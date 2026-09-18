package com.zapette.companion;

import android.content.Context;
import android.graphics.Canvas;
import android.graphics.Color;
import android.graphics.Paint;
import android.os.Handler;
import android.os.Looper;
import android.os.SystemClock;
import android.text.Editable;
import android.text.TextWatcher;
import android.util.AttributeSet;
import android.widget.EditText;

/**
 * An EditText that behaves like SmartTube's StreamingTextView, so mirror-mode reads can be
 * tested against the two faults that field shows instead of against that field.
 *
 * Two behaviours, both observable from outside the app:
 *
 *  - RENDER LAGS THE TEXT. The logical text (the Editable, what {@code field get} calls
 *    "content") is complete the moment the commit lands, but the characters are painted
 *    one per {@link #REVEAL_TICK_MS}, so a read taken straight after a commit returns a
 *    PREFIX - the "hello reads back as hell" fault.
 *  - AN EMPTY FIELD PRESENTS PLACEHOLDER TEXT. While the field is empty it paints
 *    {@link #PLACEHOLDER} ("Rechercher", the same string SmartTube's search box shows), and
 *    that string is what a naive read of the screen picks up in place of content.
 *
 * It stays an EditText on purpose: text has to arrive through the same
 * commitText/InputConnection path as the plain field, or the comparison between the two
 * fields would not be apples-to-apples. Only the painting is ours - {@link #onDraw} is
 * replaced so what is on screen is exactly {@link #painted()}.
 */
public class StreamingEditText extends EditText {

    /** What an empty field presents, verbatim (SmartTube's own placeholder). */
    public static final String PLACEHOLDER = "Rechercher";

    /** One more character per reveal tick. 25 ms is slow enough that a read issued right
     *  after the commit lands catches a prefix, and short enough that a full string settles
     *  in a fraction of a second. */
    public static final long REVEAL_TICK_MS = 25;

    /** Characters currently painted. */
    private int revealed;
    /** uptime when the reveal for the current text started, 0 when none is running. */
    private long revealStartedAt;
    /** uptime when the reveal for the current text finished, 0 when none has. */
    private long settledAt;
    /** How long the last reveal took, device clock, -1 when nothing has been revealed yet. */
    private long lastRevealMs = -1;
    private boolean revealing;
    private String previous = "";

    private final Handler main = new Handler(Looper.getMainLooper());
    private final Paint hintPaint = new Paint();

    public StreamingEditText(Context context) {
        super(context);
        init(context);
    }

    public StreamingEditText(Context context, AttributeSet attrs) {
        super(context, attrs);
        init(context);
    }

    private void init(Context context) {
        hintPaint.setAntiAlias(true);
        hintPaint.setTypeface(getTypeface());
        addTextChangedListener(new TextWatcher() {
            @Override public void beforeTextChanged(CharSequence s, int start, int count, int after) {}

            @Override public void onTextChanged(CharSequence s, int start, int before, int count) {
                onContent(s == null ? "" : s.toString());
            }

            @Override public void afterTextChanged(Editable s) {}
        });
    }

    private final Runnable tick = new Runnable() {
        @Override public void run() {
            String t = textString();
            if (revealed < t.length()) {
                revealed++;
                invalidate();
            }
            if (revealed < t.length()) {
                main.postDelayed(this, REVEAL_TICK_MS);
            } else {
                revealing = false;
                settledAt = SystemClock.uptimeMillis();
                if (revealStartedAt > 0) {
                    lastRevealMs = settledAt - revealStartedAt;
                }
            }
        }
    };

    /**
     * The text changed: keep whatever is already painted that is still a prefix of it, and
     * reveal the rest one character per tick. An empty text paints nothing to reveal.
     */
    private void onContent(String t) {
        int same = commonPrefix(previous, t);
        previous = t;
        main.removeCallbacks(tick);
        revealed = Math.min(revealed, same);
        if (t.isEmpty()) {
            revealing = false;
            revealStartedAt = 0;
            settledAt = 0;
            lastRevealMs = -1;
            invalidate();
            return;
        }
        if (revealed >= t.length()) {
            // Nothing new to paint (a same-length or shortened text): already settled.
            revealing = false;
            revealStartedAt = 0;
            settledAt = SystemClock.uptimeMillis();
            invalidate();
            return;
        }
        revealing = true;
        revealStartedAt = SystemClock.uptimeMillis();
        settledAt = 0;
        lastRevealMs = -1;
        invalidate();
        main.postDelayed(tick, REVEAL_TICK_MS);
    }

    /** The view's text as a String; never null. */
    private String textString() {
        Editable e = getText();
        return e == null ? "" : e.toString();
    }

    private static int commonPrefix(String a, String b) {
        int n = Math.min(a.length(), b.length());
        int i = 0;
        while (i < n && a.charAt(i) == b.charAt(i)) {
            i++;
        }
        return i;
    }

    /**
     * Paints only what {@link #painted()} reports: the revealed prefix, or the placeholder
     * while the field is empty. The EditText's own drawing is skipped so the screen cannot
     * show more than the read reports.
     */
    @Override
    protected void onDraw(Canvas canvas) {
        String t = textString();
        Paint p = getPaint();
        float x = getTotalPaddingLeft();
        float baseline = getBaseline();
        if (baseline <= 0) {
            baseline = getTotalPaddingTop() - p.getFontMetricsInt().top;
        }
        if (t.isEmpty()) {
            hintPaint.setColor(hintColor());
            hintPaint.setTextSize(getTextSize());
            canvas.drawText(PLACEHOLDER, x, baseline, hintPaint);
            return;
        }
        p.setColor(getCurrentTextColor());
        int n = Math.min(revealed, t.length());
        if (n > 0) {
            canvas.drawText(t.substring(0, n), x, baseline, p);
        }
    }

    /** Grey, dimmer than the text: on screen it reads as a placeholder, not as content. */
    private int hintColor() {
        return Color.argb(160, 160, 160, 160);
    }

    // ------------------------------------------------------------------ the read side

    /** Exactly what is on screen right now: the placeholder while empty, else the revealed prefix. */
    public String painted() {
        String t = textString();
        if (t.isEmpty()) {
            return PLACEHOLDER;
        }
        return t.substring(0, Math.min(revealed, t.length()));
    }

    /** The string an EMPTY field presents, named so the caller need not read it off the screen. */
    public String placeholder() {
        return PLACEHOLDER;
    }

    /** True when painting has caught up with the text (an empty field is settled by definition). */
    public boolean settled() {
        String t = textString();
        return t.isEmpty() || revealed >= t.length();
    }

    /** True while a reveal is still running. */
    public boolean revealing() {
        return revealing;
    }

    /** Device-clock duration of the last completed reveal, or -1 when nothing was revealed. */
    public long lastRevealMs() {
        return lastRevealMs;
    }

    /** Characters painted so far. */
    public int revealedChars() {
        return revealed;
    }
}
