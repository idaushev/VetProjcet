/* modules.js — фронт-реестр опциональных модулей (M3.1).
 *
 * Единая декларация модулей на клиенте: их флаг, стораджи и правила гейта
 * навигации. db.js и sync.js берут отсюда список стораджей, pages.js —
 * гейт nav. Аналог бэкендового moduleRegistry (modules.go).
 *
 * ВАЖНО: грузится ПЕРВЫМ (до db.js/sync.js/pages.js) — они читают реестр на
 * старте. Манифест несёт только ДАННЫЕ (без ссылок на функции страниц): код
 * страниц ещё не загружен. Поведение страниц пока в VetPages (разъедется по
 * modules/* в M3.2).
 *
 * Стораджи модуля объявляются ВСЕГДА (не зависят от флага): при выключенном
 * модуле данные не должны исчезать из IndexedDB — как и на сервере.
 */
(function () {
  "use strict";

  var _mods = [];

  var VetModules = {
    register: function (m) { _mods.push(m); return m; },
    all: function () { return _mods.slice(); },

    // Плоский список стораджей всех модулей (для db.js ENTITY_STORES и
    // sync.js STORE_ORDER). Порядок регистрации; дубли отсеиваются.
    stores: function () {
      var out = [];
      _mods.forEach(function (m) {
        (m.stores || []).forEach(function (s) { if (out.indexOf(s) < 0) out.push(s); });
      });
      return out;
    },

    // Ключи-флаги всех модулей (для refreshModules).
    flags: function () { return _mods.map(function (m) { return m.enabledFlag; }); },

    // defaultOn по флагу (portal включён по умолчанию, склад — нет).
    isDefaultOn: function (flag) {
      for (var i = 0; i < _mods.length; i++) {
        if (_mods[i].enabledFlag === flag) return _mods[i].defaultOn === true;
      }
      return false;
    },

    // Применить состояние флагов к навигации по правилам манифестов.
    // opt-in  — раздел скрыт по умолчанию, класс onClass на body + показ группы.
    // opt-out — ссылки видны по умолчанию, класс offClass прячет их (CSS).
    applyNav: function (states) {
      _mods.forEach(function (m) {
        if (!m.nav) return;
        var on = !!states[m.enabledFlag];
        if (m.nav.mode === "opt-in") {
          document.body.classList.toggle(m.nav.onClass, on);
          if (m.nav.groupId) {
            var g = document.getElementById(m.nav.groupId);
            if (g) g.style.display = on ? "" : "none";
          }
        } else if (m.nav.mode === "opt-out") {
          document.body.classList.toggle(m.nav.offClass, !on);
        }
      });
    },
  };

  // ── Манифесты опциональных модулей ──────────────────────────────────────
  // Ключи флагов совпадают с бэкендом (GET /settings/modules).

  VetModules.register({
    key: "warehouse",
    enabledFlag: "warehouse",
    defaultOn: false,                       // опциональная розница — по умолчанию выкл
    stores: ["warehouses", "stock_movements"],
    nav: { mode: "opt-in", groupId: "ssg-warehouse", onClass: "mod-warehouse-on" },
  });

  VetModules.register({
    key: "portal",
    enabledFlag: "portal",
    defaultOn: true,                        // кабинет владельца по умолчанию вкл
    stores: [],                             // портал — отдельное приложение, своих сторов нет
    nav: { mode: "opt-out", offClass: "mod-portal-off" }, // ссылки .needs-mod-portal
  });

  VetModules.register({
    key: "telegram",
    enabledFlag: "telegram",
    defaultOn: false,                       // «включён» = задан токен
    stores: [],
    nav: null,                              // только вкладка настроек, гейта nav нет
  });

  window.VetModules = VetModules;
})();
