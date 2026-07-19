package main

import (
	"crypto/rand"
	"database/sql"
	"database/sql/driver"
	"errors"
	"fmt"
	"math"
	"strings"
	"time"
)

// ─── Время в SQL ────────────────────────────────────────────────────────────
//
// Драйвер modernc.org/sqlite записывает time.Time через String(), то есть
// "2026-07-17 12:00:00 +0000 UTC". Такой формат не понимает ни SQLite
// (DATE() по нему возвращает пусто), ни сравнения дат: в базе оказывались
// вперемешку "2026-07-17T12:00:00Z" (из seed-скриптов), "2026-07-17 12:00:00"
// (из CURRENT_TIMESTAMP) и Go-формат. А сравнения в SQL строковые, и один и тот же
// момент времени в разных форматах сравнивается по-разному ('T' больше пробела) —
// из-за этого ломался инкрементальный pull (WHERE updated_at > since).
//
// sqlTime отдаёт драйверу RFC3339 — единый формат, понятный SQLite, JS и Go.
// Все значения времени должны уходить в SQL через T() или Tp().

type sqlTime time.Time

func (t sqlTime) Value() (driver.Value, error) {
	return time.Time(t).UTC().Format("2006-01-02T15:04:05.999Z07:00"), nil
}

// T — время для SQL-запроса.
func T(t time.Time) sqlTime { return sqlTime(t) }

// Tp — необязательное время для SQL-запроса: nil остаётся NULL.
func Tp(t *time.Time) interface{} {
	if t == nil {
		return nil
	}
	return sqlTime(*t)
}

// ─── UUID ───────────────────────────────────────────────────────────────────

func newUUID() (string, error) {
	var b [16]byte
	if _, err := rand.Read(b[:]); err != nil {
		return "", err
	}
	b[6] = (b[6] & 0x0f) | 0x40
	b[8] = (b[8] & 0x3f) | 0x80
	return fmt.Sprintf("%x-%x-%x-%x-%x", b[0:4], b[4:6], b[6:8], b[8:10], b[10:16]), nil
}

// ─── Нормализация строк ──────────────────────────────────────────────────────

func normalizeItemType(v string) string { return strings.ToLower(strings.TrimSpace(v)) }
func normalizeGender(v string) string   { return strings.ToLower(strings.TrimSpace(v)) }

func normalizePatientCondition(v string) string { return strings.TrimSpace(v) }

func normalizeAndValidatePatientCondition(v string) (string, error) {
	n := normalizePatientCondition(v)
	if n == "" {
		return "", nil
	}
	// Сравниваем без учёта регистра: клиент присылает «Здоров», «Стабильное» и т.п.
	switch strings.ToLower(n) {
	case "здоров", "стабильное", "лёгкое", "средней тяжести", "тяжелое", "крайне тяжелое", "терминальное",
		// обратная совместимость со старым значением
		"удовлетворительное":
		return n, nil
	default:
		return "", errors.New("patient_condition: здоров | стабильное | лёгкое | средней тяжести | тяжелое | крайне тяжелое | терминальное")
	}
}

// ─── Время ──────────────────────────────────────────────────────────────────

func nowUTC() time.Time { return time.Now().UTC() }

func parseFlexibleDate(v string) (time.Time, error) {
	v = strings.TrimSpace(v)
	// Форматы в порядке убывания специфичности.
	// Включает datetime-local ("2006-01-02T15:04") — формат HTML input[type=datetime-local].
	layouts := []string{
		time.RFC3339Nano,           // 2006-01-02T15:04:05.999999999Z07:00
		time.RFC3339,               // 2006-01-02T15:04:05Z07:00
		"2006-01-02T15:04:05",      // без таймзоны
		"2006-01-02T15:04",         // datetime-local без секунд (браузерный input)
		"2006-01-02 15:04:05",      // пробел вместо T
		"2006-01-02",               // только дата
	}
	for _, layout := range layouts {
		if t, err := time.Parse(layout, v); err == nil {
			return t, nil
		}
	}
	return time.Time{}, errors.New("invalid date format: " + v)
}

// parseSyncTime разбирает строку даты из sync-записи клиента.
// Возвращает nowUTC() при любой ошибке — запись всё равно принимается.
func parseSyncTime(v string) time.Time {
	v = strings.TrimSpace(v)
	if v == "" || v == "null" {
		return nowUTC()
	}
	t, err := parseFlexibleDate(v)
	if err != nil {
		return nowUTC()
	}
	return t
}

// parseSyncTimePtr разбирает опциональную строку даты из sync-записи.
// Возвращает nil для пустых значений.
func parseSyncTimePtr(v *string) *time.Time {
	if v == nil {
		return nil
	}
	s := strings.TrimSpace(*v)
	if s == "" || s == "null" {
		return nil
	}
	t, err := parseFlexibleDate(s)
	if err != nil {
		return nil
	}
	return &t
}

func parseVisitDate(v string) (time.Time, error) {
	v = strings.TrimSpace(v)
	if v == "" {
		return time.Time{}, errors.New("visit.date is required")
	}
	t, err := parseFlexibleDate(v)
	if err != nil {
		return time.Time{}, errors.New("visit.date must be RFC3339 or YYYY-MM-DD")
	}
	return t, nil
}

// ─── SQL helpers ─────────────────────────────────────────────────────────────

// nullableString возвращает nil для пустой строки, иначе trimmed string.
func nullableString(v string) interface{} {
	s := strings.TrimSpace(v)
	if s == "" {
		return nil
	}
	return s
}

func boolToInt(v bool) int {
	if v {
		return 1
	}
	return 0
}

// nullableTime — необязательное время для SQL. Отдаёт RFC3339 через sqlTime,
// иначе драйвер записал бы Go-формат (см. комментарий к sqlTime).
func nullableTime(t *time.Time) interface{} {
	return Tp(t)
}

func scanNullString(ns sql.NullString) string { return ns.String }
func scanNullTime(nt sql.NullTime) *time.Time {
	if !nt.Valid {
		return nil
	}
	return &nt.Time
}
func scanNullInt(ni sql.NullInt64) *int {
	if !ni.Valid {
		return nil
	}
	v := int(ni.Int64)
	return &v
}
func scanNullFloat(nf sql.NullFloat64) *float64 {
	if !nf.Valid {
		return nil
	}
	return &nf.Float64
}

// ─── Математика ─────────────────────────────────────────────────────────────

func roundMoney(v float64) float64 { return math.Round(v*100) / 100 }
