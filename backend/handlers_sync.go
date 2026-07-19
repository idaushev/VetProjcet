package main

import (
	"context"
	"database/sql"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"strings"
	"time"
)

// ─── POST /sync/push ──────────────────────────────────────────────────────────
//
// Принимает batch pending-записей от клиента.
// Использует lenient-декодер (без DisallowUnknownFields) потому что клиент
// отправляет дополнительные поля: sync_status, server_id, created_at и т.п.
//
// Стратегия конфликтов: latest updated_at wins.

func (a *app) handleSyncPush(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		writeError(w, http.StatusMethodNotAllowed, "method not allowed")
		return
	}

	// ── Lenient-декодер: не падаем на неизвестных полях ──────────────
	body, err := io.ReadAll(io.LimitReader(r.Body, 8<<20)) // 8 MB limit
	r.Body.Close()
	if err != nil {
		writeError(w, http.StatusBadRequest, "failed to read body")
		return
	}

	var payload syncPushPayload
	if err := json.Unmarshal(body, &payload); err != nil {
		a.logger.Printf("syncPush decode: %v", err)
		writeError(w, http.StatusBadRequest, "invalid json: "+err.Error())
		return
	}

	ctx, cancel := context.WithTimeout(r.Context(), 30*time.Second)
	defer cancel()

	if payload.DeviceID != "" {
		a.upsertDevice(ctx, payload.DeviceID)
	}

	var result syncPushResult

	// Автор изменений: пользователь, чьим токеном подписан push.
	// Заполняет created_by/updated_by — задел под аудит «кто изменил».
	pushUserID := ""
	pushUser := userFromCtx(ctx)
	if pushUser != nil {
		pushUserID = pushUser.ID
	}
	// Право писать в таблицу: у «только просмотр» push отклоняется —
	// иначе право было бы фикцией, планшет всё равно продавил бы правки.
	canPush := func(table string) bool {
		return pushUser == nil || pushUser.tableLevel(table) >= permLevels["create"]
	}

	// Порядок важен для FK: owners → pets → items → visits → visit_items → vaccinations → staff
	if len(payload.Owners) > 0 && !canPush("owners") {
		result.Skipped += len(payload.Owners)
		a.logger.Printf("syncPush owners: отклонено, у %s нет права записи", pushUserID)
		payload.Owners = nil
	}
	for _, rec := range payload.Owners {
		if ok, err := pushOwner(ctx, a.db, rec); ok {
			a.stampAuthor(ctx, "owners", rec.ID, pushUserID)
			result.Accepted++
		} else {
			if err != nil {
				a.logger.Printf("syncPush owner %s: %v", rec.ID, err)
			}
			result.Skipped++
		}
	}
	if len(payload.Pets) > 0 && !canPush("pets") {
		result.Skipped += len(payload.Pets)
		a.logger.Printf("syncPush pets: отклонено, у %s нет права записи", pushUserID)
		payload.Pets = nil
	}
	for _, rec := range payload.Pets {
		if ok, err := pushPet(ctx, a.db, rec); ok {
			a.stampAuthor(ctx, "pets", rec.ID, pushUserID)
			result.Accepted++
		} else {
			if err != nil {
				a.logger.Printf("syncPush pet %s: %v", rec.ID, err)
			}
			result.Skipped++
		}
	}
	if len(payload.Items) > 0 && !canPush("items") {
		result.Skipped += len(payload.Items)
		a.logger.Printf("syncPush items: отклонено, у %s нет права записи", pushUserID)
		payload.Items = nil
	}
	for _, rec := range payload.Items {
		if ok, err := pushItem(ctx, a.db, rec); ok {
			a.stampAuthor(ctx, "items", rec.ID, pushUserID)
			result.Accepted++
		} else {
			if err != nil {
				a.logger.Printf("syncPush item %s: %v", rec.ID, err)
			}
			result.Skipped++
		}
	}
	if len(payload.Visits) > 0 && !canPush("visits") {
		result.Skipped += len(payload.Visits)
		a.logger.Printf("syncPush visits: отклонено, у %s нет права записи", pushUserID)
		payload.Visits = nil
	}
	for _, rec := range payload.Visits {
		if ok, err := pushVisit(ctx, a.db, rec); ok {
			a.stampAuthor(ctx, "visits", rec.ID, pushUserID)
			result.Accepted++
		} else {
			if err != nil {
				a.logger.Printf("syncPush visit %s: %v", rec.ID, err)
			}
			result.Skipped++
		}
	}
	if len(payload.VisitItems) > 0 && !canPush("visits") {
		result.Skipped += len(payload.VisitItems)
		a.logger.Printf("syncPush visititems: отклонено, у %s нет права записи", pushUserID)
		payload.VisitItems = nil
	}
	for _, rec := range payload.VisitItems {
		if ok, err := pushVisitItem(ctx, a.db, rec); ok {
			a.stampAuthor(ctx, "visit_items", rec.ID, pushUserID)
			result.Accepted++
		} else {
			if err != nil {
				a.logger.Printf("syncPush visit_item %s: %v", rec.ID, err)
			}
			result.Skipped++
		}
	}
	if len(payload.Vaccinations) > 0 && !canPush("vaccinations") {
		result.Skipped += len(payload.Vaccinations)
		a.logger.Printf("syncPush vaccinations: отклонено, у %s нет права записи", pushUserID)
		payload.Vaccinations = nil
	}
	for _, rec := range payload.Vaccinations {
		if ok, err := pushVaccination(ctx, a.db, rec); ok {
			a.stampAuthor(ctx, "vaccinations", rec.ID, pushUserID)
			result.Accepted++
		} else {
			if err != nil {
				a.logger.Printf("syncPush vaccination %s: %v", rec.ID, err)
			}
			result.Skipped++
		}
	}
	if len(payload.Staff) > 0 && !canPush("staff") {
		result.Skipped += len(payload.Staff)
		a.logger.Printf("syncPush staff: отклонено, у %s нет права записи", pushUserID)
		payload.Staff = nil
	}
	for _, rec := range payload.Staff {
		if ok, err := pushStaff(ctx, a.db, rec); ok {
			a.stampAuthor(ctx, "clinic_staff", rec.ID, pushUserID)
			result.Accepted++
		} else {
			if err != nil {
				a.logger.Printf("syncPush staff %s: %v", rec.ID, err)
			}
			result.Skipped++
		}
	}

	a.logger.Printf("syncPush: accepted=%d skipped=%d", result.Accepted, result.Skipped)
	writeJSON(w, http.StatusOK, apiResponse{Status: "ok", Data: result})
}

// ─── GET /sync/pull?since=&device_id= ────────────────────────────────────────

func (a *app) handleSyncPull(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodGet {
		writeError(w, http.StatusMethodNotAllowed, "method not allowed")
		return
	}

	sinceStr := strings.TrimSpace(r.URL.Query().Get("since"))
	deviceID := strings.TrimSpace(r.URL.Query().Get("device_id"))

	var since time.Time
	if sinceStr != "" {
		t, err := parseFlexibleDate(sinceStr)
		if err != nil {
			writeError(w, http.StatusBadRequest, "since: invalid date")
			return
		}
		since = t
	}

	ctx, cancel := context.WithTimeout(r.Context(), 15*time.Second)
	defer cancel()

	if deviceID != "" {
		a.upsertDevice(ctx, deviceID)
	}

	data := syncPullData{ServerTime: nowUTC()}

	// Загружаем каждый тип независимо: ошибка одного НЕ прерывает остальных.
	// До этого любая scan-ошибка (например, неверный формат DATETIME в SQLite)
	// возвращала 500, и клиент падал в pullFallbackLegacy (без is_deleted=1 записей).
	if owners, err := pullOwners(ctx, a.db, since); err != nil {
		a.logger.Printf("syncPull owners: %v", err)
	} else {
		data.Owners = owners
	}
	if pets, err := pullPets(ctx, a.db, since); err != nil {
		a.logger.Printf("syncPull pets: %v", err)
	} else {
		data.Pets = pets
	}
	if items, err := pullItems(ctx, a.db, since); err != nil {
		a.logger.Printf("syncPull items: %v", err)
	} else {
		data.Items = items
	}
	if visits, err := pullVisits(ctx, a.db, since); err != nil {
		a.logger.Printf("syncPull visits: %v", err)
	} else {
		data.Visits = visits
	}
	if vis, err := pullVisitItems(ctx, a.db, since); err != nil {
		a.logger.Printf("syncPull visit_items: %v", err)
	} else {
		data.VisitItems = vis
	}
	if vaccs, err := pullVaccinations(ctx, a.db, since); err != nil {
		a.logger.Printf("syncPull vaccinations: %v", err)
	} else {
		data.Vaccinations = vaccs
	}
	if staff, err := pullStaff(ctx, a.db, since); err != nil {
		a.logger.Printf("syncPull staff: %v", err)
	} else {
		data.Staff = staff
	}
	if att, err := pullAttachments(ctx, a.db, since); err != nil {
		a.logger.Printf("syncPull attachments: %v", err)
	} else {
		data.Attachments = att
	}

	writeJSON(w, http.StatusOK, apiResponse{Status: "ok", Data: data})
}

// ─── Push helpers — upsert с conflict resolution ──────────────────────────────

// clientWins сравнивает версию и время клиента с сервером.
// Стратегия: version-first, then timestamp.
//   - Если у клиента version > серверного — принимаем безусловно (явное обновление).
//   - Если version одинаковый — сравниваем updated_at (>= чтобы принять одновременные правки).
//   - Новая запись (not found) — всегда принимаем.
func clientWinsVersion(ctx context.Context, db *sql.DB, table, id string, clientUpdatedAt string, clientVersion int) (bool, error) {
	clientTime := parseSyncTime(clientUpdatedAt)

	// Берём client_updated_at — время КЛИЕНТА с прошлого push.
	// Сравнивать с updated_at нельзя: там время сервера, оно всегда позже
	// клиентского, и клиент проигрывал бы каждый конфликт.
	var prevClientTime timeScanner
	var serverVersion int
	err := db.QueryRowContext(ctx,
		`SELECT client_updated_at, COALESCE(version,1) FROM `+table+` WHERE id=?`, id,
	).Scan(&prevClientTime, &serverVersion)

	if err == sql.ErrNoRows {
		return true, nil // новая запись — принимаем
	}
	if err != nil {
		return true, nil // ошибка scan — принимаем (безопасный fallback)
	}

	// Клиент явно инкрементировал версию → принимаем.
	if clientVersion > serverVersion {
		return true, nil
	}

	// Записи, созданные до появления client_updated_at (или пришедшие не через
	// синхронизацию), времени клиента не имеют. Принимаем: иначе такая строка
	// осталась бы замороженной навсегда — правки и удаления с планшета
	// отклонялись бы вечно.
	if prevClientTime.t == nil {
		return true, nil
	}

	// Версии равны — сравниваем время клиента с временем клиента.
	// >= (не After) позволяет принять правки при одинаковом времени.
	return !clientTime.Before(*prevClientTime.t), nil
}

func pushOwner(ctx context.Context, db *sql.DB, rec ownerSyncRecord) (bool, error) {
	if rec.ID == "" {
		return false, fmt.Errorf("empty id")
	}
	wins, err := clientWinsVersion(ctx, db, "owners", rec.ID, rec.UpdatedAt, rec.Version)
	if err != nil || !wins {
		return false, err
	}
	// serverNow — время СЕРВЕРА. Ключевой момент синхронизации:
	// клиентское updated_at используется только для conflict resolution (выше),
	// а в БД хранится серверное время. Иначе инкрементальный pull
	// (WHERE updated_at > since) не находит записи с "прошлым" клиентским временем.
	serverNow := T(nowUTC())
	// Время клиента сохраняем как есть — по нему разрешаются будущие конфликты.
	clientAt := Tp(parseSyncTimePtr(&rec.UpdatedAt))
	deletedAt := Tp(parseSyncTimePtr(rec.DeletedAt))
	_, err = db.ExecContext(ctx, `
		INSERT INTO owners (id, fio, iin, phone, address, notes, updated_at, deleted_at, is_deleted, device_id, version, created_at, client_updated_at)
		VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
		ON CONFLICT(id) DO UPDATE SET
		  fio=excluded.fio, iin=excluded.iin, phone=excluded.phone,
		  address=excluded.address, notes=excluded.notes,
		  updated_at=excluded.updated_at, deleted_at=excluded.deleted_at,
		  is_deleted=excluded.is_deleted, device_id=excluded.device_id,
		  version=excluded.version,
		  client_updated_at=excluded.client_updated_at`,
		rec.ID, rec.FIO, nullableString(rec.IIN), rec.Phone,
		nullableString(rec.Address), nullableString(rec.Notes),
		serverNow, deletedAt, rec.IsDeleted,
		nullableString(rec.DeviceID), rec.Version, serverNow, clientAt,
	)
	return err == nil, err
}

func pushPet(ctx context.Context, db *sql.DB, rec petSyncRecord) (bool, error) {
	if rec.ID == "" {
		return false, fmt.Errorf("empty id")
	}
	wins, err := clientWinsVersion(ctx, db, "pets", rec.ID, rec.UpdatedAt, rec.Version)
	if err != nil || !wins {
		return false, err
	}
	status := rec.Status
	if status == "" {
		status = "active"
	}
	serverNow := T(nowUTC())
	// Время клиента сохраняем как есть — по нему разрешаются будущие конфликты.
	clientAt := Tp(parseSyncTimePtr(&rec.UpdatedAt))
	deletedAt := Tp(parseSyncTimePtr(rec.DeletedAt))
	birthDate := parseSyncTimePtr(rec.BirthDate)
	deathDate := parseSyncTimePtr(rec.DeathDate)
	chipDate := parseSyncTimePtr(rec.ChipDate)
	_, err = db.ExecContext(ctx, `
		INSERT INTO pets (id, owner_id, name, type, gender, birth_date, age, breed, color, chip_number, chip_date, photo, weight,
		                  status, death_date, death_reason, notes,
		                  updated_at, deleted_at, is_deleted, device_id, version, created_at, client_updated_at)
		VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
		ON CONFLICT(id) DO UPDATE SET
		  owner_id=excluded.owner_id, name=excluded.name, type=excluded.type,
		  gender=excluded.gender, birth_date=excluded.birth_date, age=excluded.age,
		  breed=excluded.breed, color=excluded.color, chip_number=excluded.chip_number,
		  -- Пустая дата чипирования от старого клиента не затирает известную.
		  chip_date=COALESCE(excluded.chip_date, pets.chip_date),
		  photo=excluded.photo, weight=excluded.weight,
		  status=excluded.status, death_date=excluded.death_date,
		  death_reason=excluded.death_reason, notes=excluded.notes,
		  updated_at=excluded.updated_at, deleted_at=excluded.deleted_at,
		  is_deleted=excluded.is_deleted, device_id=excluded.device_id,
		  version=excluded.version,
		  client_updated_at=excluded.client_updated_at`,
		rec.ID, rec.OwnerID, rec.Name, rec.Type, rec.Gender,
		birthDate, rec.Age, nullableString(rec.Breed),
		nullableString(rec.Color), nullableString(rec.ChipNumber), Tp(chipDate), nullableString(rec.Photo), rec.Weight, status,
		Tp(deathDate), nullableString(rec.DeathReason), nullableString(rec.Notes),
		serverNow, deletedAt, rec.IsDeleted,
		nullableString(rec.DeviceID), rec.Version, serverNow, clientAt,
	)
	return err == nil, err
}

func pushItem(ctx context.Context, db *sql.DB, rec itemSyncRecord) (bool, error) {
	if rec.ID == "" {
		return false, fmt.Errorf("empty id")
	}
	wins, err := clientWinsVersion(ctx, db, "items", rec.ID, rec.UpdatedAt, rec.Version)
	if err != nil || !wins {
		return false, err
	}
	serverNow := T(nowUTC())
	// Время клиента сохраняем как есть — по нему разрешаются будущие конфликты.
	clientAt := Tp(parseSyncTimePtr(&rec.UpdatedAt))
	deletedAt := Tp(parseSyncTimePtr(rec.DeletedAt))
	// Пересчитываем на сервере: клиент мог прислать percent с устаревшей суммой.
	mode, percent, cost := resolveCost(rec.CostMode, rec.CostPercent, rec.Price, rec.CostPrice)
	_, err = db.ExecContext(ctx, `
		INSERT INTO items (id, name, type, price, cost_price, cost_mode, cost_percent, is_active, updated_at, deleted_at, is_deleted, device_id, version, created_at, client_updated_at)
		VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
		ON CONFLICT(id) DO UPDATE SET
		  name=excluded.name, type=excluded.type, price=excluded.price,
		  cost_price=excluded.cost_price, cost_mode=excluded.cost_mode,
		  cost_percent=excluded.cost_percent, is_active=excluded.is_active,
		  updated_at=excluded.updated_at, deleted_at=excluded.deleted_at,
		  is_deleted=excluded.is_deleted, device_id=excluded.device_id,
		  version=excluded.version,
		  client_updated_at=excluded.client_updated_at`,
		rec.ID, rec.Name, normalizeItemType(rec.Type), rec.Price, cost, mode, percent, boolToInt(rec.IsActive),
		serverNow, deletedAt, rec.IsDeleted,
		nullableString(rec.DeviceID), rec.Version, serverNow, clientAt,
	)
	return err == nil, err
}

func pushVisit(ctx context.Context, db *sql.DB, rec visitSyncRecord) (bool, error) {
	if rec.ID == "" {
		return false, fmt.Errorf("empty id")
	}
	wins, err := clientWinsVersion(ctx, db, "visits", rec.ID, rec.UpdatedAt, rec.Version)
	if err != nil || !wins {
		return false, err
	}
	visitDate, dateErr := parseFlexibleDate(rec.Date)
	if dateErr != nil {
		visitDate = nowUTC()
	}
	visitType := rec.VisitType
	if visitType == "" {
		visitType = "первичный"
	}
	serverNow  := T(nowUTC())
	// Время клиента сохраняем как есть — по нему разрешаются будущие конфликты.
	clientAt   := Tp(parseSyncTimePtr(&rec.UpdatedAt))
	deletedAt  := Tp(parseSyncTimePtr(rec.DeletedAt))
	nextVisitDate := Tp(parseSyncTimePtr(rec.NextVisitDate))
	// Дату окончания курса считаем на сервере, а не берём с планшета:
	// он мог посчитать её старой версией кода или не прислать вовсе.
	// Если поля нет (планшет со старой версией) — сохраняем курс, который уже
	// лежит на сервере, иначе синхронизация затирала бы назначенное лечение.
	days := rec.TreatmentDays
	if days == nil {
		var cur int
		if err := db.QueryRowContext(ctx, `SELECT COALESCE(treatment_days,0) FROM visits WHERE id=?`, rec.ID).Scan(&cur); err == nil {
			days = &cur
		}
	}
	treatDays, treatUntil := resolveTreatment(intOrZero(days), visitDate)
	_, err = db.ExecContext(ctx, `
		INSERT INTO visits (id, pet_id, staff_id, visit_type, animal_weight, date, next_visit_date,
		                    treatment_days, treatment_until,
		                    patient_condition, anamnesis, diagnosis, treatment, notes,
		                    total_amount, payment_card, change_log, updated_at, deleted_at, is_deleted, device_id, version, created_at, client_updated_at)
		VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
		ON CONFLICT(id) DO UPDATE SET
		  pet_id=excluded.pet_id, staff_id=excluded.staff_id,
		  visit_type=excluded.visit_type, animal_weight=excluded.animal_weight,
		  date=excluded.date, next_visit_date=excluded.next_visit_date,
		  treatment_days=excluded.treatment_days, treatment_until=excluded.treatment_until,
		  patient_condition=excluded.patient_condition, anamnesis=excluded.anamnesis,
		  diagnosis=excluded.diagnosis, treatment=excluded.treatment, notes=excluded.notes,
		  total_amount=excluded.total_amount, payment_card=excluded.payment_card,
		  change_log=excluded.change_log, updated_at=excluded.updated_at, deleted_at=excluded.deleted_at, is_deleted=excluded.is_deleted,
		  device_id=excluded.device_id, version=excluded.version,
		  client_updated_at=excluded.client_updated_at`,
		rec.ID, rec.PetID, nullableString(rec.StaffID), visitType, rec.AnimalWeight, T(visitDate), nextVisitDate,
		treatDays, Tp(treatUntil),
		nullableString(rec.PatientCondition), nullableString(rec.Anamnesis),
		nullableString(rec.Diagnosis), nullableString(rec.Treatment), nullableString(rec.Notes),
		rec.TotalAmount, rec.PaymentCard, nullableString(rec.ChangeLog), serverNow, deletedAt, rec.IsDeleted,
		nullableString(rec.DeviceID), rec.Version, serverNow, clientAt,
	)
	return err == nil, err
}

func pushVisitItem(ctx context.Context, db *sql.DB, rec visitItemSyncRecord) (bool, error) {
	if rec.ID == "" {
		return false, fmt.Errorf("empty id")
	}
	wins, err := clientWinsVersion(ctx, db, "visit_items", rec.ID, rec.UpdatedAt, rec.Version)
	if err != nil || !wins {
		return false, err
	}
	serverNow := T(nowUTC())
	// Время клиента сохраняем как есть — по нему разрешаются будущие конфликты.
	clientAt := Tp(parseSyncTimePtr(&rec.UpdatedAt))
	deletedAt := Tp(parseSyncTimePtr(rec.DeletedAt))
	_, err = db.ExecContext(ctx, `
		INSERT INTO visit_items (id, visit_id, item_id, name, type, quantity, price, total,
		                         updated_at, deleted_at, is_deleted, device_id, version, created_at, client_updated_at)
		VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
		ON CONFLICT(id) DO UPDATE SET
		  visit_id=excluded.visit_id, item_id=excluded.item_id, name=excluded.name,
		  type=excluded.type, quantity=excluded.quantity, price=excluded.price,
		  total=excluded.total, updated_at=excluded.updated_at,
		  deleted_at=excluded.deleted_at, is_deleted=excluded.is_deleted,
		  device_id=excluded.device_id, version=excluded.version,
		  client_updated_at=excluded.client_updated_at`,
		rec.ID, rec.VisitID, rec.ItemID, nullableString(rec.Name),
		normalizeItemType(rec.Type), rec.Quantity, rec.Price, rec.Total,
		serverNow, deletedAt, rec.IsDeleted,
		nullableString(rec.DeviceID), rec.Version, serverNow, clientAt,
	)
	return err == nil, err
}

func pushVaccination(ctx context.Context, db *sql.DB, rec vaccinationSyncRecord) (bool, error) {
	if rec.ID == "" {
		return false, fmt.Errorf("empty id")
	}
	wins, err := clientWinsVersion(ctx, db, "vaccinations", rec.ID, rec.UpdatedAt, rec.Version)
	if err != nil || !wins {
		return false, err
	}
	adminAt, adminErr := parseFlexibleDate(rec.AdministeredAt)
	if adminErr != nil {
		adminAt = nowUTC()
	}
	serverNow := T(nowUTC())
	// Время клиента сохраняем как есть — по нему разрешаются будущие конфликты.
	clientAt := Tp(parseSyncTimePtr(&rec.UpdatedAt))
	deletedAt := Tp(parseSyncTimePtr(rec.DeletedAt))
	nextDue := parseSyncTimePtr(rec.NextDueAt)
	_, err = db.ExecContext(ctx, `
		INSERT INTO vaccinations (id, pet_id, staff_id, vaccine_name, batch_number, manufacturer,
		                          dose, administered_at, next_due_at, notes,
		                          updated_at, deleted_at, is_deleted, device_id, version, created_at, client_updated_at)
		VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
		ON CONFLICT(id) DO UPDATE SET
		  pet_id=excluded.pet_id, staff_id=excluded.staff_id, vaccine_name=excluded.vaccine_name,
		  batch_number=excluded.batch_number, manufacturer=excluded.manufacturer,
		  dose=excluded.dose, administered_at=excluded.administered_at, next_due_at=excluded.next_due_at,
		  notes=excluded.notes, updated_at=excluded.updated_at,
		  deleted_at=excluded.deleted_at, is_deleted=excluded.is_deleted,
		  device_id=excluded.device_id, version=excluded.version,
		  client_updated_at=excluded.client_updated_at`,
		rec.ID, rec.PetID, nullableString(rec.StaffID), rec.VaccineName,
		nullableString(rec.BatchNumber), nullableString(rec.Manufacturer),
		rec.Dose, T(adminAt), Tp(nextDue), nullableString(rec.Notes),
		serverNow, deletedAt, rec.IsDeleted,
		nullableString(rec.DeviceID), rec.Version, serverNow, clientAt,
	)
	return err == nil, err
}

func pushStaff(ctx context.Context, db *sql.DB, rec staffSyncRecord) (bool, error) {
	if rec.ID == "" {
		return false, fmt.Errorf("empty id")
	}
	wins, err := clientWinsVersion(ctx, db, "clinic_staff", rec.ID, rec.UpdatedAt, rec.Version)
	if err != nil || !wins {
		return false, err
	}
	serverNow := T(nowUTC())
	// Время клиента сохраняем как есть — по нему разрешаются будущие конфликты.
	clientAt := Tp(parseSyncTimePtr(&rec.UpdatedAt))
	deletedAt := Tp(parseSyncTimePtr(rec.DeletedAt))
	_, err = db.ExecContext(ctx, `
		INSERT INTO clinic_staff (id, name, role, phone, email, is_active, notes, photo,
		                          updated_at, deleted_at, is_deleted, device_id, version, created_at, client_updated_at)
		VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
		ON CONFLICT(id) DO UPDATE SET
		  name=excluded.name, role=excluded.role, phone=excluded.phone, email=excluded.email,
		  is_active=excluded.is_active, notes=excluded.notes,
		  -- Пустое фото от планшета со старой версией не стирает серверное:
		  -- старый клиент про колонку не знает и прислал бы "".
		  photo=COALESCE(NULLIF(excluded.photo,''), clinic_staff.photo),
		  updated_at=excluded.updated_at,
		  deleted_at=excluded.deleted_at, is_deleted=excluded.is_deleted,
		  device_id=excluded.device_id, version=excluded.version,
		  client_updated_at=excluded.client_updated_at`,
		rec.ID, rec.Name, rec.Role, nullableString(rec.Phone), nullableString(rec.Email),
		boolToInt(rec.IsActive), nullableString(rec.Notes),
		serverNow, deletedAt, rec.IsDeleted,
		nullableString(rec.DeviceID), rec.Version, serverNow, clientAt,
	)
	return err == nil, err
}

// ─── Pull helpers ─────────────────────────────────────────────────────────────

func pullOwners(ctx context.Context, db *sql.DB, since time.Time) ([]Owner, error) {
	q := `SELECT id, fio, COALESCE(iin,''), phone, COALESCE(address,''), COALESCE(notes,''),
	             created_at, updated_at, deleted_at, is_deleted, COALESCE(device_id,''), COALESCE(version,1)
	      FROM owners`
	if !since.IsZero() {
		q += ` WHERE updated_at > ?`
		rows, err := db.QueryContext(ctx, q, T(since))
		if err != nil {
			return nil, err
		}
		defer rows.Close()
		return scanOwners(rows)
	}
	rows, err := db.QueryContext(ctx, q)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	return scanOwners(rows)
}

func scanOwners(rows *sql.Rows) ([]Owner, error) {
	var list []Owner
	for rows.Next() {
		o, err := scanOwner(rows)
		if err != nil {
			return nil, err
		}
		list = append(list, o)
	}
	if list == nil {
		list = []Owner{}
	}
	return list, rows.Err()
}

func pullPets(ctx context.Context, db *sql.DB, since time.Time) ([]Pet, error) {
	filter := ""
	var args []interface{}
	if !since.IsZero() {
		filter = ` WHERE updated_at > ?`
		args = []interface{}{T(since)}
	}

	// Legacy-fallback здесь убран сознательно: он выбирал меньше колонок,
	// чем ждёт scanPetRow, и каждая запись молча падала на Scan — планшет
	// получал пустой список животных вместо ошибки. Колонки добавляет
	// runMigrations при старте; расхождение схемы должно быть видно.
	rows, err := db.QueryContext(ctx, petSelectAll+filter, args...)
	if err != nil {
		return nil, err
	}
	defer rows.Close()

	var list []Pet
	for rows.Next() {
		p, err := scanPetRow(rows)
		if err != nil {
			continue // пропускаем битую запись
		}
		list = append(list, p)
	}
	if list == nil {
		list = []Pet{}
	}
	return list, rows.Err()
}

// ВНИМАНИЕ: порядок и число колонок должны точно совпадать со scanPetRow.
// chip_date стоит между chip_number и photo — как в сканере. Рассинхрон здесь
// уронил pull: Scan падал на каждой строке, животные не доезжали ни на одно
// устройство, а ошибка глоталась в continue.
const petSelectAll = `
SELECT id, owner_id, name, type, gender, birth_date, age, COALESCE(breed,''),
       COALESCE(color,''), COALESCE(chip_number,''), chip_date, COALESCE(photo,''), weight, COALESCE(status,'active'),
       death_date, COALESCE(death_reason,''), COALESCE(notes,''),
       created_at, updated_at, deleted_at, is_deleted, COALESCE(device_id,''), COALESCE(version,1)
FROM pets`

func pullItems(ctx context.Context, db *sql.DB, since time.Time) ([]Item, error) {
	q := `SELECT id, name, type, price, COALESCE(cost_price,0), COALESCE(cost_mode,'fixed'), COALESCE(cost_percent,0), is_active, created_at, updated_at, deleted_at, is_deleted, COALESCE(device_id,''), COALESCE(version,1) FROM items`
	var rows *sql.Rows
	var err error
	if !since.IsZero() {
		rows, err = db.QueryContext(ctx, q+` WHERE updated_at > ?`, T(since))
	} else {
		rows, err = db.QueryContext(ctx, q)
	}
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	var list []Item
	for rows.Next() {
		item, err := scanItem(rows)
		if err != nil {
			return nil, err
		}
		list = append(list, item)
	}
	if list == nil {
		list = []Item{}
	}
	return list, rows.Err()
}

func pullVisits(ctx context.Context, db *sql.DB, since time.Time) ([]Visit, error) {
	filter := ""
	var args []interface{}
	if !since.IsZero() {
		filter = ` WHERE v.updated_at > ?`
		args = []interface{}{T(since)}
	}

	// Раньше здесь был fallback на visitSelectAllLegacy для БД без новых колонок.
	// Он был опаснее проблемы, которую решал: legacy-запрос отдаёт меньше колонок,
	// а разбирается тем же scanVisit — каждая запись падала на Scan и молча
	// пропускалась через continue ниже. Планшет получал пустой список визитов
	// вместо ошибки. Колонки добавляет runMigrations при старте, так что
	// расхождение схемы означает поломку, о которой надо узнать, а не прятать.
	rows, err := db.QueryContext(ctx, visitSelectAll+filter, args...)
	if err != nil {
		return nil, err
	}
	defer rows.Close()

	var list []Visit
	for rows.Next() {
		v, err := scanVisit(rows)
		if err != nil {
			continue // пропускаем битую запись, не ломаем весь pull
		}
		list = append(list, v)
	}
	if list == nil {
		list = []Visit{}
	}
	return list, rows.Err()
}

func pullVisitItems(ctx context.Context, db *sql.DB, since time.Time) ([]VisitItem, error) {
	q := visitItemSelectAll
	var rows *sql.Rows
	var err error
	if !since.IsZero() {
		rows, err = db.QueryContext(ctx, q+` WHERE vi.updated_at > ?`, T(since))
	} else {
		rows, err = db.QueryContext(ctx, q)
	}
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	var list []VisitItem
	for rows.Next() {
		vi, err := scanVisitItem(rows)
		if err != nil {
			return nil, err
		}
		list = append(list, vi)
	}
	if list == nil {
		list = []VisitItem{}
	}
	return list, rows.Err()
}

func pullVaccinations(ctx context.Context, db *sql.DB, since time.Time) ([]Vaccination, error) {
	q := vaccinationSelectAll
	var rows *sql.Rows
	var err error
	if !since.IsZero() {
		rows, err = db.QueryContext(ctx, q+` WHERE updated_at > ?`, T(since))
	} else {
		rows, err = db.QueryContext(ctx, q)
	}
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	var list []Vaccination
	for rows.Next() {
		v, err := scanVaccination(rows)
		if err != nil {
			return nil, err
		}
		list = append(list, v)
	}
	if list == nil {
		list = []Vaccination{}
	}
	return list, rows.Err()
}

func pullStaff(ctx context.Context, db *sql.DB, since time.Time) ([]Staff, error) {
	q := staffSelectAll
	var rows *sql.Rows
	var err error
	if !since.IsZero() {
		rows, err = db.QueryContext(ctx, q+` WHERE updated_at > ?`, T(since))
	} else {
		rows, err = db.QueryContext(ctx, q)
	}
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	var list []Staff
	for rows.Next() {
		s, err := scanStaff(rows)
		if err != nil {
			return nil, err
		}
		list = append(list, s)
	}
	if list == nil {
		list = []Staff{}
	}
	return list, rows.Err()
}

// ─── Devices ──────────────────────────────────────────────────────────────────

func (a *app) upsertDevice(ctx context.Context, id string) {
	_, _ = a.db.ExecContext(ctx, `
		INSERT INTO devices (id, last_seen_at) VALUES (?, ?)
		ON CONFLICT(id) DO UPDATE SET last_seen_at=excluded.last_seen_at`,
		id, T(nowUTC()),
	)
}

// pullAttachments отдаёт метаданные вложений. Push для них не нужен:
// вложение создаётся только загрузкой файла через POST /attachments,
// а она требует сети по определению.
func pullAttachments(ctx context.Context, db *sql.DB, since time.Time) ([]Attachment, error) {
	q := attachmentSelectAll
	var rows *sql.Rows
	var err error
	if !since.IsZero() {
		rows, err = db.QueryContext(ctx, q+` WHERE updated_at > ?`, T(since))
	} else {
		rows, err = db.QueryContext(ctx, q)
	}
	if err != nil {
		return nil, err
	}
	defer rows.Close()

	list := make([]Attachment, 0)
	for rows.Next() {
		at, err := scanAttachment(rows)
		if err != nil {
			continue
		}
		list = append(list, at)
	}
	return list, rows.Err()
}
