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
