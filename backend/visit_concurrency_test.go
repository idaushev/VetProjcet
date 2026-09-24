package main

import (
	"encoding/json"
	"fmt"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
)

// ─── TECH-006: конкурентная правка приёма ────────────────────────────────────
//
// Два планшета получили один и тот же приём, оба ушли в офлайн и правят его,
// потом по очереди синхронизируются.
//
// Тесты TestConcurrentVisit* (правка без base_version) — ПЛАНШЕТ ДО 3.34.0: он
// не сообщает, от какой версии начал правку, и для него действует прежнее
// правило с потерями. Они закрепляют это поведение намеренно: пока в клинике
// есть необновлённый планшет, сервер обязан вести себя с ним как раньше.
// Тесты TestVisitConflict* в конце файла — планшет 3.34.0+: потерь нет.
//
// Сценарий повторяет реальный путь планшета:
//   - каждое сохранение на планшете прибавляет к version единицу
//     (normalizeRecord, frontend/js/db.js); сервер хранит присланную как есть;
//   - правка приёма шлёт запись приёма целиком; позиции счёта — только
//     изменённые, под своими id (frontend/js/pages.js, сохранение правки);
//   - цикл синка — сначала pull, потом push (syncAll, frontend/js/sync.js).

const (
	concBase = "2026-09-01T10:00:00Z" // приём создан и доехал до обоих планшетов
	concA    = "2026-09-01T11:00:00Z" // планшет A поправил раньше
	concB    = "2026-09-01T12:00:00Z" // планшет B поправил позже
)

// concSeed — приём с одной позицией счёта, как он лежит на обоих планшетах.
func concSeed(t *testing.T) *app {
	t.Helper()
	a := testApp(t)
	doPush(t, a, `{
		"owners":[{"id":"o-c","fio":"Хозяин","phone":"+7 700 600 6000","version":1,"updated_at":"`+concBase+`"}],
		"pets":[{"id":"p-c","owner_id":"o-c","name":"Тузик","type":"dog","gender":"m","version":1,"updated_at":"`+concBase+`"}],
		"items":[{"id":"it-exam","name":"Осмотр","type":"service","price":5000,"version":1,"updated_at":"`+concBase+`"}],
		"visits":[{"id":"v-c","pet_id":"p-c","date":"`+concBase+`","diagnosis":"Гастрит","treatment":"Диета",
			"total_amount":5000,"version":1,"updated_at":"`+concBase+`"}],
		"visit_items":[{"id":"i-base","visit_id":"v-c","item_id":"it-exam","name":"Осмотр","type":"service",
			"quantity":1,"price":5000,"total":5000,"version":1,"updated_at":"`+concBase+`"}]}`)
	return a
}

// edit — правка приёма на одном планшете, как она уходит в push.
type edit struct {
	at                   string // время правки на планшете
	version              int    // 2 — одно сохранение от исходной v1, 3 — два
	diagnosis, treatment string // что в приёме на этом планшете
}

func (e edit) payload() string {
	return fmt.Sprintf(`{"visits":[{"id":"v-c","pet_id":"p-c","date":"%s","diagnosis":"%s","treatment":"%s",
		"total_amount":5000,"version":%d,"updated_at":"%s"}]}`, concBase, e.diagnosis, e.treatment, e.version, e.at)
}

func concVisit(t *testing.T, a *app) (diagnosis, treatment string) {
	t.Helper()
	if err := a.db.QueryRow(`SELECT COALESCE(diagnosis,''), COALESCE(treatment,'') FROM visits WHERE id='v-c'`).
		Scan(&diagnosis, &treatment); err != nil {
		t.Fatal(err)
	}
	return
}

func concItems(t *testing.T, a *app) (n int, sum float64) {
	t.Helper()
	if err := a.db.QueryRow(`SELECT COUNT(*), COALESCE(SUM(total),0) FROM visit_items
		WHERE visit_id='v-c' AND is_deleted=0`).Scan(&n, &sum); err != nil {
		t.Fatal(err)
	}
	return
}

func skipped(res map[string]any) float64 { v, _ := res["skipped"].(float64); return v }

// A уточнил диагноз, B — лечение; A синхронизировался первым. Оба push
// приняты, но B прислал приём целиком со СТАРЫМ диагнозом — правка A
// исчезла, и ни один планшет об этом не узнал.
func TestConcurrentVisitEditEarlierFirstLosesEdit(t *testing.T) {
	a := concSeed(t)
	resA := doPush(t, a, edit{concA, 2, "Гастроэнтерит", "Диета"}.payload())
	resB := doPush(t, a, edit{concB, 2, "Гастрит", "Диета, пробиотик"}.payload())

	diagnosis, treatment := concVisit(t, a)
	if treatment != "Диета, пробиотик" {
		t.Errorf("лечение от B: %q", treatment)
	}
	// Планшет до 3.34.0: диагноз от A молча откатился к исходному
	// (3.34.0+ — TestVisitConflictEarlierFirstKeepsBoth).
	if diagnosis != "Гастрит" {
		t.Errorf("поведение изменилось: диагноз %q — у планшетов до 3.34.0", diagnosis)
	}
	// Оба push просто приняты.
	if skipped(resA) != 0 || skipped(resB) != 0 {
		t.Errorf("поведение изменилось: skipped A=%v B=%v", resA["skipped"], resB["skipped"])
	}
}

// Тот же сценарий, но первым синхронизировался B (более поздняя правка).
// Приём A отклонён целиком по времени клиента: планшет получает только
// skipped в ответе, который интерфейс не показывает, а следующий pull
// перезаписывает его диагноз серверным.
func TestConcurrentVisitEditLaterFirstRejectsEdit(t *testing.T) {
	a := concSeed(t)
	doPush(t, a, edit{concB, 2, "Гастрит", "Диета, пробиотик"}.payload())
	resA := doPush(t, a, edit{concA, 2, "Гастроэнтерит", "Диета"}.payload())

	diagnosis, treatment := concVisit(t, a)
	if treatment != "Диета, пробиотик" {
		t.Errorf("лечение от B: %q", treatment)
	}
	// Планшет до 3.34.0: диагноз от A отклонён по времени клиента
	// (3.34.0+ — TestVisitConflictLaterFirstKeepsBoth).
	if diagnosis != "Гастрит" {
		t.Errorf("поведение изменилось: диагноз %q — у планшетов до 3.34.0", diagnosis)
	}
	// Отклонён приём A — единственная запись в его push.
	if skipped(resA) != 1 {
		t.Errorf("поведение изменилось: skipped A=%v, ждали 1", resA["skipped"])
	}
}

// A сохранил приём офлайн дважды (version 3), B — один раз, но позже
// (version 2). Версия побеждает время: правка B отклоняется, хотя она
// новее, и лечение B пропадает — даже если B синхронизировался первым.
func TestConcurrentVisitEditHigherVersionWinsRegardlessOfTime(t *testing.T) {
	a := concSeed(t)
	doPush(t, a, edit{concB, 2, "Гастрит", "Диета, пробиотик"}.payload())
	doPush(t, a, edit{concA, 3, "Гастроэнтерит", "Диета"}.payload())

	diagnosis, treatment := concVisit(t, a)
	// Планшет до 3.34.0: лечение от B потеряно — версия A выше
	// (3.34.0+ — TestVisitConflictLaterEditWinsOverHigherVersion).
	if diagnosis != "Гастроэнтерит" || treatment != "Диета" {
		t.Errorf("поведение изменилось: диагноз %q, лечение %q — у планшетов до 3.34.0",
			diagnosis, treatment)
	}
}

// Позиции счёта (VET-017, шаг 1). Планшет больше не пересоздаёт строки при
// правке приёма: неизменённая строка не отправляется, изменённая правится
// под своим id. Раньше каждый планшет удалял исходную позицию и создавал
// свою с новым id — сервер принимал обе, и в приёме было два «Осмотра» на
// 10 000 при сумме 5000 (отчёты по деньгам считают по позициям).

// itemEdit — push позиции под её прежним id, как его шлёт правка приёма.
func itemEdit(at string, version int, qty, price float64) string {
	return fmt.Sprintf(`{"visit_items":[{"id":"i-base","visit_id":"v-c","item_id":"it-exam","name":"Осмотр",
		"type":"service","quantity":%[3]g,"price":%[4]g,"total":%[5]g,"version":%[2]d,"updated_at":"%[1]s"}]}`,
		at, version, qty, price, qty*price)
}

// Оба планшета поправили в приёме только текст — позиции не тронуты и не
// отправляются. В приёме одна позиция при любом порядке синка.
func TestConcurrentVisitEditKeepsSingleItemWhenUntouched(t *testing.T) {
	a := concSeed(t)
	doPush(t, a, `{"visits":[{"id":"v-c","pet_id":"p-c","date":"`+concBase+`","diagnosis":"Гастроэнтерит",
		"treatment":"Диета","total_amount":5000,"version":2,"updated_at":"`+concA+`"}]}`)
	doPush(t, a, `{"visits":[{"id":"v-c","pet_id":"p-c","date":"`+concBase+`","diagnosis":"Гастрит",
		"treatment":"Диета, пробиотик","total_amount":5000,"version":2,"updated_at":"`+concB+`"}]}`)
	if n, sum := concItems(t, a); n != 1 || sum != 5000 {
		t.Errorf("позиций %d на %.0f, ждём одну на 5000", n, sum)
	}
}

// Оба планшета поправили ОДНУ И ТУ ЖЕ строку: A — количество, B — цену.
// Строка одна (id общий), побеждает правка по правилам синка — сегодня
// более поздняя при равных версиях. Дубля нет при любом порядке.
func TestConcurrentVisitEditSameItemStaysSingle(t *testing.T) {
	for _, order := range []string{"A затем B", "B затем A"} {
		t.Run(order, func(t *testing.T) {
			a := concSeed(t)
			pa, pb := itemEdit(concA, 2, 2, 5000), itemEdit(concB, 2, 1, 6000)
			if order == "A затем B" {
				doPush(t, a, pa)
				doPush(t, a, pb)
			} else {
				doPush(t, a, pb)
				doPush(t, a, pa)
			}
			n, sum := concItems(t, a)
			if n != 1 {
				t.Fatalf("позиций %d, ждём одну", n)
			}
			// B-008: правка A по этой строке теряется молча, если оба
			// планшета правили её офлайн (при онлайн-сохранении врач предупреждён).
			if sum != 6000 {
				t.Errorf("поведение изменилось: сумма %.0f, ждали 6000 (правка B)", sum)
			}
		})
	}
}

// Новая строка, добавленная одним планшетом, законно добавляется к счёту:
// это не дубль, а новая услуга.
func TestConcurrentVisitEditNewItemIsAdded(t *testing.T) {
	a := concSeed(t)
	doPush(t, a, `{"visit_items":[{"id":"i-new","visit_id":"v-c","item_id":"it-exam","name":"Осмотр",
		"type":"service","quantity":1,"price":5000,"total":5000,"version":1,"updated_at":"`+concA+`"}]}`)
	if n, sum := concItems(t, a); n != 2 || sum != 10000 {
		t.Errorf("позиций %d на %.0f, ждём две на 10 000", n, sum)
	}
}

// ─── Планшет 3.34.0+: base_version, конфликт сохраняется (VET-017, шаг 2) ────

// vEdit — правка приёма планшетом 3.34.0+: сообщает base_version (версию,
// последней полученную с сервера) и свой device_id.
func vEdit(device, at string, base, version int, diagnosis, treatment string) string {
	return fmt.Sprintf(`{"visits":[{"id":"v-c","pet_id":"p-c","date":"%s","diagnosis":"%s","treatment":"%s",
		"total_amount":5000,"version":%d,"base_version":%d,"device_id":"%s","updated_at":"%s"}]}`,
		concBase, diagnosis, treatment, version, base, device, at)
}

// visitConflicts — версия приёма и проигравшие версии из conflict_json.
func visitConflicts(t *testing.T, a *app) (version int, lost []conflictEntry) {
	t.Helper()
	var cj string
	if err := a.db.QueryRow(`SELECT version, COALESCE(conflict_json,'') FROM visits WHERE id='v-c'`).
		Scan(&version, &cj); err != nil {
		t.Fatal(err)
	}
	if cj != "" {
		if err := json.Unmarshal([]byte(cj), &lost); err != nil {
			t.Fatalf("conflict_json не JSON: %v (%s)", err, cj)
		}
	}
	return
}

// A уточнил диагноз, B — лечение; A синхронизировался первым. Приём —
// правка B (она позже), правка A целиком в конфликте, ничего не потеряно.
func TestVisitConflictEarlierFirstKeepsBoth(t *testing.T) {
	a := concSeed(t)
	doPush(t, a, vEdit("tab-a", concA, 1, 2, "Гастроэнтерит", "Диета"))
	res := doPush(t, a, vEdit("tab-b", concB, 1, 2, "Гастрит", "Диета, пробиотик"))

	diagnosis, treatment := concVisit(t, a)
	if diagnosis != "Гастрит" || treatment != "Диета, пробиотик" {
		t.Errorf("приём = правка B, получили диагноз %q, лечение %q", diagnosis, treatment)
	}
	version, lost := visitConflicts(t, a)
	if len(lost) != 1 || lost[0].Diagnosis != "Гастроэнтерит" || lost[0].DeviceID != "tab-a" {
		t.Fatalf("правка A должна сохраниться в конфликте, получили %+v", lost)
	}
	if version != 3 {
		t.Errorf("версия %d, ждём 3 — выше версий обоих планшетов", version)
	}
	if skipped(res) != 0 {
		t.Errorf("push B не должен отклоняться: skipped=%v", res["skipped"])
	}
}

// Первым синхронизировался B (правка позже). Правка A не отклоняется молча,
// а уходит в конфликт; приём остаётся правкой B.
func TestVisitConflictLaterFirstKeepsBoth(t *testing.T) {
	a := concSeed(t)
	doPush(t, a, vEdit("tab-b", concB, 1, 2, "Гастрит", "Диета, пробиотик"))
	res := doPush(t, a, vEdit("tab-a", concA, 1, 2, "Гастроэнтерит", "Диета"))

	diagnosis, treatment := concVisit(t, a)
	if diagnosis != "Гастрит" || treatment != "Диета, пробиотик" {
		t.Errorf("приём = правка B, получили диагноз %q, лечение %q", diagnosis, treatment)
	}
	version, lost := visitConflicts(t, a)
	if len(lost) != 1 || lost[0].Diagnosis != "Гастроэнтерит" || lost[0].ClientUpdatedAt != concA {
		t.Fatalf("правка A должна сохраниться в конфликте, получили %+v", lost)
	}
	if version != 3 {
		t.Errorf("версия %d, ждём 3 — иначе планшеты не получат отметку", version)
	}
	if skipped(res) != 0 {
		t.Errorf("push A принят в конфликт, skipped=%v", res["skipped"])
	}
}

// A сохранил офлайн дважды (version 3), B — один раз, но позже. Раньше
// версия побеждала время и лечение B пропадало. Теперь решает время правки,
// правка A — в конфликте.
func TestVisitConflictLaterEditWinsOverHigherVersion(t *testing.T) {
	a := concSeed(t)
	doPush(t, a, vEdit("tab-b", concB, 1, 2, "Гастрит", "Диета, пробиотик"))
	doPush(t, a, vEdit("tab-a", concA, 1, 3, "Гастроэнтерит", "Диета"))

	diagnosis, treatment := concVisit(t, a)
	if diagnosis != "Гастрит" || treatment != "Диета, пробиотик" {
		t.Errorf("приём = более поздняя правка B, получили %q / %q", diagnosis, treatment)
	}
	version, lost := visitConflicts(t, a)
	if len(lost) != 1 || lost[0].Treatment != "Диета" {
		t.Fatalf("правка A в конфликте, получили %+v", lost)
	}
	if version != 4 {
		t.Errorf("версия %d, ждём 4 — выше версии 3 планшета A", version)
	}
}

// Планшет повторил push, ответ на который потерялся, — это не конфликт.
// И правки одного планшета подряд — тоже.
func TestVisitConflictNotWithItself(t *testing.T) {
	a := concSeed(t)
	doPush(t, a, vEdit("tab-a", concA, 1, 2, "Гастроэнтерит", "Диета"))
	doPush(t, a, vEdit("tab-a", concA, 1, 2, "Гастроэнтерит", "Диета"))            // повтор
	doPush(t, a, vEdit("tab-a", concB, 1, 3, "Гастроэнтерит", "Диета, пробиотик")) // ещё правка до pull
	if _, lost := visitConflicts(t, a); len(lost) != 0 {
		t.Errorf("планшет разошёлся сам с собой: %+v", lost)
	}
	if _, treatment := concVisit(t, a); treatment != "Диета, пробиотик" {
		t.Errorf("последняя правка планшета не применена: %q", treatment)
	}
}

// Отметка конфликта доезжает до планшетов через pull, а врач снимает её
// меткой conflict_resolved = detected_at разобранной версии. Обычная правка,
// своя копия conflict_json и устаревшая метка отметку не трогают.
func TestVisitConflictPulledAndResolved(t *testing.T) {
	a := concSeed(t)
	doPush(t, a, vEdit("tab-a", concA, 1, 2, "Гастроэнтерит", "Диета"))
	doPush(t, a, vEdit("tab-b", concB, 1, 2, "Гастрит", "Диета, пробиотик"))

	var pulled map[string]any
	for _, v := range doPull(t, a, "")["visits"] {
		if v["id"] == "v-c" {
			pulled = v
		}
	}
	if cj, _ := pulled["conflict_json"].(string); cj == "" {
		t.Fatalf("pull не отдал conflict_json: %v", pulled)
	}
	_, lost := visitConflicts(t, a)
	detected := lost[0].DetectedAt

	edit := func(device, at string, base, version int, diagnosis, extra string) string {
		return fmt.Sprintf(`{"visits":[{"id":"v-c","pet_id":"p-c","date":"%s","diagnosis":"%s",
			"treatment":"Диета, пробиотик","total_amount":5000,"version":%d,"base_version":%d,
			"device_id":"%s","updated_at":"%s"%s}]}`, concBase, diagnosis, version, base, device, at, extra)
	}
	// Обычная правка — отметка остаётся.
	doPush(t, a, edit("tab-b", "2026-09-01T13:00:00Z", 3, 4, "Гастрит", ""))
	if _, lost := visitConflicts(t, a); len(lost) != 1 {
		t.Fatalf("обычная правка сняла отметку: %+v", lost)
	}
	// Своя копия conflict_json с планшета игнорируется — пишет только сервер.
	doPush(t, a, edit("tab-b", "2026-09-01T13:05:00Z", 4, 5, "Гастрит", `,"conflict_json":""`))
	if _, lost := visitConflicts(t, a); len(lost) != 1 {
		t.Fatalf("conflict_json с планшета снял отметку: %+v", lost)
	}
	// Метка не та (устарела) — не снимаем.
	doPush(t, a, edit("tab-b", "2026-09-01T13:07:00Z", 5, 6, "Гастрит", `,"conflict_resolved":"2000-01-01T00:00:00Z"`))
	if _, lost := visitConflicts(t, a); len(lost) != 1 {
		t.Fatalf("устаревшая метка сняла отметку: %+v", lost)
	}
	// Врач разобрал и перенёс диагноз из проигравшей версии.
	doPush(t, a, edit("tab-b", "2026-09-01T13:10:00Z", 6, 7, "Гастроэнтерит", `,"conflict_resolved":"`+detected+`"`))
	if _, lost := visitConflicts(t, a); len(lost) != 0 {
		t.Errorf("отметка не снята после разбора: %+v", lost)
	}
	if d, _ := concVisit(t, a); d != "Гастроэнтерит" {
		t.Errorf("врач перенёс диагноз из конфликта, получили %q", d)
	}
}

// Планшет-победитель, ещё не получивший отметку, правит приём дальше: его
// push идёт без конфликта (сервер держит его же версию), и отметку он не
// стирает — метки разбора у него нет.
func TestVisitConflictSurvivesWinnerEdit(t *testing.T) {
	a := concSeed(t)
	doPush(t, a, vEdit("tab-b", concB, 1, 2, "Гастрит", "Диета, пробиотик"))
	doPush(t, a, vEdit("tab-a", concA, 1, 2, "Гастроэнтерит", "Диета")) // A проиграл
	doPush(t, a, vEdit("tab-b", "2026-09-01T13:00:00Z", 2, 3, "Гастрит", "Диета, пробиотик, покой"))
	if _, lost := visitConflicts(t, a); len(lost) != 1 {
		t.Errorf("правка победителя стёрла отметку: %+v", lost)
	}
}

// Повтор проигравшего push (ответ потерялся) второй записи не заводит.
func TestVisitConflictRetryNotDuplicated(t *testing.T) {
	a := concSeed(t)
	doPush(t, a, vEdit("tab-b", concB, 1, 2, "Гастрит", "Диета, пробиотик"))
	doPush(t, a, vEdit("tab-a", concA, 1, 2, "Гастроэнтерит", "Диета"))
	v1, _ := visitConflicts(t, a)
	doPush(t, a, vEdit("tab-a", concA, 1, 2, "Гастроэнтерит", "Диета"))
	v2, lost := visitConflicts(t, a)
	if len(lost) != 1 {
		t.Errorf("повтор push завёл запись заново: %d записей", len(lost))
	}
	// Повтор ничего не меняет — версия не растёт, планшеты не перерисовывают.
	if v2 != v1 {
		t.Errorf("повтор push поднял версию %d → %d без изменения данных", v1, v2)
	}
}

// После конфликта версия max+1 (4). Победитель, ещё не получивший её, правит
// дальше от старой базы с версией 3 — версия на сервере не должна откатиться,
// иначе другие планшеты отбросят его правку при pull.
func TestVisitConflictVersionNeverDecreases(t *testing.T) {
	a := concSeed(t)
	doPush(t, a, vEdit("tab-b", concB, 1, 2, "Гастрит", "Диета, пробиотик"))
	doPush(t, a, vEdit("tab-a", concA, 1, 3, "Гастроэнтерит", "Диета")) // версия 4
	doPush(t, a, vEdit("tab-b", "2026-09-01T13:00:00Z", 2, 3, "Гастрит", "Диета, пробиотик, покой"))
	version, _ := visitConflicts(t, a)
	if version <= 4 {
		t.Errorf("версия %d — откатилась или не выросла (была 4)", version)
	}
	if _, tr := concVisit(t, a); tr != "Диета, пробиотик, покой" {
		t.Errorf("правка победителя не применена: %q", tr)
	}
}

// Правка сильнее одновременного удаления: удалённый приём никто не откроет,
// и правка пропала бы из виду. Порядок синка не важен.
func TestVisitConflictEditBeatsDelete(t *testing.T) {
	del := func(at string) string {
		return `{"visits":[{"id":"v-c","pet_id":"p-c","date":"` + concBase + `","diagnosis":"Гастрит","treatment":"Диета",
			"total_amount":5000,"is_deleted":1,"deleted_at":"` + at + `","version":2,"base_version":1,"device_id":"tab-a","updated_at":"` + at + `"}]}`
	}
	for _, order := range []string{"правка, потом удаление", "удаление, потом правка"} {
		t.Run(order, func(t *testing.T) {
			a := concSeed(t)
			edit := vEdit("tab-b", concA, 1, 2, "Гастроэнтерит", "Диета")
			if order == "правка, потом удаление" {
				doPush(t, a, edit)
				doPush(t, a, del(concB)) // удаление позже по времени — всё равно проигрывает
			} else {
				doPush(t, a, del(concB))
				doPush(t, a, edit)
			}
			var deleted int
			a.db.QueryRow(`SELECT is_deleted FROM visits WHERE id='v-c'`).Scan(&deleted)
			if deleted != 0 {
				t.Fatal("приём удалён, правка пропала из виду")
			}
			if d, _ := concVisit(t, a); d != "Гастроэнтерит" {
				t.Errorf("в приёме должна быть правка, получили %q", d)
			}
			_, lost := visitConflicts(t, a)
			if len(lost) != 1 || lost[0].IsDeleted != 1 {
				t.Errorf("удаление должно лежать в конфликте, получили %+v", lost)
			}
		})
	}
}

// Снятая отметка доезжает до планшетов пустой строкой, а не пропуском ключа:
// иначе у них осталась бы старая отметка (слияние записи по ключам).
func TestVisitConflictClearedIsPulledAsEmpty(t *testing.T) {
	a := concSeed(t)
	rec := httptest.NewRecorder()
	a.handleSyncPull(rec, httptest.NewRequest(http.MethodGet, "/sync/pull", nil))
	if !strings.Contains(rec.Body.String(), `"conflict_json":""`) {
		t.Error(`pull не отдаёт "conflict_json":"" у приёма без конфликта`)
	}
}
