# Архитектура синхронизации

## Общий принцип

```
Пользователь нажимает кнопку
        ↓
app.js перехватывает fetch()
        ↓
Запись в IndexedDB (sync_status = "pending")
        ↓
UI обновляется МГНОВЕННО
        ↓
Debounce 1.2 сек
        ↓
runSync() — фоновая синхронизация
        ↓
Отправка на сервер (если онлайн)
        ↓
sync_status = "synced"
```

## Fetch Interceptor

`app.js` перехватывает все `fetch()` вызовы к управляемым путям:
```
/owners, /pets, /items, /visits, /visit-items, /vaccinations, /staff, /visits/full
```

Запросы с заголовком `X-Bypass-Local: 1` проходят напрямую в сеть (используется sync.js для API-вызовов).

## Push Sync — отправка изменений на сервер

```
sync.js → POST /sync/push
Body: {
  device_id: "uuid",
  owners:  [ { id, fio, phone, ..., updated_at, is_deleted } ],
  pets:    [ ... ],
  items:   [ ... ],
  visits:  [ ... ],
  visit_items: [ ... ],
  vaccinations: [ ... ],
  staff:   [ ... ]
}

Response: {
  status:   "ok",
  data: { accepted: 5, skipped: 1, conflicts: 0 }
}
```

**Conflict resolution**: `client.updated_at > server.updated_at` → принимаем клиентскую запись.
Иначе — пропускаем (сервер новее). Клиент получит обновление через pull.

**Fallback**: Если `/sync/push` недоступен — поштучные PUT/POST по legacy-эндпоинтам.

## Pull Sync — получение изменений с сервера

```
sync.js → GET /sync/pull?since=2024-01-15T10:00:00Z&device_id=uuid

Response: {
  status: "ok",
  data: {
    owners:       [ ...изменённые с since... ],
    pets:         [ ... ],
    items:        [ ... ],
    visits:       [ ... ],
    visit_items:  [ ... ],
    vaccinations: [ ... ],
    staff:        [ ... ],
    server_time:  "2024-01-15T11:00:00Z"
  }
}
```

Ответ включает **мягко удалённые** записи (`is_deleted=1`) — клиент применяет их локально.

**Fallback**: Если `/sync/pull` недоступен — полная загрузка из отдельных GET-эндпоинтов.

## Merge-стратегия на клиенте

```javascript
При применении серверных данных:
- local.sync_status === "pending" → пропускаем (ждём push)
- local.updated_at > remote.updated_at → пропускаем (наши изменения новее)
- иначе → применяем серверную версию
```

## Exponential Backoff

При ошибке сети:
```
5s → 10s → 20s → 40s → 80s → 160s → 300s (максимум)
```
Счётчик сбрасывается при успешной синхронизации или событии `online`.

## Sync State (IndexedDB)

`sync_state` — key-value хранилище в IndexedDB (НЕ localStorage):

| Key | Value | Описание |
|-----|-------|----------|
| `device_id` | UUID | Уникальный ID устройства |
| `last_sync`  | ISO timestamp | Время последней успешной синхронизации |

Хранить в IndexedDB критично: `localStorage` может быть очищен браузером независимо от IndexedDB.

## Sync Queue (IndexedDB)

`sync_queue` — упорядоченная очередь операций для явного отслеживания:

```javascript
{
  id:          UUID,
  entity_type: "pets",
  entity_id:   UUID,
  operation:   "create" | "update" | "delete",
  payload:     { ...данные... },
  status:      "pending" | "failed",
  retry_count: 0,
  created_at:  ISO,
  next_retry_at: ISO,
  error:       null | "string"
}
```

## Порядок синхронизации

Порядок важен для соблюдения Foreign Key ограничений на сервере:
```
1. owners    (владельцы — нет зависимостей)
2. pets      (зависят от owners)
3. items     (нет зависимостей)
4. visits    (зависят от pets)
5. visit_items (зависят от visits)
6. vaccinations (зависят от pets)
7. staff     (нет зависимостей)
```

## Multi-Device синхронизация

- Каждое устройство генерирует UUID при первом запуске
- `device_id` передаётся в каждом sync-запросе
- Сервер хранит устройства в таблице `devices`
- Conflict resolution по `updated_at` работает корректно для multi-device

## Offline-Offline (без сервера вообще)

Если backend недоступен полностью:
1. Все операции работают только с IndexedDB
2. `sync_status = "pending"` накапливается
3. При появлении сети — автоматический push всего накопленного
4. Данные не теряются
