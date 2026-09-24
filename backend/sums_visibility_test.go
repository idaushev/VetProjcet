package main

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
)

// canSeeSum/seesAllSums решают, какие денежные поля попадут на устройство
// (см. maskForeignSums в handlers_sync.go). Логика зеркалит клиентский
// canSeeSum — расхождение открыло бы чужие суммы, поэтому закрываем тестом.

func userWithSums(sums string, staffID string, selected ...string) *User {
	perm := map[string]any{"sums": sums}
	if len(selected) > 0 {
		perm["sums_staff"] = selected
	}
	raw, _ := json.Marshal(perm)
	return &User{Role: "reception", StaffID: staffID, Permissions: raw}
}

func TestSeesAllSums(t *testing.T) {
	if !(&User{Role: "admin"}).seesAllSums() {
		t.Error("админ должен видеть все суммы")
	}
	if !userWithSums("all", "s1").seesAllSums() {
		t.Error(`scope "all" — все суммы`)
	}
	if !(&User{Role: "reception"}).seesAllSums() {
		t.Error("пустой scope трактуется как «все»")
	}
	if userWithSums("own", "s1").seesAllSums() {
		t.Error(`scope "own" не должен видеть все суммы`)
	}
	if userWithSums("selected", "s1", "s2").seesAllSums() {
		t.Error(`scope "selected" не должен видеть все суммы`)
	}
}

func TestCanSeeSumOwn(t *testing.T) {
	u := userWithSums("own", "docA")
	if !u.canSeeSum("docA") {
		t.Error("свой визит (docA) должен быть виден")
	}
	if u.canSeeSum("docB") {
		t.Error("чужой визит (docB) виден быть не должен")
	}
	if u.canSeeSum("") {
		t.Error("визит без врача не свой — скрыть")
	}
}

func TestCanSeeSumSelected(t *testing.T) {
	u := userWithSums("selected", "me", "docB", "docC")
	for _, id := range []string{"docB", "docC"} {
		if !u.canSeeSum(id) {
			t.Errorf("врач %s в списке — суммы видны", id)
		}
	}
	if u.canSeeSum("docX") {
		t.Error("врач вне списка — суммы скрыть")
	}
}

func TestCanSeeSumAdminAndAll(t *testing.T) {
	if !(&User{Role: "admin"}).canSeeSum("anyone") {
		t.Error("админ видит любые суммы")
	}
	if !userWithSums("all", "me").canSeeSum("someoneElse") {
		t.Error(`scope "all" видит любые суммы`)
	}
}

// VET-017: проигравшая версия приёма в conflict_json несёт суммы целиком —
// маскируются по врачу каждой версии, а не только поля самого приёма.
func TestConflictSumsMaskedPerVersion(t *testing.T) {
	u := userWithSums("own", "docA")
	cj := `[{"detected_at":"t1","staff_id":"docA","total_amount":100,"payment_card":50,"discount":10,"discount_reason":"свой"},
	        {"detected_at":"t2","staff_id":"docB","total_amount":200,"payment_card":70,"discount":20,"discount_reason":"чужой"},
	        {"detected_at":"t3","total_amount":300}]`
	var got []conflictEntry
	if err := json.Unmarshal([]byte(maskConflictSums(u, cj, "docB")), &got); err != nil || len(got) != 3 {
		t.Fatalf("маскировка сломала JSON: %v %+v", err, got)
	}
	if got[0].TotalAmount != 100 || got[0].DiscountReason != "свой" {
		t.Errorf("своя версия замаскирована: %+v", got[0])
	}
	if got[1].TotalAmount != 0 || got[1].PaymentCard != 0 || got[1].Discount != 0 || got[1].DiscountReason != "" {
		t.Errorf("версия чужого врача не замаскирована: %+v", got[1])
	}
	if got[2].TotalAmount != 0 {
		t.Errorf("версия без врача — по врачу приёма (чужой), не замаскирована: %+v", got[2])
	}
	// B-008: у проигравшей строки счёта чужого приёма цена и итог тоже скрыты.
	var withItem []conflictEntry
	_ = json.Unmarshal([]byte(maskConflictSums(u, `[{"detected_at":"t4","item":{"id":"i","name":"УЗИ","quantity":1,"price":7500,"total":7500}}]`, "docB")), &withItem)
	if len(withItem) != 1 || withItem[0].Item == nil || withItem[0].Item.Price != 0 || withItem[0].Item.Total != 0 {
		t.Errorf("цена строки в конфликте чужого приёма не скрыта: %+v", withItem)
	}
	if maskConflictSums(u, "не JSON", "docA") != "" {
		t.Error("неразборный conflict_json отдан без проверки")
	}
}

// Сквозная проверка: pull от имени врача с правом «свои суммы» не отдаёт
// чужие деньги внутри conflict_json.
func TestPullMasksConflictSums(t *testing.T) {
	a := concSeed(t)
	// Сотрудников — прямо в базу: push сотрудников сейчас сломан (B-009).
	if _, err := a.db.Exec(`INSERT INTO clinic_staff (id, name) VALUES ('docA','А'), ('docB','Б')`); err != nil {
		t.Fatal(err)
	}
	doPush(t, a, `{"visits":[{"id":"v-c","pet_id":"p-c","staff_id":"docB","date":"`+concBase+`","diagnosis":"Гастрит",
		"total_amount":7000,"version":2,"base_version":1,"device_id":"tab-b","updated_at":"`+concB+`"}]}`)
	doPush(t, a, `{"visits":[{"id":"v-c","pet_id":"p-c","staff_id":"docB","date":"`+concBase+`","diagnosis":"Гастроэнтерит",
		"total_amount":9000,"discount":500,"discount_reason":"постоянный","version":2,"base_version":1,"device_id":"tab-a","updated_at":"`+concA+`"}]}`)
	if _, lost := visitConflicts(t, a); len(lost) != 1 || lost[0].TotalAmount != 9000 {
		t.Fatalf("на сервере конфликт с суммой 9000, получили %+v", lost)
	}

	doc := userWithSums("own", "docA")
	doc.ID = "u-doc"
	for _, v := range pullAs(t, a, doc, "")["visits"] {
		if v["id"] != "v-c" {
			continue
		}
		var lost []conflictEntry
		cj, _ := v["conflict_json"].(string)
		if json.Unmarshal([]byte(cj), &lost) != nil || len(lost) != 1 {
			t.Fatalf("conflict_json не доехал: %q", cj)
		}
		if lost[0].TotalAmount != 0 || lost[0].Discount != 0 || lost[0].DiscountReason != "" {
			t.Errorf("чужие суммы в conflict_json отданы врачу: %+v", lost[0])
		}
		if lost[0].Diagnosis != "Гастроэнтерит" {
			t.Errorf("маскировка задела медицинскую часть: %+v", lost[0])
		}
		return
	}
	t.Fatal("приём не пришёл в pull")
}

// B-010. REST-чтение приёмов маскирует чужие суммы так же, как /sync/pull:
// раньше GET /visits отдавал их любому, у кого есть право на приёмы.
func TestRESTMasksForeignSums(t *testing.T) {
	a := testApp(t)
	if _, err := a.db.Exec(`INSERT INTO clinic_staff (id, name) VALUES ('docA','А'), ('docB','Б')`); err != nil {
		t.Fatal(err)
	}
	const at = `"version":1,"updated_at":"2026-09-01T12:00:00Z"`
	doPush(t, a, `{
		"owners":[{"id":"m-o","fio":"Хозяин","phone":"+7 700 333 0000",`+at+`}],
		"pets":[{"id":"m-p","owner_id":"m-o","name":"Мурзик","type":"cat","gender":"m",`+at+`}],
		"visits":[{"id":"v-own","pet_id":"m-p","staff_id":"docA","date":"2026-09-01T10:00:00Z","total_amount":1000,"payment_card":1000,`+at+`},
		          {"id":"v-foreign","pet_id":"m-p","staff_id":"docB","date":"2026-09-01T11:00:00Z","total_amount":7000,"discount":500,"discount_reason":"постоянный",`+at+`}],
		"visit_items":[{"id":"i-own","visit_id":"v-own","name":"Осмотр","type":"service","quantity":1,"price":1000,"total":1000,`+at+`},
		               {"id":"i-foreign","visit_id":"v-foreign","name":"УЗИ","type":"service","quantity":1,"price":7500,"total":7500,`+at+`}]}`)

	get := func(u *User, path string) string {
		req := httptest.NewRequest(http.MethodGet, path, nil)
		if i := strings.Index(path, "/visits/"); i >= 0 {
			req.SetPathValue("id", path[i+len("/visits/"):])
		}
		req = req.WithContext(context.WithValue(req.Context(), ctxKeyUser{}, u))
		rec := httptest.NewRecorder()
		switch {
		case strings.HasPrefix(path, "/visits/"):
			a.handleVisitByID(rec, req)
		case strings.HasPrefix(path, "/visit-items"):
			a.handleVisitItems(rec, req)
		default:
			a.handleVisits(rec, req)
		}
		if rec.Code != http.StatusOK {
			t.Fatalf("%s: HTTP %d %s", path, rec.Code, rec.Body.String())
		}
		return rec.Body.String()
	}

	doc := userWithSums("own", "docA")
	for _, path := range []string{"/visits", "/visits/v-foreign", "/visit-items"} {
		body := get(doc, path)
		for _, leak := range []string{"7000", "7500", "постоянный"} {
			if strings.Contains(body, leak) {
				t.Errorf("%s: врачу с правом «свои» отдано %q", path, leak)
			}
		}
	}
	if body := get(doc, "/visits/v-own"); !strings.Contains(body, `"total_amount":1000`) {
		t.Errorf("свой приём замаскирован: %s", body)
	}
	if body := get(userWithSums("all", "docA"), "/visits"); !strings.Contains(body, "7000") {
		t.Error("право «все суммы» не видит чужую сумму")
	}

	// Ответ на правку чужого приёма тоже маскируется: в conflict_json лежат
	// суммы проигравших версий.
	a.db.Exec(`UPDATE visits SET conflict_json=? WHERE id='v-foreign'`,
		`[{"detected_at":"t","staff_id":"docB","total_amount":8888,"discount_reason":"секрет"}]`)
	req := httptest.NewRequest(http.MethodPut, "/visits/v-foreign", strings.NewReader(
		`{"pet_id":"m-p","staff_id":"docB","date":"2026-09-01T11:00:00Z","diagnosis":"Гастрит","total_amount":0}`))
	req.SetPathValue("id", "v-foreign")
	req = req.WithContext(context.WithValue(req.Context(), ctxKeyUser{}, doc))
	rec := httptest.NewRecorder()
	a.handleVisitByID(rec, req)
	if rec.Code != http.StatusOK {
		t.Fatalf("PUT: HTTP %d %s", rec.Code, rec.Body.String())
	}
	if b := rec.Body.String(); strings.Contains(b, "8888") || strings.Contains(b, "секрет") {
		t.Errorf("ответ PUT отдал чужие суммы из conflict_json: %s", b)
	}
}

// doPushAs — push от имени пользователя (doPush шлёт от админа).
func doPushAs(t *testing.T, a *app, u *User, payload string) {
	t.Helper()
	req := httptest.NewRequest(http.MethodPost, "/sync/push", strings.NewReader(payload))
	req = req.WithContext(context.WithValue(req.Context(), ctxKeyUser{}, u))
	rec := httptest.NewRecorder()
	a.handleSyncPush(rec, req)
	if rec.Code != http.StatusOK {
		t.Fatalf("push HTTP %d: %s", rec.Code, rec.Body.String())
	}
}

// B-016. Врач с правом «свои суммы» получает чужой приём с нулями вместо сумм;
// поправив в нём диагноз, он шлёт эти нули назад. Сервер не должен их
// записывать: суммы и цены чужого приёма остаются прежними.
func TestHiddenSumsNotOverwritten(t *testing.T) {
	a := testApp(t)
	if _, err := a.db.Exec(`INSERT INTO clinic_staff (id, name) VALUES ('docA','А'), ('docB','Б')`); err != nil {
		t.Fatal(err)
	}
	const at = `"version":1,"updated_at":"2026-09-01T12:00:00Z"`
	doPush(t, a, `{
		"owners":[{"id":"h-o","fio":"Х","phone":"+7 700 555 0000",`+at+`}],
		"pets":[{"id":"h-p","owner_id":"h-o","name":"Рыжик","type":"cat","gender":"m",`+at+`}],
		"visits":[{"id":"h-v","pet_id":"h-p","staff_id":"docB","date":"2026-09-01T11:00:00Z","diagnosis":"Гастрит",
			"total_amount":7000,"discount":500,"discount_reason":"постоянный","payment_card":2000,`+at+`}],
		"visit_items":[{"id":"h-i","visit_id":"h-v","name":"УЗИ","type":"service","quantity":1,"price":7500,"total":7500,`+at+`}]}`)

	doc := userWithSums("own", "docA")
	doc.ID = "u-doc"
	// Планшет врача А: диагноз поправлен, суммы — замаскированные нули;
	// количество в позиции увеличено, цена — ноль.
	doPushAs(t, a, doc, `{
		"visits":[{"id":"h-v","pet_id":"h-p","staff_id":"docB","date":"2026-09-01T11:00:00Z","diagnosis":"Гастроэнтерит",
			"total_amount":0,"discount":0,"discount_reason":"","payment_card":0,"version":2,"updated_at":"2026-09-01T13:00:00Z"}],
		"visit_items":[{"id":"h-i","visit_id":"h-v","name":"УЗИ","type":"service","quantity":2,"price":0,"total":0,"version":2,"updated_at":"2026-09-01T13:00:00Z"}]}`)

	var diag, reason string
	var total, disc, card, price, itotal, qty float64
	a.db.QueryRow(`SELECT diagnosis, total_amount, discount, discount_reason, payment_card FROM visits WHERE id='h-v'`).
		Scan(&diag, &total, &disc, &reason, &card)
	a.db.QueryRow(`SELECT quantity, price, total FROM visit_items WHERE id='h-i'`).Scan(&qty, &price, &itotal)
	if diag != "Гастроэнтерит" {
		t.Errorf("медицинская правка не применена: %q", diag)
	}
	// Итог — по позициям: 2 × 7500 − скидка 500. Скидка и карта — серверные.
	if total != 14500 || disc != 500 || reason != "постоянный" || card != 2000 {
		t.Errorf("push: сумма %v (ждём 14500 по позициям), скидка %v %q, карта %v", total, disc, reason, card)
	}
	if qty != 2 || price != 7500 || itotal != 15000 {
		t.Errorf("позиция: количество %v, цена %v, итог %v — ждём 2 × 7500 = 15000", qty, price, itotal)
	}

	// REST-правка — то же правило.
	req := httptest.NewRequest(http.MethodPut, "/visits/h-v", strings.NewReader(
		`{"pet_id":"h-p","staff_id":"docB","date":"2026-09-01T11:00:00Z","diagnosis":"Панкреатит","total_amount":0}`))
	req.SetPathValue("id", "h-v")
	req = req.WithContext(context.WithValue(req.Context(), ctxKeyUser{}, doc))
	rec := httptest.NewRecorder()
	a.handleVisitByID(rec, req)
	a.db.QueryRow(`SELECT diagnosis, total_amount FROM visits WHERE id='h-v'`).Scan(&diag, &total)
	if rec.Code != http.StatusOK || diag != "Панкреатит" || total != 14500 {
		t.Errorf("REST: HTTP %d, диагноз %q, сумма %v — ждём 14500", rec.Code, diag, total)
	}

	// Свой приём и новый приём — суммы пишущего принимаются.
	doPushAs(t, a, doc, `{"visits":[
		{"id":"h-own","pet_id":"h-p","staff_id":"docA","date":"2026-09-02T11:00:00Z","total_amount":3000,`+at+`},
		{"id":"h-new","pet_id":"h-p","staff_id":"docB","date":"2026-09-02T12:00:00Z","total_amount":4000,`+at+`}]}`)
	var own, fresh float64
	a.db.QueryRow(`SELECT total_amount FROM visits WHERE id='h-own'`).Scan(&own)
	a.db.QueryRow(`SELECT total_amount FROM visits WHERE id='h-new'`).Scan(&fresh)
	if own != 3000 || fresh != 4000 {
		t.Errorf("свой %v (ждём 3000), новый %v (ждём 4000)", own, fresh)
	}
}

// B-016, дыры: смена врача на себя, строка заново с нулевой ценой, замена
// услуги в строке, проигравшая версия с нулями, взять приём без врача.
func TestHiddenSumsEdgeCases(t *testing.T) {
	a := testApp(t)
	if _, err := a.db.Exec(`INSERT INTO clinic_staff (id, name) VALUES ('docA','А'), ('docB','Б')`); err != nil {
		t.Fatal(err)
	}
	const at = `"version":1,"updated_at":"2026-09-01T12:00:00Z"`
	doPush(t, a, `{
		"owners":[{"id":"e-o","fio":"Х","phone":"+7 700 666 0000",`+at+`}],
		"pets":[{"id":"e-p","owner_id":"e-o","name":"Бим","type":"dog","gender":"m",`+at+`}],
		"items":[{"id":"it-uzi","name":"УЗИ","type":"service","price":7500,`+at+`},
		         {"id":"it-exam","name":"Осмотр","type":"service","price":3000,`+at+`}],
		"visits":[{"id":"e-v","pet_id":"e-p","staff_id":"docB","date":"2026-09-01T11:00:00Z","total_amount":7500,"device_id":"tab-b",`+at+`},
		          {"id":"e-free","pet_id":"e-p","date":"2026-09-01T12:00:00Z","total_amount":5000,`+at+`}],
		"visit_items":[{"id":"e-i1","visit_id":"e-v","item_id":"it-uzi","name":"УЗИ","type":"service","quantity":1,"price":7500,"total":7500,`+at+`}]}`)
	doc := userWithSums("own", "docA")
	doc.ID = "u-doc"
	one := func(q string, args ...any) (s string) { a.db.QueryRow(q, args...).Scan(&s); return }
	num := func(q string, args ...any) (f float64) { a.db.QueryRow(q, args...).Scan(&f); return }

	// 1. Назначить себя врачом чужого приёма — врач не меняется.
	doPushAs(t, a, doc, `{"visits":[{"id":"e-v","pet_id":"e-p","staff_id":"docA","date":"2026-09-01T11:00:00Z",
		"total_amount":0,"version":2,"updated_at":"2026-09-01T13:00:00Z"}]}`)
	if s := one(`SELECT staff_id FROM visits WHERE id='e-v'`); s != "docB" {
		t.Errorf("врач чужого приёма сменён на %q — выручка ушла бы в чужой отчёт", s)
	}

	// 2. Строка заведена заново с замаскированной ценой 0 — цена из каталога.
	doPushAs(t, a, doc, `{"visit_items":[
		{"id":"e-i1","visit_id":"e-v","item_id":"it-uzi","name":"УЗИ","type":"service","quantity":1,"price":0,"total":0,"is_deleted":1,"deleted_at":"2026-09-01T13:10:00Z","version":2,"updated_at":"2026-09-01T13:10:00Z"},
		{"id":"e-i2","visit_id":"e-v","item_id":"it-uzi","name":"УЗИ","type":"service","quantity":1,"price":0,"total":0,"version":1,"updated_at":"2026-09-01T13:10:00Z"}]}`)
	if p := num(`SELECT price FROM visit_items WHERE id='e-i2'`); p != 7500 {
		t.Errorf("строка заново: цена %v, ждём 7500 из каталога", p)
	}
	if v := num(`SELECT total_amount FROM visits WHERE id='e-v'`); v != 7500 {
		t.Errorf("итог приёма %v, ждём 7500 по живым позициям", v)
	}

	// 3. В той же строке другая услуга — цена пришедшая (из каталога), не старая.
	doPushAs(t, a, doc, `{"visit_items":[{"id":"e-i2","visit_id":"e-v","item_id":"it-exam","name":"Осмотр","type":"service",
		"quantity":1,"price":3000,"total":3000,"version":2,"updated_at":"2026-09-01T13:20:00Z"}]}`)
	if p := num(`SELECT price FROM visit_items WHERE id='e-i2'`); p != 3000 {
		t.Errorf("замена услуги: цена %v, ждём 3000", p)
	}

	// 4. Проигравшая версия от пишущего без права — в ней серверные деньги.
	doPushAs(t, a, doc, `{"visits":[{"id":"e-v","pet_id":"e-p","staff_id":"docB","date":"2026-09-01T11:00:00Z","diagnosis":"старое",
		"total_amount":0,"version":2,"base_version":1,"device_id":"tab-a","updated_at":"2026-09-01T10:30:00Z"}]}`)
	if cj := one(`SELECT COALESCE(conflict_json,'') FROM visits WHERE id='e-v'`); cj == "" {
		t.Error("конфликт не возник — сценарий не проверен")
	} else if strings.Contains(cj, `"total_amount":0`) {
		t.Errorf("проигравшая версия хранит замаскированный ноль: %s", cj)
	}

	// 5. Приём без врача можно взять на себя.
	doPushAs(t, a, doc, `{"visits":[{"id":"e-free","pet_id":"e-p","staff_id":"docA","date":"2026-09-01T12:00:00Z",
		"total_amount":0,"version":2,"updated_at":"2026-09-01T13:30:00Z"}]}`)
	if s := one(`SELECT staff_id FROM visits WHERE id='e-free'`); s != "docA" {
		t.Errorf("приём без врача не взят на себя: %q", s)
	}
	if v := num(`SELECT total_amount FROM visits WHERE id='e-free'`); v != 5000 {
		t.Errorf("сумма приёма без врача затёрта: %v", v)
	}
}

// B-018: хвосты B-016 — бесплатная строка, заведённая заново, остаётся
// бесплатной; REST-путь позиций пересчитывает итог скрытого приёма.
func TestHiddenSumsTails(t *testing.T) {
	a := testApp(t)
	if _, err := a.db.Exec(`INSERT INTO clinic_staff (id, name) VALUES ('docA','А'), ('docB','Б')`); err != nil {
		t.Fatal(err)
	}
	const at = `"version":1,"updated_at":"2026-09-01T12:00:00Z"`
	doPush(t, a, `{
		"owners":[{"id":"t-o","fio":"Х","phone":"+7 700 999 0000",`+at+`}],
		"pets":[{"id":"t-p","owner_id":"t-o","name":"Бим","type":"dog","gender":"m",`+at+`}],
		"items":[{"id":"it-uzi","name":"УЗИ","type":"service","price":7500,`+at+`}],
		"visits":[{"id":"t-v","pet_id":"t-p","staff_id":"docB","date":"2026-09-01T11:00:00Z","total_amount":7500,`+at+`}],
		"visit_items":[{"id":"t-free","visit_id":"t-v","item_id":"it-uzi","name":"УЗИ","type":"service","quantity":1,"price":0,"total":0,`+at+`},
		               {"id":"t-paid","visit_id":"t-v","item_id":"it-uzi","name":"УЗИ","type":"service","quantity":1,"price":7500,"total":7500,`+at+`}]}`)
	doc := userWithSums("own", "docA")
	doc.ID = "u-doc"
	num := func(q string) (f float64) { a.db.QueryRow(q).Scan(&f); return }

	// Бесплатную строку завели заново (надгробие + новая с нулём) — осталась 0.
	doPushAs(t, a, doc, `{"visit_items":[
		{"id":"t-free","visit_id":"t-v","item_id":"it-uzi","name":"УЗИ","type":"service","quantity":1,"price":0,"total":0,"is_deleted":1,"deleted_at":"2026-09-01T13:00:00Z","version":2,"updated_at":"2026-09-01T13:00:00Z"},
		{"id":"t-free2","visit_id":"t-v","item_id":"it-uzi","name":"УЗИ","type":"service","quantity":1,"price":0,"total":0,"version":1,"updated_at":"2026-09-01T13:00:00Z"}]}`)
	if p := num(`SELECT price FROM visit_items WHERE id='t-free2'`); p != 0 {
		t.Errorf("бесплатная строка получила цену %v", p)
	}

	// REST: удаление платной строки чужого приёма пересчитывает итог.
	req := httptest.NewRequest(http.MethodDelete, "/visit-items/t-paid", nil)
	req.SetPathValue("id", "t-paid")
	req = req.WithContext(context.WithValue(req.Context(), ctxKeyUser{}, doc))
	rec := httptest.NewRecorder()
	a.handleVisitItemByID(rec, req)
	if rec.Code != http.StatusOK {
		t.Fatalf("DELETE: HTTP %d %s", rec.Code, rec.Body.String())
	}
	if v := num(`SELECT total_amount FROM visits WHERE id='t-v'`); v != 0 {
		t.Errorf("итог приёма %v после удаления платной строки, ждём 0", v)
	}
}
