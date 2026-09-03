package main

import (
	"context"
	"database/sql"
	"net/http"
	"strings"
	"time"
)

// Справочник диагнозов с заготовками лечения и рекомендаций.
//
// Зачем: diagnosis у визита — свободная строка. Из-за этого нельзя ни
// посчитать частые диагнозы, ни предложить врачу готовый текст, и поля
// «Лечение»/«Рекомендации» заполняются с нуля каждый раз. Отсюда же
// берутся приёмы «Без диагноза»: проще не заполнить, чем печатать.
//
// Справочник синкается как обычная таблица — офлайн не мешает.

type DiagnosisTemplate struct {
	ID              string `json:"id"`
	Name            string `json:"name"`
	Treatment       string `json:"treatment"`
	Recommendations string `json:"recommendations"`
	SyncMeta
}

func (d DiagnosisTemplate) recordID() string { return d.ID }

const diagnosisSelectAll = `
SELECT id, name, COALESCE(treatment,''), COALESCE(recommendations,''),
       created_at, updated_at, deleted_at, is_deleted,
       COALESCE(device_id,''), COALESCE(version,1)
FROM diagnosis_templates`

func scanDiagnosis(rows *sql.Rows) (DiagnosisTemplate, error) {
	var d DiagnosisTemplate
	var created, updated timeScanner
	var deleted timeScanner
	err := rows.Scan(&d.ID, &d.Name, &d.Treatment, &d.Recommendations,
		&created, &updated, &deleted, &d.IsDeleted, &d.DeviceID, &d.Version)
	if err != nil {
		return d, err
	}
	if created.t != nil {
		d.CreatedAt = *created.t
	}
	if updated.t != nil {
		d.UpdatedAt = *updated.t
	}
	d.DeletedAt = deleted.t
	return d, nil
}

// ─── HTTP ────────────────────────────────────────────────────────────────────

func (a *app) handleDiagnoses(w http.ResponseWriter, r *http.Request) {
	switch r.Method {
	case http.MethodGet:
		a.listDiagnoses(w, r)
	case http.MethodPost:
		a.createDiagnosis(w, r)
	default:
		writeError(w, http.StatusMethodNotAllowed, "method not allowed")
	}
}

func (a *app) listDiagnoses(w http.ResponseWriter, r *http.Request) {
	ctx, cancel := context.WithTimeout(r.Context(), 10*time.Second)
	defer cancel()

	rows, err := a.db.QueryContext(ctx, diagnosisSelectAll+` WHERE is_deleted = 0 ORDER BY name`)
	if err != nil {
		a.logger.Printf("listDiagnoses: %v", err)
		writeError(w, http.StatusInternalServerError, "Не удалось загрузить справочник")
		return
	}
	defer rows.Close()

	list := make([]DiagnosisTemplate, 0, 64)
	for rows.Next() {
		d, err := scanDiagnosis(rows)
		if err != nil {
			continue
		}
		list = append(list, d)
	}
	writeJSON(w, http.StatusOK, apiResponse{Status: "ok", Data: list})
}

type diagnosisPayload struct {
	Name            string `json:"name"`
	Treatment       string `json:"treatment"`
	Recommendations string `json:"recommendations"`
}

func (a *app) createDiagnosis(w http.ResponseWriter, r *http.Request) {
	var p diagnosisPayload
	if err := decodeJSON(r, &p); err != nil {
		writeError(w, http.StatusBadRequest, err.Error())
		return
	}
	name := strings.TrimSpace(p.Name)
	if name == "" {
		writeError(w, http.StatusBadRequest, "Укажите название диагноза")
		return
	}

	ctx, cancel := context.WithTimeout(r.Context(), 10*time.Second)
	defer cancel()

	id, err := newUUID()
	if err != nil {
		writeError(w, http.StatusInternalServerError, "failed to generate id")
		return
	}
	now := T(nowUTC())
	_, err = a.db.ExecContext(ctx, `
		INSERT INTO diagnosis_templates (id, name, treatment, recommendations,
		        created_at, updated_at, client_updated_at, is_deleted, version)
		VALUES (?, ?, ?, ?, ?, ?, ?, 0, 1)`,
		id, name, strings.TrimSpace(p.Treatment), strings.TrimSpace(p.Recommendations),
		now, now, now)
	if err != nil {
		a.logger.Printf("createDiagnosis: %v", err)
		writeError(w, http.StatusInternalServerError, "Не удалось сохранить диагноз")
		return
	}
	writeJSON(w, http.StatusCreated, apiResponse{Status: "ok",
		Data: map[string]string{"id": id, "name": name}})
}

func (a *app) handleDiagnosisByID(w http.ResponseWriter, r *http.Request) {
	id := strings.TrimSpace(r.PathValue("id"))
	if id == "" {
		writeError(w, http.StatusBadRequest, "id is required")
		return
	}
	ctx, cancel := context.WithTimeout(r.Context(), 10*time.Second)
	defer cancel()

	switch r.Method {
	case http.MethodPut:
		var p diagnosisPayload
		if err := decodeJSON(r, &p); err != nil {
			writeError(w, http.StatusBadRequest, err.Error())
			return
		}
		if strings.TrimSpace(p.Name) == "" {
			writeError(w, http.StatusBadRequest, "Укажите название диагноза")
			return
		}
		now := T(nowUTC())
		res, err := a.db.ExecContext(ctx, `
			UPDATE diagnosis_templates
			SET name=?, treatment=?, recommendations=?, updated_at=?,
			    client_updated_at=?, version=COALESCE(version,1)+1
			WHERE id=? AND is_deleted=0`,
			strings.TrimSpace(p.Name), strings.TrimSpace(p.Treatment),
			strings.TrimSpace(p.Recommendations), now, now, id)
		if err != nil {
			a.logger.Printf("updateDiagnosis: %v", err)
			writeError(w, http.StatusInternalServerError, "Не удалось сохранить")
			return
		}
		if n, _ := res.RowsAffected(); n == 0 {
			writeError(w, http.StatusNotFound, "Диагноз не найден")
			return
		}
		writeJSON(w, http.StatusOK, apiResponse{Status: "ok", Data: map[string]string{"id": id}})

	case http.MethodDelete:
		// Мягкое удаление, как везде: запись должна разойтись по устройствам
		// и попасть в корзину, а не исчезнуть молча.
		now := T(nowUTC())
		res, err := a.db.ExecContext(ctx, `
			UPDATE diagnosis_templates
			SET is_deleted=1, deleted_at=?, updated_at=?, client_updated_at=?,
			    version=COALESCE(version,1)+1
			WHERE id=? AND is_deleted=0`, now, now, now, id)
		if err != nil {
			a.logger.Printf("deleteDiagnosis: %v", err)
			writeError(w, http.StatusInternalServerError, "Не удалось удалить")
			return
		}
		if n, _ := res.RowsAffected(); n == 0 {
			writeError(w, http.StatusNotFound, "Диагноз не найден")
			return
		}
		writeJSON(w, http.StatusOK, apiResponse{Status: "ok", Data: map[string]string{"id": id}})

	default:
		writeError(w, http.StatusMethodNotAllowed, "method not allowed")
	}
}

// ─── Синхронизация ───────────────────────────────────────────────────────────

type diagnosisSyncRecord struct {
	ID              string  `json:"id"`
	Name            string  `json:"name"`
	Treatment       string  `json:"treatment"`
	Recommendations string  `json:"recommendations"`
	UpdatedAt       string  `json:"updated_at"`
	DeletedAt       *string `json:"deleted_at"`
	IsDeleted       int     `json:"is_deleted"`
	DeviceID        string  `json:"device_id"`
	Version         int     `json:"version"`
}

func (r diagnosisSyncRecord) recordID() string { return r.ID }

func pushDiagnosis(ctx context.Context, db *sql.DB, rec diagnosisSyncRecord) (bool, error) {
	if rec.ID == "" {
		return false, nil
	}
	wins, err := clientWinsVersion(ctx, db, "diagnosis_templates", rec.ID, rec.UpdatedAt, rec.Version)
	if err != nil || !wins {
		return false, err
	}
	serverNow := T(nowUTC())
	clientAt := Tp(parseSyncTimePtr(&rec.UpdatedAt))
	deletedAt := Tp(parseSyncTimePtr(rec.DeletedAt))
	_, err = db.ExecContext(ctx, `
		INSERT INTO diagnosis_templates (id, name, treatment, recommendations,
		        created_at, updated_at, deleted_at, is_deleted, device_id, version, client_updated_at)
		VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
		ON CONFLICT(id) DO UPDATE SET
		  name=excluded.name, treatment=excluded.treatment,
		  recommendations=excluded.recommendations,
		  updated_at=excluded.updated_at, deleted_at=excluded.deleted_at,
		  is_deleted=excluded.is_deleted, device_id=excluded.device_id,
		  version=excluded.version, client_updated_at=excluded.client_updated_at`,
		rec.ID, rec.Name, rec.Treatment, rec.Recommendations,
		serverNow, serverNow, deletedAt, rec.IsDeleted,
		nullableString(rec.DeviceID), rec.Version, clientAt)
	return err == nil, err
}

func pullDiagnoses(ctx context.Context, db *sql.DB, since time.Time) ([]DiagnosisTemplate, error) {
	filter := ""
	var args []interface{}
	if !since.IsZero() {
		filter = ` WHERE updated_at >= ?`
		args = []interface{}{S(since)}
	}
	rows, err := db.QueryContext(ctx, diagnosisSelectAll+filter, args...)
	if err != nil {
		return nil, err
	}
	defer rows.Close()

	list := make([]DiagnosisTemplate, 0, 64)
	for rows.Next() {
		d, err := scanDiagnosis(rows)
		if err != nil {
			continue
		}
		list = append(list, d)
	}
	return list, nil
}
