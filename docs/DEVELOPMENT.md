# Руководство разработчика

## Быстрый старт

```bash
# 1. Сгенерировать PWA-иконки (один раз)
python3 scripts/generate-icons.py

# 2. Запустить backend (обслуживает и frontend)
go run ./backend/
# Или через скрипт:
bash scripts/start-backend.sh

# 3. Открыть в браузере
# http://localhost:8080
```

## Требования

- Go 1.21+
- Python 3.6+ (только для генерации иконок)
- Современный Android-браузер или Chrome/Edge для PWA

## Структура проекта

```
VetProject/
├── backend/           # Go-сервер
│   ├── main.go        # Точка входа
│   ├── config.go      # Конфигурация
│   ├── db.go          # SQLite, схема, миграции
│   ├── models.go      # Структуры данных
│   ├── helpers.go     # Утилиты
│   ├── handlers.go    # Роутер, middleware
│   ├── handlers_*.go  # Доменные обработчики
│   └── handlers_sync.go # Sync API
├── frontend/          # PWA приложение
│   ├── index.html     # App shell
│   ├── manifest.json  # PWA манифест
│   ├── service-worker.js
│   ├── css/app.css    # Tablet-first стили
│   ├── js/
│   │   ├── db.js      # IndexedDB слой
│   │   ├── sync.js    # Sync логика
│   │   └── app.js     # Fetch interceptor, SPA
│   └── icons/         # PNG и SVG иконки
├── docs/              # Документация
├── scripts/           # Скрипты разработки
├── shared/            # Общие схемы (справочник)
├── data/              # SQLite база (создаётся автоматически)
├── go.mod
└── go.sum
```

## Переменные окружения

| Переменная | По умолчанию | Описание |
|------------|-------------|----------|
| `PORT` | `8080` | Порт HTTP-сервера |
| `DB_PATH` | `data/vet.db` | Путь к SQLite файлу |
| `FRONTEND_DIR` | `frontend` | Директория frontend |
| `ENV` | `development` | Окружение (development/production) |

## API эндпоинты

### Health
```
GET /health
```

### Sync (ключевые)
```
POST /sync/push   — отправка pending-записей на сервер
GET  /sync/pull   — получение изменений: ?since=ISO&device_id=UUID
```

### CRUD
```
GET/POST /owners
GET/PUT/DELETE /owners/{id}

GET/POST /pets
GET/PUT/DELETE /pets/{id}
PUT /pets/{id}/deceased   — перевод в статус "умер"

GET/POST /visits
GET/PUT/DELETE /visits/{id}
POST /visits/full          — атомарное создание (владелец+питомец+визит+позиции)

GET/POST /visit-items
DELETE /visit-items/{id}

GET/POST /vaccinations
GET/PUT/DELETE /vaccinations/{id}

GET/POST /staff
GET/PUT/DELETE /staff/{id}

GET/POST /items
GET/PUT/DELETE /items/{id}
```

## Проверка работы

```bash
# Health check
curl http://localhost:8080/health

# Создать владельца
curl -X POST http://localhost:8080/owners \
  -H "Content-Type: application/json" \
  -d '{"fio":"Иванов Иван Иванович","phone":"+7 777 123 4567"}'

# Получить все активные приёмы
curl http://localhost:8080/visits

# Инкрементальный pull (пример)
curl "http://localhost:8080/sync/pull?since=2024-01-01T00:00:00Z&device_id=test-device"

# Push (пример)
curl -X POST http://localhost:8080/sync/push \
  -H "Content-Type: application/json" \
  -d '{"device_id":"test","owners":[{"id":"abc","fio":"Тест","phone":"123","updated_at":"2025-01-01T00:00:00Z"}]}'
```

## Добавление новой сущности

### 1. Backend

**db.go** — добавить таблицу в `schema` и миграции:
```sql
CREATE TABLE IF NOT EXISTS my_entity (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    -- ... поля ...
    [sync fields: created_at, updated_at, deleted_at, is_deleted, device_id, version]
);
```

**models.go** — добавить Go-структуру:
```go
type MyEntity struct {
    ID   string `json:"id"`
    Name string `json:"name"`
    SyncMeta      // встраиваем sync-поля
}
```

**handlers_my_entity.go** — создать файл с CRUD-методами.

**handlers.go** — добавить роуты в `routes()`.

**handlers_sync.go** — добавить в `syncPushPayload`, `syncPullData`, `pushMyEntity()`, `pullMyEntity()`.

### 2. Frontend

**js/db.js** — добавить в `ENTITY_STORES`.

**js/sync.js** — добавить в `STORE_ORDER` (в правильном порядке для FK).

**js/app.js** — добавить в `STORE_MAP` и обработчики в `handleLocalRequest()`.

## Жизненный цикл питомца

```
        Создание
           │
           ▼
      status: active
      /        \
     /          \
deceased    transferred / lost
     │
     ▼
 death_date + death_reason сохраняются
 Все визиты и вакцинации доступны через историю
 is_deleted = 0 (данные не скрыты, только статус)
```

**Никогда не используйте `is_deleted=1` для умерших питомцев!**
`is_deleted=1` означает удаление записи (ошибка ввода данных).
`status=deceased` означает смерть животного.

## Отладка IndexedDB

В Chrome DevTools → Application → IndexedDB → vetclinic-pwa:
- Проверить наличие всех сторов
- Проверить `sync_state` → `last_sync`
- Проверить `sync_state` → `device_id`
- Проверить записи с `sync_status: "pending"`

## PWA Установка (Android)

1. Запустить backend (`go run ./backend/`)
2. Открыть Chrome на планшете → `http://192.168.x.x:8080`
3. Меню Chrome → "Добавить на главный экран" / "Установить приложение"
4. Иконка появится на домашнем экране
5. Приложение работает в standalone-режиме (без UI браузера)

**Для установки PWA на Android нужны PNG-иконки!**
Запустите `python3 scripts/generate-icons.py` перед первым тестом установки.

## Live Reload (опционально)

Установить air для hot-reload Go:
```bash
go install github.com/air-verse/air@latest
bash scripts/dev.sh
```

## База данных SQLite — работа напрямую

```bash
# Подключиться к БД
./sqlite3.exe data/vet.db   # Windows
sqlite3 data/vet.db          # Linux/Mac

# Просмотреть записи
SELECT * FROM owners LIMIT 5;
SELECT * FROM pets WHERE status='deceased';
SELECT * FROM sync_state;
```
