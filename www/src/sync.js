// Live sync through Firebase Firestore (free Spark plan), for signed-in family members.
// The phone keeps working offline from localStorage; this mirrors data between the
// patient's phone and caregiver devices (phone or the web dashboard) in real time.
import { fb } from './cloud.js';

const HISTORY_DAYS = 60; // devices load the last 60 days; the patient's phone keeps everything locally

let F = null;
let root = null;
const unsubs = [];

export const status = { state: 'off', error: '' };

const clean = (o) => JSON.parse(JSON.stringify(o));
const failed = (e) => {
  status.state = 'error';
  status.error = e?.code === 'permission-denied' ? 'not_member' : e?.message ?? String(e);
};

export async function connect(familyId, handlers) {
  disconnect();
  status.state = 'connecting';
  try {
    const x = await fb();
    F = x.F;
    root = F.doc(x.db, 'families', familyId);
    const since = Date.now() - HISTORY_DAYS * 24 * 3600e3;
    const watch = (ref, fn) => unsubs.push(F.onSnapshot(ref, fn, failed));
    // fromCache: this phone's saved copy, not yet confirmed by the server. "Missing in the cloud"
    // is only trusted once the server has answered.
    watch(F.query(F.collection(root, 'records'), F.where('ts', '>=', since)), (snap) => handlers.records(snap.docs.map((d) => d.data()), snap.metadata.fromCache));
    watch(F.doc(root, 'meta', 'plan'), (s) => handlers.plan(s.exists() ? s.data() : null, s.metadata.fromCache));
    watch(F.doc(root, 'meta', 'state'), (s) => handlers.state(s.exists() ? s.data() : null, s.metadata.fromCache));
    watch(F.doc(root, 'meta', 'presence'), (s) => handlers.presence?.(s.exists() ? s.data() : null, s.metadata.fromCache));
    status.state = 'on';
    status.error = '';
  } catch (e) {
    failed(e);
    throw e;
  }
}

export function disconnect() {
  while (unsubs.length) unsubs.pop()();
  root = null;
  status.state = 'off';
}

export const connected = () => !!root;

// Resolves true once the cloud has it, false if refused (null when this phone is not in a family).
export function pushRecord(rec) {
  if (!root) return null;
  return F.setDoc(F.doc(root, 'records', rec.id), clean(rec)).then(
    () => true,
    (e) => ((status.error = e.message), false),
  );
}

export function pushMeta(name, data) {
  if (!root) return;
  F.setDoc(F.doc(root, 'meta', name), clean(data)).catch((e) => (status.error = e.message));
}
