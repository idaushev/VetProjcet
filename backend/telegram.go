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
	"crypto/rand"
	"database/sql"
	"encoding/binary"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"strconv"
	"strings"
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

// startTelegramNotifier запускает фоновые циклы бота. Токен теперь
// редактируется из UI, поэтому циклы работают ВСЕГДА и сами проверяют
// на каждой итерации, задан ли токен: включение/выключение бота из
// интерфейса применяется без перезапуска сервера.
func (a *app) startTelegramNotifier() {
	if a.tgToken() == "" {
		a.logger.Println("Телеграм-бот: токен пока не задан (укажите в Настройках) — outbox копится")
	} else {
		a.logger.Println("Телеграм-бот: отправитель уведомлений и приём сообщений запущены")
	}
	// Доставка outbox
	go func() {
		for {
			if a.tgToken() != "" {
				a.deliverPendingNotifications()
			}
			time.Sleep(30 * time.Second)
		}
	}()
	// Приём входящих (long-poll); сам пропускает итерацию без токена
	go a.telegramPollUpdates()
	// Планировщик напоминаний: раз в час. Дедупликация по ref_id, поэтому
	// повторные проходы дублей не создают. Уважает флаг reminders_enabled.
	go func() {
		for {
			if a.tgToken() != "" && a.remindersEnabled() {
				a.reminderSweep()
			}
			time.Sleep(time.Hour)
		}
	}()
}

// ─── Напоминания ─────────────────────────────────────────────────────────────

// astanaDate возвращает YYYY-MM-DD в часовом поясе клиники (UTC+5) со сдвигом дней.
func astanaDate(daysAhead int) string {
	return nowUTC().Add(5*time.Hour).AddDate(0, 0, daysAhead).Format("2006-01-02")
}

func (a *app) reminderSweep() {
	ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
	defer cancel()

	// 1. Записи на завтра: владелец привязан к боту, напоминание ещё не ставили.
	tomorrow := astanaDate(1)
	rows, err := a.db.QueryContext(ctx, `
		SELECT ap.id, ap.owner_id, t.chat_id, ap.starts_at,
		       COALESCE(p.name, ap.pet_name, ''), COALESCE(s.name, '')
		FROM appointments ap
		JOIN owner_telegram t    ON t.owner_id = ap.owner_id
		LEFT JOIN pets p         ON p.id = ap.pet_id
		LEFT JOIN clinic_staff s ON s.id = ap.staff_id
		WHERE ap.is_deleted=0 AND ap.status='scheduled'
		  AND substr(ap.starts_at,1,10) = ?
		  AND NOT EXISTS (SELECT 1 FROM notifications n WHERE n.ref_id = ap.id AND n.kind = ?)`,
		tomorrow, notifyVisitReminder)
	if err != nil {
		a.logger.Printf("reminderSweep appointments: %v", err)
		return
	}
	type apptRow struct {
		id, ownerID, petName, staffName string
		chatID                          int64
		startsAt                        string
	}
	var appts []apptRow
	for rows.Next() {
		var r apptRow
		var starts timeScanner
		if err := rows.Scan(&r.id, &r.ownerID, &r.chatID, &starts, &r.petName, &r.staffName); err == nil {
			if starts.t != nil {
				r.startsAt = starts.t.Format("15:04")
			}
			appts = append(appts, r)
		}
	}
	rows.Close() // до INSERT — незакрытый курсор блокирует запись

	for _, r := range appts {
		msg := "Напоминаем: завтра"
		if r.startsAt != "" {
			msg += " в " + r.startsAt
		}
		msg += " вы записаны в клинику"
		if r.petName != "" {
			msg += " (" + r.petName + ")"
		}
		if r.staffName != "" {
			msg += ", врач: " + r.staffName
		}
		msg += ".\nЕсли планы изменились — пожалуйста, позвоните нам."
		if _, err := a.db.ExecContext(ctx,
			`INSERT INTO notifications (owner_id, chat_id, kind, message, ref_id) VALUES (?, ?, ?, ?, ?)`,
			r.ownerID, r.chatID, notifyVisitReminder, msg, r.id); err != nil {
			a.logger.Printf("reminderSweep enqueue: %v", err)
		}
	}
	if len(appts) > 0 {
		a.logger.Printf("Напоминания: поставлено %d о записях на %s", len(appts), tomorrow)
	}

	// 2. Вакцинации: срок через 3 дня.
	dueDay := astanaDate(3)
	vrows, err := a.db.QueryContext(ctx, `
		SELECT v.id, p.owner_id, t.chat_id, v.vaccine_name, p.name
		FROM vaccinations v
		JOIN pets p           ON p.id = v.pet_id AND p.is_deleted=0
		JOIN owner_telegram t ON t.owner_id = p.owner_id
		WHERE v.is_deleted=0 AND substr(COALESCE(v.next_due_at,''),1,10) = ?
		  AND NOT EXISTS (SELECT 1 FROM notifications n WHERE n.ref_id = v.id AND n.kind = ?)`,
		dueDay, notifyVaccinationDue)
	if err != nil {
		a.logger.Printf("reminderSweep vaccinations: %v", err)
		return
	}
	type vaccRow struct {
		id, ownerID, vaccine, petName string
		chatID                        int64
	}
	var vaccs []vaccRow
	for vrows.Next() {
		var r vaccRow
		if err := vrows.Scan(&r.id, &r.ownerID, &r.chatID, &r.vaccine, &r.petName); err == nil {
			vaccs = append(vaccs, r)
		}
	}
	vrows.Close()

	for _, r := range vaccs {
		msg := "Через 3 дня у питомца " + r.petName + " подходит срок вакцинации (" + r.vaccine + ").\n" +
			"Позвоните нам, чтобы выбрать удобное время."
		if _, err := a.db.ExecContext(ctx,
			`INSERT INTO notifications (owner_id, chat_id, kind, message, ref_id) VALUES (?, ?, ?, ?, ?)`,
			r.ownerID, r.chatID, notifyVaccinationDue, msg, r.id); err != nil {
			a.logger.Printf("reminderSweep enqueue vacc: %v", err)
		}
	}
	if len(vaccs) > 0 {
		a.logger.Printf("Напоминания: поставлено %d о вакцинациях на %s", len(vaccs), dueDay)
	}
}

// ─── Одноразовый пароль портала ──────────────────────────────────────────────

const portalCodeTTL = 10 * time.Minute

// portalAdminCodeTTL — срок пароля, выданного администратором вручную.
// Больше ботовского: код диктуют владельцу голосом по телефону или на
// стойке, ему нужно успеть дойти до устройства и ввести номер.
const portalAdminCodeTTL = time.Hour

// issuePortalCode выдаёт владельцу свежий 6-значный пароль для входа
// на портал. Прежние невостребованные коды гасятся: действует только
// последний — иначе перехваченный старый код жил бы до истечения TTL.
func (a *app) issuePortalCode(ctx context.Context, ownerID string, ttl time.Duration) (string, error) {
	var b [8]byte
	if _, err := rand.Read(b[:]); err != nil {
		return "", err
	}
	code := strconv.FormatUint(binary.BigEndian.Uint64(b[:])%900000+100000, 10)

	if _, err := a.db.ExecContext(ctx,
		`UPDATE portal_codes SET used_at=? WHERE owner_id=? AND used_at IS NULL`,
		T(nowUTC()), ownerID); err != nil {
		return "", err
	}
	if _, err := a.db.ExecContext(ctx,
		`INSERT INTO portal_codes (owner_id, code, expires_at) VALUES (?, ?, ?)`,
		ownerID, code, T(nowUTC().Add(ttl))); err != nil {
		return "", err
	}
	return code, nil
}

// ─── Приём входящих сообщений (getUpdates long-poll) ─────────────────────────

type tgUpdate struct {
	UpdateID int64 `json:"update_id"`
	Message  *struct {
		Chat struct {
			ID int64 `json:"id"`
		} `json:"chat"`
		From struct {
			Username string `json:"username"`
		} `json:"from"`
		Text    string `json:"text"`
		Contact *struct {
			PhoneNumber string `json:"phone_number"`
		} `json:"contact"`
	} `json:"message"`
}

func (a *app) tgStateGet(key string) string {
	var v string
	_ = a.db.QueryRow(`SELECT value FROM telegram_state WHERE key=?`, key).Scan(&v)
	return v
}

func (a *app) tgStateSet(key, value string) {
	a.db.Exec(`INSERT INTO telegram_state (key, value) VALUES (?, ?)
	           ON CONFLICT(key) DO UPDATE SET value=excluded.value`, key, value)
}

func (a *app) telegramPollUpdates() {
	offset, _ := strconv.ParseInt(a.tgStateGet("update_offset"), 10, 64)
	for {
		// Токен могли ещё не задать или убрать из Настроек — ждём, не долбя API.
		if a.tgToken() == "" {
			time.Sleep(30 * time.Second)
			continue
		}
		updates, err := a.telegramGetUpdates(offset)
		if err != nil {
			a.logger.Printf("telegram getUpdates: %v", err)
			time.Sleep(15 * time.Second)
			continue
		}
		for _, u := range updates {
			if u.UpdateID >= offset {
				offset = u.UpdateID + 1
			}
			a.handleTelegramUpdate(u)
		}
		if len(updates) > 0 {
			a.tgStateSet("update_offset", strconv.FormatInt(offset, 10))
		}
	}
}

func (a *app) telegramGetUpdates(offset int64) ([]tgUpdate, error) {
	// timeout=25 — long-poll: Telegram держит соединение до 25 секунд,
	// поэтому цикл не молотит API впустую.
	url := fmt.Sprintf("%s%s/getUpdates?timeout=25&offset=%d",
		telegramAPIBase, a.tgToken(), offset)
	ctx, cancel := context.WithTimeout(context.Background(), 35*time.Second)
	defer cancel()
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, url, nil)
	if err != nil {
		return nil, err
	}
	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		return nil, err
	}
	defer resp.Body.Close()
	body, err := io.ReadAll(io.LimitReader(resp.Body, 4<<20))
	if err != nil {
		return nil, err
	}
	var parsed struct {
		OK     bool       `json:"ok"`
		Result []tgUpdate `json:"result"`
	}
	if err := json.Unmarshal(body, &parsed); err != nil {
		return nil, err
	}
	if !parsed.OK {
		return nil, fmt.Errorf("telegram api: not ok")
	}
	return parsed.Result, nil
}

// handleTelegramUpdate — вся логика диалога с владельцем:
//
//	/start            → просим номер (кнопка «поделиться контактом»)
//	контакт или номер → ищем владельца, привязываем чат, шлём пароль
//	«пароль»/другое   → привязан: новый пароль; не привязан: просим номер
func (a *app) handleTelegramUpdate(u tgUpdate) {
	if u.Message == nil {
		return
	}
	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()

	chatID := u.Message.Chat.ID
	text := strings.TrimSpace(u.Message.Text)

	// Кнопка «поделиться контактом» — самый надёжный источник номера.
	phone := ""
	if u.Message.Contact != nil {
		phone = normalizePhoneDigits(u.Message.Contact.PhoneNumber)
	} else if d := normalizePhoneDigits(text); len(d) >= 10 && !strings.HasPrefix(text, "/") {
		phone = d
	}

	if phone != "" {
		owner, err := a.findOwnerByPhone(ctx, phone)
		if err != nil || owner.ID == "" {
			a.telegramReply(ctx, chatID,
				"Этот номер не найден в базе клиники. Проверьте номер или обратитесь в регистратуру.", nil)
			return
		}
		if err := a.linkOwnerChat(ctx, owner.ID, chatID, u.Message.From.Username); err != nil {
			a.logger.Printf("telegram link: %v", err)
			return
		}
		a.sendPortalCode(ctx, chatID, owner.ID, owner.Fio)
		return
	}

	// Чат уже привязан? Любой запрос («пароль», «код», что угодно) — новый пароль.
	var ownerID string
	_ = a.db.QueryRowContext(ctx,
		`SELECT owner_id FROM owner_telegram WHERE chat_id=?`, chatID).Scan(&ownerID)
	if ownerID != "" && text != "/start" {
		a.sendPortalCode(ctx, chatID, ownerID, "")
		return
	}

	// Не привязан (или /start): просим номер.
	a.telegramReply(ctx, chatID,
		"Здравствуйте! Это бот ветклиники.\n\n"+
			"Чтобы получать пароль для входа в кабинет владельца, отправьте свой номер телефона — "+
			"кнопкой ниже или просто сообщением (например, +7 707 123-45-67).",
		map[string]interface{}{
			"keyboard": [][]map[string]interface{}{
				{{"text": "📱 Отправить мой номер", "request_contact": true}},
			},
			"resize_keyboard":   true,
			"one_time_keyboard": true,
		})
}

func (a *app) sendPortalCode(ctx context.Context, chatID int64, ownerID, fio string) {
	code, err := a.issuePortalCode(ctx, ownerID, portalCodeTTL)
	if err != nil {
		a.logger.Printf("telegram issue code: %v", err)
		a.telegramReply(ctx, chatID, "Не получилось создать пароль, попробуйте ещё раз чуть позже.", nil)
		return
	}
	hello := ""
	if fio != "" {
		hello = fio + ", номер привязан!\n\n"
	}
	msg := hello + "Ваш пароль для входа в кабинет: " + code +
		"\n\nОн действует 10 минут и подходит один раз. Нужен новый — просто напишите «пароль»."
	if a.portalURL() != "" {
		msg += "\n\nКабинет: " + a.portalURL()
	}
	a.telegramReply(ctx, chatID, msg, map[string]interface{}{"remove_keyboard": true})
}

// telegramReply — отправка вне outbox: ответы в диалоге должны уходить
// сразу, а не ждать 30-секундный цикл отправителя.
func (a *app) telegramReply(ctx context.Context, chatID int64, text string, replyMarkup interface{}) {
	payload := map[string]interface{}{"chat_id": chatID, "text": text}
	if replyMarkup != nil {
		payload["reply_markup"] = replyMarkup
	}
	body, _ := json.Marshal(payload)
	req, err := http.NewRequestWithContext(ctx, http.MethodPost,
		telegramAPIBase+a.tgToken()+"/sendMessage", bytes.NewReader(body))
	if err != nil {
		return
	}
	req.Header.Set("Content-Type", "application/json")
	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		a.logger.Printf("telegram reply: %v", err)
		return
	}
	resp.Body.Close()
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
		telegramAPIBase+a.tgToken()+"/sendMessage", bytes.NewReader(body))
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

// ─── Журнал уведомлений (для клиники) ────────────────────────────────────────

// handleNotifications отдаёт последние уведомления: кому, что, когда, статус.
// Персонал видит, ушло ли напоминание клиенту и не отвалился ли бот.
// Гейт — requireAdmin (маршрут в handlers.go): в журнале телефоны и тексты.
func (a *app) handleNotifications(w http.ResponseWriter, r *http.Request) {
	ctx, cancel := context.WithTimeout(r.Context(), 5*time.Second)
	defer cancel()

	rows, err := a.db.QueryContext(ctx, `
		SELECT n.id, COALESCE(n.kind,''), COALESCE(n.message,''), COALESCE(n.status,''),
		       COALESCE(n.error,''), n.created_at, n.sent_at,
		       COALESCE(o.fio,''), COALESCE(o.phone,'')
		FROM notifications n
		LEFT JOIN owners o ON o.id = n.owner_id
		ORDER BY n.id DESC LIMIT 200`)
	if err != nil {
		a.logger.Printf("handleNotifications: %v", err)
		writeError(w, http.StatusInternalServerError, "failed to load notifications")
		return
	}
	defer rows.Close()

	type notifRow struct {
		ID         int64  `json:"id"`
		Kind       string `json:"kind"`
		Message    string `json:"message"`
		Status     string `json:"status"`
		Error      string `json:"error,omitempty"`
		CreatedAt  string `json:"created_at"`
		SentAt     string `json:"sent_at,omitempty"`
		OwnerFio   string `json:"owner_fio,omitempty"`
		OwnerPhone string `json:"owner_phone,omitempty"`
	}
	list := make([]notifRow, 0, 200)
	var pending, sent, errored int
	for rows.Next() {
		var n notifRow
		var created, sentAt timeScanner
		if err := rows.Scan(&n.ID, &n.Kind, &n.Message, &n.Status, &n.Error,
			&created, &sentAt, &n.OwnerFio, &n.OwnerPhone); err != nil {
			continue
		}
		if created.t != nil {
			n.CreatedAt = created.t.Format(time.RFC3339)
		}
		if sentAt.t != nil {
			n.SentAt = sentAt.t.Format(time.RFC3339)
		}
		switch n.Status {
		case "sent":
			sent++
		case "error":
			errored++
		default:
			pending++
		}
		list = append(list, n)
	}

	writeJSON(w, http.StatusOK, apiResponse{Status: "ok", Data: map[string]interface{}{
		"items":         list,
		"bot_enabled":   a.tgToken() != "",
		"count_sent":    sent,
		"count_pending": pending,
		"count_error":   errored,
	}})
}
