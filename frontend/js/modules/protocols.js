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
      + '<label class="form-label">' + esc(f.label) + (f.unit ? ' <span class="text-muted">, ' + esc(f.unit) + '</span>' : '') + '</label>'
      + input
      + (ref ? '<div class="form-hint">норма ' + esc(ref) + '</div>' : '')
      + '</div>';
  }

  async function fillResult(resultId) {
    var all = await window.VetDB.getAll('visit_results');
    var res = (all || []).find(function (r) { return r.id === resultId; });
    if (!res) { UI.toast('Результат не найден', 'err'); return; }
    var tpls = await loadTemplates();
    var tpl = res.template_id ? tpls.find(function (t) { return t.id === res.template_id; }) : null;
    var fields = fieldsOf(tpl);
    var values = valuesOf(res);

    var body = '';
    if (fields.length) {
      body += '<div class="form-grid">' + fields.map(function (f) {
        return fillFieldHTML(f, values[f.key]);
      }).join('') + '</div>';
    } else {
      body += '<div class="text-sm text-muted">У этой услуги нет шаблона протокола — впишите заключение свободным текстом.</div>';
    }
    body += '<div class="form-section"><div class="form-group">'
      + '<label class="form-label">Заключение</label>'
      + '<textarea id="rv-conclusion" class="form-textarea" rows="3">' + esc(res.conclusion || '') + '</textarea>'
      + '</div></div>';

    UI.showModal({
      title: res.title || 'Результат',
      bodyHTML: body,
      size: 'lg',
      saveLabel: 'Сохранить результат',
      onSave: async function () {
        var vals = {};
        document.querySelectorAll('.rv-input').forEach(function (el) {
          var k = el.getAttribute('data-key');
          if (!k) return;
          vals[k] = el.type === 'checkbox' ? (el.checked ? '1' : '') : el.value.trim();
        });
        try {
          await api('PUT', '/results/' + resultId, {
            values_json: JSON.stringify(vals),
            conclusion: (document.getElementById('rv-conclusion') || {}).value || '',
            status: 'done'
          });
          UI.hideModal();
          UI.toast('Результат сохранён', 'ok');
          window.dispatchEvent(new Event('vetdata:changed'));
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
      title: res.title || 'Результат',
      bodyHTML: await resultBodyHTML(res),
      size: 'lg',
      onSave: false,
      cancelLabel: 'Закрыть'
    });
  }

  async function resultBodyHTML(res) {
    var tpls = await loadTemplates();
    var tpl = res.template_id ? tpls.find(function (t) { return t.id === res.template_id; }) : null;
    var fields = fieldsOf(tpl);
    var values = valuesOf(res);
    var html = '';

    if (fields.length) {
      html += '<table class="res-table"><thead><tr><th>Показатель</th><th>Значение</th><th>Норма</th></tr></thead><tbody>';
      html += fields.map(function (f) {
        var v = values[f.key];
        var flag = outOfRange(f, v);
        var cls = flag > 0 ? 'res-high' : (flag < 0 ? 'res-low' : '');
        var mark = flag > 0 ? ' ↑' : (flag < 0 ? ' ↓' : '');
        return '<tr><td>' + esc(f.label) + '</td>'
          + '<td class="' + cls + '">' + esc(v != null && v !== '' ? v : '—')
          + (f.unit ? ' ' + esc(f.unit) : '') + mark + '</td>'
          + '<td class="text-muted">' + esc(refText(f) || '—') + '</td></tr>';
      }).join('');
      html += '</tbody></table>';
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
      'result.view':          function (el) { viewResult(el.dataset.id); }
    });
  }

  window.VetProtocols = {
    init: renderTemplateList,
    loadTemplates: loadTemplates,
    fieldsOf: fieldsOf,
    valuesOf: valuesOf,
    outOfRange: outOfRange,
    refText: refText,
    resultBodyHTML: resultBodyHTML,
    kindLabel: kindLabel
  };
})();
