package com.zapette.companion;

import android.content.ContentResolver;
import android.content.Context;
import android.content.SharedPreferences;
import android.content.pm.PackageManager;
import android.os.SystemClock;
import android.provider.Settings;
import android.util.Log;

import java.util.Locale;

/**
 * Selecting the TV's input method from inside the app, so that choosing the companion's
 * IME costs a socket round trip instead of an adb call.
 *
 * `ime set` over adb does exactly one thing we cannot do without a privileged permission:
 * write {@code settings secure default_input_method}. The permission that gates that write
 * is WRITE_SECURE_SETTINGS, held by adb shell (uid 2000) and by no ordinary app - but it is
 * flagged `development`, so adb can hand it to this package once and it stays granted:
 *
 *     pm grant com.zapette.companion android.permission.WRITE_SECURE_SETTINGS
 *
 * Everything below is the same two secure settings the shell command touches, written
 * in-process. InputMethodManagerService watches DEFAULT_INPUT_METHOD and rebinds, which is
 * why writing the setting is enough.
 *
 * Three states matter to a caller, and they are not the same thing:
 *   enabled    our IME is in enabled_input_methods (it can be selected)
 *   selected   our id IS the current default_input_method
 *   running    our InputMethodService instance exists, so `commit` has a connection
 *
 * The TV's own IME is recorded the first time we take over, and `off` gives it back; the
 * previous value lives in SharedPreferences so it survives the process being restarted by
 * TCL's idle policy in the middle of a session.
 */
public final class ImeSelect {

    /** The companion's IME component, in the short form `ime list -s -a` prints. */
    public static final String IME_ID = "com.zapette.companion/.CompanionIme";

    public static final String PERMISSION = "android.permission.WRITE_SECURE_SETTINGS";

    /** The one adb call that unlocks this, echoed back to the client when it is missing. */
    public static final String GRANT = "pm grant com.zapette.companion " + PERMISSION;

    private static final String PREFS = "companion";
    private static final String KEY_PREVIOUS = "previous_ime";

    private ImeSelect() {}

    private static ContentResolver cr(Context ctx) {
        return ctx.getContentResolver();
    }

    /** The TV's current input method, or null when the setting is unset. */
    public static String current(Context ctx) {
        return Settings.Secure.getString(cr(ctx), Settings.Secure.DEFAULT_INPUT_METHOD);
    }

    public static String enabled(Context ctx) {
        return Settings.Secure.getString(cr(ctx), Settings.Secure.ENABLED_INPUT_METHODS);
    }

    /** Is our IME the TV's selected input method right now? */
    public static boolean isSelected(Context ctx) {
        return IME_ID.equals(current(ctx));
    }

    /** Does this process hold the grant? (The write is still attempted; this is the hint.) */
    public static boolean granted(Context ctx) {
        return ctx.checkSelfPermission(PERMISSION) == PackageManager.PERMISSION_GRANTED;
    }

    /** The IME the TV had before we took over, or null if we never recorded one. */
    public static String previous(Context ctx) {
        return prefs(ctx).getString(KEY_PREVIOUS, null);
    }

    private static SharedPreferences prefs(Context ctx) {
        return ctx.getSharedPreferences(PREFS, Context.MODE_PRIVATE);
    }

    /**
     * `ime on | off | state` - see the class comment. Every reply carries `current` (what the
     * TV is on now) so a caller can act on what the device says rather than on what it asked
     * for. A missing grant is answered, never guessed at:
     * `ok:false` / `error:"no_write_secure_settings"` plus the exact `grant` command.
     */
    public static String dispatch(Context ctx, String[] parts) {
        String verb = parts.length > 1 ? parts[1].toLowerCase(Locale.US) : "";
        if ("on".equals(verb)) {
            return on(ctx);
        }
        if ("off".equals(verb)) {
            return off(ctx);
        }
        if ("state".equals(verb)) {
            return state(ctx);
        }
        return Json.obj()
                .putBool("ok", false)
                .putStr("cmd", "ime")
                .putStr("error", verb.isEmpty() ? "missing_ime_verb" : "unknown_ime_verb")
                .putStr("verb", verb)
                .putStr("known", "on, off, state")
                .putStr("current", current(ctx))
                .done();
    }

    /** `ime state` - reads only. Never writes a setting, never selects anything. */
    private static String state(Context ctx) {
        String cur = current(ctx);
        String enabled = enabled(ctx);
        boolean has = enabled != null && enabled.contains(IME_ID);
        return base("state", cur)
                .putBool("enabled", has)
                .putBool("selected", IME_ID.equals(cur))
                .putBool("running", CompanionIme.selected())
                .putBool("granted", granted(ctx))
                .putStr("previous", previous(ctx))
                .done();
    }

    /**
     * `ime on` - put the companion's IME in place.
     *
     * The TV's own IME is recorded BEFORE the switch (so `off` restores exactly it), our id is
     * appended to enabled_input_methods if it is not already there, and the default is written.
     *
     * A default that is already ours is re-asserted by writing the previous IME and then ours
     * again: after a fresh install the InputMethodManager leaves the method unbound
     * (`mBoundToMethod=false`) and a no-op write would not make it rebind. That switch-away-
     * and-back is the same retry the client used to do with two adb calls.
     */
    private static String on(Context ctx) {
        long t0 = SystemClock.elapsedRealtime();
        String cur = current(ctx);
        if (!granted(ctx)) {
            return noGrant(ctx, "on", cur);
        }
        try {
            String enabled = enabled(ctx);
            boolean already = enabled != null && enabled.contains(IME_ID);
            if (!already) {
                String next = (enabled == null || enabled.trim().isEmpty())
                        ? IME_ID
                        : enabled.trim() + ":" + IME_ID;
                Settings.Secure.putString(cr(ctx), Settings.Secure.ENABLED_INPUT_METHODS, next);
            }
            if (cur != null && !cur.isEmpty() && !IME_ID.equals(cur)) {
                prefs(ctx).edit().putString(KEY_PREVIOUS, cur).apply();
            }
            String prev = previous(ctx);
            boolean forced = IME_ID.equals(cur) && prev != null && !prev.isEmpty() && !prev.equals(IME_ID);
            if (forced) {
                Settings.Secure.putString(cr(ctx), Settings.Secure.DEFAULT_INPUT_METHOD, prev);
            }
            Settings.Secure.putString(cr(ctx), Settings.Secure.DEFAULT_INPUT_METHOD, IME_ID);
            String now = current(ctx);
            long ms = SystemClock.elapsedRealtime() - t0;
            Log.i(CompanionService.TAG, "ime on: " + cur + " -> " + now + " in " + ms + " ms");
            return base("on", now)
                    .putBool("ok", IME_ID.equals(now))
                    .putBool("enabled", true)
                    .putBool("selected", IME_ID.equals(now))
                    .putBool("running", CompanionIme.selected())
                    .putBool("granted", true)
                    .putStr("previous", prev)
                    .putBool("reenabled", !already)
                    .putBool("forced_rebind", forced)
                    .putNum("switch_ms", ms)
                    .done();
        } catch (SecurityException e) {
            return noGrant(ctx, "on", cur);
        } catch (Throwable t) {
            return base("on", cur)
                    .putBool("ok", false)
                    .putStr("error", "ime_write_failed: " + t)
                    .done();
        }
    }

    /**
     * `ime off` - give the TV its own IME back. Refuses (with the reason) rather than
     * switching to something it did not record: guessing an IME would leave the TV on a
     * keyboard nobody chose.
     */
    private static String off(Context ctx) {
        long t0 = SystemClock.elapsedRealtime();
        String cur = current(ctx);
        if (!granted(ctx)) {
            return noGrant(ctx, "off", cur);
        }
        String prev = previous(ctx);
        if (prev == null || prev.isEmpty() || prev.equals(IME_ID)) {
            return base("off", cur)
                    .putBool("ok", false)
                    .putBool("selected", IME_ID.equals(cur))
                    .putStr("error", "no_previous_ime")
                    .done();
        }
        if (!IME_ID.equals(cur)) {
            // Nothing of ours is selected: the settings already say what `off` would write.
            return base("off", cur)
                    .putBool("ok", true)
                    .putBool("selected", false)
                    .putStr("previous", prev)
                    .putBool("changed", false)
                    .putNum("switch_ms", SystemClock.elapsedRealtime() - t0)
                    .done();
        }
        try {
            Settings.Secure.putString(cr(ctx), Settings.Secure.DEFAULT_INPUT_METHOD, prev);
            String now = current(ctx);
            long ms = SystemClock.elapsedRealtime() - t0;
            Log.i(CompanionService.TAG, "ime off: " + cur + " -> " + now + " in " + ms + " ms");
            return base("off", now)
                    .putBool("ok", prev.equals(now))
                    .putBool("enabled", true)
                    .putBool("selected", IME_ID.equals(now))
                    .putBool("running", CompanionIme.selected())
                    .putBool("granted", true)
                    .putStr("previous", prev)
                    .putBool("changed", true)
                    .putNum("switch_ms", ms)
                    .done();
        } catch (SecurityException e) {
            return noGrant(ctx, "off", cur);
        } catch (Throwable t) {
            return base("off", cur)
                    .putBool("ok", false)
                    .putStr("error", "ime_write_failed: " + t)
                    .done();
        }
    }

    /** The machine-readable "I cannot write secure settings" answer, with the fix in it. */
    private static String noGrant(Context ctx, String verb, String cur) {
        return base(verb, cur)
                .putBool("ok", false)
                .putBool("granted", false)
                .putStr("error", "no_write_secure_settings")
                .putStr("need", PERMISSION)
                .putStr("grant", GRANT)
                .putStr("fallback", "adb")
                .done();
    }

    /** Every reply's shared head: the verb, and what the TV is on right now. */
    private static Json.Obj base(String verb, String cur) {
        Json.Obj o = Json.obj().putStr("cmd", "ime").putStr("verb", verb).putStr("ime", IME_ID);
        if (cur == null) {
            return o.putStr("current", null);
        }
        return o.putStr("current", cur);
    }
}
