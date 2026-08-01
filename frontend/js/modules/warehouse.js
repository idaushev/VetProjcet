/* modules/warehouse.js — UI модуля склада (M3.2, вынесен из pages.js).
 *
 * Самодостаточный IIFE. Общие хелперы ядра берём через window.VetPagesCore
 * (экспорт pages.js) по алиасам — тело кода не менялось при переносе.
 * Публичные функции (onclick в index.html) навешиваются на window.VetPages;
 * точка входа страницы — window.VetWarehouse.init (зовётся из VetPages.init).
 *
 * Грузится ПОСЛЕ pages.js (нужен VetPagesCore и VetPages).
 */
(function () {
  "use strict";
  var UI = window.VetUI, VetDB = window.VetDB, VetModules = window.VetModules;
  var C  = window.VetPagesCore || {};
  var esc = C.esc, buildMap = C.buildMap, emptyState = C.emptyState,
      searchEmpty = C.searchEmpty, setupSearch = C.setupSearch, localDateStr = C.localDateStr;
  function navigate(p) { return window.navigate && window.navigate(p); }

  // ── Состояние модуля (перенесено из pages.js) ──
  var _whStores = [], _whItems = [], _whMoves = [];
  var _whTab = 'stock';
  var _whStockWarehouse = ''; // '' = все склады
  var _whMoveKind = 'all';
  var _whRepWarehouse = '', _whRepFrom = '', _whRepTo = '';

  function _whName(map, id) { var x = map[id]; return x ? x.name : '—'; }

  // Склад пишет в items напрямую (VetDB), минуя перехватчик fetch в app.js,
  // — его кэш об этом не знает, и «Каталог» показывал бы старые цены и не
  // видел позицию, заведённую в поступлении, до перезагрузки страницы.
  function _whCatalogChanged() {
    if (window._syncCacheInvalidate) window._syncCacheInvalidate('items');
    window.dispatchEvent(new CustomEvent('vetdata:changed', { detail: { store: 'items' } }));
  }

  // Остаток = SUM(qty) движений по (склад, позиция). Ledger — единственный
  // источник правды, изменяемого счётчика нет (офлайн-безопасно).
  function _whComputeStock() {
    var stock = {}; // key "wh|item" -> qty
    _whMoves.forEach(function(m){
      if (m.is_deleted) return;
      var k = m.warehouse_id + '|' + m.item_id;
      stock[k] = (stock[k] || 0) + (Number(m.qty) || 0);
    });
    return stock;
  }

  async function initWarehouse() {
    // Загружаем локально (офлайн-first).
    _whStores = (await window.VetDB.getAll('warehouses')).filter(function(w){ return !w.is_deleted; })
                 .sort(function(a,b){ return (b.is_default||0)-(a.is_default||0) || (a.name||'').localeCompare(b.name||'','ru'); });
    _whItems  = (await window.VetDB.getAll('items')).filter(function(i){ return !i.is_deleted; })
                 .sort(function(a,b){ return (a.name||'').localeCompare(b.name||'','ru'); });
    _whMoves  = (await window.VetDB.getAll('stock_movements')).filter(function(m){ return !m.is_deleted; });

    // Вкладки
    document.querySelectorAll('#wh-tabs .settings-tab').forEach(function(tab){
      tab.onclick = function(){ whShowTab(tab.dataset.whtab); };
    });
    // Склад-фильтр остатков
    var whSel = document.getElementById('wh-stock-warehouse');
    if (whSel) {
      whSel.innerHTML = '<option value="">Все склады</option>'
        + _whStores.map(function(w){ return '<option value="'+esc(w.id)+'">'+esc(w.name)+'</option>'; }).join('');
      whSel.value = _whStockWarehouse;
      whSel.onchange = function(){ _whStockWarehouse = whSel.value; renderWhStock(); };
    }
    setupSearch('wh-stock-search', function(){ renderWhStock(); });
    setupSearch('wh-moves-search', function(){ renderWhMoves(); });
    // Фильтр видов движений
    document.querySelectorAll('#wh-moves-filter .filter-btn').forEach(function(b){
      b.onclick = function(){
        document.querySelectorAll('#wh-moves-filter .filter-btn').forEach(function(x){ x.classList.remove('active'); });
        b.classList.add('active'); _whMoveKind = b.dataset.mkind; renderWhMoves();
      };
    });
    // Кнопки операций
    var r=document.getElementById('wh-btn-receipt'); if(r) r.onclick=function(){ whMovementForm('receipt'); };
    var wo=document.getElementById('wh-btn-writeoff'); if(wo) wo.onclick=function(){ whMovementForm('writeoff'); };
    var sa=document.getElementById('wh-btn-sale'); if(sa) sa.onclick=function(){ whMovementForm('sale'); };
    var pc=document.getElementById('wh-btn-price'); if(pc) pc.onclick=function(){ whPriceForm(null); };
    var as=document.getElementById('wh-btn-add-store'); if(as) as.onclick=function(){ whStoreForm(null); };

    // Отчёт: период (по умолчанию текущий месяц) + пресеты + склад
    var repFrom=document.getElementById('wh-rep-from'), repTo=document.getElementById('wh-rep-to');
    if (repFrom && !_whRepFrom) {
      var now=new Date();
      _whRepFrom = localDateStr(new Date(now.getFullYear(), now.getMonth(), 1));
      _whRepTo   = localDateStr(now);
    }
    if (repFrom) { repFrom.value=_whRepFrom; repFrom.onchange=function(){ _whRepFrom=repFrom.value; renderWhReport(); }; }
    if (repTo)   { repTo.value=_whRepTo;     repTo.onchange=function(){ _whRepTo=repTo.value; renderWhReport(); }; }
    document.querySelectorAll('#page-warehouse [data-wrep]').forEach(function(btn){
      btn.onclick=function(){
        var n=new Date(), f, t=n;
        if (btn.dataset.wrep==='week') f=new Date(n.getTime()-6*86400000);
        else if (btn.dataset.wrep==='month') f=new Date(n.getFullYear(), n.getMonth(), 1);
        else if (btn.dataset.wrep==='prev-month') { f=new Date(n.getFullYear(), n.getMonth()-1, 1); t=new Date(n.getFullYear(), n.getMonth(), 0); }
        _whRepFrom=localDateStr(f); _whRepTo=localDateStr(t);
        if(repFrom) repFrom.value=_whRepFrom; if(repTo) repTo.value=_whRepTo;
        renderWhReport();
      };
    });
    var repWh=document.getElementById('wh-rep-warehouse');
    if (repWh) {
      repWh.innerHTML='<option value="">Все склады</option>'+_whStores.map(function(w){return '<option value="'+esc(w.id)+'">'+esc(w.name)+'</option>';}).join('');
      repWh.value=_whRepWarehouse; repWh.onchange=function(){ _whRepWarehouse=repWh.value; renderWhReport(); };
    }

    // Вкладку, выбранную до перерисовки (в т.ч. пунктом сайдбара), нужно
    // восстановить — иначе после каждой операции открывались бы «Остатки».
    whShowTab(_whTab);
  }

  // Переключение вкладки склада: панели, кнопки-вкладки и подсветка пунктов
  // сайдбара — все четыре ведут на #warehouse, различаются только вкладкой.
  function whShowTab(tab) {
    _whTab = tab || 'stock';
    document.querySelectorAll('#wh-tabs .settings-tab').forEach(function(t){ t.classList.toggle('active', t.dataset.whtab===_whTab); });
    document.querySelectorAll('#page-warehouse .settings-panel').forEach(function(p){ p.style.display = (p.dataset.whpanel===_whTab) ? '' : 'none'; });
    document.querySelectorAll('.nav-item[data-whtab]').forEach(function(a){
      var on = a.dataset.whtab===_whTab;
      a.classList.toggle('active', on);
      a.setAttribute('aria-current', on ? 'page' : 'false');
    });
    renderWhTab();
  }
  function whCurrentTab() { return _whTab; }

  // Вызывается из пункта сайдбара. Страница могла быть ещё не отрисована
  // (navigate → VetPages.init → initWarehouse асинхронный), поэтому просто
  // запоминаем вкладку: initWarehouse откроет её сам в конце.
  function whOpenTab(tab) {
    _whTab = tab || 'stock';
    if (document.getElementById('page-warehouse') && document.getElementById('page-warehouse').classList.contains('active')) {
      whShowTab(_whTab);
    }
  }

  function renderWhReport() {
    var el = document.getElementById('wh-report-content'); if (!el) return;
    var from=_whRepFrom, to=_whRepTo;
    if (!from || !to) { el.innerHTML = emptyState('Укажите период'); return; }
    if (from > to) { el.innerHTML = emptyState('Дата начала позже даты конца'); return; }
    var itemsMap = buildMap(_whItems);
    // Движения периода (по occurred_at или created_at), опционально по складу.
    var movs = _whMoves.filter(function(m){
      if (m.is_deleted) return false;
      if (_whRepWarehouse && m.warehouse_id !== _whRepWarehouse) return false;
      var d = (m.occurred_at || m.created_at || '').slice(0,10);
      return d >= from && d <= to;
    });
    var recQty=0, recSum=0, woQty=0, woSum=0, saleQty=0, revenue=0, cogs=0;
    var byItemSale = {}; // item_id -> {qty, revenue}
    movs.forEach(function(m){
      var q=Math.abs(Number(m.qty)||0);
      if (m.kind==='receipt') { recQty+=q; recSum+=q*(Number(m.purchase_price)||0); }
      else if (m.kind==='writeoff') { woQty+=q; woSum+=q*(Number(m.purchase_price)||0); }
      else if (m.kind==='sale') {
        saleQty+=q; var rev=q*(Number(m.retail_price)||0); revenue+=rev; cogs+=q*(Number(m.purchase_price)||0);
        var s=byItemSale[m.item_id]=byItemSale[m.item_id]||{qty:0,rev:0}; s.qty+=q; s.rev+=rev;
      }
    });
    var margin = revenue - cogs;
    function tg(n){ return Number(n||0).toFixed(0) + ' ₸'; }

    var tiles = '<div class="revenue-tiles">'
      + tile('Выручка от продаж', tg(revenue), 'accent')
      + tile('Себестоимость проданного', tg(cogs), 'muted')
      + tile('Маржа', tg(margin), margin>=0?'accent':'danger')
      + tile('Продано, шт', String(saleQty), 'muted')
      + tile('Поступило на сумму', tg(recSum), 'blue')
      + tile('Списано на сумму', tg(woSum), 'warn')
      + '</div>';

    // Топ продаж
    var top = Object.keys(byItemSale).map(function(id){ return {id:id, q:byItemSale[id].qty, rev:byItemSale[id].rev}; })
                .sort(function(a,b){ return b.rev-a.rev; }).slice(0,10);
    var topHTML='';
    if (top.length) {
      topHTML = '<div class="report-wrap" style="margin-top:16px;"><div class="report-header"><h2>Топ продаж</h2></div>'
        + '<table class="history-table"><thead><tr><th>Позиция</th><th style="text-align:right;">Продано</th><th style="text-align:right;">Выручка</th></tr></thead><tbody>'
        + top.map(function(t){ var it=itemsMap[t.id]||{}; return '<tr><td>'+esc(it.name||'—')+'</td><td style="text-align:right;">'+t.q+' шт</td><td style="text-align:right;">'+tg(t.rev)+'</td></tr>'; }).join('')
        + '</tbody></table></div>';
    }
    if (!movs.length) { el.innerHTML = emptyState('За период движений нет', null, null, 'box'); return; }
    el.innerHTML = tiles + topHTML;

    function tile(label, val, tone) {
      var color = tone==='accent'?'var(--accent)':tone==='danger'?'var(--danger)':tone==='blue'?'var(--blue)':tone==='warn'?'var(--warn)':'var(--text)';
      return '<div class="revenue-tile"><div class="revenue-tile-value" style="color:'+color+';">'+esc(val)+'</div><div class="revenue-tile-label">'+esc(label)+'</div></div>';
    }
  }

  function renderWhTab() {
    if (_whTab === 'stock')  renderWhStock();
    else if (_whTab === 'moves') renderWhMoves();
    else if (_whTab === 'report') renderWhReport();
    else if (_whTab === 'stores') renderWhStores();
  }

  function renderWhStock() {
    var el = document.getElementById('wh-stock-list'); if (!el) return;
    var q = ((document.getElementById('wh-stock-search')||{}).value || '').toLowerCase();
    var itemsMap = buildMap(_whItems);
    var stock = _whComputeStock();
    // Собираем по позициям: если выбран склад — по нему, иначе суммарно.
    var rows = _whItems.filter(function(it){ return !q || (it.name||'').toLowerCase().includes(q); }).map(function(it){
      var qty = 0;
      if (_whStockWarehouse) qty = stock[_whStockWarehouse + '|' + it.id] || 0;
      else _whStores.forEach(function(w){ qty += stock[w.id + '|' + it.id] || 0; });
      return { it: it, qty: qty };
    }).filter(function(r){ return r.qty !== 0 || !q; }); // при поиске показываем и нулевые
    // Сортировка: сначала с остатком, потом по имени
    rows.sort(function(a,b){ return (b.qty>0)-(a.qty>0) || a.it.name.localeCompare(b.it.name,'ru'); });

    if (!rows.length) { el.innerHTML = q ? searchEmpty('wh-stock-search') : emptyState('Остатков нет — оформите поступление', '+ Поступление', "document.getElementById('wh-btn-receipt').click()", 'box'); return; }
    el.innerHTML = rows.map(function(r){
      var it=r.it; var low = r.qty<=0;
      return '<div class="erow" onclick="VetPages.whItemMoves(\''+it.id+'\')">'
        + '<div class="erow-body">'
        + '<div class="erow-title">'+esc(it.name)+' '+(it.type==='drug'?'<span class="chip-nochip" style="color:var(--blue);background:var(--blue-dim);border-color:var(--blue-border);">препарат</span>':'')+'</div>'
        + '<div class="erow-sub">Закупка '+Number(it.purchase_price||0).toFixed(0)+' ₸ · Розница '+Number(it.price||0).toFixed(0)+' ₸</div>'
        + '</div>'
        + '<div class="erow-right">'
        + '<span class="erow-amount" style="color:'+(low?'var(--danger)':'var(--accent)')+';">'+r.qty+' шт</span>'
        + '<div class="erow-actions">'
        + '<button class="btn btn-icon" title="Изменить цены" aria-label="Изменить цены" onclick="event.stopPropagation();VetPages.whPriceForm(\''+it.id+'\')">'+UI.icon('tag','')+'</button>'
        + '</div></div></div>';
    }).join('');
  }

  var WH_KIND = { receipt:{label:'Поступление',cls:'badge-active'}, writeoff:{label:'Списание',cls:'badge-deceased'}, sale:{label:'Продажа',cls:'badge-active'}, price:{label:'Цены',cls:'badge-inactive'}, adjust:{label:'Корректировка',cls:'badge-inactive'} };

  function renderWhMoves() {
    var el = document.getElementById('wh-moves-list'); if (!el) return;
    var q = ((document.getElementById('wh-moves-search')||{}).value || '').toLowerCase();
    var itemsMap = buildMap(_whItems), storesMap = buildMap(_whStores);
    var list = _whMoves.filter(function(m){
      if (_whMoveKind !== 'all' && m.kind !== _whMoveKind) return false;
      if (q) { var it = itemsMap[m.item_id]; if (!it || !(it.name||'').toLowerCase().includes(q)) return false; }
      return true;
    }).sort(function(a,b){ var da=a.occurred_at||a.created_at||'', db=b.occurred_at||b.created_at||''; return da<db?1:-1; }).slice(0,200);
    if (!list.length) { el.innerHTML = emptyState('Движений нет', null, null, 'clipboard'); return; }
    el.innerHTML = list.map(function(m){
      var it = itemsMap[m.item_id] || {}; var k = WH_KIND[m.kind] || {label:m.kind,cls:'badge-inactive'};
      var when = (m.occurred_at||m.created_at||'').slice(0,10);
      var sign = m.qty>0?'+':''; var priceInfo = '';
      if (m.kind==='receipt') priceInfo = 'закупка '+Number(m.purchase_price||0).toFixed(0)+' ₸';
      else if (m.kind==='sale') priceInfo = 'розница '+Number(m.retail_price||0).toFixed(0)+' ₸ · выручка '+Number(Math.abs(m.qty)*(m.retail_price||0)).toFixed(0)+' ₸';
      else if (m.kind==='price') priceInfo = 'закупка '+Number(m.purchase_price||0).toFixed(0)+' / розница '+Number(m.retail_price||0).toFixed(0)+' ₸';
      else if (m.reason) priceInfo = esc(m.reason);
      return '<div class="erow">'
        + '<div class="erow-body">'
        + '<div class="erow-title">'+esc(it.name||'—')+' <span class="badge '+k.cls+'">'+k.label+'</span></div>'
        + '<div class="erow-sub">'+esc(_whName(storesMap, m.warehouse_id))+' · '+when+(priceInfo?' · '+priceInfo:'')+'</div>'
        + '</div>'
        + '<div class="erow-right">'
        + (m.kind!=='price'?'<span class="erow-amount">'+sign+m.qty+' шт</span>':'')
        + '<div class="erow-actions">'
        + '<button class="btn btn-icon danger" title="Удалить движение" aria-label="Удалить" onclick="VetPages.whDeleteMove(\''+m.id+'\')">'+UI.icon('trash','')+'</button>'
        + '</div></div></div>';
    }).join('');
  }

  function renderWhStores() {
    var el = document.getElementById('wh-stores-list'); if (!el) return;
    var stock = _whComputeStock();
    el.innerHTML = _whStores.map(function(w){
      var positions = 0; _whItems.forEach(function(it){ if ((stock[w.id+'|'+it.id]||0)!==0) positions++; });
      return '<div class="erow">'
        + '<div class="erow-body"><div class="erow-title">'+esc(w.name)+(w.is_default?' <span class="badge badge-active">по умолчанию</span>':'')+'</div>'
        + '<div class="erow-sub">Позиций с остатком: '+positions+'</div></div>'
        + '<div class="erow-right"><div class="erow-actions">'
        + '<button class="btn btn-icon" title="Переименовать" aria-label="Переименовать" onclick="VetPages.whStoreEdit(\''+w.id+'\')">'+UI.icon('edit','')+'</button>'
        + (_whStores.length>1 && !w.is_default ? '<button class="btn btn-icon danger" title="Удалить" aria-label="Удалить" onclick="VetPages.whStoreDelete(\''+w.id+'\')">'+UI.icon('trash','')+'</button>' : '')
        + '</div></div></div>';
    }).join('');
  }

  // ── Форма движения (поступление / списание / продажа) ──────────────
  function whMovementForm(kind) {
    if (!_whStores.length) { UI.toast('Сначала добавьте склад', 'warn'); return; }
    // Списывать и продавать нечего, пока каталог пуст. В поступлении это не
    // помеха: позицию заводят прямо в документе.
    if (!_whItems.length && kind!=='receipt') { UI.toast('Каталог пуст — сначала оформите поступление','warn'); return; }
    var titleMap = { receipt:'Поступление на склад', writeoff:'Списание со склада', sale:'Продажа со склада' };
    var itemOpts = _whItems.map(function(it){ return '<option value="'+esc(it.id)+'">'+esc(it.name)+'</option>'; }).join('');
    var whOpts = _whStores.map(function(w){ return '<option value="'+esc(w.id)+'"'+(w.is_default?' selected':'')+'>'+esc(w.name)+'</option>'; }).join('');
    var today = new Date().toISOString().slice(0,10);
    var priceLabel = kind==='receipt' ? 'Закупочная цена, ₸' : (kind==='sale' ? 'Цена продажи, ₸' : '');
    // В поступлении товар часто приходит новый — его заводят прямо здесь.
    // Отдельной модалкой это сделать нельзя (UI.showModal одна на всё
    // приложение и затрёт наполовину заполненное поступление), поэтому
    // форма новой позиции разворачивается прямо внутри документа.
    var newItemBlock = kind!=='receipt' ? '' :
        '<div class="form-group form-span-2"><button type="button" class="btn btn-ghost btn-sm" id="wh-f-newitem-toggle">+ Новая позиция</button></div>'
      + '<div class="form-group form-span-2" id="wh-f-newitem" style="display:none;">'
      +   '<div class="card" style="padding:14px;border:1px solid var(--border);border-radius:var(--r-lg);">'
      +     '<div class="form-grid">'
      +       '<div class="form-group form-span-2"><label class="form-label">Название <span class="form-req">*</span></label><input id="wh-f-ni-name" class="form-input" placeholder="Напр. Дротаверин 2 мл"></div>'
      +       '<div class="form-group"><label class="form-label">Тип</label><select id="wh-f-ni-type" class="form-select"><option value="drug" selected>Препарат</option><option value="service">Услуга</option></select></div>'
      +       '<div class="form-group"><label class="form-label">Закупочная, ₸</label><input id="wh-f-ni-purchase" class="form-input" type="number" min="0" step="1" value="0"></div>'
      +       '<div class="form-group"><label class="form-label">Розничная, ₸</label><input id="wh-f-ni-retail" class="form-input" type="number" min="0" step="1" value="0"></div>'
      +       '<div class="form-group" style="align-self:end;"><button type="button" class="btn btn-primary btn-sm" id="wh-f-ni-create">Создать позицию</button></div>'
      +     '</div>'
      +   '</div>'
      + '</div>';
    var body = '<div class="form-grid">'
      + '<div class="form-group form-span-2"><label class="form-label">Позиция <span class="form-req">*</span></label><select id="wh-f-item" class="form-select">'+itemOpts+'</select></div>'
      + newItemBlock
      + '<div class="form-group"><label class="form-label">Склад</label><select id="wh-f-wh" class="form-select">'+whOpts+'</select></div>'
      + '<div class="form-group"><label class="form-label">Количество, шт <span class="form-req">*</span></label><input id="wh-f-qty" class="form-input" type="number" min="0.01" step="1" value="1"></div>'
      + (priceLabel ? '<div class="form-group"><label class="form-label">'+priceLabel+'</label><input id="wh-f-price" class="form-input" type="number" min="0" step="1" value="0"></div>' : '')
      + (kind==='writeoff' ? '<div class="form-group form-span-2"><label class="form-label">Причина</label><input id="wh-f-reason" class="form-input" placeholder="Брак, срок годности, порча..."></div>' : '')
      + '<div class="form-group"><label class="form-label">Дата</label><input id="wh-f-date" class="form-input" type="date" value="'+today+'"></div>'
      + '<div class="form-group form-span-2"><label class="form-label">Примечание</label><input id="wh-f-note" class="form-input"></div>'
      + '</div>';
    // Автоподстановка цены при выборе позиции
    UI.showModal({ title: titleMap[kind], bodyHTML: body, size:'lg', saveLabel:'Сохранить',
      afterOpen: function(){
        var sel=document.getElementById('wh-f-item'); var pr=document.getElementById('wh-f-price');
        function fill(){ var it=_whItems.find(function(x){return x.id===sel.value;}); if(it&&pr){ pr.value = kind==='receipt' ? (it.purchase_price||0) : (it.price||0); } }
        if(sel){ sel.onchange=fill; fill(); }

        var toggle=document.getElementById('wh-f-newitem-toggle');
        var block=document.getElementById('wh-f-newitem');
        if (toggle && block) {
          // Каталог пуст — разворачиваем сразу: выбирать не из чего.
          if (!_whItems.length) block.style.display='';
          toggle.onclick=function(){
            var open = block.style.display==='none';
            block.style.display = open ? '' : 'none';
            toggle.textContent = open ? 'Отмена' : '+ Новая позиция';
            if (open) { var n=document.getElementById('wh-f-ni-name'); if(n) n.focus(); }
          };
        }
        var create=document.getElementById('wh-f-ni-create');
        if (create) create.onclick=async function(){
          var name=((document.getElementById('wh-f-ni-name')||{}).value||'').trim();
          if(!name){ UI.toast('Введите название позиции','err'); return; }
          if (_whItems.some(function(x){ return (x.name||'').toLowerCase()===name.toLowerCase(); })) {
            UI.toast('Позиция с таким названием уже есть','err'); return;
          }
          var purchase=parseFloat((document.getElementById('wh-f-ni-purchase')||{}).value)||0;
          var retail=parseFloat((document.getElementById('wh-f-ni-retail')||{}).value)||0;
          create.disabled=true;
          try {
            // is_active обязателен: сервер отдаёт каталог только с is_active=1,
            // а в JSON отсутствующее поле приезжает как false — позиция ушла бы
            // на сервер и пропала из каталога.
            var rec = await window.VetDB.save('items', {
              id: window.VetDB.uuid(), name:name, type:(document.getElementById('wh-f-ni-type')||{}).value||'drug',
              price:retail, purchase_price:purchase,
              cost_price:0, cost_mode:'fixed', cost_percent:0, is_active:true,
            });
            _whItems.push(rec);
            _whItems.sort(function(a,b){ return (a.name||'').localeCompare(b.name||'','ru'); });
            if (sel) {
              sel.innerHTML=_whItems.map(function(x){ return '<option value="'+esc(x.id)+'">'+esc(x.name)+'</option>'; }).join('');
              sel.value=rec.id; fill();
            }
            if (block) block.style.display='none';
            if (toggle) toggle.textContent='+ Новая позиция';
            ['wh-f-ni-name','wh-f-ni-purchase','wh-f-ni-retail'].forEach(function(id){ var e=document.getElementById(id); if(e) e.value = id==='wh-f-ni-name' ? '' : '0'; });
            _whCatalogChanged();
            UI.toast('Позиция создана','ok');
            if (window.VetSync && VetSync.syncAll) VetSync.syncAll();
          } catch(e) { UI.toast('Не удалось создать позицию: '+((e&&e.message)||e),'err'); }
          create.disabled=false;
        };
      },
      onSave: async function(){
        var itemId=(document.getElementById('wh-f-item')||{}).value;
        var whId=(document.getElementById('wh-f-wh')||{}).value;
        var qty=parseFloat((document.getElementById('wh-f-qty')||{}).value)||0;
        if(!itemId){ UI.toast('Выберите позицию','err'); return; }
        if(qty<=0){ UI.toast('Количество должно быть больше 0','err'); return; }
        var price=parseFloat((document.getElementById('wh-f-price')||{}).value)||0;
        var it=_whItems.find(function(x){return x.id===itemId;})||{};
        var signedQty = kind==='receipt' ? qty : -qty;
        // Проверка остатка при расходе (мягко).
        if (kind!=='receipt') {
          var stock=_whComputeStock(); var have=stock[whId+'|'+itemId]||0;
          if (qty>have) {
            var ok=await UI.confirm('Недостаточно остатка','На складе '+have+' шт, списываете '+qty+' шт. Уйти в минус?',{yes:'Всё равно',no:'Отмена'});
            if(!ok) return;
          }
        }
        var rec = {
          id: window.VetDB.uuid(),
          warehouse_id: whId, item_id: itemId, kind: kind, qty: signedQty,
          purchase_price: kind==='receipt' ? price : (it.purchase_price||0),
          retail_price: kind==='sale' ? price : (it.price||0),
          reason: (document.getElementById('wh-f-reason')||{}).value || '',
          note: (document.getElementById('wh-f-note')||{}).value || '',
          occurred_at: (document.getElementById('wh-f-date')||{}).value || new Date().toISOString().slice(0,10),
        };
        await window.VetDB.save('stock_movements', rec);
        // Поступление обновляет закупочную цену позиции.
        if (kind==='receipt' && price>0 && Number(it.purchase_price||0)!==price) {
          var full=await window.VetDB.getById('items', itemId);
          if (full) { full.purchase_price = price; await window.VetDB.save('items', full); _whCatalogChanged(); }
        }
        UI.toast(titleMap[kind]+' сохранено','ok'); UI.hideModal();
        if (window.VetSync && VetSync.syncAll) VetSync.syncAll();
        await initWarehouse();
      }
    });
  }

  // ── Документ «Изменение цен» (закупка + розница) ───────────────────
  // itemId задан — правим цены конкретной позиции (кнопка в остатках).
  // itemId пуст — документ создаётся с нуля: позиция выбирается в форме.
  function whPriceForm(itemId) {
    if (!_whItems.length) { UI.toast('Каталог пуст — сначала добавьте позицию','warn'); return; }
    var it = itemId ? _whItems.find(function(x){return x.id===itemId;}) : null;
    if (itemId && !it) return;
    var today=new Date().toISOString().slice(0,10);
    var picker = it
      ? '<input class="form-input" value="'+esc(it.name)+'" disabled>'
      : '<select id="wh-p-item" class="form-select">'+_whItems.map(function(x){ return '<option value="'+esc(x.id)+'">'+esc(x.name)+'</option>'; }).join('')+'</select>';
    var base = it || _whItems[0];
    var body='<div class="form-grid">'
      + '<div class="form-group form-span-2"><label class="form-label">Позиция <span class="form-req">*</span></label>'+picker+'</div>'
      + '<div class="form-group"><label class="form-label">Закупочная, ₸</label><input id="wh-p-purchase" class="form-input" type="number" min="0" step="1" value="'+Number(base.purchase_price||0)+'"></div>'
      + '<div class="form-group"><label class="form-label">Розничная, ₸</label><input id="wh-p-retail" class="form-input" type="number" min="0" step="1" value="'+Number(base.price||0)+'"></div>'
      + '<div class="form-group"><label class="form-label">Дата</label><input id="wh-p-date" class="form-input" type="date" value="'+today+'"></div>'
      + '<div class="form-group form-span-2"><div class="form-hint">Цены общие для всех складов — это цены позиции в каталоге. Изменение попадёт в журнал движений (вид «Цены»).</div></div>'
      + '</div>';
    UI.showModal({ title:'Изменение цен', bodyHTML:body, saveLabel:'Сохранить',
      afterOpen: function(){
        // Выбрали другую позицию — подставляем её текущие цены.
        var sel=document.getElementById('wh-p-item'); if(!sel) return;
        sel.onchange=function(){
          var x=_whItems.find(function(y){return y.id===sel.value;})||{};
          var pu=document.getElementById('wh-p-purchase'), rt=document.getElementById('wh-p-retail');
          if(pu) pu.value=Number(x.purchase_price||0); if(rt) rt.value=Number(x.price||0);
        };
      },
      onSave: async function(){
        var id = itemId || (document.getElementById('wh-p-item')||{}).value;
        if(!id){ UI.toast('Выберите позицию','err'); return; }
        var pu=parseFloat((document.getElementById('wh-p-purchase')||{}).value)||0;
        var rt=parseFloat((document.getElementById('wh-p-retail')||{}).value)||0;
        var full=await window.VetDB.getById('items', id); if(!full){ UI.hideModal(); return; }
        var changed = Number(full.purchase_price||0)!==pu || Number(full.price||0)!==rt;
        if (!changed) { UI.toast('Цены не изменились','warn'); return; }
        full.purchase_price=pu; full.price=rt;
        await window.VetDB.save('items', full);
        _whCatalogChanged();
        // Фиксируем изменение цен в журнале движений (qty=0).
        await window.VetDB.save('stock_movements', {
          id: window.VetDB.uuid(),
          warehouse_id:(_whStores[0]||{}).id||'', item_id:id, kind:'price', qty:0,
          purchase_price:pu, retail_price:rt,
          occurred_at:(document.getElementById('wh-p-date')||{}).value || new Date().toISOString().slice(0,10),
        });
        UI.toast('Цены обновлены','ok'); UI.hideModal();
        if (window.VetSync && VetSync.syncAll) VetSync.syncAll();
        await initWarehouse();
      }});
  }

  // ── Склады: добавить / переименовать / удалить ─────────────────────
  function whStoreForm(store) {
    var body='<div class="form-group"><label class="form-label">Название склада <span class="form-req">*</span></label>'
      + '<input id="wh-store-name" class="form-input" value="'+esc(store?store.name:'')+'" placeholder="Напр. Аптека, Хирургия"></div>';
    UI.showModal({ title: store?'Переименовать склад':'Новый склад', bodyHTML:body, saveLabel:'Сохранить', onSave: async function(){
      var name=((document.getElementById('wh-store-name')||{}).value||'').trim();
      if(!name){ UI.toast('Введите название','err'); return; }
      if (store) { var full=await window.VetDB.getById('warehouses', store.id); full.name=name; await window.VetDB.save('warehouses', full); }
      else { await window.VetDB.save('warehouses', { id: window.VetDB.uuid(), name:name, is_default:0 }); }
      UI.toast('Сохранено','ok'); UI.hideModal();
      if (window.VetSync && VetSync.syncAll) VetSync.syncAll();
      await initWarehouse();
    }});
  }
  function whStoreEdit(id) { var w=_whStores.find(function(x){return x.id===id;}); if(w) whStoreForm(w); }
  async function whStoreDelete(id) {
    var w=_whStores.find(function(x){return x.id===id;}); if(!w) return;
    if (w.is_default) { UI.toast('Нельзя удалить склад по умолчанию','warn'); return; }
    if (_whStores.length<=1) { UI.toast('Нельзя удалить единственный склад','warn'); return; }
    var ok=await UI.confirm('Удалить склад?','«'+w.name+'» будет удалён. Движения по нему останутся в журнале.',{yes:'Удалить',no:'Отмена'});
    if(!ok) return;
    await window.VetDB.softDelete('warehouses', id);
    UI.toast('Склад удалён','ok');
    if (window.VetSync && VetSync.syncAll) VetSync.syncAll();
    await initWarehouse();
  }
  async function whDeleteMove(id) {
    var ok=await UI.confirm('Удалить движение?','Остаток пересчитается. Действие необратимо.',{yes:'Удалить',no:'Отмена'});
    if(!ok) return;
    await window.VetDB.softDelete('stock_movements', id);
    UI.toast('Движение удалено','ok');
    if (window.VetSync && VetSync.syncAll) VetSync.syncAll();
    await initWarehouse();
  }
  // Клик по позиции в остатках → её движения (фильтр журнала по имени).
  function whItemMoves(itemId) {
    var it=_whItems.find(function(x){return x.id===itemId;}); if(!it) return;
    var s=document.getElementById('wh-moves-search'); if(s){ s.value=it.name; }
    _whMoveKind='all';
    document.querySelectorAll('#wh-moves-filter .filter-btn').forEach(function(x){ x.classList.toggle('active', x.dataset.mkind==='all'); });
    whShowTab('moves');
  }

  // ── Публичный API модуля ──
  // Точка входа страницы (VetPages.init делегирует сюда).
  window.VetWarehouse = { init: initWarehouse, currentTab: whCurrentTab };
  // Функции, вызываемые из onclick в index.html — навешиваем на VetPages,
  // чтобы разметку не трогать.
  if (window.VetPages) {
    VetPages.whPriceForm  = whPriceForm;
    VetPages.whStoreEdit  = whStoreEdit;
    VetPages.whStoreDelete = whStoreDelete;
    VetPages.whDeleteMove = whDeleteMove;
    VetPages.whItemMoves  = whItemMoves;
    VetPages.whOpenTab    = whOpenTab;
    VetPages.whCurrentTab = whCurrentTab;
  }
})();
