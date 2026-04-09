package main

import (
	"fmt"
	"log"
	"strings"

	"comment-copilot-web-backend/internal/config"
	"comment-copilot-web-backend/internal/db"
	"comment-copilot-web-backend/internal/handler"
	"comment-copilot-web-backend/internal/repository"
	"comment-copilot-web-backend/internal/server"
	"comment-copilot-web-backend/internal/service"

	"gorm.io/gorm"
)

func main() {
	cfg, err := config.Load()
	if err != nil {
		log.Fatal(err)
	}

	gdb, err := db.Connect(cfg.DatabaseURL)
	if err != nil {
		log.Fatal(err)
	}

	if cfg.AutoMigrate {
		if err := db.AutoMigrate(gdb); err != nil {
			log.Fatal(err)
		}
	} else {
		log.Println("auto_migrate=false, skipping AutoMigrate")
		if err := ensureSchemaReady(gdb); err != nil {
			log.Fatal(err)
		}
	}

	authRepo := repository.NewAuthRepository(gdb)
	userRepo := repository.NewUserRepository(gdb)
	authSvc := service.NewAuthService(authRepo)
	commentRepo := repository.NewCommentRepository(gdb)
	savedReplyRepo := repository.NewSavedReplyRepository(gdb)

	router := server.NewRouter(server.RouterDeps{
		AuthSecret:   cfg.AuthSecret,
		AuthRepo:     authRepo,
		CORSOrigins:  cfg.CORSOrigins,

		HealthHandler:     handler.NewHealthHandler(),
		AuthHandler:       handler.NewAuthHandler(authSvc),
		CommentHandler:    handler.NewCommentHandler(commentRepo),
		SavedReplyHandler: handler.NewSavedReplyHandler(savedReplyRepo),
		SelectorHandler:   handler.NewSelectorHandler(),
		AIHandler:         handler.NewAIHandler(cfg.DeepSeekAPIKey, userRepo),
		PersonaHandler:    handler.NewPersonaHandler(cfg.DeepSeekAPIKey),
	})

	log.Printf("Go backend running at http://localhost:%s/api", cfg.Port)
	for _, route := range router.Routes() {
		if strings.Contains(route.Path, "/api/ai") {
			log.Printf("  route %s %s", route.Method, route.Path)
		}
	}
	log.Fatal(router.Run(":" + cfg.Port))
}

func ensureSchemaReady(gdb *gorm.DB) error {
	requiredTables := []any{
		&db.User{},
		&db.Comment{},
		&db.SavedReply{},
	}
	for _, tbl := range requiredTables {
		if !gdb.Migrator().HasTable(tbl) {
			return fmt.Errorf("database schema is missing table %T, set auto_migrate=true for first startup or run migrations/0001_init.sql", tbl)
		}
	}
	return nil
}
