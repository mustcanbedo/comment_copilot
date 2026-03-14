package handler

import (
	"net/http"

	"github.com/gin-gonic/gin"
)

type SelectorHandler struct{}

func NewSelectorHandler() *SelectorHandler {
	return &SelectorHandler{}
}

func (h *SelectorHandler) Get(c *gin.Context) {
	platform := c.Query("platform")
	if platform == "" {
		c.JSON(http.StatusBadRequest, gin.H{"ok": false, "error": "missing platform"})
		return
	}

	defaults := map[string]any{
		"xiaohongshu": map[string]string{
			"commentList": "[class*='comment-item'], .note-comment-card, .comment-item",
			"authorName":  "[class*='user-name'], [class*='nickname'], .author-name",
			"content":     "[class*='comment-content'], .content",
			"timestamp":   "time, [class*='time'], [class*='date']",
			"commentId":   "[data-comment-id], [data-id]",
		},
		"douyin": map[string]string{
			"commentList": ".comment-item, [class*='CommentItem'], [data-e2e='comment-item']",
			"authorName":  "[class*='user-name'], [data-e2e='comment-user-name']",
			"content":     "[class*='content'], [data-e2e='comment-content']",
			"timestamp":   "time, [class*='time']",
			"commentId":   "[data-comment-id]",
		},
	}

	v, ok := defaults[platform]
	if !ok {
		c.JSON(http.StatusNotFound, gin.H{"ok": false, "error": "platform not supported"})
		return
	}
	c.Header("Cache-Control", "public, max-age=3600")
	c.JSON(http.StatusOK, gin.H{"ok": true, "platform": platform, "version": "default", "selectors": v})
}
