/* ════════════════════════════════════════════════════════════════
   VetClinic UI — Modal, Toast, Forms
   ════════════════════════════════════════════════════════════════ */
(function () {
  'use strict';

  // ── Иконки ────────────────────────────────────────────────────────────
  // Единственный источник иконок — VetIcons (js/icons.js). Здесь только
  // тонкая обёртка: старый код звал icon(name, cls), сигнатуру сохраняем.
  // Имена, которых в общем наборе нет исторически, переводим в его словарь.
  var ICON_ALIAS = { warn: 'alert', print: 'printer', skull: 'alert', eye: 'search' };

  function icon(name, cls) {
    return I(ICON_ALIAS[name] || name, cls);
  }

  // I — короткий помощник для вставки иконки в строковую разметку.
  // Возвращает пустую строку, если icons.js почему-то не загрузился:
  // отсутствие иконки не должно ронять весь рендер страницы.
  function I(name, cls) {
    if (!window.VetIcons) return '';
    return window.VetIcons.get(name, { cls: cls || '' });
  }

  function esc(str) {
    return String(str||'').replace(/[&<>"']/g, function(c){
      return {'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c];
    });
  }

  function avatar(name, type) {
    var parts = (name||'?').trim().split(/\s+/);
    var ini = parts.length >= 2
      ? (parts[0][0]+parts[parts.length-1][0]).toUpperCase()
      : (name||'?').slice(0,2).toUpperCase();
    var cls = 'erow-avatar';
    var t = (type||'').toLowerCase();
    if (t.includes('собак')||t==='dog')   cls += ' dog';
    else if (t.includes('кош')||t==='cat') cls += ' cat';
    else if (t.includes('птиц')||t.includes('попугай')||t==='bird') cls += ' bird';
    return '<div class="'+cls+'">'+esc(ini)+'</div>';
  }

  // ── Toast ──────────────────────────────────────────────────────────────
  var _toastWrap = null;
  function toast(msg, type, dur) {
    type = type||'ok'; dur = dur||3200;
    if (!_toastWrap) { _toastWrap = document.createElement('div'); _toastWrap.className='toast-container'; document.body.appendChild(_toastWrap); }
    var el = document.createElement('div');
    el.className = 'toast '+type;
    el.innerHTML = icon(type==='ok'?'check':type==='err'?'x':'warn','toast-icon')+'<span class="toast-msg">'+esc(msg)+'</span><span class="toast-close">&times;</span>';
    el.querySelector('.toast-close').onclick = function(){ el.remove(); };
    _toastWrap.appendChild(el);
    setTimeout(function(){ el.style.opacity='0'; el.style.transition='opacity .3s'; setTimeout(function(){ el.remove(); },300); }, dur);
  }

  // ── Confirm ────────────────────────────────────────────────────────────
  function confirm(title, msg) {
    return new Promise(function(resolve){
      var o = document.createElement('div'); o.className='confirm-overlay';
      o.innerHTML='<div class="confirm-box"><div class="confirm-title">'+esc(title)+'</div><div class="confirm-msg">'+esc(msg||'')+'</div><div class="confirm-actions"><button class="btn btn-ghost" id="cn-no">Отмена</button><button class="btn btn-danger" id="cn-yes">Удалить</button></div></div>';
      document.body.appendChild(o);
      o.querySelector('#cn-no').onclick  = function(){ o.remove(); resolve(false); };
      o.querySelector('#cn-yes').onclick = function(){ o.remove(); resolve(true);  };
      o.onclick = function(e){ if(e.target===o){ o.remove(); resolve(false); } };
    });
  }

  // ── Modal ──────────────────────────────────────────────────────────────
  function showModal(cfg) {
    var overlay = document.getElementById('modal-overlay');
    var modal   = overlay.querySelector('.modal');

    // Сбрасываем inline-стили от предыдущей модалки
    // (showOwnerCard/showPetCard скрывают header/footer через style.display)
    var modalBody   = overlay.querySelector('#modal-body');
    var modalHeader = overlay.querySelector('.modal-header');
    var footer      = overlay.querySelector('#modal-footer');
    if (modalBody)   { modalBody.style.padding = ''; modalBody.style.overflowY = ''; }
    if (modalHeader) { modalHeader.style.display = ''; }
    if (footer)      { footer.style.display = ''; }

    overlay.querySelector('#modal-title').textContent = cfg.title||'';
    modal.className = 'modal'+(cfg.size?' modal-'+cfg.size:'');
    modalBody.innerHTML = cfg.bodyHTML||'';
    footer.innerHTML = '';
    if (cfg.onSave !== false) {
      var cancel = document.createElement('button'); cancel.className='btn btn-ghost'; cancel.textContent=cfg.cancelLabel||'Отмена'; cancel.onclick=hideModal;
      var save   = document.createElement('button'); save.className='btn btn-primary'; save.id='modal-save-btn'; save.textContent=cfg.saveLabel||'Сохранить';
      if (cfg.onSave) save.onclick = cfg.onSave;
      footer.appendChild(cancel); footer.appendChild(save);
    }
    overlay.classList.add('open');
    if (cfg.afterOpen) setTimeout(cfg.afterOpen, 40);
  }
  function hideModal() { document.getElementById('modal-overlay').classList.remove('open'); }
  document.addEventListener('keydown', function(e){ if(e.key==='Escape') hideModal(); });
  document.addEventListener('click',   function(e){ if(e.target&&e.target.id==='modal-overlay') hideModal(); });

  // ── Константы ──────────────────────────────────────────────────────────

  // Иконки видов (используется в renderPetArea и pet chips)
  var SPECIES_ICONS_UI = {
    'кошка':'🐱','кот':'🐱','собака':'🐶','пёс':'🐶','кролик':'🐰','попугай':'🦜',
    'птица':'🐦','хомяк':'🐹','черепаха':'🐢','морская свинка':'🐭',
    'шиншилла':'🐭','хорёк':'🦡','другое':'🐾',
  };

  var PET_TYPES = [
    {value:'кошка',label:'Кошка'},{value:'собака',label:'Собака'},
    {value:'попугай',label:'Попугай'},{value:'птица',label:'Птица'},
    {value:'кролик',label:'Кролик'},{value:'хомяк',label:'Хомяк'},
    {value:'черепаха',label:'Черепаха'},{value:'морская свинка',label:'Морская свинка'},
    {value:'шиншилла',label:'Шиншилла'},{value:'хорёк',label:'Хорёк'},
    {value:'другое',label:'Другое'},
  ];

  var CONDITIONS = ['Здоров','Лёгкое','средней тяжести','тяжелое','крайне тяжелое','терминальное'];

  var DEATH_REASONS = [
    'По возрасту','По болезни','Экстренное состояние','Несчастный случай',
    'Позднее обращение за помощью','Дефекты оказания медицинской помощи',
    'Скрытые патологии','Анафилактический шок',
  ];

  function petTypeOpts(sel) {
    return PET_TYPES.map(function(t){ return '<option value="'+t.value+'"'+(t.value===sel?' selected':'')+'>'+t.label+'</option>'; }).join('');
  }

  // ── Owner form ─────────────────────────────────────────────────────────
  function ownerFormHTML(d) {
    d=d||{};
    return '<div class="form-grid">'
      +'<div class="form-group form-span-2"><label class="form-label">ФИО <span class="form-req">*</span></label><input id="f-fio" class="form-input" value="'+esc(d.fio||'')+'" placeholder="Иванов Иван Иванович"></div>'
      +'<div class="form-group"><label class="form-label">Телефон <span class="form-req">*</span></label><input id="f-phone" class="form-input" type="tel" value="'+esc(d.phone||'')+'" placeholder="+7 777 000 0000"></div>'
      +'<div class="form-group"><label class="form-label">ИИН</label><input id="f-iin" class="form-input" value="'+esc(d.iin||'')+'" maxlength="12" placeholder="12 цифр"></div>'
      +'<div class="form-group form-span-2"><label class="form-label">Адрес</label><input id="f-address" class="form-input" value="'+esc(d.address||'')+'" placeholder="Город, улица, дом"></div>'
      +'<div class="form-group form-span-2"><label class="form-label">Примечания</label><textarea id="f-notes" class="form-textarea">'+esc(d.notes||'')+'</textarea></div>'
      +'</div>';
  }
  function ownerFormData() {
    return { fio:document.getElementById('f-fio').value.trim(), phone:document.getElementById('f-phone').value.trim(), iin:document.getElementById('f-iin').value.trim(), address:document.getElementById('f-address').value.trim(), notes:document.getElementById('f-notes').value.trim() };
  }

  // ── Pet form (полный, с возрастом, фото, ссылками на отчёты) ────────────
  function petFormHTML(d, ownerHint) {
    d=d||{};
    var birth=''; try{ if(d.birth_date) birth=new Date(d.birth_date).toISOString().slice(0,10); }catch(e){}
    var ageYears=0, ageMons=0;
    if (birth) {
      var now=new Date(); var bd=new Date(birth);
      var totalMons=(now.getFullYear()-bd.getFullYear())*12+(now.getMonth()-bd.getMonth());
      if(totalMons>0){ageYears=Math.floor(totalMons/12); ageMons=totalMons%12;}
    }
    return '<div class="form-grid">'
      +(ownerHint?'<div class="form-group form-span-2"><div class="text-sm text-muted">Владелец: <b>'+esc(ownerHint)+'</b></div></div>':'')
      +'<div class="form-group"><label class="form-label">Кличка <span class="form-req">*</span></label><input id="f-name" class="form-input" value="'+esc(d.name||'')+'" placeholder="Барсик"></div>'
      +'<div class="form-group"><label class="form-label">Вид <span class="form-req">*</span></label><select id="f-type" class="form-select">'+petTypeOpts(d.type||'кошка')+'</select></div>'
      +'<div class="form-group"><label class="form-label">Пол <span class="form-req">*</span></label><select id="f-gender" class="form-select"><option value="m"'+(d.gender==='m'?' selected':'')+'>Самец</option><option value="f"'+(d.gender==='f'?' selected':'')+'>Самка</option></select></div>'
      +'<div class="form-group"><label class="form-label">Порода</label><input id="f-breed" class="form-input" value="'+esc(d.breed||'')+'" placeholder="Дворняга"></div>'
      // Возраст
      +'<div class="form-group form-span-2"><label class="form-label">Возраст</label>'
      +'<div style="display:flex;gap:8px;align-items:center;">'
      +'<input id="f-age-years" class="form-input" type="number" min="0" max="50" value="'+ageYears+'" placeholder="0" style="width:80px;"> лет'
      +'<input id="f-age-months" class="form-input" type="number" min="0" max="11" value="'+ageMons+'" placeholder="0" style="width:80px;margin-left:8px;"> мес'
      +'</div></div>'
      +'<div class="form-group form-span-2"><label class="form-label">Дата рождения</label><input id="f-birth" class="form-input" type="date" value="'+esc(birth)+'"></div>'
      +'<div class="form-group"><label class="form-label">Вес (кг)</label><input id="f-weight" class="form-input" type="number" step="0.1" min="0" value="'+esc(d.weight!=null?d.weight:'')+'" placeholder="3.5"></div>'
      +'<div class="form-group"><label class="form-label">Цвет / окрас</label><input id="f-color" class="form-input" value="'+esc(d.color||'')+'" placeholder="Рыжий"></div>'
      +'<div class="form-group"><label class="form-label">№ чипа</label><input id="f-chip" class="form-input" inputmode="numeric" value="'+esc(d.chip_number||'')+'" placeholder="643094100001234" maxlength="20" oninput="VetUI.checkChip()"><div id="f-chip-hint" class="form-hint"></div></div>'
      +'<div class="form-group form-span-2"><label class="form-label">Примечания</label><textarea id="f-notes" class="form-textarea">'+esc(d.notes||'')+'</textarea></div>'
      +'<input type="hidden" id="f-owner-id" value="'+esc(d.owner_id||'')+'">'
      // Фото
      +(d.id ? '<div class="form-group form-span-2"><label class="form-label">Фото</label>'
        +'<div style="display:flex;gap:14px;align-items:center;">'
        +(d.photo ? '<img src="'+d.photo+'" class="pet-photo-preview" alt="Фото '+esc(d.name||'')+'">' : '')
        +'<div style="display:flex;flex-direction:column;gap:8px;">'
        +'<button class="btn btn-ghost btn-sm" type="button" onclick="event.preventDefault();VetPages.petPhotoInput(\''+esc(d.id)+'\')">'+I('camera')+' '+(d.photo?'Изменить фото':'Добавить фото')+'</button>'
        +'</div></div></div>'
        : '')
      // Кнопки отчётов (только при редактировании)
      +(d.id ? '<div class="form-group form-span-2">'
        +'<label class="form-label">История</label>'
        +'<div style="display:flex;gap:8px;flex-wrap:wrap;">'
        +'<button class="btn btn-ghost btn-sm" type="button" onclick="event.preventDefault();VetUI.hideModal();setTimeout(function(){VetPages.showPetHistory(\''+esc(d.id)+'\');},200)">'+I('clipboard')+' История посещений</button>'
        +'<button class="btn btn-ghost btn-sm" type="button" onclick="event.preventDefault();VetUI.hideModal();setTimeout(function(){VetPages.showPetHistory(\''+esc(d.id)+'\');},200)">'+I('microscope')+' История болезней</button>'
        +'<button class="btn btn-ghost btn-sm" type="button" onclick="event.preventDefault();VetUI.hideModal();setTimeout(function(){VetPages.showPetHistory(\''+esc(d.id)+'\');},200)">'+I('scale')+' История веса</button>'
        +'</div></div>'
        : '')
      +'</div>';
  }

  function petFormAfterOpen() {
    // Авторасчёт: возраст → дата рождения
    function calcBirthFromAge() {
      var y = parseInt(document.getElementById('f-age-years').value)||0;
      var m = parseInt(document.getElementById('f-age-months').value)||0;
      var totalMons = y*12+m;
      var d = new Date(); d.setMonth(d.getMonth()-totalMons);
      document.getElementById('f-birth').value = d.toISOString().slice(0,10);
    }
    // Авторасчёт: дата рождения → возраст
    function calcAgeFromBirth() {
      var b = document.getElementById('f-birth').value;
      if (!b) return;
      var bd = new Date(b); var now = new Date();
      var total = (now.getFullYear()-bd.getFullYear())*12+(now.getMonth()-bd.getMonth());
      if (total < 0) total = 0;
      document.getElementById('f-age-years').value  = Math.floor(total/12);
      document.getElementById('f-age-months').value = total%12;
    }
    var yr = document.getElementById('f-age-years');
    var mo = document.getElementById('f-age-months');
    var br = document.getElementById('f-birth');
    if (yr) yr.addEventListener('input', calcBirthFromAge);
    if (mo) mo.addEventListener('input', calcBirthFromAge);
    if (br) br.addEventListener('change', calcAgeFromBirth);
  }

  function petFormData() {
    var w=parseFloat(document.getElementById('f-weight').value);
    return {
      name:      document.getElementById('f-name').value.trim(),
      type:      document.getElementById('f-type').value,
      gender:    document.getElementById('f-gender').value,
      breed:     document.getElementById('f-breed').value.trim(),
      color:      document.getElementById('f-color').value.trim(),
      chip_number: normalizeChip((document.getElementById('f-chip')||{}).value||''),
      weight:    isNaN(w)?null:w,
      birth_date:document.getElementById('f-birth').value||'',
      notes:     document.getElementById('f-notes').value.trim(),
      owner_id:  document.getElementById('f-owner-id').value,
    };
  }

  // ── Item form (с кассовой стоимостью) ──────────────────────────────────
  function itemFormHTML(d) {
    d=d||{};
    return '<div class="form-grid">'
      +'<div class="form-group form-span-2"><label class="form-label">Название <span class="form-req">*</span></label><input id="f-name" class="form-input" value="'+esc(d.name||'')+'" placeholder="Первичный осмотр"></div>'
      +'<div class="form-group"><label class="form-label">Тип <span class="form-req">*</span></label><select id="f-type" class="form-select"><option value="service"'+(d.type==='service'?' selected':'')+'>Услуга</option><option value="drug"'+(d.type==='drug'?' selected':'')+'>Препарат</option></select></div>'
      +'<div class="form-group"><label class="form-label">Цена (₸) <span class="form-req">*</span></label><input id="f-price" class="form-input" type="number" min="0" step="0.01" value="'+esc(d.price!=null?d.price:'')+'" placeholder="1500" oninput="VetUI.recalcItemCost()"></div>'
      +'<div class="form-group"><label class="form-label">Кассовая стоимость</label><select id="f-cost-mode" class="form-select" onchange="VetUI.recalcItemCost()">'
        +'<option value="fixed"'+(d.cost_mode!=='percent'?' selected':'')+'>Фиксированная сумма</option>'
        +'<option value="percent"'+(d.cost_mode==='percent'?' selected':'')+'>Процент от цены</option>'
      +'</select></div>'
      +'<div class="form-group" id="f-cost-fixed-group"><label class="form-label">Сумма (₸)</label><input id="f-cost-price" class="form-input" type="number" min="0" step="0.01" value="'+esc(d.cost_price!=null&&d.cost_price!==0?d.cost_price:'')+'" placeholder="Стоимость по кассе"></div>'
      +'<div class="form-group" id="f-cost-percent-group"><label class="form-label">Процент от цены (%)</label><input id="f-cost-percent" class="form-input" type="number" min="0" max="100" step="0.1" value="'+esc(d.cost_percent!=null&&d.cost_percent!==0?d.cost_percent:'')+'" placeholder="50" oninput="VetUI.recalcItemCost()"></div>'
      +'<div class="form-group form-span-2"><div id="f-cost-hint" class="form-hint"></div></div>'
      +'</div>';
  }

  // ── Курс лечения ───────────────────────────────────────────────────────
  // Повторяет серверный resolveTreatment (handlers_visits.go): отсчёт от даты
  // приёма, курс в 1 день = лечение в день приёма, отсюда days-1.
  // Дублируется намеренно: планшет офлайн должен показать врачу срок сразу,
  // не дожидаясь сервера.
  function treatmentUntil(visitDateStr, days) {
    if (!days || days < 1) return null;
    var d = visitDateStr ? new Date(visitDateStr) : new Date();
    if (isNaN(d.getTime())) return null;
    var until = new Date(d.getFullYear(), d.getMonth(), d.getDate() + (days - 1));
    return until;
  }

  function recalcTreatment() {
    var input = document.getElementById('f-treatment-days');
    var hint  = document.getElementById('f-treatment-hint');
    if (!input || !hint) return;
    var days = parseInt(input.value, 10) || 0;
    if (days <= 0) { hint.textContent = ''; hint.style.color = ''; return; }
    if (days > 365) {
      hint.textContent = 'Не больше 365 дней';
      hint.style.color = 'var(--danger, #c0392b)';
      return;
    }
    var dateEl = document.getElementById('f-visit-date');
    var until = treatmentUntil(dateEl ? dateEl.value : '', days);
    hint.style.color = '';
    hint.textContent = until
      ? 'Активен по ' + until.toLocaleDateString('ru-RU')
      : '';
  }

  // ── Чип животного ──────────────────────────────────────────────────────
  // Логика повторяет серверную (normalizeChip/validateChip в handlers_pets.go):
  // планшет офлайн обязан записать в локальную базу уже нормализованный номер,
  // иначе один и тот же чип уедет на сервер в двух написаниях.

  // Оставляем только цифры: номер часто вводят с пробелами или дефисами.
  function normalizeChip(s) { return String(s||'').replace(/\D/g, ''); }

  // Подсказка под полем. Не-ISO номер (не 15 цифр) не блокируем — старые чипы
  // Avid/FDX-A бывают на 9–10 цифр, — но предупреждаем.
  function checkChip() {
    var input = document.getElementById('f-chip');
    var hint  = document.getElementById('f-chip-hint');
    if (!input || !hint) return;
    var chip = normalizeChip(input.value);
    if (!chip) { hint.textContent = ''; hint.style.color = ''; return; }
    if (chip.length < 9 || chip.length > 15) {
      hint.textContent = 'Номер чипа: от 9 до 15 цифр (сейчас ' + chip.length + ')';
      hint.style.color = 'var(--danger, #c0392b)';
      return;
    }
    if (chip.length === 15) {
      hint.textContent = '✓ Стандарт ISO (15 цифр)';
      hint.style.color = 'var(--success, #1a8c5e)';
    } else {
      hint.textContent = 'Не ISO: ' + chip.length + ' цифр. Сохранить можно — бывают старые чипы';
      hint.style.color = 'var(--warning, #b7791f)';
    }
  }

  // Показывает нужное поле под выбранный режим и считает подсказку с итоговой суммой.
  // Пересчёт живёт на клиенте: планшет без сети должен записать в локальную базу
  // уже правильный cost_price, не дожидаясь сервера.
  function recalcItemCost() {
    var modeEl = document.getElementById('f-cost-mode');
    if (!modeEl) return;
    var percentMode = modeEl.value === 'percent';
    var fixedGroup   = document.getElementById('f-cost-fixed-group');
    var percentGroup = document.getElementById('f-cost-percent-group');
    var hint = document.getElementById('f-cost-hint');
    if (fixedGroup)   fixedGroup.style.display   = percentMode ? 'none' : '';
    if (percentGroup) percentGroup.style.display = percentMode ? '' : 'none';
    if (!hint) return;
    if (!percentMode) { hint.textContent = ''; return; }
    var price   = parseFloat(document.getElementById('f-price').value) || 0;
    var percent = parseFloat(document.getElementById('f-cost-percent').value) || 0;
    hint.textContent = 'Кассовая: ' + itemCostFromPercent(price, percent) + ' ₸ — пересчитается сама при смене цены';
  }

  function itemCostFromPercent(price, percent) {
    return Math.round(price * percent / 100 * 100) / 100;
  }

  function itemFormData() {
    var price = parseFloat(document.getElementById('f-price').value)||0;
    var mode  = document.getElementById('f-cost-mode').value;
    var percent = parseFloat(document.getElementById('f-cost-percent').value)||0;
    var cost = mode==='percent'
      ? itemCostFromPercent(price, percent)
      : parseFloat(document.getElementById('f-cost-price').value)||0;
    return { name:document.getElementById('f-name').value.trim(), type:document.getElementById('f-type').value,
             price:price, cost_price:cost, cost_mode:mode, cost_percent:mode==='percent'?percent:0 };
  }

  // ── Staff form ─────────────────────────────────────────────────────────
  var ROLES = [{v:'vet',l:'Ветеринар'},{v:'vet_assistant',l:'Ветфельдшер'},{v:'admin',l:'Администратор'},{v:'groomer',l:'Груммер'},{v:'surgeon',l:'Хирург'},{v:'other',l:'Другое'}];
  function staffFormHTML(d) {
    d=d||{};
    return '<div class="form-grid">'
      +'<div class="form-group form-span-2"><label class="form-label">ФИО <span class="form-req">*</span></label><input id="f-name" class="form-input" value="'+esc(d.name||'')+'" placeholder="Иванова Мария Сергеевна"></div>'
      +'<div class="form-group"><label class="form-label">Должность <span class="form-req">*</span></label><select id="f-role" class="form-select">'+ROLES.map(function(r){return '<option value="'+r.v+'"'+(r.v===(d.role||'vet')?' selected':'')+'>'+r.l+'</option>';}).join('')+'</select></div>'
      +'<div class="form-group"><label class="form-label">Телефон</label><input id="f-phone" class="form-input" type="tel" value="'+esc(d.phone||'')+'" placeholder="+7 777 000 0000"></div>'
      +'<div class="form-group form-span-2"><label class="form-label">Email</label><input id="f-email" class="form-input" type="email" value="'+esc(d.email||'')+'" placeholder="doctor@clinic.kz"></div>'
      +'<div class="form-group form-span-2"><label class="form-label">Примечания</label><textarea id="f-notes" class="form-textarea">'+esc(d.notes||'')+'</textarea></div>'
      +'<div class="form-group form-span-2"><label class="form-label">Фото</label>'
        +'<div style="display:flex;align-items:center;gap:12px;">'
        +(d.photo?'<img id="f-staff-photo-preview" src="'+esc(d.photo)+'" style="width:56px;height:56px;border-radius:50%;object-fit:cover;border:2px solid var(--border);">':'<span id="f-staff-photo-preview"></span>')
        +'<button type="button" class="btn btn-ghost btn-sm" onclick="VetUI.staffPhotoPick()">'+I('camera')+' '+(d.photo?'Изменить фото':'Добавить фото')+'</button>'
        +(d.photo?'<button type="button" class="btn btn-ghost btn-sm" onclick="VetUI.staffPhotoClear()">'+I('x')+' Убрать</button>':'')
        +'</div>'
        +'<input type="hidden" id="f-staff-photo" value="'+esc(d.photo||'')+'">'
      +'</div>'
      +'</div>';
  }

  // Выбор фото сотрудника: файл -> base64 в скрытое поле формы.
  // Тот же лимит 200 КБ, что у фото животных: фото едет внутри записи
  // через синхронизацию, большие картинки раздували бы каждый push.
  function staffPhotoPick() {
    var inp = document.createElement('input');
    inp.type = 'file'; inp.accept = 'image/*';
    inp.onchange = function() {
      var f = inp.files && inp.files[0];
      if (!f) return;
      if (f.size > 204800) { toast('Фото больше 200 КБ — выберите меньше или обрежьте', 'err', 5000); return; }
      var reader = new FileReader();
      reader.onload = function(e) {
        var hidden = document.getElementById('f-staff-photo');
        if (hidden) hidden.value = e.target.result;
        var prev = document.getElementById('f-staff-photo-preview');
        if (prev) prev.outerHTML = '<img id="f-staff-photo-preview" src="'+e.target.result+'" style="width:56px;height:56px;border-radius:50%;object-fit:cover;border:2px solid var(--border);">';
      };
      reader.readAsDataURL(f);
    };
    inp.click();
  }
  function staffPhotoClear() {
    var hidden = document.getElementById('f-staff-photo');
    if (hidden) hidden.value = '';
    var prev = document.getElementById('f-staff-photo-preview');
    if (prev) prev.outerHTML = '<span id="f-staff-photo-preview"></span>';
  }

  function staffFormData() { return { name:document.getElementById('f-name').value.trim(), role:document.getElementById('f-role').value, phone:document.getElementById('f-phone').value.trim(), email:document.getElementById('f-email').value.trim(), notes:document.getElementById('f-notes').value.trim(), photo:(document.getElementById('f-staff-photo')||{}).value||'', is_active:true }; }

  // ── Vaccination form (с выбором владельца → питомца) ───────────────────
  function vaccinationFormHTML(d, petName, allOwners, allPets) {
    d=d||{};
    var adminAt=''; try{ adminAt=d.administered_at?new Date(d.administered_at).toISOString().slice(0,10):new Date().toISOString().slice(0,10); }catch(e){ adminAt=new Date().toISOString().slice(0,10); }
    var nextDue=''; try{ if(d.next_due_at) nextDue=new Date(d.next_due_at).toISOString().slice(0,10); }catch(e){}
    var ownerSection = '';
    if (allOwners && allPets) {
      var owners = allOwners.filter(function(o){return !o.is_deleted;}).sort(function(a,b){return a.fio.localeCompare(b.fio,'ru');});
      var currentOwner = d.pet_id ? allPets.find(function(p){return p.id===d.pet_id;}) : null;
      var currentOwnerId = currentOwner ? currentOwner.owner_id : '';
      var petsFiltered = currentOwnerId ? allPets.filter(function(p){return p.owner_id===currentOwnerId&&!p.is_deleted&&p.status==='active';}) : allPets.filter(function(p){return !p.is_deleted&&p.status==='active';});
      ownerSection = '<div class="form-group form-span-2"><label class="form-label">Владелец</label>'
        +'<select id="vacc-owner-sel" class="form-select">'
        +'<option value="">— Выберите владельца —</option>'
        +owners.map(function(o){return '<option value="'+o.id+'"'+(o.id===currentOwnerId?' selected':'')+'>'+esc(o.fio)+'</option>';}).join('')
        +'</select></div>'
        +'<div class="form-group form-span-2"><label class="form-label">Животное <span class="form-req">*</span></label>'
        +'<select id="f-pet-sel" class="form-select">'
        +'<option value="">— Выберите животное —</option>'
        +petsFiltered.map(function(p){return '<option value="'+p.id+'"'+(p.id===d.pet_id?' selected':'')+'>'+esc(p.name)+'</option>';}).join('')
        +'</select></div>';
    } else if (petName) {
      ownerSection = '<div class="form-group form-span-2"><div class="text-sm text-muted">Животное: <b>'+esc(petName)+'</b></div></div>';
    }
    return '<div class="form-grid">'
      +ownerSection
      +'<div class="form-group form-span-2"><label class="form-label">Вакцина <span class="form-req">*</span></label><input id="f-vaccine" class="form-input" value="'+esc(d.vaccine_name||'')+'" placeholder="Nobivac Tricat"></div>'
      +'<div class="form-group"><label class="form-label">Дата введения <span class="form-req">*</span></label><input id="f-admin-at" class="form-input" type="date" value="'+esc(adminAt)+'"></div>'
      +'<div class="form-group"><label class="form-label">Следующая вакцинация</label><input id="f-next-due" class="form-input" type="date" value="'+esc(nextDue)+'"></div>'
      +'<div class="form-group"><label class="form-label">Серия/партия</label><input id="f-batch" class="form-input" value="'+esc(d.batch_number||'')+'" placeholder="A123456"></div>'
      +'<div class="form-group"><label class="form-label">Производитель</label><input id="f-mfr" class="form-input" value="'+esc(d.manufacturer||'')+'" placeholder="Nobivac"></div>'
      +'<div class="form-group"><label class="form-label">Доза (мл)</label><input id="f-dose" class="form-input" type="number" step="0.1" min="0" value="'+esc(d.dose!=null?d.dose:'')+'" placeholder="1.0"></div>'
      +'<div class="form-group form-span-2"><label class="form-label">Примечания</label><textarea id="f-notes" class="form-textarea">'+esc(d.notes||'')+'</textarea></div>'
      +'<input type="hidden" id="f-pet-id" value="'+esc(d.pet_id||'')+'">'
      +'</div>';
  }

  function vaccinationFormAfterOpen(allPets) {
    var ownerSel = document.getElementById('vacc-owner-sel');
    if (!ownerSel || !allPets) return;
    ownerSel.addEventListener('change', function() {
      var ownerId = this.value;
      var petSel = document.getElementById('f-pet-sel');
      if (!petSel) return;
      var filtered = ownerId
        ? allPets.filter(function(p){return p.owner_id===ownerId&&!p.is_deleted&&p.status==='active';})
        : allPets.filter(function(p){return !p.is_deleted&&p.status==='active';});
      petSel.innerHTML = '<option value="">— Выберите животное —</option>'
        + filtered.map(function(p){return '<option value="'+p.id+'">'+esc(p.name)+'</option>';}).join('');
    });
    // Синхронизируем f-pet-id при выборе
    var petSel = document.getElementById('f-pet-sel');
    if (petSel) petSel.addEventListener('change', function() {
      document.getElementById('f-pet-id').value = this.value;
    });
  }

  function vaccinationFormData() {
    var dose=parseFloat(document.getElementById('f-dose').value);
    var petSel = document.getElementById('f-pet-sel');
    var petId = petSel ? petSel.value : (document.getElementById('f-pet-id') ? document.getElementById('f-pet-id').value : '');
    return { vaccine_name:document.getElementById('f-vaccine').value.trim(), administered_at:document.getElementById('f-admin-at').value, next_due_at:document.getElementById('f-next-due').value||null, batch_number:document.getElementById('f-batch').value.trim(), manufacturer:document.getElementById('f-mfr').value.trim(), dose:isNaN(dose)?null:dose, notes:document.getElementById('f-notes').value.trim(), pet_id:petId };
  }

  // ── Deceased pet form (список причин) ──────────────────────────────────
  function deceasedFormHTML(pet) {
    var today=new Date().toISOString().slice(0,10);
    var reasons = DEATH_REASONS.map(function(r){
      return '<option value="'+esc(r)+'">'+esc(r)+'</option>';
    }).join('');
    return '<div class="text-sm text-muted" style="margin-bottom:12px;">Животное: <b>'+esc(pet.name)+'</b>. История приёмов сохранится.</div>'
      +'<div class="form-grid">'
      +'<div class="form-group"><label class="form-label">Дата смерти <span class="form-req">*</span></label><input id="f-death-date" class="form-input" type="date" value="'+today+'"></div>'
      +'<div class="form-group form-span-2"><label class="form-label">Причина смерти</label>'
      +'<select id="f-death-reason" class="form-select"><option value="">— Выберите причину —</option>'+reasons+'</select></div>'
      +'</div>';
  }

  // ══════════════════════════════════════════════════════════════════════
  // FULL VISIT FORM
  // ══════════════════════════════════════════════════════════════════════

  var _vs = { ownerMode:'search', owner:null, ownerDraft:{fio:'',phone:'',iin:''}, pet:null, petDraft:null, showNewPet:false, condition:'' };

  // Локальное время в формате input[datetime-local] ("2026-07-17T21:40").
  // Не toISOString(): он даёт UTC, и офлайн-приём открывался бы со временем
  // на 5 часов назад (Астана +5).
  function localDatetimeStr(d) {
    var p = function(n){ return String(n).padStart(2,'0'); };
    return d.getFullYear()+'-'+p(d.getMonth()+1)+'-'+p(d.getDate())+'T'+p(d.getHours())+':'+p(d.getMinutes());
  }

  async function getServerTime() {
    try {
      var fn = window.__nativeFetch || window.fetch;
      var r  = await fn('/health', { headers: { 'X-Bypass-Local':'1' } });
      var d  = await r.json();
      if (d && d.data && d.data.time) return localDatetimeStr(new Date(d.data.time));
    } catch(e) {}
    return localDatetimeStr(new Date());
  }

  function buildVisitFormHTML(serverTime, prefill) {
    prefill  = prefill || {};
    // Дата по умолчанию — текущее время Астаны (UTC+5)
    // Астана = UTC+5. Date.now() всегда UTC, добавляем 5 часов → toISOString даёт Астана-время.
    // НЕ используем getTimezoneOffset — зависит от настроек браузера, ломается на девайсах в других TZ.
    var _astanaStr = new Date(Date.now() + 5 * 3600000).toISOString().slice(0, 16);
    var dateVal = prefill.date ? prefill.date.slice(0,16) : _astanaStr;
    var visitType = prefill.visit_type || 'первичный';
    var weight = prefill.animal_weight || '';
    // Приём открывают, чтобы записать осмотр, а не чтобы выбирать владельца:
    // при редактировании они уже известны. Поэтому первые две секции
    // сворачиваем — экономит ~300px, то есть треть прокрутки. У нового приёма
    // владельца ещё нет, там секции открыты.
    var isEdit = !!(prefill && prefill.id);
    var foldTop = isEdit ? ' collapsed' : '';

    return `<div class="visit-form" id="vf-root">

  <div class="visit-section${foldTop}" id="vs-owner">
    <div class="visit-section-header" onclick="VetUI._toggleSection('vs-owner')">
      <span class="visit-section-num">1</span><span>Владелец</span>
      <span class="vs-summary" id="vs-owner-summary"></span>
      <span class="vs-toggle">▾</span>
    </div>
    <div class="visit-section-body" id="vf-owner-area"></div>
  </div>

  <div class="visit-section${foldTop}" id="vs-pet">
    <div class="visit-section-header" onclick="VetUI._toggleSection('vs-pet')">
      <span class="visit-section-num">2</span><span>Животное</span>
      <span class="vs-summary" id="vs-pet-summary"></span>
      <span class="vs-toggle">▾</span>
    </div>
    <div class="visit-section-body" id="vf-pet-area"><div class="text-sm text-muted">Сначала укажите владельца</div></div>
  </div>

  <div class="visit-section" id="vs-data">
    <div class="visit-section-header" onclick="VetUI._toggleSection('vs-data')">
      <span class="visit-section-num">3</span><span>Данные приёма</span>
      <span class="vs-toggle">▾</span>
    </div>
    <div class="visit-section-body">
      <div style="display:flex;gap:12px;flex-wrap:wrap;margin-bottom:14px;">
        <div class="form-group" style="flex:0 0 200px;">
          <label class="form-label">Дата и время</label>
          <input id="f-visit-date" class="form-input" type="datetime-local" value="${esc(dateVal)}" oninput="VetUI.recalcTreatment()">
        </div>
        <div class="form-group" style="flex:0 0 180px;">
          <label class="form-label">Следующий приём</label>
          <input id="f-next-visit-date" class="form-input" type="date" value="${esc(prefill.next_visit_date?new Date(prefill.next_visit_date).toISOString().slice(0,10):'')}">
        </div>
        <div class="form-group" style="flex:0 0 165px;">
          <label class="form-label">Курс лечения, дней</label>
          <input id="f-treatment-days" class="form-input" type="number" min="0" max="365" step="1"
                 value="${esc(prefill.treatment_days ? prefill.treatment_days : '')}"
                 placeholder="0 — не назначен" oninput="VetUI.recalcTreatment()">
          <div id="f-treatment-hint" class="form-hint"></div>
        </div>
        <div class="form-group" style="flex:0 0 150px;">
          <label class="form-label">Вид приёма</label>
          <select id="f-visit-type" class="form-select">
            <option value="первичный"${visitType==='первичный'?' selected':''}>Первичный</option>
            <option value="вторичный"${visitType==='вторичный'?' selected':''}>Вторичный</option>
          </select>
        </div>
        <div class="form-group" style="flex:0 0 140px;">
          <label class="form-label">Вес животного (кг)</label>
          <input id="f-animal-weight" class="form-input" type="number" step="0.1" min="0" value="${esc(weight)}" placeholder="0.0">
        </div>
        <div class="form-group" style="flex:1;min-width:200px;">
          <label class="form-label">Состояние пациента</label>
          <div id="condition-tabs" class="condition-tabs mt-1">
            ${CONDITIONS.map(function(c){ return '<span class="condition-tab'+(c===(prefill.patient_condition||'')?' selected':'')+'" data-val="'+c+'">'+c+'</span>'; }).join('')}
          </div>
          <input type="hidden" id="f-condition" value="${esc(prefill.patient_condition||'')}">
        </div>
      </div>
      <div class="visit-details-2col">
        <div>
          <div class="form-group" style="margin-bottom:12px;">
            <label class="form-label">Анамнез</label>
            <textarea id="f-anamnesis" class="form-textarea vf-grow" rows="2" placeholder="История болезни, жалобы..." oninput="VetUI._autoGrow(this)">${esc(prefill.anamnesis||'')}</textarea>
          </div>
          <div class="form-group">
            <label class="form-label">Диагноз</label>
            <div class="autocomplete" style="width:100%;">
            <textarea id="f-diagnosis" class="form-textarea vf-grow" rows="2" placeholder="Поставленный диагноз..." oninput="VetUI._diagAutocomplete(this);VetUI._autoGrow(this)">${esc(prefill.diagnosis||'')}</textarea>
            <div class="autocomplete-dropdown" id="diag-dd" style="max-height:160px;overflow-y:auto;"></div>
            </div>
          </div>
        </div>
        <div>
          <div class="form-group" style="margin-bottom:12px;">
            <label class="form-label">Лечение</label>
            <textarea id="f-treatment" class="form-textarea vf-grow" rows="2" placeholder="Назначенное лечение..." oninput="VetUI._autoGrow(this)">${esc(prefill.treatment||'')}</textarea>
          </div>
          <div class="form-group">
            <label class="form-label">Примечания</label>
            <textarea id="f-vnotes" class="form-textarea vf-grow" rows="2" placeholder="Дополнительно..." oninput="VetUI._autoGrow(this)">${esc(prefill.notes||'')}</textarea>
          </div>
        </div>
      </div>
    </div>
  </div>

  <div class="visit-section" id="vs-items">
    <div class="visit-section-header" onclick="VetUI._toggleSection('vs-items')">
      <span class="visit-section-num">4</span><span>Услуги и препараты</span>
      <span class="vs-toggle">▾</span>
    </div>
    <div class="visit-section-body">
      <div class="vitems-header">
        <span>Наименование</span><span>Тип</span><span>Кол-во</span><span>Цена</span><span>Себест.</span><span>Итого</span><span></span>
      </div>
      <div id="vitem-rows"></div>
      <div class="flex-gap mt-2">
        <button class="btn-add-vitem" id="btn-add-vitem">+ Добавить позицию</button>
      </div>
      <div class="vitems-total-row">
        <span class="text-muted text-sm">Итого:</span>
        <span class="vitems-total-amount" id="vitem-total">0 ₸</span>
      </div>
    </div>

    <!-- Оплата. Свёрнута по умолчанию: наличными платят чаще всего, и тогда
         поле «картой» трогать не надо — сумма считается сама. Разворачивают
         только при безналичной оплате. Если карта уже была указана —
         показываем развёрнутой, иначе врач не увидит, что там есть данные. -->
    <div class="vf-section">
      <div class="vf-section-title" onclick="VetUI._toggleSection('vf-payment')">
        ${I('card')} Оплата
        <span class="vs-summary" id="vf-payment-summary">${prefill && prefill.payment_card ? 'картой ' + prefill.payment_card + ' ₸' : 'наличными'}</span>
        <span class="vf-section-arrow">▾</span>
      </div>
      <div class="vf-section-body${prefill && prefill.payment_card ? '' : ' collapsed'}" id="vf-payment">
        <div class="payment-row">
          <div class="payment-field">
            <label class="form-label">${I('card')} Оплата картой (безнал), ₸</label>
            <input id="f-payment-card" class="form-input" type="number" min="0" step="1"
                   placeholder="0" value="${prefill && prefill.payment_card ? prefill.payment_card : 0}"
                   oninput="VetUI._updatePaymentSummary()">
          </div>
          <div class="payment-field">
            <label class="form-label">${I('cash')} Наличные, ₸</label>
            <div class="payment-cash-display" id="payment-cash-display">—</div>
          </div>
        </div>
      </div>
    </div>
  </div>

  <!-- Вложения: сканы УЗИ, рентгена, анализов.
       Наполняется VetPages.renderAttachments после открытия формы —
       у нового приёма ещё нет id, вкладывать не к чему. -->
  <div id="visit-attachments" class="attach-box"></div>
</div>`;
  }

  // Растущее поле: высота по содержимому, но не больше 40% экрана —
  // иначе длинный анамнез вытолкнет всё остальное за пределы формы.
  function _autoGrow(el) {
    if (!el) return;
    el.style.height = 'auto';
    var max = Math.round(window.innerHeight * 0.4);
    el.style.height = Math.min(el.scrollHeight + 2, max) + 'px';
    el.style.overflowY = el.scrollHeight > max ? 'auto' : 'hidden';
  }

  // Прогоняем по всем растущим полям — при открытии формы, чтобы уже
  // заполненный анамнез был виден целиком, а не в две строки со скроллом.
  function _autoGrowAll(root) {
    (root || document).querySelectorAll('.vf-grow').forEach(_autoGrow);
  }

  function _toggleSection(id) {
    var sec = document.getElementById(id);
    if (sec) sec.classList.toggle('collapsed');
  }

  // Пересчитывает итоги оплаты: наличные = итого − карта, доля клиники, заработок врача
  function _updatePaymentSummary() {
    var totalEl = document.getElementById('vitem-total');
    var cardEl  = document.getElementById('f-payment-card');
    var cashEl  = document.getElementById('payment-cash-display');
    var clinicEl = document.getElementById('payment-clinic-display');
    var doctorEl = document.getElementById('payment-doctor-display');
    if (!totalEl || !cardEl) return;

    var total = parseFloat(totalEl.textContent) || 0;
    var card  = Math.max(0, Math.min(parseFloat(cardEl.value) || 0, total));
    var cash  = Math.max(0, total - card);

    // Себестоимость = сумма cost_price по всем позициям
    var clinic = 0;
    document.querySelectorAll('.vitem-row').forEach(function(row) {
      var id = row.dataset.rowId;
      var qEl = document.getElementById('vit-q-'+id);
      var cEl = document.getElementById('vit-c-'+id);
      var pEl = document.getElementById('vit-p-'+id);
      var qty = parseFloat(qEl && qEl.value) || 1;
      var cp  = parseFloat(cEl && cEl.value) || 0;
      if (!cp && pEl) cp = Math.round(parseFloat(pEl.value || 0) * 0.5 * 100) / 100;
      clinic += qty * cp;
    });
    clinic = Math.round(clinic * 100) / 100;
    var doctor = Math.round(Math.max(0, total - clinic) * 100) / 100;

    if (cashEl)   cashEl.textContent   = cash.toFixed(0) + ' ₸';
    if (clinicEl) clinicEl.textContent = clinic.toFixed(0) + ' ₸';
    if (doctorEl) doctorEl.textContent = doctor.toFixed(0) + ' ₸';
  }

  function initVisitForm(allOwners, allPets, allItems, prefillOwner, prefillPet) {
    // Подгоняем высоту заполненных полей под текст сразу при открытии.
    setTimeout(function(){ _autoGrowAll(document.getElementById('vf-root')); }, 30);
    _vs = {
      ownerMode: prefillOwner ? 'selected' : 'search',
      owner:     prefillOwner || null,
      ownerDraft: { fio:'', phone:'', iin:'' },
      pet:       prefillPet || null,
      petDraft:  null,
      showNewPet: !prefillPet && prefillOwner && allPets.filter(function(p){ return p.owner_id===prefillOwner.id && !p.is_deleted && p.status==='active'; }).length === 0,
      condition: '',
    };
    var ctabs = document.getElementById('condition-tabs');
    if (ctabs) ctabs.addEventListener('click', function(e) {
      var tab = e.target.closest('.condition-tab');
      if (!tab) return;
      ctabs.querySelectorAll('.condition-tab').forEach(function(t){ t.classList.remove('selected'); });
      tab.classList.add('selected');
      document.getElementById('f-condition').value = tab.dataset.val;
    });
    var addBtn = document.getElementById('btn-add-vitem');
    if (addBtn) addBtn.onclick = function(){ addVisitItemRow(allItems); };
    renderOwnerArea(allOwners, allPets, allItems);
  }

  // Свёрнутая секция не должна прятать то, ради чего врач в неё смотрит.
  // Пишем владельца и животное прямо в шапку — она видна всегда.
  function _updateSectionSummaries() {
    var o = document.getElementById('vs-owner-summary');
    var p = document.getElementById('vs-pet-summary');
    if (o) o.textContent = _vs.owner ? _vs.owner.fio : '';
    if (p) {
      p.textContent = _vs.pet
        ? _vs.pet.name + (_vs.pet.type ? ' · ' + _vs.pet.type : '') +
          (_vs.pet.weight ? ' · ' + _vs.pet.weight + ' кг' : '')
        : '';
    }
  }

  function renderOwnerArea(allOwners, allPets, allItems) {
    var area = document.getElementById('vf-owner-area');
    if (!area) return;
    _updateSectionSummaries();
    if (_vs.ownerMode === 'selected' && _vs.owner) {
      area.innerHTML = '<div class="selected-card">'+avatar(_vs.owner.fio,'owner')+'<div class="selected-card-info"><div class="selected-card-title">'+esc(_vs.owner.fio)+'</div><div class="selected-card-sub">'+esc(_vs.owner.phone||'')+'</div></div><span class="selected-card-clear" id="vf-clear-owner">&times;</span></div>';
      document.getElementById('vf-clear-owner').onclick = function() {
        _vs.ownerMode='search'; _vs.owner=null; _vs.pet=null; _vs.petDraft=null; _vs.showNewPet=false;
        renderOwnerArea(allOwners,allPets,allItems); renderPetArea([],allPets,allItems);
      };
      var ownerPets = allPets.filter(function(p){ return p.owner_id===_vs.owner.id && !p.is_deleted && p.status==='active'; });
      renderPetArea(ownerPets, allPets, allItems);
    } else if (_vs.ownerMode === 'new') {
      // Полная форма владельца — те же поля что и при обычном создании
      area.innerHTML = '<div class="inline-create-box">'
        +'<div class="inline-create-box-header"><span class="inline-create-label">Новый владелец</span>'
        +'<button class="btn btn-sm btn-ghost" id="vf-cancel-new-owner">← К поиску</button></div>'
        +'<div class="form-grid">'
        +'<div class="form-group form-span-2"><label class="form-label">ФИО <span class="form-req">*</span></label>'
        +'<input id="vf-new-owner-fio" class="form-input" value="'+esc(_vs.ownerDraft.fio||'')+'" placeholder="Иванов Иван Иванович" autofocus></div>'
        +'<div class="form-group"><label class="form-label">Телефон <span class="form-req">*</span></label>'
        +'<input id="vf-new-owner-phone" class="form-input" type="tel" value="'+esc(_vs.ownerDraft.phone||'')+'" placeholder="+7 777 000 0000"></div>'
        +'<div class="form-group"><label class="form-label">ИИН</label>'
        +'<input id="vf-new-owner-iin" class="form-input" value="'+esc(_vs.ownerDraft.iin||'')+'" maxlength="12" placeholder="12 цифр"></div>'
        +'<div class="form-group form-span-2"><label class="form-label">Адрес</label>'
        +'<input id="vf-new-owner-address" class="form-input" value="'+esc(_vs.ownerDraft.address||'')+'" placeholder="Город, улица, дом, кв."></div>'
        +'<div class="form-group form-span-2"><label class="form-label">Примечания</label>'
        +'<textarea id="vf-new-owner-notes" class="form-textarea" rows="2" placeholder="Дополнительная информация...">'+esc(_vs.ownerDraft.notes||'')+'</textarea></div>'
        +'</div></div>';
      document.getElementById('vf-cancel-new-owner').onclick = function() {
        _vs.ownerMode='search'; _vs.ownerDraft={fio:'',phone:'',iin:'',address:'',notes:''};
        renderOwnerArea(allOwners,allPets,allItems);
      };
      _vs.showNewPet = true;
      renderPetArea([], allPets, allItems);
    } else {
      area.innerHTML = '<div class="autocomplete"><input class="form-input" id="vf-owner-search" placeholder="Поиск по имени или телефону..."><div class="autocomplete-dropdown" id="vf-owner-dd"></div></div>';
      var inp = document.getElementById('vf-owner-search');
      var dd  = document.getElementById('vf-owner-dd');
      function placeDD() { var r=inp.getBoundingClientRect(); Object.assign(dd.style,{position:'fixed',top:(r.bottom+2)+'px',left:r.left+'px',width:r.width+'px',zIndex:'3000',maxHeight:'240px'}); }
      inp.addEventListener('input', function() {
        var q = inp.value.trim(); if (!q) { dd.classList.remove('show'); return; }
        var ql = q.toLowerCase();
        var matches = allOwners.filter(function(o){ return !o.is_deleted && (o.fio+' '+(o.phone||'')+(o.iin||'')).toLowerCase().includes(ql); }).slice(0,6);
        var html = matches.map(function(o){ return '<div class="ac-item" data-id="'+o.id+'"><div class="ac-item-title">'+esc(o.fio)+'</div><div class="ac-item-sub">'+esc(o.phone||'')+'</div></div>'; }).join('');
        if (q.length>=1) html += '<div class="ac-item ac-create" id="vf-create-owner"><div class="ac-item-title">+ Создать нового: «'+esc(q)+'»</div></div>';
        dd.innerHTML = html; placeDD(); dd.classList.toggle('show', !!html);
        dd.querySelectorAll('.ac-item:not(.ac-create)').forEach(function(el) {
          el.onclick = function() { var o=allOwners.find(function(x){return x.id===el.dataset.id;}); if(o){_vs.ownerMode='selected';_vs.owner=o;dd.classList.remove('show');renderOwnerArea(allOwners,allPets,allItems);} };
        });
        var cBtn=dd.querySelector('.ac-create'); if(cBtn) cBtn.onclick=function(){_vs.ownerMode='new';_vs.ownerDraft.fio=q;dd.classList.remove('show');renderOwnerArea(allOwners,allPets,allItems);};
      });
      inp.addEventListener('keydown', function(e) {
        if (e.key!=='Enter') return; e.preventDefault();
        var q=inp.value.trim(); if(!q) return;
        var first=dd.querySelector('.ac-item:not(.ac-create)');
        if (first&&dd.classList.contains('show')) first.click();
        else { _vs.ownerMode='new'; _vs.ownerDraft={fio:q,phone:'',iin:''}; dd.classList.remove('show'); renderOwnerArea(allOwners,allPets,allItems); }
      });
      inp.addEventListener('blur', function(){ setTimeout(function(){ dd.classList.remove('show'); },220); });
      inp.focus();
      renderPetArea([], allPets, allItems);
    }
  }

  function renderPetArea(ownerPets, allPets, allItems) {
    var area = document.getElementById('vf-pet-area');
    if (!area) return;
    _updateSectionSummaries();
    if (_vs.ownerMode==='search' && !_vs.owner) { area.innerHTML='<div class="text-sm text-muted">Сначала укажите владельца</div>'; return; }
    if (_vs.pet) {
      var p = _vs.pet;
      var lastVacc = p._lastVacc;

      // Аватар или фото питомца
      var petMedia = p.photo
        ? '<img src="'+esc(p.photo)+'" style="width:52px;height:52px;border-radius:50%;object-fit:cover;border:2px solid var(--border);flex-shrink:0;">'
        : '<div style="width:52px;height:52px;border-radius:50%;background:var(--accent-dim);border:2px solid var(--accent-border);display:flex;align-items:center;justify-content:center;font-size:1.5rem;flex-shrink:0;">'+(SPECIES_ICONS_UI[(p.type||'').toLowerCase()]||'🐾')+'</div>';

      // Вакцинация
      var vaccRow = lastVacc
        ? '<div style="font-size:.75rem;color:var(--text-3);margin-top:5px;display:flex;gap:6px;align-items:center;">'
          +'<span>'+I('syringe')+'</span>'
          +'<span>'+esc(lastVacc.vaccine_name)+'</span>'
          +'<span style="color:var(--border);">·</span>'
          +'<span>'+esc((lastVacc.administered_at||'').slice(0,10))+'</span>'
          +(lastVacc.next_due_at ? '<span style="color:var(--border);">·</span><span>Сл.: <b>'+esc(lastVacc.next_due_at.slice(0,10))+'</b></span>' : '')
          +'</div>'
        : '';

      // Основная информация
      var petInfo = '<div style="display:flex;align-items:center;gap:12px;flex:1;">'
        +petMedia
        +'<div style="flex:1;min-width:0;">'
        +'<div style="font-weight:700;font-size:.95rem;color:var(--text);">'+esc(p.name)+'</div>'
        +'<div style="font-size:.82rem;color:var(--text-2);margin-top:2px;">'
        +esc(p.type||'')+(p.breed?' · '+esc(p.breed):'')+(p.weight?' · '+I('scale')+' '+p.weight+' кг':'')
        +'</div>'
        +vaccRow
        +'</div></div>';

      area.innerHTML = '<div style="display:flex;align-items:center;gap:8px;padding:10px 14px;'
        +'background:var(--accent-dim);border:1.5px solid var(--accent-border);border-radius:var(--r-lg);">'
        +petInfo
        +'<button style="width:32px;height:32px;border-radius:50%;background:none;border:none;color:var(--text-3);cursor:pointer;font-size:1rem;flex-shrink:0;display:flex;align-items:center;justify-content:center;transition:background .15s;" id="vf-clear-pet" title="Изменить животное">&times;</button>'
        +'</div>';

      document.getElementById('vf-clear-pet').onclick = function() {
        _vs.pet=null; _vs.petDraft=null;
        renderPetArea(ownerPets,allPets,allItems);
      };
      return;
    }
    var html='';
    if (ownerPets&&ownerPets.length>0&&!_vs.showNewPet) {
      html+='<div class="pet-chips">'+ownerPets.map(function(p){
        var chipMedia = p.photo
          ? '<img src="'+esc(p.photo)+'" style="width:28px;height:28px;border-radius:50%;object-fit:cover;flex-shrink:0;">'
          : '<span style="font-size:1.1rem;flex-shrink:0;">'+( SPECIES_ICONS_UI[(p.type||'').toLowerCase()] || '🐾' )+'</span>';
        return '<span class="pet-chip" data-id="'+p.id+'">'+chipMedia+' '+esc(p.name)+'</span>';
      }).join('')+'</div>';
      html+='<button class="btn btn-sm btn-ghost" id="vf-show-new-pet" style="margin-top:8px;">+ Новое животное</button>';
    }
    if (_vs.showNewPet || !ownerPets || ownerPets.length===0) {
      if (!ownerPets||ownerPets.length===0) html+='<div class="text-sm text-muted" style="margin-bottom:10px;">Нет активных животных. Создайте нового:</div>';
      if (ownerPets&&ownerPets.length>0) html+='<div class="divider"></div>';
      // Полная форма питомца — те же поля что и при обычном создании
      var pd = _vs.petDraft || {};
      html+='<div class="inline-create-box"><div class="inline-create-box-header"><span class="inline-create-label">Новое животное</span>'
        +(ownerPets&&ownerPets.length>0?'<button class="btn btn-sm btn-ghost" id="vf-cancel-new-pet">Отмена</button>':'')+'</div>'
        +'<div class="form-grid">'
        // Основные
        +'<div class="form-group"><label class="form-label">Кличка <span class="form-req">*</span></label>'
        +'<input id="vf-pet-name" class="form-input" value="'+esc(pd.name||'')+'" placeholder="Барсик"></div>'
        +'<div class="form-group"><label class="form-label">Вид <span class="form-req">*</span></label>'
        +'<select id="vf-pet-type" class="form-select">'+petTypeOpts(pd.type||'кошка')+'</select></div>'
        +'<div class="form-group"><label class="form-label">Пол <span class="form-req">*</span></label>'
        +'<select id="vf-pet-gender" class="form-select">'
        +'<option value="m"'+(pd.gender!=='f'?' selected':'')+'>Самец</option>'
        +'<option value="f"'+(pd.gender==='f'?' selected':'')+'>Самка</option>'
        +'</select></div>'
        +'<div class="form-group"><label class="form-label">Порода</label>'
        +'<input id="vf-pet-breed" class="form-input" value="'+esc(pd.breed||'')+'" placeholder="Дворняга"></div>'
        // Возраст с авторасчётом
        +'<div class="form-group form-span-2"><label class="form-label">Возраст</label>'
        +'<div style="display:flex;gap:8px;align-items:center;">'
        +'<input id="vf-pet-age-y" class="form-input" type="number" min="0" max="50" value="'+esc(pd.age_years||0)+'" placeholder="0" style="width:72px;"> лет'
        +'<input id="vf-pet-age-m" class="form-input" type="number" min="0" max="11" value="'+esc(pd.age_months||0)+'" placeholder="0" style="width:72px;margin-left:8px;"> мес'
        +'<span style="color:var(--text-3);font-size:.78rem;margin-left:6px;">↕</span>'
        +'</div></div>'
        +'<div class="form-group form-span-2"><label class="form-label">Дата рождения</label>'
        +'<input id="vf-pet-birth" class="form-input" type="date" value="'+esc(pd.birth_date||'')+'"></div>'
        // Дополнительные
        +'<div class="form-group"><label class="form-label">Вес (кг)</label>'
        +'<input id="vf-pet-weight" class="form-input" type="number" step="0.1" min="0" value="'+esc(pd.weight!=null?pd.weight:'')+'" placeholder="3.5"></div>'
        +'<div class="form-group"><label class="form-label">Цвет / окрас</label>'
        +'<input id="vf-pet-color" class="form-input" value="'+esc(pd.color||'')+'" placeholder="Рыжий"></div>'
        +'<div class="form-group form-span-2"><label class="form-label">Примечания</label>'
        +'<textarea id="vf-pet-notes" class="form-textarea" rows="2" placeholder="Аллергии, особенности...">'+esc(pd.notes||'')+'</textarea></div>'
        +'</div></div>';
    }
    area.innerHTML = html;
    area.querySelectorAll('.pet-chip').forEach(function(chip) {
      chip.onclick = function() {
        var p = allPets.find(function(x){ return x.id===chip.dataset.id; });
        if (!p) return;
        // Загружаем вакцинации питомца
        var setAndRender = function() {
          _vs.pet=p; _vs.petDraft=null;
          renderPetArea(ownerPets, allPets, allItems);
          // Автозаполнение веса из последнего приёма
          window.VetDB.getAll('visits').then(function(visits) {
            var petVisits = visits.filter(function(v){ return !v.is_deleted && v.pet_id===p.id && v.animal_weight; });
            petVisits.sort(function(a,b){ return new Date(b.date)-new Date(a.date); });
            if (petVisits.length) {
              var wEl = document.getElementById('f-animal-weight');
              if (wEl && !wEl.value) wEl.value = petVisits[0].animal_weight;
            }
          }).catch(function(){});
          // Обновляем заголовок модалки
          var mt = document.getElementById('modal-title');
          if (mt && _vs.owner) {
            mt.innerHTML = '<span>Новый приём</span>'
              +'<span style="color:var(--text-2);font-weight:500;font-size:.9rem;margin-left:10px;">'
              +esc(p.name)+(p.type?' · '+esc(p.type):'')
              +(p.weight?' · '+I('scale')+' '+p.weight+' кг':'')
              +'</span>';
          }
        };
        if (window.VetDB) {
          window.VetDB.getAll('vaccinations').then(function(vaccs) {
            var pv = vaccs.filter(function(v){ return v.pet_id===p.id && !v.is_deleted; })
                         .sort(function(a,b){ return (b.administered_at||'')>(a.administered_at||'')?1:-1; });
            p._lastVacc = pv[0] || null;
            setAndRender();
          });
        } else {
          setAndRender();
        }
      };
    });
    var showNewBtn=document.getElementById('vf-show-new-pet'); if(showNewBtn) showNewBtn.onclick=function(){_vs.showNewPet=true;renderPetArea(ownerPets,allPets,allItems);};
    var cancelNewPet=document.getElementById('vf-cancel-new-pet'); if(cancelNewPet) cancelNewPet.onclick=function(){_vs.showNewPet=false;_vs.petDraft=null;renderPetArea(ownerPets,allPets,allItems);};

    // Авторасчёт возраста ↔ дата рождения для инлайн-формы нового питомца
    var yrEl = document.getElementById('vf-pet-age-y');
    var moEl = document.getElementById('vf-pet-age-m');
    var brEl = document.getElementById('vf-pet-birth');
    if (yrEl && moEl && brEl) {
      function _calcBirthFromAge() {
        var y=parseInt(yrEl.value)||0; var m=parseInt(moEl.value)||0;
        var d=new Date(); d.setMonth(d.getMonth()-(y*12+m));
        brEl.value=d.toISOString().slice(0,10);
      }
      function _calcAgeFromBirth() {
        var b=brEl.value; if(!b) return;
        var bd=new Date(b); var now=new Date();
        var total=Math.max(0,(now.getFullYear()-bd.getFullYear())*12+(now.getMonth()-bd.getMonth()));
        yrEl.value=Math.floor(total/12); moEl.value=total%12;
      }
      yrEl.addEventListener('input', _calcBirthFromAge);
      moEl.addEventListener('input', _calcBirthFromAge);
      brEl.addEventListener('change', _calcAgeFromBirth);
      // Инициализируем если есть дата рождения
      if (brEl.value) _calcAgeFromBirth();
    }
  }

  var _vitCnt = 0;
  function addVisitItemRow(allItems, prefill) {
    prefill=prefill||{};
    var id=++_vitCnt;
    var row=document.createElement('div'); row.className='vitem-row'; row.dataset.rowId=id;
    row.innerHTML='<div class="vitem-name-wrap autocomplete"><input class="vitem-input" placeholder="Услуга или препарат" id="vit-n-'+id+'" value="'+esc(prefill.name||'')+'"><div class="autocomplete-dropdown" id="vit-dd-'+id+'"></div></div>'
      +'<select class="vitem-input" id="vit-t-'+id+'"><option value="service"'+(prefill.type!=='drug'?' selected':'')+'>Услуга</option><option value="drug"'+(prefill.type==='drug'?' selected':'')+'>Препарат</option></select>'
      +'<input class="vitem-input" type="number" min="0.01" step="0.01" id="vit-q-'+id+'" value="'+esc(prefill.quantity||1)+'">'
      +'<input class="vitem-input" type="number" min="0" step="0.01" id="vit-p-'+id+'" value="'+esc(prefill.price||0)+'">'
      +'<input class="vitem-input" type="number" min="0" step="0.01" id="vit-c-'+id+'" value="'+esc(prefill.cost_price||0)+'" placeholder="0" title="Себестоимость">'
      +'<span class="vitem-total" id="vit-tot-'+id+'">0 ₸</span>'
      +'<button class="btn btn-icon danger" data-rem="'+id+'">&#x2715;</button>';
    document.getElementById('vitem-rows').appendChild(row);
    var inp=row.querySelector('#vit-n-'+id); var dd=row.querySelector('#vit-dd-'+id);
    inp.addEventListener('input',function(){
      var q=inp.value.toLowerCase(); if(!q){dd.classList.remove('show');return;}
      var res=(allItems||[]).filter(function(it){return !it.is_deleted&&it.is_active!==false&&it.name.toLowerCase().includes(q);}).slice(0,8);
      // data-id — ОБЯЗАТЕЛЬНО для отчёта: без него cost_price не попадает в кассовую стоимость
      dd.innerHTML=res.map(function(it){return '<div class="ac-item" data-id="'+esc(it.id)+'" data-n="'+esc(it.name)+'" data-t="'+it.type+'" data-p="'+it.price+'" data-c="'+esc(it.cost_price||0)+'"><div class="ac-item-title">'+esc(it.name)+'</div><div class="ac-item-sub">'+(it.type==='drug'?'Препарат':'Услуга')+' · '+it.price+' ₸'+(it.cost_price?' · касса: '+it.cost_price+' ₸':'')+'</div></div>';}).join('');
      var r=inp.getBoundingClientRect(); Object.assign(dd.style,{position:'fixed',top:(r.bottom+2)+'px',left:r.left+'px',width:r.width+'px',zIndex:'3000',maxHeight:'200px'});
      dd.classList.toggle('show',res.length>0);
      dd.querySelectorAll('.ac-item').forEach(function(el){
        el.onclick=function(){
          inp.value=el.dataset.n;
          document.getElementById('vit-t-'+id).value=el.dataset.t;
          document.getElementById('vit-p-'+id).value=el.dataset.p;
          // Заполняем себестоимость из каталога
          var costEl=document.getElementById('vit-c-'+id);
          if(costEl) costEl.value=el.dataset.c||'';
          // Сохраняем item_id — необходим для кассовой стоимости в отчёте
          row.dataset.itemId = el.dataset.id || '';
          dd.classList.remove('show');
          updateVitRow(id);
        };
      });
    });
    inp.addEventListener('blur',function(){setTimeout(function(){dd.classList.remove('show');},200);});
    ['vit-q-'+id,'vit-p-'+id,'vit-c-'+id].forEach(function(eid){var el=document.getElementById(eid);if(el)el.addEventListener('input',function(){updateVitRow(id);});});
    row.querySelector('[data-rem]').onclick=function(){row.remove();updateVitTotal();};
    updateVitRow(id);
    if(prefill.item_id) row.dataset.itemId=prefill.item_id;
  }

  function updateVitRow(id){var q=parseFloat(document.getElementById('vit-q-'+id).value)||0;var p=parseFloat(document.getElementById('vit-p-'+id).value)||0;var t=Math.round(q*p*100)/100;document.getElementById('vit-tot-'+id).textContent=t.toFixed(0)+' ₸';updateVitTotal();}
  function updateVitTotal(){var tot=0;document.querySelectorAll('[id^="vit-tot-"]').forEach(function(el){tot+=parseFloat(el.textContent)||0;});var el=document.getElementById('vitem-total');if(el)el.textContent=tot.toFixed(0)+' ₸'; _updatePaymentSummary();}
  function collectVisitItems(){var items=[];document.querySelectorAll('.vitem-row').forEach(function(row){var id=row.dataset.rowId;var name=document.getElementById('vit-n-'+id).value.trim();var type=document.getElementById('vit-t-'+id).value;var qty=parseFloat(document.getElementById('vit-q-'+id).value)||1;var price=parseFloat(document.getElementById('vit-p-'+id).value)||0;var costEl=document.getElementById('vit-c-'+id);var costPrice=costEl?parseFloat(costEl.value)||0:Math.round(price*0.5*100)/100;if(!name)return;items.push({item_id:row.dataset.itemId||null,name:name,type:type,quantity:qty,price:price,cost_price:costPrice,total:Math.round(qty*price*100)/100});});return items;}

  function getVisitState() {
    // Собираем данные нового владельца — все поля
    var ownerNew=null;
    if(_vs.ownerMode==='new'){
      var _g=function(id,def){var el=document.getElementById(id);return el?el.value.trim():(def||'');};
      ownerNew={
        fio:     _g('vf-new-owner-fio',    _vs.ownerDraft.fio),
        phone:   _g('vf-new-owner-phone',  _vs.ownerDraft.phone),
        iin:     _g('vf-new-owner-iin',    _vs.ownerDraft.iin),
        address: _g('vf-new-owner-address',_vs.ownerDraft.address||''),
        notes:   _g('vf-new-owner-notes',  _vs.ownerDraft.notes||''),
      };
    }
    var petNew=null;
    if(_vs.showNewPet){
      var _gp=function(id,def){var el=document.getElementById(id);return el?el.value.trim():(def||'');};
      petNew={
        name:       _gp('vf-pet-name'),
        type:       _gp('vf-pet-type','кошка'),
        gender:     _gp('vf-pet-gender','m'),
        breed:      _gp('vf-pet-breed'),
        birth_date: _gp('vf-pet-birth'),
        notes:      _gp('vf-pet-notes'),
      };
    }
    var aw=parseFloat(document.getElementById('f-animal-weight')?document.getElementById('f-animal-weight').value:'')||null;
    var nvd=document.getElementById('f-next-visit-date')?document.getElementById('f-next-visit-date').value:'';
    var paymentCard=parseFloat(document.getElementById('f-payment-card')?document.getElementById('f-payment-card').value:'')||0;
    return {
      owner:_vs.owner, ownerNew:ownerNew, ownerMode:_vs.ownerMode,
      pet:_vs.pet, petNew:petNew,
      date:document.getElementById('f-visit-date')?document.getElementById('f-visit-date').value:'',
      next_visit_date:nvd,
      treatment_days:parseInt((document.getElementById('f-treatment-days')||{}).value,10)||0,
      visit_type:document.getElementById('f-visit-type')?document.getElementById('f-visit-type').value:'первичный',
      animal_weight:aw,
      condition:document.getElementById('f-condition')?document.getElementById('f-condition').value:'',
      anamnesis:document.getElementById('f-anamnesis')?document.getElementById('f-anamnesis').value.trim():'',
      diagnosis:document.getElementById('f-diagnosis')?document.getElementById('f-diagnosis').value.trim():'',
      treatment:document.getElementById('f-treatment')?document.getElementById('f-treatment').value.trim():'',
      notes:document.getElementById('f-vnotes')?document.getElementById('f-vnotes').value.trim():'',
      payment_card:paymentCard,
      items:collectVisitItems(),
    };
  }


  // ── Автодополнение диагноза ───────────────────────────────────────────────
  // Дропдаун рендерится в body (position:fixed) чтобы не обрезался
  // overflow:auto контейнером модалки.
  var _diagDDEl = null;

  function _diagGetDD() {
    if (!_diagDDEl) {
      _diagDDEl = document.createElement('div');
      _diagDDEl.id = 'diag-dd-global';
      _diagDDEl.style.cssText = [
        'position:fixed',
        'z-index:9999',
        'background:var(--bg-s)',
        'border:1.5px solid var(--border)',
        'border-radius:var(--r-lg)',
        'box-shadow:var(--shadow-lg)',
        'max-height:220px',
        'overflow-y:auto',
        'display:none',
        'min-width:280px',
      ].join(';');
      document.body.appendChild(_diagDDEl);
      // Закрываем при клике вне
      document.addEventListener('click', function(e) {
        if (_diagDDEl && !_diagDDEl.contains(e.target) && e.target.id !== 'f-diagnosis') {
          _diagDDEl.style.display = 'none';
        }
      }, true);
    }
    return _diagDDEl;
  }

  function _diagAutocomplete(textarea) {
    var q = textarea.value.trim();
    var dd = _diagGetDD();
    if (q.length < 2) { dd.style.display = 'none'; return; }

    // Позиционируем под textarea
    var rect = textarea.getBoundingClientRect();
    dd.style.left  = rect.left + 'px';
    dd.style.top   = (rect.bottom + 4) + 'px';
    dd.style.width = rect.width + 'px';

    window.VetDB.getAll('visits').then(function(visits) {
      var seen = {};
      var suggestions = [];
      visits.forEach(function(v) {
        if (!v.is_deleted && v.diagnosis) {
          v.diagnosis.split('\n').forEach(function(line) {
            line = line.trim();
            if (line && line.toLowerCase().includes(q.toLowerCase())) {
              if (!seen[line]) { seen[line] = true; suggestions.push(line); }
            }
          });
        }
      });
      suggestions = suggestions.slice(0, 8);
      if (!suggestions.length) { dd.style.display = 'none'; return; }
      dd.innerHTML = suggestions.map(function(s) {
        return '<div class="ac-item" style="padding:10px 14px;cursor:pointer;border-bottom:1px solid var(--border);font-size:.88rem;">'
          + '<div style="font-weight:600;color:var(--text);">' + esc(s) + '</div></div>';
      }).join('');
      dd.style.display = 'block';
      dd.querySelectorAll('.ac-item').forEach(function(item, idx) {
        item.onclick = function() {
          textarea.value = suggestions[idx];
          dd.style.display = 'none';
        };
      });
    }).catch(function() { dd.style.display = 'none'; });
  }

  window.VetUI = {
    icon:icon, esc:esc, avatar:avatar,
    toast:toast, confirm:confirm,
    showModal:showModal, hideModal:hideModal,
    ownerFormHTML:ownerFormHTML, ownerFormData:ownerFormData,
    petFormHTML:petFormHTML, petFormData:petFormData, petFormAfterOpen:petFormAfterOpen,
    itemFormHTML:itemFormHTML, itemFormData:itemFormData, recalcItemCost:recalcItemCost,
    checkChip:checkChip, normalizeChip:normalizeChip,
    _autoGrow:_autoGrow, _autoGrowAll:_autoGrowAll,
    recalcTreatment:recalcTreatment, treatmentUntil:treatmentUntil,
    staffFormHTML:staffFormHTML, staffFormData:staffFormData,
    staffPhotoPick:staffPhotoPick, staffPhotoClear:staffPhotoClear,
    vaccinationFormHTML:vaccinationFormHTML, vaccinationFormData:vaccinationFormData, vaccinationFormAfterOpen:vaccinationFormAfterOpen,
    deceasedFormHTML:deceasedFormHTML,
    getServerTime:getServerTime,
    buildVisitFormHTML:buildVisitFormHTML,
    initVisitForm:initVisitForm,
    addVisitItemRow:addVisitItemRow,
    collectVisitItems:collectVisitItems,
    getVisitState:getVisitState,
    _toggleSection:_toggleSection,
    _updatePaymentSummary:_updatePaymentSummary,
    _diagAutocomplete:_diagAutocomplete,
  };

}());
