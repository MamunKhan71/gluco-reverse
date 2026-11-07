package com.family.sugarhelper;

import android.content.Context;
import android.content.SharedPreferences;

import androidx.annotation.NonNull;
import androidx.work.Constraints;
import androidx.work.ExistingPeriodicWorkPolicy;
import androidx.work.ExistingWorkPolicy;
import androidx.work.NetworkType;
import androidx.work.OneTimeWorkRequest;
import androidx.work.PeriodicWorkRequest;
import androidx.work.WorkManager;
import androidx.work.Worker;
import androidx.work.WorkerParameters;

import org.json.JSONArray;
import org.json.JSONObject;

import java.io.ByteArrayOutputStream;
import java.io.InputStream;
import java.io.OutputStream;
import java.net.HttpURLConnection;
import java.net.URL;
import java.net.URLEncoder;
import java.nio.charset.StandardCharsets;
import java.util.Calendar;
import java.util.Iterator;
import java.util.concurrent.TimeUnit;

/**
 * Keeps the family in sync while the app is closed (Firestore REST, signed in with the
 * login the app handed over): uploads records saved offline, applies plan changes made by
 * the family to the alarms, marks doses already logged on another phone, and says "alive".
 * Runs every 15 minutes, as soon as the internet returns, and when the family pushes a change.
 */
public class SyncWorker extends Worker {
    private static final String PERIODIC = "sync_periodic";
    private static final String NOW = "sync_now";

    public SyncWorker(@NonNull Context c, @NonNull WorkerParameters p) {
        super(c, p);
    }

    private static Constraints online() {
        return new Constraints.Builder().setRequiredNetworkType(NetworkType.CONNECTED).build();
    }

    static void schedule(Context c) {
        if (!enabled(c)) return;
        PeriodicWorkRequest req = new PeriodicWorkRequest.Builder(SyncWorker.class, 15, TimeUnit.MINUTES).setConstraints(online()).build();
        WorkManager.getInstance(c).enqueueUniquePeriodicWork(PERIODIC, ExistingPeriodicWorkPolicy.KEEP, req);
    }

    /** Sync once, as soon as there is internet. */
    static void now(Context c) {
        if (!enabled(c)) return;
        OneTimeWorkRequest req = new OneTimeWorkRequest.Builder(SyncWorker.class).setConstraints(online()).build();
        // APPEND_OR_REPLACE: never cancel an upload half way; run again after it.
        WorkManager.getInstance(c).enqueueUniqueWork(NOW, ExistingWorkPolicy.APPEND_OR_REPLACE, req);
    }

    static void stop(Context c) {
        WorkManager.getInstance(c).cancelUniqueWork(PERIODIC);
        WorkManager.getInstance(c).cancelUniqueWork(NOW);
    }

    private static boolean enabled(Context c) {
        SharedPreferences p = AlarmScheduler.prefs(c);
        return !p.getString("sync_refresh", "").isEmpty() && !p.getString("sync_family", "").isEmpty();
    }

    /** A record logged in the app; uploaded here too in case the app closes before it reaches the cloud. */
    /** One reader/writer of the upload queue at a time (app thread, Bluetooth thread, worker). */
    static final Object QUEUE_LOCK = new Object();

    static void queue(Context c, JSONObject rec) {
        try {
            synchronized (QUEUE_LOCK) {
                SharedPreferences p = AlarmScheduler.prefs(c);
                JSONObject q = new JSONObject(p.getString("sync_queue", "{}"));
                q.put(rec.getString("id"), rec);
                p.edit().putString("sync_queue", q.toString()).commit();
            }
        } catch (Exception ignored) {
            // a record without an id cannot be uploaded
        }
        now(c);
    }

    @NonNull
    @Override
    public Result doWork() {
        Context c = getApplicationContext();
        SharedPreferences p = AlarmScheduler.prefs(c);
        String family = p.getString("sync_family", "");
        String project = p.getString("sync_project", "");
        if (family.isEmpty() || project.isEmpty()) return Result.success();
        try {
            String token = idToken(p);
            if (token == null) return Result.retry();
            String docs = "https://firestore.googleapis.com/v1/projects/" + project + "/databases/(default)/documents/families/" + family;

            uploadQueue(p, docs, token);
            applyPlan(c, p, docs, token);
            confirmLoggedDoses(c, docs, token);
            if (!"caregiver".equals(p.getString("sync_role", ""))) {
                JSONObject alive = new JSONObject().put("bgSync", System.currentTimeMillis());
                http("POST", docs + "/meta/presence?updateMask.fieldPaths=bgSync", token, new JSONObject().put("fields", toFields(alive)), true);
            }
            return Result.success();
        } catch (Exception e) {
            return Result.retry();
        }
    }

    // Exchanges the saved Firebase refresh token for a fresh ID token.
    private static String idToken(SharedPreferences p) throws Exception {
        String body = "grant_type=refresh_token&refresh_token=" + URLEncoder.encode(p.getString("sync_refresh", ""), "UTF-8");
        HttpURLConnection con = (HttpURLConnection) new URL("https://securetoken.googleapis.com/v1/token?key=" + p.getString("sync_key", "")).openConnection();
        con.setRequestMethod("POST");
        con.setDoOutput(true);
        con.setConnectTimeout(15_000);
        con.setReadTimeout(15_000);
        con.setRequestProperty("Content-Type", "application/x-www-form-urlencoded");
        try (OutputStream o = con.getOutputStream()) {
            o.write(body.getBytes(StandardCharsets.UTF_8));
        }
        if (con.getResponseCode() != 200) return null;
        JSONObject r = new JSONObject(read(con.getInputStream()));
        p.edit().putString("sync_refresh", r.optString("refresh_token", p.getString("sync_refresh", ""))).apply();
        return r.optString("id_token", null);
    }

    private static void uploadQueue(SharedPreferences p, String docs, String token) throws Exception {
        JSONObject q;
        synchronized (QUEUE_LOCK) {
            q = new JSONObject(p.getString("sync_queue", "{}"));
        }
        if (q.length() == 0) return;
        JSONObject left = new JSONObject();
        Iterator<String> ids = q.keys();
        while (ids.hasNext()) {
            String id = ids.next();
            JSONObject rec = q.getJSONObject(id);
            String url = docs + "/records/" + URLEncoder.encode(id, "UTF-8");
            // A meter reading is only created here, never overwritten: once the app has saved it
            // (maybe already given to a family member), the app's copy is the one that counts.
            boolean createOnly = id.startsWith("meter-");
            if (createOnly) url += "?currentDocument.exists=false";
            if (http("POST", url, token, new JSONObject().put("fields", toFields(rec)), true) == null) {
                boolean alreadyThere = createOnly && (lastCode == 400 || lastCode == 409);
                if (!alreadyThere) left.put(id, rec);
            }
        }
        synchronized (QUEUE_LOCK) {
            // Drop only what went up unchanged; anything queued or changed meanwhile stays.
            JSONObject now = new JSONObject(p.getString("sync_queue", "{}"));
            Iterator<String> sent = q.keys();
            while (sent.hasNext()) {
                String id = sent.next();
                if (left.has(id)) continue;
                JSONObject cur = now.optJSONObject(id);
                if (cur != null && cur.toString().equals(q.getJSONObject(id).toString())) now.remove(id);
            }
            p.edit().putString("sync_queue", now.toString()).commit();
        }
    }

    // A plan changed by the family: move the alarms to the new times and units.
    private static void applyPlan(Context c, SharedPreferences p, String docs, String token) throws Exception {
        String raw = http("GET", docs + "/meta/plan", token, null, false);
        if (raw == null) return;
        JSONObject plan = fromFields(new JSONObject(raw).optJSONObject("fields"));
        long updated = plan.optLong("updatedAt", 0);
        if (updated <= p.getLong("plan_updated", 0)) return;

        double basal = -1;
        String st = http("GET", docs + "/meta/state", token, null, false);
        if (st != null) {
            JSONObject b = fromFields(new JSONObject(st).optJSONObject("fields")).optJSONObject("basal");
            if (b != null && b.has("current")) basal = b.optDouble("current");
        }

        JSONArray doses = plan.optJSONArray("doses");
        JSONArray ids = new JSONArray(p.getString("daily_ids", "[]"));
        for (int i = 0; i < ids.length(); i++) {
            JSONObject item = AlarmScheduler.getItem(c, ids.getInt(i));
            if (item == null) continue;
            String slot = item.optString("slot", item.optString("checkSlot"));
            if (slot.isEmpty()) continue;
            String time = null;
            double units = -1;
            if ("snack".equals(slot)) {
                time = plan.optString("snackAt", null);
            } else if (doses != null) {
                for (int j = 0; j < doses.length(); j++) {
                    JSONObject d = doses.getJSONObject(j);
                    if (!slot.equals(d.optString("id"))) continue;
                    time = d.optString("injectAt", null);
                    units = "basal".equals(d.optString("kind")) && basal >= 0 ? basal : d.optDouble("base", -1);
                }
            }
            if (time == null || !time.matches("\\d{1,2}:\\d{2}")) continue;
            String[] hm = time.split(":");
            int h = Integer.parseInt(hm[0]);
            int m = Integer.parseInt(hm[1]);
            if (item.has("checkSlot")) {
                item.put("doseHour", h);
                item.put("doseMinute", m);
                int at = h * 60 + m + item.optInt("checkAfter", 30);
                h = (at / 60) % 24;
                m = at % 60;
            }
            item.put("hour", h);
            item.put("minute", m);
            if (units >= 0 && item.has("bodyTpl") && !item.has("checkSlot")) {
                String u = units == Math.floor(units) ? String.valueOf((long) units) : String.valueOf(units);
                item.put("body", item.getString("bodyTpl").replace("{u}", u));
            }
            AlarmScheduler.putItem(c, item);
            long at = AlarmScheduler.nextDaily(item.getInt("hour"), item.getInt("minute"));
            AlarmScheduler.scheduleFire(c, item.getInt("id"), at, 0, at);
        }
        p.edit().putLong("plan_updated", updated).apply();
    }

    /** For the family's 30-min check: fetch today's doses now; true if this one was logged. */
    static boolean doseDone(Context c, JSONObject item) {
        Calendar cal = Calendar.getInstance();
        cal.set(Calendar.HOUR_OF_DAY, item.optInt("doseHour"));
        cal.set(Calendar.MINUTE, item.optInt("doseMinute"));
        cal.set(Calendar.SECOND, 0);
        cal.set(Calendar.MILLISECOND, 0);
        int doseId = item.optInt("checkDose");
        try {
            SharedPreferences p = AlarmScheduler.prefs(c);
            String family = p.getString("sync_family", "");
            String project = p.getString("sync_project", "");
            String token = family.isEmpty() ? null : idToken(p);
            if (token != null) {
                confirmLoggedDoses(c, "https://firestore.googleapis.com/v1/projects/" + project + "/databases/(default)/documents/families/" + family, token);
            }
        } catch (Exception ignored) {
            // offline: decide from what we already know
        }
        return AlarmScheduler.isConfirmed(c, doseId, cal.getTimeInMillis());
    }

    // Doses logged today (on this phone or another) must not ring again.
    private static void confirmLoggedDoses(Context c, String docs, String token) throws Exception {
        Calendar cal = Calendar.getInstance();
        cal.set(Calendar.HOUR_OF_DAY, 0);
        cal.set(Calendar.MINUTE, 0);
        cal.set(Calendar.SECOND, 0);
        cal.set(Calendar.MILLISECOND, 0);
        JSONObject query = new JSONObject().put("structuredQuery", new JSONObject()
                .put("from", new JSONArray().put(new JSONObject().put("collectionId", "records")))
                .put("where", new JSONObject().put("fieldFilter", new JSONObject()
                        .put("field", new JSONObject().put("fieldPath", "ts"))
                        .put("op", "GREATER_THAN_OR_EQUAL")
                        .put("value", new JSONObject().put("integerValue", String.valueOf(cal.getTimeInMillis()))))));
        String raw = http("POST", docs + ":runQuery", token, query, false);
        if (raw == null) return;
        JSONArray rows = new JSONArray(raw);
        JSONArray ids = new JSONArray(AlarmScheduler.prefs(c).getString("daily_ids", "[]"));
        for (int i = 0; i < rows.length(); i++) {
            JSONObject doc = rows.getJSONObject(i).optJSONObject("document");
            if (doc == null) continue;
            JSONObject rec = fromFields(doc.optJSONObject("fields"));
            if (!"dose".equals(rec.optString("type")) || rec.optBoolean("deleted")) continue;
            for (int j = 0; j < ids.length(); j++) {
                JSONObject item = AlarmScheduler.getItem(c, ids.getInt(j));
                if (item != null && rec.optString("slot").equals(item.optString("slot"))) {
                    AlarmScheduler.confirm(c, item.getInt("id"), rec.optLong("ts"));
                }
            }
        }
    }

    // --- HTTP and Firestore value conversion ------------------------------------------------

    /** Returns the response body, or null if the request failed. patch=true sends a PATCH. */
    private static int lastCode = 0;

    private static String http(String method, String url, String token, JSONObject body, boolean patch) throws Exception {
        HttpURLConnection con = (HttpURLConnection) new URL(url).openConnection();
        con.setRequestMethod(method);
        con.setConnectTimeout(15_000);
        con.setReadTimeout(20_000);
        con.setRequestProperty("Authorization", "Bearer " + token);
        if (patch) con.setRequestProperty("X-HTTP-Method-Override", "PATCH");
        if (body != null) {
            con.setDoOutput(true);
            con.setRequestProperty("Content-Type", "application/json; charset=utf-8");
            try (OutputStream o = con.getOutputStream()) {
                o.write(body.toString().getBytes(StandardCharsets.UTF_8));
            }
        }
        int code = con.getResponseCode();
        lastCode = code;
        if (code < 200 || code >= 300) return null;
        return read(con.getInputStream());
    }

    private static String read(InputStream in) throws Exception {
        ByteArrayOutputStream out = new ByteArrayOutputStream();
        byte[] buf = new byte[8192];
        int n;
        while ((n = in.read(buf)) > 0) out.write(buf, 0, n);
        in.close();
        return out.toString("UTF-8");
    }

    private static JSONObject toFields(JSONObject o) throws Exception {
        JSONObject f = new JSONObject();
        Iterator<String> keys = o.keys();
        while (keys.hasNext()) {
            String k = keys.next();
            f.put(k, toValue(o.get(k)));
        }
        return f;
    }

    private static JSONObject toValue(Object v) throws Exception {
        JSONObject r = new JSONObject();
        if (v == null || v == JSONObject.NULL) r.put("nullValue", JSONObject.NULL);
        else if (v instanceof Boolean) r.put("booleanValue", v);
        else if (v instanceof Integer || v instanceof Long) r.put("integerValue", String.valueOf(v));
        else if (v instanceof Number) r.put("doubleValue", ((Number) v).doubleValue());
        else if (v instanceof JSONObject) r.put("mapValue", new JSONObject().put("fields", toFields((JSONObject) v)));
        else if (v instanceof JSONArray) {
            JSONArray a = (JSONArray) v;
            JSONArray vals = new JSONArray();
            for (int i = 0; i < a.length(); i++) vals.put(toValue(a.get(i)));
            r.put("arrayValue", new JSONObject().put("values", vals));
        } else r.put("stringValue", String.valueOf(v));
        return r;
    }

    private static JSONObject fromFields(JSONObject f) throws Exception {
        JSONObject o = new JSONObject();
        if (f == null) return o;
        Iterator<String> keys = f.keys();
        while (keys.hasNext()) {
            String k = keys.next();
            o.put(k, fromValue(f.getJSONObject(k)));
        }
        return o;
    }

    private static Object fromValue(JSONObject v) throws Exception {
        if (v.has("stringValue")) return v.getString("stringValue");
        if (v.has("integerValue")) return Long.parseLong(v.getString("integerValue"));
        if (v.has("doubleValue")) return v.getDouble("doubleValue");
        if (v.has("booleanValue")) return v.getBoolean("booleanValue");
        if (v.has("mapValue")) return fromFields(v.getJSONObject("mapValue").optJSONObject("fields"));
        if (v.has("arrayValue")) {
            JSONArray vals = v.getJSONObject("arrayValue").optJSONArray("values");
            JSONArray a = new JSONArray();
            if (vals != null) for (int i = 0; i < vals.length(); i++) a.put(fromValue(vals.getJSONObject(i)));
            return a;
        }
        return JSONObject.NULL;
    }
}
