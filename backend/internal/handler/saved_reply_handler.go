package handler

import (
	"net/http"
	"strconv"

	"comment-copilot-web-backend/internal/db"
	"comment-copilot-web-backend/internal/repository"

	"github.com/gin-gonic/gin"
)

type SavedReplyHandler struct {
	repo *repository.SavedReplyRepository
}

func NewSavedReplyHandler(repo *repository.SavedReplyRepository) *SavedReplyHandler {
	return &SavedReplyHandler{repo: repo}
}

type SavedReplyResp struct {
	ID                 string `json:"id"`
	Text               string `json:"text"`
	FromCommentSnippet string `json:"fromComment"`
	Category           string `json:"category"`
	CreatedAt          string `json:"createdAt"`
}

func (h *SavedReplyHandler) List(c *gin.Context) {
	userID, _ := c.Get("userId")
	if userID == nil {
		c.JSON(http.StatusUnauthorized, gin.H{"ok": false})
		return
	}
	uid := userID.(string)
	tenantID := c.GetHeader("x-tenant-id")
	category := c.Query("category")
	search := c.Query("search")

	limit := 200
	if raw := c.Query("limit"); raw != "" {
		if v, err := strconv.Atoi(raw); err == nil && v > 0 {
			limit = v
		}
	}

	list, err := h.repo.List(uid, tenantID, category, search, limit)
	if err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"ok": false, "error": err.Error()})
		return
	}

	resp := make([]SavedReplyResp, len(list))
	for i := range list {
		resp[i] = SavedReplyResp{
			ID:                 list[i].ID,
			Text:               list[i].Text,
			FromCommentSnippet: list[i].FromCommentSnippet,
			Category:           list[i].Category,
			CreatedAt:          list[i].CreatedAt.Format("2006-01-02T15:04:05.000Z"),
		}
	}
	c.JSON(http.StatusOK, gin.H{"ok": true, "data": resp})
}

func (h *SavedReplyHandler) Create(c *gin.Context) {
	userID, _ := c.Get("userId")
	if userID == nil {
		c.JSON(http.StatusUnauthorized, gin.H{"ok": false})
		return
	}
	uid := userID.(string)
	tenantID := c.GetHeader("x-tenant-id")
	if tenantID == "" {
		tenantID = db.DefaultTenantID
	}

	var req struct {
		Text               string `json:"text" binding:"required"`
		FromCommentID      string `json:"fromCommentId"`
		FromCommentSnippet string `json:"fromCommentSnippet"`
		Category           string `json:"category"`
	}
	if err := c.ShouldBindJSON(&req); err != nil {
		c.JSON(http.StatusBadRequest, gin.H{"ok": false, "error": err.Error()})
		return
	}
	category := req.Category
	if category == "" {
		category = "默认"
	}

	sr := db.SavedReply{
		UserID:             uid,
		TenantID:           tenantID,
		Text:               req.Text,
		FromCommentID:      req.FromCommentID,
		FromCommentSnippet: req.FromCommentSnippet,
		Category:           category,
	}
	if err := h.repo.Create(&sr); err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"ok": false, "error": err.Error()})
		return
	}
	c.JSON(http.StatusOK, gin.H{"ok": true, "data": SavedReplyResp{
		ID:                 sr.ID,
		Text:               sr.Text,
		FromCommentSnippet: sr.FromCommentSnippet,
		Category:           sr.Category,
		CreatedAt:          sr.CreatedAt.Format("2006-01-02T15:04:05.000Z"),
	}})
}

func (h *SavedReplyHandler) Delete(c *gin.Context) {
	userID, _ := c.Get("userId")
	if userID == nil {
		c.JSON(http.StatusUnauthorized, gin.H{"ok": false})
		return
	}
	uid := userID.(string)
	tenantID := c.GetHeader("x-tenant-id")
	if tenantID == "" {
		tenantID = db.DefaultTenantID
	}
	id := c.Param("id")
	if id == "" {
		c.JSON(http.StatusBadRequest, gin.H{"ok": false, "error": "missing id"})
		return
	}

	if err := h.repo.DeleteByIDAndUserAndTenant(id, uid, tenantID); err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"ok": false, "error": err.Error()})
		return
	}
	c.JSON(http.StatusOK, gin.H{"ok": true})
}
