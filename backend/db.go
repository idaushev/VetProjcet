package main

import (
	"context"
	"database/sql"
	"fmt"
	"log"
	"os"
	"path/filepath"
	"strings"
	"time"

	_ "modernc.org/sqlite"
)

// ─── Схема базы данных ───────────────────────────────────────────────────────

const schema = `
PRAGMA journal_mode=WAL;
PRAGMA foreign_keys=ON;

-- ─── Устройства (для multi-device sync) ──────────────────────────────────
CREATE TABLE IF NOT EXISTS devices (
    id          TEXT PRIMARY KEY,
    name        TEXT NOT NULL DEFAULT '',
    last_seen_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    created_at  DATETIME DEFAULT CURRENT_TIMESTAMP
);

-- ─── Состояние синхронизации (key-value) ──────────────────────────────────
CREATE TABLE IF NOT EXISTS sync_state (
    key        TEXT PRIMARY KEY,
    value      TEXT NOT NULL,
    updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
);

-- ─── Пользователи и сессии (ТОЛЬКО сервер, в sync не участвуют) ──────────
-- Пользователь — это учётная запись для входа, НЕ сотрудник: админ или
-- регистратор могут не быть врачами. Связь с врачом — через staff_id,
-- и она необязательна. Хэши паролей на планшет не едут никогда.
CREATE TABLE IF NOT EXISTS users (
    id            TEXT PRIMARY KEY,
    login         TEXT NOT NULL UNIQUE,
    password_hash TEXT NOT NULL,          -- PBKDF2-SHA256, hex
    password_salt TEXT NOT NULL,          -- hex
    display_name  TEXT NOT NULL,
    role          TEXT NOT NULL DEFAULT 'doctor'
                  CHECK(role IN ('admin','doctor','reception','warehouse')),
    staff_id      TEXT,                   -- необязательная ссылка на clinic_staff
    permissions   TEXT,                   -- JSON прав: таблицы, суммы; пусто = всё разрешено
    is_active     INTEGER NOT NULL DEFAULT 1,
    created_at    DATETIME DEFAULT CURRENT_TIMESTAMP,
    updated_at    DATETIME DEFAULT CURRENT_TIMESTAMP
);

-- Сессии: в базе лежит ХЭШ токена, не сам токен — утечка базы не даёт входа.
CREATE TABLE IF NOT EXISTS sessions (
    token_hash TEXT PRIMARY KEY,
    user_id    TEXT NOT NULL,
    device_id  TEXT,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    expires_at DATETIME NOT NULL,
    FOREIGN KEY (user_id) REFERENCES users(id)
);

CREATE INDEX IF NOT EXISTS idx_sessions_user ON sessions(user_id);

-- ─── Персонал клиники ─────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS clinic_staff (
    id         TEXT PRIMARY KEY,
    name       TEXT NOT NULL,
    role       TEXT NOT NULL DEFAULT 'vet',
    phone      TEXT,
    email      TEXT,
    is_active  INTEGER NOT NULL DEFAULT 1,
    notes      TEXT,
    photo      TEXT,               -- фото сотрудника, base64 data URL (как pets.photo)
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    deleted_at DATETIME,
    is_deleted INTEGER NOT NULL DEFAULT 0,
    device_id  TEXT,
    version    INTEGER NOT NULL DEFAULT 1
);

CREATE INDEX IF NOT EXISTS idx_staff_role      ON clinic_staff(role);
CREATE INDEX IF NOT EXISTS idx_staff_updated   ON clinic_staff(updated_at);
CREATE INDEX IF NOT EXISTS idx_staff_deleted   ON clinic_staff(is_deleted);

-- ─── Владельцы животных ───────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS owners (
    id         TEXT PRIMARY KEY,
    fio        TEXT NOT NULL,
    -- Правила требуют ИИН для физлица или БИН для юрлица. Оба — 12 цифр,
    -- поэтому колонка одна, а owner_type говорит, как её подписывать.
    -- Владельцами бывают приюты и питомники, у них ФИО нет — в fio тогда
    -- лежит наименование организации.
    owner_type TEXT,          -- individual | legal
    iin        TEXT,
    phone      TEXT NOT NULL,
    address    TEXT,
    notes      TEXT,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    deleted_at DATETIME,
    is_deleted INTEGER NOT NULL DEFAULT 0,
    device_id  TEXT,
    version    INTEGER NOT NULL DEFAULT 1
);

CREATE INDEX IF NOT EXISTS idx_owners_fio   ON owners(fio);
CREATE INDEX IF NOT EXISTS idx_owners_phone ON owners(phone);
-- idx_owners_updated и idx_owners_deleted создаются в migrations после ALTER TABLE

-- ─── Животные ─────────────────────────────────────────────────────────────
-- status: active | deceased | transferred | lost
-- Физического удаления нет никогда. История визитов сохраняется всегда.
CREATE TABLE IF NOT EXISTS pets (
    id           TEXT PRIMARY KEY,
    owner_id     TEXT NOT NULL,
    name         TEXT NOT NULL,
    type         TEXT NOT NULL,
    gender       TEXT NOT NULL,
    birth_date   DATETIME,
    age          INTEGER,
    breed        TEXT,
    color        TEXT,
    chip_number  TEXT,
    chip_date    DATETIME,            -- дата чипирования (для реестра чипов)
    -- Поля под госреестр ТАҢБА. Все nullable: колонка NOT NULL DEFAULT ''
    -- в паре с nullableString('') уже роняла синк питомцев (см. photo).
    id_method    TEXT,                -- вид средства учёта: chip|tag|tattoo|other
    tanba_number TEXT,                -- индивидуальный номер животного в ТАҢБА
    tanba_at     DATETIME,            -- когда карточку внесли в ТАҢБА
    keep_address TEXT,                -- место содержания, если не совпадает с адресом владельца
    sterilized   INTEGER NOT NULL DEFAULT 0,
    sterilized_at DATETIME,
    photo        TEXT NOT NULL DEFAULT '',
    weight       REAL,
    status       TEXT NOT NULL DEFAULT 'active',
    death_date   DATETIME,
    death_reason TEXT,
    notes        TEXT,
    created_at   DATETIME DEFAULT CURRENT_TIMESTAMP,
    updated_at   DATETIME DEFAULT CURRENT_TIMESTAMP,
    deleted_at   DATETIME,
    is_deleted   INTEGER NOT NULL DEFAULT 0,
    device_id    TEXT,
    version      INTEGER NOT NULL DEFAULT 1,
    FOREIGN KEY (owner_id) REFERENCES owners(id)
);

CREATE INDEX IF NOT EXISTS idx_pets_owner   ON pets(owner_id);
CREATE INDEX IF NOT EXISTS idx_pets_name    ON pets(name);
CREATE INDEX IF NOT EXISTS idx_pets_status  ON pets(status);
CREATE INDEX IF NOT EXISTS idx_pets_updated ON pets(updated_at);
CREATE INDEX IF NOT EXISTS idx_pets_deleted ON pets(is_deleted);

-- ─── Результаты услуг: шаблоны протоколов и заполненные результаты ────────
--
-- Услуга может требовать результата: анализ, УЗИ, рентген. Результат бывает
-- файлом (скан, PDF из лаборатории) либо заполненным протоколом, а иногда и
-- тем и другим сразу — снимок плюс заключение.
CREATE TABLE IF NOT EXISTS protocol_templates (
    id         TEXT PRIMARY KEY,
    name       TEXT NOT NULL,
    kind       TEXT NOT NULL DEFAULT 'lab',   -- lab | ultrasound | xray | other
    -- fields — JSON-описание полей протокола:
    -- [{"key","label","type","unit","ref_low","ref_high","options":[...]}]
    -- Нормы (ref_low/ref_high) держим здесь, а не в коде: у кошки и собаки
    -- границы разные, и клиника правит их сама, не дожидаясь обновления.
    fields     TEXT NOT NULL DEFAULT '[]',
    notes      TEXT,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    deleted_at DATETIME,
    is_deleted INTEGER NOT NULL DEFAULT 0,
    device_id  TEXT,
    version    INTEGER NOT NULL DEFAULT 1,
    client_updated_at DATETIME
);
CREATE INDEX IF NOT EXISTS idx_prototpl_updated ON protocol_templates(updated_at);
CREATE INDEX IF NOT EXISTS idx_prototpl_deleted ON protocol_templates(is_deleted);

-- visit_results — ожидаемый или внесённый результат по конкретной услуге приёма.
--
-- Отдельная таблица, а не поля во вложениях: результат бывает протоколом БЕЗ
-- файла, а одна услуга может дать и снимок, и заключение. Главное же —
-- status='pending': это рабочий список «пробу взяли, результата нет».
-- Без него забытый анализ обнаруживается через неделю.
CREATE TABLE IF NOT EXISTS visit_results (
    id            TEXT PRIMARY KEY,
    visit_id      TEXT NOT NULL,
    pet_id        TEXT NOT NULL,          -- дублируем ради выборки «все результаты животного»
    visit_item_id TEXT,                   -- какая строка приёма породила результат
    item_id       TEXT,                   -- услуга из каталога
    -- Номер исследования по этой услуге внутри приёма (0,1,2…). Одно УЗИ за
    -- приём — не правило: смотрят брюшную полость и сердце, берут кровь до и
    -- после нагрузки. Без номера вторая такая же услуга сливалась с первой, и
    -- второй протокол негде было заполнить. Строку счёта как ключ взять
    -- нельзя: при каждом сохранении позиции удаляются и создаются заново.
    seq           INTEGER NOT NULL DEFAULT 0,
    title         TEXT NOT NULL,          -- название услуги на момент приёма
    template_id   TEXT,                   -- шаблон протокола, если заполняется вручную
    kind          TEXT NOT NULL DEFAULT 'protocol',  -- protocol | file
    -- values — JSON {"ключ_поля": "значение"}. Конфликт разрешается целиком по
    -- версии: два человека один протокол одновременно не заполняют.
    values_json   TEXT NOT NULL DEFAULT '{}',
    -- Описание полей на момент заполнения: [{key,label,type,unit,ref_low,…}].
    -- Дублирует шаблон НАМЕРЕННО. В values_json лежат только значения по
    -- ключам; подписи, единицы и нормы жили в шаблоне, и стоило клинике
    -- удалить или переделать бланк — таблица показателей в старых результатах
    -- исчезала: цифры целы, показать их нечем. Медицинская запись обязана
    -- читаться сама по себе, спустя годы и независимо от справочника.
    fields_snapshot TEXT,
    attachment_id TEXT,                   -- ссылка на файл, если kind='file'
    conclusion    TEXT,                   -- заключение врача свободным текстом
    status        TEXT NOT NULL DEFAULT 'pending',   -- pending | done
    filled_at     DATETIME,
    created_at    DATETIME DEFAULT CURRENT_TIMESTAMP,
    updated_at    DATETIME DEFAULT CURRENT_TIMESTAMP,
    deleted_at    DATETIME,
    is_deleted    INTEGER NOT NULL DEFAULT 0,
    device_id     TEXT,
    version       INTEGER NOT NULL DEFAULT 1,
    client_updated_at DATETIME,
    created_by    TEXT,
    updated_by    TEXT,
    FOREIGN KEY (visit_id) REFERENCES visits(id),
    FOREIGN KEY (pet_id)   REFERENCES pets(id)
);
CREATE INDEX IF NOT EXISTS idx_vres_visit   ON visit_results(visit_id);
CREATE INDEX IF NOT EXISTS idx_vres_pet     ON visit_results(pet_id);
CREATE INDEX IF NOT EXISTS idx_vres_status  ON visit_results(status);
CREATE INDEX IF NOT EXISTS idx_vres_updated ON visit_results(updated_at);
CREATE INDEX IF NOT EXISTS idx_vres_deleted ON visit_results(is_deleted);

-- ─── Каталог услуг и препаратов ───────────────────────────────────────────
CREATE TABLE IF NOT EXISTS items (
    id         TEXT PRIMARY KEY,
    name       TEXT NOT NULL,
    type       TEXT NOT NULL CHECK(type IN ('service','drug')),
    price      REAL NOT NULL DEFAULT 0,
    -- cost_price — кассовая стоимость в тенге. При cost_mode='percent'
    -- это вычисляемое значение: price * cost_percent / 100.
    -- Хранится всегда, чтобы отчёт и приём читали одно поле независимо от режима.
    cost_price REAL NOT NULL DEFAULT 0,
    -- cost_mode: fixed — кассовая задана суммой | percent — доля от цены
    cost_mode    TEXT NOT NULL DEFAULT 'fixed' CHECK(cost_mode IN ('fixed','percent')),
    cost_percent REAL NOT NULL DEFAULT 0,
    -- purchase_price — закупочная цена для склада (розница = price). Обновляется
    -- при поступлении и при изменении цен. Кассовая (cost_price) — отдельно.
    purchase_price REAL NOT NULL DEFAULT 0,
    is_active  INTEGER NOT NULL DEFAULT 1,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    deleted_at DATETIME,
    is_deleted INTEGER NOT NULL DEFAULT 0,
    device_id  TEXT,
    version    INTEGER NOT NULL DEFAULT 1
);

CREATE INDEX IF NOT EXISTS idx_items_name    ON items(name);
CREATE INDEX IF NOT EXISTS idx_items_type    ON items(type);
CREATE INDEX IF NOT EXISTS idx_items_updated ON items(updated_at);
CREATE INDEX IF NOT EXISTS idx_items_deleted ON items(is_deleted);

-- ─── Вложения к приёму (УЗИ, рентген, анализы) ───────────────────────────
-- Сам файл лежит на диске сервера (data/attachments/...), в базе только
-- метаданные. Причина: скан рентгена весит мегабайты, а база целиком ездит
-- через синхронизацию — base64 в таблице утопил бы планшет.
-- storage_path — путь относительно папки вложений, не абсолютный:
-- иначе перенос сервера или папки ломает все ссылки разом.
CREATE TABLE IF NOT EXISTS attachments (
    id           TEXT PRIMARY KEY,
    visit_id     TEXT NOT NULL,
    pet_id       TEXT NOT NULL,          -- дублируем ради выборки «все сканы животного»
    kind         TEXT NOT NULL DEFAULT 'other'
                 CHECK(kind IN ('ultrasound','xray','lab','photo','other')),
    file_name    TEXT NOT NULL,          -- исходное имя файла, как его видел врач
    mime_type    TEXT NOT NULL,
    size_bytes   INTEGER NOT NULL DEFAULT 0,
    storage_path TEXT NOT NULL,
    notes        TEXT,
    created_at   DATETIME DEFAULT CURRENT_TIMESTAMP,
    updated_at   DATETIME DEFAULT CURRENT_TIMESTAMP,
    deleted_at   DATETIME,
    is_deleted   INTEGER NOT NULL DEFAULT 0,
    device_id    TEXT,
    version      INTEGER NOT NULL DEFAULT 1,
    client_updated_at DATETIME,
    created_by   TEXT,
    updated_by   TEXT,
    FOREIGN KEY (visit_id) REFERENCES visits(id),
    FOREIGN KEY (pet_id)   REFERENCES pets(id)
);

CREATE INDEX IF NOT EXISTS idx_attach_visit   ON attachments(visit_id);
CREATE INDEX IF NOT EXISTS idx_attach_pet     ON attachments(pet_id);
CREATE INDEX IF NOT EXISTS idx_attach_updated ON attachments(updated_at);
CREATE INDEX IF NOT EXISTS idx_attach_deleted ON attachments(is_deleted);

-- ─── Приёмы (visits = appointments) ──────────────────────────────────────
CREATE TABLE IF NOT EXISTS visits (
    id                TEXT PRIMARY KEY,
    pet_id            TEXT NOT NULL,
    staff_id          TEXT,
    visit_type        TEXT NOT NULL DEFAULT 'первичный',
    animal_weight     REAL,
    date              DATETIME NOT NULL,
    next_visit_date   DATETIME,
    -- Курс лечения, назначенный на этом приёме.
    -- treatment_days — предполагаемая длительность в днях (0 = курс не назначен).
    -- treatment_until — дата окончания, считается при записи: date + treatment_days.
    -- Животное считается активным, пока есть приём с treatment_until >= сегодня.
    -- Дату храним отдельно, а не считаем на лету в каждом запросе: по ней идёт
    -- индекс, иначе выборка активных животных станет полным сканом.
    treatment_days    INTEGER NOT NULL DEFAULT 0,
    treatment_until   DATETIME,
    patient_condition TEXT,
    anamnesis         TEXT,
    diagnosis         TEXT,
    treatment         TEXT,
    notes             TEXT,
    total_amount      REAL NOT NULL DEFAULT 0,
    payment_card      REAL NOT NULL DEFAULT 0,
    change_log        TEXT NOT NULL DEFAULT '',
    created_at        DATETIME DEFAULT CURRENT_TIMESTAMP,
    updated_at        DATETIME DEFAULT CURRENT_TIMESTAMP,
    deleted_at        DATETIME,
    is_deleted        INTEGER NOT NULL DEFAULT 0,
    device_id         TEXT,
    version           INTEGER NOT NULL DEFAULT 1,
    FOREIGN KEY (pet_id)   REFERENCES pets(id),
    FOREIGN KEY (staff_id) REFERENCES clinic_staff(id)
);

CREATE INDEX IF NOT EXISTS idx_visits_pet     ON visits(pet_id);
CREATE INDEX IF NOT EXISTS idx_visits_date    ON visits(date);
CREATE INDEX IF NOT EXISTS idx_visits_updated ON visits(updated_at);
CREATE INDEX IF NOT EXISTS idx_visits_deleted ON visits(is_deleted);

-- ─── Позиции приёма (услуги/препараты) ───────────────────────────────────
CREATE TABLE IF NOT EXISTS visit_items (
    id         TEXT PRIMARY KEY,
    visit_id   TEXT NOT NULL,
    item_id    TEXT,
    name       TEXT,
    type       TEXT NOT NULL,
    quantity   REAL NOT NULL DEFAULT 1,
    price      REAL NOT NULL DEFAULT 0,
    total      REAL NOT NULL DEFAULT 0,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    deleted_at DATETIME,
    is_deleted INTEGER NOT NULL DEFAULT 0,
    device_id  TEXT,
    version    INTEGER NOT NULL DEFAULT 1,
    FOREIGN KEY (visit_id) REFERENCES visits(id)
);

CREATE INDEX IF NOT EXISTS idx_vitems_visit ON visit_items(visit_id);
-- idx_vitems_updated, idx_vitems_deleted создаются в migrations

-- ─── Вакцинации ───────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS vaccinations (
    id              TEXT PRIMARY KEY,
    pet_id          TEXT NOT NULL,
    staff_id        TEXT,
    vaccine_name    TEXT NOT NULL,
    batch_number    TEXT,
    manufacturer    TEXT,
    dose            REAL,
    administered_at DATETIME NOT NULL,
    next_due_at     DATETIME,
    notes           TEXT,
    created_at      DATETIME DEFAULT CURRENT_TIMESTAMP,
    updated_at      DATETIME DEFAULT CURRENT_TIMESTAMP,
    deleted_at      DATETIME,
    is_deleted      INTEGER NOT NULL DEFAULT 0,
    device_id       TEXT,
    version         INTEGER NOT NULL DEFAULT 1,
    FOREIGN KEY (pet_id)   REFERENCES pets(id),
    FOREIGN KEY (staff_id) REFERENCES clinic_staff(id)
);

CREATE INDEX IF NOT EXISTS idx_vacc_pet       ON vaccinations(pet_id);
CREATE INDEX IF NOT EXISTS idx_vacc_date      ON vaccinations(administered_at);
CREATE INDEX IF NOT EXISTS idx_vacc_next_due  ON vaccinations(next_due_at);
CREATE INDEX IF NOT EXISTS idx_vacc_updated   ON vaccinations(updated_at);
CREATE INDEX IF NOT EXISTS idx_vacc_deleted   ON vaccinations(is_deleted);

-- ── Склад (опциональный модуль) ────────────────────────────────────────
-- Склады. Если ни одного нет — сервер заводит дефолтный «Склад ветклиники».
CREATE TABLE IF NOT EXISTS warehouses (
    id         TEXT PRIMARY KEY,
    name       TEXT NOT NULL,
    is_default INTEGER NOT NULL DEFAULT 0,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    deleted_at DATETIME,
    is_deleted INTEGER NOT NULL DEFAULT 0,
    device_id  TEXT,
    version    INTEGER NOT NULL DEFAULT 1,
    client_updated_at DATETIME
);

-- Движения склада — append-only журнал. Остаток = SUM(qty) по (склад, позиция).
-- Ledger, а не изменяемый счётчик: два устройства офлайн лишь дописывают свои
-- движения, они сливаются объединением без конфликта потери остатка.
CREATE TABLE IF NOT EXISTS stock_movements (
    id             TEXT PRIMARY KEY,
    warehouse_id   TEXT NOT NULL,
    item_id        TEXT NOT NULL,
    -- kind: receipt(поступление,+) | writeoff(списание,−) | sale(продажа,−) |
    --       price(смена цен, qty=0) | adjust(корректировка/инвентаризация)
    kind           TEXT NOT NULL DEFAULT 'receipt',
    qty            REAL NOT NULL DEFAULT 0,   -- знак = направление: приход>0, расход<0
    purchase_price REAL NOT NULL DEFAULT 0,   -- закупочная (snapshot на момент движения)
    retail_price   REAL NOT NULL DEFAULT 0,   -- розничная (для продажи — цена реализации)
    reason         TEXT,                      -- причина списания/корректировки
    note           TEXT,
    occurred_at    DATETIME,                  -- дата операции (может отличаться от created_at)
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    deleted_at DATETIME,
    is_deleted INTEGER NOT NULL DEFAULT 0,
    device_id  TEXT,
    version    INTEGER NOT NULL DEFAULT 1,
    client_updated_at DATETIME
);
CREATE INDEX IF NOT EXISTS idx_stockmov_wh      ON stock_movements(warehouse_id);
CREATE INDEX IF NOT EXISTS idx_stockmov_item    ON stock_movements(item_id);
CREATE INDEX IF NOT EXISTS idx_stockmov_updated ON stock_movements(updated_at);
CREATE INDEX IF NOT EXISTS idx_stockmov_deleted ON stock_movements(is_deleted);
`

// ─── Миграции ────────────────────────────────────────────────────────────────
// Каждая миграция идемпотентна: ошибка "duplicate column name" игнорируется.

var migrations = []string{
	// owners
	`ALTER TABLE owners ADD COLUMN updated_at DATETIME DEFAULT CURRENT_TIMESTAMP`,
	`ALTER TABLE owners ADD COLUMN deleted_at DATETIME`,
	`ALTER TABLE owners ADD COLUMN is_deleted INTEGER NOT NULL DEFAULT 0`,
	`ALTER TABLE owners ADD COLUMN device_id TEXT`,
	`ALTER TABLE owners ADD COLUMN version INTEGER NOT NULL DEFAULT 1`,
	`ALTER TABLE owners ADD COLUMN notes TEXT`,
	`ALTER TABLE owners ADD COLUMN owner_type TEXT`,
	`CREATE INDEX IF NOT EXISTS idx_owners_updated ON owners(updated_at)`,
	`CREATE INDEX IF NOT EXISTS idx_owners_deleted ON owners(is_deleted)`,

	// pets
	`ALTER TABLE pets ADD COLUMN updated_at DATETIME DEFAULT CURRENT_TIMESTAMP`,
	`ALTER TABLE pets ADD COLUMN deleted_at DATETIME`,
	`ALTER TABLE pets ADD COLUMN is_deleted INTEGER NOT NULL DEFAULT 0`,
	`ALTER TABLE pets ADD COLUMN device_id TEXT`,
	`ALTER TABLE pets ADD COLUMN version INTEGER NOT NULL DEFAULT 1`,
	`ALTER TABLE pets ADD COLUMN status TEXT NOT NULL DEFAULT 'active'`,
	`ALTER TABLE pets ADD COLUMN death_date DATETIME`,
	`ALTER TABLE pets ADD COLUMN death_reason TEXT`,
	`ALTER TABLE pets ADD COLUMN color TEXT`,
	`ALTER TABLE pets ADD COLUMN weight REAL`,
	`ALTER TABLE pets ADD COLUMN notes TEXT`,
	`ALTER TABLE pets ADD COLUMN chip_number TEXT`,
	// Уникальность чипа — частичный индекс, намеренно:
	//  • пустые номера не участвуют (чип есть не у всех, иначе второе животное
	//    без чипа конфликтовало бы с первым);
	//  • мягко удалённые не участвуют (иначе удалённая карточка навсегда
	//    заблокировала бы номер при повторном заведении животного).
	`CREATE UNIQUE INDEX IF NOT EXISTS idx_pets_chip_unique ON pets(chip_number)
	   WHERE chip_number IS NOT NULL AND chip_number <> '' AND is_deleted = 0`,
	`CREATE INDEX IF NOT EXISTS idx_pets_chip ON pets(chip_number)`,
	`ALTER TABLE pets ADD COLUMN photo TEXT DEFAULT ''`,
	// Госреестр ТАҢБА: чипирование кошек и собак обязательно с 28.08.2026,
	// API у реестра нет — данные вносит человек через портал, поэтому наша
	// задача держать полный набор полей и видеть, кого ещё не внесли.
	`ALTER TABLE pets ADD COLUMN id_method TEXT`,
	`ALTER TABLE pets ADD COLUMN tanba_number TEXT`,
	`ALTER TABLE pets ADD COLUMN tanba_at DATETIME`,
	`ALTER TABLE pets ADD COLUMN keep_address TEXT`,
	`ALTER TABLE pets ADD COLUMN sterilized INTEGER NOT NULL DEFAULT 0`,
	`ALTER TABLE pets ADD COLUMN sterilized_at DATETIME`,
	`CREATE INDEX IF NOT EXISTS idx_pets_tanba ON pets(tanba_number)`,
	`CREATE INDEX IF NOT EXISTS idx_pets_status  ON pets(status)`,
	`CREATE INDEX IF NOT EXISTS idx_pets_updated ON pets(updated_at)`,
	`CREATE INDEX IF NOT EXISTS idx_pets_deleted ON pets(is_deleted)`,

	// items
	`ALTER TABLE items ADD COLUMN updated_at DATETIME DEFAULT CURRENT_TIMESTAMP`,
	`ALTER TABLE items ADD COLUMN deleted_at DATETIME`,
	`ALTER TABLE items ADD COLUMN is_deleted INTEGER NOT NULL DEFAULT 0`,
	`ALTER TABLE items ADD COLUMN device_id TEXT`,
	`ALTER TABLE items ADD COLUMN version INTEGER NOT NULL DEFAULT 1`,
	`ALTER TABLE items ADD COLUMN cost_price REAL DEFAULT 0`,
	`ALTER TABLE items ADD COLUMN cost_mode TEXT NOT NULL DEFAULT 'fixed'`,
	`ALTER TABLE items ADD COLUMN cost_percent REAL NOT NULL DEFAULT 0`,
	// Результат услуги: анализ, УЗИ, рентген. none — обычная услуга.
	`ALTER TABLE items ADD COLUMN result_mode TEXT NOT NULL DEFAULT 'none'`,
	`ALTER TABLE items ADD COLUMN protocol_id TEXT`,
	// items.purchase_price переехал в warehouseModule.Migrations() (M1.1) —
	// это дельта модуля склада на ядровой таблице.
	`CREATE INDEX IF NOT EXISTS idx_items_updated ON items(updated_at)`,
	`CREATE INDEX IF NOT EXISTS idx_items_deleted ON items(is_deleted)`,

	// visits
	`ALTER TABLE visits ADD COLUMN updated_at DATETIME DEFAULT CURRENT_TIMESTAMP`,
	`ALTER TABLE visits ADD COLUMN deleted_at DATETIME`,
	`ALTER TABLE visits ADD COLUMN is_deleted INTEGER NOT NULL DEFAULT 0`,
	`ALTER TABLE visits ADD COLUMN device_id TEXT`,
	`ALTER TABLE visits ADD COLUMN version INTEGER NOT NULL DEFAULT 1`,
	`ALTER TABLE visits ADD COLUMN staff_id TEXT`,
	`ALTER TABLE visits ADD COLUMN treatment TEXT`,
	`ALTER TABLE visits ADD COLUMN visit_type TEXT DEFAULT 'первичный'`,
	`ALTER TABLE visits ADD COLUMN animal_weight REAL`,
	`ALTER TABLE visits ADD COLUMN next_visit_date DATETIME`,
	`ALTER TABLE visits ADD COLUMN payment_card REAL NOT NULL DEFAULT 0`,
	`ALTER TABLE visits ADD COLUMN change_log TEXT DEFAULT ''`,
	`ALTER TABLE visits ADD COLUMN treatment_days INTEGER NOT NULL DEFAULT 0`,
	`ALTER TABLE visits ADD COLUMN discount REAL NOT NULL DEFAULT 0`,
	`ALTER TABLE visits ADD COLUMN discount_reason TEXT`,
	`ALTER TABLE visits ADD COLUMN treatment_until DATETIME`,
	`CREATE INDEX IF NOT EXISTS idx_visits_updated ON visits(updated_at)`,
	`CREATE INDEX IF NOT EXISTS idx_visits_deleted ON visits(is_deleted)`,
	// Индекс под выборку животных с активным курсом
	`CREATE INDEX IF NOT EXISTS idx_visits_treat_until ON visits(treatment_until)`,

	// visit_items
	`ALTER TABLE visit_items ADD COLUMN updated_at DATETIME DEFAULT CURRENT_TIMESTAMP`,
	`ALTER TABLE visit_items ADD COLUMN deleted_at DATETIME`,
	`ALTER TABLE visit_items ADD COLUMN is_deleted INTEGER NOT NULL DEFAULT 0`,
	`ALTER TABLE visit_items ADD COLUMN device_id TEXT`,
	`ALTER TABLE visit_items ADD COLUMN version INTEGER NOT NULL DEFAULT 1`,
	`CREATE INDEX IF NOT EXISTS idx_vitems_updated ON visit_items(updated_at)`,
	`CREATE INDEX IF NOT EXISTS idx_vitems_deleted ON visit_items(is_deleted)`,

	// ─── Нормализация формата дат ─────────────────────────────────────────────
	// Драйвер записывал time.Time как "2026-07-17 12:00:00 +0000 UTC" (Go String()).
	// SQLite такой формат не понимает — DATE() по нему пустой, а сравнения дат
	// строковые, и один момент времени в разных форматах сравнивается по-разному.
	// Приводим к RFC3339: "2026-07-17 12:00:00 +0000 UTC" → "2026-07-17T12:00:00Z".
	// Записи в SQL-формате ("2026-07-17 12:00:00" из CURRENT_TIMESTAMP) не трогаем:
	// SQLite их понимает штатно.
	`UPDATE visits SET date = replace(replace(date, ' +0000 UTC', 'Z'), ' ', 'T') WHERE date LIKE '% +0000 UTC'`,
	`UPDATE visits SET updated_at = replace(replace(updated_at, ' +0000 UTC', 'Z'), ' ', 'T') WHERE updated_at LIKE '% +0000 UTC'`,
	`UPDATE visits SET created_at = replace(replace(created_at, ' +0000 UTC', 'Z'), ' ', 'T') WHERE created_at LIKE '% +0000 UTC'`,
	`UPDATE visits SET next_visit_date = replace(replace(next_visit_date, ' +0000 UTC', 'Z'), ' ', 'T') WHERE next_visit_date LIKE '% +0000 UTC'`,
	`UPDATE visits SET deleted_at = replace(replace(deleted_at, ' +0000 UTC', 'Z'), ' ', 'T') WHERE deleted_at LIKE '% +0000 UTC'`,
	`UPDATE visit_items SET updated_at = replace(replace(updated_at, ' +0000 UTC', 'Z'), ' ', 'T') WHERE updated_at LIKE '% +0000 UTC'`,
	`UPDATE visit_items SET created_at = replace(replace(created_at, ' +0000 UTC', 'Z'), ' ', 'T') WHERE created_at LIKE '% +0000 UTC'`,
	`UPDATE visit_items SET deleted_at = replace(replace(deleted_at, ' +0000 UTC', 'Z'), ' ', 'T') WHERE deleted_at LIKE '% +0000 UTC'`,
	`UPDATE pets SET updated_at = replace(replace(updated_at, ' +0000 UTC', 'Z'), ' ', 'T') WHERE updated_at LIKE '% +0000 UTC'`,
	`UPDATE pets SET created_at = replace(replace(created_at, ' +0000 UTC', 'Z'), ' ', 'T') WHERE created_at LIKE '% +0000 UTC'`,
	`UPDATE pets SET birth_date = replace(replace(birth_date, ' +0000 UTC', 'Z'), ' ', 'T') WHERE birth_date LIKE '% +0000 UTC'`,
	`UPDATE pets SET death_date = replace(replace(death_date, ' +0000 UTC', 'Z'), ' ', 'T') WHERE death_date LIKE '% +0000 UTC'`,
	`UPDATE pets SET deleted_at = replace(replace(deleted_at, ' +0000 UTC', 'Z'), ' ', 'T') WHERE deleted_at LIKE '% +0000 UTC'`,
	`UPDATE owners SET updated_at = replace(replace(updated_at, ' +0000 UTC', 'Z'), ' ', 'T') WHERE updated_at LIKE '% +0000 UTC'`,
	`UPDATE owners SET created_at = replace(replace(created_at, ' +0000 UTC', 'Z'), ' ', 'T') WHERE created_at LIKE '% +0000 UTC'`,
	`UPDATE owners SET deleted_at = replace(replace(deleted_at, ' +0000 UTC', 'Z'), ' ', 'T') WHERE deleted_at LIKE '% +0000 UTC'`,
	`UPDATE items SET updated_at = replace(replace(updated_at, ' +0000 UTC', 'Z'), ' ', 'T') WHERE updated_at LIKE '% +0000 UTC'`,
	`UPDATE items SET created_at = replace(replace(created_at, ' +0000 UTC', 'Z'), ' ', 'T') WHERE created_at LIKE '% +0000 UTC'`,
	`UPDATE items SET deleted_at = replace(replace(deleted_at, ' +0000 UTC', 'Z'), ' ', 'T') WHERE deleted_at LIKE '% +0000 UTC'`,
	`UPDATE vaccinations SET updated_at = replace(replace(updated_at, ' +0000 UTC', 'Z'), ' ', 'T') WHERE updated_at LIKE '% +0000 UTC'`,
	`UPDATE vaccinations SET created_at = replace(replace(created_at, ' +0000 UTC', 'Z'), ' ', 'T') WHERE created_at LIKE '% +0000 UTC'`,
	`UPDATE vaccinations SET administered_at = replace(replace(administered_at, ' +0000 UTC', 'Z'), ' ', 'T') WHERE administered_at LIKE '% +0000 UTC'`,
	`UPDATE vaccinations SET next_due_at = replace(replace(next_due_at, ' +0000 UTC', 'Z'), ' ', 'T') WHERE next_due_at LIKE '% +0000 UTC'`,
	`UPDATE vaccinations SET deleted_at = replace(replace(deleted_at, ' +0000 UTC', 'Z'), ' ', 'T') WHERE deleted_at LIKE '% +0000 UTC'`,
	`UPDATE clinic_staff SET updated_at = replace(replace(updated_at, ' +0000 UTC', 'Z'), ' ', 'T') WHERE updated_at LIKE '% +0000 UTC'`,
	`UPDATE clinic_staff SET created_at = replace(replace(created_at, ' +0000 UTC', 'Z'), ' ', 'T') WHERE created_at LIKE '% +0000 UTC'`,
	`UPDATE clinic_staff SET deleted_at = replace(replace(deleted_at, ' +0000 UTC', 'Z'), ' ', 'T') WHERE deleted_at LIKE '% +0000 UTC'`,

	// ─── Время клиента для разрешения конфликтов ──────────────────────────────
	// updated_at хранит время СЕРВЕРА — на нём держится инкрементальный pull,
	// и менять это нельзя. Но сравнивать серверное время с клиентским нельзя тоже:
	// клиентское всегда раньше (оно родилось до отправки), поэтому клиент проигрывал
	// любой конфликт и его правки молча отклонялись.
	// Здесь лежит время клиента как есть — сравниваем его с временем клиента.
	`ALTER TABLE owners ADD COLUMN client_updated_at DATETIME`,
	`ALTER TABLE pets ADD COLUMN client_updated_at DATETIME`,
	`ALTER TABLE items ADD COLUMN client_updated_at DATETIME`,
	`ALTER TABLE visits ADD COLUMN client_updated_at DATETIME`,
	`ALTER TABLE visit_items ADD COLUMN client_updated_at DATETIME`,
	`ALTER TABLE vaccinations ADD COLUMN client_updated_at DATETIME`,
	`ALTER TABLE clinic_staff ADD COLUMN client_updated_at DATETIME`,

	// ─── Авторство записей ────────────────────────────────────────────────────
	// Задел под роли и аудит: кто создал и кто последним изменил запись.
	// Сейчас клиника работает как один врач с одного планшета, понятия
	// «текущий пользователь» ещё нет, поэтому поля пустые и ничем не заполняются.
	// Колонки заводим заранее, чтобы потом не мигрировать схему на живых планшетах.
	// Значение — clinic_staff.id; FK не ставим намеренно: записи приезжают
	// с планшета через синхронизацию, и запись не должна отвергаться из-за того,
	// что сотрудник ещё не доехал.
	`ALTER TABLE owners ADD COLUMN created_by TEXT`,
	`ALTER TABLE owners ADD COLUMN updated_by TEXT`,
	`ALTER TABLE pets ADD COLUMN created_by TEXT`,
	`ALTER TABLE pets ADD COLUMN updated_by TEXT`,
	`ALTER TABLE items ADD COLUMN created_by TEXT`,
	`ALTER TABLE items ADD COLUMN updated_by TEXT`,
	`ALTER TABLE visits ADD COLUMN created_by TEXT`,
	`ALTER TABLE visits ADD COLUMN updated_by TEXT`,
	// VET-003. Статус приёма: completed | draft.
	// ИНФОРМАЦИОННЫЙ — ничего не блокирует и не влияет на выручку и отчёты.
	// Он отвечает на вопрос «эта запись дописана?»: приём, ждущий анализа,
	// раньше выглядел точно так же, как закрытый. Значение по умолчанию
	// 'completed' сознательно: все существующие приёмы и все новые сохранения
	// сохраняют сегодняшний смысл, а незавершённость врач отмечает явно.
	`ALTER TABLE visits ADD COLUMN status TEXT NOT NULL DEFAULT 'completed'`,
	`CREATE INDEX IF NOT EXISTS idx_visits_status ON visits(status)`,
	// VET-007: прививка, сделанная НА приёме, была связана с ним только по
	// животному и дате — через полгода при разборе реакции приходилось
	// сопоставлять записи вручную. Ссылка необязательная: вакцинация остаётся
	// самостоятельной сущностью (её заводят и вне приёма, и задним числом).
	`ALTER TABLE vaccinations ADD COLUMN visit_id TEXT`,
	`CREATE INDEX IF NOT EXISTS idx_vacc_visit ON vaccinations(visit_id)`,
	// VET-013 (ответ клиники на вопрос 7: «нужно добавить, это у питомца
	// каждого должно быть»). Аллергии и непереносимости — сведение о
	// БЕЗОПАСНОСТИ, и хранить его в общих заметках нельзя: заметки в форме
	// приёма не показываются, а решение о препарате принимается именно там.
	// Поле у ЖИВОТНОГО, а не у приёма: особенность принадлежит пациенту.
	// Переносить нечего — до сих пор таких данных в системе не было.
	`ALTER TABLE pets ADD COLUMN allergies TEXT`,
	// VET-009 (ответ на вопрос 9: «всегда разные, чаще всего вес и
	// температура»). Вес уже есть отдельной колонкой. Температура —
	// вторая по частоте, поэтому отдельным числом: по ней нужна динамика.
	// Остальные показатели у клиники непостоянны, и навязывать им фиксированный
	// список полей значило бы заставлять заполнять ненужное — они пишутся
	// парами «название: значение» в vitals.
	`ALTER TABLE visits ADD COLUMN temperature REAL`,
	`ALTER TABLE visits ADD COLUMN vitals TEXT`,
	// VET-008 (ответ клиники на вопрос 14: «нужна»). Кто делал исследование,
	// раньше читалось только из названия услуги — то есть никак, если услуга
	// называется «Биохимия крови». При разборе спорного результата это первое,
	// что спрашивают. Поле свободное: список лабораторий у клиники не
	// фиксирован, а справочник ради двух-трёх названий — лишняя сущность.
	`ALTER TABLE visit_results ADD COLUMN lab_name TEXT`,
	`ALTER TABLE visit_results ADD COLUMN seq INTEGER NOT NULL DEFAULT 0`,
	`ALTER TABLE visit_results ADD COLUMN fields_snapshot TEXT`,
	`ALTER TABLE visit_items ADD COLUMN created_by TEXT`,
	`ALTER TABLE visit_items ADD COLUMN updated_by TEXT`,
	`ALTER TABLE vaccinations ADD COLUMN created_by TEXT`,
	`ALTER TABLE vaccinations ADD COLUMN updated_by TEXT`,
	`ALTER TABLE clinic_staff ADD COLUMN photo TEXT`,
	`ALTER TABLE users ADD COLUMN permissions TEXT`,
	`ALTER TABLE pets ADD COLUMN chip_date DATETIME`,
	`ALTER TABLE clinic_staff ADD COLUMN created_by TEXT`,
	`ALTER TABLE clinic_staff ADD COLUMN updated_by TEXT`,

	// ─── Портал владельцев ────────────────────────────────────────────────
	// Сессии владельцев отдельно от users/sessions: владелец — не сотрудник,
	// у него нет пароля (вход по телефону) и нет прав на основное API.
	`CREATE TABLE IF NOT EXISTS owner_sessions (
	    token_hash TEXT PRIMARY KEY,
	    owner_id   TEXT NOT NULL,
	    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
	    expires_at DATETIME NOT NULL,
	    FOREIGN KEY (owner_id) REFERENCES owners(id)
	)`,
	`CREATE INDEX IF NOT EXISTS idx_owner_sessions_owner ON owner_sessions(owner_id)`,

	// ─── Телеграм-бот (архитектурный задел) ──────────────────────────────
	// Привязка владельца к чату бота. Заполняется, когда владелец напишет
	// боту /start <код привязки> (см. docs/TELEGRAM.md).
	`CREATE TABLE IF NOT EXISTS owner_telegram (
	    owner_id  TEXT PRIMARY KEY,
	    chat_id   INTEGER NOT NULL,
	    username  TEXT,
	    linked_at DATETIME DEFAULT CURRENT_TIMESTAMP,
	    FOREIGN KEY (owner_id) REFERENCES owners(id)
	)`,
	// Одноразовые коды привязки: выдаются в клинике/портале, владелец
	// отправляет боту, бот связывает chat_id с owner_id.
	`CREATE TABLE IF NOT EXISTS telegram_link_codes (
	    code       TEXT PRIMARY KEY,
	    owner_id   TEXT NOT NULL,
	    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
	    expires_at DATETIME NOT NULL,
	    used_at    DATETIME
	)`,
	// Outbox уведомлений: всё, что бот должен отправить. Пишем сюда,
	// фоновый отправитель доставляет и помечает. Если владелец ещё не
	// привязан (chat_id NULL) — строка ждёт привязки.
	`CREATE TABLE IF NOT EXISTS notifications (
	    id         INTEGER PRIMARY KEY AUTOINCREMENT,
	    owner_id   TEXT,
	    chat_id    INTEGER,
	    kind       TEXT NOT NULL,             -- portal_access | visit_reminder | vaccination_due | custom
	    message    TEXT NOT NULL,
	    status     TEXT NOT NULL DEFAULT 'pending',  -- pending | sent | error
	    error      TEXT,
	    ref_id     TEXT,                      -- id записи/вакцинации: дедупликация напоминаний
	    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
	    sent_at    DATETIME
	)`,
	`CREATE INDEX IF NOT EXISTS idx_notifications_status ON notifications(status)`,
	`ALTER TABLE notifications ADD COLUMN ref_id TEXT`,

	// ─── Расписание: запись на приём ──────────────────────────────────────
	// Владелец/питомец могут быть и не из базы (позвонил новый клиент) —
	// тогда заполняются текстовые client_name/client_phone/pet_name.
	// visit_id проставляется, когда запись превратилась в состоявшийся приём.
	`CREATE TABLE IF NOT EXISTS appointments (
	    id            TEXT PRIMARY KEY,
	    owner_id      TEXT,
	    pet_id        TEXT,
	    staff_id      TEXT,
	    client_name   TEXT,
	    client_phone  TEXT,
	    pet_name      TEXT,
	    starts_at     DATETIME NOT NULL,
	    duration_min  INTEGER NOT NULL DEFAULT 30,
	    reason        TEXT,
	    status        TEXT NOT NULL DEFAULT 'scheduled',  -- scheduled|done|cancelled|no_show
	    visit_id      TEXT,
	    notes         TEXT,
	    created_at    DATETIME DEFAULT CURRENT_TIMESTAMP,
	    updated_at    DATETIME DEFAULT CURRENT_TIMESTAMP,
	    deleted_at    DATETIME,
	    is_deleted    INTEGER NOT NULL DEFAULT 0,
	    device_id     TEXT,
	    version       INTEGER NOT NULL DEFAULT 1,
	    client_updated_at DATETIME,
	    created_by    TEXT,
	    updated_by    TEXT
	)`,
	`CREATE INDEX IF NOT EXISTS idx_appts_starts  ON appointments(starts_at)`,
	`CREATE INDEX IF NOT EXISTS idx_appts_updated ON appointments(updated_at)`,
	`CREATE INDEX IF NOT EXISTS idx_appts_deleted ON appointments(is_deleted)`,
	// source — откуда пришла запись: 'portal' (создал владелец) или пусто (клиника).
	// confirmed — подтвердил ли регистратор. Записи клиники подтверждены сразу
	// (DEFAULT 1); заявки с портала приходят с confirmed=0 и попадают в очередь.
	`ALTER TABLE appointments ADD COLUMN source TEXT`,
	`ALTER TABLE appointments ADD COLUMN confirmed INTEGER NOT NULL DEFAULT 1`,

	// Одноразовые пароли входа на портал. Выдаёт телеграм-бот по запросу
	// владельца; действуют 10 минут, сгорают после первого входа.
	`CREATE TABLE IF NOT EXISTS portal_codes (
	    owner_id   TEXT NOT NULL,
	    code       TEXT NOT NULL,
	    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
	    expires_at DATETIME NOT NULL,
	    used_at    DATETIME
	)`,
	`CREATE INDEX IF NOT EXISTS idx_portal_codes_owner ON portal_codes(owner_id)`,

	// Партия и срок годности приходят вместе с поступлением: у каждой партии
	// свой срок. Для ветпрепаратов это не учёт, а безопасность пациента —
	// просроченное нельзя вколоть, и клиника должна узнать об этом заранее,
	// а не в момент применения.
	`ALTER TABLE stock_movements ADD COLUMN batch TEXT`,
	`ALTER TABLE stock_movements ADD COLUMN expires_at DATETIME`,

	// Отзывы после приёма (NPS). Живут вне общего синка: ответы приходят
	// в бот на сервере, на планшете не правятся.
	`CREATE TABLE IF NOT EXISTS visit_feedback (
	    id          INTEGER PRIMARY KEY AUTOINCREMENT,
	    visit_id    TEXT NOT NULL,
	    owner_id    TEXT NOT NULL,
	    score       INTEGER,
	    comment     TEXT,
	    asked_at    DATETIME,
	    answered_at DATETIME
	)`,
	`CREATE INDEX IF NOT EXISTS idx_feedback_owner ON visit_feedback(owner_id)`,
	`CREATE UNIQUE INDEX IF NOT EXISTS idx_feedback_visit ON visit_feedback(visit_id)`,

	// Ручные задачи сотрудникам («перезвонить клиенту», «заказать препарат»).
	// Автоматический список «Требуют внимания» на дашборде закрывает только
	// то, что система может вывести сама; всё остальное сейчас живёт
	// в голове и на бумажках.
	`CREATE TABLE IF NOT EXISTS tasks (
	    id          TEXT PRIMARY KEY,
	    title       TEXT NOT NULL,
	    note        TEXT NOT NULL DEFAULT '',
	    due_date    DATETIME,
	    done        INTEGER NOT NULL DEFAULT 0,
	    owner_ref   TEXT,               -- владелец, к которому относится задача
	    staff_id    TEXT,               -- на кого назначена (пусто = на всех)
	    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
	    updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
	    client_updated_at DATETIME,
	    deleted_at DATETIME,
	    is_deleted INTEGER NOT NULL DEFAULT 0,
	    device_id  TEXT,
	    version    INTEGER NOT NULL DEFAULT 1
	)`,

	// VET-015: задача «позвонить через три дня, спросить про переносимость»
	// заводилась на владельца — без животного и без приёма, и исполнитель не
	// понимал, о каком случае речь. Ссылки необязательные: организационные
	// задачи («заказать корм») к пациенту не относятся.
	// Идут СРАЗУ ПОСЛЕ создания tasks: сама таблица тоже заводится миграцией,
	// и ALTER выше по списку падал бы с «no such table».
	`ALTER TABLE tasks ADD COLUMN pet_id TEXT`,
	`ALTER TABLE tasks ADD COLUMN visit_id TEXT`,
	`CREATE INDEX IF NOT EXISTS idx_tasks_pet ON tasks(pet_id)`,
	`CREATE INDEX IF NOT EXISTS idx_tasks_visit ON tasks(visit_id)`,

	// ─── F4 / VET-004: назначения ────────────────────────────────────────
	//
	// До сих пор назначение жило свободным текстом в visits.treatment вместе с
	// рекомендациями владельцу. Через три недели другой врач читал «амоксиклав
	// 2р/д 7 дней, диета» и не мог восстановить ни дозу, ни когда курс кончился.
	//
	// СОСТАВ ПОЛЕЙ — ответ клиники на вопрос 1, дословно: препарат, доза,
	// единица, путь введения, длительность, инструкция. КРАТНОСТИ в ответе нет,
	// хотя в вопросе она перечислялась: «2 раза в день» пишется в инструкции.
	// Отдельной колонки под неё нет намеренно — добавить проще, чем убрать.
	//
	// Доза — ОДНО число (ответ на вопрос 2: «абсолютная»). Пары «значение +
	// база расчёта» и пересчёта по весу нет.
	//
	// Разделения «назначено / выдано на руки» нет (ответ на вопрос 3: «Нет»).
	//
	// status — ответ на вопрос 4 («Да»): active | cancelled | stopped.
	// Нормально доведённый до конца курс отдельным статусом НЕ помечается:
	// это выводится из started_at + duration_days. Статусы нужны только для
	// прерываний: отменён (не давать) и завершён досрочно (давали, прекратили).
	`CREATE TABLE IF NOT EXISTS prescriptions (
	    id            TEXT PRIMARY KEY,
	    visit_id      TEXT NOT NULL,
	    pet_id        TEXT NOT NULL,      -- дублируем ради выборки «вся терапия животного»
	    staff_id      TEXT,               -- кто назначил
	    item_id       TEXT,               -- позиция каталога, если препарат оттуда
	    drug_name     TEXT NOT NULL,      -- название на момент назначения
	    dose          REAL,
	    dose_unit     TEXT,               -- мл, мг, таб, кап, г
	    route         TEXT,               -- внутрь, п/к, в/м, в/в, наружно, в глаза, в уши
	    duration_days INTEGER,
	    instruction   TEXT,               -- сюда же кратность: «по 1 таб 2 раза в день»
	    started_at    DATETIME,           -- начало курса (по умолчанию дата приёма)
	    status        TEXT NOT NULL DEFAULT 'active'
	                  CHECK(status IN ('active','cancelled','stopped')),
	    status_note   TEXT,               -- почему отменён/прекращён
	    status_at     DATETIME,           -- когда сменили статус
	    change_log    TEXT,               -- история правок, как у visits
	    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
	    updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
	    client_updated_at DATETIME,
	    deleted_at DATETIME,
	    is_deleted INTEGER NOT NULL DEFAULT 0,
	    device_id  TEXT,
	    version    INTEGER NOT NULL DEFAULT 1,
	    created_by TEXT,
	    updated_by TEXT,
	    FOREIGN KEY (visit_id) REFERENCES visits(id),
	    FOREIGN KEY (pet_id)   REFERENCES pets(id)
	)`,
	`CREATE INDEX IF NOT EXISTS idx_presc_visit   ON prescriptions(visit_id)`,
	`CREATE INDEX IF NOT EXISTS idx_presc_pet     ON prescriptions(pet_id)`,
	`CREATE INDEX IF NOT EXISTS idx_presc_status  ON prescriptions(status)`,
	`CREATE INDEX IF NOT EXISTS idx_presc_updated ON prescriptions(updated_at)`,

	// Справочник диагнозов с готовым текстом лечения и рекомендаций.
	// Врач выбирает диагноз — система подставляет заготовку, врач правит.
	// Это же даёт статистику «частые диагнозы»: сейчас diagnosis — свободная
	// строка, и посчитать по ней ничего нельзя.
	`CREATE TABLE IF NOT EXISTS diagnosis_templates (
	    id              TEXT PRIMARY KEY,
	    name            TEXT NOT NULL,
	    treatment       TEXT NOT NULL DEFAULT '',
	    recommendations TEXT NOT NULL DEFAULT '',
	    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
	    updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
	    client_updated_at DATETIME,
	    deleted_at DATETIME,
	    is_deleted INTEGER NOT NULL DEFAULT 0,
	    device_id  TEXT,
	    version    INTEGER NOT NULL DEFAULT 1
	)`,

	// Служебное состояние бота (offset длинного опроса getUpdates и т.п.)
	`CREATE TABLE IF NOT EXISTS telegram_state (
	    key   TEXT PRIMARY KEY,
	    value TEXT NOT NULL
	)`,

	// Редактируемые из UI настройки сервера (токен бота, имя бота, адрес
	// портала, телефон клиники, вкл/выкл напоминаний). Пусто в этой таблице —
	// действует значение из переменной окружения (обратная совместимость).
	`CREATE TABLE IF NOT EXISTS server_settings (
	    key   TEXT PRIMARY KEY,
	    value TEXT NOT NULL
	)`,
}

// ─── openDB ──────────────────────────────────────────────────────────────────

func openDB(dbPath string) (*sql.DB, error) {
	if err := os.MkdirAll(filepath.Dir(dbPath), 0o755); err != nil {
		return nil, fmt.Errorf("create data directory: %w", err)
	}

	db, err := sql.Open("sqlite", dbPath)
	if err != nil {
		return nil, fmt.Errorf("open sqlite: %w", err)
	}

	// SQLite не поддерживает параллельную запись — одно соединение достаточно.
	db.SetMaxOpenConns(1)
	db.SetConnMaxLifetime(5 * time.Minute)

	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()

	if err := db.PingContext(ctx); err != nil {
		db.Close()
		return nil, fmt.Errorf("ping sqlite: %w", err)
	}

	if _, err := db.ExecContext(ctx, schema); err != nil {
		db.Close()
		return nil, fmt.Errorf("apply schema: %w", err)
	}

	if err := runMigrations(ctx, db); err != nil {
		db.Close()
		return nil, fmt.Errorf("run migrations: %w", err)
	}

	migrateUsersRoleCheck(ctx, db)
	seedDefaultWarehouse(ctx, db)
	seedProtocolTemplates(ctx, db)
	backfillResultFields(ctx, db)

	return db, nil
}

// migrateUsersRoleCheck расширяет CHECK на роли (добавляет 'warehouse').
// SQLite не умеет менять CHECK через ALTER — пересобираем таблицу. Идемпотентно:
// делаем только если текущая схема не допускает 'warehouse'.
func migrateUsersRoleCheck(ctx context.Context, db *sql.DB) {
	var ddl string
	if err := db.QueryRowContext(ctx, `SELECT sql FROM sqlite_master WHERE type='table' AND name='users'`).Scan(&ddl); err != nil {
		return
	}
	if strings.Contains(ddl, "warehouse") {
		return // уже расширено
	}
	stmts := []string{
		`PRAGMA foreign_keys=off`,
		`CREATE TABLE users_new (
		    id TEXT PRIMARY KEY, login TEXT NOT NULL UNIQUE,
		    password_hash TEXT NOT NULL, password_salt TEXT NOT NULL,
		    display_name TEXT NOT NULL,
		    role TEXT NOT NULL DEFAULT 'doctor' CHECK(role IN ('admin','doctor','reception','warehouse')),
		    staff_id TEXT, permissions TEXT, is_active INTEGER NOT NULL DEFAULT 1,
		    created_at DATETIME DEFAULT CURRENT_TIMESTAMP, updated_at DATETIME DEFAULT CURRENT_TIMESTAMP)`,
		`INSERT INTO users_new (id, login, password_hash, password_salt, display_name, role, staff_id, permissions, is_active, created_at, updated_at)
		 SELECT id, login, password_hash, password_salt, display_name, role, staff_id, permissions, is_active, created_at, updated_at FROM users`,
		`DROP TABLE users`,
		`ALTER TABLE users_new RENAME TO users`,
		`PRAGMA foreign_keys=on`,
	}
	for _, s := range stmts {
		if _, err := db.ExecContext(ctx, s); err != nil {
			// Частичный сбой не должен ронять старт: логируем неявно и выходим.
			db.ExecContext(ctx, `DROP TABLE IF EXISTS users_new`)
			return
		}
	}
}

// seedDefaultWarehouse заводит «Склад ветклиники», если складов ещё нет.
// Требование ТЗ: при одном складе он есть по умолчанию. Строка синкается
// клиентам; видна только при включённом модуле склада.
func seedDefaultWarehouse(ctx context.Context, db *sql.DB) {
	var n int
	if err := db.QueryRowContext(ctx, `SELECT COUNT(*) FROM warehouses WHERE is_deleted=0`).Scan(&n); err != nil || n > 0 {
		return
	}
	id, err := newUUID()
	if err != nil {
		return
	}
	_, _ = db.ExecContext(ctx,
		`INSERT INTO warehouses (id, name, is_default, device_id, version) VALUES (?, 'Склад ветклиники', 1, 'server', 1)`,
		id)
}

func runMigrations(ctx context.Context, db *sql.DB) error {
	// Миграции ядра, затем миграции модулей (по реестру). Одинаковая
	// идемпотентная терпимость: дубль колонки/таблицы — не ошибка.
	all := append(append([]string{}, migrations...), moduleMigrations()...)
	for _, q := range all {
		if _, err := db.ExecContext(ctx, q); err != nil {
			msg := strings.ToLower(err.Error())
			// Идемпотентные ошибки — игнорируем
			if strings.Contains(msg, "duplicate column name") ||
				strings.Contains(msg, "already exists") {
				continue
			}
			qLen := len(q)
			if qLen > 40 {
				qLen = 40
			}
			return fmt.Errorf("migration %q: %w", q[:qLen], err)
		}
	}
	return nil
}

// backfillResultFields проставляет снимок полей уже заполненным результатам,
// у которых его ещё нет.
//
// Записи, сделанные до появления снимка, живут ровно с той же угрозой: удалят
// или переделают бланк — и таблица показателей в них исчезнет. Пока шаблон на
// месте, его можно переписать в саму запись, и тогда её уже ничем не испортить.
// Позже такой возможности не будет, поэтому делаем это при каждом запуске: с
// планшетов, которые ещё не обновились, продолжают приезжать результаты без
// снимка.
//
// Только status='done': у ожидающего результата значений ещё нет, и замораживать
// бланк до заполнения нельзя — врач должен получить актуальный.
//
// updated_at двигаем намеренно: иначе снимок останется только на сервере, а на
// планшете запись деградирует по-прежнему. Версию НЕ трогаем — это не правка
// содержания, и она не должна выигрывать конфликт у настоящей правки с планшета.
func backfillResultFields(ctx context.Context, db *sql.DB) {
	res, err := db.ExecContext(ctx, `
		UPDATE visit_results
		SET fields_snapshot = (SELECT t.fields FROM protocol_templates t
		                        WHERE t.id = visit_results.template_id),
		    updated_at = ?
		WHERE status = 'done'
		  AND COALESCE(fields_snapshot,'') = ''
		  AND COALESCE(template_id,'') <> ''
		  AND EXISTS (SELECT 1 FROM protocol_templates t
		               WHERE t.id = visit_results.template_id
		                 AND COALESCE(t.fields,'') NOT IN ('', '[]'))`, T(nowUTC()))
	if err != nil {
		return
	}
	if n, _ := res.RowsAffected(); n > 0 {
		log.Printf("[vet] снимок полей проставлен %d результатам", n)
	}
}
