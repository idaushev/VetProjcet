package main

import (
	"context"
	"errors"
	"math"
	"net/http"
	"strings"
	"time"
)

func (a *app) handleItems(w http.ResponseWriter, r *http.Request) {
	switch r.Method {
	case http.MethodGet:
		a.listItems(w, r)
	case http.MethodPost:
		a.createItem(w, r)
	default:
		writeError(w, http.StatusMethodNotAllowed, "method not allowed")
	}
}

func (a *app) handleItemByID(w http.ResponseWriter, r *http.Request) {
	id := strings.TrimSpace(r.PathValue("id"))
	if id == "" {
		writeError(w, http.StatusBadRequest, "id is required")
		return
	}
	switch r.Method {
	case http.MethodGet:
		a.getItemDetail(w, r, id)
	case http.MethodPut:
		a.updateItem(w, r, id)
	case http.MethodDelete:
		a.deleteItem(w, r, id)
	default:
		writeError(w, http.StatusMethodNotAllowed, "method not allowed")
	}
}

func (a *app) listItems(w http.ResponseWriter, r *http.Request) {
	ctx, cancel := context.WithTimeout(r.Context(), 5*time.Second)
	defer cancel()

	q := `SELECT id, name, type, price, COALESCE(cost_price,0), COALESCE(cost_mode,'fixed'), COALESCE(cost_percent,0), COALESCE(purchase_price,0), is_active, created_at, updated_at, deleted_at, is_deleted, COALESCE(device_id,''), COALESCE(version,1)
	      FROM items WHERE is_deleted = 0 AND is_active = 1`
	args := make([]interface{}, 0, 2)

	if t := normalizeItemType(r.URL.Query().Get("type")); t != "" {
		q += ` AND type = ?`
		args = append(args, t)
	}
	if s := strings.TrimSpace(r.URL.Query().Get("search")); s != "" {
		q += ` AND name LIKE ?`
		args = append(args, "%"+s+"%")
	}
	q += ` ORDER BY name ASC`

	rows, err := a.db.QueryContext(ctx, q, args...)
	if err != nil {
		a.logger.Printf("listItems: %v", err)
		writeError(w, http.StatusInternalServerError, "failed to load items")
		return
	}
	defer rows.Close()

	items := make([]Item, 0)
	for rows.Next() {
		item, err := scanItem(rows)
		if err != nil {
			a.logger.Printf("listItems scan: %v", err)
			writeError(w, http.StatusInternalServerError, "failed to load items")
			return
		}
		items = append(items, item)
	}
	if err := rows.Err(); err != nil {
		a.logger.Printf("listItems rows: %v", err)
		writeError(w, http.StatusInternalServerError, "failed to load items")
		return
	}
	writeJSON(w, http.StatusOK, apiResponse{Status: "ok", Data: items})
}

func (a *app) getItemDetail(w http.ResponseWriter, r *http.Request, id string) {
	ctx, cancel := context.WithTimeout(r.Context(), 5*time.Second)
	defer cancel()
	item, err := a.getItemByID(ctx, id)
	if err != nil {
		writeError(w, http.StatusNotFound, "item not found")
		return
	}
	writeJSON(w, http.StatusOK, apiResponse{Status: "ok", Data: item})
}

func (a *app) createItem(w http.ResponseWriter, r *http.Request) {
	var p itemPayload
	if err := decodeJSON(r, &p); err != nil {
		writeError(w, http.StatusBadRequest, err.Error())
		return
	}
	if err := validateItemPayload(p); err != nil {
		writeError(w, http.StatusBadRequest, err.Error())
		return
	}

	id, err := newUUID()
	if err != nil {
		writeError(w, http.StatusInternalServerError, "failed to generate id")
		return
	}

	ctx, cancel := context.WithTimeout(r.Context(), 5*time.Second)
	defer cancel()

	mode, percent, cost := resolveCost(p.CostMode, p.CostPercent, p.Price, p.CostPrice)

	now := T(nowUTC())
	if _, err := a.db.ExecContext(ctx,
		`INSERT INTO items (id, name, type, price, cost_price, cost_mode, cost_percent, purchase_price, is_active, created_at, updated_at, version)
		 VALUES (?, ?, ?, ?, ?, ?, ?, ?, 1, ?, ?, 1)`,
		id, strings.TrimSpace(p.Name), normalizeItemType(p.Type), p.Price, cost, mode, percent, p.PurchasePrice, now, now,
	); err != nil {
		a.logger.Printf("createItem: %v", err)
		writeError(w, http.StatusInternalServerError, "failed to create item")
		return
	}

	item, err := a.getItemByID(ctx, id)
	if err != nil {
		writeError(w, http.StatusInternalServerError, "failed to reload item")
		return
	}
	writeJSON(w, http.StatusCreated, apiResponse{Status: "ok", Data: item})
}

func (a *app) updateItem(w http.ResponseWriter, r *http.Request, id string) {
	var p itemPayload
	if err := decodeJSON(r, &p); err != nil {
		writeError(w, http.StatusBadRequest, err.Error())
		return
	}
	if err := validateItemPayload(p); err != nil {
		writeError(w, http.StatusBadRequest, err.Error())
		return
	}

	isActive := true
	if p.IsActive != nil {
		isActive = *p.IsActive
	}

	ctx, cancel := context.WithTimeout(r.Context(), 5*time.Second)
	defer cancel()

	mode, percent, cost := resolveCost(p.CostMode, p.CostPercent, p.Price, p.CostPrice)

	res, err := a.db.ExecContext(ctx,
		`UPDATE items SET name=?, type=?, price=?, cost_price=?, cost_mode=?, cost_percent=?, purchase_price=?, is_active=?, updated_at=?, version=version+1
		 WHERE id=? AND is_deleted=0`,
		strings.TrimSpace(p.Name), normalizeItemType(p.Type), p.Price, cost, mode, percent, p.PurchasePrice,
		boolToInt(isActive), T(nowUTC()), id,
	)
	if err != nil {
		a.logger.Printf("updateItem: %v", err)
		writeError(w, http.StatusInternalServerError, "failed to update item")
		return
	}
	if n, _ := res.RowsAffected(); n == 0 {
		writeError(w, http.StatusNotFound, "item not found")
		return
	}

	item, _ := a.getItemByID(ctx, id)
	writeJSON(w, http.StatusOK, apiResponse{Status: "ok", Data: item})
}

func (a *app) deleteItem(w http.ResponseWriter, r *http.Request, id string) {
	ctx, cancel := context.WithTimeout(r.Context(), 5*time.Second)
	defer cancel()

	now := T(nowUTC())
	res, err := a.db.ExecContext(ctx,
		`UPDATE items SET is_deleted=1, deleted_at=?, is_active=0, updated_at=?, version=version+1
		 WHERE id=? AND is_deleted=0`,
		now, now, id,
	)
	if err != nil {
		a.logger.Printf("deleteItem: %v", err)
		writeError(w, http.StatusInternalServerError, "failed to delete item")
		return
	}
	if n, _ := res.RowsAffected(); n == 0 {
		writeError(w, http.StatusNotFound, "item not found")
		return
	}
	writeJSON(w, http.StatusOK, apiResponse{Status: "ok", Data: map[string]string{"id": id}})
}

// ─── DB helpers ───────────────────────────────────────────────────────────────

func (a *app) getItemByID(ctx context.Context, id string) (Item, error) {
	row := a.db.QueryRowContext(ctx,
		`SELECT id, name, type, price, COALESCE(cost_price,0), COALESCE(cost_mode,'fixed'), COALESCE(cost_percent,0), COALESCE(purchase_price,0), is_active, created_at, updated_at, deleted_at, is_deleted, COALESCE(device_id,''), COALESCE(version,1)
		 FROM items WHERE id=?`, id)
	return scanItem(row)
}

func scanItem(s interface {
	Scan(...interface{}) error
}) (Item, error) {
	var item Item
	var isActive int
	var createdAt, updatedAt, deletedAt timeScanner
	err := s.Scan(
		&item.ID, &item.Name, &item.Type, &item.Price, &item.CostPrice,
		&item.CostMode, &item.CostPercent, &item.PurchasePrice, &isActive,
		&createdAt, &updatedAt, &deletedAt,
		&item.IsDeleted, &item.DeviceID, &item.Version,
	)
	if err != nil {
		return Item{}, err
	}
	item.IsActive = isActive == 1
	if createdAt.t != nil { item.CreatedAt = *createdAt.t }
	if updatedAt.t != nil { item.UpdatedAt = *updatedAt.t }
	item.DeletedAt = deletedAt.ptr()
	return item, nil
}

// resolveCost приводит режим кассовой стоимости к каноническому виду и считает
// итоговую сумму в тенге.
//
// percent — кассовая = price * percent / 100, пересчитывается при каждой смене цены.
// fixed   — кассовая задана суммой как есть.
//
// Пустой режим означает старого клиента, который про проценты не знает:
// он шлёт только cost_price, и мы обязаны сохранить его без изменений.
func resolveCost(mode string, percent, price, costPrice float64) (string, float64, float64) {
	if strings.TrimSpace(mode) != "percent" {
		return "fixed", 0, costPrice
	}
	if percent < 0 {
		percent = 0
	}
	if percent > 100 {
		percent = 100
	}
	return "percent", percent, math.Round(price*percent/100*100) / 100
}

func validateItemPayload(p itemPayload) error {
	if strings.TrimSpace(p.Name) == "" {
		return errors.New("name is required")
	}
	t := normalizeItemType(p.Type)
	if t != "service" && t != "drug" {
		return errors.New("type must be service or drug")
	}
	if p.Price < 0 {
		return errors.New("price must be >= 0")
	}
	if m := strings.TrimSpace(p.CostMode); m != "" && m != "fixed" && m != "percent" {
		return errors.New("cost_mode must be fixed or percent")
	}
	if p.CostPercent < 0 || p.CostPercent > 100 {
		return errors.New("cost_percent must be between 0 and 100")
	}
	return nil
}

// timeScanner — универсальная обёртка для DATETIME из SQLite.
// Обрабатывает все форматы, включая SQLite CURRENT_TIMESTAMP ("2025-05-17 14:30:00")
// и RFC3339 ("2025-05-17T14:30:00Z").
// ВАЖНО: прямое сканирование в time.Time падает на формате с пробелом вместо T,
// что ломало GET /sync/pull и приводило к тому, что удалённые записи не синхронизировались.
type timeScanner struct{ t *time.Time }

func (ts *timeScanner) Scan(value interface{}) error {
	if value == nil {
		ts.t = nil
		return nil
	}
	switch v := value.(type) {
	case time.Time:
		ts.t = &v
	case string:
		// Все форматы, используемые SQLite и Go
		layouts := []string{
			time.RFC3339Nano,            // 2025-05-17T14:30:00.000000000Z
			time.RFC3339,               // 2025-05-17T14:30:00Z
			"2006-01-02T15:04:05",      // без timezone
			"2006-01-02T15:04",         // datetime-local браузера
			"2006-01-02 15:04:05.999999999+07:00", // SQLite with tz
			"2006-01-02 15:04:05+07:00",
			"2006-01-02 15:04:05",      // SQLite CURRENT_TIMESTAMP (пробел вместо T)
			"2006-01-02",               // только дата
		}
		for _, layout := range layouts {
			if t, err := time.Parse(layout, v); err == nil {
				ts.t = &t
				return nil
			}
		}
		// Не удалось распарсить — ставим nil, не возвращаем ошибку
		// (ошибка здесь ломала весь pull)
		ts.t = nil
	}
	return nil
}
func (ts *timeScanner) ptr() *time.Time { return ts.t }
