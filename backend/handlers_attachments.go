package main

// Вложения к приёму: сканы УЗИ, рентгена, бланки анализов, фото.
//
// Файлы лежат на диске сервера (data/attachments/ГГГГ/ММ/<id>.<ext>), в базе —
// только метаданные. Скан рентгена весит мегабайты, а база целиком ездит через
// синхронизацию, поэтому base64 в таблице (как у pets.photo) здесь неприменим.
//
// Офлайн: планшет снимает файл без сети и держит его в своей очереди,
// отправляя при появлении связи. Просмотр чужих сканов требует сети — так решено
// осознанно, иначе пришлось бы качать все файлы клиники на каждый планшет.

import (
	"context"
	"fmt"
	"io"
	"net/http"
	"os"
	"path/filepath"
	"strings"
	"time"
)

const (
	// Предел на файл. Больше — почти наверняка ошибка врача (снял видео вместо фото)
	// либо DICOM целиком, который в очередь синхронизации класть нельзя.
	maxAttachmentSize = 10 << 20 // 10 МБ

	attachmentsDir = "attachments"
)

// Разрешённые типы: фото со сканера/камеры и PDF-бланки анализов.
// Значение — расширение файла на диске.
var allowedAttachmentTypes = map[string]string{
	"image/jpeg":      ".jpg",
	"image/png":       ".png",
	"image/webp":      ".webp",
	"image/heic":      ".heic",
	"application/pdf": ".pdf",
}

var attachmentKinds = map[string]bool{
	"ultrasound": true, "xray": true, "lab": true, "photo": true, "other": true,
}

func (a *app) handleAttachments(w http.ResponseWriter, r *http.Request) {
	switch r.Method {
	case http.MethodGet:
		a.listAttachments(w, r)
	case http.MethodPost:
		a.uploadAttachment(w, r)
	default:
		writeError(w, http.StatusMethodNotAllowed, "method not allowed")
	}
}

func (a *app) handleAttachmentByID(w http.ResponseWriter, r *http.Request) {
	id := strings.TrimSpace(r.PathValue("id"))
	if id == "" {
		writeError(w, http.StatusBadRequest, "id is required")
		return
	}
	switch r.Method {
	case http.MethodGet:
		a.getAttachmentDetail(w, r, id)
	case http.MethodDelete:
		a.deleteAttachment(w, r, id)
	default:
		writeError(w, http.StatusMethodNotAllowed, "method not allowed")
	}
}

// handleAttachmentFile — отдача самого файла: GET /attachments/{id}/file
func (a *app) handleAttachmentFile(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodGet {
		writeError(w, http.StatusMethodNotAllowed, "method not allowed")
		return
	}
	id := strings.TrimSpace(r.PathValue("id"))
	ctx, cancel := context.WithTimeout(r.Context(), 5*time.Second)
	defer cancel()

	var storagePath, mime, fileName string
	err := a.db.QueryRowContext(ctx,
		`SELECT storage_path, mime_type, file_name FROM attachments WHERE id=? AND is_deleted=0`, id,
	).Scan(&storagePath, &mime, &fileName)
	if err != nil {
		writeError(w, http.StatusNotFound, "attachment not found")
		return
	}

	full := filepath.Join(a.attachmentsRoot(), filepath.FromSlash(storagePath))
	// Защита от выхода за пределы папки вложений: storage_path приходит из базы,
	// но проверить дешевле, чем однажды отдать чужой файл с диска.
	if !strings.HasPrefix(full, a.attachmentsRoot()) {
		writeError(w, http.StatusBadRequest, "invalid path")
		return
	}
	f, err := os.Open(full)
	if err != nil {
		a.logger.Printf("attachment file missing: %s: %v", storagePath, err)
		writeError(w, http.StatusNotFound, "file not found on disk")
		return
	}
	defer f.Close()

	st, _ := f.Stat()
	w.Header().Set("Content-Type", mime)
	// inline — чтобы скан открывался прямо в приложении, а не скачивался.
	w.Header().Set("Content-Disposition", "inline; filename*=UTF-8''"+urlEscape(fileName))
	w.Header().Set("Cache-Control", "private, max-age=86400")
	http.ServeContent(w, r, fileName, st.ModTime(), f)
}

func (a *app) listAttachments(w http.ResponseWriter, r *http.Request) {
	ctx, cancel := context.WithTimeout(r.Context(), 5*time.Second)
	defer cancel()

	q := attachmentSelectAll + ` WHERE is_deleted=0`
	args := make([]interface{}, 0, 2)
	if v := strings.TrimSpace(r.URL.Query().Get("visit_id")); v != "" {
		q += ` AND visit_id=?`
		args = append(args, v)
	}
	if p := strings.TrimSpace(r.URL.Query().Get("pet_id")); p != "" {
		q += ` AND pet_id=?`
		args = append(args, p)
	}
	q += ` ORDER BY created_at ASC`

	rows, err := a.db.QueryContext(ctx, q, args...)
	if err != nil {
		a.logger.Printf("listAttachments: %v", err)
		writeError(w, http.StatusInternalServerError, "failed to load attachments")
		return
	}
	defer rows.Close()

	list := make([]Attachment, 0)
	for rows.Next() {
		at, err := scanAttachment(rows)
		if err != nil {
			a.logger.Printf("listAttachments scan: %v", err)
			continue
		}
		list = append(list, at)
	}
	writeJSON(w, http.StatusOK, apiResponse{Status: "ok", Data: list})
}

func (a *app) getAttachmentDetail(w http.ResponseWriter, r *http.Request, id string) {
	ctx, cancel := context.WithTimeout(r.Context(), 5*time.Second)
	defer cancel()
	row := a.db.QueryRowContext(ctx, attachmentSelectAll+` WHERE id=?`, id)
	at, err := scanAttachment(row)
	if err != nil {
		writeError(w, http.StatusNotFound, "attachment not found")
		return
	}
	writeJSON(w, http.StatusOK, apiResponse{Status: "ok", Data: at})
}

// uploadAttachment — приём файла: POST /attachments (multipart/form-data).
//
// Поля формы: file, visit_id, kind, notes, id (необязательно — id, сгенерированный
// планшетом офлайн: без него повторная отправка из очереди создала бы дубль).
func (a *app) uploadAttachment(w http.ResponseWriter, r *http.Request) {
	// +1 МБ на служебные поля формы поверх лимита файла.
	r.Body = http.MaxBytesReader(w, r.Body, maxAttachmentSize+(1<<20))
	if err := r.ParseMultipartForm(8 << 20); err != nil {
		writeError(w, http.StatusRequestEntityTooLarge,
			fmt.Sprintf("Файл больше %d МБ или форма повреждена", maxAttachmentSize>>20))
		return
	}
	defer r.MultipartForm.RemoveAll()

	visitID := strings.TrimSpace(r.FormValue("visit_id"))
	if visitID == "" {
		writeError(w, http.StatusBadRequest, "visit_id is required")
		return
	}
	kind := strings.TrimSpace(r.FormValue("kind"))
	if kind == "" {
		kind = "other"
	}
	if !attachmentKinds[kind] {
		writeError(w, http.StatusBadRequest, "kind: недопустимый тип вложения")
		return
	}

	file, header, err := r.FormFile("file")
	if err != nil {
		writeError(w, http.StatusBadRequest, "file is required")
		return
	}
	defer file.Close()

	if header.Size > maxAttachmentSize {
		writeError(w, http.StatusRequestEntityTooLarge,
			fmt.Sprintf("Файл %.1f МБ — больше предела в %d МБ",
				float64(header.Size)/(1<<20), maxAttachmentSize>>20))
		return
	}

	ctx, cancel := context.WithTimeout(r.Context(), 30*time.Second)
	defer cancel()

	// Приём должен существовать: вложение без приёма осиротеет.
	var petID string
	if err := a.db.QueryRowContext(ctx,
		`SELECT pet_id FROM visits WHERE id=? AND is_deleted=0`, visitID).Scan(&petID); err != nil {
		writeError(w, http.StatusBadRequest, "visit not found")
		return
	}

	// Тип определяем по содержимому, а не по расширению: расширение врёт,
	// а хранить .exe под видом снимка мы не хотим.
	head := make([]byte, 512)
	n, _ := io.ReadFull(file, head)
	head = head[:n]
	mime := http.DetectContentType(head)
	if i := strings.Index(mime, ";"); i > 0 {
		mime = strings.TrimSpace(mime[:i])
	}
	ext, ok := allowedAttachmentTypes[mime]
	if !ok {
		writeError(w, http.StatusUnsupportedMediaType,
			"Можно загружать только фото (JPG, PNG, WebP, HEIC) и PDF. Определён тип: "+mime)
		return
	}
	if _, err := file.Seek(0, io.SeekStart); err != nil {
		writeError(w, http.StatusInternalServerError, "failed to read file")
		return
	}

	id := strings.TrimSpace(r.FormValue("id"))
	if id == "" {
		if id, err = newUUID(); err != nil {
			writeError(w, http.StatusInternalServerError, "failed to generate id")
			return
		}
	}

	// Раскладываем по годам и месяцам: в одной папке на тысячи файлов
	// неудобно и самому серверу, и человеку, который полезет их искать.
	now := nowUTC()
	relDir := filepath.Join(now.Format("2006"), now.Format("01"))
	if err := os.MkdirAll(filepath.Join(a.attachmentsRoot(), relDir), 0o755); err != nil {
		a.logger.Printf("uploadAttachment mkdir: %v", err)
		writeError(w, http.StatusInternalServerError, "failed to store file")
		return
	}
	relPath := filepath.ToSlash(filepath.Join(relDir, id+ext))
	full := filepath.Join(a.attachmentsRoot(), filepath.FromSlash(relPath))

	dst, err := os.Create(full)
	if err != nil {
		a.logger.Printf("uploadAttachment create: %v", err)
		writeError(w, http.StatusInternalServerError, "failed to store file")
		return
	}
	written, copyErr := io.Copy(dst, io.LimitReader(file, maxAttachmentSize+1))
	dst.Close()
	if copyErr != nil || written > maxAttachmentSize {
		os.Remove(full) // не оставляем обрезок на диске
		writeError(w, http.StatusRequestEntityTooLarge,
			fmt.Sprintf("Файл больше %d МБ", maxAttachmentSize>>20))
		return
	}

	fileName := filepath.Base(header.Filename)
	if fileName == "" || fileName == "." {
		fileName = "scan" + ext
	}

	_, err = a.db.ExecContext(ctx,
		`INSERT INTO attachments (id, visit_id, pet_id, kind, file_name, mime_type, size_bytes,
		                          storage_path, notes, created_at, updated_at, is_deleted, device_id, version, client_updated_at)
		 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, ?, 1, ?)
		 ON CONFLICT(id) DO UPDATE SET
		   kind=excluded.kind, notes=excluded.notes, updated_at=excluded.updated_at,
		   is_deleted=0, version=attachments.version+1`,
		id, visitID, petID, kind, fileName, mime, written, relPath,
		nullableString(strings.TrimSpace(r.FormValue("notes"))),
		T(now), T(now), nullableString(strings.TrimSpace(r.FormValue("device_id"))), T(now),
	)
	if err != nil {
		os.Remove(full)
		a.logger.Printf("uploadAttachment insert: %v", err)
		writeError(w, http.StatusInternalServerError, "failed to save attachment")
		return
	}

	row := a.db.QueryRowContext(ctx, attachmentSelectAll+` WHERE id=?`, id)
	at, _ := scanAttachment(row)
	writeJSON(w, http.StatusCreated, apiResponse{Status: "ok", Data: at})
}

// deleteAttachment — мягкое удаление. Файл на диске остаётся намеренно:
// удаление могло приехать по ошибке синхронизации, а восстановить файл
// из ниоткуда нельзя. Чистка диска — отдельная задача.
func (a *app) deleteAttachment(w http.ResponseWriter, r *http.Request, id string) {
	ctx, cancel := context.WithTimeout(r.Context(), 5*time.Second)
	defer cancel()

	now := nowUTC()
	res, err := a.db.ExecContext(ctx,
		`UPDATE attachments SET is_deleted=1, deleted_at=?, updated_at=?, version=version+1
		 WHERE id=? AND is_deleted=0`,
		T(now), T(now), id,
	)
	if err != nil {
		a.logger.Printf("deleteAttachment: %v", err)
		writeError(w, http.StatusInternalServerError, "failed to delete attachment")
		return
	}
	if n, _ := res.RowsAffected(); n == 0 {
		writeError(w, http.StatusNotFound, "attachment not found")
		return
	}
	writeJSON(w, http.StatusOK, apiResponse{Status: "ok", Data: map[string]string{"id": id}})
}

// ─── Чистка диска ────────────────────────────────────────────────────────────

// attachmentRetention — сколько файл живёт на диске после мягкого удаления.
// Не удаляем сразу намеренно: удаление могло приехать по ошибке синхронизации
// или врач нажал не туда, а восстановить снимок из ниоткуда нельзя.
// Три дня — запас, чтобы заметить и вернуть.
const attachmentRetention = 3 * 24 * time.Hour

// purgeAttachments удаляет с диска файлы вложений, удалённых больше трёх дней назад.
//
// Строку в базе оставляем: она нужна синхронизации, чтобы планшеты узнали об
// удалении. Обнуляем только storage_path — это и признак «файла больше нет»,
// и защита от повторных попыток удалить то же самое.
func (a *app) purgeAttachments(ctx context.Context) (int, error) {
	cutoff := nowUTC().Add(-attachmentRetention)

	rows, err := a.db.QueryContext(ctx,
		`SELECT id, storage_path FROM attachments
		  WHERE is_deleted = 1 AND storage_path <> '' AND deleted_at IS NOT NULL AND deleted_at <= ?`,
		T(cutoff))
	if err != nil {
		return 0, err
	}
	type victim struct{ id, path string }
	var list []victim
	for rows.Next() {
		var v victim
		if err := rows.Scan(&v.id, &v.path); err != nil {
			continue
		}
		list = append(list, v)
	}
	rows.Close()
	if err := rows.Err(); err != nil {
		return 0, err
	}

	purged := 0
	for _, v := range list {
		full := filepath.Join(a.attachmentsRoot(), filepath.FromSlash(v.path))
		// Тот же барьер, что и при отдаче файла: storage_path приходит из базы,
		// но удалять что-то за пределами папки вложений мы не имеем права.
		if !strings.HasPrefix(full, a.attachmentsRoot()) {
			a.logger.Printf("purgeAttachments: подозрительный путь, пропущен: %s", v.path)
			continue
		}
		if err := os.Remove(full); err != nil && !os.IsNotExist(err) {
			// Файл занят или нет прав — попробуем в следующий раз,
			// storage_path не трогаем.
			a.logger.Printf("purgeAttachments: не удалён %s: %v", v.path, err)
			continue
		}
		if _, err := a.db.ExecContext(ctx,
			`UPDATE attachments SET storage_path = '' WHERE id = ?`, v.id); err != nil {
			a.logger.Printf("purgeAttachments: не обновлён %s: %v", v.id, err)
			continue
		}
		purged++
	}

	if purged > 0 {
		a.removeEmptyAttachmentDirs()
	}
	return purged, nil
}

// removeEmptyAttachmentDirs убирает опустевшие папки ГГГГ/ММ,
// чтобы за годы не накопился лес пустых каталогов.
func (a *app) removeEmptyAttachmentDirs() {
	root := a.attachmentsRoot()
	years, err := os.ReadDir(root)
	if err != nil {
		return
	}
	for _, y := range years {
		if !y.IsDir() {
			continue
		}
		yearPath := filepath.Join(root, y.Name())
		months, err := os.ReadDir(yearPath)
		if err != nil {
			continue
		}
		for _, m := range months {
			if !m.IsDir() {
				continue
			}
			monthPath := filepath.Join(yearPath, m.Name())
			if entries, err := os.ReadDir(monthPath); err == nil && len(entries) == 0 {
				os.Remove(monthPath)
			}
		}
		if entries, err := os.ReadDir(yearPath); err == nil && len(entries) == 0 {
			os.Remove(yearPath)
		}
	}
}

// startAttachmentPurge запускает фоновую чистку: сразу при старте и раз в 6 часов.
// Сервер в клинике включают утром и гасят вечером, поэтому «раз в сутки в 3 ночи»
// не сработало бы вовсе — привязываться к часам нельзя.
func (a *app) startAttachmentPurge() {
	go func() {
		run := func() {
			ctx, cancel := context.WithTimeout(context.Background(), 2*time.Minute)
			defer cancel()
			n, err := a.purgeAttachments(ctx)
			if err != nil {
				a.logger.Printf("Чистка вложений: ошибка: %v", err)
				return
			}
			if n > 0 {
				a.logger.Printf("Чистка вложений: удалено файлов с диска: %d", n)
			}
		}
		run()
		ticker := time.NewTicker(6 * time.Hour)
		defer ticker.Stop()
		for range ticker.C {
			run()
		}
	}()
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

func (a *app) attachmentsRoot() string {
	return filepath.Join(filepath.Dir(a.config.DBPath), attachmentsDir)
}

const attachmentSelectAll = `
SELECT id, visit_id, pet_id, COALESCE(kind,'other'), file_name, mime_type,
       COALESCE(size_bytes,0), COALESCE(notes,''), created_at, updated_at, deleted_at,
       is_deleted, COALESCE(device_id,''), COALESCE(version,1)
FROM attachments`

func scanAttachment(s interface{ Scan(...interface{}) error }) (Attachment, error) {
	var at Attachment
	var createdAt, updatedAt, deletedAt timeScanner
	err := s.Scan(
		&at.ID, &at.VisitID, &at.PetID, &at.Kind, &at.FileName, &at.MimeType,
		&at.SizeBytes, &at.Notes, &createdAt, &updatedAt, &deletedAt,
		&at.IsDeleted, &at.DeviceID, &at.Version,
	)
	if err != nil {
		return Attachment{}, err
	}
	if createdAt.t != nil {
		at.CreatedAt = *createdAt.t
	}
	if updatedAt.t != nil {
		at.UpdatedAt = *updatedAt.t
	}
	at.DeletedAt = deletedAt.ptr()
	return at, nil
}

// urlEscape — минимальное экранирование имени файла для Content-Disposition.
func urlEscape(s string) string {
	var b strings.Builder
	for _, c := range []byte(s) {
		if (c >= 'a' && c <= 'z') || (c >= 'A' && c <= 'Z') || (c >= '0' && c <= '9') ||
			c == '-' || c == '_' || c == '.' {
			b.WriteByte(c)
		} else {
			fmt.Fprintf(&b, "%%%02X", c)
		}
	}
	return b.String()
}
