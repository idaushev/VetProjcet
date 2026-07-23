(function () {
  "use strict";

  // Сохраняем оригинальный fetch до перехвата
  window.__nativeFetch = window.fetch.bind(window);

  window.VetAppConfig = {
    apiBase: window.location.protocol === "file:" ? "http://localhost:8080" : ""
  };

  // ─── Маршрутизация локальных запросов ─────────────────────────────────────

  const STORE_MAP = {
    "/items":        "items",
    "/owners":       "owners",
    "/pets":         "pets",
    "/visits":       "visits",
    "/visit-items":  "visit_items",
    "/vaccinations": "vaccinations",
    "/staff":        "staff",
    "/appointments": "appointments"
  };

  // ─── In-memory кэш (сбрасывается после sync) ──────────────────────────────

  var _cache = {};
  Object.keys(STORE_MAP).forEach(function (p) { _cache[STORE_MAP[p]] = null; });

  async function ensureLoaded(storeName) {
    if (_cache[storeName]) return _cache[storeName];
    _cache[storeName] = await window.VetDB.getAll(storeName);
    return _cache[storeName];
  }

  async function refreshStore(storeName) {
    _cache[storeName] = await window.VetDB.getAll(storeName);
    return _cache[storeName];
  }

  function invalidateCache(storeName) {
    _cache[storeName] = null;
    if (storeName === "owners") { _cache["pets"] = null; }
    if (storeName === "pets")   { _cache["visits"] = null; _cache["vaccinations"] = null; }
    if (storeName === "visits") { _cache["visit_items"] = null; }
  }

  function emitChange(storeName) {
    window.dispatchEvent(new CustomEvent("vetdata:changed", { detail: { store: storeName } }));
  }

  // Инвалидация кэша из sync.js (вызывается при hardDelete удалённых записей)
  window._syncCacheInvalidate = function(storeName) {
    _cache[storeName] = null;
    // Каскадная инвалидация связанных сторов
    if (storeName === "owners") { _cache["pets"] = null; }
    if (storeName === "pets")   { _cache["visits"] = null; _cache["vaccinations"] = null; _cache["visit_items"] = null; }
    if (storeName === "visits") { _cache["visit_items"] = null; }
  };

  // ─── Sync state & UI status ───────────────────────────────────────────────

  var _statusNode  = null;
  var _syncRunning = false;
  var _syncTimer   = null;
  var _backoffTimer = null;
  var _initPromise = null;

  function getStatusNode() {
    if (_statusNode) return _statusNode;
    _statusNode = document.createElement("div");
    _statusNode.id = "pwa-sync-status";
    _statusNode.setAttribute("aria-live", "polite");
    _statusNode.setAttribute("aria-atomic", "true");
    _statusNode.textContent = navigator.onLine ? "Запуск…" : "Офлайн";
    var mount = document.querySelector(".topbar");
    if (mount) mount.appendChild(_statusNode);
    return _statusNode;
  }

  function setStatus(text, tone) {
    // ── Topbar pill ──────────────────────────────────────────────────
    var node = getStatusNode();
    node.textContent = text;
    var palette = {
      ok:   { color: "#1a8c5e", border: "rgba(26,140,94,.3)",   bg: "#eaf5ee" },
      warn: { color: "#c97a0a", border: "rgba(201,122,10,.28)", bg: "#fef8ec" },
      err:  { color: "#dc3545", border: "rgba(220,53,69,.28)",  bg: "#fff2f3" },
      info: { color: "#526070", border: "#e0e8f2",              bg: "#ffffff" }
    };
    var c = palette[tone] || palette.info;
    node.style.color       = c.color;
    node.style.borderColor = c.border;
    node.style.background  = c.bg;

    // ── Sidebar sync button ──────────────────────────────────────────
    // Маппим tone → data-state кнопки
    var stateMap = { ok: "ok", warn: "syncing", err: "offline", info: "offline" };
    var btnState = stateMap[tone] || "offline";

    // Уточняем state для ошибки синхронизации (не просто офлайн)
    if (tone === "err" && text.toLowerCase().indexOf("ошибка") !== -1) {
      btnState = "error";
    }

    updateSyncBtn(btnState, text);
  }

  // ─── Sidebar sync button ──────────────────────────────────────────────────

  function updateSyncBtn(state, statusText) {
    var btn        = document.getElementById("sidebar-sync-btn");
    var statusEl   = document.getElementById("sidebar-sync-status");
    var timeEl     = document.getElementById("sidebar-sync-time");
    if (!btn) return;

    btn.dataset.state = state;

    // Текст статуса
    var labels = {
      ok:      "Подключено",
      syncing: "Синхронизация…",
      offline: "Офлайн",
      error:   "Ошибка синхронизации",
    };
    if (statusEl) statusEl.textContent = labels[state] || statusText || "—";

    // Время последней синхронизации
    if (timeEl) {
      window.VetSync && window.VetSync.getLastSync
        ? window.VetSync.getLastSync().then(function (ts) {
            timeEl.textContent = ts ? "Обновлено: " + formatSyncTime(ts) : "Синхронизаций не было";
          })
        : (timeEl.textContent = "");
    }
  }

  function formatSyncTime(isoString) {
    if (!isoString) return "";
    try {
      var d   = new Date(isoString);
      var now = new Date();
      var diffMs = now - d;
      var diffMin = Math.floor(diffMs / 60000);

      if (diffMin < 1)   return "только что";
      if (diffMin < 60)  return diffMin + " мин назад";

      var todayStart = new Date(now.getFullYear(), now.getMonth(), now.getDate());
      var yesterdayStart = new Date(todayStart - 86400000);

      var hh = d.getHours().toString().padStart(2, "0");
      var mm = d.getMinutes().toString().padStart(2, "0");
      var timeStr = hh + ":" + mm;

      if (d >= todayStart)      return timeStr;
      if (d >= yesterdayStart)  return "вчера " + timeStr;

      var day = d.getDate();
      var months = ["янв","фев","мар","апр","май","июн","июл","авг","сен","окт","ноя","дек"];
      return day + " " + months[d.getMonth()] + " " + timeStr;
    } catch (e) {
      return "";
    }
  }

  function initSyncBtn() {
    var btn = document.getElementById("sidebar-sync-btn");
    if (!btn) return;

    btn.addEventListener("click", function (e) {
      e.preventDefault();
      if (_syncRunning) return; // уже идёт
      runSync();
    });

    // Начальное состояние
    updateSyncBtn(navigator.onLine ? "offline" : "offline", null);
  }

  // ─── Инициализация приложения ─────────────────────────────────────────────

  async function initApp() {
    if (_initPromise) return _initPromise;

    _initPromise = (async function () {
      await window.VetDB.initDB();
      await window.VetDB.initDeviceID();

      setStatus(navigator.onLine ? "Загрузка данных…" : "Офлайн", navigator.onLine ? "warn" : "err");

      await window.VetSync.bootstrap();

      // Сбрасываем кэш после bootstrap/pullFull — гарантируем чтение из IndexedDB.
      // Без этого ensureLoaded может вернуть устаревший кэш если он был заполнен
      // до завершения pullFull (например параллельными вызовами initVisits).
      Object.keys(_cache).forEach(function (k) { _cache[k] = null; });

      // Уведомляем UI что данные готовы — триггер для перерисовки страниц
      emitChange("all");

      setStatus(navigator.onLine ? "Актуально" : "Офлайн", navigator.onLine ? "ok" : "err");
    })().catch(function (err) {
      setStatus("Ошибка инициализации", "err");
      console.error("[VetApp] initApp:", err);
      // Даже при ошибке — уведомить UI, чтобы страницы попытались загрузить данные
      emitChange("all");
    });

    return _initPromise;
  }

  // ─── Фоновая синхронизация ────────────────────────────────────────────────

  async function runSync() {
    if (_syncRunning) return;

    var reachable = await window.VetSync.checkServerReachable();
    if (!reachable) {
      setStatus("Офлайн", "err");
      scheduleRetry();
      return;
    }

    _syncRunning = true;
    setStatus("Синхронизация...", "warn");

    try {
      // Порядок: PUSH первым, потом PULL.
      // Push-first гарантирует что изменения (редактирования, удаления) уходят
      // на сервер до того как pull может их перезаписать.
      // Pull после push получает подтверждённое состояние сервера.
      var pushResult = await window.VetSync.pushSync();
      await window.VetSync.pullFull();

      // Сбрасываем кэш после sync чтобы UI получил свежие данные
      Object.keys(_cache).forEach(function (k) { _cache[k] = null; });

      window.VetSync.resetBackoff();
      // Показываем что синхронизировалось (для диагностики)
      var pushInfo = pushResult.pushed > 0
        ? " ↑" + pushResult.pushed + (pushResult.skipped > 0 ? " !" + pushResult.skipped : "")
        : (pushResult.fallback ? " ↑fb" : "");
      setStatus("Актуально" + pushInfo, "ok");
      emitChange("all");

    } catch (err) {
      console.error("[VetApp] sync error:", err);
      setStatus("Ошибка синхронизации", "err");
      scheduleRetry();
    } finally {
      _syncRunning = false;
    }
  }

  function scheduleRetry() {
    if (_backoffTimer) clearTimeout(_backoffTimer);
    var delay = window.VetSync.nextBackoffDelay();
    _backoffTimer = setTimeout(function () {
      if (navigator.onLine) runSync();
    }, delay);
  }

  function triggerSync() {
    if (!navigator.onLine) { setStatus("Офлайн", "err"); return; }
    clearTimeout(_syncTimer);
    _syncTimer = setTimeout(runSync, 1200);
  }

  function startSyncLoop() {
    // Основной интервал: каждые 45 секунд
    setInterval(function () {
      if (navigator.onLine && !_syncRunning) runSync();
    }, 15000); // 15s — уменьшено для быстрой видимости изменений между устройствами
  }

  // ─── Fetch interceptor ────────────────────────────────────────────────────
  // Перехватывает все fetch-запросы к управляемым путям.
  // Обслуживает их локально из IndexedDB без обращения к сети.

  async function interceptFetch(input, init) {
    var reqURL  = new URL(typeof input === "string" ? input : input.url, window.location.href);
    var method  = ((init && init.method) || (typeof input !== "string" && input.method) || "GET").toUpperCase();
    var headers = new Headers((init && init.headers) || (typeof input !== "string" ? input.headers : undefined));

    // Запросы с X-Bypass-Local идут напрямую в сеть (используется sync.js)
    if (headers.get("X-Bypass-Local") === "1") {
      return window.__nativeFetch(input, init);
    }

    // Health check — всегда в сеть
    if (reqURL.pathname === "/health") {
      return window.__nativeFetch(window.VetAppConfig.apiBase + "/health", init);
    }

    var isManagedPath = reqURL.pathname === "/visits/full" ||
      Object.keys(STORE_MAP).some(function (p) {
        return reqURL.pathname === p || reqURL.pathname.startsWith(p + "/");
      });

    if (!isManagedPath) return window.__nativeFetch(input, init);

    await initApp();

    var body = null;
    if (method !== "GET" && method !== "HEAD" && init && init.body) {
      try { body = JSON.parse(init.body); }
      catch (e) { return responseError("Invalid JSON body", 400); }
    }

    try {
      var data = await handleLocalRequest(method, reqURL.pathname, reqURL.searchParams, body || {});
      if (data === null) return window.__nativeFetch(input, init);
      return responseOK(data, method === "POST" ? 201 : 200);
    } catch (err) {
      return responseError(err.message || "Local operation failed", 500);
    }
  }

  // ─── Локальный роутер ─────────────────────────────────────────────────────

  async function handleLocalRequest(method, pathname, searchParams, body) {
    // LIST
    if (method === "GET" && STORE_MAP[pathname]) {
      return readStore(STORE_MAP[pathname], searchParams);
    }

    // Full visit (атомарная операция)
    if (method === "POST" && pathname === "/visits/full") {
      return createFullVisit(body);
    }

    // Специальный эндпоинт: отметить питомца умершим
    // PUT /pets/{id}/deceased → обновляет status + death_date + death_reason локально
    var deceasedMatch = pathname.match(/^\/pets\/([^/]+)\/deceased$/);
    if (method === "PUT" && deceasedMatch) {
      var petId = deceasedMatch[1];
      return updateEntity("pets", petId, Object.assign({}, body, { status: "deceased" }));
    }

    // CRUD по сторам
    var storeEntry = findStoreEntry(pathname);
    if (!storeEntry) return null;

    var storeName = storeEntry.storeName;
    var id = storeEntry.id;

    if (method === "POST" && !id)    return createEntity(storeName, body);
    if (method === "PUT"  && id)     return updateEntity(storeName, id, body);
    if (method === "DELETE" && id)   return deleteEntity(storeName, id);

    return null;
  }

  function findStoreEntry(pathname) {
    for (var prefix of Object.keys(STORE_MAP)) {
      if (pathname === prefix)                      return { storeName: STORE_MAP[prefix], id: null };
      if (pathname.startsWith(prefix + "/")) {
        var id = pathname.slice(prefix.length + 1).split("/")[0];
        return { storeName: STORE_MAP[prefix], id: id || null };
      }
    }
    return null;
  }

  // ─── Чтение из кэша с фильтрами ──────────────────────────────────────────

  async function readStore(storeName, sp) {
    var rows = (await ensureLoaded(storeName)).filter(function (r) { return !r.is_deleted; });

    if (storeName === "items") {
      rows = rows.filter(function (r) { return r.is_active !== false; });
      if (sp.get("type"))   rows = rows.filter(function (r) { return r.type === sp.get("type"); });
      if (sp.get("search")) rows = search(rows, sp.get("search"), ["name"]);
      return rows.sort(byField("name"));
    }

    if (storeName === "owners") {
      if (sp.get("search")) rows = search(rows, sp.get("search"), ["fio","phone","iin","address"]);
      return rows.sort(byField("fio"));
    }

    if (storeName === "pets") {
      var statusFilter = sp.get("status") || "active";
      if (statusFilter !== "all") rows = rows.filter(function (r) { return r.status === statusFilter; });
      if (sp.get("owner_id")) rows = rows.filter(function (r) { return r.owner_id === sp.get("owner_id"); });
      if (sp.get("search"))  rows = search(rows, sp.get("search"), ["name","breed"]);
      return rows.sort(byField("name"));
    }

    if (storeName === "visits") {
      if (sp.get("pet_id"))    rows = rows.filter(function (r) { return r.pet_id === sp.get("pet_id"); });
      if (sp.get("date_from")) rows = rows.filter(function (r) { return r.date >= sp.get("date_from"); });
      if (sp.get("date_to"))   rows = rows.filter(function (r) { return r.date <= sp.get("date_to"); });
      if (sp.get("search"))    rows = search(rows, sp.get("search"), ["diagnosis","anamnesis","notes"]);
      return rows.sort(function (a, b) { return b.date > a.date ? 1 : -1; });
    }

    if (storeName === "visit_items") {
      if (sp.get("visit_id")) rows = rows.filter(function (r) { return r.visit_id === sp.get("visit_id"); });
      return rows;
    }

    if (storeName === "vaccinations") {
      if (sp.get("pet_id")) rows = rows.filter(function (r) { return r.pet_id === sp.get("pet_id"); });
      return rows.sort(function (a, b) { return b.administered_at > a.administered_at ? 1 : -1; });
    }

    if (storeName === "appointments") {
      if (sp.get("date")) {
        var d = sp.get("date");
        rows = rows.filter(function (r) { return (r.starts_at||"").slice(0,10) === d; });
      }
      if (sp.get("staff_id")) rows = rows.filter(function (r) { return r.staff_id === sp.get("staff_id"); });
      return rows.sort(function (a, b) { return (a.starts_at||"") < (b.starts_at||"") ? -1 : 1; });
    }

    if (storeName === "staff") {
      if (sp.get("active") === "true") rows = rows.filter(function (r) { return r.is_active !== false; });
      if (sp.get("role")) rows = rows.filter(function (r) { return r.role === sp.get("role"); });
      return rows.sort(byField("name"));
    }

    return rows;
  }

  // Дата окончания курса лечения для локальной записи визита.
  // Повторяет серверный resolveTreatment (backend/handlers_visits.go):
  // отсчёт от даты приёма, курс в 1 день = лечение в день приёма (отсюда days-1).
  // 0 дней = курс не назначен → null, иначе животное осталось бы активным навсегда.
  function treatmentUntilISO(visitDateISO, days) {
    if (!days || days < 1) return null;
    if (days > 365) days = 365;
    var d = new Date(visitDateISO);
    if (isNaN(d.getTime())) return null;
    d.setUTCDate(d.getUTCDate() + (days - 1));
    return d.toISOString();
  }

  // Нормализует дату/время в ISO 8601 (RFC3339) для корректного парсинга на сервере.
  // Браузерный input[datetime-local] возвращает "2025-05-17T14:00" (без секунд и TZ).
  function normalizeDatetime(v) {
    if (!v) return new Date().toISOString();
    v = String(v).trim();
    if (!v) return new Date().toISOString();
    // "2025-05-17T14:00" → "2025-05-17T14:00:00.000Z"
    if (/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/.test(v)) return v + ":00.000Z";
    // "2025-05-17T14:00:00" → добавить Z
    if (/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}$/.test(v)) return v + ".000Z";
    // "2025-05-17" → "2025-05-17T09:00:00.000Z"
    if (/^\d{4}-\d{2}-\d{2}$/.test(v)) return v + "T09:00:00.000Z";
    return v; // уже корректный формат
  }

  function search(rows, query, fields) {
    var term = (query || "").toLowerCase();
    return rows.filter(function (r) {
      return fields.some(function (f) { return String(r[f] || "").toLowerCase().includes(term); });
    });
  }

  function byField(field) {
    return function (a, b) { return String(a[field] || "").localeCompare(String(b[field] || "")); };
  }

  // ─── CRUD операции ────────────────────────────────────────────────────────

  // Чип животного: нормализация и уникальность в ЛОКАЛЬНОЙ базе.
  // Сервер это проверяет, но офлайн-путь пишет мимо сервера: без локальной
  // проверки дубль спокойно создавался на планшете, а при синхронизации
  // сервер молча отклонял его — животное оставалось только на устройстве,
  // и никто об этом не узнавал. Регистрация чипа «не работала».
  async function guardPetChip(body, selfId) {
    if (!body || body.chip_number === undefined) return;
    var chip = String(body.chip_number || "").replace(/\D/g, "");
    body.chip_number = chip;
    if (!chip) return;
    if (chip.length < 9 || chip.length > 15) {
      throw new Error("Номер чипа: от 9 до 15 цифр");
    }
    var pets = await ensureLoaded("pets");
    var dup = pets.find(function (p) {
      return p.id !== selfId && !p.is_deleted && p.status === "active" &&
             String(p.chip_number || "").replace(/\D/g, "") === chip;
    });
    if (dup) {
      throw new Error("Чип " + chip + " уже закреплён за животным: " + (dup.name || "?"));
    }
    // Дата чипирования: если чип появился впервые — сегодня.
    // Реестр модуля «Чипирование» строится по этой дате.
    if (!body.chip_date) {
      var prev = selfId ? pets.find(function (p) { return p.id === selfId; }) : null;
      var prevChip = prev ? String(prev.chip_number || "").replace(/\D/g, "") : "";
      if (prevChip !== chip) body.chip_date = new Date().toISOString();
      else if (prev && prev.chip_date) body.chip_date = prev.chip_date;
    }
  }

  async function createEntity(storeName, body) {
    if (storeName === "pets") await guardPetChip(body, null);
    // Сервер ставит status='active' при создании; локальный слой обязан
    // делать то же, иначе питомец невидим в списках до первой синхронизации.
    if (storeName === "pets" && !body.status) body.status = "active";
    // То же для каталога: сервер ставит is_active=1 и отдаёт /items только с
    // ним. Отсутствующее поле приезжает в Go как false — позиция, заведённая
    // офлайн, синхронизировалась и пропадала из каталога.
    if (storeName === "items" && body.is_active === undefined) body.is_active = true;
    var record = await window.VetDB.save(storeName, Object.assign({ id: window.VetDB.uuid() }, body));
    await refreshStore(storeName);
    emitChange(storeName);
    triggerSync();
    return record;
  }

  async function updateEntity(storeName, id, body) {
    if (storeName === "pets") await guardPetChip(body, id);
    var existing = await window.VetDB.getById(storeName, id);
    if (!existing) {
      // Запись не найдена в IndexedDB — создаём новую
      var record = await window.VetDB.save(storeName, Object.assign({}, body, { id: id }));
      invalidateCache(storeName);
      _cache[storeName] = await window.VetDB.getAll(storeName);
      emitChange(storeName);
      triggerSync();
      return record;
    }
    var merged = Object.assign({}, existing, body, { id: id });
    var record = await window.VetDB.save(storeName, merged);
    // Инвалидируем кэш ЯВНО и перечитываем из IndexedDB —
    // чтобы любой последующий ensureLoaded получил актуальные данные
    _cache[storeName] = null;
    _cache[storeName] = await window.VetDB.getAll(storeName);
    emitChange(storeName);
    triggerSync();
    return record;
  }

  async function deleteEntity(storeName, id) {
    var record = await window.VetDB.softDelete(storeName, id);
    if (!record) throw new Error("Not found");
    await refreshStore(storeName);
    invalidateCache(storeName);
    emitChange(storeName);
    triggerSync();
    return { id: id };
  }

  // ─── Full visit ───────────────────────────────────────────────────────────

  async function createFullVisit(payload) {
    var ownerInput = payload.owner || {};
    var petInput   = payload.pet   || {};
    var visitInput = payload.visit || {};
    var itemsInput = Array.isArray(payload.items) ? payload.items : [];

    // Upsert владельца
    var owners = (await ensureLoaded("owners")).filter(function (r) { return !r.is_deleted; });
    var ownerMatch = owners.find(function (o) {
      return (ownerInput.id && o.id === ownerInput.id) ||
             (ownerInput.iin && o.iin && o.iin === ownerInput.iin) ||
             (ownerInput.phone && o.phone === ownerInput.phone);
    });
    var owner = await window.VetDB.save("owners", Object.assign({}, ownerMatch || {}, ownerInput, {
      id: (ownerMatch && ownerMatch.id) || ownerInput.id || window.VetDB.uuid()
    }));

    // Upsert питомца
    var pets = (await ensureLoaded("pets")).filter(function (r) { return !r.is_deleted; });
    var petMatch = pets.find(function (p) {
      return (petInput.id && p.id === petInput.id) ||
             (p.owner_id === owner.id && p.name && p.name.toLowerCase() === (petInput.name || "").toLowerCase());
    });
    var pet = await window.VetDB.save("pets", Object.assign({}, petMatch || {}, petInput, {
      id:       (petMatch && petMatch.id) || petInput.id || window.VetDB.uuid(),
      owner_id: owner.id,
      status:   (petMatch && petMatch.status) || "active"
    }));

    // Создаём визит
    var totalAmount = itemsInput.reduce(function (sum, item) {
      return sum + (Number(item.quantity || 1) * Number(item.price || 0));
    }, 0);
    // Скидка фиксированной суммой — как на сервере: итог не ниже нуля.
    var discount = Math.max(0, Math.min(Number(visitInput.discount || 0), totalAmount));
    totalAmount = Math.max(0, totalAmount - discount);

    var visitDate = normalizeDatetime(visitInput.date);
    var visit = await window.VetDB.save("visits", Object.assign({}, visitInput, {
      id:           visitInput.id || window.VetDB.uuid(),
      pet_id:       pet.id,
      total_amount: totalAmount,
      discount:     discount,
      // Нормализуем дату в RFC3339 — браузер даёт "2025-05-17T14:00" без секунд
      date: visitDate,
      // Срок курса считаем здесь же: офлайн сервера нет, а без этой даты
      // животное не попадёт в список активных до первой синхронизации.
      // Сервер пересчитает то же самое при push — расхождения не будет.
      treatment_days:  Number(visitInput.treatment_days || 0),
      treatment_until: treatmentUntilISO(visitDate, Number(visitInput.treatment_days || 0))
    }));

    // Создаём позиции визита
    var visitItems = [];
    for (var i = 0; i < itemsInput.length; i++) {
      var item = itemsInput[i];
      var vi = await window.VetDB.save("visit_items", {
        id:         item.id || window.VetDB.uuid(),
        visit_id:   visit.id,
        item_id:    item.item_id || null,
        name:       item.name || "",
        type:       item.type || "service",
        quantity:   Number(item.quantity || 1),
        price:      Number(item.price    || 0),
        cost_price: Number(item.cost_price || 0),
        total:      Number(item.quantity || 1) * Number(item.price || 0)
      });
      visitItems.push(vi);
    }

    // Обновляем кэш
    await Promise.all(["owners","pets","visits","visit_items"].map(function (s) { return refreshStore(s); }));
    emitChange("all");
    triggerSync();

    return { owner: owner, pet: pet, visit: visit, visit_items: visitItems };
  }

  // ─── HTTP response helpers ────────────────────────────────────────────────

  function responseOK(data, status) {
    return new Response(JSON.stringify({ status: "ok", data: data }), {
      status:  status || 200,
      headers: { "Content-Type": "application/json" }
    });
  }

  function responseError(message, status) {
    return new Response(JSON.stringify({ status: "error", message: message }), {
      status:  status || 400,
      headers: { "Content-Type": "application/json" }
    });
  }

  // ─── Service Worker ───────────────────────────────────────────────────────

  var _swReg = null;           // активная SW registration
  var _deferredInstall = null; // сохранённый beforeinstallprompt

  function registerServiceWorker() {
    if (window.location.protocol === "file:") {
      console.log("[VetApp] file:// — SW не регистрируется");
      return;
    }
    if (!("serviceWorker" in navigator)) {
      console.warn("[VetApp] Service Worker не поддерживается");
      return;
    }

    window.addEventListener("load", function () {
      navigator.serviceWorker
        .register("/service-worker.js", { scope: "/" })
        .then(function (reg) {
          _swReg = reg;
          console.log("[VetApp] SW registered, scope:", reg.scope);

          // Проверять обновления каждые 5 минут
          setInterval(function () { reg.update(); }, 5 * 60 * 1000);

          // Если уже есть ожидающий SW — сразу показываем тост
          if (reg.waiting) {
            showUpdateToast(reg.waiting);
          }

          // Новый SW установился и ждёт
          reg.addEventListener("updatefound", function () {
            var newWorker = reg.installing;
            if (!newWorker) return;
            newWorker.addEventListener("statechange", function () {
              if (newWorker.state === "installed" && navigator.serviceWorker.controller) {
                // Новая версия готова — предложить обновление
                showUpdateToast(newWorker);
              }
            });
          });
        })
        .catch(function (err) {
          console.error("[VetApp] SW registration failed:", err);
        });
    });

    // Слушаем сообщения от SW
    navigator.serviceWorker.addEventListener("message", function (event) {
      if (!event.data) return;
      switch (event.data.type) {
        case "APP_UPDATED":
          console.log("[VetApp] App updated to:", event.data.version);
          break;
        case "BACKGROUND_SYNC_TRIGGERED":
          if (!_syncRunning) runSync();
          break;
      }
    });

    // Перезагрузить при смене контроллера (после SKIP_WAITING)
    var refreshing = false;
    navigator.serviceWorker.addEventListener("controllerchange", function () {
      if (!refreshing) {
        refreshing = true;
        window.location.reload();
      }
    });
  }

  // Показывает тост «Доступно обновление»
  function showUpdateToast(worker) {
    if (window.VetUI && window.VetUI.toast) {
      // Используем нотификацию через UI
    }
    var toast = document.createElement("div");
    toast.id = "sw-update-toast";
    toast.style.cssText = [
      "position:fixed", "bottom:24px", "left:50%", "transform:translateX(-50%)",
      "background:#1a2434", "color:#fff", "padding:14px 20px",
      "border-radius:12px", "box-shadow:0 8px 32px rgba(0,0,0,.25)",
      "display:flex", "align-items:center", "gap:14px", "z-index:9999",
      "font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif",
      "font-size:.88rem", "font-weight:500", "max-width:calc(100vw - 32px)",
      "animation:toastSlide .22s cubic-bezier(.4,0,.2,1)"
    ].join(";");
    toast.innerHTML = '<span>🔄 Доступно обновление приложения</span>'
      + '<button style="background:#1a8c5e;color:#fff;border:none;padding:7px 16px;border-radius:8px;cursor:pointer;font-weight:700;font-size:.82rem;font-family:inherit;white-space:nowrap;" id="sw-update-btn">Обновить</button>'
      + '<button style="background:none;color:rgba(255,255,255,.5);border:none;cursor:pointer;font-size:1.1rem;padding:4px;" id="sw-update-close">&times;</button>';
    document.body.appendChild(toast);

    document.getElementById("sw-update-btn").onclick = function () {
      worker.postMessage({ type: "SKIP_WAITING" });
      toast.remove();
    };
    document.getElementById("sw-update-close").onclick = function () {
      toast.remove();
    };
    // Авто-скрыть через 15 секунд
    setTimeout(function () { if (toast.parentNode) toast.remove(); }, 15000);
  }

  // ─── Install Prompt (Android / Desktop) ──────────────────────────────────

  window.addEventListener("beforeinstallprompt", function (e) {
    e.preventDefault();
    _deferredInstall = e;
    showInstallBanner();
  });

  window.addEventListener("appinstalled", function () {
    _deferredInstall = null;
    hideInstallBanner();
    console.log("[VetApp] PWA installed successfully");
  });

  function showInstallBanner() {
    if (document.getElementById("pwa-install-banner")) return;
    var banner = document.createElement("div");
    banner.id = "pwa-install-banner";
    banner.style.cssText = [
      "position:fixed", "bottom:0", "left:0", "right:0", "z-index:8000",
      "background:#ffffff", "border-top:1px solid #e0e8f2",
      "box-shadow:0 -4px 20px rgba(12,30,60,.1)",
      "padding:14px 20px", "display:flex", "align-items:center", "gap:14px",
      "font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif",
      "safe-area-inset-bottom:env(safe-area-inset-bottom)"
    ].join(";");
    banner.innerHTML = '<div style="width:44px;height:44px;border-radius:12px;background:#eaf5ee;border:1.5px solid rgba(26,140,94,.2);display:flex;align-items:center;justify-content:center;flex-shrink:0;font-size:22px;">🏥</div>'
      + '<div style="flex:1;min-width:0;"><div style="font-weight:700;font-size:.9rem;color:#1a2434;">Установить VetClinic</div><div style="font-size:.78rem;color:#526070;margin-top:2px;">Работает без интернета</div></div>'
      + '<button id="pwa-install-btn" style="background:#1a8c5e;color:#fff;border:none;height:40px;padding:0 18px;border-radius:10px;font-weight:700;font-size:.85rem;cursor:pointer;font-family:inherit;white-space:nowrap;flex-shrink:0;">Установить</button>'
      + '<button id="pwa-install-close" style="background:none;border:none;color:var(--text-3);cursor:pointer;font-size:1.3rem;padding:4px;flex-shrink:0;line-height:1;">&times;</button>';
    document.body.appendChild(banner);

    document.getElementById("pwa-install-btn").onclick = function () {
      if (_deferredInstall) {
        _deferredInstall.prompt();
        _deferredInstall.userChoice.then(function (result) {
          if (result.outcome === "accepted") hideInstallBanner();
          _deferredInstall = null;
        });
      }
    };
    document.getElementById("pwa-install-close").onclick = function () {
      hideInstallBanner();
      // Не показывать повторно 24 часа
      localStorage.setItem("pwa-banner-dismissed", Date.now().toString());
    };
  }

  function hideInstallBanner() {
    var b = document.getElementById("pwa-install-banner");
    if (b) b.remove();
  }

  // ─── Background Sync регистрация ──────────────────────────────────────────

  async function registerBackgroundSync() {
    if (!("serviceWorker" in navigator) || !("SyncManager" in window)) return;
    try {
      var reg = await navigator.serviceWorker.ready;
      await reg.sync.register("vetclinic-sync");
      console.log("[VetApp] Background sync registered");
    } catch(e) {
      // Fallback — используем online event (уже есть)
    }
  }

  async function registerPeriodicSync() {
    if (!navigator.serviceWorker) return;
    if (!("periodicSync" in (await navigator.serviceWorker.ready))) return;
    try {
      var status = await navigator.permissions.query({ name: "periodic-background-sync" });
      if (status.state === "granted") {
        var reg = await navigator.serviceWorker.ready;
        await reg.periodicSync.register("vetclinic-daily", {
          minInterval: 24 * 60 * 60 * 1000 // раз в сутки
        });
        console.log("[VetApp] Periodic background sync registered");
      }
    } catch(e) { /* не критично */ }
  }

  // ─── Event listeners ──────────────────────────────────────────────────────

  window.addEventListener("online", function () {
    setStatus("Синхронизация...", "warn");
    runSync();
    registerBackgroundSync();
  });

  window.addEventListener("offline", function () {
    setStatus("Офлайн", "err");
  });

  // ─── Bootstrap ────────────────────────────────────────────────────────────

  window.fetch = interceptFetch;
  registerServiceWorker();

  document.addEventListener("DOMContentLoaded", function () {
    getStatusNode();
    initSyncBtn();
    initApp();
    startSyncLoop();
    if (navigator.onLine) {
      setTimeout(registerPeriodicSync, 3000);
    }
  });

}());
