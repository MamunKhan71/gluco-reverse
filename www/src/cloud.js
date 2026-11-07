// Firebase: one shared app/auth/firestore instance, login (email code or password),
// accounts and families. Live data sync lives in sync.js.
import { CLOUD } from './cloud-config.js';
import { newFamilyCode, cleanCode } from './familycode.js';

const SDK = '../vendor/firebase'; // bundled Firebase JS SDK 10.12.2
let inst = null;

export const cloudReady = () => !!CLOUD;

export async function fb() {
  if (inst) return inst;
  if (!CLOUD) throw new Error('no_cloud');
  const [appM, A, F] = await Promise.all([
    import(`${SDK}/firebase-app.js`),
    import(`${SDK}/firebase-auth.js`),
    import(`${SDK}/firebase-firestore.js`),
  ]);
  const app = appM.getApps()[0] ?? appM.initializeApp(CLOUD);
  const auth = A.initializeAuth(app, { persistence: [A.indexedDBLocalPersistence, A.browserLocalPersistence] });
  const db = F.initializeFirestore(app, { localCache: F.persistentLocalCache() });
  inst = { app, auth, db, A, F };
  return inst;
}

// --- login ----------------------------------------------------------------------------

export async function watchAuth(onChange) {
  const { auth, A } = await fb();
  A.onAuthStateChanged(auth, (u) => onChange(u ? { uid: u.uid, email: u.email } : null));
}

async function otp(body) {
  if (!CLOUD.otpUrl) throw new Error('no_otp_server');
  // text/plain keeps this a "simple" request (no CORS preflight) for Apps Script.
  const res = await fetch(CLOUD.otpUrl, { method: 'POST', headers: { 'Content-Type': 'text/plain;charset=utf-8' }, body: JSON.stringify(body) });
  const data = await res.json();
  if (data.error) throw new Error(data.error);
  return data;
}

export const normEmail = (e) => String(e || '').trim().toLowerCase();
export const validEmail = (e) => /^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(normEmail(e));

// purpose 'family': the email says it confirms a family member (no login), naming who added them.
export const sendCode = (email, lang, extra = {}) => otp({ action: 'send', email: normEmail(email), lang, ...extra });

export async function verifyCode(email, code) {
  const { token } = await otp({ action: 'verify', email: normEmail(email), code: String(code).replace(/\D/g, '') });
  const { auth, A } = await fb();
  await A.signInWithCustomToken(auth, token);
}

// Proves someone owns an email (family member added to the meter) without signing in as them.
export async function checkEmailCode(email, code) {
  await otp({ action: 'check', email: normEmail(email), code: String(code).replace(/\D/g, '') });
}

// Error codes come back as plain words the UI can translate.
const authError = (e) => new Error(String(e?.code || e?.message || 'error').replace('auth/', ''));

export async function passwordLogin(email, password) {
  const { auth, A } = await fb();
  try {
    await A.signInWithEmailAndPassword(auth, normEmail(email), password);
  } catch (e) {
    throw authError(e);
  }
}

export async function passwordSignup(email, password) {
  const { auth, A } = await fb();
  try {
    await A.createUserWithEmailAndPassword(auth, normEmail(email), password);
  } catch (e) {
    throw authError(e);
  }
}

// After a code login the user can add (or change) a password for next time.
export async function setPassword(password) {
  const { auth, A } = await fb();
  try {
    await A.updatePassword(auth.currentUser, password);
  } catch (e) {
    throw authError(e);
  }
}

// What the phone's background sync needs to sign in on its own (see SyncWorker.java).
export async function syncLogin() {
  const { auth } = await fb();
  const u = auth.currentUser;
  return u ? { refreshToken: u.refreshToken, apiKey: CLOUD.apiKey, projectId: CLOUD.projectId } : null;
}

export async function logout() {
  const { auth, A } = await fb();
  await A.signOut(auth);
}

// --- account & family --------------------------------------------------------------------

// Family codes (MANGO-RIVER-427): see familycode.js.
export { newFamilyCode, cleanCode, prettyCode } from './familycode.js';

// --- family members who share the meter --------------------------------------------------
// memberLinks/{email} tells a verified family member which family holds their readings, so they
// can see them on their own phone after logging in with that email (read-only, their own only).
// One link per family and email: id "<family>_<email>".
const linkId = (family, email) => `${family}_${normEmail(email)}`;

export async function setMemberLink(email, data) {
  const { db, F } = await fb();
  await F.setDoc(F.doc(db, 'memberLinks', linkId(data.family, email)), { ...data, email: normEmail(email), at: Date.now() });
}

export async function removeMemberLink(email, family) {
  const { db, F } = await fb();
  await F.deleteDoc(F.doc(db, 'memberLinks', linkId(family, email)));
}

// The newest family that gave this email readings (null if none).
export async function getMemberLink(email) {
  const { db, F } = await fb();
  const snap = await F.getDocs(F.query(F.collection(db, 'memberLinks'), F.where('email', '==', normEmail(email))));
  return snap.docs.map((d) => d.data()).sort((a, b) => (b.at ?? 0) - (a.at ?? 0))[0] ?? null;
}

// Live list of one family member's readings. Returns a stop function.
export async function watchMemberReadings(family, person, onData, onError) {
  const { db, F } = await fb();
  const q = F.query(F.collection(db, 'families', family, 'records'), F.where('person', '==', person));
  return F.onSnapshot(q, (snap) => onData(snap.docs.map((d) => d.data())), onError);
}

export async function getProfile(uid) {
  const { db, F } = await fb();
  const s = await F.getDoc(F.doc(db, 'users', uid));
  return s.exists() ? s.data() : null;
}

export async function saveProfile(uid, data) {
  const { db, F } = await fb();
  await F.setDoc(F.doc(db, 'users', uid), data, { merge: true });
}

// Patient: starts a family (or claims the code this phone already shares) as its patient.
export async function createFamily(user, code = newFamilyCode()) {
  const { db, F } = await fb();
  await F.setDoc(F.doc(db, 'families', code, 'members', user.uid), { role: 'patient', email: user.email ?? '', joinedAt: Date.now() });
  await saveProfile(user.uid, { email: user.email ?? '', role: 'patient', family: code });
  return code;
}

// Caregiver: joins an existing family with its secret code. Wrong code → 'not_found'.
export async function joinFamily(user, rawCode) {
  const code = cleanCode(rawCode);
  if (code.length < 9) throw new Error('not_found');
  const { db, F } = await fb();
  try {
    await F.setDoc(F.doc(db, 'families', code, 'members', user.uid), { role: 'caregiver', email: user.email ?? '', joinedAt: Date.now() });
  } catch (e) {
    throw new Error(e?.code === 'permission-denied' ? 'not_found' : 'network');
  }
  await saveProfile(user.uid, { email: user.email ?? '', role: 'caregiver', family: code });
  return code;
}

export async function listMembers(code) {
  const { db, F } = await fb();
  const snap = await F.getDocs(F.collection(db, 'families', code, 'members'));
  return snap.docs.map((d) => ({ uid: d.id, ...d.data() }));
}

export async function removeMember(code, uid) {
  const { db, F } = await fb();
  await F.deleteDoc(F.doc(db, 'families', code, 'members', uid));
}

// Shared family info (alert topic, patient name) so caregivers who type the code get it too.
export async function getShareInfo(code) {
  const { db, F } = await fb();
  const s = await F.getDoc(F.doc(db, 'families', code, 'meta', 'share'));
  return s.exists() ? s.data() : null;
}

// The patient's phone saves where it can be rung (Firebase push address) and its language.
export async function setPushDevice(code, data) {
  const { db, F } = await fb();
  await F.setDoc(F.doc(db, 'families', code, 'meta', 'push'), data);
}

// Every member's phone, so the family can be rung in an emergency.
export async function setMemberDevice(code, uid, data) {
  const { db, F } = await fb();
  await F.setDoc(F.doc(db, 'families', code, 'devices', uid), data);
}

// Patient's phone → emergency alarm on every family phone (server checks membership).
export async function crisisAlert(code, payload) {
  const { auth } = await fb();
  if (!auth.currentUser) throw new Error('login');
  const idToken = await auth.currentUser.getIdToken();
  return otp({ action: 'crisis', family: code, idToken, ...payload });
}

// Family member → alarm on the patient's phone. kind: beep | insulin | sugar | call | text.
export async function ringPatient(code, kind, text, from) {
  const { auth } = await fb();
  if (!auth.currentUser) throw new Error('login');
  const idToken = await auth.currentUser.getIdToken();
  return otp({ action: 'ring', family: code, kind, text, from, idToken });
}

export async function setShareInfo(code, data) {
  const { db, F } = await fb();
  await F.setDoc(F.doc(db, 'families', code, 'meta', 'share'), data, { merge: true });
}
