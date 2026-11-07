package com.family.sugarhelper;

import android.app.AlarmManager;
import android.app.NotificationManager;
import android.content.Context;
import android.content.Intent;
import android.net.Uri;
import android.os.Build;
import android.os.PowerManager;
import android.provider.Settings;
import android.speech.tts.TextToSpeech;

import androidx.core.app.NotificationManagerCompat;

import com.getcapacitor.JSArray;
import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;

import org.json.JSONObject;

import java.util.Locale;

/** JS bridge: window.Capacitor.Plugins.Alarm */
@CapacitorPlugin(name = "Alarm")
public class AlarmPlugin extends Plugin {
    private static String pendingRoute;
    private TextToSpeech tts;
    private boolean ttsReady;

    @Override
    public void load() {
        takeRoute(getActivity().getIntent());
        AlarmReceiver.ensureChannel(getContext());
    }

    @Override
    protected void handleOnNewIntent(Intent intent) {
        super.handleOnNewIntent(intent);
        takeRoute(intent);
    }

    private void takeRoute(Intent intent) {
        if (intent == null || !intent.hasExtra("route")) return;
        pendingRoute = intent.getStringExtra("route");
        intent.removeExtra("route");
        JSObject o = new JSObject();
        o.put("route", pendingRoute);
        notifyListeners("route", o, true);
    }

    @PluginMethod
    public void getLaunchRoute(PluginCall call) {
        JSObject r = new JSObject();
        r.put("route", pendingRoute);
        pendingRoute = null;
        call.resolve(r);
    }

    @PluginMethod
    public void setDaily(PluginCall call) {
        try {
            JSArray items = call.getArray("items", new JSArray());
            AlarmScheduler.setDaily(getContext(), items, call.getInt("repeatMinutes", 10), call.getInt("maxRepeats", 6), call.getBoolean("voice", true));
            AlarmScheduler.prefs(getContext()).edit().putString("ntfy_topic", call.getString("ntfyTopic", ""))
                    .putLong("plan_updated", call.getLong("planUpdatedAt", 0L)).apply();
            call.resolve();
        } catch (Exception e) {
            call.reject(e.getMessage());
        }
    }

    @PluginMethod
    public void once(PluginCall call) {
        try {
            JSONObject item = new JSONObject(call.getData().toString());
            AlarmScheduler.scheduleOnce(getContext(), item);
            call.resolve();
        } catch (Exception e) {
            call.reject(e.getMessage());
        }
    }

    @PluginMethod
    public void confirm(PluginCall call) {
        Long at = call.getLong("at");
        AlarmScheduler.confirm(getContext(), call.getInt("id", -1), at == null ? System.currentTimeMillis() : at);
        call.resolve();
    }

    @PluginMethod
    public void cancel(PluginCall call) {
        AlarmScheduler.cancel(getContext(), call.getInt("id", -1));
        call.resolve();
    }

    @PluginMethod
    public void status(PluginCall call) {
        Context c = getContext();
        JSObject r = new JSObject();
        NotificationManager nm = (NotificationManager) c.getSystemService(Context.NOTIFICATION_SERVICE);
        AlarmManager am = (AlarmManager) c.getSystemService(Context.ALARM_SERVICE);
        PowerManager pm = (PowerManager) c.getSystemService(Context.POWER_SERVICE);
        r.put("notifications", NotificationManagerCompat.from(c).areNotificationsEnabled());
        r.put("fullScreen", Build.VERSION.SDK_INT < 34 || nm.canUseFullScreenIntent());
        r.put("exact", Build.VERSION.SDK_INT < 31 || am.canScheduleExactAlarms());
        r.put("battery", pm.isIgnoringBatteryOptimizations(c.getPackageName()));
        call.resolve(r);
    }

    @PluginMethod
    public void openSettings(PluginCall call) {
        Context c = getContext();
        String kind = call.getString("kind", "notifications");
        Uri pkg = Uri.parse("package:" + c.getPackageName());
        Intent i;
        if ("fullScreen".equals(kind) && Build.VERSION.SDK_INT >= 34) {
            i = new Intent(Settings.ACTION_MANAGE_APP_USE_FULL_SCREEN_INTENT, pkg);
        } else if ("exact".equals(kind) && Build.VERSION.SDK_INT >= 31) {
            i = new Intent(Settings.ACTION_REQUEST_SCHEDULE_EXACT_ALARM, pkg);
        } else if ("battery".equals(kind)) {
            i = new Intent(Settings.ACTION_REQUEST_IGNORE_BATTERY_OPTIMIZATIONS, pkg);
        } else {
            i = new Intent(Settings.ACTION_APP_NOTIFICATION_SETTINGS).putExtra(Settings.EXTRA_APP_PACKAGE, c.getPackageName());
        }
        i.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK);
        try {
            c.startActivity(i);
        } catch (Exception e) {
            c.startActivity(new Intent(Settings.ACTION_APPLICATION_DETAILS_SETTINGS, pkg).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK));
        }
        call.resolve();
    }

    /** Background guard: { on, title, text } — permanent quiet notification with the next dose. */
    @PluginMethod
    public void guard(PluginCall call) {
        Context c = getContext();
        boolean on = call.getBoolean("on", true);
        AlarmScheduler.prefs(c).edit()
                .putBoolean("guard_on", on)
                .putString("guard_title", call.getString("title", "সুগার সহায়ক"))
                .putString("guard_text", call.getString("text", ""))
                .apply();
        // automatic meter sync lives in this service, so it stays on while a meter is paired
        if (on || GuardService.hasMeter(c)) GuardService.start(c);
        else GuardService.stop(c);
        call.resolve();
    }

    @PluginMethod
    public void backupSave(PluginCall call) {
        try {
            BackupStore.save(getContext(), call.getString("data", ""));
            call.resolve();
        } catch (Exception e) {
            call.reject(e.getMessage());
        }
    }

    @PluginMethod
    public void backupLoad(PluginCall call) {
        String[] r = BackupStore.load(getContext());
        JSObject o = new JSObject();
        if (r != null) {
            o.put("data", r[0]);
            o.put("source", r[1]);
        }
        call.resolve(o);
    }

    private String banglaState = "unknown";

    /** Starts the speech engine once; `then` runs when it is ready (with the Bangla state). */
    private void withTts(java.util.function.Consumer<String> then) {
        if (tts != null && ttsReady) {
            then.accept(banglaState);
            return;
        }
        if (tts != null) tts.shutdown();
        tts = VoiceHelper.create(getContext(), status -> {
            if (status != TextToSpeech.SUCCESS) {
                banglaState = "no_engine";
            } else {
                banglaState = VoiceHelper.useBangla(tts);
                ttsReady = true;
            }
            then.accept(banglaState);
        });
    }

    private android.media.MediaPlayer clipPlayer;

    private android.webkit.WebView printView; // kept alive until the print screen has the pages

    /** Doctor report: Android's print screen (Save as PDF or a printer) for the given HTML. */
    @PluginMethod
    public void printHtml(PluginCall call) {
        String html = call.getString("html", "");
        String name = call.getString("name", "Report");
        getActivity().runOnUiThread(() -> {
            try {
                android.webkit.WebView wv = new android.webkit.WebView(getActivity());
                printView = wv;
                wv.setWebViewClient(new android.webkit.WebViewClient() {
                    @Override
                    public void onPageFinished(android.webkit.WebView view, String url) {
                        android.print.PrintManager pm = (android.print.PrintManager) getActivity().getSystemService(Context.PRINT_SERVICE);
                        android.print.PrintAttributes attrs = new android.print.PrintAttributes.Builder()
                                .setMediaSize(android.print.PrintAttributes.MediaSize.ISO_A4)
                                .build();
                        pm.print(name, view.createPrintDocumentAdapter(name), attrs);
                        call.resolve();
                    }
                });
                wv.loadDataWithBaseURL("https://localhost/", html, "text/html", "utf-8", null);
            } catch (Exception e) {
                call.reject(e.getMessage());
            }
        });
    }

    /** Saves a file (base64) to Downloads/SugarHelper and opens the share sheet for it. */
    @PluginMethod
    public void shareFile(PluginCall call) {
        Context c = getContext();
        String name = call.getString("name", "report.xlsx");
        String mime = call.getString("mime", "application/octet-stream");
        try {
            byte[] bytes = android.util.Base64.decode(call.getString("base64", ""), android.util.Base64.DEFAULT);
            // a copy in Downloads, easy to find later
            if (Build.VERSION.SDK_INT >= 29) {
                try {
                    android.content.ContentValues v = new android.content.ContentValues();
                    v.put(android.provider.MediaStore.MediaColumns.DISPLAY_NAME, name);
                    v.put(android.provider.MediaStore.MediaColumns.MIME_TYPE, mime);
                    v.put(android.provider.MediaStore.MediaColumns.RELATIVE_PATH, "Download/SugarHelper/");
                    Uri saved = c.getContentResolver().insert(android.provider.MediaStore.Downloads.EXTERNAL_CONTENT_URI, v);
                    if (saved != null) {
                        try (java.io.OutputStream o = c.getContentResolver().openOutputStream(saved)) {
                            o.write(bytes);
                        }
                    }
                } catch (Exception ignored) {
                    // sharing below still works
                }
            }
            java.io.File dir = new java.io.File(c.getCacheDir(), "reports");
            dir.mkdirs();
            java.io.File file = new java.io.File(dir, name);
            try (java.io.FileOutputStream o = new java.io.FileOutputStream(file)) {
                o.write(bytes);
            }
            Uri uri = androidx.core.content.FileProvider.getUriForFile(c, c.getPackageName() + ".fileprovider", file);
            Intent send = new Intent(Intent.ACTION_SEND).setType(mime).putExtra(Intent.EXTRA_STREAM, uri)
                    .putExtra(Intent.EXTRA_SUBJECT, name).addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION);
            Intent chooser = Intent.createChooser(send, name).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK);
            c.startActivity(chooser);
            call.resolve();
        } catch (Exception e) {
            call.reject(e.getMessage());
        }
    }

    /** Paired meter, last record read, and the emergency-alarm texts, for MeterWatch/MeterReader. */
    @PluginMethod
    public void setMeterConfig(PluginCall call) {
        Context c = getContext();
        android.content.SharedPreferences p = AlarmScheduler.prefs(c);
        android.content.SharedPreferences.Editor e = p.edit();
        String id = call.getString("deviceId");
        Long last = call.getLong("lastSeq");
        if (id != null) {
            if (id.isEmpty()) {
                MeterWatch.stop(c);
                e.remove("meter_id").remove("meter_last_seq").remove("meter_pending");
            } else {
                if (!id.equals(p.getString("meter_id", ""))) e.putLong("meter_last_seq", last == null ? -1 : last);
                e.putString("meter_id", id);
            }
        }
        if (last != null && id != null && id.equals(p.getString("meter_id", ""))) e.putLong("meter_last_seq", Math.max(last, p.getLong("meter_last_seq", -1)));
        if (call.getData().has("crisis")) e.putString("crisis_texts", call.getData().optJSONObject("crisis").toString());
        if (call.getData().has("texts")) e.putString("meter_texts", call.getData().optJSONObject("texts").toString());
        Long busyUntil = call.getLong("busyUntil");
        if (busyUntil != null) e.putLong("meter_app_busy_until", busyUntil); // the app is reading the meter itself
        e.commit();
        if (id != null && !id.isEmpty()) {
            MeterWatch.start(c);
            GuardService.start(c); // holds the standing connection request (MeterLink)
        }
        call.resolve();
    }

    /** Results the phone read from the meter by itself since the app last looked (then forgotten). */
    @PluginMethod
    public void meterPending(PluginCall call) {
        android.content.SharedPreferences p = AlarmScheduler.prefs(getContext());
        JSObject r = new JSObject();
        synchronized (MeterReader.PENDING_LOCK) {
            try {
                r.put("records", new JSArray(p.getString("meter_pending", "[]")));
            } catch (Exception ex) {
                r.put("records", new JSArray());
            }
            p.edit().remove("meter_pending").commit(); // read and cleared together: nothing slips between
        }
        r.put("lastSeq", p.getLong("meter_last_seq", -1));
        r.put("lastSync", p.getLong("meter_last_sync", 0));
        r.put("link", p.getString("meter_link", ""));
        r.put("autoAt", p.getLong("meter_auto_at", 0));
        call.resolve(r);
    }

    /** The app hands over its login so SyncWorker can sync while the app is closed. Empty = stop. */
    @PluginMethod
    public void setSyncAuth(PluginCall call) {
        Context c = getContext();
        String refresh = call.getString("refreshToken", "");
        AlarmScheduler.prefs(c).edit()
                .putString("sync_refresh", refresh)
                .putString("sync_key", call.getString("apiKey", ""))
                .putString("sync_project", call.getString("projectId", ""))
                .putString("sync_family", call.getString("family", ""))
                .putString("sync_role", call.getString("role", ""))
                .apply();
        if (refresh.isEmpty()) {
            SyncWorker.stop(c);
            AlarmScheduler.prefs(c).edit().remove("sync_queue").apply();
        } else {
            SyncWorker.schedule(c);
            SyncWorker.now(c);
        }
        call.resolve();
    }

    /** A record just logged: also uploaded natively, so it reaches the family even if the app closes. */
    @PluginMethod
    public void queueRecord(PluginCall call) {
        try {
            SyncWorker.queue(getContext(), new JSONObject(call.getData().getJSONObject("rec").toString()));
        } catch (Exception ignored) {
            // nothing to queue
        }
        call.resolve();
    }

    /** This phone's Firebase push address, so family members can ring it. Resolves { token }. */
    @PluginMethod
    public void pushToken(PluginCall call) {
        try {
            com.google.firebase.messaging.FirebaseMessaging.getInstance().getToken().addOnCompleteListener(task -> {
                JSObject r = new JSObject();
                r.put("token", task.isSuccessful() ? task.getResult() : "");
                call.resolve(r);
            });
        } catch (Exception e) {
            JSObject r = new JSObject();
            r.put("token", "");
            call.resolve(r);
        }
    }

    /** Plays a recorded clip from res/raw by name. Resolves { ok }. */
    @PluginMethod
    public void playClip(PluginCall call) {
        Context c = getContext();
        int res = Clips.id(c, call.getString("name", ""));
        JSObject r = new JSObject();
        if (clipPlayer != null) {
            clipPlayer.release();
            clipPlayer = null;
        }
        android.media.MediaPlayer p = res == 0 ? null : Clips.player(c, res);
        if (p != null) {
            clipPlayer = p;
            p.setOnCompletionListener(mp -> {
                mp.release();
                if (clipPlayer == mp) clipPlayer = null;
            });
            p.start();
        }
        r.put("ok", p != null);
        call.resolve(r);
    }

    /** Reads Bangla text aloud. Resolves { ok, reason } so the app can offer a fix. */
    @PluginMethod
    public void speak(PluginCall call) {
        String text = call.getString("text", "");
        withTts((state) -> {
            JSObject r = new JSObject();
            if ("ok".equals(state)) {
                tts.speak(text, TextToSpeech.QUEUE_FLUSH, null, "say");
                r.put("ok", true);
            } else {
                r.put("ok", false);
                r.put("reason", state);
            }
            call.resolve(r);
        });
    }

    /** { bangla: ok | missing_data | not_supported | no_engine, google: installed? } */
    @PluginMethod
    public void voiceStatus(PluginCall call) {
        ttsReady = false; // re-check: the user may have just installed a voice
        withTts((state) -> {
            JSObject r = new JSObject();
            r.put("bangla", state);
            r.put("google", VoiceHelper.googleInstalled(getContext()));
            call.resolve(r);
        });
    }

    /** Opens the screen to get Google's engine or download its Bangla voice. */
    @PluginMethod
    public void voiceInstall(PluginCall call) {
        Context c = getContext();
        Intent i;
        if (!VoiceHelper.googleInstalled(c)) {
            i = new Intent(Intent.ACTION_VIEW, Uri.parse("market://details?id=" + VoiceHelper.GOOGLE));
        } else {
            i = new Intent(TextToSpeech.Engine.ACTION_INSTALL_TTS_DATA).setPackage(VoiceHelper.GOOGLE);
        }
        i.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK);
        try {
            c.startActivity(i);
        } catch (Exception e) {
            try {
                c.startActivity(new Intent("com.android.settings.TTS_SETTINGS").addFlags(Intent.FLAG_ACTIVITY_NEW_TASK));
            } catch (Exception ignored) {
                c.startActivity(new Intent(Intent.ACTION_VIEW, Uri.parse("https://play.google.com/store/apps/details?id=" + VoiceHelper.GOOGLE)).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK));
            }
        }
        call.resolve();
    }

    @Override
    protected void handleOnDestroy() {
        if (tts != null) tts.shutdown();
        super.handleOnDestroy();
    }
}
