package main

import (
	"os"
	"strings"
)

// Config содержит все параметры запуска сервера.
// Значения читаются из переменных окружения.
type Config struct {
	Port        string // :8080 — единственный порт (HTTP + HTTPS на одном)
	DBPath      string // data/vet.db
	FrontendDir string // frontend
	Env         string // development | production
	TLSCert     string // data/cert.pem  (если пусто — HTTP режим)
	TLSKey      string // data/key.pem
	// Токен телеграм-бота (@BotFather). Пусто — бот выключен,
	// уведомления копятся в outbox (таблица notifications).
	TelegramToken string
}

func LoadConfig() Config {
	return Config{
		Port:        ":" + getEnv("PORT", "8080"),
		DBPath:      getEnv("DB_PATH", "data/vet.db"),
		FrontendDir: getEnv("FRONTEND_DIR", "frontend"),
		Env:         strings.ToLower(getEnv("ENV", "development")),
		TLSCert:     getEnv("TLS_CERT", ""),
		TLSKey:      getEnv("TLS_KEY", ""),
		TelegramToken: getEnv("TELEGRAM_BOT_TOKEN", ""),
	}
}

// TLSEnabled возвращает true если настроены cert + key.
func (c Config) TLSEnabled() bool {
	return c.TLSCert != "" && c.TLSKey != ""
}

func (c Config) IsDevelopment() bool {
	return c.Env == "development" || c.Env == ""
}

func getEnv(key, fallback string) string {
	if v := os.Getenv(key); v != "" {
		return v
	}
	return fallback
}
