/* modules/print.js — печатные формы (вынесены из pages.js).
 *
 * Здесь только генерация документов: карточка приёма, карточка владельца,
 * паспорт питомца, справка о вакцинации, согласие на процедуру. Сам
 * printHTML остался в ядре — им пользуются и другие модули (чипирование).
 *
 * Самодостаточный IIFE по образцу warehouse/chips/schedule: помощники ядра
 * через window.VetPagesCore, тело функций при переносе не менялось.
 * Грузится ПОСЛЕ pages.js.
 */
(function () {
  "use strict";
  var UI = window.VetUI;
  var C  = window.VetPagesCore || {};
  var esc = C.esc, api = C.api, I = C.I, fmtDate = C.fmtDate,
      fmtMoney = C.fmtMoney, fmtQty = C.fmtQty,
      printHTML = C.printHTML, loadClinicSettings = C.loadClinicSettings;

  // ═══════════════════════════════════════════════════════════════════════
  // PRINT VISIT CARD (для владельца животного)
  // ═══════════════════════════════════════════════════════════════════════

  async function printVisitCard(visitId) {
    var allVisits  = await window.VetDB.getAll('visits');
    var allVitems  = await window.VetDB.getAll('visit_items');
    var allPets    = await window.VetDB.getAll('pets');
    var allOwners  = await window.VetDB.getAll('owners');
    var allItems   = await window.VetDB.getAll('items');
    var settings   = await loadClinicSettings();

    var visit  = allVisits.find(function(v){ return v.id===visitId; });
    if (!visit) { UI.toast('Приём не найден', 'err'); return; }

    var pet    = allPets.find(function(p){ return p.id===visit.pet_id; }) || {};
    var owner  = allOwners.find(function(o){ return o.id===pet.owner_id; }) || {};
    var vitems = allVitems.filter(function(vi){ return !vi.is_deleted && vi.visit_id===visitId; });

    var visitDate    = fmtDate(visit.date);
    var nextDate     = visit.next_visit_date ? fmtDate(visit.next_visit_date) : null;
    var isRepeat     = visit.visit_type === 'вторичный';
    var clinicName   = settings.name    || 'VetClinic';
    var clinicPhone  = settings.phone   || '';
    var clinicAddr   = settings.address || '';
    var clinicLogo   = settings.logo    || '';

    // Список препаратов и услуг
    var drugs    = vitems.filter(function(vi){ return vi.type==='drug'; });
    var services = vitems.filter(function(vi){ return vi.type==='service'; });

    var html = `<!DOCTYPE html>
<html lang="ru">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>Карточка приёма — ${esc(pet.name||'')}</title>
<style>
  * { box-sizing:border-box; margin:0; padding:0; }
  body { font-family: 'Arial', sans-serif; font-size:13pt; color:#1a2434; line-height:1.5;
         max-width:700px; margin:0 auto; padding:20px; }
  .header { display:flex; align-items:center; gap:16px; border-bottom:3px solid #1a8c5e;
             padding-bottom:14px; margin-bottom:20px; }
  .header-logo { width:64px; height:64px; object-fit:contain; flex-shrink:0; border-radius:8px; }
  .header-logo-placeholder { width:64px; height:64px; display:flex; align-items:center;
             justify-content:center; font-size:2.5rem; flex-shrink:0; }
  .header-text { flex:1; }
  .clinic-name { font-size:16pt; font-weight:900; color:#1a8c5e; letter-spacing:.5px; }
  .clinic-info { font-size:10pt; color:#526070; margin-top:2px; }
  .doc-title { font-size:11pt; color:#526070; margin-top:4px; }
  .visit-date { font-size:10pt; color:#5d6f81; margin-top:2px; }
  .repeat-badge { display:inline-block; background:#fff2f3; color:#dc3545; border:1.5px solid rgba(220,53,69,.3);
                  padding:3px 12px; border-radius:999px; font-size:10pt; font-weight:700;
                  margin-top:4px; }
  .section { margin-bottom:18px; }
  .section-title {
    font-size:9pt; font-weight:800; text-transform:uppercase; letter-spacing:.8px;
    color:#1a8c5e; border-bottom:1.5px solid #e0e8f2; padding-bottom:4px; margin-bottom:10px;
  }
  .field-row { display:flex; gap:10px; margin-bottom:5px; }
  .field-label { font-weight:700; min-width:120px; color:#526070; font-size:11pt; }
  .field-value { color:#1a2434; font-size:11pt; }
  .diagnosis-box {
    background:#eaf5ee; border-left:4px solid #1a8c5e;
    padding:12px 16px; border-radius:6px; font-size:13pt; font-weight:700; color:#1a2434;
  }
  .treatment-box {
    background:#f7fafd; border:1px solid #e0e8f2; border-radius:6px;
    padding:14px 16px; font-size:12pt; line-height:1.7;
  }
  .drug-list { list-style:none; }
  .drug-list li {
    display:flex; align-items:flex-start; gap:10px;
    padding:8px 12px; border:1px solid #e0e8f2; border-radius:6px;
    margin-bottom:7px; background:#fff;
  }
  .drug-checkbox {
    width:18px; height:18px; border:2px solid #1a8c5e; border-radius:3px;
    flex-shrink:0; margin-top:1px;
  }
  .drug-name { font-weight:700; }
  .drug-qty  { color:#526070; font-size:11pt; }
  .next-visit-box {
    background:#1a8c5e; color:#fff; padding:14px 18px; border-radius:8px;
    display:flex; align-items:center; justify-content:space-between;
  }
  .next-visit-label { font-size:10pt; font-weight:700; text-transform:uppercase; letter-spacing:.5px; opacity:.85; }
  .next-visit-date  { font-size:16pt; font-weight:900; }
  .notes-box {
    background:#fef8ec; border-left:4px solid #c97a0a; padding:12px 16px; border-radius:6px;
  }
  .signature-row {
    display:flex; gap:40px; margin-top:24px; padding-top:16px;
    border-top:1px solid #e0e8f2;
  }
  .sign-field { flex:1; }
  .sign-label { font-size:9pt; color:#5d6f81; margin-bottom:20px; }
  .sign-line  { border-bottom:1px solid #1a2434; height:1px; }
  .no-print   { background:#1a2434; color:#fff; border:none; padding:12px 24px;
                font-size:12pt; font-weight:700; border-radius:8px; cursor:pointer;
                display:block; margin:20px auto 0; }
  @media print {
    body { padding:0; max-width:100%; }
    .no-print { display:none !important; }
  }
</style>
</head>
<body>

<div class="header">
  ${clinicLogo
    ? '<img class="header-logo" src="'+clinicLogo+'" alt="Логотип">'
    : '<div class="header-logo-placeholder">'+I('hospital')+'</div>'}
  <div class="header-text">
    <div class="clinic-name">${esc(clinicName)}</div>
    ${clinicPhone || clinicAddr
      ? '<div class="clinic-info">'+(clinicPhone?''+I('phone')+' '+esc(clinicPhone):'')+(clinicPhone&&clinicAddr?' &nbsp;·&nbsp; ':'')+(clinicAddr?''+I('pin')+' '+esc(clinicAddr):'')+'</div>'
      : ''}
    <div class="doc-title">Рекомендации для владельца животного</div>
    <div class="visit-date">Дата посещения: ${esc(visitDate)}${isRepeat ? ' &nbsp;|&nbsp; <span class="repeat-badge">Повторный приём</span>' : ''}</div>
  </div>
</div>

<div class="section">
  <div class="section-title">Информация о пациенте</div>
  <div class="field-row"><span class="field-label">Кличка:</span><span class="field-value"><b>${esc(pet.name||'—')}</b></span></div>
  <div class="field-row"><span class="field-label">Вид / Порода:</span><span class="field-value">${esc(pet.type||'—')}${pet.breed?' / '+esc(pet.breed):''}</span></div>
  <div class="field-row"><span class="field-label">Пол:</span><span class="field-value">${pet.gender==='m'?'Самец':'Самка'}</span></div>
  <div class="field-row"><span class="field-label">Владелец:</span><span class="field-value">${esc(owner.fio||'—')}</span></div>
  <div class="field-row"><span class="field-label">Телефон:</span><span class="field-value">${esc(owner.phone||'—')}</span></div>
</div>

<div class="section">
  <div class="section-title">Состояние на приёме</div>
  <div class="field-row"><span class="field-label">Состояние:</span><span class="field-value">${esc(visit.patient_condition||'Не указано')}</span></div>
  ${visit.animal_weight ? '<div class="field-row"><span class="field-label">Вес:</span><span class="field-value">'+visit.animal_weight+' кг</span></div>' : ''}
  ${visit.anamnesis ? '<div class="field-row"><span class="field-label">Жалобы:</span><span class="field-value">'+esc(visit.anamnesis)+'</span></div>' : ''}
</div>

<div class="section">
  <div class="section-title">Диагноз</div>
  <div class="diagnosis-box">${esc(visit.diagnosis||'Не указан')}</div>
</div>

<div class="section">
  <div class="section-title">Что нужно делать дома</div>
  <div class="treatment-box">${esc(visit.treatment||'Дополнительного лечения не требуется').replace(/\n/g,'<br>')}</div>
</div>

${drugs.length ? `<div class="section">
  <div class="section-title">Назначенные препараты</div>
  <ul class="drug-list">
    ${drugs.map(function(vi){
      return '<li><div class="drug-checkbox"></div><div>'
        +'<div class="drug-name">'+esc(vi.name||'—')+'</div>'
        +'<div class="drug-qty">Количество: '+fmtQty(vi.quantity)+' шт. &nbsp;·&nbsp; Стоимость: '+fmtMoney(vi.total)+'</div>'
        +'</div></li>';
    }).join('')}
  </ul>
</div>` : ''}

${services.length ? `<div class="section">
  <div class="section-title">Выполненные процедуры</div>
  <ul class="drug-list">
    ${services.map(function(vi){
      return '<li><div class="drug-checkbox" style="background:#e0e8f2;"></div><div>'
        +'<div class="drug-name">'+esc(vi.name||'—')+'</div>'
        +'<div class="drug-qty">'+fmtMoney(vi.total)+'</div>'
        +'</div></li>';
    }).join('')}
  </ul>
  ${visit.discount ? '<div style="text-align:right;margin-top:8px;font-size:10pt;color:#666;">Скидка: −'+fmtMoney(visit.discount)+'</div>' : ''}
  <div style="text-align:right;margin-top:${visit.discount?'2':'8'}px;font-weight:700;font-size:12pt;color:#1a8c5e;">
    Итого: ${fmtMoney(visit.total_amount||0)}
  </div>
</div>` : ''}

${nextDate ? `<div class="section">
  <div class="next-visit-box">
    <span class="next-visit-label">Следующий приём</span>
    <span class="next-visit-date">${I('calendar')} ${esc(nextDate)}</span>
  </div>
</div>` : ''}

${visit.notes ? `<div class="section">
  <div class="section-title">Дополнительные рекомендации</div>
  <div class="notes-box">${esc(visit.notes).replace(/\n/g,'<br>')}</div>
</div>` : ''}

<div class="signature-row">
  <div class="sign-field">
    <div class="sign-label">Подпись врача</div>
    <div class="sign-line"></div>
  </div>
  <div class="sign-field">
    <div class="sign-label">Дата</div>
    <div class="sign-line"></div>
  </div>
  <div class="sign-field">
    <div class="sign-label">Подпись владельца</div>
    <div class="sign-line"></div>
  </div>
</div>

<!-- Кнопки «Распечатать» и «Новый приём» убраны: печать теперь идёт сразу
     через скрытый iframe, промежуточной страницы-предпросмотра больше нет,
     а window.opener из iframe недоступен. -->
</body></html>`;

    printHTML(html);
  }

  // ═══════════════════════════════════════════════════════════════════════
  // PRINT: OWNER CARD
  // ═══════════════════════════════════════════════════════════════════════

  async function printOwnerCard(ownerId) {
    var allOwners = await window.VetDB.getAll('owners');
    var allPets   = await window.VetDB.getAll('pets');
    var allVisits = await window.VetDB.getAll('visits');
    var settings  = await loadClinicSettings();

    var owner = allOwners.find(function(o){ return o.id===ownerId; });
    if (!owner) { UI.toast('Клиент не найден', 'err'); return; }

    var ownerPets  = allPets.filter(function(p){ return !p.is_deleted && p.owner_id===ownerId; })
                            .sort(function(a,b){ return a.name.localeCompare(b.name,'ru'); });
    var petIds     = {}; ownerPets.forEach(function(p){ petIds[p.id]=p; });
    var ownerVisits = allVisits.filter(function(v){ return !v.is_deleted && petIds[v.pet_id]; })
                               .sort(function(a,b){ return (b.date||'')>(a.date||'')?1:-1; });

    var clinicName  = settings.name    || 'VetClinic';
    var clinicPhone = settings.phone   || '';
    var clinicAddr  = settings.address || '';
    var clinicLogo  = settings.logo    || '';

    var petsRows = ownerPets.map(function(p) {
      var statusLabel = {active:'Активен', deceased:'Умер', lost:'Потерян', transferred:'Передан'}[p.status||'active'] || '';
      var lastVisit = ownerVisits.filter(function(v){ return v.pet_id===p.id; })[0];
      return '<tr>'
        +'<td><b>'+esc(p.name)+'</b></td>'
        +'<td>'+esc(p.type||'')+(p.breed?' / '+esc(p.breed):'')+'</td>'
        +'<td>'+(p.gender==='m'?'♂':'♀')+'</td>'
        +'<td>'+statusLabel+'</td>'
        +'<td>'+(lastVisit?fmtDate(lastVisit.date):'—')+'</td>'
        +'</tr>';
    }).join('');

    var lastVisits = ownerVisits.slice(0,5).map(function(v) {
      var pet = petIds[v.pet_id] || {};
      return '<tr>'
        +'<td>'+fmtDate(v.date)+'</td>'
        +'<td>'+esc(pet.name||'—')+'</td>'
        +'<td>'+esc(v.diagnosis||v.anamnesis||'—')+'</td>'
        +'<td>'+(v.total_amount?Number(v.total_amount).toFixed(0)+' ₸':'—')+'</td>'
        +'</tr>';
    }).join('');

    var html = '<!DOCTYPE html><html lang="ru"><head><meta charset="UTF-8">'
      +'<title>Карточка клиента — '+esc(owner.fio)+'</title>'
      +'<style>'
      +'*{box-sizing:border-box;margin:0;padding:0}'
      +'body{font-family:Arial,sans-serif;font-size:12pt;color:#1a2434;line-height:1.5;max-width:750px;margin:0 auto;padding:20px}'
      +'.header{display:flex;align-items:center;gap:16px;border-bottom:3px solid #1a8c5e;padding-bottom:14px;margin-bottom:20px}'
      +'.header-logo{width:56px;height:56px;object-fit:contain;flex-shrink:0;border-radius:8px}'
      +'.clinic-name{font-size:15pt;font-weight:900;color:#1a8c5e}'
      +'.clinic-info{font-size:9pt;color:#526070;margin-top:2px}'
      +'.doc-title{font-size:10pt;color:#526070;margin-top:3px}'
      +'.owner-block{background:#eaf5ee;border-radius:8px;padding:16px 20px;margin-bottom:18px}'
      +'.owner-name{font-size:16pt;font-weight:900;color:#1a2434;margin-bottom:6px}'
      +'.owner-detail{font-size:11pt;color:#526070;margin-bottom:3px}'
      +'.section-title{font-size:9pt;font-weight:800;text-transform:uppercase;letter-spacing:.7px;color:#1a8c5e;border-bottom:1.5px solid #e0e8f2;padding-bottom:4px;margin:16px 0 10px}'
      +'table{width:100%;border-collapse:collapse;font-size:10.5pt}'
      +'th{background:#eaf5ee;color:#1a8c5e;font-weight:700;text-align:left;padding:7px 10px;font-size:9pt;text-transform:uppercase;letter-spacing:.4px}'
      +'td{padding:7px 10px;border-bottom:1px solid #e0e8f2;vertical-align:top}'
      +'tr:last-child td{border-bottom:none}'
      +'.no-print{background:#1a2434;color:#fff;border:none;padding:10px 22px;font-size:11pt;font-weight:700;border-radius:8px;cursor:pointer;display:block;margin:20px auto 0}'
      +'@media print{body{padding:0;max-width:100%}.no-print{display:none!important}}'
      +'</style></head><body>'
      +'<div class="header">'
      +(clinicLogo?'<img class="header-logo" src="'+clinicLogo+'" alt="">':'<div style="font-size:2.2rem;flex-shrink:0">'+I('hospital')+'</div>')
      +'<div><div class="clinic-name">'+esc(clinicName)+'</div>'
      +(clinicPhone||clinicAddr?'<div class="clinic-info">'+(clinicPhone?''+I('phone')+' '+esc(clinicPhone):'')+(clinicPhone&&clinicAddr?' · ':'')+(clinicAddr?''+I('pin')+' '+esc(clinicAddr):'')+'</div>':'')
      +'<div class="doc-title">Карточка клиента · Распечатано: '+new Date().toLocaleDateString('ru')+'</div>'
      +'</div></div>'
      +'<div class="owner-block">'
      +'<div class="owner-name">'+esc(owner.fio)+'</div>'
      +(owner.phone?'<div class="owner-detail">'+I('phone')+' '+esc(owner.phone)+'</div>':'')
      +(owner.iin?'<div class="owner-detail">ИИН: '+esc(owner.iin)+'</div>':'')
      +(owner.address?'<div class="owner-detail">'+I('pin')+' '+esc(owner.address)+'</div>':'')
      +(owner.notes?'<div class="owner-detail" style="margin-top:6px;font-style:italic">'+esc(owner.notes)+'</div>':'')
      +'</div>'
      +(ownerPets.length
        ?'<div class="section-title">Питомцы ('+ownerPets.length+')</div>'
         +'<table><thead><tr><th>Кличка</th><th>Вид / Порода</th><th>Пол</th><th>Статус</th><th>Посл. визит</th></tr></thead><tbody>'+petsRows+'</tbody></table>'
        :'')
      +(ownerVisits.length
        ?'<div class="section-title">Последние визиты</div>'
         +'<table><thead><tr><th>Дата</th><th>Животное</th><th>Диагноз / Жалоба</th><th>Сумма</th></tr></thead><tbody>'+lastVisits+'</tbody></table>'
        :'')
      +'<button class="no-print" onclick="window.print()">'+I('printer')+' Распечатать</button>'
      +'</body></html>';

    printHTML(html);
  }

  // ═══════════════════════════════════════════════════════════════════════
  // PRINT: PET CARD (паспорт животного)
  // ═══════════════════════════════════════════════════════════════════════

  // ── Печать: согласие на процедуру ────────────────────────────────────────
  // Юридически значимый документ: подпись владельца под информированным
  // согласием — то, чем клиника защищается при споре об исходе операции
  // или анестезии. Печатные формы у нас были только справочные
  // (карточка, сертификат чипирования), а этой не хватало.
  //
  // Данные подставляем из карточки, но поля процедуры и рисков оставляем
  // пустыми строками для заполнения от руки: формулировка зависит от
  // конкретного случая, и подсовывать готовый текст здесь опасно.

  async function printConsentForm(petId) {
    var pets = await window.VetDB.getAll('pets');
    var owners = await window.VetDB.getAll('owners');
    var settings = await loadClinicSettings();

    var pet = pets.find(function (p) { return p.id === petId; });
    if (!pet) { UI.toast('Животное не найдено', 'err'); return; }
    var owner = owners.find(function (o) { return o.id === pet.owner_id; }) || {};

    var today = fmtDate(new Date().toISOString());
    var clinicName = (settings && settings.name) || 'Ветеринарная клиника';
    var clinicInfo = [settings && settings.address, settings && settings.phone]
                     .filter(Boolean).map(esc).join(' · ');

    var line = function (label, value) {
      return '<div class="row"><span class="lbl">' + label + ':</span> '
           + '<span class="val">' + (value ? esc(value) : '') + '</span></div>';
    };

    var html =
      '<html><head><meta charset="utf-8"><title>Согласие на процедуру</title><style>'
      + 'body{font-family:Georgia,serif;font-size:11pt;line-height:1.5;padding:24px;color:#111;}'
      + 'h1{font-size:14pt;text-align:center;margin:0 0 4px;}'
      + '.clinic{text-align:center;font-size:10pt;color:#444;margin-bottom:18px;}'
      + '.row{margin-bottom:7px;}'
      + '.lbl{color:#444;}'
      + '.val{border-bottom:1px solid #999;display:inline-block;min-width:60%;}'
      + '.blank{border-bottom:1px solid #999;display:block;height:18px;margin:6px 0;}'
      + 'p{margin:10px 0;text-align:justify;}'
      + '.sign{display:flex;justify-content:space-between;margin-top:28px;gap:30px;}'
      + '.sign div{border-top:1px solid #555;padding-top:5px;width:45%;text-align:center;font-size:9pt;color:#555;}'
      + '</style></head><body>'
      + '<h1>' + esc(clinicName) + '</h1>'
      + (clinicInfo ? '<div class="clinic">' + clinicInfo + '</div>' : '')
      + '<h1>Информированное согласие на ветеринарную процедуру</h1>'
      + '<div style="margin:16px 0;">'
      + line('Дата', today)
      + line('Владелец', owner.fio || '')
      + line('Телефон', owner.phone || '')
      + line('Животное', (pet.name || '') + (pet.type ? ', ' + pet.type : '')
             + (pet.breed ? ', ' + pet.breed : ''))
      + line('Идентификация (чип)', pet.chip_number || '')
      + '</div>'
      + '<div class="row"><span class="lbl">Процедура (вмешательство):</span></div>'
      + '<div class="blank"></div><div class="blank"></div>'
      + '<p>Я, нижеподписавшийся владелец (представитель владельца) животного, '
      + 'подтверждаю, что мне в понятной форме разъяснены характер и цель '
      + 'предстоящей процедуры, возможные осложнения и риски, включая риски, '
      + 'связанные с анестезией, а также альтернативные варианты и вероятные '
      + 'последствия отказа от вмешательства.</p>'
      + '<p>Я подтверждаю достоверность сообщённых мною сведений о состоянии '
      + 'здоровья животного, перенесённых заболеваниях, аллергических реакциях, '
      + 'проведённых вакцинациях и кормлении перед процедурой. Мне разъяснено, '
      + 'что сокрытие таких сведений может повлиять на исход.</p>'
      + '<p>Я понимаю, что ветеринарная медицина не даёт гарантии результата, '
      + 'и добровольно даю согласие на проведение процедуры, а также на '
      + 'необходимые дополнительные манипуляции, если потребность в них '
      + 'возникнет по ходу вмешательства и промедление будет угрожать жизни '
      + 'животного.</p>'
      + '<div class="row" style="margin-top:14px;"><span class="lbl">Особые отметки и ограничения:</span></div>'
      + '<div class="blank"></div>'
      + '<div class="sign"><div>Владелец (подпись, расшифровка)</div>'
      + '<div>Врач (подпись, расшифровка)</div></div>'
      + '</body></html>';

    printHTML(html);
  }

  async function printPetCard(petId) {
    var allPets   = await window.VetDB.getAll('pets');
    var allOwners = await window.VetDB.getAll('owners');
    var allVisits = await window.VetDB.getAll('visits');
    var allVaccs  = await window.VetDB.getAll('vaccinations');
    var settings  = await loadClinicSettings();

    var pet   = allPets.find(function(p){ return p.id===petId; });
    if (!pet) { UI.toast('Животное не найдено', 'err'); return; }
    var owner = allOwners.find(function(o){ return o.id===pet.owner_id; }) || {};

    var petVisits = allVisits.filter(function(v){ return !v.is_deleted && v.pet_id===petId; })
                             .sort(function(a,b){ return (b.date||'')>(a.date||'')?1:-1; });
    var petVaccs  = allVaccs.filter(function(v){ return !v.is_deleted && v.pet_id===petId; })
                            .sort(function(a,b){ return (b.administered_at||'')>(a.administered_at||'')?1:-1; });

    var clinicName  = settings.name    || 'VetClinic';
    var clinicPhone = settings.phone   || '';
    var clinicAddr  = settings.address || '';
    var clinicLogo  = settings.logo    || '';

    // Возраст
    var ageStr = '';
    if (pet.birth_date) {
      try {
        var bd=new Date(pet.birth_date); var now=new Date();
        var mons=(now.getFullYear()-bd.getFullYear())*12+(now.getMonth()-bd.getMonth());
        mons=Math.max(0,mons);
        var yr=Math.floor(mons/12); var mo=mons%12;
        ageStr=yr>0?yr+' л.'+(mo>0?' '+mo+' мес.':''):mo+' мес.';
      } catch(e){}
    }

    var visitsRows = petVisits.slice(0,8).map(function(v) {
      return '<tr>'
        +'<td>'+fmtDate(v.date)+'</td>'
        +'<td>'+esc(v.visit_type||'первичный')+'</td>'
        +'<td>'+esc(v.diagnosis||v.anamnesis||'—')+'</td>'
        +'<td>'+esc(v.treatment||'—')+'</td>'
        +'<td>'+(v.total_amount?Number(v.total_amount).toFixed(0)+' ₸':'—')+'</td>'
        +'</tr>';
    }).join('');

    var vaccsRows = petVaccs.map(function(v) {
      return '<tr>'
        +'<td>'+fmtDate(v.administered_at)+'</td>'
        +'<td><b>'+esc(v.vaccine_name)+'</b></td>'
        +'<td>'+esc(v.manufacturer||'—')+'</td>'
        +'<td>'+esc(v.batch_number||'—')+'</td>'
        +'<td>'+(v.next_due_at?fmtDate(v.next_due_at):'—')+'</td>'
        +'</tr>';
    }).join('');

    var html = '<!DOCTYPE html><html lang="ru"><head><meta charset="UTF-8">'
      +'<title>Паспорт — '+esc(pet.name)+'</title>'
      +'<style>'
      +'*{box-sizing:border-box;margin:0;padding:0}'
      +'body{font-family:Arial,sans-serif;font-size:12pt;color:#1a2434;line-height:1.5;max-width:750px;margin:0 auto;padding:20px}'
      +'.header{display:flex;align-items:center;gap:16px;border-bottom:3px solid #1a8c5e;padding-bottom:14px;margin-bottom:20px}'
      +'.header-logo{width:56px;height:56px;object-fit:contain;flex-shrink:0;border-radius:8px}'
      +'.clinic-name{font-size:15pt;font-weight:900;color:#1a8c5e}'
      +'.clinic-info{font-size:9pt;color:#526070;margin-top:2px}'
      +'.doc-title{font-size:10pt;color:#526070;margin-top:3px}'
      +'.pet-block{display:flex;gap:20px;background:#eaf5ee;border-radius:8px;padding:16px 20px;margin-bottom:18px;align-items:flex-start}'
      +'.pet-photo{width:90px;height:90px;object-fit:cover;border-radius:8px;flex-shrink:0}'
      +'.pet-icon{width:90px;height:90px;border-radius:8px;background:#c6e8d7;display:flex;align-items:center;justify-content:center;font-size:3rem;flex-shrink:0}'
      +'.pet-name{font-size:16pt;font-weight:900;color:#1a2434;margin-bottom:6px}'
      +'.pet-detail{font-size:11pt;color:#526070;margin-bottom:3px}'
      +'.owner-box{background:#f7fafd;border:1px solid #e0e8f2;border-radius:6px;padding:10px 14px;margin-bottom:16px}'
      +'.section-title{font-size:9pt;font-weight:800;text-transform:uppercase;letter-spacing:.7px;color:#1a8c5e;border-bottom:1.5px solid #e0e8f2;padding-bottom:4px;margin:16px 0 10px}'
      +'table{width:100%;border-collapse:collapse;font-size:10pt}'
      +'th{background:#eaf5ee;color:#1a8c5e;font-weight:700;text-align:left;padding:7px 10px;font-size:8.5pt;text-transform:uppercase;letter-spacing:.4px}'
      +'td{padding:7px 10px;border-bottom:1px solid #e0e8f2;vertical-align:top}'
      +'tr:last-child td{border-bottom:none}'
      +'.no-print{background:#1a2434;color:#fff;border:none;padding:10px 22px;font-size:11pt;font-weight:700;border-radius:8px;cursor:pointer;display:block;margin:20px auto 0}'
      +'@media print{body{padding:0;max-width:100%}.no-print{display:none!important}}'
      +'</style></head><body>'
      +'<div class="header">'
      +(clinicLogo?'<img class="header-logo" src="'+clinicLogo+'" alt="">':'<div style="font-size:2.2rem;flex-shrink:0">'+I('hospital')+'</div>')
      +'<div><div class="clinic-name">'+esc(clinicName)+'</div>'
      +(clinicPhone||clinicAddr?'<div class="clinic-info">'+(clinicPhone?''+I('phone')+' '+esc(clinicPhone):'')+(clinicPhone&&clinicAddr?' · ':'')+(clinicAddr?''+I('pin')+' '+esc(clinicAddr):'')+'</div>':'')
      +'<div class="doc-title">Медицинская карточка животного · '+new Date().toLocaleDateString('ru')+'</div>'
      +'</div></div>'
      // Блок животного
      +'<div class="pet-block">'
      +(pet.photo?'<img class="pet-photo" src="'+esc(pet.photo)+'" alt="'+esc(pet.name)+'">'
                :'<div class="pet-icon">'+({собака:'🐕',кошка:'🐈',кот:'🐈',птица:'🦜',кролик:'🐇'}[(pet.type||'').toLowerCase()]||'🐾')+'</div>')
      +'<div>'
      +'<div class="pet-name">'+esc(pet.name)+'</div>'
      +'<div class="pet-detail">'+esc(pet.type||'—')+(pet.breed?' / '+esc(pet.breed):'')+'</div>'
      +'<div class="pet-detail">'+(pet.gender==='m'?'♂ Самец':'♀ Самка')+(ageStr?' · '+ageStr:'')+(pet.weight?' · '+I('scale')+' '+pet.weight+' кг':'')+'</div>'
      +(pet.color?'<div class="pet-detail">Окрас: '+esc(pet.color)+'</div>':'')
      +(pet.birth_date?'<div class="pet-detail">Д/р: '+fmtDate(pet.birth_date)+'</div>':'')
      +(pet.notes?'<div class="pet-detail" style="margin-top:4px;font-style:italic">'+esc(pet.notes)+'</div>':'')
      +'</div></div>'
      // Владелец
      +'<div class="owner-box"><b>Владелец:</b> '+esc(owner.fio||'—')
      +(owner.phone?' &nbsp;·&nbsp; '+I('phone')+' '+esc(owner.phone):'')
      +(owner.address?' &nbsp;·&nbsp; '+I('pin')+' '+esc(owner.address):'')+'</div>'
      // Визиты
      +(petVisits.length
        ?'<div class="section-title">История визитов ('+petVisits.length+')</div>'
         +'<table><thead><tr><th>Дата</th><th>Тип</th><th>Диагноз</th><th>Назначения</th><th>Сумма</th></tr></thead><tbody>'+visitsRows+'</tbody></table>'
         +(petVisits.length>8?'<div style="font-size:9pt;color:#5d6f81;margin-top:6px;text-align:right">Показаны последние 8 из '+petVisits.length+'</div>':'')
        :'<div style="color:#5d6f81;margin:10px 0;">Визитов нет</div>')
      // Вакцинации
      +(petVaccs.length
        ?'<div class="section-title">Вакцинации ('+petVaccs.length+')</div>'
         +'<table><thead><tr><th>Дата</th><th>Вакцина</th><th>Производитель</th><th>Серия</th><th>Следующая</th></tr></thead><tbody>'+vaccsRows+'</tbody></table>'
        :'')
      +'<button class="no-print" onclick="window.print()">'+I('printer')+' Распечатать</button>'
      +'</body></html>';

    printHTML(html);
  }

  // ═══════════════════════════════════════════════════════════════════════
  // PRINT: VACCINATION CARD (справка о вакцинации)
  // ═══════════════════════════════════════════════════════════════════════

  async function printVaccinationCard(vaccId) {
    var allVaccs  = await window.VetDB.getAll('vaccinations');
    var allPets   = await window.VetDB.getAll('pets');
    var allOwners = await window.VetDB.getAll('owners');
    var allStaff  = await window.VetDB.getAll('staff');
    var settings  = await loadClinicSettings();

    var vacc = allVaccs.find(function(v){ return v.id===vaccId; });
    if (!vacc) { UI.toast('Запись не найдена', 'err'); return; }
    var pet   = allPets.find(function(p){ return p.id===vacc.pet_id; }) || {};
    var owner = allOwners.find(function(o){ return o.id===pet.owner_id; }) || {};
    var staff = allStaff.find(function(s){ return s.id===vacc.staff_id; }) || {};

    var clinicName  = settings.name    || 'VetClinic';
    var clinicPhone = settings.phone   || '';
    var clinicAddr  = settings.address || '';
    var clinicLogo  = settings.logo    || '';

    var html = '<!DOCTYPE html><html lang="ru"><head><meta charset="UTF-8">'
      +'<title>Справка о вакцинации — '+esc(pet.name)+'</title>'
      +'<style>'
      +'*{box-sizing:border-box;margin:0;padding:0}'
      +'body{font-family:Arial,sans-serif;font-size:12pt;color:#1a2434;line-height:1.6;max-width:680px;margin:0 auto;padding:24px}'
      +'.header{display:flex;align-items:center;gap:16px;border-bottom:3px solid #1a8c5e;padding-bottom:14px;margin-bottom:22px}'
      +'.header-logo{width:56px;height:56px;object-fit:contain;border-radius:8px;flex-shrink:0}'
      +'.clinic-name{font-size:15pt;font-weight:900;color:#1a8c5e}'
      +'.clinic-info{font-size:9pt;color:#526070;margin-top:2px}'
      +'.cert-title{font-size:14pt;font-weight:900;text-align:center;color:#1a2434;margin:0 0 20px;text-transform:uppercase;letter-spacing:.5px}'
      +'.field-row{display:flex;gap:10px;margin-bottom:9px;align-items:baseline}'
      +'.field-label{font-weight:700;min-width:160px;color:#526070;font-size:11pt;flex-shrink:0}'
      +'.field-value{color:#1a2434;font-size:12pt}'
      +'.vacc-box{background:#eaf5ee;border-left:5px solid #1a8c5e;padding:16px 20px;border-radius:6px;margin:18px 0}'
      +'.vacc-name{font-size:15pt;font-weight:900;color:#1a8c5e;margin-bottom:10px}'
      +'.next-box{background:#1a8c5e;color:#fff;padding:14px 20px;border-radius:8px;display:flex;justify-content:space-between;align-items:center;margin:18px 0}'
      +'.next-label{font-size:9pt;font-weight:700;text-transform:uppercase;letter-spacing:.5px;opacity:.85}'
      +'.next-date{font-size:16pt;font-weight:900}'
      +'.signature-row{display:flex;gap:40px;margin-top:30px;padding-top:16px;border-top:1px solid #e0e8f2}'
      +'.sign-label{font-size:9pt;color:#5d6f81;margin-bottom:22px}'
      +'.sign-line{border-bottom:1px solid #1a2434;height:1px}'
      +'.no-print{background:#1a2434;color:#fff;border:none;padding:10px 22px;font-size:11pt;font-weight:700;border-radius:8px;cursor:pointer;display:block;margin:20px auto 0}'
      +'@media print{body{padding:0;max-width:100%}.no-print{display:none!important}}'
      +'</style></head><body>'
      +'<div class="header">'
      +(clinicLogo?'<img class="header-logo" src="'+clinicLogo+'" alt="">':'<div style="font-size:2.2rem;flex-shrink:0">'+I('hospital')+'</div>')
      +'<div><div class="clinic-name">'+esc(clinicName)+'</div>'
      +(clinicPhone||clinicAddr?'<div class="clinic-info">'+(clinicPhone?''+I('phone')+' '+esc(clinicPhone):'')+(clinicPhone&&clinicAddr?' · ':'')+(clinicAddr?''+I('pin')+' '+esc(clinicAddr):'')+'</div>':'')
      +'</div></div>'
      +'<div class="cert-title">Справка о вакцинации животного</div>'
      +'<div class="field-row"><span class="field-label">Дата вакцинации:</span><span class="field-value"><b>'+fmtDate(vacc.administered_at)+'</b></span></div>'
      +'<div class="field-row"><span class="field-label">Животное:</span><span class="field-value"><b>'+esc(pet.name||'—')+'</b> · '+esc(pet.type||'')+(pet.breed?' / '+esc(pet.breed):'')+'</span></div>'
      +'<div class="field-row"><span class="field-label">Владелец:</span><span class="field-value">'+esc(owner.fio||'—')+(owner.phone?' · '+esc(owner.phone):'')+'</span></div>'
      +(owner.address?'<div class="field-row"><span class="field-label">Адрес:</span><span class="field-value">'+esc(owner.address)+'</span></div>':'')
      +'<div class="vacc-box">'
      +'<div class="vacc-name">'+esc(vacc.vaccine_name)+'</div>'
      +(vacc.manufacturer?'<div class="field-row"><span class="field-label">Производитель:</span><span class="field-value">'+esc(vacc.manufacturer)+'</span></div>':'')
      +(vacc.batch_number?'<div class="field-row"><span class="field-label">Серия / Партия:</span><span class="field-value">'+esc(vacc.batch_number)+'</span></div>':'')
      +(vacc.dose?'<div class="field-row"><span class="field-label">Доза:</span><span class="field-value">'+vacc.dose+' мл</span></div>':'')
      +'</div>'
      +(vacc.next_due_at
        ?'<div class="next-box"><div><div class="next-label">Следующая вакцинация</div><div class="next-date">'+fmtDate(vacc.next_due_at)+'</div></div></div>'
        :'')
      +(vacc.notes?'<div class="field-row" style="margin-top:10px"><span class="field-label">Примечания:</span><span class="field-value">'+esc(vacc.notes)+'</span></div>':'')
      +'<div class="signature-row">'
      +'<div style="flex:1"><div class="sign-label">Ветеринарный врач'+(staff.name?' ('+esc(staff.name)+')':'')+'</div><div class="sign-line"></div></div>'
      +'<div style="flex:1"><div class="sign-label">Печать клиники</div><div class="sign-line"></div></div>'
      +'</div>'
      +'<button class="no-print" onclick="window.print()">'+I('printer')+' Распечатать</button>'
      +'</body></html>';

    printHTML(html);
  }


  // ── Экспорт ──────────────────────────────────────────────────────────
  // Все пять вызываются из onclick в списках и карточках.
  window.VetPages = window.VetPages || {};
  window.VetPages.printVisitCard       = printVisitCard;
  window.VetPages.printOwnerCard       = printOwnerCard;
  window.VetPages.printPetCard         = printPetCard;
  window.VetPages.printVaccinationCard = printVaccinationCard;
  window.VetPages.printConsentForm     = printConsentForm;
}());
