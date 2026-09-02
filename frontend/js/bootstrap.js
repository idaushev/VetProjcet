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

  function navigate(page) {
    // Меню закрываем до проверки «та же страница»: клик по логотипу в шапке
    // сайдбара, когда уже открыт «Обзор», иначе оставлял бы меню висеть.
    if (isMobile()) {
      sidebar.classList.remove('open');
      overlay.classList.remove('show');
    }
    if (currentPage === page) return;
    currentPage = page;
    document.querySelectorAll('.page').forEach(function (p) { p.classList.remove('active'); });
    document.querySelectorAll('.nav-item').forEach(function (n) {
      // Пункты склада ведут на одну страницу, но в разные вкладки: подсвечиваем
      // только ту, что открыта сейчас, иначе загорались бы все четыре.
      var isCur = n.dataset.page === page;
      if (isCur && n.dataset.whtab) {
        isCur = n.dataset.whtab === (window.VetPages && VetPages.whCurrentTab ? VetPages.whCurrentTab() : '');
      }
      n.classList.toggle('active', isCur);
      n.setAttribute('aria-current', isCur ? 'page' : 'false');
    });
    var target = document.getElementById('page-' + page);
    if (target) target.classList.add('active');
    // Нижняя панель: если открыт раздел не из трёх быстрых — подсветить «Ещё»,
    // чтобы на планшете было видно «вы где-то в меню», а не «нигде».
    var bnMoreBtn = document.getElementById('bn-more');
    if (bnMoreBtn) bnMoreBtn.classList.toggle('active', ['dashboard','schedule','visits'].indexOf(page) === -1);
    window.history.replaceState(null, '', '#' + page);

    // Initialize page
    if (window.VetPages) VetPages.init(page);

    // Close mobile sidebar
    if (isMobile()) {
      sidebar.classList.remove('open');
      overlay.classList.remove('show');
    }
  }

  // Make navigate global
  window.navigate = navigate;
  window.VetNav   = { go: navigate };

  document.querySelectorAll('.nav-item').forEach(function (link) {
    link.addEventListener('click', function (e) {
      // Пункты без data-page — внешние ссылки (кабинет владельца открывается
      // в новой вкладке). Их отдаём браузеру: не перехватываем и не зовём
      // navigate(undefined), иначе ссылка просто не сработает.
      if (!this.dataset.page) return;
      e.preventDefault();
      navigate(this.dataset.page);
      // Пункты склада дополнительно открывают свою вкладку. Зовём ПОСЛЕ
      // navigate и всегда: если страница уже открыта, navigate выходит рано
      // (currentPage === page), и вкладка сама бы не переключилась.
      if (this.dataset.whtab && window.VetPages && VetPages.whOpenTab) {
        VetPages.whOpenTab(this.dataset.whtab);
      }
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

  // ── Переключение вкладок отчётов ──────────────────────────────────
  function switchReportTab(tab) {
    ['daily','upcoming','noshows'].forEach(function(t) {
      var el = document.getElementById('rtab-' + t);
      var btn = document.querySelector('[data-rtab="'+t+'"]');
      if (el) el.style.display = t === tab ? '' : 'none';
      if (btn) btn.classList.toggle('active', t === tab);
    });
    // Скрываем кнопку печати при смене вкладки
    var pb = document.getElementById('btn-print-report');
    if (pb) pb.style.display = 'none';
    // Инициализируем нужный отчёт
    if (tab === 'upcoming' && window.VetPages) VetPages.generateUpcomingReport();
    if (tab === 'noshows'  && window.VetPages) VetPages.generateNoShowsReport();
  }
  window.switchReportTab = switchReportTab;
  var initialHash = (window.location.hash || '').replace('#', '').split('?')[0];
  if (initialHash && validPages.indexOf(initialHash) !== -1) {
    // Delayed: ждём загрузки VetPages
    setTimeout(function() { navigate(initialHash); }, 0);
  }

  // ── Авто-обновление текущей страницы при изменении данных ──────────
  // Срабатывает после: pull с сервера, bootstrap, любой локальной мутации
  var _refreshTimer = null;
  window.addEventListener('vetdata:changed', function () {
    fillOwnerFilter();
    // Дебаунс 150ms чтобы не перерисовывать при rapid mutations
    clearTimeout(_refreshTimer);
    _refreshTimer = setTimeout(function() {
      if (window.VetPages && currentPage) {
        VetPages.init(currentPage);
      }
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
