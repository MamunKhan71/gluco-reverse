// Pure dose and alert rules. No DOM, no storage — everything here is unit-tested.
// The app never invents a dose: it only applies the doctor's plan (base, min, max,
// correction scale, meal rules) and refuses to go outside the allowed range.

export const LIMITS = {
  HYPO: 3.9,       // below this = low, treat before anything else
  SEVERE: 3.0,     // below this = call doctor today
  HIGH: 16.7,      // above this = high check
  VERY_HIGH: 20,   // above this with symptoms = hospital
  METER_MIN: 1.1,  // glucometers show "LO" below this
  METER_MAX: 33.3, // glucometers show "HI" above this
};

export const DAY = 24 * 60 * 60 * 1000;

const LEVEL_ORDER = { red: 0, orange: 1, yellow: 2, info: 3 };

export function clamp(v, lo, hi) {
  return Math.min(hi, Math.max(lo, v));
}

export function dayKey(ts) {
  const d = new Date(ts);
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${d.getFullYear()}-${m}-${day}`;
}

const mean = (xs) => xs.reduce((s, x) => s + x, 0) / xs.length;
const byTs = (a, b) => a.ts - b.ts;

// --- Reading entry checks -------------------------------------------------

// Returns { ok, value, problem } where problem is one of:
// 'empty' | 'mgdl' (looks like mg/dL; value holds the mmol/L conversion) |
// 'out_of_range' | 'big_jump' (needs "are you sure?")
export function checkReading(raw, lastReading, now = Date.now()) {
  const value = Number(String(raw).replace(',', '.'));
  if (raw === '' || raw == null || Number.isNaN(value)) return { ok: false, problem: 'empty' };
  if (value >= 40 && value <= 600) {
    return { ok: false, problem: 'mgdl', value: Math.round((value / 18) * 10) / 10 };
  }
  if (value < 1 || value > 34) return { ok: false, problem: 'out_of_range', value };
  if (lastReading && now - lastReading.ts < 6 * 60 * 60 * 1000 && Math.abs(value - lastReading.value) >= 12) {
    return { ok: false, problem: 'big_jump', value, last: lastReading.value };
  }
  return { ok: true, value };
}

export function classify(value, range) {
  if (value < LIMITS.SEVERE) return 'severe_low';
  if (value < LIMITS.HYPO) return 'low';
  if (value > LIMITS.HIGH) return 'very_high';
  if (range && value > range[1]) return 'high';
  if (range && value < range[0]) return 'below_target';
  return 'in_range';
}

// --- Meal-time insulin (Actrapid) ----------------------------------------

export function correctionFor(scale, reading) {
  for (const row of scale) if (reading >= row.from && reading < row.to) return row.delta;
  return 0;
}

// mealSize: 'normal' | 'small' | 'none'
// Returns one of:
//   { action: 'hypo' }                       treat the low first
//   { action: 'skip', reasons }              no meal → no meal insulin
//   { action: 'inject', units, base, delta, wanted, limitHit, reasons }
export function suggestBolus(plan, slotId, reading, mealSize) {
  const dose = plan.doses.find((d) => d.id === slotId);
  if (!dose || dose.kind !== 'bolus') throw new Error(`not a meal dose: ${slotId}`);
  if (reading != null && reading < LIMITS.HYPO) return { action: 'hypo', dose };
  if (mealSize === 'none' && plan.mealRules.none === 'skip') {
    return { action: 'skip', dose, reasons: [{ code: 'no_meal' }] };
  }

  const reasons = [];
  let delta = 0;
  if (reading == null) {
    reasons.push({ code: 'no_reading' });
  } else {
    const c = correctionFor(plan.correctionScale, reading);
    if (c) reasons.push({ code: c > 0 ? 'corr_up' : 'corr_down', delta: c, reading });
    delta += c;
  }
  if (mealSize === 'small' && plan.mealRules.small) {
    reasons.push({ code: 'small_meal', delta: plan.mealRules.small });
    delta += plan.mealRules.small;
  }

  const wanted = dose.base + delta;
  const units = clamp(wanted, dose.min, dose.max);
  return {
    action: 'inject',
    dose,
    units,
    base: dose.base,
    delta: units - dose.base,
    wanted,
    limitHit: units !== wanted,
    reasons,
  };
}

// --- Night insulin (Lantus) ----------------------------------------------

// Slow, pattern-based adjustment of the night dose. Tonight's bedtime reading
// never decides tonight's dose; the fasting readings that follow it do.
// basal: { current, lastChange } from saved state (may be undefined).
export function basalProposal(plan, basal, log, now = Date.now()) {
  const dose = plan.doses.find((d) => d.kind === 'basal');
  if (!dose) return { dose: null, current: 0, proposed: 0, wanted: 0, change: 0, limitHit: false, reason: 'none', avg: null };
  const rule = plan.basalRule;
  const current = basal?.current ?? dose.base;
  const since = basal?.lastChange ?? 0;
  const windowStart = Math.max(since, now - rule.everyDays * DAY);
  const readings = log
    .filter((e) => e.type === 'reading' && e.ts > windowStart && e.ts <= now)
    .sort(byTs);

  let wanted = current;
  let reason = 'not_due';
  let avg = null;

  if (readings.some((r) => r.value < LIMITS.HYPO)) {
    // Any low since the last change: come down now, don't wait for the 3 days.
    wanted = current - rule.step;
    reason = 'low';
  } else {
    const due = !since || now - since >= rule.everyDays * DAY;
    const fasting = readings.filter((r) => r.context === 'fasting');
    if (due && fasting.length >= rule.minReadings) {
      avg = Math.round(mean(fasting.slice(-rule.minReadings).map((r) => r.value)) * 10) / 10;
      if (avg > plan.targets.fasting[1]) {
        // A high morning can be a rebound from a night low: require a 3 am check first.
        const has3am = readings.some((r) => r.context === 'night_3am');
        if (has3am) {
          wanted = current + rule.step;
          reason = 'fasting_high';
        } else {
          reason = 'need_3am';
        }
      } else if (avg < plan.targets.fasting[0]) {
        wanted = current - rule.step;
        reason = 'fasting_low';
      } else {
        reason = 'in_target';
      }
    } else if (due) {
      reason = 'need_readings';
    }
  }

  const proposed = clamp(wanted, dose.min, dose.max);
  return {
    dose,
    current,
    proposed,
    wanted,
    change: proposed - current,
    limitHit: proposed !== wanted,
    reason,
    avg,
  };
}

// --- Alerts / escalation --------------------------------------------------

// Levels: red = hospital now, orange = call doctor today,
// yellow = book a doctor visit, info = nice to know.
// Each alert has a stable `key` so it is shown/sent once and can be marked handled.
export function evaluateAlerts(plan, log, state = {}, now = Date.now()) {
  const out = [];
  const add = (level, code, key, params = {}) => out.push({ level, code, key, params });
  const weekAgo = now - 7 * DAY;
  const dayAgo = now - DAY;
  const recent = log.filter((e) => e.ts >= weekAgo && e.ts <= now).sort(byTs);
  const readings = recent.filter((e) => e.type === 'reading');

  // Red: emergencies logged in the last 24 hours.
  for (const e of recent) {
    if (e.ts < dayAgo) continue;
    if (e.type === 'hypo' && (e.outcome === 'severe' || e.outcome === 'not_recovering')) {
      add('red', `hypo_${e.outcome}`, `red:${e.id}`, { ts: e.ts });
    }
    // Feeling very unwell with high-sugar signs but no strip to test: treat as an emergency too.
    if (e.type === 'high_signs' && e.symptoms?.length) add('red', 'high_symptoms', `red:${e.id}`, { value: null, ts: e.ts });
    if (e.type === 'reading' && e.value > LIMITS.HIGH && e.symptoms?.length) {
      add('red', 'high_symptoms', `red:${e.id}`, { value: e.value, ts: e.ts });
    }
  }

  // Orange: lows and repeated highs.
  const lows = readings.filter((r) => r.value < LIMITS.HYPO);
  for (const r of lows) {
    if (r.value < LIMITS.SEVERE) add('orange', 'severe_low', `severe_low:${r.id}`, { value: r.value, ts: r.ts });
    const h = new Date(r.ts).getHours();
    if (h >= 22 || h < 6) add('orange', 'night_low', `night_low:${r.id}`, { value: r.value, ts: r.ts });
  }
  if (lows.length >= 2) {
    add('orange', 'lows_week', `lows_week:${lows[lows.length - 1].id}`, { count: lows.length });
  }
  for (let i = 1; i < readings.length; i++) {
    if (readings[i].value > LIMITS.HIGH && readings[i - 1].value > LIMITS.HIGH) {
      add('orange', 'high_twice', `high_twice:${readings[i].id}`, {
        a: readings[i - 1].value,
        b: readings[i].value,
        ts: readings[i].ts,
      });
    }
  }

  // Yellow: the doctor's plan needs a review.
  const doses = recent.filter((e) => e.type === 'dose' && e.kind === 'bolus');
  for (const d of doses) {
    if (d.limitHit) add('yellow', 'beyond_range', `beyond_range:${d.id}`, { slot: d.slot, wanted: d.wanted, units: d.units });
  }
  for (const slot of new Set(doses.map((d) => d.slot))) {
    for (const dir of [1, -1]) {
      const days = new Set(doses.filter((d) => d.slot === slot && Math.sign(d.delta) === dir).map((d) => dayKey(d.ts)));
      if (days.size >= 3) {
        add('yellow', 'repeat_adjust', `repeat_adjust:${slot}:${dir}:${[...days].sort().pop()}`, {
          slot,
          dir,
          days: days.size,
        });
      }
    }
  }
  if (state.basal?.limitHitAt) {
    add('yellow', 'basal_limit', `basal_limit:${state.basal.limitHitAt}`, { units: state.basal.current });
  }
  const weights = log.filter((e) => e.type === 'weight').sort(byTs);
  const latestW = weights[weights.length - 1];
  if (latestW && latestW.kg <= plan.diet.lastReviewedWeight - 3) {
    add('yellow', 'weight_down', `weight_down:${plan.diet.lastReviewedWeight}`, {
      kg: latestW.kg,
      from: plan.diet.lastReviewedWeight,
    });
  }
  if (!plan.scaleConfirmed) add('info', 'scale_unconfirmed', 'scale_unconfirmed');

  const acked = new Set(state.acked ?? []);
  const seen = new Set();
  return out
    .filter((a) => !acked.has(a.key) && !seen.has(a.key) && seen.add(a.key))
    .sort((a, b) => LEVEL_ORDER[a.level] - LEVEL_ORDER[b.level]);
}

// --- Body -----------------------------------------------------------------

export const ftInToCm = (ft, inch) => Math.round((ft * 12 + inch) * 2.54 * 10) / 10;
export function cmToFtIn(cm) {
  const total = Math.round(cm / 2.54);
  return { ft: Math.floor(total / 12), inch: total % 12 };
}

// Asian BMI cut-offs (used in Bangladesh): 23+ overweight, 27.5+ obese.
export function bmiInfo(kg, cm) {
  const m2 = (cm / 100) ** 2;
  const bmi = Math.round((kg / m2) * 10) / 10;
  const cat = bmi < 18.5 ? 'under' : bmi < 23 ? 'normal' : bmi < 27.5 ? 'over' : 'obese';
  return {
    bmi,
    cat,
    healthy: [Math.round(18.5 * m2), Math.round(22.9 * m2)],
    firstGoal: Math.round(kg * 0.95 * 10) / 10, // lose 5% first
  };
}

// --- Food portions that follow her sugar ------------------------------------

const atTime = (ts, hhmm) => {
  const d = new Date(ts);
  const [h, m] = hhmm.split(':').map(Number);
  d.setHours(h, m, 0, 0);
  return d.getTime();
};

// Readings 1½–3 h after a meal count as "after meal"; any low within 5 h counts against it.
// Meal times when that meal has no insulin dose (e.g. long-acting insulin only, or tablets).
const MEAL_TIMES = { breakfast: '08:00', lunch: '13:30', dinner: '20:30' };
export function mealSugarStats(plan, log, slot, from, now = Date.now()) {
  const mealAt = plan.doses.find((d) => d.id === slot)?.mealAt ?? MEAL_TIMES[slot];
  const post = [];
  let lows = 0;
  if (!mealAt) return { n: 0, avg: null, lows: 0 };
  for (const r of log) {
    if (r.type !== 'reading' || r.ts < from || r.ts > now) continue;
    const mins = (r.ts - atTime(r.ts, mealAt)) / 60000;
    if (mins >= 90 && mins <= 180) post.push(r.value);
    if (mins >= 60 && mins <= 300 && r.value < LIMITS.HYPO) lows++;
  }
  return { n: post.length, avg: post.length ? Math.round(mean(post) * 10) / 10 : null, lows };
}

// Each meal's carb portion moves in half-cup steps (0 = the planned portion, at most
// 2 steps down), no more than once every 3 days. High after a meal → less carb;
// any low after it → back toward the planned portion (and the alerts flag the insulin).
export function adaptCarbs(plan, log, carbs = {}, now = Date.now()) {
  const out = { ...carbs };
  const changes = [];
  const stats = {};
  for (const slot of ['breakfast', 'lunch', 'dinner']) {
    const cur = carbs[slot] ?? { step: 0, at: 0 };
    const s = mealSugarStats(plan, log, slot, Math.max(cur.at, now - 5 * DAY), now);
    stats[slot] = s;
    if (now - cur.at < 3 * DAY) continue;
    let step = cur.step;
    let reason = null;
    if (s.lows && step < 0) {
      step += 1;
      reason = 'low';
    } else if (!s.lows && s.n >= 2 && s.avg > plan.diet.postMealMax && step > -2) {
      step -= 1;
      reason = 'high';
    }
    if (reason) {
      out[slot] = { step, at: now };
      changes.push({ slot, from: cur.step, to: step, reason, avg: s.avg });
    }
  }
  return { carbs: out, changes, stats };
}

// --- Supplies ---------------------------------------------------------------

// Insulin packs: a 3 ml pen (U-100, plus a 2-unit safety shot each time) or a 10 ml vial.
// Both should be thrown away 28 days after opening.
export const SUPPLY = {
  pen: { size: 300, inUseDays: 28, priming: 2 },
  vial: { size: 1000, inUseDays: 28 },
};

const isInsulinMed = (m) => m.type === 'pen' || m.type === 'vial';
const sameInsulin = (e, med) => e.medId === med.id || String(e.insulin ?? '').toLowerCase() === String(med.name ?? '').toLowerCase();
const perDayOf = (med) => (med.times ?? []).reduce((a, x) => a + (x.amount > 0 ? x.amount : 0), 0);

// What is left of each medicine on the list, and of the equipment.
// stock: { [medId]: {openedAt, spare} for insulin, {count, at} for the rest;
//          strips / lancets / needles / syringes: {count, at} }
export function stockStatus(stock = {}, log, meds = [], now = Date.now()) {
  const items = [];
  const weekAgo = now - 7 * DAY;
  const doses = log.filter((e) => e.type === 'dose' && e.action !== 'skip');
  for (const med of meds) {
    const s = stock[med.id];
    if (isInsulinMed(med)) {
      if (!s?.openedAt) continue;
      const pack = SUPPLY[med.type];
      const mine = doses.filter((e) => sameInsulin(e, med));
      const per = (d) => d.units + (pack.priming ?? 0);
      const used = mine.filter((d) => d.ts >= s.openedAt).reduce((a, d) => a + per(d), 0);
      const weekUse = mine.filter((d) => d.ts >= weekAgo).reduce((a, d) => a + per(d), 0);
      const daily = weekUse / 7 || perDayOf(med) || 1;
      const left = Math.max(0, pack.size - used);
      const openDays = Math.floor((now - s.openedAt) / DAY);
      const daysLeft = Math.floor(Math.min(left / daily, pack.inUseDays - openDays));
      const totalDays = Math.floor(daysLeft + ((s.spare ?? 0) * pack.size) / daily);
      const warn = daysLeft <= 3 ? 'replace' : totalDays <= 7 ? 'buy' : null;
      items.push({ id: med.id, name: med.name, kind: 'insulin', left: Math.round(left), openDays, daysLeft: Math.max(0, daysLeft), totalDays, spare: s.spare ?? 0, warn });
    } else {
      if (s?.count == null) continue;
      const perDay = perDayOf(med);
      const left = Math.max(0, s.count - perDay * Math.floor((now - s.at) / DAY));
      const daysLeft = perDay ? Math.floor(left / perDay) : null;
      items.push({ id: med.id, name: med.name, kind: 'count', left: Math.floor(left * 2) / 2, perDay, daysLeft, warn: daysLeft != null && daysLeft <= 5 ? 'buy' : null });
    }
  }
  const usesVial = (e) => meds.some((m) => m.type === 'vial' && sameInsulin(e, m));
  const counted = {
    strips: (e) => e.type === 'reading',
    lancets: (e) => e.type === 'reading',
    needles: (e) => e.type === 'dose' && e.action !== 'skip' && !usesVial(e),
    syringes: (e) => e.type === 'dose' && e.action !== 'skip' && usesVial(e),
  };
  const lowAt = { strips: 10, lancets: 5, needles: 7, syringes: 7 };
  for (const [id, used] of Object.entries(counted)) {
    const s = stock[id];
    if (s?.count == null) continue;
    const left = Math.max(0, s.count - log.filter((e) => e.ts >= s.at && used(e)).length);
    items.push({ id, kind: 'equip', left, warn: left <= lowAt[id] ? 'buy' : null });
  }
  return items;
}

// --- Injection sites ------------------------------------------------------------

// Meal insulin in the belly (absorbs evenly), night insulin in the thighs.
export const SITES = {
  actrapid: ['abd_ul', 'abd_ur', 'abd_lr', 'abd_ll'],
  lantus: ['thigh_l', 'thigh_r'],
};

// The site used longest ago (never-used sites first, in order).
export function nextSite(log, insulin, kind = 'bolus') {
  const key = String(insulin ?? '').toLowerCase();
  const sites = SITES[key] ?? (kind === 'basal' ? SITES.lantus : SITES.actrapid);
  const last = {};
  for (const e of log) if (e.type === 'dose' && String(e.insulin ?? '').toLowerCase() === key && e.site) last[e.site] = Math.max(last[e.site] ?? 0, e.ts);
  return sites.reduce((best, s) => ((last[s] ?? -1) < (last[best] ?? -1) ? s : best), sites[0]);
}

// --- Food -----------------------------------------------------------------

export { mealTotals } from './foods.js';
