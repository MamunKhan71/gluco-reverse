package com.family.sugarhelper;

import android.content.Context;
import android.content.Intent;

import com.google.firebase.messaging.FirebaseMessagingService;
import com.google.firebase.messaging.RemoteMessage;

import org.json.JSONObject;

import java.util.Map;

/**
 * A family member "rings" the patient's phone: a high-priority Firebase message arrives
 * (even with the app closed) and is shown as the same full-screen, sounding alarm as a dose.
 */
public class PushService extends FirebaseMessagingService {
    static final int RING_ID = 120;
    static final int CRISIS_ID = 140;

    @Override
    public void onMessageReceived(RemoteMessage msg) {
        Map<String, String> d = msg.getData();
        if ("sync".equals(d.get("type"))) {
            SyncWorker.now(this); // the family changed something: fetch it now
            return;
        }
        if (!"ring".equals(d.get("type")) && !"crisis".equals(d.get("type"))) return;
        // A ring that arrives late (phone was off for a long time) is no longer useful.
        long ts = parseLong(d.get("ts"));
        if (ts > 0 && System.currentTimeMillis() - ts > 15 * 60_000L) return;
        ring(this, d);
    }

    @Override
    public void onNewToken(String token) {
        // The app uploads it the next time it opens (see AlarmPlugin.pushToken).
        AlarmScheduler.prefs(this).edit().putString("fcm_token", token).putBoolean("fcm_token_new", true).apply();
    }

    static void ring(Context c, Map<String, String> d) {
        try {
            JSONObject item = new JSONObject();
            item.put("id", "crisis".equals(d.get("type")) ? CRISIS_ID : RING_ID);
            item.put("steps", value(d, "steps", ""));
            item.put("contacts", value(d, "contacts", "[]"));
            item.put("tone", value(d, "tone", ""));
            item.put("title", value(d, "title", "Message from family"));
            item.put("body", value(d, "body", ""));
            item.put("route", "home");
            item.put("repeat", false);
            item.put("clip", value(d, "clip", ""));
            item.put("voice", !"beep".equals(d.get("kind")));
            String lang = "en".equals(d.get("lang")) ? "en" : "bn";
            item.put("lang", lang);
            // a typed message has no recording: speak it with Google's free online voice
            item.put("fallbackClip", value(d, "fallbackClip", ""));
            if (Clips.ids(c, value(d, "clip", "")).length == 0 && !"beep".equals(d.get("kind"))) {
                String text = value(d, "title", "") + "। " + value(d, "body", "");
                if (text.length() > 195) text = value(d, "body", "");
                if (text.length() > 195) text = text.substring(0, 195);
                item.put("voiceUrl", "https://translate.google.com/translate_tts?ie=UTF-8&client=tw-ob&tl=" + lang
                        + "&q=" + java.net.URLEncoder.encode(text, "UTF-8"));
            }
            item.put("openLabel", value(d, "openLabel", "OK"));
            item.put("snoozeLabel", value(d, "snoozeLabel", "Later"));
            AlarmScheduler.putItem(c, item);
            long now = System.currentTimeMillis();
            c.sendBroadcast(new Intent(c, AlarmReceiver.class)
                    .putExtra("id", item.getInt("id")).putExtra("occurrence", now).putExtra("attempt", 0));
        } catch (Exception ignored) {
            // bad message: nothing to ring
        }
    }

    private static String value(Map<String, String> d, String key, String fallback) {
        String v = d.get(key);
        return v == null || v.isEmpty() ? fallback : v;
    }

    private static long parseLong(String s) {
        try {
            return Long.parseLong(s);
        } catch (Exception e) {
            return 0;
        }
    }
}
