package server

import (
	"comment-copilot-web-backend/internal/handler"
	"comment-copilot-web-backend/internal/middleware"

	"github.com/gin-contrib/cors"
	"github.com/gin-gonic/gin"
)

type RouterDeps struct {
	AuthSecret string

	HealthHandler   *handler.HealthHandler
	AuthHandler     *handler.AuthHandler
	CommentHandler  *handler.CommentHandler
	SelectorHandler *handler.SelectorHandler
	AIHandler       *handler.AIHandler
	PersonaHandler  *handler.PersonaHandler
}

func NewRouter(deps RouterDeps) *gin.Engine {
	r := gin.New()
	r.Use(gin.Logger(), gin.Recovery())
	r.Use(cors.New(cors.Config{
		AllowOrigins:     []string{"*"},
		AllowMethods:     []string{"GET", "POST", "OPTIONS"},
		AllowHeaders:     []string{"Origin", "Content-Type", "Accept", "Authorization", "x-tenant-id"},
		AllowCredentials: true,
	}))

	api := r.Group("/api")
	{
		api.POST("/auth/login", deps.AuthHandler.Login(deps.AuthSecret))
		api.POST("/auth/logout", deps.AuthHandler.Logout)

		protected := api.Group("")
		protected.Use(middleware.RequireAuth(deps.AuthSecret))

		protected.GET("/health", deps.HealthHandler.Get)
		protected.POST("/auth/register", deps.AuthHandler.Register)
		protected.GET("/auth/me", deps.AuthHandler.Me)
		protected.GET("/auth/session", deps.AuthHandler.CompatSession)
		protected.POST("/auth/session", deps.AuthHandler.CompatSession)
		protected.GET("/auth/csrf", deps.AuthHandler.CompatCSRF)
		protected.POST("/auth/csrf", deps.AuthHandler.CompatCSRF)
		protected.GET("/auth/providers", deps.AuthHandler.CompatProviders)
		protected.POST("/auth/providers", deps.AuthHandler.CompatProviders)

		protected.GET("/comments", deps.CommentHandler.List)
		protected.POST("/ingest/comments", deps.CommentHandler.Ingest)
		protected.GET("/selectors", deps.SelectorHandler.Get)
		protected.POST("/ai/reply", deps.AIHandler.Reply)
		protected.GET("/settings/persona", deps.PersonaHandler.Get)
		protected.POST("/settings/persona", deps.PersonaHandler.Update)
	}
	// }
	return r
}
