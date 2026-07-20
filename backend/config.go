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
	// Имя бота без @ (для ссылки t.me/<имя> на странице входа портала).
	TelegramBotName string
	// Публичный адрес портала (https://<хост>:8443/portal) — бот добавляет
	// его к сообщению с паролем. Пусто — ссылка не показывается.
	PortalPublicURL string
	// Телефон клиники — кнопка «Позвонить» на портале владельцев.
	ClinicPhone string
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
		TelegramBotName: getEnv("TELEGRAM_BOT_NAME", ""),
		PortalPublicURL: getEnv("PORTAL_URL", ""),
		ClinicPhone:     getEnv("CLINIC_PHONE", ""),
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
