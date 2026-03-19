package middleware

import (
	"net/http"

	"comment-copilot-web-backend/internal/repository"

	"github.com/gin-gonic/gin"
)

// RequireTenantMatch 校验 x-tenant-id 与当前登录用户的租户一致，防止跨租户访问
func RequireTenantMatch(authRepo *repository.AuthRepository) gin.HandlerFunc {
	return func(c *gin.Context) {
		tenantID := c.GetHeader("x-tenant-id")
		if tenantID == "" {
			c.AbortWithStatusJSON(http.StatusBadRequest, gin.H{"ok": false, "error": "missing x-tenant-id"})
			return
		}

		userIDVal, ok := c.Get("userId")
		if !ok {
			c.AbortWithStatusJSON(http.StatusUnauthorized, gin.H{"ok": false})
			return
		}
		userID := userIDVal.(string)

		user, err := authRepo.FindUserByID(userID)
		if err != nil || user == nil {
			c.AbortWithStatusJSON(http.StatusForbidden, gin.H{"ok": false, "error": "user not found"})
			return
		}

		if user.TenantID != tenantID {
			c.AbortWithStatusJSON(http.StatusForbidden, gin.H{"ok": false, "error": "tenant mismatch"})
			return
		}

		c.Next()
	}
}
