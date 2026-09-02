package main

import (
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
