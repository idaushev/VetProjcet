package main

import (
	"context"
	"path/filepath"
	"testing"
	"time"
)

// Тесты ядра, где регресс тихий и дорогой: расчёт кассовой стоимости,
// курса лечения и — главное — разрешение конфликтов синхронизации.

func TestResolveCost(t *testing.T) {
	cases := []struct {
		name              string
		mode              string
		percent, price    float64
		costPrice         float64
		wantMode          string
		wantPct, wantCost float64
	}{
		{"fixed оставляет cost_price", "fixed", 0, 1000, 300, "fixed", 0, 300},
		{"пустой режим = fixed", "", 50, 1000, 250, "fixed", 0, 250},
		{"percent считает от цены", "percent", 50, 1000, 999, "percent", 50, 500},
		{"percent округляет до копейки", "percent", 33, 1000, 0, "percent", 33, 330},
		{"percent клампит >100", "percent", 150, 1000, 0, "percent", 100, 1000},
		{"percent клампит <0", "percent", -10, 1000, 0, "percent", 0, 0},
	}
	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			mode, pct, cost := resolveCost(c.mode, c.percent, c.price, c.costPrice)
			if mode != c.wantMode || pct != c.wantPct || cost != c.wantCost {
				t.Errorf("resolveCost(%q,%v,%v,%v) = (%q,%v,%v), ждём (%q,%v,%v)",
					c.mode, c.percent, c.price, c.costPrice, mode, pct, cost, c.wantMode, c.wantPct, c.wantCost)
			}
		})
	}
}

func TestResolveTreatment(t *testing.T) {
	base := time.Date(2026, 7, 20, 9, 0, 0, 0, time.UTC)

	if days, until := resolveTreatment(0, base); days != 0 || until != nil {
		t.Errorf("0 дней → (0,nil), получили (%d,%v)", days, until)
	}
	if days, until := resolveTreatment(-5, base); days != 0 || until != nil {
		t.Errorf("отрицательные дни → (0,nil), получили (%d,%v)", days, until)
	}
	// Курс «на N дней» включает день визита: until = visit + (N-1).
	if days, until := resolveTreatment(1, base); days != 1 || until == nil || !until.Equal(base) {
		t.Errorf("1 день → until = дата визита, получили %v", until)
	}
	if _, until := resolveTreatment(7, base); until == nil || !until.Equal(base.AddDate(0, 0, 6)) {
		t.Errorf("7 дней → until = визит+6, получили %v", until)
	}
	// Кап на maxTreatmentDays.
	if days, until := resolveTreatment(10000, base); days != maxTreatmentDays ||
		until == nil || !until.Equal(base.AddDate(0, 0, maxTreatmentDays-1)) {
		t.Errorf("10000 дней → кап %d, получили %d", maxTreatmentDays, days)
	}
}

func TestParseSyncTime(t *testing.T) {
	// Пустая строка и "null" → «сейчас» (не нулевое время): такие записи
	// не должны замораживаться при сравнении конфликтов.
	before := time.Now().Add(-time.Second)
	for _, v := range []string{"", "null", "  "} {
		got := parseSyncTime(v)
		if got.Before(before) {
			t.Errorf("parseSyncTime(%q) вернул прошлое %v, ждём ~сейчас", v, got)
		}
	}
	// Валидный RFC3339 разбирается как есть.
	want := time.Date(2026, 7, 20, 12, 30, 0, 0, time.UTC)
	got := parseSyncTime("2026-07-20T12:30:00Z")
	if !got.Equal(want) {
		t.Errorf("parseSyncTime RFC3339 = %v, ждём %v", got, want)
	}
}

// clientWinsVersion — сердце разрешения конфликтов. Проверяем на реальной
// схеме (openDB прогоняет миграции), а не на моках.
func TestClientWinsVersion(t *testing.T) {
	db, err := openDB(filepath.Join(t.TempDir(), "test.db"))
	if err != nil {
		t.Fatalf("openDB: %v", err)
	}
	defer db.Close()
	ctx := context.Background()

	t0 := "2026-07-20T10:00:00Z"
	insert := func(id string, version int, clientUpdated interface{}) {
		_, err := db.ExecContext(ctx,
			`INSERT INTO owners (id, fio, phone, version, client_updated_at) VALUES (?,?,?,?,?)`,
			id, "Тест", "+70000000000", version, clientUpdated)
		if err != nil {
			t.Fatalf("insert %s: %v", id, err)
		}
	}
	win := func(id, clientTime string, clientVersion int) bool {
		w, err := clientWinsVersion(ctx, db, "owners", id, clientTime, clientVersion)
		if err != nil {
			t.Fatalf("clientWinsVersion: %v", err)
		}
		return w
	}

	// Новой записи на сервере нет — принимаем.
	if !win("nope", t0, 1) {
		t.Error("новая запись (нет на сервере) должна приниматься")
	}

	insert("a", 2, t0)
	if !win("a", "2026-07-20T09:00:00Z", 3) {
		t.Error("бо́льшая версия клиента должна побеждать даже со старым временем")
	}
	if !win("a", "2026-07-20T11:00:00Z", 2) {
		t.Error("равная версия, время клиента новее → победа")
	}
	if win("a", "2026-07-20T09:00:00Z", 2) {
		t.Error("равная версия, время клиента старше → проигрыш")
	}
	if !win("a", t0, 2) {
		t.Error("равная версия, одинаковое время → принимаем (>=)")
	}

	// Legacy-запись без client_updated_at — принимаем, иначе заморозится навсегда.
	insert("b", 5, nil)
	if !win("b", "2020-01-01T00:00:00Z", 1) {
		t.Error("запись без client_updated_at должна приниматься")
	}
}
