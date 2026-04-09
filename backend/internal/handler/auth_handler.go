package handler

import (
	"errors"
	"net/http"

	"comment-copilot-web-backend/internal/db"
	"comment-copilot-web-backend/internal/service"

	"github.com/gin-gonic/gin"
)

type AuthHandler struct {
	authSvc *service.AuthService
}

func NewAuthHandler(authSvc *service.AuthService) *AuthHandler {
	return &AuthHandler{authSvc: authSvc}
}

func (h *AuthHandler) Register(c *gin.Context) {
	var req struct {
		Email    string `json:"email" binding:"required,email"`
		Password string `json:"password" binding:"required,min=8"`
		Name     string `json:"name"`
	}
	if err := c.ShouldBindJSON(&req); err != nil {
		c.JSON(http.StatusBadRequest, gin.H{"ok": false, "error": err.Error()})
		return
	}

	user, err := h.authSvc.Register(req.Email, req.Password, req.Name)
	if err != nil {
		if errors.Is(err, service.ErrEmailExists) {
			c.JSON(http.StatusConflict, gin.H{"ok": false, "error": "该邮箱已注册"})
			return
		}
		// 返回具体错误便于排查（如数据库未连接、表未创建等）
		errMsg := err.Error()
		c.JSON(http.StatusInternalServerError, gin.H{"ok": false, "error": "register failed", "detail": errMsg})
		return
	}
	c.JSON(http.StatusOK, gin.H{"ok": true, "userId": user.ID})
}

func (h *AuthHandler) Login(secret string) gin.HandlerFunc {
	return func(c *gin.Context) {
		var req struct {
			Email    string `json:"email" binding:"required,email"`
			Password string `json:"password" binding:"required"`
		}
		if err := c.ShouldBindJSON(&req); err != nil {
			c.JSON(http.StatusBadRequest, gin.H{"ok": false, "error": err.Error()})
			return
		}

		user, token, err := h.authSvc.Login(req.Email, req.Password, secret)
		if err != nil {
			if errors.Is(err, service.ErrInvalidCredentials) {
				c.JSON(http.StatusUnauthorized, gin.H{"ok": false, "error": "邮箱或密码错误"})
				return
			}
			c.JSON(http.StatusInternalServerError, gin.H{"ok": false, "error": "login failed"})
			return
		}

		c.SetCookie("cc_token", token, 7*24*3600, "/", "", false, true)
		c.JSON(http.StatusOK, gin.H{"ok": true, "token": token, "userId": user.ID})
	}
}

func (h *AuthHandler) Logout(c *gin.Context) {
	c.SetCookie("cc_token", "", -1, "/", "", false, true)
	c.JSON(http.StatusOK, gin.H{"ok": true})
}

func (h *AuthHandler) Me(c *gin.Context) {
	userID := c.GetString("userId")
	user, err := h.authSvc.Me(userID)
	if err != nil {
		c.JSON(http.StatusUnauthorized, gin.H{"ok": false})
		return
	}
	c.JSON(http.StatusOK, gin.H{
		"ok": true,
		"user": gin.H{
			"id":    user.ID,
			"email": user.Email,
			"name":  user.FullName,
		},
		"points": gin.H{
			"freeBalance":   user.FreePointsBalance,
			"freeQuota":     db.FreePointsQuota,
			"topupBalance":  user.TopupPointsBalance,
			"total":         user.FreePointsBalance + user.TopupPointsBalance,
		},
	})
}

func (h *AuthHandler) CompatSession(c *gin.Context) {
	c.JSON(http.StatusOK, gin.H{"ok": false, "message": "use /api/auth/me"})
}

func (h *AuthHandler) CompatCSRF(c *gin.Context) {
	c.JSON(http.StatusOK, gin.H{"csrfToken": "deprecated"})
}

func (h *AuthHandler) CompatProviders(c *gin.Context) {
	c.JSON(http.StatusOK, gin.H{"credentials": gin.H{"id": "credentials", "name": "credentials"}})
}
