package main

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"testing"
	"time"
)

// portalResultsAs — ответ /portal/pets/{id}/results для владельца с живой
// сессией: поле fields каждого результата по id.
func portalResultsAs(t *testing.T, a *app, ownerID, petID string) map[string]string {
	t.Helper()
	const token = "portal-test-token"
	if _, err := a.db.Exec(
		`INSERT OR REPLACE INTO owner_sessions (token_hash, owner_id, expires_at) VALUES (?, ?, ?)`,
		tokenHashOf(token), ownerID, T(nowUTC().Add(time.Hour))); err != nil {
		t.Fatalf("сессия владельца: %v", err)
	}
	req := httptest.NewRequest(http.MethodGet, "/portal/pets/"+petID+"/results", nil)
	req.SetPathValue("id", petID)
	req.Header.Set(portalTokenHeader, token)
	rec := httptest.NewRecorder()
	a.handlePortalPetResults(rec, req)
	if rec.Code != http.StatusOK {
		t.Fatalf("портал HTTP %d: %s", rec.Code, rec.Body.String())
	}
	var resp struct {
		Data []struct {
			ID     string `json:"id"`
			Fields string `json:"fields"`
		} `json:"data"`
	}
	if err := json.Unmarshal(rec.Body.Bytes(), &resp); err != nil {
		t.Fatalf("ответ не JSON: %v", err)
	}
	out := map[string]string{}
	for _, r := range resp.Data {
		out[r.ID] = r.Fields
	}
	return out
}

// Правило 6: владелец видит результат так, как его оценил врач. Клиника
// сузила норму гемоглобина и потом удалила бланк — ответ кабинета не меняется,
// потому что нормы берутся из снимка в самой записи, а не из справочника.
func TestPortalResultsReadSnapshotNotTemplate(t *testing.T) {
	a := testApp(t)
	const snap = `[{"key":"hgb","label":"Гемоглобин","type":"number","ref_low":80,"ref_high":150}]`
	doPush(t, a, `{
		"owners":[{"id":"o-p","fio":"Хозяин","phone":"+7 700 400 4000","version":1,"updated_at":"2026-09-01T10:00:00Z"}],
		"pets":[{"id":"p-p","owner_id":"o-p","name":"Мурка","type":"cat","gender":"f","version":1,"updated_at":"2026-09-01T10:01:00Z"}],
		"visits":[{"id":"v-p","pet_id":"p-p","date":"2026-09-01T11:00:00Z","version":1,"updated_at":"2026-09-01T11:00:00Z"}],
		"protocol_templates":[{"id":"t-p","name":"ОАК","kind":"lab",
			"fields":"[{\"key\":\"hgb\",\"label\":\"Гемоглобин\",\"type\":\"number\",\"ref_low\":80,\"ref_high\":150}]",
			"version":1,"updated_at":"2026-09-01T09:00:00Z"}],
		"visit_results":[{"id":"r-p","visit_id":"v-p","pet_id":"p-p","title":"ОАК","template_id":"t-p",
			"kind":"protocol","values_json":"{\"hgb\":\"140\"}","status":"done",
			"fields_snapshot":"[{\"key\":\"hgb\",\"label\":\"Гемоглобин\",\"type\":\"number\",\"ref_low\":80,\"ref_high\":150}]",
			"version":1,"updated_at":"2026-09-01T12:00:00Z"}]}`)

	// Клиника переписала бланк: 140 теперь было бы отклонением.
	if _, err := a.db.Exec(`UPDATE protocol_templates SET fields=? WHERE id='t-p'`,
		`[{"key":"hgb","label":"Гемоглобин","type":"number","ref_low":150,"ref_high":180}]`); err != nil {
		t.Fatal(err)
	}
	if got := portalResultsAs(t, a, "o-p", "p-p")["r-p"]; got != snap {
		t.Errorf("после правки бланка кабинет отдал %s, ждём снимок %s", got, snap)
	}

	// Бланк удалили совсем: показатели не должны исчезнуть.
	if _, err := a.db.Exec(`DELETE FROM protocol_templates WHERE id='t-p'`); err != nil {
		t.Fatal(err)
	}
	if got := portalResultsAs(t, a, "o-p", "p-p")["r-p"]; got != snap {
		t.Errorf("после удаления бланка кабинет отдал %s, ждём снимок %s", got, snap)
	}
}

// Запись без снимка (сделана до его появления) по-прежнему читается по
// бланку — иначе старые результаты показались бы владельцу пустыми.
func TestPortalResultsFallBackToTemplateWithoutSnapshot(t *testing.T) {
	a := testApp(t)
	const tpl = `[{"key":"alt","label":"АЛТ","type":"number","ref_low":10,"ref_high":100}]`
	doPush(t, a, `{
		"owners":[{"id":"o-f","fio":"Хозяин","phone":"+7 700 500 5000","version":1,"updated_at":"2026-09-01T10:00:00Z"}],
		"pets":[{"id":"p-f","owner_id":"o-f","name":"Бим","type":"dog","gender":"m","version":1,"updated_at":"2026-09-01T10:01:00Z"}],
		"visits":[{"id":"v-f","pet_id":"p-f","date":"2026-09-01T11:00:00Z","version":1,"updated_at":"2026-09-01T11:00:00Z"}],
		"protocol_templates":[{"id":"t-f","name":"Биохимия","kind":"lab",
			"fields":"[{\"key\":\"alt\",\"label\":\"АЛТ\",\"type\":\"number\",\"ref_low\":10,\"ref_high\":100}]",
			"version":1,"updated_at":"2026-09-01T09:00:00Z"}],
		"visit_results":[{"id":"r-f","visit_id":"v-f","pet_id":"p-f","title":"Биохимия","template_id":"t-f",
			"kind":"protocol","values_json":"{\"alt\":\"50\"}","status":"done",
			"version":1,"updated_at":"2026-09-01T12:00:00Z"}]}`)
	// Снимка нет ни в каком виде — как у записей до его появления. Испорченный
	// снимок равен отсутствующему: так же решает врачебный интерфейс.
	for _, empty := range []any{nil, "", "[]", "не JSON"} {
		if _, err := a.db.Exec(`UPDATE visit_results SET fields_snapshot=? WHERE id='r-f'`, empty); err != nil {
			t.Fatal(err)
		}
		if got := portalResultsAs(t, a, "o-f", "p-f")["r-f"]; got != tpl {
			t.Errorf("снимок %v: кабинет отдал %s, ждём бланк %s", empty, got, tpl)
		}
	}
}
