package com.zapette.companion;

import android.accessibilityservice.AccessibilityService;
import android.accessibilityservice.AccessibilityServiceInfo;
import android.content.Intent;
import android.graphics.Rect;
import android.os.Handler;
import android.os.Looper;
import android.os.SystemClock;
import android.util.Log;
import android.view.accessibility.AccessibilityEvent;
import android.view.accessibility.AccessibilityNodeInfo;

import java.util.ArrayList;
import java.util.List;
import java.util.Locale;
import java.util.concurrent.CountDownLatch;
import java.util.concurrent.TimeUnit;

/**
 * The accessibility half of the companion: read the on-screen node tree, and click a node
 * by what it is CALLED (resource-id / text / content-description) instead of walking to it
 * with D-pad presses.
 *
 * Why it exists: reaching a target in a TV app by key presses is guesswork - the client has a
 * recipe for SmartTube's search field only because a previous run hunted for it by hand. A
 * click by resource-id is the same intent expressed once, and the reply names the node that
 * was clicked, so the caller can see what it hit.
 *
 * What it is NOT: a key injector. INJECT_EVENTS is signature-level, so real D-pad keycodes
 * stay on `input` / monkey (see the client's transport). This service only reads the tree and
 * performs node actions.
 *
 * Nothing here runs on an event: no callback reacts to accessibility events, and the service
 * asks for typeWindowStateChanged only because a service with no event type is not delivered
 * a window to read. The verbs are polled over the socket, on demand.
 *
 * Threading: an AccessibilityService is connected to the framework on its main thread, and the
 * socket server calls in from a connection thread. Every entry point below posts to the main
 * looper and waits for the answer, exactly like CompanionIme.commit - so the reply the socket
 * sends back carries a result, not a promise.
 */
public class CompanionAccess extends AccessibilityService {

    /** The enabled-services component name, in the short form the settings value uses. */
    public static final String SERVICE_ID = "com.zapette.companion/.CompanionAccess";

    /**
     * The flags this service asks for, and why exactly these two:
     *
     *   FLAG_REPORT_VIEW_IDS (0x10) - without it getViewIdResourceName() returns null for every
     *       node, which is the whole point of the service: a click target that can be named.
     *   FLAG_INCLUDE_NOT_IMPORTANT_VIEWS (0x2) - views the app marked not important for
     *       accessibility stay in the tree. TV apps flag decorative/transitional views that way,
     *       and a container that is not important can still hold the ones that are.
     *
     * Deliberately NOT requested:
     *   FLAG_REQUEST_FILTER_KEY_EVENTS (0x20) - it would take key events away from the TV's own
     *       remote. The physical remote is the primary input on this set; the companion never
     *       gets between the user and their keys.
     *   FLAG_RETRIEVE_INTERACTIVE_WINDOWS (0x40) - getRootInActiveWindow() already returns the
     *       window a click can land in, and every extra window is another cross-process fetch on
     *       a 2 GB TV. Ask for it only if a target turns out to live in a separate window.
     *   FLAG_REQUEST_TOUCH_EXPLORATION_MODE / ENHANCED_WEB_ACCESSIBILITY - no pointer input, no
     *       web views here.
     */
    public static final int FLAGS = AccessibilityServiceInfo.FLAG_REPORT_VIEW_IDS
            | AccessibilityServiceInfo.FLAG_INCLUDE_NOT_IMPORTANT_VIEWS;

    /** Node cap for a walk: a launcher or player tree is tens of nodes, this is a runaway guard. */
    public static final int MAX_NODES = 1500;

    /** The global actions this service will perform, and the names the wire uses for them. */
    public static final String KNOWN_GLOBALS = "back, home, recents, notifications, quick_settings";

    /** How far up from a matched node to look for the clickable view that owns it. */
    private static final int MAX_CLIMB = 6;

    /** The socket's own per-verb budget is 2.5 s; answering late is worse than answering "no". */
    private static final long POST_TIMEOUT_MS = 4000;

    /** Set on the main thread while the framework has this service connected. */
    private static volatile CompanionAccess instance;

    /** What the framework is really running us with, read back from getServiceInfo(). */
    private static volatile int liveFlags = -1;
    private static volatile boolean liveCanRetrieve;

    private final Handler main = new Handler(Looper.getMainLooper());

    @Override
    protected void onServiceConnected() {
        super.onServiceConnected();
        instance = this;
        readServiceInfo(true);
        Log.i(CompanionService.TAG, "accessibility connected: flags=" + liveFlags
                + " canRetrieveWindowContent=" + liveCanRetrieve);
    }

    /**
     * Re-assert the flag set on the live service info, then remember what it reads back as.
     *
     * The XML declaration (res/xml/accessibility_service.xml) is what the framework parses at
     * bind time, so this is belt and braces: it is also the only way to REPORT the effective set
     * rather than the intended one, and the reply carries it. `flags` in every access reply is
     * this value - if it ever comes back without 0x10, resource ids are the reason, not the walk.
     */
    private void readServiceInfo(boolean assertFlags) {
        try {
            AccessibilityServiceInfo info = getServiceInfo();
            if (info == null) {
                return;
            }
            if (assertFlags) {
                info.flags |= FLAGS;
                setServiceInfo(info);
            }
            liveFlags = info.flags;
            liveCanRetrieve = (info.getCapabilities()
                    & AccessibilityServiceInfo.CAPABILITY_CAN_RETRIEVE_WINDOW_CONTENT) != 0;
        } catch (Throwable t) {
            Log.w(CompanionService.TAG, "service info unreadable: " + t);
        }
    }

    @Override
    public void onAccessibilityEvent(AccessibilityEvent event) {
        // Nothing is subscribed to on purpose: the verbs are polled, so an event would only cost
        // the TV work. The event type is requested purely so the service is bound to a window.
    }

    @Override
    public void onInterrupt() {
        // No feedback (audio/haptic/vibration) is delivered by this service, so there is nothing
        // an interrupt can stop.
    }

    @Override
    public boolean onUnbind(Intent intent) {
        instance = null;
        Log.i(CompanionService.TAG, "accessibility unbound");
        return super.onUnbind(intent);
    }

    @Override
    public void onDestroy() {
        instance = null;
        super.onDestroy();
    }

    // --- what the socket server asks about ------------------------------------------------

    /** True when the framework has this service connected (enabled is not the same thing). */
    public static boolean bound() {
        return instance != null;
    }

    /** The flags the connection is really running with, or -1 before connect. */
    public static int liveFlags() {
        return liveFlags;
    }

    public static boolean canRetrieveWindowContent() {
        return liveCanRetrieve;
    }

    /** `tree [maxNodes]` - the active window's node tree, flat, in depth-first order. */
    public static Snapshot tree(final int maxNodes) {
        return post(new Body() {
            @Override public Snapshot run() {
                return treeOnMain(maxNodes);
            }
        });
    }

    /** `find &lt;selector&gt;` - every node whose resource-id / text / content-description matches. */
    public static Snapshot find(final String selector) {
        return post(new Body() {
            @Override public Snapshot run() {
                return findOnMain(selector);
            }
        });
    }

    /** `click &lt;selector&gt;` - ACTION_CLICK on the best match, or on the clickable view above it. */
    public static Snapshot click(final String selector) {
        return post(new Body() {
            @Override public Snapshot run() {
                return clickOnMain(selector);
            }
        });
    }

    /** `focused` - the node holding input focus (what a key would land on). */
    public static Snapshot focused() {
        return post(new Body() {
            @Override public Snapshot run() {
                return focusedOnMain();
            }
        });
    }

    /**
     * `global &lt;action&gt;` - one of {@link #KNOWN_GLOBALS}, dispatched to the platform through
     * AccessibilityService.performGlobalAction.
     *
     * This is the half of a remote that is NOT a key: the TV's own back / home / recents /
     * notifications / quick-settings handling is reachable from here without INJECT_EVENTS, which a
     * sideloaded app cannot hold (signature permission). What the platform does with the action is
     * another matter entirely - a global action can be accepted and do nothing (no recents screen
     * on Android TV, for instance), so the reply reports what performGlobalAction RETURNED and the
     * caller has to confirm the effect on the window or the tree. See MEASUREMENTS.txt.
     */
    public static Snapshot global(final String action) {
        return post(new Body() {
            @Override public Snapshot run() {
                return globalOnMain(action);
            }
        });
    }

    // --- main-thread implementations -------------------------------------------------------

    private static Snapshot treeOnMain(int maxNodes) {
        Snapshot s = new Snapshot();
        s.selector = null;
        long t0 = SystemClock.elapsedRealtime();
        AccessibilityNodeInfo root = root();
        if (root == null) {
            return fail(s, "no_window", t0);
        }
        Walker w = new Walker(maxNodes <= 0 ? MAX_NODES : maxNodes, null);
        w.walk(root, "0", 1);
        s.items = w.items;
        s.nodes = w.items.size();
        s.visited = w.visited;
        s.depth = w.depth;
        s.truncated = w.truncated;
        s.ok = true;
        s.ms = SystemClock.elapsedRealtime() - t0;
        return s;
    }

    private static Snapshot findOnMain(String selector) {
        Snapshot s = new Snapshot();
        s.selector = selector;
        long t0 = SystemClock.elapsedRealtime();
        AccessibilityNodeInfo root = root();
        if (root == null) {
            return fail(s, "no_window", t0);
        }
        Walker w = new Walker(MAX_NODES, selector);
        w.walk(root, "0", 1);
        s.items = w.items;
        s.nodes = w.items.size();
        s.visited = w.visited;
        s.depth = w.matchedDepth;
        s.truncated = w.truncated;
        // A find that matches nothing is a real answer, not a failure: ok carries the query ran.
        s.ok = true;
        s.ms = SystemClock.elapsedRealtime() - t0;
        return s;
    }

    private static Snapshot clickOnMain(String selector) {
        Snapshot s = new Snapshot();
        s.selector = selector;
        long t0 = SystemClock.elapsedRealtime();
        AccessibilityNodeInfo root = root();
        if (root == null) {
            return fail(s, "no_window", t0);
        }
        Match best = bestMatch(root, selector);
        if (best == null) {
            s.ms = SystemClock.elapsedRealtime() - t0;
            return fail(s, "no_match", t0);
        }
        s.matched = node(best.node, best.path, best.level);
        s.matched.field = best.field;
        s.matchedBy = best.field;

        // A row's text view is usually not the clickable thing: the clickable view is an
        // ancestor (the tile). Climb to the nearest clickable ancestor rather than reporting a
        // miss, and say how far up the action was sent.
        AccessibilityNodeInfo target = best.node;
        int climbed = 0;
        while (!target.isClickable() && climbed < MAX_CLIMB) {
            AccessibilityNodeInfo up = target.getParent();
            if (up == null) {
                break;
            }
            target = up;
            climbed++;
        }
        boolean performed;
        try {
            performed = target.performAction(AccessibilityNodeInfo.ACTION_CLICK);
        } catch (Throwable t) {
            performed = false;
            s.error = "click_exception: " + t;
        }
        s.climbed = climbed;
        s.performed = performed;
        s.node = node(target, null, best.level + climbed);
        s.node.field = best.field;
        s.ok = performed;
        if (!performed && s.error == null) {
            s.error = "click_rejected";
        }
        s.ms = SystemClock.elapsedRealtime() - t0;
        return s;
    }

    private static Snapshot focusedOnMain() {
        Snapshot s = new Snapshot();
        long t0 = SystemClock.elapsedRealtime();
        AccessibilityNodeInfo n;
        try {
            n = focus(AccessibilityNodeInfo.FOCUS_INPUT);
            s.via = "focus_input";
            if (n == null) {
                n = focus(AccessibilityNodeInfo.FOCUS_ACCESSIBILITY);
                s.via = "focus_accessibility";
            }
        } catch (Throwable t) {
            return fail(s, "focus_exception: " + t, t0);
        }
        if (n == null) {
            // findFocus only answers for the active window; a node that reports isFocused() in
            // the tree is the same fact read the long way.
            AccessibilityNodeInfo root = root();
            if (root != null) {
                Walker w = new Walker(MAX_NODES, null);
                w.walk(root, "0", 1);
                for (int i = 0; i < w.items.size(); i++) {
                    if (w.items.get(i).focused) {
                        s.node = w.items.get(i);
                        s.via = "tree_scan";
                        s.ok = true;
                        s.ms = SystemClock.elapsedRealtime() - t0;
                        return s;
                    }
                }
            }
            return fail(s, "no_focused_node", t0);
        }
        s.node = node(n, null, -1);
        s.ok = true;
        s.ms = SystemClock.elapsedRealtime() - t0;
        return s;
    }

    /** The platform's index for a global-action name, or -1 when the name is not one of ours. */
    private static int globalCode(String action) {
        if (action == null) {
            return -1;
        }
        String a = action.trim().toLowerCase(Locale.US);
        if ("back".equals(a)) {
            return GLOBAL_ACTION_BACK;
        }
        if ("home".equals(a)) {
            return GLOBAL_ACTION_HOME;
        }
        if ("recents".equals(a)) {
            return GLOBAL_ACTION_RECENTS;
        }
        if ("notifications".equals(a)) {
            return GLOBAL_ACTION_NOTIFICATIONS;
        }
        if ("quick_settings".equals(a)) {
            return GLOBAL_ACTION_QUICK_SETTINGS;
        }
        return -1;
    }

    private static Snapshot globalOnMain(String action) {
        Snapshot s = new Snapshot();
        s.action = action;
        long t0 = SystemClock.elapsedRealtime();
        int code = globalCode(action);
        if (code < 0) {
            return fail(s, "unknown_action", t0);
        }
        CompanionAccess svc = instance;
        if (svc == null) {
            return fail(s, "accessibility_not_bound", t0);
        }
        boolean performed;
        try {
            performed = svc.performGlobalAction(code);
        } catch (Throwable t) {
            return fail(s, "global_exception: " + t, t0);
        }
        s.performed = performed;
        s.ok = performed;
        if (!performed) {
            s.error = "global_rejected";
        }
        s.ms = SystemClock.elapsedRealtime() - t0;
        return s;
    }

    /** The active window's root, or null when the service has no window to read. */
    private static AccessibilityNodeInfo root() {
        CompanionAccess svc = instance;
        if (svc == null) {
            return null;
        }
        try {
            return svc.getRootInActiveWindow();
        } catch (Throwable t) {
            return null;
        }
    }

    /** findFocus on the live service, or null. FOCUS_INPUT / FOCUS_ACCESSIBILITY. */
    private static AccessibilityNodeInfo focus(int what) {
        CompanionAccess svc = instance;
        if (svc == null) {
            return null;
        }
        return svc.findFocus(what);
    }

    // --- selector matching -----------------------------------------------------------------

    /**
     * The best node for a selector, or null. Scored so an exact resource-id beats a substring,
     * which beats text, which beats a content-description; ties go to the first node in
     * depth-first order, so the same tree always yields the same target.
     */
    private static Match bestMatch(AccessibilityNodeInfo root, String selector) {
        Match[] best = new Match[1];
        int[] visited = new int[1];
        bestMatchWalk(root, "0", 1, selector, best, visited);
        return best[0];
    }

    private static void bestMatchWalk(AccessibilityNodeInfo n, String path, int level,
            String selector, Match[] best, int[] visited) {
        if (visited[0] >= MAX_NODES) {
            return;
        }
        visited[0]++;
        String[] field = new String[1];
        int score = score(n, selector, field);
        if (score >= 0 && (best[0] == null || score < best[0].score)) {
            best[0] = new Match(n, path, level, score, field[0]);
        }
        // An exact resource-id cannot be beaten by anything deeper, so stop the walk there.
        if (best[0] != null && best[0].score == 0) {
            return;
        }
        int count = n.getChildCount();
        int taken = 0;
        for (int i = 0; i < count; i++) {
            if (best[0] != null && best[0].score == 0) {
                return;
            }
            AccessibilityNodeInfo c = n.getChild(i);
            if (c == null) {
                continue;
            }
            bestMatchWalk(c, path + "." + taken, level + 1, selector, best, visited);
            taken++;
        }
    }

    /** @return the match strength (lower is better), or -1 when nothing matches. */
    private static int score(AccessibilityNodeInfo n, String selector, String[] fieldOut) {
        String id = n.getViewIdResourceName();
        if (id != null && !id.isEmpty()) {
            if (id.equalsIgnoreCase(selector)) {
                fieldOut[0] = "id_exact";
                return 0;
            }
            if (contains(id, selector)) {
                fieldOut[0] = "id";
                return 1;
            }
        }
        String text = str(n.getText());
        if (text != null) {
            if (text.equalsIgnoreCase(selector)) {
                fieldOut[0] = "text_exact";
                return 2;
            }
            if (contains(text, selector)) {
                fieldOut[0] = "text";
                return 3;
            }
        }
        String desc = str(n.getContentDescription());
        if (desc != null) {
            if (desc.equalsIgnoreCase(selector)) {
                fieldOut[0] = "desc_exact";
                return 4;
            }
            if (contains(desc, selector)) {
                fieldOut[0] = "desc";
                return 5;
            }
        }
        return -1;
    }

    private static boolean contains(String haystack, String needle) {
        return haystack.toLowerCase(Locale.US).contains(needle.toLowerCase(Locale.US));
    }

    // --- node reader ------------------------------------------------------------------------

    private static Node node(AccessibilityNodeInfo n, String path, int level) {
        Node o = new Node();
        o.path = path;
        o.level = level;
        o.id = n.getViewIdResourceName();
        o.text = str(n.getText());
        o.desc = str(n.getContentDescription());
        o.cls = str(n.getClassName());
        o.pkg = str(n.getPackageName());
        Rect r = new Rect();
        n.getBoundsInScreen(r);
        o.left = r.left;
        o.top = r.top;
        o.right = r.right;
        o.bottom = r.bottom;
        o.clickable = n.isClickable();
        o.focusable = n.isFocusable();
        o.focused = n.isFocused();
        o.enabled = n.isEnabled();
        o.visible = n.isVisibleToUser();
        o.selected = n.isSelected();
        o.scrollable = n.isScrollable();
        o.editable = n.isEditable();
        o.children = n.getChildCount();
        return o;
    }

    private static String str(CharSequence cs) {
        if (cs == null) {
            return null;
        }
        String s = cs.toString();
        return s.isEmpty() ? null : s;
    }

    // --- thread handoff ---------------------------------------------------------------------

    private interface Body {
        Snapshot run();
    }

    /**
     * Runs {@code body} on the service's main thread and waits for it, so the socket thread can
     * answer with the result. Every failure mode is a value ("accessibility_not_bound"), never a
     * thrown exception on the socket thread.
     */
    private static Snapshot post(final Body body) {
        CompanionAccess svc = instance;
        if (svc == null) {
            return fail(new Snapshot(), "accessibility_not_bound", SystemClock.elapsedRealtime());
        }
        final Snapshot[] box = new Snapshot[1];
        final CountDownLatch latch = new CountDownLatch(1);
        svc.main.post(new Runnable() {
            @Override public void run() {
                long t0 = SystemClock.elapsedRealtime();
                try {
                    box[0] = body.run();
                } catch (Throwable t) {
                    box[0] = fail(new Snapshot(), "exception: " + t, t0);
                } finally {
                    latch.countDown();
                }
            }
        });
        try {
            if (!latch.await(POST_TIMEOUT_MS, TimeUnit.MILLISECONDS)) {
                return fail(new Snapshot(), "accessibility_timeout", SystemClock.elapsedRealtime());
            }
        } catch (InterruptedException e) {
            Thread.currentThread().interrupt();
            return fail(new Snapshot(), "accessibility_interrupted", SystemClock.elapsedRealtime());
        }
        return box[0] == null
                ? fail(new Snapshot(), "accessibility_lost", SystemClock.elapsedRealtime())
                : box[0];
    }

    private static Snapshot fail(Snapshot s, String error, long startMs) {
        s.ok = false;
        s.error = error;
        s.ms = SystemClock.elapsedRealtime() - startMs;
        return s;
    }

    // --- replies ----------------------------------------------------------------------------

    /** One node, flat. `field` names what a selector matched on, for find/click. */
    public static final class Node {
        public String path;
        public int level;
        public String id;
        public String text;
        public String desc;
        public String cls;
        public String pkg;
        public int left;
        public int top;
        public int right;
        public int bottom;
        public boolean clickable;
        public boolean focusable;
        public boolean focused;
        public boolean enabled;
        public boolean visible;
        public boolean selected;
        public boolean scrollable;
        public boolean editable;
        public int children;
        public String field;
    }

    /** One verb's outcome. Flat, like CompanionIme's results: the wire layer renders it. */
    public static final class Snapshot {
        public boolean ok;
        public String error;
        public long ms;
        public String selector;
        public String via;
        public String matchedBy;
        public List<Node> items = new ArrayList<Node>();
        public Node matched;
        public Node node;
        public int nodes;
        public int visited;
        public int depth;
        public boolean truncated;
        public int climbed;
        public boolean performed;
        /** The global action asked for, on the `global` verb. */
        public String action;
    }

    private static final class Match {
        final AccessibilityNodeInfo node;
        final String path;
        final int level;
        final int score;
        final String field;

        Match(AccessibilityNodeInfo node, String path, int level, int score, String field) {
            this.node = node;
            this.path = path;
            this.level = level;
            this.score = score;
            this.field = field;
        }
    }

    /** Depth-first walk with a hard node cap, collecting every node or only the matches. */
    private static final class Walker {
        private final int limit;
        private final String selector;
        final List<Node> items = new ArrayList<Node>();
        int visited;
        int depth;
        int matchedDepth;
        boolean truncated;

        Walker(int limit, String selector) {
            this.limit = limit;
            this.selector = selector;
        }

        void walk(AccessibilityNodeInfo n, String path, int level) {
            if (visited >= limit) {
                truncated = true;
                return;
            }
            visited++;
            if (level > depth) {
                depth = level;
            }
            Node o = node(n, path, level);
            if (selector == null) {
                items.add(o);
            } else {
                String[] field = new String[1];
                if (score(n, selector, field) >= 0) {
                    o.field = field[0];
                    items.add(o);
                    if (level > matchedDepth) {
                        matchedDepth = level;
                    }
                }
            }
            int count = n.getChildCount();
            int taken = 0;
            for (int i = 0; i < count; i++) {
                if (visited >= limit) {
                    truncated = true;
                    return;
                }
                AccessibilityNodeInfo c = n.getChild(i);
                if (c == null) {
                    continue;
                }
                walk(c, path + "." + taken, level + 1);
                taken++;
            }
        }
    }
}
