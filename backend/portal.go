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
	Code  string `json:"code"` // одноразовый пароль от телеграм-бота
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
		writeError(w, http.StatusUnauthorized, "Неверный или просроченный пароль. Запросите новый у телеграм-бота.")
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

// handlePortalBotInfo — публичная справка для страницы входа: имя бота,
// чтобы показать ссылку «получить пароль». Токен наружу не отдаём.
func (a *app) handlePortalBotInfo(w http.ResponseWriter, r *http.Request) {
	writeJSON(w, http.StatusOK, apiResponse{Status: "ok", Data: map[string]string{
		"bot": a.config.TelegramBotName,
	}})
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
