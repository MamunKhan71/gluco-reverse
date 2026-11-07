// Thin wrapper over Capacitor plugins. Everything is a no-op in a normal browser,
// so the same code runs as a website and as the Android app.
const Cap = window.Capacitor;
export const isNative = !!Cap?.isNativePlatform?.();
const plugins = () => Cap?.Plugins ?? {};

export function haptic(style = 'LIGHT') {
  if (isNative) plugins().Haptics?.impact({ style }).catch(() => {});
}

export function setStatusBar(dark) {
  if (!isNative) return;
  const sb = plugins().StatusBar;
  // Style "DARK" = light icons for a dark background.
  sb?.setStyle({ style: dark ? 'DARK' : 'LIGHT' }).catch(() => {});
  sb?.setBackgroundColor({ color: dark ? '#100E1F' : '#F4F5FB' }).catch(() => {});
}

async function notifications() {
  const LN = plugins().LocalNotifications;
  if (!LN) return null;
  let perm = await LN.checkPermissions();
  if (perm.display !== 'granted') perm = await LN.requestPermissions();
  if (perm.display !== 'granted') return null;
  await LN.createChannel({ id: 'doses', name: 'Dose reminders', importance: 5, vibration: true, visibility: 1 }).catch(() => {});
  return LN;
}

// items: [{ id, hour, minute, title, body }] — repeats every day.
export async function scheduleDaily(items) {
  if (!isNative) return false;
  const LN = await notifications();
  if (!LN) return false;
  const ids = items.map((i) => ({ id: i.id }));
  await LN.cancel({ notifications: [...ids, ...[1, 2, 3, 4, 5, 6].map((id) => ({ id }))] }).catch(() => {});
  await LN.schedule({
    notifications: items.map((i) => ({
      id: i.id,
      title: i.title,
      body: i.body,
      channelId: 'doses',
      schedule: { on: { hour: i.hour, minute: i.minute }, allowWhileIdle: true },
    })),
  });
  return true;
}

export async function cancelDaily() {
  const LN = plugins().LocalNotifications;
  const ids = [1, 2, 3, 4, 5, 6, 300, 301, 302, 303, 304, 305, 306];
  await LN?.cancel({ notifications: ids.map((id) => ({ id })) }).catch(() => {});
}

export async function scheduleOnce(id, at, title, body) {
  if (!isNative) return;
  const LN = await notifications();
  await LN?.schedule({ notifications: [{ id, title, body, channelId: 'doses', schedule: { at: new Date(at), allowWhileIdle: true } }] });
}

export function cancelOnce(id) {
  plugins().LocalNotifications?.cancel({ notifications: [{ id }] }).catch(() => {});
}

// --- Full-screen alarms (custom native plugin, see android/.../AlarmPlugin.java) ---

const alarm = () => (isNative ? plugins().Alarm : null);

// items: [{ id, hour, minute, title, body, route, openLabel, snoozeLabel }] — rings daily,
// repeats every `repeatMinutes` (max `maxRepeats`) until confirmAlarm(id).
export async function setDailyAlarms(items, opts) {
  await notifications(); // asks for the notification permission once
  return alarm()?.setDaily({ items, ...opts });
}

export const alarmOnce = (item) => alarm()?.once(item);
// at = when the dose was taken (so it can't silence tomorrow's alarm)
export const confirmAlarm = (id, at) => alarm()?.confirm(at ? { id, at } : { id }).catch(() => {});
// Doctor report: print screen (Save as PDF), and saving/sharing a file (Excel).
export const printHtml = (html, name) => alarm()?.printHtml({ html, name });
export const shareFile = (name, mime, base64) => alarm()?.shareFile({ name, mime, base64 });
// The phone watches for the paired meter and reads it by itself (MeterWatch / MeterReader).
export const setMeterConfig = (o) => alarm()?.setMeterConfig(o).catch(() => {});
export const meterPending = () => alarm()?.meterPending().catch(() => null) ?? Promise.resolve(null);
// Background sync while the app is closed (SyncWorker). Empty object = stop.
export const setSyncAuth = (o) => alarm()?.setSyncAuth(o).catch(() => {});
export const queueRecord = (rec) => alarm()?.queueRecord({ rec }).catch(() => {});
export const cancelAlarm = (id) => alarm()?.cancel({ id }).catch(() => {});
export const alarmStatus = () => alarm()?.status() ?? Promise.resolve(null);
export const openAlarmSettings = (kind) => alarm()?.openSettings({ kind });

export const guard = (opts) => alarm()?.guard(opts).catch(() => {});
export const backupSave = (data) => alarm()?.backupSave({ data }).catch(() => {});
export const backupLoad = () => alarm()?.backupLoad().catch(() => null) ?? Promise.resolve(null);

export const voiceStatus = () => alarm()?.voiceStatus().catch(() => null) ?? Promise.resolve(null);
// This phone's Firebase push address (so family can ring it); '' when not available.
export const pushToken = () => alarm()?.pushToken().then((r) => r?.token ?? '').catch(() => '') ?? Promise.resolve('');
// Recorded voice clip from the app (res/raw). Resolves { ok }.
export const playClip = (name) => alarm()?.playClip({ name }).catch(() => ({ ok: false })) ?? Promise.resolve({ ok: false });
export const voiceInstall = () => alarm()?.voiceInstall().catch(() => {});

// Resolves { ok, reason } — reason is missing_data / not_supported / no_engine when Bangla can't be spoken.
export function speak(text) {
  if (isNative) return alarm()?.speak({ text }).catch(() => ({ ok: false, reason: 'no_engine' }));
  if (!('speechSynthesis' in window)) return Promise.resolve({ ok: false, reason: 'no_engine' });
  const bangla = /[ঀ-৿]/.test(text);
  const voice = speechSynthesis.getVoices().find((v) => v.lang.toLowerCase().startsWith(bangla ? 'bn' : 'en'));
  if (bangla && !voice) return Promise.resolve({ ok: false, reason: 'not_supported' });
  const u = new SpeechSynthesisUtterance(text);
  u.lang = bangla ? 'bn-BD' : 'en-US';
  if (voice) u.voice = voice;
  u.rate = 0.9;
  speechSynthesis.cancel();
  speechSynthesis.speak(u);
  return Promise.resolve({ ok: true });
}

// Route the app should open when started from an alarm ("dose/lunch").
export async function launchRoute(handler) {
  if (!isNative) return;
  alarm()?.addListener('route', (e) => e.route && handler(e.route));
  const r = await alarm()?.getLaunchRoute();
  if (r?.route) handler(r.route);
}

export function onBackButton(handler) {
  if (isNative) plugins().App?.addListener('backButton', handler);
}

// Is the app on screen? In the Android app the page's own visibility can be wrong, so ask Android.
let appActive = true;
export const appOnScreen = () => (isNative ? appActive : document.visibilityState === 'visible');
export function onAppState(handler) {
  if (isNative) {
    plugins().App?.addListener('appStateChange', ({ isActive }) => {
      appActive = isActive;
      handler(isActive);
    });
  } else {
    document.addEventListener('visibilitychange', () => handler(document.visibilityState === 'visible'));
  }
}

export function exitApp() {
  plugins().App?.exitApp();
}
