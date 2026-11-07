# সুগার সহায়ক — Sugar Helper

A Bangla-first phone app that helps a person on insulin follow their doctor's plan:
dose reminders, dose suggestions limited to ±2 units, low/high sugar emergency steps,
a food log, weight tracking, and a printable report for the doctor.

**The app never decides a dose by itself.** It applies the doctor's prescription and
rules, and anything outside them goes to the doctor.

## What is set up now (mother, prescription 03.09.2026)

| Time | Medicine | Dose | App may suggest |
|---|---|---|---|
| 07:30, before breakfast | Actrapid | 16 | 14–18 |
| 13:00, before lunch | Actrapid + Lino 5 mg | 16 + 1 tab | 14–18 |
| 20:00, before dinner | Actrapid | 12 | 10–14 |
| 22:00, night | Lantus | 20 | 18–22 |

All times, doses and rules can be changed in **Settings** (PIN-protected).

### Rules the app follows

- **Actrapid (each meal):** reading before the meal plus meal size → doctor's dose ±2.
  - **Not eating means no Actrapid.**
  - A missed meal dose is never offered late.
- **Lantus (night):** adjusted only every 3 days, from the average fasting reading.
  - A low comes first: any low means −2.
  - High mornings need a 3 am check before any increase.
- **More than ±2 needed:** the app gives the limit dose and says *see the doctor*.

### Alert levels

| Level | Means | Triggered by |
|---|---|---|
| 🔴 Hospital now | Emergency | Unconscious/can't swallow, low not recovering after 2 rounds of sugar, sugar >16.7 with vomiting/confusion/breathing trouble |
| 🟠 Call doctor today | Same-day call | Reading <3.0, any night low, 2+ lows in a week, two readings >16.7 in a row |
| 🟡 Doctor visit | Plan needs review | A change beyond ±2 needed, the same meal adjusted 3+ days in a week, Lantus at its limit, weight down 3 kg |

> ⚠️ **The correction scale, small-meal rule and targets are safe defaults, not the doctor's.**
> Take the **Doctor report** (detail mode → 📄) to the next visit. Ask the doctor to confirm or
> change the rules, enter them in Settings, and tick "Doctor has confirmed these rules".

## Android app

To build it, run:

```bash
./build-apk.sh
```

This produces `sugar-helper.apk` in the project folder. Java 21 and the Android SDK live in
`%LOCALAPPDATA%\Java` and `%LOCALAPPDATA%\Android\Sdk`.

To install it on a phone:
1. Copy the APK to the phone (USB, Google Drive or WhatsApp to yourself) and open it.
2. Allow **"Install unknown apps"** for that file app when Android asks.
3. On first open, allow **notifications**, so dose reminders ring at 07:30, 13:00, 17:00, 20:00 and 22:00.

### Making sure the dose alarms ring

Dose alarms show full screen over the lock screen and play the phone's **alarm** sound (alarm volume, not ringtone volume). They speak in Bangla if the phone has a Bangla voice. They ring again every 10 minutes, up to 6 times, until the dose is logged in the app.

After installing, open **আরও → অ্যালার্ম** and:
1. Turn on anything marked ⚠ with **চালু করুন**: notifications, full-screen alarm, exact time, battery saver.
2. On **Xiaomi, Oppo, Realme or Vivo** phones, also open Settings → Apps → সুগার সহায়ক and turn on **Autostart**.
3. Tap **টেস্ট অ্যালার্ম**, lock the phone, and check that it rings within 10 seconds.
4. Keep the phone's **alarm volume** up.

### Family sharing (live)

The cloud is built in: Firebase project `gluco-reverse`, with the database in Mumbai. The live dashboard is at https://gluco-reverse.web.app.

1. **Her phone:** আরও → **পরিবারকে দেখান** → **শেয়ার চালু করুন**. A QR code and link appear.
2. **Family:** scan the QR code with a phone camera (or open the WhatsApp link). It opens the live dashboard in any browser. Tap **হ্যাঁ** once.
3. **Missed-dose alerts:** install the free **ntfy** app and subscribe to the topic shown on her share screen. You get a push if a dose is still not logged after about 30 minutes of alarms, and for low sugar.

Each family's data sits under a 28-character secret code. Only devices with the link can read or write it (see `firestore.rules`).

To redeploy after changing the web app or rules:

```bash
npx firebase-tools@13.29.1 deploy --only hosting,firestore:rules
```

### Glucose meter (CONTOUR PLUS ELITE, Bluetooth)

The app reads the meter directly over Bluetooth, using the standard Bluetooth Glucose Profile. Readings arrive with the meter's own time and before/after-meal marker.

To pair (once), go to আরও → গ্লুকোমিটার:
1. Turn on the phone's Bluetooth.
2. Hold the meter's OK button until the Bluetooth symbol flashes.
3. Tap **মিটার খুঁজুন** and pick the meter.
4. Type the PIN shown on the meter.

After that:
- **When the app opens**, it fetches new readings from the meter by itself.
- **In a dose**, tap **মিটার থেকে নিন** to use the reading from the last 15 minutes instead of typing it.
- **A fresh low reading** from the meter opens the low-sugar steps straight away.
- **Keep the meter's date and time correct.**
- **If the official CONTOUR DIABETES app** is also on the phone and causes problems, turn it off.

### Background and data safety

- **Always on.** A small permanent notification ("সুগার সহায়ক চালু আছে · পরের: …") keeps the app protected from phone-cleaner and battery tools. It re-arms the alarms whenever it starts: after a restart, after an update, and whenever an alarm fires. You can turn it off in আরও → অ্যালার্ম.
- **Backup.** Every change is saved to `Download/SugarHelper/sugar-helper-backup.json` as well as inside the app. If the app's data is cleared, opening the app restores everything automatically. On Android 9 and older, use Settings → Backup → Export.
- **Android's one limit.** After **Force stop** or **Clear data**, Android blocks *every* app's alarms until it is opened again. Open the app once afterwards: it restores the data and re-arms all alarms by itself.

Each new build installs over the old one and keeps the data. This only works when it's built on this same PC, because the debug signing key lives here.

## Try it on this computer

```bash
npm start
```

Then open http://localhost:5173. Run the rule tests with `npm test`.

## Put it on the phones (free, about 30 minutes, one time)

### 1. Create a Firebase project

1. Go to https://console.firebase.google.com → **Add project** (no Analytics needed).
2. **Build → Firestore Database → Create database**. Production mode, region `asia-south1` (Mumbai).
3. **Build → Authentication → Get started → Sign-in method → Anonymous → Enable.**
4. **Project settings → Your apps → Web (</>)**, register the app, and copy the `firebaseConfig` snippet.

### 2. Publish the app (Firebase Hosting)

```bash
npm install -g firebase-tools
```

```bash
firebase login
```

```bash
firebase use --add
```

```bash
firebase deploy
```

This publishes the app and the security rules in `firestore.rules`. You get a link like
`https://your-project.web.app`.

### 3. Mother's phone

1. Open the link in Chrome → menu ⋮ → **Add to Home screen** (installs it like an app).
2. Open **⚙️ Settings**. Set a PIN and enter the doctor's and your phone numbers.
3. **This phone is: Patient's phone.**
4. **Cloud sync:**
   - Paste the `firebaseConfig` snippet.
   - Tap **New family code**, then **Connect**.
   - Tap **Copy link** and send it to yourself privately.
5. **Alerts:**
   - Tap **New topic**, then **Save topic**.
6. Switch to **সহজ (simple)** mode for her.

### 4. Your phone

1. Install the free **ntfy** app (Play Store) → **+** → subscribe to the same topic. Alerts now arrive as notifications.
2. Tap **Send test** on her phone to check that alerts arrive.
3. Open the setup link from step 3 on your phone → **Yes**. You now see her data live and can
   edit the plan after doctor visits.

### 5. Reminders

Web apps cannot reliably ring at a set time on Android. Set **Android Clock alarms** on her
phone at 07:30, 13:00, 17:00, 20:00 and 22:00 labelled "সুগার সহায়ক". When an alarm rings, she
opens the app.

## Privacy

- **Readings live on her phone.** With sync on, they are also stored in **your own** Firebase project.
  - Access needs the 28-character family code, so treat the setup link like a password.
- **Alert texts pass through ntfy.sh** (a public service).
  - They contain only the name shown in Settings and the alert sentence.
  - The topic name is random; keep it private.

## Not yet done

- Father's profile (needs his prescription: Emjard M + Humulin 30/70?)
- Native Android wrapper for real alarm reminders
- Doctor-confirmed rules: currently defaults

## Files

- `src/engine.js`: all dose and alert rules (tested in `tests/engine.test.js`)
- `src/plan.js`: the prescription and default rules
- `src/app.js`: screens
- `src/i18n.js`: Bangla and English text
- `src/sync.js`: Firebase sync
- `src/notify.js`: ntfy alerts
- `sw.js` + `manifest.webmanifest`: offline use and install

## Login and family access

- Log in with an email code (sent from Gmail by a free Google Apps Script, see
  [tools/otp-server/README.md](tools/otp-server/README.md)) or with a password (Firebase
  Authentication). A new email gets an account automatically.
- The patient's phone creates the family. Its secret code (XXXX-XXXX-XXXX) is under
  More → Account and More → Share with family.
- A family member logs in first, picks "I am family", then types that code. Only logged-in
  members can read a family's data (`firestore.rules`).

## Bangla voice

Alarms → Bangla voice shows whether the phone can speak Bangla. If not, tap Install (it opens
Google's speech engine or its voice download), then Test.
