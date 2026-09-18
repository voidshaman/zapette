package com.zapette.companion;

import android.graphics.Color;
import android.graphics.Typeface;
import android.inputmethodservice.InputMethodService;
import android.os.Handler;
import android.os.Looper;
import android.text.Selection;
import android.text.Spanned;
import android.util.Log;
import android.util.TypedValue;
import android.view.Gravity;
import android.view.View;
import android.view.inputmethod.EditorInfo;
import android.view.inputmethod.ExtractedText;
import android.view.inputmethod.ExtractedTextRequest;
import android.view.inputmethod.InputConnection;
import android.widget.TextView;

import java.util.concurrent.CountDownLatch;
import java.util.concurrent.TimeUnit;

/**
 * The IME half of the companion: an InputMethodService whose only job is commitText.
 *
 * It exists because keycodes are the wrong tool on this TV. The TV's own keyboard
 * maps injected key positions through its own layout (letters come back remapped)
 * and reads a repeated key as a multi-press, so it eats the repeat ("hello" arrives
 * as "hell"). commitText hands the field a finished string instead: the layout is
 * never consulted, so there is nothing to remap and no repeat to eat.
 *
 * No keyboard is ever drawn - onCreateInputView returns a status bar, never keys - because
 * nothing here is typed by a human. It is driven from the socket server, in the same process
 * (same package, no android:process), through the static commit() and read() below.
 */
public class CompanionIme extends InputMethodService {

    /**
     * The API-30 shape of InputConnection.getSurroundingText, restated locally.
     *
     * The build compiles against the highest installed platform (android-36), where the only
     * getSurroundingText returns android.view.inputmethod.SurroundingText - a class that does
     * not exist on this API-30 TV, so a direct call site would emit a descriptor the device
     * does not have. It is not reachable by casting the connection either: the IME is handed a
     * framework wrapper (com.android.internal.view.InputConnectionWrapper), which implements
     * InputConnection and nothing else, so a checkcast to a look-alike interface fails.
     * Reflection on InputConnection.class resolves the method the TV actually declares, and
     * needs no change to build.sh.
     */
    private static java.lang.reflect.Method surroundingTextMethod;

    /** getSurroundingText through the method the runtime declares. Never null: returns "" or throws. */
    private static CharSequence surroundingText(InputConnection c, int before, int after)
            throws Exception {
        java.lang.reflect.Method m = surroundingTextMethod;
        if (m == null) {
            NoSuchMethodException viaInterface = null;
            try {
                m = InputConnection.class.getMethod(
                        "getSurroundingText", int.class, int.class, int.class);
            } catch (NoSuchMethodException e) {
                viaInterface = e;
            }
            if (m == null) {
                try {
                    m = c.getClass().getMethod(
                            "getSurroundingText", int.class, int.class, int.class);
                } catch (NoSuchMethodException e) {
                    throw new NoSuchMethodException("interface: " + msg(viaInterface)
                            + " | connection " + c.getClass().getName() + ": " + msg(e)
                            + " | connection candidates: " + candidates(c));
                }
            }
            surroundingTextMethod = m;
        }
        return (CharSequence) m.invoke(c, before, after, 0);
    }

    private static String msg(NoSuchMethodException e) {
        return e == null ? "(found)" : e.getMessage();
    }

    /** Every text/caret-shaped method on the connection, for when getSurroundingText is not there. */
    private static String candidates(InputConnection c) {
        StringBuilder b = new StringBuilder();
        for (java.lang.reflect.Method m : c.getClass().getMethods()) {
            String n = m.getName();
            if ((n.contains("Surrounding") || n.startsWith("getText") || n.contains("Extracted")
                    || n.contains("Selected") || n.contains("Selection"))
                    && m.getParameterTypes().length <= 3) {
                StringBuilder sig = new StringBuilder(n).append('(');
                Class<?>[] p = m.getParameterTypes();
                for (int i = 0; i < p.length; i++) {
                    sig.append(i == 0 ? "" : ",").append(p[i].getSimpleName());
                }
                if (b.indexOf(sig.append(')').toString()) < 0) {
                    b.append(b.length() == 0 ? "" : "; ").append(sig);
                }
            }
        }
        return b.length() == 0 ? "(none)" : b.toString();
    }

    /** Set on the main thread while this IME is the selected one. */
    private static volatile CompanionIme instance;

    private final Handler main = new Handler(Looper.getMainLooper());
    private InputConnection connection;

    @Override
    public void onCreate() {
        super.onCreate();
        instance = this;
        Log.i(CompanionService.TAG, "ime created");
    }

    @Override
    public void onDestroy() {
        instance = null;
        connection = null;
        super.onDestroy();
    }

    /**
     * A status indicator, not a keyboard. The user needs to be able to see WHICH input method is
     * active before typing into a field - an IME that draws nothing is indistinguishable from one
     * that failed to engage. Nothing here is interactive and nothing consumes keys: the relay still
     * happens over the socket, and commits still go through the InputConnection.
     *
     * Dark surface and light text on purpose: this shows on a TV, often in a dark room.
     */
    @Override
    public View onCreateInputView() {
        TextView bar = new TextView(this);
        bar.setText("READY TO RELAY INPUTS");
        bar.setTextColor(Color.WHITE);
        bar.setBackgroundColor(Color.BLACK);
        bar.setTypeface(Typeface.MONOSPACE);
        bar.setTextSize(TypedValue.COMPLEX_UNIT_SP, 16);
        bar.setGravity(Gravity.CENTER);
        bar.setPadding(24, 20, 24, 20);
        return bar;
    }

    @Override
    public View onCreateCandidatesView() {
        return null;
    }

    @Override
    public void onStartInput(EditorInfo attribute, boolean restarting) {
        super.onStartInput(attribute, restarting);
        connection = getCurrentInputConnection();
        Log.i(CompanionService.TAG, "ime start input: "
                + (attribute == null ? "?" : attribute.packageName)
                + " connection=" + (connection != null));
    }

    @Override
    public void onFinishInput() {
        connection = null;
        super.onFinishInput();
    }

    /** True when this IME is selected and a field may be reachable. */
    public static boolean selected() {
        return instance != null;
    }

    /**
     * The live connection to the focused field, or null. Main thread only.
     *
     * The connection is cached by onStartInput and topped up with getCurrentInputConnection,
     * so a caller that writes and then reads in one UI-thread pass sees one connection.
     */
    public static InputConnection liveConnection() {
        CompanionIme ime = instance;
        if (ime == null) {
            return null;
        }
        InputConnection c = ime.connection;
        if (c == null) {
            c = ime.getCurrentInputConnection();
        }
        return c;
    }

    /**
     * Hands {@code text} to the focused field, on the main thread (the IME's own
     * thread), and waits for the answer so the socket reply can carry the result.
     *
     * @return what was actually passed to commitText, or why nothing was.
     */
    public static CommitResult commit(final String text) {
        final CompanionIme ime = instance;
        if (ime == null) {
            return CommitResult.failure("ime_not_selected");
        }

        final CommitResult[] box = new CommitResult[1];
        final CountDownLatch latch = new CountDownLatch(1);
        ime.main.post(new Runnable() {
            @Override
            public void run() {
                try {
                    InputConnection c = ime.connection;
                    if (c == null) {
                        c = ime.getCurrentInputConnection();
                    }
                    if (c == null) {
                        box[0] = CommitResult.failure("no_input_connection");
                        return;
                    }
                    boolean accepted = c.commitText(text, 1);
                    box[0] = accepted
                            ? CommitResult.success(text)
                            : CommitResult.failure("commit_rejected");
                } catch (Throwable t) {
                    box[0] = CommitResult.failure("exception: " + t);
                } finally {
                    latch.countDown();
                }
            }
        });

        try {
            if (!latch.await(3, TimeUnit.SECONDS)) {
                return CommitResult.failure("commit_timeout");
            }
        } catch (InterruptedException e) {
            Thread.currentThread().interrupt();
            return CommitResult.failure("commit_interrupted");
        }
        return box[0] == null ? CommitResult.failure("commit_lost") : box[0];
    }

    /** One commit's outcome: the string handed to the field, or the reason none was. */
    public static final class CommitResult {
        public final boolean ok;
        public final String error;
        public final String text;

        private CommitResult(boolean ok, String error, String text) {
            this.ok = ok;
            this.error = error;
            this.text = text;
        }

        static CommitResult success(String text) {
            return new CommitResult(true, null, text);
        }

        static CommitResult failure(String error) {
            return new CommitResult(false, error, null);
        }
    }

    /**
     * Asks the focused field for its text through the IME's own InputConnection, on the
     * main thread. Three modes, one round trip each:
     *
     *   surrounding (default) - getSurroundingText. The read path this card is about.
     *   cursor                - getTextBeforeCursor + getTextAfterCursor. The API-30
     *                           neighbour, for when getSurroundingText is not there.
     *   extracted             - getExtractedText, which reports a selection and says
     *                           whether its text is a window (partialStart/EndOffset).
     *
     * A null return is reported as a null_* error - it is the API refusing for this field,
     * and is a result, not something to paper over with a fallback.
     *
     * @return the field's text (possibly empty) or the exact reason there is none.
     */
    public static ReadResult read(final String mode, final int before, final int after) {
        final CompanionIme ime = instance;
        if (ime == null) {
            return ReadResult.failure("ime_not_selected");
        }

        final ReadResult[] box = new ReadResult[1];
        final CountDownLatch latch = new CountDownLatch(1);
        ime.main.post(new Runnable() {
            @Override
            public void run() {
                try {
                    InputConnection c = ime.connection;
                    if (c == null) {
                        c = ime.getCurrentInputConnection();
                    }
                    if (c == null) {
                        box[0] = ReadResult.failure("no_input_connection");
                        return;
                    }
                    if ("cursor".equals(mode)) {
                        box[0] = readCursor(c, before, after);
                    } else if ("extracted".equals(mode)) {
                        box[0] = readExtracted(c);
                    } else {
                        box[0] = readSurrounding(c, before, after);
                    }
                } catch (Throwable t) {
                    box[0] = ReadResult.failure("exception: " + t);
                } finally {
                    latch.countDown();
                }
            }
        });

        try {
            if (!latch.await(3, TimeUnit.SECONDS)) {
                return ReadResult.failure("read_timeout");
            }
        } catch (InterruptedException e) {
            Thread.currentThread().interrupt();
            return ReadResult.failure("read_interrupted");
        }
        return box[0] == null ? ReadResult.failure("read_lost") : box[0];
    }

    /** getSurroundingText: the API the client wants to move its field reads onto. */
    private static ReadResult readSurrounding(InputConnection c, int before, int after) {
        CharSequence s;
        try {
            s = surroundingText(c, before, after);
        } catch (java.lang.reflect.InvocationTargetException e) {
            Throwable cause = e.getCause() == null ? e : e.getCause();
            return ReadResult.failure(
                    "rejected: " + cause.getClass().getName() + ": " + cause.getMessage());
        } catch (NoSuchMethodException e) {
            return ReadResult.failure("no_such_method: " + e.getMessage());
        } catch (Throwable t) {
            return ReadResult.failure("exception: " + t);
        }
        if (s == null) {
            return ReadResult.failure("surrounding_text_null");
        }
        ReadResult r = ReadResult.success("surrounding_text", s.toString());
        r.spanned = s instanceof Spanned;
        if (r.spanned) {
            r.selectionStart = Selection.getSelectionStart(s);
            r.selectionEnd = Selection.getSelectionEnd(s);
        }
        return r;
    }

    /** getTextBeforeCursor + getTextAfterCursor, with the caret derived from the prefix. */
    private static ReadResult readCursor(InputConnection c, int before, int after) {
        CharSequence b = c.getTextBeforeCursor(before, 0);
        CharSequence a = c.getTextAfterCursor(after, 0);
        if (b == null && a == null) {
            return ReadResult.failure("text_before_cursor_null");
        }
        String prefix = b == null ? "" : b.toString();
        String suffix = a == null ? "" : a.toString();
        ReadResult r = ReadResult.success("text_before_cursor", prefix + suffix);
        // The caret is where the prefix ends - derived from the API, not reported by it.
        r.selectionStart = prefix.length();
        r.selectionEnd = prefix.length();
        r.caretDerived = true;
        r.spanned = b instanceof Spanned || a instanceof Spanned;
        return r;
    }

    /** getExtractedText: text plus a selection the API reports itself, and window offsets. */
    private static ReadResult readExtracted(InputConnection c) {
        ExtractedTextRequest req = new ExtractedTextRequest();
        req.flags = 0;
        req.hintMaxLines = 0;
        req.hintMaxChars = 0;
        req.token = 0;
        ExtractedText et = c.getExtractedText(req, 0);
        if (et == null) {
            return ReadResult.failure("extracted_text_null");
        }
        ReadResult r = ReadResult.success("extracted_text",
                et.text == null ? "" : et.text.toString());
        r.selectionStart = et.selectionStart;
        r.selectionEnd = et.selectionEnd;
        r.startOffset = et.startOffset;
        r.partialStartOffset = et.partialStartOffset;
        r.partialEndOffset = et.partialEndOffset;
        r.extractedFlags = et.flags;
        r.spanned = et.text instanceof Spanned;
        return r;
    }

    /** One read's outcome: the field's text plus whatever the API said about the caret. */
    public static final class ReadResult {
        public boolean ok;
        public String error;
        public String source;
        public String text = "";
        /** -1 means the API did not report a selection. */
        public int selectionStart = -1;
        public int selectionEnd = -1;
        public boolean spanned;
        /** True when the caret was derived from a prefix length rather than reported. */
        public boolean caretDerived;
        public int startOffset = -1;
        public int partialStartOffset = -1;
        public int partialEndOffset = -1;
        public int extractedFlags = -1;

        private ReadResult() {}

        static ReadResult success(String source, String text) {
            ReadResult r = new ReadResult();
            r.ok = true;
            r.source = source;
            r.text = text == null ? "" : text;
            return r;
        }

        static ReadResult failure(String error) {
            ReadResult r = new ReadResult();
            r.ok = false;
            r.source = "unavailable";
            r.error = error;
            return r;
        }
    }
}
