import {
  LIMITS,
  DAY,
  dayKey,
  checkReading,
  classify,
  suggestBolus,
  basalProposal,
  evaluateAlerts,
  adaptCarbs,
  bmiInfo,
  ftInToCm,
  cmToFtIn,
  stockStatus,
  nextSite,
  mealTotals,
} from './engine.js';
import { CATALOG, FOOD, GROUPS, DEFAULT_HOME_FOODS } from './foods.js';
import { suggestMenu, alternativesFor, dishesToItems, dishKcal, recipeOf, pantryMeal, recipeFor, MEAL_SHARE } from './menu.js';
import { t, tIn, setLang, getLang } from './i18n.js';
import { load, save, uid, randomId, hasData, restoreRaw, onSave, freshData } from './store.js';
import { sendNtfy, randomTopic } from './notify.js';
import { icon, SLOT_ICON } from './icons.js';
import * as native from './native.js';
import * as sync from './sync.js';
import { meterSupported, scanMeters, pairWith, readMeter } from './meter.js';
import { CLOUD } from './cloud-config.js';
import * as cloud from './cloud.js';
import { prettyCode } from './cloud.js';
import { bdPhone, prettyPhone } from './phone.js';
import { reportData, reportHtml, reportSheets } from './report.js';
import { makeXlsx } from './xlsx.js';
import { MED_TYPES, insulinWhen, GENERAL_WHEN, DEFAULT_AT, searchMeds, knownMed, isInsulin, parseDoseString, doseTimes, insulinClash, applyMeds, usePlanMeds, generalTimes, amountText } from './meds.js';

// Android: if the app's data was wiped, bring it back from the backup copy before starting.
let restoredFrom = null;
if (native.isNative && !hasData()) {
  const b = await native.backupLoad();
  if (b?.data) {
    try {
      restoreRaw(b.data);
      restoredFrom = b.source;
    } catch {
      // unreadable backup — start fresh
    }
  }
}

const S = load();
// ?debug in the address: expose the state for screenshots and checks during development
if (new URLSearchParams(location.search).has('debug')) Object.assign(window, { __S: S, __onUser: (u) => onUser(u) });

// Mirror every save to the backup files (debounced; Android only).
let backupTimer = null;
onSave((json) => {
  if (!native.isNative) return;
  clearTimeout(backupTimer);
  backupTimer = setTimeout(() => native.backupSave(json), 1500);
});
S.settings.theme ??= 'light';
S.settings.reminders ??= true;
S.settings.alarm ??= { repeatMinutes: 10, maxRepeats: 6, voice: true };
S.settings.textSize ??= 'lg';
S.settings.background ??= true;
setLang(S.settings.lang);
const $app = document.getElementById('app');

// In-memory state for multi-step screens.
let flow = null; // dose flow
let lowFlow = null;
let highFlow = null;
let readingFlow = null;
let foodFlow = null;
let pendingCheck = null; // reading that needs "are you sure?"
let kp = ''; // keypad input
let unlocked = false;
let toast = '';
let timerHandle = null;
let lastRouteKey = '';
let settingsMsg = '';

// --- helpers -----------------------------------------------------------------

const esc = (s) =>
  String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
const hhmm = (ts) => new Date(ts).toTimeString().slice(0, 5);
const isToday = (ts) => dayKey(ts) === dayKey(Date.now());
const activeLog = () => S.log.filter((e) => !e.deleted && !e.other && !e.person);
const slotName = (id) => t(`slot_${id}`);
const doseById = (id) => S.plan.doses.find((d) => d.id === id);
const readingsSorted = () => activeLog().filter((e) => e.type === 'reading').sort((a, b) => a.ts - b.ts);
const lastReading = () => readingsSorted().at(-1);
const todayDose = (slot) =>
  activeLog()
    .filter((e) => e.type === 'dose' && e.slot === slot && isToday(e.ts))
    .at(-1);
const CTX_FOR_SLOT = { breakfast: 'fasting', lunch: 'pre_lunch', dinner: 'pre_dinner', night: 'bedtime' };
const rangeFor = (ctx) =>
  ({
    fasting: S.plan.targets.fasting,
    pre_lunch: S.plan.targets.preMeal,
    pre_dinner: S.plan.targets.preMeal,
    bedtime: S.plan.targets.bedtime,
  })[ctx] ?? S.plan.targets.postMeal;
const LEVEL_ICON = { red: 'siren', orange: 'phone', yellow: 'alert', info: 'info' };

let settingsDirty = false;
function go(path) {
  if (!String(path).startsWith('dosebook')) doseBook = null;
  if (settingsDirty && !confirm(t('unsaved_leave'))) return;
  settingsDirty = false;
  native.haptic();
  location.hash = `#/${path}`;
}

function telBtn(phone, label, cls = 'btn') {
  return phone ? `<a class="${cls}" href="tel:${esc(phone)}">${icon('phone')} ${label}</a>` : '';
}

function callButtons() {
  return `<a class="btn btn-danger btn-lg" href="tel:999">${icon('phone')} ${t('call_999')}</a>
    ${telBtn(S.plan.doctor.phone, t('call_doctor'))}
    ${telBtn(S.plan.caregiver.phone, t('call_caregiver'))}`;
}

// --- theme ---------------------------------------------------------------------

const darkQuery = window.matchMedia('(prefers-color-scheme: dark)');
function isDark() {
  return S.settings.theme === 'dark' || (S.settings.theme === 'system' && darkQuery.matches);
}
function applyTheme() {
  const dark = isDark();
  document.documentElement.dataset.theme = dark ? 'dark' : 'light';
  document.querySelector('meta[name="theme-color"]')?.setAttribute('content', dark ? '#100e1f' : '#f4f5fb');
  native.setStatusBar(dark);
}
darkQuery.addEventListener?.('change', () => {
  applyTheme();
  render();
});

// --- persistence, sync, alerts -----------------------------------------------------

function persist(rec) {
  rec.id ??= uid();
  rec.ts ??= Date.now();
  rec.updatedAt = Date.now();
  rec.by ??= S.settings.role;
  const i = S.log.findIndex((e) => e.id === rec.id);
  if (i >= 0) S.log[i] = rec;
  else S.log.push(rec);
  save(S);
  sync.pushRecord(rec);
  if (S.user && S.settings.familyId) native.queueRecord(rec);
  if (rec.type === 'reading' && !rec.deleted && !rec.other && !rec.person) crisisCheck(rec);
  heartbeat();
  // A logged (or skipped) dose stops its alarm from ringing again today.
  if (rec.type === 'dose' && !rec.deleted && isToday(rec.ts)) {
    native.confirmAlarm(alarmId(rec.slot), rec.ts);
    updateGuard();
  }
  dispatchAlerts();
  return rec;
}

function savePlan() {
  S.plan.updatedAt = Math.max(Date.now(), (S.plan.updatedAt ?? 0) + 1);
  S.plan.updatedBy = S.user?.uid ?? '';
  save(S);
  sync.pushMeta('plan', S.plan);
  if (isCaregiver() && S.settings.familyId) cloud.ringPatient(S.settings.familyId, 'sync').catch(() => {});
  dispatchAlerts();
  scheduleReminders();
}

function saveState() {
  S.state.updatedAt = Math.max(Date.now(), (S.state.updatedAt ?? 0) + 1);
  save(S);
  sync.pushMeta('state', S.state);
}

const currentAlerts = () => evaluateAlerts(S.plan, activeLog(), S.state);
const alertText = (a) => t(`a_${a.code}`, a.params, a.params.slot ? slotName(a.params.slot) : '');

// Only the patient's phone sends push alerts, so they are not duplicated.
function dispatchAlerts() {
  const st = S.settings;
  if (st.role !== 'patient' || !st.ntfyTopic) return;
  for (const a of currentAlerts()) {
    if (a.level === 'info' || st.sent.includes(a.key)) continue;
    st.sent.push(a.key);
    st.outbox.push({
      title: `${S.plan.patient.name}: ${t(`lvl_${a.level}`)}`,
      message: `${alertText(a)} (${hhmm(Date.now())})`,
      priority: { red: 5, orange: 4, yellow: 3 }[a.level],
    });
  }
  save(S);
  flushOutbox();
}

let flushing = false;
async function flushOutbox() {
  const st = S.settings;
  if (flushing) return;
  flushing = true;
  try {
    while (st.outbox.length && navigator.onLine) {
      await sendNtfy(st.ntfyTopic, st.outbox[0]);
      st.outbox.shift();
      save(S);
    }
  } catch {
    // stays in the outbox; retried when back online or on the next record
  } finally {
    flushing = false;
  }
}
window.addEventListener('online', () => {
  flushOutbox();
  // Firestore re-sends anything saved while offline by itself; reconnect if it had given up.
  if (S.user && S.settings.familyId && !sync.connected()) startSync();
  registerRing();
  toast = t('back_online');
  render();
});
window.addEventListener('offline', () => render());

// Alarm id per dose slot (1..4); 99 = low-sugar recheck.
const alarmId = (slot) => S.plan.doses.findIndex((d) => d.id === slot) + 1;
// Recorded voice clips bundled with the app (audio/ → res/raw); English ones start with en_.
const clip = (name) => (getLang() === 'en' ? 'en_' : '') + name;
const doseClip = (slot) => clip(`dose_${slot === 'breakfast' ? 'morning' : slot}`);
const alarmText = () => ({ openLabel: t('alarm_open'), snoozeLabel: t('alarm_snooze', S.settings.alarm.repeatMinutes) });

// Dose times ring as full-screen alarms that repeat until the dose is logged;
// the snack and tomorrow's-menu reminders stay ordinary notifications.
async function scheduleReminders() {
  if (!native.isNative) return;
  if (!S.settings.reminders || S.settings.role !== 'patient') {
    // The family's phone gets a plain notification at each dose time (no full-screen alarm).
    await native.setDailyAlarms(isCaregiver() && S.settings.reminders ? caregiverReminders() : [], { ...S.settings.alarm, planUpdatedAt: S.plan.updatedAt ?? 0 }).catch(() => {});
    if (isCaregiver()) confirmDoneAlarms();
    for (let i = 0; i < 7; i++) native.cancelAlarm(60 + i);
    return native.cancelDaily();
  }
  const [sh, sm] = S.plan.snackAt.split(':').map(Number);
  const snack = { id: 50, slot: 'snack', hour: sh, minute: sm, gentle: true, repeat: false, route: 'home', title: t('snack_reminder'), body: t('snack_body'), clip: clip('snack') };
  const alarms = S.plan.doses.map((d) => {
    const [hour, minute] = d.injectAt.split(':').map(Number);
    const units = doseUnits(d);
    return {
      id: alarmId(d.id),
      hour,
      minute,
      route: `dose/${d.id}`,
      slot: d.id,
      kind: d.kind,
      insulin: d.insulin,
      medId: d.medId ?? '',
      units,
      base: d.base,
      takenLabel: t('al_taken', units),
      snooze30Label: t('al_later', 30),
      snooze60Label: t('al_later', 60),
      skipLabel: t('al_skip'),
      title: t('alarm_title', S.plan.patient.name, slotName(d.id)),
      body: t('alarm_body', t(`ins_${d.insulin}`), units),
      bodyTpl: t('alarm_body', t(`ins_${d.insulin}`), '{u}'),
      // sent to the family's phones if the dose is still not logged after ~30 minutes
      clip: doseClip(d.id),
      repeatClip: clip('dose_repeat'),
      missedTitle: `${S.plan.patient.name}: ${t('fam_missed')}`,
      missedText: t('missed_push', slotName(d.id), d.injectAt, `${t(`ins_${d.insulin}`)} ${units}`),
      ...alarmText(),
    };
  });
  saveCrisisTexts();
  const medRems = generalTimes(S.plan.meds ?? []).slice(0, 60).map((x, i) => {
    const [hour, minute] = x.at.split(':').map(Number);
    return { id: 200 + i, hour, minute, gentle: true, repeat: false, route: 'meds', title: t('med_rem_title', x.name), body: medLine(x), clip: '' };
  });
  await native.setDailyAlarms([...alarms, snack, ...medRems], { ...S.settings.alarm, ntfyTopic: S.settings.ntfyTopic || '', planUpdatedAt: S.plan.updatedAt ?? 0 }).catch(() => {});
  confirmDoneAlarms();
  updateGuard();
  // asks for notification permission and clears the old plain snack/menu notifications
  const ok = await native.scheduleDaily([]).catch(() => false);
  await native.cancelDaily();
  if (!ok) toast = t('reminders_denied');
  else await scheduleMenuReminders();
}

const CHECK_AFTER_MIN = 30;
// Saved for the phone's own emergency alarm when it reads the meter by itself (value filled in there).
function saveCrisisTexts() {
  if (!native.isNative || isCaregiver()) return;
  const lang = getLang();
  const pack = (level) => ({ ...crisisTexts(level, '{v}', false, lang), clip: clip(`crisis_${level}`) });
  native.setMeterConfig({
    crisis: { low: pack('low'), high: pack('high'), contacts: JSON.stringify(crisisContacts(false)), lang, openLabel: t('crisis_open'), snoozeLabel: t('crisis_close') },
    texts: { title: t('mn_title'), connected: t('mn_connected'), got: t('mn_got', '{n}'), none: t('mn_none') },
  });
}

function caregiverReminders() {
  const phone = S.plan.patient.phone ?? '';
  const checks = S.plan.doses.map((d) => {
    const [h, m] = d.injectAt.split(':').map(Number);
    const at = h * 60 + m + CHECK_AFTER_MIN;
    return {
      id: 30 + alarmId(d.id),
      hour: Math.floor(at / 60) % 24,
      minute: at % 60,
      gentle: true,
      repeat: false,
      route: 'home',
      checkSlot: d.id,
      checkAfter: CHECK_AFTER_MIN,
      checkDose: alarmId(d.id),
      doseHour: h,
      doseMinute: m,
      title: t('cg_check_title', S.plan.patient.name, slotName(d.id)),
      body: t(phone ? 'cg_check_body' : 'cg_check_body_nophone'),
      phone,
      callLabel: t('call_short'),
      clip: '',
    };
  });
  return [...caregiverDoseReminders(phone), ...checks];
}

function caregiverDoseReminders(phone) {
  return S.plan.doses.map((d) => {
    const [hour, minute] = d.injectAt.split(':').map(Number);
    const units = doseUnits(d);
    return {
      id: alarmId(d.id),
      hour,
      minute,
      gentle: true,
      repeat: false,
      route: 'home',
      slot: d.id,
      title: t('cg_dose_title', S.plan.patient.name, slotName(d.id)),
      body: `${t(`ins_${d.insulin}`)} ${units} ${t('units')}`,
      bodyTpl: `${t(`ins_${d.insulin}`)} {u} ${t('units')}`,
      phone,
      callLabel: t('call_short'),
      clip: '',
    };
  });
}

// The permanent "always on" notification shows the next dose.
// Count and button on the delete card, without redrawing the list.
function updateDeleteBar() {
  const n = delState.picked.size;
  const count = document.getElementById('del-count');
  if (count) count.textContent = t('del_selected', loc(n));
  const btn = document.getElementById('del-sel-btn');
  if (btn) btn.disabled = !n;
  for (const day of $app.querySelectorAll('.del-day')) {
    const boxes = [...day.querySelectorAll('.del-item input')];
    const head = day.querySelector('summary input');
    if (head) head.checked = boxes.length > 0 && boxes.every((b) => b.checked);
  }
}

function updateGuard() {
  if (!native.isNative) return;
  const on = S.settings.background && S.settings.reminders && S.settings.role === 'patient';
  const next = todaySchedule().find((i) => i.kind === 'dose' && itemStatus(i) === 'pending');
  const what = next ? `${t(`ins_${next.dose.insulin}`)} ${doseUnits(next.dose)} ${t('units')}` : '';
  native.guard({ on, title: t('guard_title'), text: next ? t('guard_next', slotName(next.slot), next.time, what) : t('all_done') });
}

// Doses already logged today (here or on the caregiver's phone) must not ring.
function confirmDoneAlarms() {
  for (const d of S.plan.doses) {
    const done = todayDose(d.id);
    if (done) native.confirmAlarm(alarmId(d.id), done.ts);
  }
}

// A record from the cloud: only known shapes, numbers as numbers (it is shown as HTML later).
const CONTEXTS = new Set(['fasting', 'pre_lunch', 'pre_dinner', 'post_meal', 'bedtime', 'night_3am', 'other']);
function cleanRecord(r) {
  if (!r || typeof r.id !== 'string' || !Number.isFinite(Number(r.ts))) return null;
  const out = { ...r, ts: Number(r.ts) };
  for (const k of ['value', 'units', 'kg', 'kcal', 'updatedAt']) if (k in out) out[k] = Number(out[k]);
  if (out.type === 'reading' && (!Number.isFinite(out.value) || out.value <= 0 || out.value > 40)) return null;
  if (out.type === 'reading' && !CONTEXTS.has(out.context)) out.context = 'other';
  return out;
}

let pushedMissing = false;
let presenceFresh = false;
function startSync() {
  const { familyId } = S.settings;
  if (!cloud.cloudReady() || !S.user || !familyId) return Promise.resolve();
  pushedMissing = false;
  presenceFresh = false;
  // if the live status never comes (slow network), stop saying "connecting" after a while
  setTimeout(() => {
    presenceFresh = true;
    softRender();
  }, 6000);
  return sync
    .connect(familyId, {
      records(recs, fromCache) {
        let changed = false;
        for (const raw of recs) {
          const r = cleanRecord(raw);
          if (!r) continue;
          const i = S.log.findIndex((e) => e.id === r.id);
          if (i < 0) {
            S.log.push(r);
            changed = true;
          } else if ((r.updatedAt ?? r.ts) > (S.log[i].updatedAt ?? S.log[i].ts)) {
            S.log[i] = r;
            changed = true;
          } else if ((r.updatedAt ?? r.ts) < (S.log[i].updatedAt ?? S.log[i].ts)) {
            sync.pushRecord(S.log[i]); // the cloud copy is older (e.g. overwritten): put ours back
          }
        }
        if (!pushedMissing && !fromCache) {
          // Upload anything logged while this phone was offline.
          const ids = new Set(recs.map((r) => r.id));
          const since = Date.now() - 60 * DAY;
          S.log.filter((e) => !ids.has(e.id) && e.ts >= since).forEach(sync.pushRecord);
          pushedMissing = true;
        }
        if (changed) {
          save(S);
          dispatchAlerts();
          confirmDoneAlarms();
          softRender();
        }
      },
      plan(p, fromCache) {
        if (fromCache && !p) return; // not known yet: wait for the server before creating it
        if (!fromCache) planLoaded = true;
        setTimeout(syncMemberLinks, 0);
        if (!p || p.updatedAt < S.plan.updatedAt) return fromCache ? undefined : sync.pushMeta('plan', S.plan);
        if (p.updatedAt > S.plan.updatedAt) {
          const byFamily = !isCaregiver() && p.updatedBy && p.updatedBy !== S.user?.uid && S.plan.updatedAt > 0;
          S.plan = usePlanMeds(p);
          if (!basalDose()) S.state.basal = undefined;
          save(S);
          if (byFamily) toast = t('plan_by_family');
          scheduleReminders();
          softRender();
        }
      },
      presence(p, fromCache) {
        S.presence = p;
        const last = Math.max(p?.lastSeen ?? 0, p?.bgSync ?? 0);
        if (!fromCache || Date.now() - last < 40 * 60000) presenceFresh = true; // an old saved copy waits for the live one
        softRender();
      },
      state(st, fromCache) {
        if (!st || st.updatedAt < S.state.updatedAt) return fromCache ? undefined : sync.pushMeta('state', S.state);
        if (st.updatedAt > S.state.updatedAt) {
          const basalChanged = JSON.stringify(st.basal ?? null) !== JSON.stringify(S.state.basal ?? null);
          S.state = st;
          save(S);
          if (basalChanged) scheduleReminders();
          softRender();
        }
      },
    })
    .then(() => heartbeat(true))
    .catch(() => softRender());
}

// Re-render on remote changes only where it can't wipe a half-finished entry.
// --- errors: kept on the phone (last 20) so a problem can be looked at later -------------
function logError(err, where = '') {
  console.error(where, err);
  try {
    const list = JSON.parse(localStorage.getItem('sugar-errors') || '[]');
    list.push({ at: new Date().toISOString(), where, msg: String(err?.message ?? err).slice(0, 300), stack: String(err?.stack ?? '').slice(0, 800) });
    localStorage.setItem('sugar-errors', JSON.stringify(list.slice(-20)));
  } catch {
    // storage full or blocked: nothing more to do
  }
}
window.addEventListener('error', (e) => logError(e.error ?? e.message, 'window'));
window.addEventListener('unhandledrejection', (e) => logError(e.reason, 'promise'));

function viewCrash(name) {
  return `<div class="page welcome">
    <div class="logo">${icon('alert')}</div>
    <h1>${t('crash_title')}</h1>
    <p class="center muted">${t('crash_body')}</p>
    <button class="btn btn-primary btn-lg" data-act="home">${icon('home')} ${t('crash_home')}</button>
    ${name === 'home' ? `<button class="btn" data-act="reload">${icon('refresh')} ${t('crash_reload')}</button>` : ''}
  </div>`;
}

function softRender() {
  if (['home', 'more', 'history', 'report', 'share'].includes(parseRoute().name)) render(true);
}

// --- routing -------------------------------------------------------------------

function parseRoute() {
  const [name, arg] = location.hash.replace(/^#\/?/, '').split('/');
  return { name: name || 'home', arg };
}

const VIEWS = {
  home: viewHome,
  dose: viewDose,
  low: viewLow,
  high: viewHigh,
  reading: viewReading,
  food: viewFood,
  pantry: viewPantry,
  offplan: viewOffplan,
  recipe: viewRecipe,
  stock: viewStock,
  meter: viewMeter,
  share: viewShare,
  login: viewLogin,
  role: viewRole,
  joincode: viewJoinCode,
  account: viewAccount,
  whose: viewWhose,
  patient: viewPatientInfo,
  mine: viewMine,
  people: viewPeople,
  person: viewPerson,
  metersync: viewMeterSync,
  dosebook: viewDoseBook,
  meds: viewMeds,
  med: viewMedEdit,
  cgalerts: viewCgAlerts,
  ring: viewRing,
  more: viewMore,
  alarms: viewAlarms,
  weight: viewWeight,
  history: viewHistory,
  report: viewReport,
  settings: viewSettings,
  join: viewJoin,
};

// Background updates (sync, presence, meter) redraw often: only a new page fades in, an
// unchanged screen is left alone, and inner scroll boxes keep their place.
let lastHtml = '';
let planLoaded = false; // the family's plan has come from the cloud this session
const SCROLL_BOXES = '.feed-scroll, .del-list, .scan-list, .ms-list, .wh-list';
// soft = a background refresh (sync, timers): skipped when nothing on screen changed, so it never
// flickers. Anything the user does always redraws.
function render(soft) {
  clearInterval(timerHandle);
  const r = parseRoute();
  const key = `${r.name}/${r.arg ?? ''}`;
  const newPage = key !== lastRouteKey;
  if (newPage) {
    lastRouteKey = key;
    kp = '';
    pendingCheck = null;
    window.scrollTo(0, 0);
  }
  const open = ['join', 'login', 'role', 'joincode'].includes(r.name);
  // With a family, wait for the cloud plan first so a reinstalled phone never overwrites it.
  const memberOnly = S.settings.memberOnly && !S.settings.familyId;
  const mustRegister = !memberOnly && !open && !isCaregiver() && !S.plan.patient.registered && r.name !== 'patient' && (!S.settings.familyId || planLoaded);
  let body;
  try {
    body = !S.settings.welcomed && !open ? viewWelcome() : needsLogin() && !open ? viewLogin() : mustRegister ? viewPatientInfo('first') : memberOnly && !['account', 'login', 'mine'].includes(r.name) ? viewMine() : (VIEWS[r.name] ?? viewHome)(r.arg);
  } catch (err) {
    logError(err, `view ${key}`);
    body = viewCrash(r.name);
  }
  const html = body + (toast ? `<div class="toast">${icon('check')} ${esc(toast)}</div>` : '') + celebrationLayer();
  toast = '';
  if (soft === true && !newPage && html === lastHtml) {
    if (r.name === 'low' && lowFlow?.step === 'timer') startTimer();
    return;
  }
  lastHtml = html;
  const scrolls = newPage ? [] : [...$app.querySelectorAll(SCROLL_BOXES)].map((el) => el.scrollTop);
  $app.classList.toggle('enter', newPage);
  $app.innerHTML = html;
  scrolls.forEach((top, i) => {
    const el = $app.querySelectorAll(SCROLL_BOXES)[i];
    if (el) el.scrollTop = top;
  });
  if (r.name === 'low' && lowFlow?.step === 'timer') startTimer();
}

window.addEventListener('hashchange', render);
// Update doses: a date picked from the calendar.
document.addEventListener('change', (e) => {
  if (e.target.id !== 'db-date' || !e.target.value) return;
  const [y, m, d] = e.target.value.split('-').map(Number);
  const offset = Math.round((dayStartOf(0) - new Date(y, m - 1, d).getTime()) / DAY);
  doseBook = newDoseBook(Math.max(0, Math.min(60, offset)));
  render();
});

// Medicine name: refresh the suggestion cards while typing.
document.addEventListener('input', (e) => {
  if (e.target.id !== 'med-name' || !medDraft) return;
  const box = document.getElementById('med-sugg');
  const text = e.target.value;
  const exact = knownMed(text);
  if (box) box.innerHTML = exact ? '' : medSuggestions(text);
});

// Settings: show the save bar as soon as something is changed.
for (const ev of ['input', 'change']) {
  document.addEventListener(ev, (e) => {
    if (parseRoute().name !== 'settings' || !e.target.closest?.('.settings')) return;
    if (e.target.matches('input, select, textarea')) {
      settingsDirty = true;
      document.getElementById('save-bar')?.classList.add('show');
    }
  });
}
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'visible') {
    autoSyncMeter();
    if (voiceState && voiceState !== 'ok') voiceState = null;
  }
  if (document.visibilityState === 'visible' && parseRoute().name === 'alarms') {
    alarmChecks = null;
    render();
  }
});

// --- In-app alarm: used in the browser (the Android app has the native alarm) ---------------

const webAlarm = {
  active: null,
  snoozed: {},
  lowAt: 0,
  beepTimer: null,
  sayTimer: null,
  ctx: null,

  schedule(kind, at) {
    if (kind === 'low') this.lowAt = at;
  },

  check() {
    if (native.isNative || this.active || !S.settings.welcomed) return;
    const now = Date.now();
    if (this.lowAt && now >= this.lowAt) {
      this.lowAt = 0;
      return this.ring({ key: 'low', title: t('alarm_low_title'), body: t('alarm_low_body'), route: 'low' });
    }
    if (S.settings.role !== 'patient' || !S.settings.reminders) return;
    for (const d of S.plan.doses) {
      const [h, m] = d.injectAt.split(':').map(Number);
      const at = new Date().setHours(h, m, 0, 0);
      const key = `dose:${d.id}:${dayKey(now)}`;
      if (now < at || now - at > 60 * 60e3 || todayDose(d.id) || isMissed(d.id) || (this.snoozed[key] ?? 0) > now) continue;
      const units = doseUnits(d);
      return this.ring({ key, title: t('alarm_title', S.plan.patient.name, slotName(d.id)), body: t('alarm_body', t(`ins_${d.insulin}`), units), route: `dose/${d.id}` });
    }
  },

  ring(a) {
    this.active = a;
    const layer = document.createElement('div');
    layer.id = 'alarm-layer';
    layer.className = 'alarm-layer';
    layer.innerHTML = `<div class="alarm-pulse">${icon('bell')}</div>
      <div class="alarm-time">${hhmm(Date.now())}</div>
      <div class="alarm-title">${esc(a.title)}</div>
      <div class="alarm-body">${esc(a.body)}</div>
      <div class="alarm-actions">
        <button class="btn alarm-open" id="alarm-open">${icon('chev')} ${t('alarm_open')}</button>
        <button class="btn alarm-later" id="alarm-later">${t('alarm_snooze', S.settings.alarm.repeatMinutes)}</button>
      </div>`;
    document.body.appendChild(layer);
    layer.querySelector('#alarm-open').onclick = () => this.open();
    layer.querySelector('#alarm-later').onclick = () => this.snooze();
    this.beep();
    this.beepTimer = setInterval(() => this.beep(), 1600);
    if (S.settings.alarm.voice) {
      const say = () => native.speak(`${a.title}। ${a.body}`);
      say();
      this.sayTimer = setInterval(say, 25000);
    }
    navigator.vibrate?.([800, 400, 800, 400, 800]);
  },

  beep() {
    try {
      this.ctx ??= new AudioContext();
      for (const [f, t0] of [[880, 0], [660, 0.25], [880, 0.5]]) {
        const o = this.ctx.createOscillator();
        const g = this.ctx.createGain();
        o.frequency.value = f;
        g.gain.setValueAtTime(0.25, this.ctx.currentTime + t0);
        g.gain.exponentialRampToValueAtTime(0.001, this.ctx.currentTime + t0 + 0.22);
        o.connect(g).connect(this.ctx.destination);
        o.start(this.ctx.currentTime + t0);
        o.stop(this.ctx.currentTime + t0 + 0.23);
      }
    } catch {
      // audio blocked until the page has been tapped once
    }
  },

  stop() {
    clearInterval(this.beepTimer);
    clearInterval(this.sayTimer);
    if ('speechSynthesis' in window) speechSynthesis.cancel();
    document.getElementById('alarm-layer')?.remove();
    const a = this.active;
    this.active = null;
    return a;
  },

  open() {
    const a = this.stop();
    if (a.key !== 'test') this.snoozed[a.key] = Date.now() + S.settings.alarm.repeatMinutes * 60e3;
    if (a.route === 'low') lowFlow ??= { round: 1, step: 'recheck', returnTo: null };
    else flow = null;
    go(a.route);
  },

  snooze() {
    const a = this.stop();
    this.snoozed[a.key] = Date.now() + S.settings.alarm.repeatMinutes * 60e3;
  },
};
setInterval(() => webAlarm.check(), 15000);

// Opened from a native alarm: go straight to that dose (or the low-sugar recheck).
native.launchRoute((route) => {
  if (route === 'low') lowFlow ??= { round: 1, step: 'recheck', returnTo: null };
  else flow = null;
  go(route);
});

native.onBackButton(() => {
  if (parseRoute().name === 'home') native.exitApp();
  else history.back();
});

// --- shared pieces ---------------------------------------------------------------

// Bottom bar: two tabs, the big + (log sugar) in the middle, two tabs.
function nav(active) {
  const tab = ([route, ic, label]) =>
    `<button class="${active === route ? 'on' : ''}" data-act="go" data-to="${route}" aria-label="${t(label)}">${icon(ic)}<span>${t(label)}</span></button>`;
  if (S.settings.role === 'caregiver') {
    return `<nav class="nav nav4 noprint">${tab(['home', 'activity', 'tab_live'])}${tab(['history', 'bars', 'tab_history'])}${tab(['report', 'file', 'tab_report'])}${tab(['more', 'more', 'tab_more'])}</nav>`;
  }
  return `<nav class="nav noprint">
    ${tab(['home', 'home', 'tab_home'])}${tab(['food', 'food', 'tab_food'])}
    <button class="fab" data-act="go" data-to="reading" aria-label="${t('btn_measure')}">${icon('plus')}</button>
    ${tab(['history', 'bars', 'tab_history'])}${tab(['more', 'more', 'tab_more'])}
  </nav>`;
}

function tabPage(active, content, cls = '') {
  const offline = navigator.onLine === false
    ? `<div class="alert yellow offline-bar">${icon('wifi_off')}<div><b>${t('offline_title')}</b><br><span class="small">${t(isCaregiver() ? 'offline_cg' : 'offline_sub')}</span></div></div>`
    : '';
  return `<div class="page has-nav ${cls}">${offline}${content}</div>${nav(active)}`;
}

// Back is a labelled pill (icon + word): easier to recognise than an arrow alone.
const backBtn = () => `<button class="back-pill" data-act="back">${icon('back')}<span>${t('back_label')}</span></button>`;

function flowHead(title, step = 0) {
  const steps = step
    ? `<div class="stepper" aria-label="${step}/3">${[1, 2, 3].map((i) => `<span class="${i <= step ? 'on' : ''}"></span>`).join('')}</div>`
    : '';
  return `<header class="flow-head">${backBtn()}<div class="flow-title">${esc(title)}</div></header>${steps}`;
}

function pageHead(title) {
  return `<header class="flow-head">${backBtn()}<div class="flow-title">${esc(title)}</div></header>`;
}

// Big "done" screen after a dose: clear confirmation, what's next, and an undo.
let celebration = null;
function celebrate(c) {
  celebration = c;
  go('home');
  render();
  const mine = c;
  setTimeout(() => {
    if (celebration === mine) {
      celebration = null;
      render();
    }
  }, 7000);
}

function celebrationLayer() {
  if (!celebration) return '';
  const sched = todaySchedule();
  const next = sched.find((i) => itemStatus(i) === 'pending');
  return `<div class="celebrate" data-act="celebrate_ok">
    <div class="celebrate-check">${icon('check')}</div>
    <div class="celebrate-title">${t('well_done')}</div>
    <div class="celebrate-sub">${esc(celebration.title)}</div>
    ${next ? `<div class="celebrate-next">${icon(SLOT_ICON[next.slot])} ${t('next_up', slotName(next.slot), next.time)}</div>` : ''}
    <button class="btn btn-lg celebrate-ok" data-act="celebrate_ok">${t('ok')}</button>
    ${celebration.undo ? `<button class="link celebrate-undo" data-act="undo" data-id="${celebration.undo}">${t('undo')}</button>` : ''}
  </div>`;
}

function applyTextSize() {
  document.documentElement.dataset.size = S.settings.textSize;
}

function keypad(submitAct) {
  const keys = ['1', '2', '3', '4', '5', '6', '7', '8', '9', '.', '0', '⌫'];
  return `
    <div class="display">
      <button class="meter-key" data-act="kp" data-k="LO">LO</button>
      <div><div class="val ${kp ? '' : 'empty'}" id="kp">${esc(kp || '0.0')}</div><div class="unit">${t('mmol')}</div></div>
      <button class="meter-key" data-act="kp" data-k="HI">HI</button>
    </div>
    ${pendingCheck ? checkBox() : ''}
    <div class="keypad">${keys
      .map((k) => `<button class="key ${k === '⌫' ? 'fn' : ''}" data-act="kp" data-k="${k}">${k === '⌫' ? icon('backspace') : k}</button>`)
      .join('')}</div>
    <button class="btn btn-primary btn-lg kp-ok" data-act="${submitAct}">${icon('check')} ${t('ok')}</button>`;
}

function checkBox() {
  const c = pendingCheck;
  const msg =
    c.problem === 'mgdl' ? t('check_mgdl', c.value) : c.problem === 'big_jump' ? t('check_jump', c.value, c.last) : t('check_range');
  const buttons =
    c.problem === 'mgdl' || c.problem === 'big_jump'
      ? `<div class="actions"><button class="btn btn-primary" data-act="check_yes">${c.problem === 'mgdl' ? t('yes') : t('yes_correct')}</button>
         <button class="btn" data-act="check_no">${t('retype')}</button></div>`
      : '';
  return `<div class="alert yellow">${icon('alert')}<div>${esc(msg)}</div>${buttons}</div>`;
}

// Validates the keypad value and either saves it or asks for confirmation.
function submitReading(context, after) {
  const c = checkReading(kp, lastReading());
  if (c.ok) return saveReading(c.value, context, after);
  pendingCheck = { ...c, context, after };
  native.haptic('MEDIUM');
  render();
}

function saveReading(value, context, after) {
  kp = '';
  pendingCheck = null;
  after(persist({ type: 'reading', value, context }));
}

function statusClass(value, ctx) {
  return classify(value, rangeFor(ctx));
}

function readingBadge(value, ctx) {
  const st = statusClass(value, ctx);
  return `<div class="center"><span class="reading-badge ${st}">${icon('drop')} ${value} · ${t(`st_${st}`)}</span></div>`;
}

function alertCard(a, canAck = true) {
  const actions =
    a.level === 'red'
      ? `<a class="btn btn-danger" href="tel:999">${icon('phone')} 999</a>${telBtn(S.plan.doctor.phone, t('call_doctor'))}`
      : a.level === 'orange'
        ? telBtn(S.plan.doctor.phone, t('call_doctor'))
        : '';
  const ack = canAck && a.level !== 'info' ? `<button class="link" data-act="ack" data-key="${esc(a.key)}">${t('mark_handled')}</button>` : '';
  return `<div class="alert ${a.level}">${icon(LEVEL_ICON[a.level])}
    <div><strong>${t(`lvl_${a.level}`)}</strong>${esc(alertText(a))}</div>
    ${actions || ack ? `<div class="actions">${actions}${ack}</div>` : ''}
  </div>`;
}


// --- welcome ------------------------------------------------------------------------

// "In 1 h 20 min" before the time, a pulsing "Time now!" once it has come.
function countdown(time) {
  const [h, m] = time.split(':').map(Number);
  const mins = Math.round((new Date().setHours(h, m, 0, 0) - Date.now()) / 60000);
  if (mins <= 0) return `<span class="due-now">${t('due_now')}</span>`;
  return `<span class="due-in">${t('due_in', Math.floor(mins / 60), mins % 60)}</span>`;
}

function textSizePicker() {
  const opt = (v, label) => `<button class="${S.settings.textSize === v ? 'on' : ''}" data-act="text_size" data-v="${v}"><span class="ts-${v}">${label}</span></button>`;
  return `<div class="seg text-size">${opt('md', 'অ')}${opt('lg', 'অ+')}${opt('xl', 'অ++')}</div>`;
}

function sayBtn(text) {
  return `<button class="say-btn" data-act="say" data-text="${esc(text)}">${icon('sound')} ${t('read_aloud')}</button>`;
}

function viewWelcome() {
  const icons = ['heart', 'syringe', 'siren'];
  return `<div class="page welcome">
    <div class="logo">${icon('drop')}</div>
    <h1>${t('app_name')}</h1>
    <p class="center muted">${t('welcome_title')}</p>
    <ul class="points">${t('welcome_body')
      .map((p, i) => `<li><span class="bubble">${icon(icons[i])}</span><span>${esc(p)}</span></li>`)
      .join('')}</ul>
    <div class="section-title center">${t('text_size')}</div>
    ${textSizePicker()}
    <button class="btn btn-primary btn-lg" style="margin-top:18px" data-act="welcome">${t('welcome_ok')}</button>
    <button class="link" data-act="lang">${getLang() === 'bn' ? 'English' : 'বাংলা'}</button>
  </div>`;
}

// --- home ----------------------------------------------------------------------------

function todaySchedule() {
  const items = S.plan.doses.map((d) => ({ kind: 'dose', slot: d.id, time: d.injectAt, dose: d }));
  items.push({ kind: 'snack', slot: 'snack', time: S.plan.snackAt });
  return items.sort((a, b) => a.time.localeCompare(b.time));
}

// A meal dose not taken by the time the next dose is due must not be taken late.
function isMissed(slot) {
  const d = doseById(slot);
  if (!d || d.kind !== 'bolus') return false;
  const next = S.plan.doses
    .filter((x) => x.kind === 'bolus' && x.injectAt > d.injectAt)
    .sort((a, b) => a.injectAt.localeCompare(b.injectAt))[0];
  return !!next && hhmm(Date.now()) >= next.injectAt && !todayDose(slot);
}

function itemStatus(item) {
  if (item.kind === 'snack') {
    if (activeLog().some((e) => e.type === 'meal' && e.slot === 'snack' && isToday(e.ts))) return 'done';
    return hhmm(Date.now()) >= injectAtFor('dinner') ? 'missed' : 'pending';
  }
  const d = todayDose(item.slot);
  if (d) return d.action === 'skip' ? 'skipped' : 'done';
  return isMissed(item.slot) ? 'missed' : 'pending';
}

const basalDose = () => S.plan.doses.find((d) => d.kind === 'basal');
// Meal and injection times, also when that meal has no insulin (or none is set up yet).
const MEAL_AT = { breakfast: '08:00', lunch: '13:30', dinner: '20:30' };
const injectAtFor = (id) => doseById(id)?.injectAt ?? DEFAULT_AT[id];
const mealAtFor = (id) => doseById(id)?.mealAt ?? MEAL_AT[id];
const nightUnits = () => S.state.basal?.current ?? basalDose()?.base ?? 0;
// Units for one dose. The adjusted long-acting amount (S.state.basal) belongs to the first basal
// dose only (the one basalProposal adjusts); a second basal dose (e.g. "10+0+8") keeps its own.
const doseUnits = (d) => (d.kind === 'basal' && d.id === basalDose()?.id ? S.state.basal?.current ?? d.base : d.base);

function greeting() {
  const h = new Date().getHours();
  return t(h < 12 ? 'greet_morning' : h < 16 ? 'greet_noon' : h < 20 ? 'greet_evening' : 'greet_night');
}

// Numbers in rings use Latin digits, like the glucometer and the insulin pen.
const numL = (n) => String(n);

// Dial-style progress ring (like a watch face): a thick bar plus fine tick marks inside.
function bigRing(frac, value, label) {
  const r = 86;
  const c = 2 * Math.PI * r;
  let ticks = '';
  for (let i = 0; i < 60; i++) {
    const a = (i / 60) * 2 * Math.PI;
    const r1 = i % 5 ? 66 : 63;
    ticks += `M${(110 + Math.sin(a) * r1).toFixed(1)} ${(110 - Math.cos(a) * r1).toFixed(1)}L${(110 + Math.sin(a) * 70).toFixed(1)} ${(110 - Math.cos(a) * 70).toFixed(1)}`;
  }
  return `<svg class="big-ring" viewBox="0 0 220 220" role="img" aria-label="${esc(value)} ${esc(label)}">
    <circle class="track" cx="110" cy="110" r="${r}" fill="none" stroke-width="16"/>
    <circle class="bar" cx="110" cy="110" r="${r}" fill="none" stroke-width="16" stroke-linecap="round"
      stroke-dasharray="${c.toFixed(1)}" stroke-dashoffset="${(c * (1 - Math.min(1, frac))).toFixed(1)}" transform="rotate(-90 110 110)"/>
    <path class="ticks" d="${ticks}" stroke-width="1.6" stroke-linecap="round"/>
    <text class="pct" x="110" y="117" text-anchor="middle">${esc(value)}</text>
    <text class="lbl" x="110" y="141" text-anchor="middle">${esc(label)}</text>
  </svg>`;
}

const TONE = { ok: 'var(--ok)', warn: 'var(--warn)', danger: 'var(--danger)', primary: 'var(--primary)', muted: 'var(--line)' };

function miniRing(frac, text, tone, label, act, to) {
  const r = 24;
  const c = 2 * Math.PI * r;
  return `<button class="mini ${tone}" data-act="${act}" data-to="${to}">
    <svg viewBox="0 0 58 58" aria-hidden="true">
      <circle class="track" cx="29" cy="29" r="${r}" fill="none" stroke-width="5"/>
      <circle cx="29" cy="29" r="${r}" fill="none" stroke-width="5" stroke-linecap="round" style="stroke:${TONE[tone]}"
        stroke-dasharray="${c.toFixed(1)}" stroke-dashoffset="${(c * (1 - Math.min(1, Math.max(0, frac)))).toFixed(1)}" transform="rotate(-90 29 29)"/>
      <text x="29" y="34" text-anchor="middle">${esc(text)}</text>
    </svg>
    <span class="ml">${esc(label)}</span>
  </button>`;
}

function viewHome() {
  if (isCaregiver()) return viewFamily();
  flow = lowFlow = highFlow = readingFlow = foodFlow = pantryDraft = null;
  const alerts = currentAlerts().filter((a) => a.level !== 'info');
  const sched = todaySchedule();
  const statuses = sched.map(itemStatus);
  const doneCount = statuses.filter((s) => s === 'done' || s === 'skipped').length;
  const next = sched.find((_, i) => statuses[i] === 'pending');
  const now = hhmm(Date.now());
  const basal = basalProposal(S.plan, S.state.basal, activeLog());
  const last = lastReading();
  const lastToday = last && isToday(last.ts);
  const lang = getLang() === 'bn' ? 'bn-BD' : 'en-GB';
  const today = new Date();

  // Mini rings: last sugar, calories eaten, insulin doses taken.
  const sugarTone = lastToday ? { in_range: 'ok', high: 'warn', very_high: 'warn', low: 'danger', severe_low: 'danger', below_target: 'primary' }[statusClass(last.value, last.context)] : 'muted';
  const kcal = Object.values(eatenToday()).reduce((a, b) => a + b, 0);
  const kcalFrac = kcal / S.plan.diet.kcalTarget;
  const insulinTaken = S.plan.doses.filter((d) => todayDose(d.id) && todayDose(d.id).action !== 'skip').length;
  const minis = `<div class="mini-rings">
    ${miniRing(lastToday ? 1 : 0, lastToday ? String(last.value) : '·', sugarTone, t('mini_sugar'), 'go', 'reading')}
    ${miniRing(kcalFrac, `${numL(Math.round(kcalFrac * 100))}%`, kcal > S.plan.diet.kcalMax ? 'danger' : 'warn', t('mini_kcal'), 'food_log', '')}
    ${miniRing(S.plan.doses.length ? insulinTaken / S.plan.doses.length : 0, `${numL(insulinTaken)}/${numL(S.plan.doses.length)}`, 'primary', t('mini_insulin'), 'go', 'history')}
  </div>`;

  const nextPill = next
    ? `<button class="next-pill" data-act="start" data-slot="${next.slot}">
        <span class="bubble">${icon(next.kind === 'dose' ? 'syringe' : SLOT_ICON[next.slot])}</span>
        <span><span class="t1" style="display:block">${slotName(next.slot)}${
          next.kind === 'dose' ? ` · ${t(`ins_${next.dose.insulin}`)} ${doseUnits(next.dose)}` : ''
        }</span><span class="t2" style="display:block">${next.time} · ${countdown(next.time)}</span></span>
        ${icon('chev')}
      </button>`
    : `<div class="next-pill done"><span class="bubble">${icon('check')}</span><span class="t1">${t('all_done')}</span></div>`;

  const schedule = sched
    .map((item, i) => {
      const st = statuses[i];
      const d = item.kind === 'dose' ? todayDose(item.slot) : null;
      const badge =
        st === 'done'
          ? `<span class="badge done">${icon('check')} ${d ? `${d.units} ${t('units')}` : t('done')}</span>`
          : st === 'skipped' || st === 'missed'
            ? `<span class="badge">·</span>`
            : item.time < now
              ? `<span class="badge late">${t('missed')}</span>`
              : `<span class="badge">${item.time}</span>`;
      const sub = item.kind === 'dose' ? `${item.time} · ${t(`ins_${item.dose.insulin}`)}` : item.time;
      return `<div class="sched-row ${st}" data-act="start" data-slot="${item.slot}">
        <span class="bubble">${icon(SLOT_ICON[item.slot])}</span>
        <div><div class="sched-name">${slotName(item.slot)}</div><div class="sched-time">${sub}</div></div>
        ${badge}
      </div>`;
    })
    .join('');

  return tabPage(
    'home',
    `<header class="home-head">
      <div>
        <div class="home-day">${today.toLocaleDateString(lang, { weekday: 'long' })}</div>
        <div class="home-sub">${greeting()}, ${esc(S.plan.patient.name)} · ${today.toLocaleDateString(lang, { day: 'numeric', month: 'long' })}</div>
      </div>
      <button class="round-btn" data-act="go" data-to="report" aria-label="${t('btn_report')}">${icon('stethoscope')}</button>
    </header>
    ${mineBanner()}
    ${(S.plan.meds ?? []).length || S.plan.doses.length ? '' : `<button class="card med-start" data-act="go" data-to="med/new"><span class="med-ic pen">${icon('syringe')}</span><span><b>${t('med_start')}</b><span>${t('med_start_sub')}</span></span>${icon('chev')}</button>`}
    ${alerts.map((a) => alertCard(a)).join('')}
    ${basal.reason === 'need_3am' ? `<div class="alert info">${icon('moon')}<div>${t('basal_need_3am')}</div></div>` : ''}
    ${stockStatus(S.state.stock ?? {}, S.log.filter((e) => !e.deleted), S.plan.meds ?? [])
      .filter((s) => s.warn)
      .map((s) => `<button class="alert yellow stock-alert" data-act="go" data-to="stock">${icon('box')}<div><strong>${esc(s.name ?? t(`s_${s.id}`))}</strong>${t(s.warn === 'replace' ? 'warn_replace' : 'warn_buy')}</div></button>`)
      .join('')}
    ${S.settings.meter && meterSupported()
      ? `<button class="meter-big" data-act="ms_start"><span class="mb-ic">${icon('bluetooth')}</span><span><b>${t('ms_title')}</b><span>${S.settings.meter.lastSync ? t('ms_last', ago(S.settings.meter.lastSync)) : t('ms_first')}</span></span>${icon('chev')}</button>`
      : ''}
    <section class="card ring-card">
      ${bigRing(doneCount / sched.length, `${numL(Math.round((doneCount / sched.length) * 100))}%`, t('ring_label'))}
      ${nextPill}
    </section>
    ${minis}
    <div class="pill-row">
      <button class="pill-btn coral" data-act="go" data-to="low">${icon('down')} ${t('low_tile')}</button>
      <button class="pill-btn lav" data-act="go" data-to="high">${icon('up')} ${t('high_tile')}</button>
    </div>
    ${
      today.getHours() >= 18 && homeFoods()
        ? `<button class="card tomorrow-card" data-act="tomorrow"><span class="bubble">${icon('chef')}</span>
            <div><b>${t('tomorrow_title')}</b><div class="muted small">${t('tomorrow_card')}</div></div>${icon('chev')}</button>`
        : ''
    }
    <div class="section-title">${t('today_schedule')}</div>
    <section class="card schedule">${schedule}</section>
    ${S.plan.doses.length || generalTimes(S.plan.meds ?? []).length ? `<button class="btn btn-soft" data-act="go" data-to="dosebook">${icon('check')} ${t('db_open')}</button>` : ''}
    ${sync.status.state === 'error' ? `<p class="muted small center">Sync: ${esc(sync.status.error)}</p>` : ''}`,
  );
}

// --- dose flow: guard | missed | reading → (symptoms) → meal → result | skip --------------

function viewDose(slot) {
  const dose = doseById(slot);
  if (!dose) return viewHome();
  if (!flow || flow.slot !== slot) {
    const prev = todayDose(slot);
    const step = prev ? 'guard' : isMissed(slot) ? 'missed' : 'reading';
    flow = { slot, step, prev, reading: null, readingRec: null, meal: null, units: null, tabs: new Set(), sym: new Set() };
  }
  const title = slotName(slot);
  const linoBox = (S.plan.tablets ?? [])
    .filter((x) => x.with === slot)
    .map((x) => `<label class="check-row"><input type="checkbox" data-act="tab_pick" data-id="${esc(x.id)}" ${flow.tabs?.has(x.id) ? 'checked' : ''}>${icon('pill')} ${t('took_tab', esc(x.name), amountText(x.amount ?? 1))}</label>`)
    .join('');
  const basal = dose.kind === 'basal';

  switch (flow.step) {
    case 'guard': {
      const p = flow.prev;
      return `<div class="page">${flowHead(title)}
        <div class="alert ${p.action === 'skip' ? 'info' : 'orange'}">${icon(p.action === 'skip' ? 'info' : 'alert')}
          <div><strong>${p.action === 'skip' ? t('already_skipped', hhmm(p.ts)) : t('already_taken', hhmm(p.ts), p.units)}</strong></div></div>
        <button class="btn btn-primary btn-lg" data-act="home">${icon('home')} ${t('home')}</button>
        <button class="link" data-act="fix_mistake">${t('fix_mistake')}</button>
      </div>`;
    }
    case 'missed':
      return `<div class="page">${flowHead(title)}
        <div class="alert orange">${icon('clock')}<div><strong>${t('missed_title')}</strong>${t('missed_body')}</div></div>
        ${telBtn(S.plan.doctor.phone, t('call_doctor'))}
        <button class="btn btn-primary btn-lg" data-act="home">${icon('home')} ${t('home')}</button>
      </div>`;
    case 'reading':
      return `<div class="page">${flowHead(title, 1)}
        <div class="q">${basal ? t('reading_bedtime') : t('reading_for', slotName(slot))}</div>
        <div class="q-sub">${t('enter_reading')}</div>
        ${meterButton('dose_meter')}
        ${keypad('dose_reading')}
        <button class="link" data-act="dose_no_reading">${t('skip_reading')}</button>
      </div>`;
    case 'symptoms':
      return symptomsView(title, flow.sym, 'dose_sym_done', flow.reading);
    case 'red':
      return redView(title);
    case 'meal':
      return `<div class="page">${flowHead(title, 2)}
        ${flow.reading != null ? readingBadge(flow.reading, CTX_FOR_SLOT[slot]) : ''}
        <div class="q">${t('meal_question')}</div>
        <div class="choices" style="margin-top:16px">
          <button class="choice" data-act="meal" data-size="normal"><span class="bubble">${icon('bowl')}</span><b>${t('meal_normal')}</b>${icon('chev')}</button>
          <button class="choice" data-act="meal" data-size="small"><span class="bubble">${icon('bowlSmall')}</span><b>${t('meal_small')}</b>${icon('chev')}</button>
          <button class="choice danger" data-act="meal" data-size="none"><span class="bubble">${icon('none')}</span><b>${t('meal_none')}</b>${icon('chev')}</button>
        </div>
      </div>`;
    case 'skip':
      return `<div class="page">${flowHead(title, 3)}
        <div class="alert orange">${icon('none')}<div><strong>${t('skip_title')}</strong>${t('skip_body')}</div></div>
        ${linoBox}
        <button class="btn btn-primary btn-lg" data-act="skip_ok">${icon('check')} ${t('skip_ok')}</button>
      </div>`;
    case 'result':
      return basal ? basalResult(title, dose) : bolusResult(title, dose, linoBox);
  }
  return viewHome();
}

function doseHero(units, dose, adjustable) {
  const minus = adjustable ? `<button class="round" data-act="units" data-d="-1" ${units <= 0 ? 'disabled' : ''} aria-label="-1">${icon('minus')}</button>` : '';
  const plus = adjustable ? `<button class="round" data-act="units" data-d="1" aria-label="+1">${icon('plus')}</button>` : '';
  const med = (S.plan.meds ?? []).find((m) => m.id === dose.medId);
  const cue = med ? t(`cue_${med.type}`) : t(`cue_${dose.insulin}`);
  const when = t(dose.kind === 'basal' ? 'when_lantus' : 'when_actrapid');
  const outside = units < dose.min || units > dose.max;
  flow.site ??= nextSite(activeLog(), dose.insulin, dose.kind);
  const spoken = t('say_dose', units, t(`ins_${dose.insulin}`), t(`site_${flow.site}`));
  return `<section class="dose-hero">
    <div class="hero-row"><div class="label">${t('take_now')}</div>${sayBtn(spoken)}</div>
    <div class="dose-row">${minus}<div>${adjustable ? `<input id="flow-units" class="dose-num dose-num-input" type="number" inputmode="numeric" min="0" max="100" value="${units}" aria-label="${t('units')}">` : `<div class="dose-num">${units}</div>`}<div class="dose-unit">${t('units')} ${t(`ins_${dose.insulin}`)}</div></div>${plus}</div>
    ${adjustable ? `<div class="hero-hint">${t('type_units_hint')}</div>` : ''}
    <div class="chip-row">
      <span class="chip-glass"><span class="vial ${dose.insulin}"></span>${cue}</span>
      <span class="chip-glass">${icon('clock')}${when}</span>
      <span class="chip-glass ${outside ? 'chip-warn' : ''}">${outside ? `${icon('alert')} ${t('outside_note', dose.min, dose.max)}` : t('range_note', dose.min, dose.max)}</span>
    </div>
  </section>`;
}

// Body map (front view, so the patient's left is on the viewer's right).
const SITE_SHAPES = {
  abd_ur: 'x="58" y="38" width="38" height="28"',
  abd_ul: 'x="104" y="38" width="38" height="28"',
  abd_lr: 'x="58" y="74" width="38" height="28"',
  abd_ll: 'x="104" y="74" width="38" height="28"',
  thigh_r: 'x="58" y="132" width="38" height="78"',
  thigh_l: 'x="104" y="132" width="38" height="78"',
};

function siteCard(dose) {
  flow.site ??= nextSite(activeLog(), dose.insulin, dose.kind);
  const mine = dose.kind === 'basal' ? ['thigh_l', 'thigh_r'] : ['abd_ul', 'abd_ur', 'abd_lr', 'abd_ll'];
  const zones = Object.entries(SITE_SHAPES)
    .map(([id, attrs]) => {
      const cls = id === flow.site ? 'zone on' : mine.includes(id) ? 'zone' : 'zone off';
      const act = mine.includes(id) ? `data-act="site" data-s="${id}"` : '';
      return `<rect ${attrs} rx="10" class="${cls}" ${act}/>`;
    })
    .join('');
  const tip = dose.kind === 'basal' ? t('site_tip_thigh') : t('site_tip_abd');
  return `<section class="card site-card">
    <svg class="body-map" viewBox="0 0 200 220" aria-hidden="true">
      <rect x="46" y="8" width="108" height="112" rx="34" class="skin"/>
      <rect x="52" y="116" width="46" height="100" rx="20" class="skin"/>
      <rect x="102" y="116" width="46" height="100" rx="20" class="skin"/>
      ${zones}
      <circle cx="100" cy="70" r="3.5" class="navel"/>
      <text x="24" y="70" class="side">${t('right')}</text><text x="176" y="70" class="side" text-anchor="end">${t('left')}</text>
    </svg>
    <div>
      <div class="eyebrow">${icon('syringe')} ${t('site_title')}</div>
      <div class="site-name">${t(`site_${flow.site}`)}</div>
      <p class="small muted">${tip}</p>
      <p class="small muted">${t('site_change')}</p>
    </div>
  </section>`;
}

function bolusResult(title, dose, linoBox) {
  const s = suggestBolus(S.plan, dose.id, flow.reading, flow.meal);
  flow.units ??= s.units;
  const reasons = [t('r_base', s.base), ...s.reasons.map((r) => t(`r_${r.code}`, r.delta, r.reading))];
  return `<div class="page">${flowHead(title, 3)}
    ${doseHero(flow.units, dose, true)}
    ${siteCard(dose)}
    ${s.limitHit ? `<div class="alert yellow">${icon('alert')}<div><strong>${t('lvl_yellow')}</strong>${t('limit_hit', s.wanted, s.units)}</div></div>` : ''}
    <div class="alert info">${icon('food')}<div>${t('must_eat')}</div></div>
    <details class="why"><summary>${t('show_why')}</summary><ul>${reasons.map((r) => `<li>${esc(r)}</li>`).join('')}</ul></details>
    ${linoBox}
    ${takenAtRow()}
    <button class="btn btn-primary btn-lg" data-act="dose_taken">${icon('check')} ${t('taken')}</button>
  </div>`;
}

// "When was it taken": now, or an earlier time today.
function takenAtRow() {
  flow.at ??= hhmm(Date.now());
  return `<div class="taken-at"><span>${icon('clock')} ${t('taken_at')}</span><input id="flow-at" type="time" value="${flow.at}"></div>`;
}

// Read the typed amount and time before redrawing or saving.
function readFlowInputs() {
  const raw = document.getElementById('flow-units')?.value ?? '';
  const u = Number(raw);
  if (raw.trim() !== '' && Number.isFinite(u)) flow.units = Math.max(0, Math.min(100, Math.round(u)));
  const at = document.getElementById('flow-at')?.value;
  if (at) flow.at = at;
}
const flowTs = () => {
  const [h, m] = String(flow.at || hhmm(Date.now())).split(':').map(Number);
  const d = new Date();
  d.setHours(h, m, 0, 0);
  if (d.getTime() - Date.now() > 3600000) d.setDate(d.getDate() - 1);
  return Math.min(d.getTime(), Date.now());
};

function basalResult(title, dose) {
  const p = basalProposal(S.plan, S.state.basal, activeLog());
  let proposal = '';
  if (p.change !== 0 && !flow.basalDecided) {
    const why = p.reason === 'low' ? t('basal_r_low') : t(`basal_r_${p.reason}`, p.avg);
    proposal = `<div class="alert yellow">${icon('sliders')}
      <div><strong>${t('basal_change', p.current, p.proposed)}</strong>${esc(why)}${p.limitHit ? `<br>${t('basal_limit', p.proposed)}` : ''}</div>
      <div class="actions"><button class="btn btn-primary" data-act="basal_accept">${t('accept_change')}</button>
      <button class="btn" data-act="basal_keep">${t('keep_same')}</button></div></div>`;
  } else if (p.limitHit) {
    if (!S.state.basal?.limitHitAt || !isToday(S.state.basal.limitHitAt)) {
      S.state.basal = { current: p.current, lastChange: S.state.basal?.lastChange ?? 0, limitHitAt: Date.now() };
      saveState();
      dispatchAlerts();
    }
    proposal = `<div class="alert yellow">${icon('alert')}<div>${t('basal_limit', p.current)}</div></div>`;
  } else if (p.reason === 'need_3am') {
    proposal = `<div class="alert info">${icon('moon')}<div>${t('basal_need_3am')}</div></div>`;
  }
  const pending = p.change !== 0 && !flow.basalDecided;
  return `<div class="page">${flowHead(title, 3)}
    ${flow.reading != null ? readingBadge(flow.reading, 'bedtime') : ''}
    ${proposal}
    ${doseHero((flow.units ??= doseUnits(dose)), dose, true)}
    ${siteCard(dose)}
    ${takenAtRow()}
    <button class="btn btn-primary btn-lg" style="margin-top:16px" data-act="dose_taken" ${pending ? 'disabled' : ''}>${icon('check')} ${t('taken')}</button>
  </div>`;
}

function symptomsView(title, set, doneAct, value) {
  const syms = ['vomiting', 'confusion', 'breathing', 'thirst', 'pain'];
  return `<div class="page">${flowHead(title)}
    ${value != null ? `<div class="center"><span class="reading-badge very_high">${icon('drop')} ${value}</span></div>` : ''}
    <div class="q">${t('high_symptoms_q')}</div>
    <div style="margin-top:14px">${syms
      .map((s) => `<label class="check-row"><input type="checkbox" data-act="sym" data-s="${s}" ${set.has(s) ? 'checked' : ''}> ${t(`sym_${s}`)}</label>`)
      .join('')}</div>
    <button class="btn btn-primary btn-lg" data-act="${doneAct}">${set.size ? t('ok') : t('no_symptoms')}</button>
  </div>`;
}

function redView(title) {
  return `<div class="page">${flowHead(title)}
    <section class="emergency-head"><span class="bubble">${icon('siren')}</span><h1>${t('lvl_red')}</h1></section>
    <div class="alert red" style="margin-top:14px">${icon('alert')}<div>${t('high_red')}</div></div>
    ${callButtons()}
  </div>`;
}

// --- low: treat → timer → recheck → ok | (treat again) → fail ; severe at any time ---------

const TIMER_MS = 15 * 60 * 1000;

function viewLow() {
  lowFlow ??= { round: 1, step: 'treat', returnTo: null, timerEnd: 0 };
  const severeBtn = `<button class="btn btn-outline-danger" style="margin-top:12px" data-act="severe">${icon('siren')} ${t('severe_btn')}</button>`;
  const head = (title, ic = 'down') =>
    `<div class="page">${pageHead('')}<section class="emergency-head"><span class="bubble">${icon(ic)}</span><h1>${title}</h1></section>`;
  switch (lowFlow.step) {
    case 'treat':
      return `${head(t('low_title'))}
        <ol class="steps red">
          <li>${lowFlow.round > 1 ? t('low_round2') : t('low_step1')}</li>
          <li>${t('low_step2')}</li>
        </ol>
        ${sayBtn(`${lowFlow.round > 1 ? t('low_round2') : t('low_step1')} ${t('low_step2')}`)}
        <button class="btn btn-primary btn-lg" data-act="low_timer">${icon('clock')} ${t('low_start_timer')}</button>
        ${severeBtn}</div>`;
    case 'timer':
      return `<div class="page">${pageHead(t('low_title'))}
        <div class="q">${t('low_timer')}</div>
        <div class="timer-wrap">${timerRing(lowFlow.timerEnd - Date.now())}</div>
        <p class="center muted">${t('low_step2')}</p>
        <button class="btn btn-soft" data-act="low_skip_wait">${t('low_recheck')}</button>
        ${severeBtn}</div>`;
    case 'recheck':
      return `<div class="page">${pageHead(t('low_title'))}<div class="q">${t('low_recheck')}</div><div style="height:12px"></div>${keypad('low_reading')}${severeBtn}</div>`;
    case 'ok':
      return `<div class="page">${pageHead(t('low_title'))}
        <section class="card done-card"><span class="bubble">${icon('check')}</span><b style="font-size:1.3rem">${t('low_ok')}</b></section>
        <div class="alert info">${icon('food')}<div>${t('low_after')}</div></div>
        ${
          lowFlow.returnTo
            ? `<button class="btn btn-primary btn-lg" data-act="low_continue">${icon('syringe')} ${t('low_continue_dose')}</button>`
            : `<button class="btn btn-primary btn-lg" data-act="home">${icon('home')} ${t('home')}</button>`
        }</div>`;
    case 'fail':
      return `${head(t('lvl_red'), 'siren')}<div class="alert red" style="margin-top:14px">${icon('alert')}<div>${t('not_recovering')}</div></div>${callButtons()}</div>`;
    case 'severe':
      return `${head(t('severe_title'), 'siren')}
        <ol class="steps red"><li>${t('severe_1')}</li><li>${t('severe_2')}</li><li>${t('severe_3')}</li><li>${t('severe_4')}</li></ol>
        ${callButtons()}</div>`;
  }
  return viewHome();
}

function timerRing(leftMs) {
  const r = 96;
  const c = 2 * Math.PI * r;
  const left = Math.max(0, leftMs);
  const off = c * (1 - left / TIMER_MS);
  const label = `${String(Math.floor(left / 60000)).padStart(2, '0')}:${String(Math.floor((left % 60000) / 1000)).padStart(2, '0')}`;
  return `<svg class="timer-ring" viewBox="0 0 220 220" aria-label="${label}">
    <circle class="track" cx="110" cy="110" r="${r}" fill="none" stroke-width="14"/>
    <circle class="bar" id="timer-bar" cx="110" cy="110" r="${r}" fill="none" stroke-width="14" stroke-linecap="round"
      stroke-dasharray="${c.toFixed(1)}" stroke-dashoffset="${off.toFixed(1)}" transform="rotate(-90 110 110)"/>
    <text id="timer" x="110" y="122" text-anchor="middle">${label}</text>
  </svg>`;
}

function startTimer() {
  const c = 2 * Math.PI * 96;
  const tick = () => {
    const left = Math.max(0, lowFlow.timerEnd - Date.now());
    const txt = document.getElementById('timer');
    const bar = document.getElementById('timer-bar');
    if (txt) txt.textContent = `${String(Math.floor(left / 60000)).padStart(2, '0')}:${String(Math.floor((left % 60000) / 1000)).padStart(2, '0')}`;
    if (bar) bar.setAttribute('stroke-dashoffset', (c * (1 - left / TIMER_MS)).toFixed(1));
    if (left <= 0) {
      clearInterval(timerHandle);
      navigator.vibrate?.([400, 200, 400, 200, 400]);
      native.haptic('HEAVY');
      lowFlow.step = 'recheck';
      render();
    }
  };
  tick();
  timerHandle = setInterval(tick, 1000);
}

// --- high: reading → symptoms → advice | red -----------------------------------------------

function viewHigh() {
  highFlow ??= { step: 'reading', rec: null, sym: new Set() };
  const title = t('high_title');
  switch (highFlow.step) {
    case 'reading':
      return `<div class="page">${flowHead(title)}<div class="q">${t('enter_reading')}</div><div style="height:12px"></div>${keypad('high_reading')}
        <button class="link" data-act="high_no_reading">${t('skip_reading')}</button></div>`;
    case 'symptoms':
      return symptomsView(title, highFlow.sym, 'high_sym_done', highFlow.rec?.value);
    case 'red':
      return redView(title);
    case 'advice': {
      const v = highFlow.rec?.value;
      const sick = highFlow.sym.size > 0;
      return `<div class="page">${flowHead(title)}
        ${v != null ? readingBadge(v, highFlow.rec.context) : ''}
        ${v > LIMITS.VERY_HIGH || sick ? `<div class="alert orange">${icon('phone')}<div><strong>${t('lvl_orange')}</strong>${t('high_very')}</div>${S.plan.doctor.phone ? `<div class="actions">${telBtn(S.plan.doctor.phone, t('call_doctor'))}</div>` : ''}</div>` : ''}
        <ol class="steps">${t('high_advice').map(stepLi).join('')}</ol>
        <button class="btn btn-primary btn-lg" data-act="home">${icon('check')} ${t('ok')}</button></div>`;
    }
  }
  return viewHome();
}

// --- glucose meter (Bluetooth) ---------------------------------------------------------------

const minutesOf = (hm) => {
  const [h, m] = hm.split(':').map(Number);
  return h * 60 + m;
};

// What a meter reading was, from its meal marker or else from the time of day.
function contextAt(ts, meal) {
  if (meal === 3) return 'fasting';
  if (meal === 5) return 'bedtime';
  if (meal === 2) return 'post_meal';
  const d = new Date(ts);
  const m = d.getHours() * 60 + d.getMinutes();
  if (d.getHours() < 5) return 'night_3am';
  const near = (id) => Math.abs(m - minutesOf(injectAtFor(id))) <= 60;
  if (near('breakfast') || m < minutesOf(injectAtFor('breakfast'))) return 'fasting';
  if (near('lunch')) return 'pre_lunch';
  if (near('dinner')) return 'pre_dinner';
  if (m >= minutesOf(injectAtFor('night')) - 60) return 'bedtime';
  for (const id of ['breakfast', 'lunch', 'dinner']) {
    const after = m - minutesOf(mealAtFor(id));
    if (after >= 90 && after <= 180) return 'post_meal';
  }
  return 'other';
}

let meterBusy = false;
let lastAutoSync = 0;

// Pulls new readings from the paired meter. Returns { added: [records], error }.
async function syncMeter({ quiet = false } = {}) {
  const M = S.settings.meter;
  if (!M || !meterSupported()) return { added: [] };
  if (meterBusy) return { added: [], error: 'busy' }; // another try is running: try again shortly
  meterBusy = true;
  native.setMeterConfig({ busyUntil: Date.now() + 45000 }); // the phone's own reader waits meanwhile
  try {
    const recs = await readMeter(M.deviceId, M.lastSeq ?? null, quiet ? 15000 : 25000, !quiet);
    const added = [];
    for (const r of recs) {
      if (!(r.mmol >= 1 && r.mmol <= 34)) continue;
      const id = `meter-${r.seq}-${r.ts}`;
      if (S.log.some((e) => e.id === id)) continue;
      added.push(persist({ id, type: 'reading', value: r.mmol, context: contextAt(r.ts, r.meal), ts: r.ts, source: 'meter', seq: r.seq }));
    }
    const maxSeq = recs.reduce((a, r) => Math.max(a, r.seq), M.lastSeq ?? -1);
    S.settings.meter = { ...M, lastSeq: maxSeq >= 0 ? maxSeq : M.lastSeq, lastSync: Date.now() };
    save(S);
    native.setMeterConfig({ deviceId: M.deviceId, lastSeq: S.settings.meter.lastSeq ?? -1 });
    return { added };
  } catch (e) {
    return { added: [], error: e?.message ?? String(e) };
  } finally {
    meterBusy = false;
    native.setMeterConfig({ busyUntil: 0 });
  }
}

// The CONTOUR turns itself off after 10–20 s, so a tap keeps trying for a while and connects
// as soon as the meter is switched on. Returns like syncMeter.
const METER_WAIT_MS = 90000;
async function syncMeterWait(isCancelled = () => false, { ms = METER_WAIT_MS, quiet = false } = {}) {
  const until = Date.now() + ms;
  let last = { added: [] };
  while (Date.now() < until && !isCancelled()) {
    last = await syncMeter({ quiet });
    if (!last.error || last.error === 'bluetooth_off') return last;
    await new Promise((r) => setTimeout(r, 1500));
  }
  return last;
}

// After a sync: a fresh low reading goes straight to the low-sugar steps.
function afterMeterSync(added) {
  const fresh = added.filter((r) => Date.now() - r.ts < 20 * 60000).sort((a, b) => b.ts - a.ts)[0];
  if (fresh && fresh.value < LIMITS.HYPO && parseRoute().name !== 'low') {
    lowFlow = { round: 1, step: 'treat', returnTo: null };
    go('low');
    return true;
  }
  return false;
}

// On opening the app: quietly keep trying for 30 s (she has often just measured, so the meter
// is still on). No Bluetooth prompt; stops if the big sync button takes over.
let meterLink = { state: '', autoAt: 0 }; // automatic sync status from the phone (MeterLink)

// Results the phone read from the meter by itself (right after a test, even with the app closed).
async function importMeterPending() {
  if (!native.isNative || isCaregiver()) return;
  const r = await native.meterPending();
  if (!r) return;
  const added = [];
  for (const rec of r.records ?? []) {
    if (S.log.some((e) => e.id === rec.id)) continue;
    const dup = rec.type === 'dose' && rec.slot && activeLog().some((e) => e.type === 'dose' && e.slot === rec.slot && dayKey(e.ts) === dayKey(rec.ts));
    if (dup) {
      persist({ ...rec, deleted: true, duplicate: true }); // keeps the other phones in step
      continue;
    }
    added.push(persist(rec));
  }
  const M = S.settings.meter;
  if (M) S.settings.meter = { ...M, lastSeq: Math.max(M.lastSeq ?? -1, r.lastSeq ?? -1), lastSync: Math.max(M.lastSync ?? 0, r.lastSync ?? 0) };
  meterLink = { state: r.link ?? '', autoAt: r.autoAt ?? 0 };
  save(S);
  const readings = added.filter((x) => x.type === 'reading');
  if (added.some((x) => x.type === 'dose')) updateGuard();
  if (readings.length) {
    toast = t('meter_new', readings.length);
    if (!afterMeterSync(readings)) softRender();
  } else if (added.length) softRender();
}
// while the app is open, results read by the phone show up within a few seconds
setInterval(() => document.visibilityState === 'visible' && importMeterPending(), 8000);

async function autoSyncMeter() {
  await importMeterPending();
  if (!S.settings.meter || isCaregiver() || Date.now() - lastAutoSync < 2 * 60000) return;
  lastAutoSync = Date.now();
  const { added = [] } = await syncMeterWait(() => !!meterRun || document.visibilityState !== 'visible', { ms: 30000, quiet: true });
  if (!added.length) return;
  if (afterMeterSync(added)) return;
  toast = t('meter_new', added.length);
  softRender();
}

const meterError = (err) => (err === 'bluetooth_off' ? t('meter_bt_off') : t('meter_fail'));

let meterWaiting = false;
function meterButton(act) {
  if (!S.settings.meter || !meterSupported()) return '';
  return `<button class="btn btn-soft meter-btn" data-act="${act}" ${meterWaiting ? 'disabled' : ''}>${icon('bluetooth')} ${meterWaiting ? t('ms_turn_on_short') : t('meter_from')}</button>`;
}

// --- One big button: get readings from the meter (made for older parents) --------------------
let meterRun = null; // { state: 'waiting' | 'done' | 'failed', added, error, started, cancelled }

function viewMeterSync() {
  const R = meterRun;
  if (!R) return viewHome();
  const lang = getLang() === 'bn' ? 'bn-BD' : 'en-GB';
  let body;
  if (R.state === 'waiting') {
    const left = Math.max(0, Math.ceil((R.started + METER_WAIT_MS - Date.now()) / 1000));
    body = `<div class="ms-orb"><span>${icon('bluetooth')}</span></div>
      <h2>${t('ms_turn_on')}</h2>
      <p class="ms-wait">${t('ms_trying', loc(left))}</p>
      <button class="btn btn-lg" data-act="ms_cancel">${t('cancel')}</button>
      <div class="ms-help-title">${t('ms_how')}</div>
      <ol class="ms-steps">${t('ms_steps').map((x, i) => `<li><b>${loc(i + 1)}</b><span>${esc(x)}</span></li>`).join('')}</ol>`;
  } else if (R.state === 'done') {
    const list = R.added
      .slice()
      .sort((a, b) => b.ts - a.ts)
      .map((r) => {
        const rec = S.log.find((e) => e.id === r.id) ?? r;
        return `<li class="${people().length ? 'with-whose' : ''}"><span class="ms-val ${statusClass(r.value, r.context)}">${r.value}</span><div><b>${t(`ctx_${r.context}`)}</b><span>${new Date(r.ts).toLocaleString(lang, { day: 'numeric', month: 'short', hour: 'numeric', minute: '2-digit', hour12: true })}</span></div>${whoseChips(rec)}</li>`;
      })
      .join('');
    body = `<div class="ms-orb ok"><span>${icon('check')}</span></div>
      <h2>${R.added.length ? t('ms_got', loc(R.added.length)) : t('ms_none')}</h2>
      ${list ? `<ul class="ms-list">${list}</ul>` : `<p class="muted center">${t('ms_none_sub')}</p>`}
      <button class="btn btn-primary btn-lg" data-act="ms_done">${icon('check')} ${t('ok')}</button>`;
  } else {
    body = `<div class="ms-orb bad"><span>${icon('alert')}</span></div>
      <h2>${R.error === 'bluetooth_off' ? t('meter_bt_off') : t('ms_not_found')}</h2>
      <button class="btn btn-primary btn-lg" data-act="ms_start">${icon('refresh')} ${t('ms_again')}</button>
      <button class="btn" data-act="ms_cancel">${t('cancel')}</button>
      ${R.error === 'bluetooth_off' ? '' : `<div class="ms-help-title">${t('ms_how')}</div><ul class="ms-tips">${t('ms_tips').map((x) => `<li>${icon('info')}<span>${esc(x)}</span></li>`).join('')}</ul>`}`;
  }
  return `<div class="page meter-sync">${pageHead(t('ms_head'))}<section class="ms-card">${body}</section></div>`;
}

async function startMeterRun() {
  const run = { state: 'waiting', added: [], error: '', started: Date.now(), cancelled: false };
  meterRun = run;
  go('metersync');
  const tick = setInterval(() => {
    if (meterRun !== run || run.state !== 'waiting') return clearInterval(tick);
    if (parseRoute().name === 'metersync') render();
  }, 1000);
  const res = await syncMeterWait(() => run.cancelled);
  clearInterval(tick);
  if (run.cancelled || meterRun !== run) return;
  if (res.error) Object.assign(run, { state: 'failed', error: res.error });
  else Object.assign(run, { state: 'done', added: res.added });
  if (parseRoute().name === 'metersync') render();
}

// Our own scan list: nearby meters found by name (e.g. "contour75949449") or glucose service.
let meterScan = null;
let stopMeterScan = null;
function meterScanList() {
  const M = meterScan;
  if (!M) return `<button class="btn btn-primary btn-lg" data-act="meter_scan">${icon('bluetooth')} ${t('meter_find')}</button>`;
  const list = M.found
    .map(
      (d) => `<button class="scan-item" data-act="meter_pick" data-id="${esc(d.deviceId)}" data-name="${esc(d.name)}" ${meterBusy ? 'disabled' : ''}>
        <span class="med-ic equip">${icon('bluetooth')}</span>
        <span><b>${esc(d.name)}</b><span>${d.bonded ? t('meter_bonded') : d.rssi != null ? t('meter_signal', d.rssi > -65 ? t('sig_good') : d.rssi > -85 ? t('sig_ok') : t('sig_weak')) : ''}</span></span>
        ${meterBusy === d.deviceId ? `<span class="small muted">${t('meter_pairing')}</span>` : icon('chev')}</button>`,
    )
    .join('');
  return `<div class="scan-box">
      <div class="scan-head">${M.scanning ? `<span class="scan-dot"></span>${t('meter_searching')}` : t('meter_scan_done', loc(M.found.length))}</div>
      <div class="scan-heard">${t('meter_heard', loc(M.heard ?? 0))}</div>
      ${list ? `<div class="scan-list">${list}</div>` : M.scanning ? '' : `<p class="small muted">${t('meter_none_found')}</p>`}
      <div class="row scan-actions">
        <button class="btn btn-soft" data-act="meter_scan" ${M.scanning ? 'disabled' : ''}>${icon('refresh')} ${t('meter_rescan')}</button>
        <button class="btn" data-act="meter_scan_all">${t(M.all ? 'meter_only_meters' : 'meter_show_all')}</button>
      </div>
    </div>`;
}

async function startMeterScan(all) {
  stopMeterScan?.();
  meterScan = { scanning: true, found: [], all, heard: 0 };
  render();
  try {
    stopMeterScan = await scanMeters(
      (d) => {
        if (!meterScan) return;
        meterScan.found.push(d);
        meterScan.found.sort((a, b) => Number(!!b.bonded) - Number(!!a.bonded) || (b.rssi ?? -100) - (a.rssi ?? -100));
        if (parseRoute().name === 'meter') render();
      },
      {
        all,
        onHeard: (n) => {
          if (!meterScan) return;
          meterScan.heard = n;
          if (parseRoute().name === 'meter' && n % 3 === 1) render();
        },
      },
    );
    setTimeout(() => {
      if (meterScan) meterScan.scanning = false;
      if (parseRoute().name === 'meter') render();
    }, 20000);
  } catch (e) {
    meterScan = null;
    toast = e?.message === 'bluetooth_off' ? t('meter_bt_off') : `${t('meter_scan_error')} (${e?.message ?? e})`;
    render();
  }
}

function viewMeter() {
  const M = S.settings.meter;
  const lang = getLang() === 'bn' ? 'bn-BD' : 'en-GB';
  const fromMeter = activeLog()
    .filter((e) => e.type === 'reading' && e.source === 'meter')
    .sort((a, b) => b.ts - a.ts)
    .slice(0, 5);
  if (!meterSupported()) {
    return `<div class="page">${pageHead(t('meter_title'))}
      <div class="alert info">${icon('info')}<div>${t('meter_android_only')}</div></div></div>`;
  }
  const status = M
    ? `<section class="card meter-card">
        <div class="set-head"><span class="bubble ok-bubble">${icon('bluetooth')}</span>
          <div><b>${esc(M.name)}</b><span>${M.lastSync ? t('meter_last', new Date(M.lastSync).toLocaleString(lang, { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit', hour12: false })) : t('meter_never')}</span></div></div>
        <div class="auto-sync ${meterLink.state === 'waiting' ? 'on' : 'off'}"><span class="pill-dot"></span><div><b>${t(meterLink.state === 'waiting' ? 'auto_on' : 'auto_off')}</b><span>${meterLink.state === 'waiting' ? t('auto_on_sub') : t(`auto_${meterLink.state || 'starting'}`)}${meterLink.autoAt ? ` · ${t('auto_last', ago(meterLink.autoAt))}` : ''}</span></div></div>
        <button class="btn btn-primary btn-lg" data-act="meter_sync" ${meterBusy ? 'disabled' : ''}>${icon('refresh')} ${meterBusy ? t('meter_syncing') : t('meter_sync')}</button>
        <button class="btn btn-soft" data-act="go" data-to="whose">${icon('users')} ${t('wh_title')}</button>
        <button class="link" data-act="meter_remove">${t('meter_remove')}</button>
      </section>`
    : `<section class="card">
        <div class="set-head"><span class="bubble">${icon('bluetooth')}</span><div><b>${t('meter_pair_title')}</b><span>CONTOUR PLUS ELITE</span></div></div>
        ${meterScanList()}
      </section>
      <div class="section-title">${t('meter_how')}</div>
      <section class="card"><ol class="steps">${t('meter_steps').map((x) => `<li>${esc(x)}</li>`).join('')}</ol></section>`;
  return `<div class="page">${pageHead(t('meter_title'))}
    ${status}
    ${
      fromMeter.length
        ? `<div class="section-title">${t('meter_recent')}</div><section class="card" style="padding:6px"><ul class="readings">${fromMeter
            .map(
              (r) => `<li><div><b>${r.source === 'meter' ? `${icon('bluetooth', 'tiny')} ` : ''}${t(`ctx_${r.context}`)}</b><div class="muted small">${new Date(r.ts).toLocaleString(lang, { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit', hour12: false })}</div></div>
              <span class="val ${statusClass(r.value, r.context)}">${r.value}</span></li>`,
            )
            .join('')}</ul></section>`
        : ''
    }
    <div class="section-title">${t('meter_tips_title')}</div>
    <section class="card tips"><p>${icon('bluetooth')}<span>${t('meter_sub')}</span></p>${t('meter_tips').map((x) => `<p>${icon('info')}<span>${esc(x)}</span></p>`).join('')}</section>
  </div>`;
}

// --- login, account & family membership -----------------------------------------------------

let authChecked = false; // first auth state arrived (avoid flashing the login screen)
let loginFlow = null;
let members = null;
let joinError = '';

const authErr = (code) =>
  ({
    bad_email: 'err_bad_email',
    too_many: 'err_too_many',
    'too-many-requests': 'err_too_many',
    expired: 'err_expired',
    wrong_code: 'err_wrong_code',
    'invalid-credential': 'err_invalid',
    'wrong-password': 'err_invalid',
    'user-not-found': 'err_invalid',
    'invalid-email': 'err_bad_email',
    'email-already-in-use': 'err_exists',
    'weak-password': 'err_weak',
    'missing-password': 'err_weak',
    'network-request-failed': 'err_network',
    'requires-recent-login': 'need_recent',
    no_otp_server: 'err_no_server',
    not_found: 'err_not_found',
    network: 'err_network',
  })[code] ?? 'err_generic';

const needsLogin = () => cloud.cloudReady() && authChecked && !S.user && !S.settings.loginSkipped;

function viewLogin() {
  loginFlow ??= { step: 'email', email: S.settings.lastEmail ?? '', busy: false, err: '' };
  const L = loginFlow;
  const err = L.err ? `<div class="alert red">${icon('alert')}<div>${t(authErr(L.err))}</div></div>` : '';
  const busy = L.busy ? 'disabled' : '';
  let body;
  if (L.step === 'code') {
    body = `<p class="center muted">${t('code_sent', esc(L.email))}</p>
      <input id="lg-code" class="code-input" inputmode="numeric" autocomplete="one-time-code" maxlength="6" placeholder="••••••">
      ${err}
      <button class="btn btn-primary btn-lg" data-act="login_verify" ${busy}>${icon('check')} ${t('verify')}</button>
      <p class="center small muted">${t('check_spam')}</p>
      <div class="row"><button class="btn" data-act="login_send" ${busy}>${t('resend')}</button><button class="btn" data-act="login_back">${t('other_email')}</button></div>`;
  } else if (L.step === 'password') {
    body = `<label class="field">${t('email')}<input id="lg-email" type="email" inputmode="email" autocomplete="email" value="${esc(L.email)}"></label>
      <div class="sub-title">${t('password')}</div>
      <input id="lg-pass" class="code-input" type="password" inputmode="numeric" pattern="[0-9]*" autocomplete="current-password" maxlength="6" placeholder="••••••">
      ${err}
      <button class="btn btn-primary btn-lg" data-act="login_password" ${busy}>${icon('lock')} ${t('login_btn')}</button>
      <button class="btn" data-act="login_signup" ${busy}>${icon('user')} ${t('signup_btn')}</button>
      <button class="link" data-act="login_code_mode">${t('use_code')}</button>`;
  } else {
    body = `<label class="field">${t('email')}<input id="lg-email" type="email" inputmode="email" autocomplete="email" value="${esc(L.email)}" placeholder="name@gmail.com"></label>
      ${err}
      <button class="btn btn-primary btn-lg" data-act="login_send" ${busy}>${icon('chev')} ${L.busy ? t('sending') : t('send_code')}</button>
      ${S.settings.passcodeOff ? '' : `<button class="link" data-act="login_pw_mode">${t('use_password')}</button>`}`;
  }
  const canSkip = !isCaregiver() && !S.settings.pendingJoin;
  return `<div class="page welcome login">
    <div class="logo">${icon('mail')}</div>
    <h1>${t('login_title')}</h1>
    <p class="center muted">${S.settings.pendingJoin ? t('join_login') : t('login_sub')}</p>
    ${L.step === 'password' ? '' : `<ol class="login-steps">${t('login_steps').map((x, i) => `<li class="${i === (L.step === 'code' ? 1 : 0) ? 'on' : i < (L.step === 'code' ? 1 : 0) ? 'done' : ''}"><b>${i < (L.step === 'code' ? 1 : 0) ? icon('check') : loc(i + 1)}</b><span>${esc(x)}</span></li>`).join('')}</ol>`}
    <section class="card">${body}</section>
    ${canSkip ? `<button class="link muted-link" data-act="login_skip">${t('skip_login')}</button>` : ''}
  </div>`;
}

function viewRole() {
  return `<div class="page welcome">
    <div class="logo">${icon('users')}</div>
    <h1>${t('role_title')}</h1>
    <div class="choices" style="margin-top:16px">
      <button class="choice" data-act="role_patient"><span class="bubble">${icon('heart')}</span><span><b>${t('role_patient')}</b><br><span class="small muted">${t('role_patient_sub')}</span></span>${icon('chev')}</button>
      <button class="choice" data-act="role_family"><span class="bubble">${icon('users')}</span><span><b>${t('role_family')}</b><br><span class="small muted">${t('role_family_sub')}</span></span>${icon('chev')}</button>
      ${S.settings.memberLink ? `<button class="choice" data-act="role_member"><span class="bubble">${icon('drop')}</span><span><b>${t('role_member')}</b><br><span class="small muted">${t('role_member_sub', esc(S.settings.memberLink.patient ?? ''))}</span></span>${icon('chev')}</button>` : ''}
    </div>
  </div>`;
}

function viewJoinCode() {
  return `<div class="page welcome">
    <div class="logo">${icon('shield')}</div>
    <h1>${t('joincode_title')}</h1>
    <p class="center muted">${t('joincode_sub')}</p>
    <section class="card">
      <input id="join-code" class="code-input wide" autocapitalize="characters" autocomplete="off" placeholder="MANGO-RIVER-427" value="${esc(S.settings.pendingCode ?? '')}">
      ${joinError ? `<div class="alert red">${icon('alert')}<div>${t(authErr(joinError))}</div></div>` : ''}
      <button class="btn btn-primary btn-lg" data-act="join_code">${icon('check')} ${t('joincode_btn')}</button>
    </section>
    <button class="link" data-act="go" data-to="role">${t('back')}</button>
  </div>`;
}

function viewAccount() {
  if (!S.user) {
    return `<div class="page">${pageHead(t('account'))}
      <section class="card center"><span class="bubble" style="margin:0 auto 10px">${icon('user')}</span>
      <p class="muted">${t('account_none')}</p>
      <button class="btn btn-primary btn-lg" data-act="go_login">${t('account_login')}</button></section></div>`;
  }
  const code = S.settings.familyId;
  if (code && members == null) {
    members = [];
    cloud.listMembers(code).then((m) => ((members = m), render())).catch(() => {});
  }
  const memberRows = (members ?? [])
    .map(
      (m) => `<div class="menu-row"><span class="bubble">${icon(m.role === 'patient' ? 'heart' : 'users')}</span>
        <div><b>${esc(m.email || m.uid.slice(0, 8))}</b><span>${t(m.role === 'patient' ? 'role_patient_short' : 'role_family_short')}${m.uid === S.user.uid ? ` · ${t('you')}` : ''}</span></div>
        ${!isCaregiver() && m.uid !== S.user.uid ? `<button class="btn small-btn" data-act="member_remove" data-uid="${esc(m.uid)}">${t('remove')}</button>` : '<span></span>'}</div>`,
    )
    .join('');
  return `<div class="page">${pageHead(t('account'))}
    <section class="card set-card">
      <div class="set-head"><span class="bubble ok-bubble">${icon('user')}</span><div><b>${esc(S.user.email ?? '')}</b><span>${t(isCaregiver() ? 'role_family' : 'role_patient')}</span></div></div>
      ${code ? `<div class="sub-title">${t('family_code')}</div><div class="code-pill">${prettyCode(code)}</div>
        <div class="row"><button class="btn btn-soft" data-act="copy_code">${icon('file')} ${t('copy_code')}</button>${isCaregiver() ? '' : `<button class="btn btn-soft" data-act="new_code">${icon('refresh')} ${t('new_code')}</button>`}</div>` : ''}
    </section>
    ${code ? `<div class="section-title">${t('members')}</div><section class="card menu">${memberRows || `<p class="muted center">…</p>`}</section>` : ''}
    <section class="card set-card">
      <label class="set-head pin-head"><span class="bubble">${icon('lock')}</span><div><b>${t('passcode_login')}</b><span>${t('passcode_login_sub')}</span></div>
        <span class="switch"><input type="checkbox" data-act="passcode_toggle" ${S.settings.passcodeOff ? '' : 'checked'}><span></span></span></label>
      ${S.settings.passcodeOff ? '' : `<div class="sub-title">${t('set_password')}</div>
      <input id="new-pass" class="code-input" type="password" inputmode="numeric" pattern="[0-9]*" autocomplete="new-password" maxlength="6" placeholder="••••••">
      <button class="btn btn-soft" data-act="save_password">${icon('check')} ${t('save_password')}</button>`}
    </section>
    ${isCaregiver() ? `<button class="btn" data-act="go" data-to="joincode">${icon('users')} ${t('join_other')}</button>` : ''}
    <button class="btn btn-soft" style="margin-top:12px" data-act="role_change">${icon('users')} ${t('role_change')}</button>
    <button class="btn btn-outline-danger" style="margin-top:12px" data-act="logout">${t('logout')}</button>
  </div>`;
}

// Caregiver: get the patient's alerts (missed dose, low sugar…) on this phone through ntfy.
function viewCgAlerts() {
  const topic = S.settings.ntfyTopic;
  return `<div class="page">${pageHead(t('cg_alerts'))}
    <section class="card set-card">
      <div class="set-head"><span class="bubble">${icon('bell')}</span><div><b>${t('cg_alerts')}</b><span>${t('cg_alerts_sub')}</span></div></div>
      <label class="menu-row switch-row"><span class="bubble">${icon('syringe')}</span><div><b>${t('cg_dose_rem')}</b><span>${t('cg_dose_rem_sub')}</span></div>
        <span class="switch"><input type="checkbox" data-act="reminders" ${S.settings.reminders ? 'checked' : ''}><span></span></span></label>
      ${topic
        ? `<ol class="steps">${t('cg_steps').map((x) => `<li>${esc(x)}</li>`).join('')}</ol>
        <div class="sub-title">${t('cg_topic')}</div>
        <div class="code-pill topic-pill">${esc(topic)}</div>
        <button class="btn btn-primary btn-lg" data-act="cg_open_ntfy">${icon('bell')} ${t('cg_open_ntfy')}</button>
        <div class="row" style="margin-top:10px"><button class="btn btn-soft" data-act="cg_copy_topic">${icon('file')} ${t('copy_code')}</button><button class="btn btn-soft" data-act="cg_test">${icon('sound')} ${t('cg_test')}</button></div>`
        : `<p class="muted">${t('cg_alerts_none')}</p>`}
    </section></div>`;
}

// --- Medicines (as prescribed) --------------------------------------------------------------

const MED_ICON = { pen: 'syringe', vial: 'syringe', tablet: 'pill', capsule: 'pill', syrup: 'cup', other: 'pill' };
const medUnit = (type, n = 1) => t(`unit_${type}`, n);
const whenText = (w) => t(`when_${w}`);
function medLine(x) {
  const amt = isInsulin(x) ? loc(x.amount) : loc(amountText(x.amount));
  return [`${amt} ${medUnit(x.type, x.amount)}`, x.meal ? t(`meal_${x.meal}`) : ''].filter(Boolean).join(' · ');
}
function medsSummary() {
  const n = (S.plan.meds ?? []).length;
  return n ? t('meds_count', loc(n)) : t('meds_none_short');
}

// Short preview for the settings card.
function medsPreview() {
  const meds = S.plan.meds ?? [];
  if (!meds.length) return `<p class="muted small">${t(S.plan.doses.length ? 'meds_legacy' : 'meds_empty')}</p>`;
  return meds.map((m) => `<div class="set-line"><span>${icon(MED_ICON[m.type])} ${esc(m.name)}</span><b>${(m.times ?? []).map((x) => loc(isInsulin(m) ? x.amount : amountText(x.amount))).join(' + ')}</b></div>`).join('');
}

function medCard(m) {
  const times = (m.times ?? [])
    .filter((x) => x.amount > 0)
    .map((x) => `<li><b>${isInsulin(m) && x.when === 'night' ? t('when_ins_night') : isInsulin(m) && m.insulinKind === 'basal' && x.when === 'breakfast' ? t('when_basal_morning') : whenText(x.when)}</b><span>${medLine({ ...x, type: m.type })}</span><time>${loc(x.at || DEFAULT_AT[x.when])}</time></li>`)
    .join('');
  return `<button class="med-card" data-act="go" data-to="med/${esc(m.id)}">
    <span class="med-ic ${m.type}">${icon(MED_ICON[m.type])}</span>
    <span class="med-body"><b>${esc(m.name)}${m.strength ? ` <small>${esc(m.strength)}</small>` : ''}</b>
      <span class="med-type">${t(`type_${m.type}`)}${isInsulin(m) && m.insulinKind ? ` · ${t(`kind_${m.insulinKind}`)}` : ''}</span>
      <ul class="med-times">${times}</ul>${m.note ? `<span class="med-note">${esc(m.note)}</span>` : ''}</span>
    ${icon('chev')}</button>`;
}

function viewMeds() {
  const meds = S.plan.meds ?? [];
  const legacy = !Array.isArray(S.plan.meds) && S.plan.doses.length;
  return `<div class="page">${pageHead(t('meds_title'))}
    <p class="muted">${t(isCaregiver() ? 'meds_sub_cg' : 'meds_sub')}</p>
    ${legacy ? `<div class="alert info">${icon('info')}<div>${t('meds_legacy')}</div></div>` : ''}
    ${meds.length ? `<div class="med-list">${meds.map(medCard).join('')}</div>` : `<section class="card center med-empty"><span class="bubble">${icon('pill')}</span><p>${t('meds_empty')}</p></section>`}
    <button class="btn btn-primary btn-lg" data-act="go" data-to="med/new">${icon('plus')} ${t('med_add')}</button>
  </div>`;
}

let medDraft = null;
function newMedDraft(id) {
  const m = (S.plan.meds ?? []).find((x) => x.id === id);
  return m ? structuredClone(m) : { id: uid(), type: '', name: '', strength: '', insulinKind: 'rapid', range: 2, times: [], note: '' };
}

// Rows for every time of day; amount 0 = not taken then.
function medRows(d) {
  const ins = isInsulin(d);
  const list = ins ? insulinWhen(d.insulinKind) : GENERAL_WHEN;
  return list
    .map((w) => {
      const x = d.times.find((y) => y.when === w) ?? { when: w, amount: 0 };
      const on = x.amount > 0;
      const amt = ins ? loc(x.amount) : loc(amountText(x.amount));
      const label = !ins ? whenText(w) : w === 'night' ? t('when_ins_night') : d.insulinKind === 'basal' && w === 'breakfast' ? t('when_basal_morning') : whenText(w);
      return `<div class="dose-row ${on ? 'on' : ''}">
        <b class="dose-label">${label}</b>
        <div class="dose-time">${on ? `<input type="time" data-med-at="${w}" value="${x.at || DEFAULT_AT[w]}">` : `<span class="muted small">${t('med_off')}</span>`}</div>
        <div class="num-step">
          <button data-act="med_amt" data-when="${w}" data-d="-1" aria-label="−">−</button>
          <span>${on ? amt : '0'}<small>${medUnit(d.type, x.amount)}</small></span>
          <button data-act="med_amt" data-when="${w}" data-d="1" aria-label="+">+</button>
        </div>
        ${!ins && on ? `<div class="meal-chips">${['before', 'with', 'after', 'empty', ''].map((v) => `<button class="${(x.meal ?? '') === v ? 'on' : ''}" data-act="med_meal" data-when="${w}" data-v="${v}">${v ? t(`meal_${v}`) : t('meal_any')}</button>`).join('')}</div>` : ''}
      </div>`;
    })
    .join('');
}

// Suggestion cards under the name box (brand, generic, strength), updated as you type.
function medSuggestions(text) {
  const list = searchMeds(text, isInsulin(medDraft));
  if (!list.length) return '';
  return `<div class="sugg-title">${text ? t('med_sugg') : t('med_sugg_common')}</div>${list
    .map(
      (k) => `<button class="sugg-item" data-act="med_pick" data-name="${esc(k.name)}"><span class="med-ic ${k.type}">${icon(MED_ICON[k.type])}</span>
        <span><b>${esc(k.name)}${k.strength ? ` <small>${esc(k.strength)}</small>` : ''}</b><span>${esc(k.generic)}${k.insulinKind ? ` · ${t(`kind_${k.insulinKind}`)}` : ''}</span></span></button>`,
    )
    .join('')}`;
}

function viewMedEdit(id) {
  if (!medDraft || medDraft.id !== (id === 'new' ? medDraft.id : id)) medDraft = newMedDraft(id === 'new' ? null : id);
  const d = medDraft;
  const exists = (S.plan.meds ?? []).some((x) => x.id === d.id);
  if (!d.type) {
    return `<div class="page">${pageHead(t('med_add'))}
      <div class="q">${t('med_type_q')}</div>
      <div class="type-grid">${MED_TYPES.map((ty) => `<button class="type-tile" data-act="med_type" data-type="${ty}"><span class="med-ic ${ty}">${icon(MED_ICON[ty])}</span><b>${t(`type_${ty}`)}</b></button>`).join('')}</div>
    </div>`;
  }
  const ins = isInsulin(d);
  return `<div class="page med-edit">${pageHead(exists ? d.name : t('med_add'))}
    <section class="card">
      <button class="type-chip" data-act="med_retype">${icon(MED_ICON[d.type])} ${t(`type_${d.type}`)} <span class="muted small">${t('change')}</span></button>
      <label class="field">${t('med_name')}<input id="med-name" value="${esc(d.name)}" placeholder="${ins ? 'Actrapid, Lantus…' : 'Comet, Lino, Metformin…'}" autocomplete="off" autocapitalize="words"></label>
      <div class="sugg" id="med-sugg">${d.name ? '' : medSuggestions('')}</div>
      <label class="field">${t('med_strength')}<input id="med-strength" value="${esc(d.strength)}" placeholder="${ins ? 'U-100' : '5 mg'}"></label>
      ${ins ? `<div class="field">${t('med_kind')}<div class="kind-chips">${['rapid', 'basal', 'mixed'].map((k) => `<button class="${d.insulinKind === k ? 'on' : ''}" data-act="med_kind" data-k="${k}"><b>${t(`kind_${k}`)}</b><span>${t(`kind_${k}_sub`)}</span></button>`).join('')}</div></div>` : ''}
    </section>

    <div class="section-title">${t('med_dose')}</div>
    <section class="card">
      <label class="field">${t('med_quick')}<div class="quick-row"><input id="med-quick" inputmode="text" placeholder="${ins ? (d.insulinKind === 'basal' ? '0+0+20' : '16+16+12') : '1+0+1'}" autocomplete="off"><button class="btn btn-soft" data-act="med_quick">${t('med_quick_btn')}</button></div></label>
      <p class="small muted">${t(ins ? `med_quick_hint_${d.insulinKind === 'basal' ? 'basal' : 'ins'}` : 'med_quick_hint')}</p>
      ${medDraft.err ? `<div class="alert red">${icon('alert')}<div>${esc(medDraft.err)}</div></div>` : ''}
      <div class="dose-rows">${medRows(d)}</div>
      ${ins ? `<div class="set-line"><span>${t('med_range')}</span><div class="num-step small"><button data-act="med_range" data-d="-1">−</button><span>±${loc(d.range ?? 2)}</span><button data-act="med_range" data-d="1">+</button></div></div>` : ''}
      <label class="field">${t('med_note')}<input id="med-note" value="${esc(d.note ?? '')}" placeholder="${t('med_note_ph')}"></label>
    </section>

    <button class="btn btn-primary btn-lg" data-act="med_save">${icon('check')} ${t('save')}</button>
    <button class="btn" style="margin-top:10px" data-act="med_cancel">${t('cancel')}</button>
    ${exists ? `<button class="btn btn-outline-danger" style="margin-top:18px" data-act="med_delete">${icon('trash')} ${t('med_delete')}</button>` : ''}
  </div>`;
}

// Keep what was typed before the screen is drawn again.
function readMedForm() {
  const d = medDraft;
  if (!d) return;
  const v = (id) => document.getElementById(id)?.value;
  if (v('med-name') != null) d.name = v('med-name').trim();
  if (v('med-strength') != null) d.strength = v('med-strength').trim();
  if (v('med-note') != null) d.note = v('med-note').trim();
  for (const el of $app.querySelectorAll('[data-med-at]')) {
    const x = d.times.find((y) => y.when === el.dataset.medAt);
    if (x) x.at = el.value;
  }
  const k = knownMed(d.name);
  if (k && !d.strength) d.strength = k.strength;
  if (k?.insulinKind && isInsulin(d) && !d.kindTouched) d.insulinKind = k.insulinKind;
}

// --- Update the day's doses at once (also for the family, on the patient's behalf) -----------

let doseBook = null;
const dayStartOf = (offset) => {
  const d = new Date();
  d.setHours(0, 0, 0, 0);
  d.setDate(d.getDate() - offset);
  return d.getTime();
};
const atToTs = (start, at) => {
  const [h, m] = String(at || '08:00').split(':').map(Number);
  return Math.min(start + (h * 60 + m) * 60000, Date.now());
};

// What is already logged for that day: the starting point of the form.
function newDoseBook(offset) {
  const start = dayStartOf(offset);
  const key = dayKey(start);
  const log = activeLog().filter((e) => dayKey(e.ts) === key);
  const ins = {};
  for (const d of S.plan.doses) {
    const rec = log.filter((e) => e.type === 'dose' && e.slot === d.id).at(-1);
    ins[d.id] = {
      status: rec ? (rec.action === 'skip' ? 'skipped' : 'taken') : '',
      units: rec && rec.action !== 'skip' ? rec.units : doseUnits(d),
      at: rec ? hhmm(rec.ts) : d.injectAt,
      recId: rec?.id,
    };
  }
  const tabs = {};
  for (const x of generalTimes(S.plan.meds ?? [])) {
    const k = `${x.medId}:${x.when}`;
    const rec = log.find((e) => e.type === 'tablet' && e.med === x.medId && (e.when === x.when || (!e.when && x.with)));
    tabs[k] = { taken: !!rec, at: rec ? hhmm(rec.ts) : x.at, recId: rec?.id };
  }
  return { offset, ins, tabs };
}

function readDoseBook() {
  for (const el of $app.querySelectorAll('[data-db-units]')) {
    const v = Number(el.value);
    if (el.value.trim() !== '' && Number.isFinite(v) && doseBook.ins[el.dataset.dbUnits]) doseBook.ins[el.dataset.dbUnits].units = Math.max(0, Math.min(100, Math.round(v)));
  }
  for (const el of $app.querySelectorAll('[data-db-at]')) {
    const [kind, key] = el.dataset.dbAt.split('|');
    const entry = kind === 'ins' ? doseBook.ins[key] : doseBook.tabs[key];
    if (entry && el.value) entry.at = el.value;
  }
}

function viewDoseBook() {
  doseBook ??= newDoseBook(0);
  const B = doseBook;
  const statusChip = (st) => (st === 'taken' ? `<span class="badge ok">${t('db_taken')}</span>` : st === 'skipped' ? `<span class="badge late">${t('db_skipped')}</span>` : `<span class="badge">${t('db_unset')}</span>`);
  const insCards = S.plan.doses
    .map((d) => {
      const e = B.ins[d.id];
      const out = e.status === 'taken' && (e.units < d.min || e.units > d.max);
      return `<section class="card db-card ${e.status}">
        <div class="db-head"><span class="bubble">${icon(SLOT_ICON[d.id] ?? 'syringe')}</span>
          <div><b>${slotName(d.id)}</b><span>${esc(t(`ins_${d.insulin}`))} · ${t('db_planned', loc(doseUnits(d)), loc(d.injectAt))}</span></div>${statusChip(e.status)}</div>
        <div class="db-choice">
          <button class="${e.status === 'taken' ? 'on yes' : ''}" data-act="db_set" data-slot="${d.id}" data-v="taken">${icon('check')} ${t('db_yes')}</button>
          <button class="${e.status === 'skipped' ? 'on no' : ''}" data-act="db_set" data-slot="${d.id}" data-v="skipped">${icon('none')} ${t('db_no')}</button>
        </div>
        ${e.status === 'taken'
          ? `<div class="db-detail">
              <label class="db-time">${t('db_time')}<input type="time" data-db-at="ins|${d.id}" value="${e.at}"></label>
              <div class="num-step"><button data-act="db_amt" data-slot="${d.id}" data-d="-1">−</button><label class="db-units"><input type="number" inputmode="numeric" min="0" max="100" data-db-units="${d.id}" value="${e.units}"><small>${t('units')}</small></label><button data-act="db_amt" data-slot="${d.id}" data-d="1">+</button></div>
            </div>${out ? `<p class="db-warn">${icon('alert')} ${t('db_out', loc(d.min), loc(d.max))}</p>` : ''}`
          : ''}
      </section>`;
    })
    .join('');
  const tabRows = generalTimes(S.plan.meds ?? [])
    .map((x) => {
      const k = `${x.medId}:${x.when}`;
      const e = B.tabs[k];
      return `<div class="db-tab ${e.taken ? 'on' : ''}">
        <button class="db-tick" data-act="db_tab" data-key="${esc(k)}" aria-pressed="${e.taken}">${e.taken ? icon('check') : ''}</button>
        <div><b>${esc(x.name)}</b><span>${whenText(x.when)} · ${medLine(x)}</span></div>
        ${e.taken ? `<input type="time" data-db-at="tab|${esc(k)}" value="${e.at}">` : ''}
      </div>`;
    })
    .join('');
  return `<div class="page dose-book">${pageHead(t('db_title'))}
    ${isCaregiver() ? `<div class="alert info">${icon('users')}<div>${t('db_cg_note', esc(S.plan.patient.name))}</div></div>` : ''}
    <div class="db-date-row">
      <div class="seg db-day">${[0, 1].map((o) => `<button class="${B.offset === o ? 'on' : ''}" data-act="db_day" data-v="${o}">${t(o ? 'db_yesterday' : 'db_today')}</button>`).join('')}</div>
      <label class="db-date ${B.offset > 1 ? 'on' : ''}">${icon('calendar')}<input type="date" id="db-date" value="${dayKey(dayStartOf(B.offset))}" min="${dayKey(dayStartOf(60))}" max="${dayKey(dayStartOf(0))}" aria-label="${t('db_pick_date')}"></label>
    </div>
    <p class="db-for">${t('db_for', new Date(dayStartOf(B.offset)).toLocaleDateString(getLang() === 'bn' ? 'bn-BD' : 'en-GB', { weekday: 'long', day: 'numeric', month: 'long' }))}</p>
    ${S.plan.doses.length ? `<div class="section-title">${t('stock_ins')}</div>${insCards}` : ''}
    ${tabRows ? `<div class="section-title">${t('stock_other')}</div><section class="card">${tabRows}</section>` : ''}
    <button class="btn btn-primary btn-lg" data-act="db_save">${icon('check')} ${t('db_save')}</button>
    <p class="small muted center">${t('db_sync_note')}</p>
  </div>`;
}

// After login: restore this person's family, or ask what the phone is for.
// The patient data on this phone belongs to one account. Another email logging in must not
// inherit it (or push it into its new family): it starts clean and gets its own data from the cloud.
function otherAccount(u) {
  const owner = S.settings.accountUid;
  if (owner) return owner !== u.uid;
  const last = S.settings.lastEmail; // phones from before accountUid was kept
  return !!last && !!u.email && cloud.normEmail(last) !== cloud.normEmail(u.email);
}

// Leaving one family for another: the old family's history, plan and queued uploads stay behind.
function clearFamilyData() {
  sync.disconnect();
  native.setSyncAuth({});
  const blank = freshData();
  S.plan = blank.plan;
  S.log = [];
  S.state = blank.state;
  S.presence = null;
  members = null;
  planLoaded = false;
  linksDone = '';
}

function startFreshAccount() {
  const keep = { lang: S.settings.lang, textSize: S.settings.textSize, theme: S.settings.theme, mode: S.settings.mode, welcomed: S.settings.welcomed, meter: S.settings.meter };
  const blank = freshData();
  sync.disconnect();
  S.plan = blank.plan;
  S.log = [];
  S.state = blank.state;
  S.presence = null;
  S.settings = { ...blank.settings, ...keep };
  members = null;
  planLoaded = false;
  personDraft = null;
  whose.picked = new Set();
  save(S);
  scheduleReminders();
}

async function onUser(u) {
  const prevUid = S.user?.uid;
  S.user = u;
  authChecked = true;
  if (!u) {
    sync.disconnect();
    return render();
  }
  if (prevUid === u.uid && sync.connected()) return render();
  if (otherAccount(u)) startFreshAccount();
  S.settings.accountUid = u.uid;
  const linkCheck = checkMemberLink(u);
  S.settings.lastEmail = u.email ?? S.settings.lastEmail;
  save(S);
  if (S.settings.pendingJoin) return doJoin(S.settings.pendingJoin.f, S.settings.pendingJoin.n);
  if (S.settings.familyId && S.settings.welcomed) {
    const known = S.settings.familyId;
    connectFamily().then(render);
    if (['login', 'role', 'joincode'].includes(parseRoute().name)) go('home');
    else render();
    cloud
      .getProfile(u.uid)
      .then((p) => {
        if (!p) return;
        if (p.family && p.family !== known) {
          clearFamilyData();
          S.settings.familyId = p.family;
          S.settings.role = p.role === 'caregiver' ? 'caregiver' : 'patient';
          save(S);
          connectFamily().then(render);
        } else if (!p.family) {
          if (isCaregiver()) go('role');
          else startPatientFamily();
        }
      })
      .catch(() => {}); // offline: keep using what this phone already knows
    return;
  }
  let profile = null;
  try {
    profile = await cloud.getProfile(u.uid);
  } catch {
    // offline: keep using what this phone already knows
  }
  if (profile?.family) {
    S.settings.familyId = profile.family;
    S.settings.role = profile.role === 'caregiver' ? 'caregiver' : 'patient';
    S.settings.welcomed = true;
    save(S);
    await connectFamily();
    if (['login', 'role', 'joincode'].includes(parseRoute().name)) go('home');
    else render();
    return;
  }
  if (S.settings.familyId && !isCaregiver()) return startPatientFamily(); // this phone already shared before
  await linkCheck;
  if (S.settings.memberOnly && S.settings.memberLink) return go('mine');
  go('role');
}

async function connectFamily() {
  await startSync();
  cloud.syncLogin().then((l) => l && native.setSyncAuth({ ...l, family: S.settings.familyId, role: S.settings.role })).catch(() => {});
  if (isCaregiver()) {
    const info = await cloud.getShareInfo(S.settings.familyId).catch(() => null);
    if (info?.ntfyTopic) S.settings.ntfyTopic = info.ntfyTopic;
    save(S);
    scheduleReminders();
    registerRing();
  } else {
    if (!S.settings.ntfyTopic) {
      S.settings.ntfyTopic = randomTopic();
      S.settings.sent = [...new Set([...S.settings.sent, ...currentAlerts().map((a) => a.key)])];
      save(S);
    }
    cloud.setShareInfo(S.settings.familyId, { ntfyTopic: S.settings.ntfyTopic, patientName: S.plan.patient.name }).catch(() => {});
    registerRing();
    scheduleReminders();
  }
}

// Lets family members ring this (the patient's) phone.
async function registerRing() {
  if (!native.isNative || !S.user || !S.settings.familyId) return;
  const token = await native.pushToken();
  if (!token) return;
  const device = { token, lang: getLang(), uid: S.user.uid, role: S.settings.role, updatedAt: Date.now() };
  cloud.setMemberDevice(S.settings.familyId, S.user.uid, device).catch(() => {});
  if (!isCaregiver()) cloud.setPushDevice(S.settings.familyId, device).catch(() => {});
}

// --- Sugar emergency: dangerously low or high ----------------------------------------------
// The patient's phone rings full screen with what to do now and call buttons; every family
// phone is rung the same way through the server (works with their app closed too).

const crisisLevel = (v) => (v < LIMITS.HYPO ? 'low' : v > LIMITS.HIGH ? 'high' : '');

// Who to call: up to 3 emergency contacts, the doctor, then 999. For the family, the patient first.
function crisisContacts(forFamily) {
  const P = S.plan;
  const list = [];
  if (forFamily && P.patient.phone) list.push({ name: t('call_patient', P.patient.name), phone: P.patient.phone });
  for (const c of P.emergency ?? []) if (c?.phone) list.push({ name: c.name || prettyPhone(c.phone), phone: c.phone });
  if (P.doctor?.phone) list.push({ name: t('crisis_doctor', P.doctor.name || ''), phone: P.doctor.phone });
  list.push({ name: t('crisis_999'), phone: '999' });
  return list;
}

function crisisTexts(level, value, forFamily, lang) {
  const tt = (k, ...a) => tIn(lang, k, ...a);
  const severe = level === 'low' ? value < LIMITS.SEVERE : value > LIMITS.VERY_HIGH;
  const who = forFamily ? 'fam' : 'pt';
  const steps = tt(`crisis_${level}_${who}`);
  if (severe) steps.push(tt(`crisis_${level}_severe`));
  return {
    title: forFamily ? tt(`crisis_${level}_title_fam`, S.plan.patient.name, value) : tt(`crisis_${level}_title`, value),
    body: tt(`crisis_${level}_body`),
    steps: steps.join('\n'),
  };
}

const crisisSent = new Set();
function crisisCheck(rec) {
  const level = crisisLevel(rec.value);
  if (!level || isCaregiver() || Date.now() - rec.ts > 30 * 60000) return; // old meter readings don't ring
  if (crisisSent.has(rec.id) || (S.settings.crisisSent ?? []).includes(rec.id)) return;
  crisisSent.add(rec.id);
  S.settings.crisisSent = [...(S.settings.crisisSent ?? []).slice(-19), rec.id];
  save(S);
  const lang = getLang();
  const own = crisisTexts(level, rec.value, false, lang);
  if (native.isNative && !rec.alarmed) {
    const speak = `${own.title}। ${own.steps.split('\n')[0].replace(/^[SWE]\|/, '')}`;
    native.alarmOnce({
      id: 130,
      at: Date.now() + 300,
      repeat: false,
      route: level === 'low' ? 'low' : 'high',
      ...own,
      contacts: JSON.stringify(crisisContacts(false)),
      tone: level,
      clip: clip(`crisis_${level}`),
      voiceUrl: `https://translate.google.com/translate_tts?ie=UTF-8&client=tw-ob&tl=${lang}&q=${encodeURIComponent(speak.slice(0, 195))}`,
      lang,
      openLabel: t('crisis_open'),
      snoozeLabel: t('crisis_close'),
    })?.catch?.(() => {});
  }
  // the family's phones: same alarm, with steps for them, in each phone's language
  if (S.user && S.settings.familyId) {
    const fam = { bn: crisisTexts(level, rec.value, true, 'bn'), en: crisisTexts(level, rec.value, true, 'en') };
    cloud.crisisAlert(S.settings.familyId, { level, value: rec.value, texts: fam, contacts: crisisContacts(true) }).catch(() => {});
  }
}

// --- Patient registration: name, age, man/woman and (optional) phone -----------------------
// Big, simple controls for older users. The family can fill or change it later from their menu.
const AGE_PICKS = [40, 50, 60, 70];
function viewPatientInfo(mode) {
  const first = mode === 'first';
  const P = S.plan.patient;
  const known = !!P.registered; // never guess a name: a new patient always starts with an empty box
  const age = P.registered || known ? P.age : 55;
  const sex = P.sex ?? '';
  const sexBtn = (v) => `<button class="${sex === v ? 'on' : ''}" data-act="reg_sex" data-v="${v}"><span class="bubble">${icon('user')}</span>${t(`sex_${v}`)}</button>`;
  const form = `<section class="card reg-card">
      <label class="reg-label" for="reg-name">${t(isCaregiver() ? 'reg_name_cg' : 'reg_name')}</label>
      <input id="reg-name" class="reg-input" value="${esc(known ? P.name : '')}" placeholder="${t('reg_name_ph')}" autocomplete="name" maxlength="40">
      <div class="reg-label">${t('reg_sex')}</div>
      <div class="reg-sex">${sexBtn('female')}${sexBtn('male')}</div>
      <div class="reg-label">${t('reg_age')}</div>
      <div class="reg-age">
        <button data-act="reg_age" data-d="-1" aria-label="−">−</button>
        <output id="reg-age">${age}</output>
        <button data-act="reg_age" data-d="1" aria-label="+">+</button>
      </div>
      <div class="reg-age-picks">${AGE_PICKS.map((a) => `<button data-act="reg_age_set" data-v="${a}">${a}</button>`).join('')}</div>
      <label class="reg-label" for="reg-phone">${t(isCaregiver() ? 'reg_phone_cg' : 'reg_phone')} <small>${t('optional')}</small></label>
      <input id="reg-phone" class="reg-input" type="tel" inputmode="tel" autocomplete="tel" placeholder="01XXXXXXXXX" value="${esc(P.phone ? prettyPhone(P.phone) : '')}">
      <div id="reg-msg"></div>
      <button class="btn btn-primary btn-lg" data-act="reg_save" data-first="${first ? 1 : ''}">${icon('check')} ${t(first ? 'reg_start' : 'save')}</button>
    </section>`;
  if (first) {
    return `<div class="page welcome register">
      <div class="logo">${icon('heart')}</div>
      <h1>${t('reg_title')}</h1>
      <p class="center muted">${t('reg_sub')}</p>
      ${form}
    </div>`;
  }
  return `<div class="page register">${pageHead(t('reg_edit_title'))}
    ${isCaregiver() ? `<p class="muted">${t('reg_cg_note')}</p>` : ''}
    ${form}
  </div>`;
}

// The patient's mobile number, entered by the family (Bangladeshi, stored as +8801…).
function patientPhoneCard() {
  const p = S.plan.patient.phone;
  return `<section class="card set-card">
    <div class="set-head"><span class="bubble">${icon('phone')}</span><div><b>${t('pt_phone')}</b><span>${p ? prettyPhone(p) : t('pt_phone_sub')}</span></div></div>
    <div class="row phone-row">
      <input id="pt-phone" type="tel" inputmode="tel" autocomplete="tel" placeholder="01XXXXXXXXX" value="${esc(p ? prettyPhone(p) : '')}">
      <button class="btn btn-soft" data-act="phone_save">${t('save')}</button>
    </div>
  </section>`;
}

// Big call button for the family (when the phone can't be rung, or to check on a missed dose).
const callPatientBtn = (cls = 'btn btn-primary btn-lg') =>
  S.plan.patient.phone
    ? `<a class="${cls}" href="tel:${esc(S.plan.patient.phone)}">${icon('phone')} ${t('call_patient', esc(S.plan.patient.name))}</a>`
    : `<button class="${cls}" data-act="go" data-to="ring">${icon('phone')} ${t('pt_phone_add')}</button>`;

// An alarm reaches the patient's phone whenever it is online, app open or closed (the push wakes it).
// Only when it is offline do we offer a call instead. While still connecting the ring button stays.
const phoneReachable = () => ['on', 'idle', 'wait'].includes(phoneStatus(S.presence).cls);

// Caregiver: sound an alarm on the patient's phone, with a ready message or your own.
let ringState = null;
function viewRing() {
  ringState ??= { busy: '', sent: null, err: '' };
  const R = ringState;
  const opt = (kind, ic, title, sub) =>
    `<button class="choice" data-act="ring_send" data-kind="${kind}" ${R.busy || !phoneReachable() ? 'disabled' : ''}><span class="bubble">${icon(ic)}</span><span><b>${title}</b><br><span class="small muted">${sub}</span></span>${R.busy === kind ? '<span class="small muted">…</span>' : icon('chev')}</button>`;
  const status = R.err
    ? `<div class="alert red">${icon('alert')}<div>${t(ringErr(R.err))}</div></div>`
    : R.sent
      ? `<div class="alert ok">${icon('check')}<div>${t('ring_sent', clock(R.sent))}</div></div>`
      : '';
  const reachable = phoneReachable();
  const st = phoneStatus(S.presence);
  const blocked = reachable ? '' : 'disabled';
  return `<div class="page">${pageHead(t('ring_title'))}
    ${reachable
      ? `<p class="muted">${t('ring_sub', esc(S.plan.patient.name))}</p>`
      : `<div class="alert red">${icon('alert')}<div><b>${t('ring_offline')}</b><br><span class="small">${st.sub || st.text}</span></div></div>${callPatientBtn()}`}
    ${S.plan.patient.phone ? '' : patientPhoneCard()}
    ${status}
    <div class="choices ${reachable ? '' : 'is-off'}">
      ${opt('beep', 'bell', t('ring_beep'), t('ring_beep_sub'))}
      ${opt('insulin', 'syringe', t('ring_insulin'), t('ring_voice_sub'))}
      ${opt('sugar', 'drop', t('ring_sugar'), t('ring_voice_sub'))}
      ${opt('eat', 'food', t('ring_eat'), t('ring_voice_sub'))}
      ${opt('call', 'phone', t('ring_call'), t('ring_voice_sub'))}
    </div>
    <div class="section-title">${t('ring_custom')}</div>
    <section class="card">
      <textarea id="ring-text" class="ring-text" maxlength="200" rows="3" placeholder="${t('ring_custom_ph')}">${esc(R.text ?? '')}</textarea>
      <button class="btn btn-primary btn-lg" data-act="ring_send" data-kind="text" ${R.busy || blocked ? 'disabled' : ''}>${icon('sound')} ${t('ring_send')}</button>
      <p class="small muted">${t('ring_text_note')}</p>
    </section>
    ${S.plan.patient.phone ? patientPhoneCard() : ''}
  </div>`;
}
const ringErr = (e) =>
  ({ no_device: 'ring_no_device', not_member: 'ring_not_member', too_many: 'ring_too_many', empty: 'ring_empty', login: 'share_login', network: 'err_network', no_otp_server: 'err_no_server' })[e] ?? 'err_generic';
const clock = (ts) => new Date(ts).toLocaleTimeString(getLang() === 'bn' ? 'bn-BD' : 'en-GB', { hour: '2-digit', minute: '2-digit' });

async function startPatientFamily() {
  const legacy = S.settings.familyId && S.settings.familyId.length >= 9 ? S.settings.familyId : undefined;
  try {
    const code = await cloud.createFamily(S.user, legacy);
    Object.assign(S.settings, { familyId: code, role: 'patient', welcomed: true });
    save(S);
    await connectFamily();
    go('home');
  } catch (e) {
    toast = t(authErr(e?.message));
    render();
  }
}

async function doJoin(code, topic) {
  joinError = '';
  try {
    const fam = await cloud.joinFamily(S.user, code);
    Object.assign(S.settings, { familyId: fam, role: 'caregiver', welcomed: true, pendingJoin: null, pendingCode: null });
    if (topic) S.settings.ntfyTopic = topic;
    S.log = [];
    S.plan.updatedAt = 0;
    S.state.updatedAt = 0;
    save(S);
    await connectFamily();
    go('home');
  } catch (e) {
    joinError = e?.message ?? 'not_found';
    S.settings.pendingJoin = null;
    S.settings.pendingCode = code;
    save(S);
    go('joincode');
    render();
  }
}

// --- family sharing & live caregiver dashboard ----------------------------------------------------

const isCaregiver = () => S.settings.role === 'caregiver';
const patientSummary = () => {
  const P = S.plan.patient;
  return P.registered ? [P.name, t('reg_years', loc(P.age)), P.sex ? t(`sex_${P.sex}`) : ''].filter(Boolean).join(' · ') : t('reg_missing');
};

// "5 মিনিট আগে" / "5 min ago"
// "S|…" must do, "W|…" warning, "E|…" emergency → a styled list item.
function stepLi(s) {
  const [, tag, text] = String(s).match(/^([SWE])\|(.*)$/) ?? [null, 'S', s];
  const ic = tag === 'E' ? icon('alert') : tag === 'W' ? icon('info') : '';
  return `<li class="step-${tag.toLowerCase()}">${ic}${esc(text)}</li>`;
}

// Counts in Bangla digits when the app is in Bangla.
const loc = (n) => (getLang() === 'bn' ? toBn(n) : String(n));

function ago(ts) {
  const mins = Math.max(0, Math.round((Date.now() - ts) / 60000));
  const h = Math.floor(mins / 60);
  const s = mins < 1 ? t('ago_now') : mins < 60 ? t('ago_min', mins) : h < 24 ? t('ago_hour', h) : t('ago_day', Math.floor(h / 24));
  return getLang() === 'bn' ? toBn(s) : s;
}

// Patient's phone tells the family it is alive (and when the meter last synced).
let lastBeat = 0;
function heartbeat(force = false, open = native.appOnScreen()) {
  if (isCaregiver() || !sync.connected() || (!force && Date.now() - lastBeat < 60000)) return;
  lastBeat = Date.now();
  sync.pushMeta('presence', { lastSeen: Date.now(), appOpen: open, meterSync: S.settings.meter?.lastSync ?? 0, name: S.plan.patient.name, bgSync: S.presence?.bgSync ?? 0 });
}
setInterval(() => native.appOnScreen() && heartbeat(true), 60000);
// tell the family at once when the app is opened or closed
native.onAppState(() => heartbeat(true));

// Patient's phone as the family sees it: live (app open, in touch this minute), app closed but
// online (background sync), or probably offline. Worked out again every 30 s on the family's screen.
function phoneStatus(pres) {
  if (navigator.onLine === false) return { cls: '', text: t('fam_you_offline'), sub: t('fam_you_offline_sub') };
  // still starting up: say so, and don't call the patient's phone offline yet
  const loggingIn = cloud.cloudReady() && !authChecked;
  const connecting = S.user && S.settings.familyId && (sync.status.state !== 'on' || !presenceFresh);
  const starting = loggingIn || connecting;
  if (starting && sync.status.state !== 'error') return { cls: 'wait', text: t('share_connecting'), sub: '', pending: true };
  if (sync.status.state !== 'on') return { cls: '', text: t('fam_offline'), sub: '' };
  if (!pres?.lastSeen) return { cls: '', text: t('fam_waiting'), sub: '' };
  const last = Math.max(pres.lastSeen, pres.bgSync ?? 0);
  if (pres.appOpen !== false && Date.now() - pres.lastSeen < 150000) return { cls: 'on', text: t('fam_live'), sub: t('fam_live_sub') };
  if (Date.now() - last < 40 * 60000) return { cls: 'idle', text: t('fam_online'), sub: t('fam_online_sub', ago(last)) };
  return { cls: 'off', text: t('fam_phone_offline'), sub: t('fam_phone_offline_sub', ago(last)) };
}
setInterval(() => isCaregiver() && parseRoute().name === 'home' && document.visibilityState === 'visible' && softRender(), 30000);

function qrSvg(text) {
  if (typeof window.qrcode !== 'function') return '';
  const qr = window.qrcode(0, 'M');
  qr.addData(text);
  qr.make();
  return qr.createSvgTag({ cellSize: 4, margin: 2, scalable: true });
}

function viewShare() {
  const on = !!S.user && !!S.settings.familyId;
  let body;
  if (!cloud.cloudReady()) {
    body = `<div class="alert info">${icon('info')}<div>${t('share_no_cloud')}</div></div>`;
  } else if (!S.user) {
    body = `<section class="card center"><p class="muted">${t('share_login')}</p>
      <button class="btn btn-primary btn-lg" data-act="go_login">${icon('lock')} ${t('account_login')}</button></section>`;
  } else if (!on) {
    body = `<section class="card">
        <ul class="points plain">${t('share_points')
          .map((p, i) => `<li><span class="bubble">${icon(['activity', 'bell', 'shield'][i])}</span><span>${esc(p)}</span></li>`)
          .join('')}</ul>
        <button class="btn btn-primary btn-lg" data-act="share_on">${icon('users')} ${t('share_on')}</button>
      </section>`;
  } else {
    const link = joinUrl();
    body = `<section class="card center share-card">
        <div class="live-pill ${sync.status.state === 'on' ? 'on' : ''}"><span></span>${sync.status.state === 'on' ? t('share_live') : t('share_connecting')}</div>
        <div class="sub-title">${t('family_code')}</div>
        <div class="code-pill">${prettyCode(S.settings.familyId)}</div>
        <p class="muted">${t('share_scan')}</p>
        <div class="qr">${qrSvg(link)}</div>
        <div class="row">
          <a class="btn btn-primary" href="https://wa.me/?text=${encodeURIComponent(`${t('share_msg', S.plan.patient.name)} ${link}`)}">${icon('phone')} WhatsApp</a>
          <button class="btn btn-soft" data-act="share_copy">${icon('file')} ${t('share_copy')}</button>
        </div>
        <p class="small muted">${t('share_secret')}</p>
      </section>
      ${
        S.settings.ntfyTopic
          ? `<section class="card"><div class="set-head"><span class="bubble">${icon('bell')}</span><div><b>${t('share_push_title')}</b><span>${t('share_push_sub')}</span></div></div>
             <div class="topic-pill">${esc(S.settings.ntfyTopic)}</div></section>`
          : ''
      }
      <button class="btn btn-soft" data-act="go" data-to="account">${icon('users')} ${t('members')}</button>`;
  }
  return `<div class="page">${pageHead(t('share_title'))}
    <section class="alarm-hero"><span class="bubble">${icon('users')}</span><p>${t('share_sub')}</p></section>
    ${body}
  </div>`;
}

// Where each dose stands today, from the caregiver's point of view.
function doseState(d) {
  const rec = todayDose(d.id);
  if (rec) return rec.action === 'skip' ? { st: 'skipped', rec } : { st: 'done', rec };
  const [h, m] = d.injectAt.split(':').map(Number);
  const at = new Date().setHours(h, m, 0, 0);
  if (Date.now() < at) return { st: 'upcoming' };
  if (Date.now() - at <= 60 * 60000) return { st: 'due' };
  return { st: 'missed' };
}

// [icon, text, tone] for one log entry, or null for entries that aren't shown.
function recordLine(e) {
  if (e.type === 'reading') return [e.value < LIMITS.HYPO ? 'down' : 'drop', `${t('feed_reading')} ${e.value}${e.source === 'meter' ? ` (${t('feed_meter')})` : ''}`, statusClass(e.value, e.context)];
  if (e.type === 'dose') return ['syringe', e.action === 'skip' ? `${slotName(e.slot)}: ${t('feed_skipped')}` : `${slotName(e.slot)}: ${e.units} ${t('units')} ${t(`ins_${e.insulin}`)}`, ''];
  if (e.type === 'meal') return ['food', `${slotName(e.slot)}: ${e.kcal} kcal`, ''];
  if (e.type === 'hypo') return ['siren', t('feed_hypo'), 'low'];
  if (e.type === 'weight') return ['scale', `${t('btn_weight')}: ${e.kg} kg`, ''];
  if (e.type === 'tablet') return ['pill', e.name || 'Lino 5 mg', ''];
  return null;
}

function activityFeed() {
  const lang = getLang() === 'bn' ? 'bn-BD' : 'en-GB';
  const line = recordLine;
  const items = activeLog()
    .filter((e) => Date.now() - e.ts < 2 * DAY)
    .sort((a, b) => b.ts - a.ts)
    .map((e) => [e, line(e)])
    .filter(([, l]) => l)
    .slice(0, 10);
  if (!items.length) return `<p class="muted center">${t('h_empty')}</p>`;
  return `<ul class="feed">${items
    .map(
      ([e, [ic, text, tone]]) => `<li><span class="bubble ${tone}">${icon(ic)}</span><div><b>${esc(text)}</b>
        <span>${new Date(e.ts).toLocaleString(lang, { weekday: 'short', hour: '2-digit', minute: '2-digit', hour12: false })} · ${ago(e.ts)}</span></div></li>`,
    )
    .join('')}</ul>`;
}

function viewFamily() {
  flow = lowFlow = highFlow = readingFlow = foodFlow = pantryDraft = null;
  const P = S.plan;
  const pres = S.presence;
  const phone = phoneStatus(pres);
  const alerts = currentAlerts().filter((a) => a.level !== 'info');
  const rs = readingsSorted();
  const last = rs.at(-1);
  const prev = rs.at(-2);
  const trend = last && prev ? (last.value - prev.value > 1 ? 'up' : prev.value - last.value > 1 ? 'down' : '') : '';
  const lowsWeek = rs.filter((r) => Date.now() - r.ts < 7 * DAY && r.value < LIMITS.HYPO).length;
  const todayCount = rs.filter((r) => isToday(r.ts)).length;
  const kcal = Object.values(eatenToday()).reduce((a, b) => a + b, 0);
  const lastTone = last ? statusClass(last.value, last.context) : '';

  const sugarCard = last
    ? `<section class="card fam-sugar ${lastTone}">
        <div class="eyebrow">${icon('drop')} ${t('fam_last_sugar')}</div>
        <div class="fam-value"><b>${last.value}</b><span>mmol/L</span>${trend ? `<span class="trend ${trend}">${icon(trend === 'up' ? 'up' : 'down')}</span>` : ''}</div>
        <div class="fam-meta"><span class="badge ${lastTone}">${t(`st_${lastTone}`)}</span><span>${t(`ctx_${last.context}`)} · ${ago(last.ts)}</span></div>
        <div class="fam-mini"><span><b>${loc(todayCount)}</b> ${t('fam_today_checks')}</span><span class="${lowsWeek ? 'bad' : ''}"><b>${loc(lowsWeek)}</b> ${t('fam_lows_week')}</span></div>
      </section>`
    : `<section class="card"><p class="muted center">${t('fam_no_reading')}</p></section>`;

  const doseRows = P.doses
    .map((d) => {
      const { st, rec } = doseState(d);
      const badge = {
        done: `<span class="badge done">${icon('check')} ${rec?.units} ${t('units')} · ${rec ? hhmm(rec.ts) : ''}</span>`,
        skipped: `<span class="badge">${t('fam_skipped')}</span>`,
        upcoming: `<span class="badge">${d.injectAt}</span>`,
        due: `<span class="badge late">${t('due_now')}</span>`,
        missed: `<span class="badge missed">${t('fam_missed')}</span>`,
      }[st];
      return `<div class="sched-row ${st === 'done' ? 'done' : ''}">
        <span class="bubble">${icon(SLOT_ICON[d.id])}</span>
        <div><div class="sched-name">${slotName(d.id)}</div><div class="sched-time">${d.injectAt} · ${t(`ins_${d.insulin}`)} ${doseUnits(d)}</div></div>
        ${badge}
      </div>`;
    })
    .join('');

  const body = `<header class="home-head">
      <div>
        <div class="home-day">${esc(P.patient.name)}</div>
        <div class="phone-pill ${phone.cls}"><span class="pill-dot"></span>${icon(phone.cls === 'off' ? 'wifi_off' : 'mobile')}<b>${phone.text}</b></div>
        ${phone.sub ? `<div class="phone-state-sub">${phone.sub}</div>` : ''}
      </div>
      ${P.patient.phone ? `<a class="round-btn" href="tel:${esc(P.patient.phone)}" aria-label="${t('fam_call')}">${icon('phone')}</a>` : `<button class="round-btn" data-act="go" data-to="report" aria-label="${t('btn_report')}">${icon('file')}</button>`}
    </header>
    ${mineBanner()}
    ${pres?.lastSeen && Date.now() - Math.max(pres.lastSeen, pres.bgSync ?? 0) > 3 * 3600000 ? `<div class="alert yellow">${icon('alert')}<div>${t('fam_quiet', ago(Math.max(pres.lastSeen, pres.bgSync ?? 0)))}</div></div>` : ''}
    ${alerts.map((a) => alertCard(a)).join('')}
    ${sugarCard}
    ${phoneReachable()
      ? `<button class="btn btn-primary btn-lg" data-act="go" data-to="ring">${icon('sound')} ${t('ring_btn')}</button>
        ${phoneStatus(S.presence).cls === 'idle' && S.plan.patient.phone ? callPatientBtn('btn btn-soft') : ''}`
      : `<div class="alert red">${icon('alert')}<div>${t('ring_offline')}</div></div>${callPatientBtn()}`}
    ${S.plan.patient.phone ? '' : patientPhoneCard()}
    <div class="section-title">${t('fam_doses')}</div>
    <section class="card schedule">${doseRows}</section>
    ${P.doses.length || generalTimes(P.meds ?? []).length ? `<button class="btn btn-soft" data-act="go" data-to="dosebook">${icon('check')} ${t('db_open_cg')}</button>` : ''}
    <section class="card">
      <div class="kcal-row"><span class="eyebrow">${icon('food')} ${t('fam_food')}</span><b>${kcal} / ${P.diet.kcalTarget}</b></div>
      <div class="bar"><span style="width:${Math.min(100, Math.round((kcal / P.diet.kcalTarget) * 100))}%" class="${kcal > P.diet.kcalMax ? 'over' : ''}"></span></div>
    </section>
    ${weekBars()}
    <div class="section-title">${t('fam_activity')}</div>
    <section class="card feed-scroll">${activityFeed()}</section>
    ${
      S.settings.ntfyTopic
        ? `<a class="btn btn-soft" href="https://ntfy.sh/${encodeURIComponent(S.settings.ntfyTopic)}">${icon('bell')} ${t('fam_get_alerts')}</a>`
        : ''
    }
    <button class="btn" style="margin-top:10px" data-act="go" data-to="report">${icon('file')} ${t('btn_report')}</button>`;
  return tabPage('home', body);
}

// --- sugar tab ------------------------------------------------------------------------------

function guessContext() {
  const h = new Date().getHours();
  if (h < 5) return 'night_3am';
  if (!todayDose('breakfast') && h < 11) return 'fasting';
  if (!todayDose('lunch') && h >= 11 && h < 15) return 'pre_lunch';
  if (!todayDose('dinner') && h >= 18 && h < 22) return 'pre_dinner';
  if (h >= 21) return 'bedtime';
  return 'other';
}

function viewReading() {
  readingFlow ??= { ctx: guessContext() };
  const ctxs = ['fasting', 'pre_lunch', 'pre_dinner', 'post_meal', 'bedtime', 'night_3am', 'other'];
  const recent = readingsSorted().slice(-6).reverse();
  return tabPage(
    'reading',
    `<div class="q" style="margin-top:8px">${t('btn_measure')}</div>
    <div class="q-sub">${t('which_time')}</div>
    <div class="chips">${ctxs
      .map((c) => `<button class="chip ${readingFlow.ctx === c ? 'on' : ''}" data-act="ctx" data-c="${c}">${t(`ctx_${c}`)}</button>`)
      .join('')}</div>
    ${meterButton('free_meter')}
    ${keypad('free_reading')}
    ${
      recent.length
        ? `<div class="section-title">${t('recent_readings')}</div>
      <section class="card" style="padding:6px"><ul class="readings">${recent
        .map(
          (r) => `<li><div><b>${t(`ctx_${r.context}`)}</b><div class="muted small">${dayKey(r.ts) === dayKey(Date.now()) ? t('today') : dayKey(r.ts)} · ${hhmm(r.ts)}</div></div>
          <span class="val ${statusClass(r.value, r.context)}">${r.value}</span></li>`,
        )
        .join('')}</ul></section>`
        : ''
    }`,
  );
}

// --- food tab --------------------------------------------------------------------------------

function mealSlotGuess() {
  const h = new Date().getHours();
  return h < 11 ? 'breakfast' : h < 16 ? 'lunch' : h < 19 ? 'snack' : 'dinner';
}

const foodName = (id) => FOOD[id]?.[getLang()] ?? id;
const portion = (id) => FOOD[id]?.portion[getLang()] ?? '';
const homeFoods = () => S.plan.diet.homeFoods ?? null;
const BN_DIGITS = '০১২৩৪৫৬৭৮৯';
const toBn = (n) => String(n).replace(/\d/g, (d) => BN_DIGITS[d]);
// 1.5 → "১½", 0.25 → "¼" — easier to read than decimals in a kitchen.
const fmtQty = (q) => {
  const whole = Math.floor(q + 1e-9);
  const frac = { 0.25: '¼', 0.5: '½', 0.75: '¾' }[Math.round((q - whole) * 4) / 4] ?? '';
  const w = whole ? (getLang() === 'bn' ? toBn(whole) : String(whole)) : frac ? '' : '0';
  return w + frac;
};
// "১ কাপ" × 1.5 → "১½ কাপ"; falls back to "2 × ½ কাপ" for portions that don't start with 1.
const qtyLabel = (i) => {
  const p = FOOD[i.id].portion[getLang()];
  if (i.qty === 1) return p;
  if (/^[1১](?![\d০-৯])/.test(p)) return fmtQty(i.qty) + p.slice(1);
  return `${fmtQty(i.qty)} × ${p}`;
};

const dayIndex = (offset = 0) => Math.floor((Date.now() - new Date().getTimezoneOffset() * 60000) / DAY) + offset;

function dishName(id) {
  const r = recipeOf(id);
  return r.fruit ? t('tea_fruit', foodName(r.fruit)) : r[getLang()];
}

// Portion shown next to a dish: cups of rice, number of roti, pieces of fish...
function dishPortion(d) {
  const r = recipeOf(d.id);
  if (d.id === 'veg_khichuri') return `${fmtQty(d.scale)} ${t('bowl')}`;
  const key = r.fruit ?? r.need[0] ?? Object.keys(r.items)[0];
  const grams = FOOD[key]?.grams && r.role !== 'veg' ? ` (~${Math.round(FOOD[key].grams * r.items[key] * d.scale)} g)` : '';
  return qtyLabel({ id: key, qty: r.items[key] * d.scale }) + grams;
}

function viewFood() {
  foodFlow ??= { tab: 'menu', slot: mealSlotGuess(), items: {}, shuffle: 0, all: false };
  const tab = (v, ic, label) => `<button class="${foodFlow.tab === v ? 'on' : ''}" data-act="food_tab" data-v="${v}">${label}</button>`;
  const seg = `<div class="seg" style="margin:8px 0 14px">${tab('menu', '', t('tab_menu'))}${tab('have', '', t('tab_have'))}${tab('log', '', t('tab_log'))}</div>`;
  const body = foodFlow.tab === 'menu' ? foodMenu() : foodFlow.tab === 'have' ? foodHave() : foodLog();
  return tabPage('food', seg + body);
}

function pantryPrompt() {
  return `<section class="card center">
    <span class="bubble" style="margin:0 auto 12px;width:64px;height:64px">${icon('food')}</span>
    <div class="q" style="font-size:1.2rem">${t('pantry_title')}</div>
    <p class="muted">${t('pantry_prompt')}</p>
    <button class="btn btn-primary btn-lg" data-act="go" data-to="pantry">${t('pantry_choose')} ${icon('chev')}</button>
  </section>`;
}

// Today's meals already logged, by slot.
function eatenToday() {
  const eaten = {};
  for (const m of activeLog()) if (m.type === 'meal' && isToday(m.ts)) eaten[m.slot] = (eaten[m.slot] ?? 0) + m.kcal;
  return eaten;
}

// Learns carb portions from after-meal sugar (saved once per change), then builds the menu.
// offset 1 = tomorrow (nothing eaten yet, no swaps).
function currentMenu(offset = foodFlow?.dayOffset ?? 0) {
  const adapt = adaptCarbs(S.plan, activeLog(), S.state.carbs ?? {});
  if (adapt.changes.length) {
    S.state.carbs = adapt.carbs;
    S.state.carbChanges = [...(S.state.carbChanges ?? []), ...adapt.changes.map((c) => ({ ...c, ts: Date.now() }))].slice(-20);
    saveState();
  }
  const opts = {
    riceCups: S.plan.diet.riceCupsPerMeal,
    day: dayIndex(offset) + (offset ? 0 : foodFlow?.shuffle ?? 0),
    kcalTarget: S.plan.diet.kcalTarget,
    carbSteps: Object.fromEntries(Object.entries(S.state.carbs ?? {}).map(([k, v]) => [k, v.step])),
    eaten: offset ? {} : eatenToday(),
  };
  const home = homeFoods() ?? DEFAULT_HOME_FOODS;
  const base = suggestMenu(home, opts);
  const menu = offset ? base : suggestMenu(home, { ...opts, swaps: foodFlow?.swaps ?? {} });
  return { base, menu, stats: adapt.stats, eaten: opts.eaten };
}

function hygieneCard(open = false) {
  return `<details class="card plan" ${open ? 'open' : ''}><summary><span class="bubble">${icon('heart')}</span>${t('hygiene_title')}</summary>
    <ul>${t('hygiene').map((x) => `<li>${esc(x)}</li>`).join('')}</ul></details>`;
}

function foodMenu() {
  const home = homeFoods();
  if (!home) return pantryPrompt();
  const tomorrow = foodFlow.dayOffset === 1;
  const { base, menu: s, stats, eaten } = currentMenu();
  const { kcalTarget: target, kcalMax: max } = S.plan.diet;
  const eatenKcal = Object.values(eaten).reduce((a, b) => a + b, 0);
  const pct = Math.min(100, Math.round((s.kcal / max) * 100));

  // Why portions differ from the plan, from her own readings.
  const notes = [];
  for (const slot of ['breakfast', 'lunch', 'dinner']) {
    const step = S.state.carbs?.[slot]?.step ?? 0;
    const last = (S.state.carbChanges ?? []).filter((c) => c.slot === slot).at(-1);
    if (step < 0) notes.push(t('adapt_high', slotName(slot), last?.avg ?? stats[slot].avg));
    else if (last?.reason === 'low' && Date.now() - last.ts < 7 * DAY) notes.push(t('adapt_low', slotName(slot)));
  }
  const unmeasured = ['lunch', 'dinner'].filter((slot) => !stats[slot].n);

  const mealCard = (slot) => {
    const time = slot === 'snack' ? S.plan.snackAt : mealAtFor(slot);
    if (slot in eaten) {
      return `<section class="card meal-card eaten"><div class="meal-head"><span class="bubble">${icon('check')}</span>
        <div><b>${slotName(slot)}</b><div class="muted small">${time} · ${t('eaten_label', Math.round(eaten[slot]))}</div></div></div></section>`;
    }
    const dishes = s.meals[slot];
    const kcal = dishes.reduce((sum, d) => sum + dishKcal(d.id, d.scale), 0);
    const rows = dishes
      .map((d, idx) => {
        const r = recipeOf(d.id);
        const canSwap = !tomorrow && alternativesFor(home, base.meals[slot][idx].id).length > 0;
        const tag = d.extra ? ` <em class="tag">${t('not_home')}</em>` : '';
        const name = r.steps
          ? `<button class="dish-link" data-act="go" data-to="recipe/${d.id}">${esc(dishName(d.id))}${tag}</button>`
          : `<span>${esc(dishName(d.id))}${tag}</span>`;
        const swap = canSwap ? `<button class="swap-btn" data-act="swap" data-key="${slot}:${idx}" aria-label="${t('swap')}">${icon('refresh')}</button>` : '<span></span>';
        return `<li><span class="dot ${r.role === 'carb' ? 'limit' : 'good'}"></span>${name}<b>${esc(dishPortion(d))}</b>${swap}</li>`;
      })
      .join('');
    const actions = tomorrow
      ? ''
      : `<div class="row">
          <button class="btn btn-soft" data-act="ate_menu" data-slot="${slot}">${icon('check')} ${t('ate_this')}</button>
          <button class="btn" data-act="go" data-to="offplan/${slot}">${t('couldnt')}</button>
        </div>`;
    return `<section class="card meal-card">
      <div class="meal-head"><span class="bubble">${icon(SLOT_ICON[slot])}</span>
        <div><b>${slotName(slot)}</b><div class="muted small">${time} · ~${Math.round(kcal)} kcal</div></div></div>
      <ul class="meal-items">${rows}</ul>${actions}
    </section>`;
  };

  const chips = (ids, dot) =>
    `<div class="food-chips">${ids.map((id) => `<span class="fchip"><span class="dot ${dot ?? FOOD[id].rating}"></span>${esc(foodName(id))}</span>`).join('')}</div>`;
  const dayToggle = `<div class="chips">
    <button class="chip ${tomorrow ? '' : 'on'}" data-act="menu_day" data-v="0">${t('day_today')}</button>
    <button class="chip ${tomorrow ? 'on' : ''}" data-act="menu_day" data-v="1">${t('day_tomorrow')}</button></div>`;
  const shopping = tomorrow
    ? `<section class="card"><div class="meal-head"><span class="bubble">${icon('bell')}</span><b>${t('shopping_title')}</b></div>
        ${s.shopping.length ? chips(s.shopping, 'good') : `<p class="muted">${t('shopping_none')}</p>`}</section>`
    : '';
  return `${dayToggle}
    <section class="card budget">
      <div class="kcal-row"><span class="muted small">${tomorrow ? `~${s.kcal} / ${target} kcal` : t('budget', eatenKcal, s.kcal, target)}</span><b>≤ ${max}</b></div>
      <div class="bar"><span style="width:${pct}%" class="${s.kcal > max ? 'over' : ''}"></span></div>
      <div class="muted small goal">${icon('drop')} ${t('goal_line')}</div>
    </section>
    ${shopping}
    ${!tomorrow && s.kcal > max ? `<div class="alert orange">${icon('alert')}<div>${t('over_max', max)}</div></div>` : ''}
    ${notes.length ? `<div class="alert info">${icon('chart')}<div>${notes.map(esc).join('<br>')}<br><span class="small">${t('adapt_insulin')}</span></div></div>` : ''}
    ${!tomorrow && unmeasured.length ? `<div class="alert info">${icon('clock')}<div>${t('measure_after', unmeasured.map(slotName).join(getLang() === 'bn' ? ' ও ' : ' and '))}</div></div>` : ''}
    ${['breakfast', 'lunch', 'snack', 'dinner'].map(mealCard).join('')}
    ${tomorrow ? '' : `<button class="btn" data-act="menu_shuffle">${t('other_menu')}</button>`}
    ${hygieneCard()}
    ${s.tips.length ? `<div class="section-title">${t('tips_title')}</div><section class="card tips">${s.tips.map((k) => `<p>${icon('info')}<span>${t(`tip_${k}`)}</span></p>`).join('')}</section>` : ''}
    ${s.limits.length ? `<div class="section-title">${t('limit_title')}</div>${chips(s.limits)}` : ''}
    ${s.addIdeas.length ? `<div class="section-title">${t('add_title')}</div>${chips(s.addIdeas, 'good')}` : ''}
    <button class="btn btn-soft" style="margin-top:18px" data-act="go" data-to="pantry">${icon('sliders')} ${t('pantry_edit')}</button>`;
}

// "What do we have right now?" — pick ingredients, the app sizes the meal.
function foodHave() {
  foodFlow.have ??= new Set();
  const slot = foodFlow.slot;
  const budget = MEAL_SHARE[slot] * S.plan.diet.kcalTarget;
  const groups = ['carb', 'fish', 'meat', 'dal', 'veg'];
  const picker = groups
    .map(
      (g) => `<div class="section-title">${t(`grp_${g}`)}</div><div class="food-chips">${CATALOG.filter((f) => f.group === g && !f.hidden && f.rating !== 'avoid')
        .map(
          (f) => `<button class="fchip pick ${foodFlow.have.has(f.id) ? 'on' : ''}" data-act="have_toggle" data-f="${f.id}"><span class="dot ${f.rating}"></span>${esc(f[getLang()])}<span class="tick">${icon('check')}</span></button>`,
        )
        .join('')}</div>`,
    )
    .join('');
  let result = `<p class="muted center">${t('have_pick')}</p>`;
  if (foodFlow.have.size) {
    const m = pantryMeal([...foodFlow.have], budget);
    const rows = Object.entries(m.items)
      .map(([id, q]) => {
        const g = FOOD[id].grams ? ` (~${Math.round(FOOD[id].grams * q)} g)` : '';
        const rec = recipeFor(id);
        const how = rec ? `<button class="dish-link small" data-act="go" data-to="recipe/${rec.id}">${t('how_cook')} →</button>` : '';
        return `<li><span class="dot ${FOOD[id].rating}"></span><span>${esc(foodName(id))}<br>${how}</span><b>${esc(qtyLabel({ id, qty: q }))}${g}</b><span></span></li>`;
      })
      .join('');
    const warn = [m.missing.protein && t('have_missing_protein'), m.missing.veg && t('have_missing_veg'), m.missing.carb && t('have_missing_carb'), m.over && t('have_over')].filter(Boolean);
    result = `<section class="card meal-card">
      <div class="meal-head"><span class="bubble">${icon('check')}</span><div><b>${t('have_result')}</b><div class="muted small">~${m.kcal} / ${m.budget} kcal</div></div></div>
      <ul class="meal-items">${rows}</ul>
      <p class="small muted">${t('have_oil', m.oil)}</p>
      ${warn.map((w) => `<div class="alert info">${icon('info')}<div>${esc(w)}</div></div>`).join('')}
      <button class="btn btn-primary" data-act="have_log">${icon('check')} ${t('ate_this')}</button>
    </section>`;
  }
  return `<div class="q" style="font-size:1.2rem">${t('have_title')}</div>
    <div class="q-sub">${t('have_sub')}</div>
    <div class="chips">${['breakfast', 'lunch', 'snack', 'dinner']
      .map((s) => `<button class="chip ${slot === s ? 'on' : ''}" data-act="food_slot" data-s="${s}">${slotName(s)}</button>`)
      .join('')}</div>
    <div class="alert info">${icon('food')}<div>${t('have_budget', slotName(slot), Math.round(budget))}</div></div>
    ${result}
    ${picker}`;
}

function viewRecipe(id) {
  const r = recipeOf(id ?? '');
  if (!r?.steps) return viewHome();
  const lang = getLang();
  const items = Object.entries(r.items)
    .map(([f, q]) => `<li><span class="dot ${FOOD[f].rating}"></span><span>${esc(foodName(f))}</span><b>${esc(qtyLabel({ id: f, qty: q }))}</b><span></span></li>`)
    .join('');
  return `<div class="page">${pageHead(t('how_cook'))}
    <section class="dose-hero recipe-hero"><div class="label">${icon('clock')} ${t('mins', r.mins)}</div><h1>${esc(r[lang])}</h1></section>
    <section class="card"><b>${t('ingredients')}</b><ul class="meal-items">${items}</ul></section>
    <div class="section-title">${t('cook_steps')}</div>
    ${sayBtn(r.steps[lang].join(' '))}
    <ol class="steps">${r.steps[lang].map((x) => `<li>${esc(x)}</li>`).join('')}</ol>
    ${hygieneCard(true)}
  </div>`;
}

// Next 7 evenings: tomorrow's lunch and dinner plus what to buy.
async function scheduleMenuReminders() {
  if (!native.isNative || !S.settings.reminders || S.settings.role !== 'patient' || !homeFoods()) return;
  const [h, m] = (S.plan.diet.menuReminderAt ?? '21:00').split(':').map(Number);
  const list = [];
  for (let i = 0; i < 7; i++) {
    const at = new Date();
    at.setDate(at.getDate() + i);
    at.setHours(h, m, 0, 0);
    if (at.getTime() < Date.now()) continue;
    const opts = { riceCups: S.plan.diet.riceCupsPerMeal, day: dayIndex(i + 1), kcalTarget: S.plan.diet.kcalTarget };
    const s = suggestMenu(homeFoods(), opts);
    const main = (slot) => dishName(s.meals[slot][1].id);
    list.push({ id: 300 + i, at: at.getTime(), body: t('tomorrow_body', main('lunch'), main('dinner'), s.shopping.map(foodName).join(', ')) });
  }
  for (let i = 0; i < 7; i++) native.cancelAlarm(60 + i);
  for (const n of list) {
    native.alarmOnce({ id: n.id - 240, at: n.at, gentle: true, repeat: false, route: 'food', title: t('tomorrow_title'), body: n.body, clip: clip('menu_tomorrow') })?.catch?.(() => {});
  }
}

// "Couldn't follow the menu" — practical next steps for each situation.
function viewOffplan(slot) {
  const opt = (ic, title, body, cls = '') =>
    `<details class="card offplan ${cls}"><summary><span class="bubble">${icon(ic)}</span><b>${title}</b>${icon('chev')}</summary><div class="offplan-body">${body}</div></details>`;
  const list = (items, cls = '') => `<ol class="steps ${cls}">${items.map((x) => `<li>${esc(x)}</li>`).join('')}</ol>`;
  const logBtn = `<button class="btn btn-primary" data-act="offplan_log" data-slot="${slot ?? ''}">${t('off_other_btn')}</button>`;
  return `<div class="page">${pageHead(slot ? slotName(slot) : t('tab_menu'))}
    <div class="q">${t('off_title')}</div>
    <div class="q-sub">${t('off_sub')}</div>
    ${opt('alert', t('off_cant'), list(t('cant_steps'), 'red') + telBtn(S.plan.doctor.phone, t('call_doctor')), 'urgent')}
    ${opt('food', t('off_other'), `<p>${t('off_other_sub')}</p>${logBtn}`)}
    ${opt('sliders', t('off_missing'), `<p>${t('off_missing_sub')}</p><button class="btn btn-soft" data-act="go" data-to="food">${t('off_missing_btn')}</button>`)}
    ${opt('users', t('off_party'), list(t('party_tips')))}
    ${opt('bowl', t('off_overate'), list(t('overate_steps')) + logBtn)}
  </div>`;
}

function foodLog() {
  const todayMeals = activeLog().filter((e) => e.type === 'meal' && isToday(e.ts));
  const dayKcal = todayMeals.reduce((s, m) => s + m.kcal, 0);
  const cur = mealTotals(foodFlow.items);
  const target = S.plan.diet.kcalTarget;
  const total = dayKcal + cur.kcal;
  const pct = Math.min(100, Math.round((total / target) * 100));
  const home = homeFoods();
  const list = (home && !foodFlow.all ? CATALOG.filter((f) => home.includes(f.id) || foodFlow.items[f.id]) : CATALOG).filter((f) => !f.hidden);
  return `<div class="q-sub">${t('food_which')}</div>
    <div class="chips">${['breakfast', 'lunch', 'snack', 'dinner']
      .map((s) => `<button class="chip ${foodFlow.slot === s ? 'on' : ''}" data-act="food_slot" data-s="${s}">${slotName(s)}</button>`)
      .join('')}</div>
    ${home ? `<div class="chips"><button class="chip ${foodFlow.all ? '' : 'on'}" data-act="food_all" data-v="0">${t('show_home')}</button><button class="chip ${foodFlow.all ? 'on' : ''}" data-act="food_all" data-v="1">${t('show_all')}</button></div>` : ''}
    <div class="foods">${list.map((f) => {
      const n = foodFlow.items[f.id] ?? 0;
      return `<div class="food ${n ? 'on' : ''} ${f.rating === 'avoid' ? 'warn-food' : ''}">
        <div><div class="fname"><span class="dot ${f.rating}"></span>${esc(f[getLang()])}</div><div class="fkcal">${esc(f.portion[getLang()])} · ~${f.kcal} kcal</div></div>
        <div class="stepper-ctl">
          <button data-act="food" data-f="${f.id}" data-d="-1" aria-label="-">${icon('minus')}</button>
          <b>${n}</b>
          <button data-act="food" data-f="${f.id}" data-d="1" aria-label="+">${icon('plus')}</button>
        </div>
      </div>`;
    }).join('')}</div>
    <section class="card total-card">
      <div class="total-row">
        <div class="total-info">
          <div class="kcal-row"><span class="muted small">${t('food_today')}</span><span><b>${total}</b><span class="muted small"> / ${target}</span></span></div>
          <div class="bar"><span style="width:${pct}%" class="${total > target ? 'over' : ''}"></span></div>
          <div class="muted small">+${cur.kcal} kcal · ${cur.carb} g ${t('food_carb')}</div>
        </div>
        <button class="btn btn-primary save-meal" data-act="food_save" ${cur.kcal ? '' : 'disabled'} aria-label="${t('food_save')}">${icon('check')}</button>
      </div>
    </section>`;
}

// --- foods at home -------------------------------------------------------------------------------

let pantryDraft = null;

function viewPantry() {
  pantryDraft ??= new Set(homeFoods() ?? DEFAULT_HOME_FOODS);
  const groups = GROUPS.map(
    (g) => `<div class="section-title">${t(`grp_${g}`)}</div>
    <div class="food-chips">${CATALOG.filter((f) => f.group === g && !f.hidden)
      .map(
        (f) => `<button class="fchip pick ${pantryDraft.has(f.id) ? 'on' : ''}" data-act="pantry_toggle" data-f="${f.id}">
          <span class="dot ${f.rating}"></span>${esc(f[getLang()])}<span class="tick">${icon('check')}</span></button>`,
      )
      .join('')}</div>`,
  ).join('');
  return `<div class="page">${pageHead(t('pantry_title'))}
    <p class="center muted">${t('pantry_sub')}</p>
    <div class="legend"><span><span class="dot good"></span>${t('rate_good')}</span><span><span class="dot limit"></span>${t('rate_limit')}</span><span><span class="dot avoid"></span>${t('rate_avoid')}</span></div>
    ${groups}
    <div class="sticky-save"><div class="muted small center" id="pantry-count">${t('pantry_count', pantryDraft.size)}</div>
    <button class="btn btn-primary btn-lg" data-act="pantry_save">${icon('check')} ${t('save')}</button></div>
  </div>`;
}

// --- more tab ---------------------------------------------------------------------------------

function menuRow(act, to, ic, title, sub = '') {
  return `<button class="menu-row" data-act="${act}" data-to="${to}"><span class="bubble">${icon(ic)}</span>
    <div><b>${esc(title)}</b>${sub ? `<span>${esc(sub)}</span>` : ''}</div>${icon('chev')}</button>`;
}

function viewMore() {
  const seg = (act, cur, opts) =>
    `<div class="seg">${opts.map(([v, label]) => `<button class="${cur === v ? 'on' : ''}" data-act="${act}" data-v="${v}">${label}</button>`).join('')}</div>`;
  const info = currentAlerts().find((a) => a.level === 'info');
  return tabPage(
    'more',
    `<div class="q" style="margin-top:8px">${t('more_title')}</div>
    ${info ? `<div class="alert info">${icon('info')}<div>${esc(alertText(info))}</div></div>` : ''}
    ${isCaregiver() ? `<section class="card menu">
      ${menuRow('go', 'account', 'user', t('account'), S.user ? S.user.email : t('account_login'))}
      ${menuRow('go', 'patient', 'heart', t('reg_edit_title'), patientSummary())}
      ${menuRow('go', 'ring', 'sound', t('ring_title'), t('ring_menu_sub'))}
      ${menuRow('go', 'meds', 'pill', t('meds_title'), medsSummary())}
      ${menuRow('go', 'whose', 'users', t('wh_title'), t('wh_menu_sub'))}
      ${menuRow('go', 'people', 'heart', t('pp_title'), people().length ? people().map((p) => p.name).join(', ') : t('pp_menu_sub'))}
      ${menuRow('go', 'cgalerts', 'bell', t('cg_alerts'), S.settings.ntfyTopic ? t('cg_alerts_on') : t('cg_alerts_off'))}
      ${menuRow('go', 'settings', 'syringe', t('cg_plan'), t('cg_plan_sub'))}
      ${menuRow('go', 'stock', 'pill', t('stock_title'))}
      ${menuRow('go', 'report', 'file', t('btn_report'))}
    </section>` : `<section class="card menu">
      ${menuRow('go', 'account', 'user', t('account'), S.user ? S.user.email : t('account_login'))}
      ${menuRow('go', 'patient', 'heart', t('reg_edit_title'), patientSummary())}
      ${menuRow('go', 'meds', 'pill', t('meds_title'), medsSummary())}
      ${menuRow('go', 'alarms', 'bell', t('alarm_section'), S.settings.reminders ? t('alarm_minutes', S.settings.alarm.repeatMinutes) : '')}
      ${menuRow('go', 'share', 'users', t('share_title'), S.settings.familyId ? t('share_is_on') : t('share_is_off'))}
      ${menuRow('go', 'meter', 'bluetooth', t('meter_title'), S.settings.meter ? S.settings.meter.name : t('meter_not_paired'))}
      ${menuRow('go', 'whose', 'users', t('wh_title'), t('wh_menu_sub'))}
      ${menuRow('go', 'people', 'heart', t('pp_title'), people().length ? people().map((p) => p.name).join(', ') : t('pp_menu_sub'))}
      ${menuRow('go', 'pantry', 'food', t('pantry_title'), homeFoods() ? t('pantry_count', homeFoods().length) : t('pantry_choose'))}
      ${menuRow('go', 'weight', 'scale', t('btn_weight'), `${t('height')} · ${t('bmi')}`)}
      ${menuRow('go', 'stock', 'pill', t('stock_title'))}
      ${menuRow('go', 'report', 'file', t('btn_report'))}
      ${menuRow('go', 'settings', 'sliders', t('btn_settings'), t('family_section'))}
    </section>`}
    <div class="section-title">${t('text_size')}</div>
    ${textSizePicker()}
    <div class="section-title">${t('theme')}</div>
    ${seg('theme', S.settings.theme, [['light', `${icon('sun')} ${t('theme_light')}`], ['dark', `${icon('moon')} ${t('theme_dark')}`], ['system', t('theme_system')]])}
    <div class="section-title">${t('language')}</div>
    ${seg('set_lang', getLang(), [['bn', 'বাংলা'], ['en', 'English']])}`,
  );
}

// Bangla voice: status, one-tap install of Google's Bangla voice, and a test.
let voiceState = null;
function voiceRow() {
  if (native.isNative && voiceState == null) {
    voiceState = 'checking';
    native.voiceStatus().then((s) => {
      voiceState = s?.bangla ?? 'not_supported';
      render();
    });
  }
  const ttsOk = voiceState === 'ok';
  const ok = native.isNative || ttsOk;
  const msg = native.isNative
    ? t('voice_recorded') + (ttsOk || voiceState === 'checking' ? '' : ` ${t('voice_read_hint')}`)
    : voiceState === 'checking' ? t('voice_checking') : t(`voice_${ttsOk ? 'ok' : voiceState === 'missing_data' ? 'download' : 'none'}`);
  return `<div class="voice-row">
    <span class="bubble ${ok ? 'ok-bubble' : voiceState === 'checking' ? '' : 'warn-bubble'}">${icon(ok ? 'check' : 'languages')}</span>
    <div><b>${t('voice_title')}</b><span>${msg}</span></div>
    <div class="row">
      ${ttsOk || voiceState === 'checking' ? '' : `<button class="btn ${ok ? 'btn-soft' : 'btn-primary'}" data-act="voice_install">${t('voice_install')}</button>`}
      <button class="btn btn-soft" data-act="voice_test">${icon('sound')} ${t('voice_test')}</button>
    </div>
  </div>`;
}

// Alarm settings + checks that the phone will actually let the alarm ring.
let alarmChecks = null;
function viewAlarms() {
  const A = S.settings.alarm;
  const seg = (key, cur, opts) =>
    `<div class="seg">${opts.map(([v, label]) => `<button class="${cur === v ? 'on' : ''}" data-act="alarm_set" data-k="${key}" data-v="${v}">${label}</button>`).join('')}</div>`;
  const toggle = (act, on, ic, title, sub) =>
    `<label class="menu-row"><span class="bubble">${icon(ic)}</span><div><b>${title}</b>${sub ? `<span>${sub}</span>` : ''}</div>
      <span class="switch"><input type="checkbox" data-act="${act}" ${on ? 'checked' : ''}><span></span></span></label>`;
  if (native.isNative && !alarmChecks) native.alarmStatus().then((s) => ((alarmChecks = s ?? {}), render()));
  const checks = native.isNative && alarmChecks
    ? `<div class="section-title">${t('chk_title')}</div><section class="card menu">${['notifications', 'fullScreen', 'exact', 'battery']
        .map((k) => `<div class="menu-row"><span class="bubble ${alarmChecks[k] ? 'ok-bubble' : 'warn-bubble'}">${icon(alarmChecks[k] ? 'check' : 'alert')}</span>
          <div><b>${t(`chk_${k}`)}</b></div>${alarmChecks[k] ? '' : `<button class="btn btn-soft fix-btn" data-act="alarm_fix" data-k="${k}">${t('chk_fix')}</button>`}</div>`)
        .join('')}</section><p class="small muted">${t('chk_hint')}</p>`
    : '';
  return `<div class="page">${pageHead(t('alarm_section'))}
    <section class="alarm-hero"><span class="bubble">${icon('bell')}</span><p>${t('alarm_sub')}</p></section>
    <section class="card menu">
      ${toggle('reminders', S.settings.reminders, 'bell', t('reminders'), t('reminders_sub'))}
      ${toggle('alarm_voice', A.voice, 'sound', t('alarm_voice'))}
      ${voiceRow()}
      ${native.isNative ? toggle('bg_keep', S.settings.background, 'shield', t('bg_keep'), t('bg_keep_sub')) : ''}
    </section>
    <div class="section-title">${t('alarm_repeat')}</div>
    ${seg('repeatMinutes', A.repeatMinutes, [5, 10, 15].map((m) => [m, t('alarm_minutes', m)]))}
    <div class="section-title">${t('alarm_max')}</div>
    ${seg('maxRepeats', A.maxRepeats, [3, 6, 10].map((n) => [n, `${n}×`]))}
    <button class="btn btn-primary btn-lg" style="margin-top:20px" data-act="alarm_test">${icon('bell')} ${t('alarm_test')}</button>
    ${checks}
  </div>`;
}

function viewWeight() {
  const ws = activeLog()
    .filter((e) => e.type === 'weight')
    .sort((a, b) => b.ts - a.ts);
  const start = S.plan.diet.startWeight;
  const latest = ws[0]?.kg ?? start;
  const { ft, inch } = cmToFtIn(S.plan.patient.heightCm);
  const b = bmiInfo(latest, S.plan.patient.heightCm);
  const diff = Math.round((latest - start) * 10) / 10;
  const catColor = { under: 'var(--info)', normal: 'var(--ok)', over: 'var(--warn)', obese: 'var(--danger)' }[b.cat];
  // Position on a 15–35 BMI scale for the marker.
  const mark = Math.min(100, Math.max(0, ((b.bmi - 15) / 20) * 100));
  return `<div class="page">${pageHead(t('weight_title'))}
    <section class="card bmi-card">
      <div class="bmi-top">
        <div><div class="muted small">${t('bmi')}</div><div class="bmi-num" style="color:${catColor}">${b.bmi}</div>
          <span class="badge" style="background:color-mix(in srgb, ${catColor} 15%, transparent);color:${catColor}">${t(`bmi_${b.cat}`)}</span></div>
        <div class="right-col"><div class="muted small">${t('height')}</div><b>${ft}′${inch}″</b><div class="muted small">${latest} kg</div></div>
      </div>
      <div class="bmi-scale"><span style="left:${mark}%"></span></div>
      <div class="bmi-legend small muted"><span>18.5</span><span>23</span><span>27.5</span></div>
      <p class="small">${t('healthy_weight', ...b.healthy)}<br>${t('first_goal', Math.round(start * 0.95 * 10) / 10)}<br>${t('since_start', diff)}</p>
    </section>
    <section class="card">
      <label class="field">${t('weight_enter')}<input id="kg" class="big-input" type="number" inputmode="decimal" step="0.1" min="25" max="200" value="${ws[0]?.kg ?? ''}"></label>
      <div class="grid2">
        <label class="field">${t('height')} (${t('feet')})<input id="hft" type="number" inputmode="numeric" min="3" max="7" value="${ft}"></label>
        <label class="field">${t('height')} (${t('inches')})<input id="hin" type="number" inputmode="numeric" min="0" max="11" value="${inch}"></label>
      </div>
      <button class="btn btn-primary btn-lg" data-act="weight_save">${icon('check')} ${t('save')}</button>
    </section>
    ${ws.length ? `<section class="card" style="padding:6px"><ul class="readings">${ws.slice(0, 10).map((w) => `<li><span>${dayKey(w.ts)}</span><b>${w.kg} kg</b></li>`).join('')}</ul></section>` : ''}
  </div>`;
}

// --- supplies -----------------------------------------------------------------------------------

function viewStock() {
  const meds = S.plan.meds ?? [];
  const status = Object.fromEntries(stockStatus(S.state.stock ?? {}, S.log.filter((e) => !e.deleted), meds).map((i) => [i.id, i]));
  const warnBadge = (s) => (s?.warn ? `<span class="badge late">${t(s.warn === 'replace' ? 'warn_replace' : 'warn_buy')}</span>` : '');
  const head = (ic, cls, title, sub, s) =>
    `<div class="stock-head"><span class="med-ic ${cls}">${icon(ic)}</span><div><b>${title}</b>${sub ? `<span>${sub}</span>` : ''}${warnBadge(s)}</div></div>`;
  const countRow = (id, ph) => `<div class="count-row">
      <input id="count-${id}" type="number" inputmode="decimal" min="0" step="0.5" placeholder="${ph}">
      <button class="btn btn-soft" data-act="stock_count" data-id="${id}">${t('save')}</button>
    </div>`;

  const insulinCard = (m) => {
    const s = status[m.id];
    const cur = S.state.stock?.[m.id];
    const body = s
      ? `<div class="stock-num">${t('units_left', loc(s.left))}</div>
         <div class="stock-sub">${t('days_left', loc(s.daysLeft))} · ${t('opened_ago', loc(s.openDays))} · ${t('spare', loc(s.spare))}</div>`
      : `<div class="stock-sub">${t('stock_open_hint')}</div>`;
    return `<section class="card stock-card">
      ${head(MED_ICON[m.type], m.type, esc(m.name), t(`pack_${m.type}`), s)}
      ${body}
      <div class="row stock-btns">
        <button class="btn btn-soft" data-act="stock_open" data-id="${esc(m.id)}">${t('opened_new')}</button>
        <button class="btn" data-act="stock_spare" data-id="${esc(m.id)}">${t('add_spare')}${cur?.spare ? ` (${loc(cur.spare)})` : ''}</button>
      </div>
    </section>`;
  };
  const medCountCard = (m) => {
    const s = status[m.id];
    const perDay = (m.times ?? []).reduce((a, x) => a + x.amount, 0);
    const unit = medUnit(m.type, 2);
    return `<section class="card stock-card">
      ${head(MED_ICON[m.type], m.type, `${esc(m.name)}${m.strength ? ` <small>${esc(m.strength)}</small>` : ''}`, t('per_day', loc(amountText(perDay)), unit), s)}
      ${s ? `<div class="stock-num">${loc(amountText(s.left))} ${unit}</div><div class="stock-sub">${s.daysLeft != null ? t('lasts_days', loc(s.daysLeft)) : ''}</div>` : `<div class="stock-sub">${t('stock_count_hint')}</div>`}
      ${countRow(m.id, t('how_many_now'))}
    </section>`;
  };
  const equipCard = (id, ic) => {
    const s = status[id];
    return `<section class="card stock-card">
      ${head(ic, 'equip', t(`s_${id}`), '', s)}
      ${s ? `<div class="stock-num">${t('pcs_left', loc(s.left))}</div>` : `<div class="stock-sub">${t('stock_count_hint')}</div>`}
      ${countRow(id, t('how_many_now'))}
    </section>`;
  };

  const insulins = meds.filter(isInsulin);
  const others = meds.filter((m) => !isInsulin(m));
  const equip = [['strips', 'drop'], ['lancets', 'drop'], ...(insulins.some((m) => m.type === 'pen') ? [['needles', 'syringe']] : []), ...(insulins.some((m) => m.type === 'vial') ? [['syringes', 'syringe']] : [])];
  return `<div class="page">${pageHead(t('stock_title'))}
    <p class="muted">${t('stock_sub')}</p>
    ${meds.length ? '' : `<button class="card med-start" data-act="go" data-to="meds"><span class="med-ic pen">${icon('pill')}</span><span><b>${t('stock_no_meds')}</b><span>${t('stock_no_meds_sub')}</span></span>${icon('chev')}</button>`}
    ${insulins.length ? `<div class="section-title">${t('stock_ins')}</div>${insulins.map(insulinCard).join('')}` : ''}
    ${others.length ? `<div class="section-title">${t('stock_other')}</div>${others.map(medCountCard).join('')}` : ''}
    <div class="section-title">${t('stock_equip')}</div>
    ${equip.map(([id, ic]) => equipCard(id, ic)).join('')}
  </div>`;
}

// --- history & report ---------------------------------------------------------------------------

function daysTable(days = 14) {
  const log = activeLog();
  const rows = [];
  for (let i = 0; i < days; i++) {
    const key = dayKey(Date.now() - i * DAY);
    const dl = log.filter((e) => dayKey(e.ts) === key);
    if (!dl.length) continue;
    const rd = (ctx) => dl.filter((e) => e.type === 'reading' && e.context === ctx).at(-1)?.value;
    const others = dl.filter((e) => e.type === 'reading' && !['fasting', 'pre_lunch', 'pre_dinner', 'bedtime'].includes(e.context));
    const doses = dl.filter((e) => e.type === 'dose' && e.action !== 'skip');
    rows.push({
      key,
      fasting: rd('fasting'),
      pre_lunch: rd('pre_lunch'),
      pre_dinner: rd('pre_dinner'),
      bedtime: rd('bedtime'),
      others: others.map((r) => r.value),
      insulin: Object.fromEntries(S.plan.doses.map((d) => [d.id, doses.filter((x) => x.slot === d.id).at(-1)?.units])),
      total: doses.reduce((s, d) => s + d.units, 0),
      kcal: dl.filter((e) => e.type === 'meal').reduce((s, m) => s + m.kcal, 0),
    });
  }
  return rows;
}

function cell(v, ctx) {
  return v == null ? '<td class="muted">·</td>' : `<td class="${statusClass(v, ctx)}">${v}</td>`;
}

function chartSvg(days = 14) {
  const from = Date.now() - days * DAY;
  const pts = activeLog().filter((e) => e.type === 'reading' && e.ts >= from);
  const W = 700;
  const H = 220;
  const maxY = 25;
  const x = (ts) => ((ts - from) / (days * DAY)) * W;
  const y = (v) => H - (Math.min(v, maxY) / maxY) * H;
  const tg = S.plan.targets;
  return `<svg class="chart" viewBox="0 0 ${W} ${H}" role="img" aria-label="Glucose readings, last ${days} days">
    <rect x="0" y="${y(tg.postMeal[1])}" width="${W}" height="${y(tg.fasting[0]) - y(tg.postMeal[1])}" class="band" rx="6"/>
    <line x1="0" x2="${W}" y1="${y(LIMITS.HYPO)}" y2="${y(LIMITS.HYPO)}" class="lowline"/>
    <line x1="0" x2="${W}" y1="${y(LIMITS.HIGH)}" y2="${y(LIMITS.HIGH)}" class="highline"/>
    ${[5, 10, 15, 20].map((v) => `<text x="4" y="${y(v) - 3}" class="axis">${v}</text>`).join('')}
    ${pts
      .map(
        (p) =>
          `<circle cx="${x(p.ts).toFixed(1)}" cy="${y(p.value).toFixed(1)}" r="6" class="pt ${statusClass(p.value, p.context)}"><title>${dayKey(p.ts)} ${hhmm(p.ts)} · ${p.value}</title></circle>`,
      )
      .join('')}
  </svg>`;
}

// Last 7 days: one rounded bar per day = that day's average sugar (scale 0–20), coloured by status.
function weekBars() {
  const lang = getLang() === 'bn' ? 'bn-BD' : 'en-GB';
  const all = [];
  const cols = [];
  for (let i = 6; i >= 0; i--) {
    const ts = Date.now() - i * DAY;
    const vals = activeLog().filter((e) => e.type === 'reading' && dayKey(e.ts) === dayKey(ts)).map((e) => e.value);
    all.push(...vals);
    const avg = vals.length ? Math.round((vals.reduce((a, b) => a + b, 0) / vals.length) * 10) / 10 : null;
    const h = avg ? Math.min(100, (avg / 20) * 100) : 0;
    const tone = avg ? classify(avg, [S.plan.diet.glucoseTarget[0] - 2, S.plan.diet.postMealMax]) : '';
    cols.push(`<div class="col ${i === 0 ? 'today' : ''}">
      <div class="track"><div class="fill ${tone}" style="height:${h}%"></div></div>
      <span class="v">${avg ?? '·'}</span>
      <span class="d">${new Date(ts).toLocaleDateString(lang, { weekday: 'short' })}</span>
    </div>`);
  }
  const weekAvg = all.length ? (all.reduce((a, b) => a + b, 0) / all.length).toFixed(1) : '·';
  return `<section class="card">
    <div class="week-head"><div><b>${t('week_title')}</b><div class="muted small">${t('goal_line')}</div></div><b class="nowrap">${weekAvg}</b></div>
    <div class="week-bars">${cols.join('')}</div>
  </section>`;
}

function viewHistory() {
  const rows = daysTable();
  const ins = S.plan.doses;
  return tabPage(
    'history',
    `<div class="home-head"><div><div class="home-day">${t('tab_history')}</div><div class="home-sub">${histWho ? t('hist_of', esc(personName(histWho))) : t('history_title')}</div></div>
      <button class="round-btn" data-act="go" data-to="report" aria-label="${t('btn_report')}">${icon('file')}</button></div>
    ${whoTabs()}
    ${histWho ? personBody(histWho) : `${weekBars()}
    <section class="card">${chartSvg()}</section>
    ${
      rows.length
        ? `<section class="card scroll"><table class="table">
      <thead><tr><th>${t('h_day')}</th><th>${t('h_fasting')}</th><th>${t('h_pre_lunch')}</th><th>${t('h_pre_dinner')}</th><th>${t('h_bedtime')}</th>
      ${ins.map((d) => `<th>${slotName(d.id)}</th>`).join('')}<th>${t('h_kcal')}</th></tr></thead>
      <tbody>${rows
        .map(
          (r) => `<tr><td class="nowrap">${r.key.slice(8)}/${r.key.slice(5, 7)}</td>${cell(r.fasting, 'fasting')}${cell(r.pre_lunch, 'pre_lunch')}${cell(r.pre_dinner, 'pre_dinner')}${cell(r.bedtime, 'bedtime')}
        ${ins.map((d) => `<td>${r.insulin[d.id] ?? '·'}</td>`).join('')}<td>${r.kcal || '·'}</td></tr>`,
        )
        .join('')}</tbody></table></section>`
        : `<p class="muted center">${t('h_empty')}</p>`
    }
    <button class="btn btn-soft" data-act="go" data-to="report">${icon('file')} ${t('btn_report')}</button>
    ${isCaregiver() ? deleteSection() : ''}`}`,
  );
}

// --- Family members who use the same meter ----------------------------------------------
// plan.people = [{ id, name, relation, email, verified }] (synced to every family phone).
// A reading with `person` belongs to them, not to the patient.
const people = () => S.plan.people ?? [];
const personName = (id) => (id ? people().find((p) => p.id === id)?.name ?? t('wh_other_tag') : S.plan.patient.name);
const RELATIONS = ['father', 'mother', 'husband', 'wife', 'brother', 'sister', 'son', 'daughter', 'other'];
let personDraft = null; // { name, relation, email, step: 'form' | 'code', err, busy }

function personStats(id) {
  return statsOf(S.log.filter((e) => e.type === 'reading' && !e.deleted && e.person === id).sort((a, b) => b.ts - a.ts));
}
function statsOf(rs) {
  const week = rs.filter((r) => Date.now() - r.ts < 7 * DAY).map((r) => r.value);
  return { rs, last: rs[0], avg7: week.length ? Math.round((week.reduce((a, b) => a + b, 0) / week.length) * 10) / 10 : null };
}

// Every verified family member gets a link, so they can see their readings with their own email.
let linksDone = '';
function syncMemberLinks() {
  const fam = S.settings.familyId;
  if (!fam || !S.user || !cloud.cloudReady()) return;
  const list = people().filter((p) => p.verified && p.email);
  const key = fam + JSON.stringify(list.map((p) => [p.id, p.email, p.name]));
  if (key === linksDone) return;
  linksDone = key;
  for (const p of list) cloud.setMemberLink(p.email, { family: fam, person: p.id, name: p.name, relation: p.relation, patient: S.plan.patient.name }).catch(() => (linksDone = ''));
}

// This login's own readings in someone else's family (they share that patient's meter).
async function checkMemberLink(u) {
  if (!u?.email || !cloud.cloudReady()) return;
  try {
    const link = await cloud.getMemberLink(u.email);
    if (JSON.stringify(link ?? null) === JSON.stringify(S.settings.memberLink ?? null)) return;
    if (link) S.settings.memberLink = link;
    else delete S.settings.memberLink;
    save(S);
    render(true);
  } catch {
    // offline: keep what we knew
  }
}

let mine = { key: '', list: null, stop: null, err: '' };
function viewMine() {
  const L = S.settings.memberLink;
  if (!L) return `<div class="page">${pageHead(t('mine_title'))}<section class="card center"><p class="muted">${t('mine_none')}</p></section></div>`;
  const key = `${L.family}/${L.person}`;
  if (mine.key !== key) {
    mine.stop?.();
    mine = { key, list: null, stop: null, err: '' };
    cloud
      .watchMemberReadings(L.family, L.person, (list) => ((mine.list = list), render(true)), () => ((mine.err = 'x'), render(true)))
      .then((stop) => (mine.stop = stop))
      .catch(() => ((mine.err = 'x'), render(true)));
  }
  const standalone = !S.settings.familyId;
  const rs = (mine.list ?? []).filter((r) => r.type === 'reading' && !r.deleted).sort((a, b) => b.ts - a.ts);
  const body = mine.list == null && !mine.err
    ? `<section class="card center"><p class="muted">${t('loading')}</p></section>`
    : mine.err
      ? `<div class="alert yellow">${icon('wifi_off')}<div>${t('mine_err')}</div></div>`
      : personBody(L.person, { rs, p: { name: L.name, relation: L.relation, email: S.user?.email } });
  return `<div class="page">
    ${standalone ? `<header class="home-head"><div><div class="home-day">${t('mine_title')}</div><div class="home-sub">${t('mine_sub', esc(L.patient ?? ''))}</div></div>
      <button class="round-btn" data-act="go" data-to="account" aria-label="${t('account')}">${icon('user')}</button></header>` : pageHead(t('mine_title'))}
    ${standalone ? '' : `<p class="muted">${t('mine_sub', esc(L.patient ?? ''))}</p>`}
    ${body}
    <p class="small muted">${t('mine_note')}</p>
  </div>`;
}

const mineBanner = () =>
  S.settings.memberLink
    ? `<button class="card mine-banner" data-act="go" data-to="mine"><span class="avatar">${esc((S.settings.memberLink.name ?? '?').slice(0, 1))}</span><span><b>${t('mine_banner')}</b><span>${t('mine_sub', esc(S.settings.memberLink.patient ?? ''))}</span></span>${icon('chev')}</button>`
    : '';

function readPersonForm() {
  const D = personDraft;
  if (!D) return;
  const n = document.getElementById('pp-name');
  const e = document.getElementById('pp-email');
  if (n) D.name = n.value.trim();
  if (e) D.email = e.value.trim();
}

function addPerson(p) {
  S.plan.people = [...people(), { id: uid(), ...p }];
  savePlan();
  syncMemberLinks();
  personDraft = null;
  toast = t('pp_added', p.name);
  render();
}

function viewPeople() {
  const D = personDraft;
  const lang = getLang() === 'bn' ? 'bn-BD' : 'en-GB';
  const cards = people()
    .map((p) => {
      const st = personStats(p.id);
      return `<button class="person-card" data-act="go" data-to="person/${esc(p.id)}">
        <span class="avatar">${esc(p.name.slice(0, 1))}</span>
        <span class="pc-body"><b>${esc(p.name)} <small>${t(`rel_${p.relation}`)}</small></b>
          <span>${p.email ? `${p.verified ? `${icon('check')} ` : ''}${esc(p.email)}` : t('pp_no_email')}</span>
          <span>${st.last ? t('pp_last', st.last.value, new Date(st.last.ts).toLocaleString(lang, { day: 'numeric', month: 'short', hour: 'numeric', minute: '2-digit', hour12: true })) : t('pp_no_readings')}</span></span>
        ${icon('chev')}</button>`;
    })
    .join('');
  let form;
  if (!D) {
    form = `<button class="btn btn-primary btn-lg" data-act="pp_new">${icon('plus')} ${t('pp_add')}</button>`;
  } else if (D.step === 'code') {
    form = `<section class="card">
      <div class="set-head"><span class="bubble">${icon('lock')}</span><div><b>${t('pp_verify')}</b><span>${t('pp_code_sent', esc(D.email))}</span></div></div>
      <input id="pp-code" class="code-input" inputmode="numeric" autocomplete="one-time-code" maxlength="6" placeholder="••••••">
      ${D.err ? `<div class="alert red">${icon('alert')}<div>${t(authErr(D.err))}</div></div>` : ''}
      <button class="btn btn-primary btn-lg" data-act="pp_verify" ${D.busy ? 'disabled' : ''}>${icon('check')} ${t('pp_verify_btn')}</button>
      <button class="link" data-act="pp_cancel">${t('cancel')}</button>
    </section>`;
  } else {
    form = `<section class="card">
      <div class="set-head"><span class="bubble">${icon('users')}</span><div><b>${t('pp_add')}</b><span>${t('pp_add_sub')}</span></div></div>
      <label class="field">${t('pp_name')}<input id="pp-name" value="${esc(D.name)}" placeholder="${t('pp_name_ph')}" autocomplete="off"></label>
      <div class="field">${t('pp_relation')}<div class="meal-chips">${RELATIONS.map((r) => `<button class="${D.relation === r ? 'on' : ''}" data-act="pp_rel" data-v="${r}">${t(`rel_${r}`)}</button>`).join('')}</div></div>
      <label class="field">${t('email')}<input id="pp-email" type="email" inputmode="email" value="${esc(D.email)}" placeholder="name@gmail.com"></label>
      ${D.err ? `<div class="alert red">${icon('alert')}<div>${t(D.err === 'need_name' ? 'pp_need_name' : authErr(D.err))}</div></div>` : ''}
      <button class="btn btn-primary btn-lg" data-act="pp_send" ${D.busy ? 'disabled' : ''}>${icon('mail')} ${D.busy ? t('sending') : t('pp_send')}</button>
      <button class="btn" data-act="pp_no_email">${t('pp_without_email')}</button>
      <button class="link" data-act="pp_cancel">${t('cancel')}</button>
    </section>`;
  }
  return `<div class="page">${pageHead(t('pp_title'))}
    ${form}
    <div class="section-title">${t('pp_list')}</div>
    <div class="person-list">
      <div class="person-card me"><span class="avatar">${esc(S.plan.patient.name.slice(0, 1))}</span><span class="pc-body"><b>${esc(S.plan.patient.name)} <small>${t('pp_patient')}</small></b><span>${t('pp_patient_sub')}</span></span></div>
      ${cards}
    </div>
    <p class="small muted">${t('pp_note')}</p>
  </div>`;
}

// One family member's own readings (kept apart from the patient's).
function personBody(id, from = null) {
  const p = from?.p ?? people().find((x) => x.id === id);
  const lang = getLang() === 'bn' ? 'bn-BD' : 'en-GB';
  const st = from ? statsOf(from.rs) : personStats(id);
  const vals = st.rs.map((r) => r.value);
  const byDay = new Map();
  for (const r of st.rs.slice(0, 200)) {
    const k = dayKey(r.ts);
    if (!byDay.has(k)) byDay.set(k, []);
    byDay.get(k).push(r);
  }
  const days = [...byDay.values()]
    .map(
      (rs) => `<div class="wh-day">${new Date(rs[0].ts).toLocaleDateString(lang, { weekday: 'short', day: 'numeric', month: 'short' })}</div>
      <ul class="ms-list person-readings">${rs
        .map((r) => `<li><span class="ms-val ${statusClass(r.value, r.context)}">${r.value}</span><div><b>${new Date(r.ts).toLocaleTimeString(lang, { hour: 'numeric', minute: '2-digit', hour12: true })} · ${t(`ctx_${r.context}`)}</b><span>${r.source === 'meter' ? `${icon('bluetooth')} ${t('feed_meter')}` : t('wh_typed')}</span></div></li>`)
        .join('')}</ul>`,
    )
    .join('');
  return `<section class="card person-hero"><span class="avatar">${esc((p?.name ?? '?').slice(0, 1))}</span>
      <div><b>${esc(p?.name ?? '')}</b><span>${p ? t(`rel_${p.relation}`) : ''}${p?.email ? ` · ${esc(p.email)}` : ''}</span></div></section>
    <section class="card person-stats">
      <div><b>${vals.length ? loc(vals.length) : '–'}</b><span>${t('pp_readings')}</span></div>
      <div><b>${st.avg7 ?? '–'}</b><span>${t('pp_avg7')}</span></div>
      <div><b>${vals.length ? `${Math.min(...vals)}–${Math.max(...vals)}` : '–'}</b><span>${t('pp_range')}</span></div>
    </section>
    ${days ? `<section class="card wh-list">${days}</section>` : from ? `<section class="card center"><p class="muted">${t('pp_no_readings')}</p></section>` : `<section class="card center"><p class="muted">${t('pp_no_readings_how')}</p><button class="btn btn-soft" data-act="go" data-to="whose">${icon('users')} ${t('wh_title')}</button></section>`}`;
}

function viewPerson(id) {
  const p = people().find((x) => x.id === id);
  if (!p) return viewPeople();
  return `<div class="page">${pageHead(p.name)}
    ${personBody(id)}
    <button class="btn btn-outline-danger" style="margin-top:16px" data-act="pp_remove" data-id="${esc(id)}">${icon('trash')} ${t('pp_remove')}</button>
  </div>`;
}

// History tab: whose readings to show (the patient, or one family member).
let histWho = '';
function whoTabs() {
  if (!people().length) return '';
  if (histWho && !people().some((p) => p.id === histWho)) histWho = '';
  const tab = (id, name, n) => `<button class="${histWho === id ? 'on' : ''}" data-act="hist_who" data-id="${esc(id)}"><span class="avatar">${esc(name.slice(0, 1))}</span><span>${esc(name)}</span>${n != null ? `<small>${loc(n)}</small>` : ''}</button>`;
  return `<div class="who-tabs">${tab('', S.plan.patient.name)}${people().map((p) => tab(p.id, p.name, personStats(p.id).rs.length)).join('')}</div>`;
}

// "Whose?" buttons for one reading (after a meter sync).
function whoseChips(rec) {
  if (!people().length) return '';
  const opts = [{ id: '', name: S.plan.patient.name }, ...people()];
  return `<div class="whose-chips"><span>${t('wh_whose')}</span>${opts.map((o) => `<button class="${(rec.person ?? '') === o.id && !rec.other ? 'on' : ''}" data-act="wh_one" data-id="${esc(rec.id)}" data-person="${esc(o.id)}">${esc(o.name)}</button>`).join('')}</div>`;
}

// Give readings to a person ('' = the patient).
function assignReadings(ids, person, before = null) {
  const now = Date.now();
  const was = {};
  const sent = [];
  for (const e of S.log) {
    if (!ids.has(e.id)) continue;
    const to = before ? before[e.id] : { person, other: false };
    if (!to || ((e.person ?? '') === (to.person ?? '') && !!e.other === !!to.other)) continue;
    was[e.id] = { person: e.person ?? '', other: !!e.other };
    if (to.person) e.person = to.person;
    else delete e.person;
    if (to.other) e.other = true;
    else delete e.other;
    e.updatedAt = now;
    sent.push(sync.pushRecord(e));
  }
  save(S);
  dispatchAlerts();
  return { n: Object.keys(was).length, was, sent };
}

// After giving readings to someone: a clear confirmation, whether every phone has it, and undo.
let assigned = null; // { n, person, was, state: 'sending' | 'done' | 'later' | 'local' }
function confirmAssigned(res, person) {
  const A = (assigned = { n: res.n, person, was: res.was, state: 'sending' });
  if (!res.n) return (assigned = null);
  if (!res.sent.some(Boolean)) A.state = 'local';
  else {
    Promise.all(res.sent.filter(Boolean)).then((ok) => assigned === A && ((A.state = ok.every(Boolean) ? 'done' : 'later'), softRender()));
    setTimeout(() => assigned === A && A.state === 'sending' && ((A.state = 'later'), softRender()), 5000);
  }
}

function assignedSheet() {
  const A = assigned;
  if (!A) return '';
  const who = personName(A.person);
  const state = {
    sending: [`${icon('refresh')} ${t('as_sending')}`, 'wait'],
    done: [`${icon('check')} ${t('as_done')}`, 'ok'],
    later: [`${icon('wifi_off')} ${t('as_later')}`, 'warn'],
    local: [`${icon('mobile')} ${t('as_local')}`, 'muted'],
  }[A.state];
  return `<div class="wh-sheet show as-sheet" role="dialog">
    <div class="as-top"><span class="as-check">${icon('check')}</span>
      <div><b>${t('as_title', loc(A.n), esc(who))}</b><span>${t(A.person ? 'as_sub_person' : 'as_sub_patient', esc(who), esc(S.plan.patient.name))}</span></div></div>
    <div class="as-state ${state[1]}">${state[0]}</div>
    ${A.person ? `<button class="btn btn-primary btn-lg" data-act="as_view">${icon('user')} ${t('as_view', esc(who))}</button>` : ''}
    <div class="row"><button class="btn" data-act="as_undo">${icon('back')} ${t('as_undo')}</button><button class="btn btn-soft" data-act="as_ok">${t('as_ok')}</button></div>
  </div>`;
}

// --- Whose reading? Mark readings taken by someone else (e.g. father) on the same meter -----
// Marked readings stay in the log (and count for strips) but are left out of charts,
// averages, alerts and the doctor's report. Works on the patient's and the family's phones.
let whose = { picked: new Set(), meterOnly: true };

function viewWhose() {
  const W = whose;
  const lang = getLang() === 'bn' ? 'bn-BD' : 'en-GB';
  const since = Date.now() - 60 * DAY;
  const list = S.log
    .filter((e) => e.type === 'reading' && !e.deleted && e.ts >= since && (!W.meterOnly || e.source === 'meter'))
    .sort((a, b) => b.ts - a.ts);
  const byDay = new Map();
  for (const e of list) {
    const k = dayKey(e.ts);
    if (!byDay.has(k)) byDay.set(k, []);
    byDay.get(k).push(e);
  }
  const days = [...byDay.values()]
    .map(
      (rows) => `<div class="wh-day">${new Date(rows[0].ts).toLocaleDateString(lang, { weekday: 'short', day: 'numeric', month: 'short' })}</div>
      ${rows
        .map(
          (e) => `<label class="wh-item ${e.other || e.person ? 'other' : ''}"><input type="checkbox" data-act="wh_pick" data-id="${esc(e.id)}" ${W.picked.has(e.id) ? 'checked' : ''}>
          <span class="ms-val ${e.other || e.person ? '' : statusClass(e.value, e.context)}">${e.value}</span>
          <span class="wh-text"><b>${new Date(e.ts).toLocaleTimeString(lang, { hour: 'numeric', minute: '2-digit', hour12: true })} · ${t(`ctx_${e.context}`)}</b>
            <span>${e.other || e.person ? `${icon('users')} ${esc(e.person ? personName(e.person) : t('wh_other_tag'))}` : `${e.source === 'meter' ? `${icon('bluetooth')} ${t('feed_meter')}` : t('wh_typed')} · ${esc(S.plan.patient.name)}`}</span></span></label>`,
        )
        .join('')}`,
    )
    .join('');
  const n = W.picked.size;
  return `<div class="page whose">${pageHead(t('wh_head'))}
    <p class="muted">${t('wh_sub', esc(S.plan.patient.name))}</p>
    <div class="seg">${[true, false].map((m) => `<button class="${W.meterOnly === m ? 'on' : ''}" data-act="wh_filter" data-v="${m ? 1 : 0}">${t(m ? 'wh_meter_only' : 'wh_all')}</button>`).join('')}</div>
    <p class="wh-hint">${icon('check')} ${t('wh_hint')}</p>
    ${days ? `<section class="card wh-list">${days}</section>` : `<section class="card center"><p class="muted">${t('wh_empty')}</p></section>`}
    <div class="wh-spacer ${n || assigned ? 'show' : ''}"></div>
  </div>
  ${assigned ? assignedSheet() : whoseSheet(n)}`;
}

// Bottom sheet that appears once readings are ticked: the list of people to give them to.
function whoseSheet(n) {
  const row = (id, name, sub, isMe) => `<button class="wh-person" data-act="wh_assign" data-person="${esc(id)}">
      <span class="avatar ${isMe ? 'me' : ''}">${esc(name.slice(0, 1))}</span>
      <span class="pc-body"><b>${esc(name)}</b><span>${sub}</span></span>${icon('chev')}</button>`;
  const rows = [
    row('', S.plan.patient.name, t('pp_patient'), true),
    ...people().map((p) => row(p.id, p.name, `${t(`rel_${p.relation}`)}${p.verified ? ` · ${t('pp_verified')}` : ''}`)),
  ].join('');
  return `<div class="wh-sheet ${n ? 'show' : ''}" role="dialog" aria-label="${t('wh_sheet_title')}">
    <div class="wh-sheet-head"><div><b>${t('wh_sheet_title')}</b><span id="wh-count">${t('wh_sheet_sub', loc(n))}</span></div>
      <button class="wh-clear" data-act="wh_clear">${t('cancel')}</button></div>
    <div class="wh-people">${rows}
      ${people().length ? '' : `<button class="wh-person" data-act="wh_mark" data-v="other"><span class="avatar">?</span><span class="pc-body"><b>${t('wh_mark_other')}</b><span>${t('wh_unnamed')}</span></span>${icon('chev')}</button>`}
      <button class="wh-person add" data-act="go" data-to="people"><span class="avatar">${icon('plus')}</span><span class="pc-body"><b>${t('pp_add')}</b><span>${t('wh_add_sub')}</span></span></button>
    </div>
  </div>`;
}

// --- Family: delete history ---------------------------------------------------------------
// Deleted records are marked deleted (so the deletion reaches the patient's phone too).
// Nothing is removed until the person types "delete" in the box.
let delState = { picked: new Set(), confirm: '', err: '' };
const DELETE_WORDS = ['delete', 'ডিলিট', 'মুছুন'];

function deleteSection() {
  const D = delState;
  const lang = getLang() === 'bn' ? 'bn-BD' : 'en-GB';
  const entries = activeLog()
    .filter((e) => recordLine(e))
    .sort((a, b) => b.ts - a.ts);
  if (!entries.length) return '';
  const byDay = new Map();
  for (const e of entries) {
    const k = dayKey(e.ts);
    if (!byDay.has(k)) byDay.set(k, []);
    byDay.get(k).push(e);
  }
  const days = [...byDay.entries()]
    .map(([k, list], i) => {
      const date = new Date(list[0].ts).toLocaleDateString(lang, { weekday: 'short', day: 'numeric', month: 'short' });
      const allOn = list.every((e) => D.picked.has(e.id));
      return `<details class="del-day" ${i < 2 ? 'open' : ''}>
        <summary><input type="checkbox" data-act="del_day" data-day="${k}" ${allOn ? 'checked' : ''} aria-label="${esc(date)}"><b>${esc(date)}</b><span>${t('del_count', loc(list.length))}</span>${icon('chev')}</summary>
        ${list
          .map((e) => {
            const [ic, text, tone] = recordLine(e);
            return `<label class="del-item"><input type="checkbox" data-act="del_pick" data-id="${esc(e.id)}" data-day="${k}" ${D.picked.has(e.id) ? 'checked' : ''}>
              <span class="bubble ${tone}">${icon(ic)}</span><span class="del-text"><b>${esc(text)}</b><span>${new Date(e.ts).toLocaleTimeString(lang, { hour: '2-digit', minute: '2-digit', hour12: false })}</span></span></label>`;
          })
          .join('')}
      </details>`;
    })
    .join('');

  const total = entries.length;
  const n = D.confirm === 'all' ? total : D.picked.size;
  const confirmBox = D.confirm
    ? `<div class="del-confirm">
        <div class="alert red">${icon('alert')}<div><b>${D.confirm === 'all' ? t('del_all_warn', loc(total)) : t('del_sel_warn', loc(n))}</b><br><span class="small">${t('del_both_phones')}</span></div></div>
        <label class="field">${t('del_type')}<input id="del-word" autocomplete="off" autocapitalize="none" placeholder="delete"></label>
        ${D.err ? `<p class="del-err">${t('del_wrong')}</p>` : ''}
        <div class="row"><button class="btn" data-act="del_cancel">${t('cancel')}</button><button class="btn btn-danger" data-act="del_go">${icon('trash')} ${t('del_confirm_btn')}</button></div>
      </div>`
    : '';

  return `<details class="card set-card fold del-card" ${D.picked.size || D.confirm ? 'open' : ''}>
    <summary class="set-head"><span class="bubble danger-bubble">${icon('trash')}</span><div><b>${t('del_title')}</b><span>${t('del_sub')}</span></div>${icon('chev')}</summary>
    <div class="del-bar"><span id="del-count">${t('del_selected', loc(D.picked.size))}</span>
      <button class="link" data-act="del_none">${t('del_clear')}</button></div>
    <div class="del-list">${days}</div>
    ${confirmBox || `<div class="row del-actions">
      <button class="btn btn-soft danger-soft" id="del-sel-btn" data-act="del_ask" data-what="selected" ${D.picked.size ? '' : 'disabled'}>${icon('trash')} ${t('del_selected_btn')}</button>
      <button class="btn btn-outline-danger" data-act="del_ask" data-what="all">${t('del_all_btn')}</button>
    </div>`}
  </details>`;
}

// The full report for the doctor (report.js): period chosen on the report page.
let reportDays = 90;
function fullReport() {
  const from = reportDays ? Date.now() - reportDays * DAY : undefined;
  return reportData(S.plan, S.log, { from });
}
const reportName = (ext) => `sugar-report-${dayKey(Date.now())}.${ext}`;
function toBase64(bytes) {
  let s = '';
  for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(s);
}

function viewReport() {
  const days = 14;
  const from = Date.now() - days * DAY;
  const log = activeLog().filter((e) => e.ts >= from);
  const readings = log.filter((e) => e.type === 'reading');
  const avg = (ctx) => {
    const v = readings.filter((r) => r.context === ctx).map((r) => r.value);
    return v.length ? { v: (v.reduce((a, b) => a + b, 0) / v.length).toFixed(1), n: v.length } : null;
  };
  const rows = daysTable(days);
  const insulinDays = rows.filter((r) => r.total > 0);
  const avgInsulin = insulinDays.length ? Math.round(insulinDays.reduce((s, r) => s + r.total, 0) / insulinDays.length) : null;
  const kcalDays = rows.filter((r) => r.kcal > 0);
  const avgKcal = kcalDays.length ? Math.round(kcalDays.reduce((s, r) => s + r.kcal, 0) / kcalDays.length) : null;
  const weights = activeLog()
    .filter((e) => e.type === 'weight')
    .sort((a, b) => a.ts - b.ts);
  const w = weights.at(-1);
  const cm = S.plan.patient.heightCm;
  const { ft, inch } = cmToFtIn(cm);
  const bmi = bmiInfo(w?.kg ?? S.plan.diet.startWeight, cm);
  const allAlerts = evaluateAlerts(S.plan, activeLog(), { ...S.state, acked: [] }).filter((a) => a.level !== 'info');
  const hypos = log.filter((e) => e.type === 'hypo');
  const lows = readings.filter((r) => r.value < LIMITS.HYPO).length;
  const severe = readings.filter((r) => r.value < LIMITS.SEVERE).length;
  const highs = readings.filter((r) => r.value > 13.9).length;
  const veryHigh = readings.filter((r) => r.value > LIMITS.HIGH).length;
  const basalChanges = activeLog()
    .filter((e) => e.type === 'dose' && e.kind === 'basal')
    .sort((a, b) => a.ts - b.ts)
    .filter((d, i, arr) => i === 0 || d.units !== arr[i - 1].units);
  const prevLang = getLang();
  setLang('en');
  const slotEn = (id) => t(`slot_${id}`);
  const fmtDate = (ts) => new Date(ts).toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric' });
  const P = S.plan;

  const stat = (label, value, sub = '', tone = '') =>
    `<div class="stat ${tone}"><div class="stat-v">${value ?? '<span class="muted">none</span>'}</div><div class="stat-l">${label}</div>${sub ? `<div class="stat-s">${sub}</div>` : ''}</div>`;
  const avgStat = (label, ctx) => {
    const a = avg(ctx);
    const tone = a ? { in_range: 'ok', high: 'warn', very_high: 'warn', low: 'danger', severe_low: 'danger', below_target: 'info' }[statusClass(Number(a.v), ctx)] : '';
    return stat(label, a?.v, a ? `${a.n} readings` : 'no readings', tone);
  };
  const delta = (d) =>
    d > 0 ? `<span class="delta up">+${d} units</span>` : d < 0 ? `<span class="delta down">−${-d} units</span>` : '<span class="delta zero">No change</span>';
  const range = (r) => (r.to >= 99 ? `${r.from} and above` : `${r.from} to ${(r.to - 0.1).toFixed(1)}`);

  const planRows = P.doses
    .map(
      (d) => `<div class="plan-row">
        <span class="bubble">${icon(SLOT_ICON[d.id])}</span>
        <div class="plan-main"><b>${slotEn(d.id)}</b>
          <span><span class="time-pill">${d.injectAt}</span><span class="ins"><span class="vial-dot ${d.insulin}"></span>${t(`ins_${d.insulin}`)}</span></span></div>
        <div class="plan-dose"><b>${doseUnits(d)}<small> u</small></b><span>${d.min} to ${d.max}${d.kind === 'basal' && doseUnits(d) !== d.base ? `, Rx ${d.base}` : ''}</span></div>
      </div>`,
    )
    .join('');

  const html = `<div class="page wide report">
    <header class="flow-head noprint">${backBtn()}<div class="flow-title">Doctor report</div></header>

    <section class="card export-card noprint">
      <div class="set-head"><span class="bubble">${icon('file')}</span><div><b>${tIn(prevLang, 'rep_title')}</b><span>${tIn(prevLang, 'rep_sub')}</span></div></div>
      <div class="seg">${[30, 90, 0].map((d) => `<button class="${reportDays === d ? 'on' : ''}" data-act="report_period" data-v="${d}">${tIn(prevLang, d ? 'rep_days' : 'rep_all', d)}</button>`).join('')}</div>
      <div class="export-btns">
        <button class="btn btn-primary btn-lg" data-act="report_pdf">${icon('print')} ${tIn(prevLang, 'rep_pdf')}</button>
        <button class="btn btn-soft btn-lg" data-act="report_xlsx">${icon('file')} ${tIn(prevLang, 'rep_xlsx')}</button>
      </div>
      <p class="small muted">${tIn(prevLang, 'rep_hint')}</p>
    </section>
    <section class="report-hero">
      <div class="rh-top">
        <div><div class="rh-kicker">Diabetes log</div><h1>${esc(P.patient.name)}</h1></div>
      </div>
      <div class="rh-chips">
        <span>Age ${P.patient.age}</span><span>${ft}′${inch}″</span><span>${w?.kg ?? P.diet.startWeight} kg</span>
        <span>BMI ${bmi.bmi} (${t(`bmi_${bmi.cat}`)})</span><span>Rx ${fmtDate(new Date(P.patient.prescriptionDate).getTime())}</span>
      </div>
      <div class="rh-period">${icon('calendar')} ${fmtDate(from)} to ${fmtDate(Date.now())} (${days} days)</div>
    </section>

    <section class="card">
      <div class="card-title">${icon('syringe')} Current insulin plan</div>
      <div class="plan-head"><span>Dose</span><span>Units (allowed range)</span></div>
      <div class="plan-list">${planRows}</div>
      ${generalTimes(P.meds ?? []).map((x) => `<div class="rule-note">${icon('pill')} ${esc(x.name)}: ${amountText(x.amount)} at ${x.at}</div>`).join('')}
    </section>

    <section class="card">
      <div class="card-title">${icon('sliders')} Adjustment rules
        <span class="status-badge ${P.scaleConfirmed ? 'ok' : 'warn'}">${P.scaleConfirmed ? 'Confirmed by doctor' : 'Please review'}</span></div>
      <div class="sub-title">Actrapid correction, by sugar before the meal (mmol/L)</div>
      <div class="scale-list">${P.correctionScale
        .map((r) => `<div class="scale-row"><span class="range-pill">${range(r)}</span><span class="arrow">${icon('chev')}</span>${delta(r.delta)}</div>`)
        .join('')}
        <div class="scale-row"><span class="range-pill low">below 3.9</span><span class="arrow">${icon('chev')}</span><span class="delta stop">Treat low first</span></div>
      </div>
      <div class="rule-grid">
        <div class="rule"><span>Small meal</span><b>${P.mealRules.small > 0 ? '+' : '−'}${Math.abs(P.mealRules.small)} units</b></div>
        <div class="rule"><span>No meal</span><b>Skip Actrapid</b></div>
        <div class="rule"><span>Lantus</span><b>±${P.basalRule.step} every ${P.basalRule.everyDays} days</b></div>
        <div class="rule"><span>Any change limit</span><b>±2 units, else see doctor</b></div>
        <div class="rule"><span>Fasting target</span><b>${P.targets.fasting[0]} to ${P.targets.fasting[1]}</b></div>
        <div class="rule"><span>Before meals</span><b>${P.targets.preMeal[0]} to ${P.targets.preMeal[1]}</b></div>
        <div class="rule"><span>2 h after meals</span><b>under ${P.diet.postMealMax}</b></div>
        <div class="rule"><span>Calories a day</span><b>${P.diet.kcalTarget}, max ${P.diet.kcalMax}</b></div>
      </div>
    </section>

    <section class="card">
      <div class="card-title">${icon('activity')} Summary, last ${days} days</div>
      <div class="stat-grid">
        ${avgStat('Average fasting', 'fasting')}
        ${avgStat('Average before lunch', 'pre_lunch')}
        ${avgStat('Average before dinner', 'pre_dinner')}
        ${avgStat('Average at bedtime', 'bedtime')}
        ${stat('Lows (below 3.9)', String(lows), `${severe} below 3.0`, lows ? 'danger' : 'ok')}
        ${stat('Highs (above 13.9)', String(highs), `${veryHigh} above 16.7`, highs ? 'warn' : 'ok')}
        ${stat('Insulin per day', avgInsulin != null ? `${avgInsulin} u` : null, 'average')}
        ${stat('Calories per day', avgKcal != null ? String(avgKcal) : null, `target ${P.diet.kcalTarget}`)}
        ${stat('Weight', w ? `${w.kg} kg` : null, weights.length > 1 ? `from ${weights[0].kg} kg` : '')}
        ${stat('Hypo events', String(hypos.length), hypos.map((x) => `${fmtDate(x.ts)} ${hhmm(x.ts)}, ${x.outcome}`).join('<br>'), hypos.length ? 'danger' : 'ok')}
      </div>
    </section>

    ${
      allAlerts.length
        ? `<section class="card"><div class="card-title">${icon('alert')} Flags for the doctor</div>
      <ul class="flag-list">${allAlerts.map((a) => `<li><span class="flag-dot ${a.level}"></span><div><b>${t(`lvl_${a.level}`)}</b><span>${esc(alertText(a))}</span></div></li>`).join('')}</ul></section>`
        : ''
    }
    ${
      basalChanges.length > 1
        ? `<section class="card"><div class="card-title">${icon('moon')} Lantus dose history</div><div class="food-chips">${basalChanges
            .map((d) => `<span class="fchip">${fmtDate(d.ts)}: <b>&nbsp;${d.units} u</b></span>`)
            .join('')}</div></section>`
        : ''
    }

    <section class="card">
      <div class="card-title">${icon('chart')} Sugar readings (mmol/L)</div>
      ${chartSvg(days)}
      <div class="scroll"><table class="rtable compact"><thead><tr><th>Day</th><th>Fasting</th><th>Pre-lunch</th><th>Pre-dinner</th><th>Bedtime</th><th>Other</th>
        ${P.doses.map((d) => `<th>${slotEn(d.id)}</th>`).join('')}<th>kcal</th></tr></thead>
        <tbody>${rows
          .map(
            (r) => `<tr><td class="nowrap">${new Date(r.key).toLocaleDateString('en-GB', { day: 'numeric', month: 'short' })}</td>${cell(r.fasting, 'fasting')}${cell(r.pre_lunch, 'pre_lunch')}${cell(r.pre_dinner, 'pre_dinner')}${cell(r.bedtime, 'bedtime')}
          <td>${r.others.join(', ') || '·'}</td>${P.doses.map((d) => `<td>${r.insulin[d.id] ?? '·'}</td>`).join('')}<td>${r.kcal || '·'}</td></tr>`,
          )
          .join('')}</tbody></table></div>
    </section>

    <section class="card">
      <div class="card-title">${icon('stethoscope')} Questions for the doctor</div>
      <ol class="steps">
        <li>Please confirm or change the correction scale, small-meal rule and targets above.</li>
        <li>How much should each Actrapid dose drop when one portion of rice is cut?</li>
        <li>Which low-sugar and sick-day rules should we follow at home?</li>
      </ol>
    </section>
  </div>`;
  setLang(prevLang);
  return html;
}

// --- settings ------------------------------------------------------------------------------------

function num(path, val, step = 1) {
  return `<input type="number" inputmode="decimal" step="${step}" data-path="${path}" value="${val}">`;
}

// A settings group: icon + title + short description, then the fields.
function setCard(ic, title, sub, body) {
  return `<section class="card set-card">
    <div class="set-head"><span class="bubble">${icon(ic)}</span><div><b>${title}</b>${sub ? `<span>${sub}</span>` : ''}</div></div>
    ${body}
  </section>`;
}

function mini(label, input) {
  return `<label class="mfield"><span>${label}</span>${input}</label>`;
}

function viewSettings() {
  if (S.settings.pin && !unlocked) {
    return `<div class="page">${pageHead(t('btn_settings'))}
      <section class="card center">
        <span class="bubble" style="margin:0 auto 10px">${icon('lock')}</span>
        <label class="field">${t('pin_enter')}<input id="pin" class="big-input" type="password" inputmode="numeric" maxlength="6"></label>
        <div id="settings-msg">${settingsMsg ? `<div class="alert yellow">${icon('alert')}<div>${esc(settingsMsg)}</div></div>` : ''}</div>
        <button class="btn btn-primary btn-lg" data-act="pin_unlock">${t('ok')}</button>
      </section></div>`;
  }
  const P = S.plan;
  const msg = settingsMsg;
  settingsMsg = '';


  const scaleRows = P.correctionScale
    .map(
      (r, i) => `<div class="scale-edit">
        ${mini('From', num(`correctionScale.${i}.from`, r.from, 0.1))}
        ${mini('Below', num(`correctionScale.${i}.to`, r.to, 0.1))}
        ${mini('Change', num(`correctionScale.${i}.delta`, r.delta))}
      </div>`,
    )
    .join('');

  return `<div class="page settings">${pageHead(isCaregiver() ? t('cg_plan') : t('btn_settings'))}
    <div id="settings-msg">${msg ? `<div class="alert info">${icon('info')}<div>${esc(msg)}</div></div>` : ''}</div>

    ${isCaregiver() ? `<div class="alert info">${icon('info')}<div>${t('cg_plan_note', esc(P.patient.name))}</div></div>` : ''}
    ${setCard('phone', 'This phone', 'Settings lock', `
      <label class="field"><span>New PIN <span class="hint">leave empty to keep</span></span><input id="newpin" type="password" inputmode="numeric" maxlength="6"></label>`)}

    ${setCard('alert', t('em_title'), t('em_sub'), `
      ${[0, 1, 2]
        .map((i) => {
          const c = P.emergency?.[i] ?? {};
          return `<div class="em-row">
            <span class="em-num">${loc(i + 1)}</span>
            <input data-em-name="${i}" placeholder="${t('em_name')}" value="${esc(c.name ?? '')}">
            <input data-em-phone="${i}" type="tel" inputmode="tel" placeholder="01XXXXXXXXX" value="${esc(c.phone ? prettyPhone(c.phone) : '')}">
          </div>`;
        })
        .join('')}
      <p class="small muted">${t('em_note')}</p>`)}

    ${setCard('users', 'People', 'Shown in alarms and on call buttons', `
      <label class="field">Patient name<input data-path="patient.name" value="${esc(P.patient.name)}"></label>
      <div class="mgrid two">
        ${mini('Doctor name', `<input data-path="doctor.name" value="${esc(P.doctor.name)}">`)}
        ${mini('Doctor phone', `<input data-path="doctor.phone" type="tel" value="${esc(prettyPhone(P.doctor.phone))}">`)}
      </div>
      <div class="mgrid two">
        ${mini('Patient phone', `<input data-path="patient.phone" type="tel" value="${esc(prettyPhone(P.patient.phone ?? ''))}">`)}
        ${mini('Caregiver phone', `<input data-path="caregiver.phone" type="tel" value="${esc(prettyPhone(P.caregiver.phone))}">`)}
      </div>`)}

    ${setCard('syringe', t('meds_title'), t('meds_settings_sub'), `
      ${medsPreview()}
      <button class="btn btn-soft" data-act="go" data-to="meds">${icon('pill')} ${t('meds_edit')}</button>
      <div class="mgrid two">${mini('Afternoon snack', `<input type="time" data-path="snackAt" value="${P.snackAt}">`)}<span></span></div>
      ${basalDose() ? `<div class="set-line"><span>${esc(basalDose().name)} ${t('basal_now')}</span><b>${loc(nightUnits())} ${t('units')}</b>` : '<div>'}
        ${S.state.basal && basalDose() ? `<button class="btn btn-soft small-btn" data-act="basal_reset">Reset to ${basalDose().base}</button>` : ''}</div>`)}

    ${setCard('sliders', 'Adjustment rules', "Sugar before a meal changes that meal's Actrapid", `
      ${scaleRows}
      <div class="mgrid two">
        ${mini('Small meal (units)', num('mealRules.small', P.mealRules.small))}
        ${mini('Basal insulin step (units)', num('basalRule.step', P.basalRule.step))}
        ${mini('Basal change every (days)', num('basalRule.everyDays', P.basalRule.everyDays))}
        ${mini('2 h after meal max', num('targets.postMeal.1', P.targets.postMeal[1], 0.1))}
      </div>
      <div class="sub-title">Targets (mmol/L)</div>
      <div class="mgrid two">
        ${mini('Fasting low', num('targets.fasting.0', P.targets.fasting[0], 0.1))}
        ${mini('Fasting high', num('targets.fasting.1', P.targets.fasting[1], 0.1))}
        ${mini('Before meal low', num('targets.preMeal.0', P.targets.preMeal[0], 0.1))}
        ${mini('Before meal high', num('targets.preMeal.1', P.targets.preMeal[1], 0.1))}
        ${mini('Bedtime low', num('targets.bedtime.0', P.targets.bedtime[0], 0.1))}
        <span></span>
      </div>
      <label class="menu-row switch-row"><span class="bubble">${icon('shield')}</span><div><b>Confirmed by doctor</b><span>Tick after the doctor checks these rules</span></div>
        <span class="switch"><input type="checkbox" data-path="scaleConfirmed" ${P.scaleConfirmed ? 'checked' : ''}><span></span></span></label>`)}

    ${setCard('food', 'Food and weight', 'Lower targets only together with the doctor', `
      <div class="mgrid two">
        ${mini('Calories a day', num('diet.kcalTarget', P.diet.kcalTarget, 50))}
        ${mini('Calories max', num('diet.kcalMax', P.diet.kcalMax, 50))}
        ${mini('Rice per meal (cups)', num('diet.riceCupsPerMeal', P.diet.riceCupsPerMeal, 0.25))}
        ${mini('After meal sugar max', num('diet.postMealMax', P.diet.postMealMax, 0.5))}
        ${mini('Starting weight (kg)', num('diet.startWeight', P.diet.startWeight, 0.1))}
        ${mini('Weight at last visit', num('diet.lastReviewedWeight', P.diet.lastReviewedWeight, 0.1))}
      </div>`)}

    <div class="save-bar" id="save-bar"><span>${icon('info')} ${t('unsaved')}</span>
      <div class="row"><button class="btn" data-act="settings_cancel">${t('cancel')}</button><button class="btn btn-primary" data-act="settings_save">${icon('check')} ${t('save')}</button></div></div>

    ${isCaregiver() ? '' : `<div class="section-title">${t('family_section')}</div>
    <details class="card set-card fold">
      <summary class="set-head"><span class="bubble">${icon('bell')}</span><div><b>Alerts to caregiver</b><span>Free ntfy app on the caregiver's phone</span></div>${icon('chev')}</summary>
      <label class="field">Topic<input id="ntfy" value="${esc(S.settings.ntfyTopic)}"></label>
      <div class="row"><button class="btn" data-act="ntfy_new">New topic</button><button class="btn" data-act="ntfy_save">Save</button><button class="btn btn-soft" data-act="ntfy_test">Test</button></div>
      ${S.settings.outbox.length ? `<p class="muted small">${S.settings.outbox.length} alert(s) waiting for internet.</p>` : ''}
    </details>

    <details class="card set-card fold">
      <summary class="set-head"><span class="bubble">${icon('box')}</span><div><b>Backup</b><span>Save or restore all data as a file</span></div>${icon('chev')}</summary>
      <div class="row"><button class="btn" data-act="export">Export</button><label class="btn">Import<input type="file" accept="application/json" id="import" hidden></label></div>
    </details>`}
  </div>`;
}

function joinUrl() {
  const data = { f: S.settings.familyId, n: S.settings.ntfyTopic };
  const payload = btoa(unescape(encodeURIComponent(JSON.stringify(data))));
  const base = CLOUD?.hostingUrl ? `${CLOUD.hostingUrl}/` : native.isNative ? 'https://sugar-helper.invalid/' : `${location.origin}${location.pathname}`;
  return `${base}#/join/${payload.replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')}`;
}

function decodeJoin(arg) {
  try {
    return JSON.parse(decodeURIComponent(escape(atob(arg.replace(/-/g, '+').replace(/_/g, '/')))));
  } catch {
    return null;
  }
}

function viewJoin(arg) {
  const data = decodeJoin(arg ?? '');
  if (!cloud.cloudReady() || !data?.f) return `<div class="page">${pageHead(t('join_title'))}<div class="alert yellow">${icon('alert')}<div>${t('join_bad')}</div></div></div>`;
  return `<div class="page welcome">
    <div class="logo">${icon('users')}</div>
    <h1>${t('join_title')}</h1>
    <section class="card center">
    <p>${t('join_body')}</p>
    <button class="btn btn-primary btn-lg" data-act="join_yes" data-arg="${esc(arg)}">${S.user ? t('yes') : t('join_login_btn')}</button>
    <button class="btn" data-act="home">${t('no')}</button></section></div>`;
}

// Shows a settings error without re-rendering, so typed values are kept.
function showSettingsError(text) {
  document.getElementById('settings-msg').innerHTML = `<div class="alert yellow">${icon('alert')}<div>${esc(text)}</div></div>`;
  window.scrollTo(0, 0);
}

function setPath(obj, path, value) {
  const parts = path.split('.');
  let o = obj;
  for (const p of parts.slice(0, -1)) o = o[p];
  o[parts.at(-1)] = value;
}

// --- actions --------------------------------------------------------------------------------------

const ACTIONS = {
  back: () => history.back(),
  home: () => go('home'),
  reload: () => location.reload(),
  go: (el) => go(el.dataset.to),
  welcome: () => {
    S.settings.welcomed = true;
    save(S);
    scheduleReminders();
    render();
  },
  lang: () => {
    S.settings.lang = getLang() === 'bn' ? 'en' : 'bn';
    setLang(S.settings.lang);
    save(S);
    render();
  },
  set_lang: (el) => {
    S.settings.lang = el.dataset.v;
    setLang(S.settings.lang);
    save(S);
    scheduleReminders();
    render();
  },
  theme: (el) => {
    S.settings.theme = el.dataset.v;
    save(S);
    applyTheme();
    render();
  },
  theme_toggle: () => {
    S.settings.theme = isDark() ? 'light' : 'dark';
    save(S);
    applyTheme();
    render();
  },
  reminders: (el) => {
    S.settings.reminders = el.checked;
    save(S);
    scheduleReminders().then(() => toast && render());
  },
  ack: (el) => {
    S.state.acked = [...(S.state.acked ?? []), el.dataset.key];
    saveState();
    render();
  },
  start: (el) => {
    const slot = el.dataset.slot;
    if (slot === 'snack') {
      foodFlow = { tab: 'menu', slot: 'snack', items: {}, shuffle: 0, all: false };
      return go('food');
    }
    flow = null;
    go(`dose/${slot}`);
  },

  kp: (el) => {
    native.haptic();
    const k = el.dataset.k;
    if (k === '⌫') kp = kp.slice(0, -1);
    else if (k === 'HI') kp = '33.4';
    else if (k === 'LO') kp = '1.0';
    else if (kp.length < 5 && !(k === '.' && kp.includes('.'))) kp += k;
    const d = document.getElementById('kp');
    if (d) {
      d.textContent = kp || '0.0';
      d.classList.toggle('empty', !kp);
    }
  },
  check_yes: () => {
    const c = pendingCheck;
    saveReading(c.value, c.context, c.after);
  },
  check_no: () => {
    kp = '';
    pendingCheck = null;
    render();
  },

  dose_reading: () => submitReading(CTX_FOR_SLOT[flow.slot], afterDoseReading),
  dose_no_reading: () => {
    flow.reading = null;
    flow.step = nextAfterReading();
    render();
  },
  sym: (el) => {
    const set = parseRoute().name === 'dose' ? flow.sym : highFlow.sym;
    if (el.checked) set.add(el.dataset.s);
    else set.delete(el.dataset.s);
    const btn = $app.querySelector('[data-act="dose_sym_done"],[data-act="high_sym_done"]');
    if (btn) btn.textContent = set.size ? t('ok') : t('no_symptoms');
  },
  dose_sym_done: () => {
    if (flow.sym.size) {
      flow.readingRec.symptoms = [...flow.sym];
      persist(flow.readingRec);
      flow.step = 'red';
    } else {
      flow.step = nextAfterReading();
    }
    render();
  },
  meal: (el) => {
    flow.meal = el.dataset.size;
    flow.units = null;
    flow.step = flow.meal === 'none' && S.plan.mealRules.none === 'skip' ? 'skip' : 'result';
    go(`dose/${flow.slot}`);
    render();
  },
  units: (el) => {
    native.haptic();
    readFlowInputs();
    flow.units = Math.min(100, Math.max(0, flow.units + Number(el.dataset.d)));
    render();
  },
  tab_pick: (el) => {
    flow.tabs ??= new Set();
    if (el.checked) flow.tabs.add(el.dataset.id);
    else flow.tabs.delete(el.dataset.id);
  },
  dose_taken: () => {
    const d = doseById(flow.slot);
    readFlowInputs();
    const units = d.kind === 'bolus' ? flow.units : flow.units ?? doseUnits(d);
    if ((units < d.min || units > d.max) && !confirm(t('outside_confirm', units, d.min, d.max))) return;
    let rec;
    if (d.kind === 'bolus') {
      const s = suggestBolus(S.plan, d.id, flow.reading, flow.meal);
      rec = persist({
        type: 'dose',
        kind: 'bolus',
        slot: d.id,
        insulin: d.insulin,
        medId: d.medId,
        units,
        suggested: s.units,
        base: d.base,
        delta: units - d.base,
        ts: flowTs(),
        ...(units < d.min || units > d.max ? { outside: true } : {}),
        wanted: s.wanted,
        limitHit: s.limitHit,
        reading: flow.reading,
        meal: flow.meal,
        site: flow.site,
      });
    } else {
      rec = persist({ type: 'dose', kind: 'basal', slot: d.id, insulin: d.insulin, medId: d.medId, units, base: d.base, delta: units - d.base, reading: flow.reading, site: flow.site, ts: flowTs(), ...(units < d.min || units > d.max ? { outside: true } : {}) });
    }
    for (const id of flow.tabs ?? []) persist({ type: 'tablet', med: id, name: (S.plan.tablets ?? []).find((x) => x.id === id)?.name ?? '' });
    native.haptic('HEAVY');
    celebrate({ title: t('dose_logged', rec.units, t(`ins_${d.insulin}`)), undo: rec.id });
    if (rec.outside) toast = t('outside_doctor');
    if (S.settings.alarm.voice) native.playClip(clip('dose_done'));
  },
  skip_ok: () => {
    const d = doseById(flow.slot);
    const rec = persist({ type: 'dose', kind: d.kind, slot: d.id, insulin: d.insulin, medId: d.medId, action: 'skip', units: 0, delta: 0, reading: flow.reading, meal: 'none' });
    for (const id of flow.tabs ?? []) persist({ type: 'tablet', med: id, name: (S.plan.tablets ?? []).find((x) => x.id === id)?.name ?? '' });
    celebrate({ title: t('skip_logged'), undo: rec.id });
  },
  alarm_set: (el) => {
    S.settings.alarm = { ...S.settings.alarm, [el.dataset.k]: Number(el.dataset.v) };
    save(S);
    scheduleReminders();
    render();
  },
  bg_keep: (el) => {
    S.settings.background = el.checked;
    save(S);
    updateGuard();
  },
  alarm_voice: (el) => {
    S.settings.alarm = { ...S.settings.alarm, voice: el.checked };
    save(S);
    scheduleReminders();
  },
  alarm_fix: async (el) => {
    await native.openAlarmSettings(el.dataset.k);
    alarmChecks = null; // re-check when the user comes back
  },
  alarm_test: () => {
    const at = Date.now() + 10_000;
    if (native.isNative) {
      native.alarmOnce({ id: 90, at, title: t('alarm_test_title'), body: t('alarm_test_body'), route: 'home', repeat: false, ...alarmText() });
    } else {
      setTimeout(() => webAlarm.ring({ key: 'test', title: t('alarm_test_title'), body: t('alarm_test_body'), route: 'home' }), 10_000);
    }
    toast = t('alarm_test_set');
    render();
  },
  meter_scan: () => startMeterScan(false),
  meter_scan_all: () => startMeterScan(!meterScan?.all),
  meter_pick: async (el) => {
    stopMeterScan?.();
    if (meterScan) meterScan.scanning = false;
    meterBusy = el.dataset.id;
    render();
    try {
      const m = await pairWith(el.dataset.id, el.dataset.name);
      meterScan = null;
      S.settings.meter = { ...m, lastSeq: null, lastSync: 0 };
      save(S);
      native.setMeterConfig({ deviceId: m.deviceId, lastSeq: -1 });
      meterBusy = false;
      const { added, error } = await syncMeter();
      toast = error ? meterError(error) : t('meter_new', added.length);
    } catch (e) {
      toast = e?.message === 'bluetooth_off' ? t('meter_bt_off') : t('meter_pair_fail');
    } finally {
      meterBusy = false;
      render();
    }
  },
  ms_start: () => startMeterRun(),
  ms_cancel: () => {
    if (meterRun) meterRun.cancelled = true;
    meterRun = null;
    go('home');
  },
  ms_done: () => {
    const added = meterRun?.added ?? [];
    meterRun = null;
    if (!afterMeterSync(added)) go('home');
  },
  meter_sync: () => startMeterRun(),
  meter_remove: () => {
    S.settings.meter = null;
    save(S);
    native.setMeterConfig({ deviceId: '' });
    render();
  },
  // Dose flow: take the meter reading from the last 15 minutes instead of typing it.
  dose_meter: async () => {
    meterWaiting = true;
    render();
    const { error } = await syncMeterWait();
    meterWaiting = false;
    const recent = activeLog()
      .filter((e) => e.type === 'reading' && e.source === 'meter' && Date.now() - e.ts < 15 * 60000)
      .sort((a, b) => b.ts - a.ts)[0];
    if (!recent) {
      toast = error ? meterError(error) : t('meter_none_recent');
      return render();
    }
    recent.context = CTX_FOR_SLOT[flow.slot];
    persist(recent);
    toast = t('meter_got', recent.value, hhmm(recent.ts));
    afterDoseReading(recent);
  },
  free_meter: async () => {
    meterWaiting = true;
    render();
    const { added, error } = await syncMeterWait();
    meterWaiting = false;
    toast = error ? meterError(error) : added.length ? t('meter_new', added.length) : t('meter_none');
    if (!afterMeterSync(added)) render();
  },
  share_on: () => startPatientFamily(),
  share_off: () => {
    sync.disconnect();
    S.settings.familyId = '';
    save(S);
    render();
  },
  share_copy: async () => {
    try {
      await navigator.clipboard.writeText(joinUrl());
      toast = t('share_copied');
    } catch {
      toast = joinUrl();
    }
    render();
  },
  go_login: () => {
    S.settings.loginSkipped = false;
    loginFlow = null;
    save(S);
    go('login');
  },
  login_pw_mode: () => {
    loginFlow.email = document.getElementById('lg-email')?.value ?? loginFlow.email;
    Object.assign(loginFlow, { step: 'password', err: '' });
    render();
  },
  login_code_mode: () => {
    loginFlow.email = document.getElementById('lg-email')?.value ?? loginFlow.email;
    Object.assign(loginFlow, { step: 'email', err: '' });
    render();
  },
  login_back: () => {
    Object.assign(loginFlow, { step: 'email', err: '' });
    render();
  },
  login_send: async () => {
    const L = loginFlow;
    if (L.step === 'email') L.email = cloud.normEmail(document.getElementById('lg-email')?.value);
    if (!cloud.validEmail(L.email)) return Object.assign(L, { err: 'bad_email' }) && render();
    Object.assign(L, { busy: true, err: '' });
    render();
    try {
      await cloud.sendCode(L.email, getLang());
      Object.assign(L, { step: 'code', busy: false });
      toast = t('code_sent_toast');
    } catch (e) {
      Object.assign(L, { busy: false, err: e?.message === 'Failed to fetch' ? 'network' : e?.message });
    }
    render();
    document.getElementById('lg-code')?.focus();
  },
  login_verify: async () => {
    const L = loginFlow;
    const code = document.getElementById('lg-code')?.value ?? '';
    Object.assign(L, { busy: true, err: '' });
    render();
    try {
      await cloud.verifyCode(L.email, code);
      loginFlow = null;
    } catch (e) {
      Object.assign(L, { busy: false, err: e?.message === 'Failed to fetch' ? 'network' : e?.message });
      render();
    }
  },
  login_password: async () => {
    const L = loginFlow;
    L.email = cloud.normEmail(document.getElementById('lg-email')?.value);
    const pass = document.getElementById('lg-pass')?.value ?? '';
    if (!/^\d{6}$/.test(pass)) return Object.assign(L, { err: 'weak-password' }) && render();
    Object.assign(L, { busy: true, err: '' });
    render();
    try {
      await cloud.passwordLogin(L.email, pass);
      loginFlow = null;
    } catch (e) {
      Object.assign(L, { busy: false, err: e?.message });
      render();
    }
  },
  login_signup: async () => {
    const L = loginFlow;
    L.email = cloud.normEmail(document.getElementById('lg-email')?.value);
    const pass = document.getElementById('lg-pass')?.value ?? '';
    if (!cloud.validEmail(L.email)) return Object.assign(L, { err: 'bad_email' }) && render();
    if (!/^\d{6}$/.test(pass)) return Object.assign(L, { err: 'weak-password' }) && render();
    Object.assign(L, { busy: true, err: '' });
    render();
    try {
      await cloud.passwordSignup(L.email, pass);
      loginFlow = null;
    } catch (e) {
      Object.assign(L, { busy: false, err: e?.message });
      render();
    }
  },
  login_skip: () => {
    S.settings.loginSkipped = true;
    save(S);
    go('home');
  },
  role_patient: () => startPatientFamily(),
  role_member: () => {
    Object.assign(S.settings, { memberOnly: true, welcomed: true });
    save(S);
    go('mine');
  },
  reg_sex: (el) => {
    for (const b of $app.querySelectorAll('[data-act=reg_sex]')) b.classList.toggle('on', b === el);
  },
  reg_age: (el) => {
    const o = document.getElementById('reg-age');
    o.textContent = Math.min(110, Math.max(1, Number(o.textContent) + Number(el.dataset.d)));
  },
  reg_age_set: (el) => {
    document.getElementById('reg-age').textContent = el.dataset.v;
  },
  reg_save: (el) => {
    const msg = (k) => (document.getElementById('reg-msg').innerHTML = `<div class="alert red">${icon('alert')}<div>${t(k)}</div></div>`);
    const name = document.getElementById('reg-name').value.trim().replace(/\s+/g, ' ');
    const rawPhone = document.getElementById('reg-phone').value.trim();
    const phone = rawPhone ? bdPhone(rawPhone) : '';
    if (!name) return msg('reg_need_name');
    if (rawPhone && !phone) return msg('pt_phone_bad');
    const sex = $app.querySelector('[data-act=reg_sex].on')?.dataset.v;
    Object.assign(S.plan.patient, { name, age: Number(document.getElementById('reg-age').textContent), registered: true });
    if (sex) S.plan.patient.sex = sex;
    if (phone) S.plan.patient.phone = phone;
    else if (!rawPhone) delete S.plan.patient.phone;
    savePlan();
    toast = t('reg_saved');
    if (el.dataset.first) go('home');
    else history.back();
  },
  role_family: () => {
    S.settings.role = 'caregiver';
    save(S);
    go('joincode');
  },
  join_code: () => doJoin(document.getElementById('join-code')?.value ?? ''),
  copy_code: async () => {
    try {
      await navigator.clipboard.writeText(prettyCode(S.settings.familyId));
      toast = t('code_copied');
    } catch {
      toast = prettyCode(S.settings.familyId);
    }
    render();
  },
  member_remove: async (el) => {
    await cloud.removeMember(S.settings.familyId, el.dataset.uid).catch(() => {});
    members = null;
    render();
  },
  new_code: async () => {
    if (!confirm(t('new_code_confirm'))) return;
    sync.disconnect();
    members = null;
    S.settings.familyId = '';
    S.plan.updatedAt = Math.max(S.plan.updatedAt ?? 0, 1); // this phone's plan goes to the new family
    save(S);
    await startPatientFamily();
    toast = t('new_code_done');
    render();
  },
  ring_send: async (el) => {
    const kind = el.dataset.kind;
    const R = ringState;
    if (!phoneReachable()) return render();
    R.text = document.getElementById('ring-text')?.value ?? R.text;
    if (kind === 'text' && !R.text.trim()) return Object.assign(R, { err: 'empty', sent: null }) && render();
    Object.assign(R, { busy: kind, err: '', sent: null });
    render();
    try {
      await cloud.ringPatient(S.settings.familyId, kind, kind === 'text' ? R.text.trim() : '', S.plan.caregiver?.name || '');
      Object.assign(R, { busy: '', sent: Date.now() });
      if (kind === 'text') R.text = '';
    } catch (e) {
      Object.assign(R, { busy: '', err: e?.message === 'Failed to fetch' ? 'network' : e?.message });
    }
    render();
  },
  phone_save: () => {
    const p = bdPhone(document.getElementById('pt-phone')?.value);
    if (!p) {
      toast = t('pt_phone_bad');
      return render();
    }
    S.plan.patient.phone = p;
    savePlan();
    toast = t('pt_phone_saved');
    render();
  },
  del_pick: (el) => {
    if (el.checked) delState.picked.add(el.dataset.id);
    else delState.picked.delete(el.dataset.id);
    updateDeleteBar();
  },
  del_day: (el) => {
    for (const box of $app.querySelectorAll(`.del-item input[data-day="${el.dataset.day}"]`)) {
      box.checked = el.checked;
      if (el.checked) delState.picked.add(box.dataset.id);
      else delState.picked.delete(box.dataset.id);
    }
    updateDeleteBar();
  },
  del_none: () => {
    delState = { picked: new Set(), confirm: '', err: '' };
    render();
  },
  del_ask: (el) => {
    delState.confirm = el.dataset.what;
    delState.err = '';
    render();
    document.getElementById('del-word')?.focus();
  },
  del_cancel: () => {
    delState.confirm = '';
    delState.err = '';
    render();
  },
  del_go: () => {
    const word = (document.getElementById('del-word')?.value ?? '').trim().toLowerCase();
    if (!DELETE_WORDS.includes(word)) {
      delState.err = 'wrong';
      return render();
    }
    const all = delState.confirm === 'all';
    const now = Date.now();
    let n = 0;
    for (const e of S.log) {
      if (e.deleted || !(all || delState.picked.has(e.id))) continue;
      e.deleted = true;
      e.updatedAt = now;
      sync.pushRecord(e);
      n++;
    }
    save(S);
    delState = { picked: new Set(), confirm: '', err: '' };
    toast = t('del_done', loc(n));
    render();
  },
  med_pick: (el) => {
    readMedForm();
    const k = knownMed(el.dataset.name);
    if (!k) return;
    Object.assign(medDraft, { name: k.name, strength: k.strength, type: k.type, ...(k.insulinKind ? { insulinKind: k.insulinKind, kindTouched: true } : {}) });
    render();
  },
  med_meal: (el) => {
    readMedForm();
    const x = medDraft.times.find((y) => y.when === el.dataset.when);
    if (x) x.meal = el.dataset.v;
    render();
  },
  med_type: (el) => {
    medDraft.type = el.dataset.type;
    medDraft.times = [];
    render();
  },
  med_retype: () => {
    readMedForm();
    medDraft.type = '';
    render();
  },
  med_kind: (el) => {
    readMedForm();
    const d = medDraft;
    d.insulinKind = el.dataset.k;
    d.kindTouched = true;
    const allowed = insulinWhen(d.insulinKind);
    d.times = d.times
      .map((x) => (allowed.includes(x.when) ? x : x.when === 'dinner' && allowed.includes('night') ? { ...x, when: 'night', at: DEFAULT_AT.night } : x.when === 'night' && allowed.includes('dinner') ? { ...x, when: 'dinner', at: DEFAULT_AT.dinner } : null))
      .filter(Boolean);
    render();
  },
  med_amt: (el) => {
    readMedForm();
    const d = medDraft;
    const w = el.dataset.when;
    const step = isInsulin(d) ? 1 : 0.5;
    let x = d.times.find((y) => y.when === w);
    if (!x) d.times.push((x = { when: w, amount: 0, at: DEFAULT_AT[w], meal: isInsulin(d) ? '' : 'after' }));
    x.amount = Math.max(0, Math.min(isInsulin(d) ? 100 : 10, x.amount + step * Number(el.dataset.d)));
    d.times = d.times.filter((y) => y.amount > 0);
    d.err = '';
    render();
  },
  med_range: (el) => {
    readMedForm();
    medDraft.range = Math.max(0, Math.min(6, (medDraft.range ?? 2) + Number(el.dataset.d)));
    render();
  },
  med_quick: () => {
    readMedForm();
    const d = medDraft;
    const nums = parseDoseString(document.getElementById('med-quick')?.value);
    if (!nums) {
      d.err = t('med_quick_bad');
      return render();
    }
    d.times = doseTimes(nums, d).map((x) => ({ ...x, at: DEFAULT_AT[x.when], meal: isInsulin(d) ? '' : 'after' }));
    d.err = '';
    render();
  },
  med_cancel: () => {
    medDraft = null;
    go('meds');
  },
  med_save: () => {
    readMedForm();
    const d = medDraft;
    if (!d.name) {
      d.err = t('med_need_name');
      return render();
    }
    if (!d.times.length) {
      d.err = t('med_need_dose');
      return render();
    }
    const others = (S.plan.meds ?? []).filter((x) => x.id !== d.id);
    const { err, kindTouched, ...clean } = d;
    if (!isInsulin(clean)) {
      delete clean.insulinKind;
      delete clean.range;
    }
    const meds = [...others, clean];
    const clash = insulinClash(meds);
    if (clash) {
      d.err = t('med_clash', whenText(clash));
      return render();
    }
    const basalChanged = isInsulin(clean) && (clean.insulinKind === 'basal' || (S.plan.meds ?? []).some((x) => x.id === clean.id && x.insulinKind === 'basal'));
    S.plan.meds = meds;
    applyMeds(S.plan);
    if (basalChanged) {
      S.state.basal = undefined;
      saveState();
    }
    savePlan();
    medDraft = null;
    toast = t('med_saved');
    go('meds');
  },
  med_delete: () => {
    if (!confirm(t('med_delete_q', medDraft.name))) return;
    S.plan.meds = (S.plan.meds ?? []).filter((x) => x.id !== medDraft.id);
    applyMeds(S.plan);
    if (!basalDose() && S.state.basal) {
      S.state.basal = undefined;
      saveState();
    }
    savePlan();
    medDraft = null;
    go('meds');
  },
  db_day: (el) => {
    doseBook = newDoseBook(Number(el.dataset.v));
    render();
  },
  db_set: (el) => {
    readDoseBook();
    const e = doseBook.ins[el.dataset.slot];
    e.status = e.status === el.dataset.v ? '' : el.dataset.v;
    render();
  },
  db_amt: (el) => {
    readDoseBook();
    const e = doseBook.ins[el.dataset.slot];
    e.units = Math.max(0, Math.min(100, e.units + Number(el.dataset.d)));
    render();
  },
  db_tab: (el) => {
    readDoseBook();
    const e = doseBook.tabs[el.dataset.key];
    e.taken = !e.taken;
    render();
  },
  db_save: () => {
    readDoseBook();
    const B = doseBook;
    const outside = S.plan.doses.filter((d) => B.ins[d.id].status === 'taken' && (B.ins[d.id].units < d.min || B.ins[d.id].units > d.max));
    if (outside.length && !confirm(outside.map((d) => t('outside_confirm', B.ins[d.id].units, d.min, d.max)).join('\n'))) return;
    const start = dayStartOf(B.offset);
    let n = 0;
    for (const d of S.plan.doses) {
      const e = B.ins[d.id];
      if (!e.status) continue;
      const old = e.recId ? S.log.find((x) => x.id === e.recId) : null;
      const base = { type: 'dose', kind: d.kind, slot: d.id, insulin: d.insulin, medId: d.medId, base: d.base, later: true };
      const rec = { ...(old ?? {}), ...base, id: old?.id, ts: e.status === 'taken' ? atToTs(start, e.at) : old?.ts ?? atToTs(start, d.injectAt) };
      if (e.status === 'taken') {
        delete rec.action;
        Object.assign(rec, { units: e.units, delta: e.units - d.base, outside: e.units < d.min || e.units > d.max });
      } else Object.assign(rec, { action: 'skip', units: 0, delta: 0 });
      const same = old && old.action === rec.action && old.units === rec.units && old.ts === rec.ts;
      if (!same) {
        if (!old) delete rec.id;
        persist(rec);
        n++;
      }
    }
    for (const x of generalTimes(S.plan.meds ?? [])) {
      const k = `${x.medId}:${x.when}`;
      const e = B.tabs[k];
      const old = e.recId ? S.log.find((r) => r.id === e.recId) : null;
      if (e.taken && !old) {
        persist({ type: 'tablet', med: x.medId, name: x.name, when: x.when, ts: atToTs(start, e.at), later: true });
        n++;
      } else if (e.taken && old && hhmm(old.ts) !== e.at) {
        persist({ ...old, ts: atToTs(start, e.at) });
        n++;
      } else if (!e.taken && old) {
        persist({ ...old, deleted: true });
        n++;
      }
    }
    doseBook = null;
    toast = n ? t('db_saved', loc(n)) : t('db_nothing');
    go('home');
  },
  wh_pick: (el) => {
    if (el.checked) whose.picked.add(el.dataset.id);
    else whose.picked.delete(el.dataset.id);
    const n = whose.picked.size;
    const c = document.getElementById('wh-count');
    if (c) c.textContent = t('wh_sheet_sub', loc(n));
    for (const x of $app.querySelectorAll('.wh-sheet, .wh-spacer')) x.classList.toggle('show', n > 0);
    lastHtml = ''; // the screen changed outside render()
  },
  wh_clear: () => {
    whose.picked = new Set();
    render();
  },
  wh_assign: (el) => {
    const res = assignReadings(whose.picked, el.dataset.person);
    whose.picked = new Set();
    confirmAssigned(res, el.dataset.person);
    if (!res.n) toast = t('as_nothing');
    render();
  },
  as_ok: () => {
    assigned = null;
    render();
  },
  as_view: () => {
    histWho = assigned?.person ?? '';
    assigned = null;
    go('history');
  },
  hist_who: (el) => {
    histWho = el.dataset.id;
    render();
  },
  as_undo: () => {
    const A = assigned;
    assigned = null;
    if (A) assignReadings(new Set(Object.keys(A.was)), '', A.was);
    toast = t('as_undone');
    render();
  },
  wh_one: (el) => {
    assignReadings(new Set([el.dataset.id]), el.dataset.person);
    render();
  },
  pp_new: () => {
    personDraft = { name: '', relation: 'father', email: '', step: 'form', err: '', busy: false };
    render();
    document.getElementById('pp-name')?.focus();
  },
  pp_cancel: () => {
    personDraft = null;
    render();
  },
  pp_rel: (el) => {
    readPersonForm();
    personDraft.relation = el.dataset.v;
    render();
  },
  pp_send: async () => {
    readPersonForm();
    const D = personDraft;
    if (!D.name) return Object.assign(D, { err: 'need_name' }) && render();
    if (!cloud.validEmail(D.email)) return Object.assign(D, { err: 'bad_email' }) && render();
    Object.assign(D, { busy: true, err: '' });
    render();
    try {
      await cloud.sendCode(D.email, getLang(), { purpose: 'family', member: D.name, by: S.plan.patient.name });
      Object.assign(D, { busy: false, step: 'code' });
    } catch (e) {
      Object.assign(D, { busy: false, err: e?.message === 'Failed to fetch' ? 'network' : e?.message });
    }
    render();
    document.getElementById('pp-code')?.focus();
  },
  pp_verify: async () => {
    const D = personDraft;
    const code = document.getElementById('pp-code')?.value ?? '';
    Object.assign(D, { busy: true, err: '' });
    render();
    try {
      await cloud.checkEmailCode(D.email, code);
      addPerson({ name: D.name, relation: D.relation, email: cloud.normEmail(D.email), verified: true });
    } catch (e) {
      Object.assign(D, { busy: false, err: e?.message === 'Failed to fetch' ? 'network' : e?.message });
      render();
    }
  },
  pp_no_email: () => {
    readPersonForm();
    if (!personDraft.name) return Object.assign(personDraft, { err: 'need_name' }) && render();
    addPerson({ name: personDraft.name, relation: personDraft.relation, email: '', verified: false });
  },
  pp_remove: (el) => {
    const p = people().find((x) => x.id === el.dataset.id);
    if (!p || !confirm(t('pp_remove_q', p.name))) return;
    S.plan.people = people().filter((x) => x.id !== p.id);
    savePlan();
    if (p.verified && p.email && S.settings.familyId) cloud.removeMemberLink(p.email, S.settings.familyId).catch(() => {});
    go('people');
  },
  wh_filter: (el) => {
    assigned = null;
    whose = { picked: new Set(), meterOnly: el.dataset.v === '1' };
    render();
  },
  wh_mark: (el) => {
    const other = el.dataset.v === 'other';
    const now = Date.now();
    let n = 0;
    for (const e of S.log) {
      if (!whose.picked.has(e.id) || !!e.other === other) continue;
      if (other) e.other = true;
      else delete e.other;
      e.updatedAt = now;
      sync.pushRecord(e);
      n++;
    }
    save(S);
    whose.picked = new Set();
    dispatchAlerts();
    toast = t(other ? 'wh_marked_other' : 'wh_marked_patient', loc(n));
    render();
  },
  role_change: async () => {
    if (!confirm(t('role_change_confirm'))) return;
    sync.disconnect();
    native.setSyncAuth({}); // the phone stops syncing the old family in the background too
    members = null;
    if (S.user) await cloud.saveProfile(S.user.uid, { email: S.user.email ?? '', role: '', family: '' }).catch(() => {});
    S.settings.familyId = '';
    if (isCaregiver()) S.log = [];
    save(S);
    go('role');
  },
  cg_open_ntfy: () => {
    window.open(`ntfy://ntfy.sh/${S.settings.ntfyTopic}`, '_system');
  },
  cg_copy_topic: async () => {
    try {
      await navigator.clipboard.writeText(S.settings.ntfyTopic);
      toast = t('code_copied');
    } catch {
      toast = S.settings.ntfyTopic;
    }
    render();
  },
  cg_test: async () => {
    try {
      await sendNtfy(S.settings.ntfyTopic, { title: `${S.plan.patient.name}: test`, message: t('cg_test_msg'), priority: 3 });
      toast = t('cg_test_sent');
    } catch {
      toast = t('err_network');
    }
    render();
  },
  passcode_toggle: (el) => {
    S.settings.passcodeOff = !el.checked;
    save(S);
    render();
  },
  save_password: async () => {
    const p = document.getElementById('new-pass')?.value ?? '';
    if (!/^\d{6}$/.test(p)) {
      toast = t('err_weak');
      return render();
    }
    try {
      await cloud.setPassword(p);
      toast = t('password_saved');
    } catch (e) {
      toast = t(authErr(e?.message));
    }
    render();
  },
  logout: async () => {
    const wasCaregiver = isCaregiver();
    S.settings.accountUid = S.user?.uid ?? S.settings.accountUid;
    await cloud.logout().catch(() => {});
    native.setSyncAuth({});
    sync.disconnect();
    members = null;
    S.settings.familyId = '';
    S.settings.loginSkipped = false;
    delete S.settings.memberLink;
    delete S.settings.memberOnly;
    mine.stop?.();
    mine = { key: '', list: null, stop: null, err: '' };
    if (wasCaregiver) {
      // don't leave the patient's data on a family member's device
      S.log = [];
      S.presence = null;
      S.settings.role = 'patient';
      S.settings.welcomed = false;
    }
    save(S);
    loginFlow = null;
    go('login');
  },
  celebrate_ok: () => {
    celebration = null;
    render();
  },
  undo: (el) => {
    const rec = S.log.find((e) => e.id === el.dataset.id);
    celebration = null;
    if (!rec) return render();
    rec.deleted = true;
    persist(rec);
    flow = null;
    go(`dose/${rec.slot}`);
  },
  say: async (el) => {
    const r = await native.speak(el.dataset.text);
    if (r && !r.ok) {
      toast = t('voice_missing');
      render();
    }
  },
  voice_install: () => native.voiceInstall(),
  voice_test: async () => {
    if (native.isNative && (await native.playClip(clip('voice_test')))?.ok) return;
    const r = await native.speak(t('voice_sample', S.plan.patient.name));
    voiceState = r?.ok ? 'ok' : r?.reason ?? 'not_supported';
    render();
  },
  text_size: (el) => {
    S.settings.textSize = el.dataset.v;
    save(S);
    applyTextSize();
    render();
  },
  fix_mistake: () => {
    flow.prev.deleted = true;
    persist(flow.prev);
    flow.prev = null;
    flow.step = 'reading';
    render();
  },
  basal_accept: () => {
    const p = basalProposal(S.plan, S.state.basal, activeLog());
    S.state.basal = { current: p.proposed, lastChange: Date.now(), limitHitAt: p.limitHit ? Date.now() : S.state.basal?.limitHitAt };
    if (flow) flow.units = p.proposed;
    saveState();
    scheduleReminders();
    dispatchAlerts();
    flow.basalDecided = true;
    render();
  },
  basal_keep: () => {
    flow.basalDecided = true;
    render();
  },
  basal_reset: () => {
    S.state.basal = undefined;
    saveState();
    scheduleReminders();
    render();
  },

  low_timer: () => {
    lowFlow.timerEnd = Date.now() + TIMER_MS;
    lowFlow.step = 'timer';
    native.alarmOnce({ id: 99, at: lowFlow.timerEnd, title: t('alarm_low_title'), body: t('alarm_low_body'), route: 'low', repeat: true, clip: clip('low_recheck'), ...alarmText() });
    if (!native.isNative) webAlarm.schedule('low', lowFlow.timerEnd);
    render();
  },
  low_skip_wait: () => {
    native.cancelAlarm(99);
    lowFlow.step = 'recheck';
    render();
  },
  low_reading: () =>
    submitReading('other', (rec) => {
      native.confirmAlarm(99);
      if (rec.value >= LIMITS.HYPO) {
        persist({ type: 'hypo', outcome: 'recovered', rounds: lowFlow.round });
        lowFlow.step = 'ok';
        lowFlow.value = rec.value;
      } else if (lowFlow.round >= 2) {
        persist({ type: 'hypo', outcome: 'not_recovering', rounds: lowFlow.round });
        lowFlow.step = 'fail';
      } else {
        lowFlow.round += 1;
        lowFlow.step = 'treat';
      }
      render();
    }),
  low_continue: () => {
    const slot = lowFlow.returnTo;
    flow = { slot, step: 'reading', prev: null, reading: lowFlow.value, readingRec: null, meal: null, units: null, tabs: new Set(), sym: new Set() };
    flow.step = nextAfterReading();
    lowFlow = null;
    go(`dose/${slot}`);
  },
  severe: () => {
    persist({ type: 'hypo', outcome: 'severe', rounds: lowFlow?.round ?? 0 });
    native.cancelAlarm(99);
    lowFlow = { ...(lowFlow ?? {}), step: 'severe' };
    if (parseRoute().name !== 'low') go('low');
    else render();
  },

  high_reading: () =>
    submitReading(guessContext(), (rec) => {
      if (rec.value < LIMITS.HYPO) {
        lowFlow = { round: 1, step: 'treat', returnTo: null };
        return go('low');
      }
      highFlow.rec = rec;
      highFlow.step = 'symptoms';
      render();
    }),
  high_no_reading: () => {
    highFlow.step = 'symptoms';
    render();
  },
  high_sym_done: () => {
    const v = highFlow.rec?.value;
    if (highFlow.sym.size && highFlow.rec) {
      highFlow.rec.symptoms = [...highFlow.sym];
      persist(highFlow.rec);
    }
    // No reading but clear warning signs: still tell the family (an alert, not a reading).
    if (highFlow.sym.size && !highFlow.rec) persist({ type: 'high_signs', symptoms: [...highFlow.sym] });
    highFlow.step = highFlow.sym.size && (v == null || v > LIMITS.HIGH) ? 'red' : 'advice';
    render();
  },

  ctx: (el) => {
    readingFlow.ctx = el.dataset.c;
    for (const c of $app.querySelectorAll('[data-act="ctx"]')) c.classList.toggle('on', c === el);
  },
  free_reading: () =>
    submitReading(readingFlow.ctx, (rec) => {
      if (rec.value < LIMITS.HYPO) {
        lowFlow = { round: 1, step: 'treat', returnTo: null };
        return go('low');
      }
      if (rec.value > LIMITS.HIGH) {
        highFlow = { step: 'symptoms', rec, sym: new Set() };
        return go('high');
      }
      toast = `${t('saved')} · ${rec.value}`;
      readingFlow = null;
      render();
    }),

  food_slot: (el) => {
    foodFlow.slot = el.dataset.s;
    render();
  },
  food_log: () => {
    foodFlow = { tab: 'log', slot: mealSlotGuess(), items: {}, shuffle: 0, all: false };
    go('food');
  },
  food_tab: (el) => {
    foodFlow.tab = el.dataset.v;
    render();
  },
  food_all: (el) => {
    foodFlow.all = el.dataset.v === '1';
    render();
  },
  menu_shuffle: () => {
    foodFlow.shuffle += 1;
    foodFlow.swaps = {};
    foodFlow.swapIdx = {};
    render();
    window.scrollTo(0, 0);
  },
  // ↻ cycles one menu item through same-group alternatives, then back to the original.
  swap: (el) => {
    native.haptic();
    const key = el.dataset.key;
    const [slot, idx] = key.split(':');
    const { base } = currentMenu();
    const alts = alternativesFor(homeFoods(), base.meals[slot][idx].id);
    foodFlow.swaps ??= {};
    foodFlow.swapIdx ??= {};
    const n = ((foodFlow.swapIdx[key] ?? 0) + 1) % (alts.length + 1);
    foodFlow.swapIdx[key] = n;
    if (n) foodFlow.swaps[key] = alts[n - 1];
    else delete foodFlow.swaps[key];
    const y = window.scrollY;
    render();
    window.scrollTo(0, y);
  },
  ate_menu: (el) => {
    const slot = el.dataset.slot;
    const items = dishesToItems(currentMenu(0).menu.meals[slot]);
    persist({ type: 'meal', slot, items, ...mealTotals(items) });
    native.haptic('MEDIUM');
    toast = t('saved');
    const y = window.scrollY;
    render();
    window.scrollTo(0, y);
  },
  tomorrow: () => {
    foodFlow = { tab: 'menu', slot: mealSlotGuess(), items: {}, shuffle: 0, all: false, dayOffset: 1 };
    go('food');
  },
  menu_day: (el) => {
    foodFlow.dayOffset = Number(el.dataset.v);
    render();
  },
  have_toggle: (el) => {
    native.haptic();
    foodFlow.have ??= new Set();
    const id = el.dataset.f;
    if (foodFlow.have.has(id)) foodFlow.have.delete(id);
    else foodFlow.have.add(id);
    const y = window.scrollY;
    render();
    window.scrollTo(0, y);
  },
  have_log: () => {
    const m = pantryMeal([...foodFlow.have], MEAL_SHARE[foodFlow.slot] * S.plan.diet.kcalTarget);
    const items = { ...m.items, ...(m.oil ? { oil: m.oil } : {}) };
    persist({ type: 'meal', slot: foodFlow.slot, items, ...mealTotals(items) });
    native.haptic('MEDIUM');
    toast = t('saved');
    foodFlow.have = new Set();
    foodFlow.tab = 'menu';
    render();
  },
  offplan_log: (el) => {
    foodFlow = { tab: 'log', slot: el.dataset.slot || mealSlotGuess(), items: {}, shuffle: 0, all: false };
    go('food');
  },
  site: (el) => {
    native.haptic();
    flow.site = el.dataset.s;
    render();
  },
  stock_open: (el) => {
    const id = el.dataset.id;
    const cur = S.state.stock?.[id];
    S.state.stock = { ...S.state.stock, [id]: { openedAt: Date.now(), spare: Math.max(0, (cur?.spare ?? 0) - (cur?.openedAt ? 1 : 0)) } };
    saveState();
    toast = t('saved');
    render();
  },
  stock_spare: (el) => {
    const id = el.dataset.id;
    const cur = S.state.stock?.[id] ?? { openedAt: 0, spare: 0 };
    S.state.stock = { ...S.state.stock, [id]: { ...cur, spare: (cur.spare ?? 0) + 1 } };
    saveState();
    render();
  },
  stock_count: (el) => {
    const id = el.dataset.id;
    const n = Number(document.getElementById(`count-${id}`).value);
    if (!(n >= 0)) return;
    S.state.stock = { ...S.state.stock, [id]: { count: n, at: Date.now() } };
    saveState();
    toast = t('saved');
    render();
  },
  pantry_toggle: (el) => {
    native.haptic();
    const id = el.dataset.f;
    if (pantryDraft.has(id)) pantryDraft.delete(id);
    else pantryDraft.add(id);
    el.classList.toggle('on', pantryDraft.has(id));
    document.getElementById('pantry-count').textContent = t('pantry_count', pantryDraft.size);
  },
  pantry_save: () => {
    S.plan.diet.homeFoods = CATALOG.filter((f) => pantryDraft.has(f.id)).map((f) => f.id);
    pantryDraft = null;
    savePlan();
    foodFlow = { tab: 'menu', slot: mealSlotGuess(), items: {}, shuffle: 0, all: false };
    toast = t('saved');
    go('food');
  },
  food: (el) => {
    native.haptic();
    const id = el.dataset.f;
    const step = id === 'rice' || id === 'muri' ? 0.5 : 1;
    foodFlow.items[id] = Math.max(0, (foodFlow.items[id] ?? 0) + Number(el.dataset.d) * step);
    const y = window.scrollY;
    render();
    window.scrollTo(0, y);
  },
  food_save: () => {
    const items = Object.fromEntries(Object.entries(foodFlow.items).filter(([, n]) => n > 0));
    persist({ type: 'meal', slot: foodFlow.slot, items, ...mealTotals(items) });
    toast = t('saved');
    foodFlow = null;
    go('home');
  },
  weight_save: () => {
    const kg = Number(document.getElementById('kg').value);
    const ft = Number(document.getElementById('hft').value);
    const inch = Number(document.getElementById('hin').value);
    const cm = ftInToCm(ft, inch);
    if (ft >= 3 && ft <= 7 && inch >= 0 && inch < 12 && cm !== S.plan.patient.heightCm) {
      S.plan.patient.heightCm = cm;
      savePlan();
    }
    const kgText = document.getElementById('kg').value.trim();
    if (kgText && !(kg > 25 && kg < 200)) {
      toast = t('weight_bad');
      return render();
    }
    if (kgText) persist({ type: 'weight', kg: Math.round(kg * 10) / 10 });
    toast = t('saved');
    render();
  },

  print: () => window.print(),
  report_period: (el) => {
    reportDays = Number(el.dataset.v);
    render();
  },
  report_pdf: async () => {
    const html = reportHtml(fullReport());
    if (native.isNative) {
      try {
        await native.printHtml(html, reportName('pdf').replace('.pdf', ''));
      } catch {
        toast = t('rep_fail');
        render();
      }
      return;
    }
    const w = window.open('', '_blank');
    if (!w) return;
    w.document.write(html);
    w.document.close();
    setTimeout(() => w.print(), 400);
  },
  report_xlsx: async () => {
    const bytes = makeXlsx(reportSheets(fullReport()));
    const mime = 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';
    if (native.isNative) {
      try {
        await native.shareFile(reportName('xlsx'), mime, toBase64(bytes));
        toast = t('rep_saved');
      } catch {
        toast = t('rep_fail');
      }
      return render();
    }
    const a = document.createElement('a');
    a.href = URL.createObjectURL(new Blob([bytes], { type: mime }));
    a.download = reportName('xlsx');
    a.click();
  },

  pin_unlock: () => {
    if (document.getElementById('pin').value === S.settings.pin) {
      unlocked = true;
      settingsMsg = '';
    } else settingsMsg = t('pin_wrong');
    render();
  },
  settings_cancel: () => {
    settingsDirty = false;
    render();
  },
  settings_save: () => {
    const plan = structuredClone(S.plan);
    for (const el of $app.querySelectorAll('[data-path]')) {
      const v = el.type === 'checkbox' ? el.checked : el.type === 'number' ? Number(el.value) : el.value;
      setPath(plan, el.dataset.path, v);
    }
    const bad = plan.doses.find((d) => !(d.min <= d.base && d.base <= d.max));
    if (bad) return showSettingsError(`${slotName(bad.id)}: min ≤ base ≤ max`);
    const emergency = [];
    for (const i of [0, 1, 2]) {
      const name = $app.querySelector(`[data-em-name="${i}"]`)?.value.trim() ?? '';
      const raw = $app.querySelector(`[data-em-phone="${i}"]`)?.value.trim() ?? '';
      if (!raw) continue;
      const phone = bdPhone(raw);
      if (!phone) return showSettingsError(t('em_bad', loc(i + 1)));
      emergency.push({ name, phone });
    }
    plan.emergency = emergency;
    for (const who of ['patient', 'caregiver', 'doctor']) {
      const raw = String(plan[who].phone ?? '').trim();
      plan[who].phone = bdPhone(raw) || raw;
    }
    const wide = plan.doses.filter((d) => d.max - d.base > 2 || d.base - d.min > 2);
    for (const el of $app.querySelectorAll('[data-set]')) S.settings[el.dataset.set] = el.value;
    const pin = document.getElementById('newpin').value.trim();
    if (pin) {
      S.settings.pin = pin;
      unlocked = true;
    }
    S.plan = plan;
    settingsDirty = false;
    savePlan();
    settingsMsg = wide.length ? `Saved. Note: ${wide.map((d) => slotName(d.id)).join(', ')} allows more than ±2.` : 'Saved';
    render();
  },
  join_yes: async (el) => {
    const data = decodeJoin(el.dataset.arg);
    S.settings.welcomed = true;
    S.settings.role = 'caregiver';
    if (!S.user) {
      S.settings.pendingJoin = { f: data.f, n: data.n ?? '' };
      save(S);
      return go('login');
    }
    save(S);
    doJoin(data.f, data.n);
  },
  ntfy_new: () => {
    document.getElementById('ntfy').value = randomTopic();
  },
  ntfy_save: () => {
    S.settings.ntfyTopic = document.getElementById('ntfy').value.trim();
    // Don't flood the caregiver with alerts that already existed.
    S.settings.sent = [...new Set([...S.settings.sent, ...currentAlerts().map((a) => a.key)])];
    save(S);
    settingsMsg = 'Topic saved';
    render();
  },
  ntfy_test: async () => {
    const topic = document.getElementById('ntfy').value.trim();
    try {
      await sendNtfy(topic, { title: `${S.plan.patient.name}: test`, message: 'Sugar Helper test alert', priority: 3 });
      settingsMsg = 'Test sent. Check the ntfy app.';
    } catch (e) {
      settingsMsg = `Could not send: ${e.message}`;
    }
    render();
  },
  export: () => {
    const blob = new Blob([JSON.stringify({ plan: S.plan, log: S.log, state: S.state }, null, 1)], { type: 'application/json' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = `sugar-helper-backup-${dayKey(Date.now())}.json`;
    a.click();
  },
};

function afterDoseReading(rec) {
  flow.reading = rec.value;
  flow.readingRec = rec;
  if (rec.value < LIMITS.HYPO) {
    lowFlow = { round: 1, step: 'treat', returnTo: flow.slot };
    return go('low');
  }
  flow.step = rec.value > LIMITS.HIGH ? 'symptoms' : nextAfterReading();
  render();
}

function nextAfterReading() {
  return doseById(flow.slot)?.kind === 'basal' ? 'result' : 'meal';
}

// A second tap on the same button right after the first is ignored (shaky hands must not log a
// dose twice). A failing action shows a short message instead of leaving the screen stuck.
let lastTap = { el: null, at: 0 };
const REPEATABLE = new Set(['db_amt', 'med_amt', 'med_range', 'reg_age', 'units', 'wh_pick', 'del_pick']);
function runAction(el) {
  const act = el.dataset.act;
  try {
    const out = ACTIONS[act]?.(el);
    if (out && typeof out.catch === 'function') out.catch((err) => actionFailed(err, act));
  } catch (err) {
    actionFailed(err, act);
  }
}
function actionFailed(err, act) {
  logError(err, `action ${act}`);
  toast = t('err_generic');
  render();
}
$app.addEventListener('click', (e) => {
  const el = e.target.closest('[data-act]');
  if (!el || el.disabled) return;
  // Checkboxes keep their native toggle; everything else is handled here.
  if (el.tagName === 'INPUT' && el.type === 'checkbox') return runAction(el);
  e.preventDefault();
  const now = Date.now();
  if (lastTap.el === el && now - lastTap.at < 700 && !REPEATABLE.has(el.dataset.act)) return;
  lastTap = { el, at: now };
  runAction(el);
});

$app.addEventListener('change', async (e) => {
  if (e.target.id !== 'import') return;
  const file = e.target.files[0];
  if (!file) return;
  try {
    const data = JSON.parse(await file.text());
    if (!data.plan || !Array.isArray(data.log)) throw new Error('not a backup file');
    Object.assign(S, { plan: data.plan, log: data.log, state: data.state ?? S.state });
    save(S);
    settingsMsg = t('backup_imported');
  } catch (err) {
    settingsMsg = t('backup_failed');
    logError(err, 'import');
  }
  render();
});

if (!native.isNative && 'serviceWorker' in navigator && location.protocol !== 'file:') {
  navigator.serviceWorker.register('./sw.js').catch(() => {});
}

applyTheme();
applyTextSize();
if (restoredFrom) toast = t('restored');
render();
if (cloud.cloudReady()) cloud.watchAuth(onUser).catch(() => ((authChecked = true), render()));
flushOutbox();
if (S.settings.welcomed) scheduleReminders();
if (S.settings.meter && !isCaregiver()) native.setMeterConfig({ deviceId: S.settings.meter.deviceId, lastSeq: S.settings.meter.lastSeq ?? -1 });
autoSyncMeter();
