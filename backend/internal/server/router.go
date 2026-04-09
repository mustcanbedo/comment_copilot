package server

import (
	"comment-copilot-web-backend/internal/handler"
	"comment-copilot-web-backend/internal/middleware"
	"comment-copilot-web-backend/internal/repository"

	"github.com/gin-contrib/cors"
	"github.com/gin-gonic/gin"
)

type RouterDeps struct {
	AuthSecret  string
	AuthRepo    *repository.AuthRepository
	CORSOrigins []string // 空则允许 *，生产建议配置 chrome-extension://<id> 等

	HealthHandler     *handler.HealthHandler
	AuthHandler       *handler.AuthHandler
	CommentHandler    *handler.CommentHandler
	SavedReplyHandler *handler.SavedReplyHandler
	SelectorHandler   *handler.SelectorHandler
	AIHandler         *handler.AIHandler
	PersonaHandler    *handler.PersonaHandler
}

func NewRouter(deps RouterDeps) *gin.Engine {
	r := gin.New()
	r.Use(gin.Logger(), gin.Recovery())
	origins := deps.CORSOrigins
	if len(origins) == 0 {
		origins = []string{"*"}
	}
	r.Use(cors.New(cors.Config{
		AllowOrigins:     origins,
		AllowMethods:     []string{"GET", "POST", "DELETE", "OPTIONS"},
		AllowHeaders:     []string{"Origin", "Content-Type", "Accept", "Authorization", "x-tenant-id"},
		AllowCredentials: true,
	}))

	api := r.Group("/api")
	{
		api.POST("/auth/login", deps.AuthHandler.Login(deps.AuthSecret))
		api.POST("/auth/logout", deps.AuthHandler.Logout)
		api.POST("/auth/register", deps.AuthHandler.Register)
		api.GET("/health", deps.HealthHandler.Get)

		protected := api.Group("")
		protected.Use(middleware.RequireAuth(deps.AuthSecret))

		protected.GET("/auth/me", deps.AuthHandler.Me)
		protected.GET("/auth/session", deps.AuthHandler.CompatSession)
		protected.POST("/auth/session", deps.AuthHandler.CompatSession)
		protected.GET("/auth/csrf", deps.AuthHandler.CompatCSRF)
		protected.POST("/auth/csrf", deps.AuthHandler.CompatCSRF)
		protected.GET("/auth/providers", deps.AuthHandler.CompatProviders)
		protected.POST("/auth/providers", deps.AuthHandler.CompatProviders)

		// 需要 x-tenant-id 且校验租户归属的路由
		tenantProtected := protected.Group("")
		tenantProtected.Use(middleware.RequireTenantMatch(deps.AuthRepo))
		tenantProtected.GET("/comments", deps.CommentHandler.List)
		tenantProtected.POST("/ingest/comments", deps.CommentHandler.Ingest)
		tenantProtected.POST("/comments/mark-replied", deps.CommentHandler.MarkReplied)
		tenantProtected.GET("/saved-replies", deps.SavedReplyHandler.List)
		tenantProtected.POST("/saved-replies", deps.SavedReplyHandler.Create)
		tenantProtected.DELETE("/saved-replies/:id", deps.SavedReplyHandler.Delete)
		tenantProtected.GET("/selectors", deps.SelectorHandler.Get)
		tenantProtected.POST("/ai/reply", deps.AIHandler.Reply)
		tenantProtected.POST("/ai/note-comment", deps.AIHandler.NoteComment)
		tenantProtected.GET("/settings/persona", deps.PersonaHandler.Get)
		tenantProtected.POST("/settings/persona", deps.PersonaHandler.Update)
	}
	// }
	return r
}
