package main

import (
	"context"
	"database/sql"
	"encoding/json"
)

// Стартовые бланки протоколов.
//
// Заводятся ОДИН РАЗ — на базе, где протоколов не было никогда (проверяем
// вместе с удалёнными, иначе удалённый клиникой бланк воскресал бы после
// каждого перезапуска). Дальше это обычные записи: клиника правит и удаляет
// их сама, синхронизация разносит правки по планшетам.
//
// НОРМЫ. Границы разнесены по видам, а не усреднены: у кошки и собаки они
// расходятся так, что общая «норма» подсвечивала бы здоровое животное как
// больное. Где вид не влияет заметно (биохимия) — бланк один. Это ОРИЕНТИР:
// границы зависят от анализатора и метода, и клиника обязана сверить их со
// своей лабораторией. Поэтому нормы лежат в данных, а не в коде.
type seedField struct {
	Key     string   `json:"key"`
	Label   string   `json:"label"`
	Type    string   `json:"type"`
	Unit    string   `json:"unit,omitempty"`
	RefLow  *float64 `json:"ref_low"`
	RefHigh *float64 `json:"ref_high"`
	Options []string `json:"options,omitempty"`
	Group   string   `json:"group,omitempty"`
}

// Число с нормой.
func sfNum(key, label, unit string, lo, hi float64) seedField {
	return seedField{Key: key, Label: label, Type: "number", Unit: unit, RefLow: &lo, RefHigh: &hi}
}

// Число без нормы: единица есть, границы клиника проставит сама.
func sfNumFree(key, label, unit string) seedField {
	return seedField{Key: key, Label: label, Type: "number", Unit: unit}
}

func sfText(key, label, group string) seedField {
	return seedField{Key: key, Label: label, Type: "textarea", Group: group}
}

func sfLine(key, label, group string) seedField {
	return seedField{Key: key, Label: label, Type: "text", Group: group}
}

func sfCheck(key, label, group string) seedField {
	return seedField{Key: key, Label: label, Type: "check", Group: group}
}

func sfSelect(key, label, group string, opts ...string) seedField {
	return seedField{Key: key, Label: label, Type: "select", Group: group, Options: opts}
}

func sfGNum(key, label, unit, group string, lo, hi float64) seedField {
	return seedField{Key: key, Label: label, Type: "number", Unit: unit, Group: group, RefLow: &lo, RefHigh: &hi}
}

func sfGNumFree(key, label, unit, group string) seedField {
	return seedField{Key: key, Label: label, Type: "number", Unit: unit, Group: group}
}

type seedTemplate struct {
	Name   string
	Kind   string
	Notes  string
	Fields []seedField
}

func starterProtocols() []seedTemplate {
	const refNote = "Нормы — ориентир: границы зависят от анализатора и метода. " +
		"Сверьте со своей лабораторией и поправьте прямо здесь."

	cbcDog := []seedField{
		sfNum("rbc", "Эритроциты (RBC)", "×10¹²/л", 5.5, 8.5),
		sfNum("hgb", "Гемоглобин (HGB)", "г/л", 120, 180),
		sfNum("hct", "Гематокрит (HCT)", "%", 37, 55),
		sfNum("mcv", "Средний объём эритроцита (MCV)", "фл", 60, 77),
		sfNum("mchc", "Средняя концентрация гемоглобина (MCHC)", "г/л", 320, 360),
		sfNum("plt", "Тромбоциты (PLT)", "×10⁹/л", 200, 500),
		sfNum("wbc", "Лейкоциты (WBC)", "×10⁹/л", 6.0, 17.0),
		sfNum("neut_seg", "Нейтрофилы сегментоядерные", "%", 60, 77),
		sfNum("neut_band", "Нейтрофилы палочкоядерные", "%", 0, 3),
		sfNum("lymph", "Лимфоциты", "%", 12, 30),
		sfNum("mono", "Моноциты", "%", 3, 10),
		sfNum("eos", "Эозинофилы", "%", 2, 10),
		sfNum("baso", "Базофилы", "%", 0, 1),
		sfNum("esr", "СОЭ", "мм/ч", 0, 13),
	}
	cbcCat := []seedField{
		sfNum("rbc", "Эритроциты (RBC)", "×10¹²/л", 5.0, 10.0),
		sfNum("hgb", "Гемоглобин (HGB)", "г/л", 80, 150),
		sfNum("hct", "Гематокрит (HCT)", "%", 24, 45),
		sfNum("mcv", "Средний объём эритроцита (MCV)", "фл", 39, 55),
		sfNum("mchc", "Средняя концентрация гемоглобина (MCHC)", "г/л", 300, 360),
		sfNum("plt", "Тромбоциты (PLT)", "×10⁹/л", 300, 700),
		sfNum("wbc", "Лейкоциты (WBC)", "×10⁹/л", 5.5, 18.5),
		sfNum("neut_seg", "Нейтрофилы сегментоядерные", "%", 35, 75),
		sfNum("neut_band", "Нейтрофилы палочкоядерные", "%", 0, 3),
		sfNum("lymph", "Лимфоциты", "%", 20, 55),
		sfNum("mono", "Моноциты", "%", 1, 4),
		sfNum("eos", "Эозинофилы", "%", 2, 12),
		sfNum("baso", "Базофилы", "%", 0, 1),
		sfNum("esr", "СОЭ", "мм/ч", 0, 13),
	}
	// Общий хвост обоих ОАК: качество пробы решает, можно ли вообще доверять
	// цифрам выше, и при спорном результате спрашивают об этом первым.
	cbcTail := []seedField{
		sfCheck("hemolysis", "Гемолиз пробы", "Качество пробы"),
		sfCheck("lipemia", "Липемия пробы", "Качество пробы"),
		sfText("smear", "Морфология мазка", "Качество пробы"),
	}

	bio := []seedField{
		sfNum("protein", "Общий белок", "г/л", 55, 75),
		sfNum("albumin", "Альбумин", "г/л", 25, 40),
		sfNum("glucose", "Глюкоза", "ммоль/л", 3.3, 6.5),
		sfNum("urea", "Мочевина", "ммоль/л", 3.5, 9.0),
		sfNum("creatinine", "Креатинин", "мкмоль/л", 40, 140),
		sfNum("alt", "АЛТ", "Ед/л", 10, 70),
		sfNum("ast", "АСТ", "Ед/л", 10, 50),
		sfNum("alp", "Щелочная фосфатаза", "Ед/л", 10, 150),
		sfNum("bilirubin", "Билирубин общий", "мкмоль/л", 2, 12),
		sfNumFree("amylase", "Амилаза", "Ед/л"),
		sfNum("calcium", "Кальций общий", "ммоль/л", 2.2, 3.0),
		sfNum("phosphorus", "Фосфор", "ммоль/л", 0.9, 2.0),
		sfNum("potassium", "Калий", "ммоль/л", 3.8, 5.6),
		sfNum("sodium", "Натрий", "ммоль/л", 140, 155),
		sfNum("cholesterol", "Холестерин", "ммоль/л", 3.0, 7.0),
		sfCheck("hemolysis", "Гемолиз пробы", "Качество пробы"),
	}

	// УЗИ: орган описывают несколькими полями сразу — размер числом, содержимое
	// текстом, находку галочкой. Раздел собирает их в один блок.
	usAbdomen := []seedField{
		sfSelect("prep", "Подготовка", "Условия", "натощак", "не натощак", "экстренно"),
		sfLine("device", "Аппарат / датчик", "Условия"),

		sfGNumFree("liver_size", "Край за рёберной дугой", "см", "Печень"),
		sfSelect("liver_echo", "Эхогенность", "Печень", "снижена", "норма", "повышена"),
		sfSelect("liver_struct", "Структура", "Печень", "однородная", "неоднородная"),
		sfCheck("liver_focal", "Очаговые образования", "Печень"),
		sfText("liver_note", "Описание", "Печень"),

		sfGNumFree("gb_wall", "Толщина стенки", "мм", "Жёлчный пузырь"),
		sfSelect("gb_content", "Содержимое", "Жёлчный пузырь", "анэхогенное", "сладж", "конкременты"),
		sfText("gb_note", "Описание", "Жёлчный пузырь"),

		sfGNumFree("spleen_thick", "Толщина", "см", "Селезёнка"),
		sfSelect("spleen_echo", "Эхогенность", "Селезёнка", "снижена", "норма", "повышена"),
		sfText("spleen_note", "Описание", "Селезёнка"),

		sfGNumFree("kidney_l", "Левая, длина", "см", "Почки"),
		sfGNumFree("kidney_r", "Правая, длина", "см", "Почки"),
		sfSelect("kidney_cm", "Кортико-медуллярная дифференциация", "Почки", "сохранена", "снижена", "отсутствует"),
		sfCheck("kidney_stones", "Конкременты", "Почки"),
		sfCheck("kidney_pyelo", "Расширение лоханки", "Почки"),
		sfText("kidney_note", "Описание", "Почки"),

		// Пример из практики: мочевой пузырь описывают числом (стенка),
		// текстом (содержимое) и галочками (взвесь, конкременты) сразу.
		sfSelect("bladder_fill", "Наполнение", "Мочевой пузырь", "слабое", "умеренное", "выраженное"),
		sfGNum("bladder_wall", "Толщина стенки", "мм", "Мочевой пузырь", 1, 2.5),
		sfLine("bladder_content", "Содержимое", "Мочевой пузырь"),
		sfCheck("bladder_sediment", "Взвесь", "Мочевой пузырь"),
		sfCheck("bladder_stones", "Конкременты", "Мочевой пузырь"),
		sfText("bladder_note", "Описание", "Мочевой пузырь"),

		sfGNumFree("gi_wall", "Толщина стенки кишечника", "мм", "ЖКТ"),
		sfSelect("gi_layers", "Слоистость стенки", "ЖКТ", "сохранена", "нарушена"),
		sfSelect("gi_peristalsis", "Перистальтика", "ЖКТ", "снижена", "норма", "усилена"),
		sfText("gi_note", "Описание", "ЖКТ"),

		sfCheck("free_fluid", "Свободная жидкость", "Прочее"),
		sfGNumFree("lymph_nodes", "Лимфоузлы, максимальный размер", "мм", "Прочее"),
		sfText("other_note", "Прочие находки", "Прочее"),
	}

	return []seedTemplate{
		{Name: "Общий анализ крови — собака", Kind: "lab", Notes: refNote,
			Fields: append(append([]seedField{}, cbcDog...), cbcTail...)},
		{Name: "Общий анализ крови — кошка", Kind: "lab", Notes: refNote,
			Fields: append(append([]seedField{}, cbcCat...), cbcTail...)},
		{Name: "Биохимия крови", Kind: "lab",
			Notes:  refNote + " У кошки и собаки границы по этим показателям расходятся мало, поэтому бланк общий.",
			Fields: bio},
		{Name: "УЗИ брюшной полости", Kind: "ultrasound",
			Notes:  "Пустые поля в протокол не идут — заполняйте только осмотренное.",
			Fields: usAbdomen},
	}
}

// seedProtocolTemplates заводит стартовые бланки, если протоколов не было
// никогда. Считаем ВМЕСТЕ с удалёнными: иначе бланк, который клиника убрала
// как ненужный, возвращался бы при следующем запуске сервера.
func seedProtocolTemplates(ctx context.Context, db *sql.DB) {
	var n int
	if err := db.QueryRowContext(ctx, `SELECT COUNT(*) FROM protocol_templates`).Scan(&n); err != nil || n > 0 {
		return
	}
	for _, t := range starterProtocols() {
		raw, err := json.Marshal(t.Fields)
		if err != nil {
			continue
		}
		id, err := newUUID()
		if err != nil {
			continue
		}
		_, _ = db.ExecContext(ctx, `
			INSERT INTO protocol_templates (id, name, kind, fields, notes, device_id, version)
			VALUES (?, ?, ?, ?, ?, 'server', 1)`,
			id, t.Name, t.Kind, string(raw), t.Notes)
	}
}
