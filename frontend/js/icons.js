/**
 * VetIcons — единый набор иконок приложения.
 * ════════════════════════════════════════════════════════════════
 * Зачем: раньше SVG вставлялись руками в каждое место использования,
 * а часть интерфейса рисовалась эмодзи (📋 📞 🖨) — они выглядят по-разному
 * на каждом Android, не красятся в цвет темы и не масштабируются со шрифтом.
 * Теперь иконка описана один раз здесь и берётся по имени.
 *
 * Стиль: штриховые, viewBox 24×24, stroke=currentColor — иконка наследует
 * цвет текста родителя и работает в любой теме без правок.
 *
 * Использование:
 *   • в JS-разметке:   VetIcons.get('phone')
 *   • в статическом HTML: <i data-icon="phone"></i> — подменяется при загрузке
 *   • размер:          VetIcons.get('phone', {size: 20, cls: 'nav-icon'})
 *
 * Библиотека не подключается намеренно: проект офлайн-first и без сборки,
 * внешний CDN недопустим (см. PROJECT_RULES).
 */
(function () {
  "use strict";

  // Пути иконок. Ключ — имя, значение — содержимое <svg>.
  // Все нарисованы в одной сетке 24×24 со скруглёнными концами линий.
  var PATHS = {
    // ── Навигация ──────────────────────────────────────────────────
    grid:      '<rect x="3" y="3" width="7" height="7" rx="1.5"/><rect x="14" y="3" width="7" height="7" rx="1.5"/><rect x="3" y="14" width="7" height="7" rx="1.5"/><rect x="14" y="14" width="7" height="7" rx="1.5"/>',
    clipboard: '<path d="M9 5H7a2 2 0 0 0-2 2v12a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V7a2 2 0 0 0-2-2h-2"/><rect x="9" y="3" width="6" height="4" rx="2"/><path d="M9 12h6M9 16h4"/>',
    users:     '<path d="M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2"/><circle cx="9" cy="7" r="4"/><path d="M22 21v-2a4 4 0 0 0-3-3.87M16 3.13a4 4 0 0 1 0 7.75"/>',
    paw:       '<ellipse cx="8" cy="7" rx="1.8" ry="2.4"/><ellipse cx="16" cy="7" rx="1.8" ry="2.4"/><ellipse cx="4.5" cy="12" rx="1.7" ry="2.1"/><ellipse cx="19.5" cy="12" rx="1.7" ry="2.1"/><path d="M12 12.5c-2.6 0-4.7 2-4.7 4.3 0 1.8 1.3 3 3 3 .9 0 1.3-.4 1.7-.4s.8.4 1.7.4c1.7 0 3-1.2 3-3 0-2.3-2.1-4.3-4.7-4.3z"/>',
    syringe:   '<path d="m18 2 4 4M17 7l3-3M9 15l6-6M14 4l6 6-9 9H5v-6z"/><path d="m11 7 6 6"/>',
    box:       '<path d="M21 8v8a2 2 0 0 1-1 1.73l-7 4a2 2 0 0 1-2 0l-7-4A2 2 0 0 1 3 16V8a2 2 0 0 1 1-1.73l7-4a2 2 0 0 1 2 0l7 4A2 2 0 0 1 21 8z"/><path d="m3.3 7 8.7 5 8.7-5M12 22V12"/>',
    chart:     '<path d="M3 3v16a2 2 0 0 0 2 2h16"/><path d="M7 15l3.5-3.5 2.5 2.5L19 8"/>',
    settings:  '<circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 1 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 1 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06A1.65 1.65 0 0 0 9 4.6a1.65 1.65 0 0 0 1-1.51V3a2 2 0 1 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06A1.65 1.65 0 0 0 19.4 9v.09a1.65 1.65 0 0 0 1.51 1H21a2 2 0 1 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z"/>',
    hospital:  '<path d="M3 21h18M5 21V7l7-4 7 4v14"/><path d="M12 9v6M9 12h6"/>',
    stethoscope: '<path d="M4 3v6a5 5 0 0 0 10 0V3"/><path d="M4 3H2m12 0h-2M9 14v2a5 5 0 0 0 10 0v-1"/><circle cx="19" cy="12" r="2.5"/>',

    // ── Действия ───────────────────────────────────────────────────
    search:   '<circle cx="11" cy="11" r="7"/><path d="m20 20-3.5-3.5"/>',
    plus:     '<path d="M12 5v14M5 12h14"/>',
    x:        '<path d="M18 6 6 18M6 6l12 12"/>',
    check:    '<path d="m20 6-11 11-5-5"/>',
    edit:     '<path d="M17 3a2.83 2.83 0 1 1 4 4L7.5 20.5 2 22l1.5-5.5z"/><path d="m15 5 4 4"/>',
    trash:    '<path d="M3 6h18M8 6V4a1 1 0 0 1 1-1h6a1 1 0 0 1 1 1v2"/><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6"/><path d="M10 11v6M14 11v6"/>',
    download: '<path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><path d="M7 10l5 5 5-5M12 15V3"/>',
    upload:   '<path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><path d="M17 8l-5-5-5 5M12 3v12"/>',
    printer:  '<path d="M6 9V3h12v6"/><path d="M6 18H4a2 2 0 0 1-2-2v-5a2 2 0 0 1 2-2h16a2 2 0 0 1 2 2v5a2 2 0 0 1-2 2h-2"/><rect x="6" y="14" width="12" height="8" rx="1"/>',
    refresh:  '<path d="M21 12a9 9 0 1 1-3-6.7L21 8"/><path d="M21 3v5h-5"/>',
    camera:   '<path d="M23 19a2 2 0 0 1-2 2H3a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h3l2-3h8l2 3h3a2 2 0 0 1 2 2z"/><circle cx="12" cy="13" r="4"/>',
    folder:   '<path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z"/>',

    // ── Данные приёма ──────────────────────────────────────────────
    phone:    '<path d="M22 16.9v3a2 2 0 0 1-2.2 2 19.8 19.8 0 0 1-8.6-3.1 19.5 19.5 0 0 1-6-6A19.8 19.8 0 0 1 2.1 4.2 2 2 0 0 1 4.1 2h3a2 2 0 0 1 2 1.7c.1.9.4 1.8.7 2.7a2 2 0 0 1-.5 2.1L8.1 9.9a16 16 0 0 0 6 6l1.4-1.2a2 2 0 0 1 2.1-.5c.9.3 1.8.6 2.7.7a2 2 0 0 1 1.7 2z"/>',
    pin:      '<path d="M20 10c0 6-8 12-8 12s-8-6-8-12a8 8 0 0 1 16 0z"/><circle cx="12" cy="10" r="3"/>',
    calendar: '<rect x="3" y="4" width="18" height="18" rx="2"/><path d="M16 2v4M8 2v4M3 10h18"/>',
    clock:    '<circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 2"/>',
    card:     '<rect x="2" y="5" width="20" height="14" rx="2"/><path d="M2 10h20"/>',
    cash:     '<rect x="2" y="6" width="20" height="12" rx="2"/><circle cx="12" cy="12" r="2.5"/><path d="M6 12h.01M18 12h.01"/>',
    scale:    '<path d="M12 3v18M8 21h8"/><path d="M12 6 4 9l3 5a3.5 3.5 0 0 0 6 0zM12 6l8 3-3 5a3.5 3.5 0 0 1-6 0z"/>',
    tag:      '<path d="M20.6 13.4 12 22l-9-9V4a1 1 0 0 1 1-1h9z"/><circle cx="7.5" cy="7.5" r="1.5"/>',
    key:      '<circle cx="7.5" cy="15.5" r="4.5"/><path d="M10.7 12.3 21 2m-4 4 3 3m-6-6 3 3"/>',
    microscope: '<path d="M6 18h12M8 18a5 5 0 1 0 9-3"/><path d="M10 15V6a2 2 0 0 1 2-2 2 2 0 0 1 2 2v1"/><path d="M9 6h4M12 15h3"/>',
    file:     '<path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><path d="M14 2v6h6M9 13h6M9 17h4"/>',
    alert:    '<path d="M10.3 3.9 1.8 18a2 2 0 0 0 1.7 3h17a2 2 0 0 0 1.7-3L13.7 3.9a2 2 0 0 0-3.4 0z"/><path d="M12 9v4M12 17h.01"/>',
    heart:    '<path d="M20.8 5.6a5.5 5.5 0 0 0-7.8 0L12 6.6l-1-1a5.5 5.5 0 0 0-7.8 7.8l1 1L12 22l7.8-7.6 1-1a5.5 5.5 0 0 0 0-7.8z"/>',
    user:     '<path d="M20 21v-2a4 4 0 0 0-4-4H8a4 4 0 0 0-4 4v2"/><circle cx="12" cy="7" r="4"/>',
    male:     '<circle cx="10" cy="14" r="6"/><path d="M15 9l6-6M21 3h-5M21 3v5"/>',
    female:   '<circle cx="12" cy="9" r="6"/><path d="M12 15v7M9 19h6"/>',
  };

  var DEFAULT_SIZE = 20;

  /**
   * Возвращает разметку иконки.
   * name — ключ из PATHS; неизвестное имя даёт пустую строку и предупреждение
   * в консоли (молча ломать вёрстку хуже, чем показать пустоту).
   */
  function get(name, opts) {
    var body = PATHS[name];
    if (!body) {
      console.warn("[VetIcons] неизвестная иконка:", name);
      return "";
    }
    opts = opts || {};
    var size = opts.size || DEFAULT_SIZE;
    var cls = "icon" + (opts.cls ? " " + opts.cls : "");
    return '<svg class="' + cls + '" width="' + size + '" height="' + size + '"'
      + ' viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.75"'
      + ' stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"'
      + (opts.title ? ' role="img"><title>' + opts.title + "</title>" : ">")
      + body + "</svg>";
  }

  /**
   * Подменяет <i data-icon="name"> на реальные SVG.
   * Нужна для статической разметки в index.html, где JS-вызов не вставить.
   * Вызывается при загрузке и после рендера страниц.
   */
  function hydrate(root) {
    (root || document).querySelectorAll("i[data-icon]").forEach(function (el) {
      var svg = get(el.dataset.icon, {
        size: el.dataset.iconSize ? parseInt(el.dataset.iconSize, 10) : DEFAULT_SIZE,
        cls: el.className || "",
      });
      if (svg) el.outerHTML = svg;
    });
  }

  function has(name) { return !!PATHS[name]; }

  window.VetIcons = { get: get, hydrate: hydrate, has: has, names: Object.keys(PATHS) };

  document.addEventListener("DOMContentLoaded", function () { hydrate(); });
})();
