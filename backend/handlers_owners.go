package main

import (
	"context"
	"database/sql"
	"errors"
	"net/http"
	"strings"
	"time"
)

func (a *app) handleOwners(w http.ResponseWriter, r *http.Request) {
	switch r.Method {
	case http.MethodGet:
		a.listOwners(w, r)
	case http.MethodPost:
		a.createOwner(w, r)
	default:
		writeError(w, http.StatusMethodNotAllowed, "method not allowed")
	}
}

func (a *app) handleOwnerByID(w http.ResponseWriter, r *http.Request) {
	id := strings.TrimSpace(r.PathValue("id"))
	if id == "" {
		writeError(w, http.StatusBadRequest, "id is required")
		return
	}
	switch r.Method {
	case http.MethodGet:
		a.getOwnerDetail(w, r, id)
	case http.MethodPut:
		a.updateOwner(w, r, id)
	case http.MethodDelete:
		a.deleteOwner(w, r, id)
	default:
		writeError(w, http.StatusMethodNotAllowed, "method not allowed")
	}
}

func (a *app) listOwners(w http.ResponseWriter, r *http.Request) {
	ctx, cancel := context.WithTimeout(r.Context(), 5*time.Second)
	defer cancel()

	q := `SELECT id, fio, COALESCE(iin,''), phone, COALESCE(address,''), COALESCE(notes,''),
	             created_at, updated_at, deleted_at, is_deleted, COALESCE(device_id,''), COALESCE(version,1)
	      FROM owners WHERE is_deleted=0`
	args := make([]interface{}, 0)

	if s := strings.TrimSpace(r.URL.Query().Get("search")); s != "" {
		q += ` AND (fio LIKE ? OR phone LIKE ? OR iin LIKE ?)`
		t := "%" + s + "%"
		args = append(args, t, t, t)
	}
	q += ` ORDER BY fio ASC`

	rows, err := a.db.QueryContext(ctx, q, args...)
	if err != nil {
		a.logger.Printf("listOwners: %v", err)
		writeError(w, http.StatusInternalServerError, "failed to load owners")
		return
	}
	defer rows.Close()

	owners := make([]Owner, 0)
	for rows.Next() {
		o, err := scanOwner(rows)
		if err != nil {
			a.logger.Printf("listOwners scan: %v", err)
			writeError(w, http.StatusInternalServerError, "failed to load owners")
			return
		}
		owners = append(owners, o)
	}
	writeJSON(w, http.StatusOK, apiResponse{Status: "ok", Data: owners})
}

func (a *app) getOwnerDetail(w http.ResponseWriter, r *http.Request, id string) {
	ctx, cancel := context.WithTimeout(r.Context(), 5*time.Second)
	defer cancel()
	o, err := a.getOwnerByID(ctx, id)
	if err != nil {
		writeError(w, http.StatusNotFound, "owner not found")
		return
	}
	writeJSON(w, http.StatusOK, apiResponse{Status: "ok", Data: o})
}

func (a *app) createOwner(w http.ResponseWriter, r *http.Request) {
	var p ownerPayload
	if err := decodeJSON(r, &p); err != nil {
		writeError(w, http.StatusBadRequest, err.Error())
		return
	}
	if err := validateOwnerPayload(p); err != nil {
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

	ctx, cancel := context.WithTimeout(r.Context(), 5*time.Second)
	defer cancel()

	now := T(nowUTC())
	if _, err := a.db.ExecContext(ctx,
		`INSERT INTO owners (id, fio, iin, phone, address, notes, created_at, updated_at, version)
		 VALUES (?, ?, ?, ?, ?, ?, ?, ?, 1)`,
		id, strings.TrimSpace(p.FIO), nullableString(p.IIN),
		strings.TrimSpace(p.Phone), nullableString(p.Address), nullableString(p.Notes),
		now, now,
	); err != nil {
		a.logger.Printf("createOwner: %v", err)
		writeError(w, http.StatusInternalServerError, "failed to create owner")
		return
	}

	o, _ := a.getOwnerByID(ctx, id)
	writeJSON(w, http.StatusCreated, apiResponse{Status: "ok", Data: o})
}

func (a *app) updateOwner(w http.ResponseWriter, r *http.Request, id string) {
	var p ownerPayload
	if err := decodeJSON(r, &p); err != nil {
		writeError(w, http.StatusBadRequest, err.Error())
		return
	}
	if err := validateOwnerPayload(p); err != nil {
		writeError(w, http.StatusBadRequest, err.Error())
		return
	}

	ctx, cancel := context.WithTimeout(r.Context(), 5*time.Second)
	defer cancel()

	res, err := a.db.ExecContext(ctx,
		`UPDATE owners SET fio=?, iin=?, phone=?, address=?, notes=?, updated_at=?, version=version+1
		 WHERE id=? AND is_deleted=0`,
		strings.TrimSpace(p.FIO), nullableString(p.IIN),
		strings.TrimSpace(p.Phone), nullableString(p.Address), nullableString(p.Notes),
		T(nowUTC()), id,
	)
	if err != nil {
		a.logger.Printf("updateOwner: %v", err)
		writeError(w, http.StatusInternalServerError, "failed to update owner")
		return
	}
	if n, _ := res.RowsAffected(); n == 0 {
		writeError(w, http.StatusNotFound, "owner not found")
		return
	}

	o, _ := a.getOwnerByID(ctx, id)
	writeJSON(w, http.StatusOK, apiResponse{Status: "ok", Data: o})
}

// deleteOwner — soft delete с каскадом на питомцев и визиты.
func (a *app) deleteOwner(w http.ResponseWriter, r *http.Request, id string) {
	ctx, cancel := context.WithTimeout(r.Context(), 10*time.Second)
	defer cancel()

	tx, err := a.db.BeginTx(ctx, nil)
	if err != nil {
		writeError(w, http.StatusInternalServerError, "failed to begin transaction")
		return
	}
	defer tx.Rollback()

	if err := softDeleteOwnerCascade(ctx, tx, id); err != nil {
		if errors.Is(err, sql.ErrNoRows) {
			writeError(w, http.StatusNotFound, "owner not found")
			return
		}
		a.logger.Printf("deleteOwner: %v", err)
		writeError(w, http.StatusInternalServerError, "failed to delete owner")
		return
	}

	if err := tx.Commit(); err != nil {
		writeError(w, http.StatusInternalServerError, "failed to commit")
		return
	}
	writeJSON(w, http.StatusOK, apiResponse{Status: "ok", Data: map[string]string{"id": id}})
}

// ─── Upsert (используется в sync и full-visit) ────────────────────────────────

func upsertOwner(ctx context.Context, tx *sql.Tx, owner Owner) (Owner, error) {
	owner.FIO = strings.TrimSpace(owner.FIO)
	owner.Phone = strings.TrimSpace(owner.Phone)
	owner.IIN = strings.TrimSpace(owner.IIN)
	owner.Address = strings.TrimSpace(owner.Address)

	existingID, err := resolveOwnerID(ctx, tx, owner)
	if err != nil {
		return Owner{}, err
	}

	now := T(nowUTC())
	if existingID == "" {
		if owner.ID == "" {
			owner.ID, err = newUUID()
			if err != nil {
				return Owner{}, err
			}
		}
		_, err = tx.ExecContext(ctx,
			`INSERT INTO owners (id, fio, iin, phone, address, notes, created_at, updated_at, version)
			 VALUES (?, ?, ?, ?, ?, ?, ?, ?, 1)`,
			owner.ID, owner.FIO, nullableString(owner.IIN),
			owner.Phone, nullableString(owner.Address), nullableString(owner.Notes),
			now, now,
		)
	} else {
		owner.ID = existingID
		_, err = tx.ExecContext(ctx,
			`UPDATE owners SET fio=?, iin=?, phone=?, address=?, notes=?, updated_at=?, version=version+1
			 WHERE id=?`,
			owner.FIO, nullableString(owner.IIN),
			owner.Phone, nullableString(owner.Address), nullableString(owner.Notes),
			now, owner.ID,
		)
	}
	if err != nil {
		return Owner{}, err
	}

	row := tx.QueryRowContext(ctx,
		`SELECT id, fio, COALESCE(iin,''), phone, COALESCE(address,''), COALESCE(notes,''),
		        created_at, updated_at, deleted_at, is_deleted, COALESCE(device_id,''), COALESCE(version,1)
		 FROM owners WHERE id=?`, owner.ID)
	return scanOwner(row)
}

func resolveOwnerID(ctx context.Context, tx *sql.Tx, owner Owner) (string, error) {
	type candidate struct {
		q   string
		arg string
	}
	for _, c := range []candidate{
		{`SELECT id FROM owners WHERE id=? AND is_deleted=0 LIMIT 1`, owner.ID},
		{`SELECT id FROM owners WHERE iin=? AND iin!='' AND is_deleted=0 LIMIT 1`, owner.IIN},
		{`SELECT id FROM owners WHERE phone=? AND is_deleted=0 LIMIT 1`, owner.Phone},
	} {
		if c.arg == "" {
			continue
		}
		var id string
		err := tx.QueryRowContext(ctx, c.q, c.arg).Scan(&id)
		if err == nil {
			return id, nil
		}
		if !errors.Is(err, sql.ErrNoRows) {
			return "", err
		}
	}
	return "", nil
}

func softDeleteOwnerCascade(ctx context.Context, tx *sql.Tx, ownerID string) error {
	now := T(nowUTC())

	// Проверяем существование
	var exists int
	if err := tx.QueryRowContext(ctx,
		`SELECT COUNT(*) FROM owners WHERE id=? AND is_deleted=0`, ownerID).Scan(&exists); err != nil {
		return err
	}
	if exists == 0 {
		return sql.ErrNoRows
	}

	// Каскадно soft-delete питомцев и их записей
	rows, err := tx.QueryContext(ctx, `SELECT id FROM pets WHERE owner_id=? AND is_deleted=0`, ownerID)
	if err != nil {
		return err
	}
	var petIDs []string
	for rows.Next() {
		var pid string
		if err := rows.Scan(&pid); err != nil {
			rows.Close()
			return err
		}
		petIDs = append(petIDs, pid)
	}
	rows.Close()

	for _, pid := range petIDs {
		if err := softDeletePetCascade(ctx, tx, pid); err != nil {
			return err
		}
	}

	_, err = tx.ExecContext(ctx,
		`UPDATE owners SET is_deleted=1, deleted_at=?, updated_at=?, version=version+1 WHERE id=?`,
		now, now, ownerID)
	return err
}

func softDeletePetCascade(ctx context.Context, tx *sql.Tx, petID string) error {
	now := T(nowUTC())

	// Soft delete визитов и позиций
	rows, err := tx.QueryContext(ctx, `SELECT id FROM visits WHERE pet_id=? AND is_deleted=0`, petID)
	if err != nil {
		return err
	}
	var visitIDs []string
	for rows.Next() {
		var vid string
		if err := rows.Scan(&vid); err != nil {
			rows.Close()
			return err
		}
		visitIDs = append(visitIDs, vid)
	}
	rows.Close()

	for _, vid := range visitIDs {
		if err := softDeleteVisitCascade(ctx, tx, vid); err != nil {
			return err
		}
	}

	// Soft delete вакцинаций питомца
	if _, err := tx.ExecContext(ctx,
		`UPDATE vaccinations SET is_deleted=1, deleted_at=?, updated_at=?, version=version+1
		 WHERE pet_id=? AND is_deleted=0`,
		now, now, petID); err != nil {
		return err
	}

	_, err = tx.ExecContext(ctx,
		`UPDATE pets SET is_deleted=1, deleted_at=?, updated_at=?, version=version+1 WHERE id=?`,
		now, now, petID)
	return err
}

func softDeleteVisitCascade(ctx context.Context, tx *sql.Tx, visitID string) error {
	now := T(nowUTC())
	if _, err := tx.ExecContext(ctx,
		`UPDATE visit_items SET is_deleted=1, deleted_at=?, updated_at=?, version=version+1
		 WHERE visit_id=? AND is_deleted=0`,
		now, now, visitID); err != nil {
		return err
	}
	_, err := tx.ExecContext(ctx,
		`UPDATE visits SET is_deleted=1, deleted_at=?, updated_at=?, version=version+1 WHERE id=?`,
		now, now, visitID)
	return err
}

// ─── DB helpers ───────────────────────────────────────────────────────────────

func (a *app) getOwnerByID(ctx context.Context, id string) (Owner, error) {
	row := a.db.QueryRowContext(ctx,
		`SELECT id, fio, COALESCE(iin,''), phone, COALESCE(address,''), COALESCE(notes,''),
		        created_at, updated_at, deleted_at, is_deleted, COALESCE(device_id,''), COALESCE(version,1)
		 FROM owners WHERE id=?`, id)
	return scanOwner(row)
}

func scanOwner(s interface{ Scan(...interface{}) error }) (Owner, error) {
	var o Owner
	var createdAt, updatedAt, deletedAt timeScanner
	err := s.Scan(
		&o.ID, &o.FIO, &o.IIN, &o.Phone, &o.Address, &o.Notes,
		&createdAt, &updatedAt, &deletedAt,
		&o.IsDeleted, &o.DeviceID, &o.Version,
	)
	if err != nil {
		return Owner{}, err
	}
	if createdAt.t != nil {
		o.CreatedAt = *createdAt.t
	}
	if updatedAt.t != nil {
		o.UpdatedAt = *updatedAt.t
	}
	o.DeletedAt = deletedAt.ptr()
	return o, nil
}

func validateOwnerPayload(p ownerPayload) error {
	if strings.TrimSpace(p.FIO) == "" {
		return errors.New("fio is required")
	}
	if strings.TrimSpace(p.Phone) == "" {
		return errors.New("phone is required")
	}
	return nil
}
