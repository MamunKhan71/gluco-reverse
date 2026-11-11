package com.family.sugarhelper;

import android.animation.ObjectAnimator;
import android.animation.PropertyValuesHolder;
import android.animation.ValueAnimator;
import android.app.Activity;
import android.app.KeyguardManager;
import android.content.Intent;
import android.graphics.Color;
import android.graphics.Typeface;
import android.graphics.drawable.GradientDrawable;
import android.os.Build;
import android.os.Bundle;
import android.os.Handler;
import android.os.Looper;
import android.speech.tts.TextToSpeech;
import android.util.TypedValue;
import android.view.Gravity;
import android.view.View;
import android.view.WindowManager;
import android.widget.Button;
import android.widget.FrameLayout;
import android.widget.ImageView;
import android.widget.LinearLayout;
import android.widget.TextView;

import java.text.SimpleDateFormat;
import java.util.Date;
import java.util.Locale;

/** Full-screen alarm shown over the lock screen. The sound comes from the alarm notification. */
public class AlarmActivity extends Activity {
    private static java.lang.ref.WeakReference<AlarmActivity> showing;

    /** Closes the alarm screen for this alarm if it is open (answered from the notification). */
    static void closeIfShowing(int alarmId) {
        AlarmActivity a = showing == null ? null : showing.get();
        if (a != null && a.id == alarmId) a.runOnUiThread(a::stopAndFinish);
    }

    private final Handler handler = new Handler(Looper.getMainLooper());
    private TextToSpeech tts;
    private android.media.MediaPlayer player;
    private android.media.MediaPlayer voicePlayer;
    private int clipRes;
    private int[] clipList = new int[0]; // several recordings played one after another
    private int clipIndex;
    private int id;
    private long occurrence;
    private int attempt;
    private String route;
    private String speech;

    private String voiceUrl = "";
    private int fallbackRes;
    private String lang = "bn";
    private boolean voiceStarted;
    private boolean urgent; // dangerous sugar: loud tone; everything else: the soft chime, fading in
    private float volume = 0.25f;
    private final Runnable fadeIn = new Runnable() {
        @Override
        public void run() {
            if (player == null) return;
            volume = Math.min(urgent ? 1f : 0.8f, volume + 0.08f);
            try {
                player.setVolume(volume, volume);
            } catch (Exception ignored) {
                return;
            }
            if (volume < (urgent ? 1f : 0.8f)) handler.postDelayed(this, 2500);
        }
    };

    // The voice comes first, then the alarm tone; the voice repeats every 25 s over the tone.
    private final Runnable sayAgain = new Runnable() {
        @Override
        public void run() {
            say();
            handler.postDelayed(this, 45_000);
        }
    };

    // Safety net: if no voice has started after a few seconds, ring anyway.
    private final Runnable toneIfSilent = () -> {
        if (!voiceStarted) startTone();
    };

    @Override
    protected void onCreate(Bundle state) {
        super.onCreate(state);
        if (Build.VERSION.SDK_INT >= 27) {
            setShowWhenLocked(true);
            setTurnScreenOn(true);
        } else {
            getWindow().addFlags(WindowManager.LayoutParams.FLAG_SHOW_WHEN_LOCKED | WindowManager.LayoutParams.FLAG_TURN_SCREEN_ON);
        }
        getWindow().addFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON);

        Intent in = getIntent();
        id = in.getIntExtra("id", -1);
        route = in.getStringExtra("route");
        String title = in.getStringExtra("title");
        String body = in.getStringExtra("body");
        speech = title + "। " + body;
        showing = new java.lang.ref.WeakReference<>(this);
        occurrence = in.getLongExtra("occurrence", System.currentTimeMillis());
        attempt = in.getIntExtra("attempt", 0);
        String steps = in.getStringExtra("steps");
        urgent = steps != null && !steps.isEmpty();
        if (steps != null && !steps.isEmpty()) {
            setContentView(buildCrisisUi(title, body, steps, in.getStringExtra("contacts"), in.getStringExtra("tone"),
                    in.getStringExtra("openLabel"), in.getStringExtra("snoozeLabel")));
        } else {
            setContentView(buildUi(title, body, in.getStringExtra("openLabel"), in.getStringExtra("snoozeLabel")));
        }

        // Play the alarm tone here (looping) and silence the notification's own tone,
        // so the voice can be heard first and the tone can pause while it speaks.
        try {
            player = new android.media.MediaPlayer();
            player.setAudioAttributes(new android.media.AudioAttributes.Builder()
                    .setUsage(android.media.AudioAttributes.USAGE_ALARM)
                    .setContentType(android.media.AudioAttributes.CONTENT_TYPE_SONIFICATION).build());
            player.setDataSource(this, urgent ? AlarmReceiver.urgentSound() : AlarmReceiver.softChime(this));
            player.setLooping(true);
            player.prepare();
            if (!urgent) player.setVolume(volume, volume);
            AlarmScheduler.dismissNotification(this, id);
        } catch (Exception e) {
            player = null; // keep the notification's tone instead
        }

        clipList = Clips.ids(this, in.getStringExtra("clip"));
        clipRes = clipList.length > 0 ? clipList[0] : 0;
        voiceUrl = in.getStringExtra("voiceUrl") == null ? "" : in.getStringExtra("voiceUrl");
        lang = "en".equals(in.getStringExtra("lang")) ? "en" : "bn";
        fallbackRes = Clips.id(this, in.getStringExtra("fallbackClip"));
        boolean voice = AlarmScheduler.voice(this) && in.getBooleanExtra("voice", true);
        if (voice && clipRes == 0 && voiceUrl.isEmpty()) initTts(); // no recording: the phone's own voice
        if (voice) {
            handler.postDelayed(sayAgain, 400);
            handler.postDelayed(toneIfSilent, 6000);
        } else {
            startTone();
        }
        // Stop ringing after 2 minutes if nobody answers; the repeat alarm comes back later.
        handler.postDelayed(this::stopAndFinish, urgent ? 120_000 : 60_000);
    }

    private void startTone() {
        if (player != null && !player.isPlaying() && (voicePlayer == null || !voicePlayer.isPlaying())) {
            player.start();
            handler.removeCallbacks(fadeIn);
            handler.postDelayed(fadeIn, 2500);
        }
    }

    private void pauseTone() {
        if (player != null && player.isPlaying()) player.pause();
    }

    /** One spoken message: recorded clip, else online voice, else the phone's text-to-speech. */
    private void say() {
        if (voicePlayer != null && voicePlayer.isPlaying()) return; // still speaking the last round
        if (clipList.length > 1) {
            clipIndex = 0;
            playNextClip();
        } else if (clipRes != 0) {
            playVoice(Clips.player(this, clipRes));
        } else if (!voiceUrl.isEmpty()) {
            playUrl();
        } else if (tts != null) {
            Bundle p = new Bundle();
            p.putInt(TextToSpeech.Engine.KEY_PARAM_STREAM, android.media.AudioManager.STREAM_ALARM);
            tts.speak(speech, TextToSpeech.QUEUE_FLUSH, p, "alarm");
        }
    }

    private void playNextClip() {
        if (clipIndex >= clipList.length) {
            startTone();
            return;
        }
        android.media.MediaPlayer p = Clips.player(this, clipList[clipIndex++]);
        if (p == null) {
            playNextClip();
            return;
        }
        if (voicePlayer != null) voicePlayer.release();
        voicePlayer = p;
        pauseTone();
        voiceStarted = true;
        p.setOnCompletionListener(mp -> handler.postDelayed(this::playNextClip, 350));
        p.start();
    }

    private void playVoice(android.media.MediaPlayer p) {
        if (voicePlayer != null) voicePlayer.release();
        voicePlayer = p;
        if (p == null) {
            startTone();
            return;
        }
        pauseTone();
        voiceStarted = true;
        p.setOnCompletionListener(mp -> startTone());
        p.start();
    }

    // Typed message from family: a free online Google voice (no Bangla voice needed on the phone).
    private void playUrl() {
        try {
            android.media.MediaPlayer p = new android.media.MediaPlayer();
            p.setAudioAttributes(new android.media.AudioAttributes.Builder()
                    .setUsage(android.media.AudioAttributes.USAGE_ALARM)
                    .setContentType(android.media.AudioAttributes.CONTENT_TYPE_SPEECH).build());
            java.util.Map<String, String> headers = new java.util.HashMap<>();
            headers.put("User-Agent", "Mozilla/5.0");
            p.setDataSource(this, android.net.Uri.parse(voiceUrl), headers);
            p.setOnPreparedListener(this::playVoice);
            p.setOnErrorListener((mp, what, extra) -> {
                // offline or blocked: the recorded "message from family", else the phone's own voice
                voiceUrl = "";
                mp.release();
                if (voicePlayer == mp) voicePlayer = null;
                if (fallbackRes != 0) {
                    clipRes = fallbackRes;
                    say();
                } else {
                    initTts();
                }
                return true;
            });
            if (voicePlayer != null) voicePlayer.release();
            voicePlayer = p;
            p.prepareAsync();
        } catch (Exception e) {
            voiceUrl = "";
            initTts();
        }
    }

    private void initTts() {
        if (tts != null) return;
        tts = VoiceHelper.create(this, status -> {
            if (status != TextToSpeech.SUCCESS) {
                startTone();
                return;
            }
            if ("en".equals(lang)) {
                tts.setLanguage(java.util.Locale.US);
            } else if (!"ok".equals(VoiceHelper.useBangla(tts))) {
                startTone();
                return;
            }
            tts.setOnUtteranceProgressListener(new android.speech.tts.UtteranceProgressListener() {
                @Override
                public void onStart(String utteranceId) {
                    handler.post(() -> {
                        voiceStarted = true;
                        pauseTone();
                    });
                }

                @Override
                public void onDone(String utteranceId) {
                    handler.post(AlarmActivity.this::startTone);
                }

                @Override
                public void onError(String utteranceId) {
                    onDone(utteranceId);
                }
            });
            say();
        });
    }

    private int dp(float v) {
        return (int) TypedValue.applyDimension(TypedValue.COMPLEX_UNIT_DIP, v, getResources().getDisplayMetrics());
    }

    private View buildUi(String title, String body, String openLabel, String snoozeLabel) {
        LinearLayout root = new LinearLayout(this);
        root.setOrientation(LinearLayout.VERTICAL);
        root.setGravity(Gravity.CENTER);
        root.setPadding(dp(28), dp(48), dp(28), dp(40));
        GradientDrawable bg = new GradientDrawable(GradientDrawable.Orientation.TL_BR, new int[] {0xFF4F6CF6, 0xFF6A4FF0, 0xFF8B4DE8});
        root.setBackground(bg);

        FrameLayout badge = new FrameLayout(this);
        GradientDrawable circle = new GradientDrawable();
        circle.setShape(GradientDrawable.OVAL);
        circle.setColor(0x33FFFFFF);
        badge.setBackground(circle);
        ImageView drop = new ImageView(this);
        drop.setImageResource(R.drawable.ic_stat_drop);
        FrameLayout.LayoutParams dropLp = new FrameLayout.LayoutParams(dp(64), dp(64), Gravity.CENTER);
        badge.addView(drop, dropLp);
        root.addView(badge, new LinearLayout.LayoutParams(dp(132), dp(132)));
        ObjectAnimator pulse = ObjectAnimator.ofPropertyValuesHolder(badge,
                PropertyValuesHolder.ofFloat(View.SCALE_X, 1f, 1.12f), PropertyValuesHolder.ofFloat(View.SCALE_Y, 1f, 1.12f));
        pulse.setDuration(700);
        pulse.setRepeatCount(ValueAnimator.INFINITE);
        pulse.setRepeatMode(ValueAnimator.REVERSE);
        pulse.start();

        root.addView(text(new SimpleDateFormat("HH:mm", Locale.US).format(new Date()), 64, true, 1f), wrap(dp(20)));
        root.addView(text(title, 30, true, 1f), wrap(dp(8)));
        root.addView(text(body, 21, false, 0.92f), wrap(dp(10)));

        View spacer = new View(this);
        root.addView(spacer, new LinearLayout.LayoutParams(1, 0, 1f));

        String takenLabel = getIntent().getStringExtra("takenLabel");
        if (takenLabel != null && !takenLabel.isEmpty()) {
            // a dose: answer it here (taken / later / skip), no need to open the app
            Button taken = button(takenLabel, Color.WHITE, 0xFF1E8E5A, 0);
            taken.setOnClickListener(v -> {
                silence();
                AlarmScheduler.doseAction(this, id, true);
                finish();
            });
            root.addView(taken, full(dp(76), 0));
            LinearLayout row = new LinearLayout(this);
            row.setOrientation(LinearLayout.HORIZONTAL);
            Button s30 = button(getIntent().getStringExtra("snooze30Label"), Color.TRANSPARENT, Color.WHITE, 0xCCFFFFFF);
            Button s60 = button(getIntent().getStringExtra("snooze60Label"), Color.TRANSPARENT, Color.WHITE, 0xCCFFFFFF);
            s30.setOnClickListener(v -> snoozeFor(30));
            s60.setOnClickListener(v -> snoozeFor(60));
            LinearLayout.LayoutParams half = new LinearLayout.LayoutParams(0, dp(64), 1f);
            LinearLayout.LayoutParams half2 = new LinearLayout.LayoutParams(0, dp(64), 1f);
            half2.leftMargin = dp(12);
            row.addView(s30, half);
            row.addView(s60, half2);
            root.addView(row, full(dp(64), dp(14)));
            Button skip = button(getIntent().getStringExtra("skipLabel"), Color.TRANSPARENT, 0xDDFFFFFF, 0);
            skip.setOnClickListener(v -> {
                silence();
                AlarmScheduler.doseAction(this, id, false);
                finish();
            });
            root.addView(skip, full(dp(52), dp(8)));
            Button open = button(openLabel, Color.TRANSPARENT, 0xBBFFFFFF, 0);
            open.setTextSize(TypedValue.COMPLEX_UNIT_SP, 17);
            open.setOnClickListener(v -> openApp());
            root.addView(open, full(dp(48), dp(2)));
            return root;
        }
        Button open = button(openLabel, Color.WHITE, 0xFF4B3FD8, 0);
        open.setOnClickListener(v -> openApp());
        root.addView(open, full(dp(76), 0));
        Button later = button(snoozeLabel, Color.TRANSPARENT, Color.WHITE, 0xCCFFFFFF);
        later.setOnClickListener(v -> stopAndFinish());
        root.addView(later, full(dp(64), dp(14)));
        return root;
    }

    /** Sugar emergency: what to do now, step by step, and one-tap calls to the emergency contacts. */
    private View buildCrisisUi(String title, String body, String steps, String contactsJson, String tone, String openLabel, String snoozeLabel) {
        int[] colors = "high".equals(tone)
                ? new int[] {0xFFE8590C, 0xFFD9480F, 0xFFC92A2A}
                : new int[] {0xFFE03131, 0xFFC92A2A, 0xFFA61E4D};
        android.widget.ScrollView scroll = new android.widget.ScrollView(this);
        scroll.setFillViewport(true);
        scroll.setBackground(new GradientDrawable(GradientDrawable.Orientation.TL_BR, colors));
        LinearLayout root = new LinearLayout(this);
        root.setOrientation(LinearLayout.VERTICAL);
        root.setPadding(dp(22), dp(36), dp(22), dp(28));
        scroll.addView(root, new android.widget.ScrollView.LayoutParams(-1, -2));

        TextView badge = text("⚠", 44, true, 1f);
        root.addView(badge, wrapCenter(0));
        TextView head = text(title, 28, true, 1f);
        root.addView(head, fullWrap(dp(6)));
        if (body != null && !body.isEmpty()) root.addView(text(body, 18, false, 0.95f), fullWrap(dp(6)));

        // numbered steps on a translucent card
        LinearLayout card = new LinearLayout(this);
        card.setOrientation(LinearLayout.VERTICAL);
        card.setPadding(dp(16), dp(14), dp(16), dp(14));
        GradientDrawable cardBg = new GradientDrawable();
        cardBg.setCornerRadius(dp(22));
        cardBg.setColor(0x26FFFFFF);
        card.setBackground(cardBg);
        String[] lines = steps.split("\n");
        for (int i = 0; i < lines.length; i++) {
            // "S|" must do, "W|" warning, "E|" emergency
            String line = lines[i];
            char tag = line.length() > 2 && line.charAt(1) == '|' ? line.charAt(0) : 'S';
            String txt = line.length() > 2 && line.charAt(1) == '|' ? line.substring(2) : line;
            String prefix = tag == 'E' ? "🚑  " : tag == 'W' ? "⚠  " : (i + 1) + ".  ";
            TextView step = text(prefix + txt, 18, tag == 'E', 1f);
            step.setGravity(Gravity.START);
            step.setLineSpacing(0, 1.15f);
            if (tag != 'S') {
                GradientDrawable hl = new GradientDrawable();
                hl.setCornerRadius(dp(14));
                hl.setColor(tag == 'E' ? 0x55000000 : 0x33FFE066);
                step.setBackground(hl);
                step.setPadding(dp(12), dp(10), dp(12), dp(10));
            }
            card.addView(step, fullWrap(i == 0 ? 0 : dp(10)));
        }
        root.addView(card, fullWrap(dp(18)));

        // call buttons
        try {
            org.json.JSONArray contacts = new org.json.JSONArray(contactsJson == null ? "[]" : contactsJson);
            for (int i = 0; i < contacts.length(); i++) {
                org.json.JSONObject ct = contacts.getJSONObject(i);
                String phone = ct.optString("phone");
                if (phone.isEmpty()) continue;
                boolean first = i == 0;
                Button call = button("📞  " + ct.optString("name", phone), first ? Color.WHITE : 0x33FFFFFF, first ? colors[1] : Color.WHITE, first ? 0 : 0xCCFFFFFF);
                call.setOnClickListener(v -> {
                    silence();
                    startActivity(new Intent(Intent.ACTION_DIAL, android.net.Uri.parse("tel:" + phone)).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK));
                });
                root.addView(call, full(dp(64), dp(i == 0 ? 18 : 10)));
            }
        } catch (Exception ignored) {
            // no contacts: just the steps
        }

        Button open = button(openLabel, Color.TRANSPARENT, Color.WHITE, 0xCCFFFFFF);
        open.setOnClickListener(v -> openApp());
        root.addView(open, full(dp(60), dp(18)));
        Button later = button(snoozeLabel, Color.TRANSPARENT, 0xDDFFFFFF, 0);
        later.setOnClickListener(v -> stopAndFinish());
        root.addView(later, full(dp(52), dp(6)));
        return scroll;
    }

    private LinearLayout.LayoutParams fullWrap(int top) {
        LinearLayout.LayoutParams lp = new LinearLayout.LayoutParams(LinearLayout.LayoutParams.MATCH_PARENT, LinearLayout.LayoutParams.WRAP_CONTENT);
        lp.topMargin = top;
        return lp;
    }

    private LinearLayout.LayoutParams wrapCenter(int top) {
        LinearLayout.LayoutParams lp = wrap(top);
        lp.gravity = Gravity.CENTER_HORIZONTAL;
        return lp;
    }

    private TextView text(String s, int sp, boolean bold, float alpha) {
        TextView t = new TextView(this);
        t.setText(s);
        t.setTextSize(TypedValue.COMPLEX_UNIT_SP, sp);
        t.setTextColor(Color.WHITE);
        t.setAlpha(alpha);
        t.setGravity(Gravity.CENTER);
        if (bold) t.setTypeface(Typeface.DEFAULT_BOLD);
        return t;
    }

    private Button button(String label, int fill, int textColor, int stroke) {
        Button b = new Button(this);
        b.setText(label);
        b.setAllCaps(false);
        b.setTextSize(TypedValue.COMPLEX_UNIT_SP, 22);
        b.setTypeface(Typeface.DEFAULT_BOLD);
        b.setTextColor(textColor);
        GradientDrawable d = new GradientDrawable();
        d.setCornerRadius(dp(24));
        d.setColor(fill);
        if (stroke != 0) d.setStroke(dp(2), stroke);
        b.setBackground(d);
        b.setStateListAnimator(null);
        return b;
    }

    private LinearLayout.LayoutParams wrap(int top) {
        LinearLayout.LayoutParams lp = new LinearLayout.LayoutParams(LinearLayout.LayoutParams.WRAP_CONTENT, LinearLayout.LayoutParams.WRAP_CONTENT);
        lp.topMargin = top;
        return lp;
    }

    private LinearLayout.LayoutParams full(int height, int top) {
        LinearLayout.LayoutParams lp = new LinearLayout.LayoutParams(LinearLayout.LayoutParams.MATCH_PARENT, height);
        lp.topMargin = top;
        return lp;
    }

    private void silence() {
        AlarmScheduler.dismissNotification(this, id);
        handler.removeCallbacksAndMessages(null);
        if (tts != null) tts.stop();
        if (voicePlayer != null) {
            voicePlayer.release();
            voicePlayer = null;
        }
        if (player != null) {
            player.release();
            player = null;
        }
    }

    private void openApp() {
        silence();
        Intent i = new Intent(this, MainActivity.class).putExtra("route", route)
                .addFlags(Intent.FLAG_ACTIVITY_NEW_TASK | Intent.FLAG_ACTIVITY_SINGLE_TOP);
        if (Build.VERSION.SDK_INT >= 26) {
            KeyguardManager km = getSystemService(KeyguardManager.class);
            km.requestDismissKeyguard(this, null);
        }
        startActivity(i);
        finish();
    }

    private void snoozeFor(int minutes) {
        silence();
        AlarmScheduler.snooze(this, id, minutes, occurrence, attempt);
        finish();
    }

    private void stopAndFinish() {
        silence();
        finish();
    }

    @Override
    protected void onDestroy() {
        handler.removeCallbacksAndMessages(null);
        if (tts != null) tts.shutdown();
        if (voicePlayer != null) {
            voicePlayer.release();
            voicePlayer = null;
        }
        if (player != null) {
            player.release();
            player = null;
        }
        super.onDestroy();
    }
}
