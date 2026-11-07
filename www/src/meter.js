// Bluetooth glucose meter (CONTOUR PLUS ELITE and other meters using the standard
// Bluetooth Glucose Profile). Decoding is pure and unit-tested; the BLE calls go
// through the @capacitor-community/bluetooth-le native plugin (hex strings in/out).

const uuid = (n) => `0000${n.toString(16).padStart(4, '0')}-0000-1000-8000-00805f9b34fb`;
export const GLS = uuid(0x1808);
const MEASUREMENT = uuid(0x2a18);
const CONTEXT = uuid(0x2a34);
const RACP = uuid(0x2a52);

// --- decoding ----------------------------------------------------------------------

export const hexToBytes = (hex) => (hex.replace(/[^0-9a-f]/gi, '').match(/../g) ?? []).map((h) => parseInt(h, 16));
export const bytesToHex = (bytes) => bytes.map((b) => b.toString(16).padStart(2, '0')).join('');

// IEEE-11073 16-bit SFLOAT: 4-bit signed exponent, 12-bit signed mantissa.
export function sfloat(lo, hi) {
  const raw = lo | (hi << 8);
  let mantissa = raw & 0x0fff;
  let exponent = raw >> 12;
  if (mantissa === 0x07ff || mantissa === 0x0800 || mantissa === 0x07fe) return NaN; // NaN / NRes / +INF
  if (mantissa >= 0x0800) mantissa -= 0x1000;
  if (exponent >= 0x08) exponent -= 0x10;
  return mantissa * 10 ** exponent;
}

// Glucose Measurement characteristic (0x2A18) → { seq, ts, mmol, hasContext }.
// Meter time is local time; ts is milliseconds since epoch on this phone.
export function parseMeasurement(bytes) {
  const flags = bytes[0];
  let i = 1;
  const seq = bytes[i] | (bytes[i + 1] << 8);
  i += 2;
  const year = bytes[i] | (bytes[i + 1] << 8);
  const [month, day, h, m, s] = bytes.slice(i + 2, i + 7);
  i += 7;
  let offset = 0;
  if (flags & 0x01) {
    offset = (bytes[i] | (bytes[i + 1] << 8)) << 16 >> 16; // signed minutes
    i += 2;
  }
  let mmol = null;
  if (flags & 0x02) {
    const v = sfloat(bytes[i], bytes[i + 1]);
    // bit 2: 0 = kg/L (→ mg/dL × 100000), 1 = mol/L (→ mmol/L × 1000)
    mmol = flags & 0x04 ? v * 1000 : (v * 100000) / 18.0156;
    mmol = Math.round(mmol * 10) / 10;
  }
  const ts = new Date(year, month - 1, day, h, m, s).getTime() + offset * 60000;
  return { seq, ts, mmol, hasContext: !!(flags & 0x10) };
}

// Glucose Measurement Context (0x2A34) → { seq, meal } where meal is
// 1 before meal, 2 after meal, 3 fasting, 4 casual, 5 bedtime (or null).
export function parseContext(bytes) {
  const flags = bytes[0];
  let i = 3;
  if (flags & 0x80) i += 1; // extended flags
  if (flags & 0x01) i += 3; // carbohydrate id + value
  const meal = flags & 0x02 ? bytes[i] : null;
  return { seq: bytes[1] | (bytes[2] << 8), meal };
}

// Record Access Control Point request: all records, or records with seq >= from.
export function racpRequest(fromSeq) {
  return fromSeq == null ? [0x01, 0x01] : [0x01, 0x03, 0x01, fromSeq & 0xff, (fromSeq >> 8) & 0xff];
}

// RACP response → 'done' | 'none' | 'error' | null (not a final response).
export function racpResult(bytes) {
  if (bytes[0] !== 0x06) return null;
  return bytes[3] === 0x01 ? 'done' : bytes[3] === 0x06 ? 'none' : 'error';
}

// --- Bluetooth --------------------------------------------------------------------

const ble = () => window.Capacitor?.Plugins?.BluetoothLe;
export const meterSupported = () => !!ble() && !!window.Capacitor?.isNativePlatform?.();

const withTimeout = (p, ms, msg) =>
  Promise.race([p, new Promise((_, reject) => setTimeout(() => reject(new Error(msg)), ms))]);

// ask = show Android's "turn on Bluetooth?" dialog when it is off (only for things the
// person tapped; quiet background syncs never pop up a dialog).
async function init(ask = true) {
  await ble().initialize({ androidNeverForLocation: true });
  let { value } = await ble().isEnabled();
  if (!value && ask) {
    try {
      await ble().requestEnable();
    } catch {
      // "Don't allow": handled below
    }
    ({ value } = await ble().isEnabled());
  }
  if (!value) throw new Error('bluetooth_off');
}

// CONTOUR meters show up as e.g. "contour75949449" (any case) and don't advertise the glucose
// service until they are paired, so we look by name as well as by service.
export const LIKELY_METER = /contour|ascensia|bayer|glucose|accu-?chek|onetouch|caresens|meter/i;

// Nearby meters, reported one by one through onFound({ deviceId, name, rssi, bonded }).
// all = show every named Bluetooth device. Returns a function that stops the scan.
export async function scanMeters(onFound, { all = false, ms = 20000, onHeard = () => {} } = {}) {
  await init();
  const seen = new Set();
  const add = (dev) => {
    if (!dev.deviceId || seen.has(dev.deviceId)) return;
    seen.add(dev.deviceId);
    onFound(dev);
  };
  // already paired in the phone's Bluetooth settings
  try {
    const { devices } = await ble().getBondedDevices();
    for (const d of devices ?? []) if (all ? d.name : LIKELY_METER.test(d.name ?? '')) add({ deviceId: d.deviceId, name: d.name, bonded: true });
  } catch {
    // not available on this phone: the scan below still finds it
  }
  // The plugin reports each device through the "onScanResult" event (not a callback).
  // Repeats are allowed: a device's first broadcast often has no name yet, the next one does.
  const heard = new Set();
  const listener = await ble().addListener('onScanResult', (r) => {
    if (r.device?.deviceId && !heard.has(r.device.deviceId)) {
      heard.add(r.device.deviceId);
      onHeard(heard.size);
    }
    const name = r.device?.name || r.localName || '';
    const glucose = (r.uuids ?? []).some((u) => /^0000?1808/i.test(u) || /1808-0000-1000/i.test(u));
    if (all || LIKELY_METER.test(name) || glucose) add({ deviceId: r.device.deviceId, name: name || (glucose ? 'Glucose meter' : r.device.deviceId), rssi: r.rssi });
  });
  // fastest scan mode while pairing (the meter only advertises for a short time)
  await ble().requestLEScan({ allowDuplicates: true, scanMode: 2 });
  let stopped = false;
  const stop = () => {
    if (stopped) return;
    stopped = true;
    listener?.remove?.();
    ble().stopLEScan().catch(() => {});
  };
  setTimeout(stop, ms);
  return stop;
}

// Pair with the meter that was tapped: Android asks for the PIN shown on the meter's screen.
export async function pairWith(deviceId, name) {
  await init();
  await ble().connect({ deviceId, timeout: 15000 });
  try {
    const { value } = await ble().isBonded({ deviceId });
    if (!value) await ble().createBond({ deviceId, timeout: 60000 });
  } finally {
    await ble().disconnect({ deviceId }).catch(() => {});
  }
  return { deviceId, name: name || 'CONTOUR' };
}

// Older flow (Android's own device picker, by glucose service): kept as a fallback.
export async function pairMeter() {
  await init();
  const device = await ble().requestDevice({ services: [GLS] });
  await ble().connect({ deviceId: device.deviceId, timeout: 15000 });
  try {
    const { value } = await ble().isBonded({ deviceId: device.deviceId });
    if (!value) await ble().createBond({ deviceId: device.deviceId, timeout: 60000 });
  } finally {
    await ble().disconnect({ deviceId: device.deviceId }).catch(() => {});
  }
  return { deviceId: device.deviceId, name: device.name || 'CONTOUR' };
}

// Reads stored readings newer than lastSeq. Returns [{ seq, ts, mmol, meal }].
export async function readMeter(deviceId, lastSeq, timeoutMs = 25000, ask = true) {
  await init(ask);
  const P = ble();
  const listeners = [];
  const records = new Map();
  const contexts = new Map();
  let finish;
  const done = new Promise((resolve, reject) => {
    finish = (r) => (r === 'error' ? reject(new Error('meter_error')) : resolve(r));
  });
  const listen = async (ch, fn) => {
    listeners.push(await P.addListener(`notification|${deviceId}|${GLS}|${ch}`, (e) => fn(hexToBytes(e?.value ?? ''))));
    await P.startNotifications({ deviceId, service: GLS, characteristic: ch });
  };
  try {
    await withTimeout(P.connect({ deviceId, timeout: 12000 }), 15000, 'connect_timeout');
    await listen(MEASUREMENT, (b) => {
      const r = parseMeasurement(b);
      if (r.mmol != null && r.mmol > 0) records.set(r.seq, r);
    });
    await listen(CONTEXT, (b) => {
      const c = parseContext(b);
      contexts.set(c.seq, c.meal);
    }).catch(() => {}); // context is optional
    await listen(RACP, (b) => {
      const r = racpResult(b);
      if (r) finish(r);
    });
    const from = lastSeq == null ? null : lastSeq + 1;
    await P.write({ deviceId, service: GLS, characteristic: RACP, value: bytesToHex(racpRequest(from)) });
    await withTimeout(done, timeoutMs, 'read_timeout');
  } finally {
    for (const l of listeners) await l.remove().catch(() => {});
    await P.disconnect({ deviceId }).catch(() => {});
  }
  return [...records.values()].map((r) => ({ ...r, meal: contexts.get(r.seq) ?? null })).sort((a, b) => a.seq - b.seq);
}
