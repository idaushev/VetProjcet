package main

import (
	"sync"
	"time"
)

// loginThrottle — лимитер попыток входа в памяти, без внешних зависимостей.
//
// Ключ — АККАУНТ (телефон владельца или логин сотрудника), а не IP. В клинике
// все планшеты за одним роутером, наружный IP общий: блокировка по IP заперла
// бы всех разом при атаке на один аккаунт. Ключ-аккаунт изолирует жертву —
// перебор одного номера не мешает остальным входить.
//
// Защищает в первую очередь портал: 6-значный код (900 000 комбинаций)
// без лимита перебирался бы за минуты, а это доступ к чужой медкарте.
// Состояние живёт в процессе; при перезапуске сбрасывается — для клиники
// с редкими рестартами это приемлемо.
type loginThrottle struct {
	mu      sync.Mutex
	entries map[string]*throttleEntry
	max     int           // неудач подряд до блокировки
	base    time.Duration // базовая пауза (растёт с каждой новой блокировкой)
	maxLock time.Duration // потолок паузы
}

type throttleEntry struct {
	fails       int
	lockStreak  int
	lockedUntil time.Time
	lastSeen    time.Time
}

func newLoginThrottle(max int, base, maxLock time.Duration) *loginThrottle {
	return &loginThrottle{
		entries: map[string]*throttleEntry{},
		max:     max,
		base:    base,
		maxLock: maxLock,
	}
}

// allow сообщает, можно ли сейчас пробовать ключ, и сколько ждать, если нет.
func (t *loginThrottle) allow(key string) (bool, time.Duration) {
	t.mu.Lock()
	defer t.mu.Unlock()
	e := t.entries[key]
	if e == nil {
		return true, 0
	}
	if d := time.Until(e.lockedUntil); d > 0 {
		return false, d
	}
	return true, 0
}

// fail отмечает неудачную попытку; на пороге max блокирует ключ с растущей
// паузой (base × число блокировок, но не выше maxLock).
func (t *loginThrottle) fail(key string) {
	t.mu.Lock()
	defer t.mu.Unlock()
	t.prune()
	e := t.entries[key]
	if e == nil {
		e = &throttleEntry{}
		t.entries[key] = e
	}
	e.lastSeen = time.Now()
	e.fails++
	if e.fails >= t.max {
		e.fails = 0
		e.lockStreak++
		d := t.base * time.Duration(e.lockStreak)
		if d > t.maxLock {
			d = t.maxLock
		}
		e.lockedUntil = time.Now().Add(d)
	}
}

// success сбрасывает счётчик после верного входа.
func (t *loginThrottle) success(key string) {
	t.mu.Lock()
	defer t.mu.Unlock()
	delete(t.entries, key)
}

// prune убирает давно неактивные записи, чтобы карта не росла без предела.
// Вызывается под мьютексом из fail; клиентов мало, проход дешёвый.
func (t *loginThrottle) prune() {
	if len(t.entries) < 512 {
		return
	}
	cutoff := time.Now().Add(-t.maxLock - time.Hour)
	for k, e := range t.entries {
		if e.lockedUntil.Before(time.Now()) && e.lastSeen.Before(cutoff) {
			delete(t.entries, k)
		}
	}
}

// Лимитеры процесса. Портал строже: код короткий и уходит наружу.
// 5 неудач → блок 1 мин, растёт до 15 мин. При TTL кода 10 мин / 1 час
// перебор 900 000 комбинаций становится неосуществимым.
var portalLoginThrottle = newLoginThrottle(5, time.Minute, 15*time.Minute)

// Основной вход снисходительнее: врач в спешке ошибётся, а сеть локальная.
// 8 неудач → блок 30 сек, растёт до 10 мин. Плюс уже есть 300 мс задержки.
var staffLoginThrottle = newLoginThrottle(8, 30*time.Second, 10*time.Minute)

// retryAfterSeconds округляет паузу вверх до секунд для сообщения пользователю.
func retryAfterSeconds(d time.Duration) int {
	s := int(d / time.Second)
	if d%time.Second != 0 {
		s++
	}
	if s < 1 {
		s = 1
	}
	return s
}
