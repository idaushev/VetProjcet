package main

import "time"

// ─── Sync metadata (встраивается во все сущности) ────────────────────────────

type SyncMeta struct {
	CreatedAt time.Time  `json:"created_at"`
	UpdatedAt time.Time  `json:"updated_at"`
	DeletedAt *time.Time `json:"deleted_at,omitempty"`
	IsDeleted int        `json:"is_deleted"`
	DeviceID  string     `json:"device_id,omitempty"`
	Version   int        `json:"version"`
}

// ─── Entities ─────────────────────────────────────────────────────────────────

type Item struct {
	ID        string  `json:"id"`
	Name      string  `json:"name"`
	Type      string  `json:"type"`
	Price     float64 `json:"price"`
	CostPrice float64 `json:"cost_price"` // кассовая стоимость в тенге (при percent — вычисляется)
	// CostMode: fixed — кассовая задана суммой | percent — доля от цены.
	// При percent CostPrice пересчитывается автоматически при каждой смене цены.
	CostMode    string  `json:"cost_mode"`
	CostPercent float64 `json:"cost_percent"`
	IsActive    bool    `json:"is_active"`
	SyncMeta
}

type Owner struct {
	ID      string `json:"id"`
	FIO     string `json:"fio"`
	IIN     string `json:"iin,omitempty"`
	Phone   string `json:"phone"`
	Address string `json:"address,omitempty"`
	Notes   string `json:"notes,omitempty"`
	SyncMeta
}

// Pet — животное. Никогда не удаляется физически.
// status: active | deceased | transferred | lost
type Pet struct {
	ID          string     `json:"id"`
	OwnerID     string     `json:"owner_id"`
	Name        string     `json:"name"`
	Type        string     `json:"type"`
	Gender      string     `json:"gender"`
	BirthDate   *time.Time `json:"birth_date,omitempty"`
	Age         *int       `json:"age,omitempty"`
	Breed       string     `json:"breed,omitempty"`
	Color       string     `json:"color,omitempty"`
	ChipNumber  string     `json:"chip_number,omitempty"`
	ChipDate    *time.Time `json:"chip_date,omitempty"` // дата чипирования
	Weight      *float64   `json:"weight,omitempty"`
	Status      string     `json:"status"` // active|deceased|transferred|lost
	DeathDate   *time.Time `json:"death_date,omitempty"`
	DeathReason string     `json:"death_reason,omitempty"`
	Notes       string     `json:"notes,omitempty"`
	Photo       string     `json:"photo,omitempty"` // base64 data URL
	SyncMeta
}

type Visit struct {
	ID               string     `json:"id"`
	PetID            string     `json:"pet_id"`
	StaffID          string     `json:"staff_id,omitempty"`
	VisitType        string     `json:"visit_type,omitempty"`
	AnimalWeight     *float64   `json:"animal_weight,omitempty"`
	Date             time.Time  `json:"date"`
	NextVisitDate    *time.Time `json:"next_visit_date,omitempty"`
	// Курс лечения: длительность в днях и вычисляемая дата окончания.
	// 0 означает, что курс на приёме не назначался.
	TreatmentDays    int        `json:"treatment_days"`
	TreatmentUntil   *time.Time `json:"treatment_until,omitempty"`
	PatientCondition string     `json:"patient_condition,omitempty"`
	Anamnesis        string     `json:"anamnesis,omitempty"`
	Diagnosis        string     `json:"diagnosis,omitempty"`
	Treatment        string     `json:"treatment,omitempty"`
	Notes            string     `json:"notes,omitempty"`
	TotalAmount      float64    `json:"total_amount"`
	PaymentCard      float64    `json:"payment_card"` // сумма оплаченная картой (безнал)
	ChangeLog        string     `json:"change_log,omitempty"` // JSON-массив истории изменений
	SyncMeta
}

type VisitItem struct {
	ID       string  `json:"id"`
	VisitID  string  `json:"visit_id"`
	ItemID   *string `json:"item_id,omitempty"`
	Name     string  `json:"name,omitempty"`
	Type     string  `json:"type"`
	Quantity float64 `json:"quantity"`
	Price    float64 `json:"price"`
	Total    float64 `json:"total"`
	SyncMeta
}

// Attachment — вложение к приёму: скан УЗИ, рентген, бланк анализов, фото.
// Сам файл лежит на диске сервера; здесь только метаданные.
// StoragePath наружу не отдаётся: клиенту достаточно URL /attachments/{id}/file,
// а раскрывать раскладку файлов на сервере незачем.
type Attachment struct {
	ID        string `json:"id"`
	VisitID   string `json:"visit_id"`
	PetID     string `json:"pet_id"`
	Kind      string `json:"kind"` // ultrasound|xray|lab|photo|other
	FileName  string `json:"file_name"`
	MimeType  string `json:"mime_type"`
	SizeBytes int64  `json:"size_bytes"`
	Notes     string `json:"notes,omitempty"`
	SyncMeta
}

type Vaccination struct {
	ID             string     `json:"id"`
	PetID          string     `json:"pet_id"`
	StaffID        string     `json:"staff_id,omitempty"`
	VaccineName    string     `json:"vaccine_name"`
	BatchNumber    string     `json:"batch_number,omitempty"`
	Manufacturer   string     `json:"manufacturer,omitempty"`
	Dose           *float64   `json:"dose,omitempty"`
	AdministeredAt time.Time  `json:"administered_at"`
	NextDueAt      *time.Time `json:"next_due_at,omitempty"`
	Notes          string     `json:"notes,omitempty"`
	SyncMeta
}

type Staff struct {
	ID       string `json:"id"`
	Name     string `json:"name"`
	Role     string `json:"role"`
	Phone    string `json:"phone,omitempty"`
	Email    string `json:"email,omitempty"`
	IsActive bool   `json:"is_active"`
	Notes    string `json:"notes,omitempty"`
	Photo    string `json:"photo,omitempty"` // base64 data URL, как у pets
	SyncMeta
}

type Device struct {
	ID         string    `json:"id"`
	Name       string    `json:"name"`
	LastSeenAt time.Time `json:"last_seen_at"`
	CreatedAt  time.Time `json:"created_at"`
}

// ─── Request payloads ─────────────────────────────────────────────────────────

type itemPayload struct {
	Name      string  `json:"name"`
	Type      string  `json:"type"`
	Price     float64 `json:"price"`
	CostPrice float64 `json:"cost_price"`
	// CostMode пустой = fixed: старый клиент, не знающий про проценты,
	// продолжает слать только cost_price и работает как раньше.
	CostMode    string  `json:"cost_mode,omitempty"`
	CostPercent float64 `json:"cost_percent,omitempty"`
	IsActive    *bool   `json:"is_active,omitempty"`
}

type ownerPayload struct {
	ID      string `json:"id,omitempty"`
	FIO     string `json:"fio"`
	IIN     string `json:"iin,omitempty"`
	Phone   string `json:"phone"`
	Address string `json:"address,omitempty"`
	Notes   string `json:"notes,omitempty"`
}

type petPayload struct {
	ID          string   `json:"id,omitempty"`
	OwnerID     string   `json:"owner_id"`
	Name        string   `json:"name"`
	Type        string   `json:"type"`
	Gender      string   `json:"gender"`
	BirthDate   string   `json:"birth_date,omitempty"`
	Age         *int     `json:"age,omitempty"`
	Breed       string   `json:"breed,omitempty"`
	Color       string   `json:"color,omitempty"`
	ChipNumber  string   `json:"chip_number,omitempty"`
	ChipDate    string   `json:"chip_date,omitempty"`
	Weight      *float64 `json:"weight,omitempty"`
	Notes       string   `json:"notes,omitempty"`
	Photo       string   `json:"photo,omitempty"`
}

type petDeceasedPayload struct {
	DeathDate   string `json:"death_date"`
	DeathReason string `json:"death_reason,omitempty"`
}

type createVisitPayload struct {
	ID               string   `json:"id,omitempty"`
	PetID            string   `json:"pet_id"`
	StaffID          string   `json:"staff_id,omitempty"`
	VisitType        string   `json:"visit_type,omitempty"`
	AnimalWeight     *float64 `json:"animal_weight,omitempty"`
	Date             string   `json:"date"`
	NextVisitDate    string   `json:"next_visit_date,omitempty"`
	// nil = поле не прислали (старый клиент) → курс не трогаем.
	TreatmentDays    *int     `json:"treatment_days,omitempty"`
	PatientCondition string   `json:"patient_condition,omitempty"`
	Anamnesis        string   `json:"anamnesis,omitempty"`
	Diagnosis        string   `json:"diagnosis,omitempty"`
	Treatment        string   `json:"treatment,omitempty"`
	Notes            string   `json:"notes,omitempty"`
	TotalAmount      float64  `json:"total_amount,omitempty"`
	PaymentCard      float64  `json:"payment_card,omitempty"`
	ChangeLog        string   `json:"change_log,omitempty"`
}

type createVisitItemPayload struct {
	ID       string  `json:"id,omitempty"`
	VisitID  string  `json:"visit_id"`
	ItemID   *string `json:"item_id,omitempty"`
	Name     string  `json:"name,omitempty"`
	Type     string  `json:"type"`
	Quantity float64 `json:"quantity"`
	Price    float64 `json:"price"`
	Total    float64 `json:"total,omitempty"`
}

type vaccinationPayload struct {
	ID             string   `json:"id,omitempty"`
	PetID          string   `json:"pet_id"`
	StaffID        string   `json:"staff_id,omitempty"`
	VaccineName    string   `json:"vaccine_name"`
	BatchNumber    string   `json:"batch_number,omitempty"`
	Manufacturer   string   `json:"manufacturer,omitempty"`
	Dose           *float64 `json:"dose,omitempty"`
	AdministeredAt string   `json:"administered_at"`
	NextDueAt      string   `json:"next_due_at,omitempty"`
	Notes          string   `json:"notes,omitempty"`
}

type staffPayload struct {
	ID       string `json:"id,omitempty"`
	Name     string `json:"name"`
	Role     string `json:"role"`
	Phone    string `json:"phone,omitempty"`
	Email    string `json:"email,omitempty"`
	IsActive *bool  `json:"is_active,omitempty"`
	Notes    string `json:"notes,omitempty"`
	Photo    string `json:"photo,omitempty"`
}

// ─── Full visit (composite) ───────────────────────────────────────────────────

type visitItemPayload struct {
	ItemID   *string `json:"item_id"`
	Name     string  `json:"name"`
	Type     string  `json:"type"`
	Quantity float64 `json:"quantity"`
	Price    float64 `json:"price"`
}

type visitPayloadShort struct {
	Date             string   `json:"date"`
	VisitType        string   `json:"visit_type,omitempty"`
	AnimalWeight     *float64 `json:"animal_weight,omitempty"`
	NextVisitDate    string   `json:"next_visit_date,omitempty"`
	TreatmentDays    int      `json:"treatment_days,omitempty"`
	PaymentCard      float64  `json:"payment_card,omitempty"`
	PatientCondition string   `json:"patient_condition,omitempty"`
	Anamnesis        string   `json:"anamnesis"`
	Diagnosis        string   `json:"diagnosis"`
	Treatment        string   `json:"treatment,omitempty"`
	Notes            string   `json:"notes"`
}

type visitFullPayload struct {
	Owner Owner             `json:"owner"`
	Pet   Pet               `json:"pet"`
	Visit visitPayloadShort `json:"visit"`
	Items []visitItemPayload `json:"items"`
}

type visitDetailResponse struct {
	Visit
	Items []VisitItem `json:"items"`
}

type visitFullResponse struct {
	Owner      Owner       `json:"owner"`
	Pet        Pet         `json:"pet"`
	Visit      Visit       `json:"visit"`
	VisitItems []VisitItem `json:"visit_items"`
}

// ─── Sync payloads ────────────────────────────────────────────────────────────

type syncPushPayload struct {
	DeviceID    string        `json:"device_id"`
	Owners      []ownerSyncRecord      `json:"owners"`
	Pets        []petSyncRecord        `json:"pets"`
	Items       []itemSyncRecord       `json:"items"`
	Visits      []visitSyncRecord      `json:"visits"`
	VisitItems  []visitItemSyncRecord  `json:"visit_items"`
	Vaccinations []vaccinationSyncRecord `json:"vaccinations"`
	Staff       []staffSyncRecord      `json:"staff"`
}

// ─────────────────────────────────────────────────────────────────────────────
// Sync records: все поля дат хранятся как string.
// Причина: клиент может отправить "", "2025-05-17T14:00" (без секунд),
// или дополнительные поля (sync_status, server_id, created_at) — их нужно
// игнорировать, а не падать с ошибкой.
// Парсинг в реальные time.Time происходит в push-функциях через parseSyncTime.
// ─────────────────────────────────────────────────────────────────────────────

type ownerSyncRecord struct {
	ID        string  `json:"id"`
	FIO       string  `json:"fio"`
	IIN       string  `json:"iin"`
	Phone     string  `json:"phone"`
	Address   string  `json:"address"`
	Notes     string  `json:"notes"`
	UpdatedAt string  `json:"updated_at"` // ISO string, парсится через parseSyncTime
	DeletedAt *string `json:"deleted_at"` // nullable ISO string
	IsDeleted int     `json:"is_deleted"`
	DeviceID  string  `json:"device_id"`
	Version   int     `json:"version"`
}

type petSyncRecord struct {
	ID          string   `json:"id"`
	OwnerID     string   `json:"owner_id"`
	Name        string   `json:"name"`
	Type        string   `json:"type"`
	Gender      string   `json:"gender"`
	BirthDate   *string  `json:"birth_date"`  // "" или null → nil
	Age         *int     `json:"age"`
	Breed       string   `json:"breed"`
	Color       string   `json:"color"`
	ChipNumber  string   `json:"chip_number"`
	ChipDate    *string  `json:"chip_date"`   // "" или null → nil
	Weight      *float64 `json:"weight"`
	Status      string   `json:"status"`
	DeathDate   *string  `json:"death_date"`  // "" или null → nil
	DeathReason string   `json:"death_reason"`
	Notes       string   `json:"notes"`
	Photo       string   `json:"photo"`
	UpdatedAt   string   `json:"updated_at"`
	DeletedAt   *string  `json:"deleted_at"`
	IsDeleted   int      `json:"is_deleted"`
	DeviceID    string   `json:"device_id"`
	Version     int      `json:"version"`
}

type itemSyncRecord struct {
	ID        string  `json:"id"`
	Name      string  `json:"name"`
	Type      string  `json:"type"`
	Price     float64 `json:"price"`
	CostPrice float64 `json:"cost_price"`
	// Планшет со старой версией приложения этих полей не пришлёт —
	// resolveCost подставит fixed и сохранит присланный cost_price.
	CostMode    string  `json:"cost_mode"`
	CostPercent float64 `json:"cost_percent"`
	IsActive    bool    `json:"is_active"`
	UpdatedAt   string  `json:"updated_at"`
	DeletedAt *string `json:"deleted_at"`
	IsDeleted int     `json:"is_deleted"`
	DeviceID  string  `json:"device_id"`
	Version   int     `json:"version"`
}

type visitSyncRecord struct {
	ID               string   `json:"id"`
	PetID            string   `json:"pet_id"`
	StaffID          string   `json:"staff_id"`
	VisitType        string   `json:"visit_type"`
	AnimalWeight     *float64 `json:"animal_weight"`
	Date             string   `json:"date"`
	NextVisitDate    *string  `json:"next_visit_date"`
	// Указатель, а не int, намеренно: nil = поле не прислали (планшет со старой
	// версией приложения) — курс на сервере надо сохранить как есть.
	// Явный 0 = врач убрал курс. Без этого различия старый клиент затирал бы курс
	// при каждом редактировании приёма.
	TreatmentDays    *int     `json:"treatment_days"`
	PatientCondition string   `json:"patient_condition"`
	Anamnesis        string   `json:"anamnesis"`
	Diagnosis        string   `json:"diagnosis"`
	Treatment        string   `json:"treatment"`
	Notes            string   `json:"notes"`
	TotalAmount      float64  `json:"total_amount"`
	PaymentCard      float64  `json:"payment_card"`
	ChangeLog        string   `json:"change_log"`
	UpdatedAt        string   `json:"updated_at"`
	DeletedAt        *string  `json:"deleted_at"`
	IsDeleted        int      `json:"is_deleted"`
	DeviceID         string   `json:"device_id"`
	Version          int      `json:"version"`
}

type visitItemSyncRecord struct {
	ID        string   `json:"id"`
	VisitID   string   `json:"visit_id"`
	ItemID    *string  `json:"item_id"`
	Name      string   `json:"name"`
	Type      string   `json:"type"`
	Quantity  float64  `json:"quantity"`
	Price     float64  `json:"price"`
	Total     float64  `json:"total"`
	UpdatedAt string   `json:"updated_at"`
	DeletedAt *string  `json:"deleted_at"`
	IsDeleted int      `json:"is_deleted"`
	DeviceID  string   `json:"device_id"`
	Version   int      `json:"version"`
}

type vaccinationSyncRecord struct {
	ID             string   `json:"id"`
	PetID          string   `json:"pet_id"`
	StaffID        string   `json:"staff_id"`
	VaccineName    string   `json:"vaccine_name"`
	BatchNumber    string   `json:"batch_number"`
	Manufacturer   string   `json:"manufacturer"`
	Dose           *float64 `json:"dose"`
	AdministeredAt string   `json:"administered_at"` // обязательная дата
	NextDueAt      *string  `json:"next_due_at"`     // опциональная
	Notes          string   `json:"notes"`
	UpdatedAt      string   `json:"updated_at"`
	DeletedAt      *string  `json:"deleted_at"`
	IsDeleted      int      `json:"is_deleted"`
	DeviceID       string   `json:"device_id"`
	Version        int      `json:"version"`
}

type staffSyncRecord struct {
	ID        string  `json:"id"`
	Name      string  `json:"name"`
	Role      string  `json:"role"`
	Phone     string  `json:"phone"`
	Email     string  `json:"email"`
	IsActive  bool    `json:"is_active"`
	Notes     string  `json:"notes"`
	UpdatedAt string  `json:"updated_at"`
	DeletedAt *string `json:"deleted_at"`
	IsDeleted int     `json:"is_deleted"`
	DeviceID  string  `json:"device_id"`
	Version   int     `json:"version"`
	// Пустое фото от старого планшета не должно стирать серверное — см. pushStaff.
	Photo    string `json:"photo"`
}

type syncPushResult struct {
	Accepted  int `json:"accepted"`
	Skipped   int `json:"skipped"`   // server version newer
	Conflicts int `json:"conflicts"` // обработаны, но не приняты
}

type syncPullData struct {
	Owners       []Owner       `json:"owners"`
	Pets         []Pet         `json:"pets"`
	Items        []Item        `json:"items"`
	Visits       []Visit       `json:"visits"`
	VisitItems   []VisitItem   `json:"visit_items"`
	Vaccinations []Vaccination `json:"vaccinations"`
	Staff        []Staff       `json:"staff"`
	// Метаданные вложений едут в pull; сами файлы качаются отдельно
	// по /attachments/{id}/file и только при наличии сети.
	Attachments  []Attachment  `json:"attachments"`
	ServerTime   time.Time     `json:"server_time"`
}
