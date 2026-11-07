package com.family.sugarhelper;

import android.content.BroadcastReceiver;
import android.content.Context;
import android.content.Intent;

/** Android clears alarms on restart and app update — schedule the dose alarms again. */
public class BootReceiver extends BroadcastReceiver {
    @Override
    public void onReceive(Context c, Intent intent) {
        AlarmScheduler.rescheduleAll(c);
        GuardService.start(c);
        SyncWorker.schedule(c);
        MeterWatch.start(c);
    }
}
