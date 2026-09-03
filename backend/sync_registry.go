package main

import (
	"context"
	"database/sql"
	"encoding/json"
	"time"
)

// ─── Реестр синкаемых сущностей ──────────────────────────────────────────────
//
// syncEntity описывает одну синкаемую сущность для ОБОБЩЁННОГО диспетчера
// push/pull. Оборачивает существующие типизированные pushX/pullX — вся ручная
// логика (SQL, разрешение конфликтов, nullable, resolveCost) остаётся в них.
// Реестр (упорядоченный) заменяет захардкоженные блоки в handleSyncPush/
// handleSyncPull; модули добавят свои сущности через SyncEntities() (M2.3).
// См. docs/MODULES.md, раздел «Синк».
type syncEntity struct {
	Name string // JSON-ключ (в push и в ответе pull) и имя в логах: "owners"
	// pushAll декодирует записи сущности из сырого payload (raw[Name]) и
	// применяет их (гейт прав внутри), считает accepted/skipped в res.
	// nil — сущность только для pull (вложения).
	pushAll func(ctx context.Context, a *app, raw map[string]json.RawMessage, userID string, canPush func(string) bool, res *syncPushResult)
	// pull загружает изменённые с since записи для сборки ответа.
	pull func(ctx context.Context, db *sql.DB, since time.Time) (any, error)
}

// pushEntity — декодирует записи одной сущности из сырого payload и применяет
// их. Ядро больше не знает поля сущностей: их несёт только тип записи T,
// объявленный рядом с pushFn (в т.ч. в модуле). Неизвестные ключи payload
// (device_id и пр.) сюда не попадают — их обрабатывает handleSyncPush.
func pushEntity[T interface{ recordID() string }](
	ctx context.Context, a *app, raw map[string]json.RawMessage,
	key, permTable, authorTable, userID string,
	canPush func(string) bool,
	pushFn func(context.Context, *sql.DB, T) (bool, error),
	res *syncPushResult,
) {
	rawRecs, ok := raw[key]
	if !ok || len(rawRecs) == 0 {
		return
	}
	var recs []T
	if err := json.Unmarshal(rawRecs, &recs); err != nil {
		a.logger.Printf("syncPush %s decode: %v", key, err)
		return
	}
	pushRecords(ctx, a, recs, permTable, authorTable, userID, canPush, pushFn, res)
}

// recordID — общий доступ к id записи для обобщённого push (простановка автора,
// логи). Все *SyncRecord несут поле ID.
func (r ownerSyncRecord) recordID() string         { return r.ID }
func (r petSyncRecord) recordID() string           { return r.ID }
func (r itemSyncRecord) recordID() string          { return r.ID }
func (r visitSyncRecord) recordID() string         { return r.ID }
func (r visitItemSyncRecord) recordID() string     { return r.ID }
func (r vaccinationSyncRecord) recordID() string   { return r.ID }
func (r staffSyncRecord) recordID() string         { return r.ID }
func (r appointmentSyncRecord) recordID() string   { return r.ID }
func (r warehouseSyncRecord) recordID() string     { return r.ID }
func (r stockMovementSyncRecord) recordID() string { return r.ID }

// pushRecords — общий цикл push одной сущности: гейт прав (позиции целиком),
// апсерт каждой записи через её pushFn, простановка автора, подсчёт. Дженерик —
// чтобы сохранить типобезопасность записей и переиспользуемость pushX.
func pushRecords[T interface{ recordID() string }](
	ctx context.Context, a *app, recs []T,
	permTable, authorTable, userID string,
	canPush func(string) bool,
	pushFn func(context.Context, *sql.DB, T) (bool, error),
	res *syncPushResult,
) {
	if len(recs) == 0 {
		return
	}
	if !canPush(permTable) {
		res.Skipped += len(recs)
		a.logger.Printf("syncPush %s: отклонено, у %s нет права записи", permTable, userID)
		return
	}
	for _, rec := range recs {
		if ok, err := pushFn(ctx, a.db, rec); ok {
			a.stampAuthor(ctx, authorTable, rec.recordID(), userID)
			res.Accepted++
		} else {
			if err != nil {
				a.logger.Printf("syncPush %s %s: %v", permTable, rec.recordID(), err)
			}
			res.Skipped++
		}
	}
}

// coreSyncEntities — сущности ядра в порядке внешних ключей
// (owners → pets → items → visits → visit_items → vaccinations → staff →
// appointments → warehouses → stock_movements). Порядок важен для push (FK).
// Вложения (attachments) — только pull (файлы грузятся отдельно), pushAll nil.
//
// permTable — виртуальная таблица прав (canPush): visit_items и appointments
// идут под правом "visits"; склад — под "warehouse".
// authorTable — реальная таблица для stampAuthor (staff → "clinic_staff").
func coreSyncEntities() []syncEntity {
	return []syncEntity{
		{
			Name: "owners",
			pushAll: func(ctx context.Context, a *app, raw map[string]json.RawMessage, uid string, cp func(string) bool, res *syncPushResult) {
				pushEntity(ctx, a, raw, "owners", "owners", "owners", uid, cp, pushOwner, res)
			},
			pull: func(ctx context.Context, db *sql.DB, since time.Time) (any, error) { return pullOwners(ctx, db, since) },
		},
		{
			Name: "pets",
			pushAll: func(ctx context.Context, a *app, raw map[string]json.RawMessage, uid string, cp func(string) bool, res *syncPushResult) {
				pushEntity(ctx, a, raw, "pets", "pets", "pets", uid, cp, pushPet, res)
			},
			pull: func(ctx context.Context, db *sql.DB, since time.Time) (any, error) { return pullPets(ctx, db, since) },
		},
		{
			Name: "items",
			pushAll: func(ctx context.Context, a *app, raw map[string]json.RawMessage, uid string, cp func(string) bool, res *syncPushResult) {
				pushEntity(ctx, a, raw, "items", "items", "items", uid, cp, pushItem, res)
			},
			pull: func(ctx context.Context, db *sql.DB, since time.Time) (any, error) { return pullItems(ctx, db, since) },
		},
		{
			Name: "visits",
			pushAll: func(ctx context.Context, a *app, raw map[string]json.RawMessage, uid string, cp func(string) bool, res *syncPushResult) {
				pushEntity(ctx, a, raw, "visits", "visits", "visits", uid, cp, pushVisit, res)
			},
			pull: func(ctx context.Context, db *sql.DB, since time.Time) (any, error) { return pullVisits(ctx, db, since) },
		},
		{
			Name: "visit_items",
			pushAll: func(ctx context.Context, a *app, raw map[string]json.RawMessage, uid string, cp func(string) bool, res *syncPushResult) {
				pushEntity(ctx, a, raw, "visit_items", "visits", "visit_items", uid, cp, pushVisitItem, res)
			},
			pull: func(ctx context.Context, db *sql.DB, since time.Time) (any, error) { return pullVisitItems(ctx, db, since) },
		},
		{
			// Назначения идут ПОСЛЕ visits: у них visit_id NOT NULL, и приём
			// должен доехать первым, иначе вставка упадёт по внешнему ключу.
			Name: "prescriptions",
			pushAll: func(ctx context.Context, a *app, raw map[string]json.RawMessage, uid string, cp func(string) bool, res *syncPushResult) {
				pushEntity(ctx, a, raw, "prescriptions", "visits", "prescriptions", uid, cp, pushPrescription, res)
			},
			pull: func(ctx context.Context, db *sql.DB, since time.Time) (any, error) { return pullPrescriptions(ctx, db, since) },
		},
		{
			Name: "vaccinations",
			pushAll: func(ctx context.Context, a *app, raw map[string]json.RawMessage, uid string, cp func(string) bool, res *syncPushResult) {
				pushEntity(ctx, a, raw, "vaccinations", "vaccinations", "vaccinations", uid, cp, pushVaccination, res)
			},
			pull: func(ctx context.Context, db *sql.DB, since time.Time) (any, error) { return pullVaccinations(ctx, db, since) },
		},
		{
			Name: "staff",
			pushAll: func(ctx context.Context, a *app, raw map[string]json.RawMessage, uid string, cp func(string) bool, res *syncPushResult) {
				pushEntity(ctx, a, raw, "staff", "staff", "clinic_staff", uid, cp, pushStaff, res)
			},
			pull: func(ctx context.Context, db *sql.DB, since time.Time) (any, error) { return pullStaff(ctx, db, since) },
		},
		{
			Name: "appointments",
			pushAll: func(ctx context.Context, a *app, raw map[string]json.RawMessage, uid string, cp func(string) bool, res *syncPushResult) {
				pushEntity(ctx, a, raw, "appointments", "appointments", "appointments", uid, cp, pushAppointment, res)
			},
			pull: func(ctx context.Context, db *sql.DB, since time.Time) (any, error) { return pullAppointments(ctx, db, since) },
		},
		{
			Name: "tasks",
			pushAll: func(ctx context.Context, a *app, raw map[string]json.RawMessage, uid string, cp func(string) bool, res *syncPushResult) {
				pushEntity(ctx, a, raw, "tasks", "tasks", "tasks", uid, cp, pushTask, res)
			},
			pull: func(ctx context.Context, db *sql.DB, since time.Time) (any, error) { return pullTasks(ctx, db, since) },
		},
		{
			Name: "diagnosis_templates",
			pushAll: func(ctx context.Context, a *app, raw map[string]json.RawMessage, uid string, cp func(string) bool, res *syncPushResult) {
				pushEntity(ctx, a, raw, "diagnosis_templates", "visits", "diagnosis_templates", uid, cp, pushDiagnosis, res)
			},
			pull: func(ctx context.Context, db *sql.DB, since time.Time) (any, error) { return pullDiagnoses(ctx, db, since) },
		},
		{
			// Шаблоны протоколов правит только администратор, но синкуются они
			// как обычная таблица: врачу нужен шаблон офлайн, чтобы заполнить.
			// Гейт прав — на маршрутах (requireAdmin), а не в синке.
			Name: "protocol_templates",
			pushAll: func(ctx context.Context, a *app, raw map[string]json.RawMessage, uid string, cp func(string) bool, res *syncPushResult) {
				pushEntity(ctx, a, raw, "protocol_templates", "items", "protocol_templates", uid, cp, pushProtocol, res)
			},
			pull: func(ctx context.Context, db *sql.DB, since time.Time) (any, error) { return pullProtocols(ctx, db, since) },
		},
		{
			// Результаты живут под правами приёмов: кто ведёт приём, тот и
			// вносит результат.
			Name: "visit_results",
			pushAll: func(ctx context.Context, a *app, raw map[string]json.RawMessage, uid string, cp func(string) bool, res *syncPushResult) {
				pushEntity(ctx, a, raw, "visit_results", "visits", "visit_results", uid, cp, pushVisitResult, res)
			},
			pull: func(ctx context.Context, db *sql.DB, since time.Time) (any, error) { return pullVisitResults(ctx, db, since) },
		},
		{
			Name:    "attachments", // только pull: метаданные вложений, файлы качаются отдельно
			pushAll: nil,
			pull:    func(ctx context.Context, db *sql.DB, since time.Time) (any, error) { return pullAttachments(ctx, db, since) },
		},
	}
}

// warehouseSyncEntities — синкаемые сущности модуля склада (объявляются через
// warehouseModule.SyncEntities()). Права — по виртуальной таблице "warehouse".
// Идут после ядра, поэтому FK stock_movements → items выполняется.
func warehouseSyncEntities() []syncEntity {
	return []syncEntity{
		{
			Name: "warehouses",
			pushAll: func(ctx context.Context, a *app, raw map[string]json.RawMessage, uid string, cp func(string) bool, res *syncPushResult) {
				pushEntity(ctx, a, raw, "warehouses", "warehouse", "warehouses", uid, cp, pushWarehouse, res)
			},
			pull: func(ctx context.Context, db *sql.DB, since time.Time) (any, error) { return pullWarehouses(ctx, db, since) },
		},
		{
			Name: "stock_movements",
			pushAll: func(ctx context.Context, a *app, raw map[string]json.RawMessage, uid string, cp func(string) bool, res *syncPushResult) {
				pushEntity(ctx, a, raw, "stock_movements", "warehouse", "stock_movements", uid, cp, pushStockMovement, res)
			},
			pull: func(ctx context.Context, db *sql.DB, since time.Time) (any, error) { return pullStockMovements(ctx, db, since) },
		},
	}
}

// syncEntities — полный упорядоченный список: сущности ядра, затем сущности
// модулей (реестр). Порядок важен для push (внешние ключи). Диспетчеры
// handleSyncPush/handleSyncPull идут по нему.
func syncEntities() []syncEntity {
	return append(coreSyncEntities(), moduleSyncEntities()...)
}
