# Handoff

State of this project and the plan for the next step. Measurements are from the
TV this was built against: a TCL Android TV, Android 11 (API 30), armeabi-v7a,
`192.168.1.50:5555`, locale fr-FR, reachable over wireless adb.

## Where it stands

Repo `~/Projects/tv-remote-tui`, branch `main`, local only, nothing pushed.
HEAD `4606c07`, 34 tests passing (`npm test`, with a Node 26.4+; the PATH `node`
here is 25.6.1 and the suite does not start under it).

Uncommitted in the working tree: `src/companion.mjs` (new), the typing route and
mirror reads in `src/app.mjs`, `src/mirror.mjs` taking the caller's insert, the
`companion/` APK sources, `dist/tv-companion.apk`, and the README/HANDOFF changes
that go with them.

Commits, oldest first: `41e4966` initial, `135fe58` cross-platform, `3a970c6`
APK install, `18a4760` typing batching, `c3c3f1c` stop embedding adb twice,
`ef48d19` erase fix, `2b20dfa` mirror mode + keyboard layouts, `9d84613` borrow
the pass-through keyboard, `4606c07` the companion handoff.

Binaries in `dist/`, all six built after `9d84613`: macOS x64 87.6 MB, macOS
arm64 80.6 MB, Linux x64 102.8 MB, Linux arm64 102.0 MB, Windows x64 101.0 MB,
Windows arm64 91.9 MB. `dist/tv-remote-tui-slim` is stale (predates mirror mode)
and is only produced by `npm run build:exe:slim`.

## What the app does today

Four modules: D-pad, Volume, Text, Send mode, plus wake/sleep/power, the app
list with launch, APK install, and device discovery with history.

Text has three send modes. **Mirror** is the default: the TV's focused field is
read into the local box, edits are pushed to the TV after a 1.2 s pause, the
caret is parked at the end before every edit (a uiautomator dump does not report
where it is, and guessing wrong corrupts the edit), and Enter is the TV's OK
button. Edits are diffed against a model of the field and applied as the
shortest run of device calls. An edit that removed text is followed by a re-read
so drift is corrected rather than trusted. Block and Instant are unchanged.

The app reads the TV's keyboard on connect. Where the layout remaps injected
keys it translates letters on the way out (`src/keymap.mjs`); when text is
actually going out it borrows the pass-through keyboard (6 s lease, then the
TV's own keyboard comes back). `i` pins the borrowed keyboard, `k` forces the
translation.

### Typing: two routes, chosen in one place

`typingPath()` in `src/app.mjs` is the only place the route is decided:
**companion** when a probe (on connect, on `c`, after a wake) found the socket
answering, **adb** otherwise. The adb branch is the call it always was. The
companion branch is `commit` plus a read-back, because `ok:true` means "handed to
the connection", not "on screen" - measured on SmartTube answering ok while
changing nothing, once the app had run its own search on an earlier commit. A
companion that refuses, or whose commit does not show up in the field, is demoted
on the spot and the same text goes out over adb **with the adb route's own
compensations**: half-compensating is what mangles text (a previous run sent an
AZERTY-translated string to a keyboard that was not remapping: `aabbllllq1`
arrived as `qqbblllla!`).

Three mechanisms are *bypassed* on the companion route, and none of them is
deleted - each checks the route itself and returns early, so the call sites are
unchanged:

| mechanism | adb route | companion route |
| --- | --- | --- |
| layout translation (`src/keymap.mjs`) | used | bypassed: `commitText` sends no keycodes |
| borrowed pass-through keyboard | used | bypassed: nothing to work around |
| keystroke batching | used | bypassed: a commit is single-digit ms |

### Typing measurements, both routes

Through the app's own text box (block mode, Enter sends), wall clock from the
pty stream: Enter -> the app's own confirmation line on the reconstructed
screen, 20 ms poll.

- **Companion route**, 36 characters (`qazwm;,@)_-.1aabbllllhellohelloworld`,
  doubled runs, punctuation, a digit) into the companion's test field:
  `field get` -> 36 chars, caret 36, all verbatim; pixels agree (982 ink columns,
  36 glyph cells plus the caret, the digit 17 px against 28 px for the four `l`).
  Three sends of 3-5 characters each: Enter -> confirmed in **362 ms** (that one
  includes selecting the companion IME: `ime enable` + `ime set` + a bind check,
  ~0.35 s of adb) and then **49** and **73 ms**, commit plus read-back. A second
  run measured 415 / 66 ms.
- **adb route** (companion disabled, same flow): **2178 ms**, then **1717** and
  **1462 ms** - the first one borrows Gboard (`ime enable` + `ime set`), the rest
  are one `input text` each, and that JVM start is the floor. Minimum of three:
  **1.46 s against 49 ms**, ~30x.
- **The fallback, with the companion stopped**: the probe logs `✗ companion`, the
  header reads `path: typing via adb`, the send logs `sending with Gboard`, and
  `aabbllllhello` arrived verbatim in SmartTube's real search field (doubled a, b
  and l, read back by dump). Batching still merges: five keystrokes 0.2 s apart
  went out as `h` and then one `ello` (the app's own `last sent` line), and all
  five landed in the field in order.
- **SmartTube, end to end**: the app's 36-character commit appended to the 10
  characters already in its search field -> the dump read returned exactly those
  46 characters, and a pixel read counted 46 (the vision model confuses `l` with
  `1`; the ink widths are what settle it).

## Measurements

Cost of one action, host round trip, minimum of three:

| what | cost |
|---|---|
| `adb shell getprop` (native command) | 0.08 s |
| `adb shell cmd -l` (Java command) | 0.16 s |
| `adb shell input keyevent` | 1.2 - 1.6 s |
| `monkey` network mode, `key down 22` over the socket | **2.8 - 5.3 ms** |
| `adb shell sendevent` | 0.11 s, but **Permission denied** |
| `uiautomator dump` + read back | ~2.5 s |
| `ime set` (switch the TV's keyboard) | 0.15 s, effective immediately |
| `settings put secure default_input_method` | 0.34 s |

Where the delay is: inside **one** shell session, two consecutive `input` calls
took 1.193 s and 1.191 s by the TV's own clock. So the cost is per `input`
invocation on the device, not the adb client and not the connection:

    /system/bin/input:
      #!/system/bin/sh
      export CLASSPATH=/system/framework/input.jar
      exec app_process /system/bin com.android.commands.input.Input "$@"

Every `input` starts a fresh ART VM. Keeping adb or its shell open saves only
the client spawn (0.08 s of the 1.2 s). A claim that a persistent shell brings
keys to 50-100 ms is **wrong on this device**; measured, it does not.

Raw event injection is closed off: the shell user is in the `input` group and
`/dev/input/event*` is group-writable, but SELinux denies the write anyway.
`sendevent` returns `Permission denied` on event0, event1 and event2, and a
`getevent` listener sees nothing. That path needs root. Note that raw codes are
the Linux table, not Android's (`DPAD_DOWN` is 108 raw vs 20, raw 67 is F9, not
DEL).

`monkey --port 1080` (its network mode: a Java process kept alive on the TV,
commanded over a socket through `adb forward`) **works, and is the fast path for
D-pad keys**: a warm JVM answers in single-digit milliseconds, no install at all.
It was reported here as inconclusive; it was the command grammar that was wrong.

The grammar was read from the TV's own `/system/framework/monkey.jar`
(`dexdump` on `classes.dex`, `MonkeySourceNetwork.COMMAND_MAP`) and then confirmed
against the device. One command per line, terminated by `\n`, answered with `OK`,
`OK:<msg>`, `ERROR` or `ERROR:<msg>`:

    key down|up <code>      exactly 3 tokens. `key 24` and `key DPAD_DOWN`
                            alone are 2 and answer ERROR:Invalid Argument -
                            that is where the earlier attempts died
    press <code>            down+up in one verb (4-8 ms)
    touch down|up|move <x> <y>      tap <x> <y>
    trackball down|up|move <amount>
    type <text>             one token, quote it for spaces
    sleep <ms>    wake    flip open|close
    getvar|listvar, listviews|queryview|getrootview|getviewswithtext
    # comment (ignored), quit (answers OK, monkey exits), done
                            (the same, for a dropped connection)

`<code>` is a number, or `DPAD_RIGHT` / `dpad_right` / `KEYCODE_DPAD_RIGHT` - all
three resolve. An unknown verb gets **no reply at all** (the map lookup misses
and the handler returns without answering), so a silent socket means a misspelled
verb, not a dead server.

Two rules before relying on it:

- **One client connection per monkey process.** The first reconnect kills it:
  `MonkeySourceNetworkViews.setup` calls `Thread.start` on an already-started
  thread, that `IllegalThreadStateException` is uncaught, and
  `Monkey.runMonkeyCycles` (`Monkey.java:1204`) aborts. Hold one socket open for
  the whole session; do not reconnect.
- A second `monkey --port 1080` started while the first is alive prints
  `Error binding to network socket.` and exits 251: it binds
  `InetAddress.getLocalHost()` (127.0.0.1) with no `SO_REUSEADDR`, so a live
  listener on the port wins. Use a free port for a new instance; the same port
  works again once the old process is gone.

Confirmed to really move the TV, not merely to answer: `key down 24` / `key up 24`
walked STREAM_MUSIC 21 -> 22 -> 23 -> 24 (`dumpsys audio`, one step per pair,
restored with keycode 25), and D-pad keys moved the launcher's selection - 15.2%
of pixels changed in a band after three `key down 22`, against 0 pixels changed
on a 2 s no-input baseline. Name form too: `key down DPAD_DOWN` 16.8%, two
`press DPAD_UP` 3.9%. Both with a 0-pixel baseline.

What this does **not** settle: monkey's `type <text>` goes through
`KeyCharacterMap.VIRTUAL_KEYBOARD`, so it should hit the same layout remapping as
`input text` and is not a fix for typing. It has not been tested against a field.

### The TV's keyboard rewrites what we send

`input text` turns characters into **US key positions**; the TV renders them
through its own keyboard. Measured, injecting into SmartTube's search field:

    injected a q z w m ; ,      TV showed q a w z , m ;
    injected @ ) _ - 1          TV showed 2 0 degrees ) &
    injected .                  TV showed :

The same keyboard also drops characters on repeated keys: `hello` arrived as
`hell`, `llll` as `lll`, `aabb` as `qqb`, `helloworld` as `hellzorld`. Repeated
key events are read as multi-press and the repeat is eaten, which no translation
can recover.

Selecting the stock keyboard (Gboard) fixes both: the same injections arrived
verbatim, doubled letters included. That is why the app borrows it while sending.
Some earlier character losses seen during development were unrelated: my own DEL
burst was still draining when the next text arrived.

### Verifying what the TV shows

The accessibility text of that field cannot be trusted on its own: it is a
`StreamingTextView` that animates its text in, so a read taken straight after
typing returns a prefix (`hello` read back as `hell`), and an empty field
reports its own hint as text (`Rechercher`). Mirror mode therefore reads twice,
1.2 s apart, and treats known hints as empty. For any claim about what is on
screen, confirm on **pixels**: `adb shell screencap` plus a cropped read by a
vision model. `tools/ask-vision.py` does the second half.

That paragraph is the **dump** read. On the companion route the same text comes
from the IME's own `InputConnection` (`read extracted`), which reads the Editable
rather than what has been painted: a commit's full content is there at +6..17 ms
while the field has painted nothing, a mid-reveal read returns `""`, `h`, `he`,
`hel`, `hell` (the harness reproduces that shape), and an empty field answers
`""` with `Rechercher` only in keys this read does not return as text. So mirror
mode takes the IME read **inside the companion IME lease** - one read, no 1.2 s
wait, no hint filter, and its log line ends `[ime]` - and falls back to the dump
read outside the lease, and always on the adb route (`[dump]`). Both
compensations stay where they are: an empty SmartTube field still reports
`Rechercher` to a dump (measured), and a dump of a 105-character field returned
104 of them even with the settle wait. `read` needs the companion IME selected
(it answers `ime_not_selected` once the lease is handed back), which is why the
fast read is lease-scoped.

## Tools

- `tools/tui-capture.py` drives the app in a pty and prints the rendered screen.
  It takes `--wait` (before each `--send`) and `--hold` (how long to keep the app
  alive after the last one). **A run must outlive its last keystroke**: work that
  is batched or waiting on a typing pause lands after the send, and killing the
  app there hides exactly what the run was meant to show. That trap produced two
  false "the append never synced" reports before it was found.
  - It ends the run with `kill -9`, so the app's own teardown never runs: check
    `adb forward --list` (and `ps -A` on the TV for a stray monkey JVM) after a
    capture and remove anything left behind.
  - To capture a first connect without disturbing the real state, point the app at
    a fresh config dir: `TV_REMOTE_CONFIG_DIR=$(mktemp -d) ./run.sh --auto`. Its
    key file and per-device record live there, so the app believes the TV is new.
    The yes-path then pairs the TV with THAT key — put the real key back afterwards
    (`node` one-liner over `src/companion.mjs#provisionCompanionSecret` + ping), or
    the user's own config dir stops authenticating.
- `tools/ask-vision.py` reads an image with a vision model; used for pixels.
- Field reads while developing: dump to `/sdcard`, `cat` it back, match the node
  whose resource-id ends in `lb_search_text_editor`.

## Planned: a companion APK

Goal: take adb out of the hot path. One small APK on the TV, three roles, with
adb kept as a probed fallback.

1. **Socket server** (TCP, say 7878) - transport. A command then costs LAN round
   trip plus an in-process injection, tens of milliseconds instead of 1.2 s.
   Note that monkey's network mode already delivers keys at ~5 ms over the same
   adb link, so the companion's case is text, field reads and node-level
   navigation, not raw key speed.
2. **InputMethodService** - text and field reads. `commitText` needs no keycodes,
   so no layout translation, no eaten repeats, no keyboard borrowing.
   `getSurroundingText` returns the field's real contents in milliseconds, which
   would also retire the 2.5 s dump and the hint/truncation problems in mirror
   mode. Chosen over `ACTION_SET_TEXT` because that depends on the node reporting
   as editable, which SmartTube's custom field does not.
3. **AccessibilityService** - navigation and screen reads: `ACTION_CLICK` on the
   focused node, `ACTION_FOCUS` on the nearest node in a direction (an
   approximation of the D-pad), global actions (Back, Home, Recents, quick
   settings), the whole node tree, and volume get/set in-process.

What it cannot do, and stays on adb or IR: arbitrary key events (`INJECT_EVENTS`
is a privileged permission, so no real D-pad keycodes), power off, APK install.

Install and grant path, all of which the existing code already half-supports:

- APK embedded in `assets/` for releases, published standalone as well, and
  installed from the TUI through the existing `installApk()` (push, stream
  install, report the device's own verdict).
- Accessibility: **append** our component to
  `enabled_accessibility_services` and set `accessibility_enabled 1`. The TV
  already has one enabled -
  `com.leanbitlab.ltvL/com.leanbitlab.ltvL.LauncherAccessibilityService` -
  overwriting the setting would disable it.
- IME: `ime enable` then `ime set`, both already used against this TV.
- Autostart: `BOOT_COMPLETED` receiver plus a foreground service; re-launch over
  adb when it is not running, which is exactly what the connect-time probe is for.
- Build: pure Kotlin/Java with no native libraries, so the TV's 32-bit ABI does
  not matter. The SDK is at `~/Library/Android/sdk` with `platforms/android-36`
  and `cmdline-tools`, but **no build-tools**, so one `sdkmanager` install is
  needed; `aapt2` + `d8` + `apksigner` build it without Gradle. Sign with a local
  keystore and keep the same key, or updates will be refused.

Milestones, each a device round trip or a few:

1. Spine: foreground service, socket server, answers a ping. (2-3)
2. Read latency for the node tree, measured end to end. (1)
3. IME: commit text into SmartTube's search field and read it back. (1-2)
4. Focus-walk navigation on the launcher, SmartTube and a settings screen. (2-4)
5. Volume get/set, global actions, whether it can launch apps. (1-2)
6. Client module, connect-time probe, fallback when absent, per-action latency. (3-5)

Open unknowns, in the order they should be attacked: does `getSurroundingText`
give the search field's real text; does the TV keep the foreground service alive
and start it after reboot; does background activity launch work on API 30 or must
app launching go through accessibility clicks.

## Route I would take

1. Build the spine and probe the two risky items (IME text into that field, and
   focus-walk fidelity) **before** any client integration - about five round
   trips, and they decide whether the design holds.
2. Leave the adb path untouched as the fallback. Do not chase `sendevent` (SELinux)
   and do not build IR except possibly for power, where one 68 ms frame beats the
   9-11 s wake-on-LAN sequence and works when the TV is dark.
3. When the companion holds, move text, navigation, volume and screen reads onto
   it; keep adb for power, installs and the odd exact key. Mirror mode should then
   read its field through the IME instead of dumping the UI.
4. Success looks like: per-action latency under ~50 ms, focus-walk matching real
   D-pad focus on three different screens, and the adb fallback still working
   when the companion is stopped.

## Working notes for whoever picks this up

- Report failures and corrections plainly. Two this session: the AZERTY user
  report was real after I called it unreproducible, and a claim that raw event
  injection worked had no basis (the app launch that looked like evidence was the
  user's own).
- Do not give human-shaped time estimates; give the verify loop - what has to be
  built, what has to be measured, how many device round trips.
- Verify with pixels, not with accessibility text, and count characters when the
  claim is about text.
- The README is deliberately short and pure ASCII; keep it that way.

## The companion's security layer (t_423c68fe, uncommitted)

The companion used to bind every interface with no authentication: anything on the
LAN could type into the TV. It now binds `InetAddress.getLoopbackAddress()` only
(`/proc/net/tcp6` on the TV shows the listener on `::1`) and every connection
starts with an HMAC handshake before any verb is read.

- Server: `CompanionServer.authenticate` sends a fresh 16-byte nonce, reads one
  `AUTH <hex>` line and compares `hmac-sha256(secret, nonceHex)` with
  `MessageDigest.isEqual`. Wrong or missing: closed, no verb run. **No secret
  stored: `{"ok":false,"error":"no_secret"}` and closed** - fail closed, nobody
  gets in, not even us.
- Secret: `CompanionSecret` (SharedPreferences MODE_PRIVATE), provisioned only over
  adb - `am start-foreground-service --es companion_secret <hex>`, or
  `--ez companion_forget_secret true` to un-pair. Never logged, never echoed.
- Client: `src/companion.mjs` owns the route now - `adb forward tcp:0 tcp:7900`
  created once per serial, reused by every verb, removed on exit (and on a device
  switch). Key at `~/.config/tv-remote-tui/companion-<serial>.key`, 32 random
  bytes, mode 0600, pushed by the client when the TV answers `no_secret` (the
  first-run migration path, retried once).
- Measured on the TV: LAN connect to `192.168.1.50:7900` is **ECONNREFUSED** (was
  open); authenticated ping through the forward 12-26 ms; commit + read-back of a
  36-character string min 31.4 / median 35.7 ms over 7 runs, field byte-identical
  7/7. The old 6.30 ms LAN figure is retired: that route no longer exists.
- `npm test` now runs on the PATH node too (`node --test "test/**/*.test.mjs"`; the
  bare `test/` form does not resolve under Node 25.6.1). 42 tests.
- Known gap, pre-existing and NOT caused by this layer: the app's mirror never
  learns the TV's field when its first `uiautomator dump` is OOM-killed (rc=137 -
  measured 4/4 rc=137 while the app runs, 4/4 rc=0 with it stopped, on this 2 GB
  set), and a failed probe is never retried, so typing in the app is then a silent
  no-op. The companion route itself was verified end to end without the app.

## The first-connect setup flow (t_ecbbb8b8, uncommitted)

On a TV this machine has no record for, the app asks before touching it - "Companion
app is not set up on this TV (<model>). Install and pair it now? [Y/n]" - answerable
from the keyboard alone (y/Enter, n/Esc). Saying yes walks five visible steps
(checking adb / preparing the APK / installing / pairing the key / verifying) and
stops at the first failure; saying no records the refusal and leaves the TV on adb.

- State: `~/.config/tv-remote-tui/device-<key>.json` (`src/device-state.mjs`), keyed
  on the adb serial through the same `deviceKey()` the companion's `companion-<key>.key`
  uses, with the MAC inside the record. Lookup falls back to matching that MAC across
  the records, so a DHCP re-lease does not look like a first connect and does not split
  the state into a second file. "First connect" = no record.
- The prompt fires only when the companion really is not set up: before showing it the
  app runs the companion's own probe with provisioning OFF
  (`probeCompanion({provision:false})`). That may bring an already-installed service up -
  installed-but-idle is its normal state between uses - but it never pushes a key over
  adb and never installs, so declining cannot write to the TV. Two things it protects:
  the prompt's own sentence must be true, and a companion that is merely idle must not
  read as "not set up" (found the hard way: with a plain read-only ping, a TV whose
  service had been stopped by the vendor idle policy would have been asked to set up
  again).
- Done = the companion answered an authenticated ping, never "installed". Measured on
  the TV: the whole run 3.3 s (install ~2 s of it), verify 20-22 ms.
- The APK step uses the prebuilt `dist/tv-companion.apk` while it is newer than the
  companion's `.java`/`.xml`/`.sh` inputs, and only runs `companion/build.sh` when it
  is missing or stale (notes like README.md are NOT inputs - see
  `test/companion-build.test.mjs`).
- A probe that finds the companion answering records the device as set up, so a TV
  paired outside this flow is never offered the setup.
- Captured on the TV (tools/tui-capture.py, temp config dirs to force a first connect):
  prompt -> yes -> five ✓ -> "Done in 3.3s"; same dir again -> no prompt (companion
  route live); fresh dir -> n -> remote usable over adb, and again -> no prompt; the
  real config dir -> no prompt, companion authenticated. `npm test` 55 pass.
- Installed-but-idle, re-verified after the pre-check change: `am force-stop
  com.tvremote.companion` (its normal state) with NO record present -> the app started
  the service, got an authenticated ping, logged "companion already set up on this TV
  (v0.1.0) - recorded for this device, nothing installed" and wrote the record with
  `setup: "found"` - no prompt. Also checked that six consecutive wrong-key connections
  do NOT kill the companion's listener (each auth-failed in 11-18 ms, the right key
  answered 12 ms afterwards).
- The TV left the network mid-session (no ping, port 5555 gone and adb showing a stale
  `offline`, ~07:25) so the last two captures were inconclusive: one showed the prompt
  firing with the "TV is not reachable over adb" summary (a first connect on an
  unreachable TV does prompt, which is the designed behaviour - step 1 then reports
  "adb cannot reach ..."), and the "record present -> no prompt" run had no connected
  device at all. Nothing in this card wakes, sleeps or powers the TV, so it was left
  as it was; the record left on this machine is `setup: "found"`, installed+paired,
  v0.1.0, MAC aa:bb:cc:dd:ee:ff.
- Found and put back during those runs: the TV's `default_input_method` was left as
  `com.tvremote.companion/.CompanionIme` from an earlier session (a headless IME, so the
  TV had no on-screen keyboard for the physical remote). Restored to
  `com.tcl.inputmethod.international/.T_IME`. Nothing in this flow touches the IME.

## Mirror on the adb route: lending the dump the TV's one UiAutomation slot (t_610ab891, uncommitted)

Mirror mode on the adb route had NO working field read. A monkey that has carried a
command holds the TV's single UiAutomation slot, so `uiautomator dump` is SIGKILLed
(rc=137) from the first keypress of a session; t_4d2716f8 could only make that loud.
The read now borrows the slot for as long as it needs it.

- `src/monkey.mjs`: `monkeyHoldsSlot()`, `releaseSlot()` (stopMonkey — the death of the
  JVM is what frees the slot) and `reclaimSlot()` (a fresh monkey: the server forbids a
  reconnect), plus `clearStrayMonkeys()` for JVMs this session is not driving.
- `src/app.mjs#probeField` decides, and the read + restart run OUTSIDE the call chain.
  Awaiting the 8 s handoff there would hold the key path for the read's whole length; out
  on its own, keys during the pause fall back to `input keyevent` (1.2-1.6 s each) and
  land when they are pressed. `editSeq` + `applyFieldRead` drop a read that an edit
  interleaved with (only possible for a read outside the chain).
- Measured on the TCL (Android 11, 2 GB) 2026-09-18, through the app's own modules: stop
  105-132 ms and the slot is free at once (the very next dump answered rc=0 in 2.4 s, no
  settle); a full mirror read 6.4 s (two dumps + the 1.2 s settle); restart 1.3-2.9 s; a
  whole handoff 8.0 s. The FIRST read of a session still asks the dump plainly (0.83 s to
  be refused) and its verdict decides the rest of the session (`needsSlotHandoff` /
  `slotKnowledge`), so a TV whose monkey does not take the slot never pays for one. Reads
  that pay a handoff are spread out (`MIRROR_REFRESH_SLOT_MS`, 60 s against 20 s) so they
  land while nothing is being typed.
- A dump killed while NO monkey of ours is alive is a JVM this session is not driving
  (`killedDumpRecovery`): there is nothing to hand back from, so `clearStrayMonkeys` kills
  it and the read is retried. Measured: app stopped, one leaked JVM resident (pid 2676),
  every dump rc=137 -> `clearStrayMonkeys` killed 1 -> the next read answered rc=0 and
  returned the field. The leak itself was fixed at its source: `startMonkey`'s three
  give-up paths killed the host adb shell but left the device-side JVM behind, and a
  resident JVM takes the slot (that is what killed a whole capture run: `✗ monkey — no
  usable monkey port` followed by rc=137 on every dump with no monkey of ours alive).
- Captured with the app on the adb route (companion setup declined, so `path: typing via
  adb`) and the TCL's SmartTube search field on screen:

      ✓ keys over monkey — device port 1080, local 51072, 1296 ms to start
      ℹ could not read the TV's field (the TV killed uiautomator (rc=137) mid-dump; monkey
        holds the TV's UI automation slot, ...) — retrying in 0.6s
      · slot: monkey stopped (port 1080, 110 ms) — reading the TV's field with the slot free
      ✓ DPAD_UP — adb 1293.0 ms              <- keys during the pause, over adb
      ✓ DPAD_DOWN — adb 1279.1 ms
      · slot: monkey back on port 1080 in 1377 ms — keys over monkey again
      ✓ TV field is empty (it shows its hint "Rechercher") [dump · slot handed back]
      ⌨ sending with Gboard — TCL comes back when you stop
      ✓ TV field ← END  text 4 [adb]
      ✓ TV field holds 4 char(s) [dump · slot handed back]

  and the TV's field, dumped with the app stopped and no monkey in the way, held exactly
  what had been typed ("zebra" in one run, "lima" in the capture above) — the `rc=137`
  line appears once per session, on the first probe, and never again. The TV's keyboard
  was handed back to TCL, monkey stopped, no `adb forward` and no JVM left behind.
  `npm test` 61 pass (4 new for the slot rules).
- Not verified: the leak fix's own branch (it needs a monkey that goes quiet mid-
  handshake to force a failed start). The symptom it removes was measured in the wild.
- `tools/tui-transcript.py` is new: the same pty driver as `tui-capture.py`, but it
  collects the WHOLE log as it appears (the panel keeps only the last 8 lines) by reading
  the HISTORY panel's own box and joining its wrapped rows, which is what a sequence like
  the one above needs.

## Housekeeping notes for whatever comes next

- This TV sleeps on its own after a few idle minutes: the panel goes off, `mWakefulness`
  reads `Asleep`, and its WiFi drops with it (ping fails, port 5555 closes) — the network
  can come back with a WoL packet alone while the panel stays off, and `KEYCODE_WAKEUP`
  (224) then brings the display back a moment later. A capture that ends with the TV
  asleep is a captured timeout, not an app failure.
- `uiautomator dump` writes `/sdcard/t.xml` and a killed dump leaves the PREVIOUS file in
  place, so any tool that dumps and cats must delete it first or it will report a stale
  tree as the current screen (`tools/tui-capture.py` is unaffected: it reads pixels).
- A capture killed with `kill -9` never runs the app's teardown: check
  `adb forward --list` and `ps -A` for monkey JVMs afterwards, and put the IME back if
  the run ended mid-send.
