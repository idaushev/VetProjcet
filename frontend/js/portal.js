/* portal.js — вынесено из portal.html.
 *
 * Инлайновый <script> в странице заставлял CSP держать
 * script-src 'unsafe-inline'. Код не менялся, только переехал.
 */
(function () {
  'use strict';
  var TOKEN_KEY = 'vet_portal_token';
  var state = { owner: null, pets: [], pet: null };

  function $(id) { return document.getElementById(id); }
  function esc(s) { return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) {
    return { '&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;' }[c]; }); }
  function show(id) {
    ['scr-login','scr-pets','scr-pet','scr-book'].forEach(function (s) { $(s).style.display = s === id ? '' : 'none'; });
  }

  function api(method, path, body) {
    return fetch(path, {
      method: method,
      headers: Object.assign({ 'Content-Type': 'application/json' },
        localStorage.getItem(TOKEN_KEY) ? { 'X-Portal-Token': localStorage.getItem(TOKEN_KEY) } : {}),
      body: body ? JSON.stringify(body) : undefined
    }).then(function (r) {
      return r.json().catch(function () { return {}; }).then(function (j) {
        if (!r.ok || j.status === 'error') {
          if (r.status === 401) { localStorage.removeItem(TOKEN_KEY); show('scr-login'); }
          throw new Error(j.message || ('Ошибка ' + r.status));
        }
        return j.data;
      });
    });
  }

  // ── Маска телефона (как в основном приложении) ──────────────────────
  $('phone').addEventListener('input', function (e) {
    if (e.inputType && e.inputType.indexOf('delete') === 0) return;
    var el = e.target;
    if (el.selectionStart !== el.value.length) return;
    var d = el.value.replace(/\D/g, '');
    if (!d) return;
    if (d[0] === '8') d = '7' + d.slice(1);
    if (d[0] !== '7') d = '7' + d;
    d = d.slice(0, 11);
    var out = '+7';
    if (d.length > 1) out += ' ' + d.slice(1, 4);
    if (d.length > 4) out += ' ' + d.slice(4, 7);
    if (d.length > 7) out += '-' + d.slice(7, 9);
    if (d.length > 9) out += '-' + d.slice(9, 11);
    el.value = out;
  });

  // ── Вход ─────────────────────────────────────────────────────────────
  function login() {
    var err = $('login-err'); err.style.display = 'none';
    var btn = $('btn-login'); btn.disabled = true;
    api('POST', '/portal/login', { phone: $('phone').value, code: $('code').value.trim() })
      .then(function (d) {
        localStorage.setItem(TOKEN_KEY, d.token);
        state.owner = d.owner;
        openPets();
      })
      .catch(function (e) { err.textContent = e.message; err.style.display = 'block'; })
      .then(function () { btn.disabled = false; });
  }
  $('btn-login').onclick = login;
  $('phone').addEventListener('keydown', function (e) { if (e.key === 'Enter') $('code').focus(); });
  $('code').addEventListener('keydown', function (e) { if (e.key === 'Enter') login(); });

  // Если у сервера настроено имя бота — превращаем подсказку в ссылку t.me;
  // телефон клиники включает кнопку «Позвонить».
  api('GET', '/portal/bot-info').then(function (d) {
    if (d && d.bot) {
      $('bot-hint').innerHTML = 'Пароль выдаёт телеграм-бот клиники: '
        + '<a href="https://t.me/' + esc(d.bot) + '" target="_blank" rel="noopener">@' + esc(d.bot) + '</a>'
        + ' — напишите ему «пароль», код действует 10 минут.';
    }
    if (d && d.phone) {
      var call = $('call-btn');
      call.href = 'tel:' + d.phone.replace(/[^\d+]/g, '');
      call.style.display = 'block';
    }
  }).catch(function () {});

  $('btn-logout').onclick = function () {
    // Гасим сессию НА СЕРВЕРЕ, а не только забываем токен в браузере: иначе
    // токен остаётся действительным 90 дней и «выход» ничего не отзывает.
    var token = localStorage.getItem(TOKEN_KEY);
    if (token) {
      fetch('/portal/logout', { method: 'POST', headers: { 'X-Portal-Token': token } })
        .catch(function () {}); // офлайн — локальный выход всё равно делаем
    }
    localStorage.removeItem(TOKEN_KEY);
    state.owner = null;
    show('scr-login');
  };

  // ── Список питомцев ──────────────────────────────────────────────────
  var SPECIES = { 'кошка':'🐱','кот':'🐱','собака':'🐶','кролик':'🐰','попугай':'🦜','птица':'🐦',
                  'хомяк':'🐹','черепаха':'🐢','морская свинка':'🐭','шиншилла':'🐭','хорёк':'🦡' };

  function petIcon(p) { return SPECIES[(p.type || '').toLowerCase()] || '🐾'; }

  function loadAppointments() {
    api('GET', '/portal/appointments').then(function (appts) {
      var card = $('appts-card');
      if (!appts || !appts.length) { card.style.display = 'none'; return; }
      var DAYS = ['вс','пн','вт','ср','чт','пт','сб'];
      $('appts-list').innerHTML = appts.map(function (a) {
        var d = new Date(a.starts_at);
        var when = fmtDate(a.starts_at) + ' (' + DAYS[d.getDay()] + ') в ' + a.starts_at.slice(11, 16);
        return '<div class="next-box" style="margin-top:10px;">'
          + '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" style="vertical-align:-2px;margin-right:4px;"><rect x="3" y="4" width="18" height="18" rx="2"/><path d="M16 2v4M8 2v4M3 10h18"/></svg>' + esc(when)
          + (a.pet_name ? ' · ' + esc(a.pet_name) : '')
          + (a.staff_name ? '<div style="font-weight:400;margin-top:2px;">Врач: ' + esc(a.staff_name) + '</div>' : '')
          + (a.reason ? '<div style="font-weight:400;margin-top:2px;">' + esc(a.reason) + '</div>' : '')
          + '</div>';
      }).join('');
      card.style.display = '';
    }).catch(function () {});
  }

  function openPets() {
    show('scr-pets');
    loadAppointments();
    $('hello').textContent = state.owner ? 'Здравствуйте, ' + state.owner.fio.split(' ')[0] + (state.owner.fio.split(' ')[1] ? ' ' + state.owner.fio.split(' ')[1] : '') + '!' : 'Мои питомцы';
    var list = $('pets-list');
    list.innerHTML = '<div class="loader">Загрузка…</div>';
    api('GET', '/portal/pets').then(function (pets) {
      state.pets = pets || [];
      $('btn-book').style.display = state.pets.some(function (p) { return p.status !== 'deceased'; }) ? '' : 'none';
      if (!state.pets.length) { list.innerHTML = '<div class="loader">Питомцев пока нет</div>'; return; }
      list.innerHTML = state.pets.map(function (p, i) {
        var media = p.photo
          ? '<img class="pet-photo" src="' + p.photo + '" alt="">'
          : '<span class="pet-photo">' + petIcon(p) + '</span>';
        return '<div class="pet" data-i="' + i + '">' + media
          + '<div><div class="pet-name">' + esc(p.name)
          + (p.status === 'deceased' ? '<span class="badge-deceased">умер</span>' : '') + '</div>'
          + '<div class="pet-sub">' + esc(p.type || '') + (p.breed ? ' · ' + esc(p.breed) : '') + '</div></div></div>';
      }).join('');
      list.querySelectorAll('.pet').forEach(function (el) {
        el.onclick = function () { openPet(state.pets[Number(el.dataset.i)]); };
      });
    }).catch(function (e) { list.innerHTML = '<div class="loader">' + esc(e.message) + '</div>'; });
  }

  // ── Карточка питомца и приёмы ────────────────────────────────────────
  function fmtDate(s) {
    if (!s) return '';
    try {
      var d = new Date(s);
      return String(d.getDate()).padStart(2, '0') + '.' + String(d.getMonth() + 1).padStart(2, '0') + '.' + d.getFullYear();
    } catch (e) { return s.slice(0, 10); }
  }

  function renderPetHead(p) {
    var ph = $('pet-photo');
    if (p.photo) {
      var img = document.createElement('img');
      img.className = 'pet-photo'; img.src = p.photo; img.id = 'pet-photo';
      ph.replaceWith(img);
    } else {
      var span = document.createElement('span');
      span.className = 'pet-photo'; span.textContent = petIcon(p); span.id = 'pet-photo';
      ph.replaceWith(span);
    }
    $('pet-name').textContent = p.name;
    $('pet-sub').textContent = (p.type || '') + (p.breed ? ' · ' + p.breed : '');
  }

  function openPet(p) {
    state.pet = p;
    show('scr-pet');
    renderPetHead(p);
    $('photo-err').style.display = 'none';
    var list = $('visits-list');
    list.innerHTML = '<div class="loader">Загрузка…</div>';
    api('GET', '/portal/pets/' + p.id + '/visits').then(function (visits) {
      if (!visits || !visits.length) { list.innerHTML = '<div class="loader">Приёмов пока не было</div>'; return; }
      list.innerHTML = visits.map(function (v) {
        return '<div class="visit">'
          + '<div style="display:flex;justify-content:space-between;align-items:center;">'
          + '<span class="visit-date">' + fmtDate(v.date) + '</span>'
          + '<span class="visit-type">' + (v.visit_type === 'вторичный' ? 'повторный' : 'первичный') + '</span></div>'
          + (v.patient_condition ? '<div class="visit-field"><b>Состояние</b><div>' + esc(v.patient_condition) + '</div></div>' : '')
          + (v.diagnosis ? '<div class="visit-field"><b>Диагноз</b><div>' + esc(v.diagnosis) + '</div></div>' : '')
          + (v.treatment ? '<div class="visit-field"><b>Назначение и рекомендации</b><div>' + esc(v.treatment) + '</div></div>' : '')
          + (v.treatment_days ? '<div class="visit-field"><b>Курс лечения</b><div>' + v.treatment_days + ' дн.</div></div>' : '')
          + (v.next_visit_date ? '<div class="next-box">Следующий приём: ' + fmtDate(v.next_visit_date) + '</div>' : '')
          + '</div>';
      }).join('');
    }).catch(function (e) { list.innerHTML = '<div class="loader">' + esc(e.message) + '</div>'; });

    // Прививки: что ставили и когда следующая
    var vlist = $('vaccs-list');
    vlist.innerHTML = '<div class="loader">Загрузка…</div>';
    api('GET', '/portal/pets/' + p.id + '/vaccinations').then(function (vaccs) {
      if (!vaccs || !vaccs.length) { vlist.innerHTML = '<div class="loader">Прививок пока не было</div>'; return; }
      var today = new Date().toISOString().slice(0, 10);
      vlist.innerHTML = vaccs.map(function (v) {
        var due = (v.next_due_at || '').slice(0, 10);
        var overdue = due && due < today;
        return '<div class="visit" style="padding:10px 14px;">'
          + '<div style="display:flex;justify-content:space-between;align-items:center;">'
          + '<span style="font-weight:600;font-size:.9rem;">' + esc(v.vaccine_name) + '</span>'
          + '<span class="pet-sub">' + fmtDate(v.administered_at) + '</span></div>'
          + (due
              ? '<div class="' + (overdue ? '' : 'next-box') + '" style="margin-top:6px;font-size:.82rem;'
                + (overdue ? 'color:var(--danger);font-weight:600;' : '') + '">'
                + (overdue ? '⚠ Просрочена: следующая была нужна ' : 'Следующая: ') + fmtDate(due) + '</div>'
              : '')
          + '</div>';
      }).join('');
    }).catch(function (e) { vlist.innerHTML = '<div class="loader">' + esc(e.message) + '</div>'; });
  }

  $('btn-back').onclick = openPets;

  // ── Запись на приём ──────────────────────────────────────────────────
  function openBooking() {
    var alive = state.pets.filter(function (p) { return p.status !== 'deceased'; });
    if (!alive.length) return;
    $('bk-pet').innerHTML = alive.map(function (p) {
      return '<option value="' + esc(p.id) + '">' + esc(p.name) + ' (' + esc(p.type || '') + ')</option>';
    }).join('');
    // Дата: с завтрашнего дня, максимум +60; время — слоты по 30 минут
    var t = new Date(Date.now() + 86400000);
    var max = new Date(Date.now() + 60 * 86400000);
    function ds(d) { return d.getFullYear() + '-' + String(d.getMonth()+1).padStart(2,'0') + '-' + String(d.getDate()).padStart(2,'0'); }
    var di = $('bk-date');
    di.min = ds(new Date()); di.max = ds(max);
    if (!di.value) di.value = ds(t);
    if (!$('bk-time').options.length) {
      var opts = '';
      for (var h = 9; h < 19; h++) {
        ['00','30'].forEach(function (mm) {
          var v = String(h).padStart(2,'0') + ':' + mm;
          opts += '<option value="' + v + '"' + (v === '11:00' ? ' selected' : '') + '>' + v + '</option>';
        });
      }
      $('bk-time').innerHTML = opts;
    }
    $('bk-err').style.display = 'none';
    show('scr-book');
  }
  $('btn-book').onclick = openBooking;
  $('btn-book-back').onclick = openPets;

  $('btn-book-send').onclick = function () {
    var err = $('bk-err'); err.style.display = 'none';
    var btn = $('btn-book-send'); btn.disabled = true;
    api('POST', '/portal/book', {
      pet_id: $('bk-pet').value,
      date:   $('bk-date').value,
      time:   $('bk-time').value,
      reason: $('bk-reason').value.trim()
    }).then(function (d) {
      $('bk-reason').value = '';
      openPets(); // блок «Ближайшая запись» обновится и покажет новую
      alert('Вы записаны на ' + $('bk-date').value.split('-').reverse().join('.') + ' в ' + d.time + '.\nЕсли время окажется занято, мы вам перезвоним.');
    }).catch(function (e) {
      err.textContent = e.message; err.style.display = 'block';
    }).then(function () { btn.disabled = false; });
  };

  // ── Замена фото ──────────────────────────────────────────────────────
  $('btn-photo').onclick = function () { $('photo-file').click(); };
  $('photo-file').addEventListener('change', function () {
    var file = this.files && this.files[0];
    this.value = '';
    if (!file || !state.pet) return;
    var err = $('photo-err'); err.style.display = 'none';

    // Сжимаем на клиенте до 800px / JPEG: лимит сервера ~300 КБ.
    var img = new Image();
    var url = URL.createObjectURL(file);
    img.onload = function () {
      URL.revokeObjectURL(url);
      var max = 800;
      var scale = Math.min(1, max / Math.max(img.width, img.height));
      var canvas = document.createElement('canvas');
      canvas.width = Math.round(img.width * scale);
      canvas.height = Math.round(img.height * scale);
      canvas.getContext('2d').drawImage(img, 0, 0, canvas.width, canvas.height);
      var dataUrl = canvas.toDataURL('image/jpeg', 0.82);
      if (dataUrl.length > 400000) dataUrl = canvas.toDataURL('image/jpeg', 0.6);
      api('PUT', '/portal/pets/' + state.pet.id + '/photo', { photo: dataUrl })
        .then(function () {
          state.pet.photo = dataUrl;
          var cached = state.pets.find(function (x) { return x.id === state.pet.id; });
          if (cached) cached.photo = dataUrl;
          renderPetHead(state.pet);
        })
        .catch(function (e) { err.textContent = e.message; err.style.display = 'block'; });
    };
    img.onerror = function () { err.textContent = 'Не удалось прочитать файл'; err.style.display = 'block'; };
    img.src = url;
  });

  // ── Старт ────────────────────────────────────────────────────────────
  if (localStorage.getItem(TOKEN_KEY)) {
    api('GET', '/portal/me')
      .then(function (o) { state.owner = o; openPets(); })
      .catch(function () { show('scr-login'); });
  } else {
    show('scr-login');
  }
})();
