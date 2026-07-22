/**
 * VetAuth — вход, сессия, офлайн-разблокировка.
 * ════════════════════════════════════════════════════════════════
 * Первый вход на устройстве требует сети: сервер проверяет пароль и выдаёт
 * токен на 90 дней. После этого локально кэшируется ВЕРИФИКАТОР пароля
 * (PBKDF2 через WebCrypto, свой соль/итерации — не серверный хэш), и врач
 * может разблокировать приложение без сети: пароль сверяется на устройстве,
 * токен предъявляется серверу при следующей синхронизации.
 *
 * Хэши паролей с сервера на устройство не попадают никогда.
 */
(function () {
  "use strict";

  var STORAGE_KEY = "vet-auth";
  var PBKDF2_ITER = 100000;

  var _state = null; // {token, user, login, verifier:{salt,iter,hash}}

  function load() {
    try { _state = JSON.parse(localStorage.getItem(STORAGE_KEY) || "null"); }
    catch (e) { _state = null; }
    return _state;
  }
  function save() {
    if (_state) localStorage.setItem(STORAGE_KEY, JSON.stringify(_state));
    else localStorage.removeItem(STORAGE_KEY);
  }

  // ── WebCrypto PBKDF2 ────────────────────────────────────────────────────
  function bufToHex(buf) {
    return [...new Uint8Array(buf)].map(function (b) { return b.toString(16).padStart(2, "0"); }).join("");
  }
  function hexToBuf(hex) {
    var out = new Uint8Array(hex.length / 2);
    for (var i = 0; i < out.length; i++) out[i] = parseInt(hex.substr(i * 2, 2), 16);
    return out;
  }
  async function derive(password, saltHex, iterations) {
    var key = await crypto.subtle.importKey(
      "raw", new TextEncoder().encode(password), "PBKDF2", false, ["deriveBits"]);
    var bits = await crypto.subtle.deriveBits(
      { name: "PBKDF2", hash: "SHA-256", salt: hexToBuf(saltHex), iterations: iterations },
      key, 256);
    return bufToHex(bits);
  }
  async function makeVerifier(password) {
    var salt = bufToHex(crypto.getRandomValues(new Uint8Array(16)));
    return { salt: salt, iter: PBKDF2_ITER, hash: await derive(password, salt, PBKDF2_ITER) };
  }

  // ── Вход ────────────────────────────────────────────────────────────────
  // Сначала пробуем сервер; если сети нет — офлайн-разблокировка по кэшу.
  async function login(loginName, password) {
    loginName = (loginName || "").trim().toLowerCase();
    if (!loginName || !password) return { ok: false, message: "Укажите логин и пароль" };

    var fn = window.__nativeFetch || window.fetch.bind(window);
    try {
      var r = await fn("/auth/login", {
        method: "POST",
        headers: { "Content-Type": "application/json", "X-Bypass-Local": "1" },
        body: JSON.stringify({ login: loginName, password: password,
                               device_id: window.VetDB ? window.VetDB.getDeviceID() : "" }),
        signal: AbortSignal.timeout(6000),
      });
      var d = await r.json();
      if (!r.ok || !d || d.status !== "ok") {
        return { ok: false, message: (d && d.message) || "Неверный логин или пароль" };
      }
      _state = {
        token: d.data.token,
        user: d.data.user,
        login: loginName,
        verifier: await makeVerifier(password),
      };
      save();
      return { ok: true, offline: false };
    } catch (e) {
      // Сети нет — офлайн-путь. Работает только для последнего входившего
      // на этом устройстве: чужой кэш проверить нечем.
      var st = _state || load();
      if (!st || !st.verifier || st.login !== loginName) {
        return { ok: false, message: "Нет связи с сервером. Первый вход на устройстве требует сети." };
      }
      var hash = await derive(password, st.verifier.salt, st.verifier.iter);
      if (hash !== st.verifier.hash) {
        return { ok: false, message: "Неверный пароль" };
      }
      _state = st;
      return { ok: true, offline: true };
    }
  }

  async function logout() {
    var fn = window.__nativeFetch || window.fetch.bind(window);
    try {
      await fn("/auth/logout", { method: "POST",
        headers: { "X-Auth-Token": token(), "X-Bypass-Local": "1" },
        signal: AbortSignal.timeout(3000) });
    } catch (e) {}
    _state = null;
    save();
    location.reload();
  }

  function token() { return (_state && _state.token) || ""; }
  function user()  { return (_state && _state.user) || null; }
  function isAuthed() { return !!(_state && _state.token); }

  // Сессия истекла на сервере (401 при синхронизации): токен выбрасываем,
  // но верификатор оставляем — офлайн-вход продолжит работать, а при сети
  // пользователь войдёт заново и получит свежий токен.
  function invalidateToken() {
    if (!_state) return;
    _state.token = "";
    save();
    showLogin("Сессия истекла — войдите заново");
  }

  // ── Экран входа ─────────────────────────────────────────────────────────
  function showLogin(message) {
    var el = document.getElementById("login-screen");
    if (!el) return;
    el.style.display = "flex";
    var err = document.getElementById("login-error");
    if (err) { err.textContent = message || ""; err.style.display = message ? "block" : "none"; }
    setTimeout(function () { document.getElementById("login-login") && document.getElementById("login-login").focus(); }, 50);
  }
  function hideLogin() {
    var el = document.getElementById("login-screen");
    if (el) el.style.display = "none";
  }

  // ── Права доступа ───────────────────────────────────────────────────────
  var PERM_ORDER = { none: 0, view: 1, create: 2, edit: 3 };

  // can('visits','create') — можно ли действие с таблицей.
  // Админ и пользователь без настроенных прав могут всё.
  function can(table, action) {
    var u = user();
    if (!u) return false;
    if (u.role === "admin") return true;
    // Роль склада изолирована: только склад и каталог (цены). Всё
    // медицинское — запрещено (совпадает с серверным tableLevel).
    if (u.role === "warehouse") return table === "warehouse" || table === "items";
    var p = u.permissions || {};
    var lvl = p.tables && p.tables[table];
    var have = PERM_ORDER[lvl] !== undefined ? PERM_ORDER[lvl] : 3;
    return have >= (PERM_ORDER[action] || 0);
  }

  // Чьи суммы видит пользователь: all — все, иначе список staff_id.
  function sumsScope() {
    var u = user();
    if (!u || u.role === "admin") return { mode: "all" };
    var p = u.permissions || {};
    if (p.sums === "own")      return { mode: "own", ids: u.staff_id ? [u.staff_id] : [] };
    if (p.sums === "selected") return { mode: "selected", ids: p.sums_staff || [] };
    return { mode: "all" };
  }

  // Можно ли показывать сумму приёма этого врача.
  function canSeeSum(staffId) {
    var s = sumsScope();
    if (s.mode === "all") return true;
    return !!staffId && s.ids.indexOf(staffId) >= 0;
  }

  function applyRoleUI() {
    var u = user();
    document.body.dataset.role = u ? u.role : "";
    var nameEl = document.getElementById("current-user-name");
    var roleEl = document.getElementById("current-user-role");
    var labels = { admin: "Администратор", doctor: "Врач", reception: "Регистратор", warehouse: "Склад" };
    if (nameEl && u) nameEl.textContent = u.display_name;
    if (roleEl && u) roleEl.textContent = labels[u.role] || u.role;

    // Роль склада — изолированный вход: видит только Склад и Каталог.
    // Прячем клинические группы и настройки, форсим раздел «Склад»,
    // приземляем на него. Прочая логика ниже к нему не применяется.
    if (u && u.role === "warehouse") {
      document.querySelectorAll(".nav-item[data-page]").forEach(function (a) {
        var keep = (a.dataset.page === "warehouse" || a.dataset.page === "items");
        var target = a.closest("li") || a;
        target.style.display = keep ? "" : "none";
      });
      ["ssg-clinic", "ssg-analytics", "ssg-settings"].forEach(function (id) {
        var g = document.getElementById(id); if (g) g.style.display = "none";
      });
      var whg = document.getElementById("ssg-warehouse"); if (whg) whg.style.display = "";
      document.body.classList.add("role-warehouse");
      if (window.navigate) navigate("warehouse");
      return;
    }

    // Разделы без доступа (none) убираем из меню целиком —
    // «если нет доступа, категории не отображать».
    var pageTable = {
      visits: "visits", schedule: "visits", owners: "owners", pets: "pets",
      vaccinations: "vaccinations", items: "items", staff: "staff",
      chips: "pets",
      "report-daily": "visits", "report-revenue": "visits",
      "report-upcoming": "visits", "report-noshows": "visits",
    };
    document.querySelectorAll(".nav-item[data-page]").forEach(function (a) {
      var t = pageTable[a.dataset.page];
      if (!t) return;
      // В сайдбаре пункт лежит в <li>, в нижней панели — сам по себе.
      // Прячем что есть: иначе раздел без доступа остался бы виден снизу.
      var target = a.closest("li") || a;
      target.style.display = can(t, "view") ? "" : "none";
    });
    // Кнопки добавления — по праву create.
    var addBtns = {
      "btn-add-owner": "owners", "btn-add-pet": "pets", "btn-add-visit": "visits",
      "btn-add-vaccination": "vaccinations", "btn-add-item": "items", "btn-add-staff": "staff",
    };
    Object.keys(addBtns).forEach(function (id) {
      var b = document.getElementById(id);
      if (b) b.style.display = can(addBtns[id], "create") ? "" : "none";
    });
  }

  async function submitLogin() {
    var l = document.getElementById("login-login").value;
    var p = document.getElementById("login-password").value;
    var btn = document.getElementById("login-submit");
    btn.disabled = true; btn.textContent = "Входим…";
    var res = await login(l, p);
    btn.disabled = false; btn.textContent = "Войти";
    if (!res.ok) { showLogin(res.message); return; }
    hideLogin();
    applyRoleUI();
    if (res.offline && window.VetUI) {
      window.VetUI.toast("Вход без сети — данные синхронизируются при подключении", "warn", 5000);
    }
    window.dispatchEvent(new Event("vetauth:login"));
  }

  // ── Смена собственного пароля ───────────────────────────────────────────
  // Требует сети: пароль проверяет и меняет сервер. После успеха обязательно
  // пересчитываем локальный верификатор — иначе офлайн-вход продолжил бы
  // требовать СТАРЫЙ пароль, и врач решил бы, что смена не сработала.
  async function changePassword(oldPassword, newPassword) {
    var fn = window.__nativeFetch || window.fetch.bind(window);
    var r;
    try {
      r = await fn("/auth/change-password", {
        method: "POST",
        headers: { "Content-Type": "application/json", "X-Bypass-Local": "1", "X-Auth-Token": token() },
        body: JSON.stringify({ old_password: oldPassword, new_password: newPassword }),
        signal: AbortSignal.timeout(8000),
      });
    } catch (e) {
      return { ok: false, message: "Нет связи с сервером — смена пароля требует сети" };
    }
    var d = await r.json();
    if (!r.ok || !d || d.status !== "ok") {
      return { ok: false, message: (d && d.message) || "Не удалось сменить пароль" };
    }
    _state.verifier = await makeVerifier(newPassword);
    save();
    return { ok: true };
  }

  function showChangePasswordDialog() {
    if (!window.VetUI || !window.VetUI.showModal) return;
    var html = '<div class="form-grid">'
      + '<div class="form-group form-span-2"><label class="form-label">Текущий пароль</label>'
      + '<input id="cp-old" class="form-input" type="password" autocomplete="current-password"></div>'
      + '<div class="form-group"><label class="form-label">Новый пароль</label>'
      + '<input id="cp-new" class="form-input" type="password" autocomplete="new-password" placeholder="минимум 6 символов"></div>'
      + '<div class="form-group"><label class="form-label">Ещё раз</label>'
      + '<input id="cp-new2" class="form-input" type="password" autocomplete="new-password"></div>'
      + '</div>';
    window.VetUI.showModal({
      title: "Сменить пароль",
      bodyHTML: html,
      saveLabel: "Сменить",
      onSave: async function () {
        var oldP = document.getElementById("cp-old").value;
        var newP = document.getElementById("cp-new").value;
        var new2 = document.getElementById("cp-new2").value;
        if (newP.length < 6) { window.VetUI.toast("Новый пароль не короче 6 символов", "err"); return; }
        if (newP !== new2)   { window.VetUI.toast("Пароли не совпадают", "err"); return; }
        var res = await changePassword(oldP, newP);
        if (!res.ok) { window.VetUI.toast(res.message, "err", 5000); return; }
        window.VetUI.hideModal();
        window.VetUI.toast("Пароль изменён", "ok");
      },
    });
  }

  function init() {
    load();
    var form = document.getElementById("login-form");
    if (form) form.addEventListener("submit", function (e) { e.preventDefault(); submitLogin(); });
    var lo = document.getElementById("btn-logout");
    if (lo) lo.onclick = function () {
      if (confirm("Выйти из системы?")) logout();
    };
    // Клик по своему имени в сайдбаре — смена пароля.
    var ui = document.querySelector(".sidebar-user-info");
    if (ui) {
      ui.style.cursor = "pointer";
      ui.title = "Сменить пароль";
      ui.onclick = showChangePasswordDialog;
    }

    if (isAuthed()) {
      hideLogin();
      applyRoleUI();
    } else {
      showLogin("");
    }
  }

  window.VetAuth = {
    init: init, login: login, logout: logout,
    token: token, user: user, isAuthed: isAuthed,
    invalidateToken: invalidateToken, applyRoleUI: applyRoleUI,
    changePassword: changePassword, showChangePasswordDialog: showChangePasswordDialog,
    can: can, sumsScope: sumsScope, canSeeSum: canSeeSum,
  };

  document.addEventListener("DOMContentLoaded", init);
})();
