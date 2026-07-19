package main

import (
	"context"
	"database/sql"
	"errors"
	"net/http"
	"strings"
	"time"
)

func (a *app) handlePets(w http.ResponseWriter, r *http.Request) {
	switch r.Method {
	case http.MethodGet:
		a.listPets(w, r)
	case http.MethodPost:
		a.createPet(w, r)
	default:
		writeError(w, http.StatusMethodNotAllowed, "method not allowed")
	}
}

func (a *app) handlePetByID(w http.ResponseWriter, r *http.Request) {
	id := strings.TrimSpace(r.PathValue("id"))
	if id == "" {
		writeError(w, http.StatusBadRequest, "id is required")
		return
	}
	switch r.Method {
	case http.MethodGet:
		a.getPetDetail(w, r, id)
	case http.MethodPut:
		a.updatePet(w, r, id)
	case http.MethodDelete:
		a.deletePet(w, r, id)
	default:
		writeError(w, http.StatusMethodNotAllowed, "method not allowed")
	}
}

// handleMarkPetDeceased — специальный эндпоинт жизненного цикла питомца.
// PUT /pets/{id}/deceased
func (a *app) handleMarkPetDeceased(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPut {
		writeError(w, http.StatusMethodNotAllowed, "method not allowed")
		return
	}
	id := strings.TrimSpace(r.PathValue("id"))
	if id == "" {
		writeError(w, http.StatusBadRequest, "id is required")
		return
	}

	var p petDeceasedPayload
	if err := decodeJSON(r, &p); err != nil {
		writeError(w, http.StatusBadRequest, err.Error())
		return
	}

	deathDate, err := parseFlexibleDate(p.DeathDate)
	if err != nil {
		writeError(w, http.StatusBadRequest, "death_date: valid date required")
		return
	}

	ctx, cancel := context.WithTimeout(r.Context(), 5*time.Second)
	defer cancel()

	res, err := a.db.ExecContext(ctx,
		`UPDATE pets SET status='deceased', death_date=?, death_reason=?, updated_at=?, version=version+1
		 WHERE id=? AND is_deleted=0`,
		Tp(&deathDate), nullableString(p.DeathReason), T(nowUTC()), id,
	)
	if err != nil {
		a.logger.Printf("markPetDeceased: %v", err)
		writeError(w, http.StatusInternalServerError, "failed to update pet")
		return
	}
	if n, _ := res.RowsAffected(); n == 0 {
		writeError(w, http.StatusNotFound, "pet not found")
		return
	}

	pet, _ := a.getPetByID(ctx, id)
	writeJSON(w, http.StatusOK, apiResponse{Status: "ok", Data: pet})
}

func (a *app) listPets(w http.ResponseWriter, r *http.Request) {
	ctx, cancel := context.WithTimeout(r.Context(), 5*time.Second)
	defer cancel()

	q := `SELECT id, owner_id, name, type, gender, birth_date, age, COALESCE(breed,''),
	             COALESCE(color,''), COALESCE(chip_number,''), chip_date, COALESCE(photo,''), weight, COALESCE(status,'active'),
	             death_date, COALESCE(death_reason,''), COALESCE(notes,''),
	             created_at, updated_at, deleted_at, is_deleted, COALESCE(device_id,''), COALESCE(version,1)
	      FROM pets WHERE is_deleted=0`
	args := make([]interface{}, 0, 4)

	// По умолчанию только активные; ?status=all — все, ?status=deceased — только умершие
	statusFilter := strings.TrimSpace(r.URL.Query().Get("status"))
	switch statusFilter {
	case "all":
		// без фильтра
	case "deceased", "transferred", "lost":
		q += ` AND status=?`
		args = append(args, statusFilter)
	default:
		q += ` AND status='active'`
	}

	if ownerID := strings.TrimSpace(r.URL.Query().Get("owner_id")); ownerID != "" {
		q += ` AND owner_id=?`
		args = append(args, ownerID)
	}
	if t := strings.TrimSpace(r.URL.Query().Get("type")); t != "" {
		q += ` AND type=?`
		args = append(args, t)
	}
	if s := strings.TrimSpace(r.URL.Query().Get("search")); s != "" {
		q += ` AND (name LIKE ? OR breed LIKE ? OR chip_number LIKE ?)`
		t := "%" + s + "%"
		// По чипу ищем и по нормализованному вводу: врач может ввести номер
		// с пробелами со сканера или из паспорта, а в базе он лежит без них.
		chip := "%" + normalizeChip(s) + "%"
		if normalizeChip(s) == "" {
			chip = t
		}
		args = append(args, t, t, chip)
	}
	q += ` ORDER BY name ASC`

	rows, err := a.db.QueryContext(ctx, q, args...)
	if err != nil {
		a.logger.Printf("listPets: %v", err)
		writeError(w, http.StatusInternalServerError, "failed to load pets")
		return
	}
	defer rows.Close()

	pets := make([]Pet, 0)
	for rows.Next() {
		p, err := scanPet(rows)
		if err != nil {
			a.logger.Printf("listPets scan: %v", err)
			writeError(w, http.StatusInternalServerError, "failed to load pets")
			return
		}
		pets = append(pets, p)
	}
	writeJSON(w, http.StatusOK, apiResponse{Status: "ok", Data: pets})
}

func (a *app) getPetDetail(w http.ResponseWriter, r *http.Request, id string) {
	ctx, cancel := context.WithTimeout(r.Context(), 5*time.Second)
	defer cancel()
	p, err := a.getPetByID(ctx, id)
	if err != nil {
		writeError(w, http.StatusNotFound, "pet not found")
		return
	}
	writeJSON(w, http.StatusOK, apiResponse{Status: "ok", Data: p})
}

func (a *app) createPet(w http.ResponseWriter, r *http.Request) {
	var p petPayload
	if err := decodeJSON(r, &p); err != nil {
		writeError(w, http.StatusBadRequest, err.Error())
		return
	}
	pet, err := petFromPayload(p)
	if err != nil {
		writeError(w, http.StatusBadRequest, err.Error())
		return
	}

	ctx, cancel := context.WithTimeout(r.Context(), 5*time.Second)
	defer cancel()

	// Проверяем владельца
	if _, err := a.getOwnerByID(ctx, pet.OwnerID); err != nil {
		writeError(w, http.StatusBadRequest, "owner not found")
		return
	}

	if pet.ID == "" {
		pet.ID, err = newUUID()
		if err != nil {
			writeError(w, http.StatusInternalServerError, "failed to generate id")
			return
		}
	}

	// Дата чипирования: из payload, а если чип есть, но даты нет — сегодня.
	if pet.ChipNumber != "" && pet.ChipDate == nil {
		t := nowUTC()
		pet.ChipDate = &t
	}
	now := T(nowUTC())
	if _, err := a.db.ExecContext(ctx,
		`INSERT INTO pets (id, owner_id, name, type, gender, birth_date, age, breed, color, chip_number, chip_date, photo, weight,
		                   status, notes, created_at, updated_at, version)
		 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'active', ?, ?, ?, 1)`,
		pet.ID, pet.OwnerID, pet.Name, pet.Type, pet.Gender,
		nullableTime(pet.BirthDate), pet.Age, nullableString(pet.Breed),
		nullableString(pet.Color), nullableString(pet.ChipNumber), nullableTime(pet.ChipDate), nullableString(pet.Photo),
		pet.Weight, nullableString(pet.Notes),
		now, now,
	); err != nil {
		if other, dup := a.petByChip(ctx, pet.ChipNumber, pet.ID); dup {
			writeError(w, http.StatusConflict, "Чип "+pet.ChipNumber+" уже закреплён за животным: "+other)
			return
		}
		a.logger.Printf("createPet: %v", err)
		writeError(w, http.StatusInternalServerError, "failed to create pet")
		return
	}

	created, _ := a.getPetByID(ctx, pet.ID)
	writeJSON(w, http.StatusCreated, apiResponse{Status: "ok", Data: created})
}

func (a *app) updatePet(w http.ResponseWriter, r *http.Request, id string) {
	var p petPayload
	if err := decodeJSON(r, &p); err != nil {
		writeError(w, http.StatusBadRequest, err.Error())
		return
	}
	pet, err := petFromPayload(p)
	if err != nil {
		writeError(w, http.StatusBadRequest, err.Error())
		return
	}
	pet.ID = id

	ctx, cancel := context.WithTimeout(r.Context(), 5*time.Second)
	defer cancel()

	if _, err := a.getOwnerByID(ctx, pet.OwnerID); err != nil {
		writeError(w, http.StatusBadRequest, "owner not found")
		return
	}

	// chip_date: явную дату из payload пишем; иначе COALESCE сохраняет старую,
	// а если чип появился впервые — ставим сегодня.
	var chipDateArg interface{} = nullableTime(pet.ChipDate)
	if pet.ChipDate == nil && pet.ChipNumber != "" {
		t := nowUTC()
		chipDateArg = nullableTime(&t)
	}
	res, err := a.db.ExecContext(ctx,
		`UPDATE pets SET owner_id=?, name=?, type=?, gender=?, birth_date=?, age=?,
		                 breed=?, color=?, chip_number=?,
		                 chip_date=CASE WHEN ?='' THEN NULL ELSE COALESCE(chip_date, ?) END,
		                 photo=?, weight=?, notes=?, updated_at=?, version=version+1
		 WHERE id=? AND is_deleted=0`,
		pet.OwnerID, pet.Name, pet.Type, pet.Gender,
		nullableTime(pet.BirthDate), pet.Age,
		nullableString(pet.Breed), nullableString(pet.Color), nullableString(pet.ChipNumber),
		pet.ChipNumber, chipDateArg,
		nullableString(pet.Photo),
		pet.Weight, nullableString(pet.Notes), T(nowUTC()), id,
	)
	if err != nil {
		if other, dup := a.petByChip(ctx, pet.ChipNumber, id); dup {
			writeError(w, http.StatusConflict, "Чип "+pet.ChipNumber+" уже закреплён за животным: "+other)
			return
		}
		a.logger.Printf("updatePet: %v", err)
		writeError(w, http.StatusInternalServerError, "failed to update pet")
		return
	}
	if n, _ := res.RowsAffected(); n == 0 {
		writeError(w, http.StatusNotFound, "pet not found")
		return
	}

	updated, _ := a.getPetByID(ctx, id)
	writeJSON(w, http.StatusOK, apiResponse{Status: "ok", Data: updated})
}

// deletePet — мягкое удаление с каскадом. Медицинская история сохраняется.
func (a *app) deletePet(w http.ResponseWriter, r *http.Request, id string) {
	ctx, cancel := context.WithTimeout(r.Context(), 10*time.Second)
	defer cancel()

	tx, err := a.db.BeginTx(ctx, nil)
	if err != nil {
		writeError(w, http.StatusInternalServerError, "failed to begin transaction")
		return
	}
	defer tx.Rollback()

	// Проверяем существование
	var exists int
	if err := tx.QueryRowContext(ctx,
		`SELECT COUNT(*) FROM pets WHERE id=? AND is_deleted=0`, id).Scan(&exists); err != nil {
		writeError(w, http.StatusInternalServerError, "failed to check pet")
		return
	}
	if exists == 0 {
		writeError(w, http.StatusNotFound, "pet not found")
		return
	}

	if err := softDeletePetCascade(ctx, tx, id); err != nil {
		a.logger.Printf("deletePet: %v", err)
		writeError(w, http.StatusInternalServerError, "failed to delete pet")
		return
	}

	if err := tx.Commit(); err != nil {
		writeError(w, http.StatusInternalServerError, "failed to commit")
		return
	}
	writeJSON(w, http.StatusOK, apiResponse{Status: "ok", Data: map[string]string{"id": id}})
}

// ─── Upsert ───────────────────────────────────────────────────────────────────

func upsertPet(ctx context.Context, tx *sql.Tx, pet Pet) (Pet, error) {
	pet.Name = strings.TrimSpace(pet.Name)
	pet.Type = strings.TrimSpace(pet.Type)
	pet.Gender = normalizeGender(pet.Gender)
	// Нормализуем и здесь: через этот путь идёт синхронизация с планшета,
	// где номер мог быть введён старой версией приложения без нормализации.
	pet.ChipNumber = normalizeChip(pet.ChipNumber)

	existingID, err := resolvePetID(ctx, tx, pet)
	if err != nil {
		return Pet{}, err
	}

	now := T(nowUTC())
	if existingID == "" {
		if pet.ID == "" {
			pet.ID, err = newUUID()
			if err != nil {
				return Pet{}, err
			}
		}
		_, err = tx.ExecContext(ctx,
			`INSERT INTO pets (id, owner_id, name, type, gender, birth_date, age, breed, color, chip_number, photo, weight,
			                   status, notes, created_at, updated_at, version)
			 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'active', ?, ?, ?, 1)`,
			pet.ID, pet.OwnerID, pet.Name, pet.Type, pet.Gender,
			nullableTime(pet.BirthDate), pet.Age,
			nullableString(pet.Breed), nullableString(pet.Color), nullableString(pet.ChipNumber), nullableString(pet.Photo), pet.Weight,
			nullableString(pet.Notes), now, now,
		)
	} else {
		pet.ID = existingID
		_, err = tx.ExecContext(ctx,
			`UPDATE pets SET owner_id=?, name=?, type=?, gender=?, birth_date=?, age=?,
			                 breed=?, color=?, chip_number=?, photo=?, weight=?, notes=?, updated_at=?, version=version+1
			 WHERE id=?`,
			pet.OwnerID, pet.Name, pet.Type, pet.Gender,
			nullableTime(pet.BirthDate), pet.Age,
			nullableString(pet.Breed), nullableString(pet.Color), nullableString(pet.ChipNumber), nullableString(pet.Photo), pet.Weight,
			nullableString(pet.Notes), now, pet.ID,
		)
	}
	if err != nil {
		return Pet{}, err
	}

	row := tx.QueryRowContext(ctx, petSelectByID, pet.ID)
	return scanPetRow(row)
}

func resolvePetID(ctx context.Context, tx *sql.Tx, pet Pet) (string, error) {
	type cand struct {
		q    string
		args []interface{}
		skip bool
	}
	for _, c := range []cand{
		{`SELECT id FROM pets WHERE id=? AND is_deleted=0 LIMIT 1`, []interface{}{pet.ID}, pet.ID == ""},
		{`SELECT id FROM pets WHERE owner_id=? AND name=? AND is_deleted=0 LIMIT 1`,
			[]interface{}{pet.OwnerID, pet.Name}, pet.OwnerID == "" || pet.Name == ""},
	} {
		if c.skip {
			continue
		}
		var id string
		err := tx.QueryRowContext(ctx, c.q, c.args...).Scan(&id)
		if err == nil {
			return id, nil
		}
		if !errors.Is(err, sql.ErrNoRows) {
			return "", err
		}
	}
	return "", nil
}

// ─── DB helpers ───────────────────────────────────────────────────────────────

const petSelectByID = `
SELECT id, owner_id, name, type, gender, birth_date, age, COALESCE(breed,''),
       COALESCE(color,''), COALESCE(chip_number,''), chip_date, COALESCE(photo,''), weight, COALESCE(status,'active'),
       death_date, COALESCE(death_reason,''), COALESCE(notes,''),
       created_at, updated_at, deleted_at, is_deleted, COALESCE(device_id,''), COALESCE(version,1)
FROM pets WHERE id=?`

func (a *app) getPetByID(ctx context.Context, id string) (Pet, error) {
	row := a.db.QueryRowContext(ctx, petSelectByID, id)
	return scanPetRow(row)
}

func scanPet(rows interface{ Scan(...interface{}) error }) (Pet, error) {
	return scanPetRow(rows)
}

func scanPetRow(s interface{ Scan(...interface{}) error }) (Pet, error) {
	var p Pet
	var birthDate, chipDate, deathDate, createdAt, updatedAt, deletedAt timeScanner
	var weight sql.NullFloat64
	var age sql.NullInt64
	err := s.Scan(
		&p.ID, &p.OwnerID, &p.Name, &p.Type, &p.Gender,
		&birthDate, &age, &p.Breed, &p.Color, &p.ChipNumber, &chipDate, &p.Photo, &weight,
		&p.Status, &deathDate, &p.DeathReason, &p.Notes,
		&createdAt, &updatedAt, &deletedAt,
		&p.IsDeleted, &p.DeviceID, &p.Version,
	)
	if err != nil {
		return Pet{}, err
	}
	p.BirthDate = birthDate.ptr()
	p.ChipDate = chipDate.ptr()
	p.DeathDate = deathDate.ptr()
	p.DeletedAt = deletedAt.ptr()
	if createdAt.t != nil { p.CreatedAt = *createdAt.t }
	if updatedAt.t != nil { p.UpdatedAt = *updatedAt.t }
	if age.Valid {
		v := int(age.Int64)
		p.Age = &v
	}
	if weight.Valid {
		p.Weight = &weight.Float64
	}
	return p, nil
}

// ─── Payload helpers ──────────────────────────────────────────────────────────

// petByChip ищет активное животное с таким номером чипа, кроме указанного.
// Нужна, чтобы на нарушение уникального индекса ответить врачу понятным
// «чип занят таким-то», а не сырым UNIQUE constraint failed.
// Второе значение — true, если такое животное нашлось.
func (a *app) petByChip(ctx context.Context, chip, exceptID string) (string, bool) {
	if chip == "" {
		return "", false
	}
	var name string
	err := a.db.QueryRowContext(ctx,
		`SELECT name FROM pets WHERE chip_number = ? AND id <> ? AND is_deleted = 0 LIMIT 1`,
		chip, exceptID).Scan(&name)
	if err != nil {
		return "", false
	}
	return name, true
}

// normalizeChip приводит номер чипа к каноническому виду: только цифры.
// Пробелы, дефисы и точки, которыми номер часто разделяют при вводе, убираются —
// иначе "643 094 100 001 234" и "643094100001234" будут разными номерами
// и уникальность работать не будет.
func normalizeChip(s string) string {
	var b strings.Builder
	for _, r := range s {
		if r >= '0' && r <= '9' {
			b.WriteRune(r)
		}
	}
	return b.String()
}

// validateChip проверяет номер чипа.
//
// Стандарт ISO 11784/11785 — 15 цифр, это основной формат. Но в клинике
// встречаются старые чипы Avid/FDX-A на 9–10 цифр, поэтому диапазон мягкий:
// сохраняем всё от 9 до 15 цифр, а на «не ISO» ругаться не наше дело —
// это предупреждение в интерфейсе, а не отказ.
//
// Пустой номер валиден: чип есть не у каждого животного.
func validateChip(chip string) error {
	if chip == "" {
		return nil
	}
	if len(chip) < 9 || len(chip) > 15 {
		return errors.New("chip_number: номер чипа должен содержать от 9 до 15 цифр")
	}
	return nil
}

func petFromPayload(p petPayload) (Pet, error) {
	pet := Pet{
		ID:         strings.TrimSpace(p.ID),
		OwnerID:    strings.TrimSpace(p.OwnerID),
		Name:       strings.TrimSpace(p.Name),
		Type:       strings.TrimSpace(p.Type),
		Gender:     normalizeGender(p.Gender),
		Age:        p.Age,
		Breed:      strings.TrimSpace(p.Breed),
		Color:      strings.TrimSpace(p.Color),
		ChipNumber: normalizeChip(p.ChipNumber),
		Photo:      strings.TrimSpace(p.Photo),
		Weight:     p.Weight,
		Notes:      strings.TrimSpace(p.Notes),
		Status:     "active",
	}
	if pet.OwnerID == "" {
		return Pet{}, errors.New("owner_id is required")
	}
	if pet.Name == "" {
		return Pet{}, errors.New("name is required")
	}
	if pet.Type == "" {
		return Pet{}, errors.New("type is required")
	}
	if pet.Gender != "m" && pet.Gender != "f" {
		return Pet{}, errors.New("gender must be m or f")
	}
	if err := validateChip(pet.ChipNumber); err != nil {
		return Pet{}, err
	}
	if strings.TrimSpace(p.ChipDate) != "" {
		if cd, err := parseFlexibleDate(strings.TrimSpace(p.ChipDate)); err == nil {
			pet.ChipDate = &cd
		}
	}
	if p.BirthDate != "" {
		t, err := parseFlexibleDate(p.BirthDate)
		if err != nil {
			return Pet{}, errors.New("birth_date: invalid date")
		}
		pet.BirthDate = &t
	}
	return pet, nil
}
