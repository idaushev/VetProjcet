package main

import (
	"context"
	"database/sql"
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
	Name string // JSON-ключ ответа pull и имя в логах: "owners"
	// pushAll применяет все записи сущности из payload (гейт прав внутри),
	// считает accepted/skipped в res. nil — сущность только для pull (вложения).
	pushAll func(ctx context.Context, a *app, p *syncPushPayload, userID string, canPush func(string) bool, res *syncPushResult)
	// pull загружает изменённые с since записи для сборки ответа.
	pull func(ctx context.Context, db *sql.DB, since time.Time) (any, error)
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
			pushAll: func(ctx context.Context, a *app, p *syncPushPayload, uid string, cp func(string) bool, res *syncPushResult) {
				pushRecords(ctx, a, p.Owners, "owners", "owners", uid, cp, pushOwner, res)
			},
			pull: func(ctx context.Context, db *sql.DB, since time.Time) (any, error) { return pullOwners(ctx, db, since) },
		},
		{
			Name: "pets",
			pushAll: func(ctx context.Context, a *app, p *syncPushPayload, uid string, cp func(string) bool, res *syncPushResult) {
				pushRecords(ctx, a, p.Pets, "pets", "pets", uid, cp, pushPet, res)
			},
			pull: func(ctx context.Context, db *sql.DB, since time.Time) (any, error) { return pullPets(ctx, db, since) },
		},
		{
			Name: "items",
			pushAll: func(ctx context.Context, a *app, p *syncPushPayload, uid string, cp func(string) bool, res *syncPushResult) {
				pushRecords(ctx, a, p.Items, "items", "items", uid, cp, pushItem, res)
			},
			pull: func(ctx context.Context, db *sql.DB, since time.Time) (any, error) { return pullItems(ctx, db, since) },
		},
		{
			Name: "visits",
			pushAll: func(ctx context.Context, a *app, p *syncPushPayload, uid string, cp func(string) bool, res *syncPushResult) {
				pushRecords(ctx, a, p.Visits, "visits", "visits", uid, cp, pushVisit, res)
			},
			pull: func(ctx context.Context, db *sql.DB, since time.Time) (any, error) { return pullVisits(ctx, db, since) },
		},
		{
			Name: "visit_items",
			pushAll: func(ctx context.Context, a *app, p *syncPushPayload, uid string, cp func(string) bool, res *syncPushResult) {
				pushRecords(ctx, a, p.VisitItems, "visits", "visit_items", uid, cp, pushVisitItem, res)
			},
			pull: func(ctx context.Context, db *sql.DB, since time.Time) (any, error) { return pullVisitItems(ctx, db, since) },
		},
		{
			Name: "vaccinations",
			pushAll: func(ctx context.Context, a *app, p *syncPushPayload, uid string, cp func(string) bool, res *syncPushResult) {
				pushRecords(ctx, a, p.Vaccinations, "vaccinations", "vaccinations", uid, cp, pushVaccination, res)
			},
			pull: func(ctx context.Context, db *sql.DB, since time.Time) (any, error) { return pullVaccinations(ctx, db, since) },
		},
		{
			Name: "staff",
			pushAll: func(ctx context.Context, a *app, p *syncPushPayload, uid string, cp func(string) bool, res *syncPushResult) {
				pushRecords(ctx, a, p.Staff, "staff", "clinic_staff", uid, cp, pushStaff, res)
			},
			pull: func(ctx context.Context, db *sql.DB, since time.Time) (any, error) { return pullStaff(ctx, db, since) },
		},
		{
			Name: "appointments",
			pushAll: func(ctx context.Context, a *app, p *syncPushPayload, uid string, cp func(string) bool, res *syncPushResult) {
				pushRecords(ctx, a, p.Appointments, "visits", "appointments", uid, cp, pushAppointment, res)
			},
			pull: func(ctx context.Context, db *sql.DB, since time.Time) (any, error) { return pullAppointments(ctx, db, since) },
		},
		{
			Name: "warehouses",
			pushAll: func(ctx context.Context, a *app, p *syncPushPayload, uid string, cp func(string) bool, res *syncPushResult) {
				pushRecords(ctx, a, p.Warehouses, "warehouse", "warehouses", uid, cp, pushWarehouse, res)
			},
			pull: func(ctx context.Context, db *sql.DB, since time.Time) (any, error) { return pullWarehouses(ctx, db, since) },
		},
		{
			Name: "stock_movements",
			pushAll: func(ctx context.Context, a *app, p *syncPushPayload, uid string, cp func(string) bool, res *syncPushResult) {
				pushRecords(ctx, a, p.StockMovements, "warehouse", "stock_movements", uid, cp, pushStockMovement, res)
			},
			pull: func(ctx context.Context, db *sql.DB, since time.Time) (any, error) { return pullStockMovements(ctx, db, since) },
		},
		{
			Name:    "attachments", // только pull: метаданные вложений, файлы качаются отдельно
			pushAll: nil,
			pull:    func(ctx context.Context, db *sql.DB, since time.Time) (any, error) { return pullAttachments(ctx, db, since) },
		},
	}
}
