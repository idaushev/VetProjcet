package main

// Расписание: запись клиентов на приём.
//
// Запись — не приём: она может ссылаться на владельца/питомца из базы
// (owner_id/pet_id), а может держать только текст (позвонил новый клиент).
// Когда приём состоялся, запись получает status='done' и visit_id.
//
// Работает по общей offline-first схеме: планшет пишет в IndexedDB,
// сервер получает записи через /sync/push и раздаёт через /sync/pull.
// REST-эндпоинты — для прямых операций и legacy-fallback.

import (
	"context"
	"database/sql"
	"errors"
	"net/http"
	"strings"
	"time"
)

var validAppointmentStatus = map[string]bool{
	"scheduled": true, "done": true, "cancelled": true, "no_show": true,
}

const appointmentSelectAll = `
SELECT a.id, COALESCE(a.owner_id,''), COALESCE(a.pet_id,''), COALESCE(a.staff_id,''),
       COALESCE(a.client_name,''), COALESCE(a.client_phone,''), COALESCE(a.pet_name,''),
       a.starts_at, COALESCE(a.duration_min,30), COALESCE(a.reason,''),
       COALESCE(a.status,'scheduled'), COALESCE(a.visit_id,''), COALESCE(a.notes,''),
       COALESCE(a.source,''), COALESCE(a.confirmed,1),
       a.created_at, a.updated_at, a.deleted_at, a.is_deleted,
       COALESCE(a.device_id,''), COALESCE(a.version,1)
FROM appointments a`

func scanAppointment(s interface{ Scan(...interface{}) error }) (Appointment, error) {
	var ap Appointment
	var startsAt, createdAt, updatedAt, deletedAt timeScanner
	err := s.Scan(
		&ap.ID, &ap.OwnerID, &ap.PetID, &ap.StaffID,
		&ap.ClientName, &ap.ClientPhone, &ap.PetName,
		&startsAt, &ap.DurationMin, &ap.Reason,
		&ap.Status, &ap.VisitID, &ap.Notes,
		&ap.Source, &ap.Confirmed,
		&createdAt, &updatedAt, &deletedAt, &ap.IsDeleted,
		&ap.DeviceID, &ap.Version,
	)
	if err != nil {
		return Appointment{}, err
	}
	if startsAt.t != nil  { ap.StartsAt = *startsAt.t }
	if createdAt.t != nil { ap.CreatedAt = *createdAt.t }
	if updatedAt.t != nil { ap.UpdatedAt = *updatedAt.t }
	ap.DeletedAt = deletedAt.ptr()
	return ap, nil
}

func appointmentFromPayload(p appointmentPayload) (Appointment, error) {
	starts, err := parseFlexibleDate(strings.TrimSpace(p.StartsAt))
	if err != nil {
		return Appointment{}, errors.New("starts_at: неверная дата")
	}
	status := strings.TrimSpace(p.Status)
	if status == "" {
		status = "scheduled"
	}
	if !validAppointmentStatus[status] {
		return Appointment{}, errors.New("status: scheduled | done | cancelled | no_show")
	}
	dur := p.DurationMin
	if dur <= 0 {
		dur = 30
	}
	if dur > 480 {
		dur = 480
	}
	// Запись должна указывать хоть на кого-то: питомца из базы или текст.
	if strings.TrimSpace(p.PetID) == "" && strings.TrimSpace(p.ClientName) == "" &&
		strings.TrimSpace(p.PetName) == "" && strings.TrimSpace(p.OwnerID) == "" {
		return Appointment{}, errors.New("укажите клиента: питомца из базы или имя/кличку текстом")
	}
	// confirmed: nil (старый клиент не прислал поле) трактуем как 1 —
	// это запись из клиники, она подтверждена. Явный 0 приходит от портала.
	confirmed := 1
	if p.Confirmed != nil {
		confirmed = *p.Confirmed
	}
	return Appointment{
		ID:          strings.TrimSpace(p.ID),
		OwnerID:     strings.TrimSpace(p.OwnerID),
		PetID:       strings.TrimSpace(p.PetID),
		StaffID:     strings.TrimSpace(p.StaffID),
		ClientName:  strings.TrimSpace(p.ClientName),
		ClientPhone: strings.TrimSpace(p.ClientPhone),
		PetName:     strings.TrimSpace(p.PetName),
		StartsAt:    starts,
		DurationMin: dur,
		Reason:      strings.TrimSpace(p.Reason),
		Status:      status,
		VisitID:     strings.TrimSpace(p.VisitID),
		Notes:       strings.TrimSpace(p.Notes),
		Source:      strings.TrimSpace(p.Source),
		Confirmed:   confirmed,
	}, nil
}

// ─── REST ────────────────────────────────────────────────────────────────────

func (a *app) handleAppointments(w http.ResponseWriter, r *http.Request) {
	switch r.Method {
	case http.MethodGet:
		a.listAppointments(w, r)
	case http.MethodPost:
		a.createAppointment(w, r)
	default:
		writeError(w, http.StatusMethodNotAllowed, "method not allowed")
	}
}

func (a *app) handleAppointmentByID(w http.ResponseWriter, r *http.Request) {
	id := strings.TrimSpace(r.PathValue("id"))
	if id == "" {
		writeError(w, http.StatusBadRequest, "id is required")
		return
	}
	switch r.Method {
	case http.MethodPut:
		a.updateAppointment(w, r, id)
	case http.MethodDelete:
		a.deleteAppointment(w, r, id)
	default:
		writeError(w, http.StatusMethodNotAllowed, "method not allowed")
	}
}

func (a *app) listAppointments(w http.ResponseWriter, r *http.Request) {
	ctx, cancel := context.WithTimeout(r.Context(), 5*time.Second)
	defer cancel()

	q := appointmentSelectAll + ` WHERE a.is_deleted=0`
	args := make([]interface{}, 0, 3)
	// ?date=YYYY-MM-DD — записи одного дня (основной запрос экрана)
	if d := strings.TrimSpace(r.URL.Query().Get("date")); d != "" {
		q += ` AND a.starts_at >= ? AND a.starts_at < ?`
		args = append(args, d, d+"T23:59:59.999Z")
	}
	if s := strings.TrimSpace(r.URL.Query().Get("staff_id")); s != "" {
		q += ` AND a.staff_id = ?`
		args = append(args, s)
	}
	q += ` ORDER BY a.starts_at`

	rows, err := a.db.QueryContext(ctx, q, args...)
	if err != nil {
		a.logger.Printf("listAppointments: %v", err)
		writeError(w, http.StatusInternalServerError, "failed to load appointments")
		return
	}
	defer rows.Close()

	appts := make([]Appointment, 0)
	for rows.Next() {
		ap, err := scanAppointment(rows)
		if err != nil {
			continue
		}
		appts = append(appts, ap)
	}
	writeJSON(w, http.StatusOK, apiResponse{Status: "ok", Data: appts})
}

func (a *app) createAppointment(w http.ResponseWriter, r *http.Request) {
	var p appointmentPayload
	if err := decodeJSON(r, &p); err != nil {
		writeError(w, http.StatusBadRequest, err.Error())
		return
	}
	ap, err := appointmentFromPayload(p)
	if err != nil {
		writeError(w, http.StatusBadRequest, err.Error())
		return
	}
	if ap.ID == "" {
		if ap.ID, err = newUUID(); err != nil {
			writeError(w, http.StatusInternalServerError, "failed to generate id")
			return
		}
	}

	ctx, cancel := context.WithTimeout(r.Context(), 5*time.Second)
	defer cancel()

	now := T(nowUTC())
	if _, err := a.db.ExecContext(ctx, `
		INSERT INTO appointments (id, owner_id, pet_id, staff_id, client_name, client_phone, pet_name,
		                          starts_at, duration_min, reason, status, visit_id, notes, source, confirmed,
		                          created_at, updated_at, version)
		VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1)`,
		ap.ID, nullableString(ap.OwnerID), nullableString(ap.PetID), nullableString(ap.StaffID),
		nullableString(ap.ClientName), nullableString(ap.ClientPhone), nullableString(ap.PetName),
		T(ap.StartsAt), ap.DurationMin, nullableString(ap.Reason), ap.Status,
		nullableString(ap.VisitID), nullableString(ap.Notes), nullableString(ap.Source), ap.Confirmed, now, now,
	); err != nil {
		a.logger.Printf("createAppointment: %v", err)
		writeError(w, http.StatusInternalServerError, "failed to create appointment")
		return
	}

	row := a.db.QueryRowContext(ctx, appointmentSelectAll+` WHERE a.id=?`, ap.ID)
	created, _ := scanAppointment(row)
	writeJSON(w, http.StatusCreated, apiResponse{Status: "ok", Data: created})
}

func (a *app) updateAppointment(w http.ResponseWriter, r *http.Request, id string) {
	var p appointmentPayload
	if err := decodeJSON(r, &p); err != nil {
		writeError(w, http.StatusBadRequest, err.Error())
		return
	}
	ap, err := appointmentFromPayload(p)
	if err != nil {
		writeError(w, http.StatusBadRequest, err.Error())
		return
	}

	ctx, cancel := context.WithTimeout(r.Context(), 5*time.Second)
	defer cancel()

	res, err := a.db.ExecContext(ctx, `
		UPDATE appointments SET owner_id=?, pet_id=?, staff_id=?, client_name=?, client_phone=?, pet_name=?,
		                        starts_at=?, duration_min=?, reason=?, status=?, visit_id=?, notes=?,
		                        source=?, confirmed=?, updated_at=?, version=version+1
		WHERE id=? AND is_deleted=0`,
		nullableString(ap.OwnerID), nullableString(ap.PetID), nullableString(ap.StaffID),
		nullableString(ap.ClientName), nullableString(ap.ClientPhone), nullableString(ap.PetName),
		T(ap.StartsAt), ap.DurationMin, nullableString(ap.Reason), ap.Status,
		nullableString(ap.VisitID), nullableString(ap.Notes), nullableString(ap.Source), ap.Confirmed, T(nowUTC()), id,
	)
	if err != nil {
		a.logger.Printf("updateAppointment: %v", err)
		writeError(w, http.StatusInternalServerError, "failed to update appointment")
		return
	}
	if n, _ := res.RowsAffected(); n == 0 {
		writeError(w, http.StatusNotFound, "appointment not found")
		return
	}
	row := a.db.QueryRowContext(ctx, appointmentSelectAll+` WHERE a.id=?`, id)
	updated, _ := scanAppointment(row)
	writeJSON(w, http.StatusOK, apiResponse{Status: "ok", Data: updated})
}

func (a *app) deleteAppointment(w http.ResponseWriter, r *http.Request, id string) {
	ctx, cancel := context.WithTimeout(r.Context(), 5*time.Second)
	defer cancel()
	res, err := a.db.ExecContext(ctx,
		`UPDATE appointments SET is_deleted=1, deleted_at=?, updated_at=?, version=version+1 WHERE id=? AND is_deleted=0`,
		T(nowUTC()), T(nowUTC()), id)
	if err != nil {
		writeError(w, http.StatusInternalServerError, "failed to delete appointment")
		return
	}
	if n, _ := res.RowsAffected(); n == 0 {
		writeError(w, http.StatusNotFound, "appointment not found")
		return
	}
	writeJSON(w, http.StatusOK, apiResponse{Status: "ok", Data: map[string]string{"id": id}})
}

// ─── Sync ────────────────────────────────────────────────────────────────────

func pushAppointment(ctx context.Context, db *sql.DB, rec appointmentSyncRecord) (bool, error) {
	if rec.ID == "" {
		return false, errors.New("empty id")
	}
	wins, err := clientWinsVersion(ctx, db, "appointments", rec.ID, rec.UpdatedAt, rec.Version)
	if err != nil || !wins {
		return false, err
	}
	starts, err := parseFlexibleDate(rec.StartsAt)
	if err != nil {
		return false, errors.New("starts_at: неверная дата")
	}
	status := rec.Status
	if !validAppointmentStatus[status] {
		status = "scheduled"
	}
	dur := rec.DurationMin
	if dur <= 0 {
		dur = 30
	}
	// confirmed: nil (планшет со старой версией) → 1, запись клиники подтверждена.
	confirmed := 1
	if rec.Confirmed != nil {
		confirmed = *rec.Confirmed
	}
	serverNow := T(nowUTC())
	clientAt := Tp(parseSyncTimePtr(&rec.UpdatedAt))
	deletedAt := Tp(parseSyncTimePtr(rec.DeletedAt))
	_, err = db.ExecContext(ctx, `
		INSERT INTO appointments (id, owner_id, pet_id, staff_id, client_name, client_phone, pet_name,
		                          starts_at, duration_min, reason, status, visit_id, notes, source, confirmed,
		                          updated_at, deleted_at, is_deleted, device_id, version, created_at, client_updated_at)
		VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
		ON CONFLICT(id) DO UPDATE SET
		  owner_id=excluded.owner_id, pet_id=excluded.pet_id, staff_id=excluded.staff_id,
		  client_name=excluded.client_name, client_phone=excluded.client_phone, pet_name=excluded.pet_name,
		  starts_at=excluded.starts_at, duration_min=excluded.duration_min, reason=excluded.reason,
		  status=excluded.status, visit_id=excluded.visit_id, notes=excluded.notes,
		  source=excluded.source, confirmed=excluded.confirmed,
		  updated_at=excluded.updated_at, deleted_at=excluded.deleted_at, is_deleted=excluded.is_deleted,
		  device_id=excluded.device_id, version=excluded.version,
		  client_updated_at=excluded.client_updated_at`,
		rec.ID, nullableString(rec.OwnerID), nullableString(rec.PetID), nullableString(rec.StaffID),
		nullableString(rec.ClientName), nullableString(rec.ClientPhone), nullableString(rec.PetName),
		T(starts), dur, nullableString(rec.Reason), status,
		nullableString(rec.VisitID), nullableString(rec.Notes), nullableString(rec.Source), confirmed,
		serverNow, deletedAt, rec.IsDeleted, nullableString(rec.DeviceID), rec.Version, serverNow, clientAt,
	)
	return err == nil, err
}

func pullAppointments(ctx context.Context, db *sql.DB, since time.Time) ([]Appointment, error) {
	q := appointmentSelectAll
	args := []interface{}{}
	if !since.IsZero() {
		q += ` WHERE a.updated_at > ?`
		args = append(args, T(since))
	}
	rows, err := db.QueryContext(ctx, q, args...)
	if err != nil {
		return nil, err
	}
	defer rows.Close()

	appts := make([]Appointment, 0)
	for rows.Next() {
		ap, err := scanAppointment(rows)
		if err != nil {
			continue // битую запись пропускаем, pull не ломаем
		}
		appts = append(appts, ap)
	}
	return appts, nil
}
