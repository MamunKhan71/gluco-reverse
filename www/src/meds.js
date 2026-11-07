// Medicines as the doctor prescribes them. Stored in plan.meds (synced to the family).
// Insulin cards are turned into plan.doses (the four insulin times the rest of the app uses:
// alarms, dose screens, ±2 rule); other medicines into plan.tablets (reminders, "taken" ticks).

export const MED_TYPES = ['pen', 'vial', 'tablet', 'capsule', 'syrup', 'other'];
export const isInsulin = (m) => m.type === 'pen' || m.type === 'vial';

// Insulin times = the app's dose slots. Other medicines: times of day.
export const INSULIN_WHEN = ['breakfast', 'lunch', 'dinner', 'night'];
// Which times each kind of insulin can be given: meal insulin (and mixed) before meals;
// all-day insulin once or twice a day, in the morning or at night before sleep.
export const insulinWhen = (kind) => (kind === 'basal' ? ['breakfast', 'night'] : ['breakfast', 'lunch', 'dinner']);
export const GENERAL_WHEN = ['morning', 'noon', 'afternoon', 'evening', 'night', 'bedtime'];
export const MEALS = ['before', 'with', 'after', 'empty', ''];

export const DEFAULT_AT = {
  breakfast: '07:30',
  lunch: '13:00',
  dinner: '20:00',
  night: '22:00',
  morning: '08:00',
  noon: '13:30',
  afternoon: '17:00',
  evening: '19:00',
  bedtime: '22:30',
};

// Common medicines in Bangladesh (brand, generic, usual strength). Typing either the brand or
// the generic name finds it; picking one fills in type, strength and insulin kind. Any other
// name can still be typed by hand.
const I = (name, generic, type, insulinKind) => ({ name, generic, type, strength: 'U-100', insulinKind });
const T = (name, generic, strength, type = 'tablet') => ({ name, generic, type, strength });
export const KNOWN = [
  // insulin, most used in Bangladesh first (shown before anything is typed)
  I('Actrapid', 'Human regular insulin', 'vial', 'rapid'),
  I('Lantus', 'Insulin glargine', 'pen', 'basal'),
  I('Mixtard 30', 'Human insulin 30/70', 'vial', 'mixed'),
  I('Humulin 30/70', 'Human insulin 30/70', 'vial', 'mixed'),
  I('NovoRapid', 'Insulin aspart', 'pen', 'rapid'),
  I('NovoMix 30', 'Insulin aspart 30/70', 'pen', 'mixed'),
  I('Insulatard', 'Human NPH insulin', 'vial', 'basal'),
  I('Tresiba', 'Insulin degludec', 'pen', 'basal'),
  I('Humulin R', 'Human regular insulin', 'vial', 'rapid'),
  I('Humulin N', 'Human NPH insulin', 'vial', 'basal'),
  I('Actrapid Penfill', 'Human regular insulin', 'pen', 'rapid'),
  I('Insuman Rapid', 'Human regular insulin', 'pen', 'rapid'),
  I('Humalog', 'Insulin lispro', 'pen', 'rapid'),
  I('Apidra', 'Insulin glulisine', 'pen', 'rapid'),
  I('Toujeo', 'Insulin glargine', 'pen', 'basal'),
  I('Basaglar', 'Insulin glargine', 'pen', 'basal'),
  I('Levemir', 'Insulin detemir', 'pen', 'basal'),
  I('Humalog Mix 25', 'Insulin lispro 25/75', 'pen', 'mixed'),
  I('Ryzodeg', 'Insulin degludec + aspart', 'pen', 'mixed'),
  // diabetes tablets
  T('Comet', 'Metformin', '500 mg'),
  T('Comet XR', 'Metformin XR', '500 mg'),
  T('Secrin', 'Glimepiride', '2 mg'),
  T('Amaryl', 'Glimepiride', '2 mg'),
  T('Comprid', 'Gliclazide', '80 mg'),
  T('Diamicron MR', 'Gliclazide MR', '60 mg'),
  T('Lino', 'Linagliptin', '5 mg'),
  T('Linatab', 'Linagliptin', '5 mg'),
  T('Trajenta', 'Linagliptin', '5 mg'),
  T('Januvia', 'Sitagliptin', '50 mg'),
  T('Galvus', 'Vildagliptin', '50 mg'),
  T('Galvus Met', 'Vildagliptin + Metformin', '50/500 mg'),
  T('Empa', 'Empagliflozin', '10 mg'),
  T('Jardiance', 'Empagliflozin', '10 mg'),
  T('Emjard M', 'Empagliflozin + Metformin', '12.5/500 mg'),
  T('Forxiga', 'Dapagliflozin', '10 mg'),
  T('Pioglit', 'Pioglitazone', '15 mg'),
  // heart, blood pressure, cholesterol
  T('Atova', 'Atorvastatin', '10 mg'),
  T('Lipitor', 'Atorvastatin', '10 mg'),
  T('Rosuva', 'Rosuvastatin', '10 mg'),
  T('Angilock', 'Losartan', '50 mg'),
  T('Osartil', 'Losartan', '50 mg'),
  T('Camlodin', 'Amlodipine', '5 mg'),
  T('Amdocal', 'Amlodipine', '5 mg'),
  T('Bisocor', 'Bisoprolol', '2.5 mg'),
  T('Tenormin', 'Atenolol', '50 mg'),
  T('Ecosprin', 'Aspirin', '75 mg'),
  T('Clopid', 'Clopidogrel', '75 mg'),
  // stomach
  T('Seclo', 'Omeprazole', '20 mg', 'capsule'),
  T('Maxpro', 'Esomeprazole', '20 mg'),
  T('Sergel', 'Esomeprazole', '20 mg', 'capsule'),
  T('Pantonix', 'Pantoprazole', '20 mg'),
  T('Rabe', 'Rabeprazole', '20 mg'),
  T('Flatameal DS', 'Antacid', '', 'syrup'),
  // vitamins, calcium, nerves
  T('Calbo-D', 'Calcium + Vitamin D', '500 mg'),
  T('Neuro-B', 'Vitamin B1, B6, B12', ''),
  T('Bextram Gold', 'Multivitamin', ''),
  T('Ferrous Sulphate', 'Iron', '200 mg'),
  // thyroid, pain, fever
  T('Thyrox', 'Levothyroxine', '50 mcg'),
  T('Napa', 'Paracetamol', '500 mg'),
  T('Ace', 'Paracetamol', '500 mg'),
];

// Up to `limit` medicines for what was typed (brand or generic), insulin or not as asked.
export function searchMeds(text, insulin, limit = 6) {
  const q = String(text ?? '').trim().toLowerCase();
  const pool = KNOWN.filter((k) => isInsulin(k) === insulin);
  if (!q) return pool.slice(0, limit);
  const starts = pool.filter((k) => k.name.toLowerCase().startsWith(q) || k.generic.toLowerCase().startsWith(q));
  const has = pool.filter((k) => !starts.includes(k) && (k.name.toLowerCase().includes(q) || k.generic.toLowerCase().includes(q)));
  return [...starts, ...has].slice(0, limit);
}

export function knownMed(name) {
  const n = String(name ?? '').trim().toLowerCase();
  return KNOWN.find((k) => k.name.toLowerCase() === n) ?? null;
}

const BN_DIGITS = '০১২৩৪৫৬৭৮৯';
const toAscii = (s) => String(s ?? '').replace(/[০-৯]/g, (d) => String(BN_DIGITS.indexOf(d)));

// "16+16+12", "1+0+1", "½+0+½", "1/2 + 0 + 1", "০+০+২০" → numbers (null if it doesn't read).
export function parseDoseString(raw) {
  const s = toAscii(raw).replace(/\s/g, '').replace(/[–—-]/g, '+');
  if (!s) return null;
  const parts = s.split('+');
  if (parts.length < 2 || parts.length > 4) return null;
  const nums = parts.map((p) => {
    if (p === '½') return 0.5;
    if (p === '¼') return 0.25;
    const frac = p.match(/^(\d+)?½$/);
    if (frac) return Number(frac[1] ?? 0) + 0.5;
    const slash = p.match(/^(\d+)\/(\d+)$/);
    if (slash) return Number(slash[1]) / Number(slash[2]);
    return /^\d+(\.\d+)?$/.test(p) ? Number(p) : NaN;
  });
  return nums.some((n) => Number.isNaN(n)) ? null : nums;
}

// Prescription numbers → which times. Bangladeshi prescriptions write morning+noon+night;
// for a long-acting (basal) insulin the night number is the bedtime dose.
export function doseTimes(nums, med) {
  if (!nums) return [];
  if (isInsulin(med)) {
    // all-day insulin: first number = morning, last number = night before sleep
    if (med.insulinKind === 'basal') {
      return [{ when: 'breakfast', amount: nums[0] }, { when: 'night', amount: nums.at(-1) }].filter((x) => x.amount > 0 && nums.length > 1);
    }
    return nums.slice(0, 3).map((amount, i) => ({ when: ['breakfast', 'lunch', 'dinner'][i], amount })).filter((x) => x.amount > 0);
  }
  // Bangladeshi prescriptions: 1+1 = morning and night, 1+1+1 = morning, noon, night.
  const slots = nums.length === 4 ? ['morning', 'noon', 'evening', 'night'] : nums.length === 2 ? ['morning', 'night'] : ['morning', 'noon', 'night'];
  return nums.map((amount, i) => ({ when: slots[i], amount })).filter((x) => x.amount > 0);
}

const addMin = (hhmm, min) => {
  const [h, m] = hhmm.split(':').map(Number);
  const t = (h * 60 + m + min + 1440) % 1440;
  return `${String(Math.floor(t / 60)).padStart(2, '0')}:${String(t % 60).padStart(2, '0')}`;
};

// Two insulins at the same time can't both be followed by the dose screens: report the clash.
export function insulinClash(meds) {
  const seen = new Map();
  for (const m of meds.filter(isInsulin)) {
    for (const x of m.times ?? []) {
      if (seen.has(x.when) && seen.get(x.when) !== m.id) return x.when;
      seen.set(x.when, m.id);
    }
  }
  return '';
}

// Insulin cards → the app's dose list (sorted by time of day).
// A medicine given for a set number of days: { start: 'YYYY-MM-DD', days: 7 }. No days = ongoing.
const dayStart = (key) => {
  const [y, m, d] = String(key).split('-').map(Number);
  return new Date(y, m - 1, d).getTime();
};
export function courseEnd(m) {
  if (!m.days || !m.start) return null;
  const end = new Date(dayStart(m.start));
  end.setDate(end.getDate() + Number(m.days));
  return end.getTime(); // the first day it is no longer taken
}
export const medActive = (m, now = Date.now()) => !courseEnd(m) || now < courseEnd(m);
export function daysLeft(m, now = Date.now()) {
  const end = courseEnd(m);
  if (!end) return null;
  const today = new Date(now);
  today.setHours(0, 0, 0, 0);
  return Math.max(0, Math.round((end - today.getTime()) / 864e5));
}

export function insulinDoses(meds) {
  const out = [];
  for (const m of meds.filter(isInsulin).filter((x) => medActive(x))) {
    const range = Number(m.range ?? 2);
    for (const x of m.times ?? []) {
      if (!(x.amount > 0) || !INSULIN_WHEN.includes(x.when)) continue;
      const injectAt = x.at || DEFAULT_AT[x.when];
      const basal = m.insulinKind === 'basal';
      out.push({
        id: x.when,
        medId: m.id,
        insulin: m.name,
        name: m.name,
        kind: basal ? 'basal' : 'bolus',
        injectAt,
        ...(basal ? {} : { mealAt: addMin(injectAt, 30) }),
        base: x.amount,
        min: Math.max(0, x.amount - range),
        max: x.amount + range,
      });
    }
  }
  return out.sort((a, b) => INSULIN_WHEN.indexOf(a.id) - INSULIN_WHEN.indexOf(b.id));
}

// Other medicines → reminders, and a "taken" tick on the matching insulin screen.
const MEAL_SLOT = { morning: 'breakfast', noon: 'lunch', evening: 'dinner', night: 'dinner' };
export function generalTimes(meds) {
  const out = [];
  for (const m of meds.filter((x) => !isInsulin(x) && medActive(x))) {
    for (const x of m.times ?? []) {
      if (!(x.amount > 0)) continue;
      out.push({
        medId: m.id,
        name: [m.name, m.strength].filter(Boolean).join(' '),
        type: m.type,
        when: x.when,
        meal: x.meal ?? '',
        amount: x.amount,
        at: x.at || DEFAULT_AT[x.when],
        with: x.meal === 'with' || x.meal === 'before' || x.meal === 'after' ? MEAL_SLOT[x.when] ?? '' : '',
      });
    }
  }
  return out.sort((a, b) => a.at.localeCompare(b.at));
}

// Apply medicines to a plan (insulin → doses, others → tablets). Plans without medicines yet keep
// their old insulin list until the first medicine is saved.
export function applyMeds(plan) {
  if (!Array.isArray(plan.meds)) return plan;
  plan.doses = insulinDoses(plan.meds);
  plan.tablets = generalTimes(plan.meds)
    .filter((x) => x.with)
    .map((x) => ({ id: x.medId, name: x.name, with: x.with, amount: x.amount }));
  return plan;
}

// Every plan runs on its medicine list. Plans from before medicines existed start empty: the
// family adds the prescription once and it syncs to every phone. (updatedAt is left alone, so
// a real list saved in the cloud always wins over this empty start.)
export function usePlanMeds(plan) {
  if (!Array.isArray(plan.meds)) plan.meds = [];
  return applyMeds(plan);
}

// "½", "1", "1½", "2" for tablets.
export function amountText(n) {
  const whole = Math.floor(n);
  const half = n - whole >= 0.5;
  return `${whole || (half ? '' : '0')}${half ? '½' : ''}`;
}
