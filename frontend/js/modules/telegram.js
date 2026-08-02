/* modules/telegram.js — UI настроек телеграм-бота (M4.1, вынесено из pages.js).
 *
 * Самодостаточный IIFE: телеграм-модуль владеет своей вкладкой настроек.
 * Зависит только от window.VetUI и глобалов (VetAppConfig/__nativeFetch/VetAuth).
 * Точку входа зовёт ядро (initSettings) через window.VetTelegram.initSettings.
 *
 * Грузится ПОСЛЕ pages.js. Управление модулем (тумблеры/статус) остаётся в
 * ядре (вкладка «Модули»); здесь — только конфиг бота (токен/имя/напоминания).
 */
(function () {
  "use strict";
  var UI = window.VetUI;
  function el(id) { return document.getElementById(id); }

  async function tgApi(method, path, body) {
    // Только онлайн, мимо локального перехвата: настройки живут на сервере.
    var base = (window.VetAppConfig && window.VetAppConfig.apiBase) || '';
    var nfetch = window.__nativeFetch || window.fetch.bind(window);
    var res = await nfetch(base + path, {
      method: method,
      headers: { 'Content-Type': 'application/json', 'X-Bypass-Local': '1',
                 'X-Auth-Token': (window.VetAuth && VetAuth.token && VetAuth.token()) || '' },
      body: body ? JSON.stringify(body) : undefined
    });
    var j = await res.json().catch(function(){ return {}; });
    if (!res.ok || j.status !== 'ok') throw new Error((j && j.message) || ('HTTP ' + res.status));
    return j.data;
  }

  async function initTelegramSettings() {
    var el = function(id){ return document.getElementById(id); };
    var st = el('tg-status');
    if (!el('s-tg-token')) return;
    try {
      var d = await tgApi('GET', '/settings/telegram');
      if (el('s-tg-botname')) el('s-tg-botname').value = d.bot_name || '';
      if (el('s-tg-phone'))   el('s-tg-phone').value   = d.clinic_phone || '';
      if (el('s-tg-portal'))  el('s-tg-portal').value  = d.portal_url || '';
      if (el('s-tg-reminders')) el('s-tg-reminders').checked = !!d.reminders_enabled;
      if (el('s-tg-token-hint')) el('s-tg-token-hint').textContent = d.token_set ? ('Токен задан ' + (d.token_hint||'') + '. Оставьте поле пустым, чтобы не менять.') : 'Токен не задан — бот выключен.';
      if (st) { st.textContent = d.token_set ? 'Бот подключён' : 'Бот выключен'; st.className = 'badge ' + (d.token_set ? 'badge-active' : 'badge-deceased'); }
    } catch(e) {
      if (st) { st.textContent = 'нет связи'; st.className = 'badge'; }
    }

    var saveBtn = el('btn-save-tg');
    if (saveBtn) saveBtn.onclick = async function() {
      saveBtn.disabled = true;
      try {
        await tgApi('PUT', '/settings/telegram', {
          token: el('s-tg-token').value.trim(), // пусто = не менять
          bot_name: el('s-tg-botname').value.trim(),
          clinic_phone: el('s-tg-phone').value.trim(),
          portal_url: el('s-tg-portal').value.trim(),
          reminders_enabled: el('s-tg-reminders').checked
        });
        el('s-tg-token').value = '';
        var m = el('tg-saved-msg'); if (m) { m.style.display=''; setTimeout(function(){ m.style.display='none'; },2500); }
        await initTelegramSettings();
      } catch(e) { UI.toast('Не удалось сохранить: ' + e.message, 'err'); }
      saveBtn.disabled = false;
    };

    var testBtn = el('btn-test-tg');
    if (testBtn) testBtn.onclick = async function() {
      testBtn.disabled = true;
      var old = testBtn.textContent; testBtn.textContent = 'Проверяем…';
      try {
        var r = await tgApi('POST', '/settings/telegram/test');
        UI.toast('Бот на связи: @' + (r.username || r.first_name || '?'), 'ok', 5000);
      } catch(e) { UI.toast('Проверка не прошла: ' + e.message, 'err', 6000); }
      testBtn.textContent = old; testBtn.disabled = false;
    };
  }

  window.VetTelegram = { initSettings: initTelegramSettings };
})();
