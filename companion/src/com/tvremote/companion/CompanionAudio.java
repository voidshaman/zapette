package com.tvremote.companion;

import android.content.Context;
import android.media.AudioManager;
import android.os.SystemClock;

/**
 * The audio half of the companion: read and set the TV's volume in-process.
 *
 * Why STREAM_MUSIC and nothing else: it is the stream THIS set's own volume keys move. Measured on
 * the TCL with one VOLUME_UP keyevent, the index went 21 -> 22 while every other stream (SYSTEM 24,
 * RING 2, VOICE_CALL 2, ALARM 2, NOTIFICATION 2, TTS/ACCESSIBILITY/ASSISTANT 24) stayed put, and
 * VOLUME_DOWN took it back to 21. So "the TV's volume" is STREAM_MUSIC's index on a 0-100 scale, and
 * a second stream in the protocol would be a knob that no remote key is wired to.
 *
 * Unlike CompanionIme and CompanionAccess there is no looper hop here: an AudioManager call is a
 * plain in-process binder call owned by no thread, so the dispatch runs on the socket thread and
 * the reply comes back without a latch. That is also what makes this the cheapest verb - see
 * MEASUREMENTS.txt for the round trip.
 *
 * The set path writes nothing if the device refuses the stream (fixed-volume HDMI/optical output on
 * a TV is a real case): `level` in the reply is always read BACK from the manager afterwards, so a
 * refusal shows up as level != requested instead of as an error we invented.
 */
public final class CompanionAudio {

    /**
     * The stream every verb here acts on, and the name the wire uses for it.
     *
     * AudioManager.STREAM_MUSIC is 3 on this platform (public constant, but the number is in the
     * reply so a client never has to know it).
     */
    public static final int STREAM = AudioManager.STREAM_MUSIC;
    public static final String STREAM_NAME = "music";

    private CompanionAudio() {}

    /** `volume` - read (level, min, max, muted) without touching anything. */
    public static Snapshot read(Context context) {
        return apply(context, -1, false);
    }

    /**
     * `volume &lt;n&gt; [ui]` - set the level, then read it back.
     *
     * `ui` asks the platform for its own on-screen volume panel (AudioManager.FLAG_SHOW_UI). The
     * default is no flags: the OSD is a request to the system UI, and whether this TV honours it is
     * a measured question, not an assumption.
     */
    public static Snapshot set(Context context, int requested, boolean showUi) {
        return apply(context, requested, showUi);
    }

    private static Snapshot apply(Context context, int requested, boolean showUi) {
        Snapshot s = new Snapshot();
        s.requested = requested;
        s.showUi = showUi;
        long t0 = SystemClock.elapsedRealtime();
        AudioManager am = context == null
                ? null
                : (AudioManager) context.getSystemService(Context.AUDIO_SERVICE);
        if (am == null) {
            return fail(s, "no_audio_service", t0);
        }
        try {
            s.min = am.getStreamMinVolume(STREAM);
            s.max = am.getStreamMaxVolume(STREAM);
            s.before = am.getStreamVolume(STREAM);
            s.level = s.before;
            if (requested >= 0) {
                int accepted = Math.max(s.min, Math.min(s.max, requested));
                s.clamped = accepted != requested;
                s.flags = showUi ? AudioManager.FLAG_SHOW_UI : 0;
                am.setStreamVolume(STREAM, accepted, s.flags);
                // The whole point of the verb: what the manager says NOW, not what we asked for.
                s.level = am.getStreamVolume(STREAM);
            }
            s.muted = am.isStreamMute(STREAM);
        } catch (Throwable t) {
            return fail(s, "audio_exception: " + t, t0);
        }
        s.ok = true;
        s.ms = SystemClock.elapsedRealtime() - t0;
        return s;
    }

    private static Snapshot fail(Snapshot s, String error, long startMs) {
        s.ok = false;
        s.error = error;
        s.ms = SystemClock.elapsedRealtime() - startMs;
        return s;
    }

    /** One verb's outcome. Flat, like the other halves: the wire layer renders it. */
    public static final class Snapshot {
        public boolean ok;
        public String error;
        public long ms;
        /** -1 on a read, the requested index on a set. */
        public int requested;
        /** The index read back from the manager: reality, after a set. */
        public int level;
        public int min;
        public int max;
        /** The index before a set. */
        public int before;
        public boolean muted;
        public boolean clamped;
        public boolean showUi;
        public int flags;
    }
}
