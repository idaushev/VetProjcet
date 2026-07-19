package main

// Телеграм-бот: архитектурный каркас.
//
// Назначение бота (см. docs/TELEGRAM.md):
//   1. Высылать владельцам доступы к порталу (ссылку/код входа).
//   2. Сообщать информацию: напоминания о следующем приёме, о вакцинации,
//      произвольные сообщения из клиники.
//
// Устройство — классический outbox:
//   • Любой код клиники «отправляет» сообщение вызовом enqueueOwnerNotification —
//     это просто INSERT в таблицу notifications (status='pending').
//   • Фоновый отправитель (startTelegramNotifier) раз в 30 секунд забирает
//     pending-строки с известным chat_id и доставляет через Bot API.
//   • Привязка владельца к чату — таблица owner_telegram; заполняется, когда
//     владелец отправит боту /start <код> (код выдаёт клиника, таблица
//     telegram_link_codes). Обработка входящих (getUpdates) — следующий этап.
//
// Без TELEGRAM_BOT_TOKEN весь механизм спит: enqueue продолжает писать
// в outbox (сообщения дождутся включения бота), отправитель не стартует.

import (
	"bytes"
	"context"
	"database/sql"
	"encoding/json"
	"fmt"
	"net/http"
	"time"
)

const telegramAPIBase = "https://api.telegram.org/bot"

// Виды уведомлений — фиксируем строками, чтобы по outbox можно было строить
// статистику и ретраи по типам.
const (
	notifyPortalAccess   = "portal_access"   // доступ к порталу владельца
	notifyVisitReminder  = "visit_reminder"  // напоминание о следующем приёме
	notifyVaccinationDue = "vaccination_due" // подходит срок вакцинации
	notifyCustom         = "custom"          // произвольное сообщение из клиники
)

// enqueueOwnerNotification ставит сообщение владельцу в очередь отправки.
// Если владелец ещё не привязал телеграм — сообщение ляжет в outbox без
// chat_id и уедет автоматически после привязки (бэкфилл в linkOwnerChat).
func (a *app) enqueueOwnerNotification(ctx context.Context, ownerID, kind, message string) error {
	var chatID sql.NullInt64
	_ = a.db.QueryRowContext(ctx,
		`SELECT chat_id FROM owner_telegram WHERE owner_id=?`, ownerID).Scan(&chatID)
	_, err := a.db.ExecContext(ctx,
		`INSERT INTO notifications (owner_id, chat_id, kind, message) VALUES (?, ?, ?, ?)`,
		ownerID, chatID, kind, message)
	return err
}

// linkOwnerChat привязывает чат к владельцу (вызовется из обработчика
// /start <код>, когда появится приём входящих) и досылает всё, что владелец
// «накопил» в outbox до привязки.
func (a *app) linkOwnerChat(ctx context.Context, ownerID string, chatID int64, username string) error {
	if _, err := a.db.ExecContext(ctx, `
		INSERT INTO owner_telegram (owner_id, chat_id, username) VALUES (?, ?, ?)
		ON CONFLICT(owner_id) DO UPDATE SET chat_id=excluded.chat_id, username=excluded.username, linked_at=CURRENT_TIMESTAMP`,
		ownerID, chatID, nullableString(username)); err != nil {
		return err
	}
	// Бэкфилл: ожидающие сообщения без chat_id получают адресата.
	_, err := a.db.ExecContext(ctx,
		`UPDATE notifications SET chat_id=? WHERE owner_id=? AND status='pending' AND chat_id IS NULL`,
		chatID, ownerID)
	return err
}

// ─── Фоновый отправитель ─────────────────────────────────────────────────────

func (a *app) startTelegramNotifier() {
	if a.config.TelegramToken == "" {
		a.logger.Println("Телеграм-бот выключен (TELEGRAM_BOT_TOKEN не задан); outbox копится")
		return
	}
	a.logger.Println("Телеграм-бот: отправитель уведомлений запущен")
	go func() {
		for {
			a.deliverPendingNotifications()
			time.Sleep(30 * time.Second)
		}
	}()
}

func (a *app) deliverPendingNotifications() {
	ctx, cancel := context.WithTimeout(context.Background(), 25*time.Second)
	defer cancel()

	rows, err := a.db.QueryContext(ctx, `
		SELECT id, chat_id, message FROM notifications
		WHERE status='pending' AND chat_id IS NOT NULL
		ORDER BY id LIMIT 20`)
	if err != nil {
		a.logger.Printf("telegram outbox: %v", err)
		return
	}
	type item struct {
		id     int64
		chatID int64
		msg    string
	}
	var batch []item
	for rows.Next() {
		var it item
		if err := rows.Scan(&it.id, &it.chatID, &it.msg); err == nil {
			batch = append(batch, it)
		}
	}
	rows.Close()

	for _, it := range batch {
		if err := a.telegramSendMessage(ctx, it.chatID, it.msg); err != nil {
			a.logger.Printf("telegram send #%d: %v", it.id, err)
			a.db.ExecContext(ctx,
				`UPDATE notifications SET status='error', error=? WHERE id=?`, err.Error(), it.id)
			continue
		}
		a.db.ExecContext(ctx,
			`UPDATE notifications SET status='sent', sent_at=? WHERE id=?`, T(nowUTC()), it.id)
	}
}

func (a *app) telegramSendMessage(ctx context.Context, chatID int64, text string) error {
	body, _ := json.Marshal(map[string]interface{}{
		"chat_id": chatID,
		"text":    text,
	})
	req, err := http.NewRequestWithContext(ctx, http.MethodPost,
		telegramAPIBase+a.config.TelegramToken+"/sendMessage", bytes.NewReader(body))
	if err != nil {
		return err
	}
	req.Header.Set("Content-Type", "application/json")
	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		return err
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		return fmt.Errorf("telegram api: HTTP %d", resp.StatusCode)
	}
	return nil
}
