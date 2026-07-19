package main

import (
	"crypto/tls"
	"log"
	"net/http"
	"os"
	"path/filepath"
	"time"
)

func main() {
	logger := log.New(os.Stdout, "[vet] ", log.LstdFlags)

	cfg := LoadConfig()

	root, err := os.Getwd()
	if err != nil {
		logger.Fatalf("resolve working directory: %v", err)
	}

	dbPath := filepath.Join(root, cfg.DBPath)
	db, err := openDB(dbPath)
	if err != nil {
		logger.Fatalf("database init failed: %v", err)
	}
	defer db.Close()

	frontendDir := filepath.Join(root, cfg.FrontendDir)
	application := &app{
		db:       db,
		logger:   logger,
		frontend: frontendDir,
		config:   cfg,
	}

	// Первый запуск: если пользователей нет — создаём администратора.
	application.bootstrapAdmin()

	// Фоновая чистка диска: файлы вложений, удалённых больше трёх дней назад.
	application.startAttachmentPurge()

	// Телеграм-бот: отправитель уведомлений из outbox (включается по
	// TELEGRAM_BOT_TOKEN, см. docs/TELEGRAM.md).
	application.startTelegramNotifier()

	appHandler := application.routes()

	if cfg.TLSEnabled() {
		// ── HTTPS режим (единый порт, протокол определяется по первому байту) ──
		//
		// sniffListener на одном порту cfg.Port:
		//   HTTP-запрос (http://) → r.TLS == nil → 301 redirect на https://
		//   TLS-соединение        → r.TLS != nil → нормальная работа приложения
		//
		// Пользователь может использовать и http:// и https:// — оба варианта
		// приведут к приложению. Никакой путаницы с портами.

		tlsCfg, err := loadTLSConfig(cfg.TLSCert, cfg.TLSKey)
		if err != nil {
			logger.Fatalf("TLS config: %v", err)
		}

		ln, err := newSniffListener(cfg.Port, tlsCfg)
		if err != nil {
			logger.Fatalf("listen on %s: %v", cfg.Port, err)
		}
		defer ln.Close()

		// Обёртка: HTTP → редирект, HTTPS → приложение
		dualHandler := http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			if r.TLS == nil {
				// Клиент пришёл по HTTP — редиректим на тот же хост+порт, но https://
				target := "https://" + r.Host + r.URL.RequestURI()
				http.Redirect(w, r, target, http.StatusMovedPermanently)
				return
			}
			appHandler.ServeHTTP(w, r)
		})

		server := &http.Server{
			Handler:           dualHandler,
			ReadHeaderTimeout: 5 * time.Second,
			ReadTimeout:       15 * time.Second,
			WriteTimeout:      15 * time.Second,
			IdleTimeout:       60 * time.Second,
		}

		logger.Println("──────────────────────────────────────────────────────")
		logger.Printf("  Режим: HTTPS (TLS)")
		logger.Printf("  Порт : %s  (HTTP и HTTPS на одном порту)", cfg.Port)
		logger.Printf("  База : %s", dbPath)
		logger.Printf("  Env  : %s", cfg.Env)
		logger.Println()
		logger.Printf("  На планшете откройте:  https://<IP-сервера>%s", cfg.Port)
		logger.Printf("  HTTP-запрос (http://) автоматически редиректится на https://")
		logger.Println("──────────────────────────────────────────────────────")
		logger.Println()

		if err := server.Serve(ln); err != nil && err != http.ErrServerClosed {
			logger.Fatalf("server error: %v", err)
		}

	} else {
		// ── HTTP режим (только для localhost / разработки) ─────────────────
		server := &http.Server{
			Addr:              cfg.Port,
			Handler:           appHandler,
			ReadHeaderTimeout: 5 * time.Second,
			ReadTimeout:       15 * time.Second,
			WriteTimeout:      15 * time.Second,
			IdleTimeout:       60 * time.Second,
		}

		logger.Println("──────────────────────────────────────────────────────")
		logger.Printf("  Режим: HTTP (только localhost)")
		logger.Printf("  Порт : %s", cfg.Port)
		logger.Printf("  База : %s", dbPath)
		logger.Printf("  Env  : %s", cfg.Env)
		logger.Println()
		logger.Println("  ⚠️  Service Worker работает ТОЛЬКО на localhost!")
		logger.Println("  Для планшета нужен HTTPS:")
		logger.Println("    1. go run ./scripts/gen_cert/")
		logger.Println("    2. scripts\\start-https.bat")
		logger.Println("──────────────────────────────────────────────────────")
		logger.Println()

		if err := server.ListenAndServe(); err != nil && err != http.ErrServerClosed {
			logger.Fatalf("server error: %v", err)
		}
	}
}

// loadTLSConfig читает cert.pem и key.pem и возвращает *tls.Config.
func loadTLSConfig(certFile, keyFile string) (*tls.Config, error) {
	cert, err := tls.LoadX509KeyPair(certFile, keyFile)
	if err != nil {
		return nil, err
	}
	return &tls.Config{
		Certificates: []tls.Certificate{cert},
		// Поддерживаем только TLS 1.2+ (безопасно и совместимо с Android 5+)
		MinVersion: tls.VersionTLS12,
		// Рекомендуемые cipher suites для Android Chrome
		CipherSuites: []uint16{
			tls.TLS_ECDHE_ECDSA_WITH_AES_128_GCM_SHA256,
			tls.TLS_ECDHE_RSA_WITH_AES_128_GCM_SHA256,
			tls.TLS_ECDHE_ECDSA_WITH_AES_256_GCM_SHA384,
			tls.TLS_ECDHE_RSA_WITH_AES_256_GCM_SHA384,
			tls.TLS_ECDHE_ECDSA_WITH_CHACHA20_POLY1305_SHA256,
			tls.TLS_ECDHE_RSA_WITH_CHACHA20_POLY1305_SHA256,
		},
	}, nil
}
