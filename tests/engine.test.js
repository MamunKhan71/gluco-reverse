import { test } from 'node:test';
import assert from 'node:assert/strict';
import { suggestBolus, basalProposal, evaluateAlerts, checkReading, mealTotals, DAY, adaptCarbs, bmiInfo, ftInToCm, cmToFtIn, stockStatus, nextSite } from '../www/src/engine.js';
import { DEFAULT_PLAN } from '../www/src/plan.js';
import { DEFAULT_HOME_FOODS } from '../www/src/foods.js';
import { suggestMenu, alternativesFor, dishesToItems, recipeOf, pantryMeal } from '../www/src/menu.js';
import { applyMeds } from '../www/src/meds.js';

// New users start with no medicines; the tests use a typical prescription
// (Actrapid 16+16+12 before meals, Lantus 20 at night, Lino 5 mg at lunch).
const plan = applyMeds({
  ...structuredClone(DEFAULT_PLAN),
  meds: [
    { id: 'actrapid', type: 'pen', name: 'actrapid', insulinKind: 'rapid', times: [{ when: 'breakfast', amount: 16, at: '07:30' }, { when: 'lunch', amount: 16, at: '13:00' }, { when: 'dinner', amount: 12, at: '20:00' }] },
    { id: 'lantus', type: 'pen', name: 'lantus', insulinKind: 'basal', times: [{ when: 'night', amount: 20, at: '22:00' }] },
    { id: 'lino', type: 'tablet', name: 'Lino', strength: '5 mg', times: [{ when: 'noon', amount: 1, meal: 'with' }] },
  ],
});
const NOW = new Date('2026-11-10T09:00:00').getTime();
let n = 0;
const reading = (value, hoursAgo, context = 'other', extra = {}) => ({
  id: `r${n++}`,
  type: 'reading',
  value,
  context,
  ts: NOW - hoursAgo * 3600e3,
  ...extra,
});

test('normal reading and meal gives the prescribed dose', () => {
  const s = suggestBolus(plan, 'lunch', 8, 'normal');
  assert.equal(s.action, 'inject');
  assert.equal(s.units, 16);
  assert.equal(s.limitHit, false);
});

test('low reading before a meal means treat the low first', () => {
  assert.equal(suggestBolus(plan, 'breakfast', 3.5, 'normal').action, 'hypo');
});

test('no meal means no Actrapid', () => {
  assert.equal(suggestBolus(plan, 'dinner', 9, 'none').action, 'skip');
});

test('high reading adds 2 within range', () => {
  const s = suggestBolus(plan, 'breakfast', 15, 'normal');
  assert.equal(s.units, 18);
  assert.equal(s.limitHit, false);
});

test('reading 4.5 plus small meal wants -4 but is capped at -2 and flags the doctor', () => {
  const s = suggestBolus(plan, 'lunch', 4.5, 'small');
  assert.equal(s.wanted, 12);
  assert.equal(s.units, 14);
  assert.equal(s.limitHit, true);
});

test('dinner range is 10-14 around 12', () => {
  const s = suggestBolus(plan, 'dinner', 4.5, 'small');
  assert.equal(s.units, 10);
});

test('Lantus: any low since last change proposes -2 immediately', () => {
  const log = [reading(3.6, 10)];
  const p = basalProposal(plan, { current: 20, lastChange: NOW - 1 * DAY }, log, NOW);
  assert.equal(p.reason, 'low');
  assert.equal(p.proposed, 18);
});

test('Lantus: a low from before the last change is not counted twice', () => {
  const log = [reading(3.6, 30)];
  const p = basalProposal(plan, { current: 18, lastChange: NOW - 1 * DAY }, log, NOW);
  assert.equal(p.change, 0);
});

test('Lantus: high fasting average needs a 3 am check before increasing', () => {
  const log = [reading(10, 2, 'fasting'), reading(9.5, 26, 'fasting'), reading(10.2, 50, 'fasting')];
  const p = basalProposal(plan, undefined, log, NOW);
  assert.equal(p.reason, 'need_3am');
  assert.equal(p.change, 0);
  log.push(reading(7.5, 6, 'night_3am'));
  const p2 = basalProposal(plan, undefined, log, NOW);
  assert.equal(p2.reason, 'fasting_high');
  assert.equal(p2.proposed, 22);
});

test('Lantus: not due within 3 days of the last change', () => {
  const log = [reading(10, 2, 'fasting'), reading(10, 26, 'fasting'), reading(10, 40, 'fasting'), reading(7, 6, 'night_3am')];
  const p = basalProposal(plan, { current: 20, lastChange: NOW - 2 * DAY }, log, NOW);
  assert.equal(p.reason, 'not_due');
  assert.equal(p.change, 0);
});

test('Lantus: at the top of the range, a further increase flags the doctor', () => {
  const log = [reading(10, 2, 'fasting'), reading(10, 26, 'fasting'), reading(10, 50, 'fasting'), reading(8, 6, 'night_3am')];
  const p = basalProposal(plan, { current: 22, lastChange: NOW - 4 * DAY }, log, NOW);
  assert.equal(p.proposed, 22);
  assert.equal(p.limitHit, true);
});

test('alerts: two lows in a week is orange, severe low is orange', () => {
  const log = [reading(3.5, 50), reading(2.8, 10)];
  const codes = evaluateAlerts(plan, log, {}, NOW).map((a) => a.code);
  assert.ok(codes.includes('lows_week'));
  assert.ok(codes.includes('severe_low'));
});

test('alerts: night low is orange', () => {
  const log = [reading(3.4, 7)]; // 02:00
  const codes = evaluateAlerts(plan, log, {}, NOW).map((a) => a.code);
  assert.ok(codes.includes('night_low'));
});

test('alerts: two highs in a row is orange; high with symptoms is red', () => {
  const log = [reading(18, 5), reading(19, 2, 'other', { symptoms: ['vomiting'] })];
  const alerts = evaluateAlerts(plan, log, {}, NOW);
  assert.equal(alerts[0].level, 'red');
  assert.ok(alerts.some((a) => a.code === 'high_twice'));
});

test('alerts: same meal adjusted up on 3 days is yellow', () => {
  const log = [1, 2, 3].map((d) => ({ id: `d${d}`, type: 'dose', kind: 'bolus', slot: 'lunch', delta: 2, ts: NOW - d * DAY }));
  const codes = evaluateAlerts(plan, log, {}, NOW).map((a) => a.code);
  assert.ok(codes.includes('repeat_adjust'));
});

test('alerts: weight down 3 kg is yellow, acked alerts disappear', () => {
  const log = [{ id: 'w1', type: 'weight', kg: 60.5, ts: NOW - DAY }];
  const a = evaluateAlerts(plan, log, {}, NOW).find((x) => x.code === 'weight_down');
  assert.ok(a);
  const after = evaluateAlerts(plan, log, { acked: [a.key] }, NOW);
  assert.ok(!after.some((x) => x.code === 'weight_down'));
});

test('reading checks: mg/dL detection, meter range, big jump', () => {
  assert.equal(checkReading('180').problem, 'mgdl');
  assert.equal(checkReading('180').value, 10);
  assert.equal(checkReading('0.5').problem, 'out_of_range');
  assert.equal(checkReading('3.3', { value: 18, ts: NOW - 3600e3 }, NOW).problem, 'big_jump');
  assert.equal(checkReading('7,2').value, 7.2);
});

test('meal totals', () => {
  assert.deepEqual(mealTotals({ rice: 1.5, rui: 1, lau: 2 }), { kcal: 540, carb: 84 });
});

test('menu uses home dishes, never potato, sugar or shutki, fills missing vegetables', () => {
  const s = suggestMenu(DEFAULT_HOME_FOODS, { riceCups: 1.5, day: 1 });
  const dishes = Object.values(s.meals).flat();
  const foods = Object.keys(dishesToItems(dishes));
  assert.ok(!foods.some((f) => ['potato', 'sugar', 'shutki'].includes(f)));
  assert.ok(dishes.some((d) => ['rui_lau', 'pangas_pepe', 'tilapia_bhuna'].includes(d.id)));
  assert.ok(dishes.some((d) => d.extra && recipeOf(d.id).role === 'veg'));
  assert.equal(s.meals.lunch[0].scale, 1.5);
  assert.ok(s.tips.includes('potato') && s.tips.includes('sugar'));
  assert.ok(s.shopping.includes('lau') || s.shopping.includes('potol'));
  for (const d of dishes) assert.ok(recipeOf(d.id), d.id);
});

test('menu: red meat at most every 4th day, mains and vegetables rotate, no repeat in a day', () => {
  const days = [0, 1, 2, 3, 4, 5, 6, 7].map((day) => suggestMenu([...DEFAULT_HOME_FOODS, 'lau', 'potol', 'lal_shak', 'egg', 'roti'], { day }).meals);
  const lunches = days.map((m) => m.lunch[1].id);
  assert.equal(lunches.filter((id) => id === 'beef_bhuna').length, 2);
  assert.ok(new Set(lunches).size >= 3);
  for (const m of days) {
    assert.notEqual(m.lunch[1].id, m.dinner[1].id);
    const vegs = [m.breakfast, m.lunch, m.dinner].flat().filter((d) => recipeOf(d.id).role === 'veg').map((d) => d.id);
    assert.equal(new Set(vegs).size, vegs.length);
  }
});

test('menu trims rice to the calorie target, keeps at least 1 cup at lunch', () => {
  const s = suggestMenu(DEFAULT_HOME_FOODS, { riceCups: 1.5, day: 1, kcalTarget: 1300 });
  assert.ok(s.kcal <= 1300 || s.meals.lunch[0].scale === 1);
  assert.ok(s.meals.lunch[0].scale >= 1);
});

test('menu: learned carb steps cut rice/roti, eaten meals shrink the rest of the day', () => {
  const base = suggestMenu(DEFAULT_HOME_FOODS, { riceCups: 1.5, day: 2 });
  const cut = suggestMenu(DEFAULT_HOME_FOODS, { riceCups: 1.5, day: 2, carbSteps: { lunch: -1 } });
  assert.equal(cut.meals.lunch[0].scale, base.meals.lunch[0].scale - 0.5);
  const after = suggestMenu(DEFAULT_HOME_FOODS, { riceCups: 1.5, day: 2, kcalTarget: 1300, eaten: { breakfast: 700 } });
  const before = suggestMenu(DEFAULT_HOME_FOODS, { riceCups: 1.5, day: 2, kcalTarget: 1300 });
  assert.ok(after.meals.lunch[0].scale + after.meals.dinner[0].scale < before.meals.lunch[0].scale + before.meals.dinner[0].scale);
});

test('menu: swaps replace a dish with another of the same kind', () => {
  const alts = alternativesFor(DEFAULT_HOME_FOODS, 'rui_lau');
  assert.ok(alts.includes('pangas_pepe') && alts.includes('chicken_pepe'));
  const s = suggestMenu(DEFAULT_HOME_FOODS, { day: 1, swaps: { 'lunch:1': 'tilapia_bhuna' } });
  assert.equal(s.meals.lunch[1].id, 'tilapia_bhuna');
});

test('pantry meal: rice, dal, egg, meat sized to the budget within sensible portions', () => {
  const m = pantryMeal(['rice', 'dal', 'egg', 'beef'], 455);
  assert.ok(m.kcal <= 455, String(m.kcal));
  assert.ok(m.items.rice >= 0.5 && m.items.rice <= 1);
  assert.ok(m.items.dal >= 0.5 && m.items.dal <= 1);
  assert.deepEqual([m.items.rice, m.items.dal, m.items.egg], [0.5, 1, 2]); // protein grows before rice
  assert.equal(m.items.beef, undefined);
  const big = pantryMeal(['rice', 'dal', 'egg', 'lau'], 2000);
  assert.deepEqual([big.items.rice, big.items.dal, big.items.egg, big.items.lau], [1, 1, 2, 2]);
  assert.ok(pantryMeal(['rice'], 300).missing.protein);
});

test('adaptCarbs: high after lunch twice → step down; lows → back up; waits 3 days', () => {
  const at = (d, hh) => new Date(new Date(NOW).setHours(hh, 0, 0, 0) - d * DAY).getTime();
  const high = [1, 2].map((d) => ({ id: `p${d}`, type: 'reading', value: 12, context: 'post_meal', ts: at(d, 15) }));
  const r = adaptCarbs(plan, high, {}, NOW);
  assert.deepEqual(r.changes.map((c) => [c.slot, c.to]), [['lunch', -1]]);
  assert.equal(adaptCarbs(plan, high, r.carbs, NOW + DAY).changes.length, 0);
  const low = [{ id: 'l1', type: 'reading', value: 3.4, context: 'other', ts: at(0, 16) }];
  const r2 = adaptCarbs(plan, low, { lunch: { step: -1, at: NOW - 4 * DAY } }, NOW + 8 * 3600e3);
  assert.equal(r2.carbs.lunch.step, 0);
});

test('BMI and height conversion', () => {
  assert.equal(ftInToCm(4, 10), 147.3);
  assert.deepEqual(cmToFtIn(147.3), { ft: 4, inch: 10 });
  const b = bmiInfo(64, 147.3);
  assert.equal(b.cat, 'obese');
  assert.deepEqual(b.healthy, [40, 50]);
});

test('stock: insulin left, pen expiry, tablets and strips count down', () => {
  const opened = NOW - 26 * DAY;
  const log = [{ id: 'x', type: 'dose', insulin: 'lantus', medId: 'lantus', units: 20, ts: NOW - DAY }, { id: 'y', type: 'reading', value: 7, ts: NOW - 3600e3 }];
  const stock = { lantus: { openedAt: opened, spare: 0 }, lino: { count: 10, at: NOW - 4 * DAY }, strips: { count: 11, at: NOW - DAY } };
  const items = stockStatus(stock, log, plan.meds, NOW);
  const pen = items.find((i) => i.id === 'lantus');
  assert.equal(pen.left, 278);
  assert.equal(pen.daysLeft, 2);
  assert.equal(pen.warn, 'replace');
  // Lino: 1 a day, 10 counted 4 days ago → 6 left, about 6 days
  const lino = items.find((i) => i.id === 'lino');
  assert.equal(lino.left, 6);
  assert.equal(lino.daysLeft, 6);
  assert.equal(lino.warn, null);
  assert.deepEqual(items.find((i) => i.id === 'strips'), { id: 'strips', kind: 'equip', left: 10, warn: 'buy' });
});

test('injection sites rotate to the one used longest ago', () => {
  assert.equal(nextSite([], 'actrapid'), 'abd_ul');
  const log = [
    { type: 'dose', insulin: 'actrapid', site: 'abd_ul', ts: 1 },
    { type: 'dose', insulin: 'actrapid', site: 'abd_ur', ts: 2 },
  ];
  assert.equal(nextSite(log, 'actrapid'), 'abd_lr');
  assert.equal(nextSite([{ type: 'dose', insulin: 'lantus', site: 'thigh_l', ts: 5 }], 'lantus'), 'thigh_r');
});

test('injection sites work for any insulin name', () => {
  assert.equal(nextSite([], 'Actrapid', 'bolus'), 'abd_ul');
  assert.equal(nextSite([], 'Humulin N', 'basal'), 'thigh_l');
  assert.equal(nextSite([{ type: 'dose', insulin: 'NovoRapid', site: 'abd_ul', ts: 1 }], 'NovoRapid', 'bolus'), 'abd_ur');
});
