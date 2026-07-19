package main

import (
	"context"
	"errors"
	"net/http"
	"strings"
	"time"
)

func (a *app) handleStaff(w http.ResponseWriter, r *http.Request) {
	switch r.Method {
	case http.MethodGet:
		a.listStaff(w, r)
	case http.MethodPost:
		a.createStaff(w, r)
	default:
		writeError(w, http.StatusMethodNotAllowed, "method not allowed")
	}
}

func (a *app) handleStaffByID(w http.ResponseWriter, r *http.Request) {
	id := strings.TrimSpace(r.PathValue("id"))
	if id == "" {
		writeError(w, http.StatusBadRequest, "id is required")
		return
	}
	switch r.Method {
	case http.MethodGet:
		a.getStaffDetail(w, r, id)
	case http.MethodPut:
		a.updateStaff(w, r, id)
	case http.MethodDelete:
		a.deleteStaff(w, r, id)
	default:
		writeError(w, http.StatusMethodNotAllowed, "method not allowed")
	}
}

func (a *app) listStaff(w http.ResponseWriter, r *http.Request) {
	ctx, cancel := context.WithTimeout(r.Context(), 5*time.Second)
	defer cancel()

	q := staffSelectAll + ` WHERE is_deleted=0`
	args := make([]interface{}, 0)

	// ?active=true — только активные (по умолчанию все неудалённые)
	if r.URL.Query().Get("active") == "true" {
		q += ` AND is_active=1`
	}
	if role := strings.TrimSpace(r.URL.Query().Get("role")); role != "" {
		q += ` AND role=?`
		args = append(args, role)
	}
	q += ` ORDER BY name ASC`

	rows, err := a.db.QueryContext(ctx, q, args...)
	if err != nil {
		a.logger.Printf("listStaff: %v", err)
		writeError(w, http.StatusInternalServerError, "failed to load staff")
		return
	}
	defer rows.Close()

	list := make([]Staff, 0)
	for rows.Next() {
		s, err := scanStaff(rows)
		if err != nil {
			a.logger.Printf("listStaff scan: %v", err)
			writeError(w, http.StatusInternalServerError, "failed to load staff")
			return
		}
		list = append(list, s)
	}
	writeJSON(w, http.StatusOK, apiResponse{Status: "ok", Data: list})
}

func (a *app) getStaffDetail(w http.ResponseWriter, r *http.Request, id string) {
	ctx, cancel := context.WithTimeout(r.Context(), 5*time.Second)
	defer cancel()
	s, err := a.getStaffByID(ctx, id)
	if err != nil {
		writeError(w, http.StatusNotFound, "staff not found")
		return
	}
	writeJSON(w, http.StatusOK, apiResponse{Status: "ok", Data: s})
}

func (a *app) createStaff(w http.ResponseWriter, r *http.Request) {
	var p staffPayload
	if err := decodeJSON(r, &p); err != nil {
		writeError(w, http.StatusBadRequest, err.Error())
		return
	}
	if err := validateStaffPayload(p); err != nil {
		writeError(w, http.StatusBadRequest, err.Error())
		return
	}

	id := strings.TrimSpace(p.ID)
	var err error
	if id == "" {
		id, err = newUUID()
		if err != nil {
			writeError(w, http.StatusInternalServerError, "failed to generate id")
			return
		}
	}

	isActive := true
	if p.IsActive != nil {
		isActive = *p.IsActive
	}

	ctx, cancel := context.WithTimeout(r.Context(), 5*time.Second)
	defer cancel()

	now := T(nowUTC())
	if _, err := a.db.ExecContext(ctx,
		`INSERT INTO clinic_staff (id, name, role, phone, email, is_active, notes, photo,
		                           created_at, updated_at, version)
		 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1)`,
		id, strings.TrimSpace(p.Name), strings.TrimSpace(p.Role),
		nullableString(p.Phone), nullableString(p.Email),
		boolToInt(isActive), nullableString(p.Notes), nullableString(p.Photo), now, now,
	); err != nil {
		a.logger.Printf("createStaff: %v", err)
		writeError(w, http.StatusInternalServerError, "failed to create staff")
		return
	}

	created, _ := a.getStaffByID(ctx, id)
	writeJSON(w, http.StatusCreated, apiResponse{Status: "ok", Data: created})
}

func (a *app) updateStaff(w http.ResponseWriter, r *http.Request, id string) {
	var p staffPayload
	if err := decodeJSON(r, &p); err != nil {
		writeError(w, http.StatusBadRequest, err.Error())
		return
	}
	if err := validateStaffPayload(p); err != nil {
		writeError(w, http.StatusBadRequest, err.Error())
		return
	}

	isActive := true
	if p.IsActive != nil {
		isActive = *p.IsActive
	}

	ctx, cancel := context.WithTimeout(r.Context(), 5*time.Second)
	defer cancel()

	res, err := a.db.ExecContext(ctx,
		`UPDATE clinic_staff SET name=?, role=?, phone=?, email=?, is_active=?, notes=?, photo=?,
		                         updated_at=?, version=version+1
		 WHERE id=? AND is_deleted=0`,
		strings.TrimSpace(p.Name), strings.TrimSpace(p.Role),
		nullableString(p.Phone), nullableString(p.Email),
		boolToInt(isActive), nullableString(p.Notes), nullableString(p.Photo),
		T(nowUTC()), id,
	)
	if err != nil {
		a.logger.Printf("updateStaff: %v", err)
		writeError(w, http.StatusInternalServerError, "failed to update staff")
		return
	}
	if n, _ := res.RowsAffected(); n == 0 {
		writeError(w, http.StatusNotFound, "staff not found")
		return
	}

	updated, _ := a.getStaffByID(ctx, id)
	writeJSON(w, http.StatusOK, apiResponse{Status: "ok", Data: updated})
}

func (a *app) deleteStaff(w http.ResponseWriter, r *http.Request, id string) {
	ctx, cancel := context.WithTimeout(r.Context(), 5*time.Second)
	defer cancel()
	now := T(nowUTC())
	res, err := a.db.ExecContext(ctx,
		`UPDATE clinic_staff SET is_deleted=1, deleted_at=?, is_active=0, updated_at=?, version=version+1
		 WHERE id=? AND is_deleted=0`,
		now, now, id)
	if err != nil {
		a.logger.Printf("deleteStaff: %v", err)
		writeError(w, http.StatusInternalServerError, "failed to delete staff")
		return
	}
	if n, _ := res.RowsAffected(); n == 0 {
		writeError(w, http.StatusNotFound, "staff not found")
		return
	}
	writeJSON(w, http.StatusOK, apiResponse{Status: "ok", Data: map[string]string{"id": id}})
}

// ─── DB helpers ───────────────────────────────────────────────────────────────

const staffSelectAll = `
SELECT id, name, role, COALESCE(phone,''), COALESCE(email,''), is_active, COALESCE(notes,''), COALESCE(photo,''),
       created_at, updated_at, deleted_at, is_deleted,
       COALESCE(device_id,''), COALESCE(version,1)
FROM clinic_staff`

func (a *app) getStaffByID(ctx context.Context, id string) (Staff, error) {
	row := a.db.QueryRowContext(ctx, staffSelectAll+` WHERE id=?`, id)
	return scanStaff(row)
}

func scanStaff(s interface{ Scan(...interface{}) error }) (Staff, error) {
	var st Staff
	var isActive int
	var createdAt, updatedAt, deletedAt timeScanner
	err := s.Scan(
		&st.ID, &st.Name, &st.Role, &st.Phone, &st.Email, &isActive, &st.Notes, &st.Photo,
		&createdAt, &updatedAt, &deletedAt,
		&st.IsDeleted, &st.DeviceID, &st.Version,
	)
	if err != nil {
		return Staff{}, err
	}
	st.IsActive = isActive == 1
	if createdAt.t != nil { st.CreatedAt = *createdAt.t }
	if updatedAt.t != nil { st.UpdatedAt = *updatedAt.t }
	st.DeletedAt = deletedAt.ptr()
	return st, err
}

func validateStaffPayload(p staffPayload) error {
	if strings.TrimSpace(p.Name) == "" {
		return errors.New("name is required")
	}
	if strings.TrimSpace(p.Role) == "" {
		return errors.New("role is required")
	}
	return nil
}
