package main

import (
	"context"
	"database/sql"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"strings"
	"time"
)

// ─── POST /sync/push ──────────────────────────────────────────────────────────
//
// Принимает batch pending-записей от клиента.
// Использует lenient-декодер (без DisallowUnknownFields) потому что клиент
// отправляет дополнительные поля: sync_status, server_id, created_at и т.п.
//
// Стратегия конфликтов: latest updated_at wins.

func (a *app) handleSyncPush(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		writeError(w, http.StatusMethodNotAllowed, "method not allowed")
		return
	}

	// ── Lenient-декодер: не падаем на неизвестных полях ──────────────
	body, err := io.ReadAll(io.LimitReader(r.Body, 8<<20)) // 8 MB limit
	r.Body.Close()
	if err != nil {
		writeError(w, http.StatusBadRequest, "failed to read body")
		return
	}

	// Сырой payload: карта «сущность → массив записей» + device_id. Ядро не
	// знает поля сущностей — каждую свою секцию декодирует сама сущность в
	// pushEntity (см. sync_registry.go). Так модуль добавляет сущность, не
	// трогая структуры ядра. Формат на проводе прежний (те же ключи).
	var raw map[string]json.RawMessage
	if err := json.Unmarshal(body, &raw); err != nil {
		a.logger.Printf("syncPush decode: %v", err)
		writeError(w, http.StatusBadRequest, "invalid json: "+err.Error())
		return
	}

	ctx, cancel := context.WithTimeout(r.Context(), 30*time.Second)
	defer cancel()

	var deviceID string
	if dj, ok := raw["device_id"]; ok {
		_ = json.Unmarshal(dj, &deviceID) // необязательное поле
	}
	if deviceID != "" {
		a.upsertDevice(ctx, deviceID)
		// Устройство ПИШУЩЕГО — в каждую запись (pushEntity). Планшет шлёт у
		// записи device_id того, кто её СОЗДАЛ (так она пришла с pull), и
		// правка с другого планшета выглядела на сервере как правка «сам с
		// собой» — конфликт (VET-017, B-008) не определялся.
		ctx = context.WithValue(ctx, ctxKeyPushDevice{}, deviceID)
	}

	var result syncPushResult

	// Автор изменений: пользователь, чьим токеном подписан push.
	// Заполняет created_by/updated_by — задел под аудит «кто изменил».
	pushUserID := ""
	pushUser := userFromCtx(ctx)
	if pushUser != nil {
		pushUserID = pushUser.ID
	}
	// Право писать в таблицу: у «только просмотр» push отклоняется —
	// иначе право было бы фикцией, планшет всё равно продавил бы правки.
	// Умолчание — «запретить». Раньше при pushUser == nil разрешалось всё:
	// сейчас до хендлера без валидного токена не дойти (authMiddleware), но
	// стоило бы /sync попасть в authExempt — и гейт прав исчез бы молча.
	canPush := func(table string) bool {
		return pushUser != nil && pushUser.tableLevel(table) >= permLevels["create"]
	}

	// Обобщённый диспетчер: идём по реестру сущностей (порядок = FK). Вся ручная
	// логика — в pushX внутри замыканий реестра, см. sync_registry.go.
	for _, e := range syncEntities() {
		if e.pushAll != nil {
			e.pushAll(ctx, a, raw, e.PermTable, pushUserID, canPush, &result)
		}
	}

	a.logger.Printf("syncPush: accepted=%d skipped=%d", result.Accepted, result.Skipped)
	writeJSON(w, http.StatusOK, apiResponse{Status: "ok", Data: result})
}

// ─── GET /sync/pull?since=&device_id= ────────────────────────────────────────

func (a *app) handleSyncPull(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodGet {
		writeError(w, http.StatusMethodNotAllowed, "method not allowed")
		return
	}

	sinceStr := strings.TrimSpace(r.URL.Query().Get("since"))
	deviceID := strings.TrimSpace(r.URL.Query().Get("device_id"))

	var since time.Time
	if sinceStr != "" {
		t, err := parseFlexibleDate(sinceStr)
		if err != nil {
			writeError(w, http.StatusBadRequest, "since: invalid date")
			return
		}
		since = t
	}

	ctx, cancel := context.WithTimeout(r.Context(), 15*time.Second)
	defer cancel()

	if deviceID != "" {
		a.upsertDevice(ctx, deviceID)
	}

	// Ответ — карта «сущность → записи» + server_time. Клиент читает по ключу
	// (data[store]), поэтому карта даёт тот же JSON, что прежняя структура —
	// совместимо со старыми планшетами. Ключи и форма записей не меняются.
	data := map[string]any{"server_time": nowUTC()}

	// Право читать таблицу — зеркало canPush на push-стороне. Без этого гейта
	// изоляция ролей была только в UI: планшет с ограниченной ролью (напр.
	// продавец склада) всё равно получал ВСЕ приёмы и медкарты в локальную
	// базу — их видно из консоли и IndexedDB. Пропускаем сущность, если у
	// пользователя нет даже права view. tableLevel по умолчанию отдаёт edit
	// (админ и пользователь без настроенных прав), так что незакрытые роли
	// не задеты; модульные роли (склад) разрешаются через moduleRolePermission
	// внутри tableLevel.
	//
	// Право берётся из e.PermTable — того же поля, по которому идёт push.
	// Раньше здесь была своя копия отображения, и она разошлась с push:
	// visit_results попадали в default (= edit всем), расписание читалось по
	// праву приёмов, а продавец склада не получал складских таблиц вовсе.
	// Справочникам ("templates") умолчание — view: читать их нужно всем.
	pullUser := userFromCtx(ctx)
	canPull := func(e syncEntity) bool {
		return pullUser == nil || pullUser.tableLevel(e.PermTable) >= permLevels["view"]
	}

	// Загружаем каждую сущность независимо: ошибка одной НЕ прерывает остальные.
	// (Раньше любая scan-ошибка роняла весь pull в 500.)
	for _, e := range syncEntities() {
		if e.pull == nil {
			continue
		}
		if !canPull(e) {
			continue // таблица недоступна этой роли — не отдаём её на устройство
		}
		if v, err := e.pull(ctx, a.db, since); err != nil {
			a.logger.Printf("syncPull %s: %v", e.Name, err)
		} else {
			data[e.Name] = v
		}
	}

	// Полевая маскировка сумм: пользователь со scope own/selected имеет право
	// видеть чужие визиты (право view на таблицу), но НЕ их деньги. Табличный
	// гейт выше этого не закрывает — визиты приходят, поэтому денежные поля
	// чужих визитов затираем здесь, до отдачи на устройство. Иначе ограничение
	// «видит только свои суммы» осталось бы лишь в UI (видно из IndexedDB).
	if pullUser != nil && !pullUser.seesAllSums() {
		a.maskForeignSums(ctx, pullUser, data)
	}

	writeJSON(w, http.StatusOK, apiResponse{Status: "ok", Data: data})
}

// maskConflictSums — то же для проигравших версий приёма (VET-017): в них
// лежат суммы целиком. Врач у версии может отличаться от врача приёма, поэтому
// право проверяется по каждой; без врача в версии — по врачу приёма.
func maskConflictSums(u *User, cj, visitStaff string) string {
	if cj == "" {
		return cj
	}
	var list []conflictEntry
	if json.Unmarshal([]byte(cj), &list) != nil {
		return "" // разобрать нельзя — не отдаём вовсе, чем отдать непроверенным
	}
	changed := false
	for i := range list {
		staff := list[i].StaffID
		if staff == "" {
			staff = visitStaff
		}
		if !u.canSeeSum(staff) {
			list[i].TotalAmount, list[i].PaymentCard, list[i].Discount = 0, 0, 0
			list[i].DiscountReason = ""
			if list[i].Item != nil { // B-008: цена и итог строки счёта
				list[i].Item.Price, list[i].Item.Total = 0, 0
			}
			changed = true
		}
	}
	if !changed {
		return cj
	}
	b, _ := json.Marshal(list)
	return string(b)
}

// maskForeignSums затирает денежные поля визитов и позиций, чей врач вне
// scope пользователя. Свои визиты не трогаются — клиенту нужны собственные
// суммы для расчётов и отчёта. Вызывается только для ограниченного scope.
func (a *app) maskForeignSums(ctx context.Context, u *User, data map[string]any) {
	if vs, ok := data["visits"].([]Visit); ok {
		maskVisitSums(u, vs)
	}
	if items, ok := data["visit_items"].([]VisitItem); ok {
		a.maskItemSums(ctx, u, items)
	}
}

// maskVisitSums — денежные поля приёмов чужих врачей (и их проигравших
// версий). Общая для pull и REST-чтения: маскировка была только в pull, и
// GET /visits отдавал чужие суммы тому, кому их видеть нельзя (B-010).
func maskVisitSums(u *User, vs []Visit) {
	if u == nil || u.seesAllSums() {
		return
	}
	for i := range vs {
		if !u.canSeeSum(vs[i].StaffID) {
			vs[i].TotalAmount = 0
			vs[i].PaymentCard = 0
			vs[i].Discount = 0
			vs[i].DiscountReason = ""
		}
		vs[i].ConflictJSON = maskConflictSums(u, vs[i].ConflictJSON, vs[i].StaffID)
	}
}

// maskItemSums — цены и суммы позиций приёмов чужих врачей.
func (a *app) maskItemSums(ctx context.Context, u *User, items []VisitItem) {
	if u == nil || u.seesAllSums() || len(items) == 0 {
		return
	}
	// Позиции не несут staff_id — врача берём из их визита. Инкрементальный
	// pull визитов может не содержать нужные, поэтому staff_id тянем напрямую.
	// Клиника небольшая, один проход дёшев; выполняется только для scope
	// own/selected, не для админа и не для «все суммы».
	staffOf := map[string]string{}
	if rows, err := a.db.QueryContext(ctx, `SELECT id, COALESCE(staff_id,'') FROM visits`); err == nil {
		defer rows.Close()
		for rows.Next() {
			var id, st string
			if rows.Scan(&id, &st) == nil {
				staffOf[id] = st
			}
		}
	} else {
		// Не смогли определить врачей — безопаснее замаскировать всё, чем
		// раскрыть чужие суммы.
		a.logger.Printf("maskForeignSums visits staff: %v", err)
		for i := range items {
			items[i].Price = 0
			items[i].Total = 0
		}
		return
	}
	for i := range items {
		if !u.canSeeSum(staffOf[items[i].VisitID]) {
			items[i].Price = 0
			items[i].Total = 0
		}
	}
}

// ─── Push helpers — upsert с conflict resolution ──────────────────────────────

// clientWins сравнивает версию и время клиента с сервером.
// Стратегия: version-first, then timestamp.
//   - Если у клиента version > серверного — принимаем безусловно (явное обновление).
//   - Если version одинаковый — сравниваем updated_at (>= чтобы принять одновременные правки).
//   - Новая запись (not found) — всегда принимаем.
func clientWinsVersion(ctx context.Context, db *sql.DB, table, id string, clientUpdatedAt string, clientVersion int) (bool, error) {
	clientTime := parseSyncTime(clientUpdatedAt)

	// Берём client_updated_at — время КЛИЕНТА с прошлого push.
	// Сравнивать с updated_at нельзя: там время сервера, оно всегда позже
	// клиентского, и клиент проигрывал бы каждый конфликт.
	var prevClientTime timeScanner
	var serverVersion int
	err := db.QueryRowContext(ctx,
		`SELECT client_updated_at, COALESCE(version,1) FROM `+table+` WHERE id=?`, id,
	).Scan(&prevClientTime, &serverVersion)

	if err == sql.ErrNoRows {
		return true, nil // новая запись — принимаем
	}
	if err != nil {
		return true, nil // ошибка scan — принимаем (безопасный fallback)
	}

	// Клиент явно инкрементировал версию → принимаем.
	if clientVersion > serverVersion {
		return true, nil
	}

	// Записи, созданные до появления client_updated_at (или пришедшие не через
	// синхронизацию), времени клиента не имеют. Принимаем: иначе такая строка
	// осталась бы замороженной навсегда — правки и удаления с планшета
	// отклонялись бы вечно.
	if prevClientTime.t == nil {
		return true, nil
	}

	// Версии равны — сравниваем время клиента с временем клиента.
	// >= (не After) позволяет принять правки при одинаковом времени.
	return !clientTime.Before(*prevClientTime.t), nil
}

func pushOwner(ctx context.Context, db *sql.DB, rec ownerSyncRecord) (bool, error) {
	if rec.ID == "" {
		return false, fmt.Errorf("empty id")
	}
	wins, err := clientWinsVersion(ctx, db, "owners", rec.ID, rec.UpdatedAt, rec.Version)
	if err != nil || !wins {
		return false, err
	}
	// serverNow — время СЕРВЕРА. Ключевой момент синхронизации:
	// клиентское updated_at используется только для conflict resolution (выше),
	// а в БД хранится серверное время. Иначе инкрементальный pull
	// (WHERE updated_at > since) не находит записи с "прошлым" клиентским временем.
	serverNow := T(nowUTC())
	// Время клиента сохраняем как есть — по нему разрешаются будущие конфликты.
	clientAt := Tp(parseSyncTimePtr(&rec.UpdatedAt))
	deletedAt := Tp(parseSyncTimePtr(rec.DeletedAt))
	// Тип владельца не присланным полем считаем «неизвестно», а не «физлицо».
	// Клиент старой версии owner_type не шлёт вовсе, и схлопывание пустого
	// значения в individual молча разжаловало бы приют или питомник в
	// физлицо при первой же синхронизации со старого планшета.
	var ownerType interface{}
	if strings.TrimSpace(rec.OwnerType) != "" {
		ownerType = normalizeOwnerType(rec.OwnerType)
	}
	_, err = db.ExecContext(ctx, `
		INSERT INTO owners (id, fio, owner_type, iin, phone, address, notes, updated_at, deleted_at, is_deleted, device_id, version, created_at, client_updated_at)
		VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
		ON CONFLICT(id) DO UPDATE SET
		  fio=excluded.fio,
		  owner_type=COALESCE(excluded.owner_type, owners.owner_type),
		  -- ИИН от старого клиента приходит пустым: он это поле не шлёт.
		  -- Пустое значение не должно стирать уже введённый номер.
		  iin=COALESCE(excluded.iin, owners.iin), phone=excluded.phone,
		  address=excluded.address, notes=excluded.notes,
		  updated_at=excluded.updated_at, deleted_at=excluded.deleted_at,
		  is_deleted=excluded.is_deleted, device_id=excluded.device_id,
		  version=excluded.version,
		  client_updated_at=excluded.client_updated_at`,
		rec.ID, rec.FIO, ownerType, nullableString(normalizeIIN(rec.IIN)), rec.Phone,
		nullableString(rec.Address), nullableString(rec.Notes),
		serverNow, deletedAt, rec.IsDeleted,
		nullableString(rec.DeviceID), rec.Version, serverNow, clientAt,
	)
	return err == nil, err
}

func pushPet(ctx context.Context, db *sql.DB, rec petSyncRecord) (bool, error) {
	if rec.ID == "" {
		return false, fmt.Errorf("empty id")
	}
	wins, err := clientWinsVersion(ctx, db, "pets", rec.ID, rec.UpdatedAt, rec.Version)
	if err != nil || !wins {
		return false, err
	}
	status := rec.Status
	if status == "" {
		status = "active"
	}
	serverNow := T(nowUTC())
	// Время клиента сохраняем как есть — по нему разрешаются будущие конфликты.
	clientAt := Tp(parseSyncTimePtr(&rec.UpdatedAt))
	deletedAt := Tp(parseSyncTimePtr(rec.DeletedAt))
	birthDate := parseSyncTimePtr(rec.BirthDate)
	deathDate := parseSyncTimePtr(rec.DeathDate)
	chipDate := parseSyncTimePtr(rec.ChipDate)
	tanbaAt := parseSyncTimePtr(rec.TanbaAt)
	sterilizedAt := parseSyncTimePtr(rec.SterilizedAt)
	sterilized := rec.Sterilized
	if sterilizedAt != nil {
		sterilized = 1
	}
	_, err = db.ExecContext(ctx, `
		INSERT INTO pets (id, owner_id, name, type, gender, birth_date, age, breed, color, chip_number, chip_date,
		                  id_method, tanba_number, tanba_at, keep_address, sterilized, sterilized_at,
		                  photo, weight,
		                  status, death_date, death_reason, notes, allergies,
		                  updated_at, deleted_at, is_deleted, device_id, version, created_at, client_updated_at)
		VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
		ON CONFLICT(id) DO UPDATE SET
		  owner_id=excluded.owner_id, name=excluded.name, type=excluded.type,
		  gender=excluded.gender, birth_date=excluded.birth_date, age=excluded.age,
		  breed=excluded.breed, color=excluded.color, chip_number=excluded.chip_number,
		  -- Пустая дата чипирования от старого клиента не затирает известную.
		  chip_date=COALESCE(excluded.chip_date, pets.chip_date),
		  id_method=excluded.id_method,
		  -- Номер и дата ТАҢБА приходят с той же оговоркой, что и chip_date:
		  -- клиент старой версии их вообще не шлёт, и пустое поле не должно
		  -- стирать номер, который в реестре уже есть.
		  tanba_number=COALESCE(excluded.tanba_number, pets.tanba_number),
		  tanba_at=COALESCE(excluded.tanba_at, pets.tanba_at),
		  keep_address=excluded.keep_address,
		  -- Аллергии от старого клиента не приходят вовсе; пустое значение не
		  -- должно стирать предупреждение о непереносимости. Та же оговорка,
		  -- что у номера ТАҢБА, и по той же причине — цена ошибки высокая.
		  allergies=COALESCE(excluded.allergies, pets.allergies),
		  sterilized=excluded.sterilized,
		  sterilized_at=COALESCE(excluded.sterilized_at, pets.sterilized_at),
		  photo=excluded.photo, weight=excluded.weight,
		  status=excluded.status, death_date=excluded.death_date,
		  death_reason=excluded.death_reason, notes=excluded.notes,
		  updated_at=excluded.updated_at, deleted_at=excluded.deleted_at,
		  is_deleted=excluded.is_deleted, device_id=excluded.device_id,
		  version=excluded.version,
		  client_updated_at=excluded.client_updated_at`,
		rec.ID, rec.OwnerID, rec.Name, rec.Type, rec.Gender,
		birthDate, rec.Age, nullableString(rec.Breed),
		// ВНИМАНИЕ: photo — колонка NOT NULL DEFAULT ''. nullableString('')
		// возвращает NULL, и INSERT падал на constraint: любой питомец БЕЗ
		// ФОТО молча не доезжал с планшета (push отвечал 200, запись уходила
		// в skipped, ошибка оставалась только в логе сервера). Пустую строку
		// передаём как есть. Остальные поля ниже действительно nullable.
		nullableString(rec.Color), nullableString(rec.ChipNumber), Tp(chipDate),
		nullableString(normalizeIDMethod(rec.IDMethod, rec.ChipNumber)),
		nullableString(rec.TanbaNumber), Tp(tanbaAt), nullableString(rec.KeepAddress),
		clampFlag(sterilized), Tp(sterilizedAt),
		rec.Photo, rec.Weight, status,
		Tp(deathDate), nullableString(rec.DeathReason), nullableString(rec.Notes),
		nullableString(rec.Allergies),
		serverNow, deletedAt, rec.IsDeleted,
		nullableString(rec.DeviceID), rec.Version, serverNow, clientAt,
	)
	return err == nil, err
}

func pushItem(ctx context.Context, db *sql.DB, rec itemSyncRecord) (bool, error) {
	if rec.ID == "" {
		return false, fmt.Errorf("empty id")
	}
	wins, err := clientWinsVersion(ctx, db, "items", rec.ID, rec.UpdatedAt, rec.Version)
	if err != nil || !wins {
		return false, err
	}
	serverNow := T(nowUTC())
	// Время клиента сохраняем как есть — по нему разрешаются будущие конфликты.
	clientAt := Tp(parseSyncTimePtr(&rec.UpdatedAt))
	deletedAt := Tp(parseSyncTimePtr(rec.DeletedAt))
	// Пересчитываем на сервере: клиент мог прислать percent с устаревшей суммой.
	mode, percent, cost := resolveCost(rec.CostMode, rec.CostPercent, rec.Price, rec.CostPrice)
	_, err = db.ExecContext(ctx, `
		-- 18 колонок и 18 плейсхолдеров. Раньше их было 16: при добавлении
		-- result_mode и protocol_id колонки дописали, а знаки вопроса — нет,
		-- и push позиции каталога падал целиком. Настройка «требует
		-- результата» до сервера не доезжала никогда.
		INSERT INTO items (id, name, type, price, cost_price, cost_mode, cost_percent, purchase_price, result_mode, protocol_id, is_active, updated_at, deleted_at, is_deleted, device_id, version, created_at, client_updated_at)
		VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
		ON CONFLICT(id) DO UPDATE SET
		  name=excluded.name, type=excluded.type, price=excluded.price,
		  cost_price=excluded.cost_price, cost_mode=excluded.cost_mode,
		  cost_percent=excluded.cost_percent, purchase_price=excluded.purchase_price,
		  result_mode=excluded.result_mode, protocol_id=excluded.protocol_id,
		  is_active=excluded.is_active,
		  updated_at=excluded.updated_at, deleted_at=excluded.deleted_at,
		  is_deleted=excluded.is_deleted, device_id=excluded.device_id,
		  version=excluded.version,
		  client_updated_at=excluded.client_updated_at`,
		rec.ID, rec.Name, normalizeItemType(rec.Type), rec.Price, cost, mode, percent, rec.PurchasePrice,
		normalizeResultMode(rec.ResultMode), nullableString(rec.ProtocolID), boolToInt(rec.IsActive),
		serverNow, deletedAt, rec.IsDeleted,
		nullableString(rec.DeviceID), rec.Version, serverNow, clientAt,
	)
	return err == nil, err
}

// ─── VET-017: конкурентная правка приёма ─────────────────────────────────────
//
// Два планшета правят один приём офлайн от одной версии. Раньше второй push
// либо молча затирал первый целиком, либо молча отклонялся — правка одного
// врача пропадала без следа. Теперь такой push опознаётся по base_version
// (версия, от которой планшет начал правку, отстала от серверной), побеждает
// более поздняя по времени правка, а проигравшая версия целиком сохраняется
// в visits.conflict_json. Оба планшета получают приём с отметкой конфликта,
// врач сравнивает версии и отмечает разобранным (планшет шлёт conflict_json "").

// conflictEntry — проигравшая версия приёма: то, что иначе пропало бы.
type conflictEntry struct {
	DetectedAt       string   `json:"detected_at"`       // когда сервер заметил
	ClientUpdatedAt  string   `json:"client_updated_at"` // когда правили на планшете
	DeviceID         string   `json:"device_id,omitempty"`
	StaffID          string   `json:"staff_id,omitempty"`
	VisitType        string   `json:"visit_type,omitempty"`
	PatientCondition string   `json:"patient_condition,omitempty"`
	Anamnesis        string   `json:"anamnesis,omitempty"`
	Diagnosis        string   `json:"diagnosis,omitempty"`
	Treatment        string   `json:"treatment,omitempty"`
	Notes            string   `json:"notes,omitempty"`
	Vitals           string   `json:"vitals,omitempty"`
	AnimalWeight     *float64 `json:"animal_weight,omitempty"`
	Temperature      *float64 `json:"temperature,omitempty"`
	NextVisitDate    *string  `json:"next_visit_date,omitempty"`
	TreatmentDays    *int     `json:"treatment_days,omitempty"`
	TotalAmount      float64  `json:"total_amount"`
	Discount         float64  `json:"discount"`
	DiscountReason   string   `json:"discount_reason,omitempty"`
	PaymentCard      float64  `json:"payment_card"`
	Status           string   `json:"status,omitempty"`
	IsDeleted        int      `json:"is_deleted,omitempty"`
	// B-008: проигравшая версия СТРОКИ СЧЁТА этого приёма (правили её два
	// планшета офлайн). Поля приёма выше тогда пустые.
	Item *itemConflict `json:"item,omitempty"`
}

// itemConflict — строка счёта в проигравшей версии.
type itemConflict struct {
	ID        string  `json:"id"`
	Name      string  `json:"name"`
	Quantity  float64 `json:"quantity"`
	Price     float64 `json:"price"`
	Total     float64 `json:"total"`
	IsDeleted int     `json:"is_deleted,omitempty"`
}

func conflictFromRecord(rec visitSyncRecord, detected string) conflictEntry {
	return conflictEntry{
		DetectedAt: detected, ClientUpdatedAt: rec.UpdatedAt, DeviceID: rec.DeviceID,
		StaffID: rec.StaffID, VisitType: rec.VisitType, PatientCondition: rec.PatientCondition,
		Anamnesis: rec.Anamnesis, Diagnosis: rec.Diagnosis, Treatment: rec.Treatment, Notes: rec.Notes,
		Vitals: rec.Vitals, AnimalWeight: rec.AnimalWeight, Temperature: rec.Temperature,
		NextVisitDate: rec.NextVisitDate, TreatmentDays: rec.TreatmentDays,
		TotalAmount: rec.TotalAmount, Discount: rec.Discount, DiscountReason: rec.DiscountReason,
		PaymentCard: rec.PaymentCard, Status: rec.Status, IsDeleted: rec.IsDeleted,
	}
}

func conflictFromVisit(v Visit, clientAt *time.Time, detected string) conflictEntry {
	e := conflictEntry{
		DetectedAt: detected, DeviceID: v.DeviceID, StaffID: v.StaffID, VisitType: v.VisitType,
		PatientCondition: v.PatientCondition, Anamnesis: v.Anamnesis, Diagnosis: v.Diagnosis,
		Treatment: v.Treatment, Notes: v.Notes, Vitals: v.Vitals,
		AnimalWeight: v.AnimalWeight, Temperature: v.Temperature, TotalAmount: v.TotalAmount,
		Discount: v.Discount, DiscountReason: v.DiscountReason, PaymentCard: v.PaymentCard,
		Status: v.Status, IsDeleted: v.IsDeleted,
	}
	if clientAt != nil {
		e.ClientUpdatedAt = clientAt.UTC().Format(time.RFC3339)
	}
	if v.NextVisitDate != nil {
		s := v.NextVisitDate.UTC().Format(time.RFC3339)
		e.NextVisitDate = &s
	}
	td := v.TreatmentDays
	e.TreatmentDays = &td
	return e
}

// appendConflict дописывает проигравшую версию к уже накопленным. Повтор того
// же push (ответ потерялся) второй записи не заводит.
func appendConflict(existing string, e conflictEntry) string {
	var list []conflictEntry
	if existing != "" {
		_ = json.Unmarshal([]byte(existing), &list) // испорченное — начинаем заново
	}
	// Ищем по всему списку: повтор push, проигравшего по нескольким строкам,
	// сверял бы строку только с последней записью и дописывал заново.
	for _, old := range list {
		if old.DeviceID == e.DeviceID && old.ClientUpdatedAt == e.ClientUpdatedAt && sameConflictItem(old.Item, e.Item) {
			return existing
		}
	}
	list = append(list, e)
	b, _ := json.Marshal(list)
	return string(b)
}

// sameConflictItem — одна и та же ли строка счёта (или обе записи — о приёме).
// Одно сохранение с планшета может проиграть по нескольким строкам сразу:
// у них одно устройство и время, и без id строки они склеились бы в одну.
func sameConflictItem(a, b *itemConflict) bool {
	if a == nil || b == nil {
		return a == nil && b == nil
	}
	return a.ID == b.ID
}

// resolvedConflictJSON — что станет с отметкой после правки без конфликта:
// nil — оставить; "" — врач разобрал ровно ту версию, что последней в списке.
func resolvedConflictJSON(existing, resolved string) *string {
	if resolved == "" || existing == "" {
		return nil
	}
	var list []conflictEntry
	if json.Unmarshal([]byte(existing), &list) != nil || len(list) == 0 {
		return nil
	}
	if list[len(list)-1].DetectedAt != resolved {
		return nil // пока врач смотрел, пришёл ещё один конфликт — не снимаем
	}
	empty := ""
	return &empty
}

func pushVisit(ctx context.Context, db *sql.DB, rec visitSyncRecord) (bool, error) {
	if rec.ID == "" {
		return false, fmt.Errorf("empty id")
	}

	// Конфликт: планшет правил от версии, которую сервер уже перерос.
	// Планшеты до 3.34.0 base_version не шлют — для них прежнее правило.
	if rec.BaseVersion != nil {
		cur, err := scanVisit(db.QueryRowContext(ctx, visitSelectAll+` WHERE v.id=?`, rec.ID))
		// Серверную версию оставил этот же планшет — это не конфликт, а его
		// собственная более поздняя правка или повтор push, ответ на который
		// потерялся. Сам с собой планшет разойтись не может.
		sameDevice := rec.DeviceID != "" && rec.DeviceID == cur.DeviceID
		if err == nil && !sameDevice && *rec.BaseVersion < cur.Version {
			var prevClient timeScanner
			_ = db.QueryRowContext(ctx, `SELECT client_updated_at FROM visits WHERE id=?`, rec.ID).Scan(&prevClient)
			detected := nowUTC().Format(time.RFC3339)
			// Выше обеих версий: иначе планшет-проигравший с большей
			// локальной версией не примет результат при pull.
			newVersion := cur.Version
			if rec.Version > newVersion {
				newVersion = rec.Version
			}
			newVersion++
			clientTime := parseSyncTime(rec.UpdatedAt)
			incomingWins := prevClient.t == nil || !clientTime.Before(*prevClient.t)
			// Правка сильнее одновременного удаления: удалённый приём никто не
			// откроет, и проигравшая правка пропала бы из виду. Приём остаётся,
			// удаление уходит в конфликт — врач увидит его и удалит сам.
			if rec.IsDeleted != 0 && cur.IsDeleted == 0 {
				incomingWins = false
			} else if rec.IsDeleted == 0 && cur.IsDeleted != 0 {
				incomingWins = true
				// B-011: но не под удалённым животным (каскад от удаления
				// владельца или животного) — живой приём без карточки животного
				// никто не откроет, а его сумма числилась бы у несуществующего
				// владельца. Приём остаётся удалённым, правка — в конфликте.
				var petDeleted int
				if db.QueryRowContext(ctx, `SELECT is_deleted FROM pets WHERE id=?`, cur.PetID).Scan(&petDeleted) == nil && petDeleted != 0 {
					incomingWins = false
				}
			}
			if incomingWins {
				// Входящая правка позже — она становится приёмом, серверная
				// версия уходит в конфликт.
				cj := appendConflict(cur.ConflictJSON, conflictFromVisit(cur, prevClient.t, detected))
				if cur.IsDeleted != 0 && rec.IsDeleted == 0 {
					// B-011: правка вернула удалённый приём — вернуть и позиции,
					// удалённые тем же каскадом (у них то же время удаления).
					// Иначе приём воскресал без счёта: сумма есть, строк нет.
					// device_id — вернувшего планшета: его же правки и удаления
					// этих строк (в этом или следующем push) — его собственные, а
					// не конфликт; иначе убранная им строка вернулась бы в счёт,
					// а каждая поправленная дала бы ложный блок сравнения.
					_, _ = db.ExecContext(ctx, `UPDATE visit_items
						SET is_deleted=0, deleted_at=NULL, updated_at=?, version=version+1, device_id=?
						WHERE visit_id=? AND is_deleted=1
						  AND deleted_at = (SELECT deleted_at FROM visits WHERE id=?)`,
						T(nowUTC()), nullableString(rec.DeviceID), rec.ID, rec.ID)
				}
				return applyVisit(ctx, db, rec, newVersion, &cj)
			}
			// B-016: в проигравшую версию — серверные деньги, если пишущий их не
			// видит: иначе в блоке сравнения стояла бы «Сумма 0 ₸».
			if h, hidden := hiddenVisitOf(ctx, db, userFromCtx(ctx), rec.ID); hidden {
				keepHiddenVisit(h, &rec.StaffID, &rec.TotalAmount, &rec.Discount, &rec.PaymentCard, &rec.DiscountReason)
			}
			// Входящая правка раньше — приём остаётся, она уходит в конфликт.
			// updated_at и version двигаем, чтобы отметку получили все планшеты.
			cj := appendConflict(cur.ConflictJSON, conflictFromRecord(rec, detected))
			if cj == cur.ConflictJSON {
				// Повтор уже записанного push: писать нечего. Версию не
				// двигаем — иначе каждый повтор перерисовывал бы приём на всех
				// планшетах без изменения данных (правило 5).
				return true, nil
			}
			_, err := db.ExecContext(ctx,
				`UPDATE visits SET conflict_json=?, version=?, updated_at=? WHERE id=?`,
				cj, newVersion, T(nowUTC()), rec.ID)
			return err == nil, err
		}
	}

	wins, err := clientWinsVersion(ctx, db, "visits", rec.ID, rec.UpdatedAt, rec.Version)
	if err != nil || !wins {
		return false, err
	}
	// Без конфликта отметку планшет может только снять — и только ту, что
	// врач разобрал (conflict_resolved = её detected_at).
	var cj *string
	if rec.ConflictResolved != "" {
		var existing string
		_ = db.QueryRowContext(ctx, `SELECT COALESCE(conflict_json,'') FROM visits WHERE id=?`, rec.ID).Scan(&existing)
		cj = resolvedConflictJSON(existing, rec.ConflictResolved)
	}
	// Версия на сервере не уменьшается. clientWinsVersion принимает и меньшую
	// версию с более поздним временем (планшет ещё не получил версию max+1
	// после конфликта) — записать её как есть значит откатить версию: другие
	// планшеты такую запись при pull отбросят, а их следующая правка пройдёт
	// мимо конфликта.
	version := rec.Version
	var curVersion int
	if db.QueryRowContext(ctx, `SELECT COALESCE(version,1) FROM visits WHERE id=?`, rec.ID).Scan(&curVersion) == nil && curVersion > version {
		version = curVersion + 1
	}
	return applyVisit(ctx, db, rec, version, cj)
}

// applyVisit записывает приём с планшета. version — какую версию хранить;
// conflictJSON: nil — не трогать накопленное, иначе записать как есть.
func applyVisit(ctx context.Context, db *sql.DB, rec visitSyncRecord, version int, conflictJSON *string) (bool, error) {
	var err error
	if h, hidden := hiddenVisitOf(ctx, db, userFromCtx(ctx), rec.ID); hidden { // B-016
		keepHiddenVisit(h, &rec.StaffID, &rec.TotalAmount, &rec.Discount, &rec.PaymentCard, &rec.DiscountReason)
	}
	visitDate, dateErr := parseFlexibleDate(rec.Date)
	if dateErr != nil {
		visitDate = nowUTC()
	}
	visitType := rec.VisitType
	if visitType == "" {
		visitType = "первичный"
	}
	serverNow  := T(nowUTC())
	// Время клиента сохраняем как есть — по нему разрешаются будущие конфликты.
	clientAt   := Tp(parseSyncTimePtr(&rec.UpdatedAt))
	deletedAt  := Tp(parseSyncTimePtr(rec.DeletedAt))
	nextVisitDate := Tp(parseSyncTimePtr(rec.NextVisitDate))
	// Дату окончания курса считаем на сервере, а не берём с планшета:
	// он мог посчитать её старой версией кода или не прислать вовсе.
	// Если поля нет (планшет со старой версией) — сохраняем курс, который уже
	// лежит на сервере, иначе синхронизация затирала бы назначенное лечение.
	days := rec.TreatmentDays
	if days == nil {
		var cur int
		if err := db.QueryRowContext(ctx, `SELECT COALESCE(treatment_days,0) FROM visits WHERE id=?`, rec.ID).Scan(&cur); err == nil {
			days = &cur
		}
	}
	treatDays, treatUntil := resolveTreatment(intOrZero(days), visitDate)
	_, err = db.ExecContext(ctx, `
		INSERT INTO visits (id, pet_id, staff_id, visit_type, animal_weight, temperature, vitals, date, next_visit_date,
		                    treatment_days, treatment_until,
		                    patient_condition, anamnesis, diagnosis, treatment, notes,
		                    total_amount, discount, discount_reason, payment_card, change_log, status, updated_at, deleted_at, is_deleted, device_id, version, created_at, client_updated_at,
		                    conflict_json)
		VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, COALESCE(?, ''))
		ON CONFLICT(id) DO UPDATE SET
		  pet_id=excluded.pet_id, staff_id=excluded.staff_id,
		  visit_type=excluded.visit_type, animal_weight=excluded.animal_weight,
		  temperature=excluded.temperature, vitals=excluded.vitals,
		  date=excluded.date, next_visit_date=excluded.next_visit_date,
		  treatment_days=excluded.treatment_days, treatment_until=excluded.treatment_until,
		  patient_condition=excluded.patient_condition, anamnesis=excluded.anamnesis,
		  diagnosis=excluded.diagnosis, treatment=excluded.treatment, notes=excluded.notes,
		  total_amount=excluded.total_amount, discount=excluded.discount, discount_reason=excluded.discount_reason, payment_card=excluded.payment_card,
		  change_log=excluded.change_log, status=excluded.status,
		  updated_at=excluded.updated_at, deleted_at=excluded.deleted_at, is_deleted=excluded.is_deleted,
		  device_id=excluded.device_id, version=excluded.version,
		  client_updated_at=excluded.client_updated_at,
		  conflict_json=CASE WHEN ? IS NULL THEN visits.conflict_json ELSE excluded.conflict_json END`,
		rec.ID, rec.PetID, nullableString(rec.StaffID), visitType, rec.AnimalWeight,
		rec.Temperature, nullableString(rec.Vitals), T(visitDate), nextVisitDate,
		treatDays, Tp(treatUntil),
		nullableString(rec.PatientCondition), nullableString(rec.Anamnesis),
		nullableString(rec.Diagnosis), nullableString(rec.Treatment), nullableString(rec.Notes),
		rec.TotalAmount, rec.Discount, nullableString(rec.DiscountReason), rec.PaymentCard, rec.ChangeLog,
		normalizeVisitStatus(rec.Status), serverNow, deletedAt, rec.IsDeleted,
		nullableString(rec.DeviceID), version, serverNow, clientAt,
		conflictJSON, conflictJSON,
	)
	return err == nil, err
}

func pushVisitItem(ctx context.Context, db *sql.DB, rec visitItemSyncRecord) (bool, error) {
	if rec.ID == "" {
		return false, fmt.Errorf("empty id")
	}
	// Скрытые суммы — ДО конфликта: иначе в проигравшую версию попала бы
	// замаскированная нулевая цена.
	_, hiddenParent := hiddenVisitOf(ctx, db, userFromCtx(ctx), rec.VisitID)
	if hiddenParent { // B-016
		rec.Price = hiddenItemPrice(ctx, db, rec)
		rec.Total = roundMoney(rec.Price * rec.Quantity)
	}

	// B-008: конкурентная правка одной строки счёта — как у приёма (VET-017).
	// Строку правили офлайн два планшета: побеждает более поздняя правка,
	// проигравшая версия строки дописывается в conflict_json ПРИЁМА — врач
	// увидит её в том же блоке сравнения. Версия приёма не растёт (иначе
	// правки приёма на других планшетах ложно стали бы конфликтом) — только
	// updated_at, чтобы отметку получили все.
	conflictHandled := false
	if rec.BaseVersion != nil {
		var curVer, curDel int
		var curDev, curName string
		var curQty, curPrice, curTotal float64
		var prevClient timeScanner
		err := db.QueryRowContext(ctx, `SELECT COALESCE(version,1), COALESCE(device_id,''), COALESCE(name,''),
			COALESCE(quantity,0), COALESCE(price,0), COALESCE(total,0), is_deleted, client_updated_at
			FROM visit_items WHERE id=?`, rec.ID).
			Scan(&curVer, &curDev, &curName, &curQty, &curPrice, &curTotal, &curDel, &prevClient)
		sameDevice := rec.DeviceID != "" && rec.DeviceID == curDev
		if err == nil && !sameDevice && *rec.BaseVersion < curVer {
			incomingWins := prevClient.t == nil || !parseSyncTime(rec.UpdatedAt).Before(*prevClient.t)
			if rec.IsDeleted != 0 && curDel == 0 { // правка сильнее удаления
				incomingWins = false
			} else if rec.IsDeleted == 0 && curDel != 0 {
				incomingWins = true
			}
			newVersion := curVer
			if rec.Version > newVersion {
				newVersion = rec.Version
			}
			newVersion++
			e := conflictEntry{DetectedAt: nowUTC().Format(time.RFC3339)}
			if incomingWins {
				e.DeviceID = curDev
				if prevClient.t != nil {
					e.ClientUpdatedAt = prevClient.t.UTC().Format(time.RFC3339)
				}
				e.Item = &itemConflict{ID: rec.ID, Name: curName, Quantity: curQty, Price: curPrice, Total: curTotal, IsDeleted: curDel}
			} else {
				e.DeviceID, e.ClientUpdatedAt = rec.DeviceID, rec.UpdatedAt
				e.Item = &itemConflict{ID: rec.ID, Name: rec.Name, Quantity: rec.Quantity, Price: rec.Price, Total: rec.Total, IsDeleted: rec.IsDeleted}
			}
			changed := appendVisitConflict(ctx, db, rec.VisitID, e)
			if !incomingWins {
				if !changed {
					return true, nil // повтор уже записанного — писать нечего
				}
				_, err := db.ExecContext(ctx, `UPDATE visit_items SET version=?, updated_at=? WHERE id=?`,
					newVersion, T(nowUTC()), rec.ID)
				return err == nil, err
			}
			rec.Version = newVersion
			conflictHandled = true
		}
	}
	if !conflictHandled {
		wins, err := clientWinsVersion(ctx, db, "visit_items", rec.ID, rec.UpdatedAt, rec.Version)
		if err != nil || !wins {
			return false, err
		}
	}
	var err error
	serverNow := T(nowUTC())
	// Время клиента сохраняем как есть — по нему разрешаются будущие конфликты.
	clientAt := Tp(parseSyncTimePtr(&rec.UpdatedAt))
	deletedAt := Tp(parseSyncTimePtr(rec.DeletedAt))
	_, err = db.ExecContext(ctx, `
		INSERT INTO visit_items (id, visit_id, item_id, name, type, quantity, price, total,
		                         updated_at, deleted_at, is_deleted, device_id, version, created_at, client_updated_at)
		VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
		ON CONFLICT(id) DO UPDATE SET
		  visit_id=excluded.visit_id, item_id=excluded.item_id, name=excluded.name,
		  type=excluded.type, quantity=excluded.quantity, price=excluded.price,
		  total=excluded.total, updated_at=excluded.updated_at,
		  deleted_at=excluded.deleted_at, is_deleted=excluded.is_deleted,
		  device_id=excluded.device_id, version=excluded.version,
		  client_updated_at=excluded.client_updated_at`,
		rec.ID, rec.VisitID, rec.ItemID, nullableString(rec.Name),
		normalizeItemType(rec.Type), rec.Quantity, rec.Price, rec.Total,
		serverNow, deletedAt, rec.IsDeleted,
		nullableString(rec.DeviceID), rec.Version, serverNow, clientAt,
	)
	if err == nil && hiddenParent {
		recomputeHiddenTotal(ctx, db, rec.VisitID) // B-016: итог — по позициям
	}
	return err == nil, err
}

func pushVaccination(ctx context.Context, db *sql.DB, rec vaccinationSyncRecord) (bool, error) {
	if rec.ID == "" {
		return false, fmt.Errorf("empty id")
	}
	wins, err := clientWinsVersion(ctx, db, "vaccinations", rec.ID, rec.UpdatedAt, rec.Version)
	if err != nil || !wins {
		return false, err
	}
	adminAt, adminErr := parseFlexibleDate(rec.AdministeredAt)
	if adminErr != nil {
		adminAt = nowUTC()
	}
	serverNow := T(nowUTC())
	// Время клиента сохраняем как есть — по нему разрешаются будущие конфликты.
	clientAt := Tp(parseSyncTimePtr(&rec.UpdatedAt))
	deletedAt := Tp(parseSyncTimePtr(rec.DeletedAt))
	nextDue := parseSyncTimePtr(rec.NextDueAt)
	_, err = db.ExecContext(ctx, `
		INSERT INTO vaccinations (id, pet_id, visit_id, staff_id, vaccine_name, batch_number, manufacturer,
		                          dose, administered_at, next_due_at, notes,
		                          updated_at, deleted_at, is_deleted, device_id, version, created_at, client_updated_at)
		VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
		ON CONFLICT(id) DO UPDATE SET
		  pet_id=excluded.pet_id, visit_id=excluded.visit_id,
		  staff_id=excluded.staff_id, vaccine_name=excluded.vaccine_name,
		  batch_number=excluded.batch_number, manufacturer=excluded.manufacturer,
		  dose=excluded.dose, administered_at=excluded.administered_at, next_due_at=excluded.next_due_at,
		  notes=excluded.notes, updated_at=excluded.updated_at,
		  deleted_at=excluded.deleted_at, is_deleted=excluded.is_deleted,
		  device_id=excluded.device_id, version=excluded.version,
		  client_updated_at=excluded.client_updated_at`,
		rec.ID, rec.PetID, nullableString(rec.VisitID), nullableString(rec.StaffID), rec.VaccineName,
		nullableString(rec.BatchNumber), nullableString(rec.Manufacturer),
		rec.Dose, T(adminAt), Tp(nextDue), nullableString(rec.Notes),
		serverNow, deletedAt, rec.IsDeleted,
		nullableString(rec.DeviceID), rec.Version, serverNow, clientAt,
	)
	return err == nil, err
}

func pushStaff(ctx context.Context, db *sql.DB, rec staffSyncRecord) (bool, error) {
	if rec.ID == "" {
		return false, fmt.Errorf("empty id")
	}
	wins, err := clientWinsVersion(ctx, db, "clinic_staff", rec.ID, rec.UpdatedAt, rec.Version)
	if err != nil || !wins {
		return false, err
	}
	serverNow := T(nowUTC())
	// Время клиента сохраняем как есть — по нему разрешаются будущие конфликты.
	clientAt := Tp(parseSyncTimePtr(&rec.UpdatedAt))
	deletedAt := Tp(parseSyncTimePtr(rec.DeletedAt))
	_, err = db.ExecContext(ctx, `
		INSERT INTO clinic_staff (id, name, role, phone, email, is_active, notes, photo,
		                          updated_at, deleted_at, is_deleted, device_id, version, created_at, client_updated_at)
		VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
		ON CONFLICT(id) DO UPDATE SET
		  name=excluded.name, role=excluded.role, phone=excluded.phone, email=excluded.email,
		  is_active=excluded.is_active, notes=excluded.notes,
		  -- Пустое фото от планшета со старой версией не стирает серверное:
		  -- старый клиент про колонку не знает и прислал бы "".
		  photo=COALESCE(NULLIF(excluded.photo,''), clinic_staff.photo),
		  updated_at=excluded.updated_at,
		  deleted_at=excluded.deleted_at, is_deleted=excluded.is_deleted,
		  device_id=excluded.device_id, version=excluded.version,
		  client_updated_at=excluded.client_updated_at`,
		rec.ID, rec.Name, rec.Role, nullableString(rec.Phone), nullableString(rec.Email),
		boolToInt(rec.IsActive), nullableString(rec.Notes),
		nullableString(rec.Photo),
		serverNow, deletedAt, rec.IsDeleted,
		nullableString(rec.DeviceID), rec.Version, serverNow, clientAt,
	)
	return err == nil, err
}

// ─── Pull helpers ─────────────────────────────────────────────────────────────

func pullOwners(ctx context.Context, db *sql.DB, since time.Time) ([]Owner, error) {
	q := `SELECT id, fio, COALESCE(owner_type,'individual'), COALESCE(iin,''), phone, COALESCE(address,''), COALESCE(notes,''),
	             created_at, updated_at, deleted_at, is_deleted, COALESCE(device_id,''), COALESCE(version,1)
	      FROM owners`
	if !since.IsZero() {
		q += ` WHERE updated_at >= ?`
		rows, err := db.QueryContext(ctx, q, S(since))
		if err != nil {
			return nil, err
		}
		defer rows.Close()
		return scanOwners(rows)
	}
	rows, err := db.QueryContext(ctx, q)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	return scanOwners(rows)
}

func scanOwners(rows *sql.Rows) ([]Owner, error) {
	var list []Owner
	for rows.Next() {
		o, err := scanOwner(rows)
		if err != nil {
			return nil, err
		}
		list = append(list, o)
	}
	if list == nil {
		list = []Owner{}
	}
	return list, rows.Err()
}

func pullPets(ctx context.Context, db *sql.DB, since time.Time) ([]Pet, error) {
	filter := ""
	var args []interface{}
	if !since.IsZero() {
		filter = ` WHERE updated_at >= ?`
		args = []interface{}{S(since)}
	}

	// Legacy-fallback здесь убран сознательно: он выбирал меньше колонок,
	// чем ждёт scanPetRow, и каждая запись молча падала на Scan — планшет
	// получал пустой список животных вместо ошибки. Колонки добавляет
	// runMigrations при старте; расхождение схемы должно быть видно.
	rows, err := db.QueryContext(ctx, petSelectAll+filter, args...)
	if err != nil {
		return nil, err
	}
	defer rows.Close()

	var list []Pet
	for rows.Next() {
		p, err := scanPetRow(rows)
		if err != nil {
			continue // пропускаем битую запись
		}
		list = append(list, p)
	}
	if list == nil {
		list = []Pet{}
	}
	return list, rows.Err()
}

// ВНИМАНИЕ: порядок и число колонок должны точно совпадать со scanPetRow.
// chip_date стоит между chip_number и photo — как в сканере. Рассинхрон здесь
// уронил pull: Scan падал на каждой строке, животные не доезжали ни на одно
// устройство, а ошибка глоталась в continue.
const petSelectAll = `
SELECT id, owner_id, name, type, gender, birth_date, age, COALESCE(breed,''),
       COALESCE(color,''), COALESCE(chip_number,''), chip_date,
       COALESCE(id_method,''), COALESCE(tanba_number,''), tanba_at, COALESCE(keep_address,''),
       COALESCE(sterilized,0), sterilized_at,
       COALESCE(photo,''), weight, COALESCE(status,'active'),
       death_date, COALESCE(death_reason,''), COALESCE(notes,''), COALESCE(allergies,''),
       created_at, updated_at, deleted_at, is_deleted, COALESCE(device_id,''), COALESCE(version,1)
FROM pets`

func pullItems(ctx context.Context, db *sql.DB, since time.Time) ([]Item, error) {
	q := `SELECT id, name, type, price, COALESCE(cost_price,0), COALESCE(cost_mode,'fixed'), COALESCE(cost_percent,0), COALESCE(purchase_price,0), COALESCE(result_mode,'none'), COALESCE(protocol_id,''), is_active, created_at, updated_at, deleted_at, is_deleted, COALESCE(device_id,''), COALESCE(version,1) FROM items`
	var rows *sql.Rows
	var err error
	if !since.IsZero() {
		rows, err = db.QueryContext(ctx, q+` WHERE updated_at >= ?`, S(since))
	} else {
		rows, err = db.QueryContext(ctx, q)
	}
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	var list []Item
	for rows.Next() {
		item, err := scanItem(rows)
		if err != nil {
			return nil, err
		}
		list = append(list, item)
	}
	if list == nil {
		list = []Item{}
	}
	return list, rows.Err()
}

func pullVisits(ctx context.Context, db *sql.DB, since time.Time) ([]Visit, error) {
	filter := ""
	var args []interface{}
	if !since.IsZero() {
		filter = ` WHERE v.updated_at >= ?`
		args = []interface{}{S(since)}
	}

	// Раньше здесь был fallback на visitSelectAllLegacy для БД без новых колонок.
	// Он был опаснее проблемы, которую решал: legacy-запрос отдаёт меньше колонок,
	// а разбирается тем же scanVisit — каждая запись падала на Scan и молча
	// пропускалась через continue ниже. Планшет получал пустой список визитов
	// вместо ошибки. Колонки добавляет runMigrations при старте, так что
	// расхождение схемы означает поломку, о которой надо узнать, а не прятать.
	rows, err := db.QueryContext(ctx, visitSelectAll+filter, args...)
	if err != nil {
		return nil, err
	}
	defer rows.Close()

	var list []Visit
	for rows.Next() {
		v, err := scanVisit(rows)
		if err != nil {
			continue // пропускаем битую запись, не ломаем весь pull
		}
		list = append(list, v)
	}
	if list == nil {
		list = []Visit{}
	}
	return list, rows.Err()
}

func pullVisitItems(ctx context.Context, db *sql.DB, since time.Time) ([]VisitItem, error) {
	q := visitItemSelectAll
	var rows *sql.Rows
	var err error
	if !since.IsZero() {
		rows, err = db.QueryContext(ctx, q+` WHERE vi.updated_at >= ?`, S(since))
	} else {
		rows, err = db.QueryContext(ctx, q)
	}
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	var list []VisitItem
	for rows.Next() {
		vi, err := scanVisitItem(rows)
		if err != nil {
			return nil, err
		}
		list = append(list, vi)
	}
	if list == nil {
		list = []VisitItem{}
	}
	return list, rows.Err()
}

func pullVaccinations(ctx context.Context, db *sql.DB, since time.Time) ([]Vaccination, error) {
	q := vaccinationSelectAll
	var rows *sql.Rows
	var err error
	if !since.IsZero() {
		rows, err = db.QueryContext(ctx, q+` WHERE updated_at >= ?`, S(since))
	} else {
		rows, err = db.QueryContext(ctx, q)
	}
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	var list []Vaccination
	for rows.Next() {
		v, err := scanVaccination(rows)
		if err != nil {
			return nil, err
		}
		list = append(list, v)
	}
	if list == nil {
		list = []Vaccination{}
	}
	return list, rows.Err()
}

func pullStaff(ctx context.Context, db *sql.DB, since time.Time) ([]Staff, error) {
	q := staffSelectAll
	var rows *sql.Rows
	var err error
	if !since.IsZero() {
		rows, err = db.QueryContext(ctx, q+` WHERE updated_at >= ?`, S(since))
	} else {
		rows, err = db.QueryContext(ctx, q)
	}
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	var list []Staff
	for rows.Next() {
		s, err := scanStaff(rows)
		if err != nil {
			return nil, err
		}
		list = append(list, s)
	}
	if list == nil {
		list = []Staff{}
	}
	return list, rows.Err()
}

// ─── Devices ──────────────────────────────────────────────────────────────────

func (a *app) upsertDevice(ctx context.Context, id string) {
	_, _ = a.db.ExecContext(ctx, `
		INSERT INTO devices (id, last_seen_at) VALUES (?, ?)
		ON CONFLICT(id) DO UPDATE SET last_seen_at=excluded.last_seen_at`,
		id, T(nowUTC()),
	)
}

// pullAttachments отдаёт метаданные вложений. Push для них не нужен:
// вложение создаётся только загрузкой файла через POST /attachments,
// а она требует сети по определению.
func pullAttachments(ctx context.Context, db *sql.DB, since time.Time) ([]Attachment, error) {
	q := attachmentSelectAll
	var rows *sql.Rows
	var err error
	if !since.IsZero() {
		rows, err = db.QueryContext(ctx, q+` WHERE updated_at >= ?`, S(since))
	} else {
		rows, err = db.QueryContext(ctx, q)
	}
	if err != nil {
		return nil, err
	}
	defer rows.Close()

	list := make([]Attachment, 0)
	for rows.Next() {
		at, err := scanAttachment(rows)
		if err != nil {
			continue
		}
		list = append(list, at)
	}
	return list, rows.Err()
}

// ─── Склад: push/pull ─────────────────────────────────────────────────────────

func pushWarehouse(ctx context.Context, db *sql.DB, rec warehouseSyncRecord) (bool, error) {
	if rec.ID == "" {
		return false, fmt.Errorf("empty id")
	}
	wins, err := clientWinsVersion(ctx, db, "warehouses", rec.ID, rec.UpdatedAt, rec.Version)
	if err != nil || !wins {
		return false, err
	}
	serverNow := T(nowUTC())
	clientAt := Tp(parseSyncTimePtr(&rec.UpdatedAt))
	deletedAt := Tp(parseSyncTimePtr(rec.DeletedAt))
	_, err = db.ExecContext(ctx, `
		INSERT INTO warehouses (id, name, is_default, updated_at, deleted_at, is_deleted, device_id, version, created_at, client_updated_at)
		VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
		ON CONFLICT(id) DO UPDATE SET
		  name=excluded.name, is_default=excluded.is_default,
		  updated_at=excluded.updated_at, deleted_at=excluded.deleted_at, is_deleted=excluded.is_deleted,
		  device_id=excluded.device_id, version=excluded.version, client_updated_at=excluded.client_updated_at`,
		rec.ID, rec.Name, rec.IsDefault, serverNow, deletedAt, rec.IsDeleted,
		nullableString(rec.DeviceID), rec.Version, serverNow, clientAt,
	)
	return err == nil, err
}

func pushStockMovement(ctx context.Context, db *sql.DB, rec stockMovementSyncRecord) (bool, error) {
	if rec.ID == "" {
		return false, fmt.Errorf("empty id")
	}
	wins, err := clientWinsVersion(ctx, db, "stock_movements", rec.ID, rec.UpdatedAt, rec.Version)
	if err != nil || !wins {
		return false, err
	}
	serverNow := T(nowUTC())
	clientAt := Tp(parseSyncTimePtr(&rec.UpdatedAt))
	deletedAt := Tp(parseSyncTimePtr(rec.DeletedAt))
	occurredAt := Tp(parseSyncTimePtr(&rec.OccurredAt))
	_, err = db.ExecContext(ctx, `
		INSERT INTO stock_movements (id, warehouse_id, item_id, kind, qty, purchase_price, retail_price,
		                             reason, note, occurred_at, batch, expires_at, updated_at, deleted_at, is_deleted,
		                             device_id, version, created_at, client_updated_at)
		VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
		ON CONFLICT(id) DO UPDATE SET
		  warehouse_id=excluded.warehouse_id, item_id=excluded.item_id, kind=excluded.kind,
		  qty=excluded.qty, purchase_price=excluded.purchase_price, retail_price=excluded.retail_price,
		  reason=excluded.reason, note=excluded.note, occurred_at=excluded.occurred_at,
		  batch=excluded.batch, expires_at=excluded.expires_at,
		  updated_at=excluded.updated_at, deleted_at=excluded.deleted_at, is_deleted=excluded.is_deleted,
		  device_id=excluded.device_id, version=excluded.version, client_updated_at=excluded.client_updated_at`,
		rec.ID, rec.WarehouseID, rec.ItemID, rec.Kind, rec.Qty, rec.PurchasePrice, rec.RetailPrice,
		nullableString(rec.Reason), nullableString(rec.Note), occurredAt,
		nullableString(rec.Batch), Tp(parseSyncTimePtr(rec.ExpiresAt)),
		serverNow, deletedAt, rec.IsDeleted, nullableString(rec.DeviceID), rec.Version, serverNow, clientAt,
	)
	return err == nil, err
}

func pullWarehouses(ctx context.Context, db *sql.DB, since time.Time) ([]Warehouse, error) {
	q := `SELECT id, name, COALESCE(is_default,0), created_at, updated_at, deleted_at, is_deleted,
	             COALESCE(device_id,''), COALESCE(version,1) FROM warehouses`
	var rows *sql.Rows
	var err error
	if !since.IsZero() {
		q += ` WHERE updated_at >= ?`
		rows, err = db.QueryContext(ctx, q, S(since))
	} else {
		rows, err = db.QueryContext(ctx, q)
	}
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	list := []Warehouse{}
	for rows.Next() {
		var w Warehouse
		var created, updated timeScanner
		var deleted timeScanner
		if err := rows.Scan(&w.ID, &w.Name, &w.IsDefault, &created, &updated, &deleted,
			&w.IsDeleted, &w.DeviceID, &w.Version); err != nil {
			return nil, err
		}
		if created.t != nil {
			w.CreatedAt = *created.t
		}
		if updated.t != nil {
			w.UpdatedAt = *updated.t
		}
		w.DeletedAt = deleted.t
		list = append(list, w)
	}
	return list, rows.Err()
}

func pullStockMovements(ctx context.Context, db *sql.DB, since time.Time) ([]StockMovement, error) {
	q := `SELECT id, warehouse_id, item_id, COALESCE(kind,'receipt'), COALESCE(qty,0),
	             COALESCE(purchase_price,0), COALESCE(retail_price,0), COALESCE(reason,''), COALESCE(note,''),
	             occurred_at, COALESCE(batch,''), expires_at, created_at, updated_at, deleted_at, is_deleted,
	             COALESCE(device_id,''), COALESCE(version,1) FROM stock_movements`
	var rows *sql.Rows
	var err error
	if !since.IsZero() {
		q += ` WHERE updated_at >= ?`
		rows, err = db.QueryContext(ctx, q, S(since))
	} else {
		rows, err = db.QueryContext(ctx, q)
	}
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	list := []StockMovement{}
	for rows.Next() {
		var m StockMovement
		var occurred, expires, created, updated, deleted timeScanner
		if err := rows.Scan(&m.ID, &m.WarehouseID, &m.ItemID, &m.Kind, &m.Qty,
			&m.PurchasePrice, &m.RetailPrice, &m.Reason, &m.Note,
			&occurred, &m.Batch, &expires, &created, &updated, &deleted, &m.IsDeleted, &m.DeviceID, &m.Version); err != nil {
			return nil, err
		}
		if occurred.t != nil {
			s := occurred.t.Format(time.RFC3339)
			m.OccurredAt = &s
		}
		if expires.t != nil {
			e := expires.t.Format(time.RFC3339)
			m.ExpiresAt = &e
		}
		if created.t != nil {
			m.CreatedAt = *created.t
		}
		if updated.t != nil {
			m.UpdatedAt = *updated.t
		}
		m.DeletedAt = deleted.t
		list = append(list, m)
	}
	return list, rows.Err()
}

// ─── B-016: суммы, которых пишущий не видит, не перезаписываются ─────────────
//
// Пользователь с правом sums own/selected получает чужие приёмы с суммами,
// замаскированными нулями (pull, REST — B-010). Сохранив в таком приёме хоть
// диагноз, планшет шлёт эти нули назад — и сервер записывал их как настоящие:
// выручка чужого врача обнулялась для всех, включая руководителя. Поэтому
// для приёма, суммы которого пишущий не видит («скрытого»):
//   - деньги приёма берутся из серверной записи;
//   - врач приёма не меняется (иначе, назначив себя, пишущий забрал бы чужую
//     выручку в свой отчёт и увидел её) — кроме приёма без врача: взять его
//     на себя можно;
//   - цена существующей строки — серверная, если услуга та же; новая строка
//     с нулевой ценой получает цену из каталога;
//   - итог приёма пересчитывается по живым позициям минус скидка — иначе
//     после правки количества приём и позиции разошлись бы.
// Новая запись — его собственная, её суммы принимаются.

type hiddenVisit struct {
	staff                 string
	total, discount, card float64
	reason                string
}

// hiddenVisitOf — серверная запись приёма, если пишущий не видит его сумм.
func hiddenVisitOf(ctx context.Context, db *sql.DB, u *User, visitID string) (hiddenVisit, bool) {
	var h hiddenVisit
	if u == nil || u.seesAllSums() {
		return h, false
	}
	if db.QueryRowContext(ctx, `SELECT COALESCE(staff_id,''), COALESCE(total_amount,0), COALESCE(discount,0),
		COALESCE(discount_reason,''), COALESCE(payment_card,0) FROM visits WHERE id=?`, visitID).
		Scan(&h.staff, &h.total, &h.discount, &h.reason, &h.card) != nil {
		return h, false // приёма нет — новый, суммы пишущего
	}
	return h, !u.canSeeSum(h.staff)
}

// keepHiddenVisit подставляет серверные деньги и врача в запись приёма.
func keepHiddenVisit(h hiddenVisit, staffID *string, total, discount, card *float64, reason *string) {
	*total, *discount, *card, *reason = h.total, h.discount, h.card, h.reason
	if h.staff != "" {
		*staffID = h.staff
	}
}

// hiddenItemPrice — какую цену записать строке скрытого приёма.
func hiddenItemPrice(ctx context.Context, db *sql.DB, rec visitItemSyncRecord) float64 {
	var srvPrice float64
	var srvItem sql.NullString
	err := db.QueryRowContext(ctx, `SELECT COALESCE(price,0), item_id FROM visit_items WHERE id=?`, rec.ID).
		Scan(&srvPrice, &srvItem)
	sameItem := err == nil && (rec.ItemID == nil && !srvItem.Valid ||
		rec.ItemID != nil && srvItem.Valid && *rec.ItemID == srvItem.String)
	if sameItem {
		return srvPrice // та же услуга — цену пишущий видел нулём
	}
	if rec.Price == 0 && rec.ItemID != nil {
		var catalog float64
		if db.QueryRowContext(ctx, `SELECT COALESCE(price,0) FROM items WHERE id=?`, *rec.ItemID).Scan(&catalog) == nil {
			return catalog // строку завели заново с замаскированной ценой
		}
	}
	return rec.Price // другая услуга — цена из каталога, не замаскирована
}

// recomputeHiddenTotal — итог скрытого приёма по живым позициям.
func recomputeHiddenTotal(ctx context.Context, db *sql.DB, visitID string) {
	_, _ = db.ExecContext(ctx, `UPDATE visits SET
		total_amount = MAX(0, (SELECT COALESCE(SUM(total),0) FROM visit_items WHERE visit_id=? AND is_deleted=0)
		                      - COALESCE(discount,0)),
		updated_at = ?
		WHERE id=?`, visitID, T(nowUTC()), visitID)
}

// appendVisitConflict дописывает проигравшую версию в conflict_json приёма и
// сдвигает его updated_at (не версию), чтобы отметку получили все планшеты.
// false — такая запись уже есть (повтор push), ничего не записано.
func appendVisitConflict(ctx context.Context, db *sql.DB, visitID string, e conflictEntry) bool {
	var cur string
	if db.QueryRowContext(ctx, `SELECT COALESCE(conflict_json,'') FROM visits WHERE id=?`, visitID).Scan(&cur) != nil {
		return false
	}
	next := appendConflict(cur, e)
	if next == cur {
		return false
	}
	_, _ = db.ExecContext(ctx, `UPDATE visits SET conflict_json=?, updated_at=? WHERE id=?`, next, T(nowUTC()), visitID)
	return true
}
