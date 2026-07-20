package main

import (
	"database/sql"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"log"
	"net/http"
	"path/filepath"
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
	mux.HandleFunc("GET /users",         a.requireAdmin(a.handleUsers))
	mux.HandleFunc("POST /users",        a.requireAdmin(a.handleUsers))
	mux.HandleFunc("PUT /users/{id}",    a.requireAdmin(a.handleUserByID))
	mux.HandleFunc("DELETE /users/{id}", a.requireAdmin(a.handleUserByID))

	// Выдача владельцу пароля от портала вручную — только администратор
	mux.HandleFunc("POST /owners/{id}/portal-code", a.requirePortalCodeAccess(a.handleIssuePortalCode))

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

	// Портал владельцев: своя авторизация (X-Portal-Token), см. portal.go
	mux.HandleFunc("POST /portal/login",           a.handlePortalLogin)
	mux.HandleFunc("GET /portal/bot-info",         a.handlePortalBotInfo)
	mux.HandleFunc("GET /portal/me",               a.handlePortalMe)
	mux.HandleFunc("GET /portal/pets",             a.handlePortalPets)
	mux.HandleFunc("GET /portal/pets/{id}/visits", a.handlePortalPetVisits)
	mux.HandleFunc("GET /portal/pets/{id}/vaccinations", a.handlePortalPetVaccinations)
	mux.HandleFunc("GET /portal/appointments",     a.handlePortalAppointments)
	mux.HandleFunc("POST /portal/book",            a.handlePortalBook)
	mux.HandleFunc("PUT /portal/pets/{id}/photo",  a.handlePortalPetPhoto)
	mux.HandleFunc("GET /portal", func(w http.ResponseWriter, r *http.Request) {
		http.ServeFile(w, r, filepath.Join(a.frontend, "portal.html"))
	})

	// Static frontend
	fileServer := http.FileServer(http.Dir(a.frontend))
	mux.Handle("GET /js/",     http.StripPrefix("/", fileServer))
	mux.Handle("GET /css/",    http.StripPrefix("/", fileServer))
	mux.Handle("GET /icons/",  http.StripPrefix("/", fileServer))
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
	mux.HandleFunc("GET /", func(w http.ResponseWriter, r *http.Request) {
		http.ServeFile(w, r, filepath.Join(a.frontend, "index.html"))
	})

	// authMiddleware внутри CORS: preflight-OPTIONS должен отвечать без токена.
	return a.loggingMiddleware(a.corsMiddleware(a.authMiddleware(mux)))
}

// ─── Middleware ───────────────────────────────────────────────────────────────

func (a *app) corsMiddleware(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Access-Control-Allow-Origin", "*")
		w.Header().Set("Access-Control-Allow-Headers", "Content-Type, X-Device-ID, X-Bypass-Local, X-Auth-Token, X-Portal-Token")
		w.Header().Set("Access-Control-Allow-Methods", "GET, POST, PUT, DELETE, OPTIONS")
		if r.Method == http.MethodOptions {
			w.WriteHeader(http.StatusOK)
			return
		}
		next.ServeHTTP(w, r)
	})
}

func (a *app) loggingMiddleware(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		start := time.Now()
		next.ServeHTTP(w, r)
		a.logger.Printf("%s %s %s", r.Method, r.URL.RequestURI(), time.Since(start).Round(time.Millisecond))
	})
}

// ─── Health ───────────────────────────────────────────────────────────────────

func (a *app) handleHealth(w http.ResponseWriter, r *http.Request) {
	writeJSON(w, http.StatusOK, apiResponse{
		Status: "ok",
		Data: map[string]string{
			"service": "vetclinic",
			"env":     a.config.Env,
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

func decodeJSON(r *http.Request, dest interface{}) error {
	defer r.Body.Close()
	dec := json.NewDecoder(r.Body)
	dec.DisallowUnknownFields()
	if err := dec.Decode(dest); err != nil {
		return fmt.Errorf("invalid json: %w", err)
	}
	if err := dec.Decode(&struct{}{}); err != io.EOF {
		return errors.New("request body must contain a single JSON object")
	}
	return nil
}
