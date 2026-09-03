/* bootstrap.js — вынесено из index.html.
 *
 * Инлайновый <script> в странице заставлял CSP держать
 * script-src 'unsafe-inline'. Код не менялся, только переехал.
 */
(function () {
  'use strict';

  // ── Sidebar toggle ─────────────────────────────────────────────────
  var sidebar  = document.getElementById('sidebar');
  var overlay  = document.getElementById('sidebar-overlay');
  var toggleBtn = document.getElementById('sidebar-toggle');
  var isMobile = function() { return window.innerWidth < 900; };

  // Load saved state
  var savedRail = localStorage.getItem('sidebar-rail');
  if (window.innerWidth >= 900 && window.innerWidth < 1100) {
    // Auto-rail for medium tablets
  } else if (savedRail === '1' && window.innerWidth >= 900) {
    sidebar.classList.add('rail');
  }

  toggleBtn.addEventListener('click', function () {
    if (isMobile()) {
      var isOpen = sidebar.classList.toggle('open');
      overlay.classList.toggle('show', isOpen);
      toggleBtn.setAttribute('aria-expanded', isOpen ? 'true' : 'false');
    } else {
      var isRail = sidebar.classList.toggle('rail');
      localStorage.setItem('sidebar-rail', isRail ? '1' : '0');
    }
  });

  overlay.addEventListener('click', function () {
    sidebar.classList.remove('open');
    overlay.classList.remove('show');
  });

  // ── SPA Navigation ─────────────────────────────────────────────────
  var currentPage = 'dashboard';

  // UX-017. Раньше в меню было три разных представления вкладок: склад —
  // четыре пункта на одну страницу (различались data-whtab), настройки —
  // один пункт и вкладки только внутри, отчёты — четыре отдельные страницы.
  // Правило вывести было нельзя: по виду пункта не понять, сменится страница
  // или переключится вкладка, а роутеру приходилось спрашивать у склада, какая
  // вкладка открыта, чтобы не подсветить все четыре сразу.
  //
  // Теперь правило одно: ПУНКТ МЕНЮ = АДРЕС. Вкладка, на которую можно дать
  // ссылку, — это подмаршрут «#страница/вкладка»; вкладка-грань одной задачи
  // (настройки) в адрес и меню не выносится. Роутер про склад ничего не знает:
  // страница сама объявляет свои подмаршруты в VetSubRoutes.
  var currentSub = '';

  // page -> { tabs: [...], def: 'tab', open: fn }. Заполняется страницами
  // (см. modules/warehouse.js). Создаём здесь на случай, если страница
  // загрузилась раньше — порядок подключения скриптов роли играть не должен.
  window.VetSubRoutes = window.VetSubRoutes || {};

  function parseRoute(hash) {
    var raw = (hash || '').replace('#', '').split('?')[0];
    var i = raw.indexOf('/');
    return i === -1 ? { page: raw, sub: '' }
                    : { page: raw.slice(0, i), sub: raw.slice(i + 1) };
  }

  // Приводит подмаршрут к допустимому: адрес правится руками и приходит из
  // старых закладок, поэтому мусор молча заменяем вкладкой по умолчанию,
  // а не показываем пустую страницу.
  function resolveSub(page, sub) {
    var d = window.VetSubRoutes[page];
    if (!d) return '';
    return d.tabs.indexOf(sub) !== -1 ? sub : d.def;
  }

  // UX-015. Раньше переход писался через replaceState — история не копилась,
  // и «назад» уводил из приложения, а в установленной PWA закрывал его. Теперь
  // переход добавляет запись (pushState), а popstate возвращает раздел.
  // fromHistory=true — мы уже внутри popstate, повторно писать историю нельзя.
  function navigate(page, fromHistory, sub) {
    // Меню закрываем до проверки «та же страница»: клик по логотипу в шапке
    // сайдбара, когда уже открыт «Обзор», иначе оставлял бы меню висеть.
    if (isMobile()) {
      sidebar.classList.remove('open');
      overlay.classList.remove('show');
    }
    sub = resolveSub(page, sub || '');
    if (currentPage === page && currentSub === sub) return;
    // Смена одной вкладки не должна перерисовывать страницу заново: init
    // сбросил бы фильтры и прокрутку раздела.
    var pageChanged = currentPage !== page;
    currentPage = page;
    currentSub  = sub;
    document.querySelectorAll('.page').forEach(function (p) { p.classList.remove('active'); });
    document.querySelectorAll('.nav-item').forEach(function (n) {
      // Пункт с подмаршрутом активен, только когда открыт именно он: иначе на
      // складе загорелись бы сразу все вкладки. Правило общее, без имён страниц.
      var isCur = n.dataset.page === page
               && (!n.dataset.subroute || n.dataset.subroute === sub);
      n.classList.toggle('active', isCur);
      n.setAttribute('aria-current', isCur ? 'page' : 'false');
    });
    var target = document.getElementById('page-' + page);
    if (target) target.classList.add('active');
    // Нижняя панель: если открыт раздел не из трёх быстрых — подсветить «Ещё»,
    // чтобы на планшете было видно «вы где-то в меню», а не «нигде».
    // UX-019: состав панели зависит от роли, поэтому список «быстрых» разделов
    // берём из самой панели, а не из зашитого перечня — иначе у регистратора
    // «Ещё» горело бы на открытых «Животных».
    var bnMoreBtn = document.getElementById('bn-more');
    if (bnMoreBtn) {
      var quick = [];
      document.querySelectorAll('#bottom-nav .bn-item[data-page]').forEach(function (a) {
        if (a.style.display !== 'none') quick.push(a.dataset.page);
      });
      bnMoreBtn.classList.toggle('active', quick.indexOf(page) === -1);
    }
    var hash = '#' + page + (sub ? '/' + sub : '');
    if (fromHistory) {
      // Пришли из popstate: адрес уже правильный, запись в истории есть.
      window.history.replaceState({ vetPage: page, vetSub: sub }, '', hash);
    } else {
      window.history.pushState({ vetPage: page, vetSub: sub }, '', hash);
    }

    // Initialize page
    if (window.VetPages && pageChanged) VetPages.init(page);
    // Вкладку открываем всегда: страница могла быть уже отрисована, и тогда
    // init не звали, а вкладка смениться должна.
    var sr = window.VetSubRoutes[page];
    if (sub && sr && sr.open) sr.open(sub);

    // Close mobile sidebar
    if (isMobile()) {
      sidebar.classList.remove('open');
      overlay.classList.remove('show');
    }
  }

  // Make navigate global
  window.navigate = navigate;
  window.VetNav   = { go: navigate };

  // UX-015. «Назад»:
  //   1) открыта модалка — закрываем её, раздел не трогаем (иначе жест «назад»
  //      уносил бы сразу и форму, и страницу);
  //   2) иначе — возвращаем предыдущий раздел.
  // Если форма грязная, requestHideModal спросит; при отказе возвращаем запись
  // модалки в историю, чтобы следующий «назад» снова вёл к ней, а не мимо.
  window.addEventListener('popstate', function (e) {
    // F2: закрытие верхней модалки стека само снимает свою запись истории.
    // Пришедший от этого popstate — не действие пользователя, и обрабатывать
    // его нельзя: иначе один возврат закрыл бы и нижнюю модалку тоже.
    if (window.VetUI && VetUI.consumeSelfBack && VetUI.consumeSelfBack()) return;
    var ov = document.getElementById('modal-overlay');
    if (ov && ov.classList.contains('open')) {
      if (window.VetUI && VetUI.requestHideModal) {
        Promise.resolve(VetUI.requestHideModal()).then(function () {
          if (ov.classList.contains('open')) {
            // Пользователь остался в форме — восстанавливаем запись истории.
            window.history.pushState({ vetModal: true }, '', window.location.hash);
          }
        });
      } else if (window.VetUI && VetUI.hideModal) {
        VetUI.hideModal();
      }
      return;
    }
    var r = parseRoute(window.location.hash);
    var page = (e.state && e.state.vetPage) || r.page || 'dashboard';
    var sub  = (e.state && typeof e.state.vetSub === 'string') ? e.state.vetSub : r.sub;
    if (validPages.indexOf(page) === -1) { page = 'dashboard'; sub = ''; }
    navigate(page, true, sub);
  });

  document.querySelectorAll('.nav-item').forEach(function (link) {
    link.addEventListener('click', function (e) {
      // Пункты без data-page — внешние ссылки (кабинет владельца открывается
      // в новой вкладке). Их отдаём браузеру: не перехватываем и не зовём
      // navigate(undefined), иначе ссылка просто не сработает.
      if (!this.dataset.page) return;
      e.preventDefault();
      // data-subroute — вкладка внутри страницы; navigate откроет её сам.
      navigate(this.dataset.page, false, this.dataset.subroute || '');
    });
  });

  // ── Нижняя панель: «Поиск» и «Ещё» ────────────────────────────────
  // Разделы (Обзор/Расписание/Приёмы) обрабатывает общий обработчик
  // .nav-item выше — здесь только две кнопки без data-page.
  var bnSearch = document.getElementById('bn-search');
  if (bnSearch) bnSearch.addEventListener('click', function () {
    var input = document.getElementById('global-search');
    if (!input) return;
    input.focus();
    input.scrollIntoView({ block: 'nearest' });
  });

  var bnMore = document.getElementById('bn-more');
  if (bnMore) bnMore.addEventListener('click', function () {
    sidebar.classList.add('open');
    overlay.classList.add('show');
  });

  // Modal close button — через guard: спросит про несохранённые данные
  document.getElementById('modal-close-btn').addEventListener('click', function () {
    if (!window.VetUI) return;
    if (VetUI.requestHideModal) VetUI.requestHideModal(); else VetUI.hideModal();
  });

  // ── Hash navigation ────────────────────────────────────────────────
  // Если запущено через иконку (start_url = "/?pwa=1") — hash пустой → dashboard
  // Если пользователь открыл прямую ссылку с хэшем — навигируем туда
  var validPages = ['dashboard','schedule','owners','pets','visits','vaccinations','items','staff',
                    'chips','report-daily','report-revenue','report-upcoming','report-noshows','settings','warehouse'];

  // ── Сворачиваемые группы сайдбара ──────────────────────────────────
  function toggleSSGroup(id) {
    var g = document.getElementById(id);
    if (!g) return;
    g.classList.toggle('collapsed');
    // Сохраняем состояние
    var states = {};
    try { states = JSON.parse(localStorage.getItem('ss-groups') || '{}'); } catch(e){}
    states[id] = g.classList.contains('collapsed');
    localStorage.setItem('ss-groups', JSON.stringify(states));
  }
  window.toggleSSGroup = toggleSSGroup;

  // Восстанавливаем состояние групп
  (function() {
    var states = {};
    try { states = JSON.parse(localStorage.getItem('ss-groups') || '{}'); } catch(e){}
    Object.keys(states).forEach(function(id) {
      if (states[id]) {
        var g = document.getElementById(id);
        if (g) g.classList.add('collapsed');
      }
    });
  })();

  var initial = parseRoute(window.location.hash);
  var initialHash = initial.page;
  // Стартовая запись истории помечается разделом — иначе первый popstate
  // придёт с пустым state и не знал бы, куда возвращаться.
  try {
    window.history.replaceState(
      { vetPage: initialHash || currentPage, vetSub: initial.sub },
      '', window.location.hash || '#' + currentPage);
  } catch (e) {}
  if (initialHash && validPages.indexOf(initialHash) !== -1) {
    // Delayed: ждём загрузки VetPages. fromHistory=true — это восстановление
    // адреса, а не переход: лишняя запись в истории не нужна.
    setTimeout(function() { navigate(initialHash, true, initial.sub); }, 0);
  }

  // ── Авто-обновление текущей страницы при изменении данных ──────────
  // Срабатывает после: pull с сервера, bootstrap, любой локальной мутации
  var _refreshTimer = null;
  var _refreshPending = false;

  // Форму закрыли — показываем то, что пришло, пока она была открыта.
  window.addEventListener('vetui:modalclosed', function () {
    if (!_refreshPending) return;
    _refreshPending = false;
    window.dispatchEvent(new Event('vetdata:changed'));
  });

  window.addEventListener('vetdata:changed', function () {
    fillOwnerFilter();
    // Дебаунс 150ms чтобы не перерисовывать при rapid mutations
    clearTimeout(_refreshTimer);
    _refreshTimer = setTimeout(function() {
      if (!window.VetPages || !currentPage) return;
      // Под открытой формой не перестраиваем НИЧЕГО. Врач в этот момент
      // заполняет приём: перерисовка списка за спиной модалки не приносит
      // ему пользы, но сбивает прокрутку и подёргивает экран. Отложим до
      // закрытия — тогда он и увидит свежие данные.
      var ov = document.getElementById('modal-overlay');
      if (ov && ov.classList.contains('open')) { _refreshPending = true; return; }
      _refreshPending = false;
      // Перерисовка заменяет innerHTML, и прокрутка сбрасывается в начало.
      // Когда данные пришли с другого планшета, врач не должен терять место,
      // на котором читал. Возвращаем позицию после отрисовки.
      var scroller = document.querySelector('.main') || document.scrollingElement;
      var top = scroller ? scroller.scrollTop : 0;
      var done = VetPages.init(currentPage);
      if (!scroller || top <= 0) return;
      var restore = function () {
        if (scroller.scrollTop !== top) scroller.scrollTop = top;
      };
      // init у страниц асинхронный: ждём его, иначе вернём прокрутку до того,
      // как список отрисуется, и она снова уедет в начало.
      if (done && typeof done.then === 'function') done.then(restore, restore);
      else requestAnimationFrame(restore);
    }, 150);
  });

  function fillOwnerFilter() {
    if (!window.VetDB) return;
    VetDB.getAll('owners').then(function(owners) {
      var sel = document.getElementById('filter-owner-id');
      if (!sel) return;
      var cur = sel.value;
      var opts = owners.filter(function(o){ return !o.is_deleted; })
                       .sort(function(a,b){ return a.fio.localeCompare(b.fio,'ru'); });
      sel.innerHTML = '<option value="">Все владельцы</option>' + opts.map(function(o){
        return '<option value="'+o.id+'"'+(o.id===cur?' selected':'')+'>'+o.fio+'</option>';
      }).join('');
    });
  }

  // ── Сброс локальных данных ─────────────────────────────────────────
  function resetLocalData() {
    var ok = window.confirm(
      'Сбросить все локальные данные этого устройства?\n\n' +
      'Данные на сервере не затронуты. После сброса приложение ' +
      'загрузит актуальные данные с сервера.'
    );
    if (!ok) return;

    // Удаляем IndexedDB
    var dbName = 'VetClinicDB';
    var req = indexedDB.deleteDatabase(dbName);
    req.onsuccess = function() {
      // Очищаем localStorage (last_sync и т.д.)
      localStorage.clear();
      // Перезагружаем страницу — bootstrap сделает полный pull
      window.location.reload();
    };
    req.onerror = function() {
      alert('Не удалось сбросить базу. Попробуйте вручную: DevTools → Application → Storage → Clear site data');
    };
    req.onblocked = function() {
      alert('База занята другой вкладкой. Закройте остальные вкладки приложения и повторите.');
    };
  }

  window.resetLocalData = resetLocalData;

  // ── Действия статической разметки (см. actions.js) ─────────────────
  // Кнопки в index.html раньше несли код в onclick; теперь — имя действия.
  // Функции VetPages зовём через window: bootstrap грузится последним, но
  // модули могут быть отключены, и жёсткая ссылка уронила бы обработчик.
  if (window.VetActions) {
    window.VetActions.register({
      'settings.group':      function (el) { toggleSSGroup(el.dataset.group); },
      'settings.resetLocal': function () { resetLocalData(); },
      'settings.logo':          function (el) { if (window.VetPages) VetPages.handleLogoUpload(el); },
      'settings.logoClear':     function () { if (window.VetPages) VetPages.clearLogo(); },
      'settings.wizard':        function () { if (window.VetPages) VetPages.startSetupWizard(); },
      'settings.notifications': function () { if (window.VetPages) VetPages.showNotificationsLog(); },

      'go.visitsToday': function () { if (window.VetPages) VetPages.goVisitsToday(); },
      'go.onTreatment': function () { if (window.VetPages) VetPages.goOnTreatment(); },
      'go.vaccWeek':    function () { if (window.VetPages) VetPages.goVaccThisWeek(); },

      // Дашборд: перейти к приёмам и сразу открыть форму нового.
      'visit.newFromDashboard': function () {
        if (!window.VetPages) return;
        VetPages.init('visits');
        navigate('visits');
        setTimeout(function () {
          var b = document.getElementById('btn-add-visit');
          if (b) b.click();
        }, 200);
      },

      'report.settings': function () { if (window.VetPages) VetPages.openReportSettings(); },
      'report.xlsx':     function (el) {
        if (window.VetPages) VetPages.exportReportXlsx(el.dataset.content, el.dataset.file);
      },

      'diagnosis.add':    function () { if (window.VetPages) VetPages.diagnosisDialog(); },
      'task.add':         function () { if (window.VetPages) VetPages.taskDialog(); },
      'clients.template': function () { if (window.VetPages) VetPages.downloadClientsTemplate(); },
      'clients.import':   function (el) { if (window.VetPages) VetPages.importClientsExcel(el); }
    });
  }

  // ── Init ────────────────────────────────────────────────────────────
  document.addEventListener('DOMContentLoaded', function () {
    // Всегда инициализируем dashboard первым (данные могут ещё грузиться)
    if (window.VetPages) {
      VetPages.init('dashboard');
    }
    fillOwnerFilter();
  });

}());
