package com.family.sugarhelper;

import android.Manifest;
import android.bluetooth.BluetoothAdapter;
import android.bluetooth.BluetoothManager;
import android.content.Context;
import android.content.SharedPreferences;
import android.content.pm.PackageManager;
import android.os.Build;

/**
 * Keeps a standing connection request open for the paired meter while GuardService runs, the
 * way the meter's own app stays ready: after each test the meter calls back, Android connects
 * by itself, we read the new results, then wait for the next test. Status for the meter page
 * is kept in "meter_link" (waiting / bt_off / no_meter / no_permission).
 */
final class MeterLink {
    private static Thread thread;
    private static volatile boolean running;

    private MeterLink() {}

    static synchronized void start(Context c) {
        if (running) return;
        running = true;
        Context app = c.getApplicationContext();
        thread = new Thread(() -> loop(app), "meter-link");
        thread.setDaemon(true);
        thread.start();
    }

    static synchronized void stop() {
        running = false;
        if (thread != null) thread.interrupt();
        thread = null;
    }

    private static void status(Context c, String s) {
        AlarmScheduler.prefs(c).edit().putString("meter_link", s).apply();
    }

    private static String ready(Context c) {
        SharedPreferences p = AlarmScheduler.prefs(c);
        if (p.getString("meter_id", "").isEmpty()) return "no_meter";
        if (Build.VERSION.SDK_INT >= 31 && c.checkSelfPermission(Manifest.permission.BLUETOOTH_CONNECT) != PackageManager.PERMISSION_GRANTED) return "no_permission";
        BluetoothManager bm = (BluetoothManager) c.getSystemService(Context.BLUETOOTH_SERVICE);
        BluetoothAdapter a = bm == null ? null : bm.getAdapter();
        if (a == null || !a.isEnabled()) return "bt_off";
        return "";
    }

    private static void loop(Context c) {
        while (running) {
            try {
                String why = ready(c);
                if (!why.isEmpty()) {
                    status(c, why);
                    Thread.sleep(30_000); // check again soon (Bluetooth turned on, meter paired…)
                    continue;
                }
                // the open app is reading the meter itself: wait until it is done
                long busyUntil = AlarmScheduler.prefs(c).getLong("meter_app_busy_until", 0);
                if (System.currentTimeMillis() < busyUntil) {
                    Thread.sleep(Math.min(60_000, busyUntil - System.currentTimeMillis() + 1_000));
                    continue;
                }
                status(c, "waiting");
                // waits (up to 30 min, then re-arms) for the meter to call back after a test
                boolean got = MeterReader.read(c, true, 30 * 60_000L);
                // the meter stays awake a little after sending: give it time to sleep again
                Thread.sleep(got ? 20_000 : 4_000);
            } catch (InterruptedException e) {
                return;
            } catch (Exception e) {
                try {
                    Thread.sleep(30_000);
                } catch (InterruptedException ie) {
                    return;
                }
            }
        }
    }
}
