import { test } from 'node:test';
import assert from 'node:assert/strict';
import { searchMeds, parseDoseString, doseTimes, insulinDoses, generalTimes, applyMeds, insulinClash, knownMed, amountText } from '../www/src/meds.js';

test('prescription dose strings', () => {
  assert.deepEqual(parseDoseString('16+16+12'), [16, 16, 12]);
  assert.deepEqual(parseDoseString('১+০+১'), [1, 0, 1]);
  assert.deepEqual(parseDoseString('½+0+½'), [0.5, 0, 0.5]);
  assert.deepEqual(parseDoseString('1/2 + 0 + 1'), [0.5, 0, 1]);
  assert.deepEqual(parseDoseString('1½+0+1'), [1.5, 0, 1]);
  assert.deepEqual(parseDoseString('16-16-12'), [16, 16, 12]);
  assert.deepEqual(parseDoseString('1+1+1+1'), [1, 1, 1, 1]);
  assert.equal(parseDoseString('abc'), null);
  assert.equal(parseDoseString('16'), null);
});

test('numbers go to the right times', () => {
  const actrapid = { type: 'pen', insulinKind: 'rapid' };
  const lantus = { type: 'pen', insulinKind: 'basal' };
  assert.deepEqual(doseTimes([16, 16, 12], actrapid).map((x) => x.when), ['breakfast', 'lunch', 'dinner']);
  assert.deepEqual(doseTimes([0, 0, 20], lantus), [{ when: 'night', amount: 20 }]);
  assert.deepEqual(doseTimes([1, 0, 1], { type: 'tablet' }).map((x) => x.when), ['morning', 'night']);
});

const MEDS = [
  { id: 'm1', type: 'pen', name: 'Actrapid', insulinKind: 'rapid', times: [{ when: 'breakfast', amount: 16 }, { when: 'lunch', amount: 16, at: '13:15' }, { when: 'dinner', amount: 12 }] },
  { id: 'm2', type: 'pen', name: 'Lantus', insulinKind: 'basal', times: [{ when: 'night', amount: 20 }] },
  { id: 'm3', type: 'tablet', name: 'Lino', strength: '5 mg', times: [{ when: 'noon', amount: 1, meal: 'with' }] },
  { id: 'm4', type: 'tablet', name: 'Atova', strength: '10 mg', times: [{ when: 'bedtime', amount: 1 }] },
];

test('insulin cards become the dose list with ±2', () => {
  const d = insulinDoses(MEDS);
  assert.deepEqual(d.map((x) => [x.id, x.kind, x.base, x.min, x.max]), [
    ['breakfast', 'bolus', 16, 14, 18],
    ['lunch', 'bolus', 16, 14, 18],
    ['dinner', 'bolus', 12, 10, 14],
    ['night', 'basal', 20, 18, 22],
  ]);
  assert.equal(d[1].injectAt, '13:15');
  assert.equal(d[1].mealAt, '13:45');
  assert.equal(d[3].mealAt, undefined);
});

test('other medicines become reminders and meal ticks', () => {
  const g = generalTimes(MEDS);
  assert.deepEqual(g.map((x) => [x.name, x.at, x.with]), [['Lino 5 mg', '13:30', 'lunch'], ['Atova 10 mg', '22:30', '']]);
  const plan = applyMeds({ meds: MEDS });
  assert.deepEqual(plan.tablets, [{ id: 'm3', name: 'Lino 5 mg', with: 'lunch', amount: 1 }]);
  assert.equal(plan.doses.length, 4);
});

test('a plan without medicines keeps its doses; an empty list clears them', () => {
  assert.deepEqual(applyMeds({ doses: [1] }).doses, [1]);
  assert.deepEqual(applyMeds({ doses: [1], meds: [] }).doses, []);
});

test('two insulins at one time are refused', () => {
  assert.equal(insulinClash(MEDS), '');
  assert.equal(insulinClash([...MEDS, { id: 'm5', type: 'vial', times: [{ when: 'night', amount: 4 }] }]), 'night');
});

test('helpers', () => {
  assert.equal(knownMed('lantus').insulinKind, 'basal');
  assert.equal(amountText(0.5), '½');
  assert.equal(amountText(1.5), '1½');
  assert.equal(amountText(2), '2');
});

test('medicine search: brand or generic, insulin kept apart', () => {
  assert.equal(searchMeds('comet', false)[0].name, 'Comet');
  assert.ok(searchMeds('metformin', false).some((k) => k.name === 'Comet'));
  assert.ok(searchMeds('glargine', true).some((k) => k.name === 'Lantus'));
  assert.ok(searchMeds('lan', true).every((k) => k.type === 'pen' || k.type === 'vial'));
  assert.equal(searchMeds('lantus', false).length, 0);
  assert.equal(searchMeds('', false).length, 6);
});

test('all-day insulin: morning or night only; meal insulin: before meals only', () => {
  const basal = { type: 'pen', insulinKind: 'basal' };
  assert.deepEqual(doseTimes([20, 0, 0], basal), [{ when: 'breakfast', amount: 20 }]);
  assert.deepEqual(doseTimes([10, 0, 12], basal).map((x) => x.when), ['breakfast', 'night']);
  assert.deepEqual(doseTimes([16, 16, 12, 4], { type: 'pen', insulinKind: 'rapid' }).map((x) => x.when), ['breakfast', 'lunch', 'dinner']);
});
