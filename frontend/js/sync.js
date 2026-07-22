/* ════════════════════════════════════════════════════════════════════════════
   VetClinic Sync Engine  —  v3.0  —  Offline-first, Version-based conflicts
   ════════════════════════════════════════════════════════════════════════════

   АРХИТЕКТУРА:
   ┌─────────────────────────────────────────────────────────────────────────┐
   │  Планшет (офлайн)         Планшет (онлайн)        Сервер               │
   │  ─────────────            ──────────────────────   ──────────────────── │
   │  IndexedDB                IndexedDB ←──pull────── SQLite                │
   │  version++                IndexedDB ───push──────► SQLite               │
   │  sync_status=pending      sync_status=synced       updated_at=serverNow │
   └─────────────────────────────────────────────────────────────────────────┘

   РАЗРЕШЕНИЕ КОНФЛИКТОВ (version-first, clock-independent):
     1. client.version > server.version  →  клиент побеждает (явная правка)
     2. client.version < server.version  →  сервер побеждает (более свежая)
     3. client.version = server.version  →  сравниваем updated_at (tiebreaker)
     4. change_log                       →  ВСЕГДА мержим (union всех правок)
     5. photo                            →  берём непустое (сохраняем оба)
     6. is_deleted = 1                   →  всегда применяем (удаление = закон)

   ЦИКЛ СИНХРОНИЗАЦИИ:
     pull() → merge() → push()
     │         │         └── pending-записи уходят на сервер
     │         └── сервер побеждает где версия выше, change_log мержится
     └── pending-записи ЗАЩИЩЕНЫ от перезаписи (Rule: pending beats pull)

   ИСТОРИЯ ИЗМЕНЕНИЙ (change_log):
     - Хранится в поле JSON самой записи → синхронизируется автоматически
     - Каждое устройство добавляет свои записи
     - При merge: объединяем все записи, дедупликация по (ts + device + version)
     - На любом устройстве видна полная история со всех устройств
*/
(function () {
  "use strict";

  const STORE_ORDER = [
    "owners", "pets", "items", "visits", "visit_items", "vaccinations", "staff", "appointments",
    "warehouses", "stock_movements",
    // attachments — метаданные вложений. Едут только с сервера (pull):
    // само вложение создаётся загрузкой файла через POST /attachments,
    // а не push-ом записи. Push для них не нужен.
    "attachments"
  ];

  // ── Backoff ───────────────────────────────────────────────────────────────

  var _retryCount = 0;
  const RETRY_DELAYS = [5000, 10000, 20000, 40000, 80000, 160000, 300000];

  function resetBackoff() { _retryCount = 0; }
  function nextBackoffDelay() {
    return RETRY_DELAYS[Math.min(_retryCount++, RETRY_DELAYS.length - 1)];
  }

  // ── HTTP ──────────────────────────────────────────────────────────────────

  function nativeFetch() { return window.__nativeFetch || window.fetch.bind(window); }
  function apiBase()     { return (window.VetAppConfig && window.VetAppConfig.apiBase) || ""; }
  function deviceID()    { return window.VetDB ? window.VetDB.getDeviceID() : "unknown"; }

  function authToken() { return (window.VetAuth && window.VetAuth.token()) || ""; }

  async function req(method, path, body) {
    var r = await nativeFetch()(apiBase() + path, {
      method,
      headers: { "Content-Type": "application/json", "X-Bypass-Local": "1",
                 "X-Device-ID": deviceID(), "X-Auth-Token": authToken() },
      body: body !== undefined ? JSON.stringify(body) : undefined,
    });
    if (r.status === 401) {
      // Токен протух на сервере: локальная работа продолжается,
      // синхронизация встанет до нового входа.
      if (window.VetAuth) window.VetAuth.invalidateToken();
      throw new Error("HTTP 401 " + path);
    }
    if (!r.ok) throw new Error("HTTP " + r.status + " " + path);
    var d = await r.json();
    if (!d || d.status !== "ok") throw new Error((d && d.message) || "Server error");
    return d.data;
  }

  // ── Last sync timestamp ───────────────────────────────────────────────────

  async function getLastSync() {
    try { return (await window.VetDB.getSyncState("last_sync")) || ""; }
    catch (e) { return ""; }
  }
  async function setLastSync(ts) {
    try { await window.VetDB.setSyncState("last_sync", ts || new Date().toISOString()); }
    catch (e) { console.error("[Sync] setLastSync:", e); }
  }

  // ══════════════════════════════════════════════════════════════════════════
  // PUSH  —  отправка pending-записей на сервер
  // ══════════════════════════════════════════════════════════════════════════

  async function pushSync() {
    // Собираем pending по всем сторам
    var payload = { device_id: deviceID() };
    var hasPending = false;

    for (var store of STORE_ORDER) {
      var all     = await window.VetDB.getAll(store);
      var pending = all.filter(function (r) { return r.sync_status === "pending"; });
      payload[store] = pending;
      if (pending.length) hasPending = true;
    }

    if (!hasPending) return { pushed: 0 };

    try {
      var result = await req("POST", "/sync/push", payload);

      // Помечаем всё как synced — даже skipped.
      // Причина: если сервер skipped (его версия выше) → следующий pull
      // принесёт серверную версию и Rule 3 её применит.
      // Если оставить pending → Rule 1 заблокирует pull навсегда.
      for (var store of STORE_ORDER) {
        for (var r of (payload[store] || [])) {
          await window.VetDB.markSynced(store, r.id);
        }
      }

      if ((result.skipped || 0) > 0) {
        console.info("[Sync] push: %d skipped → pull will resolve", result.skipped);
      }
      return { pushed: result.accepted || 0, skipped: result.skipped || 0 };

    } catch (err) {
      // Fallback: поштучно через REST (без photo — petPayload его не принимает)
      console.warn("[Sync] bulk push failed, fallback:", err.message);
      var pushed = 0;
      for (var store of STORE_ORDER) {
        for (var r of (payload[store] || [])) {
          try { await _legacyPush(store, r); pushed++; }
          catch (e) { console.error("[Sync] legacy push:", store, r.id, e.message); }
        }
      }
      return { pushed, fallback: true };
    }
  }

  const SYNC_META = new Set([
    "sync_status","server_id","created_at","updated_at","deleted_at","is_deleted","device_id","version"
  ]);
  const REST_PATH = {
    owners:"/owners", pets:"/pets", items:"/items", visits:"/visits",
    visit_items:"/visit-items", vaccinations:"/vaccinations", staff:"/staff",
    appointments:"/appointments"
  };

  async function _legacyPush(store, record) {
    var base = REST_PATH[store];
    if (!base) return;
    if (record.is_deleted) {
      await req("DELETE", base + "/" + record.id);
    } else {
      var body = {};
      for (var k of Object.keys(record)) {
        if (!SYNC_META.has(k)) body[k] = record[k];
      }
      // photo убираем из legacy REST (petPayload не принимает)
      if (store === "pets") delete body.photo;
      try { await req("PUT", base + "/" + record.id, body); }
      catch (e) { await req("POST", base, body); }
    }
    await window.VetDB.markSynced(store, record.id);
  }

  // ══════════════════════════════════════════════════════════════════════════
  // PULL  —  получение данных с сервера и умный merge
  // ══════════════════════════════════════════════════════════════════════════

  async function pullSync() {
    var since  = await getLastSync();
    var params = "?device_id=" + encodeURIComponent(deviceID());
    if (since) params += "&since=" + encodeURIComponent(since);
    try {
      var data = await req("GET", "/sync/pull" + params);
      await mergeAll(data);
      await setLastSync(data.server_time || new Date().toISOString());
      return { pulled: countPulled(data), incremental: true };
    } catch (e) {
      console.warn("[Sync] incremental pull failed:", e.message);
      return pullFull();
    }
  }

  // Полная загрузка (bootstrap и fallback): без since — получаем ВСЁ
  async function pullFull() {
    try {
      var data = await req("GET", "/sync/pull?device_id=" + encodeURIComponent(deviceID()));
      await mergeAll(data);
      await setLastSync(data.server_time || new Date().toISOString());
      return { pulled: countPulled(data), incremental: false };
    } catch (e) {
      console.warn("[Sync] full pull failed:", e.message);
      return { pulled: 0, error: e.message };
    }
  }

  async function mergeAll(data) {
    for (var store of STORE_ORDER) {
      await mergePulledStore(store, data[store] || []);
    }
  }

  function countPulled(data) {
    return STORE_ORDER.reduce(function (n, k) { return n + (data[k] || []).length; }, 0);
  }

  // ══════════════════════════════════════════════════════════════════════════
  // MERGE  —  умное слияние серверных и локальных данных
  //
  // Правило 0 — удаление (remote.is_deleted=1):
  //   Всегда применяем. Удалённые данные должны удалиться везде.
  //
  // Правило 1 — pending (local.sync_status='pending'):
  //   Локальная запись ожидает отправки → НЕ перезаписываем основные поля.
  //   НО: change_log и photo мержим — не теряем историю/фото с другого устройства.
  //
  // Правило 2 — version comparison:
  //   remote.version > local.version  → сервер применяем (более свежая правка)
  //   remote.version < local.version  → пропускаем (у нас свежее)
  //   remote.version = local.version  → tiebreaker: remote.updated_at vs local.updated_at
  //
  // Спецполя всегда мержатся независимо от победителя:
  //   change_log: объединяем все записи истории (union by ts+device+version)
  //   photo: берём непустое из обоих
  // ══════════════════════════════════════════════════════════════════════════

  async function mergePulledStore(storeName, remoteRecords) {
    if (!Array.isArray(remoteRecords) || !remoteRecords.length) return;

    var localAll  = await window.VetDB.getAll(storeName);
    var localByID = new Map(localAll.map(function (r) { return [r.id, r]; }));

    var toSave = [];
    var toSavePending = []; // pending-записи которым нужно смержить спецполя
    var toDelete = []; // IDs для физического удаления из IndexedDB

    remoteRecords.forEach(function (remote) {
      var local = localByID.get(remote.id);

      // ── Правило 0: удаление ────────────────────────────────────────────────
      // Удаление имеет наивысший приоритет — всегда применяем независимо от pending/версий.
      // Вместо soft-флага делаем HARD DELETE из IndexedDB — 100% гарантия удаления.
      // После hardDelete запись исчезает из getAll() → readStore не покажет её никогда.
      if (remote.is_deleted === 1 || remote.is_deleted === true) {
        toDelete.push(remote.id);
        return;
      }

      // ── Правило 1: pending — защищаем, но мержим спецполя ─────────────────
      if (local && local.sync_status === "pending") {
        var patched = _mergeSpecialFields(local, remote, storeName);
        if (patched) toSave.push(patched);
        return;
      }

      // ── Правило 2: version comparison ──────────────────────────────────────
      var remoteVersion = remote.version  || 1;
      var localVersion  = local ? (local.version || 1) : 0;

      var serverWins;
      if (remoteVersion > localVersion) {
        serverWins = true;
      } else if (remoteVersion < localVersion) {
        serverWins = false;
      } else {
        // Tiebreaker: сравниваем updated_at
        var rt = remote.updated_at ? new Date(remote.updated_at) : new Date(0);
        var lt = local && local.updated_at ? new Date(local.updated_at) : new Date(0);
        serverWins = rt >= lt; // >= чтобы принять одновременные правки
      }

      if (serverWins) {
        var saved = Object.assign({}, remote, { sync_status: "synced" });
        // Мержим спецполя: берём лучшее из обоих
        if (local) {
          if (storeName === "visits" && local.change_log) {
            saved.change_log = mergeChangeLogs(local.change_log, remote.change_log);
          }
          if (storeName === "pets") {
            saved.photo = _betterPhoto(local.photo, remote.photo);
          }
        }
        toSave.push(saved);
      } else {
        // Локальная версия новее — пропускаем серверную для основных полей,
        // но мержим спецполя чтобы не потерять историю/фото с сервера
        var patched = _mergeSpecialFields(local, remote, storeName);
        if (patched) toSave.push(patched);
      }
    });

    // Pending-записи с обновлёнными спецполями — сохраняем БЕЗ изменения sync_status
    if (toSavePending.length) {
      await window.VetDB.bulkSave(storeName, toSavePending); // без opts — sync_status не меняется
    }

    // Физически удаляем записи с is_deleted=1 — гарантированное исчезновение из UI.
    // hardDelete убирает запись из IndexedDB полностью — readStore не найдёт её.
    if (toDelete.length) {
      for (var delId of toDelete) {
        try { await window.VetDB.hardDelete(storeName, delId); } catch(e) { /* ignore */ }
      }
      // Сбрасываем кэш для этого стора и связанных
      if (window._syncCacheInvalidate) window._syncCacheInvalidate(storeName);
    }

    if (toSave.length) {
      await window.VetDB.bulkSave(storeName, toSave, { sync_status: "synced" });
    }
  }

  // Применяем только спецполя (change_log, photo) не трогая основные данные
  function _mergeSpecialFields(local, remote, storeName) {
    var changed = false;
    var updated = Object.assign({}, local);

    if (storeName === "visits" && remote.change_log) {
      var merged = mergeChangeLogs(local.change_log, remote.change_log);
      if (merged !== (local.change_log || "")) {
        updated.change_log = merged;
        changed = true;
      }
    }
    if (storeName === "pets" && remote.photo) {
      var photo = _betterPhoto(local.photo, remote.photo);
      if (photo !== (local.photo || "")) {
        updated.photo = photo;
        changed = true;
      }
    }
    return changed ? updated : null;
  }

  // photo: предпочитаем удалённое если оба непусты (сервер = master)
  // если одно пустое — берём непустое
  function _betterPhoto(localPhoto, remotePhoto) {
    if (remotePhoto && remotePhoto.length > 10) return remotePhoto;
    if (localPhoto  && localPhoto.length  > 10) return localPhoto;
    return remotePhoto || localPhoto || "";
  }

  // ══════════════════════════════════════════════════════════════════════════
  // MERGE CHANGE_LOG  —  слияние истории изменений
  //
  // История хранится в поле change_log самой записи в виде JSON-массива.
  // Это означает что она синхронизируется вместе с данными — никакой
  // отдельной таблицы не нужно.
  //
  // Алгоритм merge:
  //   1. Парсим оба массива
  //   2. Объединяем (union)
  //   3. Дедупликация по ключу (ts + device + version)
  //   4. Сортируем по version DESC, потом ts DESC
  //   5. Оставляем максимум 30 записей
  // ══════════════════════════════════════════════════════════════════════════

  function mergeChangeLogs(localLog, remoteLog) {
    var local  = _parseLog(localLog);
    var remote = _parseLog(remoteLog);

    if (!local.length && !remote.length) return localLog || remoteLog || "";

    var seen   = {};
    var merged = [];

    local.concat(remote).forEach(function (e) {
      // Ключ: время + устройство + версия (все три для уникальности)
      var key = [(e.ts || ""), (e.device || ""), (e.version || "")].join("|");
      if (!seen[key]) {
        seen[key] = true;
        merged.push(e);
      }
    });

    // Сортируем: по version DESC (более поздние правки наверху), потом по ts
    merged.sort(function (a, b) {
      var vb = b.version || 0, va = a.version || 0;
      if (vb !== va) return vb - va;
      return (b.ts || "") > (a.ts || "") ? 1 : -1;
    });

    if (merged.length > 30) merged = merged.slice(0, 30);
    return JSON.stringify(merged);
  }

  function _parseLog(log) {
    if (!log) return [];
    try {
      var a = JSON.parse(log);
      return Array.isArray(a) ? a : [];
    } catch (e) { return []; }
  }

  // ══════════════════════════════════════════════════════════════════════════
  // BOOTSTRAP & SYNC CYCLE
  // ══════════════════════════════════════════════════════════════════════════

  // Bootstrap: полная загрузка при старте приложения
  async function bootstrap() {
    // Всегда пробуем pullFull — даже если navigator.onLine=false.
    // На Android в локальной сети (без интернета) navigator.onLine может быть false,
    // хотя сервер в LAN доступен. Если сервер недоступен — просто получим ошибку.
    try { await pullFull(); }
    catch (e) { console.warn("[Sync] bootstrap pullFull failed:", e.message); }
    var counts = {};
    for (var store of STORE_ORDER) {
      counts[store] = (await window.VetDB.getAll(store)).length;
    }
    return counts;
  }

  // Полный цикл: pull → push
  // pull первым чтобы:
  //   а) pending-записи защищены от перезаписи при pull (Rule 1)
  //   б) push после pull отправляет самые актуальные pending-данные
  // ── Очередь вложений ──────────────────────────────────────────────────────
  //
  // Файл, снятый офлайн, лежит в attachment_queue вместе с Blob и ждёт сети.
  // Это единственное место, где планшет держит сам файл, поэтому запись из
  // очереди удаляется только после подтверждения сервера.
  //
  // id вложения генерируется на планшете заранее и отправляется вместе с файлом:
  // без него повторная отправка (сеть отвалилась после приёма файла, но до ответа)
  // создала бы на сервере второй такой же скан.

  async function queueAttachment(entry) {
    return window.VetDB.putRaw("attachment_queue", entry);
  }

  async function pushAttachments() {
    var queue = await window.VetDB.getAllRaw("attachment_queue");
    var pending = queue.filter(function (q) { return q.status !== "done"; });
    if (!pending.length) return { uploaded: 0, failed: 0 };

    var uploaded = 0, failed = 0;
    for (var entry of pending) {
      try {
        var fd = new FormData();
        fd.append("id", entry.id);
        fd.append("visit_id", entry.visit_id);
        fd.append("kind", entry.kind || "other");
        fd.append("notes", entry.notes || "");
        fd.append("device_id", deviceID());
        fd.append("file", entry.blob, entry.file_name || "scan");

        var resp = await nativeFetch()(apiBase() + "/attachments", {
          method: "POST",
          headers: { "X-Bypass-Local": "1", "X-Auth-Token": authToken() },
          body: fd,
        });
        if (!resp.ok) {
          var msg = await resp.text();
          // 4xx — файл не примут и со второй попытки (не тот тип, слишком большой,
          // приём удалён). Держать такое в очереди вечно бессмысленно: помечаем
          // ошибкой, чтобы врач увидел причину и решил сам.
          if (resp.status >= 400 && resp.status < 500) {
            entry.status = "error";
            entry.last_error = msg.slice(0, 300);
            await window.VetDB.putRaw("attachment_queue", entry);
            failed++;
            continue;
          }
          throw new Error("HTTP " + resp.status);
        }
        var body = await resp.json();
        // Метаданные сразу кладём локально: врач увидит вложение в карточке,
        // не дожидаясь следующего pull.
        if (body && body.data) {
          await window.VetDB.bulkSave("attachments", [body.data], { markSynced: true });
        }
        await window.VetDB.deleteRaw("attachment_queue", entry.id);
        uploaded++;
      } catch (e) {
        // Сеть или сервер — оставляем в очереди до следующей попытки.
        console.warn("[Sync] вложение не отправлено:", entry.id, e.message);
        entry.retry_count = (entry.retry_count || 0) + 1;
        entry.last_error = e.message;
        await window.VetDB.putRaw("attachment_queue", entry);
        failed++;
      }
    }
    return { uploaded: uploaded, failed: failed };
  }

  async function syncAll() {
    // 1. Pull: получаем актуальное с сервера (pending-записи защищены Rule 1)
    var pulled = await pullSync();
    // 2. Push: отправляем локальные изменения (включая удаления)
    var pushed = await pushSync();
    // 2a. Отправляем файлы, снятые офлайн. После push визитов — иначе сервер
    //     отклонит вложение к приёму, которого у него ещё нет.
    var attachments = await pushAttachments();
    // 3. Pull снова: если push отправил удаления/изменения, сервер их принял.
    //    Второй pull получит подтверждение (is_deleted=1 и т.д.) без since-фильтра
    //    чтобы гарантированно не пропустить удалённые записи.
    //    Используем pullFull (без since) только если был push с изменениями.
    if (pushed.pushed > 0 || pushed.fallback) {
      try { await pullFull(); } catch(e) { /* не критично */ }
    }
    return { pulled, pushed, attachments };
  }

  // ── Проверка связи ────────────────────────────────────────────────────────

  async function checkServerReachable() {
    try {
      var r = await nativeFetch()(apiBase() + "/health", {
        method: "HEAD",
        headers: { "X-Bypass-Local": "1" },
        signal: AbortSignal.timeout(3000),
      });
      return r.ok;
    } catch (e) { return false; }
  }

  // ── Public API ────────────────────────────────────────────────────────────

  window.VetSync = {
    bootstrap,
    syncAll,
    pushSync,
    pullSync,
    pullFull,
    mergePulledStore,
    mergeChangeLogs,
    getLastSync,
    checkServerReachable,
    resetBackoff,
    queueAttachment,
    pushAttachments,
    nextBackoffDelay,
  };

}());
