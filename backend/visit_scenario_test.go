package main

import (
	"bytes"
	"context"
	"encoding/base64"
	"mime/multipart"
	"net/http"
	"net/http/httptest"
	"path/filepath"
	"testing"
)

// B-007. Сценарий приёма целиком, как он идёт на планшете: врач открыл приём
// черновиком (VET-003), приложил снимок до завершения (VET-002), закрыл
// приём, потом открыл снова. На каждом шаге данные уходят push и должны
// прийти на второй планшет pull без потерь и без задвоений.

// onePixelPNG — самый маленький настоящий PNG: сервер проверяет тип по
// содержимому, а не по имени файла.
var onePixelPNG, _ = base64.StdEncoding.DecodeString(
	"iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==")

// uploadAttachment — загрузка файла, как её делает очередь вложений планшета:
// с id, сгенерированным на планшете, чтобы повтор не создал второй скан.
func uploadAttachmentAs(t *testing.T, a *app, id, visitID string) int {
	t.Helper()
	var body bytes.Buffer
	mw := multipart.NewWriter(&body)
	_ = mw.WriteField("id", id)
	_ = mw.WriteField("visit_id", visitID)
	_ = mw.WriteField("kind", "ultrasound")
	fw, _ := mw.CreateFormFile("file", "uzi.png")
	_, _ = fw.Write(onePixelPNG)
	_ = mw.Close()
	req := httptest.NewRequest(http.MethodPost, "/attachments", &body)
	req.Header.Set("Content-Type", mw.FormDataContentType())
	req = req.WithContext(context.WithValue(req.Context(), ctxKeyUser{},
		&User{ID: "u-test", Login: "admin", Role: "admin", IsActive: true}))
	rec := httptest.NewRecorder()
	a.handleAttachments(rec, req)
	return rec.Code
}

func pulledVisit(t *testing.T, a *app, id string) map[string]any {
	t.Helper()
	for _, v := range doPull(t, a, "")["visits"] {
		if v["id"] == id {
			return v
		}
	}
	t.Fatalf("приём %s не пришёл в pull", id)
	return nil
}

func TestVisitScenarioDraftAttachComplete(t *testing.T) {
	a := testApp(t)
	// Файлы вложений — во временную папку теста, а не рядом с исходниками.
	a.config.DBPath = filepath.Join(t.TempDir(), "vet.db")

	const at = `"version":1,"updated_at":"2026-09-01T10:00:00Z","device_id":"tab-a"`
	doPush(t, a, `{
		"owners":[{"id":"s-o","fio":"Хозяин","phone":"+7 700 888 0000",`+at+`}],
		"pets":[{"id":"s-p","owner_id":"s-o","name":"Бобик","type":"dog","gender":"m",`+at+`}],
		"visits":[{"id":"s-v","pet_id":"s-p","date":"2026-09-01T10:00:00Z","diagnosis":"",
			"status":"draft","total_amount":0,`+at+`}]}`)
	if v := pulledVisit(t, a, "s-v"); v["status"] != "draft" {
		t.Fatalf("приём должен прийти черновиком, пришёл %v", v["status"])
	}

	// Снимок к черновику — до завершения приёма.
	if code := uploadAttachmentAs(t, a, "att-1", "s-v"); code != http.StatusOK && code != http.StatusCreated {
		t.Fatalf("загрузка вложения к черновику: HTTP %d", code)
	}
	// Повтор той же загрузки (ответ потерялся) — второго скана быть не должно.
	uploadAttachmentAs(t, a, "att-1", "s-v")

	// Врач дописал и закрыл приём.
	doPush(t, a, `{"visits":[{"id":"s-v","pet_id":"s-p","date":"2026-09-01T10:00:00Z","diagnosis":"Гастрит",
		"status":"completed","total_amount":5000,"version":2,"updated_at":"2026-09-01T11:00:00Z","device_id":"tab-a"}]}`)

	// Второй планшет: приём завершён, вложение ровно одно и привязано к нему.
	data := doPull(t, a, "")
	v := pulledVisit(t, a, "s-v")
	if v["status"] != "completed" || v["diagnosis"] != "Гастрит" {
		t.Errorf("после завершения: статус %v, диагноз %v", v["status"], v["diagnosis"])
	}
	n := 0
	for _, att := range data["attachments"] {
		if att["visit_id"] == "s-v" && att["is_deleted"] != float64(1) {
			n++
			if att["id"] != "att-1" || att["kind"] != "ultrasound" {
				t.Errorf("вложение: %v", att)
			}
		}
	}
	if n != 1 {
		t.Errorf("вложений у приёма %d, ждём 1 (повтор загрузки не должен задваивать)", n)
	}

	// Приём открыли снова — снова черновик, вложение на месте.
	doPush(t, a, `{"visits":[{"id":"s-v","pet_id":"s-p","date":"2026-09-01T10:00:00Z","diagnosis":"Гастрит",
		"status":"draft","total_amount":5000,"version":3,"updated_at":"2026-09-01T12:00:00Z","device_id":"tab-a"}]}`)
	if v := pulledVisit(t, a, "s-v"); v["status"] != "draft" {
		t.Errorf("повторно открытый приём: статус %v, ждём draft", v["status"])
	}
	// Пустой статус (планшет до VET-003) — завершённый, как решено в VET-003.
	doPush(t, a, `{"visits":[{"id":"s-v","pet_id":"s-p","date":"2026-09-01T10:00:00Z","diagnosis":"Гастрит",
		"total_amount":5000,"version":4,"updated_at":"2026-09-01T13:00:00Z","device_id":"tab-a"}]}`)
	if v := pulledVisit(t, a, "s-v"); v["status"] != "completed" {
		t.Errorf("старый планшет без статуса: %v, ждём completed", v["status"])
	}
}
