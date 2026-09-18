package com.tvremote.companion;

import android.os.Build;
import android.os.Process;

import java.util.List;
import java.util.Locale;

/**
 * The wire protocol: one command per line, one JSON object per line back.
 *
 * Adding a verb is one case here plus (if it needs state) a method on the server -
 * read/focus/volume land here later. Every reply is flat JSON with "ok",
 * so a client never has to guess at the shape, and an unknown verb still answers.
 */
public final class Protocol {
    /** Every verb this build understands; echoed back on unknown commands. */
    private static final String KNOWN = "ping, commit, read, field, ime, tree, find, click, focused,"
            + " volume, global";

    /** The `field` sub-verbs, echoed back on an unknown one. */
    private static final String KNOWN_FIELD = "focus, set, append, clear, get, target";

    /** read's default window, symmetric around the caret. Large on purpose: if the field
     *  hands back less than this, the clamp is the device's, not our request. */
    private static final int READ_BEFORE = 5000;
    private static final int READ_AFTER = 5000;

    private Protocol() {}

    /** @return the reply line, without its trailing newline. */
    public static String dispatch(String line, CompanionServer server) {
        String trimmed = line.trim();
        if (trimmed.isEmpty()) {
            return Json.obj()
                    .putBool("ok", false)
                    .putStr("error", "empty_command")
                    .done();
        }

        String[] parts = trimmed.split("\\s+");
        String verb = parts[0].toLowerCase(Locale.US);

        switch (verb) {
            case "ping":
                return Json.obj()
                        .putBool("ok", true)
                        .putStr("cmd", "ping")
                        .putStr("version", server.version())
                        .putNum("uptime_ms", server.uptimeMs())
                        .putNum("pid", Process.myPid())
                        .putNum("port", server.port())
                        .putStr("model", Build.MODEL)
                        .putNum("sdk", Build.VERSION.SDK_INT)
                        .done();
            case "commit":
                return commit(argument(line));
            case "read":
                return read(parts);
            case "field":
                return field(server, line, parts);
            // `ime on|off|state`: select the companion's own IME from inside the app, so the
            // typing path carries no adb call. The write this needs is the one adb's `ime set`
            // makes - see ImeSelect's class comment.
            case "ime":
                return ImeSelect.dispatch(server.context(), parts);
            // The accessibility half: read the on-screen tree and click a node by name instead
            // of walking to it with D-pad presses. See CompanionAccess.
            case "tree":
            case "find":
            case "click":
            case "focused":
            case "global":
                return access(verb, line, parts);
            // The audio half: the TV's own volume, in-process. See CompanionAudio.
            case "volume":
                return volume(server, parts);
            default:
                return Json.obj()
                        .putBool("ok", false)
                        .putStr("error", "unknown_command")
                        .putStr("cmd", verb)
                        .putStr("known", KNOWN)
                        .done();
        }
    }

    /**
     * commit &lt;text&gt; - hand the focused field the text through the companion IME's
     * InputConnection. No keycodes, so the TV's layout cannot rewrite it.
     */
    private static String commit(String text) {
        CompanionIme.CommitResult r = CompanionIme.commit(text);
        if (!r.ok) {
            return Json.obj()
                    .putBool("ok", false)
                    .putStr("cmd", "commit")
                    .putStr("error", r.error)
                    .putNum("requested_len", text.length())
                    .done();
        }
        return Json.obj()
                .putBool("ok", true)
                .putStr("cmd", "commit")
                .putNum("len", r.text.length())
                .putStr("text", r.text)
                .done();
    }

    /**
     * read [cursor|extracted] [before] [after] - the focused field's text through the
     * companion IME's InputConnection. Default mode is getSurroundingText; "cursor" uses
     * getTextBeforeCursor/getTextAfterCursor, "extracted" uses getExtractedText.
     * "source" names the API the text came from, or "unavailable" with "error" carrying
     * the exact reason it did not.
     */
    private static String read(String[] parts) {
        String mode = "surrounding";
        int argBase = 1;
        if (parts.length > 1 && !isNumber(parts[1])) {
            mode = parts[1].toLowerCase(Locale.US);
            argBase = 2;
        }
        int before = READ_BEFORE;
        int after = READ_AFTER;
        try {
            if (parts.length > argBase) {
                before = Integer.parseInt(parts[argBase]);
            }
            if (parts.length > argBase + 1) {
                after = Integer.parseInt(parts[argBase + 1]);
            }
        } catch (NumberFormatException e) {
            return Json.obj()
                    .putBool("ok", false)
                    .putStr("cmd", "read")
                    .putStr("source", "unavailable")
                    .putStr("error", "not_a_number")
                    .done();
        }
        if (before < 0 || after < 0) {
            before = 0;
            after = 0;
        }

        CompanionIme.ReadResult r = CompanionIme.read(mode, before, after);
        if (!r.ok) {
            return Json.obj()
                    .putBool("ok", false)
                    .putStr("cmd", "read")
                    .putStr("mode", mode)
                    .putStr("source", r.source)
                    .putStr("error", r.error)
                    .putNum("requested_before", before)
                    .putNum("requested_after", after)
                    .done();
        }

        Json.Obj o = Json.obj()
                .putBool("ok", true)
                .putStr("cmd", "read")
                .putStr("mode", mode)
                .putStr("source", r.source)
                .putStr("text", r.text)
                .putNum("len", r.text.length())
                .putNum("selectionStart", r.selectionStart)
                .putNum("selectionEnd", r.selectionEnd)
                .putBool("spanned", r.spanned)
                .putNum("requested_before", before)
                .putNum("requested_after", after);
        if (r.caretDerived) {
            o.putBool("caretDerived", true);
        }
        if ("extracted_text".equals(r.source)) {
            o.putNum("startOffset", r.startOffset)
                    .putNum("partialStartOffset", r.partialStartOffset)
                    .putNum("partialEndOffset", r.partialEndOffset)
                    .putNum("extractedFlags", r.extractedFlags);
        }
        return o.done();
    }

    private static boolean isNumber(String s) {
        if (s.isEmpty()) {
            return false;
        }
        for (int i = 0; i < s.length(); i++) {
            if (!Character.isDigit(s.charAt(i))) {
                return false;
            }
        }
        return true;
    }

    /**
     * tree [maxNodes] | find &lt;selector&gt; | click &lt;selector&gt; | focused - the accessibility
     * half (CompanionAccess), for reaching a target that can be NAMED rather than walked to with
     * key presses.
     *
     *   tree [maxNodes]  the active window's node tree, flat and depth-first: every node with its
     *                    path, resource-id, text, content-description, class, package, bounds,
     *                    state and child count. `nodes`, `depth` and `truncated` are data.
     *   find &lt;selector&gt;  nodes whose resource-id (substring), text or content-description match;
     *                    `matched_by` names which of the three matched
     *   click &lt;selector&gt; ACTION_CLICK on the best match, climbing to the nearest clickable
     *                    ancestor when the match itself is not clickable; the reply carries both
     *                    `matched` and `node` (the view the action went to) so the caller can see
     *                    what it hit
     *   focused          the node holding input focus: id, text, package, bounds
     *
     * Every reply carries `flags` (the live AccessibilityServiceInfo flag set) and `bound`, so a
     * "no_window" answer can be told apart from a service the framework never connected.
     */
    private static String access(String verb, String line, String[] parts) {
        if ("tree".equals(verb)) {
            int limit = CompanionAccess.MAX_NODES;
            if (parts.length > 1) {
                try {
                    limit = Integer.parseInt(parts[1]);
                } catch (NumberFormatException e) {
                    return accessError(verb, null, "not_a_number");
                }
            }
            return accessReply(verb, CompanionAccess.tree(limit));
        }
        if ("focused".equals(verb)) {
            return accessReply(verb, CompanionAccess.focused());
        }
        // `global <action>`: the action name is the argument, and CompanionAccess answers
        // unknown_action for one it does not know, so there is no separate error path here.
        if ("global".equals(verb)) {
            return accessReply(verb, CompanionAccess.global(argument(line).trim()));
        }
        // The selector is everything after the verb, untrimmed by the tokenizer split so a text
        // selector can contain spaces.
        String selector = argument(line).trim();
        if (selector.isEmpty()) {
            return accessError(verb, null, "missing_selector");
        }
        return accessReply(verb, "find".equals(verb)
                ? CompanionAccess.find(selector)
                : CompanionAccess.click(selector));
    }

    /** One flat reply for every accessibility verb: `ok:true` carries the state, `ok:false` the reason. */
    private static String accessReply(String verb, CompanionAccess.Snapshot s) {
        Json.Obj o = Json.obj().putStr("cmd", verb).putBool("ok", s.ok);
        if (!s.ok && s.error != null) {
            o.putStr("error", s.error);
        }
        if (s.selector != null) {
            o.putStr("selector", s.selector);
        }
        if (s.via != null) {
            o.putStr("via", s.via);
        }
        if (s.matchedBy != null) {
            o.putStr("matched_by", s.matchedBy);
        }
        o.putNum("ms", s.ms);
        if ("tree".equals(verb) || "find".equals(verb)) {
            o.putNum("nodes", s.nodes)
                    .putNum("visited", s.visited)
                    .putNum("depth", s.depth)
                    .putBool("truncated", s.truncated)
                    .put("items", nodesJson(s.items));
        }
        if ("click".equals(verb)) {
            o.putNum("climbed", s.climbed).putBool("performed", s.performed);
            if (s.matched != null) {
                o.put("matched", nodeJson(s.matched));
            }
            if (s.node != null) {
                o.put("node", nodeJson(s.node));
            }
        }
        if ("focused".equals(verb)) {
            if (s.node != null) {
                o.put("node", nodeJson(s.node));
            }
        }
        if ("global".equals(verb)) {
            // `performed` is performGlobalAction's own return value, which is a statement about the
            // dispatch, not about what the TV then did with it.
            o.putStr("action", s.action).putBool("performed", s.performed);
            if ("unknown_action".equals(s.error)) {
                o.putStr("known", CompanionAccess.KNOWN_GLOBALS);
            }
        }
        return o.putNum("flags", CompanionAccess.liveFlags())
                .putBool("can_retrieve_window_content", CompanionAccess.canRetrieveWindowContent())
                .putBool("bound", CompanionAccess.bound())
                .done();
    }

    /** The same shape for a verb that never reached the service. */
    private static String accessError(String verb, String selector, String error) {
        Json.Obj o = Json.obj().putStr("cmd", verb).putBool("ok", false).putStr("error", error);
        if (selector != null) {
            o.putStr("selector", selector);
        }
        return o.putNum("flags", CompanionAccess.liveFlags())
                .putBool("can_retrieve_window_content", CompanionAccess.canRetrieveWindowContent())
                .putBool("bound", CompanionAccess.bound())
                .done();
    }

    /**
     * volume | volume &lt;n&gt; [ui] - the TV's own volume, in-process (CompanionAudio).
     *
     *   volume          the level as it is NOW: level, min, max, muted, stream, stream_id
     *   volume &lt;n&gt;      set it, then read it back. `level` is the manager's answer AFTER the write,
     *                   `requested` what was asked for, `before` what it was, `matched` whether the
     *                   two agree, `clamped` whether n was outside 0..max
     *   volume &lt;n&gt; ui   the same with AudioManager.FLAG_SHOW_UI - asking the platform for its own
     *                   on-screen volume panel. `show_ui` reports that a flag was passed, never that
     *                   the TV drew anything: whether it does is measured, not assumed.
     *
     * A read is the same call path with no write, so one wording covers both: nothing here fails
     * because the TV cannot be asked.
     */
    private static String volume(CompanionServer server, String[] parts) {
        int requested = -1;
        boolean showUi = false;
        if (parts.length > 1) {
            if (!isNumber(parts[1])) {
                return Json.obj()
                        .putBool("ok", false)
                        .putStr("cmd", "volume")
                        .putStr("error", "not_a_number")
                        .putStr("arg", parts[1])
                        .putStr("shape", "volume | volume <n> [ui]")
                        .done();
            }
            try {
                requested = Integer.parseInt(parts[1]);
            } catch (NumberFormatException e) {
                return Json.obj()
                        .putBool("ok", false)
                        .putStr("cmd", "volume")
                        .putStr("error", "out_of_range_int")
                        .putStr("arg", parts[1])
                        .done();
            }
            if (parts.length > 2) {
                if ("ui".equalsIgnoreCase(parts[2])) {
                    showUi = true;
                } else {
                    return Json.obj()
                            .putBool("ok", false)
                            .putStr("cmd", "volume")
                            .putStr("error", "unknown_flag")
                            .putStr("arg", parts[2])
                            .putStr("known", "ui")
                            .done();
                }
            }
        }
        CompanionAudio.Snapshot s = requested < 0
                ? CompanionAudio.read(server.context())
                : CompanionAudio.set(server.context(), requested, showUi);

        Json.Obj o = Json.obj().putStr("cmd", "volume").putBool("ok", s.ok);
        if (!s.ok) {
            return o.putStr("error", s.error).putNum("ms", s.ms).done();
        }
        o.putNum("level", s.level)
                .putNum("min", s.min)
                .putNum("max", s.max)
                .putBool("muted", s.muted)
                .putStr("stream", CompanionAudio.STREAM_NAME)
                .putNum("stream_id", CompanionAudio.STREAM);
        if (s.requested >= 0) {
            o.putNum("requested", s.requested)
                    .putNum("before", s.before)
                    .putBool("matched", s.level == clamp(s.requested, s.min, s.max))
                    .putBool("clamped", s.clamped)
                    .putBool("show_ui", s.showUi)
                    .putNum("flags", s.flags);
        }
        return o.putNum("ms", s.ms).done();
    }

    private static int clamp(int v, int min, int max) {
        return Math.max(min, Math.min(max, v));
    }

    /** A node array. Flat, one element per node, in depth-first order. */
    private static String nodesJson(List<CompanionAccess.Node> list) {
        StringBuilder b = new StringBuilder(list.size() * 200 + 2).append('[');
        for (int i = 0; i < list.size(); i++) {
            if (i > 0) {
                b.append(',');
            }
            b.append(nodeJson(list.get(i)));
        }
        return b.append(']').toString();
    }

    /**
     * One node. Every field is present on every node - an empty text is `null`, never a missing
     * key - so a client can read it without guessing.
     */
    private static String nodeJson(CompanionAccess.Node n) {
        return Json.obj()
                .putStr("path", n.path)
                .putNum("level", n.level)
                .putStr("id", n.id)
                .putStr("text", n.text)
                .putStr("desc", n.desc)
                .putStr("cls", n.cls)
                .putStr("pkg", n.pkg)
                .put("bounds", "[" + n.left + "," + n.top + "," + n.right + "," + n.bottom + "]")
                .putBool("click", n.clickable)
                .putBool("focusable", n.focusable)
                .putBool("focused", n.focused)
                .putBool("enabled", n.enabled)
                .putBool("visible", n.visible)
                .putBool("selected", n.selected)
                .putBool("scrollable", n.scrollable)
                .putBool("editable", n.editable)
                .putNum("kids", n.children)
                .putStr("match", n.field)
                .done();
    }

    /**
     * field focus | set &lt;text&gt; | append &lt;text&gt; | clear | get [target] | target [name] -
     * the companion's own test screen (TestFieldActivity), so typing is developed against a
     * field this app owns instead of a third-party search box.
     *
     *   focus        bring the screen to the front, put the caret in the active box, reply with
     *                its contents, length and caret as they are right now
     *   set &lt;text&gt;   clear, then commit the text through the IME's live InputConnection
     *   append &lt;text&gt; the same, at the caret, leaving what is there
     *   clear        one in-process clear; `removed` is what the view actually lost
     *   get [target] contents, length and caret - the ground truth for typing tests. No argument
     *                reads the ACTIVE field; `edittext`/`streamed` reads that one either way
     *   target [name] switch which field is focused and receives commits (`edittext` or
     *                `streamed`); with no name, report the current target and its contents
     *
     * `streamed` is the SmartTube-shaped field: it paints its text one character per tick, so a
     * read taken straight after a commit returns a prefix, and it presents `hint` while empty,
     * so a naive read of an empty field picks up the placeholder. Its replies carry `content`
     * (what was committed), `rendered` (what is painted now), `settled` and `render_ms`. The
     * plain field's reply shape is unchanged.
     *
     * set and append refuse to write when the companion IME is not the TV's selected input
     * method: `ok:false` with `error:"ime_not_selected"` (plus default_ime, which names the
     * IME that is selected) instead of quietly writing the box through another path.
     */
    private static String field(CompanionServer server, String line, String[] parts) {
        String verb = parts.length > 1 ? parts[1].toLowerCase(Locale.US) : "";
        if ("focus".equals(verb)) {
            return fieldReply("focus", TestFieldActivity.focus(server.context()));
        }
        if ("set".equals(verb)) {
            return fieldReply("set", TestFieldActivity.set(rest(line)));
        }
        if ("append".equals(verb)) {
            return fieldReply("append", TestFieldActivity.append(rest(line)));
        }
        if ("clear".equals(verb)) {
            return fieldReply("clear", TestFieldActivity.clear());
        }
        if ("get".equals(verb)) {
            return fieldReply("get", TestFieldActivity.get(parts.length > 2 ? parts[2] : null));
        }
        if ("target".equals(verb)) {
            return fieldReply("target", TestFieldActivity.target(server.context(),
                    parts.length > 2 ? parts[2] : null));
        }
        return Json.obj()
                .putBool("ok", false)
                .putStr("cmd", "field")
                .putStr("error", verb.isEmpty() ? "missing_field_verb" : "unknown_field_verb")
                .putStr("verb", verb)
                .putStr("known", KNOWN_FIELD)
                .done();
    }

    /** One flat reply for every field op: `ok:true` carries the state, `ok:false` the reason. */
    private static String fieldReply(String verb, TestFieldActivity.Snapshot s) {
        Json.Obj o = Json.obj().putStr("cmd", "field").putStr("verb", verb);
        if (!s.ok) {
            o.putBool("ok", false).putStr("error", s.error);
            if (s.knownTargets != null) {
                o.putStr("known", s.knownTargets);
            }
            if (s.defaultIme != null) {
                o.putStr("default_ime", s.defaultIme).putBool("ime_selected", s.imeSelected);
            }
            if (s.waitedMs > 0) {
                o.putNum("waited_ms", s.waitedMs);
            }
            if (s.target != null) {
                o.putStr("target", s.target);
            }
            // Measured on this TV: the app is IMPORTANT_BACKGROUND and TCL's boot policy
            // (TclAppBoot, reason "default_borbid") denies it the foreground-service state, so
            // starting an activity from the service is blocked once the app is in the
            // background. The activity is exported for exactly this case: one plain adb call
            // (min 0.145 s), then `field focus` is instant. Say so instead of making the caller
            // guess.
            if ("field_not_front".equals(s.error) || "field_not_focused".equals(s.error)) {
                o.putStr("hint", "am start -n com.tvremote.companion/.TestFieldActivity");
            }
            return o.done();
        }
        o.putBool("ok", true)
                .putStr("text", s.text)
                .putNum("len", s.len)
                .putNum("selectionStart", s.selStart)
                .putNum("selectionEnd", s.selEnd)
                .putBool("focused", s.focused);
        if (s.via != null) {
            o.putStr("via", s.via);
        }
        if ("focus".equals(verb) || "target".equals(verb)) {
            o.putNum("waited_ms", s.waitedMs);
            if (s.activity != null) {
                o.putStr("activity", s.activity);
            }
        }
        if ("set".equals(verb) || "append".equals(verb)) {
            o.putNum("requested_len", s.requested).putNum("cleared", s.changed);
        }
        if ("clear".equals(verb)) {
            o.putNum("removed", s.changed);
        }
        // The streamed field is the only one whose reply carries the render gap, and the only
        // one that names itself - the plain field's reply is exactly what it was.
        if (TestFieldActivity.TARGET_STREAMED.equals(s.target)) {
            o.putStr("target", s.target)
                    .putStr("content", s.content)
                    .putStr("rendered", s.rendered)
                    .putBool("settled", s.settled)
                    .putBool("revealing", s.revealing)
                    .putStr("hint", s.hint);
            if (s.renderMs >= 0) {
                o.putNum("render_ms", s.renderMs);
            }
        }
        return o.done();
    }

    /**
     * The raw remainder of the line after the verb, the sub-verb and the whitespace
     * following them, untrimmed: `field set  x` hands over "x".
     */
    private static String rest(String line) {
        int i = 0;
        while (i < line.length() && !Character.isWhitespace(line.charAt(i))) {
            i++;
        }
        while (i < line.length() && Character.isWhitespace(line.charAt(i))) {
            i++;
        }
        while (i < line.length() && !Character.isWhitespace(line.charAt(i))) {
            i++;
        }
        while (i < line.length() && Character.isWhitespace(line.charAt(i))) {
            i++;
        }
        return line.substring(i);
    }

    /**
     * The raw remainder of the line after the verb and the whitespace that follows
     * it, untrimmed: text is forwarded exactly as it arrived, leading spaces and all.
     */
    private static String argument(String line) {
        int i = 0;
        while (i < line.length() && !Character.isWhitespace(line.charAt(i))) {
            i++;
        }
        while (i < line.length() && Character.isWhitespace(line.charAt(i))) {
            i++;
        }
        return line.substring(i);
    }
}
