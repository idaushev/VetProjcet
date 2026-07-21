/**
 * VetClinic Service Worker
 * ════════════════════════════════════════════════════════════════
 * Стратегии кэширования:
 *  • Navigation (HTML)    → NetworkFirst  → cached shell → offline.html
 *  • App assets (CSS/JS)  → CacheFirst    (versioned cache)
 *  • Google Fonts CSS     → StaleWhileRevalidate (fonts cache)
 *  • Google Fonts files   → CacheFirst    (immutable, fonts cache)
 *  • API paths            → bypass        (обрабатывает app.js interceptor)
 * ════════════════════════════════════════════════════════════════
 */

// ── Версия ────────────────────────────────────────────────────────
// Поднимайте при каждом деплое → старые кэши удалятся автоматически
var APP_VERSION  = "2.48.0"; // bumped: R1 сворачивание секций приёма, R3 пресеты след. приёма (R2 врач по умолчанию уже был)
var CACHE_APP    = "vet-app-"   + APP_VERSION;  // версионированные ресурсы
var CACHE_FONTS  = "vet-fonts-1";               // шрифты (стабильный кэш)

// ── Ресурсы для предварительного кэширования (App Shell) ─────────
var PRECACHE = [
  "/",
  "/index.html",
  "/offline.html",
  "/manifest.json",
  "/css/app.css",
  "/vendor/xlsx.full.min.js",
  "/vendor/fonts/inter.css",
  // Предзагружаем только те начертания, что нужны с первого экрана;
  // остальные подтянутся и закэшируются по правилу для /vendor/.
  "/vendor/fonts/inter-cyrillic-400.woff2",
  "/vendor/fonts/inter-cyrillic-600.woff2",
  "/vendor/fonts/inter-cyrillic-700.woff2",
  "/vendor/fonts/inter-latin-400.woff2",
  "/js/icons.js",
  "/js/auth.js",
  "/js/db.js",
  "/js/sync.js",
  "/js/app.js",
  "/js/ui.js",
  "/js/pages.js",
  "/icons/icon.svg",
  "/icons/icon-192.png",
  "/icons/icon-512.png",
  "/icons/icon-192-maskable.png",
  "/icons/icon-512-maskable.png",
];

// ── API-пути — отдаём браузеру (app.js обработает через interceptor) ─
var API_PREFIXES = [
  "/health", "/sync/", "/owners", "/pets", "/items",
  "/visits", "/visit-items", "/vaccinations", "/staff",
  // Вложения не кэшируем: файлы смотрят только при наличии сети,
  // а класть мегабайтные сканы в кэш приложения ни к чему.
  "/attachments",
  "/auth/", "/users", "/authorship",
];

// ═══════════════════════════════════════════════════════════════════
// INSTALL — предварительно кэшируем app shell
// ═══════════════════════════════════════════════════════════════════
self.addEventListener("install", function (event) {
  event.waitUntil(
    caches.open(CACHE_APP).then(function (cache) {
      // cache: "reload" гарантирует свежие файлы при установке
      var requests = PRECACHE.map(function (url) {
        return new Request(url, { cache: "reload" });
      });
      return Promise.allSettled(
        requests.map(function (req) {
          return cache.add(req).catch(function (err) {
            console.warn("[SW] precache miss:", req.url, err.message);
          });
        })
      );
    }).then(function () {
      // Сразу берём управление без ожидания закрытия вкладок
      return self.skipWaiting();
    })
  );
});

// ═══════════════════════════════════════════════════════════════════
// ACTIVATE — удаляем устаревшие кэши, уведомляем клиентов
// ═══════════════════════════════════════════════════════════════════
self.addEventListener("activate", function (event) {
  event.waitUntil(
    // 1. Удалить старые версионированные кэши (не трогаем CACHE_FONTS)
    caches.keys().then(function (keys) {
      return Promise.all(
        keys.filter(function (k) {
          return k !== CACHE_APP && k !== CACHE_FONTS;
        }).map(function (k) {
          console.log("[SW] deleting old cache:", k);
          return caches.delete(k);
        })
      );
    })
    // 2. Захватить контроль над всеми открытыми вкладками
    .then(function () { return self.clients.claim(); })
    // 3. Уведомить все вкладки об обновлении
    .then(function () {
      return self.clients.matchAll({ includeUncontrolled: true, type: "window" });
    })
    .then(function (clients) {
      clients.forEach(function (client) {
        client.postMessage({
          type:    "APP_UPDATED",
          version: APP_VERSION,
          cache:   CACHE_APP,
        });
      });
    })
  );
});

// ═══════════════════════════════════════════════════════════════════
// FETCH — маршрутизация запросов
// ═══════════════════════════════════════════════════════════════════
self.addEventListener("fetch", function (event) {
  var req = event.request;
  var url;

  try {
    url = new URL(req.url);
  } catch (e) {
    return; // некорректный URL — не трогаем
  }

  // Только GET
  if (req.method !== "GET") return;

  // ── Google Fonts CSS → StaleWhileRevalidate ─────────────────────
  if (url.hostname === "fonts.googleapis.com") {
    event.respondWith(staleWhileRevalidate(req, CACHE_FONTS));
    return;
  }

  // ── Google Fonts файлы (woff2) → CacheFirst (URL иммутабельны) ──
  if (url.hostname === "fonts.gstatic.com") {
    event.respondWith(cacheFirst(req, CACHE_FONTS));
    return;
  }

  // Только наш origin для остального
  if (url.origin !== self.location.origin) return;

  // ── API → пропускаем (app.js interceptor) ──────────────────────
  var isApi = API_PREFIXES.some(function (prefix) {
    return url.pathname.startsWith(prefix);
  });
  if (isApi) return;

  // ── service-worker.js → отдаём по сети (no-cache) ──────────────
  if (url.pathname === "/service-worker.js") {
    event.respondWith(
      fetch(req, { cache: "no-store" }).catch(function () {
        return caches.match(req);
      })
    );
    return;
  }

  // ── Навигация (HTML-запросы) → NetworkFirst ─────────────────────
  if (req.mode === "navigate" || url.pathname === "/" || url.pathname === "/index.html") {
    event.respondWith(networkFirstNav(req));
    return;
  }

  // ── JS-файлы → NetworkFirst (всегда свежий код, офлайн-fallback из кэша) ─
  // ВАЖНО: CacheFirst для JS означал что планшет запускал старый код после обновлений.
  // NetworkFirst гарантирует что планшет получает актуальный sync.js, app.js и т.д.
  if (url.pathname.startsWith("/js/")) {
    event.respondWith(networkFirstAsset(req, CACHE_APP));
    return;
  }

  // ── CSS/иконки/манифест → CacheFirst (редко меняются) ─────────
  var isAsset = (
    url.pathname.startsWith("/css/")   ||
    url.pathname.startsWith("/vendor/") ||
    url.pathname.startsWith("/icons/") ||
    url.pathname === "/manifest.json"  ||
    url.pathname === "/offline.html"
  );
  if (isAsset) {
    event.respondWith(cacheFirst(req, CACHE_APP));
    return;
  }
});

// ═══════════════════════════════════════════════════════════════════
// СТРАТЕГИИ КЭШИРОВАНИЯ
// ═══════════════════════════════════════════════════════════════════

/**
 * NetworkFirst для статических ассетов (JS): сеть → обновляем кэш → при офлайн отдаём кэш.
 * В отличие от CacheFirst, всегда пробуем получить свежую версию.
 */
function networkFirstAsset(req, cacheName) {
  return fetch(req, { cache: "no-cache" }).then(function (resp) {
    if (resp.ok) {
      caches.open(cacheName).then(function (c) { c.put(req, resp.clone()); });
    }
    return resp;
  }).catch(function () {
    return caches.match(req).then(function (cached) {
      return cached || new Response("Script not available offline", { status: 503 });
    });
  });
}

/**
 * CacheFirst: сначала кэш, потом сеть.
 * Лучшее время загрузки; обновляется только при смене версии SW.
 */
function cacheFirst(req, cacheName) {
  return caches.open(cacheName).then(function (cache) {
    return cache.match(req).then(function (cached) {
      if (cached) return cached;
      return fetch(req).then(function (resp) {
        if (resp.ok) cache.put(req, resp.clone());
        return resp;
      }).catch(function () {
        return offlineFallback(req);
      });
    });
  });
}

/**
 * StaleWhileRevalidate: возвращаем кэш немедленно, обновляем в фоне.
 * Идеально для Google Fonts CSS.
 */
function staleWhileRevalidate(req, cacheName) {
  return caches.open(cacheName).then(function (cache) {
    var fetchPromise = fetch(req).then(function (resp) {
      if (resp.ok) cache.put(req, resp.clone());
      return resp;
    }).catch(function () { return null; });

    return cache.match(req).then(function (cached) {
      return cached || fetchPromise;
    });
  });
}

/**
 * NetworkFirst: сначала сеть, потом кэш.
 * Для HTML-навигации — гарантирует свежую оболочку приложения.
 */
function networkFirstNav(req) {
  return fetch(req, { cache: "no-cache" }).then(function (resp) {
    if (resp.ok) {
      caches.open(CACHE_APP).then(function (c) { c.put(req, resp.clone()); });
    }
    return resp;
  }).catch(function () {
    // Офлайн: пробуем кэш → потом offline.html
    return caches.match(req)
      .then(function (cached) { return cached || caches.match("/index.html"); })
      .then(function (cached) { return cached || caches.match("/offline.html"); })
      .then(function (cached) {
        return cached || new Response(OFFLINE_HTML, {
          status:  200,
          headers: { "Content-Type": "text/html; charset=utf-8" },
        });
      });
  });
}

/**
 * Офлайн-заглушка для ресурсов (не HTML).
 */
function offlineFallback(req) {
  if (req.destination === "image") {
    return new Response(
      '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24"><text y="18" font-size="18">📷</text></svg>',
      { headers: { "Content-Type": "image/svg+xml" } }
    );
  }
  return new Response("Ресурс недоступен офлайн", { status: 503 });
}

// ═══════════════════════════════════════════════════════════════════
// BACKGROUND SYNC — синхронизация при восстановлении сети
// ═══════════════════════════════════════════════════════════════════
self.addEventListener("sync", function (event) {
  if (event.tag === "vetclinic-sync") {
    event.waitUntil(notifyClientsToSync());
  }
});

// Периодическая фоновая синхронизация (раз в сутки)
self.addEventListener("periodicsync", function (event) {
  if (event.tag === "vetclinic-daily") {
    event.waitUntil(notifyClientsToSync());
  }
});

function notifyClientsToSync() {
  return self.clients.matchAll({ type: "window" }).then(function (clients) {
    clients.forEach(function (c) {
      c.postMessage({ type: "BACKGROUND_SYNC_TRIGGERED" });
    });
  });
}

// ═══════════════════════════════════════════════════════════════════
// СООБЩЕНИЯ ОТ ПРИЛОЖЕНИЯ
// ═══════════════════════════════════════════════════════════════════
self.addEventListener("message", function (event) {
  if (!event.data) return;

  switch (event.data.type) {
    // Немедленная активация (вызывается при подтверждении обновления)
    case "SKIP_WAITING":
      self.skipWaiting();
      break;

    // Запрос текущей версии
    case "GET_VERSION":
      if (event.source) {
        event.source.postMessage({
          type:    "VERSION",
          version: APP_VERSION,
          cache:   CACHE_APP,
        });
      }
      break;

    // Принудительная очистка кэша (для отладки)
    case "CLEAR_APP_CACHE":
      caches.delete(CACHE_APP).then(function () {
        if (event.source) event.source.postMessage({ type: "CACHE_CLEARED" });
      });
      break;
  }
});

// ═══════════════════════════════════════════════════════════════════
// ВСТРОЕННАЯ OFFLINE-СТРАНИЦА (fallback когда нет даже index.html)
// ═══════════════════════════════════════════════════════════════════
var OFFLINE_HTML = '<!DOCTYPE html><html lang="ru"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>VetClinic — Офлайн</title><style>*{box-sizing:border-box;margin:0;padding:0}body{font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;background:#f0f4f9;color:#1a2434;display:flex;align-items:center;justify-content:center;min-height:100vh;padding:24px}.card{background:#fff;border-radius:20px;padding:40px 36px;max-width:420px;width:100%;text-align:center;box-shadow:0 4px 24px rgba(12,30,60,.1)}.icon{font-size:56px;margin-bottom:20px;display:block}.title{font-size:1.4rem;font-weight:800;margin-bottom:10px;color:#1a2434}.sub{font-size:.95rem;color:#526070;line-height:1.6;margin-bottom:28px}.btn{display:inline-block;background:#1a8c5e;color:#fff;border:none;padding:13px 28px;border-radius:999px;font-size:.95rem;font-weight:700;cursor:pointer;font-family:inherit;transition:background .18s}.btn:hover{background:#14714b}.hint{margin-top:20px;font-size:.8rem;color:#5d6f81}</style></head><body><div class="card"><span class="icon">🏥</span><h1 class="title">Нет подключения к сети</h1><p class="sub">Приложение VetClinic работает офлайн. Все данные доступны локально. Синхронизация произойдёт автоматически при восстановлении соединения.</p><button class="btn" onclick="location.reload()">Попробовать снова</button><p class="hint">Если приложение было открыто ранее, данные клиентов и животных доступны без интернета.</p></div></body></html>';
