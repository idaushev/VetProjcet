/* ════════════════════════════════════════════════════════════════
   VetClinic Pages — Data loading, list rendering, CRUD actions
   ════════════════════════════════════════════════════════════════ */
(function () {
  'use strict';

  var UI = window.VetUI;

  // I — вставка иконки из общего набора (js/icons.js) в строковую разметку.
  // Пустая строка вместо иконки, если модуль не загрузился: рендер страницы
  // важнее картинки и падать из-за неё не должен.
  function I(name, cls) {
    if (!window.VetIcons) return '';
    return window.VetIcons.get(name, { cls: cls || '' });
  }

  // Время Астаны (UTC+5) — используется во всех сравнениях дат
  function toAstanaDate(d) {
    var dt = d ? new Date(d) : new Date();
    // Переводим в UTC+5
    var offset = 5 * 60; // минут
    var local = new Date(dt.getTime() + (offset - (-dt.getTimezoneOffset())) * 60000);
    return local;
  }
  function nowAstana() { return toAstanaDate(null); }
  function astanaTodayStr() { return nowAstana().toISOString().slice(0,10); }
  function toAstanaStr(d) { return d ? toAstanaDate(d).toISOString().slice(0,10) : ''; }


  var esc = UI.esc;

  // ── API helpers ───────────────────────────────────────────────────────
  async function api(method, path, body) {
    var opts = { method: method, headers: { 'Content-Type': 'application/json',
      'X-Auth-Token': (window.VetAuth && window.VetAuth.token()) || '' } };
    if (body) opts.body = JSON.stringify(body);
    var res = await fetch(path, opts);
    var json = await res.json();
    if (!json || json.status !== 'ok') throw new Error(json.message || 'Ошибка запроса');
    return json.data;
  }

  async function loadAll() {
    var [owners, pets, items, visits, vaccinations, staff] = await Promise.all([
      api('GET', '/owners'),
      api('GET', '/pets?status=all'),
      api('GET', '/items'),
      api('GET', '/visits'),
      api('GET', '/vaccinations'),
      api('GET', '/staff'),
    ]);
    return { owners, pets, items, visits, vaccinations, staff };
  }

  // ── Date helpers ──────────────────────────────────────────────────────
  function fmtDate(s) {
    if (!s) return '—';
    try {
      var d = new Date(s);
      return d.toLocaleDateString('ru-RU', { day: '2-digit', month: '2-digit', year: 'numeric' });
    } catch(e) { return s.slice(0,10); }
  }
  function fmtDateTime(s) {
    if (!s) return '—';
    try {
      var d = new Date(s);
      return d.toLocaleDateString('ru-RU', { day: '2-digit', month: '2-digit', year: 'numeric' }) + ' ' + d.toLocaleTimeString('ru-RU', { hour: '2-digit', minute: '2-digit' });
    } catch(e) { return s.slice(0,16).replace('T',' '); }
  }

  // ── Empty state ───────────────────────────────────────────────────────
  // Пустое состояние — не тупик: если передан ctaLabel/ctaOnclick,
  // показываем кнопку следующего шага («Записать», «Новый приём»...).
  // emptyState(text, ctaLabel, ctaOnclick, iconName)
  // iconName — имя иконки из VetIcons (напр. 'search', 'paw'); без него —
  // нейтральный значок «инфо». Разные значки помогают отличить «ещё ничего
  // нет» от «не найдено по фильтру».
  function emptyState(text, ctaLabel, ctaOnclick, iconName) {
    var iconSvg = (iconName && window.VetIcons)
      ? window.VetIcons.get(iconName, { cls: 'list-empty-icon' })
      : '<svg class="list-empty-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5">'
        + '<circle cx="12" cy="12" r="10"/><path d="M8 15h8M8 9h2m4 0h2"/></svg>';
    return `<div class="list-empty">
      ${iconSvg}
      <span>${esc(text)}</span>
      ${ctaLabel ? '<button class="btn btn-ghost btn-sm" style="margin-top:10px;" onclick="'+esc(ctaOnclick||'')+'">'+esc(ctaLabel)+'</button>' : ''}
    </div>`;
  }

  // «Ничего не найдено» с кнопкой сброса — отдельный вид пустого состояния
  // для поиска/фильтра: значок лупы + действие «Сбросить поиск».
  function searchEmpty(inputId) {
    return emptyState('Ничего не найдено', 'Сбросить поиск',
      "VetPages.resetSearch('"+inputId+"')", 'search');
  }

  // Очищает поле поиска и перерисовывает список (setupSearch слушает oninput).
  function resetSearch(inputId) {
    var el = document.getElementById(inputId);
    if (!el) return;
    el.value = '';
    if (typeof el.oninput === 'function') el.oninput();
    el.focus();
  }

  // ── Highlight search term ─────────────────────────────────────────────
  function hl(text, q) {
    if (!q || !text) return esc(text||'');
    var idx = text.toLowerCase().indexOf(q.toLowerCase());
    if (idx < 0) return esc(text);
    return esc(text.slice(0,idx)) + '<mark style="background:rgba(46,204,113,.25);border-radius:2px;color:inherit;">' + esc(text.slice(idx,idx+q.length)) + '</mark>' + esc(text.slice(idx+q.length));
  }

  // ── setupSearch — подключает live-поиск к полю ввода ─────────────────
  // inputId: id элемента <input type="search">
  // renderFn: функция рендера списка, принимает строку запроса
  function setupSearch(inputId, renderFn) {
    var el = document.getElementById(inputId);
    if (!el) return;
    // Снимаем предыдущий слушатель (пересоздание при повторном init страницы)
    el.oninput = null;
    el.oninput = function () { renderFn(el.value); };
  }

  // ── Role labels ───────────────────────────────────────────────────────
  var ROLE_LABELS = { vet:'Ветеринар', vet_assistant:'Ветфельдшер', admin:'Администратор', groomer:'Груммер', surgeon:'Хирург', other:'Другое' };

  // ═══════════════════════════════════════════════════════════════════════
  // DASHBOARD
  // ═══════════════════════════════════════════════════════════════════════

  // Сколько строк показывает панель дашборда. Одно число на все три списка:
  // высота панели должна быть предсказуемой, иначе строка грида растягивается
  // по самой длинной панели и под короткой зияет дыра (было 250px при 5 и 2
  // строках). Полные списки — по ссылке «Все →» в шапке панели.
  var DASH_ROWS = 5;

  async function initDashboard() {
    try {
      var d = await loadAll();
      var today = astanaTodayStr();
      var weekEnd = toAstanaStr(new Date(Date.now() + 7*86400000));
      var todayVisits = d.visits.filter(function(v){ return !v.is_deleted && (v.date||'').slice(0,10)===today; });
      var dueVacc = d.vaccinations.filter(function(v){ return !v.is_deleted && v.next_due_at && v.next_due_at.slice(0,10)>=today && v.next_due_at.slice(0,10)<=weekEnd; });

      // Животные с активным курсом: приём, у которого treatment_until не в прошлом.
      // Один питомец может иметь несколько курсов — считаем уникальные id.
      var onTreatmentIds = {};
      d.visits.forEach(function(v){
        if (v.is_deleted || !v.treatment_until) return;
        if (v.treatment_until.slice(0,10) >= today) onTreatmentIds[v.pet_id] = v;
      });
      var onTreatmentPets = Object.keys(onTreatmentIds);

      setText('stat-visits-today',     todayVisits.length);
      setText('stat-on-treatment',     onTreatmentPets.length);
      setText('stat-vaccinations-due', dueVacc.length);

      // Записи нужны и четвёртой карточке, и виджету ниже — грузим один раз.
      var allAppts = [];
      try { allAppts = await window.VetDB.getAll('appointments'); } catch(e) {}

      // Четвёртая карточка — под роль: врач видит свои приёмы, остальные —
      // загрузку на завтра. Денег на дашборде нет намеренно: планшет стоит
      // на виду, и сумма дневного дохода читается любым клиентом у стойки.
      // Выручка живёт в «Отчётах», куда нужно зайти осознанно.
      var roleCard = document.getElementById('stat-card-role');
      if (roleCard) {
        var u = window.VetAuth ? VetAuth.user() : null;
        if (u && u.staff_id) {
          var mine = todayVisits.filter(function(v){ return v.staff_id === u.staff_id; });
          setText('stat-role-value', mine.length);
          setText('stat-role-label', 'Мои приёмы сегодня ↗');
          roleCard.onclick = function(){ goVisitsToday(); };
          roleCard.style.display = '';
        } else if (u) {
          var tomorrow = toAstanaStr(new Date(Date.now() + 86400000));
          var tomorrowAppts = allAppts.filter(function(a){
            return !a.is_deleted && a.status === 'scheduled'
              && (a.starts_at||'').slice(0,10) === tomorrow;
          });
          setText('stat-role-value', tomorrowAppts.length);
          setText('stat-role-label', 'Записей на завтра ↗');
          roleCard.onclick = function(){ navigate('schedule'); };
          roleCard.style.display = '';
        } else {
          roleCard.style.display = 'none';
        }
      }

      // Recent visits
      var petsMap  = buildMap(d.pets);
      var ownersMap = buildMap(d.owners);
      var staffMapD = buildMap(d.staff);

      // Виджет «Записи на сегодня» — расписание видно прямо с обзора
      var apptsEl = document.getElementById('dash-appts');
      if (apptsEl) {
        var todayAppts = allAppts.filter(function(a) {
          return !a.is_deleted && (a.starts_at||'').slice(0,10) === today && a.status === 'scheduled';
        }).sort(function(a,b){ return (a.starts_at||'') < (b.starts_at||'') ? -1 : 1; }).slice(0, DASH_ROWS);
        apptsEl.innerHTML = todayAppts.length
          ? todayAppts.map(function(a) {
              var pet = a.pet_id ? petsMap[a.pet_id] : null;
              var owner = a.owner_id ? ownersMap[a.owner_id] : (pet ? ownersMap[pet.owner_id] : null);
              var petName = pet ? pet.name : (a.pet_name || 'Без клички');
              var who = owner ? owner.fio : (a.client_name || '');
              var doc = a.staff_id && staffMapD[a.staff_id] ? staffMapD[a.staff_id].name.split(' ')[0] : '';
              return '<div class="erow" onclick="navigate(\'schedule\')">'
                + '<span class="dash-appt-time">' + esc((a.starts_at||'').slice(11,16)) + '</span>'
                + '<div class="erow-body"><div class="erow-title">' + esc(petName) + '</div>'
                + '<div class="erow-sub">' + esc(who) + (a.reason ? ' · ' + esc(a.reason) : '') + '</div></div>'
                + (doc ? '<div class="erow-right"><span class="badge badge-course">' + esc(doc) + '</span></div>' : '')
                + '</div>';
            }).join('')
          : emptyState('Записей нет — день свободен', 'Записать клиента', "navigate('schedule')");
      }

      // ── Рабочий список «требуют внимания» ──────────────────────────
      // Одна очередь задач на день вместо трёх разрозненных отчётов:
      //   1) неподтверждённые заявки с портала  2) просроченные прививки
      //   3) не вернувшиеся на повторный приём. У каждой — кнопка «Позвонить».
      var attention = [];
      // 1) Заявки с портала, ждущие подтверждения
      allAppts.filter(function(a){
        return !a.is_deleted && a.status === 'scheduled' && a.source === 'portal' && a.confirmed === 0;
      }).forEach(function(a){
        var pet = a.pet_id ? petsMap[a.pet_id] : null;
        var owner = a.owner_id ? ownersMap[a.owner_id] : (pet ? ownersMap[pet.owner_id] : null);
        attention.push({
          icon: 'calendar', tone: 'warn',
          title: 'Заявка с портала: ' + esc((a.pet_id&&pet?pet.name:a.pet_name)||'—'),
          sub: fmtDate(a.starts_at) + ' ' + (a.starts_at||'').slice(11,16) + ' · ' + esc(owner?owner.fio:(a.client_name||'')),
          phone: (owner?owner.phone:a.client_phone) || '',
          onclick: "VetPages.editAppt('"+a.id+"')",
          sortKey: '0'+(a.starts_at||'')
        });
      });
      // 2) Просроченные вакцинации (next_due_at в прошлом), активные питомцы
      var vaccByPet = {};
      (d.vaccinations||[]).forEach(function(v){
        if (v.is_deleted || !v.next_due_at) return;
        var pid = v.pet_id;
        if (!vaccByPet[pid] || (v.next_due_at||'') > (vaccByPet[pid].next_due_at||'')) vaccByPet[pid] = v;
      });
      Object.keys(vaccByPet).forEach(function(pid){
        var v = vaccByPet[pid];
        if ((v.next_due_at||'').slice(0,10) >= today) return; // ещё не просрочена
        var pet = petsMap[pid];
        if (!pet || pet.is_deleted || pet.status !== 'active') return;
        var owner = ownersMap[pet.owner_id];
        attention.push({
          icon: 'syringe', tone: 'danger',
          title: 'Просрочена прививка: ' + esc(pet.name),
          sub: esc(v.vaccine_name||'') + ' · срок был ' + fmtDate(v.next_due_at) + ' · ' + esc(owner?owner.fio:''),
          phone: owner ? owner.phone : '',
          onclick: "VetPages.showPetCard('"+pid+"')",
          sortKey: '1'+(v.next_due_at||'')
        });
      });
      // 3) Не вернулись на повторный: последний визит с next_visit_date в прошлом
      //    и без последующего визита.
      var latestByPet = {};
      d.visits.filter(function(v){ return !v.is_deleted; }).forEach(function(v){
        if (!latestByPet[v.pet_id] || (v.date||'') > (latestByPet[v.pet_id].date||'')) latestByPet[v.pet_id] = v;
      });
      Object.keys(latestByPet).forEach(function(pid){
        var v = latestByPet[pid];
        if (!v.next_visit_date || (v.next_visit_date||'').slice(0,10) >= today) return;
        var hasNewer = d.visits.some(function(v2){
          return !v2.is_deleted && v2.pet_id === pid && (v2.date||'') > (v.next_visit_date||'') && v2.id !== v.id;
        });
        if (hasNewer) return;
        var pet = petsMap[pid]; if (!pet || pet.is_deleted || pet.status !== 'active') return;
        var owner = ownersMap[pet.owner_id];
        attention.push({
          icon: 'clock', tone: 'blue',
          title: 'Не пришёл на повторный: ' + esc(pet.name),
          sub: 'ждали ' + fmtDate(v.next_visit_date) + ' · ' + esc(owner?owner.fio:''),
          phone: owner ? owner.phone : '',
          onclick: "VetPages.showPetCard('"+pid+"')",
          sortKey: '2'+(v.next_visit_date||'')
        });
      });

      var attCard = document.getElementById('dash-attention-card');
      var attEl = document.getElementById('dash-attention');
      var attCount = document.getElementById('dash-attention-count');
      if (attCard && attEl) {
        if (!attention.length) {
          attCard.style.display = 'none';
        } else {
          attention.sort(function(a,b){ return a.sortKey < b.sortKey ? -1 : 1; });
          if (attCount) attCount.textContent = attention.length;
          attEl.innerHTML = attention.slice(0, 12).map(function(x){
            var callBtn = x.phone
              ? '<a class="btn btn-icon btn-open" href="tel:'+esc(String(x.phone).replace(/[^\d+]/g,''))+'" onclick="event.stopPropagation();" title="Позвонить">'+I('phone')+'</a>'
              : '';
            return '<div class="erow" onclick="'+x.onclick+'">'
              + '<span class="att-icon att-'+x.tone+'">'+I(x.icon)+'</span>'
              + '<div class="erow-body"><div class="erow-title">'+x.title+'</div>'
              + '<div class="erow-sub">'+x.sub+'</div></div>'
              + '<div class="erow-right">'+callBtn+'</div>'
              + '</div>';
          }).join('')
          + (attention.length > 12 ? '<div class="list-more"><span class="text-muted text-sm">…и ещё '+(attention.length-12)+'</span></div>' : '');
          attCard.style.display = '';
        }
      }

      var recentVisits = d.visits.filter(function(v){ return !v.is_deleted; }).sort(function(a,b){
        return new Date(b.date) - new Date(a.date);
      }).slice(0, DASH_ROWS);

      var recentEl = document.getElementById('recent-visits');
      if (!recentEl) return;
      if (!recentVisits.length) { recentEl.innerHTML = emptyState('Приёмов ещё нет', '+ Новый приём', 'VetPages.newVisit()'); return; }
      recentEl.innerHTML = recentVisits.map(function(v) {
        var pet = petsMap[v.pet_id] || {};
        var owner = ownersMap[pet.owner_id] || {};
        var visitTypeBadge = v.visit_type === 'вторичный' ? '<span class="badge badge-service" style="margin-left:6px;">Вторичный</span>' : '';
        return '<div class="erow" onclick="VetPages.editVisit(\''+v.id+'\')">'
          +UI.avatar(pet.name||'?',pet.type)
          +'<div class="erow-body"><div class="erow-title">'+esc(pet.name||'Неизвестно')+visitTypeBadge+'</div>'
          +'<div class="erow-sub">'+esc(owner.fio||'')+' · '+esc(v.diagnosis||v.anamnesis||'Без диагноза')+'</div></div>'
          // Суммы на главной не показываем: планшет стоит на виду, и клиент
          // у стойки видел бы, сколько заплатил предыдущий. В списке приёмов
          // и в отчётах суммы на месте — туда заходят осознанно.
          +'<div class="erow-right"><span class="erow-date">'+fmtDate(v.date)+'</span>'
          +'</div></div>';
      }).join('');

      // Виджет «На лечении»: животные с активным курсом, у кого раньше кончается — выше.
      var treatEl = document.getElementById('dash-treatment');
      if (treatEl) {
        var courses = onTreatmentPets.map(function(pid){
          var v = onTreatmentIds[pid];
          var pet = petsMap[pid] || {};
          var until = v.treatment_until.slice(0,10);
          var daysLeft = Math.round((new Date(until) - new Date(today)) / 86400000) + 1;
          return { pet: pet, until: until, daysLeft: daysLeft };
        }).sort(function(a,b){ return a.until < b.until ? -1 : 1; }).slice(0, DASH_ROWS);

        treatEl.innerHTML = courses.length
          ? courses.map(function(c){
              return '<div class="erow" onclick="VetPages.showPetCard(\''+c.pet.id+'\')">'
                + UI.avatar(c.pet.name||'?', c.pet.type)
                + '<div class="erow-body"><div class="erow-title">'+esc(c.pet.name||'—')+'</div>'
                + '<div class="erow-sub">'+esc(c.pet.type||'')+(c.pet.breed?' · '+esc(c.pet.breed):'')+'</div></div>'
                + '<div class="erow-right"><span class="badge badge-course">'+I('heart')+' '+c.daysLeft+' дн.</span></div>'
                + '</div>';
            }).join('')
          : emptyState('Никто не на лечении');
      }
    } catch(e) { console.error('[Dashboard]', e); }
  }

  function setText(id, val) { var el=document.getElementById(id); if(el) el.textContent=String(val); }
  function buildMap(arr) { var m={}; (arr||[]).forEach(function(x){ m[x.id]=x; }); return m; }

  // Скелетон загрузки: несколько «пустых» строк с шиммером вместо голого
  // текста «Загрузка…». На планшете при рефреше меньше моргает и ощущается
  // быстрее. Ширины детерминированы (не случайны), чтобы блок не «дрожал».
  var _skWidths = [58, 42, 66, 48, 60, 52];
  function skeletonRows(n) {
    n = n || 5;
    var s = '<div class="skeleton-list" aria-hidden="true">';
    for (var i = 0; i < n; i++) {
      s += '<div class="skeleton-row"><div class="skeleton-bar" style="width:' + _skWidths[i % _skWidths.length] + '%"></div></div>';
    }
    return s + '</div>';
  }

  // ═══════════════════════════════════════════════════════════════════════
  // OWNERS
  // ═══════════════════════════════════════════════════════════════════════
  var _owners = [], _petsMap = {};
  var _ownersLimit = 60; // порция рендера — база растёт, весь архив на страницу не льём

  async function initOwners() {
    var [owners, pets] = await Promise.all([api('GET','/owners'), api('GET','/pets?status=all')]);
    _owners = owners || [];
    _petsMap = buildMap(pets || []);
    _ownersLimit = 60;
    renderOwnerList(_owners, '');
    setupSearch('search-owners', function(q){ _ownersLimit = 60; renderOwnerList(_owners, q); });
    document.getElementById('btn-add-owner').onclick = addOwner;
  }

  function _ownersShowMore() { _ownersLimit += 60; renderOwnerList(); }

  function renderOwnerList(owners, q) {
    owners = owners || _owners;
    q = typeof q === 'string' ? q : (document.getElementById('search-owners')||{}).value || '';
    if (q) owners = owners.filter(function(o){ return !o.is_deleted && (o.fio+' '+o.phone+' '+o.iin).toLowerCase().includes(q.toLowerCase()); });
    else owners = owners.filter(function(o){ return !o.is_deleted; });
    owners.sort(function(a,b){ return a.fio.localeCompare(b.fio, 'ru'); });
    var el = document.getElementById('owners-list');
    if (!el) return;
    if (!owners.length) {
      el.innerHTML = q ? searchEmpty('search-owners') : emptyState('Владельцев ещё нет', '+ Добавить', 'VetPages.addOwner()', 'user');
      return;
    }
    var ownersTotal = owners.length;
    var ownersMore = ownersTotal > _ownersLimit;
    if (ownersMore) owners = owners.slice(0, _ownersLimit);
    var petCountMap = {};
    Object.values(_petsMap).forEach(function(p){ if(!p.is_deleted && p.status==='active') petCountMap[p.owner_id] = (petCountMap[p.owner_id]||0)+1; });
    el.innerHTML = owners.map(function(o) {
      var cnt = petCountMap[o.id] || 0;
      return '<div class="erow" onclick="VetPages.showOwnerCard(\''+o.id+'\')">'
        + UI.avatar(o.fio, 'owner')
        + '<div class="erow-body">'
        + '<div class="erow-title">'+hl(o.fio,q)+'</div>'
        + '<div class="erow-sub">'+hl(o.phone||'',q)+(o.iin?' &nbsp;·&nbsp; ИИН: '+hl(o.iin,q):'')+'</div>'
        + (o.address ? '<div class="erow-extra">'+I('pin')+' '+esc(o.address)+'</div>' : '')
        + '</div>'
        + '<div class="erow-right">'
        + (cnt ? '<span class="badge badge-active">'+cnt+' пит.</span>' : '<span style="font-size:.72rem;color:var(--text-3);">нет питомцев</span>')
        + '<div class="erow-actions">'
        + '<button class="btn btn-icon" onclick="event.stopPropagation();VetPages.editOwner(\''+o.id+'\')" title="Редактировать" aria-label="Редактировать">'+UI.icon('edit','')+'</button>'
        + UI.rowMenu([
            {label:'Печать карточки', icon:'print', onclick:"VetPages.printOwnerCard('"+o.id+"')"},
            {sep:true},
            {label:'Удалить', icon:'trash', danger:true, onclick:"VetPages.deleteOwner('"+o.id+"','"+esc(o.fio)+"')"}
          ])
        + '</div></div></div>';
    }).join('')
    + (ownersMore
        ? '<div class="list-more"><button class="btn btn-ghost" onclick="VetPages._ownersShowMore()">Показать ещё (' + (ownersTotal - _ownersLimit) + ')</button></div>'
        : '');
  }

  async function addOwner() {
    UI.showModal({ title: 'Новый владелец', bodyHTML: UI.ownerFormHTML(), size: 'lg',
      onSave: async function() {
        var d = UI.ownerFormData();
        if (!d.fio || !d.phone) { UI.toast('Заполните обязательные поля', 'err'); return; }
        try {
          await api('POST', '/owners', d);
          UI.toast('Владелец добавлен', 'ok');
          UI.hideModal();
          await initOwners();
        } catch(e) { UI.toast(e.message, 'err'); }
      }
    });
  }

  async function editOwner(id) {
    var owner = _owners.find(function(o){ return o.id === id; });
    if (!owner) return;
    UI.showModal({ title: 'Редактировать владельца', bodyHTML: UI.ownerFormHTML(owner), size: 'lg',
      onSave: async function() {
        var d = UI.ownerFormData();
        if (!d.fio || !d.phone) { UI.toast('Заполните обязательные поля', 'err'); return; }
        try {
          await api('PUT', '/owners/' + id, d);
          UI.toast('Сохранено', 'ok');
          UI.hideModal();
          await initOwners();
        } catch(e) { UI.toast(e.message, 'err'); }
      }
    });
  }

  async function deleteOwner(id, name) {
    var ok = await UI.confirm('Удалить владельца?', name + ' и все его животные будут скрыты. Медицинская история сохранится.');
    if (!ok) return;
    try {
      await api('DELETE', '/owners/' + id);
      try { var _b=(window.VetAppConfig&&window.VetAppConfig.apiBase)||'',_n=window.__nativeFetch||window.fetch.bind(window); await _n(_b+'/owners/'+id,{method:'DELETE',headers:{'X-Bypass-Local':'1'}}); } catch(_e) {}
      UI.toast('Удалено', 'ok');
      await initOwners();
    } catch(e) { UI.toast(e.message, 'err'); }
  }

  function openOwnerDetail(id) {
    navigate('pets');
    setTimeout(function(){ document.getElementById('search-pets').value = ''; document.getElementById('filter-owner-id').value = id; renderPetList(); }, 100);
  }

  // ═══════════════════════════════════════════════════════════════════════
  // PETS
  // ═══════════════════════════════════════════════════════════════════════
  var _pets = [], _ownersMap = {};
  var _petStatusFilter = 'active';
  var _coursesByPet = {}; // pet_id -> {treatment_until, days_left} активного курса

  // Строит карту активных курсов лечения по визитам.
  // Активный курс = визит с treatment_until не раньше сегодняшнего дня.
  // Если у животного несколько курсов, берём тот, что кончается позже.
  function buildCourses(visits) {
    var map = {};
    // Именно nowAstana(): toAstanaStr(null) вернул бы пустую строку, и тогда
    // сравнение «курс закончился» всегда ложно, а дней осталось — NaN.
    var today = toAstanaStr(nowAstana());
    (visits || []).forEach(function(v) {
      if (v.is_deleted || !v.treatment_until) return;
      var until = toAstanaStr(v.treatment_until);
      if (until < today) return; // курс уже закончился
      var prev = map[v.pet_id];
      if (prev && prev.until >= until) return;
      map[v.pet_id] = {
        until: until,
        treatment_until: v.treatment_until,
        // Дней осталось, считая сегодняшний: курс «по сегодня» = 1 день.
        days_left: Math.round((new Date(until) - new Date(today)) / 86400000) + 1,
        days: v.treatment_days || 0
      };
    });
    return map;
  }

  function activeCourse(petId) { return _coursesByPet[petId] || null; }

  async function initPets() {
    var [pets, owners, visits] = await Promise.all([
      api('GET','/pets?status=all'), api('GET','/owners'), api('GET','/visits')
    ]);
    _pets = pets || [];
    _ownersMap = buildMap(owners || []);
    _coursesByPet = buildCourses(visits);
    renderPetList();
    _petsLimit = 60;
    setupSearch('search-pets', function(q){ _petsLimit = 60; renderPetList(); });

    document.getElementById('filter-pet-status').onchange = function() { _petStatusFilter = this.value; _petsLimit = 60; renderPetList(); };
    document.getElementById('btn-add-pet').onclick = addPet;

    // Owner filter
    var ownerFilter = document.getElementById('filter-owner-id');
    if (ownerFilter) ownerFilter.onchange = renderPetList;
  }

  var _petsLimit = 60;
  function _petsShowMore() { _petsLimit += 60; renderPetList(); }

  function renderPetList() {
    var q = (document.getElementById('search-pets')||{}).value || '';
    var ownerFilter = (document.getElementById('filter-owner-id')||{}).value || '';
    var status = _petStatusFilter || 'active';

    var pets = _pets.filter(function(p) {
      if (p.is_deleted) return false;
      // "На лечении" — животные с активным курсом; это не значение pets.status,
      // а вычисляемый признак, поэтому фильтруем отдельной веткой.
      if (status === 'on-treatment') {
        if (!activeCourse(p.id)) return false;
      } else if (status !== 'all' && p.status !== status) {
        return false;
      }
      if (ownerFilter && p.owner_id !== ownerFilter) return false;
      if (q) {
        var qn = q.toLowerCase();
        var hay = (p.name + ' ' + (p.breed||'') + ' ' + (p.type||'')).toLowerCase();
        // Поиск по номеру чипа: сверяем по цифрам, чтобы ввод с пробелами
        // или дефисами со сканера тоже находил животное.
        var chipDigits = String(p.chip_number||'').replace(/\D/g,'');
        var qDigits = qn.replace(/\D/g,'');
        return hay.includes(qn) || (qDigits && chipDigits && chipDigits.includes(qDigits));
      }
      return true;
    });
    pets.sort(function(a,b){ return a.name.localeCompare(b.name,'ru'); });

    var el = document.getElementById('pets-list');
    if (!el) return;
    if (!pets.length) {
      el.innerHTML = q ? searchEmpty('search-pets') : emptyState('Животных нет', '+ Добавить', 'VetPages.addPet()', 'paw');
      return;
    }
    var petsTotal = pets.length;
    var petsMore = petsTotal > _petsLimit;
    if (petsMore) pets = pets.slice(0, _petsLimit);

    el.innerHTML = pets.map(function(p) {
      var owner = _ownersMap[p.owner_id] || {};
      var statusBadge = p.status !== 'active' ? '<span class="badge badge-'+p.status+'">'+(p.status==='deceased'?'Умер':p.status==='lost'?'Потерян':'Передан')+'</span>' : '';
      // Активный курс лечения. Считается на лету из визитов, а не хранится
      // в pets.status: статус в базе протух бы в тот же день, когда курс кончился,
      // а фоновых задач на офлайн-планшете нет.
      var course = activeCourse(p.id);
      var courseBadge = course
        ? '<span class="badge badge-course" title="Курс лечения до '+fmtDate(course.treatment_until)+'">'
          + I('heart') + ' Лечение: ' + course.days_left + ' дн.</span>'
        : '';
      var deceasedItem = p.status==='active' ? [{label:'Отметить «умер»', icon:'skull', onclick:"VetPages.markDeceased('"+p.id+"')"}] : [];
      var petAvatar = p.photo
        ? '<img class="pet-photo" src="'+p.photo+'" alt="'+UI.esc(p.name)+'">'
        : UI.avatar(p.name,p.type);
      return '<div class="erow" onclick="VetPages.showPetCard(\''+p.id+'\')">'+petAvatar
        +'<div class="erow-body">'
        +'<div class="erow-title">'+hl(p.name,q)+' '+statusBadge+courseBadge+'</div>'
        +'<div class="erow-sub">'+esc(p.type||'')+(p.breed?' · '+esc(p.breed):'')+(p.chip_number?' · '+I('tag')+' '+esc(p.chip_number):'')+' · '+esc(owner.fio||'')+'</div>'
        +(p.death_date?'<div class="erow-meta">Умер: '+fmtDate(p.death_date)+(p.death_reason?' · '+esc(p.death_reason):'')+' </div>':'')
        +'</div>'
        +'<div class="erow-right"><div class="erow-actions">'
        +'<button class="btn btn-icon" onclick="event.stopPropagation();VetPages.newVisitForPet(\''+p.id+'\')" title="Новый приём" aria-label="Новый приём">'+UI.icon('plus','')+'</button>'
        +'<button class="btn btn-icon" onclick="event.stopPropagation();VetPages.editPet(\''+p.id+'\')" title="Редактировать" aria-label="Редактировать">'+UI.icon('edit','')+'</button>'
        +UI.rowMenu([
            {label:'История приёмов', icon:'clipboard', onclick:"VetPages.showPetHistory('"+p.id+"')"},
            {label:'Печать паспорта', icon:'print', onclick:"VetPages.printPetCard('"+p.id+"')"}
          ].concat(deceasedItem).concat([
            {sep:true},
            {label:'Удалить', icon:'trash', danger:true, onclick:"VetPages.deletePet('"+p.id+"','"+esc(p.name)+"')"}
          ]))
        +'</div></div></div>';
    }).join('')
    + (petsMore
        ? '<div class="list-more"><button class="btn btn-ghost" onclick="VetPages._petsShowMore()">Показать ещё (' + (petsTotal - _petsLimit) + ')</button></div>'
        : '');
  }

  async function addPet() {
    var owners = Object.values(_ownersMap).filter(function(o){ return !o.is_deleted; }).sort(function(a,b){ return a.fio.localeCompare(b.fio,'ru'); });
    var ownerSelect = '<div class="form-group form-span-2"><label class="form-label">Владелец <span class="form-req">*</span></label><select id="f-owner-sel" class="form-select"><option value="">— Выберите владельца —</option>' + owners.map(function(o){ return '<option value="'+o.id+'">'+esc(o.fio)+' · '+esc(o.phone||'')+'</option>'; }).join('') + '</select></div>';
    UI.showModal({ title: 'Новое животное', bodyHTML: '<div class="form-grid">' + ownerSelect + '</div>' + UI.petFormHTML(), size: 'lg',
      afterOpen: UI.checkChip,
      afterOpen: function() { UI.petFormAfterOpen(); },
      onSave: async function() {
        var d = UI.petFormData();
        var ownerSel = document.getElementById('f-owner-sel');
        if (ownerSel) d.owner_id = ownerSel.value;
        if (!d.name) { UI.toast('Введите кличку', 'err'); return; }
        if (!d.owner_id) { UI.toast('Выберите владельца', 'err'); return; }
        if (!d.gender) { UI.toast('Укажите пол', 'err'); return; }
        try {
          await api('POST', '/pets', d);
          UI.toast('Животное добавлено', 'ok');
          UI.hideModal();
          await initPets();
        } catch(e) { UI.toast(e.message, 'err'); }
      }
    });
  }

  async function editPet(id) {
    var pet = _pets.find(function(p){ return p.id === id; });
    if (!pet) return;
    var ownerName = (_ownersMap[pet.owner_id]||{}).fio || '';
    UI.showModal({ title: 'Редактировать: ' + pet.name, bodyHTML: UI.petFormHTML(pet, ownerName), size: 'lg',
      afterOpen: UI.checkChip,
      afterOpen: function() { UI.petFormAfterOpen(); },
      onSave: async function() {
        var d = UI.petFormData();
        d.owner_id = pet.owner_id;
        if (!d.name) { UI.toast('Введите кличку', 'err'); return; }
        try {
          await api('PUT', '/pets/' + id, d);
          UI.toast('Сохранено', 'ok');
          UI.hideModal();
          await initPets();
        } catch(e) { UI.toast(e.message, 'err'); }
      }
    });
  }

  async function deletePet(id, name) {
    var ok = await UI.confirm('Удалить животное?', name + ' · История лечения сохранится в архиве.');
    if (!ok) return;
    try {
      await api('DELETE', '/pets/' + id);
      try { var _b=(window.VetAppConfig&&window.VetAppConfig.apiBase)||'',_n=window.__nativeFetch||window.fetch.bind(window); await _n(_b+'/pets/'+id,{method:'DELETE',headers:{'X-Bypass-Local':'1'}}); } catch(_e) {}
      UI.toast('Удалено', 'ok');
      await initPets();
    } catch(e) { UI.toast(e.message, 'err'); }
  }

  async function markDeceased(id) {
    var pet = _pets.find(function(p){ return p.id===id; });
    if (!pet) return;
    UI.showModal({ title: 'Отметить как умершее', bodyHTML: UI.deceasedFormHTML(pet), size: '',
      saveLabel: 'Подтвердить', onSave: async function() {
        var deathDate = document.getElementById('f-death-date').value;
        var deathReason = document.getElementById('f-death-reason').value.trim();
        if (!deathDate) { UI.toast('Укажите дату смерти', 'err'); return; }
        try {
          await api('PUT', '/pets/' + id + '/deceased', { death_date: deathDate, death_reason: deathReason });
          UI.toast('Статус обновлён', 'ok');
          UI.hideModal();
          await initPets();
        } catch(e) { UI.toast(e.message, 'err'); }
      }
    });
  }

  // ═══════════════════════════════════════════════════════════════════════
  // VISITS
  // ═══════════════════════════════════════════════════════════════════════
  var _visits = [], _vpetsMap = {}, _vownersMap = {}, _vitems = [];
  // «Сегодня» по умолчанию: список за всё время растёт бесконечно,
  // а врач в 95% случаев смотрит текущий день.
  var _visitDateFilter = 'today';
  var _visitDoctorFilter = '';
  var _visitRenderLimit = 60; // порция рендера — весь архив на страницу не льём
  var _pendingVisitFilter = null; // фильтр, который нужно применить при следующем initVisits

  async function initVisits() {
    // Применяем pending-фильтр если был задан извне (например, из дашборда)
    if (_pendingVisitFilter !== null) {
      _visitDateFilter = _pendingVisitFilter;
      _pendingVisitFilter = null;
    }

    var data = await loadAll();
    _visits   = data.visits || [];
    _vpetsMap  = buildMap(data.pets || []);
    _vownersMap = buildMap(data.owners || []);
    _vitems    = data.items || [];
    renderVisitList();
    setupSearch('search-visits', function(q){ renderVisitList(); });

    var dateFilter = document.getElementById('visit-date-filter');
    if (dateFilter) {
      // Активируем нужную кнопку фильтра
      dateFilter.querySelectorAll('.filter-btn').forEach(function(btn) {
        btn.classList.toggle('active', btn.dataset.period === _visitDateFilter);
        btn.onclick = function() {
          dateFilter.querySelectorAll('.filter-btn').forEach(function(b){ b.classList.remove('active'); });
          btn.classList.add('active');
          _visitDateFilter = btn.dataset.period;
          _visitRenderLimit = 60;
          renderVisitList();
        };
      });
    }

    // Фильтр по врачу
    var docSel = document.getElementById('visit-doctor-filter');
    if (docSel) {
      var staffList = (data.staff||[]).filter(function(s){ return !s.is_deleted && s.is_active !== false; })
        .sort(function(a,b){ return (a.name||'').localeCompare(b.name||'','ru'); });
      docSel.innerHTML = '<option value="">Все врачи</option>'
        + staffList.map(function(s){ return '<option value="'+esc(s.id)+'"'+(s.id===_visitDoctorFilter?' selected':'')+'>'+esc(s.name)+'</option>'; }).join('');
      docSel.onchange = function() {
        _visitDoctorFilter = docSel.value;
        _visitRenderLimit = 60;
        renderVisitList();
      };
    }

    document.getElementById('btn-add-visit').onclick = newVisit;
  }

  function renderVisitList() {
    var q = (document.getElementById('search-visits')||{}).value || '';
    var now = nowAstana();
    var todayStr = astanaTodayStr();
    var weekStart = new Date(now); weekStart.setDate(weekStart.getDate() - 7);

    var visits = _visits.filter(function(v) {
      if (v.is_deleted) return false;
      if (q) {
        var pet = _vpetsMap[v.pet_id] || {};
        var owner = _vownersMap[pet.owner_id] || {};
        var searchable = (v.diagnosis+' '+v.anamnesis+' '+pet.name+' '+owner.fio).toLowerCase();
        if (!searchable.includes(q.toLowerCase())) return false;
      }
      if (_visitDoctorFilter && v.staff_id !== _visitDoctorFilter) return false;
      if (_visitDateFilter === 'today') return (v.date||'').slice(0,10) === todayStr;
      if (_visitDateFilter === 'week')  return new Date(v.date) >= weekStart;
      return true;
    });
    visits.sort(function(a,b){ return new Date(b.date)-new Date(a.date); });

    var el = document.getElementById('visits-list');
    if (!el) return;
    if (!visits.length) {
      el.innerHTML = q ? searchEmpty('search-visits')
                       : emptyState('Приёмов нет', '+ Новый приём', 'VetPages.newVisit()', 'clipboard');
      return;
    }

    var totalCount = visits.length;
    var showMore = totalCount > _visitRenderLimit;
    if (showMore) visits = visits.slice(0, _visitRenderLimit);

    el.innerHTML = visits.map(function(v) {
      var pet   = _vpetsMap[v.pet_id] || {};
      var owner = _vownersMap[pet.owner_id] || {};
      var vtTag = v.visit_type==='вторичный'
        ? '<span class="visit-type-tag secondary">Повторный</span>'
        : '<span class="visit-type-tag">Первичный</span>';
      return '<div class="erow" onclick="VetPages.editVisit(\''+v.id+'\')">'
        +UI.avatar(pet.name||'?',pet.type)
        +'<div class="erow-body">'
        +'<div class="erow-title">'+esc(pet.name||'Неизвестно')+vtTag+'</div>'
        +'<div class="erow-sub">'+esc(owner.fio||'')+(v.diagnosis?' · '+esc(v.diagnosis):(v.anamnesis?' · '+esc(v.anamnesis):''))+'</div>'
        +((v.animal_weight||v.next_visit_date)?'<div class="erow-extra">'
          +(v.animal_weight?''+I('scale')+' '+v.animal_weight+' кг':'')
          +(v.animal_weight&&v.next_visit_date?' &nbsp;·&nbsp; ':'')
          +(v.next_visit_date?''+I('calendar')+' Сл. приём: '+fmtDate(v.next_visit_date):'')
          +'</div>':'')
        +'</div>'
        +'<div class="erow-right">'
        +'<span class="erow-date">'+fmtDate(v.date)+'</span>'
        +(v.total_amount?(window.VetAuth&&!VetAuth.canSeeSum(v.staff_id)?'<span class="erow-amount" title="Сумма скрыта настройками прав">···</span>':'<span class="erow-amount">'+Number(v.total_amount).toFixed(0)+' ₸</span>'):'')
        +'<div class="erow-actions">'
        +'<button class="btn btn-icon" onclick="event.stopPropagation();VetPages.editVisit(\''+v.id+'\')" title="Открыть приём" aria-label="Открыть приём">'+UI.icon('edit','')+'</button>'
        +UI.rowMenu([
            {label:'Печать для владельца', icon:'print', onclick:"VetPages.printVisitCard('"+v.id+"')"},
            {label:'Копировать приём', icon:'clipboard', onclick:"VetPages.copyVisit('"+v.id+"')"},
            {sep:true},
            {label:'Удалить', icon:'trash', danger:true, onclick:"VetPages.deleteVisit('"+v.id+"')"}
          ])
        +'</div></div></div>';
    }).join('')
    + (showMore
        ? '<div class="list-more">'
          + '<button class="btn btn-ghost" onclick="VetPages._visitsShowMore()">Показать ещё ('
          + (totalCount - _visitRenderLimit) + ')</button></div>'
        : '');
  }

  function _visitsShowMore() {
    _visitRenderLimit += 60;
    renderVisitList();
  }

  async function newVisit(petId) {
    // Получаем время с сервера для дефолтного значения поля даты
    var serverTime = await UI.getServerTime();
    var data = await loadAll();
    var prefillPet   = petId ? (data.pets||[]).find(function(p){ return p.id===petId; }) : null;
    var prefillOwner = prefillPet ? (data.owners||[]).find(function(o){ return o.id===prefillPet.owner_id; }) : null;
    // Автозаполнение веса — берём последний вес из истории приёмов питомца
    var lastWeight = null;
    if (prefillPet) {
      var petVisits = (data.visits||[]).filter(function(v){ return !v.is_deleted && v.pet_id===prefillPet.id && v.animal_weight; });
      petVisits.sort(function(a,b){ return new Date(b.date)-new Date(a.date); });
      if (petVisits.length) lastWeight = petVisits[0].animal_weight;
    }

    // Черновик: форма могла умереть без сохранения (смахнули PWA, сел
    // планшет) — предлагаем продолжить с того же места.
    var draft = UI.getVisitDraft('new');
    if (draft) {
      var restore = await UI.confirm('Незаконченный приём',
        'Найден несохранённый приём. Восстановить введённые данные?',
        { yes: 'Восстановить', no: 'Начать заново' });
      if (!restore) { UI.clearVisitDraft(); draft = null; }
    }
    if (draft) {
      if (!prefillPet && draft.pet_id)     prefillPet   = (data.pets||[]).find(function(p){ return p.id===draft.pet_id; }) || null;
      if (!prefillOwner && draft.owner_id) prefillOwner = (data.owners||[]).find(function(o){ return o.id===draft.owner_id; }) || null;
      if (!prefillOwner && prefillPet)     prefillOwner = (data.owners||[]).find(function(o){ return o.id===prefillPet.owner_id; }) || null;
    }

    UI.showModal({
      title: 'Новый приём', size: 'full',
      bodyHTML: UI.buildVisitFormHTML(serverTime, draft || (lastWeight ? { animal_weight: lastWeight } : null), data.staff||[]),
      saveLabel: 'Сохранить приём',
      afterOpen: function() {
        UI.initVisitForm(data.owners||[], data.pets||[], data.items||[], prefillOwner, prefillPet);
        if (draft) {
          (draft.items||[]).forEach(function(it){ UI.addVisitItemRow(data.items||[], it); });
          UI.applyVisitDraftExtras(draft, data.owners||[], data.pets||[], data.items||[]);
        }
        UI.startVisitDraftAutosave('new');
      },
      onSave: async function() {
        var vs = UI.getVisitState();
        if (!vs.date) { UI.toast('Укажите дату приёма', 'err'); return; }

        var finalOwner = vs.owner;
        var finalPet   = vs.pet;

        // Автоматически создать владельца если в форме новый
        if (!finalOwner && vs.ownerNew) {
          if (!vs.ownerNew.fio)   { UI.toast('Введите ФИО владельца', 'err'); return; }
          if (!vs.ownerNew.phone) { UI.toast('Введите телефон владельца', 'err'); return; }
          try {
            finalOwner = await api('POST', '/owners', vs.ownerNew);
          } catch(e) { UI.toast('Ошибка создания владельца: ' + e.message, 'err'); return; }
        }

        if (!finalOwner) { UI.toast('Выберите или создайте владельца', 'err'); return; }

        // Автоматически создать питомца если в форме новый
        if (!finalPet && vs.petNew) {
          if (!vs.petNew.name) { UI.toast('Введите кличку животного', 'err'); return; }
          try {
            finalPet = await api('POST', '/pets', Object.assign({}, vs.petNew, { owner_id: finalOwner.id }));
          } catch(e) { UI.toast('Ошибка создания животного: ' + e.message, 'err'); return; }
        }

        if (!finalPet) { UI.toast('Выберите или создайте животное', 'err'); return; }

        // Приём без позиций выпадает из выручки в отчётах — предупреждаем.
        if (!vs.items.length) {
          var okNoItems = await UI.confirm('Приём без услуг',
            'Не добавлено ни одной позиции — сумма приёма будет 0 ₸ и приём не попадёт в выручку. Сохранить как есть?',
            { yes: 'Сохранить', no: 'Вернуться' });
          if (!okNoItems) return;
        }

        var grossAmount = vs.items.reduce(function(s,i){ return s + (i.total||0); }, 0);
        var discount = Math.min(vs.discount || 0, grossAmount);
        var totalAmount = Math.max(0, grossAmount - discount);
        if (discount > 0 && !vs.discount_reason) { UI.toast('Укажите причину скидки', 'err'); return; }
        var body = {
          owner: finalOwner,
          pet:   { id: finalPet.id, name: finalPet.name, type: finalPet.type, gender: finalPet.gender||'m', owner_id: finalOwner.id },
          visit: {
            date: vs.date, next_visit_date: vs.next_visit_date||'',
            staff_id: vs.staff_id || '',
            treatment_days: vs.treatment_days || 0,
            visit_type: vs.visit_type, animal_weight: vs.animal_weight,
            patient_condition: vs.condition,
            anamnesis: vs.anamnesis, diagnosis: vs.diagnosis,
            treatment: vs.treatment, notes: vs.notes,
            total_amount: totalAmount, discount: discount, discount_reason: vs.discount_reason || '', payment_card: vs.payment_card || 0,
          },
          items: vs.items,
        };
        try {
          await api('POST', '/visits/full', body);
          UI.clearVisitDraft();
          UI.toast('Приём сохранён', 'ok');
          UI.hideModal();
          await initVisits();
          initDashboard();
          maybeOfferAppointment(vs, finalPet, finalOwner);
        } catch(e) { UI.toast(e.message, 'err'); }
      }
    });
  }

  function newVisitForPet(petId) { navigate('visits'); setTimeout(function(){ newVisit(petId); }, 100); }

  var _prevVisitSnapshot = null;
  async function editVisit(id) {
    // _visits может быть пустым если страница визитов ещё не открывалась
    // (например, клик пришёл с дашборда). Грузим напрямую из IndexedDB.
    var visit = _visits.find(function(v){ return v.id===id; });
    if (!visit) {
      try {
        var allVisits = await window.VetDB.getAll('visits');
        visit = allVisits.find(function(v){ return v.id===id; });
      } catch(e) {}
    }
    if (!visit) { UI.toast('Приём не найден', 'err'); return; }
    var serverTime = await UI.getServerTime();
    var data = await loadAll();
    var pet   = (data.pets||[]).find(function(p){ return p.id===visit.pet_id; });
    var owner = pet ? (data.owners||[]).find(function(o){ return o.id===pet.owner_id; }) : null;
    var visitItems = [];
    try { visitItems = await api('GET', '/visit-items?visit_id='+id); } catch(e) {}

    // Черновик правки этого приёма (форма умерла без сохранения)
    var draft = UI.getVisitDraft('edit:'+id);
    if (draft) {
      var restore = await UI.confirm('Незаконченная правка',
        'Найдена несохранённая правка этого приёма. Восстановить?',
        { yes: 'Восстановить', no: 'Открыть как есть' });
      if (!restore) { UI.clearVisitDraft(); draft = null; }
    }

    UI.showModal({
      title: 'Приём',
      size: 'full',
      bodyHTML: UI.buildVisitFormHTML(serverTime, draft ? Object.assign({}, visit, draft) : visit, data.staff||[]),
      saveLabel: 'Сохранить',
      afterOpen: function() {
        UI.initVisitForm(data.owners||[], data.pets||[], data.items||[], owner, pet);
        if (draft) {
          (draft.items||[]).forEach(function(it){ UI.addVisitItemRow(data.items||[], it); });
        } else {
          visitItems.filter(function(vi){ return !vi.is_deleted; }).forEach(function(vi) {
            UI.addVisitItemRow(data.items||[], vi);
          });
        }
        UI.startVisitDraftAutosave('edit:'+id);

        // Вложения — только у сохранённого приёма: файл нужно к чему-то привязать.
        renderAttachments(id);

        // Обновляем заголовок: добавляем имя питомца и кнопку печати
        var modalTitle = document.getElementById('modal-title');
        var petName = pet ? pet.name : '';
        var ownerName = owner ? owner.fio.split(' ').slice(0,2).join(' ') : '';
        if (modalTitle) {
          modalTitle.innerHTML = '<span>Приём</span>'
            +(petName ? '<span style="color:var(--text-2);font-weight:500;font-size:.9rem;margin-left:10px;">'+esc(petName)+(ownerName?' · '+esc(ownerName):'')+'</span>' : '');
        }

        // Кнопки печати и копирования — вставляются один раз (не дублируются)
        if (id && !document.getElementById('modal-visit-print-btn')) {
          var modalClose = document.getElementById('modal-close-btn');
          if (modalClose && modalClose.parentNode) {
            // Кнопка Копировать приём
            // Кнопка История
            var histBtn = document.createElement('button');
            histBtn.id = 'modal-visit-hist-btn';
            histBtn.className = 'btn btn-ghost btn-sm';
            histBtn.style.cssText = 'margin-right:4px;gap:5px;';
            histBtn.innerHTML = I('clock');
            histBtn.title = 'История изменений';
            histBtn.onclick = function() { showVisitHistory(id); };
            modalClose.parentNode.insertBefore(histBtn, modalClose);
            // Кнопка Копировать
            var copyBtn = document.createElement('button');
            copyBtn.id = 'modal-visit-copy-btn';
            copyBtn.className = 'btn btn-ghost btn-sm';
            copyBtn.style.cssText = 'margin-right:4px;gap:5px;';
            copyBtn.innerHTML = ''+I('clipboard')+' Копировать';
            copyBtn.title = 'Создать копию этого приёма';
            copyBtn.onclick = function() { UI.hideModal(); setTimeout(function(){ copyVisit(id); }, 150); };
            modalClose.parentNode.insertBefore(copyBtn, modalClose);
            // Кнопка Печать
            var printBtn = document.createElement('button');
            printBtn.id = 'modal-visit-print-btn';
            printBtn.className = 'btn btn-ghost btn-sm';
            printBtn.style.cssText = 'margin-right:8px;gap:5px;';
            printBtn.innerHTML = '<svg style="width:14px;height:14px;" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="6 9 6 2 18 2 18 9"/><path d="M6 18H4a2 2 0 0 1-2-2v-5a2 2 0 0 1 2-2h16a2 2 0 0 1 2 2v5a2 2 0 0 1-2 2h-2"/><rect x="6" y="14" width="12" height="8"/></svg> Печать';
            printBtn.title = 'Распечатать карточку для владельца';
            printBtn.onclick = function() { printVisitCard(id); };
            modalClose.parentNode.insertBefore(printBtn, modalClose);
          }
        }
      },
      onSave: async function() {
        var vs = UI.getVisitState();
        if (!vs.date) { UI.toast('Укажите дату приёма', 'err'); return; }

        // Снимаем snapshot старых данных ДО сохранения
        _prevVisitSnapshot = null;
        try {
          var allV = await window.VetDB.getAll('visits');
          var oldV = allV.find(function(x){ return x.id===id; });
          if (oldV) _prevVisitSnapshot = {
            diag:      oldV.diagnosis       || '',
            anamnesis: oldV.anamnesis        || '',
            treat:     oldV.treatment        || '',
            notes:     oldV.notes            || '',
            cond:      oldV.patient_condition|| '',
            vtype:     oldV.visit_type       || '',
            weight:    oldV.animal_weight ? String(oldV.animal_weight) : '',
            next:      oldV.next_visit_date  || '',
            card:      oldV.payment_card ? String(oldV.payment_card) : '0',
            disc:      oldV.discount ? String(oldV.discount) : '0',
            total:     oldV.total_amount     || 0,
          };
        } catch(e2) {}

        var finalOwner = vs.owner;
        var finalPet   = vs.pet;

        if (!finalOwner && vs.ownerNew) {
          if (!vs.ownerNew.fio || !vs.ownerNew.phone) { UI.toast('Заполните данные владельца', 'err'); return; }
          try { finalOwner = await api('POST', '/owners', vs.ownerNew); } catch(e) { UI.toast(e.message, 'err'); return; }
        }
        if (!finalOwner) { UI.toast('Укажите владельца', 'err'); return; }

        if (!finalPet && vs.petNew) {
          if (!vs.petNew.name) { UI.toast('Введите кличку', 'err'); return; }
          try { finalPet = await api('POST', '/pets', Object.assign({}, vs.petNew, { owner_id: finalOwner.id })); } catch(e) { UI.toast(e.message, 'err'); return; }
        }
        if (!finalPet) { UI.toast('Укажите животное', 'err'); return; }

        if (!vs.items.length) {
          var okNoItems = await UI.confirm('Приём без услуг',
            'В приёме не осталось ни одной позиции — сумма будет 0 ₸ и приём выпадет из выручки. Сохранить как есть?',
            { yes: 'Сохранить', no: 'Вернуться' });
          if (!okNoItems) return;
        }

        var grossAmount = vs.items.reduce(function(s,i){ return s+(i.total||0); }, 0);
        var discount = Math.min(vs.discount || 0, grossAmount);
        var totalAmount = Math.max(0, grossAmount - discount);
        if (discount > 0 && !vs.discount_reason) { UI.toast('Укажите причину скидки', 'err'); return; }

        // Загружаем актуальные позиции ДО основного try — чтобы ошибка не съела toast.
        // Объединяем closure-список (был при открытии) со свежим из IndexedDB.
        var currentItemIds = {};
        visitItems.filter(function(vi){ return !vi.is_deleted; }).forEach(function(vi){ currentItemIds[vi.id]=vi; });
        try {
          var freshVI = await window.VetDB.getAll('visit_items');
          freshVI.filter(function(vi){ return !vi.is_deleted && vi.visit_id===id; })
                 .forEach(function(vi){ currentItemIds[vi.id]=vi; });
        } catch(ignoreErr) {}
        var currentItems = Object.values(currentItemIds);

        try {
          // История ПЕРЕД PUT — чтобы vs._change_log был готов до отправки
          await _visitHistorySave(id, vs, _prevVisitSnapshot);
          _prevVisitSnapshot = null;
          await api('PUT', '/visits/'+id, {
            pet_id: finalPet.id,
            staff_id: vs.staff_id || '',
            date: vs.date, patient_condition: vs.condition,
            visit_type: vs.visit_type,
            animal_weight: vs.animal_weight,
            next_visit_date: vs.next_visit_date||'',
            treatment_days: vs.treatment_days || 0,
            anamnesis: vs.anamnesis, diagnosis: vs.diagnosis,
            treatment: vs.treatment, notes: vs.notes,
            total_amount: totalAmount, discount: discount, discount_reason: vs.discount_reason || '', payment_card: vs.payment_card || 0,
            change_log: vs._change_log || '',
          });
          // Сохранение правки = удалить все позиции и создать заново.
          // Если удаление не прошло, а создание прошло — в приёме останутся
          // и старые, и новые позиции, то есть дубли и задвоенная сумма.
          // Поэтому ошибку удаления не глотаем: врач должен узнать сразу.
          var failedDeletes = 0;
          for (var i = 0; i < currentItems.length; i++) {
            try {
              await api('DELETE', '/visit-items/'+currentItems[i].id);
            } catch(e) {
              failedDeletes++;
              console.error('[VetPages] не удалось удалить позицию', currentItems[i].id, e);
            }
          }
          if (failedDeletes) {
            UI.toast('Не удалось обновить позиции ('+failedDeletes+' шт). Приём сохранён, но список услуг мог задвоиться — проверьте.', 'err', 8000);
          }
          for (var j = 0; j < vs.items.length; j++) {
            await api('POST', '/visit-items', Object.assign({ visit_id: id }, vs.items[j]));
          }
          UI.clearVisitDraft();
          if (!failedDeletes) UI.toast('Приём обновлён', 'ok');
          UI.hideModal();
          await initVisits();
          maybeOfferAppointment(vs, finalPet, finalOwner);
        } catch(e) { UI.toast(e.message, 'err'); }
      }
    });
  }


  // ── Копирование приёма ────────────────────────────────────────────────
  // Открывает форму нового приёма с предзаполненными:
  //   - владелец и питомец (из исходного приёма)
  //   - диагноз, анамнез, лечение, тип визита, вес
  //   - все позиции (услуги/препараты)
  //   - дата = текущее время Астаны
  async function copyVisit(sourceId) {
    var serverTime = await UI.getServerTime();
    var data = await loadAll();

    var sourceVisit = (data.visits||[]).find(function(v){ return v.id===sourceId; });
    if (!sourceVisit) { UI.toast('Приём не найден', 'err'); return; }

    var pet   = (data.pets||[]).find(function(p){ return p.id===sourceVisit.pet_id; });
    var owner = pet ? (data.owners||[]).find(function(o){ return o.id===pet.owner_id; }) : null;

    // Позиции исходного приёма
    var allVisitItems = await window.VetDB.getAll('visit_items');
    var sourceItems = allVisitItems.filter(function(vi){ return !vi.is_deleted && vi.visit_id===sourceId; });

    // Предзаполнение формы
    var prefill = {
      visit_type:        sourceVisit.visit_type || 'вторичный',
      animal_weight:     sourceVisit.animal_weight,
      patient_condition: sourceVisit.patient_condition,
      anamnesis:         sourceVisit.anamnesis,
      diagnosis:         sourceVisit.diagnosis,
      treatment:         sourceVisit.treatment,
      notes:             sourceVisit.notes,
    };

    UI.showModal({
      title: 'Копия приёма',
      size: 'full',
      bodyHTML: UI.buildVisitFormHTML(serverTime, prefill, data.staff||[]),
      saveLabel: 'Сохранить приём',
      afterOpen: function() {
        UI.initVisitForm(data.owners||[], data.pets||[], data.items||[], owner, pet);
        // Добавляем все позиции из оригинала
        sourceItems.forEach(function(vi) {
          UI.addVisitItemRow(data.items||[], vi);
        });
      },
      onSave: async function() {
        var vs = UI.getVisitState();
        if (!vs.date) { UI.toast('Укажите дату приёма', 'err'); return; }

        var finalOwner = vs.owner;
        var finalPet   = vs.pet;
        if (!finalOwner) { UI.toast('Укажите владельца', 'err'); return; }
        if (!finalPet)   { UI.toast('Укажите животное', 'err'); return; }

        if (!vs.items.length) {
          var okNoItems = await UI.confirm('Приём без услуг',
            'Не добавлено ни одной позиции — сумма приёма будет 0 ₸ и приём не попадёт в выручку. Сохранить как есть?',
            { yes: 'Сохранить', no: 'Вернуться' });
          if (!okNoItems) return;
        }

        var grossAmount = vs.items.reduce(function(s,i){ return s+(i.total||0); }, 0);
        var discount = Math.min(vs.discount || 0, grossAmount);
        var totalAmount = Math.max(0, grossAmount - discount);
        if (discount > 0 && !vs.discount_reason) { UI.toast('Укажите причину скидки', 'err'); return; }
        var body = {
          owner: { id: finalOwner.id },
          pet:   { id: finalPet.id, name: finalPet.name, type: finalPet.type, gender: finalPet.gender||'m', owner_id: finalOwner.id },
          visit: {
            date: vs.date, next_visit_date: vs.next_visit_date||'',
            staff_id: vs.staff_id || '',
            treatment_days: vs.treatment_days || 0,
            visit_type: vs.visit_type, animal_weight: vs.animal_weight,
            patient_condition: vs.condition,
            anamnesis: vs.anamnesis, diagnosis: vs.diagnosis,
            treatment: vs.treatment, notes: vs.notes,
            total_amount: totalAmount, discount: discount, discount_reason: vs.discount_reason || '', payment_card: vs.payment_card || 0,
          },
          items: vs.items,
        };
        try {
          await api('POST', '/visits/full', body);
          UI.toast('Приём скопирован', 'ok');
          UI.hideModal();
          await initVisits();
          initDashboard();
        } catch(e) { UI.toast(e.message, 'err'); }
      }
    });
  }

  async function deleteVisit(id) {
    var ok = await UI.confirm('Удалить приём?', 'Приём и все его позиции будут удалены.');
    if (!ok) return;
    try {
      // 1. Мягкое удаление в локальном IndexedDB (работает офлайн)
      await api('DELETE', '/visits/'+id);

      // 2. Прямой DELETE на сервер минуя перехватчик —
      //    гарантирует что сервер узнает об удалении немедленно.
      //    Если сервер недоступен (офлайн) — ошибка игнорируется,
      //    sync/push доставит удаление позже.
      try {
        var base = (window.VetAppConfig && window.VetAppConfig.apiBase) || '';
        var nf   = window.__nativeFetch || window.fetch.bind(window);
        await nf(base + '/visits/' + id, {
          method: 'DELETE',
          headers: { 'Content-Type': 'application/json', 'X-Bypass-Local': '1' }
        });
      } catch(serverErr) {
        console.warn('[deleteVisit] direct server delete failed (offline?):', serverErr.message);
      }

      UI.toast('Удалено', 'ok');
      await initVisits();
    } catch(e) { UI.toast(e.message, 'err'); }
  }

  function openVisitDetail(id) { navigate('visits'); }

  // ═══════════════════════════════════════════════════════════════════════
  // VACCINATIONS
  // ═══════════════════════════════════════════════════════════════════════
  var _vaccinations = [], _vacPetsMap = {};
  var _vaccDateFilter = 'all';   // 'all' | 'week'
  var _pendingVaccFilter = null;

  async function initVaccinations() {
    if (_pendingVaccFilter !== null) {
      _vaccDateFilter = _pendingVaccFilter;
      _pendingVaccFilter = null;
    }
    var [vacc, pets] = await Promise.all([api('GET','/vaccinations'), api('GET','/pets?status=all')]);
    _vaccinations = vacc || [];
    _vacPetsMap   = buildMap(pets || []);
    var vdateFilter = document.getElementById('vacc-date-filter');
    if (vdateFilter) {
      vdateFilter.querySelectorAll('.filter-btn').forEach(function(btn) {
        btn.classList.toggle('active', btn.dataset.vdate === _vaccDateFilter);
        btn.onclick = function() {
          vdateFilter.querySelectorAll('.filter-btn').forEach(function(b){ b.classList.remove('active'); });
          btn.classList.add('active');
          _vaccDateFilter = btn.dataset.vdate;
          renderVaccinationList();
        };
      });
    }
    renderVaccinationList();
    setupSearch('search-vaccinations', function(q){ renderVaccinationList(); });
    document.getElementById('btn-add-vaccination').onclick = addVaccination;
  }

  function renderVaccinationList() {
    var q = (document.getElementById('search-vaccinations')||{}).value || '';
    // Дата клиники, не UTC: до 5 утра по Астане UTC-«сегодня» — ещё вчера,
    // и счётчик «вакцинаций на неделе» на главной расходился бы с этим списком.
    var today   = astanaTodayStr();
    var weekEnd = toAstanaStr(new Date(Date.now() + 7*86400000));

    var list = _vaccinations.filter(function(v) {
      if (v.is_deleted) return false;
      // Фильтр по дате. Раньше ветка 'week' делала return сразу и поиск
      // внутри недели не работал — теперь дата и поиск независимы.
      if (_vaccDateFilter === 'week') {
        if (!v.next_due_at) return false;
        var nd = v.next_due_at.slice(0,10);
        if (nd < today || nd > weekEnd) return false;
      } else if (_vaccDateFilter === 'overdue') {
        if (!v.next_due_at || v.next_due_at.slice(0,10) >= today) return false;
      }
      if (q) {
        var pet = _vacPetsMap[v.pet_id] || {};
        return (v.vaccine_name+' '+(pet.name||'')).toLowerCase().includes(q.toLowerCase());
      }
      return true;
    }).sort(function(a,b){ return new Date(b.administered_at)-new Date(a.administered_at); });

    var el = document.getElementById('vaccinations-list');
    if (!el) return;
    if (!list.length) {
      el.innerHTML = (q || _vaccDateFilter !== 'all')
        ? searchEmpty('search-vaccinations')
        : emptyState('Вакцинаций нет', '+ Добавить', 'VetPages.addVaccination()', 'syringe');
      return;
    }
    el.innerHTML = list.map(function(v) {
      var pet = _vacPetsMap[v.pet_id] || {};
      // Строго "<": вакцинация со сроком сегодня — ещё не просрочена.
      // Иначе бейдж расходился с фильтром «Просроченные», который считает < today.
      var overdue = v.next_due_at && v.next_due_at.slice(0,10) < today;
      return '<div class="erow" onclick="VetPages.editVaccination(\''+v.id+'\')">'
        +UI.avatar(pet.name||'?',pet.type)
        +'<div class="erow-body">'
        +'<div class="erow-title">'+esc(pet.name||'?')+' · '+esc(v.vaccine_name)+'</div>'
        +'<div class="erow-sub">'+(v.manufacturer?esc(v.manufacturer)+' · ':'')+'Серия: '+esc(v.batch_number||'—')+'</div>'
        +(v.next_due_at?'<div class="erow-meta">Следующая: '+fmtDate(v.next_due_at)+(overdue?' '+I('alert')+' Просрочена':'')+'</div>':'')
        +'</div>'
        +'<div class="erow-right">'
        +'<span class="erow-date">'+fmtDate(v.administered_at)+'</span>'
        +'<div class="erow-actions">'
        +'<button class="btn btn-icon" onclick="event.stopPropagation();VetPages.editVaccination(\''+v.id+'\')" title="Открыть" aria-label="Открыть">'+UI.icon('edit','')+'</button>'
        +UI.rowMenu([
            {label:'Печать справки', icon:'print', onclick:"VetPages.printVaccinationCard('"+v.id+"')"},
            {label:'Копировать', icon:'clipboard', onclick:"VetPages.copyVaccination('"+v.id+"')"},
            {sep:true},
            {label:'Удалить', icon:'trash', danger:true, onclick:"VetPages.deleteVaccination('"+v.id+"')"}
          ])
        +'</div></div></div>';
    }).join('');
  }

  async function addVaccination(petId) {
    // Загружаем всех владельцев и животных для формы с owner → pet selection
    var [owners, pets] = await Promise.all([
      api('GET', '/owners'),
      api('GET', '/pets?status=active'),
    ]);
    var allOwners = owners || [];
    var allPets   = pets   || [];
    var prefill   = petId ? { pet_id: petId } : {};
    UI.showModal({
      title: 'Новая вакцинация', size: 'lg',
      bodyHTML: UI.vaccinationFormHTML(prefill, null, allOwners, allPets),
      afterOpen: function() {
        UI.vaccinationFormAfterOpen(allPets);
        if (petId) { // Авто-выбрать владельца если передан petId
          var pet = allPets.find(function(p){return p.id===petId;});
          if (pet) {
            var ownerSel = document.getElementById('vacc-owner-sel');
            if (ownerSel) { ownerSel.value = pet.owner_id; ownerSel.dispatchEvent(new Event('change')); }
            setTimeout(function(){
              var petSel = document.getElementById('f-pet-sel');
              if (petSel) petSel.value = petId;
              document.getElementById('f-pet-id').value = petId;
            }, 100);
          }
        }
      },
      onSave: async function() {
        var d = UI.vaccinationFormData();
        if (!d.pet_id) { UI.toast('Выберите животное', 'err'); return; }
        if (!d.vaccine_name) { UI.toast('Введите название вакцины', 'err'); return; }
        if (!d.administered_at) { UI.toast('Укажите дату введения', 'err'); return; }
        try {
          await api('POST', '/vaccinations', d);
          UI.toast('Вакцинация добавлена', 'ok');
          UI.hideModal();
          await initVaccinations();
        } catch(e) { UI.toast(e.message, 'err'); }
      }
    });
  }

  async function editVaccination(id) {
    var v = _vaccinations.find(function(x){ return x.id===id; });
    if (!v) return;
    var [owners, pets] = await Promise.all([
      api('GET', '/owners'),
      api('GET', '/pets?status=active'),
    ]);
    UI.showModal({
      title: 'Редактировать вакцинацию', size: 'lg',
      bodyHTML: UI.vaccinationFormHTML(v, null, owners||[], pets||[]),
      afterOpen: function() {
        UI.vaccinationFormAfterOpen(pets||[]);
        // Устанавливаем текущего владельца
        var pet = (pets||[]).find(function(p){return p.id===v.pet_id;});
        if (pet) {
          var ownerSel = document.getElementById('vacc-owner-sel');
          if (ownerSel) { ownerSel.value = pet.owner_id; ownerSel.dispatchEvent(new Event('change')); }
          setTimeout(function(){
            var petSel = document.getElementById('f-pet-sel');
            if (petSel) petSel.value = v.pet_id;
            document.getElementById('f-pet-id').value = v.pet_id;
          }, 100);
        }
      },
      onSave: async function() {
        var d = UI.vaccinationFormData();
        if (!d.vaccine_name || !d.administered_at) { UI.toast('Заполните обязательные поля', 'err'); return; }
        try {
          await api('PUT', '/vaccinations/'+id, d);
          UI.toast('Сохранено', 'ok');
          UI.hideModal();
          await initVaccinations();
        } catch(e) { UI.toast(e.message, 'err'); }
      }
    });
  }


  // ── Копирование вакцинации ────────────────────────────────────────────────
  async function copyVaccination(sourceId) {
    var allVaccs = await window.VetDB.getAll('vaccinations');
    var src = allVaccs.find(function(v){ return v.id===sourceId; });
    if (!src) { UI.toast('Запись не найдена', 'err'); return; }

    var [owners, pets] = await Promise.all([
      api('GET', '/owners'),
      api('GET', '/pets?status=active'),
    ]);

    // Следующая дата — +1 год от текущей вакцинации
    var nextYear = src.next_due_at
      ? new Date(new Date(src.next_due_at).getTime() + 365*86400000).toISOString().slice(0,10)
      : '';

    var prefill = {
      pet_id:       src.pet_id,
      staff_id:     src.staff_id,
      vaccine_name: src.vaccine_name,
      batch_number: '',          // серию обнуляем — новая партия
      manufacturer: src.manufacturer,
      dose:         src.dose,
      next_due_at:  nextYear,
      notes:        src.notes,
    };

    UI.showModal({
      title: 'Повторная вакцинация',
      size: 'lg',
      bodyHTML: UI.vaccinationFormHTML(prefill, null, owners, pets),
      afterOpen: function() { UI.vaccinationFormAfterOpen(pets); },
      onSave: async function() {
        var d = UI.vaccinationFormData();
        if (!d.pet_id)       { UI.toast('Выберите животное', 'err'); return; }
        if (!d.vaccine_name) { UI.toast('Введите вакцину', 'err'); return; }
        try {
          await api('POST', '/vaccinations', d);
          UI.toast('Вакцинация добавлена', 'ok');
          UI.hideModal();
          await initVaccinations();
        } catch(e) { UI.toast(e.message, 'err'); }
      }
    });
  }

  // ── История изменений приёма ──────────────────────────────────────────────
  // Хранится в IndexedDB (локально на устройстве). Ключ: "hist_<visitId>"
  // Запись: [{ts, device, fields: {diagnosis, treatment, total_amount, ...}}]

  async function _visitHistorySave(visitId, vsState, prev) {
    try {
      var allVisits = await window.VetDB.getAll('visits');
      var visit = allVisits.find(function(v){ return v.id===visitId; });
      var existing = [];
      if (visit && visit.change_log) {
        try { existing = JSON.parse(visit.change_log); } catch(e) { existing = []; }
      }
      if (!Array.isArray(existing)) existing = [];

      var newGross = vsState.items ? vsState.items.reduce(function(s,i){return s+(i.total||0);},0) : 0;
      var newDisc  = Math.min(vsState.discount || 0, newGross);
      var newTotal = Math.max(0, newGross - newDisc);

      // Собираем ВСЕ поля нового состояния
      var newFields = {
        diag:      vsState.diagnosis       || '',
        anamnesis: vsState.anamnesis       || '',
        treat:     vsState.treatment       || '',
        notes:     vsState.notes           || '',
        cond:      vsState.condition       || '',
        vtype:     vsState.visit_type      || '',
        weight:    vsState.animal_weight ? String(vsState.animal_weight) : '',
        next:      vsState.next_visit_date || '',
        card:      vsState.payment_card    ? String(vsState.payment_card) : '0',
        disc:      newDisc ? String(newDisc) : '0',
        total:     newTotal,
      };
      // Старые поля (из prevSnapshot)
      var prevFields = prev ? {
        diag:      prev.diag  || '',
        anamnesis: prev.anamnesis || '',
        treat:     prev.treat || '',
        notes:     prev.notes || '',
        cond:      prev.cond  || '',
        vtype:     prev.vtype || '',
        weight:    prev.weight ? String(prev.weight) : '',
        next:      prev.next  || '',
        card:      prev.card  ? String(prev.card) : '0',
        disc:      prev.disc  ? String(prev.disc) : '0',
        total:     prev.total || 0,
      } : null;

      var entry = {
        ts:     new Date(Date.now() + 5*3600000).toISOString().slice(0,16).replace('T',' '),
        device: window.VetDB.getDeviceID ? window.VetDB.getDeviceID().slice(0,8) : '—',
        after:  newFields,
        before: prevFields,
      };
      existing.unshift(entry);
      if (existing.length > 15) existing = existing.slice(0, 15);
      vsState._change_log = JSON.stringify(existing);
    } catch(e) { /* не критично */ }
  }

  // ═══════════════════════════════════════════════════════════════════
  // ПЕЧАТЬ
  // ═══════════════════════════════════════════════════════════════════
  //
  // Печатаем через скрытый iframe внутри страницы, а не через window.open.
  //
  // Почему: раньше стояло window.open('', '_blank', 'width=800,height=900').
  // Заданные размеры превращают окно в popup, и на планшете в режиме PWA
  // это крошечное окошко, в котором ничего не видно и не прокручивается.
  // Плюс всплывающие окна на Android часто заблокированы — печать просто
  // молча не срабатывала.
  //
  // iframe даёт системный диалог печати сразу, без промежуточного окна.
  function printHTML(html, opts) {
    opts = opts || {};
    // Старый iframe убираем: врач мог нажать печать дважды подряд.
    var prev = document.getElementById('print-frame');
    if (prev) prev.remove();

    var frame = document.createElement('iframe');
    frame.id = 'print-frame';
    // Не display:none: Safari и часть Android-браузеров не печатают
    // скрытые таким образом фреймы. Убираем за пределы экрана.
    frame.setAttribute('aria-hidden', 'true');
    frame.style.cssText = 'position:fixed;left:-10000px;top:0;width:800px;height:1200px;border:0;';
    document.body.appendChild(frame);

    var doc = frame.contentDocument || frame.contentWindow.document;
    doc.open();
    doc.write(html);
    doc.close();

    var fired = false;
    function fire() {
      if (fired) return;
      fired = true;
      try {
        frame.contentWindow.focus();
        frame.contentWindow.print();
      } catch (e) {
        console.error('[VetPages] печать не удалась:', e);
        UI.toast('Не удалось открыть печать: ' + e.message, 'err', 6000);
      }
      // Удаляем с запасом: на Android диалог печати читает документ
      // асинхронно, и слишком ранний remove даёт пустой лист.
      setTimeout(function () { frame.remove(); }, 60000);
    }

    // Ждём картинки (логотип клиники), иначе печать уйдёт без них.
    if (frame.contentWindow.document.images.length) {
      frame.onload = fire;
      setTimeout(fire, opts.timeout || 1500); // страховка, если onload не придёт
    } else {
      setTimeout(fire, opts.delay || 300);
    }
  }

  // ═══════════════════════════════════════════════════════════════════
  // ВЛОЖЕНИЯ: сканы УЗИ, рентгена, бланки анализов
  // ═══════════════════════════════════════════════════════════════════
  //
  // Файлы лежат на сервере. Планшет офлайн может снять файл — он уходит
  // в очередь и отправляется при появлении сети. Просмотр чужих сканов
  // требует сети: держать все файлы клиники на планшете мы не хотим.

  var ATTACH_KINDS = [
    { v: 'ultrasound', l: 'УЗИ' },
    { v: 'xray',       l: 'Рентген' },
    { v: 'lab',        l: 'Анализы' },
    { v: 'photo',      l: 'Фото' },
    { v: 'other',      l: 'Другое' },
  ];
  var ATTACH_MAX_BYTES = 10 * 1024 * 1024; // как на сервере

  function attachKindLabel(v) {
    var k = ATTACH_KINDS.find(function (x) { return x.v === v; });
    return k ? k.l : 'Другое';
  }

  function fmtBytes(n) {
    n = Number(n) || 0;
    if (n >= 1048576) return (n / 1048576).toFixed(1) + ' МБ';
    if (n >= 1024) return Math.round(n / 1024) + ' КБ';
    return n + ' Б';
  }

  // Панель вложений внутри карточки приёма.
  async function renderAttachments(visitId) {
    var box = document.getElementById('visit-attachments');
    if (!box) return;

    var saved = [], queued = [];
    try { saved = (await window.VetDB.getAll('attachments')).filter(function (a) {
      return a.visit_id === visitId && !a.is_deleted;
    }); } catch (e) { console.warn('[VetPages] вложения:', e); }
    try { queued = (await window.VetDB.getAllRaw('attachment_queue')).filter(function (q) {
      return q.visit_id === visitId;
    }); } catch (e) {}

    var html = '<div class="attach-head">' + I('file') + ' Вложения'
      + '<span class="attach-count">' + (saved.length + queued.length) + '</span>'
      + '<button type="button" class="btn btn-ghost btn-sm attach-add" onclick="VetPages.pickAttachment(\'' + visitId + '\')">'
      + I('upload') + ' Добавить</button></div>';

    if (!saved.length && !queued.length) {
      html += '<div class="attach-empty">Сканов и снимков пока нет</div>';
    } else {
      html += '<div class="attach-list">';
      queued.forEach(function (q) {
        // Файл ещё на планшете. Показываем честно: он не на сервере,
        // и другой врач его пока не увидит.
        var err = q.status === 'error';
        html += '<div class="attach-row' + (err ? ' attach-err' : ' attach-pending') + '">'
          + I(err ? 'alert' : 'clock')
          + '<div class="attach-body"><div class="attach-name">' + esc(q.file_name) + '</div>'
          + '<div class="attach-meta">' + esc(attachKindLabel(q.kind)) + ' · ' + fmtBytes(q.size)
          + (err ? ' · не отправлен: ' + esc((q.last_error || '').slice(0, 90))
                 : ' · ждёт отправки на сервер')
          + '</div></div>'
          + '<button class="btn btn-icon" title="Убрать из очереди" onclick="VetPages.dropQueuedAttachment(\'' + q.id + '\',\'' + visitId + '\')">' + I('trash') + '</button>'
          + '</div>';
      });
      saved.forEach(function (a) {
        html += '<div class="attach-row">'
          + I(a.mime_type === 'application/pdf' ? 'file' : 'camera')
          + '<div class="attach-body"><a class="attach-name" href="/attachments/' + a.id + '/file?t=' + encodeURIComponent((window.VetAuth&&window.VetAuth.token())||'') + '" target="_blank" rel="noopener">' + esc(a.file_name) + '</a>'
          + '<div class="attach-meta">' + esc(attachKindLabel(a.kind)) + ' · ' + fmtBytes(a.size_bytes) + ' · ' + fmtDate(a.created_at) + '</div></div>'
          + '<button class="btn btn-icon" title="Удалить" onclick="VetPages.removeAttachment(\'' + a.id + '\',\'' + visitId + '\')">' + I('trash') + '</button>'
          + '</div>';
      });
      html += '</div>';
    }
    box.innerHTML = html;
  }

  // Выбор файла. Диалог с выбором типа показываем до открытия файла:
  // на планшете камера открывается поверх, и после съёмки спрашивать поздно.
  function pickAttachment(visitId) {
    var input = document.createElement('input');
    input.type = 'file';
    input.accept = 'image/*,application/pdf';
    input.onchange = async function () {
      var file = input.files && input.files[0];
      if (!file) return;
      if (file.size > ATTACH_MAX_BYTES) {
        UI.toast('Файл ' + fmtBytes(file.size) + ' — больше предела в 10 МБ', 'err', 6000);
        return;
      }
      var kind = window.prompt(
        'Тип вложения:\n' + ATTACH_KINDS.map(function (k, i) { return (i + 1) + ' — ' + k.l; }).join('\n'),
        '1');
      if (kind === null) return;
      var idx = parseInt(kind, 10);
      var chosen = (idx >= 1 && idx <= ATTACH_KINDS.length) ? ATTACH_KINDS[idx - 1].v : 'other';

      // Кладём в очередь всегда, даже онлайн: одна дорога для всех случаев —
      // меньше веток, и файл не потеряется, если сеть отвалится в момент отправки.
      await window.VetSync.queueAttachment({
        id: window.VetDB.uuid(),
        visit_id: visitId,
        kind: chosen,
        file_name: file.name || 'scan',
        size: file.size,
        blob: file,
        status: 'pending',
        retry_count: 0,
        created_at: new Date().toISOString(),
      });
      await renderAttachments(visitId);
      UI.toast('Файл добавлен, отправляется на сервер…', 'ok');

      try {
        var res = await window.VetSync.pushAttachments();
        await renderAttachments(visitId);
        if (res.uploaded) UI.toast('Вложение сохранено на сервере', 'ok');
        else if (res.failed) UI.toast('Нет связи — файл отправится при подключении', 'warn', 5000);
      } catch (e) {
        UI.toast('Нет связи — файл отправится при подключении', 'warn', 5000);
      }
    };
    input.click();
  }

  async function removeAttachment(id, visitId) {
    if (!confirm('Удалить вложение?')) return;
    try {
      await api('DELETE', '/attachments/' + id);
      await window.VetDB.hardDelete('attachments', id);
      await renderAttachments(visitId);
      UI.toast('Вложение удалено', 'ok');
    } catch (e) {
      UI.toast('Удалить можно только при наличии связи с сервером', 'err', 5000);
    }
  }

  async function dropQueuedAttachment(id, visitId) {
    if (!confirm('Убрать файл из очереди? Он не будет отправлен и потеряется.')) return;
    await window.VetDB.deleteRaw('attachment_queue', id);
    await renderAttachments(visitId);
  }

  // Блок «кто создал / кто изменил» для модалок истории.
  // Данные живут на сервере (авторство проставляется при push по токену),
  // поэтому запрос онлайн-only: без сети блок молча не показывается —
  // планшет в принципе не знает, кто менял запись с другого устройства.
  async function authorshipHTML(table, id) {
    try {
      var a = await api('GET', '/authorship?table=' + encodeURIComponent(table) + '&id=' + encodeURIComponent(id));
      if (!a || (!a.created_by_name && !a.updated_by_name)) return '';
      var parts = [];
      if (a.created_by_name) parts.push('Создал: <b>' + esc(a.created_by_name) + '</b>');
      if (a.updated_by_name) parts.push('Последнее изменение: <b>' + esc(a.updated_by_name) + '</b>'
        + (a.updated_at ? ' · ' + fmtDate(a.updated_at) : ''));
      return '<div class="authorship-box">' + I('user') + ' ' + parts.join(' &nbsp;·&nbsp; ') + '</div>';
    } catch (e) { return ''; }
  }

  async function showVisitHistory(visitId) {
    try {
      var allV = await window.VetDB.getAll('visits');
      var v = allV.find(function(x){ return x.id===visitId; });
      var log = (v && v.change_log) ? (function(){ try{ return JSON.parse(v.change_log); }catch(e){ return []; } })() : [];
      if (!log.length) { UI.toast('История изменений пуста', 'warn'); return; }

      function diffRow(label, before, after) {
        if (before === null || before === undefined) {
          // Первая запись — только текущее состояние
          return after
            ? '<div style="font-size:.82rem;margin-top:4px;"><b>'+esc(label)+':</b> '+esc(after.slice(0,100))+(after.length>100?'…':'')+'</div>'
            : '';
        }
        if (before === after) return ''; // не изменилось
        return '<div style="margin-top:6px;">'
          + '<div style="font-size:.75rem;font-weight:700;color:var(--text-3);text-transform:uppercase;letter-spacing:.4px;">'+esc(label)+'</div>'
          + '<div style="display:flex;gap:8px;align-items:flex-start;margin-top:3px;">'
          + '<div style="flex:1;background:#fff2f3;border-radius:4px;padding:5px 8px;font-size:.8rem;color:#dc3545;text-decoration:line-through;">'+esc((before||'—').slice(0,80))+'</div>'
          + '<div style="flex-shrink:0;color:var(--text-3);">→</div>'
          + '<div style="flex:1;background:#eaf5ee;border-radius:4px;padding:5px 8px;font-size:.8rem;color:#1a8c5e;font-weight:600;">'+esc((after||'—').slice(0,80))+'</div>'
          + '</div></div>';
      }

      var html = '<div style="padding:16px;max-height:65vh;overflow-y:auto;">'
        + '<div style="font-weight:700;margin-bottom:12px;color:var(--text-2);font-size:.8rem;text-transform:uppercase;letter-spacing:.5px;">История изменений</div>'
        + log.map(function(e, i) {
            var isFirst = i === 0;
            var LABELS = {diag:'Диагноз',anamnesis:'Анамнез',treat:'Назначение и рекомендации',
              notes:'Примечания',cond:'Состояние',vtype:'Тип приёма',
              weight:'Вес (кг)',next:'След. приём',disc:'Скидка (₸)',card:'Карта (₸)',total:'Сумма (₸)'};
            var after  = e.after  || {diag:e.diag||'',treat:e.treat||'',total:e.total||0};
            var before = e.before || null;
            var diffs = [];
            Object.keys(LABELS).forEach(function(k){
              var isMoney = k==='total'||k==='card'||k==='disc';
              var a = isMoney ? Number(after[k]||0).toFixed(0)+' ₸' : (after[k]||'');
              var b = before ? (isMoney ? Number(before[k]||0).toFixed(0)+' ₸' : (before[k]||'')) : null;
              var d = diffRow(LABELS[k], b, a);
              if (d) diffs.push(d);
            });
            return '<div style="padding:10px 12px;margin-bottom:8px;border-radius:8px;border:1px solid var(--border);background:'+(isFirst?'var(--accent-dim)':'var(--bg-s)')+'">'
              + '<div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:6px;">'
              + '<span style="font-weight:700;font-size:.88rem;">'+esc(e.ts)+'</span>'
              + '<span style="font-size:.72rem;color:var(--text-3);background:var(--bg);padding:2px 8px;border-radius:99px;">'+esc(e.device)+'</span>'
              + '</div>'
              + (diffs.length ? diffs.join('') : '<div style="font-size:.8rem;color:var(--text-3);">— без изменений —</div>')
              + '</div>';
          }).join('')
        + '</div>';
      var authHTML = await authorshipHTML('visits', visitId);
      UI.showModal({ title: 'История изменений', bodyHTML: authHTML + html, onSave: false, cancelLabel: 'Закрыть', size: 'lg' });
    } catch(e) { UI.toast('Ошибка: '+e.message, 'err'); }
  }

  async function deleteVaccination(id) {
    var ok = await UI.confirm('Удалить запись о вакцинации?', '');
    if (!ok) return;
    try { await api('DELETE', '/vaccinations/'+id);
      // Прямой DELETE на сервер (гарантирует удаление даже если sync/push не работает)
      try {
        var _base = (window.VetAppConfig && window.VetAppConfig.apiBase) || '';
        var _nf = window.__nativeFetch || window.fetch.bind(window);
        await _nf(_base + '/vaccinations/' + id, {
          method: 'DELETE', headers: { 'Content-Type': 'application/json', 'X-Bypass-Local': '1' }
        });
      } catch(_e) {} UI.toast('Удалено','ok'); await initVaccinations(); }
    catch(e) { UI.toast(e.message,'err'); }
  }

  // ═══════════════════════════════════════════════════════════════════════
  // ITEMS (Catalog)
  // ═══════════════════════════════════════════════════════════════════════
  var _items = [], _itemTypeFilter = 'all';

  async function initItems() {
    _items = await api('GET', '/items') || [];
    renderItemList();
    setupSearch('search-items', function(q){ renderItemList(); });
    document.getElementById('btn-add-item').onclick = addItem;
    var typeFilter = document.getElementById('item-type-filter');
    if (typeFilter) {
      typeFilter.querySelectorAll('.filter-btn').forEach(function(btn) {
        btn.onclick = function() {
          typeFilter.querySelectorAll('.filter-btn').forEach(function(b){ b.classList.remove('active'); });
          btn.classList.add('active');
          _itemTypeFilter = btn.dataset.type;
          renderItemList();
        };
      });
    }
  }

  function renderItemList() {
    var q = (document.getElementById('search-items')||{}).value || '';
    var list = _items.filter(function(it) {
      if (it.is_deleted) return false;
      if (_itemTypeFilter !== 'all' && it.type !== _itemTypeFilter) return false;
      if (q) return it.name.toLowerCase().includes(q.toLowerCase());
      return true;
    }).sort(function(a,b){ return a.name.localeCompare(b.name,'ru'); });

    var el = document.getElementById('items-list');
    if (!el) return;
    if (!list.length) { el.innerHTML = q ? searchEmpty('search-items') : emptyState('Каталог пуст', '+ Добавить', 'VetPages.addItem()', 'box'); return; }
    el.innerHTML = list.map(function(it) {
      var typeLabel = it.type==='drug'?'Препарат':'Услуга';
      var badgeCls  = it.type==='drug'?'drug':'service';
      return '<div class="erow" onclick="VetPages.editItem(\''+it.id+'\')">'
        +'<div class="erow-avatar '+(it.type==='drug'?'cat':'dog')+'">'+(it.type==='drug'?I('syringe'):I('stethoscope'))+'</div>'
        +'<div class="erow-body">'
        +'<div class="erow-title">'+hl(it.name,q)+'</div>'
        +'<div class="erow-sub"><span class="badge badge-'+badgeCls+'">'+typeLabel+'</span></div>'
        +'</div>'
        +'<div class="erow-right">'
        +'<span class="erow-amount">'+Number(it.price).toFixed(0)+' ₸</span>'
        +'<div class="erow-actions">'
        +'<button class="btn btn-icon" onclick="event.stopPropagation();VetPages.editItem(\''+it.id+'\')" title="Редактировать" aria-label="Редактировать">'+UI.icon('edit','')+'</button>'
        +'<span class="erow-actions-sep"></span>'
        +'<button class="btn btn-icon danger" onclick="event.stopPropagation();VetPages.deleteItem(\''+it.id+'\',\''+esc(it.name)+'\')" title="Удалить" aria-label="Удалить">'+UI.icon('trash','')+'</button>'
        +'</div></div></div>';
    }).join('');
  }

  async function addItem() {
    UI.showModal({ title: 'Новая позиция каталога', bodyHTML: UI.itemFormHTML(), size: '',
      afterOpen: UI.recalcItemCost,
      onSave: async function() {
        var d = UI.itemFormData();
        if (!d.name) { UI.toast('Введите название', 'err'); return; }
        try { await api('POST','/items',d); UI.toast('Добавлено','ok'); UI.hideModal(); await initItems(); }
        catch(e) { UI.toast(e.message,'err'); }
      }
    });
  }

  async function editItem(id) {
    var it = _items.find(function(x){ return x.id===id; });
    if (!it) return;
    UI.showModal({ title: 'Редактировать: '+it.name, bodyHTML: UI.itemFormHTML(it), size: '',
      afterOpen: UI.recalcItemCost,
      onSave: async function() {
        var d = UI.itemFormData();
        if (!d.name) { UI.toast('Введите название','err'); return; }
        try { await api('PUT','/items/'+id,d); UI.toast('Сохранено','ok'); UI.hideModal(); await initItems(); }
        catch(e) { UI.toast(e.message,'err'); }
      }
    });
  }

  async function deleteItem(id, name) {
    var ok = await UI.confirm('Удалить позицию?', name);
    if (!ok) return;
    try { await api('DELETE','/items/'+id); try{var _b=(window.VetAppConfig&&window.VetAppConfig.apiBase)||'',_n=window.__nativeFetch||window.fetch.bind(window);await _n(_b+'/items/'+id,{method:'DELETE',headers:{'X-Bypass-Local':'1'}});}catch(_e){} UI.toast('Удалено','ok'); await initItems(); }
    catch(e) { UI.toast(e.message,'err'); }
  }

  // ═══════════════════════════════════════════════════════════════════════
  // STAFF
  // ═══════════════════════════════════════════════════════════════════════
  var _staff = [];

  async function initStaff() {
    _staff = await api('GET','/staff') || [];
    renderStaffList();
    setupSearch('search-staff', function(q){ renderStaffList(); });
    document.getElementById('btn-add-staff').onclick = addStaff;
  }

  function renderStaffList() {
    var q = (document.getElementById('search-staff')||{}).value || '';
    var list = _staff.filter(function(s) {
      if (s.is_deleted) return false;
      if (q) return (s.name+' '+(s.role||'')).toLowerCase().includes(q.toLowerCase());
      return true;
    }).sort(function(a,b){ return a.name.localeCompare(b.name,'ru'); });
    var el = document.getElementById('staff-list');
    if (!el) return;
    if (!list.length) { el.innerHTML = q ? searchEmpty('search-staff') : emptyState('Персонал не добавлен', '+ Добавить', 'VetPages.addStaff()', 'users'); return; }
    el.innerHTML = list.map(function(s) {
      var media = s.photo
        ? '<img class="pet-photo" src="'+s.photo+'" alt="">'
        : UI.avatar(s.name,'staff');
      return '<div class="erow" onclick="VetPages.showStaffCard(\''+s.id+'\')">'
        +media
        +'<div class="erow-body">'
        +'<div class="erow-title">'+hl(s.name,q)+'</div>'
        +'<div class="erow-sub">'+esc(ROLE_LABELS[s.role]||s.role||'')+(s.phone?' · '+esc(s.phone):'')+'</div>'
        +'</div>'
        +'<div class="erow-right">'
        +(s.is_active?'<span class="badge badge-active">Активен</span>':'<span class="badge badge-inactive">Неактивен</span>')
        +'<div class="erow-actions">'
        +'<button class="btn btn-icon" onclick="event.stopPropagation();VetPages.editStaff(\''+s.id+'\')" title="Редактировать" aria-label="Редактировать">'+UI.icon('edit','')+'</button>'
        +'<span class="erow-actions-sep"></span>'
        +'<button class="btn btn-icon danger" onclick="event.stopPropagation();VetPages.deleteStaff(\''+s.id+'\',\''+esc(s.name)+'\')" title="Удалить" aria-label="Удалить">'+UI.icon('trash','')+'</button>'
        +'</div></div></div>';
    }).join('');
  }

  // ── Карточка сотрудника: фото, контакты и рабочая статистика ──────
  async function showStaffCard(id) {
    var st = _staff.find(function(x){ return x.id===id; });
    if (!st) {
      try { st = (await window.VetDB.getAll('staff')).find(function(x){ return x.id===id; }); } catch(e) {}
    }
    if (!st) { UI.toast('Сотрудник не найден', 'err'); return; }

    // Права на суммы: чужая статистика скрывается.
    var sumsOk = !window.VetAuth || VetAuth.canSeeSum(id);
    // Статистика по приёмам врача считается из локальной базы — работает офлайн.
    var visits = [], vitems = [], catalog = [];
    try {
      visits  = await window.VetDB.getAll('visits');
      vitems  = await window.VetDB.getAll('visit_items');
      catalog = await window.VetDB.getAll('items');
    } catch(e) {}
    var catMap = buildMap(catalog);
    var my = visits.filter(function(v){ return !v.is_deleted && v.staff_id===id; });
    var monthAgo = toAstanaStr(new Date(Date.now() - 30*86400000));
    var my30 = my.filter(function(v){ return toLocalDateStr(v.date) >= monthAgo; });
    var ids30 = {}; my30.forEach(function(v){ ids30[v.id]=true; });
    // Выручка по позициям, как в отчётах; заработок = выручка − касса клиники.
    var rev30 = 0, cash30 = 0;
    vitems.forEach(function(vi){
      if (vi.is_deleted || !ids30[vi.visit_id]) return;
      var qty = Number(vi.quantity)||1;
      rev30 += Number(vi.total) || (qty*(Number(vi.price)||0));
      var cat = vi.item_id ? catMap[vi.item_id] : null;
      cash30 += (cat ? (cat.cost_price||0) : 0) * qty;
    });
    var share30 = Math.max(0, rev30 - cash30);
    var lastVisit = my.slice().sort(function(a,b){ return (b.date||'')>(a.date||'')?1:-1; })[0];

    var media = st.photo
      ? '<img src="'+esc(st.photo)+'" style="width:84px;height:84px;border-radius:50%;object-fit:cover;border:3px solid var(--border);flex-shrink:0;">'
      : '<div style="flex-shrink:0;">'+UI.avatar(st.name,'staff')+'</div>';

    var html = '<div style="display:flex;gap:16px;align-items:center;margin-bottom:16px;">'
      + media
      + '<div><div style="font-size:1.15rem;font-weight:800;">'+esc(st.name)+'</div>'
      + '<div style="color:var(--text-2);margin:2px 0 6px;">'+esc(ROLE_LABELS[st.role]||st.role||'')+'</div>'
      + (st.is_active?'<span class="badge badge-active">Активен</span>':'<span class="badge badge-inactive">Неактивен</span>')
      + '</div></div>'
      + '<div class="oc-contact-row">'
      + (st.phone?'<span>'+I('phone')+' '+esc(st.phone)+'</span>':'')
      + (st.email?'<span>✉ '+esc(st.email)+'</span>':'')
      + '</div>'
      + (st.notes?'<div class="text-sm text-muted" style="margin:8px 0 4px;">'+esc(st.notes)+'</div>':'')
      + '<div class="revenue-tiles" style="margin-top:14px;">'
      + '<div class="revenue-tile"><div class="rt-value">'+my.length+'</div><div class="rt-label">Приёмов всего</div></div>'
      + '<div class="revenue-tile"><div class="rt-value">'+my30.length+'</div><div class="rt-label">За 30 дней</div></div>'
      + (sumsOk
        ? '<div class="revenue-tile"><div class="rt-value">'+fmtMoney(rev30)+'</div><div class="rt-label">Выручка за 30 дней</div></div>'
          + '<div class="revenue-tile rt-accent"><div class="rt-value">'+fmtMoney(share30)+'</div><div class="rt-label">Заработок за 30 дней</div></div>'
        : '<div class="revenue-tile"><div class="rt-value">···</div><div class="rt-label">Суммы скрыты правами</div></div>')
      + '</div>'
      + (lastVisit?'<div class="text-sm text-muted" style="margin-top:10px;">Последний приём: '+fmtDate(lastVisit.date)+(lastVisit.diagnosis?' · '+esc(lastVisit.diagnosis):'')+'</div>':'');

    UI.showModal({
      title: st.name,
      bodyHTML: html,
      saveLabel: 'Редактировать',
      cancelLabel: 'Закрыть',
      onSave: function(){ UI.hideModal(); setTimeout(function(){ editStaff(id); }, 150); }
    });
  }

  async function addStaff() {
    UI.showModal({ title: 'Добавить сотрудника', bodyHTML: UI.staffFormHTML(), size: 'lg',
      onSave: async function() {
        var d = UI.staffFormData();
        if (!d.name) { UI.toast('Введите ФИО','err'); return; }
        try { await api('POST','/staff',d); UI.toast('Добавлено','ok'); UI.hideModal(); await initStaff(); }
        catch(e) { UI.toast(e.message,'err'); }
      }
    });
  }

  async function editStaff(id) {
    var s = _staff.find(function(x){ return x.id===id; });
    if (!s) return;
    UI.showModal({ title: 'Редактировать: '+s.name, bodyHTML: UI.staffFormHTML(s), size: 'lg',
      onSave: async function() {
        var d = UI.staffFormData();
        if (!d.name) { UI.toast('Введите ФИО','err'); return; }
        try { await api('PUT','/staff/'+id,d); UI.toast('Сохранено','ok'); UI.hideModal(); await initStaff(); }
        catch(e) { UI.toast(e.message,'err'); }
      }
    });
  }

  async function deleteStaff(id, name) {
    var ok = await UI.confirm('Удалить сотрудника?', name);
    if (!ok) return;
    try { await api('DELETE','/staff/'+id); try{var _b=(window.VetAppConfig&&window.VetAppConfig.apiBase)||'',_n=window.__nativeFetch||window.fetch.bind(window);await _n(_b+'/staff/'+id,{method:'DELETE',headers:{'X-Bypass-Local':'1'}});}catch(_e){} UI.toast('Удалено','ok'); await initStaff(); }
    catch(e) { UI.toast(e.message,'err'); }
  }

  // ═══════════════════════════════════════════════════════════════════════
  // REPORTS — инициализация отдельных страниц
  // ═══════════════════════════════════════════════════════════════════════

  // Может ли пользователь выбирать врача в отчёте за день.
  // Право привязано к «просмотр и создание персонала»: кто управляет
  // персоналом, тот видит отчёт любого врача. Остальные — только свой.
  function _reportCanPickDoctor() {
    return !!(window.VetAuth && VetAuth.can('staff', 'view') && VetAuth.can('staff', 'create'));
  }

  // Кнопка печати отчёта: всегда на месте, но неактивна без данных.
  // Раньше её показывали/прятали через display — при формировании она
  // «появлялась» и панель дёргалась. Теперь только disabled.
  function setReportPrint(id, on) {
    var b = document.getElementById(id);
    if (b) b.disabled = !on;
  }

  async function initReportDaily() {
    var dateInput = document.getElementById('report-date');
    if (dateInput && !dateInput.value) {
      dateInput.value = new Date().toISOString().slice(0, 10);
    }
    // Фильтр по врачу — только с правом на персонал; иначе отчёт
    // формируется по врачу текущего пользователя.
    var wrap = document.getElementById('report-doctor-wrap');
    var sel  = document.getElementById('report-doctor');
    if (wrap && sel) {
      if (_reportCanPickDoctor()) {
        wrap.style.display = '';
        if (!sel.options.length) {
          var staff = [];
          try { staff = await window.VetDB.getAll('staff'); } catch(e) {}
          staff = staff.filter(function(s){ return !s.is_deleted && s.is_active !== false; })
                       .sort(function(a,b){ return (a.name||'').localeCompare(b.name||'','ru'); });
          var myStaff = window.VetAuth && VetAuth.user() ? (VetAuth.user().staff_id || '') : '';
          sel.innerHTML = '<option value="">Все врачи</option>'
            + staff.map(function(s){ return '<option value="'+esc(s.id)+'"'+(s.id===myStaff?' selected':'')+'>'+esc(s.name)+'</option>'; }).join('');
          sel.onchange = function() {
            var d = document.getElementById('report-date');
            if (d && d.value) generateReport(d.value);
          };
        }
      } else {
        wrap.style.display = 'none';
      }
    }
    var genBtn = document.getElementById('btn-generate-report');
    if (genBtn) genBtn.onclick = function() {
      var d = document.getElementById('report-date');
      generateReport(d ? d.value : '');
    };
    // Степпер дней «← дата → Сегодня» — как в расписании: пролистывать
    // отчёт по дням быстрее, чем каждый раз открывать календарь.
    function shiftReportDay(delta) {
      var d = document.getElementById('report-date');
      if (!d || !d.value) return;
      var parts = d.value.split('-');
      var dt = new Date(Number(parts[0]), Number(parts[1])-1, Number(parts[2]));
      dt.setDate(dt.getDate() + delta);
      d.value = localDateStr(dt);
      generateReport(d.value);
    }
    var pv = document.getElementById('report-date-prev');
    var nx = document.getElementById('report-date-next');
    var td = document.getElementById('report-date-today');
    if (pv) pv.onclick = function(){ shiftReportDay(-1); };
    if (nx) nx.onclick = function(){ shiftReportDay(1); };
    if (td) td.onclick = function(){
      var d = document.getElementById('report-date');
      if (d) { d.value = localDateStr(new Date()); generateReport(d.value); }
    };
    if (dateInput) dateInput.onchange = function(){ if (this.value) generateReport(this.value); };
    if (dateInput && dateInput.value) generateReport(dateInput.value);
  }

  // Локальная дата в YYYY-MM-DD без ухода в UTC.
  // toISOString() сдвигает дату: в Астане (UTC+5) 1 июня 00:00 → «31 мая» в UTC,
  // и пресеты периодов давали границы на день раньше.
  function localDateStr(d) {
    return d.getFullYear() + '-' +
      String(d.getMonth()+1).padStart(2,'0') + '-' +
      String(d.getDate()).padStart(2,'0');
  }

  // ── Отчёт: выручка за период ──────────────────────────────────────
  async function initReportRevenue() {
    var from = document.getElementById('revenue-from');
    var to   = document.getElementById('revenue-to');
    // По умолчанию — текущий месяц.
    if (from && !from.value) {
      var now = new Date();
      from.value = localDateStr(new Date(now.getFullYear(), now.getMonth(), 1));
      to.value = localDateStr(now);
    }
    document.querySelectorAll('#page-report-revenue [data-preset]').forEach(function(btn){
      btn.onclick = function(){ applyRevenuePreset(btn.dataset.preset); };
    });
    var gen = document.getElementById('btn-generate-revenue');
    if (gen) gen.onclick = generateRevenueReport;
    if (from && from.value) generateRevenueReport();
  }

  function applyRevenuePreset(preset) {
    var now = new Date();
    var from, to = now;
    if (preset === 'week') {
      from = new Date(now.getTime() - 6*86400000);
    } else if (preset === 'month') {
      from = new Date(now.getFullYear(), now.getMonth(), 1);
    } else if (preset === 'prev-month') {
      from = new Date(now.getFullYear(), now.getMonth()-1, 1);
      to = new Date(now.getFullYear(), now.getMonth(), 0);
    }
    document.getElementById('revenue-from').value = localDateStr(from);
    document.getElementById('revenue-to').value = localDateStr(to);
    generateRevenueReport();
  }

  async function generateRevenueReport() {
    var el = document.getElementById('revenue-content');
    if (!el) return;
    var fromStr = document.getElementById('revenue-from').value;
    var toStr   = document.getElementById('revenue-to').value;
    if (!fromStr || !toStr) { el.innerHTML = emptyState('Укажите период'); return; }
    if (fromStr > toStr) { el.innerHTML = emptyState('Дата начала позже даты конца'); return; }
    el.innerHTML = skeletonRows();

    try {
      var d = await loadAll();
      var staffMap = buildMap(d.staff);
      var catalogMap = buildMap(d.items);
      var allVisitItems = await window.VetDB.getAll('visit_items');

      // Приёмы за период (по локальной дате).
      var visits = d.visits.filter(function(v){
        if (v.is_deleted) return false;
        var vd = toLocalDateStr(v.date);
        return vd >= fromStr && vd <= toStr;
      });
      if (window.VetAuth && VetAuth.sumsScope().mode !== 'all') {
        visits = visits.filter(function(v){ return VetAuth.canSeeSum(v.staff_id); });
      }

      if (!visits.length) {
        el.innerHTML = emptyState('За период приёмов нет');
        setReportPrint('btn-print-revenue', false);
        return;
      }

      var visitIds = {};
      visits.forEach(function(v){ visitIds[v.id] = true; });
      var itemsByVisit = {};
      allVisitItems.forEach(function(vi){
        if (vi.is_deleted || !visitIds[vi.visit_id]) return;
        (itemsByVisit[vi.visit_id] = itemsByVisit[vi.visit_id] || []).push(vi);
      });

      // Итоги: выручка по позициям (как в отчёте за день — там та же база),
      // касса клиники (себестоимость), заработок = выручка − касса.
      var grandTotal = 0, grandCard = 0, grandCash = 0;
      var byDoctor = {}, byItem = {};
      var daysSet = {};

      var grandDiscount = 0;
      visits.forEach(function(v){
        daysSet[toLocalDateStr(v.date)] = true;
        grandCard += Number(v.payment_card) || 0;
        grandDiscount += Number(v.discount) || 0;
        var dk = v.staff_id || '(без врача)';
        if (!byDoctor[dk]) byDoctor[dk] = {
          name: v.staff_id && staffMap[v.staff_id] ? staffMap[v.staff_id].name : 'Врач не указан',
          visits: 0, total: 0, cash: 0, discount: 0
        };
        byDoctor[dk].visits += 1;
        byDoctor[dk].discount += Number(v.discount) || 0;
        (itemsByVisit[v.id] || []).forEach(function(vi){
          var qty = Number(vi.quantity) || 1;
          var line = Number(vi.total) || (qty * (Number(vi.price)||0));
          var cat = vi.item_id ? catalogMap[vi.item_id] : null;
          var cashLine = (cat ? (cat.cost_price||0) : 0) * qty;
          grandTotal += line;
          grandCash += cashLine;
          byDoctor[dk].total += line;
          byDoctor[dk].cash += cashLine;
          var ik = vi.item_id || ('name:'+vi.name);
          if (!byItem[ik]) byItem[ik] = { name: vi.name || '—', type: vi.type, qty: 0, total: 0 };
          byItem[ik].qty += qty;
          byItem[ik].total += line;
        });
      });

      // Скидки уменьшают заработок врачей и наличные (см. отчёт за день)
      var grandNet = Math.max(0, grandTotal - grandDiscount);
      var doctorShare = Math.max(0, grandTotal - grandCash - grandDiscount);
      var grandCashPaid = Math.max(0, grandNet - grandCard);
      var daysCount = Object.keys(daysSet).length;

      // Цена неявок: записи со статусом «не пришли» за период × средний чек.
      // Базовая линия для оценки эффекта будущих напоминаний бота.
      var noShowCount = 0;
      try {
        var allAppts = await window.VetDB.getAll('appointments');
        noShowCount = allAppts.filter(function(a) {
          if (a.is_deleted || a.status !== 'no_show') return false;
          var ad = (a.starts_at||'').slice(0,10);
          return ad >= fromStr && ad <= toStr;
        }).length;
      } catch(e) {}
      var avgCheck = visits.length ? Math.round(grandNet / visits.length) : 0;
      var noShowLost = noShowCount * avgCheck;

      var doctorRows = Object.keys(byDoctor).map(function(k){
        var x = byDoctor[k]; x.share = Math.max(0, x.total - x.cash - x.discount); return x;
      }).sort(function(a,b){ return b.share - a.share; });

      var topItems = Object.keys(byItem).map(function(k){ return byItem[k]; })
        .sort(function(a,b){ return b.total - a.total; }).slice(0, 10);

      el.innerHTML =
        '<div class="report-wrap">'
        + '<div class="report-header"><h2>Выручка: '+esc(fmtDate(fromStr))+' — '+esc(fmtDate(toStr))+'</h2>'
        + '<span class="text-muted text-sm">Приёмов: '+visits.length+' · дней с приёмами: '+daysCount+'</span></div>'

        // Крупные показатели
        + '<div class="revenue-tiles">'
        +   revenueTile('Получено', fmtMoney(grandNet), 'accent')
        +   revenueTile('Средний чек', fmtMoney(avgCheck), '')
        +   revenueTile(I('card')+' Картой', fmtMoney(grandCard), 'blue')
        +   revenueTile(I('cash')+' Наличными', fmtMoney(grandCashPaid), '')
        +   revenueTile(I('hospital')+' Касса клиники', fmtMoney(grandCash), '')
        +   revenueTile(I('stethoscope')+' Заработок врачей', fmtMoney(doctorShare), 'accent')
        +   (grandDiscount ? revenueTile('Скидки', '−' + fmtMoney(grandDiscount), '') : '')
        +   (noShowCount ? revenueTile('Неявки по записи', noShowCount + ' ≈ −' + fmtMoney(noShowLost), '') : '')
        + '</div>'

        // По врачам
        + '<div class="report-group"><div class="report-group-title">'+I('stethoscope')+' По врачам</div>'
        + '<table class="report-table"><thead><tr><th>Врач</th><th class="num">Приёмов</th>'
        + '<th class="num">Выручка</th><th class="num">Касса</th><th class="num">Заработок</th></tr></thead><tbody>'
        + doctorRows.map(function(x){
            return '<tr><td>'+esc(x.name)+'</td><td class="num">'+x.visits+'</td>'
              + '<td class="num amount">'+fmtMoney(x.total)+'</td>'
              + '<td class="num">'+fmtMoney(x.cash)+'</td>'
              + '<td class="num amount" style="color:var(--accent);font-weight:800;">'+fmtMoney(x.share)+'</td></tr>';
          }).join('')
        + '</tbody></table></div>'

        // Топ услуг и препаратов
        + '<div class="report-group"><div class="report-group-title">'+I('box')+' Топ позиций</div>'
        + '<table class="report-table"><thead><tr><th>Позиция</th><th class="num">Кол-во</th><th class="num">Сумма</th></tr></thead><tbody>'
        + topItems.map(function(x){
            return '<tr><td>'+esc(x.name)+' <span class="text-muted" style="font-size:.8em;">'+(x.type==='drug'?'преп.':'усл.')+'</span></td>'
              + '<td class="num">'+(Math.round(x.qty*10)/10)+'</td>'
              + '<td class="num amount">'+fmtMoney(x.total)+'</td></tr>';
          }).join('')
        + '</tbody></table></div>'
        + '</div>';

      setReportPrint('btn-print-revenue', true);
    } catch(e) {
      console.error('[RevenueReport]', e);
      el.innerHTML = emptyState('Ошибка формирования отчёта: ' + e.message);
    }
  }

  function revenueTile(label, value, tone) {
    return '<div class="revenue-tile'+(tone?' rt-'+tone:'')+'">'
      + '<div class="rt-value">'+value+'</div>'
      + '<div class="rt-label">'+label+'</div></div>';
  }

  async function initReportUpcoming() {
    var upBtn = document.getElementById('btn-gen-upcoming');
    if (upBtn) upBtn.onclick = generateUpcomingReport;
    var daysEl = document.getElementById('upcoming-days');
    if (daysEl) daysEl.onchange = generateUpcomingReport;
    generateUpcomingReport();
  }

  async function initReportNoShows() {
    var nsBtn = document.getElementById('btn-gen-noshows');
    if (nsBtn) nsBtn.onclick = generateNoShowsReport;
    generateNoShowsReport();
  }

  // Для обратной совместимости
  var initReports = initReportDaily;

  // Преобразует ISO-дату в локальную дату "YYYY-MM-DD" без смещения часового пояса
  function toLocalDateStr(isoStr) { return toAstanaStr(isoStr); }
  function _toLocalDateStr_unused(isoStr) {
    if (!isoStr) return '';
    var d = new Date(isoStr);
    if (isNaN(d.getTime())) return isoStr.slice(0, 10);
    var y = d.getFullYear();
    var m = String(d.getMonth() + 1).padStart(2, '0');
    var dd = String(d.getDate()).padStart(2, '0');
    return y + '-' + m + '-' + dd;
  }

  // Форматирует "2025-05-17" → "17 мая 2025"
  function fmtDateFull(dateStr) {
    var months = ['января','февраля','марта','апреля','мая','июня',
                  'июля','августа','сентября','октября','ноября','декабря'];
    var parts = dateStr.split('-');
    if (parts.length < 3) return dateStr;
    return parseInt(parts[2]) + ' ' + months[parseInt(parts[1])-1] + ' ' + parts[0];
  }

  async function generateReport(dateStr) {
    if (!dateStr) { UI.toast('Выберите дату', 'warn'); return; }

    var el = document.getElementById('report-content');
    if (!el) return;
    el.innerHTML = skeletonRows();

    try {
      // Загружаем данные из IndexedDB (работает офлайн)
      var allVisits     = await window.VetDB.getAll('visits');
      var allVisitItems = await window.VetDB.getAll('visit_items');
      var allItems      = await window.VetDB.getAll('items');
      var allPets       = await window.VetDB.getAll('pets');
      var allOwners     = await window.VetDB.getAll('owners');
      var allStaffReport = await window.VetDB.getAll('staff');

      // Карты для быстрого поиска
      var petsMap   = {};  allPets.forEach(function(p){ petsMap[p.id] = p; });
      var ownersMap = {};  allOwners.forEach(function(o){ ownersMap[o.id] = o; });
      var staffMap  = {};  allStaffReport.forEach(function(s){ staffMap[s.id] = s; });

      // Визиты за выбранную дату (сравниваем по локальному времени)
      var dayVisits = allVisits.filter(function(v) {
        return !v.is_deleted && toLocalDateStr(v.date) === dateStr;
      });
      // Права на суммы: пользователь с «только свои» видит отчёт
      // только по своим приёмам — чужие суммы его не касаются.
      if (window.VetAuth && VetAuth.sumsScope().mode !== 'all') {
        dayVisits = dayVisits.filter(function(v){ return VetAuth.canSeeSum(v.staff_id); });
      }

      // Отчёт формируется по врачу: с правом на персонал — по выбранному
      // в фильтре («Все врачи» = пусто), без права — по врачу пользователя.
      var staffFilter = '';
      var filterName = '';
      if (_reportCanPickDoctor()) {
        var sel = document.getElementById('report-doctor');
        staffFilter = sel ? sel.value : '';
      } else if (window.VetAuth && VetAuth.user() && VetAuth.user().staff_id) {
        staffFilter = VetAuth.user().staff_id;
      }
      if (staffFilter) {
        dayVisits = dayVisits.filter(function(v){ return v.staff_id === staffFilter; });
        filterName = staffMap[staffFilter] ? staffMap[staffFilter].name : '';
      }

      if (!dayVisits.length) {
        el.innerHTML = '<div class="report-empty">Нет приёмов за ' + esc(fmtDate(dateStr))
          + (filterName ? ' у врача ' + esc(filterName) : '') + '</div>';
        setReportPrint('btn-print-report', false);
        return;
      }

      // Множество ID визитов за день
      var visitIds = {};
      dayVisits.forEach(function(v) { visitIds[v.id] = true; });

      // Позиции приёмов за день
      var dayVisitItems = allVisitItems.filter(function(vi) {
        return !vi.is_deleted && visitIds[vi.visit_id];
      });

      // Справочник каталога: id → item
      var catalogMap = {};
      allItems.forEach(function(it) { catalogMap[it.id] = it; });

      // Агрегация по наименованию и типу
      // Ключ: item_id (если есть) или name + type
      var aggregated = {};
      dayVisitItems.forEach(function(vi) {
        var key = vi.item_id ? ('id:' + vi.item_id) : ('name:' + vi.name + '|' + vi.type);
        var catalogItem = vi.item_id ? catalogMap[vi.item_id] : null;
        var unitCost    = catalogItem ? (catalogItem.cost_price || 0) : 0;

        if (!aggregated[key]) {
          aggregated[key] = {
            name:      vi.name || '—',
            type:      vi.type || 'service',
            qty:       0,
            total:     0,    // сумма продаж (price × qty)
            cashTotal: 0,    // кассовая стоимость (cost_price × qty)
            unitPrice: vi.price || 0,
            unitCost:  unitCost,
          };
        }
        var row = aggregated[key];
        var qty    = Number(vi.quantity) || 1;
        var amount = Number(vi.total) || (qty * (Number(vi.price) || 0));
        row.qty       += qty;
        row.total     += amount;
        row.cashTotal += unitCost * qty;
      });

      // Приёмы, у которых есть сумма, но нет ни одной позиции: их деньги
      // не попадают в выручку (она считается по позициям). Молчать нельзя —
      // отчёту перестанут верить.
      var itemSumByVisit = {};
      dayVisitItems.forEach(function(vi) {
        itemSumByVisit[vi.visit_id] = (itemSumByVisit[vi.visit_id] || 0)
          + (Number(vi.total) || (Number(vi.quantity)||1) * (Number(vi.price)||0));
      });
      var noItemVisits = dayVisits.filter(function(v) {
        return (v.total_amount || 0) > 0 && !(itemSumByVisit[v.id] > 0);
      });
      var noItemsSum = noItemVisits.reduce(function(s,v){ return s + (v.total_amount||0); }, 0);

      var rows   = Object.values(aggregated);
      var services = rows.filter(function(r){ return r.type === 'service'; })
                         .sort(function(a,b){ return a.name.localeCompare(b.name,'ru'); });
      var drugs    = rows.filter(function(r){ return r.type === 'drug'; })
                         .sort(function(a,b){ return a.name.localeCompare(b.name,'ru'); });

      // Скидки за день: контроль без сводки не работает — админ должен
      // видеть, кто, сколько и почему.
      var discountRows = dayVisits.filter(function(v){ return (v.discount||0) > 0; }).map(function(v) {
        var pet = petsMap[v.pet_id] || {};
        return {
          doctor: v.staff_id && staffMap[v.staff_id] ? staffMap[v.staff_id].name : 'Врач не указан',
          pet:    pet.name || '—',
          sum:    v.discount || 0,
          reason: v.discount_reason || '—',
        };
      });

      el.innerHTML = buildReportHTML(dateStr, services, drugs, dayVisits, petsMap, ownersMap, staffMap, dayVisitItems, catalogMap, filterName,
        { count: noItemVisits.length, sum: noItemsSum }, discountRows);

      setReportPrint('btn-print-report', true);

    } catch(e) {
      console.error('[Report]', e);
      el.innerHTML = '<div class="report-empty">Ошибка формирования отчёта: ' + esc(e.message) + '</div>';
    }
  }

  // dayVisitItems и catalogMap нужны для разбивки по врачам: заработок считается
  // из кассовой стоимости позиций, а она живёт в каталоге, не в приёме.
  function buildReportHTML(dateStr, services, drugs, dayVisits, petsMap, ownersMap, staffMap, dayVisitItems, catalogMap, filterName, noItems, discountRows) {

    function rowsHTML(rows) {
      return rows.map(function(r) {
        var diff = r.total - r.cashTotal;
        return '<tr>'
          + '<td>' + esc(r.name) + '</td>'
          + '<td class="num">' + fmtQty(r.qty) + '</td>'
          + '<td class="num">' + fmtMoney(r.unitPrice) + '</td>'
          + '<td class="num amount">' + fmtMoney(r.total) + '</td>'
          + '<td class="num cash">' + (r.cashTotal > 0 ? fmtMoney(r.cashTotal) : '<span style="color:var(--text-3)">—</span>') + '</td>'
          + '<td class="num diff' + (diff < 0 ? ' negative' : '') + '">' + (r.cashTotal > 0 ? fmtMoney(diff) : '<span style="color:var(--text-3)">—</span>') + '</td>'
          + '</tr>';
      }).join('');
    }

    function groupHTML(title, rows) {
      if (!rows.length) return '';
      var sumTotal = rows.reduce(function(s,r){ return s + r.total; }, 0);
      var sumCash  = rows.reduce(function(s,r){ return s + r.cashTotal; }, 0);
      var sumDiff  = sumTotal - sumCash;
      return '<div class="report-group">'
        + '<div class="report-group-title">' + esc(title) + ' <span style="font-weight:400;color:var(--text-3)">(' + rows.length + ' позиций)</span></div>'
        + '<table class="report-table">'
        + '<thead><tr>'
        + '<th>Наименование</th>'
        + '<th class="num">Кол-во</th>'
        + '<th class="num">Цена</th>'
        + '<th class="num">Сумма</th>'
        + '<th class="num">Касса</th>'
        + '<th class="num">Разница</th>'
        + '</tr></thead>'
        + '<tbody>' + rowsHTML(rows) + '</tbody>'
        + '<tfoot><tr>'
        + '<td colspan="3"><b>Итого</b></td>'
        + '<td class="num amount"><b>' + fmtMoney(sumTotal) + '</b></td>'
        + '<td class="num cash"><b>' + fmtMoney(sumCash) + '</b></td>'
        + '<td class="num diff' + (sumDiff < 0 ? ' negative' : '') + '"><b>' + fmtMoney(sumDiff) + '</b></td>'
        + '</tr></tfoot>'
        + '</table></div>';
    }

    var allRows    = services.concat(drugs);
    var grandTotal = allRows.reduce(function(s,r){ return s + r.total; }, 0);
    var grandCash  = allRows.reduce(function(s,r){ return s + r.cashTotal; }, 0);
    var grandDiff  = grandTotal - grandCash;

    // Скидки: позиции их не знают (выручка по позициям — до скидки),
    // а получено денег — после. Итоговый блок обязан это показать,
    // иначе «наличные» в отчёте завышены на сумму скидок.
    var grandDiscount = dayVisits.reduce(function(s,v){ return s + (v.discount||0); }, 0);
    var grandNet = Math.max(0, grandTotal - grandDiscount); // реально получено

    // Суммы по приёмам
    var grandCard   = dayVisits.reduce(function(s,v){ return s + (v.payment_card||0); }, 0);
    var grandCashPaid = Math.max(0, grandNet - grandCard); // наличные = получено − карта
    // Скидку даёт врач — она уменьшает его долю, касса клиники неизменна.
    var doctorShare = Math.max(0, grandTotal - grandCash - grandDiscount);

    // ── Разбивка по врачам ────────────────────────────────────────────
    // Заработок врача = выручка по его приёмам − кассовая стоимость позиций.
    // Считаем по позициям, а не по visit.total_amount: кассовая стоимость
    // живёт именно в позициях, а без неё заработок посчитать нельзя.
    // Приёмы без staff_id собираем в отдельную строку — молча растворять
    // их в общем итоге нельзя, иначе сумма по врачам не сойдётся с выручкой.
    var byDoctor = {};
    var itemsByVisit = {};
    dayVisitItems.forEach(function(vi) {
      (itemsByVisit[vi.visit_id] = itemsByVisit[vi.visit_id] || []).push(vi);
    });
    dayVisits.forEach(function(v) {
      var key = v.staff_id || '(без врача)';
      if (!byDoctor[key]) {
        byDoctor[key] = {
          name: v.staff_id && staffMap[v.staff_id] ? staffMap[v.staff_id].name : 'Врач не указан',
          visits: 0, total: 0, cash: 0, discount: 0
        };
      }
      var row = byDoctor[key];
      row.visits += 1;
      row.discount += v.discount || 0;
      // Выручку берём из позиций, а не из visit.total_amount: итог дня выше
      // считается именно по позициям, и эти числа расходятся (в базе есть приёмы,
      // где total_amount не равен сумме позиций). Иначе таблица по врачам
      // не сходилась бы с выручкой за день.
      (itemsByVisit[v.id] || []).forEach(function(vi) {
        var cat = vi.item_id ? catalogMap[vi.item_id] : null;
        var qty = Number(vi.quantity) || 1;
        row.total += Number(vi.total) || (qty * (Number(vi.price) || 0));
        row.cash  += (cat ? (cat.cost_price || 0) : 0) * qty;
      });
    });
    var doctorRows = Object.keys(byDoctor).map(function(k) {
      var d = byDoctor[k];
      d.share = Math.max(0, d.total - d.cash - d.discount);
      return d;
    }).sort(function(a, b) { return b.share - a.share; });

    var doctorsHTML = doctorRows.length
      ? '<div class="report-group" style="margin-bottom:20px;">'
        + '<div class="report-group-title">' + I('stethoscope') + ' Заработок по врачам</div>'
        + '<table class="report-table"><thead><tr>'
        + '<th>Врач</th><th class="num">Приёмов</th><th class="num">Выручка</th>'
        + '<th class="num">Касса клиники</th><th class="num">Заработок</th>'
        + '</tr></thead><tbody>'
        + doctorRows.map(function(d) {
            return '<tr>'
              + '<td>' + esc(d.name) + '</td>'
              + '<td class="num">' + d.visits + '</td>'
              + '<td class="num amount">' + fmtMoney(d.total) + '</td>'
              + '<td class="num">' + fmtMoney(d.cash) + '</td>'
              + '<td class="num amount" style="color:var(--accent);font-weight:800;">' + fmtMoney(d.share) + '</td>'
              + '</tr>';
          }).join('')
        + '</tbody></table></div>'
      : '';

    // Список приёмов за день
    var sortedVisits = dayVisits.slice().sort(function(a,b){ return (a.date||'') > (b.date||'') ? 1 : -1; });
    var visitListHTML = '<div class="report-group" style="margin-bottom:20px;">'
      + '<div class="report-group-title">Приёмы за день</div>'
      + '<table class="report-table"><thead><tr>'
      + '<th>Вр.</th><th>Животное</th><th>Владелец</th><th class="num">Тип</th>'
      + '<th class="num">Сумма</th><th class="num" style="color:var(--blue)">'+I('card')+' Карта</th><th class="num">'+I('cash')+' Нал.</th>'
      + '</tr></thead><tbody>'
      + sortedVisits.map(function(v) {
          var pet   = petsMap[v.pet_id] || {};
          var owner = ownersMap[pet.owner_id] || {};
          var staff = staffMap && staffMap[v.staff_id] ? staffMap[v.staff_id].name.split(' ')[0] : '—';
          var typeBadge = v.visit_type === 'вторичный'
            ? '<span style="color:var(--blue);font-size:.75rem;">повт.</span>'
            : '<span style="color:var(--accent);font-size:.75rem;">перв.</span>';
          var card = v.payment_card || 0;
          var cash = Math.max(0, (v.total_amount||0) - card);
          return '<tr>'
            + '<td style="font-size:.78rem;color:var(--text-2);">' + esc(staff) + '</td>'
            + '<td>' + esc(pet.name || '—') + (v.animal_weight ? ' <span style="color:var(--text-3);font-size:.78rem;">'+v.animal_weight+' кг</span>' : '') + '</td>'
            + '<td style="font-size:.82rem;">' + esc(owner.fio || '—') + '</td>'
            + '<td class="num">' + typeBadge + '</td>'
            + '<td class="num amount">' + fmtMoney(v.total_amount || 0) + '</td>'
            + '<td class="num" style="color:var(--blue);">' + (card ? fmtMoney(card) : '—') + '</td>'
            + '<td class="num">' + fmtMoney(cash) + '</td>'
            + '</tr>';
        }).join('')
      + '</tbody>'
      + '<tfoot><tr style="font-weight:700;">'
      + '<td colspan="4">Итого</td>'
      + '<td class="num amount">' + fmtMoney(grandTotal) + '</td>'
      + '<td class="num" style="color:var(--blue);">' + fmtMoney(grandCard) + '</td>'
      + '<td class="num">' + fmtMoney(grandCashPaid) + '</td>'
      + '</tr></tfoot>'
      + '</table></div>';

    // Итог расчёта: заработок (уже за вычетом скидок) минус безнал.
    // Наличные собирает врач, карта уходит клинике напрямую — итог показывает,
    // сколько наличных остаётся врачу после сдачи кассы (минус = врач доплачивает
    // клинике / клиника должна врачу с безнала).
    var settleTotal = (grandTotal - grandCash - grandDiscount) - grandCard;

    var noItemsWarn = (noItems && noItems.count)
      ? '<div style="background:#fff8e6;border:1px solid #f0d48a;border-radius:10px;padding:10px 14px;margin-bottom:16px;font-size:.88rem;color:#8a6d1a;">'
        + I('alert') + ' Приёмов без позиций: <b>' + noItems.count + '</b> на <b>' + fmtMoney(noItems.sum) + '</b> — '
        + 'эти суммы не входят в выручку и разбивку по врачам. Откройте приёмы и добавьте услуги.'
        + '</div>'
      : '';

    // Сводка скидок дня
    discountRows = discountRows || [];
    var discountSum = discountRows.reduce(function(s,r){ return s + r.sum; }, 0);
    var discountsHTML = discountRows.length
      ? '<div class="report-group" style="margin-bottom:20px;">'
        + '<div class="report-group-title">' + I('cash') + ' Скидки <span style="font-weight:400;color:var(--text-3)">(' + discountRows.length + ' на ' + fmtMoney(discountSum) + ')</span></div>'
        + '<table class="report-table"><thead><tr><th>Врач</th><th>Животное</th><th class="num">Скидка</th><th>Причина</th></tr></thead><tbody>'
        + discountRows.map(function(r) {
            return '<tr><td>' + esc(r.doctor) + '</td><td>' + esc(r.pet) + '</td>'
              + '<td class="num" style="color:var(--warn);font-weight:700;">−' + fmtMoney(r.sum) + '</td>'
              + '<td style="font-size:.82rem;">' + esc(r.reason) + '</td></tr>';
          }).join('')
        + '</tbody></table></div>'
      : '';

    return '<div class="report-wrap">'
      + '<div class="report-header">'
      + '<h2>Отчёт за ' + esc(fmtDateFull(dateStr)) + (filterName ? ' · ' + esc(filterName) : '') + '</h2>'
      + '<span class="text-muted text-sm">Приёмов: ' + dayVisits.length + '</span>'
      + '</div>'
      + noItemsWarn
      + visitListHTML
      + doctorsHTML
      + discountsHTML
      + groupHTML('Услуги', services)
      + groupHTML('Препараты', drugs)
      + '<div class="report-grand">'
      + '<div class="report-grand-row"><span>'+I('cash')+' Выручка по позициям</span><span>' + fmtMoney(grandTotal) + '</span></div>'
      + (grandDiscount ? '<div class="report-grand-row" style="color:var(--warn);"><span>Скидки</span><span>−' + fmtMoney(grandDiscount) + '</span></div>' : '')
      + '<div class="report-grand-row" style="font-size:1rem;"><span><b>Получено за день</b></span><span style="font-weight:900;">' + fmtMoney(grandNet) + '</span></div>'
      + '<div class="report-grand-row" style="color:var(--blue);"><span>'+I('card')+' Оплата картой (безнал)</span><span>' + fmtMoney(grandCard) + '</span></div>'
      + '<div class="report-grand-row"><span>'+I('cash')+' Наличные</span><span>' + fmtMoney(grandCashPaid) + '</span></div>'
      + '<div class="report-grand-row" style="border-top:1px solid var(--border);margin-top:8px;padding-top:8px;"><span>'+I('hospital')+' Доля клиники (касса)</span><span>' + fmtMoney(grandCash) + '</span></div>'
      + '<div class="report-grand-row grand-diff"><span>'+I('stethoscope')+' Заработок врачей</span><span style="color:var(--accent);font-weight:800;">' + fmtMoney(doctorShare) + '</span></div>'
      + '<div class="report-grand-row" style="border-top:2px solid var(--border);margin-top:8px;padding-top:10px;font-size:1rem;">'
      + '<span><b>Итог расчёта</b> <span class="text-muted text-sm">наличными врачу после сдачи кассы</span></span>'
      + '<span style="font-weight:900;color:' + (settleTotal < 0 ? 'var(--danger, #dc3545)' : 'var(--text)') + ';">' + fmtMoney(settleTotal) + '</span></div>'
      + '</div>'
      + '</div>';
  }

  function fmtQty(n) {
    n = Number(n) || 0;
    return n === Math.floor(n) ? String(Math.floor(n)) : n.toFixed(2);
  }

  function fmtMoney(n) {
    n = Number(n) || 0;
    return n.toLocaleString('ru-RU', { minimumFractionDigits: 0, maximumFractionDigits: 0 }) + ' ₸';
  }

  // ═══════════════════════════════════════════════════════════════════════
  // SETTINGS PAGE
  // ═══════════════════════════════════════════════════════════════════════

  async function initSettings() {
    var settings = await loadClinicSettings();
    var el = function(id){ return document.getElementById(id); };

    if (el('s-clinic-name'))    el('s-clinic-name').value    = settings.name    || '';
    if (el('s-clinic-phone'))   el('s-clinic-phone').value   = settings.phone   || '';
    if (el('s-clinic-address')) el('s-clinic-address').value = settings.address || '';

    // Рабочие часы расписания (по умолчанию 08–20)
    ['s-sched-start','s-sched-end'].forEach(function(id, idx) {
      var sel = el(id);
      if (!sel || sel.options.length) return;
      var cur = idx === 0 ? (settings.sched_start != null ? settings.sched_start : 8)
                          : (settings.sched_end   != null ? settings.sched_end   : 20);
      var opts = '';
      for (var h = 0; h <= 23; h++) {
        opts += '<option value="'+h+'"'+(h===Number(cur)?' selected':'')+'>'+String(h).padStart(2,'0')+':00</option>';
      }
      sel.innerHTML = opts;
    });

    if (settings.logo && el('s-logo-preview')) {
      el('s-logo-preview').src     = settings.logo;
      el('s-logo-preview').style.display = '';
      if (el('s-logo-empty'))  el('s-logo-empty').style.display  = 'none';
      if (el('s-logo-clear'))  el('s-logo-clear').style.display  = '';
    }

    var saveBtn = el('btn-save-settings');
    if (saveBtn) saveBtn.onclick = async function() {
      var schedStart = el('s-sched-start') ? parseInt(el('s-sched-start').value, 10) : 8;
      var schedEnd   = el('s-sched-end')   ? parseInt(el('s-sched-end').value, 10)   : 20;
      if (schedEnd <= schedStart) { UI.toast('Конец рабочего дня должен быть позже начала', 'err'); return; }
      await saveClinicSettings({
        name:    (el('s-clinic-name')    ? el('s-clinic-name').value.trim()    : ''),
        phone:   (el('s-clinic-phone')   ? el('s-clinic-phone').value.trim()   : ''),
        address: (el('s-clinic-address') ? el('s-clinic-address').value.trim() : ''),
        logo:    _pendingLogo !== undefined ? _pendingLogo : settings.logo,
        sched_start: schedStart,
        sched_end:   schedEnd,
      });
      var msg = el('settings-saved-msg');
      if (msg) { msg.style.display=''; setTimeout(function(){ msg.style.display='none'; },2500); }
      _pendingLogo = undefined;
    };

    setupSettingsTabs();
    // Пользователи и телеграм — админские вкладки; грузим по факту наличия.
    if (document.querySelector('[data-spanel="users"]') && window.VetAuth && VetAuth.user() && VetAuth.user().role === 'admin') {
      initUsers();
      initTelegramSettings();
    }
  }

  // ── Вкладки настроек ────────────────────────────────────────────────
  function setupSettingsTabs() {
    var tabs = document.querySelectorAll('#settings-tabs .settings-tab');
    if (!tabs.length) return;
    tabs.forEach(function(tab) {
      tab.onclick = function() {
        var target = tab.dataset.stab;
        tabs.forEach(function(t){ t.classList.toggle('active', t === tab); });
        document.querySelectorAll('.settings-panel').forEach(function(p) {
          p.style.display = (p.dataset.spanel === target) ? '' : 'none';
          p.classList.toggle('active', p.dataset.spanel === target);
        });
      };
    });
  }

  // ── Настройки телеграма/уведомлений ─────────────────────────────────
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

  var _pendingLogo = undefined; // undefined = не менялся

  async function loadClinicSettings() {
    try {
      var raw = await window.VetDB.getSyncState('clinic_settings');
      return raw ? JSON.parse(raw) : {};
    } catch(e) { return {}; }
  }

  async function saveClinicSettings(settings) {
    try {
      await window.VetDB.setSyncState('clinic_settings', JSON.stringify(settings));
      UI.toast('Настройки сохранены', 'ok');
    } catch(e) { UI.toast('Ошибка сохранения', 'err'); }
  }

  // Логотип: любой размер файла — сжимаем на устройстве до 512px.
  // Раньше стоял лимит 300 КБ с отказом, а фото с планшета весит мегабайты:
  // врач выбирал картинку и получал «слишком большой» — это и выглядело
  // как «смена лого не работает».
  async function handleLogoUpload(input) {
    if (!input.files || !input.files[0]) return;
    var file = input.files[0];
    input.value = '';

    function apply(dataURL) {
      _pendingLogo = dataURL;
      var prev  = document.getElementById('s-logo-preview');
      var empty = document.getElementById('s-logo-empty');
      var clear = document.getElementById('s-logo-clear');
      if (prev)  { prev.src = _pendingLogo; prev.style.display = ''; }
      if (empty) empty.style.display = 'none';
      if (clear) clear.style.display = '';
      UI.toast('Логотип загружен — не забудьте сохранить настройки', 'ok');
    }

    // SVG canvas не ресайзит без потери векторности — берём как есть,
    // но с разумным пределом.
    if (file.type === 'image/svg+xml') {
      if (file.size > 300000) { UI.toast('SVG-логотип больше 300 КБ — упростите файл', 'err', 5000); return; }
      var r0 = new FileReader();
      r0.onload = function(e){ apply(e.target.result); };
      r0.readAsDataURL(file);
      return;
    }

    try {
      var bmp = await createImageBitmap(file);
      var MAX = 512;
      var scale = Math.min(1, MAX / Math.max(bmp.width, bmp.height));
      var w = Math.max(1, Math.round(bmp.width * scale));
      var h = Math.max(1, Math.round(bmp.height * scale));
      var c = document.createElement('canvas'); c.width = w; c.height = h;
      c.getContext('2d').drawImage(bmp, 0, 0, w, h);
      // PNG сохраняет прозрачность логотипа; при огромном результате — JPEG
      var out = c.toDataURL('image/png');
      if (out.length > 400000) out = c.toDataURL('image/jpeg', 0.85);
      apply(out);
    } catch (e) {
      UI.toast('Не удалось прочитать файл как изображение', 'err', 5000);
    }
  }

  function clearLogo() {
    _pendingLogo = null;
    var prev  = document.getElementById('s-logo-preview');
    var empty = document.getElementById('s-logo-empty');
    var clear = document.getElementById('s-logo-clear');
    if (prev)  { prev.src = ''; prev.style.display = 'none'; }
    if (empty) empty.style.display = '';
    if (clear) clear.style.display = 'none';
  }

  // ═══════════════════════════════════════════════════════════════════════
  // PRINT VISIT CARD (для владельца животного)
  // ═══════════════════════════════════════════════════════════════════════

  async function printVisitCard(visitId) {
    var allVisits  = await window.VetDB.getAll('visits');
    var allVitems  = await window.VetDB.getAll('visit_items');
    var allPets    = await window.VetDB.getAll('pets');
    var allOwners  = await window.VetDB.getAll('owners');
    var allItems   = await window.VetDB.getAll('items');
    var settings   = await loadClinicSettings();

    var visit  = allVisits.find(function(v){ return v.id===visitId; });
    if (!visit) { UI.toast('Приём не найден', 'err'); return; }

    var pet    = allPets.find(function(p){ return p.id===visit.pet_id; }) || {};
    var owner  = allOwners.find(function(o){ return o.id===pet.owner_id; }) || {};
    var vitems = allVitems.filter(function(vi){ return !vi.is_deleted && vi.visit_id===visitId; });

    var visitDate    = fmtDate(visit.date);
    var nextDate     = visit.next_visit_date ? fmtDate(visit.next_visit_date) : null;
    var isRepeat     = visit.visit_type === 'вторичный';
    var clinicName   = settings.name    || 'VetClinic';
    var clinicPhone  = settings.phone   || '';
    var clinicAddr   = settings.address || '';
    var clinicLogo   = settings.logo    || '';

    // Список препаратов и услуг
    var drugs    = vitems.filter(function(vi){ return vi.type==='drug'; });
    var services = vitems.filter(function(vi){ return vi.type==='service'; });

    var html = `<!DOCTYPE html>
<html lang="ru">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>Карточка приёма — ${esc(pet.name||'')}</title>
<style>
  * { box-sizing:border-box; margin:0; padding:0; }
  body { font-family: 'Arial', sans-serif; font-size:13pt; color:#1a2434; line-height:1.5;
         max-width:700px; margin:0 auto; padding:20px; }
  .header { display:flex; align-items:center; gap:16px; border-bottom:3px solid #1a8c5e;
             padding-bottom:14px; margin-bottom:20px; }
  .header-logo { width:64px; height:64px; object-fit:contain; flex-shrink:0; border-radius:8px; }
  .header-logo-placeholder { width:64px; height:64px; display:flex; align-items:center;
             justify-content:center; font-size:2.5rem; flex-shrink:0; }
  .header-text { flex:1; }
  .clinic-name { font-size:16pt; font-weight:900; color:#1a8c5e; letter-spacing:.5px; }
  .clinic-info { font-size:10pt; color:#526070; margin-top:2px; }
  .doc-title { font-size:11pt; color:#526070; margin-top:4px; }
  .visit-date { font-size:10pt; color:#5d6f81; margin-top:2px; }
  .repeat-badge { display:inline-block; background:#fff2f3; color:#dc3545; border:1.5px solid rgba(220,53,69,.3);
                  padding:3px 12px; border-radius:999px; font-size:10pt; font-weight:700;
                  margin-top:4px; }
  .section { margin-bottom:18px; }
  .section-title {
    font-size:9pt; font-weight:800; text-transform:uppercase; letter-spacing:.8px;
    color:#1a8c5e; border-bottom:1.5px solid #e0e8f2; padding-bottom:4px; margin-bottom:10px;
  }
  .field-row { display:flex; gap:10px; margin-bottom:5px; }
  .field-label { font-weight:700; min-width:120px; color:#526070; font-size:11pt; }
  .field-value { color:#1a2434; font-size:11pt; }
  .diagnosis-box {
    background:#eaf5ee; border-left:4px solid #1a8c5e;
    padding:12px 16px; border-radius:6px; font-size:13pt; font-weight:700; color:#1a2434;
  }
  .treatment-box {
    background:#f7fafd; border:1px solid #e0e8f2; border-radius:6px;
    padding:14px 16px; font-size:12pt; line-height:1.7;
  }
  .drug-list { list-style:none; }
  .drug-list li {
    display:flex; align-items:flex-start; gap:10px;
    padding:8px 12px; border:1px solid #e0e8f2; border-radius:6px;
    margin-bottom:7px; background:#fff;
  }
  .drug-checkbox {
    width:18px; height:18px; border:2px solid #1a8c5e; border-radius:3px;
    flex-shrink:0; margin-top:1px;
  }
  .drug-name { font-weight:700; }
  .drug-qty  { color:#526070; font-size:11pt; }
  .next-visit-box {
    background:#1a8c5e; color:#fff; padding:14px 18px; border-radius:8px;
    display:flex; align-items:center; justify-content:space-between;
  }
  .next-visit-label { font-size:10pt; font-weight:700; text-transform:uppercase; letter-spacing:.5px; opacity:.85; }
  .next-visit-date  { font-size:16pt; font-weight:900; }
  .notes-box {
    background:#fef8ec; border-left:4px solid #c97a0a; padding:12px 16px; border-radius:6px;
  }
  .signature-row {
    display:flex; gap:40px; margin-top:24px; padding-top:16px;
    border-top:1px solid #e0e8f2;
  }
  .sign-field { flex:1; }
  .sign-label { font-size:9pt; color:#5d6f81; margin-bottom:20px; }
  .sign-line  { border-bottom:1px solid #1a2434; height:1px; }
  .no-print   { background:#1a2434; color:#fff; border:none; padding:12px 24px;
                font-size:12pt; font-weight:700; border-radius:8px; cursor:pointer;
                display:block; margin:20px auto 0; }
  @media print {
    body { padding:0; max-width:100%; }
    .no-print { display:none !important; }
  }
</style>
</head>
<body>

<div class="header">
  ${clinicLogo
    ? '<img class="header-logo" src="'+clinicLogo+'" alt="Логотип">'
    : '<div class="header-logo-placeholder">'+I('hospital')+'</div>'}
  <div class="header-text">
    <div class="clinic-name">${esc(clinicName)}</div>
    ${clinicPhone || clinicAddr
      ? '<div class="clinic-info">'+(clinicPhone?''+I('phone')+' '+esc(clinicPhone):'')+(clinicPhone&&clinicAddr?' &nbsp;·&nbsp; ':'')+(clinicAddr?''+I('pin')+' '+esc(clinicAddr):'')+'</div>'
      : ''}
    <div class="doc-title">Рекомендации для владельца животного</div>
    <div class="visit-date">Дата посещения: ${esc(visitDate)}${isRepeat ? ' &nbsp;|&nbsp; <span class="repeat-badge">Повторный приём</span>' : ''}</div>
  </div>
</div>

<div class="section">
  <div class="section-title">Информация о пациенте</div>
  <div class="field-row"><span class="field-label">Кличка:</span><span class="field-value"><b>${esc(pet.name||'—')}</b></span></div>
  <div class="field-row"><span class="field-label">Вид / Порода:</span><span class="field-value">${esc(pet.type||'—')}${pet.breed?' / '+esc(pet.breed):''}</span></div>
  <div class="field-row"><span class="field-label">Пол:</span><span class="field-value">${pet.gender==='m'?'Самец':'Самка'}</span></div>
  <div class="field-row"><span class="field-label">Владелец:</span><span class="field-value">${esc(owner.fio||'—')}</span></div>
  <div class="field-row"><span class="field-label">Телефон:</span><span class="field-value">${esc(owner.phone||'—')}</span></div>
</div>

<div class="section">
  <div class="section-title">Состояние на приёме</div>
  <div class="field-row"><span class="field-label">Состояние:</span><span class="field-value">${esc(visit.patient_condition||'Не указано')}</span></div>
  ${visit.animal_weight ? '<div class="field-row"><span class="field-label">Вес:</span><span class="field-value">'+visit.animal_weight+' кг</span></div>' : ''}
  ${visit.anamnesis ? '<div class="field-row"><span class="field-label">Жалобы:</span><span class="field-value">'+esc(visit.anamnesis)+'</span></div>' : ''}
</div>

<div class="section">
  <div class="section-title">Диагноз</div>
  <div class="diagnosis-box">${esc(visit.diagnosis||'Не указан')}</div>
</div>

<div class="section">
  <div class="section-title">Что нужно делать дома</div>
  <div class="treatment-box">${esc(visit.treatment||'Дополнительного лечения не требуется').replace(/\n/g,'<br>')}</div>
</div>

${drugs.length ? `<div class="section">
  <div class="section-title">Назначенные препараты</div>
  <ul class="drug-list">
    ${drugs.map(function(vi){
      return '<li><div class="drug-checkbox"></div><div>'
        +'<div class="drug-name">'+esc(vi.name||'—')+'</div>'
        +'<div class="drug-qty">Количество: '+fmtQty(vi.quantity)+' шт. &nbsp;·&nbsp; Стоимость: '+fmtMoney(vi.total)+'</div>'
        +'</div></li>';
    }).join('')}
  </ul>
</div>` : ''}

${services.length ? `<div class="section">
  <div class="section-title">Выполненные процедуры</div>
  <ul class="drug-list">
    ${services.map(function(vi){
      return '<li><div class="drug-checkbox" style="background:#e0e8f2;"></div><div>'
        +'<div class="drug-name">'+esc(vi.name||'—')+'</div>'
        +'<div class="drug-qty">'+fmtMoney(vi.total)+'</div>'
        +'</div></li>';
    }).join('')}
  </ul>
  ${visit.discount ? '<div style="text-align:right;margin-top:8px;font-size:10pt;color:#666;">Скидка: −'+fmtMoney(visit.discount)+'</div>' : ''}
  <div style="text-align:right;margin-top:${visit.discount?'2':'8'}px;font-weight:700;font-size:12pt;color:#1a8c5e;">
    Итого: ${fmtMoney(visit.total_amount||0)}
  </div>
</div>` : ''}

${nextDate ? `<div class="section">
  <div class="next-visit-box">
    <span class="next-visit-label">Следующий приём</span>
    <span class="next-visit-date">${I('calendar')} ${esc(nextDate)}</span>
  </div>
</div>` : ''}

${visit.notes ? `<div class="section">
  <div class="section-title">Дополнительные рекомендации</div>
  <div class="notes-box">${esc(visit.notes).replace(/\n/g,'<br>')}</div>
</div>` : ''}

<div class="signature-row">
  <div class="sign-field">
    <div class="sign-label">Подпись врача</div>
    <div class="sign-line"></div>
  </div>
  <div class="sign-field">
    <div class="sign-label">Дата</div>
    <div class="sign-line"></div>
  </div>
  <div class="sign-field">
    <div class="sign-label">Подпись владельца</div>
    <div class="sign-line"></div>
  </div>
</div>

<!-- Кнопки «Распечатать» и «Новый приём» убраны: печать теперь идёт сразу
     через скрытый iframe, промежуточной страницы-предпросмотра больше нет,
     а window.opener из iframe недоступен. -->
</body></html>`;

    printHTML(html);
  }

  // ═══════════════════════════════════════════════════════════════════════
  // UPCOMING APPOINTMENTS REPORT
  // ═══════════════════════════════════════════════════════════════════════

  async function generateUpcomingReport() {
    var daysInput = document.getElementById('upcoming-days');
    var days = daysInput ? parseInt(daysInput.value) || 30 : 30;
    var el = document.getElementById('upcoming-content');
    if (!el) return;
    el.innerHTML = skeletonRows();

    try {
      var allVisits  = await window.VetDB.getAll('visits');
      var allPets    = await window.VetDB.getAll('pets');
      var allOwners  = await window.VetDB.getAll('owners');
      var petsMap    = {}; allPets.forEach(function(p){ petsMap[p.id]=p; });
      var ownersMap  = {}; allOwners.forEach(function(o){ ownersMap[o.id]=o; });

      // Сравниваем даты КАК СТРОКИ 'YYYY-MM-DD' — никаких Date-объектов с setHours.
      // Это устраняет все проблемы с UTC/локальным временем и часовыми поясами.
      var todayStr  = astanaTodayStr();  // '2026-05-31'
      var endDate   = new Date(Date.now() + days * 86400000);
      var endStr    = toAstanaStr(endDate); // 'YYYY-MM-DD' через 30 дней

      // Для каждого питомца берём ПОСЛЕДНИЙ приём у которого есть next_visit_date
      // (один питомец — одна строка в предстоящих)
      var petLatestVisit = {};
      allVisits.forEach(function(v) {
        if (v.is_deleted || !v.next_visit_date) return;
        var ndStr = toAstanaStr(v.next_visit_date); // '2026-05-30'
        // Показываем начиная с сегодня (включительно) и до конца периода
        if (!ndStr || ndStr < todayStr || ndStr > endStr) return;
        var existing = petLatestVisit[v.pet_id];
        if (!existing || new Date(v.date) > new Date(existing.date)) {
          petLatestVisit[v.pet_id] = v;
        }
      });

      // Группируем по дате следующего приёма
      var byDate = {};
      Object.values(petLatestVisit).forEach(function(v) {
        var dateKey = toAstanaStr(v.next_visit_date);
        if (!byDate[dateKey]) byDate[dateKey] = [];
        byDate[dateKey].push(v);
      });

      var sortedDates = Object.keys(byDate).sort();
      if (!sortedDates.length) {
        el.innerHTML = '<div class="report-empty">Нет предстоящих приёмов на ближайшие ' + days + ' дней</div>';
        setReportPrint('btn-print-upcoming', false);
        return;
      }

      var totalCount = Object.values(byDate).reduce(function(s,a){return s+a.length;},0);
      var html = '<div class="report-wrap">'
        + '<div class="report-header"><h2>Предстоящие приёмы (следующие ' + days + ' дней)</h2>'
        + '<span class="text-muted text-sm">Всего: ' + totalCount + '</span></div>';

      sortedDates.forEach(function(dateKey) {
        var visits = byDate[dateKey];
        var isToday = dateKey === todayStr;
        html += '<div class="upcoming-day">'
          + '<div class="upcoming-day-header' + (isToday ? ' upcoming-today' : '') + '">'
          + '<span>' + (isToday ? ''+I('calendar')+' Сегодня — ' : '') + esc(fmtDateFull(dateKey)) + '</span>'
          + '<span class="upcoming-day-count">' + visits.length + '</span>'
          + '</div><table class="history-table"><thead><tr>'
          + '<th>Животное</th><th>Владелец</th><th>Телефон</th><th>Диагноз/анамнез</th><th></th>'
          + '</tr></thead><tbody>';
        visits.forEach(function(v) {
          var pet   = petsMap[v.pet_id]   || {};
          var owner = ownersMap[pet.owner_id] || {};
          html += '<tr style="cursor:pointer;" title="Открыть приём" '
            + 'onclick="navigate(\'visits\');setTimeout(function(){VetPages.editVisit(\''+v.id+'\');},200);">'
            + '<td><b>' + esc(pet.name||'—') + '</b> <span style="color:var(--text-3);font-size:.78rem;">' + esc(pet.type||'') + '</span></td>'
            + '<td>' + esc(owner.fio||'—') + '</td>'
            + '<td><a href="tel:' + esc(owner.phone||'') + '" onclick="event.stopPropagation()" style="color:var(--accent);">' + esc(owner.phone||'—') + '</a></td>'
            + '<td style="font-size:.82rem;color:var(--text-2);">' + esc(v.diagnosis||v.anamnesis||'—') + '</td>'
            + '<td><button class="btn btn-sm btn-primary" onclick="event.stopPropagation();navigate(\'visits\');setTimeout(function(){VetPages.newVisitForPet(\''+v.pet_id+'\');},200);">+ Приём</button></td>'
            + '</tr>';
        });
        html += '</tbody></table></div>';
      });
      html += '</div>';
      el.innerHTML = html;
      setReportPrint('btn-print-upcoming', true);
    } catch(e) {
      el.innerHTML = '<div class="report-empty">Ошибка: ' + esc(e.message) + '</div>';
    }
  }

  // ═══════════════════════════════════════════════════════════════════════
  // NO-SHOWS REPORT
  // ═══════════════════════════════════════════════════════════════════════

  async function generateNoShowsReport() {
    var el = document.getElementById('noshows-content');
    if (!el) return;
    el.innerHTML = skeletonRows();

    try {
      var allVisits  = await window.VetDB.getAll('visits');
      var allPets    = await window.VetDB.getAll('pets');
      var allOwners  = await window.VetDB.getAll('owners');
      var petsMap    = {}; allPets.forEach(function(p){ petsMap[p.id]=p; });
      var ownersMap  = {}; allOwners.forEach(function(o){ ownersMap[o.id]=o; });

      var today = new Date(); today.setHours(0,0,0,0);

      // Группируем визиты по питомцу: последний визит каждого питомца
      var latestByPet = {};
      allVisits.filter(function(v){ return !v.is_deleted; }).forEach(function(v) {
        var key = v.pet_id;
        if (!latestByPet[key] || (v.date||'') > (latestByPet[key].date||'')) {
          latestByPet[key] = v;
        }
      });

      var noShows = [];
      Object.values(latestByPet).forEach(function(v) {
        if (!v.next_visit_date) return;
        var nd = new Date(v.next_visit_date); nd.setHours(0,0,0,0);
        if (nd >= today) return; // ещё не прошла
        // Проверяем: был ли визит ПОСЛЕ next_visit_date
        var hasNewerVisit = allVisits.some(function(v2) {
          return !v2.is_deleted && v2.pet_id === v.pet_id
            && (v2.date||'') > (v.next_visit_date||'') && v2.id !== v.id;
        });
        if (!hasNewerVisit) {
          var overdueDays = Math.floor((today - nd) / 86400000);
          noShows.push({ visit: v, overdueDays: overdueDays });
        }
      });

      // Второй источник: записи расписания со статусом «не пришли»
      // (последние 60 дней). Это ДРУГАЯ проблема: не явились по записи —
      // лечится напоминаниями; не вернулись на повторный — обзвоном.
      var apptNoShows = [];
      try {
        var allAppts = await window.VetDB.getAll('appointments');
        var since = localDateStr(new Date(Date.now() - 60*86400000));
        var staffNS = buildMap(await window.VetDB.getAll('staff'));
        apptNoShows = allAppts.filter(function(a) {
          return !a.is_deleted && a.status === 'no_show' && (a.starts_at||'').slice(0,10) >= since;
        }).sort(function(a,b){ return (a.starts_at||'') < (b.starts_at||'') ? 1 : -1; })
          .map(function(a) {
            var pet = a.pet_id ? petsMap[a.pet_id] : null;
            var owner = a.owner_id ? ownersMap[a.owner_id] : (pet ? ownersMap[pet.owner_id] : null);
            return {
              when:  fmtDate(a.starts_at) + ' ' + (a.starts_at||'').slice(11,16),
              who:   owner ? owner.fio : (a.client_name || '—'),
              phone: owner ? (owner.phone||'') : (a.client_phone || ''),
              pet:   pet ? pet.name : (a.pet_name || '—'),
              doc:   a.staff_id && staffNS[a.staff_id] ? staffNS[a.staff_id].name.split(' ')[0] : '—',
              reason: a.reason || '',
            };
          });
      } catch(e) {}

      if (!noShows.length && !apptNoShows.length) {
        el.innerHTML = '<div class="report-empty">Нет пропущенных приёмов — все клиенты пришли вовремя 👍</div>';
        setReportPrint('btn-print-noshows', false);
        return;
      }

      noShows.sort(function(a,b){ return b.overdueDays - a.overdueDays; });

      var apptNoShowsHTML = apptNoShows.length
        ? '<div class="report-group" style="margin-bottom:20px;">'
          + '<div class="report-group-title">Не явились по записи <span style="font-weight:400;color:var(--text-3)">(' + apptNoShows.length + ' за 60 дней)</span></div>'
          + '<table class="history-table"><thead><tr>'
          + '<th>Когда</th><th>Клиент</th><th>Телефон</th><th>Животное</th><th>Врач</th><th>Причина визита</th>'
          + '</tr></thead><tbody>'
          + apptNoShows.map(function(r) {
              return '<tr><td>' + esc(r.when) + '</td><td>' + esc(r.who) + '</td>'
                + '<td>' + (r.phone ? '<a href="tel:' + esc(r.phone) + '">' + esc(r.phone) + '</a>' : '—') + '</td>'
                + '<td>' + esc(r.pet) + '</td><td>' + esc(r.doc) + '</td>'
                + '<td style="font-size:.82rem;">' + esc(r.reason) + '</td></tr>';
            }).join('')
          + '</tbody></table></div>'
        : '';

      var html = '<div class="report-wrap">'
        + '<div class="report-header"><h2>Не пришли на приём</h2>'
        + '<span class="text-muted text-sm">По записи: ' + apptNoShows.length + ' · не вернулись на повторный: ' + noShows.length + '</span></div>'
        + apptNoShowsHTML
        + '<div class="report-group"><div class="report-group-title">Не вернулись на повторный приём</div>'
        + '<table class="history-table"><thead><tr>'
        + '<th>Владелец</th><th>Телефон</th><th>Животное</th>'
        + '<th>Последний визит</th><th>Дата след. приёма</th><th>Просрочено</th>'
        + '</tr></thead><tbody>';

      noShows.forEach(function(item) {
        var v     = item.visit;
        var pet   = petsMap[v.pet_id]       || {};
        var owner = ownersMap[pet.owner_id] || {};
        html += '<tr>'
          + '<td>' + esc(owner.fio||'—') + '</td>'
          + '<td><a href="tel:' + esc(owner.phone||'') + '">' + esc(owner.phone||'—') + '</a></td>'
          + '<td>' + esc(pet.name||'—') + ' <span style="color:var(--text-3);font-size:.78rem;">' + esc(pet.type||'') + '</span></td>'
          + '<td>' + fmtDate(v.date) + '</td>'
          + '<td>' + fmtDate(v.next_visit_date) + '</td>'
          + '<td class="noshow-overdue">+' + item.overdueDays + ' дн.</td>'
          + '</tr>';
      });
      if (!noShows.length) {
        html += '<tr><td colspan="6" style="color:var(--text-3);text-align:center;">— все вернулись вовремя —</td></tr>';
      }
      html += '</tbody></table></div></div>';
      el.innerHTML = html;
      setReportPrint('btn-print-noshows', true);
    } catch(e) {
      el.innerHTML = '<div class="report-empty">Ошибка: ' + esc(e.message) + '</div>';
    }
  }

  // ═══════════════════════════════════════════════════════════════════════
  // PRINT: OWNER CARD
  // ═══════════════════════════════════════════════════════════════════════

  async function printOwnerCard(ownerId) {
    var allOwners = await window.VetDB.getAll('owners');
    var allPets   = await window.VetDB.getAll('pets');
    var allVisits = await window.VetDB.getAll('visits');
    var settings  = await loadClinicSettings();

    var owner = allOwners.find(function(o){ return o.id===ownerId; });
    if (!owner) { UI.toast('Клиент не найден', 'err'); return; }

    var ownerPets  = allPets.filter(function(p){ return !p.is_deleted && p.owner_id===ownerId; })
                            .sort(function(a,b){ return a.name.localeCompare(b.name,'ru'); });
    var petIds     = {}; ownerPets.forEach(function(p){ petIds[p.id]=p; });
    var ownerVisits = allVisits.filter(function(v){ return !v.is_deleted && petIds[v.pet_id]; })
                               .sort(function(a,b){ return (b.date||'')>(a.date||'')?1:-1; });

    var clinicName  = settings.name    || 'VetClinic';
    var clinicPhone = settings.phone   || '';
    var clinicAddr  = settings.address || '';
    var clinicLogo  = settings.logo    || '';

    var petsRows = ownerPets.map(function(p) {
      var statusLabel = {active:'Активен', deceased:'Умер', lost:'Потерян', transferred:'Передан'}[p.status||'active'] || '';
      var lastVisit = ownerVisits.filter(function(v){ return v.pet_id===p.id; })[0];
      return '<tr>'
        +'<td><b>'+esc(p.name)+'</b></td>'
        +'<td>'+esc(p.type||'')+(p.breed?' / '+esc(p.breed):'')+'</td>'
        +'<td>'+(p.gender==='m'?'♂':'♀')+'</td>'
        +'<td>'+statusLabel+'</td>'
        +'<td>'+(lastVisit?fmtDate(lastVisit.date):'—')+'</td>'
        +'</tr>';
    }).join('');

    var lastVisits = ownerVisits.slice(0,5).map(function(v) {
      var pet = petIds[v.pet_id] || {};
      return '<tr>'
        +'<td>'+fmtDate(v.date)+'</td>'
        +'<td>'+esc(pet.name||'—')+'</td>'
        +'<td>'+esc(v.diagnosis||v.anamnesis||'—')+'</td>'
        +'<td>'+(v.total_amount?Number(v.total_amount).toFixed(0)+' ₸':'—')+'</td>'
        +'</tr>';
    }).join('');

    var html = '<!DOCTYPE html><html lang="ru"><head><meta charset="UTF-8">'
      +'<title>Карточка клиента — '+esc(owner.fio)+'</title>'
      +'<style>'
      +'*{box-sizing:border-box;margin:0;padding:0}'
      +'body{font-family:Arial,sans-serif;font-size:12pt;color:#1a2434;line-height:1.5;max-width:750px;margin:0 auto;padding:20px}'
      +'.header{display:flex;align-items:center;gap:16px;border-bottom:3px solid #1a8c5e;padding-bottom:14px;margin-bottom:20px}'
      +'.header-logo{width:56px;height:56px;object-fit:contain;flex-shrink:0;border-radius:8px}'
      +'.clinic-name{font-size:15pt;font-weight:900;color:#1a8c5e}'
      +'.clinic-info{font-size:9pt;color:#526070;margin-top:2px}'
      +'.doc-title{font-size:10pt;color:#526070;margin-top:3px}'
      +'.owner-block{background:#eaf5ee;border-radius:8px;padding:16px 20px;margin-bottom:18px}'
      +'.owner-name{font-size:16pt;font-weight:900;color:#1a2434;margin-bottom:6px}'
      +'.owner-detail{font-size:11pt;color:#526070;margin-bottom:3px}'
      +'.section-title{font-size:9pt;font-weight:800;text-transform:uppercase;letter-spacing:.7px;color:#1a8c5e;border-bottom:1.5px solid #e0e8f2;padding-bottom:4px;margin:16px 0 10px}'
      +'table{width:100%;border-collapse:collapse;font-size:10.5pt}'
      +'th{background:#eaf5ee;color:#1a8c5e;font-weight:700;text-align:left;padding:7px 10px;font-size:9pt;text-transform:uppercase;letter-spacing:.4px}'
      +'td{padding:7px 10px;border-bottom:1px solid #e0e8f2;vertical-align:top}'
      +'tr:last-child td{border-bottom:none}'
      +'.no-print{background:#1a2434;color:#fff;border:none;padding:10px 22px;font-size:11pt;font-weight:700;border-radius:8px;cursor:pointer;display:block;margin:20px auto 0}'
      +'@media print{body{padding:0;max-width:100%}.no-print{display:none!important}}'
      +'</style></head><body>'
      +'<div class="header">'
      +(clinicLogo?'<img class="header-logo" src="'+clinicLogo+'" alt="">':'<div style="font-size:2.2rem;flex-shrink:0">'+I('hospital')+'</div>')
      +'<div><div class="clinic-name">'+esc(clinicName)+'</div>'
      +(clinicPhone||clinicAddr?'<div class="clinic-info">'+(clinicPhone?''+I('phone')+' '+esc(clinicPhone):'')+(clinicPhone&&clinicAddr?' · ':'')+(clinicAddr?''+I('pin')+' '+esc(clinicAddr):'')+'</div>':'')
      +'<div class="doc-title">Карточка клиента · Распечатано: '+new Date().toLocaleDateString('ru')+'</div>'
      +'</div></div>'
      +'<div class="owner-block">'
      +'<div class="owner-name">'+esc(owner.fio)+'</div>'
      +(owner.phone?'<div class="owner-detail">'+I('phone')+' '+esc(owner.phone)+'</div>':'')
      +(owner.iin?'<div class="owner-detail">ИИН: '+esc(owner.iin)+'</div>':'')
      +(owner.address?'<div class="owner-detail">'+I('pin')+' '+esc(owner.address)+'</div>':'')
      +(owner.notes?'<div class="owner-detail" style="margin-top:6px;font-style:italic">'+esc(owner.notes)+'</div>':'')
      +'</div>'
      +(ownerPets.length
        ?'<div class="section-title">Питомцы ('+ownerPets.length+')</div>'
         +'<table><thead><tr><th>Кличка</th><th>Вид / Порода</th><th>Пол</th><th>Статус</th><th>Посл. визит</th></tr></thead><tbody>'+petsRows+'</tbody></table>'
        :'')
      +(ownerVisits.length
        ?'<div class="section-title">Последние визиты</div>'
         +'<table><thead><tr><th>Дата</th><th>Животное</th><th>Диагноз / Жалоба</th><th>Сумма</th></tr></thead><tbody>'+lastVisits+'</tbody></table>'
        :'')
      +'<button class="no-print" onclick="window.print()">'+I('printer')+' Распечатать</button>'
      +'</body></html>';

    printHTML(html);
  }

  // ═══════════════════════════════════════════════════════════════════════
  // PRINT: PET CARD (паспорт животного)
  // ═══════════════════════════════════════════════════════════════════════

  async function printPetCard(petId) {
    var allPets   = await window.VetDB.getAll('pets');
    var allOwners = await window.VetDB.getAll('owners');
    var allVisits = await window.VetDB.getAll('visits');
    var allVaccs  = await window.VetDB.getAll('vaccinations');
    var settings  = await loadClinicSettings();

    var pet   = allPets.find(function(p){ return p.id===petId; });
    if (!pet) { UI.toast('Животное не найдено', 'err'); return; }
    var owner = allOwners.find(function(o){ return o.id===pet.owner_id; }) || {};

    var petVisits = allVisits.filter(function(v){ return !v.is_deleted && v.pet_id===petId; })
                             .sort(function(a,b){ return (b.date||'')>(a.date||'')?1:-1; });
    var petVaccs  = allVaccs.filter(function(v){ return !v.is_deleted && v.pet_id===petId; })
                            .sort(function(a,b){ return (b.administered_at||'')>(a.administered_at||'')?1:-1; });

    var clinicName  = settings.name    || 'VetClinic';
    var clinicPhone = settings.phone   || '';
    var clinicAddr  = settings.address || '';
    var clinicLogo  = settings.logo    || '';

    // Возраст
    var ageStr = '';
    if (pet.birth_date) {
      try {
        var bd=new Date(pet.birth_date); var now=new Date();
        var mons=(now.getFullYear()-bd.getFullYear())*12+(now.getMonth()-bd.getMonth());
        mons=Math.max(0,mons);
        var yr=Math.floor(mons/12); var mo=mons%12;
        ageStr=yr>0?yr+' л.'+(mo>0?' '+mo+' мес.':''):mo+' мес.';
      } catch(e){}
    }

    var visitsRows = petVisits.slice(0,8).map(function(v) {
      return '<tr>'
        +'<td>'+fmtDate(v.date)+'</td>'
        +'<td>'+esc(v.visit_type||'первичный')+'</td>'
        +'<td>'+esc(v.diagnosis||v.anamnesis||'—')+'</td>'
        +'<td>'+esc(v.treatment||'—')+'</td>'
        +'<td>'+(v.total_amount?Number(v.total_amount).toFixed(0)+' ₸':'—')+'</td>'
        +'</tr>';
    }).join('');

    var vaccsRows = petVaccs.map(function(v) {
      return '<tr>'
        +'<td>'+fmtDate(v.administered_at)+'</td>'
        +'<td><b>'+esc(v.vaccine_name)+'</b></td>'
        +'<td>'+esc(v.manufacturer||'—')+'</td>'
        +'<td>'+esc(v.batch_number||'—')+'</td>'
        +'<td>'+(v.next_due_at?fmtDate(v.next_due_at):'—')+'</td>'
        +'</tr>';
    }).join('');

    var html = '<!DOCTYPE html><html lang="ru"><head><meta charset="UTF-8">'
      +'<title>Паспорт — '+esc(pet.name)+'</title>'
      +'<style>'
      +'*{box-sizing:border-box;margin:0;padding:0}'
      +'body{font-family:Arial,sans-serif;font-size:12pt;color:#1a2434;line-height:1.5;max-width:750px;margin:0 auto;padding:20px}'
      +'.header{display:flex;align-items:center;gap:16px;border-bottom:3px solid #1a8c5e;padding-bottom:14px;margin-bottom:20px}'
      +'.header-logo{width:56px;height:56px;object-fit:contain;flex-shrink:0;border-radius:8px}'
      +'.clinic-name{font-size:15pt;font-weight:900;color:#1a8c5e}'
      +'.clinic-info{font-size:9pt;color:#526070;margin-top:2px}'
      +'.doc-title{font-size:10pt;color:#526070;margin-top:3px}'
      +'.pet-block{display:flex;gap:20px;background:#eaf5ee;border-radius:8px;padding:16px 20px;margin-bottom:18px;align-items:flex-start}'
      +'.pet-photo{width:90px;height:90px;object-fit:cover;border-radius:8px;flex-shrink:0}'
      +'.pet-icon{width:90px;height:90px;border-radius:8px;background:#c6e8d7;display:flex;align-items:center;justify-content:center;font-size:3rem;flex-shrink:0}'
      +'.pet-name{font-size:16pt;font-weight:900;color:#1a2434;margin-bottom:6px}'
      +'.pet-detail{font-size:11pt;color:#526070;margin-bottom:3px}'
      +'.owner-box{background:#f7fafd;border:1px solid #e0e8f2;border-radius:6px;padding:10px 14px;margin-bottom:16px}'
      +'.section-title{font-size:9pt;font-weight:800;text-transform:uppercase;letter-spacing:.7px;color:#1a8c5e;border-bottom:1.5px solid #e0e8f2;padding-bottom:4px;margin:16px 0 10px}'
      +'table{width:100%;border-collapse:collapse;font-size:10pt}'
      +'th{background:#eaf5ee;color:#1a8c5e;font-weight:700;text-align:left;padding:7px 10px;font-size:8.5pt;text-transform:uppercase;letter-spacing:.4px}'
      +'td{padding:7px 10px;border-bottom:1px solid #e0e8f2;vertical-align:top}'
      +'tr:last-child td{border-bottom:none}'
      +'.no-print{background:#1a2434;color:#fff;border:none;padding:10px 22px;font-size:11pt;font-weight:700;border-radius:8px;cursor:pointer;display:block;margin:20px auto 0}'
      +'@media print{body{padding:0;max-width:100%}.no-print{display:none!important}}'
      +'</style></head><body>'
      +'<div class="header">'
      +(clinicLogo?'<img class="header-logo" src="'+clinicLogo+'" alt="">':'<div style="font-size:2.2rem;flex-shrink:0">'+I('hospital')+'</div>')
      +'<div><div class="clinic-name">'+esc(clinicName)+'</div>'
      +(clinicPhone||clinicAddr?'<div class="clinic-info">'+(clinicPhone?''+I('phone')+' '+esc(clinicPhone):'')+(clinicPhone&&clinicAddr?' · ':'')+(clinicAddr?''+I('pin')+' '+esc(clinicAddr):'')+'</div>':'')
      +'<div class="doc-title">Медицинская карточка животного · '+new Date().toLocaleDateString('ru')+'</div>'
      +'</div></div>'
      // Блок животного
      +'<div class="pet-block">'
      +(pet.photo?'<img class="pet-photo" src="'+esc(pet.photo)+'" alt="'+esc(pet.name)+'">'
                :'<div class="pet-icon">'+({собака:'🐕',кошка:'🐈',кот:'🐈',птица:'🦜',кролик:'🐇'}[(pet.type||'').toLowerCase()]||'🐾')+'</div>')
      +'<div>'
      +'<div class="pet-name">'+esc(pet.name)+'</div>'
      +'<div class="pet-detail">'+esc(pet.type||'—')+(pet.breed?' / '+esc(pet.breed):'')+'</div>'
      +'<div class="pet-detail">'+(pet.gender==='m'?'♂ Самец':'♀ Самка')+(ageStr?' · '+ageStr:'')+(pet.weight?' · '+I('scale')+' '+pet.weight+' кг':'')+'</div>'
      +(pet.color?'<div class="pet-detail">Окрас: '+esc(pet.color)+'</div>':'')
      +(pet.birth_date?'<div class="pet-detail">Д/р: '+fmtDate(pet.birth_date)+'</div>':'')
      +(pet.notes?'<div class="pet-detail" style="margin-top:4px;font-style:italic">'+esc(pet.notes)+'</div>':'')
      +'</div></div>'
      // Владелец
      +'<div class="owner-box"><b>Владелец:</b> '+esc(owner.fio||'—')
      +(owner.phone?' &nbsp;·&nbsp; '+I('phone')+' '+esc(owner.phone):'')
      +(owner.address?' &nbsp;·&nbsp; '+I('pin')+' '+esc(owner.address):'')+'</div>'
      // Визиты
      +(petVisits.length
        ?'<div class="section-title">История визитов ('+petVisits.length+')</div>'
         +'<table><thead><tr><th>Дата</th><th>Тип</th><th>Диагноз</th><th>Назначения</th><th>Сумма</th></tr></thead><tbody>'+visitsRows+'</tbody></table>'
         +(petVisits.length>8?'<div style="font-size:9pt;color:#5d6f81;margin-top:6px;text-align:right">Показаны последние 8 из '+petVisits.length+'</div>':'')
        :'<div style="color:#5d6f81;margin:10px 0;">Визитов нет</div>')
      // Вакцинации
      +(petVaccs.length
        ?'<div class="section-title">Вакцинации ('+petVaccs.length+')</div>'
         +'<table><thead><tr><th>Дата</th><th>Вакцина</th><th>Производитель</th><th>Серия</th><th>Следующая</th></tr></thead><tbody>'+vaccsRows+'</tbody></table>'
        :'')
      +'<button class="no-print" onclick="window.print()">'+I('printer')+' Распечатать</button>'
      +'</body></html>';

    printHTML(html);
  }

  // ═══════════════════════════════════════════════════════════════════════
  // PRINT: VACCINATION CARD (справка о вакцинации)
  // ═══════════════════════════════════════════════════════════════════════

  async function printVaccinationCard(vaccId) {
    var allVaccs  = await window.VetDB.getAll('vaccinations');
    var allPets   = await window.VetDB.getAll('pets');
    var allOwners = await window.VetDB.getAll('owners');
    var allStaff  = await window.VetDB.getAll('staff');
    var settings  = await loadClinicSettings();

    var vacc = allVaccs.find(function(v){ return v.id===vaccId; });
    if (!vacc) { UI.toast('Запись не найдена', 'err'); return; }
    var pet   = allPets.find(function(p){ return p.id===vacc.pet_id; }) || {};
    var owner = allOwners.find(function(o){ return o.id===pet.owner_id; }) || {};
    var staff = allStaff.find(function(s){ return s.id===vacc.staff_id; }) || {};

    var clinicName  = settings.name    || 'VetClinic';
    var clinicPhone = settings.phone   || '';
    var clinicAddr  = settings.address || '';
    var clinicLogo  = settings.logo    || '';

    var html = '<!DOCTYPE html><html lang="ru"><head><meta charset="UTF-8">'
      +'<title>Справка о вакцинации — '+esc(pet.name)+'</title>'
      +'<style>'
      +'*{box-sizing:border-box;margin:0;padding:0}'
      +'body{font-family:Arial,sans-serif;font-size:12pt;color:#1a2434;line-height:1.6;max-width:680px;margin:0 auto;padding:24px}'
      +'.header{display:flex;align-items:center;gap:16px;border-bottom:3px solid #1a8c5e;padding-bottom:14px;margin-bottom:22px}'
      +'.header-logo{width:56px;height:56px;object-fit:contain;border-radius:8px;flex-shrink:0}'
      +'.clinic-name{font-size:15pt;font-weight:900;color:#1a8c5e}'
      +'.clinic-info{font-size:9pt;color:#526070;margin-top:2px}'
      +'.cert-title{font-size:14pt;font-weight:900;text-align:center;color:#1a2434;margin:0 0 20px;text-transform:uppercase;letter-spacing:.5px}'
      +'.field-row{display:flex;gap:10px;margin-bottom:9px;align-items:baseline}'
      +'.field-label{font-weight:700;min-width:160px;color:#526070;font-size:11pt;flex-shrink:0}'
      +'.field-value{color:#1a2434;font-size:12pt}'
      +'.vacc-box{background:#eaf5ee;border-left:5px solid #1a8c5e;padding:16px 20px;border-radius:6px;margin:18px 0}'
      +'.vacc-name{font-size:15pt;font-weight:900;color:#1a8c5e;margin-bottom:10px}'
      +'.next-box{background:#1a8c5e;color:#fff;padding:14px 20px;border-radius:8px;display:flex;justify-content:space-between;align-items:center;margin:18px 0}'
      +'.next-label{font-size:9pt;font-weight:700;text-transform:uppercase;letter-spacing:.5px;opacity:.85}'
      +'.next-date{font-size:16pt;font-weight:900}'
      +'.signature-row{display:flex;gap:40px;margin-top:30px;padding-top:16px;border-top:1px solid #e0e8f2}'
      +'.sign-label{font-size:9pt;color:#5d6f81;margin-bottom:22px}'
      +'.sign-line{border-bottom:1px solid #1a2434;height:1px}'
      +'.no-print{background:#1a2434;color:#fff;border:none;padding:10px 22px;font-size:11pt;font-weight:700;border-radius:8px;cursor:pointer;display:block;margin:20px auto 0}'
      +'@media print{body{padding:0;max-width:100%}.no-print{display:none!important}}'
      +'</style></head><body>'
      +'<div class="header">'
      +(clinicLogo?'<img class="header-logo" src="'+clinicLogo+'" alt="">':'<div style="font-size:2.2rem;flex-shrink:0">'+I('hospital')+'</div>')
      +'<div><div class="clinic-name">'+esc(clinicName)+'</div>'
      +(clinicPhone||clinicAddr?'<div class="clinic-info">'+(clinicPhone?''+I('phone')+' '+esc(clinicPhone):'')+(clinicPhone&&clinicAddr?' · ':'')+(clinicAddr?''+I('pin')+' '+esc(clinicAddr):'')+'</div>':'')
      +'</div></div>'
      +'<div class="cert-title">Справка о вакцинации животного</div>'
      +'<div class="field-row"><span class="field-label">Дата вакцинации:</span><span class="field-value"><b>'+fmtDate(vacc.administered_at)+'</b></span></div>'
      +'<div class="field-row"><span class="field-label">Животное:</span><span class="field-value"><b>'+esc(pet.name||'—')+'</b> · '+esc(pet.type||'')+(pet.breed?' / '+esc(pet.breed):'')+'</span></div>'
      +'<div class="field-row"><span class="field-label">Владелец:</span><span class="field-value">'+esc(owner.fio||'—')+(owner.phone?' · '+esc(owner.phone):'')+'</span></div>'
      +(owner.address?'<div class="field-row"><span class="field-label">Адрес:</span><span class="field-value">'+esc(owner.address)+'</span></div>':'')
      +'<div class="vacc-box">'
      +'<div class="vacc-name">'+esc(vacc.vaccine_name)+'</div>'
      +(vacc.manufacturer?'<div class="field-row"><span class="field-label">Производитель:</span><span class="field-value">'+esc(vacc.manufacturer)+'</span></div>':'')
      +(vacc.batch_number?'<div class="field-row"><span class="field-label">Серия / Партия:</span><span class="field-value">'+esc(vacc.batch_number)+'</span></div>':'')
      +(vacc.dose?'<div class="field-row"><span class="field-label">Доза:</span><span class="field-value">'+vacc.dose+' мл</span></div>':'')
      +'</div>'
      +(vacc.next_due_at
        ?'<div class="next-box"><div><div class="next-label">Следующая вакцинация</div><div class="next-date">'+fmtDate(vacc.next_due_at)+'</div></div></div>'
        :'')
      +(vacc.notes?'<div class="field-row" style="margin-top:10px"><span class="field-label">Примечания:</span><span class="field-value">'+esc(vacc.notes)+'</span></div>':'')
      +'<div class="signature-row">'
      +'<div style="flex:1"><div class="sign-label">Ветеринарный врач'+(staff.name?' ('+esc(staff.name)+')':'')+'</div><div class="sign-line"></div></div>'
      +'<div style="flex:1"><div class="sign-label">Печать клиники</div><div class="sign-line"></div></div>'
      +'</div>'
      +'<button class="no-print" onclick="window.print()">'+I('printer')+' Распечатать</button>'
      +'</body></html>';

    printHTML(html);
  }

  // ═══════════════════════════════════════════════════════════════════════
  // OWNER CARD — профиль клиента
  // ═══════════════════════════════════════════════════════════════════════

  function _isAdmin() {
    var u = window.VetAuth && window.VetAuth.user && window.VetAuth.user();
    return !!(u && u.role === 'admin');
  }

  // Право выдавать пароли портала: админ всегда, остальные — по флагу
  // portal_codes в правах (см. настройки пользователя). Сервер проверяет
  // то же самое — кнопка лишь честно отражает доступ.
  function _canIssuePortalCodes() {
    var u = window.VetAuth && window.VetAuth.user && window.VetAuth.user();
    if (!u) return false;
    if (u.role === 'admin') return true;
    return !!(u.permissions && u.permissions.portal_codes);
  }

  // Выдать владельцу пароль для входа на портал.
  // Только онлайн и в обход локальной базы: код живёт на сервере в
  // portal_codes, положить его в offline-очередь нельзя — владелец должен
  // войти прямо сейчас, а очередь уедет неизвестно когда.
  async function issuePortalCode(ownerId) {
    if (!navigator.onLine) {
      UI.toast('Пароль выдаётся только онлайн — нужна связь с сервером', 'err');
      return;
    }
    var base = (window.VetAppConfig && window.VetAppConfig.apiBase) || '';
    var nfetch = window.__nativeFetch || window.fetch.bind(window);
    try {
      var res = await nfetch(base + '/owners/' + ownerId + '/portal-code', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-Bypass-Local': '1',
          'X-Auth-Token': (window.VetAuth && window.VetAuth.token && window.VetAuth.token()) || ''
        }
      });
      // Разбираем ответ вручную: res.json() на 404 (сервер отдаёт текст,
      // а не JSON) бросает исключение, и в общем catch это выглядело бы
      // как «нет связи» — хотя связь есть, а проблема в другом.
      var raw = await res.text();
      var body = null;
      try { body = JSON.parse(raw); } catch(_) {}

      if (!body) {
        UI.toast(res.status === 404
          ? 'Сервер не знает этой команды — обновите версию на сервере'
          : 'Сервер ответил непонятно (HTTP ' + res.status + ')', 'err');
        return;
      }
      if (!res.ok || body.status !== 'ok') {
        UI.toast(body.message || 'Не удалось создать пароль (HTTP ' + res.status + ')', 'err');
        return;
      }
      var d = body.data;
      UI.showModal({
        title: 'Пароль от портала',
        size: 'sm',
        bodyHTML:
            '<div style="text-align:center;padding:6px 2px;">'
          + '<div style="font-size:.82rem;color:var(--text-3);">'+esc(d.fio)+'</div>'
          + '<div style="font-size:2.1rem;font-weight:700;letter-spacing:.18em;'
          + 'margin:14px 0;font-variant-numeric:tabular-nums;">'+esc(d.code)+'</div>'
          + '<div style="font-size:.8rem;color:var(--text-2);line-height:1.5;">'
          + 'Вход на портале по номеру <b>'+esc(d.phone)+'</b> и этому паролю.<br>'
          + 'Действует '+esc(String(d.ttl_minutes))+' мин, срабатывает один раз.'
          + '</div>'
          + '<div style="font-size:.74rem;color:var(--text-3);margin-top:10px;">'
          + 'Прежний пароль владельца больше не действует.'
          + '</div></div>',
        saveLabel: 'Готово',
        cancelLabel: 'Закрыть',
        onSave: function() { UI.hideModal(); }
      });
    } catch(e) {
      // Сюда попадаем только при реальном сетевом сбое: разбор ответа
      // и коды ошибок обработаны выше.
      UI.toast('Нет связи с сервером: ' + (e && e.message ? e.message : 'запрос не дошёл'), 'err');
    }
  }

  async function showOwnerCard(ownerId) {
    var allOwners  = await window.VetDB.getAll('owners');
    var allPets    = await window.VetDB.getAll('pets');
    var allVisits  = await window.VetDB.getAll('visits');

    var owner = allOwners.find(function(o){ return o.id===ownerId; });
    if (!owner) { UI.toast('Клиент не найден', 'err'); return; }

    var ownerPets = allPets.filter(function(p){ return !p.is_deleted && p.owner_id===ownerId; })
                           .sort(function(a,b){ return a.name.localeCompare(b.name,'ru'); });
    var activePets   = ownerPets.filter(function(p){ return p.status==='active'; });
    var deceasedPets = ownerPets.filter(function(p){ return p.status==='deceased'; });

    // Все визиты по питомцам этого владельца
    var petIds = {}; ownerPets.forEach(function(p){ petIds[p.id]=p; });
    var ownerVisits = allVisits.filter(function(v){
        return !v.is_deleted && petIds[v.pet_id];
      }).sort(function(a,b){ return (b.date||'')>(a.date||'')?1:-1; });

    var today = new Date(); today.setHours(0,0,0,0);

    // ── Аватар с инициалами ───────────────────────────────────────
    var parts = (owner.fio||'?').split(/\s+/);
    var initials = parts.length >= 2
      ? parts[0][0]+parts[1][0]
      : (owner.fio||'?').slice(0,2);
    initials = initials.toUpperCase();

    // ── Шапка ────────────────────────────────────────────────────
    var headerHTML = '<div class="oc-header">'
      +'<div class="oc-avatar">'+esc(initials)+'</div>'
      +'<div class="oc-header-info">'
      +'<div class="oc-name">'+esc(owner.fio||'—')+'</div>'
      +'<div class="oc-contact-row">'
      +(owner.phone?'<span class="oc-phone" onclick="location.href=\'tel:'+esc(owner.phone)+'\'">'+I('phone')+' '+esc(owner.phone)+'</span>':'')
      +(owner.iin?'<span class="oc-iin">ИИН: '+esc(owner.iin)+'</span>':'')
      +'</div>'
      +(owner.address?'<div class="oc-address">'+I('pin')+' '+esc(owner.address)+'</div>':'')
      +(owner.notes?'<div style="font-size:.78rem;color:var(--text-3);margin-top:3px;">'+esc(owner.notes)+'</div>':'')
      +'<div class="oc-stats">'
      +'<span class="oc-stat"><b>'+activePets.length+'</b> активных питомцев</span>'
      +'<span class="oc-stat"><b>'+ownerVisits.length+'</b> визитов</span>'
      +(deceasedPets.length?'<span class="oc-stat"><b>'+deceasedPets.length+'</b> умерших</span>':'')
      +'</div>'
      // Пароль от портала — админ или пользователь с правом portal_codes
      // (это доступ к медкартам, право включается в настройках пользователя).
      +(_canIssuePortalCodes()
         ? '<div class="oc-actions"><button class="btn btn-sm btn-ghost" '
           + 'onclick="VetPages.issuePortalCode(\''+ownerId+'\')">'
           + UI.icon('key','') + ' Пароль от портала</button></div>'
         : '')
      +'</div></div>';

    // ── Питомцы ───────────────────────────────────────────────────
    var petsHTML = '';
    if (ownerPets.length) {
      var statusMap = {
        active:      {label:'Активен',  cls:'badge-active'},
        deceased:    {label:'Умер',     cls:'badge-deceased'},
        lost:        {label:'Потерян',  cls:'badge-lost'},
        transferred: {label:'Передан',  cls:'badge-inactive'},
      };
      petsHTML = '<div class="oc-section">'
        +'<div class="oc-section-title"><span>Питомцы</span><span>'+ownerPets.length+'</span></div>'
        +'<div class="oc-pets-grid">'
        +ownerPets.map(function(p){
            var stInfo = statusMap[p.status||'active'] || statusMap.active;
            var spIcon = SPECIES_ICONS[(p.type||'').toLowerCase()] || '🐾';
            var photoEl = p.photo
              ? '<img class="oc-pet-card-photo" src="'+esc(p.photo)+'" alt="'+esc(p.name)+'">'
              : '<div class="oc-pet-card-icon">'+spIcon+'</div>';
            // Возраст
            var ageStr = '';
            if (p.birth_date) {
              try {
                var bd=new Date(p.birth_date); var now=new Date();
                var mons=(now.getFullYear()-bd.getFullYear())*12+(now.getMonth()-bd.getMonth());
                mons=Math.max(0,mons);
                var yr=Math.floor(mons/12); var mo=mons%12;
                ageStr = yr>0 ? yr+' л.'+(mo>0?' '+mo+' мес.':'') : mo+' мес.';
              } catch(e){}
            }
            return '<div class="oc-pet-card'+(p.status==='deceased'?' deceased':'')+'" '
              +'onclick="VetUI.hideModal();setTimeout(function(){VetPages.showPetCard(\''+p.id+'\');},150)">'
              +photoEl
              +'<div class="oc-pet-card-name">'+esc(p.name)+'</div>'
              +'<div class="oc-pet-card-type">'+esc(p.type||'')+(p.breed?' · '+esc(p.breed):'')+'</div>'
              +(ageStr?'<div style="font-size:.72rem;color:var(--text-3);margin-top:2px;">'+esc(ageStr)+'</div>':'')
              +'<span class="badge '+stInfo.cls+'">'+stInfo.label+'</span>'
              +'</div>';
          }).join('')
        +'</div></div>';
    } else {
      petsHTML = '<div class="oc-section">'
        +'<div class="oc-section-title">Питомцы</div>'
        +'<div style="color:var(--text-3);font-size:.88rem;text-align:center;padding:16px 0;">Нет питомцев</div>'
        +'</div>';
    }

    // ── Последние визиты ──────────────────────────────────────────
    var recentHTML = '';
    var recent = ownerVisits.slice(0, 6);
    if (recent.length) {
      // Общая сумма
      var totalSpent = ownerVisits.reduce(function(s,v){ return s+(v.total_amount||0); }, 0);
      recentHTML = '<div class="oc-section">'
        +'<div class="oc-section-title"><span>Последние визиты</span>'
        +'<span style="font-weight:400;color:var(--accent);">'+fmtMoney(totalSpent)+' всего</span></div>'
        +recent.map(function(v){
            var pet = petIds[v.pet_id] || {};
            var spIcon = SPECIES_ICONS[(pet.type||'').toLowerCase()] || '🐾';
            return '<div class="oc-visit-row" onclick="VetUI.hideModal();setTimeout(function(){VetPages.editVisit(\''+v.id+'\');},150)">'
              +'<div class="oc-visit-pet">'+spIcon+'</div>'
              +'<span class="oc-visit-date">'+fmtDate(v.date)+'</span>'
              +'<span class="oc-visit-pet-name">'+esc(pet.name||'—')+'</span>'
              +'<span class="oc-visit-diag">'+esc(v.diagnosis||v.anamnesis||'—')+'</span>'
              +(v.total_amount?'<span class="oc-visit-amt">'+fmtMoney(v.total_amount)+'</span>':'')
              +'</div>';
          }).join('')
        +'</div>';
    }

    // Ближайший предстоящий приём через питомца
    var upcomingVisits = ownerVisits.filter(function(v){
      if (!v.next_visit_date) return false;
      return new Date(v.next_visit_date) >= today;
    }).sort(function(a,b){ return (a.next_visit_date||'')>(b.next_visit_date||'')?1:-1; });
    var upcomingHTML = '';
    if (upcomingVisits.length) {
      var next = upcomingVisits[0];
      var np = petIds[next.pet_id] || {};
      upcomingHTML = '<div class="oc-section">'
        +'<div class="oc-section-title">Следующий запись</div>'
        +'<div style="display:flex;align-items:center;gap:12px;background:var(--accent-dim);border:1.5px solid var(--accent-border);border-radius:var(--r);padding:12px 14px;">'
        +'<span style="font-size:1.5rem;">'+I('calendar')+'</span>'
        +'<div><div style="font-weight:700;font-size:.95rem;color:var(--text);">'+fmtDate(next.next_visit_date)+'</div>'
        +'<div style="font-size:.82rem;color:var(--text-2);">'+esc(np.name||'—')+(np.type?' · '+esc(np.type):'')+'</div></div>'
        +'</div></div>';
    }

    // ── Действия ─────────────────────────────────────────────────
    var actionsHTML = '<div class="oc-actions">'
      +'<button class="oc-action-btn primary" onclick="VetUI.hideModal();setTimeout(function(){'
        +(activePets.length===1
          ? 'VetPages.newVisitForPet(\''+activePets[0].id+'\');'
          : 'navigate(\'visits\');setTimeout(function(){document.getElementById(\'btn-add-visit\').click();},200);')
        +'},150)">'+I('clipboard')+' Новый приём</button>'
      +'<button class="oc-action-btn" onclick="VetUI.hideModal();setTimeout(function(){VetPages.editOwner(\''+ownerId+'\');},150)">'+I('edit')+' Редактировать</button>'
      +'<button class="oc-action-btn" onclick="VetUI.hideModal();setTimeout(function(){VetPages.addPetForOwner(\''+ownerId+'\');},150)">'+I('paw')+' Добавить питомца</button>'
      +'<button class="oc-action-btn" onclick="VetPages.callOwner(\''+esc(owner.phone||'')+'\')">'+I('phone')+' Позвонить</button>'
      +'</div>';

    // ── Сборка ────────────────────────────────────────────────────
    UI.showModal({
      title: '',
      bodyHTML: headerHTML + petsHTML + upcomingHTML + recentHTML + actionsHTML,
      size: 'lg',
      onSave: false,
      cancelLabel: 'Закрыть',
    });

    var mb = document.getElementById('modal-body');
    if (mb) { mb.style.padding='0'; mb.style.overflowY='auto'; }
    var mh = document.querySelector('.modal-header');
    if (mh) mh.style.display='none';
    var mf = document.getElementById('modal-footer');
    if (mf) mf.style.display='none';
  }

  function addPetForOwner(ownerId) {
    var owner = Object.values(_ownersMap||{}).find(function(o){ return o.id===ownerId; })
              || { id: ownerId, fio: '' };
    var ownerName = owner.fio || '';
    UI.showModal({ title: 'Новое животное', bodyHTML: '<div class="form-grid"><div class="form-group form-span-2"><div class="text-sm text-muted">Владелец: <b>'+esc(ownerName)+'</b></div></div></div>' + UI.petFormHTML({ owner_id: ownerId }), size: 'lg',
      afterOpen: UI.checkChip,
      afterOpen: function() { UI.petFormAfterOpen(); },
      onSave: async function() {
        var d = UI.petFormData(); d.owner_id = ownerId;
        if (!d.name) { UI.toast('Введите кличку','err'); return; }
        try { await api('POST','/pets',d); UI.toast('Животное добавлено','ok'); UI.hideModal(); await initPets(); }
        catch(e) { UI.toast(e.message,'err'); }
      }
    });
  }

  function callOwner(phone) {
    if (!phone) { UI.toast('Телефон не указан','warn'); return; }
    window.location.href = 'tel:' + phone;
  }

  // ═══════════════════════════════════════════════════════════════════════
  // PET CARD — профиль питомца (полная карточка)
  // ═══════════════════════════════════════════════════════════════════════

  var SPECIES_ICONS = {
    'кошка':'🐱','собака':'🐶','кролик':'🐰','попугай':'🦜',
    'птица':'🐦','хомяк':'🐹','черепаха':'🐢','морская свинка':'🐭',
    'шиншилла':'🐭','хорёк':'🦡','другое':'🐾',
  };

  async function showPetCard(petId) {
    var allPets   = await window.VetDB.getAll('pets');
    var allOwners = await window.VetDB.getAll('owners');
    var allVisits = await window.VetDB.getAll('visits');
    var allVaccs  = await window.VetDB.getAll('vaccinations');

    var pet = allPets.find(function(p){ return p.id===petId; });
    if (!pet) { UI.toast('Животное не найдено', 'err'); return; }

    var owner = allOwners.find(function(o){ return o.id===pet.owner_id; }) || {};

    var petVisits = allVisits.filter(function(v){ return !v.is_deleted && v.pet_id===petId; })
                             .sort(function(a,b){ return (b.date||'')>(a.date||'')?1:-1; });
    var petVaccs  = allVaccs.filter(function(v){ return !v.is_deleted && v.pet_id===petId; })
                            .sort(function(a,b){ return (b.administered_at||'')>(a.administered_at||'')?1:-1; });

    var lastVisit = petVisits[0] || null;
    var lastVacc  = petVaccs[0]  || null;
    // setHours(0,0,0,0) + toISOString() давали ВЧЕРАШНЮЮ дату: локальная
    // полночь в Астане (+5) — это 19:00 предыдущего дня по UTC.
    var todayStr  = astanaTodayStr();

    // Возраст
    var ageStr = '';
    if (pet.birth_date) {
      try {
        var bd = new Date(pet.birth_date); var now = new Date();
        var mons = (now.getFullYear()-bd.getFullYear())*12+(now.getMonth()-bd.getMonth());
        mons = Math.max(0, mons);
        var yr = Math.floor(mons/12); var mo = mons%12;
        ageStr = yr>0 ? yr+' л.'+(mo>0?' '+mo+' мес.':'') : mo+' мес.';
      } catch(e){}
    }

    // Следующий приём
    var nextVisitDate = lastVisit && lastVisit.next_visit_date ? lastVisit.next_visit_date.slice(0,10) : null;
    var nextVisitOverdue = nextVisitDate && nextVisitDate < todayStr;
    var nextVisitSoon = nextVisitDate && !nextVisitOverdue &&
      nextVisitDate <= toAstanaStr(new Date(Date.now()+7*86400000));

    // Следующая вакцинация
    var nextVaccDate = lastVacc && lastVacc.next_due_at ? lastVacc.next_due_at.slice(0,10) : null;
    var nextVaccOverdue = nextVaccDate && nextVaccDate < todayStr;

    // ── Шапка ────────────────────────────────────────────────────
    var spIcon = SPECIES_ICONS[(pet.type||'').toLowerCase()] || '🐾';
    var photoHTML = pet.photo
      ? '<img class="pc-photo" src="'+esc(pet.photo)+'" alt="'+esc(pet.name)+'">'
      : '<div class="pc-avatar">'+spIcon+'</div>';

    var statusMap = {
      active:      {label:'Активен',  cls:'badge-active'},
      deceased:    {label:'Умер',     cls:'badge-deceased'},
      lost:        {label:'Потерян',  cls:'badge-lost'},
      transferred: {label:'Передан',  cls:'badge-inactive'},
    };
    var stInfo = statusMap[pet.status||'active'] || statusMap.active;
    var genderStr = pet.gender==='m' ? '♂ Самец' : '♀ Самка';
    var weightStr = pet.weight ? pet.weight+' кг' : '';

    var headerHTML = '<div class="pc-header">'
      +photoHTML
      +'<div class="pc-header-info">'
      +'<div class="pc-name">'+esc(pet.name||'—')+'</div>'
      +'<div class="pc-meta">'
      +'<span class="badge '+stInfo.cls+'">'+stInfo.label+'</span>'
      +(ageStr?'<span class="pc-age">'+esc(ageStr)+'</span>':'')
      +(pet.weight?'<span class="pc-age">'+I('scale')+' '+weightStr+'</span>':'')
      +'</div>'
      +(pet.type||pet.breed?'<div class="pc-species">'+spIcon+' '+(pet.type?esc(pet.type):'')+(pet.breed?' · '+esc(pet.breed):'')+'</div>':'')
      +'<div class="pc-gender" style="font-size:.82rem;color:var(--text-2);margin-top:3px;">'+esc(genderStr)+(pet.color?' · '+esc(pet.color):'')+'</div>'
      +'</div></div>';

    // Умерший — баннер
    var deceasedBanner = '';
    if (pet.status==='deceased') {
      deceasedBanner = '<div class="pc-section"><div class="pc-deceased-banner">'
        +'<div class="pc-deceased-icon">💜</div>'
        +'<div><div class="pc-deceased-title">Животное умерло</div>'
        +(pet.death_date?'<div class="pc-deceased-sub">Дата: '+fmtDate(pet.death_date)+'</div>':'')
        +(pet.death_reason?'<div class="pc-deceased-sub">Причина: '+esc(pet.death_reason)+'</div>':'')
        +'</div></div></div>';
    }

    // ── Владелец ─────────────────────────────────────────────────
    var ownerInitials = (owner.fio||'?').split(/\s+/).slice(0,2).map(function(w){return w[0]||'';}).join('').toUpperCase();
    var ownerHTML = '<div class="pc-section">'
      +'<div class="pc-section-title">Владелец</div>'
      +'<div class="pc-owner-row">'
      +'<div class="pc-owner-avatar">'+esc(ownerInitials)+'</div>'
      +'<div><div class="pc-owner-name">'+esc(owner.fio||'—')+'</div>'
      +(owner.phone?'<div class="pc-owner-phone" onclick="location.href=\'tel:'+esc(owner.phone)+'\'">'+I('phone')+' '+esc(owner.phone)+'</div>':'')
      +(owner.address?'<div style="font-size:.78rem;color:var(--text-3);margin-top:2px;">'+I('pin')+' '+esc(owner.address)+'</div>':'')
      +'</div></div></div>';

    // ── Медицинская сводка ────────────────────────────────────────
    function healthCard(label, value, valueCls, extra) {
      return '<div class="pc-health-card">'
        +'<div class="pc-health-label">'+esc(label)+'</div>'
        +'<div class="pc-health-value '+(valueCls||'')+'">'+value+'</div>'
        +(extra?'<div style="font-size:.72rem;color:var(--text-3);margin-top:2px;">'+extra+'</div>':'')
        +'</div>';
    }

    var healthHTML = '<div class="pc-section">'
      +'<div class="pc-section-title">Медицинская сводка</div>'
      +'<div class="pc-health-grid">'
      +healthCard('Последний визит',
          lastVisit ? fmtDate(lastVisit.date) : 'Нет данных',
          lastVisit ? 'ok' : 'none',
          lastVisit && lastVisit.diagnosis ? esc(lastVisit.diagnosis) : '')
      +healthCard('Следующий приём',
          nextVisitDate ? fmtDate(nextVisitDate) : 'Не назначен',
          nextVisitOverdue ? 'overdue' : nextVisitSoon ? 'soon' : (nextVisitDate?'ok':'none'),
          nextVisitOverdue ? ''+I('alert')+' Просрочен' : nextVisitSoon ? ''+I('clock')+' Скоро' : '')
      +healthCard('Последняя вакцинация',
          lastVacc ? fmtDate(lastVacc.administered_at) : 'Нет данных',
          lastVacc ? 'ok' : 'none',
          lastVacc ? esc(lastVacc.vaccine_name) : '')
      +healthCard('Следующая вакцинация',
          nextVaccDate ? fmtDate(nextVaccDate) : 'Не назначена',
          nextVaccOverdue ? 'overdue' : (nextVaccDate?'ok':'none'),
          nextVaccOverdue ? ''+I('alert')+' Просрочена' : '')
      +'</div></div>';

    // ── Последние визиты ──────────────────────────────────────────
    var recentHTML = '';
    var recent = petVisits.slice(0, 5);
    if (recent.length) {
      recentHTML = '<div class="pc-section">'
        +'<div class="pc-section-title">Последние визиты ('+petVisits.length+')</div>'
        + recent.map(function(v){
            var vtIcon = v.visit_type==='вторичный' ? ''+I('refresh')+'' : ''+I('clipboard')+'';
            return '<div class="pc-visit-row" onclick="VetUI.hideModal();setTimeout(function(){VetPages.editVisit(\''+v.id+'\');},150);">'
              +'<span class="pc-visit-date">'+fmtDate(v.date)+'</span>'
              +'<span class="pc-visit-diag">'+esc(v.diagnosis||v.anamnesis||'—')+'</span>'
              +'<span class="pc-visit-type">'+vtIcon+'</span>'
              +(v.total_amount?'<span class="pc-visit-amt">'+fmtMoney(v.total_amount)+'</span>':'')
              +'</div>';
          }).join('')
        +'</div>';
    }

    // ── Примечания питомца ────────────────────────────────────────
    var notesHTML = pet.notes
      ? '<div class="pc-section"><div class="pc-section-title">Примечания</div>'
        +'<div style="font-size:.88rem;color:var(--text-2);line-height:1.6;">'+esc(pet.notes)+'</div></div>'
      : '';

    // ── Действия ─────────────────────────────────────────────────
    var actionsHTML = '<div class="pc-actions">'
      +'<button class="pc-action-btn primary" onclick="VetUI.hideModal();setTimeout(function(){VetPages.newVisitForPet(\''+petId+'\');},150)">'+I('clipboard')+' Новый приём</button>'
      +'<button class="pc-action-btn" onclick="VetUI.hideModal();setTimeout(function(){VetPages.addVaccination(\''+petId+'\');},150)">'+I('syringe')+' Вакцинация</button>'
      +(pet.status==='active'?'<button class="pc-action-btn" onclick="VetUI.hideModal();setTimeout(function(){VetPages.markDeceased(\''+petId+'\');},150)">☠ Умер</button>':'')
      +'<button class="pc-action-btn" onclick="VetUI.hideModal();setTimeout(function(){VetPages.showPetHistory(\''+petId+'\');},150)">📊 История</button>'
      +'<button class="pc-action-btn" onclick="VetUI.hideModal();setTimeout(function(){VetPages.editPet(\''+petId+'\');},150)">'+I('edit')+' Редактировать</button>'
      +'<button class="pc-action-btn" onclick="VetPages.petPhotoInput(\''+petId+'\')">'+I('camera')+' Фото</button>'
      +'</div>';

    // ── Собираем всё ─────────────────────────────────────────────
    UI.showModal({
      title: '',
      bodyHTML: headerHTML + deceasedBanner + ownerHTML + healthHTML + recentHTML + notesHTML + actionsHTML,
      size: 'lg',
      onSave: false,
      cancelLabel: 'Закрыть',
    });

    // Убираем padding в body и заголовок
    var modalBody = document.getElementById('modal-body');
    if (modalBody) { modalBody.style.padding = '0'; modalBody.style.overflowY = 'auto'; }
    var modalHeader = document.querySelector('.modal-header');
    if (modalHeader) modalHeader.style.display = 'none';
    var modalFooter = document.getElementById('modal-footer');
    if (modalFooter) modalFooter.style.display = 'none';
  }

  // ═══════════════════════════════════════════════════════════════════════
  // PET HISTORY REPORTS
  // ═══════════════════════════════════════════════════════════════════════

  // ── Журнал напоминаний (телеграм-бот) ──────────────────────────────
  var NOTIF_KIND = {
    portal_access:   'Доступ к порталу',
    visit_reminder:  'Напоминание о приёме',
    vaccination_due: 'Срок вакцинации',
    custom:          'Сообщение',
  };
  var NOTIF_STATUS = {
    sent:    { label: 'Доставлено', cls: 'badge-active' },
    pending: { label: 'В очереди',  cls: 'badge-course' },
    error:   { label: 'Ошибка',     cls: 'badge-deceased' },
  };

  async function showNotificationsLog() {
    UI.showModal({ title: 'Журнал напоминаний', size: 'lg', onSave: false,
      bodyHTML: '<div id="notif-log" class="report-empty">Загрузка…</div>' });
    var box = document.getElementById('notif-log');
    var data;
    try {
      // Только онлайн и мимо локального перехвата: журнал живёт на сервере.
      var base = (window.VetAppConfig && window.VetAppConfig.apiBase) || '';
      var nfetch = window.__nativeFetch || window.fetch.bind(window);
      var res = await nfetch(base + '/notifications', {
        headers: { 'X-Bypass-Local': '1', 'X-Auth-Token': (window.VetAuth && VetAuth.token && VetAuth.token()) || '' }
      });
      var j = await res.json();
      if (!res.ok || j.status !== 'ok') { box.innerHTML = '<div class="report-empty">'+esc((j&&j.message)||'Не удалось загрузить журнал')+'</div>'; return; }
      data = j.data;
    } catch(e) {
      box.innerHTML = '<div class="report-empty">Журнал доступен только онлайн — нужна связь с сервером</div>';
      return;
    }
    var botWarn = !data.bot_enabled
      ? '<div class="appt-confirm-banner" style="margin:0 0 12px;">'+I('alert')+' Бот выключен на сервере (нет токена). Сообщения копятся в очереди и уйдут после включения.</div>'
      : '';
    var summary = '<div style="display:flex;gap:16px;margin-bottom:12px;font-size:.85rem;">'
      + '<span>Доставлено: <b style="color:var(--accent)">'+(data.count_sent||0)+'</b></span>'
      + '<span>В очереди: <b>'+(data.count_pending||0)+'</b></span>'
      + '<span>Ошибок: <b style="color:var(--danger)">'+(data.count_error||0)+'</b></span></div>';
    var items = data.items || [];
    if (!items.length) { box.innerHTML = botWarn + summary + '<div class="report-empty">Пока ничего не отправлялось</div>'; return; }
    box.innerHTML = botWarn + summary
      + '<table class="history-table"><thead><tr><th>Когда</th><th>Кому</th><th>Тип</th><th>Статус</th></tr></thead><tbody>'
      + items.map(function(n){
          var st = NOTIF_STATUS[n.status] || { label: n.status, cls: '' };
          var when = n.created_at ? fmtDate(n.created_at) + ' ' + String(n.created_at).slice(11,16) : '—';
          var who = esc(n.owner_fio || n.owner_phone || '—');
          var errTitle = n.error ? ' title="'+esc(n.error)+'"' : '';
          return '<tr'+errTitle+'><td style="white-space:nowrap;">'+when+'</td>'
            + '<td>'+who+'</td>'
            + '<td>'+esc(NOTIF_KIND[n.kind]||n.kind)+'</td>'
            + '<td><span class="badge '+st.cls+'">'+esc(st.label)+'</span></td></tr>';
        }).join('')
      + '</tbody></table>';
  }

  // Спарклайн динамики веса: SVG-линия по точкам «дата → вес».
  // Клинически важна траектория (почки, онкология, ожирение), а не таблица.
  // Вход — массив визитов, отсортированный по убыванию даты (как в истории).
  function weightSparklineHTML(descData) {
    var pts = descData.slice().reverse().map(function(v){ return { d: v.date, w: Number(v.animal_weight) }; })
                .filter(function(p){ return !isNaN(p.w) && p.w > 0; });
    if (pts.length < 2) return ''; // одна точка — линию не построить
    var W = 560, H = 120, padX = 40, padY = 16;
    var ws = pts.map(function(p){ return p.w; });
    var minW = Math.min.apply(null, ws), maxW = Math.max.apply(null, ws);
    var range = (maxW - minW) || 1;
    var n = pts.length;
    function x(i){ return padX + (W - 2*padX) * (n === 1 ? 0.5 : i/(n-1)); }
    function y(w){ return padY + (H - 2*padY) * (1 - (w - minW)/range); }
    var line = pts.map(function(p,i){ return (i?'L':'M') + x(i).toFixed(1) + ' ' + y(p.w).toFixed(1); }).join(' ');
    var dots = pts.map(function(p,i){ return '<circle cx="'+x(i).toFixed(1)+'" cy="'+y(p.w).toFixed(1)+'" r="3" fill="var(--accent)"/>'; }).join('');
    var first = pts[0].w, last = pts[n-1].w;
    var trend = last > first ? '▲ +' + (Math.round((last-first)*100)/100) + ' кг'
              : last < first ? '▼ −' + (Math.round((first-last)*100)/100) + ' кг'
              : 'без изменений';
    var trendColor = last > first ? 'var(--accent)' : (last < first ? 'var(--danger)' : 'var(--text-3)');
    return '<div class="weight-spark">'
      + '<div class="weight-spark-head"><span>Динамика веса</span>'
      + '<span style="color:'+trendColor+';font-weight:700;">'+trend+'</span></div>'
      + '<svg viewBox="0 0 '+W+' '+H+'" class="weight-spark-svg" preserveAspectRatio="none">'
      + '<text x="4" y="'+(y(maxW)+4).toFixed(1)+'" class="ws-axis">'+maxW+'</text>'
      + '<text x="4" y="'+(y(minW)+4).toFixed(1)+'" class="ws-axis">'+minW+'</text>'
      + '<path d="'+line+'" fill="none" stroke="var(--accent)" stroke-width="2" stroke-linejoin="round"/>'
      + dots
      + '</svg></div>';
  }

  async function showPetHistory(petId) {
    var allVisits   = await window.VetDB.getAll('visits');
    var allVaccs    = await window.VetDB.getAll('vaccinations');
    var allPets     = await window.VetDB.getAll('pets');
    var pet = allPets.find(function(p){ return p.id===petId; });
    if (!pet) return;

    var petVisits = allVisits.filter(function(v){ return !v.is_deleted && v.pet_id===petId; })
                             .sort(function(a,b){ return (b.date||'')>(a.date||'')?1:-1; });
    var petVaccs  = allVaccs.filter(function(v){ return !v.is_deleted && v.pet_id===petId; })
                            .sort(function(a,b){ return (b.administered_at||'')>(a.administered_at||'')?1:-1; });

    var body = '<div style="display:flex;gap:14px;flex-wrap:wrap;margin-bottom:14px;">'
      // Кнопки
      + '<button class="btn btn-ghost btn-sm" onclick="showHistoryTab(\'visits\')">'+I('clipboard')+' История визитов</button>'
      + '<button class="btn btn-ghost btn-sm" onclick="showHistoryTab(\'disease\')">'+I('microscope')+' История болезней</button>'
      + '<button class="btn btn-ghost btn-sm" onclick="showHistoryTab(\'weight\')">'+I('scale')+' История веса</button>'
      + '<button class="btn btn-ghost btn-sm" onclick="showHistoryTab(\'vacc\')">'+I('syringe')+' Вакцинации</button>'
      + '</div>';

    // Визиты
    body += '<div id="htab-visits">'
      + '<table class="history-table"><thead><tr><th>Дата</th><th>Тип</th><th>Диагноз</th><th>Назначения</th><th>Вес</th><th>Сл. приём</th></tr></thead><tbody>'
      + petVisits.map(function(v){
          return '<tr>'
            +'<td>'+fmtDate(v.date)+'</td>'
            +'<td>'+(v.visit_type||'—')+'</td>'
            +'<td>'+esc(v.diagnosis||v.anamnesis||'—')+'</td>'
            +'<td>'+esc(v.treatment||'—')+'</td>'
            +'<td>'+(v.animal_weight?v.animal_weight+' кг':'—')+'</td>'
            +'<td>'+(v.next_visit_date?fmtDate(v.next_visit_date):'—')+'</td>'
            +'</tr>';
        }).join('')
      + '</tbody></table></div>';

    // Болезни
    var diseases = {};
    petVisits.forEach(function(v){
      if(v.diagnosis){
        diseases[v.diagnosis] = (diseases[v.diagnosis]||0)+1;
      }
    });
    body += '<div id="htab-disease" style="display:none">'
      + '<table class="history-table"><thead><tr><th>Диагноз</th><th>Кол-во случаев</th><th>Последний раз</th></tr></thead><tbody>'
      + Object.keys(diseases).sort().map(function(d){
          var lastVisit = petVisits.find(function(v){return v.diagnosis===d;});
          return '<tr><td>'+esc(d)+'</td><td>'+diseases[d]+'</td><td>'+fmtDate(lastVisit?lastVisit.date:'')+'</td></tr>';
        }).join('')
      + '</tbody></table></div>';

    // Вес
    var weightData = petVisits.filter(function(v){ return v.animal_weight; });
    body += '<div id="htab-weight" style="display:none">'
      + (weightData.length
        ? weightSparklineHTML(weightData)
        + '<table class="history-table"><thead><tr><th>Дата</th><th>Вес</th><th>Изм.</th><th>Диагноз</th></tr></thead><tbody>'
        + weightData.map(function(v, i){
            // weightData отсортирован по убыванию даты: следующий по индексу — предыдущий по времени
            var prev = weightData[i+1];
            var delta = prev && prev.animal_weight ? (v.animal_weight - prev.animal_weight) : null;
            var deltaHTML = delta === null ? '—'
              : (delta === 0 ? '<span style="color:var(--text-3)">0</span>'
                : '<span style="color:'+(delta>0?'var(--accent)':'var(--danger)')+';font-weight:700;">'
                  + (delta>0?'+':'') + (Math.round(delta*100)/100) + '</span>');
            return '<tr><td>'+fmtDate(v.date)+'</td><td><b>'+v.animal_weight+' кг</b></td><td>'+deltaHTML+'</td><td>'+esc(v.diagnosis||'—')+'</td></tr>';
          }).join('')
        + '</tbody></table>'
        : '<div class="report-empty">Данные о весе не записаны</div>')
      + '</div>';

    // Вакцинации
    body += '<div id="htab-vacc" style="display:none">'
      + (petVaccs.length ? '<table class="history-table"><thead><tr><th>Дата</th><th>Вакцина</th><th>Серия</th><th>Следующая</th></tr></thead><tbody>'
        + petVaccs.map(function(v){
            return '<tr><td>'+fmtDate(v.administered_at)+'</td><td>'+esc(v.vaccine_name)+'</td>'
              +'<td>'+esc(v.batch_number||'—')+'</td><td>'+(v.next_due_at?fmtDate(v.next_due_at):'—')+'</td></tr>';
          }).join('')
        + '</tbody></table>'
        : '<div class="report-empty">Вакцинаций нет</div>')
      + '</div>';

    var petAuth = await authorshipHTML('pets', petId);
    UI.showModal({
      title: 'История питомца: ' + pet.name,
      bodyHTML: petAuth + body,
      size: 'xl',
      onSave: false,
      cancelLabel: 'Закрыть',
      afterOpen: function() {}
    });
    document.getElementById('modal-footer').innerHTML =
      '<button class="btn btn-ghost" onclick="window.print()">Печать</button>'
      + '<button class="btn btn-ghost" onclick="VetUI.hideModal()">Закрыть</button>';

    window.showHistoryTab = function(tab) {
      ['visits','disease','weight','vacc'].forEach(function(t){
        var el = document.getElementById('htab-'+t);
        if (el) el.style.display = t===tab ? '' : 'none';
      });
    };
  }

  // ═══════════════════════════════════════════════════════════════════════
  // EXCEL IMPORT / EXPORT FOR CATALOG
  // ═══════════════════════════════════════════════════════════════════════

  function downloadItemTemplate() {
    if (typeof XLSX === 'undefined') {
      UI.toast('Библиотека XLSX не загружена. Проверьте подключение к интернету.', 'err');
      return;
    }
    var wsData = [
      ['Наименование', 'Тип (услуга/препарат)', 'Цена (₸)', 'Кассовая стоимость (₸)'],
      ['Первичный осмотр', 'услуга', 3000, 1800],
      ['Амоксициллин 250мг', 'препарат', 1200, 600],
    ];
    var ws = XLSX.utils.aoa_to_sheet(wsData);
    var wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb, ws, 'Items');
    XLSX.writeFile(wb, 'catalog_template.xlsx');
  }

  async function importItemsExcel(input) {
    if (!input.files || !input.files[0]) return;
    if (typeof XLSX === 'undefined') { UI.toast('XLSX не загружен', 'err'); return; }
    var file = input.files[0];
    input.value = '';
    var reader = new FileReader();
    reader.onload = async function(e) {
      try {
        var wb = XLSX.read(new Uint8Array(e.target.result), {type:'array'});
        var ws = wb.Sheets[wb.SheetNames[0]];
        var rows = XLSX.utils.sheet_to_json(ws, {header:1, defval:''});
        var imported = 0;
        for (var i = 1; i < rows.length; i++) {
          var row = rows[i];
          var name = String(row[0]||'').trim();
          var type = String(row[1]||'').trim().toLowerCase();
          var price = parseFloat(row[2]) || 0;
          var costPrice = parseFloat(row[3]) || 0;
          if (!name) continue;
          if (type !== 'услуга' && type !== 'service') type = 'drug';
          else type = 'service';
          try { await api('POST', '/items', {name:name, type:type, price:price, cost_price:costPrice}); imported++; }
          catch(e) { console.warn('import row', i, e); }
        }
        UI.toast('Импортировано: ' + imported, 'ok');
        await initItems();
      } catch(e) { UI.toast('Ошибка чтения файла: ' + e.message, 'err'); }
    };
    reader.readAsArrayBuffer(file);
  }

  function petPhotoInput(petId) {
    var inp = document.createElement('input');
    inp.type = 'file'; inp.accept = 'image/*';
    inp.onchange = async function() {
      if (!inp.files || !inp.files[0]) return;
      var f = inp.files[0];
      if (f.size > 204800) { UI.toast('Фото > 200кб', 'err'); return; }
      var reader = new FileReader();
      reader.onload = async function(e) {
        var data = e.target.result;
        var all = await window.VetDB.getAll('pets');
        var pet = all.find(function(p){ return p.id===petId; });
        if (!pet) return;
        pet.photo = data; pet.sync_status = 'pending'; pet.updated_at = new Date().toISOString();
        await window.VetDB.save('pets', pet);
        UI.toast('Фото сохранено', 'ok');
        window.dispatchEvent(new Event('vetdata:changed'));
      };
      reader.readAsDataURL(f);
    };
    inp.click();
  }

  function goVisitsToday() {
    var btn = document.querySelector('[data-period="today"]');
    if (btn) btn.click();
    navigate('visits');
  }

  function goVaccThisWeek() {
    // Ставим фильтр до перехода: initVaccinations заберёт его при инициализации.
    _pendingVaccFilter = 'week';
    navigate('vaccinations');
  }

  // Переход к списку животных с активным курсом лечения — фильтр «На лечении».
  function goOnTreatment() {
    navigate('pets');
    setTimeout(function(){
      var f = document.getElementById('filter-pet-status');
      if (f) { f.value = 'on-treatment'; f.dispatchEvent(new Event('change')); }
    }, 250);
  }

  function generateDailyReport(dateStr) {
    if (typeof generateReport === 'function') return generateReport(dateStr);
    var input = document.getElementById('report-date');
    if (input && dateStr) input.value = dateStr;
    var btn = document.getElementById('btn-generate-report');
    if (btn) btn.click();
  }

  // ═══════════════════════════════════════════════════════════════════════
  // PAGE DISPATCHER
  // ═══════════════════════════════════════════════════════════════════════


  // ═══════════════════════════════════════════════════════════════════════
  // ПОЛЬЗОВАТЕЛИ (админка). Работает только при связи с сервером:
  // учётные записи и пароли на устройство не синхронизируются.
  // ═══════════════════════════════════════════════════════════════════════
  var USER_ROLES = [
    { v: 'admin',     l: 'Администратор' },
    { v: 'doctor',    l: 'Врач' },
    { v: 'reception', l: 'Регистратор' },
  ];
  var _users = [];

  async function initUsers() {
    var el = document.getElementById('users-list');
    document.getElementById('btn-add-user').onclick = addUser;
    try {
      _users = await api('GET', '/users');
    } catch(e) {
      el.innerHTML = emptyState('Нет связи с сервером — управление пользователями требует сети');
      return;
    }
    renderUserList();
  }

  function userRoleLabel(v) {
    var r = USER_ROLES.find(function(x){ return x.v === v; });
    return r ? r.l : v;
  }

  function renderUserList() {
    var el = document.getElementById('users-list');
    if (!el) return;
    if (!_users.length) { el.innerHTML = emptyState('Пользователей нет'); return; }
    el.innerHTML = _users.map(function(u) {
      return '<div class="erow" onclick="VetPages.editUser(\''+u.id+'\')">'
        + UI.avatar(u.display_name, 'staff')
        + '<div class="erow-body">'
        + '<div class="erow-title">'+esc(u.display_name)
        + (u.is_active?'':' <span class="badge badge-inactive">Отключён</span>')+'</div>'
        + '<div class="erow-sub">'+esc(u.login)+' · '+esc(userRoleLabel(u.role))+'</div>'
        + '</div>'
        + '<div class="erow-right"><div class="erow-actions">'
        + '<button class="btn btn-icon" onclick="event.stopPropagation();VetPages.editUser(\''+u.id+'\')" title="Редактировать">'+UI.icon('edit','')+'</button>'
        + '</div></div></div>';
    }).join('');
  }

  async function userFormHTML(u) {
    u = u || {};
    var staff = [];
    try { staff = (await window.VetDB.getAll('staff')).filter(function(s){ return !s.is_deleted && s.is_active; }); } catch(e) {}
    return '<div class="form-grid">'
      + '<div class="form-group"><label class="form-label">Логин <span class="form-req">*</span></label>'
      + '<input id="fu-login" class="form-input" autocapitalize="none" value="'+esc(u.login||'')+'" placeholder="ivanov"></div>'
      + '<div class="form-group"><label class="form-label">Имя <span class="form-req">*</span></label>'
      + '<input id="fu-name" class="form-input" value="'+esc(u.display_name||'')+'" placeholder="Иванов Иван"></div>'
      + '<div class="form-group"><label class="form-label">Роль <span class="form-req">*</span></label>'
      + '<select id="fu-role" class="form-select" onchange="var b=document.getElementById(\'fu-perms-block\');if(b)b.style.display=this.value===\'admin\'?\'none\':\'\'">'
      + USER_ROLES.map(function(r){ return '<option value="'+r.v+'"'+(r.v===(u.role||'doctor')?' selected':'')+'>'+r.l+'</option>'; }).join('')
      + '</select></div>'
      + '<div class="form-group"><label class="form-label">'+(u.id?'Новый пароль (пусто — не менять)':'Пароль <span class="form-req">*</span>')+'</label>'
      + '<input id="fu-password" class="form-input" type="password" autocomplete="new-password" placeholder="минимум 6 символов"></div>'
      + '<div class="form-group form-span-2"><label class="form-label">Сотрудник клиники (необязательно)</label>'
      + '<select id="fu-staff" class="form-select"><option value="">— не связан —</option>'
      + staff.map(function(st){ return '<option value="'+st.id+'"'+(st.id===u.staff_id?' selected':'')+'>'+esc(st.name)+'</option>'; }).join('')
      + '</select>'
      + '<div class="form-hint">Пользователь не обязан быть врачом: админ или регистратор — тоже пользователи.</div></div>'
      + permissionsFormHTML(u, staff)
      + (u.id
        ? '<div class="form-group form-span-2"><label class="form-label" style="display:flex;align-items:center;gap:8px;cursor:pointer;">'
          + '<input type="checkbox" id="fu-active"'+(u.is_active!==false?' checked':'')+' style="width:18px;height:18px;"> Учётная запись активна</label></div>'
        : '')
      + '</div>';
  }

  // ── Конструктор прав ────────────────────────────────────────────
  // Для роли admin блок скрыт: админ может всё, права не редактируются.
  var PERM_TABLES = [
    { v: 'visits',       l: 'Приёмы' },
    { v: 'owners',       l: 'Владельцы' },
    { v: 'pets',         l: 'Животные' },
    { v: 'vaccinations', l: 'Вакцинации' },
    { v: 'items',        l: 'Каталог' },
    { v: 'staff',        l: 'Персонал' },
  ];
  var PERM_LEVELS = [
    { v: 'none',   l: 'Нет доступа (скрыть раздел)' },
    { v: 'view',   l: 'Только просмотр' },
    { v: 'create', l: 'Просмотр и создание' },
    { v: 'edit',   l: 'Полный доступ' },
  ];

  function permissionsFormHTML(u, staff) {
    var perms = (u && u.permissions) || {};
    var tables = perms.tables || {};
    var sums = perms.sums || 'all';
    var sumsStaff = perms.sums_staff || [];
    var isAdmin = (u && u.role) === 'admin';

    var rows = PERM_TABLES.map(function(t){
      var cur = tables[t.v] || 'edit';
      return '<div class="perm-row"><span class="perm-table">'+t.l+'</span>'
        + '<select class="form-select perm-select" data-table="'+t.v+'">'
        + PERM_LEVELS.map(function(l){ return '<option value="'+l.v+'"'+(l.v===cur?' selected':'')+'>'+l.l+'</option>'; }).join('')
        + '</select></div>';
    }).join('');

    var staffChecks = staff.map(function(st){
      return '<label class="perm-staff-check"><input type="checkbox" data-sums-staff="'+st.id+'"'
        + (sumsStaff.indexOf(st.id)>=0?' checked':'')+'> '+esc(st.name)+'</label>';
    }).join('');

    return '<div class="form-group form-span-2" id="fu-perms-block"'+(isAdmin?' style="display:none"':'')+'>'
      + '<label class="form-label">Права доступа</label>'
      + '<div class="perm-grid">'+rows+'</div>'
      + '<div style="margin-top:12px;">'
      + '<label class="form-label">Какие суммы видит</label>'
      + '<select id="fu-sums" class="form-select" onchange="document.getElementById(\'fu-sums-staff\').style.display=this.value===\'selected\'?\'\':\'none\'">'
      + '<option value="all"'+(sums==='all'?' selected':'')+'>Все суммы</option>'
      + '<option value="own"'+(sums==='own'?' selected':'')+'>Только свои (нужна связь с сотрудником)</option>'
      + '<option value="selected"'+(sums==='selected'?' selected':'')+'>Суммы выбранных врачей</option>'
      + '</select>'
      + '<div id="fu-sums-staff" class="perm-staff-list" style="'+(sums==='selected'?'':'display:none')+'">'+staffChecks+'</div>'
      + '</div>'
      + '<div style="margin-top:12px;">'
      + '<label class="form-label" style="display:flex;align-items:center;gap:8px;cursor:pointer;">'
      + '<input type="checkbox" id="fu-portal-codes"'+(perms.portal_codes?' checked':'')+' style="width:18px;height:18px;">'
      + ' Может выдавать владельцам пароли для входа в кабинет</label>'
      + '<div class="form-hint">Пароль открывает владельцу его медкарты на портале. Обычно право дают регистратуре.</div>'
      + '</div>'
      + '<div class="form-hint">«Нет доступа» прячет раздел из меню. Сервер не примет правки сверх этих прав, но данные на устройство синхронизируются целиком.</div>'
      + '</div>';
  }

  function collectPermissions() {
    var block = document.getElementById('fu-perms-block');
    if (!block) return null;
    var tables = {};
    var allEdit = true;
    block.querySelectorAll('.perm-select').forEach(function(sel){
      tables[sel.dataset.table] = sel.value;
      if (sel.value !== 'edit') allEdit = false;
    });
    var sums = document.getElementById('fu-sums').value;
    var sumsStaff = [...block.querySelectorAll('[data-sums-staff]:checked')].map(function(c){ return c.dataset.sumsStaff; });
    var portalCodes = !!(document.getElementById('fu-portal-codes') || {}).checked;
    // Всё разрешено, суммы все и спец-прав нет — хранить нечего, пусто = полный доступ.
    // portal_codes при этом по умолчанию ВЫКЛЮЧЕН (см. сервер), поэтому
    // включённый чекбокс обязан попасть в JSON.
    if (allEdit && sums === 'all' && !portalCodes) return null;
    var out = { tables: tables, sums: sums };
    if (sums === 'selected') out.sums_staff = sumsStaff;
    if (portalCodes) out.portal_codes = true;
    return out;
  }

  function userFormData(isEdit) {
    return {
      login: document.getElementById('fu-login').value.trim(),
      display_name: document.getElementById('fu-name').value.trim(),
      role: document.getElementById('fu-role').value,
      password: document.getElementById('fu-password').value,
      staff_id: document.getElementById('fu-staff').value || '',
      is_active: isEdit ? document.getElementById('fu-active').checked : true,
      permissions: collectPermissions(),
    };
  }

  async function addUser() {
    UI.showModal({ title: 'Новый пользователь', bodyHTML: await userFormHTML(), size: 'lg',
      onSave: async function() {
        var d = userFormData(false);
        try { await api('POST', '/users', d); UI.toast('Пользователь создан', 'ok'); UI.hideModal(); await initUsers(); }
        catch(e) { UI.toast(e.message, 'err', 5000); }
      }
    });
  }

  async function editUser(id) {
    var u = _users.find(function(x){ return x.id===id; });
    if (!u) return;
    UI.showModal({ title: 'Пользователь: '+u.display_name, bodyHTML: await userFormHTML(u), size: 'lg',
      onSave: async function() {
        var d = userFormData(true);
        try { await api('PUT', '/users/'+id, d); UI.toast('Сохранено', 'ok'); UI.hideModal(); await initUsers(); }
        catch(e) { UI.toast(e.message, 'err', 5000); }
      }
    });
  }

  // ═══════════════════════════════════════════════════════════════════════
  // ЧИПИРОВАНИЕ: реестр чипов, присвоение, сертификат.
  // Работает офлайн: всё считается из локальной базы.
  // ═══════════════════════════════════════════════════════════════════════
  var _chipPets = [], _chipOwners = {};

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
    var q = (document.getElementById('search-chips')||{}).value || '';
    var qn = q.toLowerCase();
    var qDigits = qn.replace(/\D/g, '');

    var list = _chipPets.filter(function(p){
      if (!p.chip_number) return false;
      if (!q) return true;
      var owner = _chipOwners[p.owner_id] || {};
      var hay = (p.name + ' ' + (p.breed||'') + ' ' + (owner.fio||'')).toLowerCase();
      // Номер сравниваем по цифрам: ввод со сканера бывает с пробелами.
      return hay.includes(qn) || (qDigits && String(p.chip_number).includes(qDigits));
    }).sort(function(a,b){
      // Свежие чипы сверху; без даты — в конец, по кличке.
      var da = a.chip_date || '', db = b.chip_date || '';
      if (da !== db) return da < db ? 1 : -1;
      return (a.name||'').localeCompare(b.name||'', 'ru');
    });

    if (!list.length) {
      el.innerHTML = q ? searchEmpty('search-chips') : emptyState('Чипированных животных пока нет', null, null, 'paw');
      return;
    }
    el.innerHTML = list.map(function(p){
      var owner = _chipOwners[p.owner_id] || {};
      var dead = p.status !== 'active';
      return '<div class="erow" onclick="VetPages.showPetCard(\''+p.id+'\')">'
        + UI.avatar(p.name, p.type)
        + '<div class="erow-body">'
        + '<div class="erow-title"><span class="chip-mono">'+esc(p.chip_number)+'</span>'
        + (dead?' <span class="badge badge-'+p.status+'">'+(p.status==='deceased'?'Умер':'Неактивен')+'</span>':'')+'</div>'
        + '<div class="erow-sub">'+esc(p.name)+' · '+esc(p.type||'')+(p.breed?' · '+esc(p.breed):'')
        + ' · '+esc(owner.fio||'—')+(owner.phone?' · '+I('phone')+' '+esc(owner.phone):'')+'</div>'
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
          chip_date: dateStr + 'T12:00:00Z'
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
          chip_number: chip, chip_date: dateStr + 'T12:00:00Z'
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
      try { pet = (await window.VetDB.getAll('pets')).find(function(p){ return p.id === petId; }); } catch(e) {}
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

  // ═══════════════════════════════════════════════════════════════════════
  // РАСПИСАНИЕ: запись на приём (день, слоты по 30 минут)
  // ═══════════════════════════════════════════════════════════════════════
  //
  // Запись ≠ приём: она может ссылаться на питомца из базы, а может держать
  // только имя/телефон текстом (позвонил новый клиент). «Начать приём»
  // открывает форму приёма и помечает запись выполненной.

  var _schedDate   = null;  // YYYY-MM-DD
  var _schedDoctor = '';
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

    await renderSchedule();
  }

  async function renderSchedule() {
    var grid = document.getElementById('schedule-grid');
    if (!grid) return;
    grid.innerHTML = '<div class="report-empty">Загрузка…</div>';

    var all = [];
    try { all = await window.VetDB.getAll('appointments'); } catch(e) {}
    _schedAppts = all.filter(function(a) {
      if (a.is_deleted) return false;
      if ((a.starts_at||'').slice(0,10) !== _schedDate) return false;
      if (_schedDoctor && a.staff_id !== _schedDoctor) return false;
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
      return '<div class="appt-card '+st.cls+(unconfirmed?' appt-unconfirmed':'')+'" onclick="VetPages.editAppt(\''+a.id+'\')">'
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
          + '<div class="sched-cell" onclick="if(event.target===this)VetPages.newApptAt(\'' + t + '\')" title="Нажмите, чтобы записать на ' + t + '">'
          + appts.map(apptCard).join('')
          + '</div></div>';
      });
    }
    if (!nowLinePlaced) html += '<div class="sched-now-line"><span>' + nowHM + '</span></div>';
    if (bySlot.after) html += '<div class="sched-slot"><div class="sched-time">после ' + SCHED_END_H + ':00</div><div class="sched-cell">' + bySlot.after.map(apptCard).join('') + '</div></div>';
    grid.innerHTML = html;
  }

  function newApptAt(time) { openApptForm(null, time); }
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
  async function openApptForm(appt, defaultTime) {
    await ensureSchedData();
    var isEdit = !!(appt && appt.id);
    appt = appt || {};
    var st = appt.status || 'scheduled';
    var hm = appt.starts_at ? appt.starts_at.slice(11,16) : (defaultTime || '10:00');
    var dateVal = appt.starts_at ? appt.starts_at.slice(0,10) : _schedDate;
    var curStaff = appt.staff_id || (window.VetAuth && VetAuth.user() ? (VetAuth.user().staff_id||'') : '');

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
          + (st !== 'done' && appt.pet_id ? '<button class="btn btn-primary btn-sm" onclick="VetPages.apptStartVisit(\''+esc(appt.id)+'\')">'+I('play')+' Начать приём</button>' : '')
          + (st === 'scheduled' ? '<button class="btn btn-ghost btn-sm" onclick="VetPages.apptSetStatus(\''+esc(appt.id)+'\',\'no_show\')">Не пришли</button>' : '')
          + (st === 'scheduled' ? '<button class="btn btn-ghost btn-sm" onclick="VetPages.apptSetStatus(\''+esc(appt.id)+'\',\'cancelled\')">Отменить запись</button>' : '')
          + (st === 'cancelled' || st === 'no_show' ? '<button class="btn btn-ghost btn-sm" onclick="VetPages.apptSetStatus(\''+esc(appt.id)+'\',\'scheduled\')">Вернуть в запись</button>' : '')
          + '<button class="btn btn-ghost btn-sm danger-text" onclick="VetPages.apptDelete(\''+esc(appt.id)+'\')">Удалить</button>'
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
    try { await api('PUT', '/appointments/' + id, Object.assign({}, a, { status: 'done' })); } catch(e) {}
    UI.hideModal();
    setTimeout(function(){ newVisit(a.pet_id); }, 150);
  }

  // ═══════════════════════════════════════════════════════════════════════
  // ГЛОБАЛЬНЫЙ ПОИСК (шапка): телефон / ФИО / кличка / № чипа
  // ═══════════════════════════════════════════════════════════════════════
  function setupGlobalSearch() {
    var inp = document.getElementById('global-search');
    var dd  = document.getElementById('global-search-dd');
    if (!inp || !dd) return;

    var timer = null;
    var seq = 0;                 // защита от гонки: поздний ответ не затирает свежий
    var cache = null, cacheAt = 0;
    function digits(s){ return String(s||'').replace(/\D/g,''); }

    async function run() {
      var q = inp.value.trim();
      if (q.length < 2) { dd.classList.remove('show'); return; }
      var ql = q.toLowerCase();
      var qd = digits(q);
      var mySeq = ++seq;

      var owners = [], pets = [];
      try {
        // Кэш на 15 секунд: пока человек печатает, база не меняется,
        // а два похода в IndexedDB на каждую букву дают заметный лаг.
        if (!cache || Date.now() - cacheAt > 15000) {
          cache = {
            owners: await window.VetDB.getAll('owners'),
            pets:   await window.VetDB.getAll('pets'),
          };
          cacheAt = Date.now();
        }
        owners = cache.owners; pets = cache.pets;
      } catch(e) { return; }
      if (mySeq !== seq) return; // уже набрали что-то новее

      var ownerHits = owners.filter(function(o) {
        if (o.is_deleted) return false;
        if ((o.fio||'').toLowerCase().includes(ql)) return true;
        if (qd.length >= 5 && digits(o.phone).includes(qd)) return true;
        if (qd.length >= 5 && (o.iin||'').includes(qd)) return true;
        return false;
      }).slice(0, 5);

      var ownersMap = buildMap(owners);
      var petHits = pets.filter(function(p) {
        if (p.is_deleted) return false;
        if ((p.name||'').toLowerCase().includes(ql)) return true;
        if ((p.breed||'').toLowerCase().includes(ql)) return true;
        if (qd.length >= 5 && digits(p.chip_number).includes(qd)) return true;
        return false;
      }).slice(0, 5);

      if (!ownerHits.length && !petHits.length) {
        dd.innerHTML = '<div class="ac-item" style="cursor:default;color:var(--text-3);">Ничего не найдено</div>';
        dd.classList.add('show');
        return;
      }
      dd.innerHTML =
        ownerHits.map(function(o) {
          return '<div class="ac-item" data-kind="owner" data-id="'+o.id+'">'
            + '<div class="ac-item-title">'+I('user')+' '+esc(o.fio)+'</div>'
            + '<div class="ac-item-sub">'+esc(o.phone||'')+'</div></div>';
        }).join('')
        + petHits.map(function(p) {
            var o = ownersMap[p.owner_id] || {};
            return '<div class="ac-item" data-kind="pet" data-id="'+p.id+'">'
              + '<div class="ac-item-title">'+I('paw')+' '+esc(p.name)+(p.status==='deceased'?' †':'')+'</div>'
              + '<div class="ac-item-sub">'+esc(p.type||'')+(o.fio?' · '+esc(o.fio):'')+'</div></div>';
          }).join('');
      dd.classList.add('show');
      dd.querySelectorAll('.ac-item[data-id]').forEach(function(el) {
        el.onmousedown = function(e) { // mousedown — раньше blur, иначе dropdown закроется до клика
          e.preventDefault();
          dd.classList.remove('show');
          inp.value = '';
          if (el.dataset.kind === 'owner') showOwnerCard(el.dataset.id);
          else showPetCard(el.dataset.id);
        };
      });
    }

    inp.addEventListener('input', function() {
      clearTimeout(timer);
      timer = setTimeout(run, 200);
    });
    inp.addEventListener('keydown', function(e) {
      if (e.key === 'Escape') { dd.classList.remove('show'); inp.blur(); }
      if (e.key === 'Enter') run();
    });
    inp.addEventListener('blur', function() { setTimeout(function(){ dd.classList.remove('show'); }, 200); });
  }
  document.addEventListener('DOMContentLoaded', setupGlobalSearch);

  function init(page) {
    var map = {
      'dashboard':        initDashboard,
      'owners':           initOwners,
      'pets':             initPets,
      'visits':           initVisits,
      'schedule':         initSchedule,
      'vaccinations':     initVaccinations,
      'chips':            initChips,
      'items':            initItems,
      'staff':            initStaff,
      'report-daily':     initReportDaily,
      'report-revenue':   initReportRevenue,
      'report-upcoming':  initReportUpcoming,
      'report-noshows':   initReportNoShows,
      'settings':         initSettings,
    };
    var fn = map[page];
    if (fn) fn();
  }

  // ═══════════════════════════════════════════════════════════════════════
  // PUBLIC API
  // ═══════════════════════════════════════════════════════════════════════

  window.VetPages = {
    init:               init,
    goVisitsToday:      goVisitsToday,
    goOnTreatment:      goOnTreatment,
    goVaccThisWeek:     goVaccThisWeek,
    newVisit:           newVisit,
    _visitsShowMore:    _visitsShowMore,
    newApptAt:          newApptAt,
    editAppt:           editAppt,
    apptSetStatus:      apptSetStatus,
    apptDelete:         apptDelete,
    apptStartVisit:     apptStartVisit,
    resetSearch:        resetSearch,
    editVisit:          editVisit,
    copyVisit:          copyVisit,
    copyVaccination:    copyVaccination,
    showVisitHistory:   showVisitHistory,
    pickAttachment:     pickAttachment,
    removeAttachment:   removeAttachment,
    dropQueuedAttachment: dropQueuedAttachment,
    renderAttachments:  renderAttachments,
    deleteVisit:        deleteVisit,
    printVisitCard:     printVisitCard,
    newVisitForPet:     newVisitForPet,
    addOwner:           addOwner,
    _ownersShowMore:    _ownersShowMore,
    _petsShowMore:      _petsShowMore,
    editOwner:          editOwner,
    deleteOwner:        deleteOwner,
    showOwnerCard:      showOwnerCard,
    issuePortalCode:    issuePortalCode,
    printOwnerCard:     printOwnerCard,
    addPet:             addPet,
    editPet:            editPet,
    deletePet:          deletePet,
    showPetCard:        showPetCard,
    printPetCard:       printPetCard,
    showPetHistory:     showPetHistory,
    showNotificationsLog: showNotificationsLog,
    markDeceased:       markDeceased,
    petPhotoInput:      petPhotoInput,
    addPetForOwner:     addPetForOwner,
    callOwner:          callOwner,
    addVaccination:     addVaccination,
    editVaccination:    editVaccination,
    deleteVaccination:  deleteVaccination,
    printVaccinationCard: printVaccinationCard,
    showStaffCard:      showStaffCard,
    printChipCertificate: printChipCertificate,
    _chipMode: _chipMode, _chipOwnerToggle: _chipOwnerToggle,
    editUser:           editUser,
    addItem:            addItem,
    editItem:           editItem,
    deleteItem:         deleteItem,
    downloadItemTemplate: downloadItemTemplate,
    importItemsExcel:   importItemsExcel,
    addStaff:           addStaff,
    editStaff:          editStaff,
    deleteStaff:        deleteStaff,
    generateDailyReport:    generateDailyReport,
    generateUpcomingReport: generateUpcomingReport,
    generateNoShowsReport:  generateNoShowsReport,
    handleLogoUpload:   handleLogoUpload,
    clearLogo:          clearLogo,
  };

}());
