# VetClinic — Архитектурный обзор

## Принцип проектирования: Offline-First

Приложение спроектировано так, что **интернет-соединение никогда не блокирует работу**.
Клиника продолжает работать при нестабильной или отсутствующей сети.

```
┌─────────────────────────────────────────────────┐
│  Android Tablet (PWA)                           │
│                                                 │
│  ┌─────────┐    ┌──────────┐    ┌────────────┐ │
│  │  UI     │───▶│ app.js   │───▶│ IndexedDB  │ │
│  │ (HTML)  │◀───│(intercept│◀───│ (local DB) │ │
│  └─────────┘    │  or)    │    └────────────┘ │
│                 └────┬─────┘         ▲         │
│                      │ async         │         │
│                      ▼ sync          │         │
│                 ┌──────────┐    ┌────────────┐ │
│                 │ sync.js  │───▶│sync_queue  │ │
│                 └────┬─────┘    └────────────┘ │
└──────────────────────┼──────────────────────────┘
                       │ HTTP (когда онлайн)
                       ▼
┌─────────────────────────────────────────────────┐
│  Go Backend (monolith)                          │
│                                                 │
│  ┌──────────┐    ┌──────────┐    ┌───────────┐ │
│  │ HTTP     │───▶│ Handlers │───▶│  SQLite   │ │
│  │ Server   │    │ (domain  │    │  (WAL)    │ │
│  └──────────┘    │  files)  │    └───────────┘ │
│                  └──────────┘                   │
└─────────────────────────────────────────────────┘
```

## Слои приложения

### Frontend

| Файл | Роль |
|------|------|
| `js/db.js` | IndexedDB CRUD, sync_queue, sync_state, device_id |
| `js/sync.js` | Push/Pull синхронизация, backoff, merge |
| `js/app.js` | Fetch interceptor, in-memory кэш, SPA роутинг |
| `css/app.css` | Tablet-first стили, тёмная/светлая темы |
| `index.html` | App shell, навигация, dashboard |
| `service-worker.js` | Cache-First для статики, Stale-While-Revalidate |
| `manifest.json` | PWA конфигурация, иконки, ориентация |

### Backend

| Файл | Роль |
|------|------|
| `main.go` | Точка входа, HTTP-сервер |
| `config.go` | Конфигурация из env-переменных |
| `db.go` | Открытие SQLite, схема, миграции |
| `models.go` | Структуры данных, sync-типы |
| `helpers.go` | UUID, нормализация, временны́е утилиты |
| `handlers.go` | Роутер, middleware, JSON helpers |
| `handlers_items.go` | CRUD каталога услуг/препаратов |
| `handlers_owners.go` | CRUD владельцев, cascade soft-delete |
| `handlers_pets.go` | CRUD животных, lifecycle (deceased/transferred) |
| `handlers_visits.go` | CRUD приёмов и позиций |
| `handlers_vaccinations.go` | CRUD вакцинаций |
| `handlers_staff.go` | CRUD персонала |
| `handlers_sync.go` | `/sync/push` и `/sync/pull` |

## Принципы

1. **Local-first writes** — все записи сначала в IndexedDB, потом sync
2. **Soft delete everywhere** — физического удаления нет нигде
3. **Conflict resolution** — latest `updated_at` wins
4. **Device tracking** — каждое устройство имеет UUID (хранится в IndexedDB)
5. **Incremental sync** — `?since=timestamp` исключает повторную загрузку всего
6. **Exponential backoff** — 5s → 10s → 20s → ... → 5min при ошибках

## Стек

- **Frontend**: HTML5, CSS3, Vanilla JS (ES2017 async/await), IndexedDB, Service Worker
- **Backend**: Go 1.24, net/http (стандартная библиотека), modernc.org/sqlite (pure Go SQLite)
- **БД**: SQLite с WAL mode (локально/dev), PostgreSQL-совместимая архитектура (prod)
- **PWA**: Manifest v3, Background Sync API, Cache API
