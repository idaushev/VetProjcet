package main

import (
	"context"
	"database/sql"
	"fmt"
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
                  CHECK(role IN ('admin','doctor','reception')),
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
	    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
	    sent_at    DATETIME
	)`,
	`CREATE INDEX IF NOT EXISTS idx_notifications_status ON notifications(status)`,

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

	// Служебное состояние бота (offset длинного опроса getUpdates и т.п.)
	`CREATE TABLE IF NOT EXISTS telegram_state (
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

	return db, nil
}

func runMigrations(ctx context.Context, db *sql.DB) error {
	for _, q := range migrations {
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
