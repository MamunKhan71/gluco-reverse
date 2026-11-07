import { DEFAULT_PLAN } from './plan.js';
import { usePlanMeds } from './meds.js';

// Profile-scoped key so a second profile (father) can be added later.
export const KEY = 'diabetes-control:mother:v1';

let saveHook = null;
// Called after every save (the Android app mirrors the data to a backup file).
export function onSave(fn) {
  saveHook = fn;
}

export function uid() {
  return Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
}

export function randomId(len = 28) {
  const bytes = crypto.getRandomValues(new Uint8Array(len));
  return Array.from(bytes, (b) => 'abcdefghijklmnopqrstuvwxyz0123456789'[b % 36]).join('');
}

export function hasData() {
  try {
    return !!localStorage.getItem(KEY);
  } catch {
    return false;
  }
}

export function restoreRaw(json) {
  JSON.parse(json); // refuse anything that isn't valid data
  localStorage.setItem(KEY, json);
}

// A clean start (new account on this phone): default plan, no history, default settings.
export const freshData = () => load(null);

export function load(from = undefined) {
  let raw = null;
  try {
    raw = from === null ? null : JSON.parse(localStorage.getItem(KEY));
  } catch {
    raw = null;
  }
  const plan = raw?.plan ?? structuredClone(DEFAULT_PLAN);
  // Older saved plans: fill in diet fields added later.
  plan.diet = { ...DEFAULT_PLAN.diet, ...plan.diet };
  usePlanMeds(plan);
  return {
    plan,
    log: raw?.log ?? [],
    // Synced between phones.
    state: { basal: undefined, acked: [], updatedAt: 0, ...raw?.state, ...(plan.doses.some((d) => d.kind === 'basal') ? {} : { basal: undefined }) },
    // This phone only.
    settings: {
      lang: 'bn',
      mode: 'simple',
      role: 'patient',
      pin: '',
      welcomed: false,
      firebase: null,
      familyId: '',
      ntfyTopic: '',
      sent: [],
      outbox: [],
      ...raw?.settings,
    },
  };
}

export function save(db) {
  const json = JSON.stringify(db);
  localStorage.setItem(KEY, json);
  saveHook?.(json);
}
