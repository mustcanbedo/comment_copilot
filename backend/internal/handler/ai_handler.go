package handler

import (
	"bytes"
	"encoding/json"
	"fmt"
	"net/http"
	"strings"

	"github.com/gin-gonic/gin"
)

type AIHandler struct {
	deepSeekAPIKey string
}

func NewAIHandler(deepSeekAPIKey string) *AIHandler {
	return &AIHandler{deepSeekAPIKey: deepSeekAPIKey}
}

func (h *AIHandler) Reply(c *gin.Context) {
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

	persona := req.Persona
	if persona == "" {
		persona = "热情友好的品牌客服"
	}

	systemPrompt := fmt.Sprintf(`你是一个%s，负责回复小红书/抖音等平台的用户评论。
要求：
1. 回复简短自然，15-40字为宜
2. 语气亲切，符合中文社交媒体风格
3. 不要使用“您”，用“你”更自然
4. 不要在回复中提及微信号、手机号等敏感信息
5. 结合帖子内容回复，使回复与笔记主题相关
6. 若用户评论中出现“[表情]”，表示该处为表情图片（如笑哭、点赞等），请结合前后文推断情绪并自然回复，不要在回复中写出“[表情]”或“表情”字样
7. 输出 JSON 格式：{"suggestions": ["回复1", "回复2", "回复3"]}`, persona)

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

	resp, err := http.DefaultClient.Do(httpReq)
	if err != nil {
		c.JSON(http.StatusBadGateway, gin.H{"ok": false, "error": "AI service error"})
		return
	}
	defer resp.Body.Close()
	if resp.StatusCode >= 400 {
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
	if json.NewDecoder(resp.Body).Decode(&out) != nil || len(out.Choices) == 0 {
		c.JSON(http.StatusBadGateway, gin.H{"ok": false, "error": "AI service error"})
		return
	}

	var parsed struct {
		Suggestions []string `json:"suggestions"`
	}
	if json.Unmarshal([]byte(out.Choices[0].Message.Content), &parsed) != nil {
		c.JSON(http.StatusBadGateway, gin.H{"ok": false, "error": "AI service error"})
		return
	}

	c.JSON(http.StatusOK, gin.H{"ok": true, "suggestions": parsed.Suggestions})
}
