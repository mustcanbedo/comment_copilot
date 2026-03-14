package config

import (
	"fmt"
	"strings"

	"github.com/spf13/viper"
)

type Config struct {
	Port           string `mapstructure:"port"`
	DatabaseURL    string `mapstructure:"database_url"`
	AuthSecret     string `mapstructure:"auth_secret"`
	DeepSeekAPIKey string `mapstructure:"deepseek_api_key"`
	AutoMigrate    bool   `mapstructure:"auto_migrate"`
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
	return cfg, nil
}
