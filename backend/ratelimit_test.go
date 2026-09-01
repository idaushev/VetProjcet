package main

import (
	"testing"
	"time"
)

// Лимитер — часть защиты от перебора кода портала, поэтому его поведение
// стоит закрепить тестом: порог, блокировка, рост паузы, сброс после успеха.

func TestThrottleLocksAfterMax(t *testing.T) {
	th := newLoginThrottle(3, time.Minute, 15*time.Minute)
	key := "+77770001122"

	// До порога — пускаем.
	for i := 0; i < 2; i++ {
		if ok, _ := th.allow(key); !ok {
			t.Fatalf("попытка %d должна проходить", i+1)
		}
		th.fail(key)
	}
	// Третья неудача достигает порога max=3 и блокирует.
	if ok, _ := th.allow(key); !ok {
		t.Fatal("перед третьей неудачей вход ещё открыт")
	}
	th.fail(key)
	ok, wait := th.allow(key)
	if ok {
		t.Fatal("после max неудач ключ должен быть заблокирован")
	}
	if wait <= 0 || wait > time.Minute {
		t.Fatalf("пауза вне ожидаемого диапазона (0, base]: %v", wait)
	}
}

func TestThrottleSuccessResets(t *testing.T) {
	th := newLoginThrottle(3, time.Minute, 15*time.Minute)
	key := "admin"

	th.fail(key)
	th.fail(key)
	th.success(key) // верный вход обнуляет счётчик

	// После сброса снова есть полный лимит: две неудачи не блокируют.
	th.fail(key)
	th.fail(key)
	if ok, _ := th.allow(key); !ok {
		t.Fatal("после success счётчик должен обнулиться, блокировки быть не должно")
	}
}

func TestThrottleLockGrows(t *testing.T) {
	th := newLoginThrottle(1, time.Minute, 15*time.Minute)
	key := "k"

	th.fail(key) // 1-я блокировка: base×1
	_, w1 := th.allow(key)

	// Досрочно снимаем блокировку, имитируя, что пауза прошла.
	th.entries[key].lockedUntil = time.Now().Add(-time.Second)

	th.fail(key) // 2-я блокировка: base×2
	_, w2 := th.allow(key)

	if !(w2 > w1) {
		t.Fatalf("пауза должна расти с числом блокировок: w1=%v w2=%v", w1, w2)
	}
}

func TestRetryAfterSeconds(t *testing.T) {
	cases := map[time.Duration]int{
		0:                        1, // минимум 1 сек
		500 * time.Millisecond:   1,
		time.Second:              1,
		1500 * time.Millisecond:  2, // округление вверх
		60 * time.Second:         60,
	}
	for d, want := range cases {
		if got := retryAfterSeconds(d); got != want {
			t.Errorf("retryAfterSeconds(%v) = %d, ожидалось %d", d, got, want)
		}
	}
}
