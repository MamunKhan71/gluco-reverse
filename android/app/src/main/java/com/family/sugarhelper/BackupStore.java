package com.family.sugarhelper;

import android.content.ContentResolver;
import android.content.ContentValues;
import android.content.Context;
import android.database.Cursor;
import android.net.Uri;
import android.os.Build;
import android.provider.MediaStore;

import java.io.ByteArrayOutputStream;
import java.io.File;
import java.io.FileInputStream;
import java.io.FileOutputStream;
import java.io.InputStream;
import java.io.OutputStream;
import java.nio.charset.StandardCharsets;

/**
 * Two copies of the app data outside the WebView: one in the app's own files (survives a
 * WebView reset) and one in Downloads/SugarHelper (survives "Clear data" on Android 10+).
 */
final class BackupStore {
    private static final String NAME = "sugar-helper-backup.json";
    private static final String FOLDER = "Download/SugarHelper/";

    private BackupStore() {}

    static void save(Context c, String json) throws Exception {
        byte[] bytes = json.getBytes(StandardCharsets.UTF_8);
        try (OutputStream out = new FileOutputStream(new File(c.getFilesDir(), NAME))) {
            out.write(bytes);
        }
        if (Build.VERSION.SDK_INT >= 29) {
            ContentResolver cr = c.getContentResolver();
            Uri uri = findShared(c);
            if (uri == null) {
                ContentValues v = new ContentValues();
                v.put(MediaStore.MediaColumns.DISPLAY_NAME, NAME);
                v.put(MediaStore.MediaColumns.MIME_TYPE, "application/json");
                v.put(MediaStore.MediaColumns.RELATIVE_PATH, FOLDER);
                uri = cr.insert(MediaStore.Downloads.EXTERNAL_CONTENT_URI, v);
            }
            if (uri != null) {
                try (OutputStream out = cr.openOutputStream(uri, "wt")) {
                    if (out != null) out.write(bytes);
                }
            }
        }
    }

    /** Returns { json, source } or null. */
    static String[] load(Context c) {
        File f = new File(c.getFilesDir(), NAME);
        if (f.exists()) {
            try (InputStream in = new FileInputStream(f)) {
                return new String[] {read(in), "internal"};
            } catch (Exception ignored) {
                // fall through to the shared copy
            }
        }
        if (Build.VERSION.SDK_INT >= 29) {
            Uri uri = findShared(c);
            if (uri != null) {
                try (InputStream in = c.getContentResolver().openInputStream(uri)) {
                    if (in != null) return new String[] {read(in), "downloads"};
                } catch (Exception ignored) {
                    // not readable
                }
            }
        }
        return null;
    }

    private static Uri findShared(Context c) {
        if (Build.VERSION.SDK_INT < 29) return null;
        String[] cols = {MediaStore.MediaColumns._ID};
        String sel = MediaStore.MediaColumns.DISPLAY_NAME + "=? AND " + MediaStore.MediaColumns.RELATIVE_PATH + "=?";
        try (Cursor cur = c.getContentResolver().query(MediaStore.Downloads.EXTERNAL_CONTENT_URI, cols, sel, new String[] {NAME, FOLDER}, null)) {
            if (cur != null && cur.moveToFirst()) {
                return Uri.withAppendedPath(MediaStore.Downloads.EXTERNAL_CONTENT_URI, String.valueOf(cur.getLong(0)));
            }
        } catch (Exception ignored) {
            // MediaStore unavailable
        }
        return null;
    }

    private static String read(InputStream in) throws Exception {
        ByteArrayOutputStream buf = new ByteArrayOutputStream();
        byte[] b = new byte[8192];
        int n;
        while ((n = in.read(b)) > 0) buf.write(b, 0, n);
        return buf.toString("UTF-8");
    }
}
