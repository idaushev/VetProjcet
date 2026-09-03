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
  // emptyState(text, ctaLabel, cta, iconName)
  // cta — имя действия ('owner.add') либо {act, data}. Раньше сюда передавали
  // готовый код строкой, и он попадал в onclick — то есть каждый вызов был
  // потенциальной точкой внедрения (см. docs/SECURITY-AUDIT.md, находка 1).
  // iconName — имя иконки из VetIcons (напр. 'search', 'paw'); без него —
  // нейтральный значок «инфо». Разные значки помогают отличить «ещё ничего
  // нет» от «не найдено по фильтру».
  function emptyState(text, ctaLabel, cta, iconName) {
    var iconSvg = (iconName && window.VetIcons)
      ? window.VetIcons.get(iconName, { cls: 'list-empty-icon' })
      : '<svg class="list-empty-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5">'
        + '<circle cx="12" cy="12" r="10"/><path d="M8 15h8M8 9h2m4 0h2"/></svg>';
    return `<div class="list-empty">
      ${iconSvg}
      <span>${esc(text)}</span>
      ${ctaLabel ? '<button class="btn btn-ghost btn-sm list-empty-cta" '+ctaAttrs(cta)+'>'+esc(ctaLabel)+'</button>' : ''}
    </div>`;
  }

  // ctaAttrs принимает 'имя.действия' или {act:'имя', data:{...}}.
  function ctaAttrs(cta) {
    if (!cta) return '';
    if (typeof cta === 'string') return UI.actAttrs(cta, null);
    return UI.actAttrs(cta.act, cta.data);
  }

  // «Ничего не найдено» с кнопкой сброса — отдельный вид пустого состояния
  // для поиска/фильтра: значок лупы + действие «Сбросить поиск».
  function searchEmpty(inputId) {
    return emptyState('Ничего не найдено', 'Сбросить поиск',
      { act: 'search.reset', data: { input: inputId } }, 'search');
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
  // UX-021. Фильтры и строка поиска раздела намеренно переживают переход:
  // вернувшись из карточки владельца, регистратор должен увидеть тот же
  // отобранный список, а не отбирать заново. Но АДРЕСНЫЙ переход — плитка
  // «Приёмов сегодня», «На лечении», «Вакцинаций на неделе» — это обещание
  // показать конкретный срез. Оставшийся с прошлого раза поиск молча сужал
  // его: плитка показывает 3, а список — «Ничего не найдено». Поэтому такие
  // переходы строку поиска очищают, обычная навигация — нет.
  function clearSectionSearch(inputId) {
    var el = document.getElementById(inputId);
    if (el) el.value = '';
  }

  function setupSearch(inputId, renderFn) {
    var el = document.getElementById(inputId);
    if (!el) return;
    // Снимаем предыдущий слушатель (пересоздание при повторном init страницы)
    el.oninput = null;
    el.oninput = function () { renderFn(el.value); };
  }

  // ── Role labels ───────────────────────────────────────────────────────
  var ROLE_LABELS = { vet:'Ветеринар', vet_assistant:'Ветфельдшер', admin:'Администратор', groomer:'Груммер', surgeon:'Хирург', other:'Другое' };

  // Мягкое предупреждение: приём без диагноза оставляет в истории питомца
  // строку «Без диагноза». Не блокируем — осмотр без заключения бывает
  // штатно, но пропуск должен быть осознанным, а не по спешке.
  async function confirmDiagnosis(vs) {
    if (vs.diagnosis) return true;
    var extra = vs.anamnesis ? ' Анамнез записан, но поле диагноза пустое.' : '';
    return await UI.confirm('Приём без диагноза',
      'Диагноз не указан — в истории питомца приём отобразится как «Без диагноза».' + extra + ' Сохранить без диагноза?',
      { yes: 'Сохранить', no: 'Вернуться' });
  }

  // ═══════════════════════════════════════════════════════════════════════
  // DASHBOARD
  // ═══════════════════════════════════════════════════════════════════════

  // Сколько строк показывает панель дашборда. Одно число на все три списка:
  // высота панели должна быть предсказуемой, иначе строка грида растягивается
  // по самой длинной панели и под короткой зияет дыра (было 250px при 5 и 2
  // строках). Полные списки — по ссылке «Все →» в шапке панели.
  var DASH_ROWS = 5;

  async function initDashboard() {
    // Свежая установка: проводим через настройку до того, как человек
    // упрётся в пустые экраны. Внутри проверка — повторно не навязываемся.
    try { await maybeRunSetupWizard(); } catch (e) {}

    refreshModules();  // гейтим раздел «Склад» по флагу модуля
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

      setStat('stat-visits-today',     todayVisits.length);
      setStat('stat-on-treatment',     onTreatmentPets.length);
      setStat('stat-vaccinations-due', dueVacc.length);

      // Записи нужны и четвёртой карточке, и виджету ниже — грузим один раз.
      var allAppts = [];
      try { allAppts = await window.VetDB.getAll('appointments'); } catch(e) { window.VetLog.warn('dashboard:appointments', e); }

      // Четвёртая карточка — под роль: врач видит свои приёмы, остальные —
      // загрузку на завтра. Денег на дашборде нет намеренно: планшет стоит
      // на виду, и сумма дневного дохода читается любым клиентом у стойки.
      // Выручка живёт в «Отчётах», куда нужно зайти осознанно.
      var roleCard = document.getElementById('stat-card-role');
      if (roleCard) {
        var u = window.VetAuth ? VetAuth.user() : null;
        if (u && u.staff_id) {
          var mine = todayVisits.filter(function(v){ return v.staff_id === u.staff_id; });
          setStat('stat-role-value', mine.length);
          setText('stat-role-label', 'Мои приёмы сегодня ↗');
          roleCard.onclick = function(){ goVisitsToday(); };
          roleCard.style.display = '';
        } else if (u) {
          var tomorrow = toAstanaStr(new Date(Date.now() + 86400000));
          var tomorrowAppts = allAppts.filter(function(a){
            return !a.is_deleted && a.status === 'scheduled'
              && (a.starts_at||'').slice(0,10) === tomorrow;
          });
          setStat('stat-role-value', tomorrowAppts.length);
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
              return '<div class="erow" data-act="nav.go" data-page="schedule">'
                + '<span class="dash-appt-time">' + esc((a.starts_at||'').slice(11,16)) + '</span>'
                + '<div class="erow-body"><div class="erow-title">' + esc(petName) + '</div>'
                + '<div class="erow-sub">' + esc(who) + (a.reason ? ' · ' + esc(a.reason) : '') + '</div></div>'
                + (doc ? '<div class="erow-right"><span class="badge badge-course">' + esc(doc) + '</span></div>' : '')
                + '</div>';
            }).join('')
          : emptyState('Записей нет — день свободен', 'Записать клиента', { act: 'nav.go', data: { page: 'schedule' } });
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
          act: 'appt.edit', data: { id: a.id },
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
          act: 'pet.card', data: { id: pid },
          sortKey: '1'+(v.next_due_at||'')
        });
      });
      // 0) Незаполненные результаты — пробу взяли, документа нет.
      //    Ради этого пункта status='pending' и заводится: иначе забытый
      //    анализ всплывает через неделю, когда владелец звонит сам.
      try {
        var pendingRes = (await window.VetDB.getAll('visit_results') || [])
          .filter(function (r) { return !r.is_deleted && r.status !== 'done'; });
        var petsById = {};
        (await window.VetDB.getAll('pets') || []).forEach(function (p) { petsById[p.id] = p; });
        pendingRes.forEach(function (r) {
          var pet = petsById[r.pet_id] || {};
          var day = (r.created_at || '').slice(0, 10);
          var stale = day && day < today;
          attention.push({
            icon: 'microscope', tone: stale ? 'danger' : 'blue',
            title: esc(r.title || 'Результат') + ' — ' + esc(pet.name || 'животное'),
            sub: stale ? 'результата нет с ' + fmtDate(r.created_at) : 'ожидает результата',
            phone: '',
            act: 'result.fill', data: { id: r.id },
            sortKey: (stale ? '0' : '2') + (day || '')
          });
        });
      } catch (e) {}

      // VET-018. Незавершённые приёмы. Врач снял отметку «приём завершён»,
      // чтобы вернуться (ждём анализ, диагноз под вопросом) — и запись должна
      // о себе напоминать. Иначе «допишу потом» остаётся навсегда: раньше
      // такой приём ничем не отличался от закрытого. Показываем только свои,
      // с правом на чужие суммы — все.
      try {
        var myStaffId = (window.VetAuth && VetAuth.user() && VetAuth.user().staff_id) || '';
        var seesAll = !window.VetAuth || VetAuth.sumsScope().mode === 'all';
        (d.visits || []).forEach(function (v) {
          if (v.is_deleted || v.status !== 'draft') return;
          if (!seesAll && myStaffId && v.staff_id && v.staff_id !== myStaffId) return;
          var pet = (d.pets || []).find(function (p) { return p.id === v.pet_id; }) || {};
          var day = (v.date || '').slice(0, 10);
          var old = day && day < today;
          attention.push({
            icon: 'clipboard', tone: old ? 'warn' : 'blue',
            title: 'Приём не завершён — ' + esc(pet.name || 'животное'),
            sub: old ? 'с ' + fmtDate(v.date) : 'сегодня',
            phone: '',
            act: 'visit.edit', data: { id: v.id },
            sortKey: (old ? '1' : '2') + (day || '')
          });
        });
      } catch (e) {}

      // 0) Ручные задачи сотрудников — в той же очереди: у врача один
      //    рабочий список на день, а не отдельный экран задач.
      var manualTasks = await loadTasks();
      manualTasks.filter(function (t) { return !t.done; }).forEach(function (t) {
        var due = (t.due_date || '').slice(0, 10);
        var overdue = due && due < today;
        attention.push({
          icon: 'clipboard', tone: overdue ? 'danger' : 'blue',
          title: esc(t.title),
          sub: (due ? (overdue ? 'просрочено, срок ' : 'срок ') + fmtDate(t.due_date) : 'задача')
               + (t.note ? ' · ' + esc(t.note) : ''),
          phone: '',
          act: 'task.complete', data: { id: t.id },
          sortKey: (overdue ? '0' : '3') + (due || '')
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
          act: 'pet.card', data: { id: pid },
          sortKey: '2'+(v.next_visit_date||'')
        });
      });

      var attCard = document.getElementById('dash-attention-card');
      var attEl = document.getElementById('dash-attention');
      var attCount = document.getElementById('dash-attention-count');
      if (attCard && attEl) {
        if (!attention.length) {
          // Раньше блок просто прятали. Теперь в нём живёт кнопка «+ Задача»,
          // и пряча блок, мы прятали бы единственный способ её создать.
          attCard.style.display = '';
          attCard.style.borderColor = 'var(--border)';
          if (attCount) attCount.textContent = '';
          attEl.innerHTML = '<div class="text-sm text-muted" style="padding:6px 0;">'
            + 'Ничего не требует внимания. Задачу можно добавить кнопкой выше.</div>';
        } else {
          attCard.style.borderColor = '';
          attention.sort(function(a,b){ return a.sortKey < b.sortKey ? -1 : 1; });
          if (attCount) attCount.textContent = attention.length;
          attEl.innerHTML = attention.slice(0, 12).map(function(x){
            var callBtn = x.phone
              ? '<a class="btn btn-icon btn-open" href="tel:'+esc(String(x.phone).replace(/[^\d+]/g,''))+'" data-act="noop" title="Позвонить" aria-label="Позвонить">'+I('phone')+'</a>'
              : '';
            return '<div class="erow" '+UI.actAttrs(x.act, x.data)+'>'
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

      // Сортировка по ISO-строке, а не по new Date: порядок тот же, но без
      // двух аллокаций Date на каждое сравнение (см. TECH-003).
      var recentVisits = d.visits.filter(function(v){ return !v.is_deleted; }).sort(function(a,b){
        return (b.date || '') > (a.date || '') ? 1 : -1;
      }).slice(0, DASH_ROWS);

      var recentEl = document.getElementById('recent-visits');
      if (!recentEl) return;
      if (!recentVisits.length) { recentEl.innerHTML = emptyState('Приёмов ещё нет', '+ Новый приём', 'visit.new'); return; }
      recentEl.innerHTML = recentVisits.map(function(v) {
        var pet = petsMap[v.pet_id] || {};
        var owner = ownersMap[pet.owner_id] || {};
        var visitTypeBadge = v.visit_type === 'вторичный' ? '<span class="badge badge-service" style="margin-left:6px;">Вторичный</span>' : '';
        // VET-003: незавершённый приём видно прямо в списке — иначе запись,
        // к которой врач собирался вернуться, ничем не отличается от закрытой.
        var draftBadge = v.status === 'draft' ? '<span class="badge badge-draft" style="margin-left:6px;">Не завершён</span>' : '';
        return '<div class="erow" data-act="visit.edit" data-id="'+v.id+'">'
          +UI.avatar(pet.name||'?',pet.type)
          +'<div class="erow-body"><div class="erow-title">'+esc(pet.name||'Неизвестно')+visitTypeBadge+draftBadge+'</div>'
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
              return '<div class="erow" data-act="pet.card" data-id="'+c.pet.id+'">'
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
  // UX-010. Счётчик дашборда: за нулём НЕТ действия, а крупный цветной ноль
  // перетягивал внимание с блока «Требуют внимания» — ровно то, на что
  // жаловался аудит («первым в глаза попадает не то, что требует действия»).
  // Нулевые плитки гасим, значимые оставляем цветными.
  function setStat(id, val) {
    var el = document.getElementById(id);
    if (!el) return;
    el.textContent = String(val);
    var card = el.closest('.stat-card');
    if (card) card.classList.toggle('stat-zero', !Number(val));
  }
  function buildMap(arr) { var m={}; (arr||[]).forEach(function(x){ m[x.id]=x; }); return m; }

  // Скелетон загрузки: несколько «пустых» строк с шиммером вместо голого
  // текста «Загрузка…». На планшете при рефреше меньше моргает и ощущается
  // быстрее. Ширины детерминированы (не случайны), чтобы блок не «дрожал».
  var _skWidths = [58, 42, 66, 48, 60, 52];
  // Показать «загружается» — только если показывать пока нечего. При
  // возврате в раздел список уже отрисован, и подмена его серыми полосками
  // читалась бы как мигание, а не как загрузка.
  function showLoading(elId) {
    var el = document.getElementById(elId);
    if (el && !el.children.length) el.innerHTML = skeletonRows();
  }

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
    showLoading('owners-list');
    var [owners, pets] = await Promise.all([api('GET','/owners'), api('GET','/pets?status=all')]);
    _owners = owners || [];
    _petsMap = buildMap(pets || []);
    _ownersLimit = 60;
    // Без второго аргумента renderOwnerList берёт запрос из самого поля.
    // Раньше здесь стояла явная пустая строка, и при возврате в раздел список
    // рисовался НЕотфильтрованным, хотя в поле поиска запрос оставался:
    // управление говорило «отобрано», содержимое показывало всё.
    renderOwnerList(_owners);
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
      el.innerHTML = q ? searchEmpty('search-owners') : emptyState('Владельцев ещё нет', '+ Владелец', 'owner.add', 'user');
      return;
    }
    var ownersTotal = owners.length;
    var ownersMore = ownersTotal > _ownersLimit;
    if (ownersMore) owners = owners.slice(0, _ownersLimit);
    var petCountMap = {};
    Object.values(_petsMap).forEach(function(p){ if(!p.is_deleted && p.status==='active') petCountMap[p.owner_id] = (petCountMap[p.owner_id]||0)+1; });
    el.innerHTML = owners.map(function(o) {
      var cnt = petCountMap[o.id] || 0;
      return '<div class="erow" data-act="owner.card" data-id="'+o.id+'">'
        + UI.avatar(o.fio, 'owner')
        + '<div class="erow-body">'
        + '<div class="erow-title">'+hl(o.fio,q)+'</div>'
        + '<div class="erow-sub">'+hl(o.phone||'',q)+(o.iin?' &nbsp;·&nbsp; ИИН: '+hl(o.iin,q):'')+'</div>'
        // Адрес из строки убран намеренно. Он был необязательной третьей
        // строкой: у владельцев с адресом строка становилась 98px, без него
        // 77px — список терял ритм. Резервировать пустую строку тоже плохо:
        // все строки вырастали до 95px, и на экран помещалось меньше.
        // Адрес при просмотре списка не нужен — он есть в карточке владельца.
        + '</div>'
        + '<div class="erow-right">'
        + (cnt ? '<span class="badge badge-active">'+cnt+' пит.</span>' : '<span style="font-size:.72rem;color:var(--text-3);">нет питомцев</span>')
        + '<div class="erow-actions">'
        + '<button class="btn btn-icon" data-act="owner.edit" data-id="'+o.id+'" title="Редактировать" aria-label="Редактировать">'+UI.icon('edit','')+'</button>'
        + UI.rowMenu([
            {label:'Печать карточки', icon:'print', act:'owner.print', data:{id:o.id}},
            {sep:true},
            {label:'Удалить', icon:'trash', danger:true, act:'owner.delete', data:{id:o.id}}
          ])
        + '</div></div></div>';
    }).join('')
    + (ownersMore
        ? '<div class="list-more"><button class="btn btn-ghost" data-act="owners.more">Показать ещё (' + (ownersTotal - _ownersLimit) + ')</button></div>'
        : '');
  }

  async function addOwner() {
    UI.showModal({ title: 'Новый владелец', bodyHTML: UI.ownerFormHTML(), size: 'lg',
      afterOpen: UI.checkIIN,
      onSave: async function() {
        var d = UI.ownerFormData();
        if (!d.fio || !d.phone) { UI.markInvalid(['f-fio','f-phone']); UI.toast('Заполните обязательные поля', 'err'); return; }
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
      // Считаем подсказку сразу: старый ИИН с опечаткой должен быть виден
      // при открытии карточки, а не только после правки поля.
      afterOpen: UI.checkIIN,
      onSave: async function() {
        var d = UI.ownerFormData();
        if (!d.fio || !d.phone) { UI.markInvalid(['f-fio','f-phone']); UI.toast('Заполните обязательные поля', 'err'); return; }
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
    showLoading('pets-list');
    var [pets, owners, visits] = await Promise.all([
      api('GET','/pets?status=all'), api('GET','/owners'), api('GET','/visits')
    ]);
    _pets = pets || [];
    _ownersMap = buildMap(owners || []);
    _coursesByPet = buildCourses(visits);
    _petsLimit = 60;
    setupSearch('search-pets', function(q){ _petsLimit = 60; renderPetList(); });

    // Список рисуется по _petStatusFilter, а человек видит селект: сводим их
    // при каждом входе в раздел. Иначе они могли разойтись — ровно тот же
    // разлад «управление говорит одно, содержимое показывает другое», что был
    // у владельцев.
    var statusSel = document.getElementById('filter-pet-status');
    statusSel.value = _petStatusFilter;
    statusSel.onchange = function() { _petStatusFilter = this.value; _petsLimit = 60; renderPetList(); };
    document.getElementById('btn-add-pet').onclick = addPet;
    renderPetList();

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
      el.innerHTML = q ? searchEmpty('search-pets') : emptyState('Животных нет', '+ Животное', 'pet.add', 'paw');
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
        ? '<span class="badge badge-course" title="Курс лечения до '+fmtDate(course.treatment_until)+'" aria-label="Курс лечения до '+fmtDate(course.treatment_until)+'">'
          + I('heart') + ' Лечение: ' + course.days_left + ' дн.</span>'
        : '';
      var deceasedItem = p.status==='active' ? [{label:'Отметить «умер»', icon:'skull', onclick:"VetPages.markDeceased('"+p.id+"')"}] : [];
      var petAvatar = p.photo
        ? '<img class="pet-photo" src="'+p.photo+'" alt="'+UI.esc(p.name)+'">'
        : UI.avatar(p.name,p.type);
      return '<div class="erow" data-act="pet.card" data-id="'+p.id+'">'+petAvatar
        +'<div class="erow-body">'
        +'<div class="erow-title">'+hl(p.name,q)+' '+statusBadge+courseBadge+'</div>'
        +'<div class="erow-sub">'+esc(p.type||'')+(p.breed?' · '+esc(p.breed):'')+(p.chip_number?' · '+I('tag')+' '+esc(p.chip_number):'')+' · '+esc(owner.fio||'')+'</div>'
        +(p.death_date?'<div class="erow-meta">Умер: '+fmtDate(p.death_date)+(p.death_reason?' · '+esc(p.death_reason):'')+' </div>':'')
        +'</div>'
        +'<div class="erow-right"><div class="erow-actions">'
        +'<button class="btn btn-icon" data-act="pet.newVisit" data-id="'+p.id+'" title="Новый приём" aria-label="Новый приём">'+UI.icon('plus','')+'</button>'
        +'<button class="btn btn-icon" data-act="pet.edit" data-id="'+p.id+'" title="Редактировать" aria-label="Редактировать">'+UI.icon('edit','')+'</button>'
        +UI.rowMenu([
            {label:'Хронология', icon:'clock', act:'pet.timeline', data:{id:p.id}},
            {label:'История приёмов', icon:'clipboard', act:'pet.history', data:{id:p.id}},
            {label:'Печать паспорта', icon:'print', act:'pet.print', data:{id:p.id}},
            {label:'Согласие на процедуру', icon:'print', act:'pet.consent', data:{id:p.id}}
          ].concat(deceasedItem).concat([
            {sep:true},
            {label:'Удалить', icon:'trash', danger:true, act:'pet.delete', data:{id:p.id}}
          ]))
        +'</div></div></div>';
    }).join('')
    + (petsMore
        ? '<div class="list-more"><button class="btn btn-ghost" data-act="pets.more">Показать ещё (' + (petsTotal - _petsLimit) + ')</button></div>'
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

    showLoading('visits-list');
    var data = await loadAll();
    _visits   = data.visits || [];
    _vpetsMap  = buildMap(data.pets || []);
    _vownersMap = buildMap(data.owners || []);
    _vitems    = data.items || [];
    renderVisitList();
    setupSearch('search-visits', function(q){ renderVisitList(); });

    var dateFilter = document.getElementById('visit-date-filter');
    if (dateFilter) {
      syncVisitPeriodButtons();
      dateFilter.querySelectorAll('.filter-btn').forEach(function(btn) {
        btn.onclick = function() {
          _visitDateFilter = btn.dataset.period;
          _visitRenderLimit = 60;
          syncVisitPeriodButtons();
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

  // Подсветка кнопок периода по текущему _visitDateFilter. Отдельной функцией,
  // потому что период задаёт не только клик по кнопке, но и переход с дашборда.
  function syncVisitPeriodButtons() {
    var box = document.getElementById('visit-date-filter');
    if (!box) return;
    box.querySelectorAll('.filter-btn').forEach(function(b){
      b.classList.toggle('active', b.dataset.period === _visitDateFilter);
    });
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
    // TECH-003: ISO-строки сравниваются лексикографически в том же порядке,
    // что и даты, но без аллокации Date на каждое сравнение. На базе в
    // 20 000 приёмов это 28 мс вместо 418.
    visits.sort(function(a,b){ return (b.date || '') > (a.date || '') ? 1 : -1; });

    var el = document.getElementById('visits-list');
    if (!el) return;
    if (!visits.length) {
      el.innerHTML = q ? searchEmpty('search-visits')
                       : emptyState('Приёмов нет', '+ Новый приём', 'visit.new', 'clipboard');
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
      // VET-003: незавершённый приём видно прямо в списке — иначе запись,
      // к которой врач собирался вернуться, ничем не отличается от закрытой.
      var draftTag = v.status==='draft'
        ? '<span class="badge badge-draft" style="margin-left:6px;">Не завершён</span>' : '';
      return '<div class="erow" data-act="visit.edit" data-id="'+v.id+'">'
        +UI.avatar(pet.name||'?',pet.type)
        +'<div class="erow-body">'
        +'<div class="erow-title">'+esc(pet.name||'Неизвестно')+vtTag+draftTag+'</div>'
        +'<div class="erow-sub">'+esc(owner.fio||'')+(v.diagnosis?' · '+esc(v.diagnosis):(v.anamnesis?' · '+esc(v.anamnesis):''))+'</div>'
        +('<div class="erow-extra">'
          +(v.animal_weight?''+I('scale')+' '+v.animal_weight+' кг':'')
          +(v.animal_weight&&v.next_visit_date?' &nbsp;·&nbsp; ':'')
          +(v.next_visit_date?''+I('calendar')+' Сл. приём: '+fmtDate(v.next_visit_date):'')
          +'</div>')
        +'</div>'
        +'<div class="erow-right">'
        +'<span class="erow-date">'+fmtDate(v.date)+'</span>'
        +(v.total_amount?(window.VetAuth&&!VetAuth.canSeeSum(v.staff_id)?'<span class="erow-amount" title="Сумма скрыта настройками прав" aria-label="Сумма скрыта настройками прав">···</span>':'<span class="erow-amount">'+Number(v.total_amount).toFixed(0)+' ₸</span>'):'')
        +'<div class="erow-actions">'
        // Кнопка «открыть приём» удалена: клик по самой строке делает ровно
        // то же самое (data-act="visit.edit" на .erow). Две одинаковые цели
        // рядом — не выбор, а шум.
        +UI.rowMenu([
            {label:'Печать для владельца', icon:'print', act:'visit.print', data:{id:v.id}},
            {label:'Копировать приём', icon:'clipboard', act:'visit.copy', data:{id:v.id}},
            {sep:true},
            {label:'Удалить', icon:'trash', danger:true, act:'visit.delete', data:{id:v.id}}
          ])
        +'</div></div></div>';
    }).join('')
    + (showMore
        ? '<div class="list-more">'
          + '<button class="btn btn-ghost" data-act="visits.more">Показать ещё ('
          + (totalCount - _visitRenderLimit) + ')</button></div>'
        : '');
  }

  function _visitsShowMore() {
    _visitRenderLimit += 60;
    renderVisitList();
  }

  async function newVisit(petId, ownerId) {
    // Получаем время с сервера для дефолтного значения поля даты
    var serverTime = await UI.getServerTime();
    var data = await loadAll();
    var prefillPet   = petId ? (data.pets||[]).find(function(p){ return p.id===petId; }) : null;
    // Владелец: от питомца, либо напрямую (R9 — «Новый приём» из карточки
    // владельца с несколькими/без питомцев: подставляем владельца, питомца
    // врач выберет сам).
    var prefillOwner = prefillPet
      ? (data.owners||[]).find(function(o){ return o.id===prefillPet.owner_id; })
      : (ownerId ? (data.owners||[]).find(function(o){ return o.id===ownerId; }) : null);
    // Автозаполнение веса — берём последний вес из истории приёмов питомца
    var lastWeight = null;
    if (prefillPet) {
      var petVisits = (data.visits||[]).filter(function(v){ return !v.is_deleted && v.pet_id===prefillPet.id && v.animal_weight; });
      petVisits.sort(function(a,b){ return (b.date || '') > (a.date || '') ? 1 : -1; });
      if (petVisits.length) lastWeight = petVisits[0].animal_weight;
    }

    // Черновик: форма могла умереть без сохранения (смахнули PWA, сел
    // планшет) — предлагаем продолжить с того же места.
    var draft = UI.getVisitDraft('new');
    if (draft) {
      var restore = await UI.confirm('Незаконченный приём',
        'Найден несохранённый приём. Восстановить введённые данные?',
        { yes: 'Восстановить', no: 'Начать заново' });
      if (!restore) {
        // «Начать заново» — снимки прошлой попытки тоже ни к чему не привяжутся.
        if (draft.attachKey) await discardDraftAttachments(draft.attachKey);
        UI.clearVisitDraft(); draft = null;
      }
    }

    // VET-002: временный ключ, под которым файлы ждут создания приёма.
    // Восстановленный черновик забирает свой прежний ключ — иначе снимок,
    // сделанный до того, как планшет уснул, остался бы в очереди ничей.
    var attachKey = (draft && draft.attachKey) || ('draft:' + window.VetDB.uuid());
    var attachCommitted = false;
    var _vaccPetId = prefillPet ? prefillPet.id : '';
    // Всё, что осталось от прошлых незакрытых форм, к приёму уже не привяжется.
    await sweepOrphanDraftAttachments([attachKey]);
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
        UI.startVisitDraftAutosave('new', attachKey);
        renderAttachments(attachKey);
        renderVisitVaccinations(attachKey, prefillPet ? prefillPet.id : '');
        renderVisitPrescriptions(attachKey, prefillPet ? prefillPet.id : '');
        renderVisitResults(attachKey, prefillPet ? prefillPet.id : '');
        renderVisitContext(prefillPet ? prefillPet.id : '', false);
        renderPetAllergies(prefillPet ? prefillPet.id : '');
        // Животное в новом приёме выбирают уже после открытия формы, а прививке
        // нужен pet_id — перерисовываем блок, когда выбор сделан.
        var petHook = setInterval(function () {
          if (!document.getElementById('vf-root')) { clearInterval(petHook); return; }
          var vs = UI.getVisitState();
          var pid = (vs.pet && vs.pet.id) || '';
          if (pid !== _vaccPetId) {
            _vaccPetId = pid;
            renderVisitVaccinations(attachKey, pid);
            renderVisitPrescriptions(attachKey, pid);   // F4/VET-004
            renderVisitResults(attachKey, pid);
            renderVisitContext(pid, false);   // VET-001: контекст выбранного пациента
            renderPetAllergies(pid);          // VET-013: предупреждение об аллергиях
          }
        }, 1200);
      },
      // Уборка за формой: приём не создан — файлы к нему не привяжутся.
      // Срабатывает на «Отмену», крестик и жест «назад». После успешного
      // сохранения ключ уже подменён, и удалять нечего.
      onClose: function() {
        if (!attachCommitted) discardDraftAttachments(attachKey);
        _vaccPending = null;   // приём не создан — привязывать прививки не к чему
        _prescPending = null;  // и назначения тоже
        _resultDrafts = {};    // и заполненные протоколы
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

        // R6: приём без врача не попадёт в отчёт по врачу и сводку выработки.
        if (!vs.staff_id) {
          var okNoDoc = await UI.confirm('Врач не указан',
            'Приём не попадёт в отчёт по врачу и в сводку выработки. Сохранить без врача?',
            { yes: 'Сохранить', no: 'Вернуться' });
          if (!okNoDoc) return;
        }

        if (!(await confirmDiagnosis(vs))) return;
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
            temperature: vs.temperature, vitals: vs.vitals,
            patient_condition: vs.condition,
            anamnesis: vs.anamnesis, diagnosis: vs.diagnosis,
            treatment: vs.treatment, notes: vs.notes,
            total_amount: totalAmount, discount: discount, discount_reason: vs.discount_reason || '', payment_card: vs.payment_card || 0,
            status: vs.status || 'completed',
          },
          items: vs.items,
        };
        try {
          var created = await api('POST', '/visits/full', body);
          var attached = 0, vaccAdded = 0, prescAdded = 0, resultsFilled = 0;
          if (created && created.visit) {
            await ensureVisitResults(created.visit.id, finalPet.id, vs.items);
            // Приём появился — только теперь у файлов есть к чему привязаться.
            // Ставим флаг ДО hideModal: иначе onClose счёл бы приём несохранённым
            // и удалил бы уже привязанные снимки.
            attachCommitted = true;
            attached = await commitDraftAttachments(attachKey, created.visit.id);
            vaccAdded = await commitPendingVaccinations(attachKey, created.visit.id, finalPet.id);
            prescAdded = await commitPendingPrescriptions(attachKey, created.visit.id, finalPet.id, vs.staff_id);
            // Протоколы, заполненные ДО сохранения, переносим в строки,
            // которые только что завела ensureVisitResults.
            resultsFilled = await applyDraftResults(created.visit.id);
          }
          UI.clearVisitDraft();
          var extra = [];
          if (attached)  extra.push('файлов: ' + attached);
          if (vaccAdded) extra.push('прививок: ' + vaccAdded);
          if (prescAdded) extra.push('назначений: ' + prescAdded);
          if (resultsFilled) extra.push('протоколов: ' + resultsFilled);
          UI.toast(extra.length ? 'Приём сохранён (' + extra.join(', ') + ')' : 'Приём сохранён', 'ok');
          UI.hideModal();
          if (vaccAdded) await initVaccinations();
          await initVisits();
          initDashboard();
          // Через VetPages, а не голым именем: функция живёт в modules/schedule.js.
          // Проверка на существование — модуль расписания может быть не загружен.
          if (VetPages.maybeOfferAppointment) VetPages.maybeOfferAppointment(vs, finalPet, finalOwner);
        } catch(e) { UI.toast(e.message, 'err'); }
      }
    });
  }

  function newVisitForPet(petId) { navigate('visits'); setTimeout(function(){ newVisit(petId); }, 100); }
  function newVisitForOwner(ownerId) { navigate('visits'); setTimeout(function(){ newVisit(null, ownerId); }, 100); }

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
    try { visitItems = await api('GET', '/visit-items?visit_id='+id); } catch(e) { window.VetLog.warn('visit:items', e); }

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

        renderAttachments(id);
        // VET-007: прививки этого приёма. У сохранённого приёма id есть, поэтому
        // новая прививка пишется сразу, без промежуточного накопления.
        renderVisitVaccinations(id, visit.pet_id);
        renderVisitPrescriptions(id, visit.pet_id);
        renderVisitResults(id, visit.pet_id);
        renderVisitContext(visit.pet_id, false);
        renderPetAllergies(visit.pet_id);

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

        if (!(await confirmDiagnosis(vs))) return;
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
            temperature: vs.temperature, vitals: vs.vitals,
            next_visit_date: vs.next_visit_date||'',
            treatment_days: vs.treatment_days || 0,
            anamnesis: vs.anamnesis, diagnosis: vs.diagnosis,
            treatment: vs.treatment, notes: vs.notes,
            total_amount: totalAmount, discount: discount, discount_reason: vs.discount_reason || '', payment_card: vs.payment_card || 0,
            status: vs.status || 'completed',
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
          await ensureVisitResults(id, finalPet.id, vs.items);
          // Протоколы, заполненные в этой сессии до сохранения.
          await applyDraftResults(id);
          // Услугу убрали из счёта — незаполненная строка результата по ней
          // больше не нужна. Заполненные не трогаем: это медицинская запись,
          // а не строка счёта. Порядок важен: сначала перенос, потом уборка.
          await pruneOrphanResults(id);
          UI.clearVisitDraft();
          if (!failedDeletes) UI.toast('Приём обновлён', 'ok');
          UI.hideModal();
          await initVisits();
          // Через VetPages, а не голым именем: функция живёт в modules/schedule.js.
          // Проверка на существование — модуль расписания может быть не загружен.
          if (VetPages.maybeOfferAppointment) VetPages.maybeOfferAppointment(vs, finalPet, finalOwner);
        } catch(e) { UI.toast(e.message, 'err'); }
      }
    });
  }


  // ── Результаты услуг ──────────────────────────────────────────────────
  //
  // Услуга, помеченная в каталоге флагом «требует результата», заводит в приёме
  // строку ожидания. Дальше её либо заполняют протоколом, либо к ней цепляют
  // файл — и до тех пор она висит в списке «результата нет».
  //
  // Привязка идёт к паре (приём, услуга каталога), а НЕ к строке приёма:
  // сохранение правки удаляет все visit_items и создаёт заново, поэтому их id
  // живут ровно до следующего сохранения. Результат так терялся бы каждый раз.
  // Перерисовать блок результатов, если форма приёма открыта: строки могли
  // появиться только что (ensureVisitResults) или быть заполнены поверх.
  function refreshVisitResultsBlock() {
    if (_curVisitId && document.getElementById('visit-results')) {
      renderVisitResults(_curVisitId, _curPetId);
    }
  }

  async function ensureVisitResults(visitId, petId, items) {
    if (!visitId) return;
    // Каталог читаем из базы, а НЕ из _items: тот массив наполняет initItems,
    // то есть он пуст, пока врач не заходил на страницу каталога. Приём же
    // открывают напрямую из расписания или карточки животного.
    var catalog = [];
    try { catalog = await window.VetDB.getAll('items') || []; } catch (e) { return; }
    var catById = {};
    catalog.forEach(function (c) { catById[c.id] = c; });

    // Одна запись на КАЖДУЮ строку исследования, а не на услугу: два УЗИ в
    // приёме — два протокола. Раньше здесь стоял словарь по item_id, и второе
    // такое же исследование просто исчезало.
    var wanted = seqOfItems(items, catById);
    var wantedKeys = {};
    wanted.forEach(function (w) { wantedKeys[resKey(w.item_id, w.seq)] = w; });

    var all = [];
    try { all = await window.VetDB.getAll('visit_results'); } catch (e) { return; }
    var existing = (all || []).filter(function (r) {
      return r.visit_id === visitId && !r.is_deleted;
    });
    var have = {};
    existing.forEach(function (r) { if (r.item_id) have[resKey(r.item_id, r.seq)] = r; });

    for (var k = 0; k < wanted.length; k++) {
      var w = wanted[k];
      if (have[resKey(w.item_id, w.seq)]) continue;
      try {
        await api('POST', '/results', {
          visit_id: visitId, pet_id: petId, item_id: w.item_id, seq: w.seq,
          title: w.title, template_id: w.template_id, kind: w.kind, status: 'pending'
        });
      } catch (e) {
        if (window.VetLog) window.VetLog.warn('results:create', e);
      }
    }

    // Услугу убрали из приёма — ожидание снимаем. Но ТОЛЬКО пустое: уже
    // внесённый результат не должен исчезнуть из-за правки строки приёма.
    for (var i = 0; i < existing.length; i++) {
      var r = existing[i];
      if (r.item_id && !wantedKeys[resKey(r.item_id, r.seq)] && r.status !== 'done') {
        try { await api('DELETE', '/results/' + r.id); } catch (e) {}
      }
    }
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

        if (!(await confirmDiagnosis(vs))) return;
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
            temperature: vs.temperature, vitals: vs.vitals,
            patient_condition: vs.condition,
            anamnesis: vs.anamnesis, diagnosis: vs.diagnosis,
            treatment: vs.treatment, notes: vs.notes,
            total_amount: totalAmount, discount: discount, discount_reason: vs.discount_reason || '', payment_card: vs.payment_card || 0,
            status: vs.status || 'completed',
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
    showLoading('vaccinations-list');
    var [vacc, pets] = await Promise.all([api('GET','/vaccinations'), api('GET','/pets?status=all')]);
    _vaccinations = vacc || [];
    _vacPetsMap   = buildMap(pets || []);
    var vdateFilter = document.getElementById('vacc-date-filter');
    if (vdateFilter) {
      syncVaccDateButtons();
      vdateFilter.querySelectorAll('.filter-btn').forEach(function(btn) {
        btn.onclick = function() {
          _vaccDateFilter = btn.dataset.vdate;
          syncVaccDateButtons();
          renderVaccinationList();
        };
      });
    }
    renderVaccinationList();
    setupSearch('search-vaccinations', function(q){ renderVaccinationList(); });
    document.getElementById('btn-add-vaccination').onclick = addVaccination;
  }

  function syncVaccDateButtons() {
    var box = document.getElementById('vacc-date-filter');
    if (!box) return;
    box.querySelectorAll('.filter-btn').forEach(function(b){
      b.classList.toggle('active', b.dataset.vdate === _vaccDateFilter);
    });
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
    }).sort(function(a,b){ return (b.administered_at || '') > (a.administered_at || '') ? 1 : -1; });

    var el = document.getElementById('vaccinations-list');
    if (!el) return;
    if (!list.length) {
      el.innerHTML = (q || _vaccDateFilter !== 'all')
        ? searchEmpty('search-vaccinations')
        : emptyState('Вакцинаций нет', '+ Вакцинация', 'vacc.add', 'syringe');
      return;
    }
    el.innerHTML = list.map(function(v) {
      var pet = _vacPetsMap[v.pet_id] || {};
      // Строго "<": вакцинация со сроком сегодня — ещё не просрочена.
      // Иначе бейдж расходился с фильтром «Просроченные», который считает < today.
      var overdue = v.next_due_at && v.next_due_at.slice(0,10) < today;
      return '<div class="erow" data-act="vacc.edit" data-id="'+v.id+'">'
        +UI.avatar(pet.name||'?',pet.type)
        +'<div class="erow-body">'
        +'<div class="erow-title">'+esc(pet.name||'?')+' · '+esc(v.vaccine_name)+'</div>'
        +'<div class="erow-sub">'+(v.manufacturer?esc(v.manufacturer)+' · ':'')+'Серия: '+esc(v.batch_number||'—')
        // VET-007: видно, что прививка сделана на приёме, и можно этот приём
        // открыть — раньше связь приходилось искать по животному и дате.
        +(v.visit_id?' · <span class="vacc-from-visit" data-act="visit.edit" data-id="'+esc(v.visit_id)+'" role="button" tabindex="0" title="Открыть приём, на котором сделана прививка">на приёме →</span>':'')
        +'</div>'
        +(v.next_due_at?'<div class="erow-meta">Следующая: '+fmtDate(v.next_due_at)+(overdue?' '+I('alert')+' Просрочена':'')+'</div>':'')
        +'</div>'
        +'<div class="erow-right">'
        +'<span class="erow-date">'+fmtDate(v.administered_at)+'</span>'
        +'<div class="erow-actions">'
        +'<button class="btn btn-icon" data-act="vacc.edit" data-id="'+v.id+'" title="Открыть" aria-label="Открыть">'+UI.icon('edit','')+'</button>'
        +UI.rowMenu([
            {label:'Печать справки', icon:'print', act:'vacc.print', data:{id:v.id}},
            {label:'Копировать', icon:'clipboard', act:'vacc.copy', data:{id:v.id}},
            {sep:true},
            {label:'Удалить', icon:'trash', danger:true, act:'vacc.delete', data:{id:v.id}}
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
        if (!d.vaccine_name || !d.administered_at) { UI.markInvalid(['f-vaccine','f-admin-at']); UI.toast('Заполните обязательные поля', 'err'); return; }
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

    // Кнопка «Распечатать» внутри печатного документа. Обработчик вешаем
    // отсюда: инлайновый onclick в сгенерированном HTML запрещён политикой
    // CSP, а сам документ живёт в iframe и своих скриптов не имеет.
    var doPrint = doc.getElementById('btn-do-print');
    if (doPrint) {
      doPrint.onclick = function () {
        try { frame.contentWindow.print(); } catch (e) {}
      };
    }

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

    // Стили печатного документа теперь внешние (/css/print-*.css): их надо
    // дождаться, иначе лист уйдёт без оформления. Потолок обязателен —
    // недоступная таблица не должна навсегда заблокировать печать.
    function whenStylesReady(cb) {
      var links = doc.querySelectorAll('link[rel="stylesheet"]');
      if (!links.length) { cb(); return; }
      var left = links.length, done = false;
      function finish() { if (!done) { done = true; cb(); } }
      function tick() { if (--left <= 0) finish(); }
      for (var i = 0; i < links.length; i++) {
        if (links[i].sheet) { tick(); continue; }   // уже применилась
        links[i].addEventListener('load', tick);
        links[i].addEventListener('error', tick);
      }
      setTimeout(finish, 2000);
    }

    whenStylesReady(function () {
      // Ждём картинки (логотип клиники), иначе печать уйдёт без них.
      if (frame.contentWindow.document.images.length) {
        frame.onload = fire;
        setTimeout(fire, opts.timeout || 1500); // страховка, если onload не придёт
      } else {
        setTimeout(fire, opts.delay || 300);
      }
    });
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

  // Умолчание типа по имени файла: снимок с камеры почти всегда «Фото», PDF —
  // обычно бланк анализов. Врачу остаётся поправить, а не выбирать каждый раз.
  function guessAttachKind(file) {
    var n = String(file && file.name || '').toLowerCase();
    var t = String(file && file.type || '').toLowerCase();
    if (t === 'application/pdf' || /\.pdf$/.test(n)) return 'lab';
    if (/(uzi|узи|ultra)/.test(n)) return 'ultrasound';
    if (/(rentg|рент|xray|x-ray)/.test(n)) return 'xray';
    return 'photo';
  }

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

  // ── VET-002: вложения в ещё не сохранённом приёме ────────────────────
  //
  // Раньше приложить файл можно было только к сохранённому приёму: врач,
  // сфотографировав поражение кожи прямо на осмотре, должен был сначала
  // сохранить приём, потом открыть его заново и лишь тогда добавить снимок.
  // На практике снимок оставался в галерее планшета и до карты не доходил.
  //
  // Приём создаёт СЕРВЕР (POST /visits/full сам генерирует id), поэтому
  // заранее настоящего id у нас нет. Файл кладём в ту же офлайн-очередь под
  // временным ключом draft:<uuid>, а сразу после создания приёма подменяем
  // ключ на настоящий id и отправляем. Очередь не трогали: она уже умеет
  // ждать сеть, повторять попытки и показывать состояние в карточке.
  function isDraftVisitKey(id) { return String(id || '').indexOf('draft:') === 0; }

  async function queuedForVisit(visitId) {
    try {
      return (await window.VetDB.getAllRaw('attachment_queue'))
        .filter(function (q) { return q.visit_id === visitId; });
    } catch (e) { return []; }
  }

  // Приём создан — переносим файлы с временного ключа на настоящий id и
  // отправляем. Ошибку отправки не считаем провалом сохранения: файл остаётся
  // в очереди и уедет со следующей синхронизацией.
  async function commitDraftAttachments(draftKey, visitId) {
    var list = await queuedForVisit(draftKey);
    if (!list.length) return 0;
    for (var i = 0; i < list.length; i++) {
      list[i].visit_id = visitId;
      await window.VetDB.putRaw('attachment_queue', list[i]);
    }
    // Приём сохраняется локально и уезжает на сервер отдельным push'ем, поэтому
    // сначала отправляем ЗАПИСИ, и только потом файлы: иначе сервер честно
    // отвечает «visit not found» на приём, которого у него ещё нет, и снимок
    // ждал бы следующего цикла синхронизации без всякой нужды.
    try { await window.VetSync.pushSync(); } catch (e) {}
    try { await window.VetSync.pushAttachments(); } catch (e) {}
    return list.length;
  }

  // Уборка «ничьих» файлов. Обычную отмену формы закрывает onClose, но если
  // планшет выключили с открытой формой, onClose не отработает и файл останется
  // в очереди под draft-ключом навсегда: отправить его нельзя (приёма нет),
  // видно его тоже нигде. Подметаем при открытии следующего нового приёма —
  // тогда точно известны оба живых ключа: текущей формы и уцелевшего черновика.
  async function sweepOrphanDraftAttachments(keepKeys) {
    try {
      var all = await window.VetDB.getAllRaw('attachment_queue');
      for (var i = 0; i < all.length; i++) {
        var e = all[i];
        if (!isDraftVisitKey(e.visit_id)) continue;
        if (keepKeys.indexOf(e.visit_id) !== -1) continue;
        await window.VetDB.deleteRaw('attachment_queue', e.id);
      }
    } catch (e) { console.warn('[VetPages] уборка вложений:', e); }
  }

  // Приём не сохранён — файлы удаляем: держать в очереди вложения к приёму,
  // которого не будет, значит копить сирот, которые при каждой синхронизации
  // будут биться о сервер.
  async function discardDraftAttachments(draftKey) {
    var list = await queuedForVisit(draftKey);
    for (var i = 0; i < list.length; i++) {
      await window.VetDB.deleteRaw('attachment_queue', list[i].id);
    }
    return list.length;
  }

  // ── VET-013: аллергии и непереносимости ──────────────────────────────
  //
  // Ответ клиники на вопрос 7: «нужно добавить, это у питомца каждого должно
  // быть». До сих пор таких полей не было нигде — сведение о безопасности жило
  // (если жило) в общих заметках, которые в форме приёма не показываются.
  // Врач назначал препарат, не видя, что на него была реакция.
  //
  // Поэтому это НЕ поле в карточке, а полоса ПОВЕРХ формы приёма: увидеть её
  // надо до назначения, а не когда специально пошёл смотреть. Когда аллергий
  // нет — тихая строка с предложением заполнить, без крика.
  async function renderPetAllergies(petId) {
    var box = document.getElementById('visit-allergy');
    if (!box) return;
    if (!petId) { box.innerHTML = ''; return; }
    var pet = null;
    try {
      pet = (await window.VetDB.getAll('pets')).find(function (p) { return p.id === petId; });
    } catch (e) {}
    if (!pet) { box.innerHTML = ''; return; }

    var a = (pet.allergies || '').trim();
    box.innerHTML = a
      ? '<div class="allergy-bar" role="alert">' + I('alert')
        + '<div class="allergy-text"><b>Аллергии и непереносимости:</b> ' + esc(a) + '</div>'
        + '<button type="button" class="btn btn-ghost btn-sm" data-act="pet.allergyEdit" data-id="'
          + esc(petId) + '">Изменить</button></div>'
      : '<div class="allergy-bar allergy-empty">' + I('alert')
        + '<div class="allergy-text">Аллергии не указаны</div>'
        + '<button type="button" class="btn btn-ghost btn-sm" data-act="pet.allergyEdit" data-id="'
          + esc(petId) + '">Указать</button></div>';
  }

  // Правка прямо из приёма (критерий приёмки): идти в карточку животного
  // посреди осмотра врач не станет.
  async function editPetAllergies(petId) {
    var pets = await window.VetDB.getAll('pets');
    var pet = pets.find(function (p) { return p.id === petId; });
    if (!pet) return;
    UI.showModal({
      stacked: true,
      title: 'Аллергии и непереносимости · ' + (pet.name || ''),
      size: 'lg',
      saveLabel: 'Сохранить',
      bodyHTML: '<div class="form-stack">'
        + '<div class="form-group"><label class="form-label">Реакции, непереносимости, особенности</label>'
        + '<textarea id="pet-allergies" class="form-textarea" rows="4" maxlength="600"'
        + ' placeholder="Например: реакция на амоксициллин — отёк морды; не переносит ксилазин">'
        + esc(pet.allergies || '') + '</textarea></div>'
        + '<div class="text-sm text-muted">Показывается в каждом приёме этого животного,'
        + ' до выбора препаратов.</div></div>',
      onSave: async function () {
        var val = (document.getElementById('pet-allergies') || {}).value || '';
        try {
          await api('PUT', '/pets/' + petId, Object.assign({}, pet, { allergies: val.trim() }));
          UI.hideModal();
          await renderPetAllergies(petId);
          UI.toast('Сохранено', 'ok');
        } catch (e) { UI.toast(e.message, 'err'); }
      }
    });
  }

  // ── VET-001: контекст пациента внутри приёма ─────────────────────────
  //
  // Врач на повторном приёме вспоминает: «какой антибиотик я назначал две
  // недели назад и какой был вес?» Раньше, чтобы ответить, он ЗАКРЫВАЛ форму,
  // шёл в карточку животного, читал, возвращался и восстанавливал черновик.
  // Чаще — не шёл вовсе и решал по памяти.
  //
  // Блок свёрнут: форма приёма и без того длинная (UX-009), и добавлять
  // контекст простыней означало бы чинить одно, ломая другое. Развернул —
  // увидел последние приёмы, вес, анализ и прививку; ткнул в приём — он
  // открылся ПОВЕРХ формы (F2), не разрушив её.
  async function renderVisitContext(petId, expanded) {
    var box = document.getElementById('visit-context');
    if (!box) return;
    if (!petId) { box.innerHTML = ''; return; }

    var all = await loadAll();
    var pet = (all.pets || []).find(function (p) { return p.id === petId; });
    if (!pet) { box.innerHTML = ''; return; }

    var visits = (all.visits || [])
      .filter(function (v) { return !v.is_deleted && v.pet_id === petId; })
      .sort(function (a, b) { return (b.date || '') > (a.date || '') ? 1 : -1; });
    var vaccs = (all.vaccinations || [])
      .filter(function (v) { return !v.is_deleted && v.pet_id === petId; })
      .sort(function (a, b) { return (b.administered_at || '') > (a.administered_at || '') ? 1 : -1; });
    var results = [];
    try {
      results = (await window.VetDB.getAll('visit_results'))
        .filter(function (r) { return !r.is_deleted && r.pet_id === petId && r.status === 'done'; })
        .sort(function (a, b) {
          var ax = a.filled_at || a.created_at || '', bx = b.filled_at || b.created_at || '';
          return bx > ax ? 1 : -1;
        });
    } catch (e) {}

    // Вес: последний известный и куда движется.
    var weighed = visits.filter(function (v) { return Number(v.animal_weight) > 0; });
    var wNow = weighed.length ? Number(weighed[0].animal_weight) : null;
    var wPrev = weighed.length > 1 ? Number(weighed[1].animal_weight) : null;
    var wDelta = (wNow != null && wPrev != null) ? Math.round((wNow - wPrev) * 100) / 100 : null;

    var nextVacc = vaccs.filter(function (v) { return v.next_due_at; })
                        .sort(function (a, b) { return (a.next_due_at || '') > (b.next_due_at || '') ? 1 : -1; })[0];

    var chips = [];
    if (wNow != null) {
      chips.push('<span class="vctx-chip">' + I('scale') + ' ' + wNow + ' кг'
        + (wDelta ? ' <b class="' + (wDelta > 0 ? 'res-up' : 'res-down') + '">'
                    + (wDelta > 0 ? '+' : '') + wDelta + '</b>' : '') + '</span>');
    }
    // VET-009: температура в динамике — там же, где вес, и по тем же правилам.
    // Пустое поле означает «не мерили», такие приёмы в ряд не попадают, иначе
    // «0 °C» выглядело бы как измерение.
    var withT = visits.filter(function (v) { return Number(v.temperature) > 0; });
    if (withT.length) {
      var tNow = Number(withT[0].temperature);
      var tPrev = withT.length > 1 ? Number(withT[1].temperature) : null;
      var tDelta = tPrev != null ? Math.round((tNow - tPrev) * 10) / 10 : null;
      // 37.5–39.2 — рабочий ориентир для собак и кошек; выход за него подсвечен,
      // но ничего не блокирует: решение остаётся за врачом.
      var feverCls = (tNow > 39.2 || tNow < 37.5) ? ' vctx-alert' : '';
      chips.push('<span class="vctx-chip' + feverCls + '">' + I('alert') + ' ' + tNow + ' °C'
        + (tDelta ? ' <b class="' + (tDelta > 0 ? 'res-up' : 'res-down') + '">'
                    + (tDelta > 0 ? '+' : '') + tDelta + '</b>' : '') + '</span>');
    }
    if (results.length) {
      chips.push('<span class="vctx-chip" data-act="result.view" data-id="' + esc(results[0].id) + '" role="button" tabindex="0">'
        + I('clipboard') + ' ' + esc(results[0].title || 'Результат') + ' · ' + esc(fmtDate(results[0].filled_at || results[0].created_at)) + '</span>');
    }
    if (nextVacc) {
      chips.push('<span class="vctx-chip">' + I('syringe') + ' ' + esc(nextVacc.vaccine_name)
        + ' до ' + esc(fmtDate(nextVacc.next_due_at)) + '</span>');
    }
    if (pet.notes) chips.push('<span class="vctx-chip vctx-note">' + I('alert') + ' ' + esc(pet.notes.slice(0, 90)) + '</span>');

    var past = visits.slice(0, 5);
    var listHTML = past.length
      ? past.map(function (v) {
          return '<div class="vctx-visit" data-act="visit.peek" data-id="' + esc(v.id) + '" role="button" tabindex="0">'
            + '<span class="vctx-date">' + esc(fmtDate(v.date)) + '</span>'
            + '<span class="vctx-dx">' + esc(v.diagnosis || 'без диагноза') + '</span>'
            + '<span class="vctx-tx">' + esc((v.treatment || '').slice(0, 70) || '—') + '</span>'
            + '</div>';
        }).join('')
      : '<div class="attach-empty">Это первый приём — прошлых записей нет</div>';

    // Действующая терапия (ответ клиники на вопрос 4: врач должен видеть на
    // повторном приёме, что курс ещё идёт). Именно ради этого назначение и
    // стало сущностью: из строки «амоксиклав 2р/д 7 дней» вывести, идёт ли
    // курс сегодня, нельзя.
    var running = [];
    try {
      running = (await window.VetDB.getAll('prescriptions'))
        .filter(function (p) { return !p.is_deleted && p.pet_id === petId && prescIsRunning(p); })
        .sort(function (a, b) { return (b.started_at || '') > (a.started_at || '') ? 1 : -1; });
    } catch (e) {}
    var runningHTML = running.length
      ? '<div class="vctx-tasks">' + running.map(function (p) {
          return '<div class="vctx-task vctx-presc">' + I('stethoscope')
            + '<span>' + esc(p.drug_name) + '</span>'
            + '<span class="vctx-date">' + esc(prescLine(p)) + '</span></div>';
        }).join('') + '</div>'
      : '';

    // VET-015: связанные задачи по этому пациенту — и возможность завести новую
    // прямо отсюда, с привязкой к животному и приёму.
    var tasks = [];
    try {
      tasks = (await window.VetDB.getAll('tasks'))
        .filter(function (t) { return !t.is_deleted && !t.done && t.pet_id === petId; })
        .sort(function (a, b) { return (a.due_date || '') > (b.due_date || '') ? 1 : -1; });
    } catch (e) {}
    var tasksHTML = tasks.length
      ? '<div class="vctx-tasks">' + tasks.map(function (t) {
          return '<div class="vctx-task">' + I('check')
            + '<span>' + esc(t.title) + '</span>'
            + (t.due_date ? '<span class="vctx-date">до ' + esc(fmtDate(t.due_date)) + '</span>' : '')
            + '</div>';
        }).join('') + '</div>'
      : '';

    box.innerHTML = '<div class="visit-section' + (expanded ? '' : ' collapsed') + '" id="vs-context">'
      + '<div class="visit-section-header" data-act="ui.section" data-section="vs-context">'
      +   '<span class="visit-section-num">i</span><span>Контекст пациента</span>'
      +   '<span class="vs-summary">' + (past.length ? 'приёмов: ' + visits.length : 'первый приём')
      +     (running.length ? ' · терапия: ' + running.length : '')
      +     (tasks.length ? ' · задач: ' + tasks.length : '') + '</span>'
      +   '<span class="vs-toggle">▾</span>'
      + '</div>'
      + '<div class="visit-section-body">'
      +   (chips.length ? '<div class="vctx-chips">' + chips.join('') + '</div>' : '')
      +   (runningHTML ? '<div class="vctx-sub">Терапия идёт сейчас</div>' + runningHTML : '')
      +   tasksHTML
      +   '<div class="vctx-list">' + listHTML + '</div>'
      +   '<button type="button" class="btn btn-ghost btn-sm" data-act="task.forPet"'
      +     ' data-pet="' + esc(petId) + '" data-owner="' + esc(pet.owner_id || '') + '"'
      +     ' data-name="' + esc(pet.name || '') + '">' + I('plus') + ' Задача по пациенту</button>'
      + '</div></div>';
  }

  // Прошлый приём ПОВЕРХ формы: заполняемая форма остаётся нетронутой,
  // возврат — по пути в шапке. Только чтение: править прошлый приём, стоя
  // в новом, значит почти наверняка ошибиться окном.
  async function peekVisit(id) {
    var all = await loadAll();
    var v = (all.visits || []).find(function (x) { return x.id === id; });
    if (!v) { UI.toast('Приём не найден', 'err'); return; }
    var pet = (all.pets || []).find(function (p) { return p.id === v.pet_id; }) || {};
    var items = [];
    try { items = await api('GET', '/visit-items?visit_id=' + id); } catch (e) {}
    function row(label, val) {
      return val ? '<div class="vpeek-row"><div class="vpeek-label">' + esc(label) + '</div>'
                 + '<div class="vpeek-val">' + esc(val) + '</div></div>' : '';
    }
    var body = '<div class="vpeek">'
      + row('Дата', fmtDate(v.date))
      + row('Вес', v.animal_weight ? v.animal_weight + ' кг' : '')
      + row('Состояние', v.patient_condition)
      + row('Анамнез', v.anamnesis)
      + row('Диагноз', v.diagnosis)
      + row('Назначение', v.treatment)
      + row('Примечания', v.notes)
      + ((items || []).length
          ? '<div class="vpeek-row"><div class="vpeek-label">Позиции</div><div class="vpeek-val">'
            + items.map(function (it) { return esc(it.name) + ' × ' + it.quantity; }).join('<br>')
            + '</div></div>'
          : '')
      + '</div>';
    UI.showModal({
      stacked: true,
      title: 'Приём ' + fmtDate(v.date) + ' · ' + (pet.name || ''),
      bodyHTML: body, size: 'lg', onSave: false, cancelLabel: 'Назад'
    });
  }

  // ── Результаты услуг прямо в приёме ──────────────────────────────────
  //
  // Услуга, помеченная «требует результата», заводит ожидающую строку — так
  // забытая пробирка видна сразу. Но заполнить её можно было только с
  // дашборда или из карточки животного: в самой форме приёма ссылки не было.
  // Врач, добавивший анализ крови, честно спрашивал «а где заполнять?».
  //
  // У НЕсохранённого приёма результатов ещё нет (их заводит ensureVisitResults
  // после создания), поэтому показываем, что появится, — иначе блок выглядел
  // бы пустым ровно тогда, когда врач о нём думает.
  // Заполненные протоколы строк, добавленных в форму: row_id -> {values,
  // conclusion, lab_name}. Держим в памяти до сохранения приёма — записи
  // visit_results до этого не существует. После создания приёма значения
  // переносятся в созданные строки (applyDraftResults).
  //
  // Ключ — СТРОКА счёта, а не услуга: два УЗИ в одном приёме это два разных
  // исследования с разными заключениями. Пока ключом была услуга, второе УЗИ
  // молча попадало в первое, и заполнить его было нельзя.
  var _resultDrafts = {};

  // Строки ТЕКУЩЕЙ формы, которым положен результат, в порядке отображения.
  // seq — номер исследования по этой услуге внутри приёма: он переживает
  // сохранение, тогда как id строки счёта — нет (при правке приёма позиции
  // удаляются и создаются заново).
  async function resultBearingItems() {
    var out = [];
    try {
      var rows = UI.getVisitItemRows ? UI.getVisitItemRows() : null;
      // Формы нет (перерисовка после закрытия) — работать не с чем.
      if (!rows || !rows.length) return out;
      var catalog = await window.VetDB.getAll('items');
      var byId = {}; catalog.forEach(function (c) { byId[c.id] = c; });
      var n = {};
      rows.forEach(function (r) {
        if (!r.item_id) return;
        var cat = byId[r.item_id];
        if (!cat || !cat.result_mode || cat.result_mode === 'none') return;
        var seq = n[r.item_id] || 0;
        n[r.item_id] = seq + 1;
        out.push({ row_id: r.row_id, item_id: r.item_id, seq: seq,
                   name: r.name || cat.name, label: resultLabel(r.name || cat.name, seq),
                   mode: cat.result_mode, protocol_id: cat.protocol_id || '' });
      });
    } catch (e) {}
    return out;
  }

  // Второе и последующие исследования по одной услуге нумеруем в названии:
  // в списке результатов и в распечатке «УЗИ» и «УЗИ» неразличимы, а «УЗИ №2»
  // сразу говорит, что исследований было два.
  function resultLabel(name, seq) {
    return seq > 0 ? (name + ' №' + (seq + 1)) : name;
  }

  // Те же строки, но по составу позиций (без DOM): нужен на сохранении, когда
  // считаем, сколько результатов положено завести.
  function seqOfItems(items, catById) {
    var out = [], n = {};
    (items || []).forEach(function (it) {
      if (!it.item_id) return;
      var cat = catById[it.item_id];
      var mode = cat && cat.result_mode;
      if (!mode || mode === 'none') return;
      var seq = n[it.item_id] || 0;
      n[it.item_id] = seq + 1;
      out.push({ item_id: it.item_id, seq: seq,
                 title: resultLabel(it.name || cat.name || 'Результат', seq),
                 kind: mode === 'file' ? 'file' : 'protocol',
                 template_id: cat.protocol_id || '' });
    });
    return out;
  }

  // Ключ результата: услуга + номер исследования.
  function resKey(itemId, seq) { return String(itemId) + '#' + Number(seq || 0); }

  async function renderVisitResults(visitId, petId) {
    var box = document.getElementById('visit-results');
    if (!box) return;

    var saved = [];
    if (!isDraftVisitKey(visitId)) {
      try {
        saved = (await window.VetDB.getAll('visit_results'))
          .filter(function (r) { return r.visit_id === visitId && !r.is_deleted; });
      } catch (e) {}
    }
    var wanted = await resultBearingItems();
    var wantedKeys = {};
    wanted.forEach(function (w) { wantedKeys[resKey(w.item_id, w.seq)] = w; });

    // Строку счёта удалили — незаполненный результат по ней показывать нельзя:
    // кнопка «Заполнить» вела бы к услуге, которой в приёме уже нет.
    // ЗАПОЛНЕННЫЙ результат остаётся: исследование сделали и записали, и
    // стирать медицинскую запись вслед за строкой счёта нельзя.
    var shown = saved.filter(function (r) {
      if (r.status === 'done') return true;
      return !r.item_id || !!wantedKeys[resKey(r.item_id, r.seq)];
    });

    // Строки без созданной записи: приём ещё не сохранён.
    var drafts = wanted.filter(function (w) {
      return !saved.some(function (r) {
        return r.item_id === w.item_id && Number(r.seq || 0) === w.seq;
      });
    });

    if (!shown.length && !drafts.length) { setBoxHTML(box, ''); return; }

    var html = '<div class="attach-head">' + I('microscope') + ' Результаты'
      + '<span class="attach-count">' + (shown.length + drafts.length) + '</span></div>'
      + '<div class="attach-list">';

    drafts.forEach(function (w) {
      var d = _resultDrafts[w.row_id];
      var filled = !!d;
      html += '<div class="attach-row' + (filled ? '' : ' attach-pending') + '">'
        + I(filled ? 'check' : 'clock')
        + '<div class="attach-body"><div class="attach-name">' + esc(w.label) + '</div>'
        + '<div class="attach-meta">'
        + (filled ? 'заполнен · запишется вместе с приёмом'
                  : (w.mode === 'file' ? 'ждёт файл' : 'ждёт заполнения протокола'))
        + '</div>'
        + (filled && d.conclusion ? '<div class="attach-note">' + esc(d.conclusion) + '</div>' : '')
        + '</div>'
        + (w.mode === 'file' ? ''
            : '<button type="button" class="btn btn-ghost btn-sm" data-act="result.draftFill"'
              + ' data-row="' + esc(w.row_id) + '" data-tpl="' + esc(w.protocol_id) + '"'
              + ' data-name="' + esc(w.label) + '">' + (filled ? 'Изменить' : 'Заполнить') + '</button>')
        + '</div>';
    });

    shown.forEach(function (r) {
      var done = r.status === 'done';
      html += '<div class="attach-row' + (done ? '' : ' attach-pending') + '">' + I(done ? 'check' : 'clock')
        + '<div class="attach-body"><div class="attach-name">' + esc(r.title || 'Результат') + '</div>'
        + '<div class="attach-meta">' + (done ? 'заполнен ' + esc(fmtDate(r.filled_at || r.updated_at)) : 'ожидает результата')
        + (r.lab_name ? ' · ' + esc(r.lab_name) : '')
        + (done && window.VetProtocols && VetProtocols.wasCorrected && VetProtocols.wasCorrected(r)
            ? ' · исправлен' : '')
        + '</div></div>'
        + '<button type="button" class="btn btn-ghost btn-sm" data-act="'
        + (done ? 'result.view' : 'result.fill') + '" data-id="' + esc(r.id) + '">'
        + (done ? 'Открыть' : 'Заполнить') + '</button>'
        // Правка рядом со «Смотреть», а не только внутри карточки: врач правит
        // результат прямо во время приёма — описка в цифре, дописать
        // заключение, — и лишний заход в карточку ради этого только мешает.
        // «Открыть» остаётся первым: в карточке нормы, отклонения и динамика
        // показателя, которых в форме заполнения нет.
        + (done ? '<button type="button" class="btn btn-ghost btn-sm" data-act="result.fill"'
                  + ' data-id="' + esc(r.id) + '">Изменить</button>' : '')
        + '</div>';
    });
    setBoxHTML(box, html + '</div>');
  }

  // Перерисовка без мигания: если разметка та же, DOM не трогаем. Блок
  // пересчитывается при любой правке позиций, и подстановка одинакового
  // innerHTML заново создавала бы узлы — экран моргал на ровном месте.
  function setBoxHTML(box, html) {
    if (box.innerHTML === html) return;
    box.innerHTML = html;
  }

  // Решение «открывать ли протокол сразу» принимаем ЗДЕСЬ: только тут известен
  // текущий приём, а значит — существует ли уже строка результата. У
  // сохранённого приёма её надо править как запись, а не заводить черновик
  // в памяти, иначе повторное открытие услуги затёрло бы заполненное.
  async function autoOpenProtocol(itemId, rowId) {
    if (!itemId) return;
    var list = await resultBearingItems();
    // Именно ТА строка, в которой выбрали услугу. По item_id находилась бы
    // первая — и второе УЗИ открывало бы протокол первого.
    // Через String: номер строки приходит из формы числом, а из dataset —
    // строкой. Строгое сравнение молча не находило строку, и окно протокола
    // просто не открывалось — без единой ошибки в консоли.
    var key = rowId == null ? '' : String(rowId);
    var w = key ? list.find(function (x) { return String(x.row_id) === key; })
                : list.filter(function (x) { return x.item_id === itemId; }).pop();
    if (!w || w.mode === 'file') return;   // файл прикладывают отдельно
    if (_resultDrafts[w.row_id]) return;   // уже заполняли в этой сессии

    if (!isDraftVisitKey(_curVisitId) && _curVisitId) {
      try {
        var row = (await window.VetDB.getAll('visit_results')).find(function (r) {
          return r.visit_id === _curVisitId && r.item_id === itemId
              && Number(r.seq || 0) === w.seq && !r.is_deleted;
        });
        // Запись есть — открываем её обычным заполнением; заполненную не
        // трогаем, чтобы повторный выбор услуги не стёр заключение.
        if (row) {
          if (row.status !== 'done' && window.VetProtocols) VetPages.fillResultById(row.id);
          return;
        }
      } catch (e) {}
    }
    fillResultDraft(w.row_id, w.protocol_id, w.label);
  }

  // Заполнение протокола по строке счёта, у которой записи результата ещё нет.
  function fillResultDraft(rowId, tplId, name) {
    if (!window.VetProtocols || !VetProtocols.fillProtocolDraft) return;
    VetProtocols.fillProtocolDraft(tplId, name, _resultDrafts[rowId], function (data) {
      _resultDrafts[rowId] = data;
      // Заполненный протокол — работа врача: без пометки «Отмена» выбросила
      // бы её молча, как это было со снимками до VET-002.
      if (UI.markModalDirty) UI.markModalDirty();
      if (UI.forceVisitDraft) UI.forceVisitDraft();
      refreshVisitResultsBlock();
      UI.toast('Протокол заполнен — сохранится вместе с приёмом', 'ok');
    });
  }

  // После создания приёма ensureVisitResults завела строки — переносим в них
  // то, что врач заполнил до сохранения.
  async function applyDraftResults(visitId) {
    var keys = Object.keys(_resultDrafts);
    if (!keys.length) return 0;
    var done = 0;
    try {
      // Черновик привязан к СТРОКЕ формы; запись — к паре «услуга + номер».
      // Мостик между ними строим по текущему составу формы, пока она открыта.
      var map = {};
      (await resultBearingItems()).forEach(function (w) { map[w.row_id] = w; });
      var rows = (await window.VetDB.getAll('visit_results'))
        .filter(function (r) { return r.visit_id === visitId && !r.is_deleted; });
      for (var i = 0; i < keys.length; i++) {
        var w = map[keys[i]];
        if (!w) continue;   // строку убрали из счёта до сохранения
        var row = rows.find(function (r) {
          return r.item_id === w.item_id && Number(r.seq || 0) === w.seq;
        });
        if (!row) continue;
        var d = _resultDrafts[keys[i]];
        await api('PUT', '/results/' + row.id, {
          values_json: JSON.stringify(d.values || {}),
          conclusion: d.conclusion || '',
          lab_name: d.lab_name || '',
          status: 'done'
        });
        done++;
      }
    } catch (e) { console.warn('[VetPages] перенос протоколов:', e); }
    _resultDrafts = {};
    return done;
  }

  // Удаление незаполненных строк результата, чья услуга убрана из счёта.
  // Заполненные не трогаем — это медицинская запись, а не строка счёта.
  async function pruneOrphanResults(visitId) {
    try {
      var wanted = {};
      (await resultBearingItems()).forEach(function (w) { wanted[resKey(w.item_id, w.seq)] = 1; });
      var rows = (await window.VetDB.getAll('visit_results'))
        .filter(function (r) { return r.visit_id === visitId && !r.is_deleted
                                    && r.status !== 'done' && r.item_id
                                    && !wanted[resKey(r.item_id, r.seq)]; });
      for (var i = 0; i < rows.length; i++) {
        await api('DELETE', '/results/' + rows[i].id);
      }
      return rows.length;
    } catch (e) { return 0; }
  }

  // ── F4 / VET-004: назначения ─────────────────────────────────────────
  //
  // Раньше вся терапия была одной строкой в visits.treatment: «амоксиклав
  // 2р/д 7 дней, диета». Через три недели другой врач не мог восстановить ни
  // дозу, ни когда кончился курс, и назначал заново вслепую.
  //
  // Состав полей — ответ клиники (вопрос 1): препарат, доза, единица, путь
  // введения, длительность, инструкция. Кратности отдельным полем НЕТ: в
  // ответе её не было, «2 раза в день» пишется в инструкции.
  // Доза одним числом (вопрос 2: абсолютная).
  // Свободный текст в «Назначении и рекомендациях» остаётся (вопрос 5).
  var PRESC_UNITS  = ['мл', 'мг', 'таб', 'кап', 'г', 'ЕД'];
  var PRESC_ROUTES = ['внутрь', 'п/к', 'в/м', 'в/в', 'наружно', 'в глаза', 'в уши', 'в нос'];
  var PRESC_STATUS = {
    active:    { label: 'идёт',              cls: 'presc-active'  },
    cancelled: { label: 'отменено',          cls: 'presc-off'     },
    stopped:   { label: 'прекращено досрочно', cls: 'presc-off'   },
  };

  var _prescPending = null;   // { visitId, list: [payload], form: bool }

  function prescPendingList(visitId) {
    return (_prescPending && _prescPending.visitId === visitId) ? _prescPending.list : [];
  }

  // Курс «идёт» — статус active И дата окончания не прошла. Нормально
  // доведённый до конца курс отдельным статусом не помечается (ответ на
  // вопрос 4 перечислял только прерывания), поэтому считаем по датам.
  function prescIsRunning(p) {
    if ((p.status || 'active') !== 'active') return false;
    if (!p.duration_days) return true;         // без длительности — бессрочно
    var start = p.started_at || p.created_at;
    if (!start) return true;
    var end = new Date(start);
    end.setDate(end.getDate() + Number(p.duration_days));
    return end >= new Date(new Date().toISOString().slice(0, 10));
  }

  function prescLine(p) {
    var bits = [];
    if (p.dose) bits.push(p.dose + (p.dose_unit ? ' ' + p.dose_unit : ''));
    if (p.route) bits.push(p.route);
    if (p.duration_days) bits.push(p.duration_days + ' дн.');
    return bits.join(' · ');
  }

  async function renderVisitPrescriptions(visitId, petId) {
    var box = document.getElementById('visit-prescriptions');
    if (!box) return;
    var saved = [];
    if (!isDraftVisitKey(visitId)) {
      try {
        saved = (await window.VetDB.getAll('prescriptions'))
          .filter(function (p) { return p.visit_id === visitId && !p.is_deleted; });
      } catch (e) {}
    }
    var pend = prescPendingList(visitId);
    var open = !!(_prescPending && _prescPending.visitId === visitId && _prescPending.form);

    var html = '<div class="attach-head">' + I('stethoscope') + ' Назначения'
      + '<span class="attach-count">' + (saved.length + pend.length) + '</span>'
      + (open ? '' : '<button type="button" class="btn btn-ghost btn-sm attach-add"'
          + ' data-act="presc.open" data-visit="' + esc(visitId) + '" data-pet="' + esc(petId || '') + '">'
          + I('plus') + ' Препарат</button>')
      + '</div>';

    if (open) html += prescFormHTML(visitId, petId);

    if (!saved.length && !pend.length) {
      if (!open) html += '<div class="attach-empty">Назначений нет. Свободный текст можно оставить в поле «Назначение и рекомендации».</div>';
    } else {
      html += '<div class="attach-list">';
      pend.forEach(function (p, i) {
        html += '<div class="attach-row attach-pending">' + I('clock')
          + '<div class="attach-body"><div class="attach-name">' + esc(p.drug_name) + '</div>'
          + '<div class="attach-meta">' + esc(prescLine(p)) + ' · запишется после сохранения приёма</div>'
          + (p.instruction ? '<div class="attach-note">' + esc(p.instruction) + '</div>' : '')
          + '</div>'
          + '<button type="button" class="btn btn-icon" title="Убрать" aria-label="Убрать"'
          + ' data-act="presc.dropPending" data-visit="' + esc(visitId) + '" data-idx="' + i + '">' + I('trash') + '</button>'
          + '</div>';
      });
      saved.forEach(function (p) {
        var st = PRESC_STATUS[p.status || 'active'] || PRESC_STATUS.active;
        var running = prescIsRunning(p);
        html += '<div class="attach-row">' + I('stethoscope')
          + '<div class="attach-body"><div class="attach-name">' + esc(p.drug_name)
          + ' <span class="presc-badge ' + st.cls + '">' + esc(running ? st.label : (p.status === 'active' ? 'курс завершён' : st.label)) + '</span></div>'
          + '<div class="attach-meta">' + esc(prescLine(p)) + '</div>'
          + (p.instruction ? '<div class="attach-note">' + esc(p.instruction) + '</div>' : '')
          + (p.status_note ? '<div class="attach-note">' + esc(p.status_note) + '</div>' : '')
          + '</div>'
          + (p.status === 'active'
              ? '<button type="button" class="btn btn-icon" title="Отменить или прекратить" aria-label="Отменить или прекратить"'
                + ' data-act="presc.stop" data-id="' + esc(p.id) + '" data-visit="' + esc(visitId) + '" data-pet="' + esc(petId || '') + '">'
                + I('alert') + '</button>'
              : '')
          + '</div>';
      });
      html += '</div>';
    }
    box.innerHTML = html;
  }

  // Форма ВНУТРИ панели: она открывается в форме приёма, а вложенные модалки
  // здесь были бы третьим окном поверх второго.
  function prescFormHTML(visitId, petId) {
    var drugs = (_pFormItems || []).filter(function (i) { return !i.is_deleted && i.type === 'drug'; });
    return '<div class="attach-stage">'
      + '<div class="attach-stage-head">Назначение</div>'
      + '<div class="presc-grid">'
      + '<label class="vf-lbl presc-wide">Препарат <span class="form-req">*</span>'
      + '<input type="text" class="form-input" id="px-drug" list="px-drugs" placeholder="Амоксиклав 125 мг">'
      + '<datalist id="px-drugs">'
      + drugs.map(function (d) { return '<option value="' + esc(d.name) + '"></option>'; }).join('')
      + '</datalist></label>'
      + '<label class="vf-lbl">Доза'
      + '<input type="number" step="0.01" min="0" class="form-input" id="px-dose" placeholder="0.5"></label>'
      + '<label class="vf-lbl">Единица'
      + '<select class="form-select" id="px-unit">'
      + PRESC_UNITS.map(function (u) { return '<option value="' + u + '">' + u + '</option>'; }).join('')
      + '</select></label>'
      + '<label class="vf-lbl">Путь введения'
      + '<select class="form-select" id="px-route">'
      + PRESC_ROUTES.map(function (r) { return '<option value="' + r + '">' + r + '</option>'; }).join('')
      + '</select></label>'
      + '<label class="vf-lbl">Длительность, дней'
      + '<input type="number" step="1" min="0" class="form-input" id="px-days" placeholder="7"></label>'
      + '<label class="vf-lbl presc-wide">Инструкция'
      + '<input type="text" class="form-input" id="px-instr" maxlength="300"'
      + ' placeholder="по 1 таблетке 2 раза в день, после еды"></label>'
      + '</div>'
      + '<div class="attach-stage-actions">'
      + '<button type="button" class="btn btn-ghost btn-sm" data-act="presc.cancel" data-visit="' + esc(visitId) + '" data-pet="' + esc(petId || '') + '">Отмена</button>'
      + '<button type="button" class="btn btn-primary btn-sm" data-act="presc.add" data-visit="' + esc(visitId) + '" data-pet="' + esc(petId || '') + '">Добавить</button>'
      + '</div></div>';
  }

  var _pFormItems = [];

  async function openPrescForm(visitId, petId) {
    try { _pFormItems = (await loadAll()).items || []; } catch (e) { _pFormItems = []; }
    if (!_prescPending || _prescPending.visitId !== visitId) {
      _prescPending = { visitId: visitId, list: [], form: true };
    } else { _prescPending.form = true; }
    renderVisitPrescriptions(visitId, petId);
  }

  function cancelPrescForm(visitId, petId) {
    if (_prescPending && _prescPending.visitId === visitId) _prescPending.form = false;
    renderVisitPrescriptions(visitId, petId);
  }

  async function addPresc(visitId, petId) {
    var name = ((document.getElementById('px-drug') || {}).value || '').trim();
    if (!name) { UI.toast('Укажите препарат', 'err'); return; }
    var dose = (document.getElementById('px-dose') || {}).value;
    var days = (document.getElementById('px-days') || {}).value;
    var match = (_pFormItems || []).find(function (i) { return !i.is_deleted && i.name === name; });
    var rec = {
      pet_id: petId,
      item_id: match ? match.id : '',
      drug_name: name,
      dose: dose ? Number(dose) : null,
      dose_unit: (document.getElementById('px-unit') || {}).value || '',
      route: (document.getElementById('px-route') || {}).value || '',
      duration_days: days ? parseInt(days, 10) : null,
      instruction: ((document.getElementById('px-instr') || {}).value || '').trim(),
      status: 'active',
    };

    if (isDraftVisitKey(visitId)) {
      _prescPending.list.push(rec);
      _prescPending.form = false;
      if (UI.markModalDirty) UI.markModalDirty();
      if (UI.forceVisitDraft) UI.forceVisitDraft();
      await renderVisitPrescriptions(visitId, petId);
      UI.toast('Назначение запишется вместе с приёмом', 'ok');
      return;
    }
    try {
      rec.visit_id = visitId;
      await api('POST', '/prescriptions', rec);
      _prescPending.form = false;
      await renderVisitPrescriptions(visitId, petId);
      UI.toast('Назначение добавлено', 'ok');
    } catch (e) { UI.toast(e.message, 'err'); }
  }

  function dropPendingPresc(visitId, idx, petId) {
    if (!_prescPending || _prescPending.visitId !== visitId) return;
    _prescPending.list.splice(Number(idx), 1);
    renderVisitPrescriptions(visitId, petId);
  }

  async function commitPendingPrescriptions(draftKey, visitId, petId, staffId) {
    var list = prescPendingList(draftKey);
    if (!list.length) { _prescPending = null; return 0; }
    var done = 0;
    for (var i = 0; i < list.length; i++) {
      try {
        await api('POST', '/prescriptions', Object.assign({}, list[i], {
          visit_id: visitId, pet_id: petId || list[i].pet_id, staff_id: staffId || ''
        }));
        done++;
      } catch (e) { console.warn('[VetPages] назначение:', e); }
    }
    _prescPending = null;
    return done;
  }

  // Отмена и досрочное прекращение — разные вещи (ответ клиники на вопрос 4):
  // отменено = не давать вовсе, прекращено = давали и остановили. Смешивать
  // их значило бы потерять, получал ли пациент препарат.
  async function stopPresc(id, visitId, petId) {
    var all = await window.VetDB.getAll('prescriptions');
    var p = all.find(function (x) { return x.id === id; });
    if (!p) return;
    UI.showModal({
      stacked: true,
      title: 'Курс: ' + (p.drug_name || ''),
      size: 'lg',
      saveLabel: 'Сохранить',
      bodyHTML: '<div class="form-stack">'
        + '<div class="form-group"><label class="form-label">Что произошло</label>'
        + '<select id="px-status" class="form-select">'
        + '<option value="cancelled">Отменено — препарат не давали</option>'
        + '<option value="stopped">Прекращено досрочно — давали и остановили</option>'
        + '</select></div>'
        + '<div class="form-group"><label class="form-label">Причина</label>'
        + '<input id="px-note" class="form-input" maxlength="300" placeholder="реакция, нет эффекта, сменили схему"></div>'
        + '</div>',
      onSave: async function () {
        try {
          var newStatus = (document.getElementById('px-status') || {}).value || 'cancelled';
          var note = ((document.getElementById('px-note') || {}).value || '').trim();
          // Журнал ведём ЗДЕСЬ, а не на сервере. Клиент офлайн-first: api()
          // пишет локально, а на сервер запись едет синхронизацией, минуя
          // серверный PUT. Оставь логику там — и история изменений не
          // записалась бы никогда (проверено: status_at и change_log пустые).
          // Так же устроен change_log приёмов: его собирает клиент.
          var now = new Date().toISOString();
          var entry = { at: now, from: p.status || 'active', to: newStatus, note: note };
          var log = [];
          try { log = JSON.parse(p.change_log || '[]') || []; } catch (e) { log = []; }
          log.push(entry);
          await api('PUT', '/prescriptions/' + id, Object.assign({}, p, {
            status: newStatus,
            status_note: note,
            status_at: now,
            change_log: JSON.stringify(log),
          }));
          UI.hideModal();
          await renderVisitPrescriptions(visitId, petId);
          UI.toast('Сохранено', 'ok');
        } catch (e) { UI.toast(e.message, 'err'); }
      }
    });
  }

  // ── VET-007: вакцинации, выполненные на приёме ───────────────────────
  //
  // Прививка, сделанная во время приёма, жила отдельной записью, связанной с
  // ним лишь по животному и дате. Теперь у вакцинации есть необязательная
  // ссылка на приём. Необязательная сознательно: вакцинацию заводят и вне
  // приёма (выезд, повторная явка только за прививкой), и задним числом.
  //
  // У НЕсохранённого приёма id ещё нет, поэтому введённые прививки ждут в
  // памяти и создаются сразу после создания приёма — той же логикой, что и
  // вложения, только очередь тут не нужна: запись маленькая и уходит обычным
  // POST, который и сам умеет работать офлайн.
  var _vaccPending = null;   // { visitId, list: [payload], form: bool }
  // Приём и животное, форма которых открыта: нужны, чтобы задача из контекста
  // привязалась не только к животному, но и к конкретному приёму, и чтобы
  // блок результатов можно было перерисовать снаружи формы.
  var _curVisitId = '';
  var _curPetId = '';

  function pendingVaccList(visitId) {
    return (_vaccPending && _vaccPending.visitId === visitId) ? _vaccPending.list : [];
  }

  async function renderVisitVaccinations(visitId, petId) {
    _curVisitId = visitId || '';
    _curPetId = petId || '';
    var box = document.getElementById('visit-vaccinations');
    if (!box) return;
    var saved = [];
    if (!isDraftVisitKey(visitId)) {
      try {
        saved = (await window.VetDB.getAll('vaccinations'))
          .filter(function (v) { return v.visit_id === visitId && !v.is_deleted; });
      } catch (e) {}
    }
    var pend = pendingVaccList(visitId);
    var open = !!(_vaccPending && _vaccPending.visitId === visitId && _vaccPending.form);

    var html = '<div class="attach-head">' + I('syringe') + ' Вакцинации'
      + '<span class="attach-count">' + (saved.length + pend.length) + '</span>'
      + (open ? '' : '<button type="button" class="btn btn-ghost btn-sm attach-add"'
          + ' data-act="vacc.inlineOpen" data-visit="' + esc(visitId) + '" data-pet="' + esc(petId || '') + '">'
          + I('plus') + ' Вакцинация</button>')
      + '</div>';

    if (open) html += vaccInlineFormHTML(visitId, petId);

    if (!saved.length && !pend.length) {
      if (!open) html += '<div class="attach-empty">Прививок на этом приёме не делали</div>';
    } else {
      html += '<div class="attach-list">';
      pend.forEach(function (v, i) {
        html += '<div class="attach-row attach-pending">' + I('clock')
          + '<div class="attach-body"><div class="attach-name">' + esc(v.vaccine_name) + '</div>'
          + '<div class="attach-meta">' + esc(fmtDate(v.administered_at))
          + (v.next_due_at ? ' · следующая ' + esc(fmtDate(v.next_due_at)) : '')
          + ' · запишется после сохранения приёма</div>'
          + (v.notes ? '<div class="attach-note">' + esc(v.notes) + '</div>' : '')
          + '</div>'
          + '<button type="button" class="btn btn-icon" title="Убрать" aria-label="Убрать"'
          + ' data-act="vacc.dropPending" data-visit="' + esc(visitId) + '" data-idx="' + i + '">' + I('trash') + '</button>'
          + '</div>';
      });
      saved.forEach(function (v) {
        html += '<div class="attach-row">' + I('syringe')
          + '<div class="attach-body"><div class="attach-name">' + esc(v.vaccine_name) + '</div>'
          + '<div class="attach-meta">' + esc(fmtDate(v.administered_at))
          + (v.next_due_at ? ' · следующая ' + esc(fmtDate(v.next_due_at)) : '')
          + (v.batch_number ? ' · серия ' + esc(v.batch_number) : '')
          + '</div>'
          + (v.notes ? '<div class="attach-note">' + esc(v.notes) + '</div>' : '')
          + '</div></div>';
      });
      html += '</div>';
    }
    box.innerHTML = html;
  }

  // Форма ВНУТРИ панели, а не отдельным окном: панель живёт внутри модалки
  // приёма, а вложенные модалки приложение пока не умеет (F2/UX-022).
  // Владельца и животное не спрашиваем — они уже заданы приёмом.
  function vaccInlineFormHTML(visitId, petId) {
    var today = new Date().toISOString().slice(0, 10);
    return '<div class="attach-stage">'
      + '<div class="attach-stage-head">Прививка, сделанная на этом приёме</div>'
      + '<div class="vacc-inline-grid">'
      + '<label class="vf-lbl">Вакцина <span class="form-req">*</span>'
      + '<input type="text" class="form-input" id="vv-name" placeholder="Nobivac Tricat"></label>'
      + '<label class="vf-lbl">Дата введения <span class="form-req">*</span>'
      + '<input type="date" class="form-input" id="vv-date" value="' + today + '"></label>'
      + '<label class="vf-lbl">Следующая'
      + '<input type="date" class="form-input" id="vv-next"></label>'
      + '<label class="vf-lbl">Серия/партия'
      + '<input type="text" class="form-input" id="vv-batch" placeholder="A123456"></label>'
      + '<label class="vf-lbl">Производитель'
      + '<input type="text" class="form-input" id="vv-mfr" placeholder="Nobivac"></label>'
      + '<label class="vf-lbl">Доза (мл)'
      + '<input type="number" step="0.1" min="0" class="form-input" id="vv-dose" placeholder="1.0"></label>'
      + '<label class="vf-lbl vf-lbl-wide">Примечание'
      + '<input type="text" class="form-input" id="vv-notes" maxlength="300"></label>'
      + '</div>'
      + '<div class="attach-stage-actions">'
      + '<button type="button" class="btn btn-ghost btn-sm" data-act="vacc.inlineCancel" data-visit="' + esc(visitId) + '" data-pet="' + esc(petId || '') + '">Отмена</button>'
      + '<button type="button" class="btn btn-primary btn-sm" data-act="vacc.inlineAdd" data-visit="' + esc(visitId) + '" data-pet="' + esc(petId || '') + '">Добавить</button>'
      + '</div></div>';
  }

  function openVaccInline(visitId, petId) {
    if (!_vaccPending || _vaccPending.visitId !== visitId) {
      _vaccPending = { visitId: visitId, list: [], form: true };
    } else {
      _vaccPending.form = true;
    }
    renderVisitVaccinations(visitId, petId);
  }

  function cancelVaccInline(visitId, petId) {
    if (_vaccPending && _vaccPending.visitId === visitId) _vaccPending.form = false;
    renderVisitVaccinations(visitId, petId);
  }

  // Добавление. Для СОХРАНЁННОГО приёма пишем сразу; для нового — копим и
  // создаём после сохранения, когда у приёма появится id.
  async function addVaccInline(visitId, petId) {
    var name = (document.getElementById('vv-name') || {}).value || '';
    var date = (document.getElementById('vv-date') || {}).value || '';
    if (!name.trim()) { UI.toast('Введите название вакцины', 'err'); return; }
    if (!date)        { UI.toast('Укажите дату введения', 'err'); return; }
    var dose = (document.getElementById('vv-dose') || {}).value;
    var rec = {
      pet_id: petId,
      vaccine_name: name.trim(),
      administered_at: date,
      next_due_at: (document.getElementById('vv-next') || {}).value || '',
      batch_number: ((document.getElementById('vv-batch') || {}).value || '').trim(),
      manufacturer: ((document.getElementById('vv-mfr') || {}).value || '').trim(),
      dose: dose ? Number(dose) : null,
      notes: ((document.getElementById('vv-notes') || {}).value || '').trim(),
    };

    if (isDraftVisitKey(visitId)) {
      _vaccPending.list.push(rec);
      _vaccPending.form = false;
      // Прививка — тоже несохранённая работа: без этого «Отмена» выбросила бы
      // её без вопроса, как раньше выбрасывала снимок.
      if (UI.markModalDirty) UI.markModalDirty();
      if (UI.forceVisitDraft) UI.forceVisitDraft();
      await renderVisitVaccinations(visitId, petId);
      UI.toast('Прививка запишется вместе с приёмом', 'ok');
      return;
    }

    try {
      rec.visit_id = visitId;
      await api('POST', '/vaccinations', rec);
      _vaccPending.form = false;
      await renderVisitVaccinations(visitId, petId);
      UI.toast('Вакцинация добавлена', 'ok');
    } catch (e) { UI.toast(e.message, 'err'); }
  }

  function dropPendingVacc(visitId, idx, petId) {
    if (!_vaccPending || _vaccPending.visitId !== visitId) return;
    _vaccPending.list.splice(Number(idx), 1);
    renderVisitVaccinations(visitId, petId);
  }

  // Приём создан — заводим накопленные прививки с ссылкой на него.
  async function commitPendingVaccinations(draftKey, visitId, petId) {
    var list = pendingVaccList(draftKey);
    if (!list.length) { _vaccPending = null; return 0; }
    var done = 0;
    for (var i = 0; i < list.length; i++) {
      try {
        await api('POST', '/vaccinations',
          Object.assign({}, list[i], { visit_id: visitId, pet_id: petId || list[i].pet_id }));
        done++;
      } catch (e) { console.warn('[VetPages] вакцинация приёма:', e); }
    }
    _vaccPending = null;
    return done;
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
      + '<button type="button" class="btn btn-ghost btn-sm attach-add" data-act="attach.pick" data-visit="' + visitId + '">'
      + I('upload') + ' Добавить</button></div>';

    // Отобранные, но ещё не подтверждённые файлы: тип и комментарий задаются
    // здесь, а не системным окном. Блок идёт первым — это то, чем врач занят
    // прямо сейчас.
    if (_attachPending && _attachPending.visitId === visitId) {
      var prev = _attachPending.saved || [];
      html += '<div class="attach-stage"><div class="attach-stage-head">'
        + 'Выбрано файлов: ' + _attachPending.files.length + ' — укажите тип и подпись</div>';
      _attachPending.files.forEach(function (f, i) {
        var pk = (prev[i] && prev[i].kind) || guessAttachKind(f);
        var pn = (prev[i] && prev[i].notes) || '';
        html += '<div class="attach-stage-row">'
          + '<div class="attach-stage-name" title="' + esc(f.name) + '">' + esc(f.name)
          + ' <span class="attach-meta">' + fmtBytes(f.size) + '</span></div>'
          + '<select class="filter-select ctl-sm" id="att-kind-' + i + '" aria-label="Тип вложения">'
          + ATTACH_KINDS.map(function (k) {
              return '<option value="' + k.v + '"' + (k.v === pk ? ' selected' : '') + '>' + esc(k.l) + '</option>';
            }).join('')
          + '</select>'
          + '<input type="text" class="input" id="att-note-' + i + '" maxlength="200"'
          + ' placeholder="Подпись: например, до обработки" value="' + esc(pn) + '" aria-label="Комментарий к файлу">'
          + '<button type="button" class="btn btn-icon" title="Убрать файл" aria-label="Убрать файл"'
          + ' data-act="attach.dropPending" data-visit="' + visitId + '" data-idx="' + i + '">' + I('trash') + '</button>'
          + '</div>';
      });
      html += '<div class="attach-stage-actions">'
        + '<button type="button" class="btn btn-ghost btn-sm" data-act="attach.cancelPending" data-visit="' + visitId + '">Отмена</button>'
        + '<button type="button" class="btn btn-primary btn-sm" data-act="attach.confirmPending" data-visit="' + visitId + '">Приложить</button>'
        + '</div></div>';
    }

    if (!saved.length && !queued.length) {
      html += '<div class="attach-empty">'
        + (isDraftVisitKey(visitId)
            ? 'Снимок можно приложить прямо сейчас — он сохранится вместе с приёмом'
            : 'Сканов и снимков пока нет')
        + '</div>';
    } else {
      html += '<div class="attach-list">';
      queued.forEach(function (q) {
        // Файл ещё на планшете. Показываем честно: он не на сервере,
        // и другой врач его пока не увидит.
        var err = q.status === 'error';
        var waitText = isDraftVisitKey(visitId)
          ? ' · отправится после сохранения приёма'
          : ' · ждёт отправки на сервер';
        html += '<div class="attach-row' + (err ? ' attach-err' : ' attach-pending') + '">'
          + I(err ? 'alert' : 'clock')
          + '<div class="attach-body"><div class="attach-name">' + esc(q.file_name) + '</div>'
          + '<div class="attach-meta">' + esc(attachKindLabel(q.kind)) + ' · ' + fmtBytes(q.size)
          + (err ? ' · не отправлен: ' + esc((q.last_error || '').slice(0, 90))
                 : waitText)
          + '</div>'
          + (q.notes ? '<div class="attach-note">' + esc(q.notes) + '</div>' : '')
          + '</div>'
          + '<button class="btn btn-icon" title="Убрать из очереди" data-act="attach.dropQueued" data-id="' + q.id + '" data-visit="' + visitId + '" aria-label="Убрать из очереди">' + I('trash') + '</button>'
          + '</div>';
      });
      saved.forEach(function (a) {
        var isImg = String(a.mime_type || '').indexOf('image/') === 0;
        var href = '/attachments/' + a.id + '/file?t='
                 + encodeURIComponent((window.VetAuth && window.VetAuth.token()) || '');
        // Снимок открываем предпросмотром поверх приёма: уход в новую вкладку
        // выбивал врача из формы, к которой он через секунду возвращается.
        // PDF смотреть внутри нечем — его по-прежнему отдаём браузеру.
        var nameHTML = isImg
          ? '<button type="button" class="attach-name attach-name-btn" data-act="attach.preview" data-id="' + a.id
            + '" data-name="' + esc(a.file_name) + '">' + esc(a.file_name) + '</button>'
          : '<a class="attach-name" href="' + href + '" target="_blank" rel="noopener">' + esc(a.file_name) + '</a>';
        html += '<div class="attach-row">'
          + I(a.mime_type === 'application/pdf' ? 'file' : 'camera')
          + '<div class="attach-body">' + nameHTML
          + '<div class="attach-meta">' + esc(attachKindLabel(a.kind)) + ' · ' + fmtBytes(a.size_bytes) + ' · ' + fmtDate(a.created_at) + '</div>'
          + (a.notes ? '<div class="attach-note">' + esc(a.notes) + '</div>' : '')
          + '</div>'
          + '<button class="btn btn-icon" title="Удалить" data-act="attach.remove" data-id="' + a.id + '" data-visit="' + visitId + '" aria-label="Удалить">' + I('trash') + '</button>'
          + '</div>';
      });
      html += '</div>';
    }
    box.innerHTML = html;
  }

  // VET-011. Тип вложения раньше спрашивали системным window.prompt со списком
  // «1 — УЗИ, 2 — Рентген…»: на планшете это неудобно, а в части окружений
  // prompt вовсе подавляется — тогда файл молча уходил в «Другое». Комментарий
  // ввести было негде, хотя колонка notes в схеме есть. Теперь после выбора
  // файлов в панели появляется обычная форма: тип селектом, комментарий полем.
  // Форма не модальная намеренно — она открывается ВНУТРИ формы приёма, а
  // вложенные модалки приложение пока не умеет (F2/UX-022).
  var _attachPending = null;   // { visitId, files: [File] }

  function pickAttachment(visitId) {
    var input = document.createElement('input');
    input.type = 'file';
    input.accept = 'image/*,application/pdf';
    input.multiple = true;     // врач снимает поражение с нескольких ракурсов подряд
    input.onchange = async function () {
      var picked = Array.prototype.slice.call(input.files || []);
      if (!picked.length) return;
      var tooBig = picked.filter(function (f) { return f.size > ATTACH_MAX_BYTES; });
      var ok = picked.filter(function (f) { return f.size <= ATTACH_MAX_BYTES; });
      if (tooBig.length) {
        UI.toast(tooBig.length === 1
          ? 'Файл ' + fmtBytes(tooBig[0].size) + ' — больше предела в 10 МБ'
          : 'Не приняты файлы больше 10 МБ: ' + tooBig.map(function(f){ return f.name; }).join(', '),
          'err', 6000);
      }
      if (!ok.length) return;
      // Добавляем к уже отобранным: «Добавить» можно нажать несколько раз.
      if (_attachPending && _attachPending.visitId === visitId) {
        _attachPending.files = _attachPending.files.concat(ok);
      } else {
        _attachPending = { visitId: visitId, files: ok };
      }
      await renderAttachments(visitId);
    };
    input.click();
  }

  // Подтверждение отбора: читаем тип и комментарий из формы и кладём в очередь.
  async function confirmPendingAttachments(visitId) {
    if (!_attachPending || _attachPending.visitId !== visitId) return;
    var files = _attachPending.files;
    for (var i = 0; i < files.length; i++) {
      var kindEl = document.getElementById('att-kind-' + i);
      var noteEl = document.getElementById('att-note-' + i);
      // Кладём в очередь всегда, даже онлайн: одна дорога для всех случаев —
      // меньше веток, и файл не потеряется, если сеть отвалится в момент отправки.
      await window.VetSync.queueAttachment({
        id: window.VetDB.uuid(),
        visit_id: visitId,
        kind: (kindEl && kindEl.value) || 'other',
        notes: (noteEl && noteEl.value.trim()) || '',
        file_name: files[i].name || 'scan',
        size: files[i].size,
        blob: files[i],
        status: 'pending',
        retry_count: 0,
        created_at: new Date().toISOString(),
      });
    }
    _attachPending = null;
    await renderAttachments(visitId);

    // Приёма ещё нет — отправлять некуда: сервер отверг бы вложение к
    // несуществующему приёму. Файл ждёт сохранения формы. И помечаем форму
    // изменённой, иначе «Отмена» выбросила бы снимок без единого вопроса.
    if (isDraftVisitKey(visitId)) {
      if (UI.markModalDirty) UI.markModalDirty();
      // Черновик формы должен сохраниться даже при пустых полях: в нём лежит
      // ключ, по которому восстановленная форма найдёт этот файл.
      if (UI.forceVisitDraft) UI.forceVisitDraft();
      UI.toast(files.length === 1 ? 'Файл приложен — сохранится вместе с приёмом'
                                  : 'Файлов приложено: ' + files.length + ' — сохранятся вместе с приёмом', 'ok');
      return;
    }

    UI.toast('Отправляется на сервер…', 'ok');
    try {
      var res = await window.VetSync.pushAttachments();
      await renderAttachments(visitId);
      if (res.uploaded) UI.toast(res.uploaded === 1 ? 'Вложение сохранено на сервере'
                                                   : 'Вложений сохранено: ' + res.uploaded, 'ok');
      else if (res.failed) UI.toast('Нет связи — файлы отправятся при подключении', 'warn', 5000);
    } catch (e) {
      UI.toast('Нет связи — файлы отправятся при подключении', 'warn', 5000);
    }
  }

  function cancelPendingAttachments(visitId) {
    _attachPending = null;
    renderAttachments(visitId);
  }

  function dropPendingAttachment(visitId, idx) {
    if (!_attachPending || _attachPending.visitId !== visitId) return;
    // Значения полей уже введены — сохраняем их, чтобы удаление одного файла
    // не стирало подписи у остальных.
    var keep = _attachPending.files.map(function (f, i) {
      var k = document.getElementById('att-kind-' + i);
      var n = document.getElementById('att-note-' + i);
      return { file: f, kind: k && k.value, notes: n && n.value };
    });
    keep.splice(Number(idx), 1);
    _attachPending.files = keep.map(function (x) { return x.file; });
    _attachPending.saved = keep;
    if (!_attachPending.files.length) _attachPending = null;
    renderAttachments(visitId);
  }

  // Просмотр снимка. Своим оверлеем, а не через showModal: панель вложений
  // живёт ВНУТРИ модалки приёма, а вложенные модалки приложение пока не умеет
  // (F2/UX-022). Тем же приёмом сделан UI.confirm — отдельный узел поверх всего.
  function previewAttachment(id, name) {
    var url = '/attachments/' + id + '/file?t='
            + encodeURIComponent((window.VetAuth && window.VetAuth.token()) || '');
    var o = document.createElement('div');
    o.className = 'imgview-overlay';
    o.innerHTML = '<div class="imgview-bar">'
      + '<span class="imgview-name">' + esc(name || '') + '</span>'
      + '<a class="btn btn-ghost btn-sm" href="' + url + '" target="_blank" rel="noopener">Открыть отдельно</a>'
      + '<button type="button" class="btn btn-ghost btn-sm" id="imgview-close" aria-label="Закрыть">Закрыть</button>'
      + '</div><div class="imgview-stage"><img class="imgview-img" alt="' + esc(name || '') + '" src="' + url + '"></div>'
      + '<div class="imgview-hint">Нажмите на снимок, чтобы увеличить</div>';
    document.body.appendChild(o);

    var img = o.querySelector('.imgview-img');
    // Увеличение по нажатию: на планшете это надёжнее жестов, а врачу нужно
    // разглядеть участок кожи, а не листать масштабы.
    img.onclick = function () { img.classList.toggle('imgview-zoom'); };
    function close() { document.removeEventListener('keydown', onKey, true); o.remove(); }
    o.querySelector('#imgview-close').onclick = close;
    o.onclick = function (e) { if (e.target === o || e.target.classList.contains('imgview-stage')) close(); };
    // Escape должен закрыть ТОЛЬКО просмотр. Модалка приёма слушает Escape на
    // том же document, поэтому обычного stopPropagation мало (он не отменяет
    // соседние обработчики того же узла): вешаемся на фазу перехвата и
    // глушим событие целиком — иначе один Escape уносил и снимок, и форму.
    function onKey(e) {
      if (e.key !== 'Escape') return;
      e.stopImmediatePropagation();
      e.preventDefault();
      close();
    }
    document.addEventListener('keydown', onKey, true);
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
    var ok = await UI.confirm('Удалить запись о вакцинации?',
      'Запись исчезнет из истории животного, и срок следующей вакцинации по ней считаться не будет. Действие необратимо.');
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
    showLoading('items-list');
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
    if (!list.length) { el.innerHTML = q ? searchEmpty('search-items') : emptyState('Каталог пуст', '+ Позиция', 'item.add', 'box'); return; }
    el.innerHTML = list.map(function(it) {
      var typeLabel = it.type==='drug'?'Препарат':'Услуга';
      var badgeCls  = it.type==='drug'?'drug':'service';
      return '<div class="erow" data-act="item.edit" data-id="'+it.id+'">'
        +'<div class="erow-avatar '+(it.type==='drug'?'cat':'dog')+'">'+(it.type==='drug'?I('syringe'):I('stethoscope'))+'</div>'
        +'<div class="erow-body">'
        +'<div class="erow-title">'+hl(it.name,q)+'</div>'
        +'<div class="erow-sub"><span class="badge badge-'+badgeCls+'">'+typeLabel+'</span></div>'
        +'</div>'
        +'<div class="erow-right">'
        +'<span class="erow-amount">'+Number(it.price).toFixed(0)+' ₸</span>'
        +'<div class="erow-actions">'
        +'<button class="btn btn-icon" data-act="item.edit" data-id="'+it.id+'" title="Редактировать" aria-label="Редактировать">'+UI.icon('edit','')+'</button>'
        // UX-012: удаление ушло в «⋯». Икона-корзина стояла вплотную к
        // карандашу и на планшете ловила промах пальцем — а это позиция
        // каталога, на которую ссылаются приёмы.
        +UI.rowMenu([
            {label:'Удалить', icon:'trash', danger:true, act:'item.delete', data:{id:it.id}}
          ])
        +'</div></div></div>';
    }).join('');
  }

  // Список шаблонов нужен форме услуги синхронно — подгружаем заранее.
  async function primeProtocols() {
    if (!window.VetProtocols) return;
    try { UI.setProtocols(await VetProtocols.loadTemplates()); } catch (e) {}
  }

  async function addItem() {
    await primeProtocols();
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
    await primeProtocols();
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

  // ПРАВИЛО: в inline-обработчик подставляем ТОЛЬКО идентификатор, никогда
  // свободный текст. esc() здесь не защищает: браузер HTML-декодирует значение
  // атрибута ДО того, как отдаст его JS-парсеру, поэтому &#39; снова становится
  // апострофом и разрывает строку кода. Имя и телефон берём по id из данных,
  // которые и так загружены.
  async function deleteItem(id) {
    var it = _items.find(function (x) { return x.id === id; }) || {};
    var ok = await UI.confirm('Удалить позицию?', it.name || '');
    if (!ok) return;
    try { await api('DELETE','/items/'+id); try{var _b=(window.VetAppConfig&&window.VetAppConfig.apiBase)||'',_n=window.__nativeFetch||window.fetch.bind(window);await _n(_b+'/items/'+id,{method:'DELETE',headers:{'X-Bypass-Local':'1'}});}catch(_e){} UI.toast('Удалено','ok'); await initItems(); }
    catch(e) { UI.toast(e.message,'err'); }
  }

  // ═══════════════════════════════════════════════════════════════════════
  // STAFF
  // ═══════════════════════════════════════════════════════════════════════
  var _staff = [];

  async function initStaff() {
    showLoading('staff-list');
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
    if (!list.length) { el.innerHTML = q ? searchEmpty('search-staff') : emptyState('Персонал не добавлен', '+ Сотрудник', 'staff.add', 'users'); return; }
    el.innerHTML = list.map(function(s) {
      var media = s.photo
        ? '<img class="pet-photo" src="'+s.photo+'" alt="">'
        : UI.avatar(s.name,'staff');
      return '<div class="erow" data-act="staff.card" data-id="'+s.id+'">'
        +media
        +'<div class="erow-body">'
        +'<div class="erow-title">'+hl(s.name,q)+'</div>'
        +'<div class="erow-sub">'+esc(ROLE_LABELS[s.role]||s.role||'')+(s.phone?' · '+esc(s.phone):'')+'</div>'
        +'</div>'
        +'<div class="erow-right">'
        +(s.is_active?'<span class="badge badge-active">Активен</span>':'<span class="badge badge-inactive">Неактивен</span>')
        +'<div class="erow-actions">'
        +'<button class="btn btn-icon" data-act="staff.edit" data-id="'+s.id+'" title="Редактировать" aria-label="Редактировать">'+UI.icon('edit','')+'</button>'
        +UI.rowMenu([
            {label:'Удалить', icon:'trash', danger:true, act:'staff.delete', data:{id:s.id}}
          ])
        +'</div></div></div>';
    }).join('');
  }

  // ── Карточка сотрудника: фото, контакты и рабочая статистика ──────
  async function showStaffCard(id) {
    var st = _staff.find(function(x){ return x.id===id; });
    if (!st) {
      try { st = (await window.VetDB.getAll('staff')).find(function(x){ return x.id===id; }); } catch(e) { window.VetLog.warn('staff:byId', e); }
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

  async function deleteStaff(id) {
    var st = _staff.find(function (x) { return x.id === id; }) || {};
    var ok = await UI.confirm('Удалить сотрудника?', st.name || '');
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
    // Клиниковый конфиг отчёта (наименования/таблицы/формула) — с сервера,
    // чтобы наименования применились уже при первом построении.
    await _reportConfigLoad();
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
          try { staff = await window.VetDB.getAll('staff'); } catch(e) { window.VetLog.warn('staff:list', e); }
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

      // ── Показатели клиники ────────────────────────────────────────────
      // Учётная система фиксирует прошлое; владельцу нужно видеть, где
      // деньги. Данные для всех трёх метрик уже собираются — не хватало
      // только выводов. Считаем по тому же периоду, что и выручку.
      var allVisitsForMetrics = [];
      try { allVisitsForMetrics = (await window.VetDB.getAll('visits')).filter(function(v){ return !v.is_deleted; }); }
      catch (e) { if (window.VetLog) window.VetLog.warn('metrics:visits', e); }

      // 1. Первичные и повторные за период. visit_type пишется в каждый приём,
      //    но до сих пор нигде не анализировался — только бейдж в списке.
      var primaryCnt = 0, repeatCnt = 0;
      visits.forEach(function (v) {
        if (String(v.visit_type || '').toLowerCase() === 'вторичный') repeatCnt++;
        else primaryCnt++;
      });
      var repeatShare = visits.length ? Math.round(repeatCnt * 100 / visits.length) : 0;

      // 2. Загрузка расписания: занятые слоты из доступных. Пустой слот —
      //    не «свободно», а упущенная выручка, и её сейчас никто не видит.
      var slotsBusy = 0, slotsTotal = 0, loadPct = null;
      try {
        var st = await loadClinicSettings();
        var hStart = st && st.sched_start != null ? Number(st.sched_start) : 8;
        var hEnd   = st && st.sched_end   != null ? Number(st.sched_end)   : 20;
        var perDay = Math.max(0, (hEnd - hStart) * 2); // слот 30 минут
        var dFrom = new Date(fromStr), dTo = new Date(toStr);
        var days = Math.floor((dTo - dFrom) / 86400000) + 1;
        if (days > 0 && perDay > 0) {
          slotsTotal = perDay * days;
          var apptsAll = await window.VetDB.getAll('appointments');
          slotsBusy = (apptsAll || []).filter(function (a) {
            if (a.is_deleted || a.status === 'cancelled') return false;
            var ad = (a.starts_at || '').slice(0, 10);
            return ad >= fromStr && ad <= toStr;
          }).length;
          loadPct = Math.round(slotsBusy * 100 / slotsTotal);
        }
      } catch (e) { if (window.VetLog) window.VetLog.warn('metrics:load', e); }

      // 3. Возвращаемость: из питомцев, впервые пришедших в период, сколько
      //    вернулись в течение 90 дней. Отвечает на вопрос «клиника растёт
      //    или просто прогоняет поток» и честно покажет эффект напоминаний.
      var firstByPet = {};
      allVisitsForMetrics.forEach(function (v) {
        if (!v.pet_id || !v.date) return;
        var d = toLocalDateStr(v.date);
        if (!firstByPet[v.pet_id] || d < firstByPet[v.pet_id]) firstByPet[v.pet_id] = d;
      });
      var cohort = 0, returned = 0;
      Object.keys(firstByPet).forEach(function (petId) {
        var first = firstByPet[petId];
        if (first < fromStr || first > toStr) return;
        cohort++;
        var deadline = new Date(new Date(first).getTime() + 90 * 86400000).toISOString().slice(0, 10);
        var came = allVisitsForMetrics.some(function (v) {
          if (v.pet_id !== petId) return false;
          var d = toLocalDateStr(v.date);
          return d > first && d <= deadline;
        });
        if (came) returned++;
      });
      var returnPct = cohort ? Math.round(returned * 100 / cohort) : null;

      // Оценки приёмов (NPS) — только у админа: маршрут под requireAdmin.
      var npsRow = '';
      try {
        if (window.VetAuth && VetAuth.user() && VetAuth.user().role === 'admin' && navigator.onLine) {
          var base = (window.VetAppConfig && window.VetAppConfig.apiBase) || '';
          var nf = window.__nativeFetch || window.fetch.bind(window);
          var fbRes = await nf(base + '/feedback?from=' + fromStr + '&to=' + toStr, {
            headers: { 'X-Bypass-Local': '1', 'X-Auth-Token': (VetAuth.token && VetAuth.token()) || '' }
          });
          var fbBody = await fbRes.json();
          if (fbRes.ok && fbBody.status === 'ok' && fbBody.data && fbBody.data.count) {
            var fb = fbBody.data;
            npsRow = '<tr><td>Оценка приёма (NPS)</td><td class="num">' + fb.nps
              + ' <span class="text-muted">(средняя ' + fb.average.toFixed(1)
              + ' по ' + fb.count + ' ответам)</span></td></tr>';
          }
        }
      } catch (e) { if (window.VetLog) window.VetLog.warn('metrics:nps', e); }

      var metricsHTML =
        '<div class="report-group"><div class="report-group-title">' + I('chart') + ' Показатели клиники</div>'
        + '<table class="report-table"><tbody>'
        + '<tr><td>Первичные приёмы</td><td class="num">' + primaryCnt + '</td></tr>'
        + '<tr><td>Повторные приёмы</td><td class="num">' + repeatCnt
        + ' <span class="text-muted">(' + repeatShare + '%)</span></td></tr>'
        + (loadPct === null ? ''
            : '<tr><td>Загрузка расписания</td><td class="num">' + loadPct + '%'
              + ' <span class="text-muted">(' + slotsBusy + ' из ' + slotsTotal + ' слотов)</span></td></tr>')
        + (returnPct === null
            ? '<tr><td>Возвращаемость новых пациентов</td><td class="num text-muted">нет новых за период</td></tr>'
            : '<tr><td>Вернулись в течение 90 дней</td><td class="num">' + returnPct + '%'
              + ' <span class="text-muted">(' + returned + ' из ' + cohort + ' новых)</span></td></tr>')
        + npsRow
        + '</tbody></table>'
        + '<div class="text-sm text-muted" style="padding:8px 0 0;">'
        + 'Возвращаемость считается по питомцам, впервые пришедшим в выбранный период; '
        + 'для свежих дат она ещё неполная — 90 дней не прошли.'
        + '</div></div>';

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
        + metricsHTML
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

  // ── Сворачивание групп отчёта (сохраняется по клинике в localStorage) ──
  function _rptCollapsed() {
    try { return JSON.parse(localStorage.getItem('vet-rpt-collapsed') || '{}'); }
    catch (e) { return {}; }
  }
  function _rptSetCollapsed(key, val) {
    var o = _rptCollapsed(); o[key] = val;
    try { localStorage.setItem('vet-rpt-collapsed', JSON.stringify(o)); } catch (e) {}
  }
  // Класс для свёрнутой группы при построении HTML.
  function _rgClass(key) { return _rptCollapsed()[key] ? ' collapsed' : ''; }

  // Делегированный клик по заголовку группы — сворачивает/разворачивает.
  // Вешаем один раз на постоянный контейнер #report-content (его innerHTML
  // меняется, но сам узел живёт — обработчик переживает перерисовки).
  function _wireReportCollapse() {
    var rc = document.getElementById('report-content');
    if (!rc || rc._collapseWired) return;
    rc._collapseWired = true;
    rc.addEventListener('click', function (e) {
      var t = e.target.closest ? e.target.closest('.report-group-title') : null;
      if (!t) return;
      var g = t.closest('.report-group'); if (!g) return;
      var key = g.getAttribute('data-rgroup'); if (!key) return;
      var nowCollapsed = !g.classList.contains('collapsed');
      g.classList.toggle('collapsed', nowCollapsed);
      _rptSetCollapsed(key, nowCollapsed);
    });
  }

  // ═══════════════════════════════════════════════════════════════════════
  // Настройки отчёта за день (наименования итогов, выбор таблиц, формула).
  // Клиниковые: хранятся на сервере (server_settings), кэш в localStorage.
  // ═══════════════════════════════════════════════════════════════════════
  var REPORT_CFG_DEFAULTS = {
    tables: { visits: true, doctors: true, services: true, drugs: true },
    labels: {
      revenue:   'Выручка по позициям',
      discounts: 'Скидки',
      received:  'Получено за день',
      card:      'Оплата картой (безнал)',
      cash:      'Наличные',
      clinic:    'Доля клиники (касса)',
      doctors:   'Заработок врачей',
      settle:    'Итог расчёта',
      settleSub: 'наличными врачу после сдачи кассы',
    },
    // Формула строки «Итог расчёта». Переменные: Доля врача, Доля клиники,
    // Сумма, Наличные, Безналичные. По умолчанию = заработок врача − безнал.
    formula: 'Доля врача - Безналичные',
  };
  var _reportCfg = null;              // текущий конфиг (после merge)
  var _lastReportVars = null;         // значения переменных последнего отчёта (для предпросмотра формулы)

  function _mergeReportCfg(o) {
    o = o || {};
    return {
      tables:  Object.assign({}, REPORT_CFG_DEFAULTS.tables, o.tables || {}),
      labels:  Object.assign({}, REPORT_CFG_DEFAULTS.labels, o.labels || {}),
      formula: (typeof o.formula === 'string' && o.formula.trim()) ? o.formula : REPORT_CFG_DEFAULTS.formula,
    };
  }
  function _reportConfig() {
    if (_reportCfg) return _reportCfg;
    var cached = {};
    try { cached = JSON.parse(localStorage.getItem('vet-report-daily-config') || '{}'); } catch (e) {}
    _reportCfg = _mergeReportCfg(cached);
    return _reportCfg;
  }
  async function _reportConfigLoad() {
    try {
      var base = (window.VetAppConfig && VetAppConfig.apiBase) || '';
      var nf = window.__nativeFetch || window.fetch.bind(window);
      var res = await nf(base + '/settings/report-daily', { headers: { 'X-Auth-Token': (window.VetAuth && VetAuth.token && VetAuth.token()) || '' } });
      var j = await res.json();
      _reportCfg = _mergeReportCfg(j && j.data);
      localStorage.setItem('vet-report-daily-config', JSON.stringify(_reportCfg));
    } catch (e) { _reportConfig(); } // офлайн/ошибка — кэш или дефолты
    return _reportCfg;
  }
  async function _reportConfigSave(cfg) {
    _reportCfg = _mergeReportCfg(cfg);
    try { localStorage.setItem('vet-report-daily-config', JSON.stringify(_reportCfg)); } catch (e) {}
    var base = (window.VetAppConfig && VetAppConfig.apiBase) || '';
    var nf = window.__nativeFetch || window.fetch.bind(window);
    var res = await nf(base + '/settings/report-daily', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json', 'X-Auth-Token': (window.VetAuth && VetAuth.token && VetAuth.token()) || '' },
      body: JSON.stringify(_reportCfg),
    });
    if (!res.ok) throw new Error('HTTP ' + res.status);
    return _reportCfg;
  }

  // Безопасный вычислитель формул (без eval). Поддерживает + - * / ( ),
  // унарный минус, сравнения (> < >= <= == !=), логические && || и тернар ?:.
  // Переменные подставляются числами на этапе токенизации.
  var _FORMULA_VARS = ['Доля врача', 'Доля клиники', 'Безналичные', 'Наличные', 'Сумма'];
  function _evalReportFormula(expr, vars) {
    var s = String(expr || ''), i = 0, toks = [];
    function matchVar() {
      for (var k = 0; k < _FORMULA_VARS.length; k++) {
        var nm = _FORMULA_VARS[k];
        if (s.substr(i, nm.length) === nm) { i += nm.length; return nm; }
      }
      return null;
    }
    while (i < s.length) {
      var ch = s[i];
      if (ch === ' ' || ch === '\t' || ch === '\n') { i++; continue; }
      var vn = matchVar();
      if (vn !== null) { toks.push({ t: 'num', v: Number(vars[vn]) || 0 }); continue; }
      if ((ch >= '0' && ch <= '9') || ch === '.') {
        var num = ''; while (i < s.length && ((s[i] >= '0' && s[i] <= '9') || s[i] === '.')) { num += s[i++]; }
        toks.push({ t: 'num', v: parseFloat(num) || 0 }); continue;
      }
      var two = s.substr(i, 2);
      if (['>=', '<=', '==', '!=', '&&', '||'].indexOf(two) >= 0) { toks.push({ t: 'op', v: two }); i += 2; continue; }
      if ('+-*/()><?:'.indexOf(ch) >= 0) { toks.push({ t: 'op', v: ch }); i++; continue; }
      throw new Error('Непонятный символ: «' + ch + '»');
    }
    var p = 0;
    function peek() { return toks[p]; }
    function next() { return toks[p++]; }
    function expect(v) { var t = next(); if (!t || t.v !== v) throw new Error('Ожидалось «' + v + '»'); }
    function pTernary() {
      var c = pOr();
      if (peek() && peek().v === '?') { next(); var a = pTernary(); expect(':'); var b = pTernary(); return c ? a : b; }
      return c;
    }
    function pOr()  { var x = pAnd(); while (peek() && peek().v === '||') { next(); var y = pAnd(); x = (x || y) ? 1 : 0; } return x; }
    function pAnd() { var x = pCmp(); while (peek() && peek().v === '&&') { next(); var y = pCmp(); x = (x && y) ? 1 : 0; } return x; }
    function pCmp() {
      var x = pAdd();
      while (peek() && ['>', '<', '>=', '<=', '==', '!='].indexOf(peek().v) >= 0) {
        var op = next().v, y = pAdd();
        x = op === '>' ? (x > y ? 1 : 0) : op === '<' ? (x < y ? 1 : 0) : op === '>=' ? (x >= y ? 1 : 0)
          : op === '<=' ? (x <= y ? 1 : 0) : op === '==' ? (x === y ? 1 : 0) : (x !== y ? 1 : 0);
      }
      return x;
    }
    function pAdd() { var x = pMul(); while (peek() && (peek().v === '+' || peek().v === '-')) { var op = next().v, y = pMul(); x = op === '+' ? x + y : x - y; } return x; }
    function pMul() { var x = pUn();  while (peek() && (peek().v === '*' || peek().v === '/')) { var op = next().v, y = pUn();  x = op === '*' ? x * y : (y !== 0 ? x / y : 0); } return x; }
    function pUn()  { if (peek() && peek().v === '-') { next(); return -pUn(); } if (peek() && peek().v === '+') { next(); return pUn(); } return pPrim(); }
    function pPrim() {
      var t = next();
      if (!t) throw new Error('Неожиданный конец формулы');
      if (t.t === 'num') return t.v;
      if (t.v === '(') { var x = pTernary(); expect(')'); return x; }
      throw new Error('Неожиданный символ «' + t.v + '»');
    }
    var result = pTernary();
    if (p < toks.length) throw new Error('Лишние символы в конце');
    if (!isFinite(result)) throw new Error('Результат не число');
    return result;
  }

  async function generateReport(dateStr) {
    if (!dateStr) { UI.toast('Выберите дату', 'warn'); return; }

    var el = document.getElementById('report-content');
    if (!el) return;
    _wireReportCollapse();
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

      // Сохраняем позицию прокрутки: перерисовка отчёта (сворачивание групп,
      // настройки, фоновое обновление) не должна швырять пользователя вверх.
      var _scroller = document.querySelector('.main-content') || document.querySelector('main') || document.scrollingElement;
      var _savedTop = _scroller ? _scroller.scrollTop : 0;

      el.innerHTML = buildReportHTML(dateStr, services, drugs, dayVisits, petsMap, ownersMap, staffMap, dayVisitItems, catalogMap, filterName,
        { count: noItemVisits.length, sum: noItemsSum }, discountRows);

      if (_scroller && _savedTop) _scroller.scrollTop = _savedTop;

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

    function groupHTML(title, rows, rgKey) {
      if (!rows.length) return '';
      var sumTotal = rows.reduce(function(s,r){ return s + r.total; }, 0);
      var sumCash  = rows.reduce(function(s,r){ return s + r.cashTotal; }, 0);
      var sumDiff  = sumTotal - sumCash;
      return '<div class="report-group'+_rgClass(rgKey)+'" data-rgroup="'+rgKey+'">'
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
      ? '<div class="report-group'+_rgClass('doctors')+'" data-rgroup="doctors" style="margin-bottom:20px;">'
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
    var visitListHTML = '<div class="report-group'+_rgClass('visits')+'" data-rgroup="visits" style="margin-bottom:20px;">'
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

    // Итог расчёта — по настраиваемой формуле (шестерёнка). Переменные:
    // Доля врача (заработок), Доля клиники (касса), Сумма (получено за день),
    // Наличные, Безналичные. По умолчанию = Доля врача − Безналичные.
    var _cfg = _reportConfig();
    _lastReportVars = {
      'Доля врача':   doctorShare,
      'Доля клиники': grandCash,
      'Сумма':        grandNet,
      'Наличные':     grandCashPaid,
      'Безналичные':  grandCard,
    };
    var settleTotal;
    try { settleTotal = _evalReportFormula(_cfg.formula, _lastReportVars); }
    catch (e) { settleTotal = doctorShare - grandCard; } // некорректная формула — дефолт

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
      ? '<div class="report-group'+_rgClass('discounts')+'" data-rgroup="discounts" style="margin-bottom:20px;">'
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
      + (_cfg.tables.visits  ? visitListHTML : '')
      + (_cfg.tables.doctors ? doctorsHTML   : '')
      + discountsHTML
      + (_cfg.tables.services ? groupHTML('Услуги', services, 'services') : '')
      + (_cfg.tables.drugs    ? groupHTML('Препараты', drugs, 'drugs')     : '')
      + '<div class="report-grand">'
      + '<div class="report-grand-row"><span>'+I('cash')+' '+esc(_cfg.labels.revenue)+'</span><span>' + fmtMoney(grandTotal) + '</span></div>'
      + (grandDiscount ? '<div class="report-grand-row" style="color:var(--warn);"><span>'+esc(_cfg.labels.discounts)+'</span><span>−' + fmtMoney(grandDiscount) + '</span></div>' : '')
      + '<div class="report-grand-row" style="font-size:1rem;"><span><b>'+esc(_cfg.labels.received)+'</b></span><span style="font-weight:900;">' + fmtMoney(grandNet) + '</span></div>'
      + '<div class="report-grand-row" style="color:var(--blue);"><span>'+I('card')+' '+esc(_cfg.labels.card)+'</span><span>' + fmtMoney(grandCard) + '</span></div>'
      + '<div class="report-grand-row"><span>'+I('cash')+' '+esc(_cfg.labels.cash)+'</span><span>' + fmtMoney(grandCashPaid) + '</span></div>'
      + '<div class="report-grand-row" style="border-top:1px solid var(--border);margin-top:8px;padding-top:8px;"><span>'+I('hospital')+' '+esc(_cfg.labels.clinic)+'</span><span>' + fmtMoney(grandCash) + '</span></div>'
      + '<div class="report-grand-row grand-diff"><span>'+I('stethoscope')+' '+esc(_cfg.labels.doctors)+'</span><span style="color:var(--accent);font-weight:800;">' + fmtMoney(doctorShare) + '</span></div>'
      + '<div class="report-grand-row" style="border-top:2px solid var(--border);margin-top:8px;padding-top:10px;font-size:1rem;">'
      + '<span><b>'+esc(_cfg.labels.settle)+'</b>' + (_cfg.labels.settleSub ? ' <span class="text-muted text-sm">'+esc(_cfg.labels.settleSub)+'</span>' : '') + '</span>'
      + '<span style="font-weight:900;color:' + (settleTotal < 0 ? 'var(--danger, #dc3545)' : 'var(--text)') + ';">' + fmtMoney(settleTotal) + '</span></div>'
      + '</div>'
      + '</div>';
  }

  // Модалка настроек отчёта (шестерёнка): выбор таблиц, наименования итогов,
  // формула итоговой строки с предпросмотром на данных текущего отчёта.
  function openReportSettings() {
    var cfg = _reportConfig(), L = cfg.labels, T = cfg.tables;
    function chk(key, title) { return '<label class="rs-check"><input type="checkbox" data-rt="'+key+'"'+(T[key]?' checked':'')+'> '+esc(title)+'</label>'; }
    function inp(key, title) { return '<div class="form-group"><label class="form-label">'+esc(title)+'</label><input class="form-input" data-rl="'+key+'" value="'+esc(L[key]||'')+'"></div>'; }
    var varBtns = ['Доля врача','Доля клиники','Сумма','Наличные','Безналичные'].map(function(v){
      return '<button type="button" class="btn btn-ghost btn-sm rs-var" data-var="'+esc(v)+'">'+esc(v)+'</button>';
    }).join('');
    var body =
        '<div class="rs-sect"><div class="rs-sect-t">Показывать таблицы</div><div class="rs-checks">'
      + chk('visits','Приёмы за день') + chk('doctors','Заработок по врачам')
      + chk('services','Услуги') + chk('drugs','Препараты')
      + '</div></div>'
      + '<div class="rs-sect"><div class="rs-sect-t">Наименования итогов</div><div class="form-grid">'
      + inp('revenue','Выручка по позициям') + inp('discounts','Скидки')
      + inp('received','Получено за день') + inp('card','Оплата картой')
      + inp('cash','Наличные') + inp('clinic','Доля клиники')
      + inp('doctors','Заработок врачей')
      + '</div></div>'
      + '<div class="rs-sect"><div class="rs-sect-t">Итоговая строка</div><div class="form-grid">'
      + inp('settle','Название итога') + inp('settleSub','Подпись (мелким)')
      + '</div>'
      + '<div class="form-group form-span-2" style="margin-top:10px;"><label class="form-label">Формула расчёта'+UI.hint('Операции: + − * / ( ) > < >= <= == != && || ?:   Пример: Доля врача > 0 ? Доля врача − Безналичные : 0')+'</label>'
      + '<input class="form-input" id="rs-formula" value="'+esc(cfg.formula)+'" style="font-family:monospace;">'
      + '<div class="form-hint" style="margin-top:6px;">Переменные (нажмите, чтобы вставить):</div>'
      + '<div class="flex-gap" style="flex-wrap:wrap;margin:6px 0;">'+varBtns+'</div>'
      + '<div id="rs-preview" style="margin-top:8px;font-weight:700;font-size:.9rem;"></div>'
      + '</div></div>';
    UI.showModal({
      title: 'Настройки отчёта за день', size: 'lg', saveLabel: 'Сохранить',
      bodyHTML: body,
      afterOpen: function() {
        var fInp = document.getElementById('rs-formula'), prev = document.getElementById('rs-preview');
        function upd() {
          var vars = _lastReportVars || { 'Доля врача':0,'Доля клиники':0,'Сумма':0,'Наличные':0,'Безналичные':0 };
          try { prev.textContent = 'Предпросмотр: ' + fmtMoney(_evalReportFormula(fInp.value, vars)); prev.style.color = 'var(--accent)'; }
          catch (e) { prev.textContent = 'Ошибка: ' + e.message; prev.style.color = 'var(--danger, #dc3545)'; }
        }
        if (fInp) fInp.addEventListener('input', upd);
        document.querySelectorAll('.rs-var').forEach(function(b) {
          b.addEventListener('click', function() {
            var v = this.getAttribute('data-var');
            var st = fInp.selectionStart != null ? fInp.selectionStart : fInp.value.length;
            var en = fInp.selectionEnd != null ? fInp.selectionEnd : fInp.value.length;
            fInp.value = fInp.value.slice(0, st) + v + fInp.value.slice(en);
            fInp.focus(); var np = st + v.length; try { fInp.setSelectionRange(np, np); } catch (e) {}
            upd();
          });
        });
        upd();
      },
      onSave: async function() {
        var newCfg = { tables: {}, labels: {}, formula: (document.getElementById('rs-formula').value || '').trim() };
        document.querySelectorAll('[data-rt]').forEach(function(c) { newCfg.tables[c.getAttribute('data-rt')] = c.checked; });
        document.querySelectorAll('[data-rl]').forEach(function(i) { newCfg.labels[i.getAttribute('data-rl')] = i.value; });
        try { _evalReportFormula(newCfg.formula, { 'Доля врача':1,'Доля клиники':1,'Сумма':1,'Наличные':1,'Безналичные':1 }); }
        catch (e) { UI.toast('Формула с ошибкой: ' + e.message, 'err'); return; }
        try {
          await _reportConfigSave(newCfg);
          UI.hideModal();
          UI.toast('Настройки отчёта сохранены', 'ok');
          var d = document.getElementById('report-date'); if (d && d.value) generateReport(d.value);
        } catch (e) { UI.toast('Не удалось сохранить: ' + (e && e.message || e), 'err'); }
      },
    });
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
    setupThemeSwitch();

    // Вкладка «Модули» (админ): тумблеры склада и портала пишут единый
    // PUT /settings/module/{key}; телеграм только показываем (управляется
    // токеном). Мягкие зависимости приходят в data._warnings — показываем.
    initModulesTab();

    // R7: неразрушающее «Обновить с сервера» (полный pull) — отдельно от
    // пугающего «Сбросить локальные данные».
    var refBtn = el('btn-refresh-from-server');
    if (refBtn) refBtn.onclick = async function() {
      if (!(window.VetSync && VetSync.pullFull)) return;
      refBtn.disabled = true;
      var old = refBtn.innerHTML; refBtn.innerHTML = 'Обновляю…';
      try {
        await VetSync.pullFull();
        var m = el('refresh-server-msg'); if (m) m.style.display='';
        UI.toast('Данные обновлены с сервера', 'ok');
        // Перечитываем экран из свежего IndexedDB — простой и надёжный путь.
        setTimeout(function(){ location.reload(); }, 700);
      } catch(e) {
        UI.toast('Не удалось обновить: ' + (e && e.message || e), 'err');
        refBtn.innerHTML = old; refBtn.disabled = false;
      }
    };
    // Пользователи и телеграм — админские вкладки; грузим по факту наличия.
    if (document.querySelector('[data-spanel="users"]') && window.VetAuth && VetAuth.user() && VetAuth.user().role === 'admin') {
      initUsers();
      if (window.VetTelegram) VetTelegram.initSettings(); // модуль telegram (M4.1)
    }

    // Диагностика: журнал последних ошибок из VetLog (см. app.js).
    var diagBtn = document.getElementById('btn-diag-refresh');
    if (diagBtn) diagBtn.onclick = renderDiagLog;
    renderDiagLog();

    // Справочник диагнозов
    if (document.getElementById('diagnoses-list')) renderDiagnoses();
    // Шаблоны протоколов — по ПРАВУ «Справочники», а не по роли: клиника
    // должна иметь возможность доверить ведение бланков старшему врачу, не
    // делая его администратором целиком. Сервер закрыт тем же правом.
    var protoCard = document.getElementById('protocols-card');
    if (protoCard) {
      var mayEditTpl = !!(window.VetAuth && VetAuth.can('templates', 'edit'));
      protoCard.style.display = mayEditTpl ? '' : 'none';
      if (mayEditTpl && window.VetProtocols) VetProtocols.init();
    }
    // Справочник диагнозов: карточка видна всем (заготовки нужны при
    // заполнении приёма), но кнопка «Добавить» — только с правом правки.
    var diagAdd = document.querySelector('[data-act="diagnosis.add"]');
    if (diagAdd) diagAdd.style.display =
      (window.VetAuth && VetAuth.can('templates', 'edit')) ? '' : 'none';

    // Корзина: доступна всем, кто видит настройки — восстановление идёт
    // через обычный синк и подчиняется тем же правам, что и правка.
    var trashBtn = document.getElementById('btn-trash-refresh');
    if (trashBtn) trashBtn.onclick = renderTrash;
    if (document.getElementById('trash-list')) renderTrash();

    // Резервные копии — только администратору (маршруты под requireAdmin).
    var bkCard = document.getElementById('backup-card');
    if (bkCard) {
      var isAdmin = window.VetAuth && VetAuth.user() && VetAuth.user().role === 'admin';
      bkCard.style.display = isAdmin ? '' : 'none';
      if (isAdmin) {
        var bkBtn = document.getElementById('btn-backup-now');
        if (bkBtn) bkBtn.onclick = runBackupNow;
        renderBackupStatus();
      }
    }
  }

  // ── Корзина ──────────────────────────────────────────────────────────────
  // Удаление мягкое (is_deleted=1), но вернуть карточку из интерфейса было
  // нельзя — только через разработчика. Для системы, стоящей в клинике без
  // своего админа, это блокер: ошибочно удалённый владелец прячет и всех
  // его животных.
  //
  // Данные берём С СЕРВЕРА, а не из локальной базы: при pull удалённые записи
  // физически стираются из IndexedDB (Правило 0 в mergePulledStore — удаление
  // применяется жёстко, чтобы гарантированно разойтись по устройствам).
  // Единственное место, где удалённая карточка ещё существует, — SQLite
  // сервера. Поэтому корзина требует связи; восстановление её тоже требует —
  // иначе запись не разойдётся на другие устройства.
  var TRASH_DAYS = 30;

  function trashFetch(path, method, body) {
    var base = (window.VetAppConfig && window.VetAppConfig.apiBase) || '';
    var nf = window.__nativeFetch || window.fetch.bind(window);
    return nf(base + path, {
      method: method || 'GET',
      headers: {
        'Content-Type': 'application/json',
        'X-Bypass-Local': '1',
        'X-Auth-Token': (window.VetAuth && VetAuth.token && VetAuth.token()) || ''
      },
      body: body ? JSON.stringify(body) : undefined
    });
  }

  async function renderTrash() {
    var el = document.getElementById('trash-list');
    if (!el) return;
    if (!navigator.onLine) {
      el.innerHTML = '<div class="text-sm text-muted">Корзина доступна только при связи '
        + 'с сервером: удалённые записи хранятся там.</div>';
      return;
    }
    el.innerHTML = '<div class="text-sm text-muted">Загрузка…</div>';
    try {
      var res = await trashFetch('/trash');
      var body = await res.json();
      if (!res.ok || body.status !== 'ok') {
        el.innerHTML = '<div class="text-sm" style="color:var(--danger);">'
          + esc(body.message || ('Ошибка ' + res.status)) + '</div>';
        return;
      }
      var items = (body.data && body.data.items) || [];
      if (!items.length) {
        el.innerHTML = '<div class="text-sm text-muted">Корзина пуста — за последние '
          + TRASH_DAYS + ' дней ничего не удаляли.</div>';
        return;
      }
      el.innerHTML = items.map(function (r) {
        return '<div class="erow flush-x">'
          + '<div class="erow-body">'
          + '<div class="erow-title">' + esc(r.title || '—') + '</div>'
          + '<div class="erow-sub">' + esc(r.label || '')
          + (r.deleted_at ? ' · удалено ' + esc(fmtDate(r.deleted_at)) : '') + '</div></div>'
          + '<div class="erow-right"><button class="btn btn-ghost btn-sm trash-restore" '
          + 'data-table="' + esc(r.table) + '" data-id="' + esc(r.id) + '">'
          + 'Восстановить</button></div></div>';
      }).join('');
      // Делегирование вместо onclick в разметке: id и таблица едут в data-,
      // без экранирования кавычек внутри строкового шаблона.
      el.onclick = function (ev) {
        var b = ev.target.closest && ev.target.closest('.trash-restore');
        if (b) restoreFromTrash(b.dataset.table, b.dataset.id);
      };
    } catch (e) {
      if (window.VetLog) window.VetLog.warn('trash:list', e);
      el.innerHTML = '<div class="text-sm text-muted">Не удалось получить корзину.</div>';
    }
  }

  async function restoreFromTrash(table, id) {
    try {
      var res = await trashFetch('/trash/restore', 'POST', { table: table, id: id });
      var body = await res.json();
      if (!res.ok || body.status !== 'ok') {
        UI.toast(body.message || 'Не удалось восстановить', 'err');
        return;
      }
      UI.toast('Запись восстановлена', 'ok');
      // Забираем восстановленную запись обратно на устройство: локально её
      // уже нет (её стёр pull при удалении), поэтому нужен полный pull.
      if (window.VetSync && VetSync.pullFull) {
        try { await VetSync.pullFull(); } catch (e) { /* приедет следующим циклом */ }
      }
      renderTrash();
    } catch (e) {
      if (window.VetLog) window.VetLog.warn('trash:restore', e);
      UI.toast('Нет связи с сервером', 'err');
    }
  }

  // ── Резервные копии ──────────────────────────────────────────────────────
  // Копии живут на сервере, поэтому запрос идёт мимо локальной базы
  // (X-Bypass-Local): офлайн показываем честное «нет связи», а не пустоту.
  function backupFetch(path, method) {
    var base = (window.VetAppConfig && window.VetAppConfig.apiBase) || '';
    var nf = window.__nativeFetch || window.fetch.bind(window);
    return nf(base + path, {
      method: method || 'GET',
      headers: {
        'Content-Type': 'application/json',
        'X-Bypass-Local': '1',
        'X-Auth-Token': (window.VetAuth && VetAuth.token && VetAuth.token()) || ''
      }
    });
  }

  async function renderBackupStatus() {
    var el = document.getElementById('backup-status');
    if (!el) return;
    if (!navigator.onLine) {
      el.innerHTML = '<div class="text-sm text-muted">Нет связи с сервером — состояние копий неизвестно.</div>';
      return;
    }
    try {
      var res = await backupFetch('/backups');
      var body = await res.json();
      if (!res.ok || body.status !== 'ok') {
        el.innerHTML = '<div class="text-sm" style="color:var(--danger);">'
          + esc(body.message || ('Ошибка ' + res.status)) + '</div>';
        return;
      }
      var d = body.data || {};
      var list = d.backups || [];
      if (!list.length) {
        el.innerHTML = '<div class="text-sm" style="color:var(--danger);font-weight:600;">'
          + 'Копий пока нет. Нажмите «Создать копию».</div>';
        return;
      }
      // Возраст последней копии — то, ради чего этот блок и нужен: если копии
      // перестали создаваться, это должно быть видно сразу.
      var h = Number(d.age_hours || 0);
      var tone = h < 26 ? 'var(--accent)' : (h < 24 * 3 ? 'var(--warn, var(--text-2))' : 'var(--danger)');
      var when = h < 1 ? 'только что' : (h < 24 ? h + ' ч назад' : Math.floor(h / 24) + ' дн. назад');
      el.innerHTML =
        '<div style="font-weight:700;color:' + tone + ';margin-bottom:8px;">'
        + 'Последняя копия: ' + esc(when) + '</div>'
        + '<div class="text-sm text-muted" style="margin-bottom:10px;">'
        + 'Хранится копий: ' + list.length + ' (максимум ' + esc(String(d.keep || '')) + ')</div>'
        + list.slice(0, 5).map(function (b) {
            return '<div style="font-family:monospace;font-size:var(--fs-xs);color:var(--text-2);padding:3px 0;">'
              + esc(b.name) + ' · ' + Math.round((b.size_bytes || 0) / 1024) + ' КБ</div>';
          }).join('');
    } catch (e) {
      if (window.VetLog) window.VetLog.warn('backups:list', e);
      el.innerHTML = '<div class="text-sm text-muted">Не удалось получить состояние копий.</div>';
    }
  }

  async function runBackupNow() {
    var btn = document.getElementById('btn-backup-now');
    if (btn) { btn.disabled = true; btn.textContent = 'Создаём…'; }
    try {
      var res = await backupFetch('/backups/run', 'POST');
      var body = await res.json();
      if (res.ok && body.status === 'ok') UI.toast('Копия создана и проверена', 'ok');
      else UI.toast(body.message || 'Не удалось создать копию', 'err');
    } catch (e) {
      UI.toast('Нет связи с сервером', 'err');
    } finally {
      if (btn) { btn.disabled = false; btn.textContent = 'Создать копию'; }
      renderBackupStatus();
    }
  }

  function renderDiagLog() {
    var el = document.getElementById('diag-log');
    if (!el) return;
    var entries = (window.VetLog && window.VetLog.entries()) || [];
    if (!entries.length) {
      el.innerHTML = '<div style="font-size:.85rem;color:var(--text-3);">Ошибок нет — всё работает штатно.</div>';
      return;
    }
    el.innerHTML = entries.slice().reverse().map(function(e){
      var color = e.level === 'error' ? 'var(--danger)' : 'var(--warn, var(--text-2))';
      var time = (e.t || '').slice(11, 19);
      return '<div style="font-family:monospace;font-size:.78rem;padding:6px 0;border-bottom:1px solid var(--border);">'
        + '<span style="color:var(--text-3);">' + esc(time) + '</span> '
        + '<span style="color:' + color + ';font-weight:600;">' + esc(e.ctx) + '</span> '
        + '<span style="color:var(--text-2);">' + esc(e.detail || '') + '</span></div>';
    }).join('');
  }

  // ── Переключатель темы (Светлая / Тёмная / Системная) ───────────────
  function setupThemeSwitch() {
    var box = document.getElementById('theme-switch');
    if (!box || !window.VetTheme) return;
    var cur = VetTheme.get();
    box.querySelectorAll('[data-theme-mode]').forEach(function(btn) {
      btn.classList.toggle('active', btn.dataset.themeMode === cur);
      btn.onclick = function() {
        VetTheme.set(btn.dataset.themeMode);
        box.querySelectorAll('[data-theme-mode]').forEach(function(b){ b.classList.remove('active'); });
        btn.classList.add('active');
      };
    });
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
  // tgApi перенесён в modules/telegram.js (M4.1).

  // initModulesTab — вкладка «Модули» настроек (только админ). Тумблеры
  // склада и портала пишут единый PUT /settings/module/{key}; телеграм
  // только отображаем (управляется токеном). Мягкие зависимости приходят
  // в data._warnings — показываем тостами.
  function initModulesTab() {
    var el = function(id){ return document.getElementById(id); };
    var u = window.VetAuth && VetAuth.user();
    if (!u || u.role !== 'admin') return;
    var base = (window.VetAppConfig && window.VetAppConfig.apiBase) || '';
    var nf = window.__nativeFetch || window.fetch.bind(window);
    var tok = function(){ return (window.VetAuth && VetAuth.token && VetAuth.token()) || ''; };

    // Начальное состояние тумблеров и статуса телеграма.
    nf(base + '/settings/modules', { headers: { 'X-Auth-Token': tok() } })
      .then(function(r){ return r.json(); })
      .then(function(j){
        var d = (j && j.data) || {};
        if (el('s-module-warehouse')) el('s-module-warehouse').checked = !!d.warehouse;
        if (el('s-module-portal'))    el('s-module-portal').checked = ('portal' in d) ? !!d.portal : true;
        var tg = el('s-module-telegram-status');
        if (tg) { tg.textContent = d.telegram ? 'Подключён' : 'Не настроен'; tg.className = 'badge ' + (d.telegram ? 'badge-active' : 'badge-inactive'); }
      }).catch(function(){});

    function wire(key, chk, label) {
      if (!chk) return;
      chk.onchange = async function() {
        var want = chk.checked;
        try {
          var res = await nf(base + '/settings/module/' + key, {
            method: 'PUT',
            headers: { 'Content-Type':'application/json', 'X-Auth-Token': tok() },
            body: JSON.stringify({ enabled: want })
          });
          var j = await res.json();
          if (!res.ok || (j && j.status === 'error')) throw new Error((j && j.message) || 'ошибка');
          await refreshModules();
          UI.toast(label + (want ? ' включён' : ' выключен'), 'ok');
          var warns = j && j.data && j.data._warnings;
          if (warns && warns.length) warns.forEach(function(wn){ UI.toast(wn, 'warn', 6000); });
        } catch(e) {
          UI.toast('Не удалось изменить: ' + (e && e.message || e), 'err');
          chk.checked = !want; // откат галки к прежнему состоянию
        }
      };
    }
    wire('warehouse', el('s-module-warehouse'), 'Модуль склада');
    wire('portal',    el('s-module-portal'),    'Кабинет владельца');
  }

  // initTelegramSettings перенесён в modules/telegram.js (M4.1) —
  // вызывается из initSettings через window.VetTelegram.initSettings.

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
  // ПЕЧАТНЫЕ ФОРМЫ — вынесены в modules/print.js. Здесь остался только
  // printHTML: им пользуются и другие модули.
  // ═══════════════════════════════════════════════════════════════════════

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
          html += '<tr style="cursor:pointer;" title="Открыть приём" aria-label="Открыть приём" '
            + 'data-act="visit.edit.fromReport" data-id="'+v.id+'">'
            + '<td><b>' + esc(pet.name||'—') + '</b> <span style="color:var(--text-3);font-size:.78rem;">' + esc(pet.type||'') + '</span></td>'
            + '<td>' + esc(owner.fio||'—') + '</td>'
            + '<td><a href="tel:' + esc(owner.phone||'') + '" data-act="noop" style="color:var(--accent);">' + esc(owner.phone||'—') + '</a></td>'
            + '<td style="font-size:.82rem;color:var(--text-2);">' + esc(v.diagnosis||v.anamnesis||'—') + '</td>'
            + '<td><button class="btn btn-primary btn-sm" data-act="pet.newVisit.fromReport" data-id="'+v.pet_id+'">+ Приём</button></td>'
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
          + '<th>Когда</th><th>Владелец</th><th>Телефон</th><th>Животное</th><th>Врач</th><th>Причина визита</th>'
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

  // ── Задачи сотрудникам ───────────────────────────────────────────────────
  // Список «Требуют внимания» показывает только то, что система выводит
  // сама. Всё остальное («перезвонить», «заказать препарат») жило в голове
  // и на бумажках. Ручные задачи попадают в тот же список — отдельный экран
  // заводить не стали: у врача и так один рабочий блок на день.

  async function loadTasks() {
    try {
      var all = await window.VetDB.getAll('tasks');
      return (all || []).filter(function (t) { return !t.is_deleted; });
    } catch (e) {
      if (window.VetLog) window.VetLog.warn('tasks:load', e);
      return [];
    }
  }

  // VET-015. ctx — необязательный контекст случая {petId, visitId, petName}.
  // Задача «позвонить через три дня, спросить про переносимость» без него
  // висела на владельце, и исполнитель не понимал, о каком животном речь.
  // stacked: диалог открывается ПОВЕРХ приёма, а не вместо него (F2).
  function taskDialog(ownerId, prefillTitle, ctx) {
    ctx = ctx || {};
    UI.showModal({
      title: 'Новая задача',
      size: 'lg',
      stacked: true,
      bodyHTML:
        '<div class="form-stack">'
        + '<div class="form-group"><label class="form-label">Что сделать<span class="form-req">*</span></label>'
        + '<input id="task-title" class="form-input" value="' + esc(prefillTitle || '') + '" placeholder="Перезвонить по результатам анализов"></div>'
        + '<div class="form-group"><label class="form-label">Срок</label>'
        + '<input id="task-due" class="form-input" type="date"></div>'
        + '<div class="form-group"><label class="form-label">Заметка</label>'
        + '<textarea id="task-note" class="form-textarea" rows="3"></textarea></div>'
        + (ctx.petName
            ? '<div class="text-sm text-muted">Задача по пациенту: <b>' + esc(ctx.petName) + '</b>'
              + (ctx.visitId ? ' · привязана к этому приёму' : '') + '</div>'
            : '')
        + '</div>',
      saveLabel: 'Создать',
      onSave: async function () {
        var title = (document.getElementById('task-title') || {}).value || '';
        if (!title.trim()) { UI.markInvalid(['task-title']); UI.toast('Опишите задачу', 'err'); return; }
        try {
          await api('POST', '/tasks', {
            title: title.trim(),
            note: (document.getElementById('task-note') || {}).value.trim(),
            due_date: (document.getElementById('task-due') || {}).value || '',
            owner_ref: ownerId || '',
            pet_id: ctx.petId || '',
            visit_id: ctx.visitId || ''
          });
          UI.hideModal();
          UI.toast('Задача создана', 'ok');
          // Инкрементально: тянуть всю базу ради одной задачи незачем (TECH-001).
          if (window.VetSync && VetSync.pullSync) { try { await VetSync.pullSync(); } catch (e) {} }
          window.dispatchEvent(new Event('vetdata:changed'));
          if ((document.querySelector('.page.active') || {}).id === 'page-dashboard') initDashboard();
        } catch (e) {
          UI.toast('Не удалось создать: ' + (e && e.message || e), 'err');
        }
      }
    });
  }

  async function completeTask(id) {
    try {
      await api('PUT', '/tasks/' + id, { done: 1 });
      if (window.VetSync && VetSync.pullFull) { try { await VetSync.pullFull(); } catch (e) {} }
      UI.toast('Задача выполнена', 'ok');
      window.dispatchEvent(new Event('vetdata:changed'));
      if ((document.querySelector('.page.active') || {}).id === 'page-dashboard') initDashboard();
    } catch (e) {
      UI.toast('Не удалось отметить: ' + (e && e.message || e), 'err');
    }
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
    if (!owner) { UI.toast('Владелец не найден', 'err'); return; }

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
      +(owner.phone?'<span class="oc-phone" data-act="owner.call" data-id="'+esc(owner.id)+'">'+I('phone')+' '+esc(owner.phone)+'</span>':'')
      +(owner.iin?'<span class="oc-iin">'+(owner.owner_type==='legal'?'БИН':'ИИН')+': '+esc(owner.iin)+'</span>':'')
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
         ? '<div class="oc-actions"><button class="btn btn-ghost btn-sm" '
           + 'data-act="owner.portalCode" data-id="'+ownerId+'">'
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
              +'data-act="pet.card.fromModal" data-id="'+p.id+'">'
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
            return '<div class="oc-visit-row" data-act="visit.edit.fromModal" data-id="'+v.id+'">'
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
      +'<button class="oc-action-btn primary" data-act="owner.newVisit" data-owner="'+ownerId+'" data-pet="'
        +(activePets.length===1 ? activePets[0].id : '')+'">'+I('clipboard')+' Новый приём</button>'
      +'<button class="oc-action-btn" data-act="owner.edit.fromModal" data-id="'+ownerId+'">'+I('edit')+' Редактировать</button>'
      +'<button class="oc-action-btn" data-act="owner.addPet" data-id="'+ownerId+'">'+I('paw')+' Добавить питомца</button>'
      +'<button class="oc-action-btn" data-act="owner.call" data-id="'+esc(owner.id)+'">'+I('phone')+' Позвонить</button>'
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

  // Принимает id владельца, а не номер: номер — свободный текст, и его нельзя
  // подставлять в обработчик (см. ПРАВИЛО выше). Читаем из локальной базы, а не
  // из массива страницы: карточку открывают и из списка животных, и из приёма.
  async function callOwner(ownerId) {
    var phone = '';
    try {
      var o = await window.VetDB.getById('owners', ownerId);
      phone = (o && o.phone) || '';
    } catch (e) {
      if (window.VetLog) window.VetLog.warn('callOwner', e);
    }
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

  // ── VET-014: единая хронология животного ─────────────────────────────
  //
  // Данные были, связной истории — нет. Приёмы в одном месте, результаты во
  // втором, вакцинации в третьем, вложения внутри приёма; чтобы восстановить
  // ход хронического случая («приём → анализ → смена терапии → повторный
  // приём → новый анализ»), врач собирал картину из трёх экранов и рисковал
  // упустить звено. Лента ставит всё рядом по датам.
  var TL_KINDS = {
    visit:  { label: 'Приёмы',     icon: 'clipboard' },
    result: { label: 'Анализы',    icon: 'chart'     },
    attach: { label: 'Вложения',   icon: 'camera'    },
    vacc:   { label: 'Прививки',   icon: 'syringe'   },
    course: { label: 'Назначения', icon: 'stethoscope' },
  };
  var _tlFilter = 'all';

  async function petTimelineEvents(petId) {
    var all = await loadAll();
    var ev = [];

    (all.visits || []).filter(function (v) { return !v.is_deleted && v.pet_id === petId; })
      .forEach(function (v) {
        ev.push({ kind: 'visit', when: v.date, title: v.diagnosis || 'Приём без диагноза',
                  sub: (v.animal_weight ? v.animal_weight + ' кг' : '')
                     + (v.patient_condition ? (v.animal_weight ? ' · ' : '') + v.patient_condition : ''),
                  act: 'visit.peek', id: v.id });
        // Курс лечения — отдельное событие: он длится и объясняет, почему
        // следующий приём выглядит именно так.
        if (v.treatment && (v.treatment_days || v.treatment_until)) {
          ev.push({ kind: 'course', when: v.date,
                    title: 'Курс лечения' + (v.treatment_days ? ', ' + v.treatment_days + ' дн.' : ''),
                    sub: String(v.treatment).slice(0, 120), act: 'visit.peek', id: v.id });
        }
      });

    (all.vaccinations || []).filter(function (v) { return !v.is_deleted && v.pet_id === petId; })
      .forEach(function (v) {
        ev.push({ kind: 'vacc', when: v.administered_at, title: v.vaccine_name,
                  sub: (v.next_due_at ? 'следующая ' + fmtDate(v.next_due_at) : '')
                     + (v.batch_number ? (v.next_due_at ? ' · ' : '') + 'серия ' + v.batch_number : ''),
                  act: v.visit_id ? 'visit.peek' : '', id: v.visit_id || '' });
      });

    // F4/VET-004: назначения в ленте — отдельными событиями. Курс лечения из
    // visits.treatment остаётся (свободный текст никуда не делся), но теперь
    // рядом стоят структурированные назначения с дозой и путём введения.
    try {
      (await window.VetDB.getAll('prescriptions'))
        .filter(function (p) { return !p.is_deleted && p.pet_id === petId; })
        .forEach(function (p) {
          var st = PRESC_STATUS[p.status || 'active'] || PRESC_STATUS.active;
          ev.push({ kind: 'course', when: p.started_at || p.created_at || '',
                    title: p.drug_name + (p.status !== 'active' ? ' — ' + st.label : ''),
                    sub: [prescLine(p), p.instruction, p.status_note].filter(Boolean).join(' · '),
                    act: 'visit.peek', id: p.visit_id || '' });
        });
    } catch (e) {}

    try {
      (await window.VetDB.getAll('visit_results'))
        .filter(function (r) { return !r.is_deleted && r.pet_id === petId && r.status === 'done'; })
        .forEach(function (r) {
          ev.push({ kind: 'result', when: r.filled_at || r.created_at,
                    title: r.title || 'Результат', sub: r.conclusion || '',
                    act: 'result.view', id: r.id });
        });
    } catch (e) {}

    try {
      var visitIds = {};
      (all.visits || []).forEach(function (v) { if (v.pet_id === petId) visitIds[v.id] = v.date; });
      (await window.VetDB.getAll('attachments'))
        .filter(function (a) { return !a.is_deleted && a.pet_id === petId; })
        .forEach(function (a) {
          ev.push({ kind: 'attach', when: a.created_at || visitIds[a.visit_id] || '',
                    title: a.file_name, sub: attachKindLabel(a.kind) + (a.notes ? ' · ' + a.notes : ''),
                    act: String(a.mime_type || '').indexOf('image/') === 0 ? 'attach.preview' : '',
                    id: a.id, name: a.file_name });
        });
    } catch (e) {}

    ev.sort(function (a, b) { return (b.when || '') > (a.when || '') ? 1 : -1; });
    return ev;
  }

  function renderTimeline(events) {
    var box = document.getElementById('tl-list');
    if (!box) return;
    var list = _tlFilter === 'all' ? events : events.filter(function (e) { return e.kind === _tlFilter; });
    if (!list.length) {
      box.innerHTML = '<div class="attach-empty">Событий этого типа нет</div>';
      return;
    }
    var lastDay = '';
    box.innerHTML = list.map(function (e) {
      var day = (e.when || '').slice(0, 10);
      var head = day !== lastDay ? '<div class="tl-day">' + esc(fmtDate(e.when)) + '</div>' : '';
      lastDay = day;
      var k = TL_KINDS[e.kind] || TL_KINDS.visit;
      var clickable = e.act && e.id;
      return head
        + '<div class="tl-item tl-' + e.kind + (clickable ? ' tl-click' : '') + '"'
        + (clickable ? ' data-act="' + e.act + '" data-id="' + esc(e.id) + '"'
                     + (e.name ? ' data-name="' + esc(e.name) + '"' : '') + ' role="button" tabindex="0"' : '')
        + '><span class="tl-icon">' + I(k.icon) + '</span>'
        + '<div class="tl-body"><div class="tl-title">' + esc(e.title) + '</div>'
        + (e.sub ? '<div class="tl-sub">' + esc(e.sub) + '</div>' : '')
        + '</div><span class="tl-kind">' + esc(k.label) + '</span></div>';
    }).join('');
  }

  async function showPetTimeline(petId) {
    var all = await loadAll();
    var pet = (all.pets || []).find(function (p) { return p.id === petId; });
    if (!pet) { UI.toast('Животное не найдено', 'err'); return; }
    var events = await petTimelineEvents(petId);
    _tlEvents = events;
    _tlFilter = 'all';

    var counts = { all: events.length };
    Object.keys(TL_KINDS).forEach(function (k) {
      counts[k] = events.filter(function (e) { return e.kind === k; }).length;
    });
    var chips = '<button type="button" class="filter-btn active" data-act="tl.filter" data-kind="all">Все ' + counts.all + '</button>'
      + Object.keys(TL_KINDS).filter(function (k) { return counts[k]; }).map(function (k) {
          return '<button type="button" class="filter-btn" data-act="tl.filter" data-kind="' + k + '">'
               + esc(TL_KINDS[k].label) + ' ' + counts[k] + '</button>';
        }).join('');

    UI.showModal({
      stacked: true,
      title: 'История: ' + (pet.name || ''),
      size: 'lg', onSave: false, cancelLabel: 'Закрыть',
      bodyHTML: '<div class="tl-filters flex-gap">' + chips + '</div><div class="tl-list" id="tl-list"></div>',
      afterOpen: function () { renderTimeline(events); }
    });
  }
  var _tlEvents = [];

  function setTimelineFilter(kind, btn) {
    _tlFilter = kind;
    var box = btn && btn.parentNode;
    if (box) box.querySelectorAll('.filter-btn').forEach(function (b) {
      b.classList.toggle('active', b.dataset.kind === kind);
    });
    renderTimeline(_tlEvents);
  }

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
      +(owner.phone?'<div class="pc-owner-phone" data-act="owner.call" data-id="'+esc(pet.owner_id)+'">'+I('phone')+' '+esc(owner.phone)+'</div>':'')
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

    // ── Госучёт (ТАҢБА) ───────────────────────────────────────────
    // У реестра нет API: карточку туда заводит человек через портал. Поэтому
    // здесь важно не столько показать номер, сколько честно сказать, что
    // животное с чипом в реестр ещё не внесено — это работа, а не статус.
    var idMethodLabel = { chip:'Микрочип', tag:'Бирка', tattoo:'Татуировка', other:'Иное' };
    var tanbaHTML = '';
    if (pet.chip_number || pet.tanba_number || pet.keep_address || pet.sterilized) {
      tanbaHTML = '<div class="pc-section">'
        +'<div class="pc-section-title">Госучёт (ТАҢБА)</div>'
        +'<div class="pc-health-grid">'
        +healthCard(idMethodLabel[pet.id_method] || 'Средство учёта',
            pet.chip_number ? esc(pet.chip_number) : 'Нет',
            pet.chip_number ? 'ok' : 'none',
            pet.chip_date ? 'от '+fmtDate(pet.chip_date) : '')
        +healthCard('В реестре',
            pet.tanba_number ? esc(pet.tanba_number) : 'Не внесено',
            pet.tanba_number ? 'ok' : 'soon',
            pet.tanba_at ? fmtDate(pet.tanba_at) : (pet.chip_number ? 'Завести на портале' : ''))
        +healthCard('Стерилизация',
            pet.sterilized ? 'Да' : 'Нет',
            pet.sterilized ? 'ok' : 'none',
            pet.sterilized_at ? fmtDate(pet.sterilized_at) : '')
        +'</div>'
        +(pet.keep_address ? '<div class="pc-keep-address text-sm text-muted">'+I('pin')+' Содержится: '+esc(pet.keep_address)+'</div>' : '')
        +'</div>';
    }

    // ── Анализы и результаты ──────────────────────────────────────
    // Ради этого раздела всё и делалось: врач должен открыть прошлый анализ
    // из карточки, не разыскивая приём, в котором его прикрепили.
    var petResults = [];
    try {
      petResults = (await window.VetDB.getAll('visit_results') || [])
        .filter(function(r){ return !r.is_deleted && r.pet_id === petId; })
        .sort(function(a,b){
          var ax=a.filled_at||a.created_at||'', bx=b.filled_at||b.created_at||'';
          return bx > ax ? 1 : -1;
        });
    } catch(e) {}

    var resultsHTML = '';
    if (petResults.length) {
      resultsHTML = '<div class="pc-section">'
        +'<div class="pc-section-title">Анализы и результаты ('+petResults.length+')</div>'
        + petResults.slice(0, 12).map(function(r){
            var done = r.status === 'done';
            return '<div class="res-row" data-act="'+(done?'result.view':'result.fill')+'" data-id="'+esc(r.id)+'">'
              + '<div class="res-row-main">'
              + '<div class="res-row-title">'+esc(r.title||'Результат')+'</div>'
              + '<div class="res-row-sub">'+(done
                  ? (r.filled_at ? fmtDate(r.filled_at) : 'внесён')
                  : '<span class="res-pending">результата ещё нет</span>')+'</div>'
              + '</div>'
              + (done
                  ? '<button type="button" class="btn btn-ghost btn-sm res-row-edit"'
                    + ' data-act="result.fill" data-id="'+esc(r.id)+'">Изменить</button>'
                  : '')
              + '<span class="res-row-go">'+(done ? 'смотреть' : 'заполнить')+'</span>'
              + '</div>';
          }).join('')
        + (petResults.length > 12 ? '<div class="text-sm text-muted">Показаны последние 12</div>' : '')
        + '</div>';
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
            return '<div class="pc-visit-row" data-act="visit.edit.fromModal" data-id="'+v.id+'">'
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
      +'<button class="pc-action-btn primary" data-act="pet.newVisit.fromModal" data-id="'+petId+'">'+I('clipboard')+' Новый приём</button>'
      +'<button class="pc-action-btn" data-act="pet.addVacc" data-id="'+petId+'">'+I('syringe')+' Вакцинация</button>'
      +(pet.status==='active'?'<button class="pc-action-btn" data-act="pet.deceased" data-id="'+petId+'">☠ Умер</button>':'')
      +'<button class="pc-action-btn" data-act="pet.history" data-id="'+petId+'">📊 История</button>'
      +'<button class="pc-action-btn" data-act="pet.edit.fromModal" data-id="'+petId+'">'+I('edit')+' Редактировать</button>'
      +'<button class="pc-action-btn" data-act="pet.photo" data-id="'+petId+'">'+I('camera')+' Фото</button>'
      +'</div>';

    // ── Собираем всё ─────────────────────────────────────────────
    UI.showModal({
      title: '',
      bodyHTML: headerHTML + deceasedBanner + ownerHTML + tanbaHTML + resultsHTML + healthHTML + recentHTML + notesHTML + actionsHTML,
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
      + '<button class="btn btn-ghost btn-sm" data-act="history.tab" data-tab="visits">'+I('clipboard')+' История визитов</button>'
      + '<button class="btn btn-ghost btn-sm" data-act="history.tab" data-tab="disease">'+I('microscope')+' История болезней</button>'
      + '<button class="btn btn-ghost btn-sm" data-act="history.tab" data-tab="weight">'+I('scale')+' История веса</button>'
      + '<button class="btn btn-ghost btn-sm" data-act="history.tab" data-tab="vacc">'+I('syringe')+' Вакцинации</button>'
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
      '<button class="btn btn-ghost" data-act="print.window">Печать</button>'
      + '<button class="btn btn-ghost" data-act="ui.modal.close">Закрыть</button>';

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

  // ── Экспорт отчётов в Excel ──────────────────────────────────────────────
  // Бухгалтеру нужен файл, а не распечатка. Отчёты уже собраны как обычные
  // HTML-таблицы, поэтому выгрузка общая для всех четырёх — SheetJS умеет
  // превращать таблицу в лист напрямую, дублировать логику расчётов
  // не требуется (и, значит, цифры в файле не разойдутся с экраном).

  function exportReportXlsx(containerId, baseName) {
    if (typeof XLSX === 'undefined') { UI.toast('Библиотека XLSX не загружена', 'err'); return; }
    var box = document.getElementById(containerId);
    var tables = box ? box.querySelectorAll('table') : [];
    if (!tables.length) { UI.toast('Сначала сформируйте отчёт', 'err'); return; }

    try {
      var wb = XLSX.utils.book_new();
      var used = {};
      for (var i = 0; i < tables.length; i++) {
        // Имя листа берём из заголовка группы над таблицей — так в файле
        // понятно, что где, без обращения к экрану.
        var grp = tables[i].closest('.report-group');
        var title = grp && grp.querySelector('.report-group-title')
                  ? grp.querySelector('.report-group-title').textContent.trim()
                  : ('Лист ' + (i + 1));
        // Excel: не больше 31 символа и без : \ / ? * [ ]
        title = title.replace(/[:\\/?*\[\]]/g, ' ').trim().slice(0, 28) || ('Лист ' + (i + 1));
        if (used[title]) { used[title]++; title = title.slice(0, 25) + ' ' + used[title]; }
        else used[title] = 1;
        XLSX.utils.book_append_sheet(wb, XLSX.utils.table_to_sheet(tables[i]), title);
      }
      var stamp = new Date().toISOString().slice(0, 10);
      XLSX.writeFile(wb, baseName + '-' + stamp + '.xlsx');
      UI.toast('Файл выгружен', 'ok');
    } catch (e) {
      if (window.VetLog) window.VetLog.warn('export:xlsx', e);
      UI.toast('Не удалось выгрузить: ' + (e && e.message || e), 'err');
    }
  }

  // ── Справочник диагнозов с заготовками ───────────────────────────────────
  // diagnosis у визита — свободная строка: посчитать частые диагнозы нельзя,
  // а «Лечение» и «Рекомендации» врач набирает с нуля каждый раз. Отсюда же
  // берутся приёмы «Без диагноза» — проще не заполнить, чем печатать.
  //
  // Справочник живёт обычной синкуемой таблицей, поэтому работает офлайн.

  async function loadDiagnoses() {
    try {
      var all = await window.VetDB.getAll('diagnosis_templates');
      return (all || []).filter(function (d) { return !d.is_deleted; })
                        .sort(function (a, b) { return String(a.name||'').localeCompare(String(b.name||''), 'ru'); });
    } catch (e) {
      if (window.VetLog) window.VetLog.warn('diagnoses:load', e);
      return [];
    }
  }

  async function renderDiagnoses() {
    var el = document.getElementById('diagnoses-list');
    if (!el) return;
    var list = await loadDiagnoses();
    if (!list.length) {
      el.innerHTML = '<div class="text-sm text-muted">Справочник пуст. Добавьте частые диагнозы — '
        + 'при заполнении приёма система подставит готовый текст лечения.</div>';
      return;
    }
    el.innerHTML = list.map(function (d) {
      var hint = [d.treatment, d.recommendations].filter(Boolean).join(' · ');
      return '<div class="erow flush-x">'
        + '<div class="erow-body"><div class="erow-title">' + esc(d.name) + '</div>'
        + '<div class="erow-sub">' + esc(hint ? hint.slice(0, 90) : 'без заготовки') + '</div></div>'
        + '<div class="erow-right">'
        + '<button class="btn btn-icon diag-edit" data-id="' + esc(d.id) + '" title="Изменить" aria-label="Изменить">'
        + UI.icon('edit', '') + '</button>'
        + '<button class="btn btn-icon danger diag-del" data-id="' + esc(d.id) + '" title="Удалить" aria-label="Удалить">'
        + UI.icon('trash', '') + '</button>'
        + '</div></div>';
    }).join('');

    el.onclick = function (ev) {
      var e = ev.target.closest && ev.target.closest('.diag-edit');
      var d = ev.target.closest && ev.target.closest('.diag-del');
      if (e) diagnosisDialog(e.dataset.id);
      else if (d) deleteDiagnosis(d.dataset.id);
    };
  }

  async function diagnosisDialog(id) {
    var list = await loadDiagnoses();
    var cur = id ? list.find(function (d) { return d.id === id; }) : null;
    UI.showModal({
      title: cur ? 'Изменить диагноз' : 'Новый диагноз',
      size: 'lg',
      bodyHTML:
        '<div class="form-stack">'
        + '<div class="form-group"><label class="form-label">Диагноз<span class="form-req">*</span></label>'
        + '<input id="diag-name" class="form-input" value="' + esc(cur ? cur.name : '') + '" placeholder="Отит наружного уха"></div>'
        + '<div class="form-group"><label class="form-label">Назначение и лечение</label>'
        + '<textarea id="diag-treatment" class="form-textarea" rows="4">' + esc(cur ? cur.treatment : '') + '</textarea></div>'
        + '<div class="form-group"><label class="form-label">Рекомендации владельцу</label>'
        + '<textarea id="diag-rec" class="form-textarea" rows="3">' + esc(cur ? cur.recommendations : '') + '</textarea></div>'
        + '</div>'
        + '<div class="text-sm text-muted" style="margin-top:10px;">'
        + 'Текст подставится в приём как заготовка — врач сможет его поправить.</div>',
      saveLabel: 'Сохранить',
      onSave: async function () {
        var name = (document.getElementById('diag-name') || {}).value || '';
        if (!name.trim()) { UI.markInvalid(['diag-name']); UI.toast('Укажите диагноз', 'err'); return; }
        var body = {
          name: name.trim(),
          treatment: (document.getElementById('diag-treatment') || {}).value.trim(),
          recommendations: (document.getElementById('diag-rec') || {}).value.trim()
        };
        try {
          if (cur) await api('PUT', '/diagnoses/' + cur.id, body);
          else await api('POST', '/diagnoses', body);
          UI.hideModal();
          UI.toast('Сохранено', 'ok');
          if (window.VetSync && VetSync.pullFull) { try { await VetSync.pullFull(); } catch (e) {} }
          renderDiagnoses();
        } catch (e) {
          UI.toast('Не удалось сохранить: ' + (e && e.message || e), 'err');
        }
      }
    });
  }

  async function deleteDiagnosis(id) {
    var ok = await UI.confirm('Удалить диагноз?', 'Записи приёмов не изменятся — удаляется только заготовка.');
    if (!ok) return;
    try {
      await api('DELETE', '/diagnoses/' + id);
      if (window.VetSync && VetSync.pullFull) { try { await VetSync.pullFull(); } catch (e) {} }
      UI.toast('Удалено', 'ok');
      renderDiagnoses();
    } catch (e) {
      UI.toast('Не удалось удалить: ' + (e && e.message || e), 'err');
    }
  }

  // Подстановка в форму приёма: врач выбирает диагноз из справочника,
  // поля заполняются заготовкой. Уже введённый текст не затираем молча —
  // спрашиваем, иначе легко потерять написанное вручную.
  async function applyDiagnosisTemplate(id) {
    var list = await loadDiagnoses();
    var d = list.find(function (x) { return x.id === id; });
    if (!d) return;

    var fDiag = document.getElementById('f-diagnosis');
    // В форме приёма одно поле «Назначение и рекомендации» — значит и
    // заготовку кладём туда целиком, склеивая обе части справочника.
    var fTreat = document.getElementById('f-treatment');
    var text = [d.treatment, d.recommendations].filter(Boolean).join(String.fromCharCode(10,10));

    if (fTreat && fTreat.value.trim() && text) {
      var ok = await UI.confirm('Заменить текст?',
        'В поле «Назначение и рекомендации» уже есть текст. Заменить его заготовкой из справочника?',
        { yes: 'Заменить', no: 'Оставить' });
      if (!ok) {
        if (fDiag) fDiag.value = d.name; // диагноз всё равно проставим
        return;
      }
    }
    if (fDiag) fDiag.value = d.name;
    if (fTreat && text) fTreat.value = text;
    if (UI._autoGrowAll) UI._autoGrowAll();
    UI.toast('Заготовка подставлена', 'ok');
  }

  // ── Мастер первого запуска ───────────────────────────────────────────────
  // Настройка размазана по вкладкам, и порядок знает только тот, кто
  // разрабатывал. Новой клинике нужен один линейный путь: кто мы → кто
  // принимает → чем лечим. Мастер закрывает ровно это и больше ничего:
  // всё остальное настраивается позже и не мешает начать работать.
  //
  // Показывается сам, если клиника выглядит ненастроенной (нет названия
  // и ни одного сотрудника), и доступен вручную из «Настройки → Клиника».

  var _wizStep = 1;
  var _wizTotal = 3;

  async function setupNeeded() {
    try {
      var st = await loadClinicSettings();
      if (st && st.setup_done) return false;
      var staff = await window.VetDB.getAll('staff');
      var active = (staff || []).filter(function (s) { return !s.is_deleted; });
      // Признак свежей установки: некому принимать и клиника без имени.
      return !(st && st.name) && !active.length;
    } catch (e) {
      return false; // не смогли определить — не навязываемся
    }
  }

  async function maybeRunSetupWizard() {
    if (await setupNeeded()) startSetupWizard();
  }

  function startSetupWizard() {
    _wizStep = 1;
    renderWizard();
  }

  function wizardHeader() {
    var dots = '';
    for (var i = 1; i <= _wizTotal; i++) {
      dots += '<span style="width:26px;height:4px;border-radius:2px;background:'
            + (i <= _wizStep ? 'var(--accent)' : 'var(--border)') + ';"></span>';
    }
    return '<div style="display:flex;gap:6px;margin-bottom:16px;">' + dots + '</div>'
         + '<div class="text-sm text-muted" style="margin-bottom:14px;">Шаг '
         + _wizStep + ' из ' + _wizTotal + '</div>';
  }

  async function renderWizard() {
    if (_wizStep === 1) return renderWizardClinic();
    if (_wizStep === 2) return renderWizardStaff();
    return renderWizardCatalog();
  }

  async function renderWizardClinic() {
    var st = await loadClinicSettings();
    var hours = function (sel, cur) {
      var o = '';
      for (var h = 0; h <= 23; h++) {
        o += '<option value="' + h + '"' + (h === cur ? ' selected' : '') + '>'
           + String(h).padStart(2, '0') + ':00</option>';
      }
      return o;
    };
    UI.showModal({
      title: 'Настройка клиники',
      size: 'lg',
      bodyHTML: wizardHeader()
        + '<div class="form-grid form-stack">'
        + '<div class="form-group"><label class="form-label">Название клиники<span class="form-req">*</span></label>'
        + '<input id="wiz-name" class="form-input" value="' + esc(st.name || '') + '" placeholder="Ветклиника «Айболит»"></div>'
        + '<div class="form-group"><label class="form-label">Телефон</label>'
        + '<input id="wiz-phone" class="form-input" value="' + esc(st.phone || '') + '" placeholder="+7 ..."></div>'
        + '<div class="form-group"><label class="form-label">Адрес</label>'
        + '<input id="wiz-address" class="form-input" value="' + esc(st.address || '') + '"></div>'
        + '<div style="display:flex;gap:12px;">'
        + '<div class="form-group" style="flex:1;"><label class="form-label">Начало приёма</label>'
        + '<select id="wiz-start" class="form-select">' + hours('start', st.sched_start != null ? st.sched_start : 8) + '</select></div>'
        + '<div class="form-group" style="flex:1;"><label class="form-label">Конец приёма</label>'
        + '<select id="wiz-end" class="form-select">' + hours('end', st.sched_end != null ? st.sched_end : 20) + '</select></div>'
        + '</div></div>'
        + '<div class="text-sm text-muted" style="margin-top:12px;">Название попадёт в печатные формы и справки.</div>',
      saveLabel: 'Далее',
      cancelLabel: 'Позже',
      onSave: async function () {
        var name = (document.getElementById('wiz-name') || {}).value || '';
        if (!name.trim()) {
          UI.markInvalid(['wiz-name']);
          UI.toast('Укажите название клиники', 'err');
          return;
        }
        var s = parseInt((document.getElementById('wiz-start') || {}).value, 10);
        var e = parseInt((document.getElementById('wiz-end') || {}).value, 10);
        if (e <= s) { UI.toast('Конец приёма должен быть позже начала', 'err'); return; }
        var prev = await loadClinicSettings();
        prev.name = name.trim();
        prev.phone = (document.getElementById('wiz-phone') || {}).value.trim();
        prev.address = (document.getElementById('wiz-address') || {}).value.trim();
        prev.sched_start = s; prev.sched_end = e;
        await saveClinicSettings(prev);
        _wizStep = 2;
        renderWizard();
      }
    });
  }

  async function renderWizardStaff() {
    var staff = [];
    try { staff = (await window.VetDB.getAll('staff')).filter(function (s) { return !s.is_deleted; }); } catch (e) {}
    var list = staff.length
      ? '<div style="margin-bottom:12px;">' + staff.map(function (s) {
          return '<div class="erow flush-x"><div class="erow-body">'
               + '<div class="erow-title">' + esc(s.name) + '</div>'
               + '<div class="erow-sub">' + esc(ROLE_LABELS[s.role] || s.role || '') + '</div></div></div>';
        }).join('') + '</div>'
      : '';

    var roleOpts = Object.keys(ROLE_LABELS).map(function (k) {
      return '<option value="' + k + '"' + (k === 'vet' ? ' selected' : '') + '>' + esc(ROLE_LABELS[k]) + '</option>';
    }).join('');

    UI.showModal({
      title: 'Кто принимает',
      size: 'lg',
      bodyHTML: wizardHeader() + list
        + '<div class="form-stack">'
        + '<div class="form-group"><label class="form-label">ФИО сотрудника</label>'
        + '<input id="wiz-staff-name" class="form-input" placeholder="Иванов Иван"></div>'
        + '<div class="form-group"><label class="form-label">Должность</label>'
        + '<select id="wiz-staff-role" class="form-select">' + roleOpts + '</select></div>'
        + '</div>'
        + '<div class="text-sm text-muted" style="margin-top:12px;">'
        + 'Врач нужен, чтобы приёмы попадали в отчёт по врачам и в расписание. '
        + 'Остальных добавите позже в «Персонале».</div>',
      saveLabel: staff.length ? 'Далее' : 'Добавить и далее',
      cancelLabel: 'Пропустить',
      onSave: async function () {
        var nm = (document.getElementById('wiz-staff-name') || {}).value.trim();
        if (nm) {
          try {
            await api('POST', '/staff', {
              name: nm,
              role: (document.getElementById('wiz-staff-role') || {}).value || 'vet',
              is_active: true
            });
          } catch (e) {
            UI.toast('Не удалось добавить сотрудника: ' + (e && e.message || e), 'err');
            return;
          }
        } else if (!staff.length) {
          UI.markInvalid(['wiz-staff-name']);
          UI.toast('Добавьте хотя бы одного сотрудника или нажмите «Пропустить»', 'err');
          return;
        }
        _wizStep = 3;
        renderWizard();
      },
      onCancel: function () { _wizStep = 3; renderWizard(); }
    });
  }

  async function renderWizardCatalog() {
    var items = [];
    try { items = (await window.VetDB.getAll('items')).filter(function (i) { return !i.is_deleted; }); } catch (e) {}

    UI.showModal({
      title: 'Услуги и препараты',
      size: 'lg',
      bodyHTML: wizardHeader()
        + (items.length
            ? '<div style="color:var(--accent);font-weight:700;margin-bottom:10px;">В каталоге уже '
              + items.length + ' позиций — этот шаг можно пропустить.</div>'
            : '')
        + '<p style="color:var(--text-2);margin-bottom:14px;">'
        + 'Каталог — это то, из чего складывается сумма приёма. Загрузите свой '
        + 'прайс из Excel: скачайте шаблон, заполните и выберите файл.</p>'
        + '<div style="display:flex;gap:10px;flex-wrap:wrap;">'
        + '<button class="btn btn-ghost btn-sm" data-act="items.template">Скачать шаблон</button>'
        + '<label class="btn btn-primary btn-sm" style="cursor:pointer;">Выбрать файл…'
        + '<input type="file" accept=".xlsx,.xls" style="display:none;" '
        + 'data-act="items.import" data-act-on="change"></label>'
        + '</div>',
      saveLabel: 'Готово',
      cancelLabel: 'Позже',
      onSave: async function () { await finishWizard(); },
      onCancel: async function () { await finishWizard(); }
    });
  }

  async function finishWizard() {
    try {
      var st = await loadClinicSettings();
      st.setup_done = true;               // больше не показываем автоматически
      await saveClinicSettings(st);
    } catch (e) {
      if (window.VetLog) window.VetLog.warn('wizard:finish', e);
    }
    UI.hideModal();
    UI.toast('Клиника настроена', 'ok');
    window.dispatchEvent(new Event('vetdata:changed'));
    if (typeof navigate === 'function') navigate('dashboard');
  }

  // ── Импорт клиентской базы (владельцы + животные) ────────────────────────
  // Условие входа для новой клиники: у неё уже есть сотни карточек в Excel,
  // и вручную их никто вбивать не станет. Формат — одна строка на животное,
  // владелец повторяется; так выглядят почти все выгрузки и просто ведённые
  // таблицы. Владельцы дедуплицируются по телефону — и внутри файла,
  // и против тех, кто уже есть в базе.
  //
  // Импорт двухшаговый: сначала разбор и предпросмотр с проблемными строками,
  // и только потом запись. Заливать сотни строк вслепую нельзя — ошибку
  // потом придётся вычищать руками.

  var IMPORT_COLS = ['ФИО владельца', 'Телефон', 'ИИН', 'Адрес',
                     'Кличка', 'Вид', 'Пол (м/ж)', 'Порода', 'Дата рождения', '№ чипа'];

  function downloadClientsTemplate() {
    if (typeof XLSX === 'undefined') { UI.toast('Библиотека XLSX не загружена', 'err'); return; }
    var rows = [
      IMPORT_COLS,
      ['Ахметова Динара', '+7 701 111 2233', '', 'Алматы, Абая 10', 'Мурзик', 'кошка', 'м', 'британская', '2021-05-14', ''],
      ['Ахметова Динара', '+7 701 111 2233', '', '', 'Белла', 'собака', 'ж', '', '', '643094100123456'],
      ['Сергеев Валентин', '+7 702 222 3344', '', '', 'Рекс', 'собака', 'м', 'овчарка', '', '']
    ];
    var ws = XLSX.utils.aoa_to_sheet(rows);
    ws['!cols'] = IMPORT_COLS.map(function(){ return {wch: 20}; });
    var wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb, ws, 'Клиенты');
    XLSX.writeFile(wb, 'clients_template.xlsx');
  }

  // Телефон — ключ дедупликации, поэтому сводим к цифрам с кодом страны 7.
  function importPhoneKey(v) {
    var d = String(v == null ? '' : v).replace(/\D/g, '');
    if (d.length === 11 && (d[0] === '8' || d[0] === '7')) d = '7' + d.slice(1);
    if (d.length === 10) d = '7' + d;
    return d;
  }

  var PET_TYPE_SYNONYMS = {
    'кот':'кошка','кошка':'кошка','кошки':'кошка','cat':'кошка',
    'пёс':'собака','пес':'собака','собака':'собака','dog':'собака',
    'попугай':'попугай','птица':'птица','кролик':'кролик','хомяк':'хомяк',
    'черепаха':'черепаха','морская свинка':'морская свинка',
    'шиншилла':'шиншилла','хорёк':'хорёк','хорек':'хорёк'
  };

  function importPetType(v) {
    var t = String(v == null ? '' : v).trim().toLowerCase();
    return PET_TYPE_SYNONYMS[t] || 'другое';
  }

  function importGender(v) {
    var g = String(v == null ? '' : v).trim().toLowerCase();
    if (g === 'ж' || g === 'f' || g === 'самка' || g === 'девочка') return 'f';
    return 'm'; // по умолчанию — сервер требует строго m или f
  }

  // Дата из Excel приходит либо строкой, либо числом (серийная дата).
  function importDate(v) {
    if (v == null || v === '') return '';
    if (typeof v === 'number' && typeof XLSX !== 'undefined' && XLSX.SSF) {
      var d = XLSX.SSF.parse_date_code(v);
      if (d) return d.y + '-' + String(d.m).padStart(2,'0') + '-' + String(d.d).padStart(2,'0');
    }
    var s = String(v).trim();
    var m = s.match(/^(\d{2})[.\/](\d{2})[.\/](\d{4})$/); // 14.05.2021
    if (m) return m[3] + '-' + m[2] + '-' + m[1];
    return /^\d{4}-\d{2}-\d{2}/.test(s) ? s.slice(0,10) : '';
  }

  var _importPlan = null; // разобранный файл, ждёт подтверждения

  async function importClientsExcel(input) {
    if (!input.files || !input.files[0]) return;
    if (typeof XLSX === 'undefined') { UI.toast('Библиотека XLSX не загружена', 'err'); return; }
    var file = input.files[0];
    input.value = '';
    var reader = new FileReader();
    reader.onload = async function (e) {
      try {
        var wb = XLSX.read(new Uint8Array(e.target.result), { type: 'array' });
        var ws = wb.Sheets[wb.SheetNames[0]];
        var rows = XLSX.utils.sheet_to_json(ws, { header: 1, defval: '' });
        await buildImportPlan(rows);
      } catch (err) {
        if (window.VetLog) window.VetLog.warn('import:read', err);
        UI.toast('Не удалось прочитать файл: ' + (err && err.message || err), 'err');
      }
    };
    reader.readAsArrayBuffer(file);
  }

  async function buildImportPlan(rows) {
    var existing = [];
    try { existing = await window.VetDB.getAll('owners'); } catch (e) {}
    var byPhone = {};
    (existing || []).forEach(function (o) {
      if (o.is_deleted) return;
      var k = importPhoneKey(o.phone);
      if (k) byPhone[k] = o;
    });

    var plan = { owners: [], pets: [], problems: [], matched: 0 };
    var newByPhone = {};

    for (var i = 1; i < rows.length; i++) {
      var r = rows[i] || [];
      var fio = String(r[0] || '').trim();
      var phoneRaw = r[1];
      var key = importPhoneKey(phoneRaw);
      var petName = String(r[4] || '').trim();

      if (!fio && !petName) continue; // пустая строка — молча пропускаем
      if (!fio) { plan.problems.push('Строка ' + (i + 1) + ': нет ФИО владельца'); continue; }
      if (!key || key.length < 11) {
        plan.problems.push('Строка ' + (i + 1) + ': телефон «' + String(phoneRaw || '') + '» непохож на номер');
        continue;
      }

      var ownerRef;
      if (byPhone[key]) {
        ownerRef = { existingId: byPhone[key].id };
        plan.matched++;
      } else if (newByPhone[key] !== undefined) {
        ownerRef = { newIndex: newByPhone[key] };
      } else {
        newByPhone[key] = plan.owners.length;
        ownerRef = { newIndex: plan.owners.length };
        plan.owners.push({
          fio: fio, phone: String(phoneRaw || '').trim(),
          iin: String(r[2] || '').replace(/\D/g, ''), address: String(r[3] || '').trim()
        });
      }

      if (petName) {
        plan.pets.push({
          owner: ownerRef, name: petName,
          type: importPetType(r[5]), gender: importGender(r[6]),
          breed: String(r[7] || '').trim(), birth_date: importDate(r[8]),
          chip_number: String(r[9] || '').trim().replace(/\s/g, '')
        });
      }
    }

    _importPlan = plan;
    showImportPreview(plan);
  }

  function showImportPreview(plan) {
    var body =
      '<div style="margin-bottom:14px;">'
      + '<div style="font-size:var(--fs-lg);font-weight:700;margin-bottom:6px;">Будет создано</div>'
      + '<div>Владельцев: <b>' + plan.owners.length + '</b></div>'
      + '<div>Животных: <b>' + plan.pets.length + '</b></div>'
      + (plan.matched ? '<div class="text-muted" style="margin-top:6px;">Совпало с существующими по телефону: '
          + plan.matched + ' — новые карточки для них не создаются, животные привяжутся к ним.</div>' : '')
      + '</div>';

    if (plan.problems.length) {
      body += '<div style="border-top:1px solid var(--border);padding-top:12px;">'
        + '<div style="font-weight:700;color:var(--danger);margin-bottom:6px;">'
        + 'Пропущено строк: ' + plan.problems.length + '</div>'
        + '<div style="max-height:160px;overflow:auto;font-size:var(--fs-sm);color:var(--text-2);">'
        + plan.problems.slice(0, 30).map(function (p) { return '<div>' + esc(p) + '</div>'; }).join('')
        + (plan.problems.length > 30 ? '<div>…и ещё ' + (plan.problems.length - 30) + '</div>' : '')
        + '</div></div>';
    }

    if (!plan.owners.length && !plan.pets.length) {
      body += '<div style="margin-top:12px;color:var(--danger);">Импортировать нечего.</div>';
    }

    UI.showModal({
      title: 'Проверьте перед импортом',
      size: 'lg',
      bodyHTML: body,
      saveLabel: (plan.owners.length || plan.pets.length) ? 'Импортировать' : 'Закрыть',
      cancelLabel: 'Отмена',
      onSave: function () {
        if (!plan.owners.length && !plan.pets.length) { UI.hideModal(); return; }
        runImport();
      }
    });
  }

  async function runImport() {
    var plan = _importPlan;
    if (!plan) return;
    var btn = document.getElementById('modal-save-btn');
    if (btn) { btn.disabled = true; btn.textContent = 'Импорт…'; }

    var createdOwners = [], okOwners = 0, okPets = 0, failed = [];

    for (var i = 0; i < plan.owners.length; i++) {
      try {
        var o = await api('POST', '/owners', plan.owners[i]);
        createdOwners[i] = o && o.id ? o.id : null;
        okOwners++;
      } catch (e) {
        createdOwners[i] = null;
        failed.push('Владелец «' + plan.owners[i].fio + '»: ' + (e && e.message || e));
      }
    }

    for (var j = 0; j < plan.pets.length; j++) {
      var p = plan.pets[j];
      var ownerId = p.owner.existingId || createdOwners[p.owner.newIndex];
      if (!ownerId) { failed.push('Животное «' + p.name + '»: владелец не создан'); continue; }
      var payload = { owner_id: ownerId, name: p.name, type: p.type, gender: p.gender };
      if (p.breed) payload.breed = p.breed;
      if (p.birth_date) payload.birth_date = p.birth_date;
      if (p.chip_number) payload.chip_number = p.chip_number;
      try { await api('POST', '/pets', payload); okPets++; }
      catch (e) { failed.push('Животное «' + p.name + '»: ' + (e && e.message || e)); }
    }

    UI.hideModal();
    _importPlan = null;

    // Отчёт показываем всегда: молчаливый импорт не даёт понять, что не доехало.
    var msg = '<div>Создано владельцев: <b>' + okOwners + '</b></div>'
            + '<div>Создано животных: <b>' + okPets + '</b></div>';
    if (failed.length) {
      msg += '<div style="margin-top:12px;color:var(--danger);font-weight:700;">Не удалось: '
           + failed.length + '</div>'
           + '<div style="max-height:180px;overflow:auto;font-size:var(--fs-sm);color:var(--text-2);">'
           + failed.slice(0, 30).map(function (f) { return '<div>' + esc(f) + '</div>'; }).join('')
           + (failed.length > 30 ? '<div>…и ещё ' + (failed.length - 30) + '</div>' : '')
           + '</div>';
    }
    UI.showModal({ title: 'Импорт завершён', bodyHTML: msg, size: 'lg',
                   saveLabel: 'Готово', cancelLabel: 'Закрыть',
                   onSave: function () { UI.hideModal(); } });

    window.dispatchEvent(new Event('vetdata:changed'));
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

  // Переходы с плиток дашборда. Каждый обещает конкретный срез, поэтому
  // задаёт СВОЙ фильтр и снимает всё, что срез сузило бы вопреки обещанию
  // (см. clearSectionSearch). Раздел может быть уже открыт — тогда navigate
  // выходит рано и init не зовётся, поэтому применяем и сами: иначе плитка
  // на своей же странице не делала бы ничего.
  function goVisitsToday() {
    var already = document.getElementById('page-visits').classList.contains('active');
    _pendingVisitFilter  = 'today';
    _visitDoctorFilter   = '';   // плитка считает всех врачей, а не выбранного
    _visitRenderLimit    = 60;
    clearSectionSearch('search-visits');
    var docSel = document.getElementById('visit-doctor-filter');
    if (docSel) docSel.value = '';
    navigate('visits');
    if (already) {
      _visitDateFilter = _pendingVisitFilter; _pendingVisitFilter = null;
      syncVisitPeriodButtons();
      renderVisitList();
    }
  }

  function goVaccThisWeek() {
    var already = document.getElementById('page-vaccinations').classList.contains('active');
    // Ставим фильтр до перехода: initVaccinations заберёт его при инициализации.
    _pendingVaccFilter = 'week';
    clearSectionSearch('search-vaccinations');
    navigate('vaccinations');
    if (already) {
      _vaccDateFilter = _pendingVaccFilter; _pendingVaccFilter = null;
      syncVaccDateButtons();
      renderVaccinationList();
    }
  }

  // Переход к списку животных с активным курсом лечения — фильтр «На лечении».
  // Раньше значение выставлялось через setTimeout(250): гонка с initPets,
  // который ждёт три запроса и мог отрисовать список уже после. Теперь состояние
  // задаётся синхронно, а рисует его init (или мы сами, если раздел уже открыт).
  function goOnTreatment() {
    var already = document.getElementById('page-pets').classList.contains('active');
    _petStatusFilter = 'on-treatment';
    _petsLimit = 60;
    clearSectionSearch('search-pets');
    var f = document.getElementById('filter-pet-status');
    if (f) f.value = 'on-treatment';
    var owf = document.getElementById('filter-owner-id');
    if (owf) owf.value = '';
    navigate('pets');
    if (already) renderPetList();
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
    { v: 'warehouse', l: 'Склад (продавец)' },
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

  // Короткая сводка прав в списке: раньше настройку было видно, только открыв
  // каждого пользователя, и «почему регистратура правит цены» выяснялось
  // перебором. Показываем то, что отличается от полного доступа.
  function permSummary(u) {
    if (u.role === 'admin') return '<span class="perm-chip perm-chip-all">полный доступ</span>';
    var p = u.permissions || {};
    var t = p.tables || {};
    var chips = [];
    if (!p.tables) {
      // Пустые права = полный доступ (см. tableLevel на сервере). Это легко
      // проглядеть при заведении пользователя, поэтому говорим прямо.
      chips.push('<span class="perm-chip perm-chip-warn">права не настроены — доступ ко всему</span>');
    } else {
      var closed = PERM_TABLES.filter(function (x) { return t[x.v] === 'none'; }).map(function (x) { return x.l; });
      var ro     = PERM_TABLES.filter(function (x) { return t[x.v] === 'view'; }).map(function (x) { return x.l; });
      if (closed.length) chips.push('<span class="perm-chip perm-chip-off">закрыто: '+esc(closed.join(', '))+'</span>');
      if (ro.length)     chips.push('<span class="perm-chip">только чтение: '+esc(ro.join(', '))+'</span>');
      if (!closed.length && !ro.length) chips.push('<span class="perm-chip perm-chip-all">полный доступ</span>');
    }
    if (p.sums === 'own')      chips.push('<span class="perm-chip">суммы: свои</span>');
    if (p.sums === 'selected') chips.push('<span class="perm-chip">суммы: выбранных врачей</span>');
    if (p.portal_codes)        chips.push('<span class="perm-chip">выдаёт пароли в кабинет</span>');
    return chips.join(' ');
  }

  function renderUserList() {
    var el = document.getElementById('users-list');
    if (!el) return;
    if (!_users.length) { el.innerHTML = emptyState('Пользователей нет'); return; }
    el.innerHTML = _users.map(function(u) {
      return '<div class="erow" data-act="user.edit" data-id="'+u.id+'">'
        + UI.avatar(u.display_name, 'staff')
        + '<div class="erow-body">'
        + '<div class="erow-title">'+esc(u.display_name)
        + (u.is_active?'':' <span class="badge badge-inactive">Отключён</span>')+'</div>'
        + '<div class="erow-sub">'+esc(u.login)+' · '+esc(userRoleLabel(u.role))+'</div>'
        + '<div class="erow-sub perm-summary">'+permSummary(u)+'</div>'
        + '</div>'
        + '<div class="erow-right"><div class="erow-actions">'
        + '<button class="btn btn-icon" data-act="user.edit" data-id="'+u.id+'" title="Редактировать" aria-label="Редактировать">'+UI.icon('edit','')+'</button>'
        + '</div></div></div>';
    }).join('');
  }

  async function userFormHTML(u) {
    u = u || {};
    var staff = [];
    try { staff = (await window.VetDB.getAll('staff')).filter(function(s){ return !s.is_deleted && s.is_active; }); } catch(e) { window.VetLog.warn('staff:active', e); }
    return '<div class="form-grid">'
      + '<div class="form-group"><label class="form-label">Логин <span class="form-req">*</span></label>'
      + '<input id="fu-login" class="form-input" autocapitalize="none" value="'+esc(u.login||'')+'" placeholder="ivanov"></div>'
      + '<div class="form-group"><label class="form-label">Имя <span class="form-req">*</span></label>'
      + '<input id="fu-name" class="form-input" value="'+esc(u.display_name||'')+'" placeholder="Иванов Иван"></div>'
      + '<div class="form-group"><label class="form-label">Роль <span class="form-req">*</span></label>'
      + '<select id="fu-role" class="form-select" data-act="user.roleChange" data-act-on="change">'
      + USER_ROLES.map(function(r){ return '<option value="'+r.v+'"'+(r.v===(u.role||'doctor')?' selected':'')+'>'+r.l+'</option>'; }).join('')
      + '</select></div>'
      + '<div class="form-group"><label class="form-label">'+(u.id?'Новый пароль (пусто — не менять)':'Пароль <span class="form-req">*</span>')+'</label>'
      + '<input id="fu-password" class="form-input" type="password" autocomplete="new-password" placeholder="минимум 6 символов"></div>'
      + '<div class="form-group form-span-2"><label class="form-label">Сотрудник клиники'+UI.hint('Связь нужна, чтобы показывать «свои» суммы и авторство записей. Пользователь не обязан быть врачом: админ и регистратор — тоже пользователи.')+'</label>'
      + '<select id="fu-staff" class="form-select" data-act="user.staffChange" data-act-on="change"><option value="">— не связан —</option>'
      + staff.map(function(st){ return '<option value="'+st.id+'"'+(st.id===u.staff_id?' selected':'')+'>'+esc(st.name)+'</option>'; }).join('')
      + '</select>'
      + '</div>'
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
    { v: 'visits',       l: 'Приёмы',      hint: 'вложения, шаблоны диагнозов и результаты анализов — здесь же' },
    { v: 'appointments', l: 'Расписание',  hint: 'запись клиентов; не даёт доступа к медицинской части' },
    { v: 'owners',       l: 'Владельцы',   hint: '' },
    { v: 'pets',         l: 'Животные',    hint: '' },
    { v: 'vaccinations', l: 'Вакцинации',  hint: '' },
    { v: 'items',        l: 'Каталог',     hint: 'услуги и препараты, цены' },
    { v: 'staff',        l: 'Персонал',    hint: '' },
    // Глобальная настройка клиники, а не данные приёма: шаблоны протоколов и
    // заготовки диагнозов задают, что и как заполняют ВСЕ врачи. Поэтому
    // отдельная строка прав, а не право на приёмы или каталог.
    { v: 'templates',    l: 'Справочники', hint: 'шаблоны протоколов и заготовки диагнозов — общие для всей клиники; читать их нужно всем, ограничивается правка' },
  ];

  // Типовые наборы прав. Роль сама по себе ничего не ограничивала: врач и
  // регистратура получали полный доступ ко всему, пока администратор вручную
  // не выставит семь списков. Пресет — отправная точка, дальше можно править.
  //
  // Администратора здесь нет намеренно: у него доступ всюду по определению
  // (см. tableLevel), и блок прав для него скрыт.
  var ROLE_PRESETS = {
    doctor: {
      title: 'Врач',
      note: 'Ведёт приёмы и медкарты. Каталог и персонал — только смотрит, суммы видит свои.',
      tables: { visits:'edit', appointments:'edit', owners:'edit', pets:'edit',
                vaccinations:'edit', items:'view', staff:'view',
                // Врач ведёт справочники: он ими и пользуется каждый день.
                // Не «потому что может», а потому что заготовку лечения
                // осмысленно правит тот, кто её применяет.
                templates:'edit' },
      sums: 'own', portal_codes: false
    },
    reception: {
      title: 'Регистратура',
      note: 'Записывает и заводит клиентов. Медкарты видит, но не правит. Выдаёт пароли в кабинет владельца.',
      tables: { visits:'view', appointments:'edit', owners:'edit', pets:'edit',
                vaccinations:'view', items:'view', staff:'view', templates:'view' },
      sums: 'all', portal_codes: true
    },
    warehouse: {
      title: 'Склад',
      note: 'Работает с каталогом и остатками. К медицинской части доступа нет.',
      tables: { visits:'none', appointments:'none', owners:'none', pets:'none',
                vaccinations:'none', items:'edit', staff:'none', templates:'none' },
      sums: 'all', portal_codes: false
    }
  };
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
      return '<div class="perm-row">'
        + '<span class="perm-table">'+t.l+(t.hint ? UI.hint(t.hint) : '')+'</span>'
        + '<select class="form-select perm-select" data-table="'+t.v+'">'
        + PERM_LEVELS.map(function(l){ return '<option value="'+l.v+'"'+(l.v===cur?' selected':'')+'>'+l.l+'</option>'; }).join('')
        + '</select></div>';
    }).join('');

    var staffChecks = staff.map(function(st){
      return '<label class="perm-staff-check"><input type="checkbox" data-act="user.sumsStaffToggle" data-sums-staff="'+st.id+'"'
        + (sumsStaff.indexOf(st.id)>=0?' checked':'')+'> '+esc(st.name)+'</label>';
    }).join('');

    return '<div class="form-group form-span-2" id="fu-perms-block"'+(isAdmin?' style="display:none"':'')+'>'
      + '<div class="perm-head">'
      + '<label class="form-label">Права доступа'
      + UI.hint('«Нет доступа» прячет раздел из меню. Сервер не примет правки сверх этих прав, но данные на устройство синхронизируются целиком.')
      + '</label>'
      + '<button type="button" class="btn btn-ghost btn-sm" data-act="user.preset">Типовые для роли</button>'
      + '</div>'
      + '<div class="perm-grid">'+rows+'</div>'
      + '<div style="margin-top:12px;">'
      + '<label class="form-label">Какие суммы видит</label>'
      + '<select id="fu-sums" class="form-select" data-act="user.sumsChange" data-act-on="change">'
      + '<option value="all"'+(sums==='all'?' selected':'')+'>Все суммы</option>'
      + '<option value="own"'+(sums==='own'?' selected':'')+'>Только свои (нужна связь с сотрудником)</option>'
      + '<option value="selected"'+(sums==='selected'?' selected':'')+'>Суммы выбранных врачей</option>'
      + '</select>'
      + '<div id="fu-sums-staff" class="perm-staff-list" style="'+(sums==='selected'?'':'display:none')+'">'+staffChecks+'</div>'
      + '<div id="fu-sums-warn" class="form-hint perm-warn"></div>'
      + '</div>'
      + '<div style="margin-top:12px;">'
      + '<label class="form-label" style="display:flex;align-items:center;gap:8px;cursor:pointer;">'
      + '<input type="checkbox" id="fu-portal-codes"'+(perms.portal_codes?' checked':'')+' style="width:18px;height:18px;">'
      + ' Может выдавать владельцам пароли для входа в кабинет'
      + UI.hint('Пароль открывает владельцу его медкарты на портале. Обычно право дают регистратуре.') + '</label>'
      + '</div>'

      + '</div>';
  }

  // Подставляет типовой набор для выбранной роли, не трогая остальную форму.
  function applyRolePreset() {
    var role = (document.getElementById('fu-role') || {}).value;
    var preset = ROLE_PRESETS[role];
    if (!preset) {
      UI.toast(role === 'admin'
        ? 'У администратора доступ ко всем разделам — настраивать нечего'
        : 'Для этой роли типового набора нет', 'warn');
      return;
    }
    document.querySelectorAll('.perm-select').forEach(function (sel) {
      var lvl = preset.tables[sel.dataset.table];
      if (lvl) sel.value = lvl;
    });
    var sums = document.getElementById('fu-sums');
    if (sums) { sums.value = preset.sums; sums.dispatchEvent(new Event('change', { bubbles: true })); }
    var pc = document.getElementById('fu-portal-codes');
    if (pc) pc.checked = !!preset.portal_codes;
    checkSumsStaff();
    UI.toast(preset.title + ': ' + preset.note, 'ok', 6000);
  }

  // «Только свои суммы» без связи с сотрудником не работает вовсе: сравнение
  // идёт по staff_id, и при пустой связи не совпадает ничто — человек видит
  // нули вместо выручки. Сервер это отклонит, но сказать надо раньше.
  function checkSumsStaff() {
    var warn = document.getElementById('fu-sums-warn');
    if (!warn) return;
    var sums = (document.getElementById('fu-sums') || {}).value;
    var staff = (document.getElementById('fu-staff') || {}).value;
    if (sums === 'own' && !staff) {
      warn.textContent = 'Выберите сотрудника выше — иначе «свои суммы» не с чем сравнивать и человек не увидит ни одной суммы.';
      warn.style.display = '';
    } else if (sums === 'selected' && !document.querySelector('[data-sums-staff]:checked')) {
      warn.textContent = 'Отметьте хотя бы одного врача — иначе суммы не будет видно вовсе.';
      warn.style.display = '';
    } else {
      warn.textContent = '';
      warn.style.display = 'none';
    }
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
      afterOpen: checkSumsStaff,
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
      afterOpen: checkSumsStaff,
      onSave: async function() {
        var d = userFormData(true);
        try { await api('PUT', '/users/'+id, d); UI.toast('Сохранено', 'ok'); UI.hideModal(); await initUsers(); }
        catch(e) { UI.toast(e.message, 'err', 5000); }
      }
    });
  }

  // ═══════════════════════════════════════════════════════════════════════
  // ЧИПИРОВАНИЕ — вынесено в modules/chips.js (см. window.VetChips).
  // Здесь остался только вызов из диспетчера страниц.
  // ═══════════════════════════════════════════════════════════════════════

  // ═══════════════════════════════════════════════════════════════════════
  // РАСПИСАНИЕ — вынесено в modules/schedule.js (см. window.VetSchedule).
  // ═══════════════════════════════════════════════════════════════════════

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
      // UX-028: у найденного — сразу действие. Самое частое намерение после
      // «нашёл» — начать приём; раньше для этого нужно было открыть карточку.
      // Умершим животным приём не предлагаем.
      function quickBtn(kind, id) {
        return '<button type="button" class="btn btn-ghost btn-sm ac-quick" data-quick="'+kind+'" data-qid="'+id+'"'
             + ' title="Новый приём" aria-label="Новый приём">+ Приём</button>';
      }
      dd.innerHTML =
        ownerHits.map(function(o) {
          return '<div class="ac-item" data-kind="owner" data-id="'+o.id+'">'
            + '<div class="ac-item-main">'
            + '<div class="ac-item-title">'+I('user')+' '+esc(o.fio)+'</div>'
            + '<div class="ac-item-sub">'+esc(o.phone||'')+'</div></div>'
            + quickBtn('owner', o.id) + '</div>';
        }).join('')
        + petHits.map(function(p) {
            var o = ownersMap[p.owner_id] || {};
            return '<div class="ac-item" data-kind="pet" data-id="'+p.id+'">'
              + '<div class="ac-item-main">'
              + '<div class="ac-item-title">'+I('paw')+' '+esc(p.name)+(p.status==='deceased'?' †':'')+'</div>'
              + '<div class="ac-item-sub">'+esc(p.type||'')+(o.fio?' · '+esc(o.fio):'')+'</div></div>'
              + (p.status === 'deceased' ? '' : quickBtn('pet', p.id)) + '</div>';
          }).join('');
      dd.classList.add('show');
      // Быстрое действие: вешаем раньше строки и гасим всплытие, иначе
      // сработает переход в карточку (обработчик строки — на том же mousedown).
      dd.querySelectorAll('.ac-quick').forEach(function(btn) {
        btn.onmousedown = function(e) {
          e.preventDefault(); e.stopPropagation();
          dd.classList.remove('show');
          inp.value = '';
          var id = btn.dataset.qid;
          if (btn.dataset.quick === 'pet') newVisitForPet(id);
          else newVisitForOwner(id);
        };
      });
      dd.querySelectorAll('.ac-item[data-id]').forEach(function(el) {
        el.onmousedown = function(e) { // mousedown — раньше blur, иначе dropdown закроется до клика
          if (e.target.closest && e.target.closest('.ac-quick')) return; // клик по кнопке
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
    });
    // R4: ↑/↓ по результатам, Enter открывает выделенный/первый.
    if (window.VetUI && VetUI.acKeyboard) VetUI.acKeyboard(inp, dd);
    inp.addEventListener('blur', function() { setTimeout(function(){ dd.classList.remove('show'); }, 200); });
  }
  document.addEventListener('DOMContentLoaded', setupGlobalSearch);

  function init(page) {
    var map = {
      'dashboard':        initDashboard,
      'owners':           initOwners,
      'pets':             initPets,
      'visits':           initVisits,
      'schedule':         function(){ return window.VetSchedule && window.VetSchedule.init(); },
      'vaccinations':     initVaccinations,
      'chips':            function(){ return window.VetChips && window.VetChips.init(); },
      'items':            initItems,
      'staff':            initStaff,
      'report-daily':     initReportDaily,
      'report-revenue':   initReportRevenue,
      'report-upcoming':  initReportUpcoming,
      'report-noshows':   initReportNoShows,
      'settings':         initSettings,
      // Склад вынесен в modules/warehouse.js (M3.2) — делегируем.
      'warehouse':        function(){ if (window.VetWarehouse) VetWarehouse.init(); },
    };
    var fn = map[page];
    // Возвращаем результат: у большинства страниц init асинхронный, и
    // вызывающему (авто-обновление в bootstrap.js) нужно дождаться отрисовки,
    // прежде чем возвращать прокрутку на место.
    if (fn) return fn();
  }

  // Флаг модуля: показываем/прячем раздел «Склад». Тянем с сервера (онлайн),
  // кэшируем в localStorage — офлайн берём последнее известное значение.
  // refreshModules читает состояние опциональных модулей (GET /settings/modules)
  // и гейтит навигацию по манифестам VetModules (M3.1). Список флагов и правила
  // гейта — из реестра, ядро их не перечисляет. Кэш в localStorage, чтобы
  // офлайн-загрузка не мигала разделами. Возвращает карту состояний по флагам.
  function _moduleFlags() {
    return (window.VetModules && VetModules.flags()) || ['warehouse', 'portal'];
  }
  async function refreshModules() {
    var states = {};
    _moduleFlags().forEach(function(f){ states[f] = window.VetModules ? VetModules.isDefaultOn(f) : (f === 'portal'); });
    try {
      var base = (window.VetAppConfig && window.VetAppConfig.apiBase) || '';
      var nf = window.__nativeFetch || window.fetch.bind(window);
      var res = await nf(base + '/settings/modules', { headers: { 'X-Auth-Token': (window.VetAuth && VetAuth.token && VetAuth.token()) || '' } });
      var j = await res.json();
      var d = (j && j.data) || {};
      _moduleFlags().forEach(function(f){
        if (f in d) states[f] = !!d[f];
        localStorage.setItem('vet-mod-' + f, states[f] ? '1' : '0');
      });
    } catch(e) {
      _moduleFlags().forEach(function(f){
        var v = localStorage.getItem('vet-mod-' + f);
        states[f] = (window.VetModules && VetModules.isDefaultOn(f)) ? v !== '0' : v === '1';
      });
    }
    applyModuleUI(states);
    return states;
  }
  function applyModuleUI(states) {
    if (window.VetModules) { VetModules.applyNav(states); return; }
    // Фолбэк, если реестр не загрузился: прежнее поведение склад/портал.
    document.body.classList.toggle('mod-warehouse-on', !!states.warehouse);
    var grp = document.getElementById('ssg-warehouse');
    if (grp) grp.style.display = states.warehouse ? '' : 'none';
    document.body.classList.toggle('mod-portal-off', !states.portal);
  }


  // ═══════════════════════════════════════════════════════════════════════
  // PUBLIC API
  // ═══════════════════════════════════════════════════════════════════════

  // Общие хелперы ядра для вынесенных модулей (modules/*, M3.2). Чтобы модуль
  // не дублировал утилиты и не лез в замыкание pages.js.
  window.VetPagesCore = {
    esc: esc, buildMap: buildMap, emptyState: emptyState,
    searchEmpty: searchEmpty, setupSearch: setupSearch, localDateStr: localDateStr,
    // Добавлено при выносе модуля чипирования: помощники, без которых
    // вынесенный код пришлось бы дублировать.
    api: api, I: I, fmtDate: fmtDate, printHTML: printHTML,
    toAstanaStr: toAstanaStr, astanaTodayStr: astanaTodayStr,
    setText: setText, loadClinicSettings: loadClinicSettings,
    loadAll: loadAll, initDashboard: initDashboard, newVisit: newVisit,
    fmtMoney: fmtMoney, fmtQty: fmtQty,
  };

  // ── Действия pages.js для делегата (см. actions.js) ──────────────────
  //
  // Разметка несёт ИМЯ действия и данные, а не код. Отдельный
  // event.stopPropagation() больше не нужен: диспетчер берёт ближайшего
  // предка с data-act, поэтому кнопка внутри кликабельной строки
  // перекрывает действие строки сама собой.

  // Закрыть модалку и выполнить действие, дав ей доиграть анимацию.
  function afterModal(fn) { UI.hideModal(); setTimeout(fn, 150); }
  // Перейти на страницу и выполнить действие, дав ей отрисоваться.
  function afterNav(page, fn) { navigate(page); setTimeout(fn, 200); }

  if (window.VetActions) {
    window.VetActions.register({
      // Заглушка: элемент, который перекрывает действие строки, но сам
      // ничего не делает (ссылка tel: внутри кликабельной строки).
      'noop': function () {},

      'nav.go':       function (el) { navigate(el.dataset.page); },
      'search.reset': function (el) { resetSearch(el.dataset.input); },
      'print.window': function () { window.print(); },

      // Списки: «показать ещё»
      'owners.more': function () { _ownersShowMore(); },
      'pets.more':   function () { _petsShowMore(); },
      'visits.more': function () { _visitsShowMore(); },

      // Создание
      'owner.add': function () { addOwner(); },
      'pet.add':   function () { addPet(); },
      'visit.new': function () { newVisit(); },
      'vacc.add':  function () { addVaccination(); },
      'item.add':  function () { addItem(); },
      'staff.add': function () { addStaff(); },

      // Владелец
      'owner.card':   function (el) { showOwnerCard(el.dataset.id); },
      'owner.edit':   function (el) { editOwner(el.dataset.id); },
      'owner.print':  function (el) { printOwnerCard(el.dataset.id); },
      'owner.delete': function (el) { deleteOwner(el.dataset.id); },
      'owner.call':   function (el) { callOwner(el.dataset.id); },
      'owner.portalCode': function (el) { issuePortalCode(el.dataset.id); },
      'owner.edit.fromModal': function (el) {
        var id = el.dataset.id; afterModal(function () { editOwner(id); });
      },
      'owner.addPet': function (el) {
        var id = el.dataset.id; afterModal(function () { addPetForOwner(id); });
      },
      // У владельца одно активное животное — сразу приём ему, иначе выбор.
      'owner.newVisit': function (el) {
        var pet = el.dataset.pet, owner = el.dataset.owner;
        afterModal(function () { pet ? newVisitForPet(pet) : newVisitForOwner(owner); });
      },

      // Животное
      'pet.card':     function (el) { showPetCard(el.dataset.id); },
      'pet.edit':     function (el) { editPet(el.dataset.id); },
      'pet.delete':   function (el) { deletePet(el.dataset.id); },
      'pet.print':    function (el) { printPetCard(el.dataset.id); },
      'pet.consent':  function (el) { printConsentForm(el.dataset.id); },
      'pet.newVisit': function (el) { newVisitForPet(el.dataset.id); },
      'pet.card.fromModal': function (el) {
        var id = el.dataset.id; afterModal(function () { showPetCard(id); });
      },
      'pet.edit.fromModal': function (el) {
        var id = el.dataset.id; afterModal(function () { editPet(id); });
      },
      'pet.newVisit.fromModal': function (el) {
        var id = el.dataset.id; afterModal(function () { newVisitForPet(id); });
      },
      'pet.newVisit.fromReport': function (el) {
        var id = el.dataset.id; afterNav('visits', function () { newVisitForPet(id); });
      },
      'pet.addVacc': function (el) {
        var id = el.dataset.id; afterModal(function () { addVaccination(id); });
      },
      'pet.deceased': function (el) {
        var id = el.dataset.id; afterModal(function () { markDeceased(id); });
      },

      // Приём
      'visit.edit':   function (el) { editVisit(el.dataset.id); },
      'visit.copy':   function (el) { copyVisit(el.dataset.id); },
      'visit.delete': function (el) { deleteVisit(el.dataset.id); },
      'visit.print':  function (el) { printVisitCard(el.dataset.id); },
      'visit.edit.fromModal': function (el) {
        var id = el.dataset.id; afterModal(function () { editVisit(id); });
      },
      'visit.edit.fromReport': function (el) {
        var id = el.dataset.id; afterNav('visits', function () { editVisit(id); });
      },

      // Вакцинация
      'vacc.edit':   function (el) { editVaccination(el.dataset.id); },
      'vacc.copy':   function (el) { copyVaccination(el.dataset.id); },
      'vacc.delete': function (el) { deleteVaccination(el.dataset.id); },
      'vacc.print':  function (el) { printVaccinationCard(el.dataset.id); },

      // Вложения
      'attach.pick':          function (el) { pickAttachment(el.dataset.visit); },
      'attach.confirmPending': function (el) { confirmPendingAttachments(el.dataset.visit); },
      'attach.cancelPending':  function (el) { cancelPendingAttachments(el.dataset.visit); },
      'attach.dropPending':    function (el) { dropPendingAttachment(el.dataset.visit, el.dataset.idx); },
      'attach.preview':        function (el) { previewAttachment(el.dataset.id, el.dataset.name); },
      'visit.peek':            function (el) { peekVisit(el.dataset.id); },
      'presc.open':            function (el) { openPrescForm(el.dataset.visit, el.dataset.pet); },
      'presc.cancel':          function (el) { cancelPrescForm(el.dataset.visit, el.dataset.pet); },
      'presc.add':             function (el) { addPresc(el.dataset.visit, el.dataset.pet); },
      'presc.dropPending':     function (el) { dropPendingPresc(el.dataset.visit, el.dataset.idx, el.dataset.pet); },
      'presc.stop':            function (el) { stopPresc(el.dataset.id, el.dataset.visit, el.dataset.pet); },
      'pet.allergyEdit':       function (el) { editPetAllergies(el.dataset.id); },
      'result.draftFill':      function (el) { fillResultDraft(el.dataset.row, el.dataset.tpl, el.dataset.name); },
      'pet.timeline':          function (el) { showPetTimeline(el.dataset.id); },
      'tl.filter':             function (el) { setTimelineFilter(el.dataset.kind, el); },
      'task.forPet':           function (el) {
        // visitId проставляем только у сохранённого приёма: у нового id ещё нет.
        var vid = (_curVisitId && !isDraftVisitKey(_curVisitId)) ? _curVisitId : '';
        taskDialog(el.dataset.owner, '', { petId: el.dataset.pet, visitId: vid, petName: el.dataset.name });
      },
      'vacc.inlineOpen':       function (el) { openVaccInline(el.dataset.visit, el.dataset.pet); },
      'vacc.inlineCancel':     function (el) { cancelVaccInline(el.dataset.visit, el.dataset.pet); },
      'vacc.inlineAdd':        function (el) { addVaccInline(el.dataset.visit, el.dataset.pet); },
      'vacc.dropPending':      function (el) { dropPendingVacc(el.dataset.visit, el.dataset.idx, el.dataset.pet); },
      'attach.remove':     function (el) { removeAttachment(el.dataset.id, el.dataset.visit); },
      'attach.dropQueued': function (el) { dropQueuedAttachment(el.dataset.id, el.dataset.visit); },

      // Каталог и персонал
      'item.edit':      function (el) { editItem(el.dataset.id); },
      'item.delete':    function (el) { deleteItem(el.dataset.id); },
      'items.template': function () { downloadItemTemplate(); },
      'items.import':   function (el) { importItemsExcel(el); },
      'staff.card':     function (el) { showStaffCard(el.dataset.id); },
      'staff.edit':     function (el) { editStaff(el.dataset.id); },
      'staff.delete':   function (el) { deleteStaff(el.dataset.id); },

      // Дашборд «Требуют внимания» и задачи
      'appt.edit':     function (el) { window.VetPages && VetPages.editAppt(el.dataset.id); },
      'task.complete': function (el) { completeTask(el.dataset.id); },

      // История животного: вкладки
      'history.tab': function (el) {
        if (window.showHistoryTab) window.showHistoryTab(el.dataset.tab);
      },

      // Форма пользователя: блоки прав зависят от выбранной роли
      'user.edit': function (el) { editUser(el.dataset.id); },
      'user.roleChange': function (el) {
        var b = document.getElementById('fu-perms-block');
        if (b) b.style.display = el.value === 'admin' ? 'none' : '';
      },
      'user.sumsChange': function (el) {
        var b = document.getElementById('fu-sums-staff');
        if (b) b.style.display = el.value === 'selected' ? '' : 'none';
        checkSumsStaff();
      },
      'user.preset':     function () { applyRolePreset(); },
      'user.staffChange': function () { checkSumsStaff(); },
      'user.sumsStaffToggle': function () { checkSumsStaff(); }
    });
  }

  window.VetPages = {
    init:               init,
    goVisitsToday:      goVisitsToday,
    goOnTreatment:      goOnTreatment,
    goVaccThisWeek:     goVaccThisWeek,
    newVisit:           newVisit,
    _visitsShowMore:    _visitsShowMore,
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
    newVisitForPet:     newVisitForPet,
    newVisitForOwner:   newVisitForOwner,
    refreshModules:     refreshModules,
    openReportSettings: openReportSettings,
    // whX-функции склада навешиваются из modules/warehouse.js (M3.2).
    addOwner:           addOwner,
    _ownersShowMore:    _ownersShowMore,
    _petsShowMore:      _petsShowMore,
    editOwner:          editOwner,
    deleteOwner:        deleteOwner,
    showOwnerCard:      showOwnerCard,
    issuePortalCode:    issuePortalCode,
    restoreFromTrash:   restoreFromTrash,
    startSetupWizard:   startSetupWizard,
    taskDialog:         taskDialog,
    completeTask:       completeTask,
    exportReportXlsx:   exportReportXlsx,
    diagnosisDialog:    diagnosisDialog,
    applyDiagnosisTemplate: applyDiagnosisTemplate,
    downloadClientsTemplate: downloadClientsTemplate,
    importClientsExcel: importClientsExcel,
    addPet:             addPet,
    editPet:            editPet,
    deletePet:          deletePet,
    showPetCard:        showPetCard,
    showPetHistory:     showPetHistory,
    showPetTimeline:    showPetTimeline,
    refreshVisitResults: refreshVisitResultsBlock,
    fillResultDraft:    fillResultDraft,
    resultBearingItems: resultBearingItems,
    autoOpenProtocol:   autoOpenProtocol,
    // run(name, el) ждёт ЭЛЕМЕНТ и читает dataset — подсовываем минимальный.
    fillResultById:     function (id) { if (window.VetActions) VetActions.run('result.fill', { dataset: { id: id } }); },
    showNotificationsLog: showNotificationsLog,
    markDeceased:       markDeceased,
    petPhotoInput:      petPhotoInput,
    addPetForOwner:     addPetForOwner,
    callOwner:          callOwner,
    addVaccination:     addVaccination,
    editVaccination:    editVaccination,
    deleteVaccination:  deleteVaccination,
    showStaffCard:      showStaffCard,
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
