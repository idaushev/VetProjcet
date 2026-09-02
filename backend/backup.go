package main

import (
	"context"
	"database/sql"
	"fmt"
	"net/http"
	"os"
	"path/filepath"
	"sort"
	"strings"
	"time"
)

// Резервные копии базы.
//
// Медкарты — единственное, что в системе невосполнимо: прайс перезальём,
// планшет переустановим, сервер пересоберём, а историю лечения за годы — нет.
// До этого копия делалась ровно в одном месте — внутри clear_data.bat, то есть
// только когда данные СТИРАЮТ.
//
// Копируем через VACUUM INTO, а не копированием файла: при включённом WAL
// простой copy может поймать частичную запись и дать битую копию, которая
// выглядит целой до первой попытки восстановления.
//
// И главное: каждая копия сразу проверяется на открываемость и целостность.
// Бэкап, который никто не проверял на восстановление, — это иллюзия бэкапа.

const (
	backupDirName  = "backups"
	backupKeep     = 14 // сколько копий держим (по одной в сутки ≈ две недели)
	backupInterval = 24 * time.Hour
)

type backupInfo struct {
	Name      string    `json:"name"`
	SizeBytes int64     `json:"size_bytes"`
	CreatedAt time.Time `json:"created_at"`
}

// backupDir — каталог копий рядом с базой (data/backups).
func (a *app) backupDir() string {
	return filepath.Join(filepath.Dir(a.config.DBPath), backupDirName)
}

// createBackup делает копию базы и проверяет её. Возвращает имя файла.
func (a *app) createBackup(ctx context.Context) (string, error) {
	dir := a.backupDir()
	if err := os.MkdirAll(dir, 0o755); err != nil {
		return "", fmt.Errorf("создать каталог копий: %w", err)
	}

	name := "vet-" + nowUTC().Format("2006-01-02-1504") + ".db"
	path := filepath.Join(dir, name)
	// VACUUM INTO отказывается писать в существующий файл — если копия за эту
	// минуту уже есть, считаем задачу выполненной.
	if _, err := os.Stat(path); err == nil {
		return name, nil
	}

	// В SQL-строке путь экранируем удвоением кавычек: каталог может содержать
	// апостроф (например, имя пользователя Windows).
	safe := strings.ReplaceAll(path, "'", "''")
	if _, err := a.db.ExecContext(ctx, "VACUUM INTO '"+safe+"'"); err != nil {
		return "", fmt.Errorf("VACUUM INTO: %w", err)
	}

	if err := verifyBackup(ctx, path); err != nil {
		// Битую копию не оставляем: иначе она будет считаться «свежим бэкапом»
		// и создавать ложное спокойствие.
		os.Remove(path)
		return "", fmt.Errorf("копия не прошла проверку: %w", err)
	}
	return name, nil
}

// verifyBackup открывает копию отдельным соединением и убеждается, что она
// целая и читаемая. Именно эта проверка отличает бэкап от иллюзии бэкапа.
func verifyBackup(ctx context.Context, path string) error {
	db, err := sql.Open("sqlite", path)
	if err != nil {
		return fmt.Errorf("открыть копию: %w", err)
	}
	defer db.Close()

	var result string
	if err := db.QueryRowContext(ctx, `PRAGMA integrity_check`).Scan(&result); err != nil {
		return fmt.Errorf("integrity_check: %w", err)
	}
	if result != "ok" {
		return fmt.Errorf("integrity_check вернул %q", result)
	}
	// Читаем реальные таблицы: файл может быть формально целым, но пустым
	// (например, если база открылась не та).
	var n int
	if err := db.QueryRowContext(ctx,
		`SELECT COUNT(*) FROM sqlite_master WHERE type='table' AND name IN ('owners','pets','visits')`,
	).Scan(&n); err != nil {
		return fmt.Errorf("чтение схемы: %w", err)
	}
	if n < 3 {
		return fmt.Errorf("в копии нет основных таблиц (найдено %d из 3)", n)
	}
	return nil
}

// listBackups возвращает копии, новые первыми.
func (a *app) listBackups() ([]backupInfo, error) {
	entries, err := os.ReadDir(a.backupDir())
	if err != nil {
		if os.IsNotExist(err) {
			return []backupInfo{}, nil // копий ещё нет — это не ошибка
		}
		return nil, err
	}
	out := make([]backupInfo, 0, len(entries))
	for _, e := range entries {
		if e.IsDir() || !strings.HasSuffix(e.Name(), ".db") {
			continue
		}
		fi, err := e.Info()
		if err != nil {
			continue
		}
		out = append(out, backupInfo{
			Name:      e.Name(),
			SizeBytes: fi.Size(),
			CreatedAt: fi.ModTime().UTC(),
		})
	}
	sort.Slice(out, func(i, j int) bool { return out[i].CreatedAt.After(out[j].CreatedAt) })
	return out, nil
}

// rotateBackups удаляет самые старые копии сверх backupKeep.
func (a *app) rotateBackups() {
	list, err := a.listBackups()
	if err != nil {
		a.logger.Printf("Бэкап: чтение каталога копий: %v", err)
		return
	}
	for i := backupKeep; i < len(list); i++ {
		p := filepath.Join(a.backupDir(), list[i].Name)
		if err := os.Remove(p); err != nil {
			a.logger.Printf("Бэкап: не удалось удалить старую копию %s: %v", list[i].Name, err)
		}
	}
}

// startBackupScheduler запускает суточный цикл копий. Первая копия делается
// сразу при старте: сервер в клинике перезапускают редко, и ждать сутки
// после установки — значит сутки работать без единой резервной копии.
func (a *app) startBackupScheduler() {
	go func() {
		run := func() {
			ctx, cancel := context.WithTimeout(context.Background(), 10*time.Minute)
			defer cancel()
			name, err := a.createBackup(ctx)
			if err != nil {
				a.logger.Printf("Бэкап: ОШИБКА: %v", err)
				return
			}
			a.rotateBackups()
			// Заодно выметаем протухшие сессии: отдельный планировщик ради
			// одного DELETE в сутки заводить незачем.
			a.sweepExpiredSessions()
			a.logger.Printf("Бэкап: создана и проверена копия %s", name)
		}
		run()
		ticker := time.NewTicker(backupInterval)
		defer ticker.Stop()
		for range ticker.C {
			run()
		}
	}()
}

// ─── HTTP ────────────────────────────────────────────────────────────────────

// handleBackups отдаёт список копий и время последней. Нужен для индикатора
// в настройках: «последний бэкап N дней назад» — без него никто не заметит,
// что копии перестали создаваться.
func (a *app) handleBackups(w http.ResponseWriter, r *http.Request) {
	list, err := a.listBackups()
	if err != nil {
		a.logger.Printf("Бэкап: список копий: %v", err)
		writeError(w, http.StatusInternalServerError, "Не удалось прочитать список копий")
		return
	}
	data := map[string]interface{}{
		"backups": list,
		"keep":    backupKeep,
		"dir":     a.backupDir(),
	}
	if len(list) > 0 {
		data["last_at"] = list[0].CreatedAt
		data["age_hours"] = int(nowUTC().Sub(list[0].CreatedAt).Hours())
	}
	writeJSON(w, http.StatusOK, apiResponse{Status: "ok", Data: data})
}

// handleBackupRun делает копию по требованию — перед рискованной операцией
// (обновление, массовая правка) ждать суточного цикла незачем.
func (a *app) handleBackupRun(w http.ResponseWriter, r *http.Request) {
	ctx, cancel := context.WithTimeout(r.Context(), 10*time.Minute)
	defer cancel()

	name, err := a.createBackup(ctx)
	if err != nil {
		a.logger.Printf("Бэкап (вручную): %v", err)
		writeError(w, http.StatusInternalServerError, "Не удалось создать копию: "+err.Error())
		return
	}
	a.rotateBackups()
	writeJSON(w, http.StatusOK, apiResponse{Status: "ok", Data: map[string]string{"name": name}})
}
