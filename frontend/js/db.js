(function () {
  "use strict";

  const DB_NAME    = "vetclinic-pwa";
  const DB_VERSION = 4; // v4: appointments (расписание — запись на приём)

  // Список всех object stores
  // attachments — только метаданные, приезжают с сервера через pull.
  // Сами файлы на планшете не хранятся: смотреть сканы можно при наличии сети.
  const ENTITY_STORES = ["owners", "pets", "items", "visits", "visit_items", "vaccinations", "staff", "attachments", "appointments"];
  const META_STORES   = ["sync_queue", "sync_state", "devices", "attachment_queue"];
  const ALL_STORES    = ENTITY_STORES.concat(META_STORES);

  let _dbPromise = null;

  // ─── Открытие / инициализация ─────────────────────────────────────────────

  function openDB() {
    if (_dbPromise) return _dbPromise;

    _dbPromise = new Promise(function (resolve, reject) {
      const req = indexedDB.open(DB_NAME, DB_VERSION);

      req.onupgradeneeded = function (event) {
        const db  = event.target.result;
        const old = event.oldVersion;

        // ── Entity stores ──────────────────────────────────────────────────
        ENTITY_STORES.forEach(function (name) {
          var store;
          if (!db.objectStoreNames.contains(name)) {
            store = db.createObjectStore(name, { keyPath: "id" });
          } else {
            store = event.target.transaction.objectStore(name);
          }
          _ensureIndex(store, "sync_status", "sync_status", false);
          _ensureIndex(store, "updated_at",  "updated_at",  false);
          _ensureIndex(store, "is_deleted",  "is_deleted",  false);
          // Дополнительные индексы для частых запросов
          if (name === "pets")        { _ensureIndex(store, "owner_id", "owner_id", false); _ensureIndex(store, "status", "status", false); }
          if (name === "visits")      { _ensureIndex(store, "pet_id",   "pet_id",   false); }
          if (name === "visit_items") { _ensureIndex(store, "visit_id", "visit_id", false); }
          if (name === "vaccinations"){ _ensureIndex(store, "pet_id",   "pet_id",   false); }
          if (name === "attachments") { _ensureIndex(store, "visit_id", "visit_id", false); _ensureIndex(store, "pet_id", "pet_id", false); }
          if (name === "appointments"){ _ensureIndex(store, "starts_at", "starts_at", false); }
        });

        // ── attachment_queue ───────────────────────────────────────────────
        // Файлы, снятые офлайн и ждущие отправки. Здесь лежит сам Blob —
        // это единственное место, где планшет держит файлы: до отправки
        // их больше нигде нет, потеря очереди = потеря снимка.
        if (!db.objectStoreNames.contains("attachment_queue")) {
          const aq = db.createObjectStore("attachment_queue", { keyPath: "id" });
          aq.createIndex("status",     "status",     { unique: false });
          aq.createIndex("visit_id",   "visit_id",   { unique: false });
          aq.createIndex("created_at", "created_at", { unique: false });
        }

        // ── sync_queue ─────────────────────────────────────────────────────
        // Упорядоченная очередь операций, которые нужно синхронизировать.
        if (!db.objectStoreNames.contains("sync_queue")) {
          const sq = db.createObjectStore("sync_queue", { keyPath: "id" });
          sq.createIndex("status",       "status",       { unique: false });
          sq.createIndex("entity_type",  "entity_type",  { unique: false });
          sq.createIndex("created_at",   "created_at",   { unique: false });
        }

        // ── sync_state ─────────────────────────────────────────────────────
        // key-value хранилище состояния синхронизации (last_sync, device_id и т.п.)
        if (!db.objectStoreNames.contains("sync_state")) {
          db.createObjectStore("sync_state", { keyPath: "key" });
        }

        // ── devices ────────────────────────────────────────────────────────
        if (!db.objectStoreNames.contains("devices")) {
          db.createObjectStore("devices", { keyPath: "id" });
        }
      };

      req.onsuccess  = function () { resolve(req.result); };
      req.onerror    = function () { reject(req.error || new Error("Failed to open IndexedDB")); };
      req.onblocked  = function () { console.warn("[VetDB] upgrade blocked — close other tabs"); };
    });

    return _dbPromise;
  }

  function _ensureIndex(store, name, keyPath, unique) {
    if (!store.indexNames.contains(name)) {
      store.createIndex(name, keyPath, { unique: unique });
    }
  }

  // ─── Транзакционный helper ────────────────────────────────────────────────

  function tx(storeName, mode, runner) {
    return openDB().then(function (db) {
      return new Promise(function (resolve, reject) {
        var t = db.transaction(storeName, mode);
        t.onerror = function () { reject(t.error || new Error("Transaction failed")); };
        var store = t.objectStore(storeName);
        var result = runner(store, resolve, reject);
        if (result && typeof result.catch === "function") result.catch(reject);
      });
    });
  }

  // ─── UUID ─────────────────────────────────────────────────────────────────

  function uuid() {
    if (window.crypto && typeof window.crypto.randomUUID === "function") {
      return window.crypto.randomUUID();
    }
    return "xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx".replace(/[xy]/g, function (c) {
      var r = Math.random() * 16 | 0;
      return (c === "x" ? r : (r & 0x3 | 0x8)).toString(16);
    });
  }

  function nowISO() { return new Date().toISOString(); }

  // ─── Нормализация записей ─────────────────────────────────────────────────

  function normalizeRecord(existing, incoming, opts) {
    var src    = JSON.parse(JSON.stringify(incoming || {}));
    var record = Object.assign({}, existing || {}, src);
    var now    = nowISO();

    record.id         = record.id         || uuid();
    record.server_id  = record.server_id  || null;
    record.created_at = record.created_at || (existing && existing.created_at) || now;

    // updated_at логика:
    //  1. opts.updated_at  — явное время (markSynced, pull)   → использовать как есть
    //  2. sync_status будет "pending" (пользователь редактирует) → ВСЕГДА now
    //     Критично: если взять src.updated_at (старый серверный штамп), сервер
    //     посчитает свою версию новее и отклонит push → pull перезапишет правку.
    //  3. Иначе (synced, приходит с сервера) → src.updated_at || now
    var newSyncStatus = (opts && opts.sync_status) ? opts.sync_status : "pending";
    record.sync_status = newSyncStatus;

    record.updated_at = (opts && opts.updated_at)
                        ? opts.updated_at          // явное время из pull/markSynced
                        : (newSyncStatus === "pending"
                            ? now                  // пользователь правит — текущее время
                            : (src.updated_at || now));

    record.deleted_at  = record.deleted_at  || null;
    record.is_deleted  = typeof record.is_deleted === "number" ? record.is_deleted : 0;
    // sync_status уже установлен выше (до updated_at)
    record.device_id   = record.device_id   || getDeviceID();
    // Инкрементируем version при каждом пользовательском сохранении (pending).
    // Сервер принимает push если client.version > server.version — без зависимости от часов.
    record.version = ((record.version || 0) + (newSyncStatus === 'pending' ? 1 : 0)) || 1;

    return record;
  }

  // ─── Device ID ────────────────────────────────────────────────────────────
  // Генерируется один раз, хранится в sync_state (IndexedDB, не localStorage).

  var _deviceID = null;

  function getDeviceID() {
    return _deviceID || "unknown";
  }

  function initDeviceID() {
    return getSyncState("device_id").then(function (existing) {
      if (existing) {
        _deviceID = existing;
        return existing;
      }
      var id = uuid();
      _deviceID = id;
      return setSyncState("device_id", id).then(function () { return id; });
    });
  }

  // ─── CRUD helpers ─────────────────────────────────────────────────────────

  function getAll(storeName) {
    return tx(storeName, "readonly", function (store, resolve, reject) {
      var r = store.getAll();
      r.onsuccess = function () { resolve(r.result || []); };
      r.onerror   = function () { reject(r.error); };
    });
  }

  function getById(storeName, id) {
    return tx(storeName, "readonly", function (store, resolve, reject) {
      var r = store.get(id);
      r.onsuccess = function () { resolve(r.result || null); };
      r.onerror   = function () { reject(r.error); };
    });
  }

  function putRecord(storeName, record) {
    return tx(storeName, "readwrite", function (store, resolve, reject) {
      var r = store.put(record);
      r.onsuccess = function () { resolve(record); };
      r.onerror   = function () { reject(r.error); };
    });
  }

  function save(storeName, incoming, opts) {
    return getById(storeName, incoming && incoming.id).then(function (existing) {
      return putRecord(storeName, normalizeRecord(existing, incoming, opts));
    });
  }

  function bulkSave(storeName, items, opts) {
    items = Array.isArray(items) ? items : [];
    if (items.length === 0) return Promise.resolve([]);

    return openDB().then(function (db) {
      return new Promise(function (resolve, reject) {
        var t = db.transaction(storeName, "readwrite");
        var store = t.objectStore(storeName);
        var saved = [];

        t.oncomplete = function () { resolve(saved); };
        t.onerror    = function () { reject(t.error); };

        // Для каждого элемента: get → normalize → put
        items.forEach(function (item) {
          var r = store.get(item.id);
          r.onsuccess = function () {
            var record = normalizeRecord(r.result || null, item, opts);
            store.put(record);
            saved.push(record);
          };
        });
      });
    });
  }

  function softDelete(storeName, id) {
    return getById(storeName, id).then(function (existing) {
      if (!existing) return null;
      return putRecord(storeName, normalizeRecord(existing, { id: id, is_deleted: 1, deleted_at: nowISO() }, { sync_status: "pending" }));
    });
  }

  function hardDelete(storeName, id) {
    return tx(storeName, "readwrite", function (store, resolve, reject) {
      var r = store.delete(id);
      r.onsuccess = function () { resolve(true); };
      r.onerror   = function () { reject(r.error); };
    });
  }

  function markSynced(storeName, id, serverUpdatedAt) {
    return getById(storeName, id).then(function (existing) {
      if (!existing) return null;
      return putRecord(storeName, Object.assign({}, existing, {
        sync_status: "synced",
        updated_at:  serverUpdatedAt || existing.updated_at || nowISO()
      }));
    });
  }

  // ─── Sync Queue ───────────────────────────────────────────────────────────

  function addToSyncQueue(entityType, entityId, operation, payload) {
    var entry = {
      id:          uuid(),
      entity_type: entityType,
      entity_id:   entityId,
      operation:   operation,   // create | update | delete
      payload:     payload,
      status:      "pending",
      retry_count: 0,
      created_at:  nowISO(),
      next_retry_at: nowISO(),
      error:       null
    };
    return putRecord("sync_queue", entry);
  }

  function getPendingSyncQueue() {
    return tx("sync_queue", "readonly", function (store, resolve, reject) {
      var idx = store.index("status");
      var r   = idx.getAll("pending");
      r.onsuccess = function () { resolve(r.result || []); };
      r.onerror   = function () { reject(r.error); };
    });
  }

  function markQueueEntryDone(id) {
    return tx("sync_queue", "readwrite", function (store, resolve, reject) {
      var r = store.delete(id);
      r.onsuccess = function () { resolve(true); };
      r.onerror   = function () { reject(r.error); };
    });
  }

  function markQueueEntryFailed(id, error) {
    return getById("sync_queue", id).then(function (entry) {
      if (!entry) return null;
      return putRecord("sync_queue", Object.assign({}, entry, {
        status:      "failed",
        error:       String(error),
        retry_count: (entry.retry_count || 0) + 1
      }));
    });
  }

  // ─── Sync State (key-value) ───────────────────────────────────────────────
  // Хранит last_sync, device_id и т.п. — НЕ localStorage!

  function getSyncState(key) {
    return tx("sync_state", "readonly", function (store, resolve, reject) {
      var r = store.get(key);
      r.onsuccess = function () { resolve(r.result ? r.result.value : null); };
      r.onerror   = function () { reject(r.error); };
    });
  }

  function setSyncState(key, value) {
    return tx("sync_state", "readwrite", function (store, resolve, reject) {
      var r = store.put({ key: key, value: value, updated_at: nowISO() });
      r.onsuccess = function () { resolve(value); };
      r.onerror   = function () { reject(r.error); };
    });
  }

  // ─── Public API ───────────────────────────────────────────────────────────

  window.VetDB = {
    ENTITY_STORES: ENTITY_STORES,
    ALL_STORES:    ALL_STORES,

    // Инициализация
    initDB:       openDB,
    initDeviceID: initDeviceID,
    getDeviceID:  getDeviceID,

    // UUID
    uuid: uuid,

    // CRUD
    getAll:      getAll,
    getById:     getById,
    save:        save,
    bulkSave:    bulkSave,
    softDelete:  softDelete,
    hardDelete:  hardDelete,
    markSynced:  markSynced,

    // Sync state (last_sync, device_id, settings…)
    getSyncState: getSyncState,
    setSyncState: setSyncState,

    // Sync queue
    addToSyncQueue:       addToSyncQueue,
    getPendingSyncQueue:  getPendingSyncQueue,
    markQueueEntryDone:   markQueueEntryDone,
    markQueueEntryFailed: markQueueEntryFailed,

    // Прямой доступ к стору без sync-метаданных.
    // Нужен для attachment_queue: там лежит Blob снятого офлайн файла,
    // и обычные save/getAll подмешали бы туда version, sync_status и прочее,
    // чему в очереди файлов делать нечего.
    putRaw:    putRecord,
    getAllRaw: getAll,
    deleteRaw: hardDelete,
  };

}());
