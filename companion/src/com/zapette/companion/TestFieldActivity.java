package com.zapette.companion;

import android.app.Activity;
import android.content.ComponentName;
import android.content.Context;
import android.content.Intent;
import android.graphics.Color;
import android.graphics.Typeface;
import android.graphics.drawable.GradientDrawable;
import android.os.Bundle;
import android.os.Handler;
import android.os.Looper;
import android.os.SystemClock;
import android.provider.Settings;
import android.text.Editable;
import android.text.InputType;
import android.util.TypedValue;
import android.view.Gravity;
import android.view.View;
import android.view.inputmethod.InputConnection;
import android.widget.EditText;
import android.widget.LinearLayout;
import android.widget.TextView;

import java.util.Locale;
import java.util.concurrent.CountDownLatch;
import java.util.concurrent.TimeUnit;

/**
 * The companion's own test screen: two text fields and the verbs typing is developed
 * against.
 *
 * Why it exists: the only field available before this was SmartTube's search box, and
 * that is a poor measuring instrument - reaching it means navigating a third-party app,
 * clearing it meant a 2000-key DEL burst, and it runs its own search after the first
 * commit (later commits answer ok and change nothing). This activity owns both fields and
 * {@code field get} reads them directly: no pixels, no accessibility, no guessing.
 *
 * TWO FIELDS, ONE COMMIT PATH.
 *   edittext (default) - a plain EditText: text on screen the moment it is committed.
 *   streamed           - a {@link StreamingEditText}, which paints its text one character
 *                        per tick and presents a placeholder while empty. This is the
 *                        instrument for the two faults SmartTube's own field shows (a read
 *                        straight after a commit returns a prefix; an empty field reports its
 *                        hint as content), which mirror mode carries compensation for.
 * {@code field target <name>} chooses which one is focused and therefore which one the IME's
 * commits land in. Both go through the same path - commitText on CompanionIme's live
 * InputConnection - so a comparison between them measures the FIELD, not the transport.
 *
 * {@code field set} and {@code field append} refuse to write when the companion IME is not
 * the TV's selected input method: they answer an error rather than quietly writing the box
 * through another path. A test must not pass through a path that is not the one under test.
 *
 * {@code field clear} is one in-process operation: deleteSurroundingText over the field's
 * length through the connection when there is one, otherwise an in-place replace on the
 * Editable (never setText, which would swap the Editable and orphan a live connection). It
 * never sends a keystroke, so nothing outlives the call.
 */
public class TestFieldActivity extends Activity {

    /** The plain EditText: the default target, and what "the field" meant before this card. */
    public static final String TARGET_PLAIN = "edittext";
    /** The SmartTube-shaped field: paints progressively, presents a placeholder when empty. */
    public static final String TARGET_STREAMED = "streamed";

    /** How long `field focus`/`field target` lets the activity come to the front and take focus. */
    private static final long FOCUS_WAIT_MS = 2500;
    /** How long the server thread waits for the UI thread, per operation. */
    private static final long OP_TIMEOUT_MS = 2000;
    /** Polling gap while waiting for the window/field focus. */
    private static final long POLL_MS = 20;

    /** The resumed instance, or null. Written on the UI thread, read from the socket thread. */
    private static volatile TestFieldActivity live;
    private static volatile boolean windowFocused;
    /** Which field receives commits: {@link #TARGET_PLAIN} or {@link #TARGET_STREAMED}. */
    private static volatile String target = TARGET_PLAIN;

    private static final Handler MAIN = new Handler(Looper.getMainLooper());

    private EditText box;
    private StreamingEditText stream;

    // ---------------------------------------------------------------- the screen

    @Override
    protected void onCreate(Bundle saved) {
        super.onCreate(saved);

        LinearLayout root = new LinearLayout(this);
        root.setOrientation(LinearLayout.VERTICAL);
        root.setBackgroundColor(Color.BLACK);
        root.setPadding(dp(24), dp(24), dp(24), dp(24));

        root.addView(label("COMPANION TEST FIELD - PLAIN (edittext)"));

        box = new EditText(this);
        style(box);
        root.addView(box, fullWidth());

        root.addView(label("STREAMED (streamed) - paints one char per tick, placeholder when empty"));

        stream = new StreamingEditText(this);
        style(stream);
        root.addView(stream, fullWidth());

        setContentView(root);
        setTitle("Zapette Companion");
    }

    /** Shared look: monospace, 32sp, light on black with a visible edge. A TV screen in a
     *  dark room needs the boundary drawn or the field is invisible - and the harness needs
     *  both fields seen. */
    private void style(EditText v) {
        v.setTypeface(Typeface.MONOSPACE);
        v.setTextSize(TypedValue.COMPLEX_UNIT_SP, 32);
        v.setTextColor(Color.WHITE);
        GradientDrawable bg = new GradientDrawable();
        bg.setColor(Color.BLACK);
        bg.setStroke(dp(2), Color.DKGRAY);
        bg.setCornerRadius(dp(8));
        v.setBackground(bg);
        v.setGravity(Gravity.START | Gravity.CENTER_VERTICAL);
        v.setSingleLine(true);
        v.setPadding(dp(12), dp(8), dp(12), dp(8));
        v.setInputType(InputType.TYPE_CLASS_TEXT | InputType.TYPE_TEXT_FLAG_NO_SUGGESTIONS);
    }

    private TextView label(String text) {
        TextView t = new TextView(this);
        t.setText(text);
        t.setTextColor(Color.GRAY);
        t.setTypeface(Typeface.MONOSPACE);
        t.setTextSize(TypedValue.COMPLEX_UNIT_SP, 12);
        t.setPadding(0, dp(10), 0, dp(2));
        return t;
    }

    private LinearLayout.LayoutParams fullWidth() {
        return new LinearLayout.LayoutParams(
                LinearLayout.LayoutParams.MATCH_PARENT, LinearLayout.LayoutParams.WRAP_CONTENT);
    }

    @Override
    protected void onResume() {
        super.onResume();
        live = this;
        active().requestFocus();
    }

    @Override
    protected void onPause() {
        if (live == this) {
            live = null;
        }
        windowFocused = false;
        super.onPause();
    }

    @Override
    protected void onDestroy() {
        if (live == this) {
            live = null;
        }
        super.onDestroy();
    }

    @Override
    public void onWindowFocusChanged(boolean hasFocus) {
        super.onWindowFocusChanged(hasFocus);
        windowFocused = hasFocus;
    }

    private int dp(int v) {
        return (int) TypedValue.applyDimension(TypedValue.COMPLEX_UNIT_DIP, v, getResources().getDisplayMetrics());
    }

    /** The field that receives commits and that the verbs act on. */
    private EditText active() {
        return TARGET_STREAMED.equals(target) ? stream : box;
    }

    // ------------------------------------------------------------------- the verbs

    /** `field focus`: bring the screen to the front, put the caret in the ACTIVE box, read it back. */
    public static Snapshot focus(Context ctx) {
        return focused(ctx, null, "focus");
    }

    /**
     * `field target [name]`: with a name, switch which field is focused and receives commits (and
     * bring the screen up if it is not there yet); with no name, report the current target and its
     * contents without changing anything.
     */
    public static Snapshot target(Context ctx, String name) {
        String want = name == null ? "" : name.toLowerCase(Locale.US);
        if (want.isEmpty()) {
            Snapshot s = get();
            s.target = target;
            return s;
        }
        boolean known = TARGET_PLAIN.equals(want) || TARGET_STREAMED.equals(want);
        if (!known) {
            Snapshot s = Snapshot.fail("unknown_target");
            s.knownTargets = TARGET_PLAIN + ", " + TARGET_STREAMED;
            return s;
        }
        return focused(ctx, want, "target");
    }

    /**
     * Shared body of focus/target: front the activity, focus the requested (or active) field,
     * reply with its contents. Sets the target BEFORE waiting for the front, so a switch that
     * cannot be shown on screen still leaves the target switched - the caller can see it in the
     * reply and only needs one `am start` to complete it.
     */
    private static Snapshot focused(Context ctx, final String want, final String verb) {
        long started = SystemClock.uptimeMillis();
        if (want != null) {
            target = want;
        }
        if (live == null) {
            bringToFront(ctx);
        }
        // The window may already be front while the WRONG field holds focus - which is exactly
        // the state a target switch starts in. Ask for the right one on the UI thread while
        // waiting, or the wait runs out its full budget for nothing.
        long deadline = started + FOCUS_WAIT_MS;
        while (!ready()) {
            if (SystemClock.uptimeMillis() >= deadline) {
                break;
            }
            if (windowFocused) {
                requestActiveFocus();
            }
            sleep(POLL_MS);
        }
        final TestFieldActivity a = live;
        long waited = SystemClock.uptimeMillis() - started;
        if (a == null) {
            Snapshot s = Snapshot.fail("field_not_front");
            s.waitedMs = waited;
            s.target = target;
            return s;
        }
        Snapshot s = post(a, new Op() {
            @Override public Snapshot run(TestFieldActivity act) {
                act.active().requestFocus();
                Snapshot r = act.snapshot("focus".equals(verb) ? "focus" : null, 0);
                r.activity = act.getClass().getName();
                r.target = target;
                return r;
            }
        });
        s.waitedMs = waited;
        s.target = target;
        if (s.ok && !(windowFocused && a.active().hasFocus())) {
            Snapshot bad = Snapshot.fail("field_not_focused");
            bad.waitedMs = waited;
            bad.text = s.text;
            bad.len = s.len;
            bad.target = target;
            return bad;
        }
        return s;
    }

    /** `field set <text>`: clear, then commit the text through the live input connection. */
    public static Snapshot set(String text) {
        return typed(true, text);
    }

    /** `field append <text>`: commit the text at the caret, leaving what is there. */
    public static Snapshot append(String text) {
        return typed(false, text);
    }

    /** `field clear`: one in-process clear. Never a keystroke, never a setText. */
    public static Snapshot clear() {
        final TestFieldActivity a = live;
        if (a == null) {
            return Snapshot.fail("field_not_front");
        }
        return post(a, new Op() {
            @Override public Snapshot run(TestFieldActivity act) {
                InputConnection c = CompanionIme.liveConnection();
                if (c != null) {
                    int removed = act.clearThrough(c);
                    return act.snapshot("input_connection", removed);
                }
                int before = act.active().length();
                Editable e = act.active().getText();
                if (before > 0 && e != null) {
                    e.replace(0, before, "");
                }
                return act.snapshot("editable", before - act.active().length());
            }
        });
    }

    /**
     * `field get`: the ACTIVE field's contents, length and caret - the ground truth for typing
     * tests. With the streamed field active, the reply also carries what is painted right now,
     * whether painting has caught up, and the placeholder an empty field presents.
     */
    public static Snapshot get() {
        return read(null);
    }

    /** `field get <name>`: read a NAMED field without switching the active target. */
    public static Snapshot get(String which) {
        String want = which == null ? "" : which.toLowerCase(Locale.US);
        if (want.isEmpty()) {
            return get();
        }
        if (!TARGET_PLAIN.equals(want) && !TARGET_STREAMED.equals(want)) {
            Snapshot s = Snapshot.fail("unknown_target");
            s.knownTargets = TARGET_PLAIN + ", " + TARGET_STREAMED;
            return s;
        }
        return read(want);
    }

    private static Snapshot read(final String which) {
        final TestFieldActivity a = live;
        if (a == null) {
            return Snapshot.fail("field_not_front");
        }
        return post(a, new Op() {
            @Override public Snapshot run(TestFieldActivity act) {
                EditText v = which == null ? act.active()
                        : (TARGET_STREAMED.equals(which) ? act.stream : act.box);
                return act.snapshot(v, null, 0);
            }
        });
    }

    // ------------------------------------------------------------------ internals

    private static Snapshot typed(final boolean replace, final String text) {
        final TestFieldActivity a = live;
        if (a == null) {
            return Snapshot.fail("field_not_front");
        }
        // Gate before anything is written: the text has to travel the IME's path. If the
        // companion IME is not the TV's selected input method, commitText cannot reach the
        // field, and writing the box directly would test a path nothing else uses.
        if (!a.companionImeIsDefault()) {
            Snapshot s = Snapshot.fail("ime_not_selected");
            s.defaultIme = a.defaultIme();
            s.imeSelected = CompanionIme.selected();
            return s;
        }
        return post(a, new Op() {
            @Override public Snapshot run(TestFieldActivity act) {
                InputConnection c = CompanionIme.liveConnection();
                if (c == null) {
                    Snapshot s = Snapshot.fail("no_input_connection");
                    s.defaultIme = act.defaultIme();
                    s.imeSelected = CompanionIme.selected();
                    return s;
                }
                int cleared = replace ? act.clearThrough(c) : 0;
                boolean accepted = c.commitText(text, 1);
                if (!accepted) {
                    Snapshot s = Snapshot.fail("commit_rejected");
                    s.defaultIme = act.defaultIme();
                    s.imeSelected = true;
                    return s;
                }
                Snapshot s = act.snapshot("input_connection", cleared);
                s.requested = text.length();
                return s;
            }
        });
    }

    /** One in-process clear through the live connection: deleteSurroundingText over its length. */
    private int clearThrough(InputConnection c) {
        EditText v = active();
        int before = v.length();
        if (before <= 0) {
            return 0;
        }
        c.setSelection(0, 0);
        c.deleteSurroundingText(0, before);
        return before - v.length();
    }

    /** The active field as the app itself holds it. UI thread only. */
    private Snapshot snapshot(String via, int changed) {
        return snapshot(active(), via, changed);
    }

    /**
     * One field as the app itself holds it. UI thread only. For the streamed field the reply
     * also carries the gap between the two notions of "the text": what was committed
     * (content) and what is painted (rendered).
     */
    private Snapshot snapshot(EditText v, String via, int changed) {
        Snapshot s = new Snapshot();
        s.ok = true;
        Editable e = v.getText();
        s.text = e == null ? "" : e.toString();
        s.len = e == null ? 0 : e.length();
        s.selStart = v.getSelectionStart();
        s.selEnd = v.getSelectionEnd();
        s.focused = v.hasFocus();
        s.via = via;
        s.changed = changed;
        if (v == stream) {
            s.target = TARGET_STREAMED;
            s.content = s.text;
            s.rendered = stream.painted();
            s.hint = stream.placeholder();
            s.settled = stream.settled();
            s.revealing = stream.revealing();
            s.renderMs = s.settled ? stream.lastRevealMs() : -1;
        }
        return s;
    }

    private static boolean ready() {
        TestFieldActivity a = live;
        return a != null && windowFocused && a.active().hasFocus();
    }

    /** Asks the UI thread for focus on the active field; fire and forget. */
    private static void requestActiveFocus() {
        MAIN.post(new Runnable() {
            @Override public void run() {
                TestFieldActivity a = live;
                if (a != null) {
                    a.active().requestFocus();
                }
            }
        });
    }

    /** The activity's own title, not the device's: the test screen is brought to the front. */
    private static void bringToFront(Context ctx) {
        Intent i = new Intent(ctx, TestFieldActivity.class);
        i.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK | Intent.FLAG_ACTIVITY_SINGLE_TOP);
        ctx.startActivity(i);
    }

    private String defaultIme() {
        try {
            String v = Settings.Secure.getString(getContentResolver(),
                    Settings.Secure.DEFAULT_INPUT_METHOD);
            return v == null ? "" : v;
        } catch (Throwable t) {
            return "unavailable: " + t;
        }
    }

    private boolean companionImeIsDefault() {
        ComponentName theirs = ComponentName.unflattenFromString(defaultIme());
        return theirs != null && theirs.equals(new ComponentName(this, CompanionIme.class));
    }

    private static void sleep(long ms) {
        try {
            Thread.sleep(ms);
        } catch (InterruptedException e) {
            Thread.currentThread().interrupt();
        }
    }

    /** Runs one operation on the UI thread and waits for its result. */
    private static Snapshot post(final TestFieldActivity a, final Op op) {
        if (Looper.myLooper() == Looper.getMainLooper()) {
            return op.run(a);
        }
        final Snapshot[] box = new Snapshot[1];
        final CountDownLatch latch = new CountDownLatch(1);
        MAIN.post(new Runnable() {
            @Override public void run() {
                try {
                    box[0] = op.run(a);
                } catch (Throwable t) {
                    box[0] = Snapshot.fail("exception: " + t);
                } finally {
                    latch.countDown();
                }
            }
        });
        try {
            if (!latch.await(OP_TIMEOUT_MS, TimeUnit.MILLISECONDS)) {
                return Snapshot.fail("op_timeout");
            }
        } catch (InterruptedException e) {
            Thread.currentThread().interrupt();
            return Snapshot.fail("op_interrupted");
        }
        return box[0] == null ? Snapshot.fail("op_lost") : box[0];
    }

    private interface Op {
        Snapshot run(TestFieldActivity act);
    }

    /** One field operation's outcome: what the app holds, or the reason there is nothing. */
    public static final class Snapshot {
        public boolean ok;
        public String error;
        public String text = "";
        public int len;
        /** -1 when the view reports no selection. */
        public int selStart = -1;
        public int selEnd = -1;
        public boolean focused;
        /** Characters this operation removed, as counted by the view. */
        public int changed;
        /** Characters the caller asked for, on set/append. */
        public int requested = -1;
        /** Which path carried the write: "input_connection", "editable", or null for a read. */
        public String via;
        public long waitedMs;
        public String activity;
        /** Diagnostics for the IME gate. */
        public String defaultIme;
        public boolean imeSelected;
        /** The field this reply is about; null on the plain field, whose reply shape is fixed. */
        public String target;
        /** Streamed field only: the committed text, what is painted, and the empty-field hint. */
        public String content;
        public String rendered;
        public String hint;
        public boolean settled;
        public boolean revealing;
        /** Device-clock length of the render that completed, or -1 when none was measured. */
        public long renderMs = -1;
        /** Names accepted by `field target`/`field get`, on an unknown one. */
        public String knownTargets;

        static Snapshot fail(String error) {
            Snapshot s = new Snapshot();
            s.ok = false;
            s.error = error;
            return s;
        }
    }
}
