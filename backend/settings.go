package main

// Редактируемые из UI настройки сервера.
//
// Живут в таблице server_settings (key-value). Читаются НА ЛЕТУ: бот и
// хендлеры вызывают аксессоры при каждом обращении, поэтому смена токена
// или телефона в интерфейсе применяется без перезапуска сервера.
//
// Fallback — переменная окружения: если ключа в таблице нет, действует
// значение из env (обратная совместимость со старыми развёртываниями,
// где всё задавалось через TELEGRAM_BOT_TOKEN и т.п.).

import (
	"context"
	"encoding/json"
	"net/http"
	"strings"
	"time"
)

// getSetting возвращает значение ключа из server_settings, а если его нет —
// переданный fallback (обычно значение из env).
func (a *app) getSetting(key, fallback string) string {
	var v string
	err := a.db.QueryRow(`SELECT value FROM server_settings WHERE key=?`, key).Scan(&v)
	if err != nil {
		return fallback
	}
	return v
}

func (a *app) setSetting(key, value string) error {
	_, err := a.db.Exec(`
		INSERT INTO server_settings (key, value) VALUES (?, ?)
		ON CONFLICT(key) DO UPDATE SET value=excluded.value`, key, value)
	return err
}

// ─── Живые аксессоры конфигурации (env как значение по умолчанию) ────────────

func (a *app) tgToken() string     { return a.getSetting("tg_token", a.config.TelegramToken) }
func (a *app) tgBotName() string   { return a.getSetting("tg_bot_name", a.config.TelegramBotName) }
func (a *app) portalURL() string   { return a.getSetting("portal_url", a.config.PortalPublicURL) }
func (a *app) clinicPhone() string { return a.getSetting("clinic_phone", a.config.ClinicPhone) }

// remindersEnabled — включён ли планировщик напоминаний. По умолчанию да.
func (a *app) remindersEnabled() bool {
	return a.getSetting("reminders_enabled", "1") != "0"
}

// ─── HTTP ────────────────────────────────────────────────────────────────────

// handleGetTelegramSettings отдаёт текущие настройки. Токен наружу не отдаём
// целиком (секрет) — только признак, задан ли он, и последние 4 символа
// для опознания.
func (a *app) handleGetTelegramSettings(w http.ResponseWriter, r *http.Request) {
	token := a.tgToken()
	hint := ""
	if len(token) >= 4 {
		hint = "…" + token[len(token)-4:]
	}
	writeJSON(w, http.StatusOK, apiResponse{Status: "ok", Data: map[string]interface{}{
		"bot_name":          a.tgBotName(),
		"portal_url":        a.portalURL(),
		"clinic_phone":      a.clinicPhone(),
		"reminders_enabled": a.remindersEnabled(),
		"token_set":         token != "",
		"token_hint":        hint,
	}})
}

type telegramSettingsPayload struct {
	// Token: пусто = не менять (оставить текущий). Чтобы очистить — TokenClear.
	Token            string `json:"token"`
	TokenClear       bool   `json:"token_clear"`
	BotName          string `json:"bot_name"`
	PortalURL        string `json:"portal_url"`
	ClinicPhone      string `json:"clinic_phone"`
	RemindersEnabled bool   `json:"reminders_enabled"`
}

func (a *app) handlePutTelegramSettings(w http.ResponseWriter, r *http.Request) {
	var p telegramSettingsPayload
	if err := decodeJSON(r, &p); err != nil {
		writeError(w, http.StatusBadRequest, err.Error())
		return
	}
	// Токен: очистить, задать новый или оставить как есть.
	if p.TokenClear {
		a.setSetting("tg_token", "")
	} else if strings.TrimSpace(p.Token) != "" {
		a.setSetting("tg_token", strings.TrimSpace(p.Token))
	}
	a.setSetting("tg_bot_name", strings.TrimSpace(strings.TrimPrefix(p.BotName, "@")))
	a.setSetting("portal_url", strings.TrimSpace(p.PortalURL))
	a.setSetting("clinic_phone", strings.TrimSpace(p.ClinicPhone))
	if p.RemindersEnabled {
		a.setSetting("reminders_enabled", "1")
	} else {
		a.setSetting("reminders_enabled", "0")
	}
	a.handleGetTelegramSettings(w, r)
}

// handleTestTelegram проверяет токен через Bot API getMe: показывает,
// работает ли подключение и как зовут бота.
func (a *app) handleTestTelegram(w http.ResponseWriter, r *http.Request) {
	token := a.tgToken()
	if token == "" {
		writeError(w, http.StatusBadRequest, "Токен бота не задан")
		return
	}
	ctx, cancel := context.WithTimeout(r.Context(), 10*time.Second)
	defer cancel()
	req, _ := http.NewRequestWithContext(ctx, http.MethodGet, telegramAPIBase+token+"/getMe", nil)
	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		writeError(w, http.StatusBadGateway, "Нет связи с Telegram: "+err.Error())
		return
	}
	defer resp.Body.Close()
	var parsed struct {
		OK     bool `json:"ok"`
		Result struct {
			Username  string `json:"username"`
			FirstName string `json:"first_name"`
		} `json:"result"`
		Description string `json:"description"`
	}
	if err := json.NewDecoder(resp.Body).Decode(&parsed); err != nil || !parsed.OK {
		msg := "Токен отклонён Telegram"
		if parsed.Description != "" {
			msg = parsed.Description
		}
		writeError(w, http.StatusBadRequest, msg)
		return
	}
	writeJSON(w, http.StatusOK, apiResponse{Status: "ok", Data: map[string]string{
		"username":   parsed.Result.Username,
		"first_name": parsed.Result.FirstName,
	}})
}
