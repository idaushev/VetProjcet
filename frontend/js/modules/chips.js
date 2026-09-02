/* modules/chips.js — модуль «Чипирование» (вынесен из pages.js).
 *
 * Самодостаточный IIFE по образцу modules/warehouse.js. Общие помощники ядра
 * берём через window.VetPagesCore — тело функций при переносе не менялось.
 * Публичные функции (onclick в разметке) навешиваются на window.VetPages;
 * точка входа страницы — window.VetChips.init (зовётся из VetPages.init).
 *
 * Грузится ПОСЛЕ pages.js (нужен VetPagesCore и VetPages).
 */
(function () {
  "use strict";
  var UI = window.VetUI;
  var C  = window.VetPagesCore || {};
  var esc = C.esc, buildMap = C.buildMap, emptyState = C.emptyState,
      searchEmpty = C.searchEmpty, setupSearch = C.setupSearch,
      api = C.api, I = C.I, fmtDate = C.fmtDate, printHTML = C.printHTML,
      toAstanaStr = C.toAstanaStr, astanaTodayStr = C.astanaTodayStr,
      setText = C.setText, loadClinicSettings = C.loadClinicSettings;

  // ═══════════════════════════════════════════════════════════════════════
  // ЧИПИРОВАНИЕ: реестр чипов, присвоение, сертификат.
  // Работает офлайн: всё считается из локальной базы.
  // ═══════════════════════════════════════════════════════════════════════
  var _chipPets = [], _chipOwners = {};
  // 'all' — с чипом | 'none' — без чипа | 'month' — за 30 дней
  // | 'notanba' — чип есть, а в госреестре карточки ещё нет
  var _chipFilter = 'all';

  // У ТАҢБА нет API: карточку в реестр заводит человек через портал. Значит
  // единственный способ не потерять животное — вести свой список тех, кого
  // ещё не внесли, и вычёркивать по мере регистрации.
  function needsTanba(p) {
    return p.chip_number && p.status === 'active' && !p.tanba_number;
  }

  async function initChips() {
    var [pets, owners] = await Promise.all([
      window.VetDB.getAll('pets'), window.VetDB.getAll('owners')
    ]);
    _chipPets = (pets || []).filter(function(p){ return !p.is_deleted; });
    _chipOwners = buildMap(owners || []);

    var chipped = _chipPets.filter(function(p){ return p.chip_number && p.status === 'active'; });
    var noChip  = _chipPets.filter(function(p){ return !p.chip_number && p.status === 'active'; });
    var monthAgo = toAstanaStr(new Date(Date.now() - 30*86400000));
    var month = chipped.filter(function(p){ return p.chip_date && toAstanaStr(p.chip_date) >= monthAgo; });

    setText('chip-stat-total', chipped.length);
    setText('chip-stat-none',  noChip.length);
    setText('chip-stat-month', month.length);
    setText('chip-stat-notanba', _chipPets.filter(needsTanba).length);

    // Карточки-счётчики кликабельны: фильтруют список (с чипом / без чипа /
    // за 30 дней). Клик по активной карточке сбрасывает на «с чипом».
    document.querySelectorAll('#chip-stats .stat-card-link').forEach(function(card) {
      var setF = function() {
        _chipFilter = (card.dataset.cf === _chipFilter && card.dataset.cf !== 'all') ? 'all' : card.dataset.cf;
        renderChipList();
      };
      card.onclick = setF;
      card.onkeydown = function(e){ if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); setF(); } };
    });

    renderChipList();
    setupSearch('search-chips', function(){ renderChipList(); });
    var btn = document.getElementById('btn-chip-pet');
    if (btn) {
      btn.onclick = chipPetDialog;
      btn.style.display = (window.VetAuth && !VetAuth.can('pets','edit')) ? 'none' : '';
    }
  }

  function renderChipList() {
    var el = document.getElementById('chips-list');
    if (!el) return;
    // Подсветка активной карточки-фильтра.
    document.querySelectorAll('#chip-stats .stat-card-link').forEach(function(c){
      c.classList.toggle('active', c.dataset.cf === _chipFilter);
    });

    var q = (document.getElementById('search-chips')||{}).value || '';
    var qn = q.toLowerCase();
    var qDigits = qn.replace(/\D/g, '');
    var monthAgo = toAstanaStr(new Date(Date.now() - 30*86400000));

    // База по выбранной карточке.
    var base;
    if (_chipFilter === 'none') {
      base = _chipPets.filter(function(p){ return !p.chip_number && p.status === 'active'; });
    } else if (_chipFilter === 'notanba') {
      base = _chipPets.filter(needsTanba);
    } else if (_chipFilter === 'month') {
      base = _chipPets.filter(function(p){ return p.chip_number && p.chip_date && toAstanaStr(p.chip_date) >= monthAgo; });
    } else {
      base = _chipPets.filter(function(p){ return p.chip_number; });
    }

    var list = base.filter(function(p){
      if (!q) return true;
      var owner = _chipOwners[p.owner_id] || {};
      var hay = (p.name + ' ' + (p.breed||'') + ' ' + (owner.fio||'')).toLowerCase();
      // Номер сравниваем по цифрам: ввод со сканера бывает с пробелами.
      return hay.includes(qn) || (qDigits && p.chip_number && String(p.chip_number).includes(qDigits));
    }).sort(function(a,b){
      if (_chipFilter === 'none') return (a.name||'').localeCompare(b.name||'', 'ru');
      // Свежие чипы сверху; без даты — в конец, по кличке.
      var da = a.chip_date || '', db = b.chip_date || '';
      if (da !== db) return da < db ? 1 : -1;
      return (a.name||'').localeCompare(b.name||'', 'ru');
    });

    if (!list.length) {
      if (q) { el.innerHTML = searchEmpty('search-chips'); return; }
      var emptyText = _chipFilter === 'none' ? 'Все активные животные уже с чипом 👍'
                    : _chipFilter === 'notanba' ? 'Все чипированные животные заведены в ТАҢБА 👍'
                    : _chipFilter === 'month' ? 'За 30 дней не чипировали'
                    : 'Чипированных животных пока нет';
      el.innerHTML = emptyState(emptyText, null, null, 'paw');
      return;
    }

    // Список животных БЕЗ чипа — со своим действием «Чипировать».
    if (_chipFilter === 'none') {
      var canEdit = !(window.VetAuth && !VetAuth.can('pets','edit'));
      el.innerHTML = list.map(function(p){
        var owner = _chipOwners[p.owner_id] || {};
        return '<div class="erow" onclick="VetPages.showPetCard(\''+p.id+'\')">'
          + UI.avatar(p.name, p.type)
          + '<div class="erow-body">'
          + '<div class="erow-title">'+esc(p.name)+' <span class="chip-nochip">нет чипа</span></div>'
          + '<div class="erow-sub">'+esc(p.type||'')+(p.breed?' · '+esc(p.breed):'')
          + ' · '+esc(owner.fio||'—')+(owner.phone?' · '+I('phone')+' '+esc(owner.phone):'')+'</div>'
          + '</div>'
          + '<div class="erow-right"><div class="erow-actions">'
          + (canEdit ? '<button class="btn btn-sm btn-primary" onclick="event.stopPropagation();VetPages.chipPetDialog()">Чипировать</button>' : '')
          + '</div></div></div>';
      }).join('');
      return;
    }

    // Чипированные (все / за 30 дней).
    el.innerHTML = list.map(function(p){
      var owner = _chipOwners[p.owner_id] || {};
      var dead = p.status !== 'active';
      return '<div class="erow" onclick="VetPages.showPetCard(\''+p.id+'\')">'
        + UI.avatar(p.name, p.type)
        + '<div class="erow-body">'
        + '<div class="erow-title"><span class="chip-mono">'+esc(p.chip_number)+'</span>'
        + (needsTanba(p)?' <span class="chip-nochip">не в ТАҢБА</span>':'')
        + (dead?' <span class="badge badge-'+p.status+'">'+(p.status==='deceased'?'Умер':'Неактивен')+'</span>':'')+'</div>'
        + '<div class="erow-sub">'+esc(p.name)+' · '+esc(p.type||'')+(p.breed?' · '+esc(p.breed):'')
        + ' · '+esc(owner.fio||'—')+(owner.phone?' · '+I('phone')+' '+esc(owner.phone):'')
        // Без ИИН владельца регистрация на портале не пройдёт — показываем
        // это прямо в рабочем списке, чтобы не выяснять на портале.
        + (_chipFilter === 'notanba' && !owner.iin ? ' · <span class="chip-nochip">нет ИИН владельца</span>' : '')
        + '</div>'
        + '</div>'
        + '<div class="erow-right">'
        + (p.chip_date?'<span class="erow-date">'+fmtDate(p.chip_date)+'</span>':'')
        + '<div class="erow-actions">'
        + '<button class="btn btn-icon btn-print" onclick="event.stopPropagation();VetPages.printChipCertificate(\''+p.id+'\')" title="Сертификат чипирования">'+UI.icon('print','')+'</button>'
        + '</div></div></div>';
    }).join('');
  }

  // Диалог «Чипировать»: существующее животное без чипа ЛИБО новое —
  // с созданием владельца на месте. Частый сценарий: на чипирование приходят
  // впервые, и ни хозяина, ни животного в базе ещё нет.
  var CHIP_PET_TYPES = [
    'кошка','собака','попугай','птица','кролик','хомяк',
    'черепаха','морская свинка','шиншилла','хорёк','другое'
  ];

  async function chipPetDialog() {
    var candidates = _chipPets.filter(function(p){ return !p.chip_number && p.status === 'active'; })
      .sort(function(a,b){ return (a.name||'').localeCompare(b.name||'', 'ru'); });

    // Услуги имплантации из прайса — чтобы сразу оформить приём.
    var chipServices = [];
    try {
      chipServices = (await window.VetDB.getAll('items')).filter(function(it){
        return !it.is_deleted && it.is_active !== false && /чип/i.test(it.name || '');
      });
    } catch(e) {}

    // Владельцы для режима «новое животное»
    var ownersList = Object.keys(_chipOwners).map(function(k){ return _chipOwners[k]; })
      .filter(function(o){ return !o.is_deleted; })
      .sort(function(a,b){ return (a.fio||'').localeCompare(b.fio||'', 'ru'); });

    var html = '<div class="form-grid">'
      // Переключатель режима: существующее / новое животное
      + '<div class="form-group form-span-2"><div class="condition-tabs">'
      + '<span class="condition-tab selected" id="chip-mode-existing" onclick="VetPages._chipMode(\'existing\')">Из базы</span>'
      + '<span class="condition-tab" id="chip-mode-new" onclick="VetPages._chipMode(\'new\')">Новое животное</span>'
      + '</div></div>'

      // ── Режим «из базы» ──
      + '<div class="form-group form-span-2 chip-block-existing"><label class="form-label">Животное <span class="form-req">*</span></label>'
      + (candidates.length
        ? '<select id="chip-pet" class="form-select">'
          + candidates.map(function(p){
              var o = _chipOwners[p.owner_id] || {};
              return '<option value="'+p.id+'">'+esc(p.name)+' ('+esc(p.type||'')+') — '+esc(o.fio||'')+'</option>';
            }).join('')
          + '</select>'
        : '<div class="text-sm text-muted">Все животные в базе уже с чипами — переключитесь на «Новое животное»</div>')
      + '</div>'

      // ── Режим «новое животное» (скрыт по умолчанию) ──
      + '<div class="form-group chip-block-new" style="display:none"><label class="form-label">Владелец <span class="form-req">*</span></label>'
      + '<select id="chip-owner" class="form-select" onchange="VetPages._chipOwnerToggle(this)">'
      + '<option value="__new__">+ Новый владелец</option>'
      + ownersList.map(function(o){ return '<option value="'+o.id+'">'+esc(o.fio)+(o.phone?' · '+esc(o.phone):'')+'</option>'; }).join('')
      + '</select></div>'
      + '<div class="form-group chip-block-new chip-owner-new" style="display:none"><label class="form-label">ФИО владельца <span class="form-req">*</span></label>'
      + '<input id="chip-owner-fio" class="form-input" placeholder="Иванов Иван Иванович"></div>'
      + '<div class="form-group chip-block-new chip-owner-new" style="display:none"><label class="form-label">Телефон владельца <span class="form-req">*</span></label>'
      + '<input id="chip-owner-phone" class="form-input" type="tel" placeholder="+7 700 000 0000"></div>'
      + '<div class="form-group chip-block-new" style="display:none"><label class="form-label">Кличка <span class="form-req">*</span></label>'
      + '<input id="chip-pet-name" class="form-input" placeholder="Барсик"></div>'
      + '<div class="form-group chip-block-new" style="display:none"><label class="form-label">Вид</label>'
      + '<select id="chip-pet-type" class="form-select">'
      + CHIP_PET_TYPES.map(function(t){ return '<option value="'+t+'">'+t.charAt(0).toUpperCase()+t.slice(1)+'</option>'; }).join('')
      + '</select></div>'
      + '<div class="form-group chip-block-new" style="display:none"><label class="form-label">Пол</label>'
      + '<select id="chip-pet-gender" class="form-select"><option value="m">Самец</option><option value="f">Самка</option></select></div>'
      + '<div class="form-group chip-block-new" style="display:none"><label class="form-label">Порода</label>'
      + '<input id="chip-pet-breed" class="form-input" placeholder="необязательно"></div>'

      + '<div class="form-group form-span-2"><label class="form-label">Номер чипа <span class="form-req">*</span></label>'
      + '<input id="chip-number" class="form-input" inputmode="numeric" maxlength="20" placeholder="643094100001234" oninput="VetUI.checkChip()">'
      + '<div id="f-chip-hint" class="form-hint"></div></div>'
      + '<div class="form-group form-span-2"><label class="form-label">Дата чипирования</label>'
      + '<input id="chip-date" class="form-input" type="date" value="'+astanaTodayStr()+'"></div>'
      + (chipServices.length
        ? '<div class="form-group form-span-2"><label class="form-label" style="display:flex;align-items:center;gap:8px;cursor:pointer;text-transform:none;letter-spacing:0;">'
          + '<input type="checkbox" id="chip-make-visit" checked style="width:18px;height:18px;"> Оформить приём с услугой:</label>'
          + '<select id="chip-service" class="form-select">'
          + chipServices.map(function(it){ return '<option value="'+it.id+'">'+esc(it.name)+' — '+Number(it.price).toFixed(0)+' ₸</option>'; }).join('')
          + '</select></div>'
        : '')
      + '</div>';

    // Стартовый режим: если существующих кандидатов нет — сразу «новое животное».
    _chipDialogMode = candidates.length ? 'existing' : 'new';

    UI.showModal({
      title: 'Чипирование', bodyHTML: html, saveLabel: 'Чипировать',
      afterOpen: function(){
        // checkChip читает поле f-chip — дадим ему наш input под тем же id
        var inp = document.getElementById('chip-number');
        if (inp) inp.id = 'f-chip', inp.setAttribute('oninput','VetUI.checkChip()');
        _chipMode(_chipDialogMode);
      },
      onSave: chipDialogSave
    });
  }

  var _chipDialogMode = 'existing';

  // Переключение режима «из базы» / «новое животное».
  function _chipMode(mode) {
    _chipDialogMode = mode;
    document.getElementById('chip-mode-existing').classList.toggle('selected', mode === 'existing');
    document.getElementById('chip-mode-new').classList.toggle('selected', mode === 'new');
    document.querySelectorAll('.chip-block-existing').forEach(function(el){ el.style.display = mode === 'existing' ? '' : 'none'; });
    document.querySelectorAll('.chip-block-new').forEach(function(el){ el.style.display = mode === 'new' ? '' : 'none'; });
    if (mode === 'new') _chipOwnerToggle(document.getElementById('chip-owner'));
  }

  // Показ полей нового владельца, когда выбрано «+ Новый владелец».
  function _chipOwnerToggle(sel) {
    if (!sel) return;
    var isNew = sel.value === '__new__';
    document.querySelectorAll('.chip-owner-new').forEach(function(el){ el.style.display = isNew ? '' : 'none'; });
  }

  async function chipDialogSave() {
    var chipInp = document.getElementById('f-chip') || document.getElementById('chip-number');
    var chip = UI.normalizeChip(chipInp.value);
    var dateStr = document.getElementById('chip-date').value || astanaTodayStr();
    if (!chip) { UI.toast('Введите номер чипа', 'err'); return; }
    if (chip.length < 9 || chip.length > 15) { UI.toast('Номер чипа: от 9 до 15 цифр', 'err'); return; }

    var pet, ownerId;
    try {
      if (_chipDialogMode === 'new') {
        // Всё валидируем ДО любых записей: иначе при пустой кличке владелец
        // уже создан, а животное упало — остаётся осиротевший владелец.
        var ownerSel = document.getElementById('chip-owner');
        var makeNewOwner = ownerSel.value === '__new__';
        var fio = document.getElementById('chip-owner-fio').value.trim();
        var phone = document.getElementById('chip-owner-phone').value.trim();
        var name = document.getElementById('chip-pet-name').value.trim();
        if (makeNewOwner && !fio)   { UI.toast('Введите ФИО владельца', 'err'); return; }
        if (makeNewOwner && !phone) { UI.toast('Введите телефон владельца', 'err'); return; }
        if (!name) { UI.toast('Введите кличку животного', 'err'); return; }

        // ── Владелец: существующий или новый ──
        if (makeNewOwner) {
          var newOwner = await api('POST', '/owners', { fio: fio, phone: phone });
          ownerId = newOwner.id;
        } else {
          ownerId = ownerSel.value;
        }
        // ── Новое животное ──
        pet = await api('POST', '/pets', {
          owner_id: ownerId,
          name: name,
          type: document.getElementById('chip-pet-type').value,
          gender: document.getElementById('chip-pet-gender').value,
          breed: document.getElementById('chip-pet-breed').value.trim(),
          chip_number: chip,
          chip_date: dateStr + 'T12:00:00Z',
          id_method: 'chip'
        });
      } else {
        // ── Существующее животное ──
        var petSel = document.getElementById('chip-pet');
        if (!petSel || !petSel.value) { UI.toast('Выберите животное', 'err'); return; }
        var existing = _chipPets.find(function(p){ return p.id === petSel.value; });
        if (!existing) return;
        ownerId = existing.owner_id;
        pet = await api('PUT', '/pets/'+existing.id, {
          owner_id: existing.owner_id, name: existing.name, type: existing.type, gender: existing.gender,
          birth_date: existing.birth_date || '', breed: existing.breed || '', color: existing.color || '',
          weight: existing.weight, notes: existing.notes || '',
          chip_number: chip, chip_date: dateStr + 'T12:00:00Z', id_method: 'chip'
        });
      }
    } catch(e) { UI.toast(e.message, 'err', 5000); return; }

    // Приём с услугой имплантации — по желанию.
    var mkVisit = document.getElementById('chip-make-visit');
    if (mkVisit && mkVisit.checked) {
      var svcId = document.getElementById('chip-service').value;
      var items = await window.VetDB.getAll('items');
      var svc = items.find(function(it){ return it.id === svcId; });
      if (svc) {
        try {
          await api('POST', '/visits/full', {
            owner: { id: ownerId },
            pet: { id: pet.id, name: pet.name, type: pet.type, gender: pet.gender||'m', owner_id: ownerId },
            visit: { date: new Date().toISOString(), diagnosis: 'Чипирование',
                     treatment: 'Имплантация микрочипа ' + chip, visit_type: 'первичный' },
            items: [{ item_id: svc.id, name: svc.name, type: svc.type, quantity: 1,
                      price: svc.price, cost_price: svc.cost_price, total: svc.price }]
          });
        } catch(e) { UI.toast('Чип присвоен, но приём не создан: '+e.message, 'warn', 6000); }
      }
    }
    UI.hideModal();
    UI.toast('Чип '+chip+' зарегистрирован', 'ok');
    initChips();
  }

  // Сертификат чипирования — печатная форма для владельца.
  async function printChipCertificate(petId) {
    var pet = _chipPets.find(function(p){ return p.id === petId; });
    if (!pet) {
      try { pet = (await window.VetDB.getAll('pets')).find(function(p){ return p.id === petId; }); } catch(e) { window.VetLog.warn('pet:byId', e); }
    }
    if (!pet || !pet.chip_number) { UI.toast('У животного нет чипа', 'err'); return; }
    var owner = _chipOwners[pet.owner_id] ||
      ((await window.VetDB.getAll('owners')).find(function(o){ return o.id === pet.owner_id; }) || {});
    var settings = await loadClinicSettings();

    var html = '<!DOCTYPE html><html><head><meta charset="utf-8"><title>Сертификат чипирования — '+esc(pet.name)+'</title>'
      + '<style>'
      + 'body{font-family:Arial,sans-serif;color:#1a2434;max-width:640px;margin:24px auto;padding:0 16px;}'
      + '.head{display:flex;align-items:center;gap:14px;border-bottom:2px solid #1a8c5e;padding-bottom:12px;margin-bottom:18px;}'
      + '.head img{height:56px;} h1{font-size:18pt;margin:0;} .sub{color:#526070;font-size:10pt;}'
      + '.chip{font-family:Consolas,monospace;font-size:20pt;font-weight:bold;letter-spacing:2px;'
      +   'border:2px solid #1a8c5e;border-radius:10px;padding:12px 18px;text-align:center;margin:16px 0;}'
      + 'table{width:100%;border-collapse:collapse;font-size:11pt;} td{padding:7px 4px;border-bottom:1px solid #e0e8f2;}'
      + 'td:first-child{color:#526070;width:42%;}'
      + '.sign{display:flex;justify-content:space-between;margin-top:36px;font-size:10pt;color:#526070;}'
      + '.sign div{border-top:1px solid #5d6f81;padding-top:6px;width:40%;text-align:center;}'
      + '@media print{.no-print{display:none}}'
      + '</style></head><body>'
      + '<div class="head">'
      + (settings.logo ? '<img src="'+settings.logo+'">' : '')
      + '<div><h1>Сертификат чипирования</h1>'
      + '<div class="sub">'+esc(settings.name || 'VetClinic')
      + (settings.phone ? ' · '+esc(settings.phone) : '')+(settings.address ? ' · '+esc(settings.address) : '')+'</div></div>'
      + '</div>'
      + '<div class="chip">'+esc(pet.chip_number)+'</div>'
      + '<table>'
      + '<tr><td>Кличка</td><td><b>'+esc(pet.name)+'</b></td></tr>'
      + '<tr><td>Вид / порода</td><td>'+esc(pet.type||'—')+(pet.breed?' / '+esc(pet.breed):'')+'</td></tr>'
      + '<tr><td>Пол</td><td>'+(pet.gender==='m'?'Самец':'Самка')+'</td></tr>'
      + (pet.birth_date?'<tr><td>Дата рождения</td><td>'+fmtDate(pet.birth_date)+'</td></tr>':'')
      + (pet.color?'<tr><td>Окрас</td><td>'+esc(pet.color)+'</td></tr>':'')
      + '<tr><td>Дата чипирования</td><td>'+(pet.chip_date?fmtDate(pet.chip_date):'—')+'</td></tr>'
      + '<tr><td>Владелец</td><td>'+esc(owner.fio||'—')+'</td></tr>'
      + (owner.phone?'<tr><td>Телефон владельца</td><td>'+esc(owner.phone)+'</td></tr>':'')
      + '</table>'
      + '<div class="sign"><div>Врач</div><div>Печать клиники</div></div>'
      + '</body></html>';
    printHTML(html);
  }


  // ── Экспорт ──────────────────────────────────────────────────────────
  // Точка входа страницы; VetPages.init вызывает её для раздела 'chips'.
  window.VetChips = { init: initChips };

  // Функции, на которые ссылаются onclick в разметке, — на общий VetPages,
  // как это делает модуль склада.
  window.VetPages = window.VetPages || {};
  window.VetPages.printChipCertificate = printChipCertificate;
  window.VetPages.chipPetDialog        = chipPetDialog;
  window.VetPages._chipMode            = _chipMode;
  window.VetPages._chipOwnerToggle     = _chipOwnerToggle;
  window.VetPages.chipDialogSave       = chipDialogSave;
}());
