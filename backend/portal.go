package main

// Портал владельцев: владелец входит по номеру телефона (пока без пароля),
// видит своих питомцев, историю приёмов с назначениями и может заменить
// фото питомца. Больше никаких действий: портал намеренно read-only.
//
// Авторизация отдельная от сотрудников: свои сессии (owner_sessions),
// свой заголовок X-Portal-Token. Владелец не проходит через users/sessions
// и не получает доступа к основному API — /portal/* сам проверяет,
// что запрошенный питомец принадлежит владельцу сессии.

import (
	"context"
	"database/sql"
	"net/http"
	"strings"
	"time"
)

const portalTokenHeader = "X-Portal-Token"
const portalSessionTTL = 90 * 24 * time.Hour

// normalizePhoneDigits приводит телефон к цифрам с кодом страны 7:
// «+7 707 123-45-67», «87071234567», «707 123 45 67» → «77071234567».
func normalizePhoneDigits(s string) string {
	var b strings.Builder
	for _, r := range s {
		if r >= '0' && r <= '9' {
			b.WriteRune(r)
		}
	}
	d := b.String()
	if d == "" {
		return ""
	}
	if d[0] == '8' {
		d = "7" + d[1:]
	}
	if len(d) == 10 { // набрали без кода страны: 7071234567
		d = "7" + d
	}
	return d
}

// ─── Вход ─────────────────────────────────────────────────────────────────────

type portalLoginPayload struct {
	Phone string `json:"phone"`
	Code  string `json:"code"` // одноразовый пароль: от телеграм-бота или выданный администратором
}

type portalOwnerInfo struct {
	ID    string `json:"id"`
	Fio   string `json:"fio"`
	Phone string `json:"phone"`
}

// findOwnerByPhone ищет владельца по нормализованному номеру.
// Телефоны в базе хранятся в разном виде («+7 777 ...», «8777...») —
// сравниваем цифры. Владельцев немного, полный проход дешев.
// Возвращает пустой ID, если не найден.
func (a *app) findOwnerByPhone(ctx context.Context, phoneDigits string) (portalOwnerInfo, error) {
	rows, err := a.db.QueryContext(ctx,
		`SELECT id, fio, COALESCE(phone,'') FROM owners WHERE is_deleted=0`)
	if err != nil {
		return portalOwnerInfo{}, err
	}
	var owner portalOwnerInfo
	for rows.Next() {
		var id, fio, ph string
		if err := rows.Scan(&id, &fio, &ph); err != nil {
			continue
		}
		if normalizePhoneDigits(ph) == phoneDigits {
			owner = portalOwnerInfo{ID: id, Fio: fio, Phone: ph}
			break
		}
	}
	// Закрываем ДО последующих записей: незакрытый курсор держит
	// read-транзакцию, и INSERT ждал бы её до таймаута.
	rows.Close()
	return owner, nil
}

func (a *app) handlePortalLogin(w http.ResponseWriter, r *http.Request) {
	var p portalLoginPayload
	if err := decodeJSON(r, &p); err != nil {
		writeError(w, http.StatusBadRequest, err.Error())
		return
	}
	phone := normalizePhoneDigits(p.Phone)
	if len(phone) < 10 {
		writeError(w, http.StatusBadRequest, "Введите номер телефона полностью")
		return
	}
	code := strings.TrimSpace(p.Code)
	if code == "" {
		writeError(w, http.StatusBadRequest, "Введите пароль из телеграм-бота")
		return
	}

	ctx, cancel := context.WithTimeout(r.Context(), 5*time.Second)
	defer cancel()

	owner, err := a.findOwnerByPhone(ctx, phone)
	if err != nil {
		a.logger.Printf("portalLogin: %v", err)
		writeError(w, http.StatusInternalServerError, "Ошибка сервера")
		return
	}
	if owner.ID == "" {
		writeError(w, http.StatusNotFound, "Номер не найден. Проверьте номер или обратитесь в клинику.")
		return
	}

	// Пароль одноразовый: сверяем и тут же гасим. Просроченные не подходят.
	res, err := a.db.ExecContext(ctx,
		`UPDATE portal_codes SET used_at=?
		 WHERE owner_id=? AND code=? AND used_at IS NULL AND expires_at > ?`,
		T(nowUTC()), owner.ID, code, T(nowUTC()))
	if err != nil {
		a.logger.Printf("portalLogin code: %v", err)
		writeError(w, http.StatusInternalServerError, "Ошибка сервера")
		return
	}
	if n, _ := res.RowsAffected(); n == 0 {
		writeError(w, http.StatusUnauthorized, "Неверный или просроченный пароль. Запросите новый у телеграм-бота или в клинике.")
		return
	}

	token, hash, err := newSessionToken()
	if err != nil {
		writeError(w, http.StatusInternalServerError, "Ошибка сервера")
		return
	}
	expires := nowUTC().Add(portalSessionTTL)
	if _, err := a.db.ExecContext(ctx,
		`INSERT INTO owner_sessions (token_hash, owner_id, expires_at) VALUES (?, ?, ?)`,
		hash, owner.ID, T(expires),
	); err != nil {
		a.logger.Printf("portalLogin session: %v", err)
		writeError(w, http.StatusInternalServerError, "Ошибка сервера")
		return
	}

	writeJSON(w, http.StatusOK, apiResponse{Status: "ok", Data: map[string]interface{}{
		"token": token,
		"owner": owner,
	}})
}

// handlePortalBotInfo — публичная справка для страницы входа: имя бота
// (ссылка «получить пароль») и телефон клиники (кнопка «Позвонить»).
// Токен наружу не отдаём.
func (a *app) handlePortalBotInfo(w http.ResponseWriter, r *http.Request) {
	writeJSON(w, http.StatusOK, apiResponse{Status: "ok", Data: map[string]string{
		"bot":   a.tgBotName(),
		"phone": a.clinicPhone(),
	}})
}

// handlePortalPetVaccinations — прививки питомца: что ставили и когда
// следующая. Самый частый вопрос владельца — данные уже есть в базе.
type portalVaccination struct {
	VaccineName    string `json:"vaccine_name"`
	AdministeredAt string `json:"administered_at"`
	NextDueAt      string `json:"next_due_at,omitempty"`
}

func (a *app) handlePortalPetVaccinations(w http.ResponseWriter, r *http.Request) {
	ownerID := a.requirePortalOwner(w, r)
	if ownerID == "" {
		return
	}
	petID := strings.TrimSpace(r.PathValue("id"))
	if !a.petBelongsToOwner(r.Context(), petID, ownerID) {
		writeError(w, http.StatusNotFound, "Питомец не найден")
		return
	}
	rows, err := a.db.QueryContext(r.Context(),
		`SELECT vaccine_name, COALESCE(administered_at,''), COALESCE(next_due_at,'')
		 FROM vaccinations WHERE pet_id=? AND is_deleted=0
		 ORDER BY administered_at DESC LIMIT 50`, petID)
	if err != nil {
		a.logger.Printf("portalVaccinations: %v", err)
		writeError(w, http.StatusInternalServerError, "Ошибка сервера")
		return
	}
	defer rows.Close()

	vaccs := make([]portalVaccination, 0)
	for rows.Next() {
		var v portalVaccination
		if err := rows.Scan(&v.VaccineName, &v.AdministeredAt, &v.NextDueAt); err != nil {
			continue
		}
		vaccs = append(vaccs, v)
	}
	writeJSON(w, http.StatusOK, apiResponse{Status: "ok", Data: vaccs})
}

// ─── Сессия ───────────────────────────────────────────────────────────────────

// portalOwnerID возвращает owner_id по портальному токену или "" если сессии нет.
func (a *app) portalOwnerID(r *http.Request) string {
	token := strings.TrimSpace(r.Header.Get(portalTokenHeader))
	if token == "" {
		token = strings.TrimSpace(r.URL.Query().Get("pt"))
	}
	if token == "" {
		return ""
	}
	var ownerID string
	var expires timeScanner
	err := a.db.QueryRowContext(r.Context(),
		`SELECT owner_id, expires_at FROM owner_sessions WHERE token_hash=?`,
		tokenHashOf(token),
	).Scan(&ownerID, &expires)
	if err != nil {
		return ""
	}
	if expires.t != nil && expires.t.Before(nowUTC()) {
		return ""
	}
	return ownerID
}

// requirePortalOwner — общая проверка «владелец вошёл»; пишет 401 сама.
func (a *app) requirePortalOwner(w http.ResponseWriter, r *http.Request) string {
	ownerID := a.portalOwnerID(r)
	if ownerID == "" {
		writeError(w, http.StatusUnauthorized, "Требуется вход по номеру телефона")
	}
	return ownerID
}

// ─── Данные владельца ─────────────────────────────────────────────────────────

func (a *app) handlePortalMe(w http.ResponseWriter, r *http.Request) {
	ownerID := a.requirePortalOwner(w, r)
	if ownerID == "" {
		return
	}
	var o portalOwnerInfo
	err := a.db.QueryRowContext(r.Context(),
		`SELECT id, fio, COALESCE(phone,'') FROM owners WHERE id=? AND is_deleted=0`, ownerID,
	).Scan(&o.ID, &o.Fio, &o.Phone)
	if err != nil {
		writeError(w, http.StatusNotFound, "Владелец не найден")
		return
	}
	writeJSON(w, http.StatusOK, apiResponse{Status: "ok", Data: o})
}

type portalPet struct {
	ID        string `json:"id"`
	Name      string `json:"name"`
	Type      string `json:"type"`
	Breed     string `json:"breed,omitempty"`
	Gender    string `json:"gender"`
	BirthDate string `json:"birth_date,omitempty"`
	Status    string `json:"status"`
	Photo     string `json:"photo,omitempty"`
}

func (a *app) handlePortalPets(w http.ResponseWriter, r *http.Request) {
	ownerID := a.requirePortalOwner(w, r)
	if ownerID == "" {
		return
	}
	rows, err := a.db.QueryContext(r.Context(),
		`SELECT id, name, COALESCE(type,''), COALESCE(breed,''), COALESCE(gender,'m'),
		        COALESCE(birth_date,''), COALESCE(status,'active'), COALESCE(photo,'')
		 FROM pets WHERE owner_id=? AND is_deleted=0
		 ORDER BY status='active' DESC, name`, ownerID)
	if err != nil {
		a.logger.Printf("portalPets: %v", err)
		writeError(w, http.StatusInternalServerError, "Ошибка сервера")
		return
	}
	defer rows.Close()

	pets := make([]portalPet, 0)
	for rows.Next() {
		var p portalPet
		if err := rows.Scan(&p.ID, &p.Name, &p.Type, &p.Breed, &p.Gender, &p.BirthDate, &p.Status, &p.Photo); err != nil {
			continue
		}
		pets = append(pets, p)
	}
	writeJSON(w, http.StatusOK, apiResponse{Status: "ok", Data: pets})
}

// petBelongsToOwner — граница доступа портала: любой запрос по питомцу
// сверяется с владельцем сессии.
func (a *app) petBelongsToOwner(ctx context.Context, petID, ownerID string) bool {
	var n int
	err := a.db.QueryRowContext(ctx,
		`SELECT COUNT(*) FROM pets WHERE id=? AND owner_id=? AND is_deleted=0`,
		petID, ownerID).Scan(&n)
	return err == nil && n > 0
}

// portalVisit — приём глазами владельца: назначения и рекомендации,
// без денег и внутренних полей.
type portalVisit struct {
	ID               string `json:"id"`
	Date             string `json:"date"`
	VisitType        string `json:"visit_type"`
	PatientCondition string `json:"patient_condition,omitempty"`
	Diagnosis        string `json:"diagnosis,omitempty"`
	Treatment        string `json:"treatment,omitempty"` // назначения и рекомендации
	NextVisitDate    string `json:"next_visit_date,omitempty"`
	TreatmentDays    int    `json:"treatment_days,omitempty"`
}

func (a *app) handlePortalPetVisits(w http.ResponseWriter, r *http.Request) {
	ownerID := a.requirePortalOwner(w, r)
	if ownerID == "" {
		return
	}
	petID := strings.TrimSpace(r.PathValue("id"))
	if !a.petBelongsToOwner(r.Context(), petID, ownerID) {
		writeError(w, http.StatusNotFound, "Питомец не найден")
		return
	}
	rows, err := a.db.QueryContext(r.Context(),
		`SELECT id, COALESCE(date,''), COALESCE(visit_type,'первичный'),
		        COALESCE(patient_condition,''), COALESCE(diagnosis,''),
		        COALESCE(treatment,''), COALESCE(next_visit_date,''), COALESCE(treatment_days,0)
		 FROM visits WHERE pet_id=? AND is_deleted=0
		 ORDER BY date DESC LIMIT 100`, petID)
	if err != nil {
		a.logger.Printf("portalVisits: %v", err)
		writeError(w, http.StatusInternalServerError, "Ошибка сервера")
		return
	}
	defer rows.Close()

	visits := make([]portalVisit, 0)
	for rows.Next() {
		var v portalVisit
		if err := rows.Scan(&v.ID, &v.Date, &v.VisitType, &v.PatientCondition,
			&v.Diagnosis, &v.Treatment, &v.NextVisitDate, &v.TreatmentDays); err != nil {
			continue
		}
		visits = append(visits, v)
	}
	writeJSON(w, http.StatusOK, apiResponse{Status: "ok", Data: visits})
}

// handlePortalAppointments — ближайшие записи владельца: «завтра в 15:00
// к врачу X». Владелец видит свою запись — меньше забытых визитов.
type portalAppointment struct {
	StartsAt    string `json:"starts_at"`
	DurationMin int    `json:"duration_min"`
	Reason      string `json:"reason,omitempty"`
	PetName     string `json:"pet_name,omitempty"`
	StaffName   string `json:"staff_name,omitempty"`
}

func (a *app) handlePortalAppointments(w http.ResponseWriter, r *http.Request) {
	ownerID := a.requirePortalOwner(w, r)
	if ownerID == "" {
		return
	}
	rows, err := a.db.QueryContext(r.Context(), `
		SELECT ap.starts_at, COALESCE(ap.duration_min,30), COALESCE(ap.reason,''),
		       COALESCE(p.name, ap.pet_name, ''), COALESCE(s.name,'')
		FROM appointments ap
		LEFT JOIN pets p         ON p.id = ap.pet_id
		LEFT JOIN clinic_staff s ON s.id = ap.staff_id
		WHERE ap.owner_id=? AND ap.is_deleted=0 AND ap.status='scheduled' AND ap.starts_at >= ?
		ORDER BY ap.starts_at LIMIT 5`,
		ownerID, T(nowUTC().Add(-2*time.Hour)))
	if err != nil {
		a.logger.Printf("portalAppointments: %v", err)
		writeError(w, http.StatusInternalServerError, "Ошибка сервера")
		return
	}
	defer rows.Close()

	appts := make([]portalAppointment, 0)
	for rows.Next() {
		var ap portalAppointment
		var starts timeScanner
		if err := rows.Scan(&starts, &ap.DurationMin, &ap.Reason, &ap.PetName, &ap.StaffName); err != nil {
			continue
		}
		if starts.t != nil {
			ap.StartsAt = starts.t.Format("2006-01-02T15:04")
		}
		appts = append(appts, ap)
	}
	writeJSON(w, http.StatusOK, apiResponse{Status: "ok", Data: appts})
}

// ─── Фото питомца — единственное действие владельца ──────────────────────────

type portalPhotoPayload struct {
	Photo string `json:"photo"`
}

func (a *app) handlePortalPetPhoto(w http.ResponseWriter, r *http.Request) {
	ownerID := a.requirePortalOwner(w, r)
	if ownerID == "" {
		return
	}
	petID := strings.TrimSpace(r.PathValue("id"))
	if !a.petBelongsToOwner(r.Context(), petID, ownerID) {
		writeError(w, http.StatusNotFound, "Питомец не найден")
		return
	}
	var p portalPhotoPayload
	if err := decodeJSON(r, &p); err != nil {
		writeError(w, http.StatusBadRequest, err.Error())
		return
	}
	photo := strings.TrimSpace(p.Photo)
	// Тот же лимит, что в основном приложении: фото едет внутри записи
	// через синхронизацию, большие картинки раздували бы каждый push.
	if photo != "" && !strings.HasPrefix(photo, "data:image/") {
		writeError(w, http.StatusBadRequest, "Ожидается изображение (data:image/...)")
		return
	}
	if len(photo) > 400_000 {
		writeError(w, http.StatusBadRequest, "Фото слишком большое — сожмите до ~300 КБ")
		return
	}
	res, err := a.db.ExecContext(r.Context(),
		`UPDATE pets SET photo=?, updated_at=?, version=version+1 WHERE id=? AND is_deleted=0`,
		photo, T(nowUTC()), petID)
	if err != nil {
		a.logger.Printf("portalPetPhoto: %v", err)
		writeError(w, http.StatusInternalServerError, "Не удалось сохранить фото")
		return
	}
	if n, _ := res.RowsAffected(); n == 0 {
		writeError(w, http.StatusNotFound, "Питомец не найден")
		return
	}
	writeJSON(w, http.StatusOK, apiResponse{Status: "ok", Data: map[string]string{"id": petID}})
}

// ─── Запись на приём из кабинета владельца ────────────────────────────────────

type portalBookPayload struct {
	PetID  string `json:"pet_id"`
	Date   string `json:"date"` // YYYY-MM-DD
	Time   string `json:"time"` // HH:MM
	Reason string `json:"reason"`
}

// handlePortalBook создаёт запись в расписании от имени владельца.
// Запись обычная (status='scheduled', врач не назначен) — регистратура
// видит её в расписании с пометкой «портал» и при необходимости
// перезванивает, чтобы уточнить время или врача.
func (a *app) handlePortalBook(w http.ResponseWriter, r *http.Request) {
	ownerID := a.requirePortalOwner(w, r)
	if ownerID == "" {
		return
	}
	var p portalBookPayload
	if err := decodeJSON(r, &p); err != nil {
		writeError(w, http.StatusBadRequest, err.Error())
		return
	}

	ctx, cancel := context.WithTimeout(r.Context(), 5*time.Second)
	defer cancel()

	petID := strings.TrimSpace(p.PetID)
	if petID == "" || !a.petBelongsToOwner(ctx, petID, ownerID) {
		writeError(w, http.StatusBadRequest, "Выберите питомца")
		return
	}

	// Дата: сегодня … +60 дней (по времени клиники).
	date := strings.TrimSpace(p.Date)
	if len(date) != 10 || date < astanaDate(0) || date > astanaDate(60) {
		writeError(w, http.StatusBadRequest, "Дата должна быть в ближайшие 60 дней")
		return
	}
	// Время: HH:MM в разумных пределах рабочего дня.
	tm := strings.TrimSpace(p.Time)
	if len(tm) != 5 || tm[2] != ':' || tm < "07:00" || tm > "21:00" {
		writeError(w, http.StatusBadRequest, "Укажите время с 07:00 до 21:00")
		return
	}
	starts, err := parseFlexibleDate(date + "T" + tm)
	if err != nil {
		writeError(w, http.StatusBadRequest, "Неверные дата или время")
		return
	}

	// Защита от спама: не больше 5 активных будущих записей на владельца.
	var active int
	if err := a.db.QueryRowContext(ctx, `
		SELECT COUNT(*) FROM appointments
		WHERE owner_id=? AND is_deleted=0 AND status='scheduled' AND starts_at >= ?`,
		ownerID, T(nowUTC())).Scan(&active); err == nil && active >= 5 {
		writeError(w, http.StatusTooManyRequests,
			"У вас уже 5 активных записей. Чтобы изменить их, позвоните в клинику.")
		return
	}

	var fio, phone string
	_ = a.db.QueryRowContext(ctx,
		`SELECT fio, COALESCE(phone,'') FROM owners WHERE id=?`, ownerID).Scan(&fio, &phone)

	id, err := newUUID()
	if err != nil {
		writeError(w, http.StatusInternalServerError, "Ошибка сервера")
		return
	}
	reason := strings.TrimSpace(p.Reason)
	if len([]rune(reason)) > 200 {
		reason = string([]rune(reason)[:200])
	}
	now := T(nowUTC())
	if _, err := a.db.ExecContext(ctx, `
		INSERT INTO appointments (id, owner_id, pet_id, client_name, client_phone,
		                          starts_at, duration_min, reason, status, notes, source, confirmed,
		                          created_at, updated_at, version)
		VALUES (?, ?, ?, ?, ?, ?, 30, ?, 'scheduled', 'Запись создана владельцем через портал', 'portal', 0, ?, ?, 1)`,
		id, ownerID, petID, nullableString(fio), nullableString(phone),
		T(starts), nullableString(reason), now, now,
	); err != nil {
		a.logger.Printf("portalBook: %v", err)
		writeError(w, http.StatusInternalServerError, "Не удалось создать запись")
		return
	}
	a.logger.Printf("portal booking: owner %s, pet %s, %s %s", ownerID, petID, date, tm)

	writeJSON(w, http.StatusCreated, apiResponse{Status: "ok", Data: map[string]string{
		"id": id, "date": date, "time": tm,
	}})
}

// ─── Выдача пароля администратором ───────────────────────────────────────────

// handleIssuePortalCode выдаёт владельцу пароль для входа на портал по
// требованию администратора: владельцу без телеграма (или с неработающим
// ботом) иначе никак не попасть в кабинет. Пароль тот же одноразовый
// 6-значный код, что шлёт бот, — общий механизм, общая таблица portal_codes,
// прежние невостребованные коды гасятся. Отличается только срок жизни:
// код диктуют голосом, десяти минут на это мало.
//
// Маршрут закрыт requirePortalCodeAccess: админ — всегда, остальные —
// по праву portal_codes из настроек пользователя (выдача пароля — это
// доступ к медкартам чужих животных, право включается осознанно).
func (a *app) handleIssuePortalCode(w http.ResponseWriter, r *http.Request) {
	ownerID := r.PathValue("id")
	if ownerID == "" {
		writeError(w, http.StatusBadRequest, "Не указан владелец")
		return
	}
	ctx := r.Context()

	var fio, phone string
	err := a.db.QueryRowContext(ctx,
		`SELECT fio, COALESCE(phone,'') FROM owners WHERE id=? AND is_deleted=0`,
		ownerID).Scan(&fio, &phone)
	if err == sql.ErrNoRows {
		writeError(w, http.StatusNotFound, "Владелец не найден")
		return
	}
	if err != nil {
		a.logger.Printf("issuePortalCode owner: %v", err)
		writeError(w, http.StatusInternalServerError, "Не удалось найти владельца")
		return
	}
	// Вход на портал идёт по телефону: без номера код бесполезен.
	if normalizePhoneDigits(phone) == "" {
		writeError(w, http.StatusBadRequest,
			"У владельца не указан телефон — вход на портал по номеру, сначала заполните его в карточке")
		return
	}

	code, err := a.issuePortalCode(ctx, ownerID, portalAdminCodeTTL)
	if err != nil {
		a.logger.Printf("issuePortalCode: %v", err)
		writeError(w, http.StatusInternalServerError, "Не удалось создать пароль")
		return
	}

	// Аудит: кто и кому выдал доступ. Сам код в лог не пишем.
	issuer := "?"
	if u := userFromCtx(ctx); u != nil {
		issuer = u.Login
	}
	a.logger.Printf("portal code issued by %s for owner %s", issuer, ownerID)

	writeJSON(w, http.StatusOK, apiResponse{Status: "ok", Data: map[string]interface{}{
		"code":        code,
		"fio":         fio,
		"phone":       phone,
		"expires_at":  nowUTC().Add(portalAdminCodeTTL).Format(time.RFC3339),
		"ttl_minutes": int(portalAdminCodeTTL / time.Minute),
	}})
}
