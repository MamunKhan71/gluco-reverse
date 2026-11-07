package com.family.sugarhelper;

import android.content.Context;
import android.content.res.AssetFileDescriptor;
import android.media.AudioAttributes;
import android.media.MediaPlayer;

/** Recorded voice clips in res/raw (dose_morning, en_dose_morning, …), played on the alarm stream. */
final class Clips {
    private Clips() {}

    static int id(Context c, String name) {
        if (name == null || name.isEmpty()) return 0;
        return c.getResources().getIdentifier(name, "raw", c.getPackageName());
    }

    /** "a,b,c" → the ids of those that exist in the app, in order. */
    static int[] ids(Context c, String names) {
        if (names == null || names.isEmpty()) return new int[0];
        java.util.List<Integer> out = new java.util.ArrayList<>();
        for (String n : names.split(",")) {
            int id = id(c, n.trim());
            if (id != 0) out.add(id);
        }
        int[] r = new int[out.size()];
        for (int i = 0; i < r.length; i++) r[i] = out.get(i);
        return r;
    }

    /** A prepared player for the clip, or null if it can't be played. */
    static MediaPlayer player(Context c, int res) {
        try (AssetFileDescriptor fd = c.getResources().openRawResourceFd(res)) {
            MediaPlayer p = new MediaPlayer();
            p.setAudioAttributes(new AudioAttributes.Builder()
                    .setUsage(AudioAttributes.USAGE_ALARM)
                    .setContentType(AudioAttributes.CONTENT_TYPE_SPEECH).build());
            p.setDataSource(fd.getFileDescriptor(), fd.getStartOffset(), fd.getLength());
            p.prepare();
            return p;
        } catch (Exception e) {
            return null;
        }
    }
}
