package handler

import (
	"bytes"
	"encoding/json"
	"net/http"
	"strings"
	"sync"

	"github.com/gin-gonic/gin"
)

type PersonaHandler struct {
	deepSeekAPIKey string
}

func NewPersonaHandler(deepSeekAPIKey string) *PersonaHandler {
	return &PersonaHandler{deepSeekAPIKey: deepSeekAPIKey}
}

var (
	personaMu    sync.RWMutex
	personaStore = map[string]string{}
)

func (h *PersonaHandler) Get(c *gin.Context) {
	userID := c.GetString("userId")
	personaMu.RLock()
	persona := personaStore[userID]
	personaMu.RUnlock()
	c.JSON(http.StatusOK, gin.H{"ok": true, "persona": persona, "name": ""})
}

func (h *PersonaHandler) Update(c *gin.Context) {
	userID := c.GetString("userId")
	var req struct {
		Keywords     string `json:"keywords"`
		AutoGenerate bool   `json:"autoGenerate"`
	}
	if err := c.ShouldBindJSON(&req); err != nil {
		c.JSON(http.StatusBadRequest, gin.H{"ok": false, "error": err.Error()})
		return
	}

	persona := req.Keywords
	if req.AutoGenerate && req.Keywords != "" && h.deepSeekAPIKey != "" {
		payload := map[string]any{
			"model":      "deepseek-chat",
			"max_tokens": 300,
			"messages": []map[string]string{
				{
					"role":    "system",
					"content": "你是一个品牌文案专家，帮助用户生成小红书账号的回复人设描述。要求：简洁、有个性、适合评论互动场景，100字以内。",
				},
				{
					"role":    "user",
					"content": "根据以下关键词，生成一段账号人设描述：" + req.Keywords,
				},
			},
		}
		b, _ := json.Marshal(payload)
		httpReq, _ := http.NewRequest(http.MethodPost, "https://api.deepseek.com/chat/completions", bytes.NewReader(b))
		httpReq.Header.Set("Content-Type", "application/json")
		httpReq.Header.Set("Authorization", "Bearer "+h.deepSeekAPIKey)
		if resp, err := http.DefaultClient.Do(httpReq); err == nil {
			defer resp.Body.Close()
			var out struct {
				Choices []struct {
					Message struct {
						Content string `json:"content"`
					} `json:"message"`
				} `json:"choices"`
			}
			if json.NewDecoder(resp.Body).Decode(&out) == nil && len(out.Choices) > 0 {
				if s := strings.TrimSpace(out.Choices[0].Message.Content); s != "" {
					persona = s
				}
			}
		}
	}

	personaMu.Lock()
	personaStore[userID] = persona
	personaMu.Unlock()

	c.JSON(http.StatusOK, gin.H{"ok": true, "persona": persona})
}
