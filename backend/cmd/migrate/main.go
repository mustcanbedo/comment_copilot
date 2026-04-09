// 执行 migrations 目录下的 SQL 迁移
// 用法: go run ./cmd/migrate [迁移文件]
// 从 config.yaml 读取 database_url，或设置 DATABASE_URL 环境变量
// 不传参数时仅执行 0004_users_points.sql
package main

import (
	"database/sql"
	"fmt"
	"log"
	"os"
	"path/filepath"
	"strings"

	"comment-copilot-web-backend/internal/config"

	_ "github.com/jackc/pgx/v5/stdlib"
)

func main() {
	dbURL := os.Getenv("DATABASE_URL")
	if dbURL == "" {
		cfg, err := config.Load()
		if err != nil {
			log.Fatal("DATABASE_URL not set and config load failed:", err)
		}
		dbURL = cfg.DatabaseURL
	}

	db, err := sql.Open("pgx", dbURL)
	if err != nil {
		log.Fatal(err)
	}
	defer db.Close()

	if err := db.Ping(); err != nil {
		log.Fatal(err)
	}

	migrationsDir := "migrations"
	if d := os.Getenv("MIGRATIONS_DIR"); d != "" {
		migrationsDir = d
	}

	files := os.Args[1:]
	if len(files) == 0 {
		files = []string{"0004_users_points.sql"}
	}

	for _, f := range files {
		path := f
		if !strings.Contains(f, "/") && !strings.Contains(f, "\\") {
			path = filepath.Join(migrationsDir, f)
		}
		content, err := os.ReadFile(path)
		if err != nil {
			log.Fatal(err)
		}
		log.Printf("Running %s...", f)
		if _, err := db.Exec(string(content)); err != nil {
			log.Fatalf("%s failed: %v", f, err)
		}
		log.Printf("  OK")
	}
	fmt.Println("Migrations complete.")
}
