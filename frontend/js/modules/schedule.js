/* modules/schedule.js — модуль «Расписание» (вынесен из pages.js).
 *
 * Самодостаточный IIFE по образцу modules/warehouse.js и modules/chips.js.
 * Помощники ядра берём через window.VetPagesCore — тело функций при
 * переносе не менялось. Публичные функции (onclick в разметке) вешаем
 * на window.VetPages; точка входа — window.VetSchedule.init.
 *
 * Грузится ПОСЛЕ pages.js (нужен VetPagesCore и VetPages).
 */
(function () {
  "use strict";
  var UI = window.VetUI;
  var C  = window.VetPagesCore || {};
  var esc = C.esc, buildMap = C.buildMap, emptyState = C.emptyState,
      localDateStr = C.localDateStr, api = C.api, I = C.I, fmtDate = C.fmtDate,
      astanaTodayStr = C.astanaTodayStr, loadClinicSettings = C.loadClinicSettings,
      loadAll = C.loadAll, initDashboard = C.initDashboard, newVisit = C.newVisit;
  function navigate(p) { return window.navigate && window.navigate(p); }

  // ═══════════════════════════════════════════════════════════════════════
  // РАСПИСАНИЕ: запись на приём (день, слоты по 30 минут)
  // ═══════════════════════════════════════════════════════════════════════
  //
  // Запись ≠ приём: она может ссылаться на питомца из базы, а может держать
  // только имя/телефон текстом (позвонил новый клиент). «Начать приём»
  // открывает форму приёма и помечает запись выполненной.

  var _schedDate   = null;  // YYYY-MM-DD
  var _schedDoctor = '';
  var _schedView   = 'list'; // 'list' | 'doctors' (колонки по врачам)
  var _schedAppts  = [];
  var _schedStaff  = [];
  var _schedOwners = [];
  var _schedPets   = [];

  var SCHED_START_H = 8, SCHED_END_H = 20; // рабочий день клиники

  var APPT_STATUS = {
    scheduled: { label: 'Запись',    cls: 'appt-scheduled' },
    done:      { label: 'Приём был', cls: 'appt-done' },
    cancelled: { label: 'Отменена',  cls: 'appt-cancelled' },
    no_show:   { label: 'Не пришли', cls: 'appt-noshow' },
  };

  async function initSchedule() {
    if (!_schedDate) _schedDate = astanaTodayStr();
    // Рабочие часы — из настроек клиники (по умолчанию 08–20)
    try {
      var s = await loadClinicSettings();
      if (s.sched_start != null) SCHED_START_H = Number(s.sched_start);
      if (s.sched_end   != null) SCHED_END_H   = Number(s.sched_end);
      if (SCHED_END_H <= SCHED_START_H) { SCHED_START_H = 8; SCHED_END_H = 20; }
    } catch(e) {}
    var dateInp = document.getElementById('sched-date');
    if (dateInp) {
      dateInp.value = _schedDate;
      dateInp.onchange = function() { _schedDate = dateInp.value || astanaTodayStr(); renderSchedule(); };
    }
    function shiftDay(delta) {
      var d = new Date(_schedDate + 'T12:00:00');
      d.setDate(d.getDate() + delta);
      _schedDate = localDateStr(d);
      if (dateInp) dateInp.value = _schedDate;
      renderSchedule();
    }
    var prev = document.getElementById('sched-prev');   if (prev) prev.onclick = function(){ shiftDay(-1); };
    var next = document.getElementById('sched-next');   if (next) next.onclick = function(){ shiftDay(1); };
    var tdy  = document.getElementById('sched-today');  if (tdy)  tdy.onclick  = function(){ _schedDate = astanaTodayStr(); if (dateInp) dateInp.value = _schedDate; renderSchedule(); };

    var data = await loadAll();
    _schedStaff  = (data.staff||[]).filter(function(s){ return !s.is_deleted && s.is_active !== false; })
                     .sort(function(a,b){ return (a.name||'').localeCompare(b.name||'','ru'); });
    _schedOwners = data.owners || [];
    _schedPets   = data.pets || [];

    var docSel = document.getElementById('sched-doctor');
    if (docSel) {
      docSel.innerHTML = '<option value="">Все врачи</option>'
        + _schedStaff.map(function(s){ return '<option value="'+esc(s.id)+'"'+(s.id===_schedDoctor?' selected':'')+'>'+esc(s.name)+'</option>'; }).join('');
      docSel.onchange = function() { _schedDoctor = docSel.value; renderSchedule(); };
    }
    var addBtn = document.getElementById('btn-add-appt');
    if (addBtn) addBtn.onclick = function() { openApptForm(null, null); };

    // R5: переключатель вида «Списком / По врачам». В режиме врачей фильтр
    // по одному врачу не нужен — прячем селектор, показываем все колонки.
    var viewBox = document.getElementById('sched-view');
    var docWrap = document.getElementById('sched-doctor');
    function applyViewUI() {
      if (viewBox) viewBox.querySelectorAll('.filter-btn').forEach(function(b){ b.classList.toggle('active', b.dataset.sview === _schedView); });
      if (docWrap) docWrap.style.display = _schedView === 'doctors' ? 'none' : '';
    }
    if (viewBox) {
      viewBox.querySelectorAll('.filter-btn').forEach(function(b){
        b.onclick = function() { _schedView = b.dataset.sview; applyViewUI(); renderSchedule(); };
      });
    }
    applyViewUI();

    await renderSchedule();
  }

  async function renderSchedule() {
    var grid = document.getElementById('schedule-grid');
    if (!grid) return;
    grid.innerHTML = '<div class="report-empty">Загрузка…</div>';

    var all = [];
    try { all = await window.VetDB.getAll('appointments'); } catch(e) { window.VetLog.warn('appointments:list', e); }
    _schedAppts = all.filter(function(a) {
      if (a.is_deleted) return false;
      if ((a.starts_at||'').slice(0,10) !== _schedDate) return false;
      if (_schedView !== 'doctors' && _schedDoctor && a.staff_id !== _schedDoctor) return false;
      return true;
    }).sort(function(a,b){ return (a.starts_at||'') < (b.starts_at||'') ? -1 : 1; });

    var cnt = document.getElementById('sched-count');
    if (cnt) {
      var active = _schedAppts.filter(function(a){ return a.status === 'scheduled'; }).length;
      cnt.textContent = _schedAppts.length
        ? ('Записей: ' + _schedAppts.length + (active !== _schedAppts.length ? ' (активных ' + active + ')' : ''))
        : 'День свободен — нажмите на слот, чтобы записать';
    }

    var staffMap = buildMap(_schedStaff);
    var petsMap  = buildMap(_schedPets);
    var ownersMap = buildMap(_schedOwners);

    // Слоты по 30 минут. Запись попадает в слот по времени начала.
    var bySlot = {};
    _schedAppts.forEach(function(a) {
      var hm = (a.starts_at||'').slice(11,16);
      var h = parseInt(hm.slice(0,2),10), m = parseInt(hm.slice(3,5),10);
      var key = (h < SCHED_START_H) ? 'before' : (h >= SCHED_END_H ? 'after' : (String(h).padStart(2,'0') + ':' + (m < 30 ? '00' : '30')));
      (bySlot[key] = bySlot[key] || []).push(a);
    });

    function apptCard(a) {
      var st = APPT_STATUS[a.status] || APPT_STATUS.scheduled;
      var pet = a.pet_id ? petsMap[a.pet_id] : null;
      var owner = a.owner_id ? ownersMap[a.owner_id] : (pet ? ownersMap[pet.owner_id] : null);
      var petName = pet ? pet.name : (a.pet_name || '');
      var who = (owner ? owner.fio : (a.client_name || '')) || '';
      var doc = a.staff_id && staffMap[a.staff_id] ? staffMap[a.staff_id].name.split(' ')[0] : '';
      var hm = (a.starts_at||'').slice(11,16);
      // Заявка с портала: клиника видит источник, а неподтверждённые
      // (confirmed=0) выделяем рамкой — их надо подтвердить или перезвонить.
      var fromPortal = a.source === 'portal' || (a.notes||'').indexOf('портал') >= 0;
      var unconfirmed = fromPortal && a.confirmed === 0;
      return '<div class="appt-card '+st.cls+(unconfirmed?' appt-unconfirmed':'')+'" data-act="appt.edit" data-id="'+a.id+'">'
        + (fromPortal ? '<span class="appt-portal'+(unconfirmed?' unconf':'')+'" title="'+(unconfirmed?'Новая заявка с портала — подтвердите время или перезвоните':'Запись создана владельцем через портал')+'">'+(unconfirmed?'заявка':'портал')+'</span>' : '')
        + '<div class="appt-time">'+esc(hm)+'<span class="appt-dur"> · '+(a.duration_min||30)+' мин</span></div>'
        + '<div class="appt-body">'
        + '<div class="appt-title">'+esc(petName || 'Без клички')+(who ? ' <span class="appt-owner">· '+esc(who)+'</span>' : '')+'</div>'
        + (a.reason ? '<div class="appt-reason">'+esc(a.reason)+'</div>' : '')
        + '</div>'
        + (doc ? '<span class="appt-doc">'+esc(doc)+'</span>' : '')
        + '<span class="appt-status">'+st.label+'</span>'
        + '</div>';
    }

    // R5: режим «по врачам» — колонки. Каждый столбец = врач, запись стоит
    // в столбце своего врача и в строке своего слота. Записи без врача —
    // в отдельном столбце «Без врача». Слоты вне рабочих часов и в этом
    // режиме показываем строками «до/после».
    if (_schedView === 'doctors') {
      grid.innerHTML = renderScheduleByDoctors(bySlot, apptCard, staffMap);
      return;
    }

    // Линия «сейчас»: только на сегодняшнем дне. Врач сканирует сетку
    // глазами десятки раз в день — линия сразу показывает, где он во времени.
    var nowHM = '';
    if (_schedDate === astanaTodayStr()) {
      nowHM = new Date(Date.now() + 5*3600000).toISOString().slice(11,16);
    }
    var nowLinePlaced = !nowHM;

    var html = '';
    if (bySlot.before) html += '<div class="sched-slot"><div class="sched-time">до ' + String(SCHED_START_H).padStart(2,'0') + ':00</div><div class="sched-cell">' + bySlot.before.map(apptCard).join('') + '</div></div>';
    for (var h = SCHED_START_H; h < SCHED_END_H; h++) {
      ['00','30'].forEach(function(mm) {
        var t = String(h).padStart(2,'0') + ':' + mm;
        if (!nowLinePlaced && t > nowHM) {
          html += '<div class="sched-now-line"><span>' + nowHM + '</span></div>';
          nowLinePlaced = true;
        }
        var appts = bySlot[t] || [];
        html += '<div class="sched-slot' + (appts.length ? ' has-appts' : '') + '">'
          + '<div class="sched-time">' + t + '</div>'
          + '<div class="sched-cell" data-act="appt.newAt" data-time="' + t + '" title="Нажмите, чтобы записать на ' + t + '">'
          + appts.map(apptCard).join('')
          + '</div></div>';
      });
    }
    if (!nowLinePlaced) html += '<div class="sched-now-line"><span>' + nowHM + '</span></div>';
    if (bySlot.after) html += '<div class="sched-slot"><div class="sched-time">после ' + SCHED_END_H + ':00</div><div class="sched-cell">' + bySlot.after.map(apptCard).join('') + '</div></div>';
    grid.innerHTML = html;
  }

  function newApptAt(time) { openApptForm(null, time); }
  function newApptForDoc(time, staffId) { openApptForm(null, time, staffId); }

  // R5: сетка «по врачам» — колонки. Столбец = врач; запись стоит в столбце
  // своего врача и в строке своего слота. Записи без врача — столбец «Без
  // врача». Клик по пустой ячейке записывает на это время к этому врачу.
  function renderScheduleByDoctors(bySlot, apptCard, staffMap) {
    var cols = _schedStaff.map(function(s){ return { id: s.id, name: s.name }; });
    if (_schedAppts.some(function(a){ return !a.staff_id; })) cols.push({ id: '', name: 'Без врача' });
    if (!cols.length) return emptyState('Нет врачей — добавьте персонал', '+ Добавить', "navigate('staff')", 'users');

    function cellAppts(slotAppts, colId) {
      return (slotAppts || []).filter(function(a){ return (a.staff_id || '') === colId; });
    }

    var tmpl = 'var(--sched-time-w) repeat(' + cols.length + ', minmax(150px, 1fr))';
    var html = '<div class="sched-doctors" style="grid-template-columns:' + tmpl + ';">';
    html += '<div class="schd-corner"></div>';
    cols.forEach(function(c){ html += '<div class="schd-head">' + esc(c.name) + '</div>'; });

    function row(label, slotAppts, slotTime) {
      html += '<div class="schd-time">' + esc(label) + '</div>';
      cols.forEach(function(c){
        var appts = cellAppts(slotAppts, c.id);
        var clickable = slotTime && c.id;
        html += '<div class="schd-cell' + (appts.length ? ' has' : '') + '"'
          + (clickable ? ' data-act="appt.newForDoc" data-time="' + slotTime + '" data-doc="' + c.id + '" title="Записать на ' + slotTime + '"' : '')
          + '>' + appts.map(apptCard).join('') + '</div>';
      });
    }

    if (bySlot.before) row('до ' + String(SCHED_START_H).padStart(2,'0') + ':00', bySlot.before, null);
    for (var h = SCHED_START_H; h < SCHED_END_H; h++) {
      ['00','30'].forEach(function(mm){
        var t = String(h).padStart(2,'0') + ':' + mm;
        row(t, bySlot[t], t);
      });
    }
    if (bySlot.after) row('после ' + SCHED_END_H + ':00', bySlot.after, null);

    html += '</div>';
    return html;
  }
  function editAppt(id) {
    var a = _schedAppts.find(function(x){ return x.id === id; });
    if (a) openApptForm(a, null);
  }

  // Конфликт по времени у одного врача: пересечение интервалов
  // [start, start+dur) на ту же дату, статус scheduled, кроме самой записи.
  // Возвращает {who, time} конфликтующей записи или null. Читаем из
  // IndexedDB, а не из _schedAppts: расписание могло быть отфильтровано.
  async function _apptConflict(dateStr, timeStr, durMin, staffId, excludeId) {
    var startMin = parseInt(timeStr.slice(0,2),10)*60 + parseInt(timeStr.slice(3,5),10);
    var endMin = startMin + (durMin || 30);
    var all = [];
    try { all = await window.VetDB.getAll('appointments'); } catch(e) { return null; }
    var ownersMap = buildMap(_schedOwners);
    var petsMap = buildMap(_schedPets);
    for (var i = 0; i < all.length; i++) {
      var a = all[i];
      if (a.is_deleted || a.id === excludeId) continue;
      if (a.status !== 'scheduled') continue;
      if (a.staff_id !== staffId) continue;
      if ((a.starts_at||'').slice(0,10) !== dateStr) continue;
      var t = (a.starts_at||'').slice(11,16);
      var aStart = parseInt(t.slice(0,2),10)*60 + parseInt(t.slice(3,5),10);
      var aEnd = aStart + (a.duration_min || 30);
      if (startMin < aEnd && aStart < endMin) { // интервалы пересекаются
        var pet = a.pet_id ? petsMap[a.pet_id] : null;
        var owner = a.owner_id ? ownersMap[a.owner_id] : (pet ? ownersMap[pet.owner_id] : null);
        return { who: (owner ? owner.fio : (a.client_name || (pet ? pet.name : ''))) || 'клиент', time: t };
      }
    }
    return null;
  }

  // Форму записи открывают и вне страницы расписания (из формы приёма) —
  // справочники могли быть ещё не загружены.
  async function ensureSchedData() {
    if (_schedStaff.length && _schedOwners.length) return;
    var data = await loadAll();
    _schedStaff  = (data.staff||[]).filter(function(s){ return !s.is_deleted && s.is_active !== false; })
                     .sort(function(a,b){ return (a.name||'').localeCompare(b.name||'','ru'); });
    _schedOwners = data.owners || [];
    _schedPets   = data.pets || [];
  }

  // Приём с назначенной датой следующего визита → предложение сразу
  // создать запись в расписании. Закрывает главный шов: врач назначил
  // повторный визит, а регистратура его в расписании не видела.
  async function maybeOfferAppointment(vs, pet, owner) {
    if (!vs || !vs.next_visit_date || !pet) return;
    try {
      var appts = await window.VetDB.getAll('appointments');
      var exists = appts.some(function(a) {
        return !a.is_deleted && a.pet_id === pet.id && a.status === 'scheduled'
          && (a.starts_at||'').slice(0,10) === vs.next_visit_date;
      });
      if (exists) return; // уже записан на эту дату
    } catch(e) {}
    var ok = await UI.confirm('Записать в расписание?',
      'Назначен следующий приём на ' + fmtDate(vs.next_visit_date) + '. Создать запись в расписании?',
      { yes: 'Создать запись', no: 'Не сейчас' });
    if (!ok) return;
    openApptForm({
      owner_id: owner ? owner.id : (pet.owner_id || ''),
      pet_id:   pet.id,
      staff_id: vs.staff_id || '',
      starts_at: vs.next_visit_date + 'T10:00:00.000Z',
      reason:   'Повторный приём' + (vs.diagnosis ? ': ' + vs.diagnosis : ''),
    }, null);
  }

  // ── Форма записи ────────────────────────────────────────────────────
  async function openApptForm(appt, defaultTime, defaultStaff) {
    await ensureSchedData();
    var isEdit = !!(appt && appt.id);
    appt = appt || {};
    var st = appt.status || 'scheduled';
    var hm = appt.starts_at ? appt.starts_at.slice(11,16) : (defaultTime || '10:00');
    var dateVal = appt.starts_at ? appt.starts_at.slice(0,10) : _schedDate;
    var curStaff = appt.staff_id || defaultStaff || (window.VetAuth && VetAuth.user() ? (VetAuth.user().staff_id||'') : '');

    var durOpts = [15,30,45,60,90,120].map(function(m){
      return '<option value="'+m+'"'+(m===(appt.duration_min||30)?' selected':'')+'>'+m+' мин</option>';
    }).join('');
    var staffOpts = '<option value="">— не указан —</option>'
      + _schedStaff.map(function(s){ return '<option value="'+esc(s.id)+'"'+(s.id===curStaff?' selected':'')+'>'+esc(s.name)+'</option>'; }).join('');

    // Неподтверждённая заявка с портала: баннер вверху формы. Регистратор
    // проверяет время, назначает врача и сохраняет — сохранение подтверждает.
    var isUnconfirmed = appt.source === 'portal' && appt.confirmed === 0;
    var banner = isUnconfirmed
      ? '<div class="appt-confirm-banner">' + I('alert')
        + ' Новая заявка с портала. Проверьте время, назначьте врача и сохраните — заявка станет подтверждённой записью.'
        + (appt.client_phone ? ' <a href="tel:'+esc(appt.client_phone.replace(/[^\\d+]/g,''))+'">Позвонить клиенту</a>' : '')
        + '</div>'
      : '';

    var bodyHTML = banner + '<div class="form-grid">'
      + '<div class="form-group"><label class="form-label">Дата</label><input id="ap-date" class="form-input" type="date" value="'+esc(dateVal)+'"></div>'
      + '<div class="form-group"><label class="form-label">Время</label><input id="ap-time" class="form-input" type="time" step="900" value="'+esc(hm)+'"></div>'
      + '<div class="form-group"><label class="form-label">Длительность</label><select id="ap-dur" class="form-select">'+durOpts+'</select></div>'
      + '<div class="form-group"><label class="form-label">Врач</label><select id="ap-staff" class="form-select">'+staffOpts+'</select></div>'
      // Владелец из базы: автокомплит; выбор подтягивает телефон и питомцев
      + '<div class="form-group form-span-2"><label class="form-label">Владелец из базы</label>'
      + '<div class="autocomplete" style="width:100%;"><input id="ap-owner-search" class="form-input" placeholder="Поиск по имени или телефону..." autocomplete="off" value="">'
      + '<div class="autocomplete-dropdown" id="ap-owner-dd"></div></div>'
      + '<input type="hidden" id="ap-owner-id" value="'+esc(appt.owner_id||'')+'">'
      + '<div class="form-hint" id="ap-owner-hint"></div></div>'
      + '<div class="form-group form-span-2" id="ap-pet-wrap" style="display:none;"><label class="form-label">Питомец</label>'
      + '<select id="ap-pet" class="form-select"></select></div>'
      + '<div class="form-group"><label class="form-label">Имя клиента</label><input id="ap-client-name" class="form-input" value="'+esc(appt.client_name||'')+'" placeholder="Если не из базы"></div>'
      + '<div class="form-group"><label class="form-label">Телефон</label><input id="ap-client-phone" class="form-input" type="tel" value="'+esc(appt.client_phone||'')+'" placeholder="+7 ..."></div>'
      + '<div class="form-group form-span-2"><label class="form-label">Кличка (если не из базы)</label><input id="ap-pet-name" class="form-input" value="'+esc(appt.pet_name||'')+'" placeholder="Барсик"></div>'
      + '<div class="form-group form-span-2"><label class="form-label">Причина визита</label><input id="ap-reason" class="form-input" value="'+esc(appt.reason||'')+'" placeholder="Вакцинация, осмотр, хромает..."></div>'
      + '<div class="form-group form-span-2"><label class="form-label">Заметки</label><textarea id="ap-notes" class="form-textarea" rows="2">'+esc(appt.notes||'')+'</textarea></div>'
      + '</div>'
      // Статусные действия — только у существующей записи
      + (isEdit ? '<div class="appt-actions-row">'
          + (st !== 'done' && appt.pet_id ? '<button class="btn btn-primary btn-sm" data-act="appt.startVisit" data-id="'+esc(appt.id)+'">'+I('play')+' Начать приём</button>' : '')
          + (st === 'scheduled' ? '<button class="btn btn-ghost btn-sm" data-act="appt.status" data-id="'+esc(appt.id)+'" data-status="no_show">Не пришли</button>' : '')
          + (st === 'scheduled' ? '<button class="btn btn-ghost btn-sm" data-act="appt.status" data-id="'+esc(appt.id)+'" data-status="cancelled">Отменить запись</button>' : '')
          + (st === 'cancelled' || st === 'no_show' ? '<button class="btn btn-ghost btn-sm" data-act="appt.status" data-id="'+esc(appt.id)+'" data-status="scheduled">Вернуть в запись</button>' : '')
          + '<button class="btn btn-ghost btn-sm danger-text" data-act="appt.delete" data-id="'+esc(appt.id)+'">Удалить</button>'
          + '</div>' : '');

    UI.showModal({
      title: isUnconfirmed ? 'Заявка с портала' : (isEdit ? 'Запись' : 'Новая запись'),
      bodyHTML: bodyHTML,
      saveLabel: isUnconfirmed ? 'Подтвердить запись' : (isEdit ? 'Сохранить' : 'Записать'),
      afterOpen: function() {
        // ── Автокомплит владельца ──
        var inp = document.getElementById('ap-owner-search');
        var dd  = document.getElementById('ap-owner-dd');
        var hint = document.getElementById('ap-owner-hint');

        function fillPets(ownerId, selectedPetId) {
          var wrap = document.getElementById('ap-pet-wrap');
          var sel  = document.getElementById('ap-pet');
          var pets = _schedPets.filter(function(p){ return p.owner_id === ownerId && !p.is_deleted && p.status === 'active'; });
          if (!pets.length) { wrap.style.display = 'none'; sel.innerHTML = ''; return; }
          sel.innerHTML = pets.map(function(p){ return '<option value="'+esc(p.id)+'"'+(p.id===selectedPetId?' selected':'')+'>'+esc(p.name)+' ('+esc(p.type||'')+')</option>'; }).join('');
          wrap.style.display = '';
        }
        function pickOwner(o, petId) {
          document.getElementById('ap-owner-id').value = o.id;
          inp.value = o.fio;
          hint.textContent = '';
          var cn = document.getElementById('ap-client-name');
          var cp = document.getElementById('ap-client-phone');
          if (cn && !cn.value) cn.value = o.fio;
          if (cp && !cp.value) cp.value = o.phone || '';
          fillPets(o.id, petId || '');
        }
        // Предзаполнение при правке
        if (appt.owner_id) {
          var ow = _schedOwners.find(function(o){ return o.id === appt.owner_id; });
          if (ow) pickOwner(ow, appt.pet_id || '');
        } else if (appt.pet_id) {
          var pp = _schedPets.find(function(p){ return p.id === appt.pet_id; });
          var ow2 = pp ? _schedOwners.find(function(o){ return o.id === pp.owner_id; }) : null;
          if (ow2) pickOwner(ow2, appt.pet_id);
        }

        inp.addEventListener('input', function() {
          document.getElementById('ap-owner-id').value = '';
          document.getElementById('ap-pet-wrap').style.display = 'none';
          var q = inp.value.trim().toLowerCase();
          if (q.length < 2) { dd.classList.remove('show'); return; }
          var qd = q.replace(/\D/g,'');
          var matches = _schedOwners.filter(function(o) {
            if (o.is_deleted) return false;
            if ((o.fio||'').toLowerCase().includes(q)) return true;
            if (qd.length >= 5 && String(o.phone||'').replace(/\D/g,'').includes(qd)) return true;
            return false;
          }).slice(0, 6);
          dd.innerHTML = matches.map(function(o) {
            return '<div class="ac-item" data-id="'+o.id+'"><div class="ac-item-title">'+esc(o.fio)+'</div><div class="ac-item-sub">'+esc(o.phone||'')+'</div></div>';
          }).join('');
          dd.classList.toggle('show', matches.length > 0);
          dd.querySelectorAll('.ac-item').forEach(function(el) {
            el.onmousedown = function(e) {
              e.preventDefault();
              var o = _schedOwners.find(function(x){ return x.id === el.dataset.id; });
              if (o) pickOwner(o);
              dd.classList.remove('show');
            };
          });
        });
        inp.addEventListener('blur', function(){ setTimeout(function(){ dd.classList.remove('show'); }, 200); });
      },
      onSave: async function() {
        var g = function(id){ var el = document.getElementById(id); return el ? el.value.trim() : ''; };
        var date = g('ap-date'), time = g('ap-time');
        if (!date || !time) { UI.toast('Укажите дату и время', 'err'); return; }
        var ownerId = g('ap-owner-id');
        var petWrap = document.getElementById('ap-pet-wrap');
        var petId = (ownerId && petWrap && petWrap.style.display !== 'none') ? g('ap-pet') : '';
        var staffId = g('ap-staff');
        var durMin = parseInt(g('ap-dur'), 10) || 30;
        var startsAt = date + 'T' + time + ':00.000Z';
        var body = {
          owner_id:     ownerId,
          pet_id:       petId,
          staff_id:     staffId,
          client_name:  g('ap-client-name'),
          client_phone: g('ap-client-phone'),
          pet_name:     g('ap-pet-name'),
          starts_at:    startsAt,
          duration_min: durMin,
          reason:       g('ap-reason'),
          notes:        g('ap-notes'),
          status:       st,
          // Источник сохраняем; сохранение заявки регистратором = подтверждение.
          source:       appt.source || '',
          confirmed:    1,
        };
        if (!body.pet_id && !body.client_name && !body.pet_name) {
          UI.toast('Укажите клиента: выберите владельца или впишите имя/кличку', 'err');
          return;
        }
        // Двойная запись: тот же врач, пересечение по времени. Мягко —
        // клиника может сознательно посадить двоих (напр. срочный случай).
        if (staffId) {
          var clash = await _apptConflict(date, time, durMin, staffId, isEdit ? appt.id : null);
          if (clash) {
            var ok = await UI.confirm('Врач уже занят',
              'На это время к выбранному врачу уже записан ' + (clash.who || 'клиент')
              + ' (' + clash.time + '). Всё равно записать?',
              { yes: 'Всё равно записать', no: 'Изменить время' });
            if (!ok) return;
          }
        }
        try {
          if (isEdit) await api('PUT', '/appointments/' + appt.id, body);
          else        await api('POST', '/appointments', body);
          UI.toast(isUnconfirmed ? 'Заявка подтверждена' : (isEdit ? 'Запись обновлена' : 'Запись создана'), 'ok');
          UI.hideModal();
          _schedDate = date;
          var di = document.getElementById('sched-date'); if (di) di.value = date;
          renderSchedule();
          initDashboard();
        } catch(e) { UI.toast(e.message, 'err'); }
      },
    });
  }

  async function apptSetStatus(id, status) {
    var a = _schedAppts.find(function(x){ return x.id === id; });
    if (!a) return;
    try {
      await api('PUT', '/appointments/' + id, Object.assign({}, a, { status: status }));
      UI.hideModal();
      renderSchedule();
    } catch(e) { UI.toast(e.message, 'err'); }
  }

  async function apptDelete(id) {
    var ok = await UI.confirm('Удалить запись?', 'Запись будет удалена из расписания.');
    if (!ok) return;
    try {
      await api('DELETE', '/appointments/' + id);
      UI.hideModal();
      renderSchedule();
    } catch(e) { UI.toast(e.message, 'err'); }
  }

  // «Начать приём»: помечаем запись выполненной и открываем форму приёма
  // с её питомцем. Врач сразу в работе, статус в расписании уже честный.
  async function apptStartVisit(id) {
    var a = _schedAppts.find(function(x){ return x.id === id; });
    if (!a || !a.pet_id) return;
    try { await api('PUT', '/appointments/' + id, Object.assign({}, a, { status: 'done' })); } catch(e) { window.VetLog.warn('appointment:markDone', e); }
    UI.hideModal();
    setTimeout(function(){ newVisit(a.pet_id); }, 150);
  }


  // ── Экспорт ──────────────────────────────────────────────────────────
  window.VetSchedule = { init: initSchedule };

  window.VetPages = window.VetPages || {};
  window.VetPages.newApptAt      = newApptAt;
  window.VetPages.newApptForDoc  = newApptForDoc;
  if (window.VetActions) {
    window.VetActions.register({
      // Пустой слот: раньше стояла проверка event.target===this, чтобы клик по
      // карточке внутри слота не заводил новую запись. Диспетчер берёт
      // ближайшего предка с data-act, и карточка перекрывает слот сама — но
      // у слота бывают и не-кликабельные потомки, поэтому проверку оставляем.
      'appt.newAt':      function (el, e) { if (e.target === el) newApptAt(el.dataset.time); },
      'appt.newForDoc':  function (el, e) { if (e.target === el) newApptForDoc(el.dataset.time, el.dataset.doc); },
      'appt.startVisit': function (el) { apptStartVisit(el.dataset.id); },
      'appt.status':     function (el) { apptSetStatus(el.dataset.id, el.dataset.status); },
      'appt.delete':     function (el) { apptDelete(el.dataset.id); }
    });
  }

  window.VetPages.editAppt       = editAppt;
  window.VetPages.apptSetStatus  = apptSetStatus;
  window.VetPages.apptStartVisit = apptStartVisit;
  window.VetPages.apptDelete     = apptDelete;
}());
