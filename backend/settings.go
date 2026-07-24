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

// ─── Опциональные модули: гейт и API ─────────────────────────────────────────
//
// Реестр модулей (ключи, зависимости, схема) живёт в modules.go — moduleRegistry.
// Здесь только рантайм-часть: гейт moduleEnabled и HTTP (moduleStates/handlePut).
//
// Зависимость «мягкая»: без неё модуль работает ХУЖЕ, но не ломается. Портал
// без телеграма живёт — коды владельцам сотрудник выдаёт вручную, бот лишь
// автоматизирует выдачу паролей. Поэтому включение без зависимости не блокируем,
// а возвращаем предупреждение. См. docs/MODULES.md.

// moduleEnabled — единый гейт «включён ли модуль». Телеграм особый: он
// «включён» тогда, когда задан токен бота (тумблера нет, управляется токеном).
// Портал по умолчанию включён, склад — выключен (опциональная розница).
func (a *app) moduleEnabled(key string) bool {
	switch key {
	case "telegram":
		return a.tgToken() != ""
	case "portal":
		return a.getSetting("portal_enabled", "1") == "1"
	case "warehouse":
		return a.getSetting("warehouse_enabled", "0") == "1"
	default:
		return false
	}
}

// warehouseEnabled — совместимость со старыми вызовами (склад-хендлеры).
func (a *app) warehouseEnabled() bool { return a.moduleEnabled("warehouse") }

// requireModule — middleware: при выключенном модуле отдаёт 404, как будто
// эндпоинта нет (не раскрываем существование выключенного функционала).
// Оборачивает уже собранный хендлер: requireModule("portal", requireAuth(fn)).
func (a *app) requireModule(key string, fn http.HandlerFunc) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		if !a.moduleEnabled(key) {
			writeError(w, http.StatusNotFound, "Модуль отключён")
			return
		}
		fn(w, r)
	}
}

// moduleStates — карта «модуль → включён» для всех модулей реестра.
func (a *app) moduleStates() map[string]interface{} {
	m := make(map[string]interface{}, len(moduleRegistry))
	for _, mod := range moduleRegistry {
		m[mod.Key()] = a.moduleEnabled(mod.Key())
	}
	return m
}

// handleGetModules отдаёт состояние опциональных модулей ЛЮБОМУ вошедшему —
// нужно всем ролям, чтобы решить, показывать ли раздел в меню. Ключи плоские
// булевы (обратная совместимость с фронтом, читающим data.warehouse).
func (a *app) handleGetModules(w http.ResponseWriter, r *http.Request) {
	writeJSON(w, http.StatusOK, apiResponse{Status: "ok", Data: a.moduleStates()})
}

// handlePutModule включает/выключает модуль по ключу — только админ.
// PUT /settings/module/{key}. Зависимости «мягкие»: при включении без
// зависимости кладём предупреждение в data._warnings, но не отклоняем.
func (a *app) handlePutModule(w http.ResponseWriter, r *http.Request) {
	key := r.PathValue("key")
	mod, ok := findModule(key)
	if !ok {
		writeError(w, http.StatusNotFound, "неизвестный модуль")
		return
	}
	// Телеграм включается вводом токена, а не тумблером модуля.
	if key == "telegram" {
		writeError(w, http.StatusBadRequest, "Телеграм включается вводом токена бота в настройках телеграма")
		return
	}
	var p struct {
		Enabled bool `json:"enabled"`
	}
	if err := decodeJSON(r, &p); err != nil {
		writeError(w, http.StatusBadRequest, err.Error())
		return
	}

	var warnings []string
	if p.Enabled {
		for _, dep := range mod.DependsOn() {
			if !a.moduleEnabled(dep) {
				warnings = append(warnings, moduleDepWarning(key, dep))
			}
		}
		a.setSetting(key+"_enabled", "1")
	} else {
		a.setSetting(key+"_enabled", "0")
	}

	data := a.moduleStates()
	if len(warnings) > 0 {
		data["_warnings"] = warnings
	}
	writeJSON(w, http.StatusOK, apiResponse{Status: "ok", Data: data})
}

// moduleDepWarning — человекочитаемое предупреждение о невключённой мягкой
// зависимости. Специализируем известные пары, иначе общая формулировка.
func moduleDepWarning(key, dep string) string {
	if key == "portal" && dep == "telegram" {
		return "Телеграм-бот не настроен: одноразовые пароли владельцам придётся выдавать вручную из карточки владельца."
	}
	return "Модуль «" + key + "» использует «" + dep + "», который сейчас выключен — часть функций будет недоступна."
}

// handlePutWarehouseModule — старый маршрут PUT /settings/warehouse. Оставлен
// для совместимости с уже установленными клиентами; делегирует общей логике.
func (a *app) handlePutWarehouseModule(w http.ResponseWriter, r *http.Request) {
	var p struct {
		Enabled bool `json:"enabled"`
	}
	if err := decodeJSON(r, &p); err != nil {
		writeError(w, http.StatusBadRequest, err.Error())
		return
	}
	if p.Enabled {
		a.setSetting("warehouse_enabled", "1")
	} else {
		a.setSetting("warehouse_enabled", "0")
	}
	a.handleGetModules(w, r)
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
