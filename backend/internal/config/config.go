package config

import (
	"fmt"
	"os"
	"strings"

	"github.com/spf13/viper"
)

type Config struct {
	Port           string   `mapstructure:"port"`
	DatabaseURL    string   `mapstructure:"database_url"`
	AuthSecret     string   `mapstructure:"auth_secret"`
	DeepSeekAPIKey string   `mapstructure:"deepseek_api_key"`
	AutoMigrate    bool     `mapstructure:"auto_migrate"`
	CORSOrigins    []string `mapstructure:"cors_origins"` // 生产环境建议配置，如 ["chrome-extension://xxx"]
}

func Load() (Config, error) {
	v := viper.New()
	v.SetConfigName("config")
	v.SetConfigType("yaml")
	v.AddConfigPath(".")
	v.AddConfigPath("./configs")
	v.AddConfigPath("..")
	v.AddConfigPath("../..")

	v.SetDefault("port", "3001")
	v.SetDefault("auth_secret", "dev-secret")
	v.SetDefault("auto_migrate", false)

	v.AutomaticEnv()
	v.SetEnvKeyReplacer(strings.NewReplacer(".", "_"))
	_ = v.BindEnv("port", "PORT")
	_ = v.BindEnv("database_url", "DATABASE_URL")
	_ = v.BindEnv("cors_origins", "CORS_ORIGINS") // 逗号分隔，如 "chrome-extension://xxx,https://example.com"
	_ = v.BindEnv("auth_secret", "AUTH_SECRET")
	_ = v.BindEnv("deepseek_api_key", "DEEPSEEK_API_KEY")
	_ = v.BindEnv("auto_migrate", "AUTO_MIGRATE")

	if err := v.ReadInConfig(); err != nil {
		if _, ok := err.(viper.ConfigFileNotFoundError); !ok {
			return Config{}, fmt.Errorf("read config failed: %w", err)
		}
	}

	var cfg Config
	if err := v.Unmarshal(&cfg); err != nil {
		return Config{}, fmt.Errorf("unmarshal config failed: %w", err)
	}
	if cfg.DatabaseURL == "" {
		return Config{}, fmt.Errorf("database_url is required")
	}
	if env := os.Getenv("CORS_ORIGINS"); env != "" && len(cfg.CORSOrigins) == 0 {
		for _, o := range strings.Split(env, ",") {
			if s := strings.TrimSpace(o); s != "" {
				cfg.CORSOrigins = append(cfg.CORSOrigins, s)
			}
		}
	}
	return cfg, nil
}
