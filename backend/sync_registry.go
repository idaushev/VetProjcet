package main

import (
	"context"
	"database/sql"
	"encoding/json"
	"strings"
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
	// PermTable — строка прав, под которой сущность и отправляется, и
	// загружается. ЕДИНСТВЕННОЕ место этого отображения: раньше push и pull
	// держали по своей копии, копии разошлись, и результаты исследований
	// уезжали на планшет тем, кому приёмы закрыты. Спутник приёма — "visits".
	PermTable string
	// pushAll декодирует записи сущности из сырого payload (raw[Name]) и
	// применяет их (гейт прав внутри, по perm = PermTable), считает
	// accepted/skipped в res. nil — сущность только для pull (вложения).
	pushAll func(ctx context.Context, a *app, raw map[string]json.RawMessage, perm, userID string, canPush func(string) bool, res *syncPushResult)
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
	// Записи разбираем ПО ОДНОЙ: одна неразборная запись (не тот тип поля)
	// раньше роняла декодирование всего пакета сущности — все записи
	// отбрасывались без единой отметки, а планшет считал их отправленными.
	var items []json.RawMessage
	if err := json.Unmarshal(rawRecs, &items); err != nil {
		a.logger.Printf("syncPush %s decode: %v", key, err)
		return // не массив — id не извлечь, сообщить не о чем
	}
	pushDevice, _ := ctx.Value(ctxKeyPushDevice{}).(string)
	recs := make([]T, 0, len(items))
	for _, it := range items {
		if pushDevice != "" {
			it = withDeviceID(it, pushDevice)
		}
		var rec T
		if err := json.Unmarshal(it, &rec); err != nil {
			var idOnly struct {
				ID string `json:"id"`
			}
			_ = json.Unmarshal(it, &idOnly)
			a.logger.Printf("syncPush %s %s decode: %v", key, idOnly.ID, err)
			res.reject(key, idOnly.ID, "запись не разобрана сервером", err)
			continue
		}
		recs = append(recs, rec)
	}
	pushRecords(ctx, a, recs, key, permTable, authorTable, userID, canPush, pushFn, res)
}

// reject — запись не принята: планшет оставит её неотправленной (B-013).
// Внешний ключ называем отдельно: это самый частый и самый понятный случай —
// на сервере нет записи, на которую эта ссылается.
func (r *syncPushResult) reject(entity, id, reason string, err error) {
	if err != nil {
		msg := err.Error()
		if strings.Contains(msg, "FOREIGN KEY") {
			reason = "на сервере нет связанной записи (врача, животного или приёма)"
		}
		if len(msg) > 200 {
			msg = msg[:200]
		}
		reason += ": " + msg
	}
	r.Rejected = append(r.Rejected, pushReject{Entity: entity, ID: id, Reason: reason})
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
	key, permTable, authorTable, userID string,
	canPush func(string) bool,
	pushFn func(context.Context, *sql.DB, T) (bool, error),
	res *syncPushResult,
) {
	if len(recs) == 0 {
		return
	}
	if !canPush(permTable) {
		a.logger.Printf("syncPush %s: отклонено, у %s нет права записи", permTable, userID)
		for _, rec := range recs {
			res.reject(key, rec.recordID(), "нет права на запись", nil)
			res.Rejected[len(res.Rejected)-1].Permanent = true
		}
		return
	}
	for _, rec := range recs {
		if ok, err := pushFn(ctx, a.db, rec); ok {
			a.stampAuthor(ctx, authorTable, rec.recordID(), userID)
			res.Accepted++
		} else {
			if err != nil {
				// Не «сервер новее», а отказ записи — планшет обязан узнать.
				a.logger.Printf("syncPush %s %s: %v", key, rec.recordID(), err)
				res.reject(key, rec.recordID(), "сервер не смог записать", err)
				continue
			}
			res.Skipped++
		}
	}
}

// coreSyncEntities — сущности ядра в порядке внешних ключей
// (owners → pets → items → staff → visits → visit_items → prescriptions →
// vaccinations → appointments → … → warehouses → stock_movements). Порядок важен для push (FK).
// Вложения (attachments) — только pull (файлы грузятся отдельно), pushAll nil.
//
// PermTable — виртуальная таблица прав для push и pull: спутники приёма
// (visit_items, prescriptions, visit_results, attachments) идут под "visits",
// расписание — под своим "appointments", склад — под "warehouse".
// authorTable — реальная таблица для stampAuthor (staff → "clinic_staff").
func coreSyncEntities() []syncEntity {
	return []syncEntity{
		{
			Name:      "owners",
			PermTable: "owners",
			pushAll: func(ctx context.Context, a *app, raw map[string]json.RawMessage, perm, uid string, cp func(string) bool, res *syncPushResult) {
				pushEntity(ctx, a, raw, "owners", perm, "owners", uid, cp, pushOwner, res)
			},
			pull: func(ctx context.Context, db *sql.DB, since time.Time) (any, error) { return pullOwners(ctx, db, since) },
		},
		{
			Name:      "pets",
			PermTable: "pets",
			pushAll: func(ctx context.Context, a *app, raw map[string]json.RawMessage, perm, uid string, cp func(string) bool, res *syncPushResult) {
				pushEntity(ctx, a, raw, "pets", perm, "pets", uid, cp, pushPet, res)
			},
			pull: func(ctx context.Context, db *sql.DB, since time.Time) (any, error) { return pullPets(ctx, db, since) },
		},
		{
			Name:      "items",
			PermTable: "items",
			pushAll: func(ctx context.Context, a *app, raw map[string]json.RawMessage, perm, uid string, cp func(string) bool, res *syncPushResult) {
				pushEntity(ctx, a, raw, "items", perm, "items", uid, cp, pushItem, res)
			},
			pull: func(ctx context.Context, db *sql.DB, since time.Time) (any, error) { return pullItems(ctx, db, since) },
		},
		// Сотрудники — ДО приёмов и вакцинаций: у них внешний ключ staff_id.
		// Стояли после, и новый врач с его первым приёмом в одном push
		// отклонялись по внешнему ключу (B-009).
		{
			Name:      "staff",
			PermTable: "staff",
			pushAll: func(ctx context.Context, a *app, raw map[string]json.RawMessage, perm, uid string, cp func(string) bool, res *syncPushResult) {
				pushEntity(ctx, a, raw, "staff", perm, "clinic_staff", uid, cp, pushStaff, res)
			},
			pull: func(ctx context.Context, db *sql.DB, since time.Time) (any, error) { return pullStaff(ctx, db, since) },
		},
		{
			Name:      "visits",
			PermTable: "visits",
			pushAll: func(ctx context.Context, a *app, raw map[string]json.RawMessage, perm, uid string, cp func(string) bool, res *syncPushResult) {
				pushEntity(ctx, a, raw, "visits", perm, "visits", uid, cp, pushVisit, res)
			},
			pull: func(ctx context.Context, db *sql.DB, since time.Time) (any, error) { return pullVisits(ctx, db, since) },
		},
		{
			Name:      "visit_items",
			PermTable: "visits",
			pushAll: func(ctx context.Context, a *app, raw map[string]json.RawMessage, perm, uid string, cp func(string) bool, res *syncPushResult) {
				pushEntity(ctx, a, raw, "visit_items", perm, "visit_items", uid, cp, pushVisitItem, res)
			},
			pull: func(ctx context.Context, db *sql.DB, since time.Time) (any, error) { return pullVisitItems(ctx, db, since) },
		},
		{
			// Назначения идут ПОСЛЕ visits: у них visit_id NOT NULL, и приём
			// должен доехать первым, иначе вставка упадёт по внешнему ключу.
			Name:      "prescriptions",
			PermTable: "visits",
			pushAll: func(ctx context.Context, a *app, raw map[string]json.RawMessage, perm, uid string, cp func(string) bool, res *syncPushResult) {
				pushEntity(ctx, a, raw, "prescriptions", perm, "prescriptions", uid, cp, pushPrescription, res)
			},
			pull: func(ctx context.Context, db *sql.DB, since time.Time) (any, error) { return pullPrescriptions(ctx, db, since) },
		},
		{
			Name:      "vaccinations",
			PermTable: "vaccinations",
			pushAll: func(ctx context.Context, a *app, raw map[string]json.RawMessage, perm, uid string, cp func(string) bool, res *syncPushResult) {
				pushEntity(ctx, a, raw, "vaccinations", perm, "vaccinations", uid, cp, pushVaccination, res)
			},
			pull: func(ctx context.Context, db *sql.DB, since time.Time) (any, error) { return pullVaccinations(ctx, db, since) },
		},
		{
			Name:      "appointments",
			PermTable: "appointments",
			pushAll: func(ctx context.Context, a *app, raw map[string]json.RawMessage, perm, uid string, cp func(string) bool, res *syncPushResult) {
				pushEntity(ctx, a, raw, "appointments", perm, "appointments", uid, cp, pushAppointment, res)
			},
			pull: func(ctx context.Context, db *sql.DB, since time.Time) (any, error) { return pullAppointments(ctx, db, since) },
		},
		{
			Name:      "tasks",
			PermTable: "tasks",
			pushAll: func(ctx context.Context, a *app, raw map[string]json.RawMessage, perm, uid string, cp func(string) bool, res *syncPushResult) {
				pushEntity(ctx, a, raw, "tasks", perm, "tasks", uid, cp, pushTask, res)
			},
			pull: func(ctx context.Context, db *sql.DB, since time.Time) (any, error) { return pullTasks(ctx, db, since) },
		},
		{
			// Право «templates», а не «visits»: справочник — общая настройка
			// клиники, а не медицинская запись конкретного приёма.
			Name:      "diagnosis_templates",
			PermTable: "templates",
			pushAll: func(ctx context.Context, a *app, raw map[string]json.RawMessage, perm, uid string, cp func(string) bool, res *syncPushResult) {
				pushEntity(ctx, a, raw, "diagnosis_templates", perm, "diagnosis_templates", uid, cp, pushDiagnosis, res)
			},
			pull: func(ctx context.Context, db *sql.DB, since time.Time) (any, error) { return pullDiagnoses(ctx, db, since) },
		},
		{
			// Шаблоны протоколов правит только администратор, но синкуются они
			// как обычная таблица: врачу нужен шаблон офлайн, чтобы заполнить.
			// Гейт прав — на маршрутах (requireAdmin), а не в синке.
			// Право «templates», а не «items»: раньше правку бланков анализов
			// открывало право на каталог — цены и протоколы разные вещи.
			Name:      "protocol_templates",
			PermTable: "templates",
			pushAll: func(ctx context.Context, a *app, raw map[string]json.RawMessage, perm, uid string, cp func(string) bool, res *syncPushResult) {
				pushEntity(ctx, a, raw, "protocol_templates", perm, "protocol_templates", uid, cp, pushProtocol, res)
			},
			pull: func(ctx context.Context, db *sql.DB, since time.Time) (any, error) { return pullProtocols(ctx, db, since) },
		},
		{
			// Результаты живут под правами приёмов: кто ведёт приём, тот и
			// вносит результат.
			Name:      "visit_results",
			PermTable: "visits",
			pushAll: func(ctx context.Context, a *app, raw map[string]json.RawMessage, perm, uid string, cp func(string) bool, res *syncPushResult) {
				pushEntity(ctx, a, raw, "visit_results", perm, "visit_results", uid, cp, pushVisitResult, res)
			},
			pull: func(ctx context.Context, db *sql.DB, since time.Time) (any, error) { return pullVisitResults(ctx, db, since) },
		},
		{
			Name:      "attachments", // только pull: метаданные вложений, файлы качаются отдельно
			PermTable: "visits",
			pushAll:   nil,
			pull:      func(ctx context.Context, db *sql.DB, since time.Time) (any, error) { return pullAttachments(ctx, db, since) },
		},
	}
}

// warehouseSyncEntities — синкаемые сущности модуля склада (объявляются через
// warehouseModule.SyncEntities()). Права — по виртуальной таблице "warehouse".
// Идут после ядра, поэтому FK stock_movements → items выполняется.
func warehouseSyncEntities() []syncEntity {
	return []syncEntity{
		{
			Name:      "warehouses",
			PermTable: "warehouse",
			pushAll: func(ctx context.Context, a *app, raw map[string]json.RawMessage, perm, uid string, cp func(string) bool, res *syncPushResult) {
				pushEntity(ctx, a, raw, "warehouses", perm, "warehouses", uid, cp, pushWarehouse, res)
			},
			pull: func(ctx context.Context, db *sql.DB, since time.Time) (any, error) { return pullWarehouses(ctx, db, since) },
		},
		{
			Name:      "stock_movements",
			PermTable: "warehouse",
			pushAll: func(ctx context.Context, a *app, raw map[string]json.RawMessage, perm, uid string, cp func(string) bool, res *syncPushResult) {
				pushEntity(ctx, a, raw, "stock_movements", perm, "stock_movements", uid, cp, pushStockMovement, res)
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

// ctxKeyPushDevice — устройство, приславшее push (поле device_id запроса).
type ctxKeyPushDevice struct{}

// withDeviceID ставит записи device_id пишущего устройства. Не разобралась —
// оставляем как есть: отказ сообщит разбор ниже.
func withDeviceID(rec json.RawMessage, device string) json.RawMessage {
	var m map[string]json.RawMessage
	if json.Unmarshal(rec, &m) != nil {
		return rec
	}
	d, _ := json.Marshal(device)
	m["device_id"] = d
	out, err := json.Marshal(m)
	if err != nil {
		return rec
	}
	return out
}
