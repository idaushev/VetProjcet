package main

import (
	"net/http"
	"path/filepath"
)

// Module — контракт опционального модуля: единая точка, где модуль объявляет
// себя ядру. Интерфейс несёт ключ, зависимости, схему и маршруты; роли и
// синк-сущности добавятся отдельными методами в следующих фазах (M1.3/M2),
// чтобы каждый шаг оставался собираемым. См. docs/MODULES.md.
type Module interface {
	Key() string                             // стабильный идентификатор ("warehouse")
	DependsOn() []string                     // «мягкие» зависимости (portal → telegram)
	Migrations() []string                    // DDL модуля, идемпотентный (после схемы ядра)
	RegisterRoutes(mux *http.ServeMux, a *app) // HTTP-маршруты модуля (гейт внутри)
}

// moduleRegistry — единственный источник правды об опциональных модулях.
// Настройки (moduleStates/handlePutModule) и миграции читают отсюда, чтобы
// новый модуль добавлялся в одном месте.
var moduleRegistry = []Module{
	telegramModule{},
	portalModule{},
	warehouseModule{},
}

func findModule(key string) (Module, bool) {
	for _, m := range moduleRegistry {
		if m.Key() == key {
			return m, true
		}
	}
	return nil, false
}

// moduleMigrations — DDL всех модулей по порядку регистрации. Выполняется
// после миграций ядра (runMigrations), с той же идемпотентной терпимостью.
func moduleMigrations() []string {
	var out []string
	for _, m := range moduleRegistry {
		out = append(out, m.Migrations()...)
	}
	return out
}

// ─── Телеграм ────────────────────────────────────────────────────────────────
// Своих таблиц нет — использует таблицы ядра (owners/appointments/…).
type telegramModule struct{}

func (telegramModule) Key() string         { return "telegram" }
func (telegramModule) DependsOn() []string  { return nil }
func (telegramModule) Migrations() []string { return nil }

func (telegramModule) RegisterRoutes(mux *http.ServeMux, a *app) {
	// НЕ гейтим модулем: через эти настройки задаётся токен, который и
	// включает телеграм (иначе замкнутый круг). Только админ.
	mux.HandleFunc("GET /settings/telegram",       a.requireAdmin(a.handleGetTelegramSettings))
	mux.HandleFunc("PUT /settings/telegram",       a.requireAdmin(a.handlePutTelegramSettings))
	mux.HandleFunc("POST /settings/telegram/test", a.requireAdmin(a.handleTestTelegram))
}

// ─── Портал владельцев ─────────────────────────────────────────────────────
// Своих таблиц нет; зависит от телеграма (автовыдача паролей), мягко.
type portalModule struct{}

func (portalModule) Key() string         { return "portal" }
func (portalModule) DependsOn() []string  { return []string{"telegram"} }
func (portalModule) Migrations() []string { return nil }

func (portalModule) RegisterRoutes(mux *http.ServeMux, a *app) {
	// Весь модуль гейтится флагом portal_enabled: при выключении — 404.
	g := func(fn http.HandlerFunc) http.HandlerFunc { return a.requireModule("portal", fn) }
	// Выдача владельцу пароля вручную (админ/право) — без портала бессмысленна.
	mux.HandleFunc("POST /owners/{id}/portal-code", g(a.requirePortalCodeAccess(a.handleIssuePortalCode)))
	// API портала: своя авторизация (X-Portal-Token), см. portal.go.
	mux.HandleFunc("POST /portal/login",                 g(a.handlePortalLogin))
	mux.HandleFunc("GET /portal/bot-info",               g(a.handlePortalBotInfo))
	mux.HandleFunc("GET /portal/me",                     g(a.handlePortalMe))
	mux.HandleFunc("GET /portal/pets",                   g(a.handlePortalPets))
	mux.HandleFunc("GET /portal/pets/{id}/visits",       g(a.handlePortalPetVisits))
	mux.HandleFunc("GET /portal/pets/{id}/vaccinations", g(a.handlePortalPetVaccinations))
	mux.HandleFunc("GET /portal/appointments",           g(a.handlePortalAppointments))
	mux.HandleFunc("POST /portal/book",                  g(a.handlePortalBook))
	mux.HandleFunc("PUT /portal/pets/{id}/photo",        g(a.handlePortalPetPhoto))
	mux.HandleFunc("GET /portal", func(w http.ResponseWriter, r *http.Request) {
		if !a.moduleEnabled("portal") {
			http.Error(w, "Кабинет владельца отключён", http.StatusNotFound)
			return
		}
		http.ServeFile(w, r, filepath.Join(a.frontend, "portal.html"))
	})
}

// ─── Склад ───────────────────────────────────────────────────────────────────
// Таблицы warehouses/stock_movements лежат в общей schema (создаются всегда,
// безвредны при выключенном модуле). Здесь — дельта на ядровой items:
// закупочная цена нужна только складу.
type warehouseModule struct{}

func (warehouseModule) Key() string        { return "warehouse" }
func (warehouseModule) DependsOn() []string { return nil }
func (warehouseModule) Migrations() []string {
	return []string{
		`ALTER TABLE items ADD COLUMN purchase_price REAL NOT NULL DEFAULT 0`,
	}
}

func (warehouseModule) RegisterRoutes(mux *http.ServeMux, a *app) {
	// Отдельных маршрутов нет: данные склада идут через общий /sync (гейт по
	// праву "warehouse" в canPush), позиции — ядровой /items.
}
