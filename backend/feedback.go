package main

import (
	"context"
	"fmt"
	"net/http"
	"strconv"
	"strings"
	"time"
)

// Сбор отзывов после приёма (NPS).
//
// Инфраструктура уже была: очередь сообщений бота и привязка чатов. Не
// хватало только вопроса и места, куда класть ответ.
//
// Важная тонкость приёма ответа: у привязанного чата ЛЮБОЙ текст сейчас
// означает «пришли новый пароль от портала». Если этого не учесть, ответ
// «9» вернёт владельцу пароль вместо сохранения оценки. Поэтому оценку
// разбираем ДО этой ветки и только когда у владельца есть неотвеченный
// вопрос — иначе число остаётся обычным запросом пароля.

const (
	notifyFeedbackAsk = "feedback_ask"
	feedbackWaitHours = 72 // сколько ждём ответ, прежде чем считать вопрос протухшим
)

// askFeedbackSweep рассылает вопрос по вчерашним приёмам. Раз в сутки,
// вместе с остальными напоминаниями.
func (a *app) askFeedbackSweep() {
	ctx, cancel := context.WithTimeout(context.Background(), 2*time.Minute)
	defer cancel()

	// Вчерашние визиты, где владелец привязан к боту и вопрос ещё не задавали.
	rows, err := a.db.QueryContext(ctx, `
		SELECT v.id, p.owner_id, COALESCE(p.name,'')
		FROM visits v
		JOIN pets p ON p.id = v.pet_id
		JOIN owner_telegram t ON t.owner_id = p.owner_id
		WHERE v.is_deleted = 0
		  AND date(v.date) = date('now','-1 day')
		  AND NOT EXISTS (SELECT 1 FROM visit_feedback f WHERE f.visit_id = v.id)`)
	if err != nil {
		a.logger.Printf("Отзывы: выборка визитов: %v", err)
		return
	}
	type ask struct{ visitID, ownerID, petName string }
	var list []ask
	for rows.Next() {
		var x ask
		if rows.Scan(&x.visitID, &x.ownerID, &x.petName) == nil {
			list = append(list, x)
		}
	}
	rows.Close()

	for _, x := range list {
		// Строку заводим ДО отправки: она же метка «вопрос задан»,
		// иначе при повторном проходе спросим ещё раз.
		if _, err := a.db.ExecContext(ctx, `
			INSERT INTO visit_feedback (visit_id, owner_id, asked_at) VALUES (?, ?, ?)`,
			x.visitID, x.ownerID, T(nowUTC())); err != nil {
			a.logger.Printf("Отзывы: не удалось отметить вопрос: %v", err)
			continue
		}
		msg := "Здравствуйте! Вчера вы были у нас на приёме"
		if x.petName != "" {
			msg += " с питомцем " + x.petName
		}
		msg += ".\n\nОцените, пожалуйста, визит от 1 до 10 — просто отправьте число в ответ."
		if err := a.enqueueOwnerNotification(ctx, x.ownerID, notifyFeedbackAsk, msg); err != nil {
			a.logger.Printf("Отзывы: постановка в очередь: %v", err)
		}
	}
	if len(list) > 0 {
		a.logger.Printf("Отзывы: задано вопросов: %d", len(list))
	}
}

// tryRecordFeedback пытается принять текст как оценку. Возвращает true,
// если сообщение было оценкой и обработано — тогда обычная ветка бота
// (выдача пароля) не выполняется.
func (a *app) tryRecordFeedback(ctx context.Context, chatID int64, ownerID, text string) bool {
	t := strings.TrimSpace(text)
	score, err := strconv.Atoi(t)
	if err != nil || score < 1 || score > 10 {
		return false // не оценка — пусть обрабатывается как раньше
	}

	// Есть ли неотвеченный вопрос? Без него число — обычный запрос пароля,
	// и перехватывать его нельзя.
	var id int64
	err = a.db.QueryRowContext(ctx, `
		SELECT id FROM visit_feedback
		WHERE owner_id = ? AND score IS NULL AND asked_at > ?
		ORDER BY asked_at DESC LIMIT 1`,
		ownerID, T(nowUTC().Add(-feedbackWaitHours*time.Hour))).Scan(&id)
	if err != nil {
		return false
	}

	if _, err := a.db.ExecContext(ctx,
		`UPDATE visit_feedback SET score = ?, answered_at = ? WHERE id = ?`,
		score, T(nowUTC()), id); err != nil {
		a.logger.Printf("Отзывы: сохранение оценки: %v", err)
		return false
	}

	reply := "Спасибо за оценку!"
	if score <= 6 {
		// Низкая оценка — не отделываемся благодарностью: это повод
		// разобраться, и клиника должна увидеть причину.
		reply = "Спасибо за честный ответ. Жаль, что визит не оправдал ожиданий — " +
			"напишите пару слов, что было не так, мы разберёмся."
	}
	a.telegramReply(ctx, chatID, reply, nil)
	a.logger.Printf("Отзывы: получена оценка %d от владельца %s", score, ownerID)
	return true
}

// tryRecordFeedbackComment сохраняет текстовый комментарий сразу после
// низкой оценки — иначе он ушёл бы в выдачу пароля и потерялся.
func (a *app) tryRecordFeedbackComment(ctx context.Context, ownerID, text string) bool {
	t := strings.TrimSpace(text)
	if t == "" || len(t) < 3 {
		return false
	}
	var id int64
	err := a.db.QueryRowContext(ctx, `
		SELECT id FROM visit_feedback
		WHERE owner_id = ? AND score IS NOT NULL AND score <= 6
		  AND (comment IS NULL OR comment = '')
		  AND answered_at > ?
		ORDER BY answered_at DESC LIMIT 1`,
		ownerID, T(nowUTC().Add(-1*time.Hour))).Scan(&id)
	if err != nil {
		return false
	}
	if _, err := a.db.ExecContext(ctx,
		`UPDATE visit_feedback SET comment = ? WHERE id = ?`, t, id); err != nil {
		return false
	}
	return true
}

// ─── Отчёт ───────────────────────────────────────────────────────────────────

type feedbackStats struct {
	Count     int      `json:"count"`
	Average   float64  `json:"average"`
	Promoters int      `json:"promoters"` // 9–10
	Passives  int      `json:"passives"`  // 7–8
	Critics   int      `json:"critics"`   // 1–6
	NPS       int      `json:"nps"`
	Comments  []string `json:"comments"`
}

func (a *app) handleFeedback(w http.ResponseWriter, r *http.Request) {
	ctx, cancel := context.WithTimeout(r.Context(), 15*time.Second)
	defer cancel()

	from := strings.TrimSpace(r.URL.Query().Get("from"))
	to := strings.TrimSpace(r.URL.Query().Get("to"))
	where := "score IS NOT NULL"
	var args []interface{}
	if from != "" && to != "" {
		where += " AND date(answered_at) BETWEEN ? AND ?"
		args = append(args, from, to)
	}

	rows, err := a.db.QueryContext(ctx,
		`SELECT score, COALESCE(comment,'') FROM visit_feedback WHERE `+where, args...)
	if err != nil {
		a.logger.Printf("Отзывы: отчёт: %v", err)
		writeError(w, http.StatusInternalServerError, "Не удалось получить отзывы")
		return
	}
	defer rows.Close()

	var st feedbackStats
	st.Comments = []string{}
	sum := 0
	for rows.Next() {
		var score int
		var comment string
		if rows.Scan(&score, &comment) != nil {
			continue
		}
		st.Count++
		sum += score
		switch {
		case score >= 9:
			st.Promoters++
		case score >= 7:
			st.Passives++
		default:
			st.Critics++
		}
		if comment != "" && len(st.Comments) < 20 {
			st.Comments = append(st.Comments, fmt.Sprintf("%d — %s", score, comment))
		}
	}
	if st.Count > 0 {
		st.Average = float64(sum) / float64(st.Count)
		// NPS = доля промоутеров минус доля критиков, в процентных пунктах.
		st.NPS = (st.Promoters - st.Critics) * 100 / st.Count
	}
	writeJSON(w, http.StatusOK, apiResponse{Status: "ok", Data: st})
}
