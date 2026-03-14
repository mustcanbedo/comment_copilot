package handler

import (
	"net/http"
	"strconv"
	"sync"
	"time"

	"github.com/gin-gonic/gin"
	"github.com/google/uuid"
)

type MemoryComment struct {
	ID                string `json:"id"`
	Platform          string `json:"platform"`
	PlatformCommentID string `json:"platformCommentId"`
	AuthorName        string `json:"authorName"`
	Content           string `json:"content"`
	IntentLevel       string `json:"intentLevel"`
	Status            string `json:"status"`
	CommentedAt       string `json:"commentedAt"`
	PostURL           string `json:"postUrl"`
	IsAuthorReply     bool   `json:"isAuthorReply"`
}

type CommentHandler struct{}

func NewCommentHandler() *CommentHandler {
	return &CommentHandler{}
}

var (
	commentMu    sync.RWMutex
	commentStore = map[string][]MemoryComment{}
)

func (h *CommentHandler) List(c *gin.Context) {
	tenantID := c.GetHeader("x-tenant-id")
	if tenantID == "" {
		c.JSON(http.StatusBadRequest, gin.H{"ok": false, "error": "missing x-tenant-id"})
		return
	}

	limit := 50
	if raw := c.Query("limit"); raw != "" {
		if v, err := strconv.Atoi(raw); err == nil && v > 0 {
			limit = v
		}
	}
	if limit > 200 {
		limit = 200
	}

	intent := c.Query("intent")
	status := c.Query("status")

	commentMu.RLock()
	rows := append([]MemoryComment(nil), commentStore[tenantID]...)
	commentMu.RUnlock()

	filtered := make([]MemoryComment, 0, len(rows))
	for _, row := range rows {
		if row.IsAuthorReply {
			continue
		}
		if intent != "" && row.IntentLevel != intent {
			continue
		}
		if status != "" && row.Status != status {
			continue
		}
		filtered = append(filtered, row)
		if len(filtered) >= limit {
			break
		}
	}

	c.JSON(http.StatusOK, gin.H{"ok": true, "data": filtered, "total": len(filtered)})
}

func (h *CommentHandler) Ingest(c *gin.Context) {
	tenantID := c.GetHeader("x-tenant-id")
	if tenantID == "" {
		c.JSON(http.StatusBadRequest, gin.H{"ok": false, "error": "missing x-tenant-id"})
		return
	}

	var req struct {
		Platform string `json:"platform" binding:"required"`
		Comments []struct {
			PlatformCommentID string `json:"platformCommentId" binding:"required"`
			AuthorName        string `json:"authorName" binding:"required"`
			Content           string `json:"content" binding:"required"`
			CommentedAt       string `json:"commentedAt" binding:"required"`
			PostURL           string `json:"postUrl"`
			IsAuthorReply     bool   `json:"isAuthorReply"`
		} `json:"comments" binding:"required,min=1"`
	}
	if err := c.ShouldBindJSON(&req); err != nil {
		c.JSON(http.StatusBadRequest, gin.H{"ok": false, "error": err.Error()})
		return
	}

	commentMu.Lock()
	defer commentMu.Unlock()

	exists := map[string]struct{}{}
	for _, row := range commentStore[tenantID] {
		key := row.Platform + "::" + row.PlatformCommentID
		exists[key] = struct{}{}
	}

	saved := 0
	skipped := 0

	for _, item := range req.Comments {
		key := req.Platform + "::" + item.PlatformCommentID
		if _, ok := exists[key]; ok {
			skipped++
			continue
		}

		parsedTime := item.CommentedAt
		if _, err := time.Parse(time.RFC3339, item.CommentedAt); err != nil {
			parsedTime = time.Now().Format(time.RFC3339)
		}

		status := "pending"
		if item.IsAuthorReply {
			status = "author"
		}

		commentStore[tenantID] = append(commentStore[tenantID], MemoryComment{
			ID:                uuid.NewString(),
			Platform:          req.Platform,
			PlatformCommentID: item.PlatformCommentID,
			AuthorName:        item.AuthorName,
			Content:           item.Content,
			IntentLevel:       "cold",
			Status:            status,
			CommentedAt:       parsedTime,
			PostURL:           item.PostURL,
			IsAuthorReply:     item.IsAuthorReply,
		})
		exists[key] = struct{}{}
		saved++
	}

	c.JSON(http.StatusOK, gin.H{"ok": true, "saved": saved, "skipped": skipped})
}
