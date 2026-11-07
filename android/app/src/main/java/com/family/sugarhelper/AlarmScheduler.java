package com.family.sugarhelper;

import android.app.AlarmManager;
import android.app.NotificationManager;
import android.app.PendingIntent;
import android.content.Context;
import android.content.Intent;
import android.content.SharedPreferences;
import android.os.Build;

import org.json.JSONArray;
import org.json.JSONException;
import org.json.JSONObject;

import java.util.Calendar;

/**
 * Stores alarm definitions and schedules them with AlarmManager.setAlarmClock
 * (exact, survives Doze). Each alarm id has two slots: the main ring and the
 * repeat ring that keeps coming back until the dose is confirmed.
 */
final class AlarmScheduler {
    static final String ACTION_FIRE = "com.family.sugarhelper.ALARM_FIRE";
    static final String ACTION_SNOOZE = "com.family.sugarhelper.ALARM_SNOOZE";
    static final String ACTION_TAKEN = "com.family.sugarhelper.ALARM_TAKEN";
    static final String ACTION_SKIP = "com.family.sugarhelper.ALARM_SKIP";
    static final String ACTION_DONE = "com.family.sugarhelper.ALARM_DONE";
    static final String PREFS = "sugar_alarms";
    static final int NOTIF_BASE = 7000;
    // A confirmation counts for an alarm scheduled up to this long after it.
    static final long CONFIRM_WINDOW_MS = 3L * 60 * 60 * 1000;

    private AlarmScheduler() {}

    static SharedPreferences prefs(Context c) {
        return c.getSharedPreferences(PREFS, Context.MODE_PRIVATE);
    }

    static JSONObject getItem(Context c, int id) {
        String s = prefs(c).getString("item_" + id, null);
        if (s == null) return null;
        try {
            return new JSONObject(s);
        } catch (JSONException e) {
            return null;
        }
    }

    static void putItem(Context c, JSONObject item) {
        prefs(c).edit().putString("item_" + item.optInt("id"), item.toString()).apply();
    }

    static int repeatMinutes(Context c) {
        return prefs(c).getInt("repeat_minutes", 10);
    }

    static int maxRepeats(Context c) {
        return prefs(c).getInt("max_repeats", 6);
    }

    static boolean voice(Context c) {
        return prefs(c).getBoolean("voice", true);
    }

    static boolean isConfirmed(Context c, int id, long occurrence) {
        long conf = prefs(c).getLong("confirmed_" + id, 0);
        // taken within 3 h before, or earlier the same day (e.g. a dose taken at sehri)
        return conf >= occurrence - CONFIRM_WINDOW_MS || (conf > 0 && sameDay(conf, occurrence));
    }

    static boolean sameDay(long a, long b) {
        java.util.Calendar x = java.util.Calendar.getInstance();
        x.setTimeInMillis(a);
        java.util.Calendar y = java.util.Calendar.getInstance();
        y.setTimeInMillis(b);
        return x.get(java.util.Calendar.YEAR) == y.get(java.util.Calendar.YEAR) && x.get(java.util.Calendar.DAY_OF_YEAR) == y.get(java.util.Calendar.DAY_OF_YEAR);
    }

    /** Snoozing stops 2½ h after the planned time, so a late dose can't run into the next meal's. */
    static final long SNOOZE_LIMIT_MS = 150L * 60 * 1000;

    static void confirm(Context c, int id) {
        confirm(c, id, System.currentTimeMillis());
    }

    /** Marks the alarm done as of when the dose was actually taken (not when we heard about it),
     *  so a dose logged this morning can never silence tomorrow morning's alarm. */
    static void confirm(Context c, int id, long takenAt) {
        if (takenAt <= 0) takenAt = System.currentTimeMillis();
        long prev = prefs(c).getLong("confirmed_" + id, 0);
        if (takenAt <= prev) return;
        prefs(c).edit().putLong("confirmed_" + id, takenAt).apply();
        if (System.currentTimeMillis() - takenAt < CONFIRM_WINDOW_MS) {
            cancelPending(c, id, true);
            dismissNotification(c, id);
        }
    }

    static long nextDaily(int hour, int minute) {
        Calendar cal = Calendar.getInstance();
        cal.set(Calendar.HOUR_OF_DAY, hour);
        cal.set(Calendar.MINUTE, minute);
        cal.set(Calendar.SECOND, 0);
        cal.set(Calendar.MILLISECOND, 0);
        if (cal.getTimeInMillis() <= System.currentTimeMillis() + 1000) cal.add(Calendar.DAY_OF_YEAR, 1);
        return cal.getTimeInMillis();
    }

    private static PendingIntent firePi(Context c, int id, boolean repeat, long occurrence, int attempt, int flags) {
        Intent i = new Intent(c, AlarmReceiver.class).setAction(ACTION_FIRE);
        i.putExtra("id", id).putExtra("occurrence", occurrence).putExtra("attempt", attempt);
        return PendingIntent.getBroadcast(c, id * 100 + (repeat ? 1 : 0), i, flags | PendingIntent.FLAG_IMMUTABLE);
    }

    static void scheduleFire(Context c, int id, long at, int attempt, long occurrence) {
        AlarmManager am = (AlarmManager) c.getSystemService(Context.ALARM_SERVICE);
        PendingIntent op = firePi(c, id, attempt > 0, occurrence, attempt, PendingIntent.FLAG_UPDATE_CURRENT);
        boolean exact = Build.VERSION.SDK_INT < 31 || am.canScheduleExactAlarms();
        if (exact) {
            Intent show = new Intent(c, MainActivity.class);
            PendingIntent showPi = PendingIntent.getActivity(c, 1, show, PendingIntent.FLAG_IMMUTABLE | PendingIntent.FLAG_UPDATE_CURRENT);
            am.setAlarmClock(new AlarmManager.AlarmClockInfo(at, showPi), op);
        } else {
            am.setAndAllowWhileIdle(AlarmManager.RTC_WAKEUP, at, op);
        }
    }

    /**
     * "Taken" or "skip" pressed on a dose alarm: stop it, and record the dose (planned units,
     * now) for the app to pick up and for the family (SyncWorker), even with the app closed.
     */
    /** "Ate it" / "Taken" on a meal or medicine reminder: logs the reminder's record for the app. */
    static void recordAction(Context c, int id) {
        org.json.JSONObject item = getItem(c, id);
        long now = System.currentTimeMillis();
        confirm(c, id, now);
        dismissNotification(c, id);
        if (item == null || !item.has("doneRecord")) return;
        try {
            org.json.JSONObject rec = new org.json.JSONObject(item.getString("doneRecord"))
                    .put("id", "rem-" + id + "-" + now)
                    .put("ts", now)
                    .put("updatedAt", now)
                    .put("by", "patient")
                    .put("via", "reminder");
            SharedPreferences p = prefs(c);
            synchronized (MeterReader.PENDING_LOCK) {
                org.json.JSONArray pending = new org.json.JSONArray(p.getString("meter_pending", "[]"));
                pending.put(rec);
                p.edit().putString("meter_pending", pending.toString()).commit();
            }
            SyncWorker.queue(c, rec);
        } catch (Exception ignored) {
            // nothing to log
        }
    }

    static void doseAction(Context c, int id, boolean taken) {
        org.json.JSONObject item = getItem(c, id);
        long now = System.currentTimeMillis();
        confirm(c, id, now);
        AlarmActivity.closeIfShowing(id);
        if (item == null || !item.has("slot")) return;
        try {
            int base = item.optInt("base", item.optInt("units", 0));
            int units = taken ? item.optInt("units", base) : 0;
            org.json.JSONObject rec = new org.json.JSONObject()
                    .put("id", "alarm-" + item.optString("slot") + "-" + now)
                    .put("type", "dose")
                    .put("kind", item.optString("kind", "bolus"))
                    .put("slot", item.optString("slot"))
                    .put("insulin", item.optString("insulin"))
                    .put("medId", item.optString("medId"))
                    .put("units", units)
                    .put("base", base)
                    .put("delta", units - base)
                    .put("ts", now)
                    .put("updatedAt", now)
                    .put("by", "patient")
                    .put("via", "alarm");
            if (!taken) rec.put("action", "skip");
            SharedPreferences p = prefs(c);
            synchronized (MeterReader.PENDING_LOCK) {
                org.json.JSONArray pending = new org.json.JSONArray(p.getString("meter_pending", "[]"));
                pending.put(rec);
                p.edit().putString("meter_pending", pending.toString()).commit();
            }
            SyncWorker.queue(c, rec);
        } catch (Exception ignored) {
            // alarm is stopped anyway
        }
    }

    /** "Remind me in N minutes": stop now, ring again then (instead of the usual repeat). */
    static void snooze(Context c, int id, int minutes, long occurrence, int attempt) {
        cancelPending(c, id, true);
        dismissNotification(c, id);
        AlarmActivity.closeIfShowing(id);
        long at = System.currentTimeMillis() + minutes * 60_000L;
        if (occurrence > 0 && at > occurrence + SNOOZE_LIMIT_MS) {
            at = occurrence + SNOOZE_LIMIT_MS;
            if (at <= System.currentTimeMillis() + 60_000L) return; // too late now: the app shows it as missed
        }
        scheduleFire(c, id, at, attempt + 1, occurrence);
    }

    static void cancelPending(Context c, int id, boolean repeatOnly) {
        AlarmManager am = (AlarmManager) c.getSystemService(Context.ALARM_SERVICE);
        for (boolean repeat : repeatOnly ? new boolean[] {true} : new boolean[] {false, true}) {
            PendingIntent pi = firePi(c, id, repeat, 0, 0, PendingIntent.FLAG_NO_CREATE);
            if (pi != null) {
                am.cancel(pi);
                pi.cancel();
            }
        }
    }

    static void dismissNotification(Context c, int id) {
        NotificationManager nm = (NotificationManager) c.getSystemService(Context.NOTIFICATION_SERVICE);
        nm.cancel(NOTIF_BASE + id);
    }

    /** Replaces the daily alarms (doses) with a new list. */
    static void setDaily(Context c, JSONArray items, int repeatMinutes, int maxRepeats, boolean voice) throws JSONException {
        SharedPreferences p = prefs(c);
        JSONArray old = new JSONArray(p.getString("daily_ids", "[]"));
        for (int i = 0; i < old.length(); i++) {
            cancelPending(c, old.getInt(i), false);
            p.edit().remove("item_" + old.getInt(i)).apply();
        }
        JSONArray ids = new JSONArray();
        for (int i = 0; i < items.length(); i++) {
            JSONObject item = items.getJSONObject(i);
            item.put("daily", true);
            putItem(c, item);
            ids.put(item.getInt("id"));
            long at = nextDaily(item.getInt("hour"), item.getInt("minute"));
            scheduleFire(c, item.getInt("id"), at, 0, at);
        }
        p.edit().putString("daily_ids", ids.toString()).putInt("repeat_minutes", repeatMinutes).putInt("max_repeats", maxRepeats).putBoolean("voice", voice).apply();
    }

    static void scheduleOnce(Context c, JSONObject item) throws JSONException {
        item.put("daily", false);
        putItem(c, item);
        int id = item.getInt("id");
        prefs(c).edit().remove("confirmed_" + id).apply();
        cancelPending(c, id, false);
        long at = item.getLong("at");
        scheduleFire(c, id, at, 0, at);
    }

    static void cancel(Context c, int id) {
        cancelPending(c, id, false);
        dismissNotification(c, id);
        prefs(c).edit().remove("item_" + id).apply();
    }

    /** After a restart: alarms are cleared by Android, so schedule them again. */
    static void rescheduleAll(Context c) {
        try {
            JSONArray ids = new JSONArray(prefs(c).getString("daily_ids", "[]"));
            for (int i = 0; i < ids.length(); i++) {
                JSONObject item = getItem(c, ids.getInt(i));
                if (item == null) continue;
                long at = nextDaily(item.getInt("hour"), item.getInt("minute"));
                scheduleFire(c, item.getInt("id"), at, 0, at);
            }
        } catch (JSONException ignored) {
            // nothing stored yet
        }
    }
}
