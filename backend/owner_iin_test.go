package main

import "testing"

// Контрольный разряд ИИН/БИН. Проверка нужна не ради формальности: с неверным
// номером регистрация в ТАҢБА не проходит, а узнают об этом уже на портале.
func TestValidIINChecksum(t *testing.T) {
	// Валидные номера собраны алгоритмом: берём первые 11 цифр и дописываем
	// контрольную. Так тест не зависит от чьих-то настоящих ИИН.
	valid := []string{}
	for _, base := range []string{"88010130012", "01020350045", "99123145678"} {
		for d := 0; d <= 9; d++ {
			cand := base + string(rune('0'+d))
			if validIINChecksum(cand) {
				valid = append(valid, cand)
			}
		}
	}
	if len(valid) == 0 {
		t.Fatal("алгоритм не принял ни одного номера — проверь веса")
	}
	for _, v := range valid {
		if !validIINChecksum(v) {
			t.Errorf("%s должен быть валиден", v)
		}
		// Порча последней цифры обязана ломать проверку.
		bad := []byte(v)
		if bad[11] == '9' {
			bad[11] = '0'
		} else {
			bad[11]++
		}
		if validIINChecksum(string(bad)) {
			t.Errorf("%s: испорченная контрольная цифра принята", string(bad))
		}
	}

	for _, bad := range []string{"", "123", "12345678901", "1234567890123", "88010130012a"} {
		if validIINChecksum(bad) {
			t.Errorf("%q не должен проходить проверку", bad)
		}
	}
}

func TestNormalizeIINAndOwnerType(t *testing.T) {
	if got := normalizeIIN(" 880101 300-123 "); got != "880101300123" {
		t.Errorf("normalizeIIN = %q", got)
	}
	if got := normalizeOwnerType(""); got != "individual" {
		t.Errorf("пустой тип должен считаться физлицом, получили %q", got)
	}
	if got := normalizeOwnerType("LEGAL"); got != "legal" {
		t.Errorf("normalizeOwnerType(LEGAL) = %q", got)
	}
	if got := normalizeOwnerType("мусор"); got != "individual" {
		t.Errorf("неизвестный тип должен схлопываться в individual, получили %q", got)
	}
}
