// Regression tests for the production review fixes.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { adaptCarbs, evaluateAlerts } from '../www/src/engine.js';
import { DEFAULT_PLAN } from '../www/src/plan.js';
import { doseTimes } from '../www/src/meds.js';
import { reportData } from '../www/src/report.js';

const plan = () => structuredClone(DEFAULT_PLAN);

test('menu portions work with no meal insulin (long-acting only or tablets)', () => {
  const p = plan(); // a new patient has no doses at all
  const log = [{ id: 'r1', type: 'reading', value: 9, context: 'other', ts: Date.now() - 3600e3 }];
  assert.doesNotThrow(() => adaptCarbs(p, log));
});

test('tablets written 1+1 mean morning and night', () => {
  assert.deepEqual(doseTimes([1, 1], { type: 'tablet' }).map((x) => x.when), ['morning', 'night']);
  assert.deepEqual(doseTimes([1, 1, 1], { type: 'tablet' }).map((x) => x.when), ['morning', 'noon', 'night']);
});

test('high-sugar signs without a reading still raise a red alert for the family', () => {
  const log = [{ id: 'h1', type: 'high_signs', symptoms: ['vomit'], ts: Date.now() - 60e3 }];
  const alerts = evaluateAlerts(plan(), log);
  assert.ok(alerts.some((a) => a.level === 'red' && a.code === 'high_symptoms'));
});

test('report: other family members are left out, coverage uses tracked days', () => {
  const now = Date.now();
  const log = [
    { id: 'a', type: 'reading', value: 7, context: 'fasting', ts: now - 2 * 864e5 },
    { id: 'b', type: 'reading', value: 15, context: 'fasting', ts: now - 864e5, person: 'p1' },
    { id: 'c', type: 'reading', value: 6, context: 'fasting', ts: now - 3600e3 },
  ];
  const r = reportData(plan(), log, { from: now - 90 * 864e5, to: now });
  assert.equal(r.readings.length, 2);
  assert.ok(r.stats.daysWithData > 50, `coverage ${r.stats.daysWithData}% should not be diluted by 90 untracked days`);
});
