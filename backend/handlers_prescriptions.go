package main

import (
	"context"
	"database/sql"
	"net/http"
	"strings"
	"time"
)

// ─── F4 / VET-004: назначения ────────────────────────────────────────────────
//
// Назначение — отдельная сущность, а не строка в тексте приёма. Состав полей
// задан ответом клиники на вопрос 1 (препарат, доза, единица, путь введения,
// длительность, инструкция); кратность живёт в инструкции — так ответила
// клиника, и отдельной колонки под неё нет намеренно.
//
// visits.treatment НЕ трогаем: там остаются лечение и рекомендации одним
// полем (ответ на вопрос 5), и существующий текст никуда не девается.
// Назначения дополняют его, а не заменяют — свободная запись остаётся
// возможной для того, что не формализуется.

// Пути введения и единицы — короткие фиксированные списки. Не справочник в
// базе: значений единицы, и заводить ради них таблицу значило бы создать
// сущность, которую придётся сопровождать.
var prescriptionRoutes = map[string]bool{
	"внутрь": true, "п/к": true, "в/м": true, "в/в": true,
	"наружно": true, "в глаза": true, "в уши": true, "в нос": true,
}

var prescriptionStatuses = map[string]bool{
	"active": true, "cancelled": true, "stopped": true,
}

// normalizePrescriptionStatus — неизвестный статус считаем действующим.
// Ошибка в статусе не должна прятать назначение от врача: невидимая терапия
// опаснее лишней строки в списке.
func normalizePrescriptionStatus(s string) string {
	s = strings.ToLower(strings.TrimSpace(s))
	if prescriptionStatuses[s] {
		return s
	}
	return "active"
}

func normalizeRoute(s string) string {
	s = strings.TrimSpace(s)
	if s == "" || prescriptionRoutes[s] {
		return s
	}
	// Путь введения, которого нет в списке, сохраняем как есть: клиника может
	// назначать так, как мы не предусмотрели, и терять это нельзя.
	return s
}

func (a *app) handlePrescriptions(w http.ResponseWriter, r *http.Request) {
	switch r.Method {
	case http.MethodGet:
		a.listPrescriptions(w, r)
	case http.MethodPost:
		a.createPrescription(w, r)
	default:
		writeError(w, http.StatusMethodNotAllowed, "method not allowed")
	}
}

func (a *app) handlePrescriptionByID(w http.ResponseWriter, r *http.Request) {
	id := strings.TrimSpace(r.PathValue("id"))
	if id == "" {
		writeError(w, http.StatusBadRequest, "id is required")
		return
	}
	switch r.Method {
	case http.MethodPut:
		a.updatePrescription(w, r, id)
	case http.MethodDelete:
		a.deletePrescription(w, r, id)
	default:
		writeError(w, http.StatusMethodNotAllowed, "method not allowed")
	}
}

func (a *app) listPrescriptions(w http.ResponseWriter, r *http.Request) {
	ctx, cancel := context.WithTimeout(r.Context(), 10*time.Second)
	defer cancel()

	q := prescriptionSelectAll + ` WHERE is_deleted=0`
	var args []interface{}
	if v := strings.TrimSpace(r.URL.Query().Get("visit_id")); v != "" {
		q += ` AND visit_id=?`
		args = append(args, v)
	}
	if v := strings.TrimSpace(r.URL.Query().Get("pet_id")); v != "" {
		q += ` AND pet_id=?`
		args = append(args, v)
	}
	if v := strings.TrimSpace(r.URL.Query().Get("status")); v != "" {
		q += ` AND status=?`
		args = append(args, normalizePrescriptionStatus(v))
	}
	q += ` ORDER BY started_at DESC, created_at DESC`

	rows, err := a.db.QueryContext(ctx, q, args...)
	if err != nil {
		a.logger.Printf("listPrescriptions: %v", err)
		writeError(w, http.StatusInternalServerError, "failed to load prescriptions")
		return
	}
	defer rows.Close()

	list := []Prescription{}
	for rows.Next() {
		p, err := scanPrescription(rows)
		if err != nil {
			a.logger.Printf("scanPrescription: %v", err)
			continue
		}
		list = append(list, p)
	}
	writeJSON(w, http.StatusOK, apiResponse{Status: "ok", Data: list})
}

func (a *app) createPrescription(w http.ResponseWriter, r *http.Request) {
	var p prescriptionPayload
	if err := decodeJSON(r, &p); err != nil {
		writeError(w, http.StatusBadRequest, err.Error())
		return
	}
	if strings.TrimSpace(p.VisitID) == "" {
		writeError(w, http.StatusBadRequest, "visit_id is required")
		return
	}
	if strings.TrimSpace(p.PetID) == "" {
		writeError(w, http.StatusBadRequest, "pet_id is required")
		return
	}
	if strings.TrimSpace(p.DrugName) == "" {
		writeError(w, http.StatusBadRequest, "Укажите препарат")
		return
	}

	ctx, cancel := context.WithTimeout(r.Context(), 10*time.Second)
	defer cancel()

	id := strings.TrimSpace(p.ID)
	if id == "" {
		var err error
		if id, err = newUUID(); err != nil {
			writeError(w, http.StatusInternalServerError, "failed to generate id")
			return
		}
	}

	var started *time.Time
	if s := strings.TrimSpace(p.StartedAt); s != "" {
		if t, err := parseFlexibleDate(s); err == nil {
			started = &t
		}
	}

	now := T(nowUTC())
	if _, err := a.db.ExecContext(ctx,
		`INSERT INTO prescriptions (id, visit_id, pet_id, staff_id, item_id, drug_name,
		                            dose, dose_unit, route, duration_days, instruction,
		                            started_at, status, created_at, updated_at, client_updated_at,
		                            is_deleted, version)
		 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, 1)`,
		id, p.VisitID, p.PetID, nullableString(p.StaffID), nullableString(p.ItemID),
		strings.TrimSpace(p.DrugName), p.Dose, nullableString(p.DoseUnit),
		nullableString(normalizeRoute(p.Route)), p.DurationDays,
		nullableString(p.Instruction), nullableTime(started),
		normalizePrescriptionStatus(p.Status), now, now, now,
	); err != nil {
		a.logger.Printf("createPrescription: %v", err)
		writeError(w, http.StatusInternalServerError, "Не удалось сохранить назначение")
		return
	}

	created, _ := a.getPrescriptionByID(ctx, id)
	writeJSON(w, http.StatusCreated, apiResponse{Status: "ok", Data: created})
}

func (a *app) updatePrescription(w http.ResponseWriter, r *http.Request, id string) {
	var p prescriptionPayload
	if err := decodeJSON(r, &p); err != nil {
		writeError(w, http.StatusBadRequest, err.Error())
		return
	}
	ctx, cancel := context.WithTimeout(r.Context(), 10*time.Second)
	defer cancel()

	prev, err := a.getPrescriptionByID(ctx, id)
	if err != nil {
		writeError(w, http.StatusNotFound, "prescription not found")
		return
	}

	var started *time.Time
	if s := strings.TrimSpace(p.StartedAt); s != "" {
		if t, err := parseFlexibleDate(s); err == nil {
			started = &t
		}
	}
	status := normalizePrescriptionStatus(p.Status)

	// Смена статуса — событие, а не просто правка поля: врач должен видеть,
	// что курс отменили или прервали, и когда.
	//
	// Журнал ведёт КЛИЕНТ (он офлайн-first, и правка едет синхронизацией, а не
	// этим обработчиком). Здесь — только подстраховка для прямых вызовов API:
	// если клиент журнал прислал, не трогаем его.
	changeLog := prev.ChangeLog
	var statusAt interface{}
	statusAt = nullableTime(prev.StatusAt)
	if strings.TrimSpace(p.ChangeLog) != "" {
		changeLog = p.ChangeLog
	}
	if s := strings.TrimSpace(p.StatusAt); s != "" {
		if t, err := parseFlexibleDate(s); err == nil {
			statusAt = T(t)
		}
	}
	if status != prev.Status && strings.TrimSpace(p.ChangeLog) == "" {
		statusAt = T(nowUTC())
		entry := `{"at":"` + nowUTC().Format("2006-01-02T15:04:05.000Z") + `","from":"` +
			prev.Status + `","to":"` + status + `","note":"` +
			strings.ReplaceAll(strings.TrimSpace(p.StatusNote), `"`, `'`) + `"}`
		if strings.TrimSpace(changeLog) == "" {
			changeLog = "[" + entry + "]"
		} else if strings.HasSuffix(changeLog, "]") {
			changeLog = changeLog[:len(changeLog)-1] + "," + entry + "]"
		}
	}

	res, err := a.db.ExecContext(ctx,
		`UPDATE prescriptions SET staff_id=?, item_id=?, drug_name=?,
		                          dose=?, dose_unit=?, route=?, duration_days=?,
		                          instruction=?, started_at=?, status=?, status_note=?,
		                          status_at=?, change_log=?,
		                          updated_at=?, client_updated_at=?, version=COALESCE(version,1)+1
		 WHERE id=? AND is_deleted=0`,
		nullableString(p.StaffID), nullableString(p.ItemID), strings.TrimSpace(p.DrugName),
		p.Dose, nullableString(p.DoseUnit), nullableString(normalizeRoute(p.Route)),
		p.DurationDays, nullableString(p.Instruction), nullableTime(started),
		status, nullableString(p.StatusNote), statusAt, nullableString(changeLog),
		T(nowUTC()), T(nowUTC()), id,
	)
	if err != nil {
		a.logger.Printf("updatePrescription: %v", err)
		writeError(w, http.StatusInternalServerError, "Не удалось сохранить назначение")
		return
	}
	if n, _ := res.RowsAffected(); n == 0 {
		writeError(w, http.StatusNotFound, "prescription not found")
		return
	}

	updated, _ := a.getPrescriptionByID(ctx, id)
	writeJSON(w, http.StatusOK, apiResponse{Status: "ok", Data: updated})
}

func (a *app) deletePrescription(w http.ResponseWriter, r *http.Request, id string) {
	ctx, cancel := context.WithTimeout(r.Context(), 10*time.Second)
	defer cancel()
	now := T(nowUTC())
	res, err := a.db.ExecContext(ctx,
		`UPDATE prescriptions SET is_deleted=1, deleted_at=?, updated_at=?, client_updated_at=?,
		                          version=COALESCE(version,1)+1
		 WHERE id=? AND is_deleted=0`, now, now, now, id)
	if err != nil {
		a.logger.Printf("deletePrescription: %v", err)
		writeError(w, http.StatusInternalServerError, "failed to delete prescription")
		return
	}
	if n, _ := res.RowsAffected(); n == 0 {
		writeError(w, http.StatusNotFound, "prescription not found")
		return
	}
	writeJSON(w, http.StatusOK, apiResponse{Status: "ok", Data: map[string]string{"id": id}})
}

// ─── DB helpers ──────────────────────────────────────────────────────────────

const prescriptionSelectAll = `
SELECT id, visit_id, pet_id, COALESCE(staff_id,''), COALESCE(item_id,''), drug_name,
       dose, COALESCE(dose_unit,''), COALESCE(route,''), duration_days,
       COALESCE(instruction,''), started_at, COALESCE(status,'active'),
       COALESCE(status_note,''), status_at, COALESCE(change_log,''),
       created_at, updated_at, deleted_at, is_deleted,
       COALESCE(device_id,''), COALESCE(version,1)
FROM prescriptions`

func (a *app) getPrescriptionByID(ctx context.Context, id string) (Prescription, error) {
	row := a.db.QueryRowContext(ctx, prescriptionSelectAll+` WHERE id=?`, id)
	return scanPrescription(row)
}

func scanPrescription(s interface{ Scan(...interface{}) error }) (Prescription, error) {
	var p Prescription
	var dose sql.NullFloat64
	var days sql.NullInt64
	var started, statusAt, createdAt, updatedAt, deletedAt timeScanner
	err := s.Scan(
		&p.ID, &p.VisitID, &p.PetID, &p.StaffID, &p.ItemID, &p.DrugName,
		&dose, &p.DoseUnit, &p.Route, &days,
		&p.Instruction, &started, &p.Status,
		&p.StatusNote, &statusAt, &p.ChangeLog,
		&createdAt, &updatedAt, &deletedAt, &p.IsDeleted,
		&p.DeviceID, &p.Version,
	)
	if err != nil {
		return Prescription{}, err
	}
	if dose.Valid {
		p.Dose = &dose.Float64
	}
	if days.Valid {
		d := int(days.Int64)
		p.DurationDays = &d
	}
	p.StartedAt = started.ptr()
	p.StatusAt = statusAt.ptr()
	if createdAt.t != nil {
		p.CreatedAt = *createdAt.t
	}
	if updatedAt.t != nil {
		p.UpdatedAt = *updatedAt.t
	}
	p.DeletedAt = deletedAt.ptr()
	return p, nil
}

func pullPrescriptions(ctx context.Context, db *sql.DB, since time.Time) ([]Prescription, error) {
	q := prescriptionSelectAll
	var args []interface{}
	if !since.IsZero() {
		q += ` WHERE updated_at >= ?`
		args = []interface{}{S(since)}
	}
	rows, err := db.QueryContext(ctx, q, args...)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	list := []Prescription{}
	for rows.Next() {
		p, err := scanPrescription(rows)
		if err != nil {
			return nil, err
		}
		list = append(list, p)
	}
	return list, rows.Err()
}

func pushPrescription(ctx context.Context, db *sql.DB, rec prescriptionSyncRecord) (bool, error) {
	if rec.ID == "" {
		return false, nil
	}
	wins, err := clientWinsVersion(ctx, db, "prescriptions", rec.ID, rec.UpdatedAt, rec.Version)
	if err != nil || !wins {
		return false, err
	}
	serverNow := T(nowUTC())
	clientAt := Tp(parseSyncTimePtr(&rec.UpdatedAt))
	_, err = db.ExecContext(ctx, `
		INSERT INTO prescriptions (id, visit_id, pet_id, staff_id, item_id, drug_name,
		                           dose, dose_unit, route, duration_days, instruction,
		                           started_at, status, status_note, status_at, change_log,
		                           created_at, updated_at, deleted_at, is_deleted,
		                           device_id, version, client_updated_at)
		VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
		ON CONFLICT(id) DO UPDATE SET
		  visit_id=excluded.visit_id, pet_id=excluded.pet_id, staff_id=excluded.staff_id,
		  item_id=excluded.item_id, drug_name=excluded.drug_name,
		  dose=excluded.dose, dose_unit=excluded.dose_unit, route=excluded.route,
		  duration_days=excluded.duration_days, instruction=excluded.instruction,
		  started_at=excluded.started_at, status=excluded.status,
		  status_note=excluded.status_note, status_at=excluded.status_at,
		  change_log=excluded.change_log,
		  updated_at=excluded.updated_at, deleted_at=excluded.deleted_at,
		  is_deleted=excluded.is_deleted, device_id=excluded.device_id,
		  version=excluded.version, client_updated_at=excluded.client_updated_at`,
		rec.ID, rec.VisitID, rec.PetID, nullableString(rec.StaffID), nullableString(rec.ItemID),
		rec.DrugName, rec.Dose, nullableString(rec.DoseUnit),
		nullableString(normalizeRoute(rec.Route)), rec.DurationDays,
		nullableString(rec.Instruction), Tp(parseSyncTimePtr(rec.StartedAt)),
		normalizePrescriptionStatus(rec.Status), nullableString(rec.StatusNote),
		Tp(parseSyncTimePtr(rec.StatusAt)), nullableString(rec.ChangeLog),
		serverNow, serverNow, Tp(parseSyncTimePtr(rec.DeletedAt)), rec.IsDeleted,
		nullableString(rec.DeviceID), rec.Version, clientAt,
	)
	return err == nil, err
}
