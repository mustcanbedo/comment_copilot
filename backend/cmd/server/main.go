package main

import (
	"fmt"
	"log"

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
	authSvc := service.NewAuthService(authRepo)

	router := server.NewRouter(server.RouterDeps{
		AuthSecret: cfg.AuthSecret,

		HealthHandler:   handler.NewHealthHandler(),
		AuthHandler:     handler.NewAuthHandler(authSvc),
		CommentHandler:  handler.NewCommentHandler(),
		SelectorHandler: handler.NewSelectorHandler(),
		AIHandler:       handler.NewAIHandler(cfg.DeepSeekAPIKey),
		PersonaHandler:  handler.NewPersonaHandler(cfg.DeepSeekAPIKey),
	})

	log.Printf("Go backend running at http://localhost:%s/api", cfg.Port)
	log.Fatal(router.Run(":" + cfg.Port))
}

func ensureSchemaReady(gdb *gorm.DB) error {
	requiredTables := []any{
		&db.User{},
	}
	for _, tbl := range requiredTables {
		if !gdb.Migrator().HasTable(tbl) {
			return fmt.Errorf("database schema is missing table %T, set auto_migrate=true for first startup or run migrations/0001_init.sql", tbl)
		}
	}
	return nil
}
