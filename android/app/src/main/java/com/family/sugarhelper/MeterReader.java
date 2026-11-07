package com.family.sugarhelper;

import android.Manifest;
import android.bluetooth.BluetoothAdapter;
import android.bluetooth.BluetoothDevice;
import android.bluetooth.BluetoothGatt;
import android.bluetooth.BluetoothGattCallback;
import android.bluetooth.BluetoothGattCharacteristic;
import android.bluetooth.BluetoothGattDescriptor;
import android.bluetooth.BluetoothGattService;
import android.bluetooth.BluetoothManager;
import android.bluetooth.BluetoothProfile;
import android.content.Context;
import android.content.Intent;
import android.content.SharedPreferences;
import android.content.pm.PackageManager;
import android.os.Build;

import androidx.annotation.NonNull;

import org.json.JSONArray;
import org.json.JSONObject;

import java.util.ArrayDeque;
import java.util.Calendar;
import java.util.Deque;
import java.util.HashMap;
import java.util.Map;
import java.util.UUID;
import java.util.concurrent.CountDownLatch;
import java.util.concurrent.TimeUnit;

/**
 * Reads new results from the paired meter (Bluetooth Glucose Profile, as in www/src/meter.js):
 * notifications on, then "records from sequence N" through the Record Access Control Point.
 * New results are kept for the app (meterPending), uploaded to the family (SyncWorker), and a
 * dangerously low or high fresh result rings the full-screen emergency alarm.
 */
final class MeterReader {
    private static final UUID GLS = uuid(0x1808);
    private static final UUID MEASUREMENT = uuid(0x2a18);
    private static final UUID CONTEXT = uuid(0x2a34);
    private static final UUID RACP = uuid(0x2a52);
    private static final UUID CCCD = uuid(0x2902);
    private static final int CRISIS_ID = 130;
    private static volatile boolean busy;
    static volatile boolean waiting; // a standing connection request is open (MeterLink)

    private MeterReader() {}

    private static final String NOTE_CHANNEL = "meter_note_v1";
    private static final int NOTE_ID = 7400;

    // "Meter connected…", then "3 new readings" / "No new readings" (texts from the app, in its language).
    static void note(Context c, String key, int n) {
        try {
            org.json.JSONObject tx = new org.json.JSONObject(AlarmScheduler.prefs(c).getString("meter_texts", "{}"));
            String title = tx.optString("title", "CONTOUR");
            String text = tx.optString(key, "").replace("{n}", String.valueOf(n));
            if (text.isEmpty()) return;
            android.app.NotificationManager nm = (android.app.NotificationManager) c.getSystemService(Context.NOTIFICATION_SERVICE);
            if (Build.VERSION.SDK_INT >= 26 && nm.getNotificationChannel(NOTE_CHANNEL) == null) {
                android.app.NotificationChannel ch = new android.app.NotificationChannel(NOTE_CHANNEL, "Meter", android.app.NotificationManager.IMPORTANCE_DEFAULT);
                ch.setDescription("Meter connected and readings received");
                ch.setSound(null, null);
                nm.createNotificationChannel(ch);
            }
            Intent open = new Intent(c, MainActivity.class).putExtra("route", "home").addFlags(Intent.FLAG_ACTIVITY_NEW_TASK | Intent.FLAG_ACTIVITY_SINGLE_TOP);
            android.app.PendingIntent pi = android.app.PendingIntent.getActivity(c, NOTE_ID, open, android.app.PendingIntent.FLAG_IMMUTABLE | android.app.PendingIntent.FLAG_UPDATE_CURRENT);
            androidx.core.app.NotificationCompat.Builder b = new androidx.core.app.NotificationCompat.Builder(c, NOTE_CHANNEL)
                    .setSmallIcon(R.drawable.ic_stat_drop)
                    .setColor(0xFF4F86E8)
                    .setContentTitle(title)
                    .setContentText(text)
                    .setContentIntent(pi)
                    .setAutoCancel(true)
                    .setOnlyAlertOnce(true)
                    .setTimeoutAfter("connected".equals(key) ? 60_000 : 20 * 60_000);
            if ("connected".equals(key)) b.setProgress(0, 0, true);
            nm.notify(NOTE_ID, b.build());
        } catch (Exception ignored) {
            // no texts saved yet
        }
    }

    private static UUID uuid(int n) {
        return UUID.fromString(String.format("%08x-0000-1000-8000-00805f9b34fb", n));
    }

    /** Quick read while the meter is known to be awake (MeterWatch). */
    static void read(Context c) {
        read(c, false, 35_000L);
    }

    /**
     * autoConnect = a standing request: Android connects by itself the moment the paired meter
     * calls back after a test (also the meter's direct reconnect signal, which a scan never
     * sees), then we read. Returns true if results were read.
     */
    static boolean read(Context c, boolean autoConnect, long waitMs) {
        if (busy) return false;
        busy = true;
        waiting = autoConnect;
        try {
            SharedPreferences p = AlarmScheduler.prefs(c);
            String id = p.getString("meter_id", "");
            if (id.isEmpty()) return false;
            if (Build.VERSION.SDK_INT >= 31 && c.checkSelfPermission(Manifest.permission.BLUETOOTH_CONNECT) != PackageManager.PERMISSION_GRANTED) return false;
            BluetoothManager bm = (BluetoothManager) c.getSystemService(Context.BLUETOOTH_SERVICE);
            BluetoothAdapter adapter = bm == null ? null : bm.getAdapter();
            if (adapter == null || !adapter.isEnabled()) return false;
            BluetoothDevice dev = adapter.getRemoteDevice(id);
            long lastSeq = p.getLong("meter_last_seq", -1);
            Conversation r = new Conversation(c, lastSeq);
            BluetoothGatt gatt = dev.connectGatt(c, autoConnect, r, BluetoothDevice.TRANSPORT_LE);
            r.done.await(waitMs, TimeUnit.MILLISECONDS);
            try {
                gatt.disconnect();
                gatt.close();
            } catch (Exception ignored) {
                // already closed
            }
            if (r.connected) p.edit().putLong("meter_auto_at", System.currentTimeMillis()).apply();
            if (!r.records.isEmpty()) {
                int before = new org.json.JSONArray(p.getString("meter_pending", "[]")).length();
                save(c, r, lastSeq);
                int added = new org.json.JSONArray(p.getString("meter_pending", "[]")).length() - before;
                note(c, added > 0 ? "got" : "none", added);
                return true;
            }
            if (r.connected) note(c, "none", 0);
            return false;
        } catch (InterruptedException e) {
            Thread.currentThread().interrupt();
            return false;
        } catch (Exception ignored) {
            return false; // meter went to sleep or out of range: next time it wakes
        } finally {
            busy = false;
            waiting = false;
        }
    }

    // --- the Bluetooth conversation -----------------------------------------------------------

    private static class Reading {
        int seq;
        long ts;
        double mmol;
    }

    private static class Conversation extends BluetoothGattCallback {
        final CountDownLatch done = new CountDownLatch(1);
        final Map<Integer, Reading> records = new HashMap<>();
        final Map<Integer, Integer> meals = new HashMap<>();
        final Deque<BluetoothGattDescriptor> toEnable = new ArrayDeque<>();
        final long lastSeq;
        final Context ctx;
        volatile boolean connected;
        BluetoothGattCharacteristic racp;

        Conversation(Context ctx, long lastSeq) {
            this.ctx = ctx;
            this.lastSeq = lastSeq;
        }

        @Override
        public void onConnectionStateChange(BluetoothGatt g, int status, int state) {
            if (state == BluetoothProfile.STATE_CONNECTED) {
                // the open app is reading the meter itself right now: leave it to the app
                if (System.currentTimeMillis() < AlarmScheduler.prefs(ctx).getLong("meter_app_busy_until", 0)) {
                    done.countDown();
                    return;
                }
                connected = true;
                note(ctx, "connected", 0);
                g.discoverServices();
            } else if (state == BluetoothProfile.STATE_DISCONNECTED) {
                done.countDown();
            }
        }

        @Override
        public void onServicesDiscovered(BluetoothGatt g, int status) {
            BluetoothGattService s = g.getService(GLS);
            if (s == null) {
                done.countDown();
                return;
            }
            racp = s.getCharacteristic(RACP);
            for (UUID u : new UUID[] {MEASUREMENT, CONTEXT, RACP}) {
                BluetoothGattCharacteristic ch = s.getCharacteristic(u);
                if (ch == null) continue;
                g.setCharacteristicNotification(ch, true);
                BluetoothGattDescriptor d = ch.getDescriptor(CCCD);
                if (d == null) continue;
                d.setValue(u.equals(RACP) ? BluetoothGattDescriptor.ENABLE_INDICATION_VALUE : BluetoothGattDescriptor.ENABLE_NOTIFICATION_VALUE);
                toEnable.add(d);
            }
            next(g);
        }

        @Override
        public void onDescriptorWrite(BluetoothGatt g, BluetoothGattDescriptor d, int status) {
            next(g);
        }

        // One notification switch at a time, then ask for the readings.
        private void next(BluetoothGatt g) {
            BluetoothGattDescriptor d = toEnable.poll();
            if (d != null) {
                g.writeDescriptor(d);
                return;
            }
            if (racp == null) {
                done.countDown();
                return;
            }
            byte[] req = lastSeq < 0
                    ? new byte[] {0x01, 0x01}
                    : new byte[] {0x01, 0x03, 0x01, (byte) (lastSeq & 0xff), (byte) ((lastSeq >> 8) & 0xff)};
            racp.setValue(req);
            racp.setWriteType(BluetoothGattCharacteristic.WRITE_TYPE_DEFAULT);
            g.writeCharacteristic(racp);
        }

        // Android 13+: the value comes as an argument.
        @Override
        public void onCharacteristicChanged(@NonNull BluetoothGatt g, @NonNull BluetoothGattCharacteristic ch, @NonNull byte[] value) {
            handle(ch.getUuid(), value);
        }

        // Older Android: the value is on the characteristic.
        @Override
        public void onCharacteristicChanged(BluetoothGatt g, BluetoothGattCharacteristic ch) {
            handle(ch.getUuid(), ch.getValue());
        }

        private void handle(UUID u, byte[] b) {
            if (b == null || b.length == 0) return;
            if (u.equals(MEASUREMENT)) {
                Reading r = parseMeasurement(b);
                if (r != null) records.put(r.seq, r);
            } else if (u.equals(CONTEXT)) {
                parseContext(b, meals);
            } else if (u.equals(RACP) && (b[0] & 0xff) == 0x06) {
                done.countDown(); // finished (or nothing new)
            }
        }
    }

    // IEEE-11073 16-bit SFLOAT
    private static double sfloat(int lo, int hi) {
        int raw = (lo & 0xff) | ((hi & 0xff) << 8);
        int mantissa = raw & 0x0fff;
        int exponent = raw >> 12;
        if (mantissa == 0x07ff || mantissa == 0x0800 || mantissa == 0x07fe) return Double.NaN;
        if (mantissa >= 0x0800) mantissa -= 0x1000;
        if (exponent >= 0x08) exponent -= 0x10;
        return mantissa * Math.pow(10, exponent);
    }

    // Same decoding as parseMeasurement() in www/src/meter.js.
    private static Reading parseMeasurement(byte[] b) {
        if (b.length < 10) return null;
        int flags = b[0] & 0xff;
        int i = 1;
        Reading r = new Reading();
        r.seq = (b[i] & 0xff) | ((b[i + 1] & 0xff) << 8);
        i += 2;
        int year = (b[i] & 0xff) | ((b[i + 1] & 0xff) << 8);
        int month = b[i + 2] & 0xff, day = b[i + 3] & 0xff, h = b[i + 4] & 0xff, m = b[i + 5] & 0xff, s = b[i + 6] & 0xff;
        i += 7;
        int offset = 0;
        if ((flags & 0x01) != 0 && b.length >= i + 2) {
            offset = (short) ((b[i] & 0xff) | ((b[i + 1] & 0xff) << 8));
            i += 2;
        }
        if ((flags & 0x02) == 0 || b.length < i + 2) return null;
        double v = sfloat(b[i], b[i + 1]);
        if (Double.isNaN(v)) return null;
        double mmol = (flags & 0x04) != 0 ? v * 1000 : (v * 100000) / 18.0156;
        r.mmol = Math.round(mmol * 10) / 10.0;
        Calendar cal = Calendar.getInstance();
        cal.set(year, month - 1, day, h, m, s);
        cal.set(Calendar.MILLISECOND, 0);
        r.ts = cal.getTimeInMillis() + offset * 60_000L;
        return r;
    }

    private static void parseContext(byte[] b, Map<Integer, Integer> meals) {
        if (b.length < 3) return;
        int flags = b[0] & 0xff;
        int seq = (b[1] & 0xff) | ((b[2] & 0xff) << 8);
        int i = 3;
        if ((flags & 0x80) != 0) i += 1;
        if ((flags & 0x01) != 0) i += 3;
        if ((flags & 0x02) != 0 && b.length > i) meals.put(seq, b[i] & 0xff);
    }

    // --- new results: for the app, the family, and the emergency alarm --------------------------

    private static boolean danger(double mmol) {
        return mmol < 3.9 || mmol > 16.7;
    }

    /** The readings list handed to the app ("meter_pending") is read and cleared under this lock. */
    static final Object PENDING_LOCK = new Object();

    private static void save(Context c, Conversation r, long lastSeq) throws Exception {
        synchronized (PENDING_LOCK) {
            saveLocked(c, r, lastSeq);
        }
    }

    private static void saveLocked(Context c, Conversation r, long lastSeq) throws Exception {
        SharedPreferences p = AlarmScheduler.prefs(c);
        JSONArray pending = new JSONArray(p.getString("meter_pending", "[]"));
        long maxSeq = lastSeq;
        Reading newest = null;
        long now = System.currentTimeMillis();
        for (Reading x : r.records.values()) {
            maxSeq = Math.max(maxSeq, x.seq);
            if (!(x.mmol >= 1 && x.mmol <= 34)) continue;
            boolean fresh = now - x.ts < 30 * 60_000L;
            JSONObject rec = new JSONObject();
            rec.put("id", "meter-" + x.seq + "-" + x.ts);
            rec.put("type", "reading");
            rec.put("value", x.mmol);
            rec.put("context", contextAt(c, x.ts, r.meals.get(x.seq)));
            rec.put("ts", x.ts);
            rec.put("source", "meter");
            rec.put("seq", x.seq);
            rec.put("updatedAt", now);
            rec.put("by", "patient");
            if (fresh && danger(x.mmol)) rec.put("alarmed", true);
            pending.put(rec);
            SyncWorker.queue(c, rec); // to the family
            if (newest == null || x.ts > newest.ts) newest = x;
        }
        p.edit().putString("meter_pending", pending.toString()).putLong("meter_last_seq", maxSeq).putLong("meter_last_sync", now).apply();
        if (newest != null && danger(newest.mmol) && now - newest.ts < 30 * 60_000L) ringCrisis(c, newest);
    }

    // Emergency alarm with the texts and contacts the app saved (AlarmPlugin.setMeterConfig).
    private static void ringCrisis(Context c, Reading x) {
        try {
            JSONObject all = new JSONObject(AlarmScheduler.prefs(c).getString("crisis_texts", "{}"));
            String level = x.mmol < 3.9 ? "low" : "high";
            JSONObject tx = all.optJSONObject(level);
            if (tx == null) return;
            JSONObject item = new JSONObject();
            item.put("id", CRISIS_ID);
            item.put("title", tx.optString("title").replace("{v}", String.valueOf(x.mmol)));
            item.put("body", tx.optString("body"));
            item.put("steps", tx.optString("steps"));
            item.put("contacts", all.optString("contacts", "[]"));
            item.put("tone", level);
            item.put("clip", tx.optString("clip"));
            item.put("lang", all.optString("lang", "bn"));
            item.put("route", level);
            item.put("repeat", false);
            item.put("openLabel", all.optString("openLabel", "Open"));
            item.put("snoozeLabel", all.optString("snoozeLabel", "Close"));
            AlarmScheduler.putItem(c, item);
            c.sendBroadcast(new Intent(c, AlarmReceiver.class).putExtra("id", CRISIS_ID).putExtra("occurrence", System.currentTimeMillis()).putExtra("attempt", 0));
        } catch (Exception ignored) {
            // no texts saved yet: the app shows the steps when opened
        }
    }

    // Like contextAt() in the app: the meter's meal mark, else the time of day compared with the
    // insulin times saved with the alarms.
    private static String contextAt(Context c, long ts, Integer meal) {
        if (meal != null && meal == 3) return "fasting";
        if (meal != null && meal == 5) return "bedtime";
        if (meal != null && meal == 2) return "post_meal";
        Map<String, Integer> at = new HashMap<>();
        at.put("breakfast", 7 * 60 + 30);
        at.put("lunch", 13 * 60);
        at.put("dinner", 20 * 60);
        at.put("night", 22 * 60);
        try {
            JSONArray ids = new JSONArray(AlarmScheduler.prefs(c).getString("daily_ids", "[]"));
            for (int i = 0; i < ids.length(); i++) {
                JSONObject item = AlarmScheduler.getItem(c, ids.getInt(i));
                if (item != null && at.containsKey(item.optString("slot"))) at.put(item.optString("slot"), item.optInt("hour") * 60 + item.optInt("minute"));
            }
        } catch (Exception ignored) {
            // defaults
        }
        Calendar cal = Calendar.getInstance();
        cal.setTimeInMillis(ts);
        int m = cal.get(Calendar.HOUR_OF_DAY) * 60 + cal.get(Calendar.MINUTE);
        if (cal.get(Calendar.HOUR_OF_DAY) < 5) return "night_3am";
        if (Math.abs(m - at.get("breakfast")) <= 60 || m < at.get("breakfast")) return "fasting";
        if (Math.abs(m - at.get("lunch")) <= 60) return "pre_lunch";
        if (Math.abs(m - at.get("dinner")) <= 60) return "pre_dinner";
        if (m >= at.get("night") - 60) return "bedtime";
        for (String slot : new String[] {"breakfast", "lunch", "dinner"}) {
            int after = m - (at.get(slot) + 30);
            if (after >= 90 && after <= 180) return "post_meal";
        }
        return "other";
    }
}
