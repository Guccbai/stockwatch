// Package config loads runtime configuration from environment variables.
package config

import (
	"os"
	"path/filepath"
	"strconv"
	"time"
)

type Config struct {
	Listen        string
	DataDir       string
	AdminPassword string // used only on first start, when no password is stored yet

	// Optional overrides; when set they take precedence over values saved in the WebUI.
	TelegramToken  string
	TelegramChatID string
	TelegramAPI    string // Bot API base URL; change for a self-hosted Bot API server or reverse proxy

	FakeProvider bool // registers a fake provider that flips stock states, for end-to-end testing
	HTTPTimeout  time.Duration
}

func Load() Config {
	return Config{
		Listen:         env("SW_LISTEN", ":8080"),
		DataDir:        env("SW_DATA", "./data"),
		AdminPassword:  os.Getenv("SW_ADMIN_PASSWORD"),
		TelegramToken:  os.Getenv("SW_TELEGRAM_TOKEN"),
		TelegramChatID: os.Getenv("SW_TELEGRAM_CHAT_ID"),
		TelegramAPI:    env("SW_TELEGRAM_API", "https://api.telegram.org"),
		FakeProvider:   envBool("SW_FAKE_PROVIDER"),
		HTTPTimeout:    30 * time.Second,
	}
}

func (c Config) DBPath() string { return filepath.Join(c.DataDir, "stockwatch.db") }

func env(k, def string) string {
	if v := os.Getenv(k); v != "" {
		return v
	}
	return def
}

func envBool(k string) bool {
	b, _ := strconv.ParseBool(os.Getenv(k))
	return b
}
