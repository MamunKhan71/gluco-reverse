package com.family.sugarhelper;

import android.content.Context;
import android.content.pm.PackageManager;
import android.speech.tts.TextToSpeech;
import android.speech.tts.Voice;

import java.util.Locale;
import java.util.Set;

/**
 * Bangla text-to-speech. Many phones default to the maker's engine (Samsung, Xiaomi…)
 * which has no Bangla, so we use Google's engine when it is installed and pick an
 * installed Bangla voice explicitly.
 */
final class VoiceHelper {
    static final String GOOGLE = "com.google.android.tts";

    private VoiceHelper() {}

    static boolean googleInstalled(Context c) {
        try {
            c.getPackageManager().getPackageInfo(GOOGLE, 0);
            return true;
        } catch (PackageManager.NameNotFoundException e) {
            return false;
        }
    }

    static TextToSpeech create(Context c, TextToSpeech.OnInitListener l) {
        return googleInstalled(c) ? new TextToSpeech(c, l, GOOGLE) : new TextToSpeech(c, l);
    }

    /** Sets a Bangla voice. Returns "ok", "missing_data" (needs download) or "not_supported". */
    static String useBangla(TextToSpeech tts) {
        try {
            Set<Voice> voices = tts.getVoices();
            Voice best = null;
            if (voices != null) {
                for (Voice v : voices) {
                    if (!"bn".equals(v.getLocale().getLanguage())) continue;
                    if (v.getFeatures() != null && v.getFeatures().contains(TextToSpeech.Engine.KEY_FEATURE_NOT_INSTALLED)) continue;
                    // Prefer an offline Bangladesh voice, then any offline one, then network.
                    boolean network = v.isNetworkConnectionRequired();
                    boolean bd = "BD".equals(v.getLocale().getCountry());
                    if (best == null || (!network && best.isNetworkConnectionRequired()) || (bd && !network && !"BD".equals(best.getLocale().getCountry()))) best = v;
                }
            }
            if (best != null && tts.setVoice(best) == TextToSpeech.SUCCESS) {
                tts.setSpeechRate(0.85f);
                return "ok";
            }
        } catch (Exception ignored) {
            // fall back to locales below
        }
        String result = "not_supported";
        for (Locale l : new Locale[] {new Locale("bn", "BD"), new Locale("bn", "IN"), new Locale("bn")}) {
            int r = tts.isLanguageAvailable(l);
            if (r >= TextToSpeech.LANG_AVAILABLE) {
                tts.setLanguage(l);
                tts.setSpeechRate(0.85f);
                return "ok";
            }
            if (r == TextToSpeech.LANG_MISSING_DATA) result = "missing_data";
        }
        return result;
    }
}
