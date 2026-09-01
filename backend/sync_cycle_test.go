package main

import (
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
func doPush(t *testing.T, a *app, payload string) map[string]any {
	t.Helper()
	req := httptest.NewRequest(http.MethodPost, "/sync/push", strings.NewReader(payload))
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
