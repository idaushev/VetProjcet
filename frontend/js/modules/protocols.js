/* modules/protocols.js — конструктор протоколов и заполнение результатов.
 *
 * ЗАЧЕМ. Часть услуг заканчивается не записью в приёме, а документом: анализ
 * крови, УЗИ, рентген. Услуга в каталоге помечается флагом «требует
 * результата», и приём заводит строку ожидания. Результат — либо файл (скан,
 * PDF из лаборатории), либо заполненный вручную протокол, либо и то и другое.
 *
 * КОНСТРУКТОР. Шаблон описывает поля: ключ, подпись, тип, единица, границы
 * нормы. Нормы лежат в шаблоне, а не в коде, потому что у кошки и собаки они
 * разные, и клиника правит их сама, не дожидаясь обновления приложения.
 * Правит шаблоны только администратор (гейт на сервере), заполняет любой, кто
 * ведёт приёмы.
 *
 * Грузится ПОСЛЕ pages.js: нужен VetPagesCore и VetPages.
 */
(function () {
  "use strict";
  var UI = window.VetUI;
  var C  = window.VetPagesCore || {};
  var esc = C.esc, api = C.api, I = C.I, fmtDate = C.fmtDate,
      emptyState = C.emptyState;

  var FIELD_TYPES = [
    { v: 'number',   l: 'Число' },
    { v: 'text',     l: 'Строка' },
    { v: 'textarea', l: 'Текст' },
    { v: 'select',   l: 'Выбор из списка' },
    { v: 'check',    l: 'Галочка' }
  ];
  var KINDS = [
    { v: 'lab',        l: 'Анализы' },
    { v: 'ultrasound', l: 'УЗИ' },
    { v: 'xray',       l: 'Рентген' },
    { v: 'other',      l: 'Другое' }
  ];

  function kindLabel(k) {
    for (var i = 0; i < KINDS.length; i++) if (KINDS[i].v === k) return KINDS[i].l;
    return 'Другое';
  }

  // Разбор JSON из базы никогда не должен ронять экран: строка приходит и с
  // сервера, и из IndexedDB, и от старого клиента.
  function parseJSON(raw, fallback) {
    try {
      var v = JSON.parse(raw || '');
      return v && typeof v === 'object' ? v : fallback;
    } catch (e) {
      return fallback;
    }
  }
  function fieldsOf(tpl)  { return parseJSON(tpl && tpl.fields, []) || []; }

  // Поля ДЛЯ РЕЗУЛЬТАТА: сначала снимок, снятый при заполнении, и только потом
  // текущий шаблон. Порядок именно такой, а не наоборот: медицинская запись
  // должна читаться так, как её сделали. Клиника вправе переписать бланк —
  // поменять единицу, сузить норму, убрать показатель, — но старый результат
  // от этого не должен ни исчезнуть, ни начать врать: цифра, снятая по норме
  // 60–77, не может задним числом стать отклонением по новой границе.
  function fieldsForResult(res, tpl) {
    var snap = parseJSON(res && res.fields_snapshot, null);
    if (snap && snap.length) return snap;
    return fieldsOf(tpl);
  }

  // Снимок для записи: то же описание полей, но без пустот — их в бланке УЗИ
  // на три десятка полей набирается заметно, а снимок едет на каждый планшет
  // вместе с записью.
  function snapshotFields(fields) {
    return (fields || []).map(function (f) {
      var o = { key: f.key, label: f.label, type: f.type || 'text' };
      if (f.unit) o.unit = f.unit;
      if (f.ref_low != null) o.ref_low = f.ref_low;
      if (f.ref_high != null) o.ref_high = f.ref_high;
      if (f.options && f.options.length) o.options = f.options;
      if (f.group) o.group = f.group;
      return o;
    });
  }
  function valuesOf(res)  { return parseJSON(res && res.values_json, {}) || {}; }

  // ═══════════════════════════════════════════════════════════════════════
  // КОНСТРУКТОР ШАБЛОНОВ (Настройки, только администратор)
  // ═══════════════════════════════════════════════════════════════════════

  async function loadTemplates() {
    try {
      var all = await window.VetDB.getAll('protocol_templates');
      return (all || []).filter(function (t) { return !t.is_deleted; })
                        .sort(function (a, b) { return (a.name||'').localeCompare(b.name||'', 'ru'); });
    } catch (e) {
      if (window.VetLog) window.VetLog.warn('protocols:load', e);
      return [];
    }
  }

  async function renderTemplateList() {
    var el = document.getElementById('protocols-list');
    if (!el) return;
    var list = await loadTemplates();
    if (!list.length) {
      el.innerHTML = emptyState('Шаблонов протоколов пока нет', '+ Создать', 'protocol.add', 'clipboard');
      return;
    }
    el.innerHTML = list.map(function (t) {
      var n = fieldsOf(t).length;
      return '<div class="erow" data-act="protocol.edit" data-id="' + esc(t.id) + '">'
        + '<div class="erow-body">'
        + '<div class="erow-title">' + esc(t.name) + '</div>'
        + '<div class="erow-sub">' + esc(kindLabel(t.kind)) + ' · полей: ' + n + '</div>'
        + '</div>'
        + '<div class="erow-right"><div class="erow-actions">'
        + '<button class="btn btn-icon danger" data-act="protocol.delete" data-id="' + esc(t.id) + '"'
        + ' title="Удалить" aria-label="Удалить">' + UI.icon('trash', '') + '</button>'
        + '</div></div></div>';
    }).join('');
  }

  // Поля редактируем в памяти и сохраняем разом: протокол — цельный документ,
  // сохранять по одному полю значит плодить промежуточные версии в синке.
  var _editing = null;   // {id, name, kind, notes, fields:[]}

  function fieldRowHTML(f, i) {
    return '<div class="proto-field" data-idx="' + i + '">'
      + '<div class="form-grid">'
      + '<div class="form-group"><label class="form-label">Подпись</label>'
      + '<input class="form-input pf-label" value="' + esc(f.label || '') + '" placeholder="Гемоглобин"></div>'
      + '<div class="form-group"><label class="form-label">Тип</label>'
      + '<select class="form-select pf-type">' + FIELD_TYPES.map(function (t) {
          return '<option value="' + t.v + '"' + (f.type === t.v ? ' selected' : '') + '>' + t.l + '</option>';
        }).join('') + '</select></div>'
      + '<div class="form-group"><label class="form-label">Единица</label>'
      + '<input class="form-input pf-unit" value="' + esc(f.unit || '') + '" placeholder="г/л"></div>'
      + '<div class="form-group"><label class="form-label">Норма от / до</label>'
      + '<div class="proto-range">'
      + '<input class="form-input pf-low" type="number" step="any" value="' + esc(f.ref_low != null ? f.ref_low : '') + '" placeholder="от">'
      + '<input class="form-input pf-high" type="number" step="any" value="' + esc(f.ref_high != null ? f.ref_high : '') + '" placeholder="до">'
      + '</div></div>'
      + '<div class="form-group"><label class="form-label">Раздел</label>'
      + '<input class="form-input pf-group" value="' + esc(f.group || '') + '" placeholder="Мочевой пузырь"></div>'
      + '<div class="form-group form-span-2"><label class="form-label">Варианты (через запятую, для списка)</label>'
      + '<input class="form-input pf-options" value="' + esc((f.options || []).join(', ')) + '" placeholder="норма, снижено, повышено"></div>'
      + '</div>'
      + '<button class="btn btn-ghost btn-sm danger" data-act="protocol.fieldRemove" data-idx="' + i + '">Убрать поле</button>'
      + '</div>';
  }

  function editorHTML() {
    var t = _editing;
    return '<div class="form-grid">'
      + '<div class="form-group form-span-2"><label class="form-label">Название <span class="form-req">*</span></label>'
      + '<input id="pt-name" class="form-input" value="' + esc(t.name || '') + '" placeholder="Общий анализ крови"></div>'
      + '<div class="form-group form-span-2"><label class="form-label">Вид</label>'
      + '<select id="pt-kind" class="form-select">' + KINDS.map(function (k) {
          return '<option value="' + k.v + '"' + (t.kind === k.v ? ' selected' : '') + '>' + k.l + '</option>';
        }).join('') + '</select></div>'
      + '</div>'
      + '<div class="form-section"><div class="form-section-title">Поля протокола</div>'
      + '<div id="pt-fields">' + (t.fields.length
          ? t.fields.map(fieldRowHTML).join('')
          : '<div class="text-sm text-muted">Полей пока нет — добавьте первое.</div>') + '</div>'
      + '<button class="btn btn-ghost btn-sm" data-act="protocol.fieldAdd">+ Добавить поле</button>'
      + '</div>';
  }

  // Собираем поля из DOM: правки живут в разметке до нажатия «Сохранить».
  function collectFields() {
    var out = [];
    document.querySelectorAll('#pt-fields .proto-field').forEach(function (row) {
      var val = function (cls) { var e = row.querySelector(cls); return e ? e.value.trim() : ''; };
      var label = val('.pf-label');
      if (!label) return;                     // безымянное поле смысла не имеет
      var num = function (cls) { var v = val(cls); return v === '' ? null : Number(v); };
      var opts = val('.pf-options').split(',').map(function (x) { return x.trim(); })
                                   .filter(function (x) { return x; });
      out.push({
        // Ключ выводим из подписи один раз и больше не меняем: по нему
        // связаны уже заполненные протоколы, переименование подписи не должно
        // осиротить старые значения.
        key: (row.getAttribute('data-key') || keyFromLabel(label, out)),
        label: label,
        type: val('.pf-type') || 'text',
        // Раздел: одно поле — один тип, иначе значения нечем разобрать (норму
        // не сравнить, динамику не построить). Но орган описывают сразу
        // несколькими: у мочевого пузыря это толщина стенки числом, содержимое
        // текстом и «взвесь» галочкой. Раздел собирает их под общий заголовок,
        // и в форме это читается как один блок.
        group: val('.pf-group'),
        unit: val('.pf-unit'),
        ref_low: num('.pf-low'),
        ref_high: num('.pf-high'),
        options: opts
      });
    });
    return out;
  }

  function keyFromLabel(label, existing) {
    var base = label.toLowerCase().replace(/[^a-zа-я0-9]+/gi, '_').replace(/^_+|_+$/g, '') || 'f';
    var key = base, n = 2;
    var taken = {};
    (existing || []).forEach(function (f) { taken[f.key] = true; });
    while (taken[key]) { key = base + '_' + n; n++; }
    return key;
  }

  function templateDialog(id) {
    (async function () {
      var tpl = null;
      if (id) {
        var all = await loadTemplates();
        tpl = all.find(function (t) { return t.id === id; });
      }
      _editing = tpl
        ? { id: tpl.id, name: tpl.name, kind: tpl.kind, notes: tpl.notes || '', fields: fieldsOf(tpl) }
        : { id: '', name: '', kind: 'lab', notes: '', fields: [] };

      UI.showModal({
        title: id ? 'Шаблон: ' + tpl.name : 'Новый шаблон протокола',
        bodyHTML: editorHTML(),
        size: 'lg',
        onSave: async function () {
          var name = (document.getElementById('pt-name') || {}).value || '';
          if (!name.trim()) { UI.markInvalid(['pt-name']); UI.toast('Укажите название', 'err'); return; }
          var body = {
            name: name.trim(),
            kind: (document.getElementById('pt-kind') || {}).value || 'lab',
            fields: JSON.stringify(collectFields())
          };
          try {
            if (_editing.id) await api('PUT', '/protocols/' + _editing.id, body);
            else await api('POST', '/protocols', body);
            UI.hideModal();
            UI.toast('Шаблон сохранён', 'ok');
            await renderTemplateList();
          } catch (e) {
            UI.toast(e.message, 'err');
          }
        }
      });
    })();
  }

  // Поля добавляем/убираем прямо в открытом диалоге, сохраняя уже введённое.
  function fieldAdd() {
    _editing.fields = collectFields();
    _editing.fields.push({ key: '', label: '', type: 'number', unit: '', ref_low: null, ref_high: null, options: [] });
    _redrawFields();
  }
  function fieldRemove(idx) {
    _editing.fields = collectFields().filter(function (_, i) { return i !== idx; });
    _redrawFields();
  }
  function _redrawFields() {
    var box = document.getElementById('pt-fields');
    if (!box) return;
    box.innerHTML = _editing.fields.length
      ? _editing.fields.map(fieldRowHTML).join('')
      : '<div class="text-sm text-muted">Полей пока нет — добавьте первое.</div>';
    // Проставляем сохранённые ключи обратно в разметку: collectFields читает
    // их оттуда, иначе после перерисовки ключи сгенерировались бы заново и
    // связь с уже заполненными протоколами потерялась бы.
    box.querySelectorAll('.proto-field').forEach(function (row, i) {
      if (_editing.fields[i] && _editing.fields[i].key) {
        row.setAttribute('data-key', _editing.fields[i].key);
      }
    });
  }

  async function deleteTemplate(id) {
    var all = await loadTemplates();
    var t = all.find(function (x) { return x.id === id; });
    var ok = await UI.confirm('Удалить шаблон?', (t && t.name) || '');
    if (!ok) return;
    try {
      await api('DELETE', '/protocols/' + id);
      UI.toast('Удалено', 'ok');
      await renderTemplateList();
    } catch (e) {
      UI.toast(e.message, 'err');
    }
  }

  // ═══════════════════════════════════════════════════════════════════════
  // ЗАПОЛНЕНИЕ И ПРОСМОТР РЕЗУЛЬТАТА
  // ═══════════════════════════════════════════════════════════════════════

  // Вне нормы — то, ради чего нормы вообще хранятся: врач должен увидеть
  // отклонение, не сверяя цифры со справочником.
  function outOfRange(field, raw) {
    if (field.type !== 'number') return 0;
    var v = parseFloat(String(raw).replace(',', '.'));
    if (isNaN(v)) return 0;
    if (field.ref_low != null && v < field.ref_low) return -1;
    if (field.ref_high != null && v > field.ref_high) return 1;
    return 0;
  }

  function refText(f) {
    if (f.ref_low == null && f.ref_high == null) return '';
    if (f.ref_low != null && f.ref_high != null) return f.ref_low + '–' + f.ref_high;
    return f.ref_low != null ? 'от ' + f.ref_low : 'до ' + f.ref_high;
  }

  function fillFieldHTML(f, value) {
    var id = 'rv-' + f.key;
    var common = 'id="' + esc(id) + '" data-key="' + esc(f.key) + '" class="form-input rv-input"';
    var input;
    if (f.type === 'textarea') {
      input = '<textarea ' + common.replace('form-input', 'form-textarea') + ' rows="3">' + esc(value || '') + '</textarea>';
    } else if (f.type === 'select') {
      input = '<select ' + common.replace('form-input', 'form-select') + '>'
        + '<option value="">—</option>'
        + (f.options || []).map(function (o) {
            return '<option value="' + esc(o) + '"' + (value === o ? ' selected' : '') + '>' + esc(o) + '</option>';
          }).join('') + '</select>';
    } else if (f.type === 'check') {
      input = '<label class="form-check"><input type="checkbox" ' + common
        + (value === '1' || value === true ? ' checked' : '') + '> да</label>';
    } else {
      input = '<input ' + common + (f.type === 'number' ? ' type="number" step="any" inputmode="decimal"' : '')
        + ' value="' + esc(value != null ? value : '') + '">';
    }
    var ref = refText(f);
    return '<div class="form-group">'
      // Запятая внутри span, а не перед ним: иначе между подписью и запятой
      // вставал пробел — «Селезёнка, толщина , мм».
      + '<label class="form-label">' + esc(f.label) + (f.unit ? '<span class="text-muted">, ' + esc(f.unit) + '</span>' : '') + '</label>'
      + input
      + (ref ? '<div class="form-hint">норма ' + esc(ref) + '</div>' : '')
      + '</div>';
  }

  // Тело формы протокола — общее для двух случаев: заполнения существующего
  // результата и черновика по услуге, добавленной в ещё не сохранённый приём.
  function protocolBodyHTML(tpl, values, conclusion, labName) {
    var fields = fieldsOf(tpl);
    var body = '';
    if (fields.length) {
      var cur = null, open = false;
      fields.forEach(function (f) {
        var g = (f.group || '').trim();
        if (g !== cur) {
          if (open) { body += '</div>'; open = false; }
          cur = g;
          if (g) body += '<div class="form-section-title">' + esc(g) + '</div>';
          body += '<div class="form-grid">'; open = true;
        }
        body += fillFieldHTML(f, (values || {})[f.key]);
      });
      if (open) body += '</div>';
    } else {
      body += '<div class="text-sm text-muted">У этой услуги нет шаблона протокола — впишите заключение свободным текстом.</div>';
    }
    body += '<div class="form-section">'
      + '<div class="form-group"><label class="form-label">Лаборатория-исполнитель</label>'
      + '<input id="rv-lab" class="form-input" maxlength="120" value="' + esc(labName || '')
      + '" placeholder="Своя лаборатория / Vet Union / …"></div>'
      + '<div class="form-group">'
      + '<label class="form-label">Заключение</label>'
      + '<textarea id="rv-conclusion" class="form-textarea" rows="3">' + esc(conclusion || '') + '</textarea>'
      + '</div></div>';
    return body;
  }

  function collectProtocolValues() {
    var vals = {};
    document.querySelectorAll('.rv-input').forEach(function (el) {
      var k = el.getAttribute('data-key');
      if (!k) return;
      vals[k] = el.type === 'checkbox' ? (el.checked ? '1' : '') : el.value.trim();
    });
    return {
      values: vals,
      conclusion: (document.getElementById('rv-conclusion') || {}).value || '',
      lab_name: ((document.getElementById('rv-lab') || {}).value || '').trim(),
    };
  }

  // Протокол услуги, добавленной в приём, который ещё не сохранён. Записи
  // visit_results тогда не существует (её заводит ensureVisitResults после
  // создания приёма), поэтому собранное отдаём вызывающему — он держит это в
  // памяти до сохранения. Без этого врач, сделавший УЗИ прямо на приёме, не
  // мог записать заключение, пока не сохранит и не переоткроет приём.
  async function fillProtocolDraft(templateId, title, prev, onDone) {
    var tpls = await loadTemplates();
    var tpl = templateId ? tpls.find(function (t) { return t.id === templateId; }) : null;
    prev = prev || {};
    UI.showModal({
      stacked: true,
      title: title || 'Результат',
      bodyHTML: protocolBodyHTML(tpl, prev.values, prev.conclusion, prev.lab_name),
      size: 'lg',
      saveLabel: 'Готово',
      onSave: function () {
        var data = collectProtocolValues();
        // Вместе со значениями отдаём и описание полей: приём ещё не сохранён,
        // записи нет, и снимок поставить некуда — сделает это applyDraftResults.
        data.fields = snapshotFields(fieldsOf(tpl));
        UI.hideModal();
        if (onDone) onDone(data);
      }
    });
  }

  async function fillResult(resultId) {
    var all = await window.VetDB.getAll('visit_results');
    var res = (all || []).find(function (r) { return r.id === resultId; });
    if (!res) { UI.toast('Результат не найден', 'err'); return; }
    var tpls = await loadTemplates();
    var tpl = res.template_id ? tpls.find(function (t) { return t.id === res.template_id; }) : null;
    // VET-008 (вопрос 14): в теле формы есть и лаборатория-исполнитель —
    // при разборе спорного результата её спрашивают первой.
    // Правим в ТОМ бланке, по которому исследование делали: у заполненной
    // записи берём её снимок, а не сегодняшний шаблон.
    var fields = fieldsForResult(res, tpl);
    var body = protocolBodyHTML({ fields: JSON.stringify(fields) }, valuesOf(res), res.conclusion, res.lab_name);

    UI.showModal({
      // Поверх формы приёма, а не вместо неё: заполнение протокола вызывают
      // прямо из приёма, и замена окна уничтожила бы заполняемую форму —
      // ровно то, ради чего делался стек модалок (F2/UX-022).
      stacked: true,
      title: res.title || 'Результат',
      // Исправление уже внесённого результата называем своим именем: врач
      // должен понимать, что переписывает медицинскую запись, на которую
      // могли опереться при назначении, а не заполняет пустую форму.
      bodyHTML: (res.status === 'done'
        ? '<div class="form-hint mb-2">Результат уже внесён ' + esc(fmtWhenExact(res.filled_at))
          + '. Изменения перезапишут его; дата поступления сохранится.</div>'
        : '') + body,
      size: 'lg',
      saveLabel: res.status === 'done' ? 'Сохранить исправление' : 'Сохранить результат',
      onSave: async function () {
        var d = collectProtocolValues();
        try {
          await api('PUT', '/results/' + resultId, {
            values_json: JSON.stringify(d.values),
            // Снимок полей уходит вместе со значениями. Сервер поставит его
            // только если снимка ещё не было: правка не переписывает бланк.
            fields_snapshot: JSON.stringify(snapshotFields(fields)),
            conclusion: d.conclusion,
            lab_name: d.lab_name,
            status: 'done'
          });
          UI.hideModal();
          UI.toast(res.status === 'done' ? 'Результат исправлен' : 'Результат сохранён', 'ok');
          window.dispatchEvent(new Event('vetdata:changed'));
          // Если протокол заполняли из открытой формы приёма — обновим там
          // строку, иначе она осталась бы «ожидает результата» до перезахода.
          if (window.VetPages && VetPages.refreshVisitResults) VetPages.refreshVisitResults();
        } catch (e) {
          UI.toast(e.message, 'err');
        }
      }
    });
  }

  // Просмотр — то, ради чего всё затевалось: открыть результат из карточки
  // животного или из следующего приёма, не выходя из формы.
  async function viewResult(resultId) {
    var all = await window.VetDB.getAll('visit_results');
    var res = (all || []).find(function (r) { return r.id === resultId; });
    if (!res) { UI.toast('Результат не найден', 'err'); return; }
    UI.showModal({

      // Поверх того, откуда пришли (лента истории, контекст пациента, приём),
      // а не вместо: иначе просмотр результата уничтожал бы экран, с которого
      // его открыли, и возвращаться было бы некуда (F2/UX-022).
      stacked: true,
      title: res.title || 'Результат',
      // Правка живёт ЗДЕСЬ, а не кнопкой в списке. Результат — медицинская
      // запись: её открывают, чтобы ПОСМОТРЕТЬ (в просмотре есть нормы,
      // отклонения и динамика показателя — в форме заполнения этого нет), и
      // лишь изредка — чтобы исправить цифру или дописать заключение. Кнопка
      // правки прямо в списке провоцировала бы менять запись, не взглянув
      // на неё.
      bodyHTML: '<div class="res-actions"><button type="button" class="btn btn-ghost btn-sm"'
        + ' data-act="result.edit" data-id="' + esc(res.id) + '">Изменить результат</button></div>'
        + await resultBodyHTML(res),
      size: 'lg',
      onSave: false,
      cancelLabel: 'Закрыть'
    });
  }

  // ── VET-008: динамика показателя ─────────────────────────────────────
  //
  // Структура для этого уже была: тип, единица и референсы лежат в шаблоне,
  // значения — в values_json, отклонения подсвечивались. Не хватало ровно
  // одного — сравнения результатов между собой. Врач при ХПН открывал анализы
  // по одному и выписывал креатинин на бумагу, чтобы понять, растёт ли он.
  //
  // Ряд собираем по ЖИВОТНОМУ и КЛЮЧУ ПОЛЯ, а не по шаблону: клиника может
  // завести второй бланк «Биохимия (расширенная)», и креатинин в нём — тот же
  // показатель. Единицу берём из шаблона своего результата: если она разошлась,
  // точку в ряд не берём — сравнивать ммоль/л с мг/дл нельзя.
  async function seriesFor(petId, fieldKey, unit) {
    var all = await window.VetDB.getAll('visit_results');
    var tpls = await loadTemplates();
    var byId = {};
    tpls.forEach(function (t) { byId[t.id] = t; });

    var pts = [];
    (all || []).forEach(function (r) {
      if (r.is_deleted || r.pet_id !== petId) return;
      if (r.status && r.status === 'pending') return;   // ещё не внесён
      var tpl = r.template_id ? byId[r.template_id] : null;
      // По снимку КАЖДОГО результата: точку в ряд берём с той единицей, с
      // какой её и записали, а не с сегодняшней из справочника.
      var f = fieldsForResult(r, tpl).find(function (x) { return x.key === fieldKey; });
      if (!f) return;
      if ((f.unit || '') !== (unit || '')) return;      // разные единицы не смешиваем
      var raw = valuesOf(r)[fieldKey];
      var v = Number(raw);
      if (raw == null || raw === '' || isNaN(v)) return;
      pts.push({ id: r.id, v: v, when: r.filled_at || r.created_at || '', field: f });
    });
    pts.sort(function (a, b) { return (a.when || '') > (b.when || '') ? 1 : -1; });
    return pts;
  }

  // График ряда с полосой нормы. Полоса важнее самой линии: «6.2» ничего не
  // говорит, а «6.2 при норме до 5.0 и было 4.8» говорит всё.
  function seriesChartHTML(pts, f) {
    if (pts.length < 2) return '';
    var W = 520, H = 110, padX = 44, padY = 14;
    var vals = pts.map(function (p) { return p.v; });
    // Подписи осей — НАСТОЯЩИЕ границы данных и нормы, а не служебные значения
    // после отступа: иначе врач читает «194.05» там, где в анализе стоит 196.
    var loLabel = Math.min.apply(null, vals), hiLabel = Math.max.apply(null, vals);
    if (f.ref_low  != null) loLabel = Math.min(loLabel, Number(f.ref_low));
    if (f.ref_high != null) hiLabel = Math.max(hiLabel, Number(f.ref_high));
    var lo = loLabel, hi = hiLabel;
    var range = (hi - lo) || 1;
    lo -= range * 0.08; hi += range * 0.08; range = hi - lo;
    var n = pts.length;
    function x(i) { return padX + (W - 2 * padX) * (n === 1 ? 0.5 : i / (n - 1)); }
    function y(v) { return padY + (H - 2 * padY) * (1 - (v - lo) / range); }

    var band = '';
    if (f.ref_low != null || f.ref_high != null) {
      var yTop = f.ref_high != null ? y(Number(f.ref_high)) : padY;
      var yBot = f.ref_low  != null ? y(Number(f.ref_low))  : H - padY;
      band = '<rect x="' + padX + '" y="' + yTop.toFixed(1) + '" width="' + (W - 2 * padX)
           + '" height="' + Math.max(1, yBot - yTop).toFixed(1) + '" class="res-band"/>';
    }
    var line = pts.map(function (p, i) { return (i ? 'L' : 'M') + x(i).toFixed(1) + ' ' + y(p.v).toFixed(1); }).join(' ');
    var dots = pts.map(function (p, i) {
      var flag = outOfRange(f, p.v);
      var c = flag ? 'var(--danger)' : 'var(--accent)';
      return '<circle cx="' + x(i).toFixed(1) + '" cy="' + y(p.v).toFixed(1) + '" r="3.5" fill="' + c + '"/>';
    }).join('');
    return '<svg viewBox="0 0 ' + W + ' ' + H + '" class="res-chart" preserveAspectRatio="none">'
      + band
      + '<text x="2" y="' + (y(hiLabel) + 4).toFixed(1) + '" class="ws-axis">' + round2(hiLabel) + '</text>'
      + '<text x="2" y="' + (y(loLabel) + 4).toFixed(1) + '" class="ws-axis">' + round2(loLabel) + '</text>'
      + '<path d="' + line + '" fill="none" stroke="var(--accent)" stroke-width="2" stroke-linejoin="round"/>'
      + dots + '</svg>';
  }

  function round2(v) { return Math.round(Number(v) * 100) / 100; }

  function fmtWhen(s) {
    if (!s) return '—';
    try { return new Date(s).toLocaleDateString('ru-RU'); } catch (e) { return String(s).slice(0, 10); }
  }

  // Со временем. Для следа исправления одной даты мало: описку замечают через
  // час, и «внесён 03.09, исправлен 03.09» не говорит ничего.
  function fmtWhenExact(s) {
    if (!s) return '—';
    try {
      var d = new Date(s);
      return d.toLocaleDateString('ru-RU') + ' в ' + d.toLocaleTimeString('ru-RU', { hour: '2-digit', minute: '2-digit' });
    } catch (e) { return String(s).slice(0, 16); }
  }

  // Разворачивается прямо под строкой показателя: результат остаётся на экране,
  // и врач видит цифру и её историю одновременно. Отдельным окном это потребовало
  // бы стека модалок, которого пока нет (F2/UX-022).
  async function toggleSeries(resultId, fieldKey) {
    var row = document.getElementById('res-series-' + fieldKey);
    if (!row) return;
    if (row.dataset.open === '1') {
      row.dataset.open = '0';
      row.innerHTML = '';
      row.style.display = 'none';
      return;
    }
    var all = await window.VetDB.getAll('visit_results');
    var res = (all || []).find(function (r) { return r.id === resultId; });
    if (!res) return;
    var tpls = await loadTemplates();
    var tpl = res.template_id ? tpls.find(function (t) { return t.id === res.template_id; }) : null;
    var f = fieldsForResult(res, tpl).find(function (x) { return x.key === fieldKey; });
    if (!f) return;

    var pts = await seriesFor(res.pet_id, fieldKey, f.unit);
    var cell = row.querySelector('td');
    var html;
    if (pts.length < 2) {
      html = '<div class="res-series-empty">Это первое измерение показателя — сравнивать пока не с чем.</div>';
    } else {
      html = seriesChartHTML(pts, f)
        + '<table class="res-series-table"><tbody>'
        + pts.slice().reverse().map(function (p, i, arr) {
            var prev = arr[i + 1];
            var d = prev ? round2(p.v - prev.v) : null;
            var flag = outOfRange(f, p.v);
            var cls = flag > 0 ? 'res-high' : (flag < 0 ? 'res-low' : '');
            var delta = d === null ? '' : (d > 0 ? '+' + d : (d < 0 ? String(d) : '='));
            return '<tr' + (p.id === resultId ? ' class="res-series-cur"' : '') + '>'
              + '<td>' + esc(fmtWhen(p.when)) + '</td>'
              + '<td class="' + cls + '">' + round2(p.v) + (f.unit ? ' ' + esc(f.unit) : '') + '</td>'
              + '<td class="text-muted">' + esc(delta) + '</td></tr>';
          }).join('')
        + '</tbody></table>';
    }
    cell.innerHTML = html;
    row.dataset.open = '1';
    row.style.display = '';
  }

  // Результат считаем исправленным, если запись меняли ЗАМЕТНО позже внесения.
  // Минута запаса — на разницу часов планшета и сервера и на то, что синк
  // проставляет updated_at своим временем: иначе «исправлен» загоралось бы у
  // каждого только что заполненного протокола.
  function wasCorrected(res) {
    if (!res.filled_at || !res.updated_at) return false;
    var f = new Date(res.filled_at).getTime(), u = new Date(res.updated_at).getTime();
    return isFinite(f) && isFinite(u) && (u - f) > 60000;
  }

  async function resultBodyHTML(res) {
    var tpls = await loadTemplates();
    var tpl = res.template_id ? tpls.find(function (t) { return t.id === res.template_id; }) : null;
    var fields = fieldsForResult(res, tpl);
    var values = valuesOf(res);
    var html = '';

    if (fields.length) {
      // VET-008: предыдущее значение считаем заранее — по одному ряду на поле.
      var prevByKey = {};
      for (var fi = 0; fi < fields.length; fi++) {
        var ff = fields[fi];
        if (ff.type && ff.type !== 'number') continue;
        var series = await seriesFor(res.pet_id, ff.key, ff.unit);
        // Предыдущая точка — последняя, что РАНЬШЕ текущего результата.
        var curWhen = res.filled_at || res.created_at || '';
        var earlier = series.filter(function (p) { return p.id !== res.id && (p.when || '') < curWhen; });
        prevByKey[ff.key] = { prev: earlier.length ? earlier[earlier.length - 1] : null, count: series.length };
      }

      html += '<table class="res-table"><thead><tr><th>Показатель</th><th>Значение</th>'
            + '<th>Было</th><th>Норма</th></tr></thead><tbody>';
      html += fields.map(function (f) {
        var v = values[f.key];
        var flag = outOfRange(f, v);
        var cls = flag > 0 ? 'res-high' : (flag < 0 ? 'res-low' : '');
        var mark = flag > 0 ? ' ↑' : (flag < 0 ? ' ↓' : '');
        var info = prevByKey[f.key] || {};
        // «Было» — не просто прошлая цифра, а НАПРАВЛЕНИЕ: врачу важно, растёт
        // ли креатинин, а не какое именно число было в марте.
        var wasCell = '—';
        if (info.prev) {
          var d = round2(Number(v) - info.prev.v);
          var arrow = isNaN(d) ? '' : (d > 0 ? ' ▲' : (d < 0 ? ' ▼' : ' ='));
          var dCls = isNaN(d) || d === 0 ? '' : (d > 0 ? 'res-up' : 'res-down');
          wasCell = '<span class="' + dCls + '">' + round2(info.prev.v) + arrow
                  + (isNaN(d) || d === 0 ? '' : ' <span class="res-delta">' + (d > 0 ? '+' : '') + d + '</span>')
                  + '</span>'
                  + '<div class="res-was-when">' + esc(fmtWhen(info.prev.when)) + '</div>';
        }
        var canSeries = (info.count || 0) >= 2;
        var label = canSeries
          ? '<button type="button" class="res-series-btn" data-act="result.series"'
            + ' data-id="' + esc(res.id) + '" data-key="' + esc(f.key) + '"'
            + ' title="Показать динамику показателя">' + esc(f.label) + ' 📈</button>'
          : esc(f.label);
        return '<tr><td>' + label + '</td>'
          + '<td class="' + cls + '">' + esc(v != null && v !== '' ? v : '—')
          + (f.unit ? ' ' + esc(f.unit) : '') + mark + '</td>'
          + '<td class="res-was">' + wasCell + '</td>'
          + '<td class="text-muted">' + esc(refText(f) || '—') + '</td></tr>'
          + '<tr class="res-series-row" id="res-series-' + esc(f.key) + '" style="display:none;" data-open="0">'
          + '<td colspan="4"></td></tr>';
      }).join('');
      html += '</tbody></table>';
    }
    if (res.lab_name) {
      html += '<div class="res-lab">' + I('hospital') + ' Исполнитель: ' + esc(res.lab_name) + '</div>';
    }
    // След исправления. Без него переписанный результат ничем не отличается от
    // исходного, а на его цифры могли опереться при назначении: вопрос «мы это
    // правили?» возникает именно тогда, когда разбирают спорный случай.
    // Отдельного журнала не заводим — дата внесения и дата последней правки уже
    // хранятся, их достаточно, чтобы увидеть сам факт.
    if (wasCorrected(res)) {
      html += '<div class="res-corrected">' + I('clock') + ' Внесён ' + esc(fmtWhenExact(res.filled_at))
        + ', исправлен ' + esc(fmtWhenExact(res.updated_at)) + '</div>';
    }
    if (res.conclusion) {
      html += '<div class="form-section"><div class="form-section-title">Заключение</div>'
        + '<div>' + esc(res.conclusion) + '</div></div>';
    }
    if (res.attachment_id) {
      var token = (window.VetAuth && VetAuth.token()) || '';
      html += '<div class="form-section"><a class="btn btn-ghost btn-sm" target="_blank" rel="noopener" href="/attachments/'
        + esc(res.attachment_id) + '/file?t=' + encodeURIComponent(token) + '">' + I('clipboard') + ' Открыть файл</a></div>';
    }
    if (!html) html = '<div class="text-sm text-muted">Результат ещё не внесён.</div>';
    return html;
  }

  // ═══════════════════════════════════════════════════════════════════════

  if (window.VetActions) {
    window.VetActions.register({
      'protocol.add':         function () { templateDialog(''); },
      'protocol.edit':        function (el) { templateDialog(el.dataset.id); },
      'protocol.delete':      function (el) { deleteTemplate(el.dataset.id); },
      'protocol.fieldAdd':    function () { fieldAdd(); },
      'protocol.fieldRemove': function (el) { fieldRemove(Number(el.dataset.idx)); },
      'result.fill':          function (el) { fillResult(el.dataset.id); },
      'result.view':          function (el) { viewResult(el.dataset.id); },
      // Просмотр закрываем ПЕРЕД открытием правки: иначе под формой осталась
      // бы карточка со старыми значениями, и после сохранения врач вернулся
      // бы к тому, что уже исправил.
      'result.edit':          function (el) {
                                var id = el.dataset.id;
                                UI.hideModal();
                                setTimeout(function () { fillResult(id); }, 60);
                              },
      'result.series':        function (el) { toggleSeries(el.dataset.id, el.dataset.key); }
    });
  }

  window.VetProtocols = {
    init: renderTemplateList,
    fieldsForResult: fieldsForResult,
    wasCorrected: wasCorrected,
    fillProtocolDraft: fillProtocolDraft,
    loadTemplates: loadTemplates,
    fieldsOf: fieldsOf,
    valuesOf: valuesOf,
    outOfRange: outOfRange,
    refText: refText,
    resultBodyHTML: resultBodyHTML,
    seriesFor: seriesFor,
    kindLabel: kindLabel
  };
})();
