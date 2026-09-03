package main

import (
	"context"
	"database/sql"
	"time"
)

// Синхронизация шаблонов протоколов и результатов.
//
// Обе сущности обычные: version-first, время клиента в client_updated_at,
// создание и правка офлайн. Ничего особенного, кроме одного — см. COALESCE
// в pushVisitResult.

type protocolSyncRecord struct {
	ID        string  `json:"id"`
	Name      string  `json:"name"`
	Kind      string  `json:"kind"`
	Fields    string  `json:"fields"`
	Notes     string  `json:"notes"`
	UpdatedAt string  `json:"updated_at"`
	DeletedAt *string `json:"deleted_at"`
	IsDeleted int     `json:"is_deleted"`
	DeviceID  string  `json:"device_id"`
	Version   int     `json:"version"`
}

func (r protocolSyncRecord) recordID() string { return r.ID }

func pushProtocol(ctx context.Context, db *sql.DB, rec protocolSyncRecord) (bool, error) {
	if rec.ID == "" {
		return false, nil
	}
	wins, err := clientWinsVersion(ctx, db, "protocol_templates", rec.ID, rec.UpdatedAt, rec.Version)
	if err != nil || !wins {
		return false, err
	}
	serverNow := T(nowUTC())
	clientAt := Tp(parseSyncTimePtr(&rec.UpdatedAt))
	_, err = db.ExecContext(ctx, `
		INSERT INTO protocol_templates (id, name, kind, fields, notes,
		        created_at, updated_at, deleted_at, is_deleted, device_id, version, client_updated_at)
		VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
		ON CONFLICT(id) DO UPDATE SET
		  name=excluded.name, kind=excluded.kind, fields=excluded.fields,
		  notes=excluded.notes, updated_at=excluded.updated_at,
		  deleted_at=excluded.deleted_at, is_deleted=excluded.is_deleted,
		  device_id=excluded.device_id, version=excluded.version,
		  client_updated_at=excluded.client_updated_at`,
		rec.ID, rec.Name, normalizeProtocolKind(rec.Kind), defaultJSON(rec.Fields, "[]"),
		nullableString(rec.Notes), serverNow, serverNow,
		Tp(parseSyncTimePtr(rec.DeletedAt)), rec.IsDeleted,
		nullableString(rec.DeviceID), rec.Version, clientAt)
	return err == nil, err
}

func pullProtocols(ctx context.Context, db *sql.DB, since time.Time) ([]ProtocolTemplate, error) {
	q := protocolSelectAll
	var args []interface{}
	if !since.IsZero() {
		q += ` WHERE updated_at >= ?`
		args = []interface{}{S(since)}
	}
	rows, err := db.QueryContext(ctx, q, args...)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	list := make([]ProtocolTemplate, 0, 16)
	for rows.Next() {
		p, err := scanProtocol(rows)
		if err != nil {
			continue
		}
		list = append(list, p)
	}
	return list, nil
}

// ─── Результаты ──────────────────────────────────────────────────────────────

type resultSyncRecord struct {
	ID           string  `json:"id"`
	VisitID      string  `json:"visit_id"`
	PetID        string  `json:"pet_id"`
	VisitItemID  string  `json:"visit_item_id"`
	ItemID       string  `json:"item_id"`
	Title        string  `json:"title"`
	TemplateID   string  `json:"template_id"`
	Kind         string  `json:"kind"`
	Values       string  `json:"values_json"`
	AttachmentID string  `json:"attachment_id"`
	Conclusion   string  `json:"conclusion"`
	LabName      string  `json:"lab_name"`
	Status       string  `json:"status"`
	FilledAt     *string `json:"filled_at"`
	UpdatedAt    string  `json:"updated_at"`
	DeletedAt    *string `json:"deleted_at"`
	IsDeleted    int     `json:"is_deleted"`
	DeviceID     string  `json:"device_id"`
	Version      int     `json:"version"`
}

func (r resultSyncRecord) recordID() string { return r.ID }

func pushVisitResult(ctx context.Context, db *sql.DB, rec resultSyncRecord) (bool, error) {
	if rec.ID == "" || rec.VisitID == "" {
		return false, nil
	}
	wins, err := clientWinsVersion(ctx, db, "visit_results", rec.ID, rec.UpdatedAt, rec.Version)
	if err != nil || !wins {
		return false, err
	}
	serverNow := T(nowUTC())
	clientAt := Tp(parseSyncTimePtr(&rec.UpdatedAt))
	status := normalizeResultStatus(rec.Status)
	// filled_at отвечает на вопрос «когда пришёл результат», и по нему кабинет
	// владельца сортирует список. Планшет, заполнивший протокол офлайн, эту
	// дату не присылает — проставляем сами, но только при первом переходе в
	// «внесён»: COALESCE ниже не даст затереть уже известную.
	filledAt := Tp(parseSyncTimePtr(rec.FilledAt))
	if filledAt == nil && status == "done" {
		filledAt = serverNow
	}
	_, err = db.ExecContext(ctx, `
		INSERT INTO visit_results (id, visit_id, pet_id, visit_item_id, item_id, title,
		        template_id, kind, values_json, attachment_id, conclusion, lab_name, status, filled_at,
		        created_at, updated_at, deleted_at, is_deleted, device_id, version, client_updated_at)
		VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
		ON CONFLICT(id) DO UPDATE SET
		  visit_item_id=excluded.visit_item_id, item_id=excluded.item_id,
		  title=excluded.title, template_id=excluded.template_id, kind=excluded.kind,
		  values_json=excluded.values_json,
		  -- Файл прикрепляется отдельным механизмом (очередь вложений) и может
		  -- доехать раньше, чем планшет пришлёт запись результата. Пустая
		  -- ссылка от клиента не должна стирать уже привязанный файл.
		  attachment_id=COALESCE(excluded.attachment_id, visit_results.attachment_id),
		  conclusion=excluded.conclusion, lab_name=excluded.lab_name, status=excluded.status,
		  filled_at=COALESCE(excluded.filled_at, visit_results.filled_at),
		  updated_at=excluded.updated_at, deleted_at=excluded.deleted_at,
		  is_deleted=excluded.is_deleted, device_id=excluded.device_id,
		  version=excluded.version, client_updated_at=excluded.client_updated_at`,
		rec.ID, rec.VisitID, rec.PetID, nullableString(rec.VisitItemID), nullableString(rec.ItemID),
		rec.Title, nullableString(rec.TemplateID), normalizeResultKind(rec.Kind),
		defaultJSON(rec.Values, "{}"), nullableString(rec.AttachmentID),
		nullableString(rec.Conclusion), nullableString(rec.LabName), status, filledAt,
		serverNow, serverNow, Tp(parseSyncTimePtr(rec.DeletedAt)), rec.IsDeleted,
		nullableString(rec.DeviceID), rec.Version, clientAt)
	return err == nil, err
}

func pullVisitResults(ctx context.Context, db *sql.DB, since time.Time) ([]VisitResult, error) {
	q := resultSelectAll
	var args []interface{}
	if !since.IsZero() {
		q += ` WHERE updated_at >= ?`
		args = []interface{}{S(since)}
	}
	rows, err := db.QueryContext(ctx, q, args...)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	list := make([]VisitResult, 0, 32)
	for rows.Next() {
		v, err := scanResult(rows)
		if err != nil {
			continue
		}
		list = append(list, v)
	}
	return list, nil
}
