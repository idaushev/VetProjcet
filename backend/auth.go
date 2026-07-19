package main

// Авторизация и роли.
//
// Пользователь — учётная запись для входа, НЕ сотрудник клиники: админ или
// регистратор могут не быть врачами. Связь с врачом — необязательный staff_id.
//
// Роли:
//   admin     — всё, включая админку пользователей, правку каталога и персонала
//   doctor    — приёмы, пациенты, отчёты
//   reception — регистратура: владельцы, животные, вакцинации
//
// Офлайн: сервер выдаёт токен на 90 дней; планшет хранит его и кэширует
// верификатор пароля локально (см. frontend/js/auth.js). Вход без сети
// проверяется на устройстве, токен предъявляется при синхронизации.
//
// Пароли — PBKDF2-SHA256 на стандартной библиотеке: новых зависимостей
// проект не берёт (PROJECT_RULES).

import (
	"context"
	"crypto/hmac"
	"crypto/rand"
	"crypto/sha256"
	"crypto/subtle"
	"encoding/binary"
	"encoding/hex"
	"encoding/json"
	"errors"
	"net/http"
	"os"
	"path/filepath"
	"strings"
	"time"
)

const (
	pbkdf2Iterations = 150_000
	sessionTTL       = 90 * 24 * time.Hour
	authHeader       = "X-Auth-Token"
)

// ─── PBKDF2 (RFC 2898) на stdlib ─────────────────────────────────────────────

func pbkdf2SHA256(password, salt []byte, iterations, keyLen int) []byte {
	prf := func(data []byte) []byte {
		m := hmac.New(sha256.New, password)
		m.Write(data)
		return m.Sum(nil)
	}
	blocks := (keyLen + sha256.Size - 1) / sha256.Size
	var out []byte
	for b := 1; b <= blocks; b++ {
		var ctr [4]byte
		binary.BigEndian.PutUint32(ctr[:], uint32(b))
		u := prf(append(append([]byte{}, salt...), ctr[:]...))
		acc := append([]byte{}, u...)
		for i := 1; i < iterations; i++ {
			u = prf(u)
			for j := range acc {
				acc[j] ^= u[j]
			}
		}
		out = append(out, acc...)
	}
	return out[:keyLen]
}

func hashPassword(password string) (hashHex, saltHex string, err error) {
	salt := make([]byte, 16)
	if _, err = rand.Read(salt); err != nil {
		return "", "", err
	}
	h := pbkdf2SHA256([]byte(password), salt, pbkdf2Iterations, 32)
	return hex.EncodeToString(h), hex.EncodeToString(salt), nil
}

func verifyPassword(password, hashHex, saltHex string) bool {
	salt, err := hex.DecodeString(saltHex)
	if err != nil {
		return false
	}
	want, err := hex.DecodeString(hashHex)
	if err != nil {
		return false
	}
	got := pbkdf2SHA256([]byte(password), salt, pbkdf2Iterations, len(want))
	return subtle.ConstantTimeCompare(got, want) == 1
}

// ─── Токены сессий ───────────────────────────────────────────────────────────

func newSessionToken() (token, tokenHash string, err error) {
	raw := make([]byte, 32)
	if _, err = rand.Read(raw); err != nil {
		return "", "", err
	}
	token = hex.EncodeToString(raw)
	sum := sha256.Sum256([]byte(token))
	return token, hex.EncodeToString(sum[:]), nil
}

func tokenHashOf(token string) string {
	sum := sha256.Sum256([]byte(token))
	return hex.EncodeToString(sum[:])
}

// ─── Модель ──────────────────────────────────────────────────────────────────

type User struct {
	ID          string    `json:"id"`
	Login       string    `json:"login"`
	DisplayName string    `json:"display_name"`
	Role        string    `json:"role"`
	StaffID     string    `json:"staff_id,omitempty"`
	IsActive    bool      `json:"is_active"`
	CreatedAt   time.Time `json:"created_at"`
	UpdatedAt   time.Time `json:"updated_at"`
	// Permissions — JSON прав доступа:
	//   {"tables":{"visits":"edit","items":"view",...},
	//    "sums":"all|own|selected","sums_staff":["staff_id",...]}
	// Уровни таблиц: none < view < create < edit. Пусто = всё разрешено.
	// Для role=admin права игнорируются: админ может всё всегда.
	Permissions json.RawMessage `json:"permissions,omitempty"`
	perms       *permSet        // разобранный кэш, наружу не сериализуется
}

// permSet — разобранные права.
type permSet struct {
	Tables    map[string]string `json:"tables"`
	Sums      string            `json:"sums"`
	SumsStaff []string          `json:"sums_staff"`
}

var permLevels = map[string]int{"none": 0, "view": 1, "create": 2, "edit": 3}

func (u *User) permsParsed() *permSet {
	if u.perms != nil {
		return u.perms
	}
	ps := &permSet{}
	if len(u.Permissions) > 0 {
		json.Unmarshal(u.Permissions, ps)
	}
	u.perms = ps
	return ps
}

// tableLevel — уровень доступа пользователя к таблице.
// Админ и пользователь без настроенных прав получают edit.
func (u *User) tableLevel(table string) int {
	if u == nil || u.Role == "admin" {
		return permLevels["edit"]
	}
	ps := u.permsParsed()
	if ps.Tables == nil {
		return permLevels["edit"]
	}
	lvl, ok := ps.Tables[table]
	if !ok || lvl == "" {
		return permLevels["edit"]
	}
	n, ok := permLevels[lvl]
	if !ok {
		return permLevels["edit"]
	}
	return n
}

var validRoles = map[string]bool{"admin": true, "doctor": true, "reception": true}

// ─── Контекст текущего пользователя ─────────────────────────────────────────

type ctxKeyUser struct{}

func userFromCtx(ctx context.Context) *User {
	u, _ := ctx.Value(ctxKeyUser{}).(*User)
	return u
}

// ─── Middleware ──────────────────────────────────────────────────────────────

// authExempt — что доступно без токена: статика (иначе не загрузится сама
// страница входа), health для проверки связи и сам вход.
func authExempt(r *http.Request) bool {
	p := r.URL.Path
	if r.Method == http.MethodGet || r.Method == http.MethodHead {
		if p == "/" || p == "/index.html" || p == "/manifest.json" ||
			p == "/service-worker.js" || p == "/offline.html" || p == "/health" ||
			strings.HasPrefix(p, "/js/") || strings.HasPrefix(p, "/css/") ||
			strings.HasPrefix(p, "/icons/") || strings.HasPrefix(p, "/vendor/") {
			return true
		}
	}
	if p == "/health" || p == "/auth/login" {
		return true
	}
	return false
}

func (a *app) authMiddleware(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Method == http.MethodOptions || authExempt(r) {
			next.ServeHTTP(w, r)
			return
		}
		token := strings.TrimSpace(r.Header.Get(authHeader))
		if token == "" {
			// Запасной канал для GET-ссылок, куда заголовок не вставить
			// (открытие скана в новой вкладке): ?t=<токен>.
			token = strings.TrimSpace(r.URL.Query().Get("t"))
		}
		if token == "" {
			writeError(w, http.StatusUnauthorized, "Требуется вход")
			return
		}
		u, err := a.userByToken(r.Context(), token)
		if err != nil {
			writeError(w, http.StatusUnauthorized, "Сессия истекла — войдите заново")
			return
		}
		if msg := deniedByPermissions(u, r); msg != "" {
			writeError(w, http.StatusForbidden, msg)
			return
		}
		next.ServeHTTP(w, r.WithContext(context.WithValue(r.Context(), ctxKeyUser{}, u)))
	})
}

// pathTable — к какой «таблице прав» относится путь API.
// visit-items и attachments живут под правами приёмов: отдельно их
// настраивать нет смысла — это части одной сущности.
func pathTable(p string) string {
	switch {
	case strings.HasPrefix(p, "/owners"):
		return "owners"
	case strings.HasPrefix(p, "/pets"):
		return "pets"
	case strings.HasPrefix(p, "/visits"), strings.HasPrefix(p, "/visit-items"), strings.HasPrefix(p, "/attachments"):
		return "visits"
	case strings.HasPrefix(p, "/vaccinations"):
		return "vaccinations"
	case strings.HasPrefix(p, "/items"):
		return "items"
	case strings.HasPrefix(p, "/staff"):
		return "staff"
	}
	return ""
}

// deniedByPermissions — централизованная проверка прав на API.
// GET требует view, POST — create, PUT/DELETE — edit. Пустая строка = доступ есть.
// Одно место вместо проверки в тридцати хендлерах.
func deniedByPermissions(u *User, r *http.Request) string {
	table := pathTable(r.URL.Path)
	if table == "" {
		return "" // /auth, /users (свой guard), /sync (свой guard), /authorship
	}
	need := permLevels["view"]
	switch r.Method {
	case http.MethodPost:
		need = permLevels["create"]
	case http.MethodPut, http.MethodDelete:
		need = permLevels["edit"]
	}
	if u.tableLevel(table) < need {
		return "Недостаточно прав для этого действия"
	}
	return ""
}

func (a *app) userByToken(ctx context.Context, token string) (*User, error) {
	var u User
	var isActive int
	var expires timeScanner
	var permsStr string
	err := a.db.QueryRowContext(ctx, `
		SELECT u.id, u.login, u.display_name, u.role, COALESCE(u.staff_id,''), COALESCE(u.permissions,''), u.is_active, s.expires_at
		FROM sessions s JOIN users u ON u.id = s.user_id
		WHERE s.token_hash = ?`, tokenHashOf(token),
	).Scan(&u.ID, &u.Login, &u.DisplayName, &u.Role, &u.StaffID, &permsStr, &isActive, &expires)
	if permsStr != "" {
		u.Permissions = json.RawMessage(permsStr)
	}
	if err != nil {
		return nil, err
	}
	if isActive != 1 {
		return nil, errors.New("user disabled")
	}
	if expires.t == nil || expires.t.Before(nowUTC()) {
		return nil, errors.New("session expired")
	}
	return &u, nil
}

// requireAdmin оборачивает хендлеры, доступные только администратору.
func (a *app) requireAdmin(fn http.HandlerFunc) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		u := userFromCtx(r.Context())
		if u == nil || u.Role != "admin" {
			writeError(w, http.StatusForbidden, "Доступно только администратору")
			return
		}
		fn(w, r)
	}
}

// ─── Вход / выход / текущий пользователь ────────────────────────────────────

func (a *app) handleLogin(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		writeError(w, http.StatusMethodNotAllowed, "method not allowed")
		return
	}
	var p struct {
		Login    string `json:"login"`
		Password string `json:"password"`
		DeviceID string `json:"device_id"`
	}
	if err := json.NewDecoder(r.Body).Decode(&p); err != nil {
		writeError(w, http.StatusBadRequest, "invalid json")
		return
	}
	login := strings.ToLower(strings.TrimSpace(p.Login))
	if login == "" || p.Password == "" {
		writeError(w, http.StatusBadRequest, "Укажите логин и пароль")
		return
	}

	ctx, cancel := context.WithTimeout(r.Context(), 10*time.Second)
	defer cancel()

	var u User
	var hash, salt string
	var isActive int
	var permsStr string
	err := a.db.QueryRowContext(ctx, `
		SELECT id, login, display_name, role, COALESCE(staff_id,''), COALESCE(permissions,''), is_active, password_hash, password_salt
		FROM users WHERE login = ?`, login,
	).Scan(&u.ID, &u.Login, &u.DisplayName, &u.Role, &u.StaffID, &permsStr, &isActive, &hash, &salt)
	if permsStr != "" {
		u.Permissions = json.RawMessage(permsStr)
	}
	// Одинаковый ответ для «нет такого логина» и «неверный пароль» —
	// не подсказываем, какие логины существуют.
	if err != nil || isActive != 1 || !verifyPassword(p.Password, hash, salt) {
		time.Sleep(300 * time.Millisecond) // притормаживаем перебор
		writeError(w, http.StatusUnauthorized, "Неверный логин или пароль")
		return
	}
	u.IsActive = true

	token, th, err := newSessionToken()
	if err != nil {
		writeError(w, http.StatusInternalServerError, "failed to create session")
		return
	}
	if _, err := a.db.ExecContext(ctx,
		`INSERT INTO sessions (token_hash, user_id, device_id, created_at, expires_at) VALUES (?, ?, ?, ?, ?)`,
		th, u.ID, nullableString(strings.TrimSpace(p.DeviceID)), T(nowUTC()), T(nowUTC().Add(sessionTTL)),
	); err != nil {
		a.logger.Printf("login session insert: %v", err)
		writeError(w, http.StatusInternalServerError, "failed to create session")
		return
	}

	writeJSON(w, http.StatusOK, apiResponse{Status: "ok", Data: map[string]interface{}{
		"token": token,
		"user":  u,
	}})
}

func (a *app) handleLogout(w http.ResponseWriter, r *http.Request) {
	token := strings.TrimSpace(r.Header.Get(authHeader))
	if token != "" {
		ctx, cancel := context.WithTimeout(r.Context(), 5*time.Second)
		defer cancel()
		a.db.ExecContext(ctx, `DELETE FROM sessions WHERE token_hash = ?`, tokenHashOf(token))
	}
	writeJSON(w, http.StatusOK, apiResponse{Status: "ok"})
}

func (a *app) handleMe(w http.ResponseWriter, r *http.Request) {
	u := userFromCtx(r.Context())
	if u == nil {
		writeError(w, http.StatusUnauthorized, "Требуется вход")
		return
	}
	writeJSON(w, http.StatusOK, apiResponse{Status: "ok", Data: u})
}

// ─── Админка: CRUD пользователей ────────────────────────────────────────────

func (a *app) handleUsers(w http.ResponseWriter, r *http.Request) {
	switch r.Method {
	case http.MethodGet:
		a.listUsers(w, r)
	case http.MethodPost:
		a.createUser(w, r)
	default:
		writeError(w, http.StatusMethodNotAllowed, "method not allowed")
	}
}

func (a *app) listUsers(w http.ResponseWriter, r *http.Request) {
	ctx, cancel := context.WithTimeout(r.Context(), 5*time.Second)
	defer cancel()
	rows, err := a.db.QueryContext(ctx, `
		SELECT id, login, display_name, role, COALESCE(staff_id,''), COALESCE(permissions,''), is_active, created_at, updated_at
		FROM users ORDER BY display_name`)
	if err != nil {
		writeError(w, http.StatusInternalServerError, "failed to load users")
		return
	}
	defer rows.Close()
	list := make([]User, 0)
	for rows.Next() {
		var u User
		var act int
		var cr, up timeScanner
		var permsStr string
		if err := rows.Scan(&u.ID, &u.Login, &u.DisplayName, &u.Role, &u.StaffID, &permsStr, &act, &cr, &up); err != nil {
			continue
		}
		if permsStr != "" {
			u.Permissions = json.RawMessage(permsStr)
		}
		u.IsActive = act == 1
		if cr.t != nil {
			u.CreatedAt = *cr.t
		}
		if up.t != nil {
			u.UpdatedAt = *up.t
		}
		list = append(list, u)
	}
	writeJSON(w, http.StatusOK, apiResponse{Status: "ok", Data: list})
}

type userPayload struct {
	Login       string          `json:"login"`
	Password    string          `json:"password,omitempty"` // при создании обязателен; при правке пустой = не менять
	DisplayName string          `json:"display_name"`
	Role        string          `json:"role"`
	StaffID     string          `json:"staff_id,omitempty"`
	IsActive    *bool           `json:"is_active,omitempty"`
	Permissions json.RawMessage `json:"permissions,omitempty"`
}

func validateUserPayload(p userPayload, isCreate bool) error {
	if strings.TrimSpace(p.Login) == "" {
		return errors.New("Укажите логин")
	}
	if strings.ContainsAny(p.Login, " \t") {
		return errors.New("Логин без пробелов")
	}
	if strings.TrimSpace(p.DisplayName) == "" {
		return errors.New("Укажите имя")
	}
	if !validRoles[p.Role] {
		return errors.New("Роль: admin, doctor или reception")
	}
	if isCreate && len(p.Password) < 6 {
		return errors.New("Пароль не короче 6 символов")
	}
	if !isCreate && p.Password != "" && len(p.Password) < 6 {
		return errors.New("Пароль не короче 6 символов")
	}
	return nil
}

func (a *app) createUser(w http.ResponseWriter, r *http.Request) {
	var p userPayload
	if err := decodeJSON(r, &p); err != nil {
		writeError(w, http.StatusBadRequest, err.Error())
		return
	}
	if err := validateUserPayload(p, true); err != nil {
		writeError(w, http.StatusBadRequest, err.Error())
		return
	}
	id, err := newUUID()
	if err != nil {
		writeError(w, http.StatusInternalServerError, "failed to generate id")
		return
	}
	hash, salt, err := hashPassword(p.Password)
	if err != nil {
		writeError(w, http.StatusInternalServerError, "failed to hash password")
		return
	}

	ctx, cancel := context.WithTimeout(r.Context(), 10*time.Second)
	defer cancel()
	now := T(nowUTC())
	_, err = a.db.ExecContext(ctx, `
		INSERT INTO users (id, login, password_hash, password_salt, display_name, role, staff_id, permissions, is_active, created_at, updated_at)
		VALUES (?, ?, ?, ?, ?, ?, ?, ?, 1, ?, ?)`,
		id, strings.ToLower(strings.TrimSpace(p.Login)), hash, salt,
		strings.TrimSpace(p.DisplayName), p.Role, nullableString(p.StaffID),
		nullableString(string(p.Permissions)), now, now,
	)
	if err != nil {
		if strings.Contains(err.Error(), "UNIQUE") {
			writeError(w, http.StatusConflict, "Логин «"+p.Login+"» уже занят")
			return
		}
		a.logger.Printf("createUser: %v", err)
		writeError(w, http.StatusInternalServerError, "failed to create user")
		return
	}
	writeJSON(w, http.StatusCreated, apiResponse{Status: "ok", Data: map[string]string{"id": id}})
}

func (a *app) handleUserByID(w http.ResponseWriter, r *http.Request) {
	id := strings.TrimSpace(r.PathValue("id"))
	if id == "" {
		writeError(w, http.StatusBadRequest, "id is required")
		return
	}
	switch r.Method {
	case http.MethodPut:
		a.updateUser(w, r, id)
	case http.MethodDelete:
		a.deactivateUser(w, r, id)
	default:
		writeError(w, http.StatusMethodNotAllowed, "method not allowed")
	}
}

func (a *app) updateUser(w http.ResponseWriter, r *http.Request, id string) {
	var p userPayload
	if err := decodeJSON(r, &p); err != nil {
		writeError(w, http.StatusBadRequest, err.Error())
		return
	}
	if err := validateUserPayload(p, false); err != nil {
		writeError(w, http.StatusBadRequest, err.Error())
		return
	}
	// Последнего активного админа нельзя разжаловать или выключить —
	// иначе в админку больше никто не войдёт.
	cur := userFromCtx(r.Context())
	ctx, cancel := context.WithTimeout(r.Context(), 10*time.Second)
	defer cancel()
	if err := a.guardLastAdmin(ctx, id, p.Role, p.IsActive); err != nil {
		writeError(w, http.StatusBadRequest, err.Error())
		return
	}

	isActive := true
	if p.IsActive != nil {
		isActive = *p.IsActive
	}
	res, err := a.db.ExecContext(ctx, `
		UPDATE users SET login=?, display_name=?, role=?, staff_id=?, permissions=?, is_active=?, updated_at=?
		WHERE id=?`,
		strings.ToLower(strings.TrimSpace(p.Login)), strings.TrimSpace(p.DisplayName),
		p.Role, nullableString(p.StaffID), nullableString(string(p.Permissions)),
		boolToInt(isActive), T(nowUTC()), id,
	)
	if err != nil {
		if strings.Contains(err.Error(), "UNIQUE") {
			writeError(w, http.StatusConflict, "Логин «"+p.Login+"» уже занят")
			return
		}
		writeError(w, http.StatusInternalServerError, "failed to update user")
		return
	}
	if n, _ := res.RowsAffected(); n == 0 {
		writeError(w, http.StatusNotFound, "user not found")
		return
	}

	// Смена пароля: убиваем чужие сессии этого пользователя, свою (если админ
	// меняет себе) оставляем — иначе он вылетит из админки посреди работы.
	if p.Password != "" {
		hash, salt, err := hashPassword(p.Password)
		if err == nil {
			a.db.ExecContext(ctx, `UPDATE users SET password_hash=?, password_salt=? WHERE id=?`, hash, salt, id)
			keep := ""
			if cur != nil && cur.ID == id {
				keep = tokenHashOf(strings.TrimSpace(r.Header.Get(authHeader)))
			}
			a.db.ExecContext(ctx, `DELETE FROM sessions WHERE user_id=? AND token_hash<>?`, id, keep)
		}
	}
	if p.IsActive != nil && !*p.IsActive {
		a.db.ExecContext(ctx, `DELETE FROM sessions WHERE user_id=?`, id)
	}
	writeJSON(w, http.StatusOK, apiResponse{Status: "ok", Data: map[string]string{"id": id}})
}

// deactivateUser: пользователей не удаляем физически (created_by/updated_by
// ссылаются на них) — выключаем и рвём сессии.
func (a *app) deactivateUser(w http.ResponseWriter, r *http.Request, id string) {
	ctx, cancel := context.WithTimeout(r.Context(), 5*time.Second)
	defer cancel()
	off := false
	if err := a.guardLastAdmin(ctx, id, "", &off); err != nil {
		writeError(w, http.StatusBadRequest, err.Error())
		return
	}
	res, err := a.db.ExecContext(ctx, `UPDATE users SET is_active=0, updated_at=? WHERE id=?`, T(nowUTC()), id)
	if err != nil {
		writeError(w, http.StatusInternalServerError, "failed to deactivate user")
		return
	}
	if n, _ := res.RowsAffected(); n == 0 {
		writeError(w, http.StatusNotFound, "user not found")
		return
	}
	a.db.ExecContext(ctx, `DELETE FROM sessions WHERE user_id=?`, id)
	writeJSON(w, http.StatusOK, apiResponse{Status: "ok", Data: map[string]string{"id": id}})
}

// guardLastAdmin не даёт лишить систему последнего активного администратора.
func (a *app) guardLastAdmin(ctx context.Context, id, newRole string, newActive *bool) error {
	var role string
	var act int
	if err := a.db.QueryRowContext(ctx, `SELECT role, is_active FROM users WHERE id=?`, id).Scan(&role, &act); err != nil {
		return nil // не нашли — пусть решает основной запрос
	}
	if role != "admin" || act != 1 {
		return nil
	}
	demote := (newRole != "" && newRole != "admin") || (newActive != nil && !*newActive)
	if !demote {
		return nil
	}
	var others int
	a.db.QueryRowContext(ctx, `SELECT COUNT(*) FROM users WHERE role='admin' AND is_active=1 AND id<>?`, id).Scan(&others)
	if others == 0 {
		return errors.New("Это последний администратор — сначала назначьте другого")
	}
	return nil
}

// ─── Первый запуск ───────────────────────────────────────────────────────────

// bootstrapAdmin создаёт администратора, если пользователей ещё нет.
// Пароль генерируется, печатается в консоль и кладётся в data/ADMIN-PASSWORD.txt —
// фиксированный «admin/admin» остался бы навсегда, знаем мы таких админов.
func (a *app) bootstrapAdmin() {
	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()
	var n int
	if err := a.db.QueryRowContext(ctx, `SELECT COUNT(*) FROM users`).Scan(&n); err != nil || n > 0 {
		return
	}
	// 10 символов без похожих друг на друга (0/O, 1/l)
	const alphabet = "abcdefghjkmnpqrstuvwxyz23456789"
	raw := make([]byte, 10)
	rand.Read(raw)
	pw := make([]byte, 10)
	for i, b := range raw {
		pw[i] = alphabet[int(b)%len(alphabet)]
	}
	password := string(pw)

	hash, salt, err := hashPassword(password)
	if err != nil {
		a.logger.Printf("bootstrapAdmin: %v", err)
		return
	}
	id, _ := newUUID()
	now := T(nowUTC())
	if _, err := a.db.ExecContext(ctx, `
		INSERT INTO users (id, login, password_hash, password_salt, display_name, role, is_active, created_at, updated_at)
		VALUES (?, 'admin', ?, ?, 'Администратор', 'admin', 1, ?, ?)`,
		id, hash, salt, now, now); err != nil {
		a.logger.Printf("bootstrapAdmin insert: %v", err)
		return
	}

	pwFile := filepath.Join(filepath.Dir(a.config.DBPath), "ADMIN-PASSWORD.txt")
	os.WriteFile(pwFile, []byte("Логин: admin\nПароль: "+password+"\n\nСмените пароль после первого входа и удалите этот файл.\n"), 0o600)
	a.logger.Println("──────────────────────────────────────────────────────")
	a.logger.Println("  Создан первый пользователь-администратор:")
	a.logger.Printf("    логин:  admin")
	a.logger.Printf("    пароль: %s", password)
	a.logger.Printf("  Пароль также сохранён в %s", pwFile)
	a.logger.Println("  Смените его после первого входа и удалите файл.")
	a.logger.Println("──────────────────────────────────────────────────────")
}

// stampAuthor проставляет авторство записи после успешного sync-push:
// created_by — только если пусто, updated_by — всегда.
func (a *app) stampAuthor(ctx context.Context, table, id, userID string) {
	if userID == "" {
		return
	}
	a.db.ExecContext(ctx,
		`UPDATE `+table+` SET updated_by=?, created_by=COALESCE(created_by,?) WHERE id=?`,
		userID, userID, id)
}

// ─── Смена собственного пароля ──────────────────────────────────────────────

// POST /auth/change-password — любой вошедший меняет СВОЙ пароль,
// подтвердив старый. Чужие сессии пользователя рвутся (вдруг пароль меняют,
// потому что он утёк), текущая остаётся.
func (a *app) handleChangePassword(w http.ResponseWriter, r *http.Request) {
	u := userFromCtx(r.Context())
	if u == nil {
		writeError(w, http.StatusUnauthorized, "Требуется вход")
		return
	}
	var p struct {
		OldPassword string `json:"old_password"`
		NewPassword string `json:"new_password"`
	}
	if err := json.NewDecoder(r.Body).Decode(&p); err != nil {
		writeError(w, http.StatusBadRequest, "invalid json")
		return
	}
	if len(p.NewPassword) < 6 {
		writeError(w, http.StatusBadRequest, "Новый пароль не короче 6 символов")
		return
	}

	ctx, cancel := context.WithTimeout(r.Context(), 10*time.Second)
	defer cancel()

	var hash, salt string
	if err := a.db.QueryRowContext(ctx,
		`SELECT password_hash, password_salt FROM users WHERE id=?`, u.ID,
	).Scan(&hash, &salt); err != nil {
		writeError(w, http.StatusInternalServerError, "failed to load user")
		return
	}
	if !verifyPassword(p.OldPassword, hash, salt) {
		time.Sleep(300 * time.Millisecond)
		writeError(w, http.StatusForbidden, "Текущий пароль неверен")
		return
	}

	newHash, newSalt, err := hashPassword(p.NewPassword)
	if err != nil {
		writeError(w, http.StatusInternalServerError, "failed to hash password")
		return
	}
	if _, err := a.db.ExecContext(ctx,
		`UPDATE users SET password_hash=?, password_salt=?, updated_at=? WHERE id=?`,
		newHash, newSalt, T(nowUTC()), u.ID); err != nil {
		writeError(w, http.StatusInternalServerError, "failed to update password")
		return
	}
	keep := tokenHashOf(strings.TrimSpace(r.Header.Get(authHeader)))
	a.db.ExecContext(ctx, `DELETE FROM sessions WHERE user_id=? AND token_hash<>?`, u.ID, keep)
	writeJSON(w, http.StatusOK, apiResponse{Status: "ok"})
}

// ─── Кто изменил запись ─────────────────────────────────────────────────────

// authorshipTables — какие таблицы можно спрашивать. Белый список обязателен:
// имя таблицы попадает в SQL, произвольную строку туда пускать нельзя.
var authorshipTables = map[string]string{
	"owners": "owners", "pets": "pets", "items": "items", "visits": "visits",
	"visit_items": "visit_items", "vaccinations": "vaccinations", "staff": "clinic_staff",
}

// GET /authorship?table=visits&id=... — кто создал и кто последним менял запись.
// Работает только при связи с сервером, и это честно: авторство проставляется
// на сервере при push, планшет офлайн в принципе не знает, кто менял запись
// с другого устройства.
func (a *app) handleAuthorship(w http.ResponseWriter, r *http.Request) {
	table, ok := authorshipTables[strings.TrimSpace(r.URL.Query().Get("table"))]
	if !ok {
		writeError(w, http.StatusBadRequest, "table: недопустимое значение")
		return
	}
	id := strings.TrimSpace(r.URL.Query().Get("id"))
	if id == "" {
		writeError(w, http.StatusBadRequest, "id is required")
		return
	}

	ctx, cancel := context.WithTimeout(r.Context(), 5*time.Second)
	defer cancel()

	var createdBy, updatedBy string
	var createdAt, updatedAt timeScanner
	err := a.db.QueryRowContext(ctx,
		`SELECT COALESCE(created_by,''), COALESCE(updated_by,''), created_at, updated_at
		 FROM `+table+` WHERE id=?`, id,
	).Scan(&createdBy, &updatedBy, &createdAt, &updatedAt)
	if err != nil {
		writeError(w, http.StatusNotFound, "record not found")
		return
	}

	name := func(uid string) string {
		if uid == "" {
			return ""
		}
		var n string
		a.db.QueryRowContext(ctx, `SELECT display_name FROM users WHERE id=?`, uid).Scan(&n)
		return n
	}
	out := map[string]interface{}{
		"created_by_name": name(createdBy),
		"updated_by_name": name(updatedBy),
	}
	if createdAt.t != nil {
		out["created_at"] = createdAt.t
	}
	if updatedAt.t != nil {
		out["updated_at"] = updatedAt.t
	}
	writeJSON(w, http.StatusOK, apiResponse{Status: "ok", Data: out})
}
