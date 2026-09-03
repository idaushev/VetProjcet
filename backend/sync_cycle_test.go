package main

import (
	"context"
	"encoding/json"
	"fmt"
	"io"
	"log"
	"net/http"
	"net/http/httptest"
	"path/filepath"
	"strings"
	"testing"
	"time"
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
// photo (NOT NULL DEFAULT ”) в паре с nullableString(”) уже роняла INSERT,
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

// Шаблон протокола и результат проходят полный цикл. Проверка не формальная:
// values_json и fields — колонки NOT NULL с JSON по умолчанию, и пустая строка
// от клиента не должна ложиться в базу вместо '{}' — иначе разбор упадёт и на
// планшете, и в кабинете владельца.
func TestSyncCycleResultsSurviveRoundTrip(t *testing.T) {
	a := testApp(t)

	res := doPush(t, a, `{
		"owners":[{"id":"o-30","fio":"Хозяин","phone":"+7 700 300 3000",
			"version":1,"updated_at":"2026-09-01T10:00:00Z"}],
		"pets":[{"id":"p-30","owner_id":"o-30","name":"Рыжик","type":"cat","gender":"m",
			"version":1,"updated_at":"2026-09-01T10:01:00Z"}],
		"visits":[{"id":"v-30","pet_id":"p-30","date":"2026-09-01T11:00:00Z",
			"version":1,"updated_at":"2026-09-01T11:00:00Z"}],
		"protocol_templates":[{"id":"t-30","name":"ОАК","kind":"lab",
			"fields":"[{\"key\":\"hgb\",\"label\":\"Гемоглобин\",\"type\":\"number\",\"ref_low\":80,\"ref_high\":150}]",
			"version":1,"updated_at":"2026-09-01T09:00:00Z"}],
		"visit_results":[{"id":"r-30","visit_id":"v-30","pet_id":"p-30","title":"ОАК",
			"template_id":"t-30","kind":"protocol","values_json":"{\"hgb\":\"200\"}",
			"status":"done","conclusion":"Выше нормы",
			"version":1,"updated_at":"2026-09-01T12:00:00Z"}]}`)
	if skipped, _ := res["skipped"].(float64); skipped != 0 {
		t.Fatalf("сервер пропустил записи (skipped=%v)", res["skipped"])
	}

	data := doPull(t, a, "")
	tpls := data["protocol_templates"]
	if len(tpls) != 1 {
		t.Fatalf("шаблон не вернулся (получили %d)", len(tpls))
	}
	if got, _ := tpls[0]["name"].(string); got != "ОАК" {
		t.Errorf("name шаблона = %q", got)
	}
	if f, _ := tpls[0]["fields"].(string); !strings.Contains(f, "hgb") {
		t.Errorf("поля шаблона потерялись: %q", f)
	}

	results := data["visit_results"]
	if len(results) != 1 {
		t.Fatalf("результат не вернулся (получили %d)", len(results))
	}
	r := results[0]
	if v, _ := r["values_json"].(string); v != `{"hgb":"200"}` {
		t.Errorf("значения протокола потерялись: %q", v)
	}
	if s, _ := r["status"].(string); s != "done" {
		t.Errorf("status = %q, ожидался done", s)
	}
	// filled_at сервер проставляет сам при status=done — по нему кабинет
	// владельца сортирует результаты.
	if r["filled_at"] == nil {
		t.Errorf("filled_at не проставлен для внесённого результата")
	}
}

// Пустой values_json от старого клиента не должен ложиться в базу пустой
// строкой: JSON.parse("") падает и на планшете, и в портале.
func TestSyncCycleResultEmptyJSONBecomesObject(t *testing.T) {
	a := testApp(t)
	doPush(t, a, `{
		"owners":[{"id":"o-31","fio":"Х","phone":"+7 700 1","version":1,"updated_at":"2026-09-01T10:00:00Z"}],
		"pets":[{"id":"p-31","owner_id":"o-31","name":"К","type":"cat","gender":"m","version":1,"updated_at":"2026-09-01T10:00:00Z"}],
		"visits":[{"id":"v-31","pet_id":"p-31","date":"2026-09-01T11:00:00Z","version":1,"updated_at":"2026-09-01T11:00:00Z"}],
		"visit_results":[{"id":"r-31","visit_id":"v-31","pet_id":"p-31","title":"УЗИ",
			"kind":"file","values_json":"","status":"pending",
			"version":1,"updated_at":"2026-09-01T12:00:00Z"}]}`)

	results := doPull(t, a, "")["visit_results"]
	if len(results) != 1 {
		t.Fatalf("результат не вернулся")
	}
	if v, _ := results[0]["values_json"].(string); v != "{}" {
		t.Errorf("values_json = %q, ожидался {}", v)
	}
}

// ─── TECH-001: инкрементальный pull ───────────────────────────────────────────
//
// Клиент после каждого push с изменениями делал ПОЛНУЮ выгрузку всех таблиц
// (pullFull без since) — «чтобы гарантированно не пропустить удалённые».
// Тесты ниже фиксируют, что инкрементальный pull этого не пропускает, и что
// граница since не теряет записи. Без них замена pullFull на pullSync была бы
// заменой известного поведения на предполагаемое.

// pullWithTime отдаёт и записи, и server_time — именно его клиент запоминает
// как точку отсчёта для следующего since.
func pullWithTime(t *testing.T, a *app, since string) (map[string][]map[string]any, string) {
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
	serverTime := ""
	for k, raw := range resp.Data {
		if k == "server_time" {
			_ = json.Unmarshal(raw, &serverTime)
			continue
		}
		var rows []map[string]any
		if json.Unmarshal(raw, &rows) == nil {
			out[k] = rows
		}
	}
	if serverTime == "" {
		t.Fatal("pull не вернул server_time — клиенту нечего запомнить как точку отсчёта")
	}
	return out, serverTime
}

// Удаление, пришедшее push'ем, должно возвращаться инкрементальным pull.
// Ровно это и было причиной полной выгрузки после каждого push.
func TestIncrementalPullReturnsDeletion(t *testing.T) {
	a := testApp(t)

	doPush(t, a, `{"device_id":"dev-1","owners":[{
		"id":"o-del","fio":"Удаляемый","phone":"+7 700 111 1111",
		"version":1,"updated_at":"2026-09-01T10:00:00Z"}]}`)

	_, mark := pullWithTime(t, a, "")

	// Планшет удалил владельца и отправил флаг.
	doPush(t, a, `{"device_id":"dev-1","owners":[{
		"id":"o-del","fio":"Удаляемый","phone":"+7 700 111 1111",
		"is_deleted":1,"deleted_at":"2026-09-01T11:00:00Z",
		"version":2,"updated_at":"2026-09-01T11:00:00Z"}]}`)

	data, _ := pullWithTime(t, a, mark)
	owners := data["owners"]
	if len(owners) != 1 {
		t.Fatalf("инкрементальный pull вернул %d владельцев, ждём 1 (удаление) — "+
			"именно из-за такого пропуска после каждого push шла полная выгрузка", len(owners))
	}
	if fmt.Sprintf("%v", owners[0]["is_deleted"]) != "1" {
		t.Errorf("is_deleted = %v, ждём 1", owners[0]["is_deleted"])
	}
}

// Граница since. Время в базе хранится как RFC3339 с ПЕРЕМЕННЫМ числом знаков
// после точки (формат .999 отбрасывает нули), а сравнение в SQLite —
// текстовое. Поэтому «10:00:00.5Z» строкой МЕНЬШЕ, чем «10:00:00Z», хотя
// хронологически позже. Запись, сделанная сразу после pull, не должна теряться.
func TestIncrementalPullDoesNotLoseRecordsAtBoundary(t *testing.T) {
	a := testApp(t)

	_, mark := pullWithTime(t, a, "")

	// Пишем сразу после отметки — тот самый случай «в пределах той же секунды».
	doPush(t, a, `{"device_id":"dev-1","owners":[{
		"id":"o-edge","fio":"Пограничный","phone":"+7 700 222 2222",
		"version":1,"updated_at":"2026-09-01T10:00:00Z"}]}`)

	data, _ := pullWithTime(t, a, mark)
	if len(data["owners"]) != 1 {
		t.Fatalf("запись, созданная сразу после отметки времени, не вернулась "+
			"инкрементальным pull (получено %d) — планшет её не увидит до полной выгрузки",
			len(data["owners"]))
	}
}

// Несколько сущностей разом: удаление животного и правка приёма должны
// приезжать одним инкрементальным pull, без полной выгрузки.
func TestIncrementalPullCoversSeveralStores(t *testing.T) {
	a := testApp(t)

	doPush(t, a, `{"device_id":"dev-1",
		"owners":[{"id":"o-2","fio":"Хозяин","phone":"+7 700 333 3333","version":1,"updated_at":"2026-09-01T10:00:00Z"}],
		"pets":[{"id":"p-2","owner_id":"o-2","name":"Барсик","type":"cat","gender":"m","version":1,"updated_at":"2026-09-01T10:00:00Z"}],
		"visits":[{"id":"v-2","pet_id":"p-2","date":"2026-09-01T10:00:00Z","version":1,"updated_at":"2026-09-01T10:00:00Z"}]}`)

	// Пауза перед отметкой времени — не «на всякий случай», а по делу.
	// Граница pull ВКЛЮЧАЮЩАЯ (>=), иначе теряется запись, сделанная в ту же
	// миллисекунду, что и отметка. Обратная сторона: запись, сделанная ровно
	// в граничную миллисекунду, приедет повторно. Здесь проверяется другое —
	// что НЕТРОНУТЫЕ записи не едут, — поэтому разводим их с границей во
	// времени, а не полагаемся на то, что миллисекунда не совпадёт.
	time.Sleep(3 * time.Millisecond)
	_, mark := pullWithTime(t, a, "")
	time.Sleep(3 * time.Millisecond)

	doPush(t, a, `{"device_id":"dev-1",
		"pets":[{"id":"p-2","owner_id":"o-2","name":"Барсик","type":"cat","gender":"m",
		         "is_deleted":1,"deleted_at":"2026-09-01T12:00:00Z","version":2,"updated_at":"2026-09-01T12:00:00Z"}],
		"visits":[{"id":"v-2","pet_id":"p-2","date":"2026-09-01T10:00:00Z","diagnosis":"отит",
		           "version":2,"updated_at":"2026-09-01T12:00:00Z"}]}`)

	data, _ := pullWithTime(t, a, mark)
	if len(data["pets"]) != 1 {
		t.Errorf("удаление животного не пришло инкрементально (pets=%d)", len(data["pets"]))
	}
	if len(data["visits"]) != 1 {
		t.Fatalf("правка приёма не пришла инкрементально (visits=%d)", len(data["visits"]))
	}
	if data["visits"][0]["diagnosis"] != "отит" {
		t.Errorf("diagnosis = %v, ждём «отит»", data["visits"][0]["diagnosis"])
	}
	// Владельца не трогали — он приезжать не должен: в этом весь смысл
	// инкрементальности, иначе экономии нет.
	if len(data["owners"]) != 0 {
		t.Errorf("нетронутый владелец приехал повторно (owners=%d) — pull не инкрементален",
			len(data["owners"]))
	}
}

// Формат границы: доля секунды ВСЕГДА три знака, поэтому текстовый порядок
// (а именно так сравнивает SQLite) совпадает с хронологическим. Тест
// детерминирован: не зависит от того, какое время выпало на прогоне.
func TestSinceBoundaryFormatIsLexicographic(t *testing.T) {
	base := time.Date(2026, 9, 3, 7, 27, 12, 0, time.UTC)
	// 190 мс — ровно тот случай, где формат «.999» даёт «.19Z» и ломает порядок.
	cases := []struct {
		ms   int
		want string
	}{
		{0, "2026-09-03T07:27:12.000Z"},
		{100, "2026-09-03T07:27:12.100Z"},
		{190, "2026-09-03T07:27:12.190Z"},
		{193, "2026-09-03T07:27:12.193Z"},
	}
	for _, c := range cases {
		v, err := S(base.Add(time.Duration(c.ms) * time.Millisecond)).Value()
		if err != nil {
			t.Fatalf("S(%d мс): %v", c.ms, err)
		}
		if v != c.want {
			t.Errorf("S(%d мс) = %v, ждём %q", c.ms, v, c.want)
		}
	}

	// Граница 190 мс против записи 193 мс — та самая пара, на которой запись
	// пропадала: строкой «.19Z» больше, чем «.193Z», потому что 'Z' > '3'.
	bound, _ := S(base.Add(190 * time.Millisecond)).Value()
	row, _ := T(base.Add(193 * time.Millisecond)).Value()
	if !(row.(string) > bound.(string)) {
		t.Errorf("запись %q должна быть строкой БОЛЬШЕ границы %q — иначе "+
			"инкрементальный pull её теряет", row, bound)
	}

	// И обратно: запись раньше границы не должна в неё попадать.
	older, _ := T(base.Add(180 * time.Millisecond)).Value()
	if older.(string) > bound.(string) {
		t.Errorf("запись %q старше границы %q, но считается новее", older, bound)
	}
}

// ─── Позиции каталога: колонки и плейсхолдеры ────────────────────────────────
//
// Одна и та же ошибка допущена ТРИЖДЫ: при добавлении result_mode и
// protocol_id колонки дописали, а список значений — нет. В createItem это
// делало невозможным создание позиции (исправлено раньше), в pushItem роняло
// синхронизацию каталога, в updateItem сдвигало аргументы так, что правка
// любой позиции отвечала «item not found». Тест проверяет весь цикл целиком,
// потому что счёт «колонок и вопросиков» глазами уже трижды не сработал.
func TestItemResultModeSurvivesCreateUpdateAndSync(t *testing.T) {
	a := testApp(t)

	// 1. Создание через REST.
	req := httptest.NewRequest(http.MethodPost, "/items", strings.NewReader(
		`{"name":"УЗИ брюшной полости","type":"service","price":6000,
		  "result_mode":"protocol","protocol_id":"tpl-1"}`))
	req = req.WithContext(context.WithValue(req.Context(), ctxKeyUser{},
		&User{ID: "u", Login: "admin", Role: "admin", IsActive: true}))
	rec := httptest.NewRecorder()
	a.handleItems(rec, req)
	if rec.Code != http.StatusCreated {
		t.Fatalf("создание позиции: HTTP %d: %s", rec.Code, rec.Body.String())
	}
	var created struct {
		Data struct {
			ID         string `json:"id"`
			ResultMode string `json:"result_mode"`
			ProtocolID string `json:"protocol_id"`
		} `json:"data"`
	}
	if err := json.Unmarshal(rec.Body.Bytes(), &created); err != nil {
		t.Fatalf("ответ не JSON: %v", err)
	}
	if created.Data.ResultMode != "protocol" {
		t.Errorf("после создания result_mode = %q, ждём protocol", created.Data.ResultMode)
	}
	id := created.Data.ID

	// 2. Правка через REST — раньше отвечала 404 из-за сдвига аргументов.
	req = httptest.NewRequest(http.MethodPut, "/items/"+id, strings.NewReader(
		`{"name":"УЗИ брюшной полости","type":"service","price":6500,
		  "result_mode":"both","protocol_id":"tpl-2"}`))
	req.SetPathValue("id", id)
	req = req.WithContext(context.WithValue(req.Context(), ctxKeyUser{},
		&User{ID: "u", Login: "admin", Role: "admin", IsActive: true}))
	rec = httptest.NewRecorder()
	a.handleItemByID(rec, req)
	if rec.Code != http.StatusOK {
		t.Fatalf("правка позиции: HTTP %d: %s", rec.Code, rec.Body.String())
	}
	var mode, proto string
	if err := a.db.QueryRow(`SELECT COALESCE(result_mode,''), COALESCE(protocol_id,'') FROM items WHERE id=?`, id).
		Scan(&mode, &proto); err != nil {
		t.Fatalf("чтение после правки: %v", err)
	}
	if mode != "both" || proto != "tpl-2" {
		t.Errorf("после правки result_mode=%q protocol_id=%q, ждём both/tpl-2", mode, proto)
	}

	// 3. Синхронизация с планшета — раньше падала на несовпадении
	//    числа колонок и плейсхолдеров, то есть каталог не синхронизировался.
	doPush(t, a, `{"device_id":"dev-1","items":[{
		"id":"i-sync","name":"Рентген","type":"service","price":4000,
		"result_mode":"file","protocol_id":"tpl-3","is_active":true,
		"version":1,"updated_at":"2026-09-01T10:00:00Z"}]}`)
	if err := a.db.QueryRow(`SELECT COALESCE(result_mode,''), COALESCE(protocol_id,'') FROM items WHERE id='i-sync'`).
		Scan(&mode, &proto); err != nil {
		t.Fatalf("позиция не доехала синхронизацией: %v", err)
	}
	if mode != "file" || proto != "tpl-3" {
		t.Errorf("после синка result_mode=%q protocol_id=%q, ждём file/tpl-3", mode, proto)
	}
}

// ─── Жизненный цикл результата услуги ────────────────────────────────────────
//
// Сценарий из жалобы: услуга с протоколом добавлена в приём, строка результата
// заведена, потом позицию из счёта убрали. Незаполненная строка должна
// удаляться, ЗАПОЛНЕННАЯ — оставаться: исследование сделали и записали, и
// стирать медицинскую запись вслед за строкой счёта нельзя.
func TestVisitResultLifecycle(t *testing.T) {
	a := testApp(t)

	doPush(t, a, `{"device_id":"dev-1",
		"owners":[{"id":"o-r","fio":"Хозяин","phone":"+7 700 111 0000","version":1,"updated_at":"2026-09-01T10:00:00Z"}],
		"pets":[{"id":"p-r","owner_id":"o-r","name":"Рекс","type":"dog","gender":"m","version":1,"updated_at":"2026-09-01T10:00:00Z"}],
		"visits":[{"id":"v-r","pet_id":"p-r","date":"2026-09-01T10:00:00Z","version":1,"updated_at":"2026-09-01T10:00:00Z"}],
		"visit_results":[
		  {"id":"r-pending","visit_id":"v-r","pet_id":"p-r","item_id":"i-uzi","title":"УЗИ",
		   "kind":"protocol","status":"pending","values":"{}","version":1,"updated_at":"2026-09-01T10:00:00Z"},
		  {"id":"r-done","visit_id":"v-r","pet_id":"p-r","item_id":"i-blood","title":"Кровь",
		   "kind":"protocol","status":"done","values":"{\"hgb\":\"120\"}","conclusion":"норма",
		   "lab_name":"Своя лаборатория","version":1,"updated_at":"2026-09-01T10:00:00Z"}]}`)

	var pending, done, lab, concl string
	if err := a.db.QueryRow(`SELECT status FROM visit_results WHERE id='r-pending'`).Scan(&pending); err != nil {
		t.Fatalf("ожидающий результат не доехал: %v", err)
	}
	if err := a.db.QueryRow(`SELECT status, COALESCE(lab_name,''), COALESCE(conclusion,'')
	                         FROM visit_results WHERE id='r-done'`).Scan(&done, &lab, &concl); err != nil {
		t.Fatalf("заполненный результат не доехал: %v", err)
	}
	if pending != "pending" || done != "done" {
		t.Errorf("статусы: pending=%q done=%q", pending, done)
	}
	if lab != "Своя лаборатория" || concl != "норма" {
		t.Errorf("заполненный результат потерял данные: lab=%q concl=%q", lab, concl)
	}

	// Клиент удаляет незаполненную строку (услугу убрали из счёта) и НЕ трогает
	// заполненную. Удаление приезжает флагом, как любое другое.
	doPush(t, a, `{"device_id":"dev-1","visit_results":[
		{"id":"r-pending","visit_id":"v-r","pet_id":"p-r","item_id":"i-uzi","title":"УЗИ",
		 "kind":"protocol","status":"pending","values":"{}",
		 "is_deleted":1,"deleted_at":"2026-09-01T12:00:00Z",
		 "version":2,"updated_at":"2026-09-01T12:00:00Z"}]}`)

	var delPending, delDone int
	a.db.QueryRow(`SELECT is_deleted FROM visit_results WHERE id='r-pending'`).Scan(&delPending)
	a.db.QueryRow(`SELECT is_deleted FROM visit_results WHERE id='r-done'`).Scan(&delDone)
	if delPending != 1 {
		t.Errorf("незаполненный результат не удалён (is_deleted=%d)", delPending)
	}
	if delDone != 0 {
		t.Errorf("ЗАПОЛНЕННЫЙ результат удалён вместе со строкой счёта — "+
			"потеряна медицинская запись (is_deleted=%d)", delDone)
	}

	// Значения протокола и лаборатория переживают синхронизацию туда-обратно.
	data := doPull(t, a, "")
	var foundDone bool
	for _, r := range data["visit_results"] {
		if r["id"] == "r-done" {
			foundDone = true
			if r["lab_name"] != "Своя лаборатория" {
				t.Errorf("lab_name после pull = %v", r["lab_name"])
			}
			if r["values"] == nil && r["values_json"] == nil {
				t.Error("значения протокола не вернулись")
			}
		}
	}
	if !foundDone {
		t.Error("заполненный результат не вернулся инкрементальным pull")
	}
}
