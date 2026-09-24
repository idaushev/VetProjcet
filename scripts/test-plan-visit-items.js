// Тест плана сохранения позиций при правке приёма (VET-017).
// Запуск: node scripts/test-plan-visit-items.js   (браузер не нужен)
//
// VetUI.planVisitItems — чистая функция, но живёт в frontend/js/ui.js, который
// при загрузке трогает DOM. Поэтому грузим файл в песочнице с заглушками и
// проверяем только функцию. Сценарии — конкурентная правка одного приёма
// двумя планшетами: что уходит на сервер (op), сумма приёма (gross), что
// удаляется, предупреждён ли врач о чужих изменениях.
'use strict';
var vm = require('vm');
var fs = require('fs');
var path = require('path');

function noop() {}
var el = new Proxy(function () {}, {
  get: function (t, k) { return (k === 'style' || k === 'dataset' || k === 'classList') ? new Proxy({}, { get: function () { return noop; } }) : noop; },
  apply: function () { return el; }
});
var ctx = {
  console: console, setTimeout: setTimeout, setInterval: setInterval, clearInterval: clearInterval,
  addEventListener: noop, matchMedia: function () { return { matches: false, addEventListener: noop }; },
  localStorage: { getItem: function () { return null; }, setItem: noop, removeItem: noop },
  document: { addEventListener: noop, getElementById: function () { return null; }, querySelector: function () { return null; },
              querySelectorAll: function () { return []; }, createElement: function () { return el; }, body: el, documentElement: el },
  navigator: {}
};
ctx.window = ctx;
vm.createContext(ctx);
vm.runInContext(fs.readFileSync(path.join(__dirname, '..', 'frontend', 'js', 'ui.js'), 'utf8'), ctx);
var P = ctx.VetUI.planVisitItems;

var exam = { id: 'i1', visit_id: 'v', item_id: 'it', name: 'Осмотр', type: 'service', quantity: 1, price: 5000, cost_price: 0, total: 5000 };
// Сумма без округления — так её пишет createFullVisit: 0.3 × 350.
var drug = { id: 'i2', visit_id: 'v', item_id: 'd', name: 'Препарат', type: 'drug', quantity: 0.3, price: 350, cost_price: 0, total: 104.99999999999999 };
function W(x, o) { return Object.assign({}, x, o); }
// Строка формы: как её собирает collectVisitItemsForEdit.
function F(vi, x, o) {
  return { vi_id: vi, item: Object.assign({ item_id: x.item_id, name: x.name, type: x.type, quantity: x.quantity,
    price: x.price, cost_price: x.cost_price || 0, total: Math.round(x.quantity * x.price * 100) / 100 }, o || {}) };
}
function S(r) { return [r.plan.map(function (p) { return p.op; }).join(','), r.gross, r.toDelete.join(','), r.elsewhere.length].join('|'); }

// [сценарий, форма, при открытии, сейчас в базе, ожидание 'ops|сумма|удалить|предупреждений']
var cases = [
  ['никто ничего не трогал (дробная доза — без ложной правки)', [F('i1', exam), F('i2', drug)], { i1: exam, i2: drug }, { i1: exam, i2: drug }, 'keep,keep|5105||0'],
  ['другой планшет сменил цену, врач не трогал — не перетираем', [F('i1', exam)], { i1: exam }, { i1: W(exam, { price: 3000, total: 3000 }) }, 'keep|3000||1'],
  ['врач изменил количество', [F('i1', exam, { quantity: 2, total: 10000 })], { i1: exam }, { i1: exam }, 'update|10000||0'],
  ['врач убрал строку', [], { i1: exam }, { i1: exam }, '|0|i1|0'],
  ['другой убрал строку, врач её правил — заводим заново', [F('i1', exam, { quantity: 2, total: 10000 })], { i1: exam }, {}, 'create|10000||1'],
  ['другой добавил строку после открытия — не удаляем, считаем', [F('i1', exam)], { i1: exam }, { i1: exam, i9: W(exam, { id: 'i9', name: 'Анализ', total: 2000 }) }, 'keep,keep|7000||1'],
  ['врач изменил только себестоимость', [F('i1', exam, { cost_price: 1200 })], { i1: exam }, { i1: exam }, 'update|5000||0'],
  ['оба правили одну строку — правка врача, с предупреждением', [F('i1', exam, { quantity: 2, total: 10000 })], { i1: exam }, { i1: W(exam, { price: 3000, total: 3000 }) }, 'update|10000||1'],
  ['черновик (снимок при открытии) поверх чужой цены', [F('i1', exam)], { i1: exam }, { i1: W(exam, { price: 3000, total: 3000 }) }, 'keep|3000||1'],
  ['черновик поверх чужого удаления — строку не воскрешаем', [F('i1', exam)], { i1: exam }, {}, '|0||1'],
  ['pull обнулил себестоимость — это не чужая правка', [F('i1', W(exam, { cost_price: 1200 }))], { i1: W(exam, { cost_price: 1200 }) }, { i1: exam }, 'keep|5000||0']
];

var failed = 0;
cases.forEach(function (c) {
  var got = S(P(c[1], c[2], c[3]));
  var ok = got === c[4];
  if (!ok) failed++;
  console.log((ok ? 'ok    ' : 'FAIL  ') + c[0] + (ok ? '' : '\n      получили ' + got + ', ждали ' + c[4]));
});
// Итоговый счёт для результатов включает чужие добавления.
var items = P([F('i1', exam)], { i1: exam }, { i1: exam, i9: W(exam, { id: 'i9', name: 'Анализ' }) }).items;
if (items.map(function (i) { return i.name; }).join(',') !== 'Осмотр,Анализ') { failed++; console.log('FAIL  итоговый счёт для результатов'); }
else console.log('ok    итоговый счёт для результатов включает чужие строки');

console.log(failed ? '\n' + failed + ' провалено' : '\nвсе прошли');
process.exit(failed ? 1 : 0);
