package main

import (
	"fmt"
	"testing"
)

// ─── TECH-006: конкурентная правка приёма ────────────────────────────────────
//
// Два планшета получили один и тот же приём, оба ушли в офлайн и правят его,
// потом по очереди синхронизируются. Тесты ниже ФИКСИРУЮТ СЕГОДНЯШНЕЕ
// поведение — оно плохое, и это сделано намеренно: они проходят сейчас и
// станут приёмкой VET-017. Исправляя VET-017, переписать ассерты, помеченные
// TODO(VET-017), на желаемое поведение — это и будет доказательством, что
// задача закрыта.
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
	// TODO(VET-017): диагноз от A должен сохраниться («Гастроэнтерит») или
	// конфликт должен быть сообщён. Сегодня — молча откатился к исходному.
	if diagnosis != "Гастрит" {
		t.Errorf("поведение изменилось: диагноз %q — обновить тест под VET-017", diagnosis)
	}
	// TODO(VET-017): ответ push должен сообщать о конфликте. Сегодня оба
	// push просто приняты.
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
	// TODO(VET-017): диагноз от A потерян — должен сохраниться или быть
	// сообщён конфликтом. Сегодня отклонён по времени клиента.
	if diagnosis != "Гастрит" {
		t.Errorf("поведение изменилось: диагноз %q — обновить тест под VET-017", diagnosis)
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
	// TODO(VET-017): лечение от B («Диета, пробиотик») потеряно — версия A
	// выше, и сервер принял его запись целиком поверх более поздней.
	if diagnosis != "Гастроэнтерит" || treatment != "Диета" {
		t.Errorf("поведение изменилось: диагноз %q, лечение %q — обновить тест под VET-017",
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
			// TODO(VET-017, шаг 2): правка A по этой строке теряется молча —
			// должна быть сообщена конфликтом.
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
