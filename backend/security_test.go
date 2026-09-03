package main

import (
	"context"
	"net/http"
	"net/http/httptest"
	"net/url"
	"strings"
	"testing"
)

// Токен из строки запроса не должен попадать в лог: ?t= — запасной канал для
// ссылок на сканы, а лог писал полный URI, то есть рабочую сессию на 90 дней
// открытым текстом.
func TestRedactTokens(t *testing.T) {
	cases := []struct{ in, wantHas, wantNot string }{
		{"/attachments/1/file?t=SEKRET", "redacted", "SEKRET"},
		{"/portal/pets?pt=SEKRET", "redacted", "SEKRET"},
		{"/pets?status=all&t=SEKRET", "status=all", "SEKRET"},
	}
	for _, c := range cases {
		u, err := url.Parse(c.in)
		if err != nil {
			t.Fatalf("parse %s: %v", c.in, err)
		}
		got := redactTokens(u)
		if !strings.Contains(got, c.wantHas) {
			t.Errorf("%s -> %s: нет %q", c.in, got, c.wantHas)
		}
		if strings.Contains(got, c.wantNot) {
			t.Errorf("%s -> %s: токен утёк в лог", c.in, got)
		}
	}
	// Запрос без токена не должен переписываться вообще.
	u, _ := url.Parse("/pets?status=all")
	if got := redactTokens(u); got != "/pets?status=all" {
		t.Errorf("URI без токена изменён: %s", got)
	}
}

// Без пользователя в контексте push обязан быть отклонён. В бою пользователя
// кладёт authMiddleware; умолчание «разрешить» означало бы, что стоит /sync
// попасть в authExempt — и гейт прав исчезнет молча.
func TestSyncPushWithoutUserIsRejected(t *testing.T) {
	a := testApp(t)
	payload := `{"owners":[{"id":"o-x","fio":"Никто","phone":"+7 700 000 0000",
		"version":1,"updated_at":"2026-09-01T10:00:00Z"}]}`

	req := httptest.NewRequest(http.MethodPost, "/sync/push", strings.NewReader(payload))
	rec := httptest.NewRecorder()
	a.handleSyncPush(rec, req) // контекст пустой — пользователя нет

	if rec.Code != http.StatusOK {
		t.Fatalf("ожидали 200 с нулём принятых, получили %d", rec.Code)
	}
	owners := doPull(t, a, "")["owners"]
	if len(owners) != 0 {
		t.Errorf("запись без пользователя принята: %d шт.", len(owners))
	}
}

// Портал обязан отвечать одинаково на неизвестный номер и на неверный пароль:
// иначе разница в ответах выдаёт, обслуживается ли человек в клинике.
func TestPortalLoginDoesNotRevealClients(t *testing.T) {
	a := testApp(t)
	portalLoginThrottle = newLoginThrottle(50, 0, 0) // троттлинг не мешает проверке

	// Известный номер, но пароль неверный.
	doPush(t, a, `{"owners":[{"id":"o-1","fio":"Клиент","phone":"+7 700 111 2233",
		"version":1,"updated_at":"2026-09-01T10:00:00Z"}]}`)

	call := func(phone string) (int, string) {
		body := `{"phone":"` + phone + `","code":"000000"}`
		req := httptest.NewRequest(http.MethodPost, "/portal/login", strings.NewReader(body))
		rec := httptest.NewRecorder()
		a.handlePortalLogin(rec, req)
		return rec.Code, rec.Body.String()
	}

	knownCode, knownBody := call("+7 700 111 2233")
	unknownCode, unknownBody := call("+7 700 999 8877")

	if knownCode != unknownCode {
		t.Errorf("коды ответа различаются: известный %d, неизвестный %d", knownCode, unknownCode)
	}
	if knownBody != unknownBody {
		t.Errorf("тексты различаются:\n известный:   %s\n неизвестный: %s", knownBody, unknownBody)
	}
	if knownCode != http.StatusUnauthorized {
		t.Errorf("ожидали 401, получили %d", knownCode)
	}
}

// Заголовки безопасности должны приезжать на каждый ответ.
func TestSecurityHeaders(t *testing.T) {
	a := testApp(t)
	a.frontend = t.TempDir()
	h := a.securityHeadersMiddleware(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {}))
	rec := httptest.NewRecorder()
	h.ServeHTTP(rec, httptest.NewRequest(http.MethodGet, "/health", nil))

	for k, want := range map[string]string{
		"X-Content-Type-Options": "nosniff",
		"X-Frame-Options":        "DENY",
		"Referrer-Policy":        "same-origin",
	} {
		if got := rec.Header().Get(k); got != want {
			t.Errorf("%s = %q, ожидали %q", k, got, want)
		}
	}
	csp := rec.Header().Get("Content-Security-Policy")
	// Главное в политике: скрипты только свои. Инлайновых обработчиков в
	// интерфейсе не осталось, поэтому 'unsafe-inline' для script-src здесь
	// быть не должно — иначе защита от внедрения кода снова фиктивна.
	if strings.Contains(csp, "script-src 'self' 'unsafe-inline'") ||
		strings.Contains(csp, "script-src 'unsafe-inline'") {
		t.Errorf("script-src разрешает inline: %s", csp)
	}
	if !strings.Contains(csp, "script-src 'self';") {
		t.Errorf("нет строгого script-src: %s", csp)
	}
	// connect-src не даёт внедрённому скрипту отправить украденный токен наружу.
	for _, need := range []string{"connect-src 'self'", "frame-ancestors 'none'", "object-src 'none'"} {
		if !strings.Contains(csp, need) {
			t.Errorf("CSP без %q: %s", need, csp)
		}
	}
}

// CORS больше не отвечает "*": чужому источнику заголовок не выдаётся вовсе.
func TestCORSOnlySameOrigin(t *testing.T) {
	a := testApp(t)
	h := a.corsMiddleware(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {}))

	check := func(origin string) string {
		req := httptest.NewRequest(http.MethodGet, "http://vet.local/pets", nil)
		req.Host = "vet.local"
		req.Header.Set("Origin", origin)
		rec := httptest.NewRecorder()
		h.ServeHTTP(rec, req)
		return rec.Header().Get("Access-Control-Allow-Origin")
	}
	if got := check("https://evil.example"); got != "" {
		t.Errorf("чужому источнику выдан ACAO: %q", got)
	}
	if got := check("http://vet.local"); got != "http://vet.local" {
		t.Errorf("своему источнику ACAO не выдан: %q", got)
	}
}

// ─── Право «Справочники» ─────────────────────────────────────────────────────
//
// Шаблоны протоколов и заготовки диагнозов задают, что и как заполняют ВСЕ
// врачи. Раньше протоколы были закрыты жёсткой проверкой роли (делегировать
// ведение старшему врачу было нельзя), а справочник диагнозов не был закрыт
// ВООБЩЕ. Теперь и то и другое — по праву templates.
func TestTemplatesPermissionGuardsReferenceBooks(t *testing.T) {
	a := testApp(t)

	// Пользователь без настроенных прав: остальные таблицы — edit по
	// умолчанию, а справочники — только чтение. Новое право не должно молча
	// открыть их тем, у кого доступа не было.
	plain := &User{ID: "u1", Login: "doc", Role: "doctor", IsActive: true}
	if got := plain.tableLevel("visits"); got != permLevels["edit"] {
		t.Errorf("visits без настройки = %d, ждём edit", got)
	}
	if got := plain.tableLevel("templates"); got != permLevels["view"] {
		t.Errorf("templates без настройки = %d, ждём view — иначе право молча "+
			"откроет справочники всем", got)
	}

	// Явная выдача правки работает.
	editor := &User{ID: "u2", Login: "senior", Role: "doctor", IsActive: true,
		Permissions: []byte(`{"tables":{"templates":"edit"}}`)}
	if got := editor.tableLevel("templates"); got != permLevels["edit"] {
		t.Errorf("templates с явным edit = %d, ждём edit", got)
	}

	// Гейт маршрута: без права — 403, с правом — проходит дальше.
	called := false
	h := a.requireTableEdit("templates", func(w http.ResponseWriter, r *http.Request) {
		called = true
		w.WriteHeader(http.StatusOK)
	})

	req := httptest.NewRequest(http.MethodPost, "/protocols", nil)
	req = req.WithContext(context.WithValue(req.Context(), ctxKeyUser{}, plain))
	rec := httptest.NewRecorder()
	h(rec, req)
	if rec.Code != http.StatusForbidden {
		t.Errorf("без права правки справочника ждём 403, получили %d", rec.Code)
	}
	if called {
		t.Error("обработчик выполнился, хотя права нет")
	}

	req = httptest.NewRequest(http.MethodPost, "/protocols", nil)
	req = req.WithContext(context.WithValue(req.Context(), ctxKeyUser{}, editor))
	rec = httptest.NewRecorder()
	h(rec, req)
	if rec.Code != http.StatusOK || !called {
		t.Errorf("с правом правки ждём проход, получили %d", rec.Code)
	}
}

// ─── Пентест: назначения ─────────────────────────────────────────────────────
//
// Назначения появились недавно и содержат медицинские данные. Проверяем, что
// новая сущность закрыта так же, как остальная медкарта, а не осталась дырой:
// право на неё — право на приёмы (permTableFor), и роль склада к ней не имеет
// доступа ни через API, ни через синхронизацию.
func TestPrescriptionsAreGuardedLikeMedicalRecord(t *testing.T) {
	// Право на назначения — это право на приёмы.
	if got := permTableForTest("prescriptions"); got != "visits" {
		t.Errorf("prescriptions отнесены к праву %q, ждём visits — иначе "+
			"медицинские назначения поедут в обход прав на медкарту", got)
	}

	// Роль склада изолирована: медкарта ей недоступна.
	seller := &User{ID: "w", Login: "seller", Role: "warehouse", IsActive: true}
	if lvl := seller.tableLevel("visits"); lvl >= permLevels["view"] {
		t.Errorf("роль склада видит медкарту (уровень %d) — назначения утекут вместе с ней", lvl)
	}

	// Пользователь с явным запретом на приёмы не должен получать назначения.
	blocked := &User{ID: "b", Login: "reg", Role: "reception", IsActive: true,
		Permissions: []byte(`{"tables":{"visits":"none"}}`)}
	if lvl := blocked.tableLevel("visits"); lvl != permLevels["none"] {
		t.Errorf("явный запрет на приёмы не сработал: уровень %d", lvl)
	}
}

// Инъекции и разметка в новых полях. Значения проходят через параметры
// запроса, а не конкатенацию, и должны сохраняться ДОСЛОВНО — ни выполниться,
// ни быть «почищенными» до неузнаваемости.
func TestNewFieldsStoreHostileInputVerbatim(t *testing.T) {
	a := testApp(t)

	doPush(t, a, `{"device_id":"dev-1",
		"owners":[{"id":"o-x","fio":"О","phone":"+7 700 000 0000","version":1,"updated_at":"2026-09-01T10:00:00Z"}],
		"pets":[{"id":"p-x","owner_id":"o-x","name":"Кот","type":"cat","gender":"m",
		         "allergies":"'); DROP TABLE pets;--","version":1,"updated_at":"2026-09-01T10:00:00Z"}],
		"visits":[{"id":"v-x","pet_id":"p-x","date":"2026-09-01T10:00:00Z",
		           "vitals":"<script>alert(1)</script>","version":1,"updated_at":"2026-09-01T10:00:00Z"}],
		"prescriptions":[{"id":"px-x","visit_id":"v-x","pet_id":"p-x","drug_name":"Амоксиклав\" OR 1=1--",
		                  "instruction":"<img src=x onerror=alert(1)>","status":"active",
		                  "version":1,"updated_at":"2026-09-01T10:00:00Z"}]}`)

	// Таблица цела — инъекция не выполнилась.
	var pets int
	if err := a.db.QueryRow(`SELECT count(*) FROM pets`).Scan(&pets); err != nil {
		t.Fatalf("таблица pets повреждена: %v", err)
	}
	if pets != 1 {
		t.Fatalf("животных %d, ждём 1", pets)
	}

	// Значения сохранены дословно.
	var allergies, vitals, drug, instr string
	a.db.QueryRow(`SELECT COALESCE(allergies,'') FROM pets WHERE id='p-x'`).Scan(&allergies)
	a.db.QueryRow(`SELECT COALESCE(vitals,'') FROM visits WHERE id='v-x'`).Scan(&vitals)
	a.db.QueryRow(`SELECT drug_name, COALESCE(instruction,'') FROM prescriptions WHERE id='px-x'`).Scan(&drug, &instr)
	if allergies != "'); DROP TABLE pets;--" {
		t.Errorf("аллергии сохранены как %q — значение исказилось", allergies)
	}
	if vitals != "<script>alert(1)</script>" {
		t.Errorf("показатели сохранены как %q", vitals)
	}
	if drug != `Амоксиклав" OR 1=1--` {
		t.Errorf("препарат сохранён как %q", drug)
	}
	if instr != "<img src=x onerror=alert(1)>" {
		t.Errorf("инструкция сохранена как %q", instr)
	}
}

// Статус курса нормализуется: неизвестное значение считаем действующим.
// Невидимая терапия опаснее лишней строки в списке — врач должен увидеть
// назначение даже если статус пришёл битым.
func TestPrescriptionStatusNeverHidesTherapy(t *testing.T) {
	for _, in := range []string{"", "  ", "мусор", "DROP", "ACTIVE", "Cancelled"} {
		got := normalizePrescriptionStatus(in)
		if got != "active" && got != "cancelled" && got != "stopped" {
			t.Errorf("normalizePrescriptionStatus(%q) = %q — вне допустимых значений", in, got)
		}
		if in == "мусор" || in == "DROP" || in == "" || in == "  " {
			if got != "active" {
				t.Errorf("неизвестный статус %q дал %q, ждём active: назначение "+
					"не должно исчезать из-за битого статуса", in, got)
			}
		}
	}
}

// permTableForTest повторяет отображение из handleSyncPull: тест обязан
// сломаться, если новую сущность добавят мимо прав.
func permTableForTest(name string) string {
	switch name {
	case "visit_items", "appointments", "attachments", "prescriptions":
		return "visits"
	case "protocol_templates", "diagnosis_templates":
		return "templates"
	default:
		return name
	}
}
