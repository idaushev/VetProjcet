package main

import (
	"context"
	"database/sql"
	"net/http"
	"strings"
	"time"
)

func (a *app) handleVaccinations(w http.ResponseWriter, r *http.Request) {
	switch r.Method {
	case http.MethodGet:
		a.listVaccinations(w, r)
	case http.MethodPost:
		a.createVaccination(w, r)
	default:
		writeError(w, http.StatusMethodNotAllowed, "method not allowed")
	}
}

func (a *app) handleVaccinationByID(w http.ResponseWriter, r *http.Request) {
	id := strings.TrimSpace(r.PathValue("id"))
	if id == "" {
		writeError(w, http.StatusBadRequest, "id is required")
		return
	}
	switch r.Method {
	case http.MethodGet:
		a.getVaccinationDetail(w, r, id)
	case http.MethodPut:
		a.updateVaccination(w, r, id)
	case http.MethodDelete:
		a.deleteVaccination(w, r, id)
	default:
		writeError(w, http.StatusMethodNotAllowed, "method not allowed")
	}
}

func (a *app) listVaccinations(w http.ResponseWriter, r *http.Request) {
	ctx, cancel := context.WithTimeout(r.Context(), 5*time.Second)
	defer cancel()

	q := vaccinationSelectAll + ` WHERE is_deleted=0`
	args := make([]interface{}, 0)

	if petID := strings.TrimSpace(r.URL.Query().Get("pet_id")); petID != "" {
		q += ` AND pet_id=?`
		args = append(args, petID)
	}
	if df := strings.TrimSpace(r.URL.Query().Get("date_from")); df != "" {
		q += ` AND administered_at>=?`
		args = append(args, df)
	}
	q += ` ORDER BY administered_at DESC`

	rows, err := a.db.QueryContext(ctx, q, args...)
	if err != nil {
		a.logger.Printf("listVaccinations: %v", err)
		writeError(w, http.StatusInternalServerError, "failed to load vaccinations")
		return
	}
	defer rows.Close()

	list := make([]Vaccination, 0)
	for rows.Next() {
		v, err := scanVaccination(rows)
		if err != nil {
			a.logger.Printf("listVaccinations scan: %v", err)
			writeError(w, http.StatusInternalServerError, "failed to load vaccinations")
			return
		}
		list = append(list, v)
	}
	writeJSON(w, http.StatusOK, apiResponse{Status: "ok", Data: list})
}

func (a *app) getVaccinationDetail(w http.ResponseWriter, r *http.Request, id string) {
	ctx, cancel := context.WithTimeout(r.Context(), 5*time.Second)
	defer cancel()
	v, err := a.getVaccinationByID(ctx, id)
	if err != nil {
		writeError(w, http.StatusNotFound, "vaccination not found")
		return
	}
	writeJSON(w, http.StatusOK, apiResponse{Status: "ok", Data: v})
}

func (a *app) createVaccination(w http.ResponseWriter, r *http.Request) {
	var p vaccinationPayload
	if err := decodeJSON(r, &p); err != nil {
		writeError(w, http.StatusBadRequest, err.Error())
		return
	}
	if strings.TrimSpace(p.PetID) == "" {
		writeError(w, http.StatusBadRequest, "pet_id is required")
		return
	}
	if strings.TrimSpace(p.VaccineName) == "" {
		writeError(w, http.StatusBadRequest, "vaccine_name is required")
		return
	}
	adminAt, err := parseFlexibleDate(p.AdministeredAt)
	if err != nil {
		writeError(w, http.StatusBadRequest, "administered_at: invalid date")
		return
	}

	ctx, cancel := context.WithTimeout(r.Context(), 5*time.Second)
	defer cancel()

	if _, err := a.getPetByID(ctx, p.PetID); err != nil {
		writeError(w, http.StatusBadRequest, "pet not found")
		return
	}

	id := strings.TrimSpace(p.ID)
	if id == "" {
		id, err = newUUID()
		if err != nil {
			writeError(w, http.StatusInternalServerError, "failed to generate id")
			return
		}
	}

	var nextDue *time.Time
	if p.NextDueAt != "" {
		t, err := parseFlexibleDate(p.NextDueAt)
		if err == nil {
			nextDue = &t
		}
	}

	now := T(nowUTC())
	if _, err := a.db.ExecContext(ctx,
		`INSERT INTO vaccinations (id, pet_id, staff_id, vaccine_name, batch_number, manufacturer,
		                           dose, administered_at, next_due_at, notes,
		                           created_at, updated_at, version)
		 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1)`,
		id, p.PetID, nullableString(p.StaffID),
		strings.TrimSpace(p.VaccineName), nullableString(p.BatchNumber),
		nullableString(p.Manufacturer), p.Dose, adminAt, nullableTime(nextDue),
		nullableString(p.Notes), now, now,
	); err != nil {
		a.logger.Printf("createVaccination: %v", err)
		writeError(w, http.StatusInternalServerError, "failed to create vaccination")
		return
	}

	created, _ := a.getVaccinationByID(ctx, id)
	writeJSON(w, http.StatusCreated, apiResponse{Status: "ok", Data: created})
}

func (a *app) updateVaccination(w http.ResponseWriter, r *http.Request, id string) {
	var p vaccinationPayload
	if err := decodeJSON(r, &p); err != nil {
		writeError(w, http.StatusBadRequest, err.Error())
		return
	}
	adminAt, err := parseFlexibleDate(p.AdministeredAt)
	if err != nil {
		writeError(w, http.StatusBadRequest, "administered_at: invalid date")
		return
	}

	var nextDue *time.Time
	if p.NextDueAt != "" {
		t, err := parseFlexibleDate(p.NextDueAt)
		if err == nil {
			nextDue = &t
		}
	}

	ctx, cancel := context.WithTimeout(r.Context(), 5*time.Second)
	defer cancel()

	res, err := a.db.ExecContext(ctx,
		`UPDATE vaccinations SET vaccine_name=?, batch_number=?, manufacturer=?, dose=?,
		                         administered_at=?, next_due_at=?, notes=?, staff_id=?,
		                         updated_at=?, version=version+1
		 WHERE id=? AND is_deleted=0`,
		strings.TrimSpace(p.VaccineName), nullableString(p.BatchNumber),
		nullableString(p.Manufacturer), p.Dose, adminAt, nullableTime(nextDue),
		nullableString(p.Notes), nullableString(p.StaffID),
		T(nowUTC()), id,
	)
	if err != nil {
		a.logger.Printf("updateVaccination: %v", err)
		writeError(w, http.StatusInternalServerError, "failed to update vaccination")
		return
	}
	if n, _ := res.RowsAffected(); n == 0 {
		writeError(w, http.StatusNotFound, "vaccination not found")
		return
	}

	updated, _ := a.getVaccinationByID(ctx, id)
	writeJSON(w, http.StatusOK, apiResponse{Status: "ok", Data: updated})
}

func (a *app) deleteVaccination(w http.ResponseWriter, r *http.Request, id string) {
	ctx, cancel := context.WithTimeout(r.Context(), 5*time.Second)
	defer cancel()
	now := T(nowUTC())
	res, err := a.db.ExecContext(ctx,
		`UPDATE vaccinations SET is_deleted=1, deleted_at=?, updated_at=?, version=version+1
		 WHERE id=? AND is_deleted=0`,
		now, now, id)
	if err != nil {
		a.logger.Printf("deleteVaccination: %v", err)
		writeError(w, http.StatusInternalServerError, "failed to delete vaccination")
		return
	}
	if n, _ := res.RowsAffected(); n == 0 {
		writeError(w, http.StatusNotFound, "vaccination not found")
		return
	}
	writeJSON(w, http.StatusOK, apiResponse{Status: "ok", Data: map[string]string{"id": id}})
}

// ─── DB helpers ───────────────────────────────────────────────────────────────

const vaccinationSelectAll = `
SELECT id, pet_id, COALESCE(staff_id,''), vaccine_name,
       COALESCE(batch_number,''), COALESCE(manufacturer,''), dose,
       administered_at, next_due_at, COALESCE(notes,''),
       created_at, updated_at, deleted_at, is_deleted,
       COALESCE(device_id,''), COALESCE(version,1)
FROM vaccinations`

func (a *app) getVaccinationByID(ctx context.Context, id string) (Vaccination, error) {
	row := a.db.QueryRowContext(ctx, vaccinationSelectAll+` WHERE id=?`, id)
	return scanVaccination(row)
}

func scanVaccination(s interface{ Scan(...interface{}) error }) (Vaccination, error) {
	var v Vaccination
	var dose sql.NullFloat64
	var administeredAt, nextDue, createdAt, updatedAt, deletedAt timeScanner
	err := s.Scan(
		&v.ID, &v.PetID, &v.StaffID, &v.VaccineName,
		&v.BatchNumber, &v.Manufacturer, &dose,
		&administeredAt, &nextDue, &v.Notes,
		&createdAt, &updatedAt, &deletedAt,
		&v.IsDeleted, &v.DeviceID, &v.Version,
	)
	if err != nil {
		return Vaccination{}, err
	}
	if dose.Valid { v.Dose = &dose.Float64 }
	if administeredAt.t != nil { v.AdministeredAt = *administeredAt.t }
	if createdAt.t != nil { v.CreatedAt = *createdAt.t }
	if updatedAt.t != nil { v.UpdatedAt = *updatedAt.t }
	v.NextDueAt = nextDue.ptr()
	v.DeletedAt = deletedAt.ptr()
	return v, nil
}
