package main

import (
	"context"
	"database/sql"
	"net/http"
	"strings"
	"time"
)

// Результаты услуг: шаблоны протоколов и заполненные результаты.
//
// Зачем. Часть услуг заканчивается не записью в приёме, а документом: анализ
// крови, УЗИ, рентген. Раньше такой документ было некуда положить — врач
// прикреплял скан к приёму и надеялся, что в следующий раз его найдёт. Теперь
// услуга в каталоге помечается флагом «требует результата», и приём сам
// заводит строку ожидания.
//
// Почему две таблицы. protocol_templates — что заполнять (конструктор,
// правит только администратор). visit_results — что заполнено по конкретному
// приёму. Результат бывает файлом, протоколом или и тем и другим, поэтому в
// visit_results есть и values_json, и attachment_id.
//
// Почему status='pending'. Это не украшение, а рабочий список: пробу взяли,
// результата нет. Без него забытый анализ всплывает через неделю, когда
// владелец звонит сам.
//
// Синхронизация обычная: version-first, client_updated_at, создание офлайн.
// values_json разрешается конфликтом целиком — два человека один протокол
// одновременно не заполняют, дробить merge по полям незачем.

// ─── Шаблоны протоколов ──────────────────────────────────────────────────────

type ProtocolTemplate struct {
	ID     string `json:"id"`
	Name   string `json:"name"`
	Kind   string `json:"kind"`
	Fields string `json:"fields"` // JSON-массив описаний полей
	Notes  string `json:"notes,omitempty"`
	SyncMeta
}

func (p ProtocolTemplate) recordID() string { return p.ID }

const protocolSelectAll = `
SELECT id, name, COALESCE(kind,'lab'), COALESCE(fields,'[]'), COALESCE(notes,''),
       created_at, updated_at, deleted_at, is_deleted,
       COALESCE(device_id,''), COALESCE(version,1)
FROM protocol_templates`

func scanProtocol(rows *sql.Rows) (ProtocolTemplate, error) {
	var p ProtocolTemplate
	var created, updated, deleted timeScanner
	err := rows.Scan(&p.ID, &p.Name, &p.Kind, &p.Fields, &p.Notes,
		&created, &updated, &deleted, &p.IsDeleted, &p.DeviceID, &p.Version)
	if err != nil {
		return p, err
	}
	if created.t != nil {
		p.CreatedAt = *created.t
	}
	if updated.t != nil {
		p.UpdatedAt = *updated.t
	}
	p.DeletedAt = deleted.t
	return p, nil
}

// normalizeProtocolKind — вид документа. Влияет только на подпись и значок.
func normalizeProtocolKind(k string) string {
	switch strings.ToLower(strings.TrimSpace(k)) {
	case "ultrasound", "xray", "other":
		return strings.ToLower(strings.TrimSpace(k))
	}
	return "lab"
}

func (a *app) handleProtocols(w http.ResponseWriter, r *http.Request) {
	ctx, cancel := context.WithTimeout(r.Context(), 10*time.Second)
	defer cancel()

	switch r.Method {
	case http.MethodGet:
		rows, err := a.db.QueryContext(ctx, protocolSelectAll+` WHERE is_deleted = 0 ORDER BY name`)
		if err != nil {
			a.logger.Printf("listProtocols: %v", err)
			writeError(w, http.StatusInternalServerError, "Не удалось загрузить шаблоны")
			return
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
		writeJSON(w, http.StatusOK, apiResponse{Status: "ok", Data: list})

	case http.MethodPost:
		var p struct {
			ID     string `json:"id"`
			Name   string `json:"name"`
			Kind   string `json:"kind"`
			Fields string `json:"fields"`
			Notes  string `json:"notes"`
		}
		if err := decodeJSON(r, &p); err != nil {
			writeError(w, http.StatusBadRequest, err.Error())
			return
		}
		if strings.TrimSpace(p.Name) == "" {
			writeError(w, http.StatusBadRequest, "Укажите название шаблона")
			return
		}
		id := strings.TrimSpace(p.ID)
		if id == "" {
			var err error
			if id, err = newUUID(); err != nil {
				writeError(w, http.StatusInternalServerError, "failed to generate id")
				return
			}
		}
		now := T(nowUTC())
		if _, err := a.db.ExecContext(ctx, `
			INSERT INTO protocol_templates (id, name, kind, fields, notes,
			        created_at, updated_at, client_updated_at, is_deleted, version)
			VALUES (?, ?, ?, ?, ?, ?, ?, ?, 0, 1)`,
			id, strings.TrimSpace(p.Name), normalizeProtocolKind(p.Kind),
			defaultJSON(p.Fields, "[]"), nullableString(p.Notes), now, now, now); err != nil {
			a.logger.Printf("createProtocol: %v", err)
			writeError(w, http.StatusInternalServerError, "Не удалось сохранить шаблон")
			return
		}
		writeJSON(w, http.StatusCreated, apiResponse{Status: "ok", Data: map[string]string{"id": id}})

	default:
		writeError(w, http.StatusMethodNotAllowed, "method not allowed")
	}
}

func (a *app) handleProtocolByID(w http.ResponseWriter, r *http.Request) {
	id := strings.TrimSpace(r.PathValue("id"))
	if id == "" {
		writeError(w, http.StatusBadRequest, "id is required")
		return
	}
	ctx, cancel := context.WithTimeout(r.Context(), 10*time.Second)
	defer cancel()
	now := T(nowUTC())

	switch r.Method {
	case http.MethodPut:
		var p struct {
			Name   *string `json:"name"`
			Kind   *string `json:"kind"`
			Fields *string `json:"fields"`
			Notes  *string `json:"notes"`
		}
		if err := decodeJSON(r, &p); err != nil {
			writeError(w, http.StatusBadRequest, err.Error())
			return
		}
		// Обновляем только присланное: правка одного поля не должна стирать
		// остальные (та же логика, что в задачах).
		sets := []string{"updated_at=?", "client_updated_at=?", "version=COALESCE(version,1)+1"}
		args := []interface{}{now, now}
		if p.Name != nil {
			sets = append([]string{"name=?"}, sets...)
			args = append([]interface{}{strings.TrimSpace(*p.Name)}, args...)
		}
		if p.Kind != nil {
			sets = append(sets, "kind=?")
			args = append(args, normalizeProtocolKind(*p.Kind))
		}
		if p.Fields != nil {
			sets = append(sets, "fields=?")
			args = append(args, defaultJSON(*p.Fields, "[]"))
		}
		if p.Notes != nil {
			sets = append(sets, "notes=?")
			args = append(args, nullableString(*p.Notes))
		}
		args = append(args, id)
		res, err := a.db.ExecContext(ctx,
			`UPDATE protocol_templates SET `+strings.Join(sets, ", ")+` WHERE id=? AND is_deleted=0`, args...)
		if err != nil {
			a.logger.Printf("updateProtocol: %v", err)
			writeError(w, http.StatusInternalServerError, "Не удалось сохранить")
			return
		}
		if n, _ := res.RowsAffected(); n == 0 {
			writeError(w, http.StatusNotFound, "Шаблон не найден")
			return
		}
		writeJSON(w, http.StatusOK, apiResponse{Status: "ok", Data: map[string]string{"id": id}})

	case http.MethodDelete:
		res, err := a.db.ExecContext(ctx, `
			UPDATE protocol_templates SET is_deleted=1, deleted_at=?, updated_at=?,
			    client_updated_at=?, version=COALESCE(version,1)+1
			WHERE id=? AND is_deleted=0`, now, now, now, id)
		if err != nil {
			a.logger.Printf("deleteProtocol: %v", err)
			writeError(w, http.StatusInternalServerError, "Не удалось удалить")
			return
		}
		if n, _ := res.RowsAffected(); n == 0 {
			writeError(w, http.StatusNotFound, "Шаблон не найден")
			return
		}
		writeJSON(w, http.StatusOK, apiResponse{Status: "ok", Data: map[string]string{"id": id}})

	default:
		writeError(w, http.StatusMethodNotAllowed, "method not allowed")
	}
}

// normalizeResultMode — что услуга требует по завершении.
// none — обычная услуга; file — только документ; protocol — только заполнение
// вручную; both — и снимок, и заключение (типичное УЗИ).
func normalizeResultMode(m string) string {
	switch strings.ToLower(strings.TrimSpace(m)) {
	case "file", "protocol", "both":
		return strings.ToLower(strings.TrimSpace(m))
	}
	return "none"
}

// ─── Заполненные результаты ──────────────────────────────────────────────────

type VisitResult struct {
	ID           string     `json:"id"`
	VisitID      string     `json:"visit_id"`
	PetID        string     `json:"pet_id"`
	VisitItemID  string     `json:"visit_item_id,omitempty"`
	ItemID       string     `json:"item_id,omitempty"`
	// Номер исследования по этой услуге в приёме: второе УЗИ — seq=1.
	Seq          int        `json:"seq"`
	Title        string     `json:"title"`
	TemplateID   string     `json:"template_id,omitempty"`
	Kind         string     `json:"kind"`
	Values       string     `json:"values_json"`
	// Поля бланка на момент заполнения — чтобы запись читалась без шаблона.
	FieldsSnap   string     `json:"fields_snapshot,omitempty"`
	AttachmentID string     `json:"attachment_id,omitempty"`
	Conclusion   string     `json:"conclusion,omitempty"`
	// Лаборатория-исполнитель: свободный текст (VET-008, вопрос 14).
	LabName      string     `json:"lab_name,omitempty"`
	Status       string     `json:"status"`
	FilledAt     *time.Time `json:"filled_at,omitempty"`
	SyncMeta
}

func (v VisitResult) recordID() string { return v.ID }

const resultSelectAll = `
SELECT id, visit_id, pet_id, COALESCE(visit_item_id,''), COALESCE(item_id,''),
       COALESCE(seq,0), title, COALESCE(template_id,''), COALESCE(kind,'protocol'),
       COALESCE(values_json,'{}'), COALESCE(fields_snapshot,''), COALESCE(attachment_id,''),
       COALESCE(conclusion,''), COALESCE(lab_name,''), COALESCE(status,'pending'), filled_at,
       created_at, updated_at, deleted_at, is_deleted,
       COALESCE(device_id,''), COALESCE(version,1)
FROM visit_results`

func scanResult(rows *sql.Rows) (VisitResult, error) {
	var v VisitResult
	var filled, created, updated, deleted timeScanner
	err := rows.Scan(&v.ID, &v.VisitID, &v.PetID, &v.VisitItemID, &v.ItemID,
		&v.Seq, &v.Title, &v.TemplateID, &v.Kind, &v.Values, &v.FieldsSnap, &v.AttachmentID,
		&v.Conclusion, &v.LabName, &v.Status, &filled,
		&created, &updated, &deleted, &v.IsDeleted, &v.DeviceID, &v.Version)
	if err != nil {
		return v, err
	}
	v.FilledAt = filled.ptr()
	if created.t != nil {
		v.CreatedAt = *created.t
	}
	if updated.t != nil {
		v.UpdatedAt = *updated.t
	}
	v.DeletedAt = deleted.t
	return v, nil
}

func normalizeResultKind(k string) string {
	if strings.ToLower(strings.TrimSpace(k)) == "file" {
		return "file"
	}
	return "protocol"
}

func normalizeResultStatus(s string) string {
	if strings.ToLower(strings.TrimSpace(s)) == "done" {
		return "done"
	}
	return "pending"
}

// defaultJSON — подстраховка от пустой строки в колонке, объявленной NOT NULL
// с JSON-значением. Пустая строка не разбирается ни на клиенте, ни в отчёте.
func defaultJSON(v, def string) string {
	v = strings.TrimSpace(v)
	if v == "" {
		return def
	}
	return v
}

func (a *app) handleResults(w http.ResponseWriter, r *http.Request) {
	ctx, cancel := context.WithTimeout(r.Context(), 10*time.Second)
	defer cancel()

	switch r.Method {
	case http.MethodGet:
		q := resultSelectAll + ` WHERE is_deleted = 0`
		var args []interface{}
		if v := strings.TrimSpace(r.URL.Query().Get("visit_id")); v != "" {
			q += ` AND visit_id = ?`
			args = append(args, v)
		}
		if p := strings.TrimSpace(r.URL.Query().Get("pet_id")); p != "" {
			q += ` AND pet_id = ?`
			args = append(args, p)
		}
		if s := strings.TrimSpace(r.URL.Query().Get("status")); s != "" {
			q += ` AND status = ?`
			args = append(args, normalizeResultStatus(s))
		}
		q += ` ORDER BY created_at DESC`
		rows, err := a.db.QueryContext(ctx, q, args...)
		if err != nil {
			a.logger.Printf("listResults: %v", err)
			writeError(w, http.StatusInternalServerError, "Не удалось загрузить результаты")
			return
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
		writeJSON(w, http.StatusOK, apiResponse{Status: "ok", Data: list})

	case http.MethodPost:
		var p struct {
			ID           string `json:"id"`
			VisitID      string `json:"visit_id"`
			PetID        string `json:"pet_id"`
			VisitItemID  string `json:"visit_item_id"`
			ItemID       string `json:"item_id"`
			Seq          int    `json:"seq"`
			Title        string `json:"title"`
			TemplateID   string `json:"template_id"`
			Kind         string `json:"kind"`
			Values       string `json:"values_json"`
			FieldsSnap   string `json:"fields_snapshot"`
			AttachmentID string `json:"attachment_id"`
			Conclusion   string `json:"conclusion"`
			LabName      string `json:"lab_name"`
			Status       string `json:"status"`
		}
		if err := decodeJSON(r, &p); err != nil {
			writeError(w, http.StatusBadRequest, err.Error())
			return
		}
		if strings.TrimSpace(p.VisitID) == "" || strings.TrimSpace(p.PetID) == "" {
			writeError(w, http.StatusBadRequest, "visit_id и pet_id обязательны")
			return
		}
		id := strings.TrimSpace(p.ID)
		if id == "" {
			var err error
			if id, err = newUUID(); err != nil {
				writeError(w, http.StatusInternalServerError, "failed to generate id")
				return
			}
		}
		status := normalizeResultStatus(p.Status)
		now := T(nowUTC())
		var filled interface{}
		if status == "done" {
			filled = now
		}
		if _, err := a.db.ExecContext(ctx, `
			INSERT INTO visit_results (id, visit_id, pet_id, visit_item_id, item_id, seq, title,
			        template_id, kind, values_json, fields_snapshot, attachment_id, conclusion, lab_name, status, filled_at,
			        created_at, updated_at, client_updated_at, is_deleted, version)
			VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, 1)`,
			id, p.VisitID, p.PetID, nullableString(p.VisitItemID), nullableString(p.ItemID),
			p.Seq, strings.TrimSpace(p.Title), nullableString(p.TemplateID), normalizeResultKind(p.Kind),
			defaultJSON(p.Values, "{}"), nullableString(p.FieldsSnap), nullableString(p.AttachmentID),
			nullableString(p.Conclusion), nullableString(p.LabName), status, filled, now, now, now); err != nil {
			a.logger.Printf("createResult: %v", err)
			writeError(w, http.StatusInternalServerError, "Не удалось сохранить результат")
			return
		}
		writeJSON(w, http.StatusCreated, apiResponse{Status: "ok", Data: map[string]string{"id": id}})

	default:
		writeError(w, http.StatusMethodNotAllowed, "method not allowed")
	}
}

func (a *app) handleResultByID(w http.ResponseWriter, r *http.Request) {
	id := strings.TrimSpace(r.PathValue("id"))
	if id == "" {
		writeError(w, http.StatusBadRequest, "id is required")
		return
	}
	ctx, cancel := context.WithTimeout(r.Context(), 10*time.Second)
	defer cancel()
	now := T(nowUTC())

	switch r.Method {
	case http.MethodPut:
		var p struct {
			Values       *string `json:"values_json"`
			FieldsSnap   *string `json:"fields_snapshot"`
			Conclusion   *string `json:"conclusion"`
			LabName      *string `json:"lab_name"`
			Status       *string `json:"status"`
			AttachmentID *string `json:"attachment_id"`
			Kind         *string `json:"kind"`
			TemplateID   *string `json:"template_id"`
		}
		if err := decodeJSON(r, &p); err != nil {
			writeError(w, http.StatusBadRequest, err.Error())
			return
		}
		sets := []string{"updated_at=?", "client_updated_at=?", "version=COALESCE(version,1)+1"}
		args := []interface{}{now, now}
		if p.Values != nil {
			sets = append([]string{"values_json=?"}, sets...)
			args = append([]interface{}{defaultJSON(*p.Values, "{}")}, args...)
		}
		// Снимок полей ставим ОДИН РАЗ — при первом заполнении. Правка записи
		// его не переписывает: врач исправляет цифру в том бланке, по которому
		// исследование и делали, а не в сегодняшней редакции справочника.
		if p.FieldsSnap != nil && strings.TrimSpace(*p.FieldsSnap) != "" {
			sets = append(sets, "fields_snapshot=COALESCE(NULLIF(fields_snapshot,''), ?)")
			args = append(args, strings.TrimSpace(*p.FieldsSnap))
		}
		if p.Conclusion != nil {
			sets = append(sets, "conclusion=?")
			args = append(args, nullableString(*p.Conclusion))
		}
		if p.LabName != nil {
			sets = append(sets, "lab_name=?")
			args = append(args, nullableString(*p.LabName))
		}
		if p.AttachmentID != nil {
			sets = append(sets, "attachment_id=?")
			args = append(args, nullableString(*p.AttachmentID))
		}
		if p.Kind != nil {
			sets = append(sets, "kind=?")
			args = append(args, normalizeResultKind(*p.Kind))
		}
		if p.TemplateID != nil {
			sets = append(sets, "template_id=?")
			args = append(args, nullableString(*p.TemplateID))
		}
		if p.Status != nil {
			st := normalizeResultStatus(*p.Status)
			sets = append(sets, "status=?")
			args = append(args, st)
			// Дату заполнения ставим при первом переходе в «внесён» и больше
			// не трогаем: она отвечает на вопрос «когда пришёл результат»,
			// а не «когда последний раз правили».
			if st == "done" {
				sets = append(sets, "filled_at=COALESCE(filled_at, ?)")
				args = append(args, now)
			}
		}
		args = append(args, id)
		res, err := a.db.ExecContext(ctx,
			`UPDATE visit_results SET `+strings.Join(sets, ", ")+` WHERE id=? AND is_deleted=0`, args...)
		if err != nil {
			a.logger.Printf("updateResult: %v", err)
			writeError(w, http.StatusInternalServerError, "Не удалось сохранить")
			return
		}
		if n, _ := res.RowsAffected(); n == 0 {
			writeError(w, http.StatusNotFound, "Результат не найден")
			return
		}
		writeJSON(w, http.StatusOK, apiResponse{Status: "ok", Data: map[string]string{"id": id}})

	case http.MethodDelete:
		res, err := a.db.ExecContext(ctx, `
			UPDATE visit_results SET is_deleted=1, deleted_at=?, updated_at=?,
			    client_updated_at=?, version=COALESCE(version,1)+1
			WHERE id=? AND is_deleted=0`, now, now, now, id)
		if err != nil {
			a.logger.Printf("deleteResult: %v", err)
			writeError(w, http.StatusInternalServerError, "Не удалось удалить")
			return
		}
		if n, _ := res.RowsAffected(); n == 0 {
			writeError(w, http.StatusNotFound, "Результат не найден")
			return
		}
		writeJSON(w, http.StatusOK, apiResponse{Status: "ok", Data: map[string]string{"id": id}})

	default:
		writeError(w, http.StatusMethodNotAllowed, "method not allowed")
	}
}
