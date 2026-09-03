package main

import (
	"context"
	"database/sql"
	"net/http"
	"strings"
	"time"
)

// Задачи сотрудникам: «перезвонить клиенту», «заказать препарат».
//
// Список «Требуют внимания» на дашборде показывает только то, что система
// выводит сама (заявки с портала, просроченные прививки, не вернувшиеся).
// Всё остальное до сих пор жило в голове и на бумажках. Задачи — обычная
// синкуемая таблица, поэтому создаются и офлайн.

type Task struct {
	ID       string  `json:"id"`
	Title    string  `json:"title"`
	Note     string  `json:"note"`
	DueDate  *string `json:"due_date"`
	Done     int     `json:"done"`
	OwnerRef string  `json:"owner_ref"`
	StaffID  string  `json:"staff_id"`
	// Ссылки на случай: пусто у организационных задач.
	PetID    string  `json:"pet_id,omitempty"`
	VisitID  string  `json:"visit_id,omitempty"`
	SyncMeta
}

func (t Task) recordID() string { return t.ID }

const taskSelectAll = `
SELECT id, title, COALESCE(note,''), due_date, COALESCE(done,0),
       COALESCE(owner_ref,''), COALESCE(staff_id,''),
       COALESCE(pet_id,''), COALESCE(visit_id,''),
       created_at, updated_at, deleted_at, is_deleted,
       COALESCE(device_id,''), COALESCE(version,1)
FROM tasks`

func scanTask(rows *sql.Rows) (Task, error) {
	var t Task
	var due, created, updated, deleted timeScanner
	err := rows.Scan(&t.ID, &t.Title, &t.Note, &due, &t.Done, &t.OwnerRef, &t.StaffID,
		&t.PetID, &t.VisitID,
		&created, &updated, &deleted, &t.IsDeleted, &t.DeviceID, &t.Version)
	if err != nil {
		return t, err
	}
	if due.t != nil {
		s := due.t.Format(time.RFC3339)
		t.DueDate = &s
	}
	if created.t != nil {
		t.CreatedAt = *created.t
	}
	if updated.t != nil {
		t.UpdatedAt = *updated.t
	}
	t.DeletedAt = deleted.t
	return t, nil
}

// ─── HTTP ────────────────────────────────────────────────────────────────────

func (a *app) handleTasks(w http.ResponseWriter, r *http.Request) {
	switch r.Method {
	case http.MethodGet:
		ctx, cancel := context.WithTimeout(r.Context(), 10*time.Second)
		defer cancel()
		rows, err := a.db.QueryContext(ctx, taskSelectAll+` WHERE is_deleted = 0 ORDER BY done, due_date`)
		if err != nil {
			a.logger.Printf("listTasks: %v", err)
			writeError(w, http.StatusInternalServerError, "Не удалось загрузить задачи")
			return
		}
		defer rows.Close()
		list := make([]Task, 0, 32)
		for rows.Next() {
			t, err := scanTask(rows)
			if err != nil {
				continue
			}
			list = append(list, t)
		}
		writeJSON(w, http.StatusOK, apiResponse{Status: "ok", Data: list})

	case http.MethodPost:
		var p struct {
			Title    string `json:"title"`
			Note     string `json:"note"`
			DueDate  string `json:"due_date"`
			OwnerRef string `json:"owner_ref"`
			StaffID  string `json:"staff_id"`
			PetID    string `json:"pet_id"`
			VisitID  string `json:"visit_id"`
		}
		if err := decodeJSON(r, &p); err != nil {
			writeError(w, http.StatusBadRequest, err.Error())
			return
		}
		if strings.TrimSpace(p.Title) == "" {
			writeError(w, http.StatusBadRequest, "Опишите задачу")
			return
		}
		ctx, cancel := context.WithTimeout(r.Context(), 10*time.Second)
		defer cancel()
		id, err := newUUID()
		if err != nil {
			writeError(w, http.StatusInternalServerError, "failed to generate id")
			return
		}
		now := T(nowUTC())
		_, err = a.db.ExecContext(ctx, `
			INSERT INTO tasks (id, title, note, due_date, done, owner_ref, staff_id,
			        pet_id, visit_id,
			        created_at, updated_at, client_updated_at, is_deleted, version)
			VALUES (?, ?, ?, ?, 0, ?, ?, ?, ?, ?, ?, ?, 0, 1)`,
			id, strings.TrimSpace(p.Title), strings.TrimSpace(p.Note),
			Tp(parseSyncTimePtr(&p.DueDate)),
			nullableString(p.OwnerRef), nullableString(p.StaffID),
			nullableString(p.PetID), nullableString(p.VisitID), now, now, now)
		if err != nil {
			a.logger.Printf("createTask: %v", err)
			writeError(w, http.StatusInternalServerError, "Не удалось сохранить задачу")
			return
		}
		writeJSON(w, http.StatusCreated, apiResponse{Status: "ok", Data: map[string]string{"id": id}})

	default:
		writeError(w, http.StatusMethodNotAllowed, "method not allowed")
	}
}

func (a *app) handleTaskByID(w http.ResponseWriter, r *http.Request) {
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
			Title   *string `json:"title"`
			Note    *string `json:"note"`
			DueDate *string `json:"due_date"`
			Done    *int    `json:"done"`
		}
		if err := decodeJSON(r, &p); err != nil {
			writeError(w, http.StatusBadRequest, err.Error())
			return
		}
		// Обновляем только то, что прислали: отметка «выполнено» приходит
		// одна, без остальных полей, и не должна их затирать.
		sets := []string{"updated_at=?", "client_updated_at=?", "version=COALESCE(version,1)+1"}
		args := []interface{}{now, now}
		if p.Title != nil {
			sets = append([]string{"title=?"}, sets...)
			args = append([]interface{}{strings.TrimSpace(*p.Title)}, args...)
		}
		if p.Note != nil {
			sets = append(sets, "note=?")
			args = append(args, strings.TrimSpace(*p.Note))
		}
		if p.DueDate != nil {
			sets = append(sets, "due_date=?")
			args = append(args, Tp(parseSyncTimePtr(p.DueDate)))
		}
		if p.Done != nil {
			sets = append(sets, "done=?")
			args = append(args, *p.Done)
		}
		args = append(args, id)
		res, err := a.db.ExecContext(ctx,
			`UPDATE tasks SET `+strings.Join(sets, ", ")+` WHERE id=? AND is_deleted=0`, args...)
		if err != nil {
			a.logger.Printf("updateTask: %v", err)
			writeError(w, http.StatusInternalServerError, "Не удалось сохранить")
			return
		}
		if n, _ := res.RowsAffected(); n == 0 {
			writeError(w, http.StatusNotFound, "Задача не найдена")
			return
		}
		writeJSON(w, http.StatusOK, apiResponse{Status: "ok", Data: map[string]string{"id": id}})

	case http.MethodDelete:
		res, err := a.db.ExecContext(ctx, `
			UPDATE tasks SET is_deleted=1, deleted_at=?, updated_at=?, client_updated_at=?,
			    version=COALESCE(version,1)+1
			WHERE id=? AND is_deleted=0`, now, now, now, id)
		if err != nil {
			a.logger.Printf("deleteTask: %v", err)
			writeError(w, http.StatusInternalServerError, "Не удалось удалить")
			return
		}
		if n, _ := res.RowsAffected(); n == 0 {
			writeError(w, http.StatusNotFound, "Задача не найдена")
			return
		}
		writeJSON(w, http.StatusOK, apiResponse{Status: "ok", Data: map[string]string{"id": id}})

	default:
		writeError(w, http.StatusMethodNotAllowed, "method not allowed")
	}
}

// ─── Синхронизация ───────────────────────────────────────────────────────────

type taskSyncRecord struct {
	ID        string  `json:"id"`
	Title     string  `json:"title"`
	Note      string  `json:"note"`
	DueDate   *string `json:"due_date"`
	Done      int     `json:"done"`
	OwnerRef  string  `json:"owner_ref"`
	StaffID   string  `json:"staff_id"`
	PetID     string  `json:"pet_id"`
	VisitID   string  `json:"visit_id"`
	UpdatedAt string  `json:"updated_at"`
	DeletedAt *string `json:"deleted_at"`
	IsDeleted int     `json:"is_deleted"`
	DeviceID  string  `json:"device_id"`
	Version   int     `json:"version"`
}

func (r taskSyncRecord) recordID() string { return r.ID }

func pushTask(ctx context.Context, db *sql.DB, rec taskSyncRecord) (bool, error) {
	if rec.ID == "" {
		return false, nil
	}
	wins, err := clientWinsVersion(ctx, db, "tasks", rec.ID, rec.UpdatedAt, rec.Version)
	if err != nil || !wins {
		return false, err
	}
	serverNow := T(nowUTC())
	clientAt := Tp(parseSyncTimePtr(&rec.UpdatedAt))
	_, err = db.ExecContext(ctx, `
		INSERT INTO tasks (id, title, note, due_date, done, owner_ref, staff_id,
		        pet_id, visit_id,
		        created_at, updated_at, deleted_at, is_deleted, device_id, version, client_updated_at)
		VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
		ON CONFLICT(id) DO UPDATE SET
		  title=excluded.title, note=excluded.note, due_date=excluded.due_date,
		  done=excluded.done, owner_ref=excluded.owner_ref, staff_id=excluded.staff_id,
		  pet_id=excluded.pet_id, visit_id=excluded.visit_id,
		  updated_at=excluded.updated_at, deleted_at=excluded.deleted_at,
		  is_deleted=excluded.is_deleted, device_id=excluded.device_id,
		  version=excluded.version, client_updated_at=excluded.client_updated_at`,
		rec.ID, rec.Title, rec.Note, Tp(parseSyncTimePtr(rec.DueDate)), rec.Done,
		nullableString(rec.OwnerRef), nullableString(rec.StaffID),
		nullableString(rec.PetID), nullableString(rec.VisitID),
		serverNow, serverNow, Tp(parseSyncTimePtr(rec.DeletedAt)), rec.IsDeleted,
		nullableString(rec.DeviceID), rec.Version, clientAt)
	return err == nil, err
}

func pullTasks(ctx context.Context, db *sql.DB, since time.Time) ([]Task, error) {
	q := taskSelectAll
	var args []interface{}
	if !since.IsZero() {
		q += ` WHERE updated_at > ?`
		args = []interface{}{S(since)}
	}
	rows, err := db.QueryContext(ctx, q, args...)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	list := make([]Task, 0, 32)
	for rows.Next() {
		t, err := scanTask(rows)
		if err != nil {
			continue
		}
		list = append(list, t)
	}
	return list, nil
}
