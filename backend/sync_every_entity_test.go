package main

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
)

// Каждая сущность реестра синка принимает push своей записи и отдаёт её при
// pull. Тест ловит целый класс ошибок, который в проекте повторялся: список
// колонок и список значений в SQL разошлись (правило 3). Так push сотрудников
// месяц отклонял каждую запись (B-009): в INSERT 15 колонок, значений 14,
// ошибка уходила в лог, а на планшете запись считалась отправленной.
//
// Новая сущность в реестре без примера здесь валит тест — пример обязателен.
var entitySamples = map[string]string{
	"owners":              `{"id":"e-o","fio":"Хозяин","phone":"+7 700 800 8000"}`,
	"pets":                `{"id":"e-p","owner_id":"e-o","name":"Бобик","type":"dog","gender":"m"}`,
	"items":               `{"id":"e-i","name":"Осмотр","type":"service","price":5000}`,
	"visits":              `{"id":"e-v","pet_id":"e-p","date":"2026-09-01T11:00:00Z","total_amount":5000}`,
	"visit_items":         `{"id":"e-vi","visit_id":"e-v","item_id":"e-i","name":"Осмотр","type":"service","quantity":1,"price":5000,"total":5000}`,
	"prescriptions":       `{"id":"e-rx","visit_id":"e-v","pet_id":"e-p","drug_name":"Церукал","dose":0.5,"dose_unit":"мл"}`,
	"vaccinations":        `{"id":"e-vac","pet_id":"e-p","vaccine_name":"Нобивак","administered_at":"2026-09-01"}`,
	"staff":               `{"id":"e-s","name":"Врач","role":"vet","is_active":true,"photo":"data:image/png;base64,AAAA"}`,
	"appointments":        `{"id":"e-ap","pet_id":"e-p","starts_at":"2026-09-02T10:00:00Z","status":"scheduled"}`,
	"tasks":               `{"id":"e-t","title":"Позвонить владельцу"}`,
	"diagnosis_templates": `{"id":"e-dt","name":"Гастрит","treatment":"Диета"}`,
	"protocol_templates":  `{"id":"e-pt","name":"ОАК","kind":"lab","fields":"[]"}`,
	"visit_results":       `{"id":"e-vr","visit_id":"e-v","pet_id":"e-p","title":"ОАК","kind":"text","status":"pending"}`,
	"warehouses":          `{"id":"e-w","name":"Основной"}`,
	"stock_movements":     `{"id":"e-sm","warehouse_id":"e-w","item_id":"e-i","kind":"purchase","quantity":10,"occurred_at":"2026-09-01T09:00:00Z"}`,
}

func TestEverySyncEntityPushesAndPulls(t *testing.T) {
	a := testApp(t)
	for _, e := range syncEntities() {
		if e.pushAll == nil {
			continue // только pull (вложения)
		}
		sample, ok := entitySamples[e.Name]
		if !ok {
			t.Errorf("%s: нет примера записи в entitySamples — добавьте", e.Name)
			continue
		}
		// Сущности идут в порядке реестра (внешние ключи), по одной на push:
		// так отказ указывает ровно на свою сущность.
		rec := strings.TrimSuffix(sample, "}") +
			`,"version":1,"updated_at":"2026-09-01T12:00:00Z","device_id":"dev-e"}`
		res := doPush(t, a, `{"`+e.Name+`":[`+rec+`]}`)
		if acc, _ := res["accepted"].(float64); acc != 1 {
			t.Errorf("%s: push не принят (%v) — сверьте колонки и значения в push%s",
				e.Name, res, e.Name)
		}
	}

	data := doPull(t, a, "")
	for name, sample := range entitySamples {
		var want struct{ ID string `json:"id"` }
		_ = json.Unmarshal([]byte(sample), &want)
		found := false
		for _, row := range data[name] {
			if row["id"] == want.ID {
				found = true
			}
		}
		if !found {
			t.Errorf("%s: запись %s не вернулась в pull", name, want.ID)
		}
	}
}

// B-009: фото сотрудника доезжает, а пустое фото от старого планшета не
// стирает серверное.
func TestStaffPushKeepsPhoto(t *testing.T) {
	a := testApp(t)
	doPush(t, a, `{"staff":[{"id":"s-1","name":"Врач","role":"vet","is_active":true,
		"photo":"data:image/png;base64,AAAA","version":1,"updated_at":"2026-09-01T10:00:00Z"}]}`)
	res := doPush(t, a, `{"staff":[{"id":"s-1","name":"Врач Иванова","role":"vet","is_active":true,
		"photo":"","version":2,"updated_at":"2026-09-01T11:00:00Z"}]}`)
	if acc, _ := res["accepted"].(float64); acc != 1 {
		t.Fatalf("правка сотрудника не принята: %v", res)
	}
	var name, photo string
	a.db.QueryRow(`SELECT name, COALESCE(photo,'') FROM clinic_staff WHERE id='s-1'`).Scan(&name, &photo)
	if name != "Врач Иванова" {
		t.Errorf("имя не обновилось: %q", name)
	}
	if photo != "data:image/png;base64,AAAA" {
		t.Errorf("пустое фото стёрло серверное: %q", photo)
	}
}

// Новый врач и его первый приём уходят одним push — как с планшета, где
// сотрудника завели и тут же приняли пациента. Приём, позиция, назначение и
// вакцинация ссылаются на врача внешним ключом: сотрудник должен пройти
// раньше. Раньше в реестре он стоял после приёмов, и всё это отклонялось.
func TestNewStaffAndHisVisitInOnePush(t *testing.T) {
	a := testApp(t)
	const at = `"version":1,"updated_at":"2026-09-01T12:00:00Z","device_id":"dev-n"`
	res := doPush(t, a, `{
		"owners":[{"id":"n-o","fio":"Хозяин","phone":"+7 700 900 9000",`+at+`}],
		"pets":[{"id":"n-p","owner_id":"n-o","name":"Рекс","type":"dog","gender":"m",`+at+`}],
		"items":[{"id":"n-i","name":"Осмотр","type":"service","price":5000,`+at+`}],
		"staff":[{"id":"n-s","name":"Новый врач","role":"vet","is_active":true,`+at+`}],
		"visits":[{"id":"n-v","pet_id":"n-p","staff_id":"n-s","date":"2026-09-01T11:00:00Z","total_amount":5000,`+at+`}],
		"visit_items":[{"id":"n-vi","visit_id":"n-v","item_id":"n-i","name":"Осмотр","type":"service","quantity":1,"price":5000,"total":5000,`+at+`}],
		"prescriptions":[{"id":"n-rx","visit_id":"n-v","pet_id":"n-p","staff_id":"n-s","drug_name":"Церукал","dose":0.5,"dose_unit":"мл",`+at+`}],
		"vaccinations":[{"id":"n-vac","pet_id":"n-p","staff_id":"n-s","visit_id":"n-v","vaccine_name":"Нобивак","administered_at":"2026-09-01",`+at+`}]}`)
	if skipped(res) != 0 {
		t.Fatalf("часть записей отклонена: %v", res)
	}
	if acc, _ := res["accepted"].(float64); acc != 8 {
		t.Errorf("принято %v из 8", res["accepted"])
	}
}

// B-013. Сервер сообщает, какие записи не смог принять: планшет держит их
// неотправленными. «Сервер новее» — по-прежнему skipped, не отказ.
func TestPushReportsRejectedRecords(t *testing.T) {
	a := testApp(t)
	const at = `"version":1,"updated_at":"2026-09-01T12:00:00Z"`
	res := doPush(t, a, `{
		"owners":[{"id":"r-o","fio":"Хозяин","phone":"+7 700 111 0000",`+at+`}],
		"pets":[{"id":"r-p","owner_id":"r-o","name":"Шарик","type":"dog","gender":"m",`+at+`},
		        {"id":"r-orphan","owner_id":"нет-такого","name":"Ничей","type":"cat","gender":"f",`+at+`}],
		"prescriptions":[{"id":"r-bad","visit_id":"x","pet_id":"r-p","dose":"полтаблетки",`+at+`}]}`)

	if acc, _ := res["accepted"].(float64); acc != 2 {
		t.Errorf("валидные записи: принято %v, ждём 2 (владелец и Шарик)", res["accepted"])
	}
	got := map[string]string{}
	list, _ := res["rejected"].([]any)
	for _, x := range list {
		m := x.(map[string]any)
		got[m["entity"].(string)+":"+m["id"].(string)] = m["reason"].(string)
	}
	if r := got["pets:r-orphan"]; !strings.Contains(r, "нет связанной записи") {
		t.Errorf("животное без владельца: причина %q, ждём про связанную запись", r)
	}
	if r := got["prescriptions:r-bad"]; !strings.Contains(r, "не разобрана") {
		t.Errorf("неразборная запись: причина %q", r)
	}
	if len(got) != 2 {
		t.Errorf("отказов %d, ждём 2: %v", len(got), got)
	}
	if skipped(res) != 0 {
		t.Errorf("отказы не должны считаться skipped: %v", res["skipped"])
	}

	// Повтор той же отклонённой записи — снова отказ, без дублей и мусора.
	res = doPush(t, a, `{"pets":[{"id":"r-orphan","owner_id":"нет-такого","name":"Ничей","type":"cat","gender":"f",`+at+`}]}`)
	if l, _ := res["rejected"].([]any); len(l) != 1 {
		t.Errorf("повтор: отказов %d, ждём 1", len(l))
	}

	// Сервер новее — skipped, не отказ.
	doPush(t, a, `{"owners":[{"id":"r-o","fio":"Хозяин новый","phone":"+7 700 111 0000","version":5,"updated_at":"2026-09-02T12:00:00Z"}]}`)
	res = doPush(t, a, `{"owners":[{"id":"r-o","fio":"Хозяин старый","phone":"+7 700 111 0000","version":2,"updated_at":"2026-09-01T13:00:00Z"}]}`)
	if skipped(res) != 1 || res["rejected"] != nil {
		t.Errorf("устаревшая правка: ждём skipped=1 без отказов, получили %v", res)
	}
}

// Нет права на запись — отказ с причиной, а не молчаливый skipped.
func TestPushWithoutRightIsRejected(t *testing.T) {
	a := testApp(t)
	req := httptest.NewRequest(http.MethodPost, "/sync/push", strings.NewReader(
		`{"owners":[{"id":"np-o","fio":"Х","phone":"+7 700 222 0000","version":1,"updated_at":"2026-09-01T12:00:00Z"}]}`))
	viewer := &User{ID: "v", Login: "viewer", Role: "reception", IsActive: true,
		Permissions: []byte(`{"tables":{"owners":"view"}}`)}
	req = req.WithContext(context.WithValue(req.Context(), ctxKeyUser{}, viewer))
	rec := httptest.NewRecorder()
	a.handleSyncPush(rec, req)
	if !strings.Contains(rec.Body.String(), `"reason":"нет права на запись","permanent":true`) {
		t.Errorf("отказ по праву не сообщён: %s", rec.Body.String())
	}
}

// B-017. Чтение животного по REST (список, по id и изнутри создания приёма)
// идёт тем же списком колонок, что pull. Своя копия запроса разошлась со
// scanPetRow (аллергии, VET-013), и с 2026-09-03 любое такое чтение падало:
// REST-создание и правка приёма отвечали «pet not found».
func TestPetReadableByREST(t *testing.T) {
	a := testApp(t)
	doPush(t, a, `{"owners":[{"id":"pr-o","fio":"Х","phone":"+7 700 444 0000","version":1,"updated_at":"2026-09-01T12:00:00Z"}],
		"pets":[{"id":"pr-p","owner_id":"pr-o","name":"Бим","type":"dog","gender":"m","allergies":"пенициллин","version":1,"updated_at":"2026-09-01T12:00:00Z"}]}`)
	p, err := a.getPetByID(context.Background(), "pr-p")
	if err != nil || p.Allergies != "пенициллин" {
		t.Fatalf("getPetByID: %v, аллергии %q", err, p.Allergies)
	}
	rec := httptest.NewRecorder()
	a.handlePets(rec, httptest.NewRequest(http.MethodGet, "/pets", nil))
	if rec.Code != http.StatusOK || !strings.Contains(rec.Body.String(), "пенициллин") {
		t.Errorf("GET /pets: HTTP %d %s", rec.Code, rec.Body.String())
	}
}

// Правило 3 для чтения: каждый REST GET сущностей отвечает 200 на данных,
// пришедших синком. Своя копия списка колонок в обработчике расходится со
// scan-функцией незаметно (B-017) — этот тест ловит весь класс разом.
func TestRESTReadsWorkOnSyncedData(t *testing.T) {
	a := testApp(t)
	for _, e := range syncEntities() {
		if e.pushAll == nil {
			continue
		}
		rec := strings.TrimSuffix(entitySamples[e.Name], "}") +
			`,"version":1,"updated_at":"2026-09-01T12:00:00Z","device_id":"dev-e"}`
		doPush(t, a, `{"`+e.Name+`":[`+rec+`]}`)
	}
	admin := &User{ID: "adm", Login: "admin", Role: "admin", IsActive: true}
	type route struct {
		path string
		h    http.HandlerFunc
		id   string
	}
	routes := []route{
		{"/items", a.handleItems, ""}, {"/items/e-i", a.handleItemByID, "e-i"},
		{"/owners", a.handleOwners, ""}, {"/owners/e-o", a.handleOwnerByID, "e-o"},
		{"/pets", a.handlePets, ""}, {"/pets/e-p", a.handlePetByID, "e-p"},
		{"/visits", a.handleVisits, ""}, {"/visits/e-v", a.handleVisitByID, "e-v"},
		{"/visit-items", a.handleVisitItems, ""},
		{"/prescriptions", a.handlePrescriptions, ""},
		{"/vaccinations", a.handleVaccinations, ""}, {"/vaccinations/e-vac", a.handleVaccinationByID, "e-vac"},
		{"/appointments", a.handleAppointments, ""},
		{"/staff", a.handleStaff, ""}, {"/staff/e-s", a.handleStaffByID, "e-s"},
		{"/tasks", a.handleTasks, ""}, {"/protocols", a.handleProtocols, ""},
		{"/results", a.handleResults, ""}, {"/diagnoses", a.handleDiagnoses, ""},
	}
	for _, rt := range routes {
		req := httptest.NewRequest(http.MethodGet, rt.path, nil)
		if rt.id != "" {
			req.SetPathValue("id", rt.id)
		}
		req = req.WithContext(context.WithValue(req.Context(), ctxKeyUser{}, admin))
		w := httptest.NewRecorder()
		rt.h(w, req)
		if w.Code != http.StatusOK {
			t.Errorf("GET %s: HTTP %d %s", rt.path, w.Code, w.Body.String())
		}
	}
}
