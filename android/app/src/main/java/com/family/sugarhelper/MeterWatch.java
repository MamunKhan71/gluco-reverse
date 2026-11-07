package com.family.sugarhelper;

import android.Manifest;
import android.app.PendingIntent;
import android.bluetooth.BluetoothAdapter;
import android.bluetooth.BluetoothManager;
import android.bluetooth.le.BluetoothLeScanner;
import android.bluetooth.le.ScanFilter;
import android.bluetooth.le.ScanSettings;
import android.content.BroadcastReceiver;
import android.content.Context;
import android.content.Intent;
import android.content.pm.PackageManager;
import android.os.Build;

import java.util.Collections;

/**
 * Watches for the paired meter the way the meter's own app does: after every test the CONTOUR
 * switches its radio on for a few seconds to send the result. Android's Bluetooth chip looks
 * for that one device (filtered scan, very low battery use) and wakes us through a
 * PendingIntent even if the app was swiped away; we then read the new results (MeterReader).
 */
public class MeterWatch extends BroadcastReceiver {
    static final String ACTION = "com.family.sugarhelper.METER_SEEN";

    private static PendingIntent pi(Context c) {
        Intent i = new Intent(c, MeterWatch.class).setAction(ACTION);
        int flags = PendingIntent.FLAG_UPDATE_CURRENT | (Build.VERSION.SDK_INT >= 31 ? PendingIntent.FLAG_MUTABLE : 0);
        return PendingIntent.getBroadcast(c, 7310, i, flags);
    }

    private static BluetoothLeScanner scanner(Context c) {
        if (Build.VERSION.SDK_INT >= 31 && c.checkSelfPermission(Manifest.permission.BLUETOOTH_SCAN) != PackageManager.PERMISSION_GRANTED) return null;
        BluetoothManager bm = (BluetoothManager) c.getSystemService(Context.BLUETOOTH_SERVICE);
        BluetoothAdapter a = bm == null ? null : bm.getAdapter();
        if (a == null || !a.isEnabled()) return null;
        return a.getBluetoothLeScanner();
    }

    /** Start (or restart) watching for the paired meter. Safe to call often. */
    static void start(Context c) {
        String id = AlarmScheduler.prefs(c).getString("meter_id", "");
        if (id.isEmpty() || Build.VERSION.SDK_INT < 26) return;
        try {
            BluetoothLeScanner s = scanner(c);
            if (s == null) return; // Bluetooth off: started again when the app opens or the phone restarts
            s.stopScan(pi(c));
            ScanFilter f = new ScanFilter.Builder().setDeviceAddress(id).build();
            ScanSettings settings = new ScanSettings.Builder()
                    .setScanMode(ScanSettings.SCAN_MODE_LOW_POWER)
                    .setCallbackType(ScanSettings.CALLBACK_TYPE_ALL_MATCHES)
                    .build();
            s.startScan(Collections.singletonList(f), settings, pi(c));
        } catch (Exception ignored) {
            // no permission / Bluetooth busy: try again next time
        }
    }

    static void stop(Context c) {
        if (Build.VERSION.SDK_INT < 26) return;
        try {
            BluetoothLeScanner s = scanner(c);
            if (s != null) s.stopScan(pi(c));
        } catch (Exception ignored) {
            // nothing to stop
        }
    }

    // The meter was seen: read it now, while its radio is on (not again within a minute).
    // A system broadcast like this one may run for up to about a minute, plenty for a read.
    @Override
    public void onReceive(Context c, Intent intent) {
        if (!ACTION.equals(intent.getAction())) return;
        if (System.currentTimeMillis() < AlarmScheduler.prefs(c).getLong("meter_app_busy_until", 0)) return; // the open app is reading it
        if (MeterReader.waiting) return; // MeterLink connects by itself
        long last = AlarmScheduler.prefs(c).getLong("meter_read_at", 0);
        if (System.currentTimeMillis() - last < 60_000L) return;
        AlarmScheduler.prefs(c).edit().putLong("meter_read_at", System.currentTimeMillis()).apply();
        PendingResult pending = goAsync();
        new Thread(() -> {
            try {
                MeterReader.read(c.getApplicationContext());
            } finally {
                pending.finish();
            }
        }).start();
    }
}
