// Full report for the doctor: a printable A4 document (Save as PDF from the print screen) and
// an Excel workbook of the whole history. Pure functions: give them the plan, the log and a
// period; English throughout, since it is read by the doctor.

import { LIMITS, DAY, dayKey, classify, bmiInfo, cmToFtIn } from './engine.js';
import { tIn } from './i18n.js';
import { generalTimes } from './meds.js';
import { REPORT_FONT_CSS } from './reportfont.js';

const T = (k, ...a) => tIn('en', k, ...a);
const SLOTS = ['breakfast', 'lunch', 'dinner', 'night'];
const MAIN_CTX = ['fasting', 'pre_lunch', 'pre_dinner', 'bedtime'];
const TIR = [3.9, 10]; // time in range, mmol/L

const rangeFor = (plan, ctx) =>
  ({ fasting: plan.targets.fasting, pre_lunch: plan.targets.preMeal, pre_dinner: plan.targets.preMeal, bedtime: plan.targets.bedtime })[ctx] ?? plan.targets.postMeal;
const round1 = (n) => Math.round(n * 10) / 10;
const avg = (a) => (a.length ? round1(a.reduce((x, y) => x + y, 0) / a.length) : null);
const pct = (n, d) => (d ? Math.round((n / d) * 100) : null);
// Bangladesh time, 12-hour clock (7:30 AM), whatever the phone's settings.
const TZ = 'Asia/Dhaka';
const hm = (ts) => new Date(ts).toLocaleTimeString('en-US', { timeZone: TZ, hour: 'numeric', minute: '2-digit', hour12: true });
const dateLong = (ts) => new Date(ts).toLocaleDateString('en-GB', { timeZone: TZ, day: 'numeric', month: 'short', year: 'numeric' });
const dateShort = (ts) => new Date(ts).toLocaleDateString('en-GB', { timeZone: TZ, weekday: 'short', day: 'numeric', month: 'short' });
const at12 = (hhmm) => {
  const [h, m] = String(hhmm ?? '').split(':').map(Number);
  if (!Number.isFinite(h)) return hhmm ?? '';
  return `${h % 12 || 12}:${String(m || 0).padStart(2, '0')} ${h < 12 ? 'AM' : 'PM'}`;
};
const dateNum = (ts) => new Date(ts).toLocaleDateString('en-GB', { timeZone: TZ });
// minutes since midnight in Dhaka (for the "standard day" chart)
const minuteOfDay = (ts) => {
  const [h, m] = new Date(ts).toLocaleTimeString('en-GB', { timeZone: TZ, hour: '2-digit', minute: '2-digit', hour12: false }).split(':').map(Number);
  return (h % 24) * 60 + m;
};
const sdOf = (a) => {
  if (a.length < 2) return null;
  const m = a.reduce((x, y) => x + y, 0) / a.length;
  return Math.sqrt(a.reduce((x, y) => x + (y - m) ** 2, 0) / (a.length - 1));
};
const quantile = (sorted, q) => {
  const i = (sorted.length - 1) * q;
  const lo = Math.floor(i);
  return sorted[lo] + (sorted[Math.min(lo + 1, sorted.length - 1)] - sorted[lo]) * (i - lo);
};
// International consensus ranges (mmol/L) with their usual colours and goals.
export const BANDS = [
  { key: 'vhigh', label: 'Very high', range: '>13.9', test: (v) => v > 13.9, color: '#e8781e', goal: '<5%' },
  { key: 'high', label: 'High', range: '10.1–13.9', test: (v) => v > 10 && v <= 13.9, color: '#f5c242', goal: '<25% (with very high)' },
  { key: 'target', label: 'Target', range: '3.9–10.0', test: (v) => v >= 3.9 && v <= 10, color: '#2fa36b', goal: '>70%' },
  { key: 'low', label: 'Low', range: '3.0–3.8', test: (v) => v >= 3 && v < 3.9, color: '#e0473d', goal: '<4% (with very low)' },
  { key: 'vlow', label: 'Very low', range: '<3.0', test: (v) => v < 3, color: '#8e1b17', goal: '<1%' },
];
const esc = (s) => String(s ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]);

// Everything the report shows, for log entries between from and to.
export function reportData(plan, log, { from, to = Date.now() } = {}) {
  const all = log.filter((e) => !e.deleted && !e.other && !e.person); // other family members' readings are left out
  const start = from ?? Math.min(to, ...all.map((e) => e.ts));
  const inRange = all.filter((e) => e.ts >= start && e.ts <= to).sort((a, b) => a.ts - b.ts);
  const readings = inRange.filter((e) => e.type === 'reading' && Number.isFinite(e.value));
  const doses = inRange.filter((e) => e.type === 'dose');
  const tablets = inRange.filter((e) => e.type === 'tablet');
  const meals = inRange.filter((e) => e.type === 'meal');
  const weights = all.filter((e) => e.type === 'weight').sort((a, b) => a.ts - b.ts);
  const values = readings.map((r) => r.value);

  // days in the period (for adherence and the daily table)
  const days = [];
  for (let d = new Date(start); d.getTime() <= to; d.setDate(d.getDate() + 1)) {
    d.setHours(0, 0, 0, 0);
    days.push(dayKey(d.getTime()));
  }
  const uniqueDays = [...new Set(days)];

  const byCtx = Object.fromEntries(
    [...MAIN_CTX, 'post_meal', 'other', 'night_3am'].map((c) => {
      const v = readings.filter((r) => r.context === c).map((r) => r.value);
      return [c, { n: v.length, avg: avg(v), min: v.length ? Math.min(...v) : null, max: v.length ? Math.max(...v) : null }];
    }),
  );
  const inTarget = readings.filter((r) => classify(r.value, rangeFor(plan, r.context)) === 'in_range').length;

  // insulin adherence per planned dose, over days that had already started being tracked
  const firstDay = all.length ? dayKey(Math.min(...all.map((e) => e.ts))) : dayKey(start);
  const trackedDays = uniqueDays.filter((k) => k >= firstDay && k <= dayKey(to));
  const adherence = plan.doses.map((d) => {
    const mine = doses.filter((x) => x.slot === d.id);
    const taken = mine.filter((x) => x.action !== 'skip');
    const skipped = mine.filter((x) => x.action === 'skip');
    const dayTaken = new Set(taken.map((x) => dayKey(x.ts)));
    const daySkipped = new Set(skipped.map((x) => dayKey(x.ts)));
    // counted only from the first day this dose was logged (a dose added last week isn't 'missed' for 3 months)
    const doseStart = mine.length ? dayKey(Math.min(...mine.map((x) => x.ts))) : dayKey(to);
    const missed = trackedDays.filter((k) => k >= doseStart && !dayTaken.has(k) && !daySkipped.has(k) && k < dayKey(to)).length;
    return {
      slot: d.id,
      name: d.name ?? d.insulin,
      planned: d.base,
      range: [d.min, d.max],
      taken: dayTaken.size,
      skipped: daySkipped.size,
      missed,
      avgUnits: avg(taken.map((x) => x.units)),
      outside: taken.filter((x) => x.units < d.min || x.units > d.max).length,
    };
  });

  const events = [];
  for (const r of readings) {
    if (r.value < LIMITS.SEVERE) events.push({ ts: r.ts, kind: 'Severe low', text: `${r.value} mmol/L (${T(`ctx_${r.context}`)})`, level: 3 });
    else if (r.value < LIMITS.HYPO) events.push({ ts: r.ts, kind: 'Low', text: `${r.value} mmol/L (${T(`ctx_${r.context}`)})`, level: 2 });
    else if (r.value > LIMITS.VERY_HIGH) events.push({ ts: r.ts, kind: 'Very high', text: `${r.value} mmol/L (${T(`ctx_${r.context}`)})`, level: 2 });
  }
  for (const d of doses) if (d.outside) events.push({ ts: d.ts, kind: 'Dose outside range', text: `${T(`slot_${d.slot}`)}: ${d.units} units (planned ${d.base})`, level: 1 });
  for (const e of inRange.filter((x) => x.type === 'hypo')) events.push({ ts: e.ts, kind: 'Hypo treated', text: e.value ? `${e.value} mmol/L` : 'Low sugar treatment', level: 2 });
  events.sort((a, b) => b.level - a.level || b.ts - a.ts); // lows and very highs first

  const daily = uniqueDays
    .slice()
    .reverse()
    .map((k) => {
      const dl = inRange.filter((e) => dayKey(e.ts) === k);
      if (!dl.length) return null;
      const rd = (c) => dl.filter((e) => e.type === 'reading' && e.context === c).map((e) => e.value);
      const ins = {};
      for (const s of SLOTS) {
        const x = dl.filter((e) => e.type === 'dose' && e.slot === s).at(-1);
        ins[s] = x ? (x.action === 'skip' ? 'skipped' : `${x.units} u · ${hm(x.ts)}`) : '';
      }
      return {
        key: k,
        ts: dl[0].ts,
        values: dl.filter((e) => e.type === 'reading').map((e) => e.value),
        fasting: rd('fasting'),
        pre_lunch: rd('pre_lunch'),
        pre_dinner: rd('pre_dinner'),
        bedtime: rd('bedtime'),
        other: dl.filter((e) => e.type === 'reading' && !MAIN_CTX.includes(e.context)).map((e) => `${e.value} (${hm(e.ts)})`),
        ins,
        tablets: dl.filter((e) => e.type === 'tablet').map((e) => String(e.name || 'tablet').replace(/\s+\d.*$/, '')),
        kcal: dl.filter((e) => e.type === 'meal').reduce((a, m) => a + (m.kcal || 0), 0),
      };
    })
    .filter(Boolean);

  const w0 = weights.find((w) => w.ts >= start) ?? weights[0];
  const w1 = weights.at(-1);
  return {
    plan,
    from: start,
    to,
    daysCount: Math.max(1, Math.round((to - start) / DAY)),
    readings,
    doses,
    tablets,
    meals,
    weights,
    stats: {
      n: values.length,
      avg: avg(values),
      min: values.length ? Math.min(...values) : null,
      max: values.length ? Math.max(...values) : null,
      perDay: round1(values.length / Math.max(1, trackedDays.length || 1)),
      inTarget: pct(inTarget, values.length),
      tir: pct(values.filter((v) => v >= TIR[0] && v <= TIR[1]).length, values.length),
      below: pct(values.filter((v) => v < TIR[0]).length, values.length),
      above: pct(values.filter((v) => v > TIR[1]).length, values.length),
      lows: values.filter((v) => v < LIMITS.HYPO).length,
      severe: values.filter((v) => v < LIMITS.SEVERE).length,
      veryHigh: values.filter((v) => v > LIMITS.HIGH).length,
      // estimated HbA1c from the average (ADAG formula), only with enough readings
      eA1c: values.length >= 20 ? round1((avg(values) * 18.0156 + 46.7) / 28.7) : null,
      sd: values.length > 1 ? round1(sdOf(values)) : null,
      cv: values.length > 1 ? Math.round((sdOf(values) / (values.reduce((a, b) => a + b, 0) / values.length)) * 100) : null,
      daysWithData: pct(new Set(readings.map((r) => dayKey(r.ts))).size, Math.max(1, trackedDays.length || uniqueDays.length)),
      bands: Object.fromEntries(BANDS.map((b) => [b.key, values.length ? Math.round((values.filter(b.test).length / values.length) * 1000) / 10 : 0])),
      kcalAvg: meals.length ? Math.round(meals.reduce((a, m) => a + (m.kcal || 0), 0) / new Set(meals.map((m) => dayKey(m.ts))).size) : null,
    },
    byCtx,
    adherence,
    events,
    daily,
    weight: w1 ? { start: w0?.kg, now: w1.kg, at: w1.ts } : null,
  };
}

// --- charts (inline SVG, print sharply) --------------------------------------------------------

// Time in Ranges: one stacked bar in the consensus colours, with % and goals beside it.
function tirSvg(D) {
  const b = D.stats.bands;
  const W = 330;
  const H = 230;
  const bar = { x: 18, y: 14, w: 46, h: 200 };
  let y = bar.y;
  const rects = [];
  const labels = [];
  BANDS.forEach((band, i) => {
    const p = b[band.key];
    const h = (p / 100) * bar.h;
    if (h > 0) rects.push(`<rect x="${bar.x}" y="${y.toFixed(1)}" width="${bar.w}" height="${Math.max(h, 0.8).toFixed(1)}" fill="${band.color}"/>`);
    const ly = bar.y + 18 + i * 42;
    labels.push(`<g transform="translate(${bar.x + bar.w + 18},${ly})">
      <rect x="0" y="-11" width="12" height="12" rx="3" fill="${band.color}"/>
      <text x="20" y="0" font-size="12" font-weight="700" fill="#1f2041">${p}%</text>
      <text x="70" y="0" font-size="11.5" fill="#1f2041">${band.label} <tspan fill="#777">${band.range}</tspan></text>
      <text x="20" y="15" font-size="10" fill="#888">Goal ${band.goal}</text></g>`);
    y += h;
  });
  return `<svg viewBox="0 0 ${W} ${H}" width="100%" role="img" aria-label="Time in ranges">${rects.join('')}<rect x="${bar.x}" y="${bar.y}" width="${bar.w}" height="${bar.h}" fill="none" stroke="#ccc"/>${labels.join('')}</svg>`;
}

// Shared axes: target band 3.9–10 with dashed limits, glucose scale on the left.
function frame(W, H, pad, ymax, xTicks) {
  const y = (v) => pad.t + (1 - v / ymax) * (H - pad.t - pad.b);
  const gl = [0, 5, 10, 15, 20, 25, 30].filter((v) => v <= ymax);
  const grid = gl.map((v) => `<line x1="${pad.l}" x2="${W - pad.r}" y1="${y(v)}" y2="${y(v)}" stroke="#ececf3"/><text x="${pad.l - 6}" y="${y(v) + 3.5}" text-anchor="end" font-size="10" fill="#666">${v}</text>`).join('');
  const band = `<rect x="${pad.l}" y="${y(10)}" width="${W - pad.l - pad.r}" height="${y(3.9) - y(10)}" fill="#2fa36b" opacity="0.09"/>
    <line x1="${pad.l}" x2="${W - pad.r}" y1="${y(10)}" y2="${y(10)}" stroke="#2fa36b" stroke-dasharray="4 3"/>
    <line x1="${pad.l}" x2="${W - pad.r}" y1="${y(3.9)}" y2="${y(3.9)}" stroke="#e0473d" stroke-dasharray="4 3"/>
    <text x="${pad.l + 4}" y="${y(10) - 3}" font-size="9.5" fill="#2fa36b">10.0</text>
    <text x="${pad.l + 4}" y="${y(3.9) + 11}" font-size="9.5" fill="#e0473d">3.9</text>`;
  const axisTitle = `<text x="12" y="${(H - pad.b + pad.t) / 2}" transform="rotate(-90 12 ${(H - pad.b + pad.t) / 2})" text-anchor="middle" font-size="10" fill="#666">Glucose (mmol/L)</text>`;
  return { y, svg: grid + band + axisTitle + xTicks };
}

const bandColor = (v) => BANDS.find((b) => b.test(v))?.color ?? '#999';

// Standard day: every reading placed on one 24-hour day, with the median and the middle 50%
// per 2-hour block (when there are enough readings), as in the Ambulatory Glucose Profile.
function modalDaySvg(D) {
  const rs = D.readings;
  if (!rs.length) return '';
  const W = 720;
  const H = 260;
  const pad = { l: 46, r: 24, t: 12, b: 34 };
  const ymax = Math.max(20, Math.ceil(Math.max(...rs.map((r) => r.value)) / 5) * 5);
  const x = (min) => pad.l + (min / 1440) * (W - pad.l - pad.r);
  const ticks = [0, 3, 6, 9, 12, 15, 18, 21, 24]
    .map((h) => `<line x1="${x(h * 60)}" x2="${x(h * 60)}" y1="${pad.t}" y2="${H - pad.b}" stroke="#f1f1f6"/><text x="${x(h * 60)}" y="${H - pad.b + 14}" text-anchor="middle" font-size="10" fill="#666">${h % 12 || 12} ${h < 12 || h === 24 ? 'AM' : 'PM'}</text>`)
    .join('') + `<text x="${(W + pad.l) / 2}" y="${H - 4}" text-anchor="middle" font-size="10" fill="#666">Time of day (Bangladesh time)</text>`;
  const fr = frame(W, H, pad, ymax, ticks);
  const dots = rs.map((r) => `<circle cx="${x(minuteOfDay(r.ts)).toFixed(1)}" cy="${fr.y(r.value).toFixed(1)}" r="2.6" fill="${bandColor(r.value)}" opacity="0.75"/>`).join('');
  // 2-hour blocks with at least 3 readings
  const blocks = [];
  for (let b = 0; b < 12; b++) {
    const v = rs.filter((r) => Math.floor(minuteOfDay(r.ts) / 120) === b).map((r) => r.value).sort((a, c) => a - c);
    if (v.length >= 3) blocks.push({ m: b * 120 + 60, q1: quantile(v, 0.25), med: quantile(v, 0.5), q3: quantile(v, 0.75) });
  }
  let stats = '';
  if (blocks.length >= 2) {
    const up = blocks.map((p) => `${x(p.m).toFixed(1)},${fr.y(p.q3).toFixed(1)}`);
    const down = blocks.slice().reverse().map((p) => `${x(p.m).toFixed(1)},${fr.y(p.q1).toFixed(1)}`);
    stats = `<polygon points="${[...up, ...down].join(' ')}" fill="#5a6fd8" opacity="0.18"/>
      <polyline points="${blocks.map((p) => `${x(p.m).toFixed(1)},${fr.y(p.med).toFixed(1)}`).join(' ')}" fill="none" stroke="#3d4fb8" stroke-width="2.4"/>`;
  }
  return `<svg viewBox="0 0 ${W} ${H}" width="100%" role="img" aria-label="Glucose by time of day">${fr.svg}${stats}${dots}</svg>`;
}

// Daily trend: each day's average (dot) and lowest–highest reading (line).
function dailyTrendSvg(D) {
  const days = D.daily.slice().reverse().filter((d) => d.values.length);
  if (!days.length) return '';
  const W = 720;
  const H = 220;
  const pad = { l: 46, r: 12, t: 12, b: 34 };
  const ymax = Math.max(20, Math.ceil(Math.max(...days.flatMap((d) => d.values)) / 5) * 5);
  const n = days.length;
  const x = (i) => pad.l + ((i + 0.5) / n) * (W - pad.l - pad.r);
  const step = Math.max(1, Math.ceil(n / 10));
  const ticks = days
    .map((d, i) => (i % step === 0 ? `<text x="${x(i)}" y="${H - pad.b + 14}" text-anchor="middle" font-size="10" fill="#666">${new Date(d.ts).toLocaleDateString('en-GB', { timeZone: TZ, day: 'numeric', month: 'short' })}</text>` : ''))
    .join('') + `<text x="${(W + pad.l) / 2}" y="${H - 4}" text-anchor="middle" font-size="10" fill="#666">Date</text>`;
  const fr = frame(W, H, pad, ymax, ticks);
  const marks = days
    .map((d, i) => {
      const lo = Math.min(...d.values);
      const hi = Math.max(...d.values);
      const mean = d.values.reduce((a, b) => a + b, 0) / d.values.length;
      return `<line x1="${x(i)}" x2="${x(i)}" y1="${fr.y(hi)}" y2="${fr.y(lo)}" stroke="#9aa3d8" stroke-width="3" stroke-linecap="round"/><circle cx="${x(i)}" cy="${fr.y(mean)}" r="3.6" fill="${bandColor(mean)}" stroke="#fff" stroke-width="1"/>`;
    })
    .join('');
  return `<svg viewBox="0 0 ${W} ${H}" width="100%" role="img" aria-label="Daily glucose">${fr.svg}${marks}</svg>`;
}

// --- the printable document ------------------------------------------------------------------

export function reportHtml(D, { generatedAt = Date.now() } = {}) {
  const P = D.plan;
  const S = D.stats;
  const { ft, inch } = cmToFtIn(P.patient.heightCm ?? 0);
  const w = D.weight?.now ?? P.diet?.startWeight;
  const bmi = w && P.patient.heightCm ? bmiInfo(w, P.patient.heightCm) : null;
  const meds = (P.meds ?? [])
    .map((m) => {
      const isIns = m.type === 'pen' || m.type === 'vial';
      const times = (m.times ?? [])
        .filter((x) => x.amount > 0)
        .map((x) => `${isIns ? T(x.when === 'night' ? 'when_ins_night' : `when_${x.when}`) : T(`when_${x.when}`)}: <b>${x.amount}${isIns ? ' u' : ''}</b>${x.meal ? ` (${T(`meal_${x.meal}`)})` : ''}${x.at ? ` · ${at12(x.at)}` : ''}`)
        .join('<br>');
      return `<tr><td><b>${esc(m.name)}</b> ${esc(m.strength ?? '')}<div class="sub">${T(`type_${m.type}`)}${isIns && m.insulinKind ? ` · ${T(`kind_${m.insulinKind}`)}` : ''}${isIns ? ` · allowed ±${m.range ?? 2}` : ''}</div></td><td>${times || '-'}</td><td>${esc(m.note ?? '')}</td></tr>`;
    })
    .join('');
  const stat = (label, value, sub = '', tone = '') => `<div class="stat ${tone}"><div class="v">${value ?? '–'}</div><div class="l">${label}</div>${sub ? `<div class="s">${sub}</div>` : ''}</div>`;
  const ctxRows = [...MAIN_CTX, 'post_meal', 'other']
    .filter((c) => D.byCtx[c].n)
    .map((c) => {
      const s = D.byCtx[c];
      const tr = rangeFor(P, c);
      return `<tr><td>${T(`ctx_${c}`)}</td><td>${s.n}</td><td><b>${s.avg}</b></td><td>${s.min} – ${s.max}</td><td>${tr[0]} – ${tr[1]}</td></tr>`;
    })
    .join('');
  const adhRows = D.adherence
    .map((a) => `<tr><td>${T(`slot_${a.slot}`)}</td><td>${esc(a.name)}</td><td>${a.planned} u <span class="sub">(${a.range[0]}–${a.range[1]})</span></td><td>${a.taken}</td><td>${a.skipped}</td><td class="${a.missed ? 'bad' : ''}">${a.missed}</td><td>${a.avgUnits ?? '–'}</td><td class="${a.outside ? 'bad' : ''}">${a.outside}</td></tr>`)
    .join('');
  const cell = (vals, ctx) =>
    vals.length
      ? vals.map((v) => `<span class="${v < LIMITS.HYPO ? 'low' : classify(v, rangeFor(P, ctx)) === 'in_range' ? 'ok' : 'high'}">${v}</span>`).join(' ')
      : '';
  const dailyRows = D.daily
    .map(
      (d) => `<tr><td class="nowrap">${dateShort(d.ts)}</td><td>${cell(d.fasting, 'fasting')}</td><td>${cell(d.pre_lunch, 'pre_lunch')}</td><td>${cell(d.pre_dinner, 'pre_dinner')}</td><td>${cell(d.bedtime, 'bedtime')}</td><td class="small">${d.other.join(', ')}</td>${SLOTS.map((s) => `<td class="ins ${d.ins[s] === 'skipped' ? 'bad' : ''}">${d.ins[s]}</td>`).join('')}<td class="small">${esc(d.tablets.join(', '))}</td><td>${d.kcal || ''}</td></tr>`,
    )
    .join('');
  const evRows = D.events
    .slice(0, 60)
    .map((e) => `<tr><td class="nowrap">${dateShort(e.ts)} ${hm(e.ts)}</td><td class="${e.level >= 2 ? 'bad' : ''}"><b>${e.kind}</b></td><td>${esc(e.text)}</td></tr>`)
    .join('');

  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>Diabetes report · ${esc(P.patient.name)}</title>
<style>
  ${REPORT_FONT_CSS}
  @page { size: A4; margin: 13mm 11mm; }
  * { box-sizing: border-box; }
  body, svg text { font-family: "Space Grotesk", "Noto Sans Bengali", Arial, sans-serif; }
  body { font-family: "Space Grotesk", "Noto Sans Bengali", "Hind Siliguri", Roboto, Arial, sans-serif; color: #1f2041; font-size: 11.5px; line-height: 1.4; margin: 0; padding: 16px; background: #fff; }
  h1 { font-size: 22px; margin: 0; }
  h2 { font-size: 14px; margin: 18px 0 8px; padding-bottom: 4px; border-bottom: 2px solid #7472e8; color: #3d3aa8; break-after: avoid; }
  .head { display: flex; justify-content: space-between; gap: 16px; align-items: flex-start; border-bottom: 3px solid #7472e8; padding-bottom: 10px; }
  .kicker { color: #7472e8; font-weight: 700; letter-spacing: .08em; font-size: 10px; text-transform: uppercase; }
  .meta { text-align: right; color: #555; font-size: 11px; }
  .info { display: grid; grid-template-columns: repeat(4, 1fr); gap: 6px 14px; margin-top: 10px; }
  .info div { font-size: 11px; color: #555; } .info b { display: block; color: #1f2041; font-size: 12.5px; }
  .stats { display: grid; grid-template-columns: repeat(6, 1fr); gap: 8px; }
  .stat { border: 1px solid #e6e6ef; border-radius: 10px; padding: 8px; text-align: center; }
  .stat .v { font-size: 18px; font-weight: 700; } .stat .l { font-size: 10px; color: #666; } .stat .s { font-size: 9.5px; color: #888; }
  .stat.good .v { color: #1e8e5a; } .stat.warn .v { color: #c46a0b; } .stat.bad .v { color: #c0392b; }
  table { width: 100%; border-collapse: collapse; margin: 4px 0; }
  th, td { border: 1px solid #e3e3ee; padding: 4px 6px; text-align: left; vertical-align: top; }
  th { background: #f1f1fb; font-size: 10.5px; color: #3d3aa8; }
  tr { break-inside: avoid; }
  .sub { color: #777; font-size: 10px; } .small { font-size: 10px; } .nowrap { white-space: nowrap; }
  .ok { color: #1e8e5a; font-weight: 600; } .high { color: #c46a0b; font-weight: 600; } .low, .bad { color: #c0392b; font-weight: 600; }
  .legend { color: #666; font-size: 10px; margin-top: 2px; }
  .chart { border: 1px solid #e6e6ef; border-radius: 10px; padding: 8px 8px 4px; break-inside: avoid; }
  .chart-title { font-weight: 700; font-size: 12px; margin: 0 0 2px; } .chart-sub { color: #777; font-size: 10px; margin-bottom: 4px; }
  .agp { display: grid; grid-template-columns: 34% 1fr; gap: 10px; align-items: start; break-inside: avoid; }
  .glu { display: grid; grid-template-columns: 1fr 1fr; gap: 0; border: 1px solid #e6e6ef; border-radius: 10px; overflow: hidden; }
  .glu div { padding: 7px 10px; border-bottom: 1px solid #f0f0f6; font-size: 11px; color: #555; display: flex; justify-content: space-between; gap: 8px; }
  .glu div b { color: #1f2041; font-size: 12.5px; }
  .glu div:nth-child(odd) { border-right: 1px solid #f0f0f6; }
  .note { margin-top: 18px; font-size: 10px; color: #777; border-top: 1px solid #e6e6ef; padding-top: 6px; }
  .page-break { break-before: page; }
  .logbook td, .logbook th { font-size: 9.6px; padding: 3px 4px; }
  .logbook td.ins { white-space: nowrap; }
  @media screen { body { max-width: 860px; margin: 0 auto; } }
</style></head><body>
<div class="head">
  <div><div class="kicker">Diabetes report</div><h1>${esc(P.patient.name)}</h1>
    <div class="sub">${dateLong(D.from)} – ${dateLong(D.to)} (${D.daysCount} days)</div></div>
  <div class="meta">Generated ${dateLong(generatedAt)} ${hm(generatedAt)}<br>Sugar Helper app${P.doctor?.name ? `<br>For: Dr ${esc(P.doctor.name)}` : ''}</div>
</div>
<div class="info">
  <div>Age<b>${P.patient.age ?? '–'}</b></div>
  <div>Height<b>${P.patient.heightCm ? `${ft}′${inch}″ (${P.patient.heightCm} cm)` : '–'}</b></div>
  <div>Weight<b>${w ? `${w} kg` : '–'}${D.weight?.start && D.weight.start !== w ? ` <span class="sub">(was ${D.weight.start})</span>` : ''}</b></div>
  <div>BMI<b>${bmi ? `${bmi.bmi} (${{ under: 'underweight', normal: 'healthy', over: 'overweight', obese: 'obese' }[bmi.cat] ?? bmi.cat})` : '–'}</b></div>
  <div>Prescription<b>${P.patient.prescriptionDate ?? '–'}</b></div>
  <div>Patient phone<b>${esc(P.patient.phone ?? '–')}</b></div>
  <div>Targets before meals<b>${P.targets.preMeal[0]}–${P.targets.preMeal[1]} mmol/L</b></div>
  <div>After meals<b>≤ ${P.targets.postMeal[1]} mmol/L</b></div>
</div>

${D.readings.length ? `<h2>Glucose profile</h2>
<div class="agp">
  <div class="chart"><div class="chart-title">Time in ranges</div><div class="chart-sub">${S.n} readings · international consensus targets</div>${tirSvg(D)}</div>
  <div>
    <div class="glu">
      <div>Mean glucose<b>${S.avg ?? '–'} mmol/L</b></div>
      <div>Estimated HbA1c (eA1c)<b>${S.eA1c ? `${S.eA1c}%` : '–'}</b></div>
      <div>Glucose variability (CV)<b class="${S.cv > 36 ? 'bad' : ''}">${S.cv != null ? `${S.cv}%` : '–'}</b></div>
      <div>Standard deviation<b>${S.sd ?? '–'} mmol/L</b></div>
      <div>Lowest / highest<b>${S.n ? `${S.min} / ${S.max}` : '–'}</b></div>
      <div>Readings a day<b>${S.perDay}</b></div>
      <div>Days with readings<b>${S.daysWithData ?? '–'}%</b></div>
      <div>Hypos (&lt;3.9)<b class="${S.lows ? 'bad' : ''}">${S.lows} <span class="sub">(${S.severe} &lt;3.0)</span></b></div>
      <div>In personal target<b class="${S.inTarget >= 70 ? 'ok' : S.inTarget >= 50 ? 'high' : 'bad'}">${S.inTarget ?? '–'}%</b></div>
      <div>Readings above 16.7<b class="${S.veryHigh ? 'high' : ''}">${S.veryHigh}</b></div>
    </div>
    <div class="legend">Targets per international consensus (Battelino et al., Diabetes Care 2019): time in range 3.9–10.0 mmol/L &gt;70%, below 3.9 &lt;4%, below 3.0 &lt;1%, CV ≤36%. From fingerstick meter readings, not continuous monitoring.</div>
  </div>
</div>
<div class="chart" style="margin-top:10px"><div class="chart-title">Glucose by time of day (all days on one 24-hour day)</div><div class="chart-sub">Dots: each reading, coloured by range. Blue line: median, shaded: middle 50% of readings (2-hour blocks with 3+ readings). Dashed lines: target 3.9–10.0 mmol/L.</div>${modalDaySvg(D)}</div>
<div class="chart" style="margin-top:10px"><div class="chart-title">Daily glucose</div><div class="chart-sub">Dot: day's average (coloured by range). Bar: lowest to highest reading that day.</div>${dailyTrendSvg(D)}</div>` : ''}

${ctxRows ? `<h2>Sugar by time of day</h2><table><tr><th>When</th><th>Readings</th><th>Average</th><th>Lowest – highest</th><th>Target</th></tr>${ctxRows}</table>` : ''}

<h2>Current medicines</h2>
${meds ? `<table><tr><th style="width:32%">Medicine</th><th>When and how much</th><th style="width:20%">Note</th></tr>${meds}</table>` : '<p class="sub">No medicines entered.</p>'}

${adhRows ? `<h2>Insulin taken (adherence)</h2><table><tr><th>Dose</th><th>Insulin</th><th>Planned</th><th>Days taken</th><th>Skipped</th><th>Missed</th><th>Average units</th><th>Outside range</th></tr>${adhRows}</table>` : ''}

${evRows ? `<h2>Important events</h2><table><tr><th style="width:20%">When</th><th style="width:22%">Event</th><th>Details</th></tr>${evRows}</table>` : ''}

${dailyRows ? `<h2 class="page-break">Day by day</h2>
<table class="logbook"><tr><th>Day</th><th>Fasting</th><th>Before lunch</th><th>Before dinner</th><th>Bedtime</th><th>Other readings</th>${SLOTS.map((s) => `<th>${T(`slot_${s}`)} insulin</th>`).join('')}<th>Tablets</th><th>kcal</th></tr>${dailyRows}</table>
<div class="legend">Sugar in mmol/L: green within the personal target, orange above it, red below 3.9. Insulin: units @ time taken.</div>` : ''}

<div class="note">Recorded by the patient and family in the Sugar Helper app (glucose meter readings marked as such in the Excel file). For the doctor's review; the app does not replace medical advice.</div>
</body></html>`;
}

// --- Excel sheets ---------------------------------------------------------------------------

export function reportSheets(D) {
  const P = D.plan;
  const S = D.stats;
  const day = dateNum;
  const summary = [
    ['Item', 'Value'],
    ['Patient', P.patient.name],
    ['Period', `${dateLong(D.from)} – ${dateLong(D.to)}`],
    ['Readings', S.n],
    ['Average sugar (mmol/L)', S.avg ?? ''],
    ['Lowest / highest', S.n ? `${S.min} / ${S.max}` : ''],
    ['In personal target (%)', S.inTarget ?? ''],
    ['Time 3.9–10 (%)', S.tir ?? ''],
    ['Lows < 3.9', S.lows],
    ['Severe lows < 3.0', S.severe],
    ['Readings above 16.7', S.veryHigh],
    ['Estimated HbA1c (eA1c, ADAG) (%)', S.eA1c ?? ''],
    ['Glucose variability CV (%)', S.cv ?? ''],
    ['Standard deviation (mmol/L)', S.sd ?? ''],
    ...BANDS.map((b) => [`${b.label} ${b.range} mmol/L (%)`, S.bands[b.key]]),
    ['Average kcal a day', S.kcalAvg ?? ''],
    [],
    ['Dose', 'Insulin', 'Planned units', 'Days taken', 'Skipped', 'Missed', 'Average units', 'Outside range'],
    ...D.adherence.map((a) => [T(`slot_${a.slot}`), a.name, a.planned, a.taken, a.skipped, a.missed, a.avgUnits ?? '', a.outside]),
  ];
  const medRows = [['Medicine', 'Strength', 'Type', 'When', 'Amount', 'Food', 'Time', 'Note']];
  for (const m of P.meds ?? []) {
    const isIns = m.type === 'pen' || m.type === 'vial';
    for (const x of (m.times ?? []).filter((y) => y.amount > 0)) {
      medRows.push([m.name, m.strength ?? '', T(`type_${m.type}`), isIns ? T(x.when === 'night' ? 'when_ins_night' : `when_${x.when}`) : T(`when_${x.when}`), x.amount, x.meal ? T(`meal_${x.meal}`) : '', at12(x.at), m.note ?? '']);
    }
  }
  return [
    { name: 'Summary', rows: summary, widths: [26, 22, 14, 12, 10, 10, 14, 14] },
    { name: 'Medicines', rows: medRows, widths: [18, 12, 14, 22, 8, 14, 8, 20] },
    {
      name: 'Readings',
      rows: [['Date', 'Time', 'Sugar (mmol/L)', 'When', 'Status', 'Source'], ...D.readings.map((r) => [day(r.ts), hm(r.ts), r.value, T(`ctx_${r.context}`), r.value < LIMITS.HYPO ? 'low' : classify(r.value, rangeFor(P, r.context)) === 'in_range' ? 'in target' : 'above target', r.source === 'meter' ? 'meter' : 'typed'])],
      widths: [12, 8, 14, 18, 14, 10],
    },
    {
      name: 'Insulin',
      rows: [['Date', 'Time', 'Dose', 'Insulin', 'Units', 'Planned', 'Change', 'Status', 'Entered by'], ...D.doses.map((d) => [day(d.ts), hm(d.ts), T(`slot_${d.slot}`), d.insulin ?? '', d.action === 'skip' ? '' : d.units, d.base ?? '', d.action === 'skip' ? '' : d.delta ?? '', d.action === 'skip' ? 'skipped' : d.outside ? 'outside range' : 'taken', d.by === 'caregiver' ? 'family' : d.via === 'alarm' ? 'alarm button' : 'patient'])],
      widths: [12, 8, 16, 14, 8, 9, 9, 14, 14],
    },
    { name: 'Tablets', rows: [['Date', 'Time', 'Medicine', 'When'], ...D.tablets.map((x) => [day(x.ts), hm(x.ts), x.name ?? '', x.when ? T(`when_${x.when}`) : ''])], widths: [12, 8, 22, 14] },
    { name: 'Meals', rows: [['Date', 'Time', 'Meal', 'kcal'], ...D.meals.map((m) => [day(m.ts), hm(m.ts), T(`slot_${m.slot}`), m.kcal ?? ''])], widths: [12, 8, 16, 8] },
    { name: 'Weight', rows: [['Date', 'kg'], ...D.weights.map((x) => [day(x.ts), x.kg])], widths: [12, 8] },
    {
      name: 'Day by day',
      rows: [
        ['Day', 'Fasting', 'Before lunch', 'Before dinner', 'Bedtime', 'Other readings', ...SLOTS.map((s) => `${T(`slot_${s}`)} insulin`), 'Tablets', 'kcal'],
        ...D.daily.map((d) => [day(d.ts), d.fasting.join(', '), d.pre_lunch.join(', '), d.pre_dinner.join(', '), d.bedtime.join(', '), d.other.join(', '), ...SLOTS.map((s) => d.ins[s]), d.tablets.join(', '), d.kcal || '']),
      ],
      widths: [12, 10, 12, 12, 10, 22, 16, 16, 16, 16, 20, 8],
    },
  ];
}

export { generalTimes };
