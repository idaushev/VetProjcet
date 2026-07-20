package main

import (
	"context"
	"database/sql"
	"errors"
	"net/http"
	"strings"
	"time"
)

// ─── Visits ───────────────────────────────────────────────────────────────────

func (a *app) handleVisits(w http.ResponseWriter, r *http.Request) {
	switch r.Method {
	case http.MethodGet:
		a.listVisits(w, r)
	case http.MethodPost:
		a.createVisit(w, r)
	default:
		writeError(w, http.StatusMethodNotAllowed, "method not allowed")
	}
}

func (a *app) handleVisitByID(w http.ResponseWriter, r *http.Request) {
	id := strings.TrimSpace(r.PathValue("id"))
	if id == "" {
		writeError(w, http.StatusBadRequest, "id is required")
		return
	}
	switch r.Method {
	case http.MethodGet:
		a.getVisitDetail(w, r, id)
	case http.MethodPut:
		a.updateVisit(w, r, id)
	case http.MethodDelete:
		a.deleteVisit(w, r, id)
	default:
		writeError(w, http.StatusMethodNotAllowed, "method not allowed")
	}
}

func (a *app) listVisits(w http.ResponseWriter, r *http.Request) {
	ctx, cancel := context.WithTimeout(r.Context(), 5*time.Second)
	defer cancel()

	q := visitSelectAll + ` WHERE v.is_deleted=0`
	args := make([]interface{}, 0, 4)

	if petID := strings.TrimSpace(r.URL.Query().Get("pet_id")); petID != "" {
		q += ` AND v.pet_id=?`
		args = append(args, petID)
	}
	if df := strings.TrimSpace(r.URL.Query().Get("date_from")); df != "" {
		q += ` AND v.date>=?`
		args = append(args, df)
	}
	if dt := strings.TrimSpace(r.URL.Query().Get("date_to")); dt != "" {
		q += ` AND v.date<=?`
		args = append(args, dt)
	}
	if s := strings.TrimSpace(r.URL.Query().Get("search")); s != "" {
		q += ` AND (v.diagnosis LIKE ? OR v.anamnesis LIKE ? OR v.notes LIKE ?)`
		t := "%" + s + "%"
		args = append(args, t, t, t)
	}
	q += ` ORDER BY v.date DESC, v.created_at DESC`

	rows, err := a.db.QueryContext(ctx, q, args...)
	if err != nil {
		a.logger.Printf("listVisits: %v", err)
		writeError(w, http.StatusInternalServerError, "failed to load visits")
		return
	}
	defer rows.Close()

	visits := make([]Visit, 0)
	for rows.Next() {
		v, err := scanVisit(rows)
		if err != nil {
			a.logger.Printf("listVisits scan: %v", err)
			writeError(w, http.StatusInternalServerError, "failed to load visits")
			return
		}
		visits = append(visits, v)
	}
	writeJSON(w, http.StatusOK, apiResponse{Status: "ok", Data: visits})
}

func (a *app) getVisitDetail(w http.ResponseWriter, r *http.Request, id string) {
	ctx, cancel := context.WithTimeout(r.Context(), 5*time.Second)
	defer cancel()

	v, err := a.getVisitByID(ctx, id)
	if err != nil {
		writeError(w, http.StatusNotFound, "visit not found")
		return
	}

	rows, err := a.db.QueryContext(ctx,
		visitItemSelectByVisit+` AND vi.is_deleted=0 ORDER BY vi.created_at ASC`, id)
	if err != nil {
		a.logger.Printf("getVisitDetail items: %v", err)
		writeError(w, http.StatusInternalServerError, "failed to load visit items")
		return
	}
	defer rows.Close()

	items := make([]VisitItem, 0)
	for rows.Next() {
		vi, err := scanVisitItem(rows)
		if err != nil {
			a.logger.Printf("getVisitDetail scan item: %v", err)
			writeError(w, http.StatusInternalServerError, "failed to load visit items")
			return
		}
		items = append(items, vi)
	}

	writeJSON(w, http.StatusOK, apiResponse{Status: "ok", Data: visitDetailResponse{Visit: v, Items: items}})
}

func (a *app) createVisit(w http.ResponseWriter, r *http.Request) {
	var p createVisitPayload
	if err := decodeJSON(r, &p); err != nil {
		writeError(w, http.StatusBadRequest, err.Error())
		return
	}
	v, err := visitFromPayload(p)
	if err != nil {
		writeError(w, http.StatusBadRequest, err.Error())
		return
	}

	ctx, cancel := context.WithTimeout(r.Context(), 5*time.Second)
	defer cancel()

	if _, err := a.getPetByID(ctx, v.PetID); err != nil {
		writeError(w, http.StatusBadRequest, "pet not found")
		return
	}

	if v.ID == "" {
		v.ID, err = newUUID()
		if err != nil {
			writeError(w, http.StatusInternalServerError, "failed to generate id")
			return
		}
	}

	now := T(nowUTC())
	visitType := v.VisitType
	if visitType == "" {
		visitType = "первичный"
	}
	days, until := resolveTreatment(intOrZero(p.TreatmentDays), v.Date)
	if _, err := a.db.ExecContext(ctx,
		`INSERT INTO visits (id, pet_id, staff_id, visit_type, animal_weight, date, next_visit_date,
		                     treatment_days, treatment_until,
		                     patient_condition, anamnesis, diagnosis, treatment, notes,
		                     total_amount, discount, discount_reason, payment_card, change_log, created_at, updated_at, version)
		 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1)`,
		v.ID, v.PetID, nullableString(v.StaffID), visitType, v.AnimalWeight, T(v.Date), Tp(v.NextVisitDate),
		days, Tp(until),
		nullableString(v.PatientCondition), nullableString(v.Anamnesis),
		nullableString(v.Diagnosis), nullableString(v.Treatment),
		nullableString(v.Notes), v.TotalAmount, v.Discount, nullableString(v.DiscountReason), v.PaymentCard, v.ChangeLog, now, now,
	); err != nil {
		a.logger.Printf("createVisit: %v", err)
		writeError(w, http.StatusInternalServerError, "failed to create visit")
		return
	}

	created, _ := a.getVisitByID(ctx, v.ID)
	writeJSON(w, http.StatusCreated, apiResponse{Status: "ok", Data: created})
}

func (a *app) updateVisit(w http.ResponseWriter, r *http.Request, id string) {
	var p createVisitPayload
	if err := decodeJSON(r, &p); err != nil {
		writeError(w, http.StatusBadRequest, err.Error())
		return
	}
	v, err := visitFromPayload(p)
	if err != nil {
		writeError(w, http.StatusBadRequest, err.Error())
		return
	}
	v.ID = id

	ctx, cancel := context.WithTimeout(r.Context(), 5*time.Second)
	defer cancel()

	if _, err := a.getPetByID(ctx, v.PetID); err != nil {
		writeError(w, http.StatusBadRequest, "pet not found")
		return
	}

	visitType := v.VisitType
	if visitType == "" {
		visitType = "первичный"
	}
	// Поле не прислали (старый клиент) — берём текущий курс из базы, чтобы
	// редактирование приёма со старого планшета его не стёрло.
	treatDays := p.TreatmentDays
	if treatDays == nil {
		var cur int
		if err := a.db.QueryRowContext(ctx, `SELECT COALESCE(treatment_days,0) FROM visits WHERE id=?`, id).Scan(&cur); err == nil {
			treatDays = &cur
		}
	}
	days, until := resolveTreatment(intOrZero(treatDays), v.Date)
	res, err := a.db.ExecContext(ctx,
		`UPDATE visits SET pet_id=?, staff_id=?, visit_type=?, animal_weight=?,
		                   date=?, next_visit_date=?, treatment_days=?, treatment_until=?,
		                   patient_condition=?, anamnesis=?, diagnosis=?, treatment=?,
		                   notes=?, total_amount=?, discount=?, discount_reason=?, payment_card=?, change_log=?, updated_at=?, version=version+1
		 WHERE id=? AND is_deleted=0`,
		v.PetID, nullableString(v.StaffID), visitType, v.AnimalWeight,
		T(v.Date), Tp(v.NextVisitDate), days, Tp(until),
		nullableString(v.PatientCondition), nullableString(v.Anamnesis),
		nullableString(v.Diagnosis), nullableString(v.Treatment),
		nullableString(v.Notes), v.TotalAmount, v.Discount, nullableString(v.DiscountReason), v.PaymentCard, v.ChangeLog, T(nowUTC()), id,
	)
	if err != nil {
		a.logger.Printf("updateVisit: %v", err)
		writeError(w, http.StatusInternalServerError, "failed to update visit")
		return
	}
	if n, _ := res.RowsAffected(); n == 0 {
		writeError(w, http.StatusNotFound, "visit not found")
		return
	}

	updated, _ := a.getVisitByID(ctx, id)
	writeJSON(w, http.StatusOK, apiResponse{Status: "ok", Data: updated})
}

func (a *app) deleteVisit(w http.ResponseWriter, r *http.Request, id string) {
	ctx, cancel := context.WithTimeout(r.Context(), 10*time.Second)
	defer cancel()

	tx, err := a.db.BeginTx(ctx, nil)
	if err != nil {
		writeError(w, http.StatusInternalServerError, "failed to begin transaction")
		return
	}
	defer tx.Rollback()

	var exists int
	if err := tx.QueryRowContext(ctx,
		`SELECT COUNT(*) FROM visits WHERE id=? AND is_deleted=0`, id).Scan(&exists); err != nil {
		writeError(w, http.StatusInternalServerError, "failed to check visit")
		return
	}
	if exists == 0 {
		writeError(w, http.StatusNotFound, "visit not found")
		return
	}

	if err := softDeleteVisitCascade(ctx, tx, id); err != nil {
		a.logger.Printf("deleteVisit: %v", err)
		writeError(w, http.StatusInternalServerError, "failed to delete visit")
		return
	}

	if err := tx.Commit(); err != nil {
		writeError(w, http.StatusInternalServerError, "failed to commit")
		return
	}
	writeJSON(w, http.StatusOK, apiResponse{Status: "ok", Data: map[string]string{"id": id}})
}

// handleCreateFullVisit — атомарное создание: владелец + питомец + визит + позиции.
func (a *app) handleCreateFullVisit(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		writeError(w, http.StatusMethodNotAllowed, "method not allowed")
		return
	}

	var p visitFullPayload
	if err := decodeJSON(r, &p); err != nil {
		writeError(w, http.StatusBadRequest, err.Error())
		return
	}
	if err := validateFullVisitPayload(p); err != nil {
		writeError(w, http.StatusBadRequest, err.Error())
		return
	}

	ctx, cancel := context.WithTimeout(r.Context(), 15*time.Second)
	defer cancel()

	tx, err := a.db.BeginTx(ctx, nil)
	if err != nil {
		writeError(w, http.StatusInternalServerError, "failed to begin transaction")
		return
	}
	defer tx.Rollback()

	owner, err := upsertOwner(ctx, tx, p.Owner)
	if err != nil {
		a.logger.Printf("fullVisit upsertOwner: %v", err)
		writeError(w, http.StatusInternalServerError, "failed to save owner")
		return
	}

	p.Pet.OwnerID = owner.ID
	pet, err := upsertPet(ctx, tx, p.Pet)
	if err != nil {
		a.logger.Printf("fullVisit upsertPet: %v", err)
		writeError(w, http.StatusInternalServerError, "failed to save pet")
		return
	}

	visitDate, _ := parseVisitDate(p.Visit.Date)
	patCond, _ := normalizeAndValidatePatientCondition(p.Visit.PatientCondition)

	visitID, err := newUUID()
	if err != nil {
		writeError(w, http.StatusInternalServerError, "failed to generate visit id")
		return
	}

	var totalAmount float64
	visitItems := make([]VisitItem, 0, len(p.Items))
	for _, item := range p.Items {
		total := roundMoney(item.Quantity * item.Price)
		totalAmount += total
		viID, err := newUUID()
		if err != nil {
			writeError(w, http.StatusInternalServerError, "failed to generate item id")
			return
		}
		visitItems = append(visitItems, VisitItem{
			ID:       viID,
			VisitID:  visitID,
			ItemID:   item.ItemID,
			Name:     strings.TrimSpace(item.Name),
			Type:     normalizeItemType(item.Type),
			Quantity: item.Quantity,
			Price:    item.Price,
			Total:    total,
		})
	}
	// Скидка фиксированной суммой уменьшает итог, но не ниже нуля.
	discount := roundMoney(p.Visit.Discount)
	if discount < 0 {
		discount = 0
	}
	if discount > totalAmount {
		discount = totalAmount
	}
	totalAmount = roundMoney(totalAmount - discount)

	visitType := strings.TrimSpace(p.Visit.VisitType)
	if visitType == "" {
		visitType = "первичный"
	}

	var nextVisitDate *time.Time
	if strings.TrimSpace(p.Visit.NextVisitDate) != "" {
		if nd, err2 := parseFlexibleDate(strings.TrimSpace(p.Visit.NextVisitDate)); err2 == nil {
			nextVisitDate = &nd
		}
	}

	now := T(nowUTC())
	visit := Visit{
		ID:               visitID,
		PetID:            pet.ID,
		StaffID:          strings.TrimSpace(p.Visit.StaffID),
		VisitType:        visitType,
		AnimalWeight:     p.Visit.AnimalWeight,
		Date:             visitDate,
		NextVisitDate:    nextVisitDate,
		PatientCondition: patCond,
		Anamnesis:        strings.TrimSpace(p.Visit.Anamnesis),
		Diagnosis:        strings.TrimSpace(p.Visit.Diagnosis),
		Treatment:        strings.TrimSpace(p.Visit.Treatment),
		Notes:            strings.TrimSpace(p.Visit.Notes),
		TotalAmount:      totalAmount,
		Discount:         discount,
		DiscountReason:   strings.TrimSpace(p.Visit.DiscountReason),
	}

	// Курс и оплату клиент присылает и в «полном» приёме — терять их нельзя.
	// Даты — через T()/Tp(): голый time.Time драйвер записал бы Go-форматом
	// ("2026-07-17 12:00:00 +0000 UTC"), который не разбирает SQLite.
	days, until := resolveTreatment(p.Visit.TreatmentDays, visit.Date)
	if _, err := tx.ExecContext(ctx,
		`INSERT INTO visits (id, pet_id, staff_id, visit_type, animal_weight, date, next_visit_date,
		                     treatment_days, treatment_until, discount, discount_reason, payment_card,
		                     patient_condition, anamnesis, diagnosis, treatment, notes,
		                     total_amount, created_at, updated_at, version)
		 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1)`,
		visit.ID, visit.PetID, nullableString(visit.StaffID), visitType, visit.AnimalWeight, T(visit.Date), Tp(nextVisitDate),
		days, Tp(until), visit.Discount, nullableString(visit.DiscountReason), p.Visit.PaymentCard,
		nullableString(visit.PatientCondition), nullableString(visit.Anamnesis),
		nullableString(visit.Diagnosis), nullableString(visit.Treatment),
		nullableString(visit.Notes), visit.TotalAmount, now, now,
	); err != nil {
		a.logger.Printf("fullVisit insert visit: %v", err)
		writeError(w, http.StatusInternalServerError, "failed to create visit")
		return
	}

	for _, vi := range visitItems {
		if _, err := tx.ExecContext(ctx,
			`INSERT INTO visit_items (id, visit_id, item_id, name, type, quantity, price, total,
			                          created_at, updated_at, version)
			 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1)`,
			vi.ID, vi.VisitID, vi.ItemID, nullableString(vi.Name),
			vi.Type, vi.Quantity, vi.Price, vi.Total, now, now,
		); err != nil {
			a.logger.Printf("fullVisit insert item: %v", err)
			writeError(w, http.StatusInternalServerError, "failed to create visit items")
			return
		}
	}

	if err := tx.Commit(); err != nil {
		writeError(w, http.StatusInternalServerError, "failed to commit")
		return
	}

	writeJSON(w, http.StatusCreated, apiResponse{Status: "ok", Data: visitFullResponse{
		Owner:      owner,
		Pet:        pet,
		Visit:      visit,
		VisitItems: visitItems,
	}})
}

// ─── Visit Items ──────────────────────────────────────────────────────────────

func (a *app) handleVisitItems(w http.ResponseWriter, r *http.Request) {
	switch r.Method {
	case http.MethodGet:
		a.listVisitItems(w, r)
	case http.MethodPost:
		a.createVisitItem(w, r)
	default:
		writeError(w, http.StatusMethodNotAllowed, "method not allowed")
	}
}

func (a *app) handleVisitItemByID(w http.ResponseWriter, r *http.Request) {
	id := strings.TrimSpace(r.PathValue("id"))
	if id == "" {
		writeError(w, http.StatusBadRequest, "id is required")
		return
	}
	switch r.Method {
	case http.MethodDelete:
		a.deleteVisitItem(w, r, id)
	default:
		writeError(w, http.StatusMethodNotAllowed, "method not allowed")
	}
}

func (a *app) listVisitItems(w http.ResponseWriter, r *http.Request) {
	ctx, cancel := context.WithTimeout(r.Context(), 5*time.Second)
	defer cancel()

	q := visitItemSelectAll + ` WHERE vi.is_deleted=0`
	args := make([]interface{}, 0)

	if vid := strings.TrimSpace(r.URL.Query().Get("visit_id")); vid != "" {
		q += ` AND vi.visit_id=?`
		args = append(args, vid)
	}
	q += ` ORDER BY vi.created_at ASC`

	rows, err := a.db.QueryContext(ctx, q, args...)
	if err != nil {
		a.logger.Printf("listVisitItems: %v", err)
		writeError(w, http.StatusInternalServerError, "failed to load visit items")
		return
	}
	defer rows.Close()

	items := make([]VisitItem, 0)
	for rows.Next() {
		vi, err := scanVisitItem(rows)
		if err != nil {
			writeError(w, http.StatusInternalServerError, "failed to load visit items")
			return
		}
		items = append(items, vi)
	}
	writeJSON(w, http.StatusOK, apiResponse{Status: "ok", Data: items})
}

func (a *app) createVisitItem(w http.ResponseWriter, r *http.Request) {
	var p createVisitItemPayload
	if err := decodeJSON(r, &p); err != nil {
		writeError(w, http.StatusBadRequest, err.Error())
		return
	}
	vi, err := visitItemFromPayload(p)
	if err != nil {
		writeError(w, http.StatusBadRequest, err.Error())
		return
	}

	ctx, cancel := context.WithTimeout(r.Context(), 5*time.Second)
	defer cancel()

	if _, err := a.getVisitByID(ctx, vi.VisitID); err != nil {
		writeError(w, http.StatusBadRequest, "visit not found")
		return
	}

	if vi.ID == "" {
		vi.ID, err = newUUID()
		if err != nil {
			writeError(w, http.StatusInternalServerError, "failed to generate id")
			return
		}
	}

	now := T(nowUTC())
	if _, err := a.db.ExecContext(ctx,
		`INSERT INTO visit_items (id, visit_id, item_id, name, type, quantity, price, total,
		                          created_at, updated_at, version)
		 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1)`,
		vi.ID, vi.VisitID, vi.ItemID, nullableString(vi.Name),
		vi.Type, vi.Quantity, vi.Price, vi.Total, now, now,
	); err != nil {
		a.logger.Printf("createVisitItem: %v", err)
		writeError(w, http.StatusInternalServerError, "failed to create visit item")
		return
	}

	created, _ := a.getVisitItemByID(ctx, vi.ID)
	writeJSON(w, http.StatusCreated, apiResponse{Status: "ok", Data: created})
}

func (a *app) deleteVisitItem(w http.ResponseWriter, r *http.Request, id string) {
	ctx, cancel := context.WithTimeout(r.Context(), 5*time.Second)
	defer cancel()

	now := T(nowUTC())
	res, err := a.db.ExecContext(ctx,
		`UPDATE visit_items SET is_deleted=1, deleted_at=?, updated_at=?, version=version+1
		 WHERE id=? AND is_deleted=0`,
		now, now, id,
	)
	if err != nil {
		a.logger.Printf("deleteVisitItem: %v", err)
		writeError(w, http.StatusInternalServerError, "failed to delete visit item")
		return
	}
	if n, _ := res.RowsAffected(); n == 0 {
		writeError(w, http.StatusNotFound, "visit item not found")
		return
	}
	writeJSON(w, http.StatusOK, apiResponse{Status: "ok", Data: map[string]string{"id": id}})
}

// ─── DB helpers ───────────────────────────────────────────────────────────────

// resolveTreatment считает срок курса лечения по его длительности.
//
// Дни ≤ 0 означают «курс не назначен»: обнуляем и дату, иначе в базе остался бы
// висеть срок от прошлой версии приёма, и животное числилось бы активным вечно.
//
// Отсчёт от даты приёма, а не от «сегодня»: приём могут завести задним числом,
// и курс должен считаться от того дня, когда лечение реально началось.
// Курс в 1 день = лечение идёт в день приёма, поэтому days-1.
func resolveTreatment(days int, visitDate time.Time) (int, *time.Time) {
	if days <= 0 {
		return 0, nil
	}
	if days > maxTreatmentDays {
		days = maxTreatmentDays
	}
	until := visitDate.AddDate(0, 0, days-1)
	return days, &until
}

// intOrZero разворачивает необязательное число: nil трактуется как 0.
func intOrZero(p *int) int {
	if p == nil {
		return 0
	}
	return *p
}

// Верхняя граница курса — защита от опечатки вроде 3650 дней,
// после которой животное останется «активным» на десять лет.
const maxTreatmentDays = 365

const visitSelectAll = `
SELECT v.id, v.pet_id, COALESCE(v.staff_id,''), COALESCE(v.visit_type,'первичный'), v.animal_weight,
       v.date, v.next_visit_date, COALESCE(v.treatment_days,0), v.treatment_until,
       COALESCE(v.patient_condition,''), COALESCE(v.anamnesis,''),
       COALESCE(v.diagnosis,''), COALESCE(v.treatment,''), COALESCE(v.notes,''),
       v.total_amount, COALESCE(v.discount,0), COALESCE(v.discount_reason,''), COALESCE(v.payment_card,0), COALESCE(v.change_log,''), v.created_at, v.updated_at, v.deleted_at,
       v.is_deleted, COALESCE(v.device_id,''), COALESCE(v.version,1)
FROM visits v`

const visitItemSelectAll = `
SELECT vi.id, vi.visit_id, vi.item_id, COALESCE(vi.name,''), vi.type,
       vi.quantity, vi.price, vi.total, vi.created_at, vi.updated_at,
       vi.deleted_at, vi.is_deleted, COALESCE(vi.device_id,''), COALESCE(vi.version,1)
FROM visit_items vi`

const visitItemSelectByVisit = visitItemSelectAll + ` WHERE vi.visit_id=?`

func (a *app) getVisitByID(ctx context.Context, id string) (Visit, error) {
	row := a.db.QueryRowContext(ctx, visitSelectAll+` WHERE v.id=?`, id)
	return scanVisit(row)
}

func (a *app) getVisitItemByID(ctx context.Context, id string) (VisitItem, error) {
	row := a.db.QueryRowContext(ctx, visitItemSelectAll+` WHERE vi.id=?`, id)
	return scanVisitItem(row)
}

func scanVisit(s interface{ Scan(...interface{}) error }) (Visit, error) {
	var v Visit
	var createdAt, updatedAt, deletedAt timeScanner
	var visitDate, nextVisitDate, treatmentUntil timeScanner
	var animalWeight sql.NullFloat64
	err := s.Scan(
		&v.ID, &v.PetID, &v.StaffID, &v.VisitType, &animalWeight,
		&visitDate, &nextVisitDate, &v.TreatmentDays, &treatmentUntil,
		&v.PatientCondition, &v.Anamnesis, &v.Diagnosis, &v.Treatment, &v.Notes,
		&v.TotalAmount, &v.Discount, &v.DiscountReason, &v.PaymentCard, &v.ChangeLog, &createdAt, &updatedAt, &deletedAt,
		&v.IsDeleted, &v.DeviceID, &v.Version,
	)
	if err != nil {
		return Visit{}, err
	}
	if visitDate.t != nil     { v.Date = *visitDate.t }
	if nextVisitDate.t != nil { v.NextVisitDate = nextVisitDate.t }
	v.TreatmentUntil = treatmentUntil.ptr()
	if createdAt.t != nil     { v.CreatedAt = *createdAt.t }
	if updatedAt.t != nil     { v.UpdatedAt = *updatedAt.t }
	v.DeletedAt = deletedAt.ptr()
	if animalWeight.Valid {
		v.AnimalWeight = &animalWeight.Float64
	}
	return v, nil
}

func scanVisitItem(s interface{ Scan(...interface{}) error }) (VisitItem, error) {
	var vi VisitItem
	var itemID sql.NullString
	var createdAt, updatedAt, deletedAt timeScanner
	err := s.Scan(
		&vi.ID, &vi.VisitID, &itemID, &vi.Name, &vi.Type,
		&vi.Quantity, &vi.Price, &vi.Total,
		&createdAt, &updatedAt, &deletedAt,
		&vi.IsDeleted, &vi.DeviceID, &vi.Version,
	)
	if err != nil {
		return VisitItem{}, err
	}
	if itemID.Valid {
		s := itemID.String
		vi.ItemID = &s
	}
	if createdAt.t != nil { vi.CreatedAt = *createdAt.t }
	if updatedAt.t != nil { vi.UpdatedAt = *updatedAt.t }
	vi.DeletedAt = deletedAt.ptr()
	return vi, nil
}

// ─── Payload helpers ──────────────────────────────────────────────────────────

func visitFromPayload(p createVisitPayload) (Visit, error) {
	d, err := parseVisitDate(p.Date)
	if err != nil {
		return Visit{}, err
	}
	cond, err := normalizeAndValidatePatientCondition(p.PatientCondition)
	if err != nil {
		return Visit{}, err
	}
	if strings.TrimSpace(p.PetID) == "" {
		return Visit{}, errors.New("pet_id is required")
	}
	if p.TotalAmount < 0 {
		return Visit{}, errors.New("total_amount must be >= 0")
	}
	if p.Discount < 0 {
		return Visit{}, errors.New("discount must be >= 0")
	}
	visitType := strings.TrimSpace(p.VisitType)
	if visitType == "" {
		visitType = "первичный"
	}
	v := Visit{
		ID:               strings.TrimSpace(p.ID),
		PetID:            strings.TrimSpace(p.PetID),
		StaffID:          strings.TrimSpace(p.StaffID),
		VisitType:        visitType,
		AnimalWeight:     p.AnimalWeight,
		Date:             d,
		PatientCondition: cond,
		Anamnesis:        strings.TrimSpace(p.Anamnesis),
		Diagnosis:        strings.TrimSpace(p.Diagnosis),
		Treatment:        strings.TrimSpace(p.Treatment),
		Notes:            strings.TrimSpace(p.Notes),
		TotalAmount:      roundMoney(p.TotalAmount),
		Discount:         roundMoney(p.Discount),
		DiscountReason:   strings.TrimSpace(p.DiscountReason),
		PaymentCard:      p.PaymentCard,
		ChangeLog:        strings.TrimSpace(p.ChangeLog),
	}
	if strings.TrimSpace(p.NextVisitDate) != "" {
		if nd, err := parseFlexibleDate(strings.TrimSpace(p.NextVisitDate)); err == nil {
			v.NextVisitDate = &nd
		}
	}
	return v, nil
}

func visitItemFromPayload(p createVisitItemPayload) (VisitItem, error) {
	t := normalizeItemType(p.Type)
	if strings.TrimSpace(p.VisitID) == "" {
		return VisitItem{}, errors.New("visit_id is required")
	}
	if t != "service" && t != "drug" {
		return VisitItem{}, errors.New("type must be service or drug")
	}
	if p.Quantity <= 0 {
		return VisitItem{}, errors.New("quantity must be > 0")
	}
	if p.Price < 0 {
		return VisitItem{}, errors.New("price must be >= 0")
	}
	if p.ItemID == nil && strings.TrimSpace(p.Name) == "" {
		return VisitItem{}, errors.New("name required when item_id is empty")
	}
	total := p.Total
	if total == 0 {
		total = p.Quantity * p.Price
	}
	return VisitItem{
		ID:       strings.TrimSpace(p.ID),
		VisitID:  strings.TrimSpace(p.VisitID),
		ItemID:   p.ItemID,
		Name:     strings.TrimSpace(p.Name),
		Type:     t,
		Quantity: p.Quantity,
		Price:    p.Price,
		Total:    roundMoney(total),
	}, nil
}

func validateFullVisitPayload(p visitFullPayload) error {
	if strings.TrimSpace(p.Owner.FIO) == "" {
		return errors.New("owner.fio is required")
	}
	if strings.TrimSpace(p.Owner.Phone) == "" {
		return errors.New("owner.phone is required")
	}
	if strings.TrimSpace(p.Pet.Name) == "" {
		return errors.New("pet.name is required")
	}
	if _, err := parseVisitDate(p.Visit.Date); err != nil {
		return err
	}
	return nil
}
