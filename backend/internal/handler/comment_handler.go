package handler

import (
	"net/http"
	"strconv"

	"comment-copilot-web-backend/internal/db"
	"comment-copilot-web-backend/internal/repository"

	"github.com/gin-gonic/gin"
)

type CommentHandler struct {
	commentRepo *repository.CommentRepository
}

func NewCommentHandler(commentRepo *repository.CommentRepository) *CommentHandler {
	return &CommentHandler{commentRepo: commentRepo}
}

type CommentResp struct {
	ID                string  `json:"id"`
	Platform          string  `json:"platform"`
	PlatformCommentID string  `json:"platformCommentId"`
	AuthorName        string  `json:"authorName"`
	Content           string  `json:"content"`
	IntentLevel       string  `json:"intentLevel"`
	Status            string  `json:"status"`
	CommentedAt       string  `json:"commentedAt"`
	PostURL           string  `json:"postUrl"`
	IsAuthorReply     bool    `json:"isAuthorReply"`
	RepliedAt         *string `json:"repliedAt,omitempty"`
}

func commentToResp(c db.Comment) CommentResp {
	r := CommentResp{
		ID:                c.ID,
		Platform:          c.Platform,
		PlatformCommentID: c.PlatformCommentID,
		AuthorName:        c.AuthorName,
		Content:           c.Content,
		IntentLevel:       c.IntentLevel,
		Status:            c.Status,
		CommentedAt:      c.CommentedAt.Format("2006-01-02T15:04:05.000Z"),
		PostURL:           c.PostURL,
		IsAuthorReply:     c.IsAuthorReply,
	}
	if c.RepliedAt != nil {
		s := c.RepliedAt.Format("2006-01-02T15:04:05.000Z")
		r.RepliedAt = &s
	}
	return r
}

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

	postURL := c.Query("postUrl")
	intent := c.Query("intent")
	status := c.Query("status")

	list, err := h.commentRepo.List(tenantID, postURL, intent, status, limit)
	if err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"ok": false, "error": err.Error()})
		return
	}

	resp := make([]CommentResp, len(list))
	for i := range list {
		resp[i] = commentToResp(list[i])
	}

	c.JSON(http.StatusOK, gin.H{"ok": true, "data": resp, "total": len(resp)})
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

	items := make([]repository.IngestItem, len(req.Comments))
	for i := range req.Comments {
		items[i] = repository.IngestItem{
			PlatformCommentID: req.Comments[i].PlatformCommentID,
			AuthorName:        req.Comments[i].AuthorName,
			Content:           req.Comments[i].Content,
			CommentedAt:       req.Comments[i].CommentedAt,
			PostURL:           req.Comments[i].PostURL,
			IsAuthorReply:     req.Comments[i].IsAuthorReply,
		}
	}

	saved, skipped, err := h.commentRepo.UpsertFromIngest(tenantID, req.Platform, items)
	if err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"ok": false, "error": err.Error()})
		return
	}

	c.JSON(http.StatusOK, gin.H{"ok": true, "saved": saved, "skipped": skipped})
}

func (h *CommentHandler) MarkReplied(c *gin.Context) {
	tenantID := c.GetHeader("x-tenant-id")
	if tenantID == "" {
		c.JSON(http.StatusBadRequest, gin.H{"ok": false, "error": "missing x-tenant-id"})
		return
	}

	var req struct {
		PlatformCommentID string `json:"platformCommentId" binding:"required"`
		Platform          string `json:"platform"`
	}
	if err := c.ShouldBindJSON(&req); err != nil {
		c.JSON(http.StatusBadRequest, gin.H{"ok": false, "error": err.Error()})
		return
	}
	platform := req.Platform
	if platform == "" {
		platform = "xiaohongshu"
	}

	if err := h.commentRepo.MarkReplied(tenantID, platform, req.PlatformCommentID); err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"ok": false, "error": err.Error()})
		return
	}

	c.JSON(http.StatusOK, gin.H{"ok": true})
}
