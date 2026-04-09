package handler

import (
	"bytes"
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"strings"
	"time"

	"comment-copilot-web-backend/internal/repository"

	"github.com/gin-gonic/gin"
)

const pointsPerCall = 1

// DeepSeek 调用可能较慢，避免 DefaultClient 无超时挂死连接
var deepSeekHTTPClient = &http.Client{Timeout: 90 * time.Second}

type AIHandler struct {
	deepSeekAPIKey string
	userRepo       *repository.UserRepository
}

func NewAIHandler(deepSeekAPIKey string, userRepo *repository.UserRepository) *AIHandler {
	return &AIHandler{deepSeekAPIKey: deepSeekAPIKey, userRepo: userRepo}
}

func (h *AIHandler) Reply(c *gin.Context) {
	userID := c.GetString("userId")
	if userID == "" {
		c.JSON(http.StatusUnauthorized, gin.H{"ok": false, "error": "unauthorized"})
		return
	}

	tenantID := c.GetHeader("x-tenant-id")
	if tenantID == "" {
		c.JSON(http.StatusBadRequest, gin.H{"ok": false, "error": "missing x-tenant-id"})
		return
	}

	var req struct {
		CommentID      string `json:"commentId" binding:"required"`
		CommentContent string `json:"commentContent" binding:"required"`
		Persona        string `json:"persona"`
		PostTitle      string `json:"postTitle"`
		PostContent    string `json:"postContent"`
	}
	if err := c.ShouldBindJSON(&req); err != nil {
		c.JSON(http.StatusBadRequest, gin.H{"ok": false, "error": err.Error()})
		return
	}

	if h.deepSeekAPIKey == "" {
		// Mock 模式不扣费
		c.JSON(http.StatusOK, gin.H{
			"ok": true,
			"suggestions": []string{
				"感谢你的关注，欢迎继续交流。",
				"收到你的评论，我们会持续优化内容。",
				"谢谢支持，有问题可以继续留言。",
			},
		})
		return
	}

	// 预扣费（事务 + 行锁），AI 失败时回退
	deductResult, err := h.userRepo.DeductPoints(userID, pointsPerCall)
	if err != nil {
		if errors.Is(err, repository.ErrInsufficientPoints) {
			c.JSON(http.StatusPaymentRequired, gin.H{
				"ok":      false,
				"error":   "insufficient_points",
				"code":    "INSUFFICIENT_POINTS",
				"message": "您的积分已耗尽，请充值。",
			})
			return
		}
		c.JSON(http.StatusInternalServerError, gin.H{"ok": false, "error": err.Error()})
		return
	}

	persona := req.Persona
	if persona == "" {
		persona = "热情友好的品牌客服"
	}

	systemPrompt := fmt.Sprintf(`你是一个%s，负责回复小红书/抖音等平台的用户评论。
要求：
1. 回复简短自然，15-40字为宜
2. 语气亲切，符合中文社交媒体风格，但要像真人随手打字，不要「小作文」感
3. 不要使用“您”，用“你”更自然
4. 不要在回复中提及微信号、手机号等敏感信息
5. 结合帖子内容回复，使回复与笔记主题相关
6. 若用户评论中出现“[表情]”，表示该处为表情图片（如笑哭、点赞等），请结合前后文推断情绪并自然回复，不要在回复中写出“[表情]”或“表情”字样
7. 避免 AI 腔与语气词堆砌：少用或不用「哈哈/嘿嘿/呢呀哦啦/哒」、波浪号～、连用多个「！」；少用空洞万能承接（如「太棒了」「绝了」「厉害了」「说得真好」「给我很大启发」「确实如此」）除非与对方评论强相关；少用千篇一律客服套话（如「感谢支持/留言」「欢迎继续交流」「希望对你有帮助」），尽量扣住对方那句话或帖子里的具体点回应
8. 输出 JSON 格式：{"suggestions": ["回复1", "回复2", "回复3"]}`, persona)

	commentHint := ""
	if strings.TrimSpace(req.CommentContent) == "【图片】" {
		commentHint = "（该评论为纯图片，请根据帖子内容生成通用友好回复，勿描述或回复图片本身。） "
	}
	userPrompt := fmt.Sprintf("用户评论：%s\n\n%s请生成3条候选回复。", req.CommentContent, commentHint)
	if req.PostTitle != "" || req.PostContent != "" {
		userPrompt = fmt.Sprintf("【当前帖子】\n标题：%s\n正文：%s\n\n【用户评论】%s\n\n%s请结合帖子内容生成3条候选回复。",
			req.PostTitle, req.PostContent, req.CommentContent, commentHint)
	}

	payload := map[string]any{
		"model": "deepseek-chat",
		"messages": []map[string]string{
			{"role": "system", "content": systemPrompt},
			{"role": "user", "content": userPrompt},
		},
		"max_tokens":      300,
		"temperature":     0.8,
		"response_format": map[string]string{"type": "json_object"},
	}
	b, _ := json.Marshal(payload)
	httpReq, _ := http.NewRequest(http.MethodPost, "https://api.deepseek.com/v1/chat/completions", bytes.NewReader(b))
	httpReq.Header.Set("Content-Type", "application/json")
	httpReq.Header.Set("Authorization", "Bearer "+h.deepSeekAPIKey)

	resp, err := deepSeekHTTPClient.Do(httpReq)
	if err != nil {
		_ = h.userRepo.RefundPoints(userID, deductResult.FromFree, deductResult.FromTopup)
		c.JSON(http.StatusBadGateway, gin.H{"ok": false, "error": "AI service error"})
		return
	}
	defer resp.Body.Close()
	if resp.StatusCode >= 400 {
		_ = h.userRepo.RefundPoints(userID, deductResult.FromFree, deductResult.FromTopup)
		c.JSON(http.StatusBadGateway, gin.H{"ok": false, "error": "AI service error"})
		return
	}

	var out struct {
		Choices []struct {
			Message struct {
				Content string `json:"content"`
			} `json:"message"`
		} `json:"choices"`
	}
	if err := json.NewDecoder(resp.Body).Decode(&out); err != nil {
		_ = h.userRepo.RefundPoints(userID, deductResult.FromFree, deductResult.FromTopup)
		c.JSON(http.StatusBadGateway, gin.H{"ok": false, "error": "invalid AI response"})
		return
	}
	if len(out.Choices) == 0 {
		_ = h.userRepo.RefundPoints(userID, deductResult.FromFree, deductResult.FromTopup)
		c.JSON(http.StatusBadGateway, gin.H{"ok": false, "error": "AI returned empty choices"})
		return
	}

	content := strings.TrimSpace(out.Choices[0].Message.Content)
	if content == "" {
		_ = h.userRepo.RefundPoints(userID, deductResult.FromFree, deductResult.FromTopup)
		c.JSON(http.StatusBadGateway, gin.H{"ok": false, "error": "AI returned empty content"})
		return
	}

	var parsed struct {
		Suggestions []string `json:"suggestions"`
	}
	if err := json.Unmarshal([]byte(content), &parsed); err != nil {
		_ = h.userRepo.RefundPoints(userID, deductResult.FromFree, deductResult.FromTopup)
		c.JSON(http.StatusBadGateway, gin.H{"ok": false, "error": "invalid AI JSON"})
		return
	}
	if len(parsed.Suggestions) == 0 {
		_ = h.userRepo.RefundPoints(userID, deductResult.FromFree, deductResult.FromTopup)
		c.JSON(http.StatusBadGateway, gin.H{"ok": false, "error": "AI returned no suggestions"})
		return
	}

	c.JSON(http.StatusOK, gin.H{"ok": true, "suggestions": parsed.Suggestions})
}
