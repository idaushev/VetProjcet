package main

import (
	"context"
	"fmt"
	"net/http"
	"sort"
	"strings"
	"time"
)

// Корзина: просмотр и восстановление мягко удалённых записей.
//
// Почему на сервере, а не в локальной базе планшета: при pull удалённые
// записи физически стираются из IndexedDB (Правило 0 в mergePulledStore —
// удаление применяется жёстко, чтобы гарантированно разойтись по устройствам).
// Значит единственное место, где удалённая карточка ещё существует, — SQLite
// на сервере. Оттуда её и показываем.
//
// Восстановление поднимает version: иначе устройства, у которых запись уже
// удалена, не примут её обратно при следующем pull.

const trashDays = 30 // сколько дней держим в корзине

// trashTable описывает, как показать запись пользователю: подпись типа
// и выражение для заголовка (у каждой сущности своё «имя»).
type trashTable struct {
	Table string
	Label string
	Title string // SQL-выражение, дающее человекочитаемое имя
}

var trashTables = []trashTable{
	{"owners", "Владелец", "COALESCE(NULLIF(fio,''),'без имени')"},
	{"pets", "Животное", "COALESCE(NULLIF(name,''),'без клички')"},
	{"visits", "Приём", "COALESCE(NULLIF(diagnosis,''), NULLIF(anamnesis,''),'без диагноза')"},
	{"vaccinations", "Вакцинация", "COALESCE(NULLIF(vaccine_name,''),'вакцинация')"},
	{"appointments", "Запись", "COALESCE(NULLIF(pet_name,''), NULLIF(client_name,''),'запись')"},
	{"items", "Позиция каталога", "COALESCE(NULLIF(name,''),'позиция')"},
}

func trashTableByName(name string) *trashTable {
	for i := range trashTables {
		if trashTables[i].Table == name {
			return &trashTables[i]
		}
	}
	return nil
}

type trashItem struct {
	Table     string  `json:"table"`
	Label     string  `json:"label"`
	ID        string  `json:"id"`
	Title     string  `json:"title"`
	DeletedAt *string `json:"deleted_at"`
}

// handleTrash отдаёт удалённые записи за последние trashDays дней.
func (a *app) handleTrash(w http.ResponseWriter, r *http.Request) {
	ctx, cancel := context.WithTimeout(r.Context(), 20*time.Second)
	defer cancel()

	user := userFromCtx(ctx)
	since := T(nowUTC().Add(-trashDays * 24 * time.Hour))

	out := make([]trashItem, 0, 64)
	for _, tt := range trashTables {
		// Корзина подчиняется тем же правам, что и таблица: видеть удалённое
		// в чужом разделе не должно быть проще, чем живое.
		if user != nil && user.tableLevel(trashPermTable(tt.Table)) < permLevels["view"] {
			continue
		}
		q := fmt.Sprintf(
			`SELECT id, %s, deleted_at FROM %s
			 WHERE is_deleted = 1 AND (deleted_at IS NULL OR deleted_at >= ?)
			 ORDER BY deleted_at DESC LIMIT 100`, tt.Title, tt.Table)
		rows, err := a.db.QueryContext(ctx, q, since)
		if err != nil {
			a.logger.Printf("Корзина: %s: %v", tt.Table, err)
			continue
		}
		for rows.Next() {
			var it trashItem
			var del timeScanner
			if err := rows.Scan(&it.ID, &it.Title, &del); err != nil {
				continue
			}
			it.Table, it.Label = tt.Table, tt.Label
			if del.t != nil {
				s := del.t.UTC().Format(time.RFC3339)
				it.DeletedAt = &s
			}
			out = append(out, it)
		}
		rows.Close()
	}

	// Свежеудалённые сверху; записи без даты (удалены до появления поля) — в конец.
	sort.SliceStable(out, func(i, j int) bool {
		a1, b1 := out[i].DeletedAt, out[j].DeletedAt
		if a1 == nil {
			return false
		}
		if b1 == nil {
			return true
		}
		return *a1 > *b1
	})

	writeJSON(w, http.StatusOK, apiResponse{Status: "ok", Data: map[string]interface{}{
		"items": out,
		"days":  trashDays,
	}})
}

// trashPermTable — та же карта прав, что в синхронизации: приёмы, позиции,
// записи и вложения относятся к праву на visits (медкарта).
func trashPermTable(table string) string {
	switch table {
	case "visit_items", "appointments":
		return "visits"
	default:
		return table
	}
}

// handleTrashRestore снимает признак удаления.
func (a *app) handleTrashRestore(w http.ResponseWriter, r *http.Request) {
	var p struct {
		Table string `json:"table"`
		ID    string `json:"id"`
	}
	if err := decodeJSON(r, &p); err != nil {
		writeError(w, http.StatusBadRequest, err.Error())
		return
	}
	tt := trashTableByName(strings.TrimSpace(p.Table))
	if tt == nil || strings.TrimSpace(p.ID) == "" {
		writeError(w, http.StatusBadRequest, "Неизвестная запись")
		return
	}

	ctx, cancel := context.WithTimeout(r.Context(), 10*time.Second)
	defer cancel()

	// Восстановление — это изменение записи: требуем право edit, как на правку.
	if u := userFromCtx(ctx); u != nil && u.tableLevel(trashPermTable(tt.Table)) < permLevels["edit"] {
		writeError(w, http.StatusForbidden, "Нет прав на восстановление этой записи")
		return
	}

	now := T(nowUTC())
	// version+1 обязателен: у устройств запись уже удалена, и принять её
	// обратно они согласятся только с более высокой версией.
	res, err := a.db.ExecContext(ctx, fmt.Sprintf(
		`UPDATE %s SET is_deleted = 0, deleted_at = NULL,
		        version = COALESCE(version,1) + 1,
		        updated_at = ?, client_updated_at = ?
		 WHERE id = ? AND is_deleted = 1`, tt.Table), now, now, p.ID)
	if err != nil {
		a.logger.Printf("Корзина: восстановление %s %s: %v", tt.Table, p.ID, err)
		writeError(w, http.StatusInternalServerError, "Не удалось восстановить запись")
		return
	}
	if n, _ := res.RowsAffected(); n == 0 {
		writeError(w, http.StatusNotFound, "Запись не найдена или уже восстановлена")
		return
	}
	a.logger.Printf("Корзина: восстановлена запись %s %s", tt.Table, p.ID)
	writeJSON(w, http.StatusOK, apiResponse{Status: "ok", Data: map[string]string{"id": p.ID}})
}
