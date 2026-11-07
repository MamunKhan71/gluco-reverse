package com.family.sugarhelper;

import android.app.Notification;
import android.app.NotificationChannel;
import android.app.NotificationManager;
import android.app.PendingIntent;
import android.app.Service;
import android.content.Context;
import android.content.Intent;
import android.content.pm.ServiceInfo;
import android.os.Build;
import android.os.IBinder;

import androidx.core.app.NotificationCompat;
import androidx.core.app.ServiceCompat;
import androidx.core.content.ContextCompat;

/**
 * Keeps the app alive in the background with a quiet, permanent notification showing the
 * next dose. Phone "cleaner" tools and aggressive battery managers leave foreground
 * services alone, so the dose alarms keep working. Every start re-arms the alarms.
 */
public class GuardService extends Service {
    static final String CHANNEL = "guard_v1";
    static final int NOTIF_ID = 6100;

    static boolean hasMeter(Context c) {
        return !AlarmScheduler.prefs(c).getString("meter_id", "").isEmpty();
    }

    static void start(Context c) {
        if (!AlarmScheduler.prefs(c).getBoolean("guard_on", true) && !hasMeter(c)) return;
        try {
            ContextCompat.startForegroundService(c, new Intent(c, GuardService.class));
        } catch (Exception ignored) {
            // Android may refuse a background start; the alarms still work on their own.
        }
    }

    static void stop(Context c) {
        c.stopService(new Intent(c, GuardService.class));
    }

    // Android drops the meter watch when Bluetooth goes off; start it again when it comes back.
    private final android.content.BroadcastReceiver btState = new android.content.BroadcastReceiver() {
        @Override
        public void onReceive(Context c, Intent i) {
            if (i.getIntExtra(android.bluetooth.BluetoothAdapter.EXTRA_STATE, -1) == android.bluetooth.BluetoothAdapter.STATE_ON) MeterWatch.start(c);
        }
    };
    private boolean btWatching;

    @Override
    public void onCreate() {
        super.onCreate();
        try {
            ContextCompat.registerReceiver(this, btState, new android.content.IntentFilter(android.bluetooth.BluetoothAdapter.ACTION_STATE_CHANGED), ContextCompat.RECEIVER_NOT_EXPORTED);
            btWatching = true;
        } catch (Exception ignored) {
            // not critical
        }
        MeterWatch.start(this);
        MeterLink.start(this);
    }

    @Override
    public void onDestroy() {
        MeterLink.stop();
        if (btWatching) {
            try {
                unregisterReceiver(btState);
            } catch (Exception ignored) {
                // already gone
            }
        }
        super.onDestroy();
    }

    @Override
    public int onStartCommand(Intent intent, int flags, int startId) {
        ensureChannel();
        Intent open = new Intent(this, MainActivity.class).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK | Intent.FLAG_ACTIVITY_SINGLE_TOP);
        PendingIntent pi = PendingIntent.getActivity(this, 2, open, PendingIntent.FLAG_IMMUTABLE | PendingIntent.FLAG_UPDATE_CURRENT);
        Notification n = new NotificationCompat.Builder(this, CHANNEL)
                .setSmallIcon(R.drawable.ic_stat_drop)
                .setColor(0xFF7472E8)
                .setContentTitle(AlarmScheduler.prefs(this).getString("guard_title", "সুগার সহায়ক"))
                .setContentText(AlarmScheduler.prefs(this).getString("guard_text", ""))
                .setContentIntent(pi)
                .setOngoing(true)
                .setShowWhen(false)
                .setPriority(NotificationCompat.PRIORITY_LOW)
                .setCategory(NotificationCompat.CATEGORY_REMINDER)
                .build();
        int type = Build.VERSION.SDK_INT >= 34 ? ServiceInfo.FOREGROUND_SERVICE_TYPE_SPECIAL_USE : 0;
        try {
            ServiceCompat.startForeground(this, NOTIF_ID, n, type);
        } catch (Exception e) {
            stopSelf();
            return START_NOT_STICKY;
        }
        AlarmScheduler.rescheduleAll(this);
        return START_STICKY;
    }

    private void ensureChannel() {
        if (Build.VERSION.SDK_INT < 26) return;
        NotificationManager nm = getSystemService(NotificationManager.class);
        if (nm.getNotificationChannel(CHANNEL) != null) return;
        NotificationChannel ch = new NotificationChannel(CHANNEL, "Always on", NotificationManager.IMPORTANCE_LOW);
        ch.setDescription("Keeps dose alarms working in the background");
        ch.setShowBadge(false);
        nm.createNotificationChannel(ch);
    }

    @Override
    public IBinder onBind(Intent intent) {
        return null;
    }
}
