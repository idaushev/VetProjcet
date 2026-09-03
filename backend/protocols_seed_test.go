package main

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
)

// Бланк, который нельзя заполнить, хуже отсутствующего: врач открывает окно и
// видит поля без подписей или норму «от 10 до 2». Проверяем форму данных, а не
// клинический смысл — смысл сверяет клиника, для того нормы и лежат в базе.
func TestStarterProtocolsAreWellFormed(t *testing.T) {
	tpls := starterProtocols()
	if len(tpls) < 4 {
		t.Fatalf("стартовых бланков должно быть минимум 4, получено %d", len(tpls))
	}
	types := map[string]bool{"number": true, "text": true, "textarea": true, "select": true, "check": true}

	for _, tpl := range tpls {
		if strings.TrimSpace(tpl.Name) == "" {
			t.Error("бланк без названия")
		}
		if len(tpl.Fields) == 0 {
			t.Errorf("%s: бланк без полей", tpl.Name)
		}
		seen := map[string]bool{}
		for _, f := range tpl.Fields {
			if f.Key == "" || f.Label == "" {
				t.Errorf("%s: поле без ключа или подписи: %+v", tpl.Name, f)
			}
			// Ключ связывает уже заполненные протоколы со значениями. Дубль
			// означает, что второе поле затрёт первое при заполнении.
			if seen[f.Key] {
				t.Errorf("%s: ключ %q встречается дважды", tpl.Name, f.Key)
			}
			seen[f.Key] = true

			if !types[f.Type] {
				t.Errorf("%s/%s: тип %q интерфейсу неизвестен", tpl.Name, f.Key, f.Type)
			}
			if f.RefLow != nil && f.RefHigh != nil && *f.RefLow > *f.RefHigh {
				t.Errorf("%s/%s: норма от %v до %v — границы перевёрнуты", tpl.Name, f.Key, *f.RefLow, *f.RefHigh)
			}
			// Норма осмысленна только у числа: у галочки «от 1 до 3» — мусор.
			if f.Type != "number" && (f.RefLow != nil || f.RefHigh != nil) {
				t.Errorf("%s/%s: норма задана нечисловому полю (%s)", tpl.Name, f.Key, f.Type)
			}
			if f.Type == "select" && len(f.Options) == 0 {
				t.Errorf("%s/%s: список без вариантов — выбирать не из чего", tpl.Name, f.Key)
			}
		}
		if _, err := json.Marshal(tpl.Fields); err != nil {
			t.Errorf("%s: поля не сериализуются: %v", tpl.Name, err)
		}
	}
}

// Один орган описывают несколькими полями разного типа сразу — это и просила
// клиника («мочевой пузырь: и текст, и цифры, и галочки»). Проверяем, что в
// бланке УЗИ такой блок действительно есть: без него правку легко потерять при
// следующей чистке шаблонов.
func TestUltrasoundTemplateMixesTypesWithinOneOrgan(t *testing.T) {
	var found bool
	for _, tpl := range starterProtocols() {
		if !strings.Contains(tpl.Name, "УЗИ") {
			continue
		}
		kinds := map[string]bool{}
		for _, f := range tpl.Fields {
			if f.Group == "Мочевой пузырь" {
				kinds[f.Type] = true
			}
		}
		if !kinds["number"] || !kinds["check"] || !(kinds["text"] || kinds["textarea"]) {
			t.Errorf("%s: у мочевого пузыря нет всех трёх видов полей, есть только %v", tpl.Name, kinds)
		}
		found = true
	}
	if !found {
		t.Fatal("бланка УЗИ среди стартовых нет")
	}
}

// Сидер обязан быть одноразовым. Бланк, удалённый клиникой как ненужный, не
// должен возвращаться при следующем запуске сервера — иначе список протоколов
// становится неубираемым.
func TestSeedRunsOnceAndDeletedTemplatesStayDeleted(t *testing.T) {
	a := testApp(t)
	ctx := context.Background()

	var n int
	if err := a.db.QueryRow(`SELECT COUNT(*) FROM protocol_templates`).Scan(&n); err != nil {
		t.Fatalf("подсчёт бланков: %v", err)
	}
	if n == 0 {
		t.Fatal("стартовые бланки не завелись при создании базы")
	}

	// Клиника убрала лишний бланк.
	if _, err := a.db.Exec(`UPDATE protocol_templates SET is_deleted=1 WHERE name LIKE '%кошка%'`); err != nil {
		t.Fatalf("удаление бланка: %v", err)
	}
	// И совсем стёрла другой.
	if _, err := a.db.Exec(`DELETE FROM protocol_templates WHERE name='Биохимия крови'`); err != nil {
		t.Fatalf("физическое удаление: %v", err)
	}

	seedProtocolTemplates(ctx, a.db) // перезапуск сервера

	var deleted, bio int
	a.db.QueryRow(`SELECT COUNT(*) FROM protocol_templates WHERE name LIKE '%кошка%' AND is_deleted=0`).Scan(&deleted)
	if deleted != 0 {
		t.Error("удалённый бланк воскрес после перезапуска")
	}
	a.db.QueryRow(`SELECT COUNT(*) FROM protocol_templates WHERE name='Биохимия крови'`).Scan(&bio)
	if bio != 0 {
		t.Error("стёртый бланк завёлся заново")
	}
}

// Бланк, который не доехал до планшета, равен отсутствующему: врач откроет
// услугу и увидит пустое окно. Проверяем ВЫГРУЗКУ настоящим обработчиком с
// правами пользователя — тесты синка зовут его без пользователя, и гейт прав
// там не срабатывает.
func pullAs(t *testing.T, a *app, u *User, since string) map[string][]map[string]any {
	t.Helper()
	url := "/sync/pull"
	if since != "" {
		url += "?since=" + since
	}
	req := httptest.NewRequest(http.MethodGet, url, nil)
	if u != nil {
		req = req.WithContext(context.WithValue(req.Context(), ctxKeyUser{}, u))
	}
	rec := httptest.NewRecorder()
	a.handleSyncPull(rec, req)
	if rec.Code != http.StatusOK {
		t.Fatalf("pull HTTP %d: %s", rec.Code, rec.Body.String())
	}
	var resp struct {
		Data map[string]json.RawMessage `json:"data"`
	}
	if err := json.Unmarshal(rec.Body.Bytes(), &resp); err != nil {
		t.Fatalf("ответ не JSON: %v", err)
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

func TestSeededTemplatesReachTheTablet(t *testing.T) {
	a := testApp(t)

	// Врач без настроенных прав — самый частый случай в клинике.
	doc := &User{ID: "u-doc", Login: "vet", Role: "doctor", IsActive: true}
	data := pullAs(t, a, doc, "")

	tpls := data["protocol_templates"]
	if len(tpls) < 4 {
		t.Fatalf("врачу пришло %d бланков — стартовые не доехали", len(tpls))
	}

	var uzi map[string]any
	for _, tpl := range tpls {
		name, _ := tpl["name"].(string)
		if strings.Contains(name, "УЗИ") {
			uzi = tpl
		}
		// Пустой набор полей означает бланк без единой строки для заполнения.
		if f, _ := tpl["fields"].(string); len(f) < 10 {
			t.Errorf("%s: поля не доехали (%q)", name, f)
		}
	}
	if uzi == nil {
		t.Fatal("бланка УЗИ среди присланных нет")
	}
	// Разделы — то, ради чего орган описывается несколькими полями сразу.
	if f, _ := uzi["fields"].(string); !strings.Contains(f, "Мочевой пузырь") {
		t.Error("разделы бланка УЗИ не доехали до планшета")
	}

	// Инкрементальная выгрузка: планшет, синхронизировавшийся ДО появления
	// бланков, обязан получить их следующим циклом. Цикл ходит именно так.
	inc := pullAs(t, a, doc, "2020-01-01T00:00:00Z")
	if len(inc["protocol_templates"]) < 4 {
		t.Errorf("инкрементально пришло %d бланков вместо 4 — планшет их не увидит",
			len(inc["protocol_templates"]))
	}
}

// Право «справочники» ограничивает ПРАВКУ, а не чтение. Если бы умолчанием
// был none, врач с настроенными правами перестал бы видеть бланки — и протокол
// открывался бы пустым, без единой ошибки на экране.
func TestTemplatesStayReadableForEveryoneWhoFillsVisits(t *testing.T) {
	a := testApp(t)

	// Права настроены, про справочники в них не сказано ничего.
	doc := &User{ID: "u-doc2", Login: "vet2", Role: "doctor", IsActive: true,
		Permissions: []byte(`{"tables":{"visits":"edit","items":"view"}}`)}
	if n := len(pullAs(t, a, doc, "")["protocol_templates"]); n < 4 {
		t.Errorf("врачу с настроенными правами пришло %d бланков — протокол будет пустым", n)
	}

	// А явный запрет по-прежнему закрывает таблицу: изоляция ролей на месте.
	locked := &User{ID: "u-lock", Login: "seller", Role: "doctor", IsActive: true,
		Permissions: []byte(`{"tables":{"templates":"none"}}`)}
	if n := len(pullAs(t, a, locked, "")["protocol_templates"]); n != 0 {
		t.Errorf("при явном запрете пришло %d бланков — изоляция не работает", n)
	}
}

// Исправление уже внесённого результата — обычная работа: описку в цифре
// замечают через час, заключение дописывают после консультации. Но дата
// ПОСТУПЛЕНИЯ результата при этом меняться не должна: по ней сортируется
// список в кабинете владельца и по ней же понимают, когда пришёл анализ.
// Съехавшая дата тихо переставит анализ в хронологии лечения.
func TestCorrectingResultKeepsArrivalDate(t *testing.T) {
	a := testApp(t)

	doPush(t, a, `{"device_id":"dev-1",
		"owners":[{"id":"o-c","fio":"Хозяин","phone":"+7 700 333 0000","version":1,"updated_at":"2026-09-01T10:00:00Z"}],
		"pets":[{"id":"p-c","owner_id":"o-c","name":"Мурка","type":"cat","gender":"f","version":1,"updated_at":"2026-09-01T10:00:00Z"}],
		"visits":[{"id":"v-c","pet_id":"p-c","date":"2026-09-01T10:00:00Z","version":1,"updated_at":"2026-09-01T10:00:00Z"}],
		"visit_results":[{"id":"r-c","visit_id":"v-c","pet_id":"p-c","item_id":"i-bio","title":"Биохимия",
		  "kind":"protocol","status":"done","values":"{\"creatinine\":\"400\"}","conclusion":"почки",
		  "filled_at":"2026-09-01T11:00:00Z","version":1,"updated_at":"2026-09-01T11:00:00Z"}]}`)

	var filledBefore string
	if err := a.db.QueryRow(`SELECT filled_at FROM visit_results WHERE id='r-c'`).Scan(&filledBefore); err != nil {
		t.Fatalf("результат не доехал: %v", err)
	}

	// Врач исправляет описку: 400 → 140.
	body := `{"values_json":"{\"creatinine\":\"140\"}","conclusion":"описка в цифре","status":"done"}`
	req := httptest.NewRequest(http.MethodPut, "/results/r-c", strings.NewReader(body))
	req.SetPathValue("id", "r-c")
	req.Header.Set("Content-Type", "application/json")
	rec := httptest.NewRecorder()
	a.handleResultByID(rec, req)
	if rec.Code != http.StatusOK {
		t.Fatalf("правка результата HTTP %d: %s", rec.Code, rec.Body.String())
	}

	var filledAfter, values, concl, status string
	err := a.db.QueryRow(`SELECT filled_at, values_json, COALESCE(conclusion,''), status
	                      FROM visit_results WHERE id='r-c'`).Scan(&filledAfter, &values, &concl, &status)
	if err != nil {
		t.Fatalf("чтение после правки: %v", err)
	}
	if filledAfter != filledBefore {
		t.Errorf("дата поступления съехала: было %q, стало %q", filledBefore, filledAfter)
	}
	if !strings.Contains(values, "140") || strings.Contains(values, "400") {
		t.Errorf("значение не исправилось: %s", values)
	}
	if concl != "описка в цифре" {
		t.Errorf("заключение не исправилось: %q", concl)
	}
	if status != "done" {
		t.Errorf("статус после правки = %q, ждём done", status)
	}
}

// Правка результата — правка медкарты. Роль, которой приёмы не открыты, не
// должна переписывать анализы, даже зная адрес запроса: изоляция обязана быть
// на сервере, а не только в интерфейсе.
func TestEditingResultsNeedsMedicalRecordAccess(t *testing.T) {
	viewer := &User{ID: "u-v", Login: "reg", Role: "doctor", IsActive: true,
		Permissions: []byte(`{"tables":{"visits":"view"}}`)}
	editor := &User{ID: "u-e", Login: "vet", Role: "doctor", IsActive: true}

	if got := pathTable("/results/r-1"); got != "visits" {
		t.Fatalf("маршрут результатов закреплён за правом %q, ждём visits", got)
	}
	if viewer.tableLevel("visits") >= permLevels["edit"] {
		t.Error("роль с правом только на чтение приёмов может править результаты")
	}
	if editor.tableLevel("visits") < permLevels["edit"] {
		t.Error("врач без настроенных прав потерял возможность править результаты")
	}
}
