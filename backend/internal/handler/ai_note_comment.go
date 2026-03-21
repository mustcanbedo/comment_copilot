package handler

import (
	"bytes"
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"strings"

	"comment-copilot-web-backend/internal/repository"

	"github.com/gin-gonic/gin"
)

func (h *AIHandler) NoteComment(c *gin.Context) {
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
		PostURL     string `json:"postUrl"`
		PostTitle   string `json:"postTitle"`
		PostContent string `json:"postContent"`
		Persona     string `json:"persona"`
		Style       string `json:"style"`
	}
	if err := c.ShouldBindJSON(&req); err != nil {
		c.JSON(http.StatusBadRequest, gin.H{"ok": false, "error": err.Error()})
		return
	}

	if strings.TrimSpace(req.PostURL) == "" &&
		strings.TrimSpace(req.PostTitle) == "" &&
		strings.TrimSpace(req.PostContent) == "" {
		c.JSON(http.StatusBadRequest, gin.H{
			"ok":    false,
			"error": "postUrl, postTitle, postContent cannot all be empty",
		})
		return
	}

	if h.deepSeekAPIKey == "" {
		c.JSON(http.StatusOK, gin.H{
			"ok": true,
			"suggestions": []string{
				"内容很实用，收藏了，期待你后续更多分享。",
				"这个思路很清晰，按你这个方法试试看。",
				"看完有启发，想知道你实操后的效果如何。",
			},
		})
		return
	}

	deductResult, err := h.userRepo.DeductPoints(userID, pointsPerCall)
	if err != nil {
		if errors.Is(err, repository.ErrInsufficientPoints) {
			c.JSON(http.StatusPaymentRequired, gin.H{
				"ok":      false,
				"error":   "insufficient_points",
				"code":    "INSUFFICIENT_POINTS",
				"message": "insufficient points",
			})
			return
		}
		c.JSON(http.StatusInternalServerError, gin.H{"ok": false, "error": err.Error()})
		return
	}

	persona := strings.TrimSpace(req.Persona)
	if persona == "" {
		persona = "friendly social media operator"
	}

	style := strings.TrimSpace(req.Style)
	if style == "" {
		style = "casual"
	}

	systemPrompt := fmt.Sprintf(`你是%s。
你要为社交媒体笔记生成“主评论”（发在笔记下的评论），不是回复某条已有评论。
要求：
1. 每条建议简短自然，口语化表达。
2. 不要冒充笔记作者，不要编造事实或效果承诺。
3. 避免引流联系方式、违规营销或敏感内容。
4. 仅输出严格 JSON：{"suggestions":["评论1","评论2","评论3"]}。`, persona)

	userPrompt := fmt.Sprintf(
		"请基于以下信息，生成3条可直接发布在笔记下方的主评论建议。\n风格：%s\n笔记URL：%s\n笔记标题：%s\n笔记内容：%s",
		style, req.PostURL, req.PostTitle, req.PostContent,
	)

	suggestions, err := h.runSuggestionsJob(systemPrompt, userPrompt)
	if err != nil {
		_ = h.userRepo.RefundPoints(userID, deductResult.FromFree, deductResult.FromTopup)
		c.JSON(http.StatusBadGateway, gin.H{"ok": false, "error": err.Error()})
		return
	}

	c.JSON(http.StatusOK, gin.H{"ok": true, "suggestions": suggestions})
}

func (h *AIHandler) runSuggestionsJob(systemPrompt, userPrompt string) ([]string, error) {
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
		return nil, errors.New("AI service error")
	}
	defer resp.Body.Close()
	if resp.StatusCode >= 400 {
		return nil, errors.New("AI service error")
	}

	var out struct {
		Choices []struct {
			Message struct {
				Content string `json:"content"`
			} `json:"message"`
		} `json:"choices"`
	}
	if err := json.NewDecoder(resp.Body).Decode(&out); err != nil {
		return nil, errors.New("invalid AI response")
	}
	if len(out.Choices) == 0 {
		return nil, errors.New("AI returned empty choices")
	}

	content := strings.TrimSpace(out.Choices[0].Message.Content)
	if content == "" {
		return nil, errors.New("AI returned empty content")
	}

	var parsed struct {
		Suggestions []string `json:"suggestions"`
	}
	if err := json.Unmarshal([]byte(content), &parsed); err != nil {
		return nil, errors.New("invalid AI JSON")
	}
	if len(parsed.Suggestions) == 0 {
		return nil, errors.New("AI returned no suggestions")
	}

	result := make([]string, 0, len(parsed.Suggestions))
	for _, s := range parsed.Suggestions {
		if t := strings.TrimSpace(s); t != "" {
			result = append(result, t)
		}
	}
	if len(result) == 0 {
		return nil, errors.New("AI returned no suggestions")
	}
	return result, nil
}
