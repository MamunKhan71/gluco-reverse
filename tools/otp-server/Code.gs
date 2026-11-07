/**
 * সুগার সহায়ক: free email login-code server (Google Apps Script, runs in your Google account).
 *
 * 1. The app sends { action: 'send', email } → a 6-digit code is emailed from your Gmail.
 * 2. The app sends { action: 'verify', email, code } → if right, the Firebase account for
 *    that email is found (or created) and a Firebase sign-in token is returned.
 * Password login does not come here; the app uses Firebase Authentication for that.
 *
 * Setup (once): see tools/otp-server/README.md.
 */

const CODE_TTL = 600; // seconds a code stays valid
const MAX_SENDS_PER_HOUR = 5; // per email address
const MAX_TRIES = 5; // wrong guesses before the code is thrown away (kept across resends)
const MAX_MAILS_PER_DAY = 80; // all addresses together, so nobody can use up the Gmail quota

function doPost(e) {
  try {
    const req = JSON.parse((e && e.postData && e.postData.contents) || '{}');
    if (req.action === 'ring') return reply(ring(req));
    if (req.action === 'crisis') return reply(crisis(req));
    const email = String(req.email || '').trim().toLowerCase();
    if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) return reply({ error: 'bad_email' });
    if (req.action === 'send') return reply(sendCode(email, req.lang, req));
    if (req.action === 'verify') return reply(withLock(() => verifyCode(email, String(req.code || '').trim(), 'c:')));
    // Family member check: proves the email is theirs, never signs anyone in.
    if (req.action === 'check') return reply(withLock(() => verifyCode(email, String(req.code || '').trim(), 'f:')));
    return reply({ error: 'bad_action' });
  } catch (err) {
    console.error(err);
    return reply({ error: 'server' });
  }
}

// Wording of the code email: a login code, or (purpose 'family') a check that a family member
// added to someone's glucose meter really owns this email. Names are cleaned and kept short.
function mailText(bn, req) {
  const clean = (x) => String(x || '').slice(0, 40).replace(/[<>&"']/g, '');
  if (req.purpose === 'family') {
    const member = clean(req.member);
    const by = clean(req.by);
    return bn
      ? {
          subject: 'সুগার সহায়ক: পরিবারের সদস্য যাচাই কোড',
          intro: (by ? by + '-এর' : 'একজনের') + ' সুগার সহায়ক অ্যাপে আপনাকে' + (member ? ' "' + member + '" নামে' : '') + ' পরিবারের সদস্য হিসেবে যোগ করা হচ্ছে, যাতে একই গ্লুকোমিটারে মাপা আপনার রিডিং আলাদা থাকে। যিনি যোগ করছেন, তাঁকে নিচের কোডটি বলুন:',
          plain: 'পরিবারের সদস্য যাচাই কোড:',
          note: 'এটি লগইন কোড নয়, এতে কোনো অ্যাকাউন্ট খোলে না। কোডটি ১০ মিনিট কাজ করবে। এ বিষয়ে না জানলে কোডটি কাউকে দেবেন না।',
        }
      : {
          subject: 'Sugar Helper: family member check code',
          intro: 'You are being added' + (member ? ' as "' + member + '"' : '') + ' as a family member in ' + (by ? by + '’s' : 'someone’s') + ' Sugar Helper app, so your readings on the shared glucose meter are kept apart. Give this code to the person adding you:',
          plain: 'Family member check code:',
          note: 'This is not a login code and opens no account. It works for 10 minutes. If you know nothing about this, do not share the code.',
        };
  }
  return bn
    ? { subject: 'সুগার সহায়ক লগইন কোড', intro: 'সুগার সহায়কে লগইন করার কোড:', plain: 'আপনার লগইন কোড:', note: 'কোডটি ১০ মিনিট কাজ করবে। আপনি না চাইলে এই ইমেইল উপেক্ষা করুন।' }
    : { subject: 'Sugar Helper login code', intro: 'Your Sugar Helper login code:', plain: 'Your login code:', note: 'It works for 10 minutes. If you did not ask for it, ignore this email.' };
}

function doGet() {
  return reply({ ok: true, service: 'sugar-helper-otp' });
}

// One request at a time for code checks, so parallel guesses can't skip the try counter.
function withLock(fn) {
  const lock = LockService.getScriptLock();
  if (!lock.tryLock(10000)) return { error: 'busy' };
  try {
    return fn();
  } finally {
    lock.releaseLock();
  }
}

function sendCode(email, lang, req) {
  const cache = CacheService.getScriptCache();
  const sends = Number(cache.get('n:' + email) || 0);
  if (sends >= MAX_SENDS_PER_HOUR) return { error: 'too_many' };
  const props = PropertiesService.getScriptProperties();
  const day = Utilities.formatDate(new Date(), 'Asia/Dhaka', 'yyyy-MM-dd');
  const daily = JSON.parse(props.getProperty('mails') || '{}');
  if (daily.day !== day) (daily.day = day), (daily.n = 0);
  if (daily.n >= MAX_MAILS_PER_DAY) return { error: 'too_many' };
  daily.n++;
  props.setProperty('mails', JSON.stringify(daily));
  // A login code and a family-member check code are kept apart: only a login code signs in.
  const kind = req && req.purpose === 'family' ? 'f:' : 'c:';
  const code = String(100000 + secureInt(900000));
  const tries = Number(cache.get('t:' + kind + email) || 0); // wrong guesses survive a resend
  cache.put(kind + email, JSON.stringify({ hash: sha256(code + ':' + email), tries: tries }), CODE_TTL);
  cache.put('n:' + email, String(sends + 1), 3600);

  const bn = lang !== 'en';
  const T = mailText(bn, req || {});
  const subject = T.subject + ': ' + code;
  const note = T.note;
  const html =
    '<div style="font-family:Arial,sans-serif;font-size:16px;color:#1f2041;max-width:420px">' +
    '<p>' + T.intro + '</p>' +
    '<p style="font-size:36px;font-weight:bold;letter-spacing:8px;color:#5856d6;margin:12px 0">' + code + '</p>' +
    '<p style="color:#7d7f9b">' + note + '</p></div>';
  MailApp.sendEmail({
    to: email,
    subject: subject,
    body: T.plain + ' ' + code + '\n' + note,
    htmlBody: html,
    name: bn ? 'সুগার সহায়ক' : 'Sugar Helper',
  });
  return { ok: true };
}

function verifyCode(email, code, kind) {
  const cache = CacheService.getScriptCache();
  const raw = cache.get(kind + email);
  if (!raw) return { error: 'expired' };
  const v = JSON.parse(raw);
  if (v.tries >= MAX_TRIES) {
    cache.remove(kind + email);
    return { error: 'too_many' };
  }
  if (sha256(code + ':' + email) !== v.hash) {
    v.tries++;
    cache.put(kind + email, JSON.stringify(v), CODE_TTL);
    cache.put('t:' + kind + email, String(v.tries), 3600);
    return { error: 'wrong_code' };
  }
  cache.remove(kind + email);
  cache.remove('t:' + kind + email);
  if (kind === 'f:') return { ok: true };
  const sa = serviceAccount();
  const uid = findOrCreateUser(sa, email);
  return { token: customToken(sa, uid) };
}

// Random number from SHA-256 of a fresh UUID (Apps Script has no crypto.getRandomValues).
function secureInt(max) {
  const bytes = Utilities.computeDigest(Utilities.DigestAlgorithm.SHA_256, Utilities.getUuid() + ':' + Date.now());
  let n = 0;
  for (let i = 0; i < 6; i++) n = (n * 256 + (bytes[i] & 255)) % 1e12;
  return n % max;
}

function sha256(s) {
  return Utilities.base64Encode(Utilities.computeDigest(Utilities.DigestAlgorithm.SHA_256, s, Utilities.Charset.UTF_8));
}

function serviceAccount() {
  const raw = PropertiesService.getScriptProperties().getProperty('SERVICE_ACCOUNT');
  if (!raw) throw new Error('Script property SERVICE_ACCOUNT is missing (paste the Firebase service account JSON)');
  return JSON.parse(raw);
}

function b64url(data) {
  return Utilities.base64EncodeWebSafe(data).replace(/=+$/, '');
}

function signJwt(sa, claims) {
  const header = b64url(Utilities.newBlob(JSON.stringify({ alg: 'RS256', typ: 'JWT' })).getBytes());
  const body = b64url(Utilities.newBlob(JSON.stringify(claims)).getBytes());
  const sig = Utilities.computeRsaSha256Signature(header + '.' + body, sa.private_key);
  return header + '.' + body + '.' + b64url(sig);
}

function accessToken(sa) {
  const cache = CacheService.getScriptCache();
  const hit = cache.get('sa_token');
  if (hit) return hit;
  const now = Math.floor(Date.now() / 1000);
  const jwt = signJwt(sa, {
    iss: sa.client_email,
    scope: 'https://www.googleapis.com/auth/identitytoolkit https://www.googleapis.com/auth/cloud-platform',
    aud: 'https://oauth2.googleapis.com/token',
    iat: now,
    exp: now + 3600,
  });
  const res = UrlFetchApp.fetch('https://oauth2.googleapis.com/token', {
    method: 'post',
    payload: { grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer', assertion: jwt },
  });
  const token = JSON.parse(res.getContentText()).access_token;
  cache.put('sa_token', token, 3000);
  return token;
}

// One account per email: code login and password login reach the same Firebase user.
function findOrCreateUser(sa, email) {
  const base = 'https://identitytoolkit.googleapis.com/v1/projects/' + sa.project_id;
  const call = (path, payload) =>
    JSON.parse(
      UrlFetchApp.fetch(base + path, {
        method: 'post',
        contentType: 'application/json',
        payload: JSON.stringify(payload),
        headers: { Authorization: 'Bearer ' + accessToken(sa) },
        muteHttpExceptions: true,
      }).getContentText(),
    );
  const found = call('/accounts:lookup', { email: [email] });
  if (found.users && found.users.length) return found.users[0].localId;
  const made = call('/accounts', { email: email, emailVerified: true });
  if (!made.localId) throw new Error('Could not create the account: ' + JSON.stringify(made));
  return made.localId;
}

function customToken(sa, uid) {
  const now = Math.floor(Date.now() / 1000);
  return signJwt(sa, {
    iss: sa.client_email,
    sub: sa.client_email,
    aud: 'https://identitytoolkit.googleapis.com/google.identity.identitytoolkit.v1.IdentityToolkit',
    iat: now,
    exp: now + 3600,
    uid: uid,
  });
}

// --- ring the patient's phone ---------------------------------------------------------------
// A logged-in family member asks to sound an alarm on the patient's phone. We check they are a
// member of that family, then send a high-priority Firebase message to the phone saved in
// families/{code}/meta/push. The phone shows it as a full-screen alarm even if the app is closed.

const WEB_API_KEY = 'AIzaSyAZI2dIwoFFgGbRRbXYs6CueytZfK0Jbio'; // public web key of the Firebase project
const MAX_RINGS_PER_10_MIN = 30;

const RING_TEXT = {
  bn: {
    title: 'পরিবারের বার্তা',
    ok: 'ঠিক আছে',
    later: 'পরে',
    beep: 'পরিবার আপনাকে খুঁজছে। ফোনটি দেখুন।',
    insulin: 'ইনসুলিন এখনও নেওয়া হয়নি। নেওয়া হলে ফোনে জানিয়ে দিন।',
    sugar: 'এখন একবার সুগার মেপে দেখুন।',
    call: 'পরিবারকে একবার ফোন করুন।',
    eat: 'খাবারের সময় হয়েছে। খেয়ে নিন।',
  },
  en: {
    title: 'Message from family',
    ok: 'OK',
    later: 'Later',
    beep: 'Your family is trying to reach you. Please check the phone.',
    insulin: "You haven't taken your insulin yet. Please mark it in the app once it's done.",
    sugar: 'Please check your sugar now.',
    call: 'Please call your family.',
    eat: "It's time to eat. Please have your meal.",
  },
};
// recorded clips bundled in the app for the preset messages
const RING_CLIP = { insulin: 'dose_repeat', sugar: 'low_recheck', call: 'ring_call', eat: 'ring_eat', text: 'ring_message' };

function ring(req) {
  const family = String(req.family || '');
  if (!/^[A-Z0-9-]{9,40}$/.test(family)) return { error: 'not_found' };
  const uid = uidFromIdToken(String(req.idToken || ''));
  if (!uid) return { error: 'login' };

  const sa = serviceAccount();
  const token = accessToken(sa);
  const docs = 'https://firestore.googleapis.com/v1/projects/' + sa.project_id + '/databases/(default)/documents/families/' + family;
  const get = (path) => UrlFetchApp.fetch(docs + path, { headers: { Authorization: 'Bearer ' + token }, muteHttpExceptions: true });

  if (get('/members/' + uid).getResponseCode() !== 200) return { error: 'not_member' };
  const pushRes = get('/meta/push');
  if (pushRes.getResponseCode() !== 200) return { error: 'no_device' };
  const fields = JSON.parse(pushRes.getContentText()).fields || {};
  const device = fields.token && fields.token.stringValue;
  if (!device) return { error: 'no_device' };
  const lang = fields.lang && fields.lang.stringValue === 'en' ? 'en' : 'bn';

  if (req.kind === 'sync') {
    const sc = CacheService.getScriptCache();
    const ns = Number(sc.get('s:' + family) || 0);
    if (ns >= 60) return { error: 'too_many' };
    sc.put('s:' + family, String(ns + 1), 600);
    return sendPush(sa, token, device, { type: 'sync', ts: String(Date.now()) });
  }

  const cache = CacheService.getScriptCache();
  const n = Number(cache.get('r:' + family) || 0);
  if (n >= MAX_RINGS_PER_10_MIN) return { error: 'too_many' };
  cache.put('r:' + family, String(n + 1), 600);

  const T = RING_TEXT[lang];
  const kind = ['beep', 'insulin', 'sugar', 'call', 'eat', 'text'].indexOf(req.kind) >= 0 ? req.kind : 'beep';
  const text = kind === 'text' ? String(req.text || '').slice(0, 200).trim() : T[kind];
  if (!text) return { error: 'empty' };
  const clip = RING_CLIP[kind] ? (lang === 'en' ? 'en_' : '') + RING_CLIP[kind] : '';
  const from = String(req.from || '').slice(0, 40).trim();

  const res = UrlFetchApp.fetch('https://fcm.googleapis.com/v1/projects/' + sa.project_id + '/messages:send', {
    method: 'post',
    contentType: 'application/json',
    headers: { Authorization: 'Bearer ' + token },
    muteHttpExceptions: true,
    payload: JSON.stringify({
      message: {
        token: device,
        android: { priority: 'HIGH', ttl: '900s' },
        data: {
          type: 'ring',
          kind: kind === 'beep' ? 'beep' : 'voice',
          title: from ? T.title + ' · ' + from : T.title,
          body: text,
          clip: kind === 'text' ? '' : clip,
          fallbackClip: kind === 'text' ? clip : '',
          lang: lang,
          openLabel: T.ok,
          snoozeLabel: T.later,
          ts: String(Date.now()),
        },
      },
    }),
  });
  if (res.getResponseCode() !== 200) {
    const detail = res.getContentText();
    return { error: /UNREGISTERED|NOT_FOUND/.test(detail) ? 'no_device' : 'send_failed', detail: detail.slice(0, 300) };
  }
  return { ok: true };
}

// --- sugar emergency: ring every family phone -------------------------------------------------
// Sent by the patient's phone when a reading is dangerously low or high. Every other member's
// phone (families/{code}/devices) gets a full-screen alarm with steps and call buttons.
function crisis(req) {
  const family = String(req.family || '');
  if (!/^[A-Z0-9-]{9,40}$/.test(family)) return { error: 'not_found' };
  const uid = uidFromIdToken(String(req.idToken || ''));
  if (!uid) return { error: 'login' };
  const sa = serviceAccount();
  const token = accessToken(sa);
  const docs = 'https://firestore.googleapis.com/v1/projects/' + sa.project_id + '/databases/(default)/documents/families/' + family;
  const get = (path) => UrlFetchApp.fetch(docs + path, { headers: { Authorization: 'Bearer ' + token }, muteHttpExceptions: true });
  if (get('/members/' + uid).getResponseCode() !== 200) return { error: 'not_member' };

  const cache = CacheService.getScriptCache();
  const n = Number(cache.get('c:' + family) || 0);
  if (n >= 10) return { error: 'too_many' };
  cache.put('c:' + family, String(n + 1), 600);

  const level = req.level === 'high' ? 'high' : 'low';
  const texts = req.texts || {};
  const contacts = JSON.stringify((req.contacts || []).slice(0, 6).map((c) => ({ name: String(c.name || '').slice(0, 40), phone: String(c.phone || '').slice(0, 20) })));
  const res = get('/devices');
  const list = res.getResponseCode() === 200 ? JSON.parse(res.getContentText()).documents || [] : [];
  let sent = 0;
  list.forEach((doc) => {
    const f = doc.fields || {};
    const device = f.token && f.token.stringValue;
    const owner = f.uid && f.uid.stringValue;
    if (!device || owner === uid) return; // not back to the patient's own phone
    const lang = f.lang && f.lang.stringValue === 'en' ? 'en' : 'bn';
    const tx = texts[lang] || texts.bn || {};
    const T = RING_TEXT[lang];
    const r = sendPush(sa, token, device, {
      type: 'crisis',
      kind: 'voice',
      tone: level,
      lang: lang,
      title: String(tx.title || '').slice(0, 120),
      body: String(tx.body || '').slice(0, 200),
      steps: String(tx.steps || '').slice(0, 1500),
      contacts: contacts,
      clip: (lang === 'en' ? 'en_' : '') + 'crisis_' + level + '_fam',
      openLabel: lang === 'en' ? 'Open the app' : 'অ্যাপ খুলুন',
      snoozeLabel: T.later,
      ts: String(Date.now()),
    }, '1800s');
    if (r.ok) sent++;
  });
  return { ok: true, sent: sent };
}

// Silent data message (no alarm), e.g. "the plan changed, sync now".
function sendPush(sa, token, device, data, ttl) {
  const res = UrlFetchApp.fetch('https://fcm.googleapis.com/v1/projects/' + sa.project_id + '/messages:send', {
    method: 'post',
    contentType: 'application/json',
    headers: { Authorization: 'Bearer ' + token },
    muteHttpExceptions: true,
    payload: JSON.stringify({ message: { token: device, android: { priority: 'HIGH', ttl: ttl || '86400s' }, data: data } }),
  });
  return res.getResponseCode() === 200 ? { ok: true } : { error: 'send_failed', detail: res.getContentText().slice(0, 300) };
}

// Checks a Firebase ID token with Firebase itself and returns that user's uid ('' if not valid).
function uidFromIdToken(idToken) {
  if (!idToken) return '';
  const res = UrlFetchApp.fetch('https://identitytoolkit.googleapis.com/v1/accounts:lookup?key=' + WEB_API_KEY, {
    method: 'post',
    contentType: 'application/json',
    payload: JSON.stringify({ idToken: idToken }),
    muteHttpExceptions: true,
  });
  if (res.getResponseCode() !== 200) return '';
  const users = JSON.parse(res.getContentText()).users || [];
  return users.length ? users[0].localId : '';
}

function reply(obj) {
  return ContentService.createTextOutput(JSON.stringify(obj)).setMimeType(ContentService.MimeType.JSON);
}
