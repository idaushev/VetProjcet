package main

import (
	"encoding/json"
	"testing"
)

// canSeeSum/seesAllSums решают, какие денежные поля попадут на устройство
// (см. maskForeignSums в handlers_sync.go). Логика зеркалит клиентский
// canSeeSum — расхождение открыло бы чужие суммы, поэтому закрываем тестом.

func userWithSums(sums string, staffID string, selected ...string) *User {
	perm := map[string]any{"sums": sums}
	if len(selected) > 0 {
		perm["sums_staff"] = selected
	}
	raw, _ := json.Marshal(perm)
	return &User{Role: "reception", StaffID: staffID, Permissions: raw}
}

func TestSeesAllSums(t *testing.T) {
	if !(&User{Role: "admin"}).seesAllSums() {
		t.Error("админ должен видеть все суммы")
	}
	if !userWithSums("all", "s1").seesAllSums() {
		t.Error(`scope "all" — все суммы`)
	}
	if !(&User{Role: "reception"}).seesAllSums() {
		t.Error("пустой scope трактуется как «все»")
	}
	if userWithSums("own", "s1").seesAllSums() {
		t.Error(`scope "own" не должен видеть все суммы`)
	}
	if userWithSums("selected", "s1", "s2").seesAllSums() {
		t.Error(`scope "selected" не должен видеть все суммы`)
	}
}

func TestCanSeeSumOwn(t *testing.T) {
	u := userWithSums("own", "docA")
	if !u.canSeeSum("docA") {
		t.Error("свой визит (docA) должен быть виден")
	}
	if u.canSeeSum("docB") {
		t.Error("чужой визит (docB) виден быть не должен")
	}
	if u.canSeeSum("") {
		t.Error("визит без врача не свой — скрыть")
	}
}

func TestCanSeeSumSelected(t *testing.T) {
	u := userWithSums("selected", "me", "docB", "docC")
	for _, id := range []string{"docB", "docC"} {
		if !u.canSeeSum(id) {
			t.Errorf("врач %s в списке — суммы видны", id)
		}
	}
	if u.canSeeSum("docX") {
		t.Error("врач вне списка — суммы скрыть")
	}
}

func TestCanSeeSumAdminAndAll(t *testing.T) {
	if !(&User{Role: "admin"}).canSeeSum("anyone") {
		t.Error("админ видит любые суммы")
	}
	if !userWithSums("all", "me").canSeeSum("someoneElse") {
		t.Error(`scope "all" видит любые суммы`)
	}
}
