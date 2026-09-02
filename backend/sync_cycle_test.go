package main

import (
	"context"
	"encoding/json"
	"io"
	"log"
	"net/http"
	"net/http/httptest"
	"path/filepath"
	"strings"
	"testing"
)

// Полный цикл push -> pull через настоящие HTTP-обработчики и настоящую схему.
// Это то место, где регресс тише всего: запись уходит с планшета, сервер её
// принимает, но обратно она может не вернуться (так уже было — pullPets
// молча терял все строки из-за расхождения колонок и scanner'а).

func testApp(t *testing.T) *app {
	t.Helper()
	db, err := openDB(filepath.Join(t.TempDir(), "cycle.db"))
	if err != nil {
		t.Fatalf("openDB: %v", err)
	}
	t.Cleanup(func() { db.Close() })
	return &app{db: db, logger: log.New(io.Discard, "", 0)}
}

// push отправляет payload в handleSyncPush и возвращает разобранный ответ.
//
// Пользователя в контекст кладём руками: в бою это делает authMiddleware, а
// хендлер зовут напрямую. Без него canPush отклоняет всё — умолчание там
// «запретить», и тест обязан ходить тем же путём, что живой планшет.
func doPush(t *testing.T, a *app, payload string) map[string]any {
	t.Helper()
	req := httptest.NewRequest(http.MethodPost, "/sync/push", strings.NewReader(payload))
	req = req.WithContext(context.WithValue(req.Context(), ctxKeyUser{},
		&User{ID: "u-test", Login: "admin", Role: "admin", IsActive: true}))
	rec := httptest.NewRecorder()
	a.handleSyncPush(rec, req)
	if rec.Code != http.StatusOK {
		t.Fatalf("push HTTP %d: %s", rec.Code, rec.Body.String())
	}
	var resp struct {
		Status string         `json:"status"`
		Data   map[string]any `json:"data"`
	}
	if err := json.Unmarshal(rec.Body.Bytes(), &resp); err != nil {
		t.Fatalf("push ответ не JSON: %v", err)
	}
	if resp.Status != "ok" {
		t.Fatalf("push status=%q", resp.Status)
	}
	return resp.Data
}

// pull забирает данные и возвращает карту «сущность -> записи».
func doPull(t *testing.T, a *app, since string) map[string][]map[string]any {
	t.Helper()
	url := "/sync/pull"
	if since != "" {
		url += "?since=" + since
	}
	rec := httptest.NewRecorder()
	a.handleSyncPull(rec, httptest.NewRequest(http.MethodGet, url, nil))
	if rec.Code != http.StatusOK {
		t.Fatalf("pull HTTP %d: %s", rec.Code, rec.Body.String())
	}
	var resp struct {
		Data map[string]json.RawMessage `json:"data"`
	}
	if err := json.Unmarshal(rec.Body.Bytes(), &resp); err != nil {
		t.Fatalf("pull ответ не JSON: %v", err)
	}
	out := map[string][]map[string]any{}
	for k, raw := range resp.Data {
		var rows []map[string]any
		if json.Unmarshal(raw, &rows) == nil {
			out[k] = rows
		}
	}
	return out
}

func TestSyncCycleOwnerPushThenPull(t *testing.T) {
	a := testApp(t)

	doPush(t, a, `{"device_id":"dev-1","owners":[{
		"id":"o-1","fio":"Тестов Тест","phone":"+7 700 000 0000",
		"version":1,"updated_at":"2026-09-01T10:00:00Z"}]}`)

	data := doPull(t, a, "")
	owners := data["owners"]
	if len(owners) != 1 {
		t.Fatalf("после push ждём 1 владельца в pull, получили %d", len(owners))
	}
	if owners[0]["fio"] != "Тестов Тест" {
		t.Errorf("fio = %v, ждём «Тестов Тест»", owners[0]["fio"])
	}
	// Ключевая гарантия офлайна: id, присвоенный на устройстве, сохраняется —
	// иначе локальные ссылки (питомцы, визиты) повиснут.
	if owners[0]["id"] != "o-1" {
		t.Errorf("id изменился на %v — ссылки с устройства сломаются", owners[0]["id"])
	}
}

func TestSyncCycleUpdateWinsAndReturns(t *testing.T) {
	a := testApp(t)

	doPush(t, a, `{"owners":[{"id":"o-2","fio":"Первый","phone":"+7 700 111 1111",
		"version":1,"updated_at":"2026-09-01T10:00:00Z"}]}`)
	// Правка с более высокой версией должна победить и вернуться в pull.
	doPush(t, a, `{"owners":[{"id":"o-2","fio":"Исправленный","phone":"+7 700 111 1111",
		"version":2,"updated_at":"2026-09-01T11:00:00Z"}]}`)

	owners := doPull(t, a, "")["owners"]
	if len(owners) != 1 {
		t.Fatalf("ждём одну запись (обновление, не дубль), получили %d", len(owners))
	}
	if owners[0]["fio"] != "Исправленный" {
		t.Errorf("правка не применилась: fio = %v", owners[0]["fio"])
	}
}

func TestSyncCycleStaleUpdateRejected(t *testing.T) {
	a := testApp(t)

	doPush(t, a, `{"owners":[{"id":"o-3","fio":"Свежий","phone":"+7 700 222 2222",
		"version":5,"updated_at":"2026-09-01T12:00:00Z"}]}`)
	// Устаревшая правка (версия ниже, время раньше) не должна затирать свежую.
	doPush(t, a, `{"owners":[{"id":"o-3","fio":"Устаревший","phone":"+7 700 222 2222",
		"version":2,"updated_at":"2026-09-01T09:00:00Z"}]}`)

	owners := doPull(t, a, "")["owners"]
	if len(owners) != 1 {
		t.Fatalf("ждём одну запись, получили %d", len(owners))
	}
	if owners[0]["fio"] != "Свежий" {
		t.Errorf("устаревшая правка затёрла свежую: fio = %v", owners[0]["fio"])
	}
}

func TestSyncCycleDeleteReturnsAsFlag(t *testing.T) {
	a := testApp(t)

	doPush(t, a, `{"owners":[{"id":"o-4","fio":"Удаляемый","phone":"+7 700 333 3333",
		"version":1,"updated_at":"2026-09-01T10:00:00Z"}]}`)
	doPush(t, a, `{"owners":[{"id":"o-4","fio":"Удаляемый","phone":"+7 700 333 3333",
		"version":2,"updated_at":"2026-09-01T11:00:00Z","is_deleted":1}]}`)

	owners := doPull(t, a, "")["owners"]
	if len(owners) != 1 {
		t.Fatalf("удалённая запись должна ВЕРНУТЬСЯ с флагом (иначе другое "+
			"устройство её не удалит), получили %d", len(owners))
	}
	// is_deleted в модели синка — int (0/1), в JSON приходит числом.
	if n, ok := owners[0]["is_deleted"].(float64); !ok || n == 0 {
		t.Errorf("is_deleted = %v, ждём признак удаления", owners[0]["is_deleted"])
	}
}

// Питомцы отдельно: именно на них ломался pull из-за расхождения колонок
// в запросе и сканере — записи молча пропадали, а HTTP оставался 200.
func TestSyncCyclePetSurvivesRoundTrip(t *testing.T) {
	a := testApp(t)

	doPush(t, a, `{
		"owners":[{"id":"o-5","fio":"Хозяин","phone":"+7 700 444 4444",
			"version":1,"updated_at":"2026-09-01T10:00:00Z"}],
		"pets":[{"id":"p-1","owner_id":"o-5","name":"Марсель","type":"cat","gender":"m",
			"chip_number":"643094100123456","version":1,"updated_at":"2026-09-01T10:05:00Z"}]}`)

	pets := doPull(t, a, "")["pets"]
	if len(pets) != 1 {
		t.Fatalf("питомец не вернулся из pull (получили %d) — это тот самый "+
			"класс поломки, когда планшет молча остаётся без данных", len(pets))
	}
	if pets[0]["name"] != "Марсель" {
		t.Errorf("name = %v", pets[0]["name"])
	}
	if pets[0]["chip_number"] != "643094100123456" {
		t.Errorf("номер чипа потерялся: %v", pets[0]["chip_number"])
	}
}

// Поля госучёта ТАҢБА проходят полный цикл. Проверка не формальная: колонка
// photo (NOT NULL DEFAULT '') в паре с nullableString('') уже роняла INSERT,
// и питомцы без фото молча уходили в skipped — push при этом отвечал 200.
func TestSyncCycleTanbaFieldsSurviveRoundTrip(t *testing.T) {
	a := testApp(t)

	res := doPush(t, a, `{
		"owners":[{"id":"o-9","fio":"Хозяин","phone":"+7 700 999 9999",
			"version":1,"updated_at":"2026-09-01T10:00:00Z"}],
		"pets":[{"id":"p-9","owner_id":"o-9","name":"Тайга","type":"dog","gender":"f",
			"chip_number":"643094100999888","chip_date":"2026-08-30T12:00:00Z",
			"id_method":"chip","tanba_number":"KZ-77-001","tanba_at":"2026-09-01T09:00:00Z",
			"keep_address":"Алматы, дача","sterilized":1,"sterilized_at":"2026-05-20T12:00:00Z",
			"version":1,"updated_at":"2026-09-01T10:05:00Z"}]}`)
	if skipped, _ := res["skipped"].(float64); skipped != 0 {
		t.Fatalf("сервер пропустил запись (skipped=%v) — питомец не доехал", res["skipped"])
	}

	pets := doPull(t, a, "")["pets"]
	if len(pets) != 1 {
		t.Fatalf("питомец не вернулся из pull (получили %d)", len(pets))
	}
	p := pets[0]
	for _, c := range []struct{ field, want string }{
		{"id_method", "chip"},
		{"tanba_number", "KZ-77-001"},
		{"keep_address", "Алматы, дача"},
	} {
		if got, _ := p[c.field].(string); got != c.want {
			t.Errorf("%s = %q, ожидалось %q", c.field, got, c.want)
		}
	}
	if v, _ := p["sterilized"].(float64); v != 1 {
		t.Errorf("sterilized = %v, ожидалось 1", p["sterilized"])
	}
	if p["tanba_at"] == nil || p["sterilized_at"] == nil {
		t.Errorf("даты госучёта потерялись: tanba_at=%v sterilized_at=%v", p["tanba_at"], p["sterilized_at"])
	}
}

// Клиент старой версии полей ТАҢБА не шлёт вовсе. Его push не должен стирать
// номер, который в реестре уже есть, — иначе одна синхронизация со старого
// планшета обнулит работу, сделанную вручную на портале.
func TestSyncCycleOldClientKeepsTanbaNumber(t *testing.T) {
	a := testApp(t)

	doPush(t, a, `{
		"owners":[{"id":"o-10","fio":"Хозяин","phone":"+7 700 111 2222",
			"version":1,"updated_at":"2026-09-01T10:00:00Z"}],
		"pets":[{"id":"p-10","owner_id":"o-10","name":"Рекс","type":"dog","gender":"m",
			"chip_number":"643094100777666","tanba_number":"KZ-77-002",
			"version":1,"updated_at":"2026-09-01T10:05:00Z"}]}`)

	// Тот же питомец со старого клиента: полей ТАҢБА в payload нет.
	doPush(t, a, `{
		"pets":[{"id":"p-10","owner_id":"o-10","name":"Рекс Второй","type":"dog","gender":"m",
			"chip_number":"643094100777666",
			"version":2,"updated_at":"2026-09-01T11:00:00Z"}]}`)

	pets := doPull(t, a, "")["pets"]
	if len(pets) != 1 {
		t.Fatalf("ожидали одного питомца, получили %d", len(pets))
	}
	if got, _ := pets[0]["name"].(string); got != "Рекс Второй" {
		t.Errorf("обновление имени не применилось: %q", got)
	}
	if got, _ := pets[0]["tanba_number"].(string); got != "KZ-77-002" {
		t.Errorf("старый клиент затёр номер ТАҢБА: %q", got)
	}
}

// Юрлицо и ИИН владельца проходят полный цикл, а push со старого клиента,
// который owner_type и iin не шлёт, не стирает уже введённый номер.
func TestSyncCycleOwnerTypeAndIIN(t *testing.T) {
	a := testApp(t)

	doPush(t, a, `{
		"owners":[{"id":"o-20","fio":"ОФ Приют Друг","owner_type":"legal",
			"iin":"880101 300123","phone":"+7 727 000 0000","address":"Алматы, Абая 1",
			"version":1,"updated_at":"2026-09-01T10:00:00Z"}]}`)

	owners := doPull(t, a, "")["owners"]
	if len(owners) != 1 {
		t.Fatalf("владелец не вернулся из pull (получили %d)", len(owners))
	}
	if got, _ := owners[0]["owner_type"].(string); got != "legal" {
		t.Errorf("owner_type = %q, ожидалось legal", got)
	}
	// Пробелы из номера должны быть срезаны, иначе поиск дублей его не найдёт.
	if got, _ := owners[0]["iin"].(string); got != "880101300123" {
		t.Errorf("iin = %q, ожидалось 880101300123", got)
	}

	// Старый клиент: полей owner_type и iin в payload нет.
	doPush(t, a, `{
		"owners":[{"id":"o-20","fio":"ОФ Приют Друг","phone":"+7 727 111 1111",
			"version":2,"updated_at":"2026-09-01T11:00:00Z"}]}`)

	owners = doPull(t, a, "")["owners"]
	if got, _ := owners[0]["phone"].(string); got != "+7 727 111 1111" {
		t.Errorf("обновление телефона не применилось: %q", got)
	}
	if got, _ := owners[0]["iin"].(string); got != "880101300123" {
		t.Errorf("старый клиент затёр ИИН: %q", got)
	}
	if got, _ := owners[0]["owner_type"].(string); got != "legal" {
		t.Errorf("старый клиент разжаловал юрлицо в %q", got)
	}
}
