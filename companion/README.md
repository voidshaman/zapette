# Zapette Companion

A small pure-Java APK that runs on the TV side by side with the TUI. It holds a
foreground service and answers commands on a TCP socket bound to the TV's own
loopback, so a command costs one `adb forward` round trip plus an in-process action
instead of a fresh ART VM per `adb shell input` — and the socket is not reachable from
the LAN at all (see Security below). The adb path stays as the fallback.

## Build

    companion/build.sh

No Gradle: the script drives aapt2 + javac + d8 + zipalign + apksigner itself.
It finds JAVA_HOME (`~/.local/jdk/temurin-17/Contents/Home`) and the SDK
(`~/Library/Android/sdk`) on its own, and creates the signing key on first run.
Output: `dist/zapette-companion.apk`.

## Install

    ./assets/adb install -r -d dist/zapette-companion.apk
    ./assets/adb shell pm grant com.zapette.companion android.permission.WRITE_SECURE_SETTINGS   # once
    ./assets/adb shell am start-foreground-service -n com.zapette.companion/.CompanionService

Or launch it from the TV's app row; the activity starts the service on the way in.

Then pair it, or it refuses every connection (fail closed — see Security below):

    ./assets/adb shell am start-foreground-service -n com.zapette.companion/.CompanionService \
        --es companion_secret <64 hex chars>

The client does that step itself the first time it finds a companion answering
`no_secret` (src/companion.mjs), so this is only needed when pairing by hand.

## Security: loopback only, and a per-device secret

Two layers, and neither is optional.

**1. The socket is not on the LAN.** The bind is `InetAddress.getLoopbackAddress()`,
so the only thing that can reach 7900 is something already on the TV, and the client
reaches it through `adb forward tcp:<hostPort> tcp:7900` (adb binds 127.0.0.1 on the
host). Verified from this Mac: a raw TCP connect to `192.168.1.50:7900` is
`ECONNREFUSED`; `/proc/net/tcp6` on the TV shows the listener on `::1` only.

**2. Reaching the loopback is not authorisation.** The first line on every connection
is a handshake, before any verb is read:

    server -> {"ok":true,"cmd":"auth","auth":"nonce","nonce":"<16 random bytes, hex>"}
    client -> AUTH <hmac-sha256(secret, nonceHex)>

`hmac-sha256` is `javax.crypto.Mac` over the nonce's hex characters, keyed with the
secret's decoded bytes (the same definition on both sides:
`CompanionSecret.hmacHex` / `computeAuthHmac`), compared with `MessageDigest.isEqual`.
A wrong or missing `AUTH` gets no further reply and **no verb runs** - the connection
is closed in `CompanionServer.authenticate`, before the command loop. **With no secret
stored the server answers `{"ok":false,"error":"no_secret"}` and closes**: fail closed,
so an unprovisioned companion is usable by nobody rather than by everybody.

The secret is provisioned over adb and only over adb - adb is the trust root here (RSA
key plus the TV's on-screen confirmation) - and never crosses the socket:

    ./assets/adb shell am start-foreground-service -n com.zapette.companion/.CompanionService \
        --es companion_secret <64 hex chars>
    ./assets/adb shell am start-foreground-service -n com.zapette.companion/.CompanionService \
        --ez companion_forget_secret true          # un-pair: it refuses everyone again

It lands in `SharedPreferences(MODE_PRIVATE)`, is never logged or echoed in a reply, and
survives a process restart. The client keeps its own copy at
`~/.config/zapette/companion-<device>.key` (mode 0600, 32 random bytes) and pushes
it when the TV answers `no_secret` - the normal first-run path for an APK installed
before this layer existed, not an error path.

**Threat model.** Layer 1 stops anything else on the network: no LAN peer can type into
the TV, launch activities or change volume. Layer 2 stops anything that *can* reach
loopback, including another app on the same TV: without the secret it gets a nonce and
then a closed socket. Neither stops a party that already has adb access to the TV - by
design, adb IS the trust root, and the TV's ADB service stays on.

## Talk to it

The socket is loopback-only and speaks the handshake above, so `printf 'ping' | nc
1.2.3.4:7900` no longer reaches anything. Reach it with any client that can do both
steps - or use the client module, which does (`pingCompanion(device)`, `commitCompanion`,
`readCompanion`, `imeOn` in `src/companion.mjs`):

    ./assets/adb forward tcp:7900 tcp:7900          # or tcp:0 and read the port it prints
    # connect to 127.0.0.1:7900, read the nonce line, answer AUTH <hmac>, then send verbs

Port 7900, loopback only. Not 7878: that one is already listening on this TV, a
root-owned vendor service (see `CompanionService.PORT`). 7900 sits below Android's
ephemeral port range, so nothing can take it first.

One command per line, one JSON object per line back. `ping` answers with version,
uptime_ms, pid, port, model and sdk. An unknown verb answers
`{"ok":false,"error":"unknown_command",...}` rather than closing or hanging, so
later verbs (read, focus, volume) can be added to `Protocol.dispatch` without
changing the transport.

## The IME (commit)

`commit <text>` hands the focused field the text through `CompanionIme`, an
`InputMethodService` that draws no keyboard and does nothing but `commitText`. No
keycodes are involved, so the TV's own keyboard cannot remap the letters or eat a
repeated character. Enable it with the id `ime list -s -a` prints - the short form:

    ./assets/adb shell ime enable com.zapette.companion/.CompanionIme
    ./assets/adb shell ime set com.zapette.companion/.CompanionIme
    printf 'commit aabbllll\n' | nc 127.0.0.1:$FWD   # see "Talk to it": forward + AUTH handshake first
    {"ok":true,"cmd":"commit","len":8,"text":"aabbllll"}

`ok` means the string was handed to the input connection, not that the field shows
it: check the screen. A commit with no connection answers
`{"ok":false,"error":"no_input_connection"}`, and one with the companion IME not
selected answers `{"ok":false,"error":"ime_not_selected"}`. Put the TV's own IME
back with `ime set <its id>` when you are done, and `ime disable` the companion.

## Selecting the companion IME itself (`ime`)

    printf 'ime state\n' | nc 127.0.0.1:$FWD   # see "Talk to it": forward + AUTH handshake first
    printf 'ime on\n'    | nc 127.0.0.1:$FWD   # see "Talk to it": forward + AUTH handshake first     # select the companion's IME, in-process
    printf 'ime off\n'   | nc 127.0.0.1:$FWD   # see "Talk to it": forward + AUTH handshake first     # give the TV its own IME back

This is `ime set` without adb. Both write the same secure setting, but the app can only do
it with WRITE_SECURE_SETTINGS, a privileged permission it gets from one adb call:

    ./assets/adb shell pm grant com.zapette.companion android.permission.WRITE_SECURE_SETTINGS

Granted once, it stays granted across `am force-stop` and a restart of the process (the
grant lives in the package manager, not in the process). `on` records the TV's own IME
before switching, appends the companion's id to `enabled_input_methods` if it is missing,
and - when our IME is already the default but may not be bound - switches away and back
in-process. `off` restores the recorded IME and refuses (`no_previous_ime`) rather than
guessing one. `state` reads only.

    on     3-18 ms device-side to write the setting, 15-34 ms socket round trip
           (the same switch over adb is 0.15 s) ; the IME then takes 141-231 ms more to
           bind before a commit has a connection
    off    ok:true with current/previous, or no_previous_ime
    state  current, previous, enabled, selected, running, granted

Without the grant every verb answers

    {"ok":false,"error":"no_write_secure_settings","need":"android.permission.WRITE_SECURE_SETTINGS",
     "grant":"pm grant com.zapette.companion android.permission.WRITE_SECURE_SETTINGS","fallback":"adb"}

which is the client's cue to use the adb `ime enable` + `ime set` path - it must not retry
the socket verb. `ime off` never leaves the companion IME selected by accident: the one
thing it will not do is pick an IME it did not record.

## Reading the focused field (`read`)

    printf 'read cursor\n'    | nc 127.0.0.1:$FWD   # see "Talk to it": forward + AUTH handshake first
    printf 'read extracted\n' | nc 127.0.0.1:$FWD   # see "Talk to it": forward + AUTH handshake first

`read` asks the focused field for its text through the same InputConnection.
Default mode is `getSurroundingText`; on this API-30 TV that method does not exist
at all, so it answers `{"ok":false,"source":"unavailable","error":"no_such_method: ..."}`
instead of pretending. The two working modes:

  - `read cursor [before] [after]` - `getTextBeforeCursor` + `getTextAfterCursor`.
    Returns the field's real text (an empty field is `""`: the hint is never part
    of it) and the caret, derived from the prefix length (`caretDerived: true`).
    The window is honored exactly, so ask for more than the field can hold.
  - `read extracted` - `getExtractedText`. Returns the whole text plus the
    selection the app itself reports, and `partialStartOffset`/`partialEndOffset`
    to say whether that text is a window. This is the mode that can tell "empty
    field" from "no field focused": the latter answers
    `{"ok":false,"error":"extracted_text_null"}`, while `cursor` cannot tell them
    apart (both are `""`).

Measured on the TCL TV: 4.5 ms for `read cursor`, 5.4 ms for `read extracted`,
against ~2.7 s for a `uiautomator dump` and ~1.4 s for a `screencap`. Like
`commit`, it needs the companion IME selected.

## The test field (`field`)

    printf 'field focus\n'                   | nc 127.0.0.1:$FWD   # see "Talk to it": forward + AUTH handshake first
    printf 'field set hellohelloworld\n'     | nc 127.0.0.1:$FWD   # see "Talk to it": forward + AUTH handshake first
    printf 'field append XY\n'               | nc 127.0.0.1:$FWD   # see "Talk to it": forward + AUTH handshake first
    printf 'field clear\n'                   | nc 127.0.0.1:$FWD   # see "Talk to it": forward + AUTH handshake first
    printf 'field get\n'                     | nc 127.0.0.1:$FWD   # see "Talk to it": forward + AUTH handshake first
    printf 'field target streamed\n'         | nc 127.0.0.1:$FWD   # see "Talk to it": forward + AUTH handshake first
    printf 'field get streamed\n'            | nc 127.0.0.1:$FWD   # see "Talk to it": forward + AUTH handshake first

`field` drives `TestFieldActivity`, which owns TWO monospace fields, so typing is
developed and verified against a field the companion can report exactly, instead of
SmartTube's search box (reaching it costs a run of navigation, clearing it used to cost a
2000-key DEL burst, and it reruns its own search after the first commit).

  - `edittext` (the default target) - a plain EditText: what is committed is on screen.
  - `streamed` - a `StreamingEditText`, shaped like SmartTube's own search field: it paints
    its text one character per tick (25 ms), and while empty it presents the placeholder
    `Rechercher` as if it were content. This is the instrument for the two faults
    SmartTube's field shows - a read taken straight after a commit returns a PREFIX, and an
    empty field reports its hint - the behaviours mirror mode carries compensation for.

`field target edittext|streamed` switches which field is focused and therefore which one
receives the IME's commits; both fields take text through the same commitText path, so a
comparison between them measures the field, not the transport. With no argument it reports
the current target and its contents. `field get [edittext|streamed]` reads the active field
or a named one without switching.

The verbs, and the measured contrast, are the same for both targets:

  - `focus` brings the screen to the front and puts the caret in the active box, then
    answers with the contents, length and caret the caller starts from. It is instant when
    the screen is already up. When the TV does not let the app start an activity from the
    background - TCL denies this app the foreground-service state, so it sits at
    IMPORTANT_BACKGROUND - it answers `ok:false` / `field_not_front` with a `hint` naming
    the one adb call that brings the screen up:
    `am start -n com.zapette.companion/.TestFieldActivity` (measured 0.145-0.31 s, no keyevent).
    `target` does the same for the field it switched to, and switches the target even when
    the screen cannot come up.
  - `set <text>` clears the field, then commits the text through the IME's live
    InputConnection - the same path real typing ends in. `requested_len` is what was asked
    for, `cleared` how much the field lost first, `via` which path carried the write.
  - `append <text>` does the same at the caret, leaving what is there.
  - `clear` is one in-process operation (deleteSurroundingText over the field's length, or
    an in-place Editable replace when no IME is connected) and answers `removed` as counted
    by the view. It never sends a keystroke, so nothing outlives the call.
  - `get` is the ground truth for typing tests: contents, length and caret, read from the
    view itself - no pixels, no accessibility.

With the streamed field active, every reply also carries the gap between the two notions of
"the text", and the plain field's reply is exactly what it was:

    content   what was committed (the Editable: complete the moment the commit lands)
    rendered  what is painted right now - the revealed prefix, or `Rechercher` while empty
    settled   whether painting has caught up; `render_ms` (device clock) says how long the
              render took when one was measured
    hint      the placeholder an EMPTY field presents, named rather than assumed

Measured on this TV over the socket, minimum of 5 runs, same commit path into both fields:

    streamed, "hello"       first read +6..+17 ms after the commit -> rendered "" (content "hello")
                            mid-reveal reads return "", "h", "he", "hel", "hell"
                            settled 124-185 ms wall, device render_ms 125-129
    streamed, "helloworld"  first read rendered "" ; settled 248-338 ms, render_ms 251-253
    streamed, 40 chars      screencap taken straight after the commit caught "abcdefghijkl"
                            (12 of 40) on pixels while the logical text was 40 - the lag is on
                            the screen, not only in the read
    streamed, empty         content "" but rendered "Rechercher", hint "Rechercher" (grey on
                            pixels: the placeholder a naive read picks up as content)
    edittext, both strings  first read +8..+17 ms -> the full string, no render_ms at all
    edittext, empty         text "" and len 0 - no placeholder anywhere

`set` and `append` answer `{"ok":false,"error":"ime_not_selected","default_ime":...}` when
the companion IME is not the TV's selected input method, instead of quietly writing the
box through another path: a test must not pass through a path that is not under test.
`clear` and `get` work whatever IME is selected.

Measured on this TV over one held connection (minimum of 5 runs): focus 3.2 ms, set 7.3 ms,
append 8.8 ms, clear 6.1 ms, get 7.4 ms, target switch 21 ms (the switch waits for the new
field to take focus). A 36-character string containing the letters the TV's own keyboard
remaps and doubled runs was set and read back verbatim, five times in a row, and the
rendering was confirmed on pixels.

## Clicking a node by name (`tree`, `find`, `click`, `focused`)

    printf 'tree\n'                                    | nc 127.0.0.1:$FWD   # see "Talk to it": forward + AUTH handshake first
    printf 'tree 40\n'                                 | nc 127.0.0.1:$FWD   # see "Talk to it": forward + AUTH handshake first
    printf 'find lb_search_text_editor\n'              | nc 127.0.0.1:$FWD   # see "Talk to it": forward + AUTH handshake first
    printf 'click org.smarttube.stable:id/title_orb\n' | nc 127.0.0.1:$FWD   # see "Talk to it": forward + AUTH handshake first
    printf 'focused\n'                                 | nc 127.0.0.1:$FWD   # see "Talk to it": forward + AUTH handshake first

`CompanionAccess` is the other half of the app: an AccessibilityService that reads the
active window's node tree and clicks a node by name, so a target does not have to be reached
by pressing D-pad keys and hoping. It is NOT a key injector - INJECT_EVENTS is
signature-level, so keys stay on `input` / monkey, and the adb path is untouched by it.

  - `tree [maxNodes]` - every node, flat and depth-first: path, level, resource-id, text,
    content-description, class, package, bounds, click/focusable/focused/enabled/visible/
    selected/scrollable/editable and child count. `nodes`, `depth` and `truncated` are data.
  - `find <selector>` - matching nodes; each carries `match`, naming which of resource-id /
    text / content-description matched. An exact id beats an id substring, which beats text,
    which beats a description; ties go to the first node in depth-first order.
  - `click <selector>` - ACTION_CLICK on the best match, climbing (at most 6 levels) to the
    nearest clickable ancestor when the match itself is not clickable: a row's text view is
    usually not the thing that takes the click. The reply carries `matched` and `node` (what
    the action was sent to), `climbed` and `performed`, so the caller can see what it hit.
    ACTION_CLICK goes to the node, not to screen coordinates, so an overlay on top of it does
    not swallow it.
  - `focused` - the node holding input focus: id, text, package, bounds, and `via` naming the
    API that answered (focus_input, focus_accessibility, or a tree scan).

Every reply carries `flags` (the live AccessibilityServiceInfo flag set), `bound` and
`can_retrieve_window_content`, so a `no_window` answer can be told apart from a service the
framework never connected.

Enabling it - READ the value, then APPEND (never overwrite):

    ./assets/adb shell settings get secure enabled_accessibility_services
    ./assets/adb shell settings put secure enabled_accessibility_services "<that value>:com.zapette.companion/.CompanionAccess"
    ./assets/adb shell settings put secure accessibility_enabled 1

The TV already has its own launcher service in that setting, and overwriting the value
instead of appending DISABLES THE TV'S OWN LAUNCHER. The service also needs
`res/xml/accessibility_service.xml`, declared in the manifest as meta-data: a service with
BIND_ACCESSIBILITY_SERVICE but without that XML is enabled in settings and silently never
bound. It asks for `flagReportViewIds` (without it every resource-id reads back as null) and
`flagIncludeNotImportantViews`, and deliberately not `flagRequestFilterKeyEvents`, which
would take keys away from the physical remote.

Measured on this TV over the socket (service-side ms / host round trip): `focused` 3 ms /
39 ms, `tree` on the launcher 47 nodes depth 12 in 20 ms / 63 ms, on SmartTube 35 nodes in
8 ms / 50 ms, `find` 7-20 ms, `click` 28 ms / 42 ms. One `click` on
`org.smarttube.stable:id/title_orb` (id_exact, climbed 0, performed true) opened the search
UI: `find lb_search_text_editor` went from 0 matches to the focused, editable
StreamingTextView carrying that id.

TCL does not keep the companion alive on its own: TGuard kills the process seconds to a
minute after start ("tguard-kill", adj 100/200) and the app-idle policy stops
`CompanionService`, so the socket answers only while the process is up.
`am start-foreground-service -n com.zapette.companion/.CompanionService` brings it back in
under a second; the client's start-on-demand probe is what makes that invisible.

## What the accessibility path costs, and what it does not do

Measured on this TV (full numbers in MEASUREMENTS.txt):

  - the tree read is 14-17 ms for a 47-node launcher screen against ~2.5 s for `uiautomator
    dump` (~150x), and it is the only path that returns a NODE to click;
  - nothing throttles or caches it: 10 back-to-back and 10 pipelined calls all answered, and the
    replies track the screen live - they show the launcher's own focus animation frames, which a
    cached read could not;
  - clicks work where the app puts the resource-id or the content-description on the clickable
    view, or one level above it (SmartTube: `title_orb`, the search field, the search icon's desc,
    the field's own text). They do NOT work on the TCL launcher, whose tiles are named on a
    non-clickable view with the click on a CHILD - the climb only goes up - and a text match is
    not dependable either: clicking a TV-settings row by its label answered ok:true and
    performed:true and changed nothing at all. Verify the effect, never the reply;
  - every click answers with `matched` and `node` (id, text, bounds, climbed, performed), so the
    caller can see what it hit; one that reaches no clickable view answers `click_rejected`
    rather than pretending;
  - it is NOT free. Anything holding a UiAutomation connection displaces this service on this TV:
    while monkey is resident the service is unbound (every verb answers `accessibility_not_bound`
    while the process still answers `ping`), and `uiautomator dump` unbinds it for the ~1.2 s it
    runs. `input keyevent` does not. Stopping monkey rebinds it within 1.2 s. A client that wants
    both a warm key transport and the tree has to stop monkey to read and start it again after.

## Volume, in-process (`volume`)

    printf 'volume\n'        | nc 127.0.0.1:$FWD   # see "Talk to it": forward + AUTH handshake first
    printf 'volume 30\n'     | nc 127.0.0.1:$FWD   # see "Talk to it": forward + AUTH handshake first
    printf 'volume 30 ui\n'  | nc 127.0.0.1:$FWD   # see "Talk to it": forward + AUTH handshake first

`volume` answers `{"ok":true,"cmd":"volume","level":21,"min":0,"max":100,"muted":false,
"stream":"music","stream_id":3,...}`. `volume <n>` adds `requested`, `before`, `matched` (the
read-back equals what was written) and `clamped`. `level` is always read BACK from the
AudioManager after the write, never echoed from the request, so a TV that refuses the stream
shows up as `level != requested` instead of as a success we invented.

The stream is `STREAM_MUSIC` and nothing else, because that is the stream this TV's own volume
keys move: measured, one VOLUME_UP keyevent took STREAM_MUSIC 21 -> 22 while every other stream
(SYSTEM 24, TTS/ACCESSIBILITY/ASSISTANT 24, RING/VOICE_CALL/ALARM/NOTIFICATION 2, BLUETOOTH_SCO
7, DTMF 4) stayed exactly where it was, and VOLUME_DOWN took it back. 0 is a mute on this set:
setting 0 reports `muted:true`, and setting a level above it reports `muted:false`.

`ui` appends `AudioManager.FLAG_SHOW_UI`, and that is the only way the TV's own volume OSD
appears:

  - without it the screen does not change AT ALL - a screencap taken right after `volume 30` was
    byte-identical to the frame before it (2/2 runs, one hash-for-hash);
  - with it the TCL slider (a thin vertical bar with a speaker glyph, far right edge) appeared on
    3/3 level CHANGES (35->40, 40->45, 45->40), and a re-set to the level it already had drew
    nothing (1/1: the platform skips an unchanged value);
  - the OSD carries no digits, so it is human feedback, not something a client can read back, and
    pixel diffs cannot read the level either (the panel animates in). `input keyevent 24` draws
    the same slider in the same place.

Cost on this TV, host round trip on a held connection: read min 5.4 ms (device-side 2 ms), set
min 13.3 ms (device-side 10-16 ms). The first `volume` in a fresh process measured 152 ms
(device-side 2 ms) - one-off class loading, not the steady state.

## The TV's own back / home / recents / notifications / quick settings (`global`)

    printf 'global home\n'           | nc 127.0.0.1:$FWD   # see "Talk to it": forward + AUTH handshake first
    printf 'global quick_settings\n' | nc 127.0.0.1:$FWD   # see "Talk to it": forward + AUTH handshake first

`global <action>` calls `AccessibilityService.performGlobalAction` for one of back, home,
recents, notifications, quick_settings; anything else answers `{"ok":false,
"error":"unknown_action","known":"back, home, recents, notifications, quick_settings"}`. The
reply's `performed` is the framework's return value and is NOT evidence the TV did anything -
three of these five answer `performed:true` and change not one pixel.

What works, verified against the window list, the node tree AND the framebuffer:

  - `home` - yes: from the companion's own activity mCurrentFocus moved to the launcher and the
    tree went 8 nodes/com.zapette.companion -> 47 nodes/com.leanbitlab.ltvL (3/3 runs).
  - `back` - yes, as a BACK and not a "go up". While the soft keyboard is up the FIRST back goes
    to the keyboard (measured: the frame after it lost the keyboard, focus unchanged), and the
    next one finishes the activity. On the launcher it does nothing, like any remote's back.
  - `recents`, `notifications`, `quick_settings` - accepted and inert: byte-identical screencaps
    before and after, unchanged mCurrentFocus, unchanged window list, unchanged tree, from both
    the companion's activity and the TCL launcher. Android TV 11 has no recents screen, and this
    vendor's notification and quick-settings panels are not reachable through this API. The adb
    path (whatever key that remote sends) stays the answer for those three.

Latency, host round trip (all runs this session): home min 4.5 ms, back min 6.6 ms,
quick_settings min 3.7 ms, notifications min 3.6 ms, recents min 5.4 ms; device-side 0-4 ms.
Outliers are the socket, not the action (one `global recents` took 122 ms host with 1 ms
device-side).

## Signing key

`~/.zapette/android.keystore`, alias `zapette`, created by the build
script on first run. Keep it: Android refuses an update signed with a different
key, and installing over the old build then means uninstalling first.
