package com.family.sugarhelper;

import android.app.Notification;
import android.app.NotificationChannel;
import android.app.NotificationManager;
import android.app.PendingIntent;
import android.content.BroadcastReceiver;
import android.content.Context;
import android.content.Intent;
import android.media.AudioAttributes;
import android.media.AudioManager;
import android.media.RingtoneManager;
import android.net.Uri;
import android.os.Build;

import androidx.core.app.NotificationCompat;

import org.json.JSONObject;

/** Rings an alarm: full-screen alarm screen + looping alarm sound, then schedules the repeat. */
public class AlarmReceiver extends BroadcastReceiver {
    static final String CHANNEL = "dose_alarm_soft_v2";
    static final String GENTLE_CHANNEL = "spoken_reminder_v1";
    private static android.media.MediaPlayer gentlePlayer;
    private static final long[] VIBRATE = {0, 300, 700, 300}; // two short, soft buzzes

    @Override
    public void onReceive(Context c, Intent intent) {
        int id = intent.getIntExtra("id", -1);
        String action = intent.getAction();
        if (AlarmScheduler.ACTION_TAKEN.equals(action) || AlarmScheduler.ACTION_SKIP.equals(action)) {
            AlarmScheduler.doseAction(c, id, AlarmScheduler.ACTION_TAKEN.equals(action));
            return;
        }
        if (AlarmScheduler.ACTION_DONE.equals(action)) {
            AlarmScheduler.recordAction(c, id);
            return;
        }
        if (AlarmScheduler.ACTION_SNOOZE.equals(action)) {
            int minutes = intent.getIntExtra("minutes", 0);
            if (minutes > 0) {
                AlarmScheduler.snooze(c, id, minutes, intent.getLongExtra("occurrence", System.currentTimeMillis()), intent.getIntExtra("attempt", 0));
            } else {
                AlarmScheduler.dismissNotification(c, id); // stop ringing; the usual repeat follows
            }
            return;
        }
        JSONObject item = AlarmScheduler.getItem(c, id);
        if (item == null) return;
        GuardService.start(c); // an exact alarm lets us bring the guard back if it was killed
        long occurrence = intent.getLongExtra("occurrence", System.currentTimeMillis());
        int attempt = intent.getIntExtra("attempt", 0);

        if (attempt == 0 && item.optBoolean("daily")) {
            long next = AlarmScheduler.nextDaily(item.optInt("hour"), item.optInt("minute"));
            AlarmScheduler.scheduleFire(c, id, next, 0, next);
        }
        if (AlarmScheduler.isConfirmed(c, id, occurrence)) return;
        if (item.optBoolean("gentle")) {
            PendingResult pending = goAsync();
            if (item.optInt("checkDose", 0) > 0) {
                // Family's "was the dose taken?" check: look in the cloud first, stay quiet if it was.
                new Thread(() -> {
                    if (SyncWorker.doseDone(c, item)) {
                        pending.finish();
                        return;
                    }
                    new android.os.Handler(android.os.Looper.getMainLooper()).post(() -> showGentle(c, id, item, pending));
                }).start();
            } else {
                showGentle(c, id, item, pending);
            }
            return;
        }

        show(c, id, item, attempt, occurrence);
        if (attempt < AlarmScheduler.maxRepeats(c) && item.optBoolean("repeat", true)) {
            long at = System.currentTimeMillis() + AlarmScheduler.repeatMinutes(c) * 60_000L;
            AlarmScheduler.scheduleFire(c, id, at, attempt + 1, occurrence);
        }
        // Still not logged after about 30 minutes of ringing: tell the family.
        int escalateAt = Math.max(1, Math.min(AlarmScheduler.maxRepeats(c), 30 / Math.max(1, AlarmScheduler.repeatMinutes(c))));
        if (attempt == escalateAt && item.has("missedText")) {
            notifyFamily(c, item.optString("missedTitle"), item.optString("missedText"), goAsync());
        }
    }

    /** Posts to the caregiver's ntfy topic from a background thread (no app needed). */
    private static void notifyFamily(Context c, String title, String text, PendingResult pending) {
        String topic = AlarmScheduler.prefs(c).getString("ntfy_topic", "");
        if (topic.isEmpty()) {
            pending.finish();
            return;
        }
        new Thread(() -> {
            java.net.HttpURLConnection con = null;
            try {
                org.json.JSONObject body = new org.json.JSONObject()
                        .put("topic", topic).put("title", title).put("message", text)
                        .put("priority", 5).put("tags", new org.json.JSONArray().put("warning"));
                con = (java.net.HttpURLConnection) new java.net.URL("https://ntfy.sh/").openConnection();
                con.setRequestMethod("POST");
                con.setConnectTimeout(15000);
                con.setReadTimeout(15000);
                con.setDoOutput(true);
                con.setRequestProperty("Content-Type", "application/json");
                try (java.io.OutputStream out = con.getOutputStream()) {
                    out.write(body.toString().getBytes(java.nio.charset.StandardCharsets.UTF_8));
                }
                con.getResponseCode();
            } catch (Exception ignored) {
                // no internet: the family still sees "Not taken" on the live dashboard
            } finally {
                if (con != null) con.disconnect();
                pending.finish();
            }
        }).start();
    }

    /** Snack / tomorrow's menu: an ordinary notification that speaks its clip once. */
    private static void showGentle(Context c, int id, JSONObject item, PendingResult pending) {
        String route = item.optString("route", "home");
        if (Build.VERSION.SDK_INT >= 26) {
            NotificationManager nm = c.getSystemService(NotificationManager.class);
            if (nm.getNotificationChannel(GENTLE_CHANNEL) == null) {
                NotificationChannel ch = new NotificationChannel(GENTLE_CHANNEL, "Spoken reminders", NotificationManager.IMPORTANCE_HIGH);
                ch.setDescription("Snack and tomorrow's menu, read aloud");
                ch.setSound(null, null); // the recorded voice is the sound
                ch.enableVibration(true);
                ch.setLockscreenVisibility(Notification.VISIBILITY_PUBLIC);
                nm.createNotificationChannel(ch);
            }
        }
        Intent open = new Intent(c, MainActivity.class).putExtra("route", route)
                .addFlags(Intent.FLAG_ACTIVITY_NEW_TASK | Intent.FLAG_ACTIVITY_SINGLE_TOP);
        PendingIntent openPi = PendingIntent.getActivity(c, id * 100 + 6, open, PendingIntent.FLAG_IMMUTABLE | PendingIntent.FLAG_UPDATE_CURRENT);
        String body = item.optString("body");
        NotificationCompat.Builder nb = new NotificationCompat.Builder(c, GENTLE_CHANNEL)
                .setSmallIcon(R.drawable.ic_stat_drop)
                .setColor(0xFF5B4DE8)
                .setContentTitle(item.optString("title"))
                .setContentText(body)
                .setStyle(new NotificationCompat.BigTextStyle().bigText(body))
                .setPriority(NotificationCompat.PRIORITY_HIGH)
                .setSilent(true)
                .setVibrate(new long[] {0, 400, 200, 400})
                .setContentIntent(openPi)
                .setAutoCancel(true);
        if (!item.optString("doneLabel").isEmpty() && item.has("doneRecord")) {
            Intent done = new Intent(c, AlarmReceiver.class).setAction(AlarmScheduler.ACTION_DONE).putExtra("id", id);
            PendingIntent donePi = PendingIntent.getBroadcast(c, id * 100 + 7, done, PendingIntent.FLAG_IMMUTABLE | PendingIntent.FLAG_UPDATE_CURRENT);
            nb.addAction(0, item.optString("doneLabel"), donePi);
        }
        String phone = item.optString("phone");
        if (!phone.isEmpty()) {
            Intent dial = new Intent(Intent.ACTION_DIAL, Uri.parse("tel:" + phone)).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK);
            PendingIntent dialPi = PendingIntent.getActivity(c, id * 100 + 8, dial, PendingIntent.FLAG_IMMUTABLE | PendingIntent.FLAG_UPDATE_CURRENT);
            nb.addAction(0, item.optString("callLabel", "Call"), dialPi);
        }
        NotificationManager nm = (NotificationManager) c.getSystemService(Context.NOTIFICATION_SERVICE);
        nm.notify(AlarmScheduler.NOTIF_BASE + id, nb.build());

        int res = AlarmScheduler.voice(c) ? Clips.id(c, item.optString("clip")) : 0;
        android.media.MediaPlayer p = res == 0 ? null : Clips.player(c, res);
        if (p == null) {
            // voice off or no clip: a normal notification tone
            try {
                RingtoneManager.getRingtone(c, RingtoneManager.getDefaultUri(RingtoneManager.TYPE_NOTIFICATION)).play();
            } catch (Exception ignored) {
            }
            pending.finish();
            return;
        }
        if (gentlePlayer != null) gentlePlayer.release();
        gentlePlayer = p;
        android.os.Handler h = new android.os.Handler(android.os.Looper.getMainLooper());
        Runnable done = () -> {
            if (gentlePlayer == p) {
                p.release();
                gentlePlayer = null;
            }
            try {
                pending.finish();
            } catch (IllegalStateException ignored) {
                // already finished
            }
        };
        p.setOnCompletionListener(mp -> h.post(done));
        h.postDelayed(done, 9_000); // a broadcast may only run about 10 s
        p.start();
    }

    static void ensureChannel(Context c) {
        if (Build.VERSION.SDK_INT < 26) return;
        NotificationManager nm = c.getSystemService(NotificationManager.class);
        if (nm.getNotificationChannel("dose_alarm_v1") != null) nm.deleteNotificationChannel("dose_alarm_v1"); // the old loud one
        if (nm.getNotificationChannel(CHANNEL) != null) return;
        NotificationChannel ch = new NotificationChannel(CHANNEL, "Dose alarms", NotificationManager.IMPORTANCE_HIGH);
        ch.setDescription("Insulin and sugar-check alarms");
        ch.setSound(alarmSound(), new AudioAttributes.Builder()
                .setUsage(AudioAttributes.USAGE_ALARM)
                .setContentType(AudioAttributes.CONTENT_TYPE_SONIFICATION)
                .build());
        ch.enableVibration(true);
        ch.setVibrationPattern(VIBRATE);
        ch.setLockscreenVisibility(Notification.VISIBILITY_PUBLIC);
        nm.createNotificationChannel(ch);
    }

    static final String URGENT_CHANNEL = "crisis_alarm_v1";

    /** Dangerous-sugar alarms keep the phone's loud alarm tone. */
    static void ensureUrgentChannel(Context c) {
        if (Build.VERSION.SDK_INT < 26) return;
        NotificationManager nm = c.getSystemService(NotificationManager.class);
        if (nm.getNotificationChannel(URGENT_CHANNEL) != null) return;
        NotificationChannel ch = new NotificationChannel(URGENT_CHANNEL, "Dangerous sugar alarms", NotificationManager.IMPORTANCE_HIGH);
        ch.setSound(urgentSound(), new AudioAttributes.Builder().setUsage(AudioAttributes.USAGE_ALARM).setContentType(AudioAttributes.CONTENT_TYPE_SONIFICATION).build());
        ch.enableVibration(true);
        ch.setVibrationPattern(new long[] {0, 800, 400, 800, 400, 800});
        ch.setLockscreenVisibility(Notification.VISIBILITY_PUBLIC);
        nm.createNotificationChannel(ch);
    }

    static Uri alarmSound() {
        return softChime(null);
    }

    /** Soft three-note bell, like a hospital call bell (res/raw/chime_soft.wav). */
    static Uri softChime(Context c) {
        return Uri.parse("android.resource://com.family.sugarhelper/raw/chime_soft");
    }

    /** The phone's own loud alarm tone: kept for dangerous-sugar emergencies only. */
    static Uri urgentSound() {
        Uri u = RingtoneManager.getDefaultUri(RingtoneManager.TYPE_ALARM);
        return u != null ? u : RingtoneManager.getDefaultUri(RingtoneManager.TYPE_NOTIFICATION);
    }

    private void show(Context c, int id, JSONObject item, int attempt, long occurrence) {
        ensureChannel(c);
        String title = item.optString("title");
        String body = item.optString("body");
        String route = item.optString("route", "home");

        Intent full = new Intent(c, AlarmActivity.class)
                .putExtra("id", id).putExtra("title", title).putExtra("body", body).putExtra("route", route)
                .putExtra("openLabel", item.optString("openLabel", "Open"))
                .putExtra("snoozeLabel", item.optString("snoozeLabel", "Later"))
                .putExtra("attempt", attempt)
                .putExtra("occurrence", occurrence)
                .putExtra("takenLabel", item.optString("takenLabel", ""))
                .putExtra("snooze30Label", item.optString("snooze30Label", ""))
                .putExtra("snooze60Label", item.optString("snooze60Label", ""))
                .putExtra("skipLabel", item.optString("skipLabel", ""))
                .putExtra("voice", item.optBoolean("voice", true))
                .putExtra("voiceUrl", item.optString("voiceUrl", ""))
                .putExtra("fallbackClip", item.optString("fallbackClip", ""))
                .putExtra("steps", item.optString("steps", ""))
                .putExtra("contacts", item.optString("contacts", ""))
                .putExtra("tone", item.optString("tone", ""))
                .putExtra("lang", item.optString("lang", "bn"))
                .putExtra("clip", attempt > 0 && item.has("repeatClip") ? item.optString("repeatClip") : item.optString("clip"))
                .addFlags(Intent.FLAG_ACTIVITY_NEW_TASK | Intent.FLAG_ACTIVITY_NO_USER_ACTION);
        PendingIntent fullPi = PendingIntent.getActivity(c, id * 100 + 5, full, PendingIntent.FLAG_IMMUTABLE | PendingIntent.FLAG_UPDATE_CURRENT);

        Intent open = new Intent(c, MainActivity.class).putExtra("route", route)
                .addFlags(Intent.FLAG_ACTIVITY_NEW_TASK | Intent.FLAG_ACTIVITY_SINGLE_TOP);
        PendingIntent openPi = PendingIntent.getActivity(c, id * 100 + 6, open, PendingIntent.FLAG_IMMUTABLE | PendingIntent.FLAG_UPDATE_CURRENT);

        Intent snooze = new Intent(c, AlarmReceiver.class).setAction(AlarmScheduler.ACTION_SNOOZE).putExtra("id", id);
        PendingIntent snoozePi = PendingIntent.getBroadcast(c, id * 100 + 7, snooze, PendingIntent.FLAG_IMMUTABLE | PendingIntent.FLAG_UPDATE_CURRENT);

        boolean urgent = !item.optString("steps").isEmpty(); // dangerous sugar
        if (urgent) ensureUrgentChannel(c);
        NotificationCompat.Builder b = new NotificationCompat.Builder(c, urgent ? URGENT_CHANNEL : CHANNEL)
                .setSmallIcon(R.drawable.ic_stat_drop)
                .setColor(0xFF5B4DE8)
                .setContentTitle(title)
                .setContentText(body)
                .setStyle(new NotificationCompat.BigTextStyle().bigText(body))
                .setPriority(NotificationCompat.PRIORITY_MAX)
                .setCategory(NotificationCompat.CATEGORY_ALARM)
                .setVisibility(NotificationCompat.VISIBILITY_PUBLIC)
                .setFullScreenIntent(fullPi, true)
                .setContentIntent(openPi)
                .setAutoCancel(true)
                .setOngoing(true)
                .setSound(urgent ? urgentSound() : alarmSound(), AudioManager.STREAM_ALARM)
                .setVibrate(VIBRATE)
;
        if (item.has("slot") && !item.optString("takenLabel").isEmpty()) {
            // a dose: answer it right from the notification
            Intent taken = new Intent(c, AlarmReceiver.class).setAction(AlarmScheduler.ACTION_TAKEN).putExtra("id", id);
            PendingIntent takenPi = PendingIntent.getBroadcast(c, id * 100 + 8, taken, PendingIntent.FLAG_IMMUTABLE | PendingIntent.FLAG_UPDATE_CURRENT);
            Intent later = new Intent(c, AlarmReceiver.class).setAction(AlarmScheduler.ACTION_SNOOZE).putExtra("id", id)
                    .putExtra("minutes", 30).putExtra("occurrence", occurrence).putExtra("attempt", attempt);
            PendingIntent laterPi = PendingIntent.getBroadcast(c, id * 100 + 9, later, PendingIntent.FLAG_IMMUTABLE | PendingIntent.FLAG_UPDATE_CURRENT);
            b.addAction(0, item.optString("takenLabel"), takenPi)
                    .addAction(0, item.optString("snooze30Label", "30 min"), laterPi)
                    .addAction(0, item.optString("openLabel", "Open"), openPi);
        } else {
            b.addAction(0, item.optString("openLabel", "Open"), openPi)
                    .addAction(0, item.optString("snoozeLabel", "Later"), snoozePi);
        }
        Notification n = b.build();
        n.flags |= Notification.FLAG_INSISTENT; // keep ringing until answered
        NotificationManager nm = (NotificationManager) c.getSystemService(Context.NOTIFICATION_SERVICE);
        nm.notify(AlarmScheduler.NOTIF_BASE + id, n);
    }
}
