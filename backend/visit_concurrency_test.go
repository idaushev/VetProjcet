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
//   - правка приёма шлёт запись приёма целиком, а позиции счёта удаляет и
//     создаёт заново с новыми id (frontend/js/pages.js, сохранение правки);
//   - цикл синка — сначала pull, потом push (syncAll, frontend/js/sync.js).
//     Pull применяет удаления поверх неотправленных записей, поэтому второй
//     планшет надгробие исходной позиции уже НЕ отправляет: его стёр pull.

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
	newItem              string // id пересозданной позиции
	tombstone            bool   // шлёт ли надгробие i-base (только первый, см. выше)
}

func (e edit) payload() string {
	items := fmt.Sprintf(`{"id":"%s","visit_id":"v-c","item_id":"it-exam","name":"Осмотр","type":"service",
		"quantity":1,"price":5000,"total":5000,"version":1,"updated_at":"%s"}`, e.newItem, e.at)
	if e.tombstone {
		items = fmt.Sprintf(`{"id":"i-base","visit_id":"v-c","item_id":"it-exam","name":"Осмотр","type":"service",
			"quantity":1,"price":5000,"total":5000,"is_deleted":1,"deleted_at":"%[1]s","version":2,"updated_at":"%[1]s"},`,
			e.at) + items
	}
	return fmt.Sprintf(`{
		"visits":[{"id":"v-c","pet_id":"p-c","date":"%s","diagnosis":"%s","treatment":"%s",
			"total_amount":5000,"version":%d,"updated_at":"%s"}],
		"visit_items":[%s]}`, concBase, e.diagnosis, e.treatment, e.version, e.at, items)
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
	resA := doPush(t, a, edit{concA, 2, "Гастроэнтерит", "Диета", "i-a", true}.payload())
	resB := doPush(t, a, edit{concB, 2, "Гастрит", "Диета, пробиотик", "i-b", false}.payload())

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
	doPush(t, a, edit{concB, 2, "Гастрит", "Диета, пробиотик", "i-b", true}.payload())
	resA := doPush(t, a, edit{concA, 2, "Гастроэнтерит", "Диета", "i-a", false}.payload())

	diagnosis, treatment := concVisit(t, a)
	if treatment != "Диета, пробиотик" {
		t.Errorf("лечение от B: %q", treatment)
	}
	// TODO(VET-017): диагноз от A потерян — должен сохраниться или быть
	// сообщён конфликтом. Сегодня отклонён по времени клиента.
	if diagnosis != "Гастрит" {
		t.Errorf("поведение изменилось: диагноз %q — обновить тест под VET-017", diagnosis)
	}
	// Отклонён только приём A; его новая позиция i-a — новая запись, сервер
	// её принимает. Это и даёт задвоение (следующий тест).
	if skipped(resA) != 1 {
		t.Errorf("поведение изменилось: skipped A=%v, ждали 1", resA["skipped"])
	}
}

// A сохранил приём офлайн дважды (version 3), B — один раз, но позже
// (version 2). Версия побеждает время: правка B отклоняется, хотя она
// новее, и лечение B пропадает — даже если B синхронизировался первым.
func TestConcurrentVisitEditHigherVersionWinsRegardlessOfTime(t *testing.T) {
	a := concSeed(t)
	doPush(t, a, edit{concB, 2, "Гастрит", "Диета, пробиотик", "i-b", true}.payload())
	doPush(t, a, edit{concA, 3, "Гастроэнтерит", "Диета", "i-a", false}.payload())

	diagnosis, treatment := concVisit(t, a)
	// TODO(VET-017): лечение от B («Диета, пробиотик») потеряно — версия A
	// выше, и сервер принял его запись целиком поверх более поздней.
	if diagnosis != "Гастроэнтерит" || treatment != "Диета" {
		t.Errorf("поведение изменилось: диагноз %q, лечение %q — обновить тест под VET-017",
			diagnosis, treatment)
	}
}

// Позиции счёта. Каждый планшет удалил исходную позицию и создал свою, с
// новым id. Сервер принимает обе новые — в приёме два «Осмотра» на 10 000
// при total_amount 5000. Порядок синхронизации не важен.
//
// Отчёты по деньгам (дневной, выручка за период, заработок врача) считают
// по позициям — выручка завышена вдвое. Список приёмов и карточка владельца —
// по total_amount, и с отчётом расходятся. Следующее сохранение приёма
// пересоздаст обе строки и сделает total_amount = 10 000.
func TestConcurrentVisitEditDuplicatesItems(t *testing.T) {
	for _, order := range []string{"A затем B", "B затем A"} {
		t.Run(order, func(t *testing.T) {
			a := concSeed(t)
			if order == "A затем B" {
				doPush(t, a, edit{concA, 2, "Гастрит", "Диета", "i-a", true}.payload())
				doPush(t, a, edit{concB, 2, "Гастрит", "Диета", "i-b", false}.payload())
			} else {
				doPush(t, a, edit{concB, 2, "Гастрит", "Диета", "i-b", true}.payload())
				doPush(t, a, edit{concA, 2, "Гастрит", "Диета", "i-a", false}.payload())
			}
			n, sum := concItems(t, a)
			// TODO(VET-017): должна остаться одна позиция на 5000 — сегодня
			// их две на 10 000.
			if n != 2 || sum != 10000 {
				t.Errorf("поведение изменилось: позиций %d на %.0f — обновить тест под VET-017", n, sum)
			}
		})
	}
}
