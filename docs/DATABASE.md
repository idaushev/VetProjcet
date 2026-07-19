# База данных

## Обзор

| БД | Где | Для чего |
|----|-----|----------|
| SQLite (WAL) | Backend сервер | Источник истины, хранение всех данных |
| IndexedDB | Android-планшет (браузер) | Локальная копия, offline-работа |

## Общие поля (все сущности)

Каждая таблица/стор содержит синхронизационные метаданные:

| Поле | Тип | Описание |
|------|-----|----------|
| `id` | TEXT (UUID) | Клиентский UUID, первичный ключ |
| `created_at` | DATETIME | Время создания |
| `updated_at` | DATETIME | Время последнего изменения — используется для sync |
| `deleted_at` | DATETIME NULL | Время мягкого удаления |
| `is_deleted` | INTEGER (0/1) | Флаг мягкого удаления |
| `device_id` | TEXT NULL | UUID устройства, создавшего/изменившего запись |
| `version` | INTEGER | Версия записи (инкрементируется при каждом UPDATE) |

В IndexedDB дополнительно:
| Поле | Описание |
|------|----------|
| `server_id` | UUID на сервере (может отличаться от client id) |
| `sync_status` | `pending` | `synced` — статус синхронизации |

## Схема SQLite

### owners (Владельцы)
```sql
id TEXT PK, fio TEXT, iin TEXT NULL, phone TEXT, address TEXT NULL,
notes TEXT NULL, [sync fields]
```

### pets (Животные)
```sql
id TEXT PK, owner_id TEXT FK→owners, name TEXT, type TEXT, gender TEXT(m/f),
birth_date DATETIME NULL, age INTEGER NULL, breed TEXT NULL,
color TEXT NULL, weight REAL NULL,
status TEXT DEFAULT 'active',  -- active | deceased | transferred | lost
death_date DATETIME NULL,      -- дата смерти (только для deceased)
death_reason TEXT NULL,        -- причина смерти
notes TEXT NULL,
[sync fields]
```

**Жизненный цикл питомца:**
- `status = 'active'` — живёт, активные приёмы
- `status = 'deceased'` — умер. Все визиты и вакцинации сохранены.
- `status = 'transferred'` — передан другому владельцу
- `status = 'lost'` — пропал
- `is_deleted = 1` — запись скрыта (ошибка ввода данных). Медицинская история всё равно сохраняется.

### items (Каталог услуг и препаратов)
```sql
id TEXT PK, name TEXT, type TEXT CHECK(IN('service','drug')),
price REAL, is_active INTEGER DEFAULT 1, [sync fields]
```

### visits (Приёмы)
```sql
id TEXT PK, pet_id TEXT FK→pets, staff_id TEXT NULL FK→clinic_staff,
date DATETIME, patient_condition TEXT NULL, anamnesis TEXT NULL,
diagnosis TEXT NULL, treatment TEXT NULL, notes TEXT NULL,
total_amount REAL DEFAULT 0, [sync fields]
```

`patient_condition` enum: удовлетворительное | средней тяжести | тяжелое | крайне тяжелое | терминальное

### visit_items (Позиции приёма)
```sql
id TEXT PK, visit_id TEXT FK→visits, item_id TEXT NULL FK→items,
name TEXT NULL, type TEXT, quantity REAL, price REAL, total REAL,
[sync fields]
```

### vaccinations (Вакцинации)
```sql
id TEXT PK, pet_id TEXT FK→pets, staff_id TEXT NULL FK→clinic_staff,
vaccine_name TEXT, batch_number TEXT NULL, manufacturer TEXT NULL,
dose REAL NULL, administered_at DATETIME, next_due_at DATETIME NULL,
notes TEXT NULL, [sync fields]
```

### clinic_staff (Персонал)
```sql
id TEXT PK, name TEXT, role TEXT DEFAULT 'vet',
phone TEXT NULL, email TEXT NULL, is_active INTEGER DEFAULT 1,
notes TEXT NULL, [sync fields]
```

### devices (Устройства)
```sql
id TEXT PK, name TEXT, last_seen_at DATETIME, created_at DATETIME
```

### sync_state (Key-Value состояние сервера)
```sql
key TEXT PK, value TEXT, updated_at DATETIME
```

## IndexedDB Schema (Browser)

**DB_NAME**: `vetclinic-pwa`  
**DB_VERSION**: `2`

**Entity Stores**: owners, pets, items, visits, visit_items, vaccinations, staff
- keyPath: `id`
- indexes: `sync_status`, `updated_at`, `is_deleted`, domain-specific

**Meta Stores**:
- `sync_queue` — очередь операций для синхронизации
- `sync_state` — key-value (last_sync, device_id)
- `devices` — зарегистрированные устройства

## Стратегия мягкого удаления

**Никогда не удаляем физически** медицинские данные:

1. `pets` — только `is_deleted=1` или смена `status`
2. При удалении владельца — каскадный soft-delete питомцев и их визитов
3. При удалении питомца — каскадный soft-delete визитов и вакцинаций
4. При удалении визита — soft-delete всех visit_items

Исключение: `items` из каталога деактивируются (`is_active=0`), а не удаляются.

## Индексы

Для производительности sync-запросов на каждой таблице:
```sql
INDEX updated_at  -- для инкрементального pull: WHERE updated_at > ?since
INDEX is_deleted  -- для фильтрации активных записей
```

## Миграции

Система миграций в `db.go` идемпотентна:
- Каждый ALTER TABLE / CREATE INDEX выполняется при каждом старте
- Ошибки "duplicate column name" и "already exists" игнорируются
- Добавление новых полей — добавить строку в срез `migrations`
