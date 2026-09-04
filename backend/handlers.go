package main

import (
	"bytes"
	"database/sql"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"log"
	"net/http"
	"net/url"
	"os"
	"path/filepath"
	"regexp"
	"strings"
	"time"
)

// ─── App ──────────────────────────────────────────────────────────────────────

type app struct {
	db       *sql.DB
	logger   *log.Logger
	frontend string
	config   Config
}

type apiResponse struct {
	Status  string      `json:"status"`
	Data    interface{} `json:"data,omitempty"`
	Message string      `json:"message,omitempty"`
}

// ─── Router ───────────────────────────────────────────────────────────────────

func (a *app) routes() http.Handler {
	mux := http.NewServeMux()

	// Health
	mux.HandleFunc("GET /health", a.handleHealth)

	// Items (каталог)
	mux.HandleFunc("GET /items",        a.handleItems)
	mux.HandleFunc("POST /items",       a.handleItems)
	mux.HandleFunc("GET /items/{id}",   a.handleItemByID)
	mux.HandleFunc("PUT /items/{id}",   a.handleItemByID)
	mux.HandleFunc("DELETE /items/{id}", a.handleItemByID)

	// Owners (владельцы)
	mux.HandleFunc("GET /owners",         a.handleOwners)
	mux.HandleFunc("POST /owners",        a.handleOwners)
	mux.HandleFunc("GET /owners/{id}",    a.handleOwnerByID)
	mux.HandleFunc("PUT /owners/{id}",    a.handleOwnerByID)
	mux.HandleFunc("DELETE /owners/{id}", a.handleOwnerByID)

	// Pets (животные)
	mux.HandleFunc("GET /pets",                      a.handlePets)
	mux.HandleFunc("POST /pets",                     a.handlePets)
	mux.HandleFunc("GET /pets/{id}",                 a.handlePetByID)
	mux.HandleFunc("PUT /pets/{id}",                 a.handlePetByID)
	mux.HandleFunc("DELETE /pets/{id}",              a.handlePetByID)
	mux.HandleFunc("PUT /pets/{id}/deceased",        a.handleMarkPetDeceased)

	// Visits (приёмы)
	mux.HandleFunc("GET /visits",              a.handleVisits)
	mux.HandleFunc("POST /visits",             a.handleVisits)
	mux.HandleFunc("GET /visits/{id}",         a.handleVisitByID)
	mux.HandleFunc("PUT /visits/{id}",         a.handleVisitByID)
	mux.HandleFunc("DELETE /visits/{id}",      a.handleVisitByID)
	mux.HandleFunc("POST /visits/full",        a.handleCreateFullVisit)

	// Visit items
	mux.HandleFunc("GET /visit-items",              a.handleVisitItems)
	mux.HandleFunc("POST /visit-items",             a.handleVisitItems)
	mux.HandleFunc("DELETE /visit-items/{id}",      a.handleVisitItemByID)

	// Vaccinations (вакцинации)
	// F4/VET-004: назначения
	mux.HandleFunc("GET /prescriptions",        a.handlePrescriptions)
	mux.HandleFunc("POST /prescriptions",       a.handlePrescriptions)
	mux.HandleFunc("PUT /prescriptions/{id}",   a.handlePrescriptionByID)
	mux.HandleFunc("DELETE /prescriptions/{id}", a.handlePrescriptionByID)

	mux.HandleFunc("GET /vaccinations",         a.handleVaccinations)
	mux.HandleFunc("POST /vaccinations",        a.handleVaccinations)
	mux.HandleFunc("GET /vaccinations/{id}",    a.handleVaccinationByID)
	mux.HandleFunc("PUT /vaccinations/{id}",    a.handleVaccinationByID)
	mux.HandleFunc("DELETE /vaccinations/{id}", a.handleVaccinationByID)

	// Appointments (расписание — запись на приём)
	mux.HandleFunc("GET /appointments",         a.handleAppointments)
	mux.HandleFunc("POST /appointments",        a.handleAppointments)
	mux.HandleFunc("PUT /appointments/{id}",    a.handleAppointmentByID)
	mux.HandleFunc("DELETE /appointments/{id}", a.handleAppointmentByID)

	// Staff (персонал)
	mux.HandleFunc("GET /staff",         a.handleStaff)
	mux.HandleFunc("POST /staff",        a.handleStaff)
	mux.HandleFunc("GET /staff/{id}",    a.handleStaffByID)
	mux.HandleFunc("PUT /staff/{id}",    a.handleStaffByID)
	mux.HandleFunc("DELETE /staff/{id}", a.handleStaffByID)

	// Авторизация
	mux.HandleFunc("POST /auth/login",  a.handleLogin)
	mux.HandleFunc("POST /auth/logout", a.handleLogout)
	mux.HandleFunc("GET /auth/me",      a.handleMe)
	mux.HandleFunc("POST /auth/change-password", a.handleChangePassword)
	mux.HandleFunc("GET /authorship",   a.handleAuthorship)

	// Админка пользователей — только администратор
	mux.HandleFunc("GET /notifications", a.requireAdmin(a.handleNotifications))

	// Резервные копии базы — только администратор.
	mux.HandleFunc("GET /backups",      a.requireAdmin(a.handleBackups))
	mux.HandleFunc("POST /backups/run", a.requireAdmin(a.handleBackupRun))

	// Отзывы после приёма (NPS) — сводка для владельца клиники.
	mux.HandleFunc("GET /feedback", a.requireAdmin(a.handleFeedback))

	// Задачи сотрудникам (см. handlers_tasks.go). Права общие: задача —
	// рабочая заметка, а не медицинские данные.
	mux.HandleFunc("GET /tasks",         a.handleTasks)
	mux.HandleFunc("POST /tasks",        a.handleTasks)
	mux.HandleFunc("PUT /tasks/{id}",    a.handleTaskByID)
	mux.HandleFunc("DELETE /tasks/{id}", a.handleTaskByID)

	// Справочник диагнозов с заготовками лечения (см. handlers_diagnoses.go).
	// Шаблоны протоколов: читать всем (врач заполняет по ним), править — админу.
	mux.HandleFunc("GET /protocols",         a.handleProtocols)
	// Правка справочников — по праву «templates», а не по роли: раньше бланки
	// анализов мог менять только администратор, и делегировать это старшему
	// врачу было нельзя иначе как выдав ему администратора целиком.
	mux.HandleFunc("POST /protocols",        a.requireTableEdit("templates", a.handleProtocols))
	mux.HandleFunc("PUT /protocols/{id}",    a.requireTableEdit("templates", a.handleProtocolByID))
	mux.HandleFunc("DELETE /protocols/{id}", a.requireTableEdit("templates", a.handleProtocolByID))

	// Результаты услуг — под правами приёмов (см. pathTable).
	mux.HandleFunc("GET /results",         a.handleResults)
	mux.HandleFunc("POST /results",        a.handleResults)
	mux.HandleFunc("PUT /results/{id}",    a.handleResultByID)
	mux.HandleFunc("DELETE /results/{id}", a.handleResultByID)

	mux.HandleFunc("GET /diagnoses",         a.handleDiagnoses)
	// Справочник диагнозов не был закрыт ВООБЩЕ: править заготовки лечения,
	// которые подставляются всем врачам, мог любой пользователь.
	mux.HandleFunc("POST /diagnoses",        a.requireTableEdit("templates", a.handleDiagnoses))
	mux.HandleFunc("PUT /diagnoses/{id}",    a.requireTableEdit("templates", a.handleDiagnosisByID))
	mux.HandleFunc("DELETE /diagnoses/{id}", a.requireTableEdit("templates", a.handleDiagnosisByID))

	// Корзина: права проверяются внутри по каждой таблице (см. trash.go),
	// поэтому админом не гейтим — врач должен уметь вернуть свой приём.
	mux.HandleFunc("GET /trash",          a.handleTrash)
	mux.HandleFunc("POST /trash/restore", a.handleTrashRestore)
	// Опциональные модули: чтение — любой вошедший (для меню), запись — админ.
	// Это управление модулями (ядро), а не маршруты самих модулей.
	mux.HandleFunc("GET /settings/modules",        a.handleGetModules)
	mux.HandleFunc("PUT /settings/module/{key}",   a.requireAdmin(a.handlePutModule))
	// Конфиг отчёта за день: читают все вошедшие, пишет админ.
	mux.HandleFunc("GET /settings/report-daily",   a.handleGetReportConfig)
	mux.HandleFunc("PUT /settings/report-daily",   a.requireAdmin(a.handlePutReportConfig))
	mux.HandleFunc("PUT /settings/warehouse",      a.requireAdmin(a.handlePutWarehouseModule)) // старый маршрут, совместимость
	mux.HandleFunc("GET /users",         a.requireAdmin(a.handleUsers))
	mux.HandleFunc("POST /users",        a.requireAdmin(a.handleUsers))
	mux.HandleFunc("PUT /users/{id}",    a.requireAdmin(a.handleUserByID))
	mux.HandleFunc("DELETE /users/{id}", a.requireAdmin(a.handleUserByID))

	// Маршруты опциональных модулей (телеграм-настройки, портал). Каждый
	// модуль регистрирует своё и сам гейтит по флагу (см. modules.go).
	for _, m := range moduleRegistry {
		m.RegisterRoutes(mux, a)
	}

	// Вложения (сканы УЗИ, рентген, анализы).
	// Метод указываем явно, как и во всех маршрутах выше: без него шаблон
	// конфликтует с catch-all "GET /" и роутер падает при старте.
	mux.HandleFunc("GET /attachments",           a.handleAttachments)
	mux.HandleFunc("POST /attachments",          a.handleAttachments)
	mux.HandleFunc("GET /attachments/{id}",      a.handleAttachmentByID)
	mux.HandleFunc("DELETE /attachments/{id}",   a.handleAttachmentByID)
	mux.HandleFunc("GET /attachments/{id}/file", a.handleAttachmentFile)

	// Sync
	mux.HandleFunc("POST /sync/push", a.handleSyncPush)
	mux.HandleFunc("GET /sync/pull",  a.handleSyncPull)

	// Static frontend
	//
	// no-cache — не «не кэшировать», а «перед выдачей спросить сервер». Ответом
	// обычно будет 304 без тела, так что цена — один лёгкий запрос на файл.
	// Заголовков не было вовсе, и браузер кэшировал по своему усмотрению: после
	// обновления клиника продолжала работать на старом коде, а на стенде правка
	// «не появлялась» до ручной чистки кэша. Офлайн обеспечивает service worker
	// со своей версией — сетевому слою кэшировать нечего.
	fileServer := http.FileServer(http.Dir(a.frontend))
	revalidate := func(h http.Handler) http.Handler {
		return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			w.Header().Set("Cache-Control", "no-cache")
			h.ServeHTTP(w, r)
		})
	}
	mux.Handle("GET /js/",     revalidate(http.StripPrefix("/", fileServer)))
	mux.Handle("GET /css/",    revalidate(http.StripPrefix("/", fileServer)))
	mux.Handle("GET /icons/",  revalidate(http.StripPrefix("/", fileServer)))
	// vendor — сторонние библиотеки локальной копией (xlsx/SheetJS).
	// Без этого маршрута запрос падал в catch-all "GET /" и получал index.html
	// вместо скрипта: браузер молча не находил XLSX, а импорт Excel переставал работать.
	mux.Handle("GET /vendor/", http.StripPrefix("/", fileServer))
	mux.HandleFunc("GET /manifest.json", func(w http.ResponseWriter, r *http.Request) {
		http.ServeFile(w, r, filepath.Join(a.frontend, "manifest.json"))
	})
	mux.HandleFunc("GET /service-worker.js", func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Cache-Control", "no-cache, no-store, must-revalidate")
		http.ServeFile(w, r, filepath.Join(a.frontend, "service-worker.js"))
	})
	// index.html отдаём с подставленной версией: в разметке стоит ?v=__V__, и
	// после обновления браузер запрашивает скрипты по новому адресу. Без этого
	// он мог месяцами держать старую копию — версионирования не было ни у
	// одного файла, и клиника рисковала работать на смеси старого и нового
	// кода. Версию берём из service-worker.js, чтобы она была ровно в одном
	// месте: два источника однажды разойдутся.
	mux.HandleFunc("GET /", func(w http.ResponseWriter, r *http.Request) {
		raw, err := os.ReadFile(filepath.Join(a.frontend, "index.html"))
		if err != nil {
			http.ServeFile(w, r, filepath.Join(a.frontend, "index.html"))
			return
		}
		w.Header().Set("Cache-Control", "no-cache")
		w.Header().Set("Content-Type", "text/html; charset=utf-8")
		_, _ = w.Write([]byte(strings.ReplaceAll(string(raw), "__V__", a.appVersion())))
	})

	// authMiddleware внутри CORS: preflight-OPTIONS должен отвечать без токена.
	return a.loggingMiddleware(a.securityHeadersMiddleware(a.corsMiddleware(a.authMiddleware(mux))))
}

// ─── Middleware ───────────────────────────────────────────────────────────────

func (a *app) corsMiddleware(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		// Раньше стояло "*": любой сайт, открытый у сотрудника, мог обращаться
		// к серверу клиники из его браузера. Приложение и API живут на одном
		// origin (apiBase пустой), поэтому кросс-доменный доступ не нужен
		// вообще — отвечаем заголовком только своему же источнику.
		if origin := r.Header.Get("Origin"); origin != "" && sameOrigin(origin, r) {
			w.Header().Set("Access-Control-Allow-Origin", origin)
			w.Header().Set("Vary", "Origin")
			w.Header().Set("Access-Control-Allow-Headers", "Content-Type, X-Device-ID, X-Bypass-Local, X-Auth-Token, X-Portal-Token")
			w.Header().Set("Access-Control-Allow-Methods", "GET, POST, PUT, DELETE, OPTIONS")
		}
		if r.Method == http.MethodOptions {
			w.WriteHeader(http.StatusOK)
			return
		}
		next.ServeHTTP(w, r)
	})
}

// sameOrigin — совпадает ли источник запроса с хостом, к которому обратились.
// Схему не сверяем: сервер слушает и http, и https на одном порту (sniff),
// и планшет ходит по обеим.
func sameOrigin(origin string, r *http.Request) bool {
	u, err := url.Parse(origin)
	if err != nil {
		return false
	}
	return u.Host == r.Host
}

// securityHeaders — заголовки, которые браузер обязан получить на каждый ответ.
//
// script-src БЕЗ 'unsafe-inline': инлайновых обработчиков и инлайновых
// <script> в интерфейсе не осталось — действия объявляются через data-act и
// разбираются делегатом (frontend/js/actions.js). Это и есть та защита, ради
// которой затевалась находка 1 аудита: даже если текст с кодом попадёт в
// разметку, браузер откажется его исполнять.
//
// style-src 'unsafe-inline' остаётся: инлайновые style-атрибуты в разметке
// ещё есть, а внедрение стилей не даёт выполнения кода.
//
// connect-src 'self' не даёт отправить украденное на чужой сервер,
// frame-ancestors закрывает кликджекинг, img-src разрешает data: — фото
// животных хранятся data-URL внутри записи.
const contentSecurityPolicy = "default-src 'self'; " +
	"script-src 'self'; " +
	// style-src-elem без 'unsafe-inline': инлайновых <style> не осталось,
	// печатные документы и портал грузят свои файлы из /css. Внедрённый
	// <style> опаснее атрибута — селекторами он умеет вытягивать содержимое
	// страницы. Атрибуты style= в разметке ещё есть, поэтому style-src-attr
	// пока мягкий; общий style-src оставлен запасным для старых браузеров.
	"style-src 'self' 'unsafe-inline'; " +
	"style-src-elem 'self'; " +
	"style-src-attr 'unsafe-inline'; " +
	"img-src 'self' data: blob:; " +
	"font-src 'self' data:; " +
	"connect-src 'self'; " +
	"worker-src 'self'; " +
	"object-src 'none'; " +
	"base-uri 'self'; " +
	"form-action 'self'; " +
	"frame-ancestors 'none'"

func (a *app) securityHeadersMiddleware(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		h := w.Header()
		h.Set("Content-Security-Policy", contentSecurityPolicy)
		h.Set("X-Content-Type-Options", "nosniff")
		h.Set("X-Frame-Options", "DENY")
		// same-origin: ссылка наружу не должна унести токен из строки запроса
		// (см. redactToken — тот же токен раньше утекал и в лог).
		h.Set("Referrer-Policy", "same-origin")
		next.ServeHTTP(w, r)
	})
}

func (a *app) loggingMiddleware(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		start := time.Now()
		next.ServeHTTP(w, r)
		a.logger.Printf("%s %s %s", r.Method, redactTokens(r.URL), time.Since(start).Round(time.Millisecond))
	})
}

// redactTokens убирает токены из строки запроса перед записью в лог.
//
// authMiddleware принимает токен не только в заголовке, но и в ?t= — это
// запасной канал для ссылок, куда заголовок не вставить (открытие скана в
// новой вкладке). Портал так же принимает ?pt=. Полный URI в логе означал,
// что рабочая сессия на 90 дней ложится в лог открытым текстом.
func redactTokens(u *url.URL) string {
	q := u.Query()
	hit := false
	for _, k := range []string{"t", "pt"} {
		if q.Get(k) != "" {
			// Не "***": Encode() превратил бы звёздочки в %2A и лог стал бы шумным.
			q.Set(k, "redacted")
			hit = true
		}
	}
	if !hit {
		return u.RequestURI()
	}
	c := *u
	c.RawQuery = q.Encode()
	return c.RequestURI()
}

// ─── Health ───────────────────────────────────────────────────────────────────

func (a *app) handleHealth(w http.ResponseWriter, r *http.Request) {
	writeJSON(w, http.StatusOK, apiResponse{
		Status: "ok",
		Data: map[string]string{
			"service": "vetclinic",
			"env":     a.config.Env,
			// Версия сервера нужна поддержке и скрипту обновления: по ней
			// видно, что после замены exe поднялась именно новая сборка.
			"version": serverVersion,
			"time":    time.Now().UTC().Format(time.RFC3339),
		},
	})
}

// ─── JSON helpers ─────────────────────────────────────────────────────────────

func writeJSON(w http.ResponseWriter, status int, payload apiResponse) {
	w.Header().Set("Content-Type", "application/json; charset=utf-8")
	w.WriteHeader(status)
	if err := json.NewEncoder(w).Encode(payload); err != nil {
		// Response уже начата — только логируем
		_ = err
	}
}

func writeError(w http.ResponseWriter, status int, message string) {
	writeJSON(w, status, apiResponse{Status: "error", Message: message})
}

// maxJSONBody — потолок тела JSON-запроса.
//
// Раньше лимита не было вовсе: любой аутентифицированный клиент мог прислать
// тело произвольного размера, и оно целиком буферизовалось в памяти. Портал
// проверял размер фото, но уже ПОСЛЕ разбора — то есть после буферизации.
// 2 МБ с запасом покрывают самый тяжёлый обычный запрос: запись с фото
// животного (data-URL, ограничение ~400 КБ).
const maxJSONBody = 2 << 20

func decodeJSON(r *http.Request, dest interface{}) error {
	defer r.Body.Close()
	// Читаем на байт больше потолка и по длине отличаем «слишком большое» от
	// «битый JSON». Без этого обрезанное тело давало «invalid json:
	// unexpected EOF» — сообщение, по которому непонятно, что фото просто
	// тяжёлое. Буферизация безопасна: выше потолка мы всё равно не читаем.
	raw, err := io.ReadAll(io.LimitReader(r.Body, maxJSONBody+1))
	if err != nil {
		return errors.New("failed to read body")
	}
	if len(raw) > maxJSONBody {
		return fmt.Errorf("тело запроса больше %d МБ — уменьшите вложение", maxJSONBody>>20)
	}
	dec := json.NewDecoder(bytes.NewReader(raw))
	dec.DisallowUnknownFields()
	if err := dec.Decode(dest); err != nil {
		return fmt.Errorf("invalid json: %w", err)
	}
	if err := dec.Decode(&struct{}{}); err != io.EOF {
		return errors.New("request body must contain a single JSON object")
	}
	return nil
}

// appVersion читает APP_VERSION из service-worker.js — единственного места, где
// версия объявлена. Читаем при каждом запросе index.html: файл маленький, а
// перезапуск ради смены версии на стенде только мешал бы.
func (a *app) appVersion() string {
	raw, err := os.ReadFile(filepath.Join(a.frontend, "service-worker.js"))
	if err != nil {
		return "0"
	}
	m := regexp.MustCompile(`APP_VERSION\s*=\s*"([^"]+)"`).FindSubmatch(raw)
	if len(m) < 2 {
		return "0"
	}
	return string(m[1])
}
