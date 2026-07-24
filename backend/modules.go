package main

// Module — контракт опционального модуля: единая точка, где модуль объявляет
// себя ядру. Пока интерфейс несёт ключ, зависимости и схему; маршруты, роли и
// синк-сущности добавятся отдельными методами в следующих фазах (M1.2/M1.3/M2),
// чтобы каждый шаг оставался собираемым. См. docs/MODULES.md.
type Module interface {
	Key() string          // стабильный идентификатор ("warehouse")
	DependsOn() []string   // «мягкие» зависимости (portal → telegram)
	Migrations() []string  // DDL модуля, идемпотентный (после схемы ядра)
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

// ─── Портал владельцев ─────────────────────────────────────────────────────
// Своих таблиц нет; зависит от телеграма (автовыдача паролей), мягко.
type portalModule struct{}

func (portalModule) Key() string         { return "portal" }
func (portalModule) DependsOn() []string  { return []string{"telegram"} }
func (portalModule) Migrations() []string { return nil }

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
