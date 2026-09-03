package main

import (
	"context"
	"encoding/json"
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
