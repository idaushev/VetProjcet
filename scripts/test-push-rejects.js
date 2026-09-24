// Тест разбора ответа push на планшете (B-013).
// Запуск: node scripts/test-push-rejects.js   (браузер не нужен)
//
// Грузим настоящий frontend/js/sync.js в песочнице; IndexedDB заменена базой
// в памяти, сервер — подменённым ответом. Проверяем: запись, которую сервер
// не принял (rejected), остаётся неотправленной с причиной и уходит в
// следующий push; принятая — становится synced; «сервер новее» (skipped) —
// synced, как раньше; ответ старого сервера без rejected — как раньше.
'use strict';
var vm = require('vm');
var fs = require('fs');
var path = require('path');

function makeDB() {
  var stores = {};
  function st(n) { return stores[n] || (stores[n] = {}); }
  return {
    stores: stores,
    getDeviceID: function () { return 'dev-test'; },
    getAll: async function (n) { return Object.values(st(n)).map(function (r) { return Object.assign({}, r); }); },
    getById: async function (n, id) { return st(n)[id] ? Object.assign({}, st(n)[id]) : null; },
    writes: 0,
    // Контракт db.js: версия отправленной записи — если выросла, не помечаем.
    markSynced: async function (n, id, _t, expectedVersion) {
      var r = st(n)[id]; if (!r) return null;
      this.lastExpected = expectedVersion;
      if (expectedVersion != null && r.version !== expectedVersion) return r;
      st(n)[id] = Object.assign({}, r, { sync_status: 'synced', sync_error: '' });
      return st(n)[id];
    },
    // keep — дописать поля поверх (pushSync); иначе — запись с сервера (pull).
    bulkSave: async function (n, items, opts) {
      this.writes++;
      items.forEach(function (it) {
        st(n)[it.id] = (opts && opts.keep) ? Object.assign({}, st(n)[it.id] || {}, it)
                                          : Object.assign({}, it, { sync_status: (opts && opts.sync_status) || 'pending' });
      });
    },
    hardDelete: async function (n, id) { delete st(n)[id]; },
    state: {},
    getSyncState: async function (k) { return this.state[k] || ''; },
    setSyncState: async function (k, v) { this.state[k] = v; }
  };
}

function load(db, respond, extra) {
  var sent = [];
  var ctx = {
    console: { log: function () {}, info: function () {}, warn: function () {}, error: console.error },
    setTimeout: setTimeout, clearTimeout: clearTimeout, Promise: Promise, JSON: JSON, Date: Date, Map: Map, Set: Set,
    navigator: { onLine: true },
    VetDB: db, VetAppConfig: { apiBase: '' },
    __nativeFetch: async function (url, opts) {
      var body = opts && opts.body ? JSON.parse(opts.body) : null;
      sent.push({ url: url, body: body });
      var data = respond(url, body);
      return { status: 200, ok: true, json: async function () { return { status: 'ok', data: data }; } };
    }
  };
  Object.assign(ctx, extra || {});
  ctx.window = ctx;
  vm.createContext(ctx);
  vm.runInContext(fs.readFileSync(path.join(__dirname, '..', 'frontend', 'js', 'sync.js'), 'utf8'), ctx);
  return { S: ctx.VetSync, sent: sent };
}

var failed = 0;
function check(name, cond, detail) {
  if (cond) console.log('ok    ' + name);
  else { failed++; console.log('FAIL  ' + name + (detail ? '\n      ' + detail : '')); }
}

(async function () {
  var db = makeDB();
  db.stores.owners = {
    'o-ok':   { id: 'o-ok',   fio: 'Принятый',    sync_status: 'pending' },
    'o-bad':  { id: 'o-bad',  fio: 'Отклонённый', sync_status: 'pending' },
    'o-old':  { id: 'o-old',  fio: 'Устаревший',  sync_status: 'pending' }
  };
  var phase = 1;
  var env = load(db, function (url) {
    if (url.indexOf('/sync/push') < 0) return {};
    return phase === 1
      ? { accepted: 1, skipped: 1, rejected: [{ entity: 'owners', id: 'o-bad', reason: 'на сервере нет связанной записи: FOREIGN KEY constraint failed' }] }
      : { accepted: 1, skipped: 0 };
  });

  var r1 = await env.S.pushSync();
  var o = db.stores.owners;
  check('принятая запись стала synced', o['o-ok'].sync_status === 'synced');
  check('«сервер новее» (skipped) — synced, как раньше', o['o-old'].sync_status === 'synced');
  check('отклонённая осталась неотправленной', o['o-bad'].sync_status === 'pending', JSON.stringify(o['o-bad']));
  check('у отклонённой сохранена причина', /FOREIGN KEY/.test(o['o-bad'].sync_error || ''), o['o-bad'].sync_error);
  check('данные отклонённой не тронуты', o['o-bad'].fio === 'Отклонённый');
  check('pushSync сообщает число непринятых', r1.rejected === 1, JSON.stringify(r1));

  // Следующий цикл: отклонённая уходит снова; сервер её принял — ошибка снята.
  phase = 2;
  await env.S.pushSync();
  var second = env.sent[env.sent.length - 1].body;
  check('отклонённая ушла в следующий push', (second.owners || []).some(function (r) { return r.id === 'o-bad'; }));
  check('после приёма — synced и без ошибки', o['o-bad'].sync_status === 'synced' && !o['o-bad'].sync_error, JSON.stringify(o['o-bad']));

  // Старый сервер: rejected нет — всё synced, как до B-013.
  var db2 = makeDB();
  db2.stores.owners = { 'x': { id: 'x', fio: 'X', sync_status: 'pending' } };
  var env2 = load(db2, function () { return { accepted: 0, skipped: 1 }; });
  var r2 = await env2.S.pushSync();
  check('старый сервер без rejected — всё synced', db2.stores.owners.x.sync_status === 'synced' && r2.rejected === 0);

  // Повтор с той же причиной — без лишней записи в базу каждые 15 секунд.
  var db3 = makeDB();
  db3.stores.owners = { 'f': { id: 'f', fio: 'F', sync_status: 'pending', version: 2 } };
  var env3 = load(db3, function () {
    return { accepted: 0, skipped: 0, rejected: [{ entity: 'owners', id: 'f', reason: 'сервер не смог записать' }] };
  });
  await env3.S.pushSync();
  var w = db3.writes;
  await env3.S.pushSync();
  check('повтор с той же причиной не пишет в базу', db3.writes === w, 'записей: ' + w + ' → ' + db3.writes);

  // Постоянный отказ (нет права): не висит pending, не повторяется,
  // сообщается врачу и при pull уступает серверной версии.
  var db4 = makeDB();
  db4.stores.owners = { 'p': { id: 'p', fio: 'Моя правка', sync_status: 'pending', version: 5 } };
  var env4 = load(db4, function (url) {
    if (url.indexOf('/sync/push') >= 0) {
      return { accepted: 0, skipped: 0, rejected: [{ entity: 'owners', id: 'p', reason: 'нет права на запись', permanent: true }] };
    }
    return {};
  });
  var r4 = await env4.S.pushSync();
  check('постоянный отказ — статус rejected, не pending', db4.stores.owners.p.sync_status === 'rejected', JSON.stringify(db4.stores.owners.p));
  check('постоянный отказ сообщается (dropped)', r4.dropped && r4.dropped.length === 1, JSON.stringify(r4));
  var sentBefore = env4.sent.length;
  await env4.S.pushSync();
  check('отклонённая окончательно в push больше не идёт', env4.sent.length === sentBefore);
  await env4.S.mergePulledStore('owners', [{ id: 'p', fio: 'Версия сервера', version: 3, updated_at: '2026-09-01T10:00:00Z' }]);
  check('при pull уступает серверу, даже с меньшей версией', db4.stores.owners.p.fio === 'Версия сервера' && db4.stores.owners.p.sync_status === 'synced',
    JSON.stringify(db4.stores.owners.p));

  // Гонка: запись поправили, пока шёл push, — принятая старая версия не
  // должна пометить отправленной новую правку.
  var db5 = makeDB();
  db5.stores.owners = { 'g': { id: 'g', fio: 'v1', sync_status: 'pending', version: 1 } };
  var env5 = load(db5, function () {
    db5.stores.owners.g = { id: 'g', fio: 'v2 — правка во время push', sync_status: 'pending', version: 2 };
    return { accepted: 1, skipped: 0 };
  });
  await env5.S.pushSync();
  check('pushSync передаёт отправленную версию', db5.lastExpected === 1, String(db5.lastExpected));
  check('правка во время push осталась неотправленной', db5.stores.owners.g.sync_status === 'pending' && db5.stores.owners.g.version === 2,
    JSON.stringify(db5.stores.owners.g));

  // B-012: разовая повторная отправка своих записей, которых нет на сервере.
  function b012db() {
    var d = makeDB();
    d.stores.staff  = { 's-mine':  { id: 's-mine',  name: 'Мой врач', sync_status: 'synced', device_id: 'dev-test', version: 1 },
                        's-other': { id: 's-other', name: 'Чужой',    sync_status: 'synced', device_id: 'dev-b',    version: 1 } };
    d.stores.visits = { 'v-mine':   { id: 'v-mine',   sync_status: 'synced',  device_id: 'dev-test', version: 3, base_version: 2 },
                        'v-onsrv':  { id: 'v-onsrv',  sync_status: 'synced',  device_id: 'dev-test', version: 2, total_amount: 0 },
                        'v-pend':   { id: 'v-pend',   sync_status: 'pending', device_id: 'dev-test', version: 4, base_version: 3 } };
    d.stores.vaccinations = { 'vac-mine': { id: 'vac-mine', sync_status: 'synced', device_id: 'dev-test' } };
    d.stores.owners = { 'o-mine': { id: 'o-mine', sync_status: 'synced', device_id: 'dev-test' } };
    return d;
  }
  // Снимок сервера: v-onsrv у него есть (с настоящей суммой), vaccinations
  // этому пользователю не видны — стора в снимке нет.
  function b012server(url) {
    if (url.indexOf('/sync/pull') >= 0) return { staff: [{ id: 's-other' }], visits: [{ id: 'v-onsrv', total_amount: 5000 }, { id: 'v-pend' }] };
    return { accepted: 2, skipped: 0 };
  }
  var can = function (t, a) { return true; };

  var dbNo = b012db();
  var envNo = load(dbNo, b012server, { VetAuth: { can: function (t) { return t !== 'staff'; }, token: function () { return ''; } } });
  check('B-012: без права создавать сотрудников — не запускается и ждёт', (await envNo.S.recoverStuckRecords()) === 0 &&
    !dbNo.state.recovery_b012);

  var db6 = b012db();
  var env6 = load(db6, b012server, { VetAuth: { can: can, token: function () { return ''; } } });
  var n6 = await env6.S.recoverStuckRecords();
  check('B-012: в отправку — только свои записи, которых нет на сервере', n6 === 2 &&
    db6.stores.staff['s-mine'].sync_status === 'pending' && db6.stores.visits['v-mine'].sync_status === 'pending', 'помечено ' + n6);
  check('B-012: то, что сервер уже принял, не повторяется (суммы не затрёт)', db6.stores.visits['v-onsrv'].sync_status === 'synced');
  check('B-012: стор, невидимый пользователю, не трогается', db6.stores.vaccinations['vac-mine'].sync_status === 'synced');
  check('B-012: чужие записи и другие сущности не тронуты', db6.stores.staff['s-other'].sync_status === 'synced' &&
    db6.stores.owners['o-mine'].sync_status === 'synced');
  check('B-012: base_version снят — повтор без ложного конфликта', db6.stores.visits['v-mine'].base_version === null);
  check('B-012: уже неотправленная правка не тронута', db6.stores.visits['v-pend'].base_version === 3);
  check('B-012: второй запуск ничего не делает', (await env6.S.recoverStuckRecords()) === 0);
  await env6.S.pushSync();
  var sent6 = env6.sent[env6.sent.length - 1].body;
  check('B-012: записи ушли в push, приём — без base_version', (sent6.staff || []).length === 1 &&
    (sent6.visits || []).some(function (v) { return v.id === 'v-mine' && v.base_version === null; }));

  // B-008: отметка конфликта доезжает при pull независимо от часов планшета.
  var db7 = makeDB();
  db7.stores.visits = {
    // часы планшета спешат: локальное время позже серверного при равной версии
    'v-skew': { id: 'v-skew', diagnosis: 'Гастрит', conflict_json: '', sync_status: 'synced', version: 2, updated_at: '2026-09-01T12:30:00Z' },
    // врач разобрал конфликт, правка ещё не ушла
    'v-res':  { id: 'v-res', conflict_json: '', conflict_resolved: 't1', sync_status: 'pending', version: 3, updated_at: '2026-09-01T12:00:00Z' }
  };
  var env7 = load(db7, function () { return {}; });
  await env7.S.mergePulledStore('visits', [
    { id: 'v-skew', diagnosis: 'Гастрит', conflict_json: '[{"detected_at":"t9","item":{"id":"i"}}]', version: 2, updated_at: '2026-09-01T12:10:00Z' },
    { id: 'v-res',  conflict_json: '[{"detected_at":"t1"}]', version: 2, updated_at: '2026-09-01T11:00:00Z' }
  ]);
  check('B-008: отметка конфликта доезжает при спешащих часах планшета', db7.stores.visits['v-skew'].conflict_json.indexOf('t9') >= 0,
    JSON.stringify(db7.stores.visits['v-skew']));
  check('B-008: разобранная и ещё не ушедшая отметка не возвращается', db7.stores.visits['v-res'].conflict_json === '');

  console.log(failed ? '\n' + failed + ' провалено' : '\nвсе прошли');
  process.exit(failed ? 1 : 0);
})().catch(function (e) { console.error(e); process.exit(1); });
