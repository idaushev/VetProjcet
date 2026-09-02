/* actions.js — делегирование действий вместо инлайновых обработчиков.
 *
 * ЗАЧЕМ. Разметка собирается конкатенацией строк, и раньше действие писалось
 * прямо в атрибут обработчика — вызов с подставленным именем позиции
 * каталога. Это дало хранимую XSS (docs/SECURITY-AUDIT.md, находка 1): браузер
 * HTML-декодирует значение атрибута ДО того, как отдаст его JS-парсеру,
 * поэтому esc() там не защищает — &#39; снова становится апострофом и
 * разрывает строку кода. Пока хоть один инлайновый обработчик жив, CSP
 * вынуждена держать script-src 'unsafe-inline', то есть не мешает и
 * внедрённому скрипту.
 *
 * КАК. Элемент объявляет ИМЯ действия и данные:
 *
 *     <button data-act="item.delete" data-id="...">Удалить</button>
 *
 * Значения атрибутов нигде не разбираются как код — это данные, и esc()
 * для них работает штатно. Диспетчер по имени находит функцию в реестре;
 * незарегистрированное имя не делает ничего.
 *
 * СОБЫТИЯ. По умолчанию click. Иначе — data-act-on="change" (input, submit,
 * keydown, change). Можно перечислить несколько через пробел:
 * data-act-on="click keydown".
 *
 * ВЛОЖЕННОСТЬ. Ищем ближайшего предка с data-act, поэтому кнопка внутри
 * кликабельной строки перекрывает действие строки сама собой — отдельный
 * event.stopPropagation() больше не нужен. Это работает, только пока
 * инлайновых обработчиков не осталось: смешанный режим давал бы гонку
 * порядка, когда обработчик строки успевает отработать раньше делегата.
 */
(function () {
  "use strict";

  var registry = {};

  // register({ 'имя': function (el, event) {...} })
  // Имя — «сущность.действие»: item.delete, pet.card, modal.close.
  function register(map) {
    for (var name in map) {
      if (Object.prototype.hasOwnProperty.call(map, name)) registry[name] = map[name];
    }
  }

  function run(name, el, event) {
    var fn = registry[name];
    if (!fn) {
      // Не роняем интерфейс: молча ничего не делаем, но след оставляем —
      // иначе опечатка в имени превращается в «кнопка не работает» без причины.
      if (window.VetLog) window.VetLog.warn('actions', 'неизвестное действие: ' + name);
      return;
    }
    try {
      fn(el, event);
    } catch (e) {
      if (window.VetLog) window.VetLog.error('actions:' + name, e);
      else console.error('[actions] ' + name, e);
    }
  }

  function handler(type) {
    return function (event) {
      var t = event.target;
      if (!t || !t.closest) return;
      var el = t.closest('[data-act]');
      if (!el) return;
      // Элемент реагирует ровно на своё событие: у <select data-act-on="change">
      // клик по нему не должен запускать действие. Событий можно перечислить
      // несколько через пробел — значку пояснения нужны и click, и keydown,
      // чтобы он открывался не только мышью.
      var want = el.getAttribute('data-act-on') || 'click';
      if (want.indexOf(' ') >= 0) {
        if (want.split(/\s+/).indexOf(type) < 0) return;
      } else if (want !== type) return;
      if (el.disabled) return;
      if (el.getAttribute('data-act-prevent') === '1') event.preventDefault();
      run(el.getAttribute('data-act'), el, event);
    };
  }

  ['click', 'change', 'input', 'submit', 'keydown'].forEach(function (type) {
    document.addEventListener(type, handler(type));
  });

  window.VetActions = {
    register: register,
    run: run,
    // has нужен тестам и проверке покрытия: все ли имена из разметки заведены.
    has: function (name) { return !!registry[name]; },
    names: function () { return Object.keys(registry).sort(); }
  };
})();
