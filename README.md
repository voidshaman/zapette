# zapette

[![test](https://github.com/voidshaman/zapette/actions/workflows/test.yml/badge.svg)](https://github.com/voidshaman/zapette/actions/workflows/test.yml)
[![companion-apk](https://github.com/voidshaman/zapette/actions/workflows/companion-apk.yml/badge.svg)](https://github.com/voidshaman/zapette/actions/workflows/companion-apk.yml)

A terminal remote for an Android TV, driven over wireless ADB. Pick a device, then use one screen to
run it: D-pad, volume, text entry, power, and the apps installed on the TV.

## Requirements

- Node 26.4 or newer. The launcher looks for one; `NODE_BIN` overrides.
- A TV with wireless debugging enabled (Developer options, ADB over network).
- adb. macOS source runs use the copy in the repo, `npm run fetch:adb` installs it for any other
  platform, and failing both the app falls back to the adb on PATH. A compiled binary carries its own.

## Run

    ./run.sh          # choose a device, then the remote
    ./run.sh --auto   # open the first connected device
    ./run.sh --demo   # no TV: drives the UI offline

`run.cmd` is the same launcher on Windows. Both are thin wrappers around `node run.mjs`, which finds a
Node 26.4 or newer and starts the app with it.

## Keys

The remote screen has four modules: D-pad, Volume, Text, Send mode. The focused module's border lights
up, and D-pad has focus at the start.

    Tab, Shift+Tab   switch module, also from inside the text box
    1 2 3 4          jump to a module
    w / s / p        wake / sleep / power toggle
    l                app list (there: Enter launch, k stop, f filter)
    c                probe the TV's companion service, starting it if needed
    m                cursor mode: the mouse drives a TV pointer (m or Escape releases)
    d                device selector

Inside D-pad, the arrows drive the TV, Enter is OK, Backspace or b is Back, h is Home. In Volume, up
and down change the TV volume, and the minus and plus buttons do the same; left and right switch
module. Every on-screen button is also clickable.

Cursor mode moves a pointer on the TV with this machine's mouse; a left click taps the TV where the
pointer is. The shortcut that enters it leaves it, and so does Escape. Worth knowing before using it:
the TV draws no cursor of its own for the touch events this path can inject, so the footer is where
the position is shown, and the pointer starts in the middle of the panel. Movement is relative and
speed-scaled (a slow nudge is 6 panel pixels, a flick up to 240), and keys keep working while it is
on, so the D-pad and the mouse can be mixed.

In Text, the box mirrors the TV's field by default: the field's contents are read into it, edits are
pushed to the TV after a pause, and Enter is the TV's OK button, so a search or a form can be filled
without leaving the module. Backspace edits the box; once it is empty it deletes on the TV instead, so
a block that has already been sent can still be corrected. Send mode picks between Mirror (the
default), Block, where Enter sends the whole string, and Instant, where every key goes to the TV as you
type. Send mode also shows which keyboard the TV is using: the app borrows one that passes text
through while it is sending and gives the TV its own back afterwards, i pins that borrowed keyboard
in place instead, and k forces the translation by hand.

Keys resolve in this order: Tab first, then the text box, then the shortcuts above, then the focused
module. So while the text box has focus the keyboard belongs to it and no shortcut can fire; Tab still
gets you out, and Escape on an empty field moves on.

## TV keyboards

`adb shell input text` turns each character into a **US key position**, and the TV renders that
position through its own keyboard. Measured on this TCL, whose keyboard is French AZERTY, by reading
the field back after every injection:

    injected a q z w m ; ,      TV showed q a w z , m ;
    injected @ ) _ - 1          TV showed 2 0 degrees ) &

The same keyboard also loses characters. Injected `hello` arrived as `hell`, `llll` as `lll`,
`helloworld` as `hellzorld`: repeated key events are treated as multi-press and the repeat is eaten.
No translation can recover a key the TV never took.

Selecting the stock keyboard instead fixes both at once. With it, every injection arrived exactly as
sent, including the letters AZERTY moves and words with doubled letters. A switch costs 0.15 seconds
and applies immediately, so the app borrows that keyboard for as long as text is going out: it switches
when the sender needs it and hands the TV its own keyboard back six seconds after the last send. The TV
is left as it was found unless i is pressed, which pins the borrowed keyboard in place; i again goes
back to borrowing it only when sending.

The layout is read from the TV on connect and whenever the keyboard changes, so while the TV is on its
own keyboard the letters that remap are translated on the way out and a TV that cannot be switched
still types mostly right. k cycles that translation between automatic, on and off. Characters behind
AltGr on AZERTY, `@` and `#` among them, cannot be produced by `input text` at all, since it can
express base and shift only: the app names them instead of pretending they were sent.

## Mirror mode

The field is read with a uiautomator dump, about 2.5 seconds, twice a moment apart: Leanback's search
field animates its text in, and a read taken straight after typing catches only a prefix of it
(`hello` came back as `hell`). An empty Android field reports its own hint through accessibility, so a
bare search box reads as `Rechercher`; hint text counts as empty, and a hint the app has not seen
before is learned the first time it empties the field itself.

Where the caret sits is the one thing a dump does not report, and guessing it wrong puts an edit in the
wrong place: clearing an 8-character field left its last character behind and the next insert landed in
front of it. So an edit never assumes the caret. It parks the caret at the end first, then walks back,
deletes and inserts as much as is needed and no more: appending a word is one insert, clearing a field
is one delete run, and a change in the middle is a walk back, a delete run and one insert. Any edit
that removed text is followed by another read, so a model that drifted is corrected rather than
trusted.

## Companion

The companion APK in `companion/` runs on the TV side by side with this app and answers commands on a
TCP socket bound to the TV's **own loopback** on port 7900 (`dist/tv-companion.apk`, built by
`companion/build.sh`). Nothing on the LAN can reach it: the app dials it through `adb forward
tcp:<hostPort> tcp:7900`, which adb binds to 127.0.0.1 here, and every connection starts with an
HMAC handshake against a per-device secret provisioned over adb (the first time the TV answers
`no_secret`, the client pushes the key itself and retries once). A companion with no secret accepts
nobody. It is not kept running between uses, so the app never assumes it is there: it probes the
socket on connect and on `c`.

An answering socket is reported with its version and round trip. A silent one is started over adb
(`am start-foreground-service`) and probed again for a few seconds. A TV that cannot be reached on adb
either is reported as asleep, with the wake offered instead of another retry. If the package is not
installed, the app says so and names the APK — installing it is the first-connect flow's job, and it
only ever happens after being asked (below).

Everything still runs over adb, which is the fallback, and the header names the path beside the
companion's state (`path: typing via companion (adb forward :<hostPort>) - N commit(s), M verified`).

While the socket answers, text goes over it: the string is committed through the companion's IME and
the field is read back over the same connection, because "the commit was accepted" is not "the field
holds it". `commitText` sends no keycodes, so the layout translation, the borrowed pass-through
keyboard and the keystroke batching have nothing to do on that route: they are bypassed there and
unchanged on adb. A companion that stops answering mid-send is dropped, and that same text goes out
over adb with those mechanisms back in place. Navigation keys and volume have their own path (below);
launching and power stay on adb either way.

Typing a 36-character mixed string through the app takes 415 ms on the first companion send (it
includes selecting the companion IME) and 66 ms after that, against 2.2 s over adb, which borrows
Gboard first. With the companion stopped the app is exactly what it was before this route existed.

## First connect

The first time the app connects to a TV, it asks before touching it:

    Companion app is not set up on this TV (Android_TV). Install and pair it now? [Y/n]

"First connect" is a file, not a guess: `~/.config/tv-remote-tui/device-<device>.json`, keyed on the adb
serial (the same key the companion's own secret file is named with) with the TV's MAC inside it, so a
re-addressed TV still finds its own record. Answering once — either way — settles that device.

The question is only asked when the companion really is not set up: before showing it the app runs the
companion's own probe with **provisioning off**. That probe may bring up an already-installed service —
installed-but-idle is the companion's normal state between uses, and reading it as "not set up" would
prompt about a TV that is already set up — but it never pushes a key over adb and never installs
anything, so declining cannot write to the TV. A TV that already answers is recorded as set up and never
asked about.

`y` (or Enter) runs the setup as five steps, each with its own verdict, stopping at the first failure:

    ✓ checking adb — adb is connected to 192.168.1.50:5555
    ✓ preparing the APK — using tv-companion.apk (45602 bytes, newer than the sources)
    ✓ installing the companion — base.apk installed
    ✓ pairing this machine's key — the TV accepted this machine's key
    ✓ verifying (authenticated ping) — authenticated ping answered in 22 ms (v0.1.0, pid 3164)
    Done in 3.3s — the companion answered an authenticated ping (v0.1.0, pid 3164) on
    127.0.0.1:63307 → 192.168.1.50:7900 via adb forward. Text goes over it from here; keys stay on adb.

The APK step prefers the prebuilt `dist/tv-companion.apk` when it is newer than the companion's sources
(`.java`/`.xml`/`.sh`) and only runs `companion/build.sh` when it is missing or stale. The pairing step
creates this machine's key if there is none, pushes it over adb, and the run counts as done only when
the companion answers an **authenticated ping** — installed is not paired. The outcome goes into the
device's record.

`n` (or Esc) records the refusal: that TV stays on the adb path, is not probed for the companion on
connect either (the probe's migration path can push a key over adb, which is what was declined), and is
not asked again. `c` still probes on request.

## Input latency

Every `input` invocation starts a JVM on the TV: measured at roughly 1.7 seconds on the TCL, while a
shell round trip over the same link is 0.07 seconds. A call per keystroke is therefore unusable, so
the app sends immediately when the device is idle and gathers everything pressed while it is busy into
single calls. Ten characters cost two calls, not ten; three quick arrow presses cost two, not three.
The echo on screen is local and immediate, so the display never waits for the TV to answer. That
batching is what text, DEL and everything on the fallback path below still get.

## Key latency

Navigation keys, Back, Home, Enter and volume do not go through `input` at all. On connect the app
starts `monkey --port <n>` on the TV, forwards that port with `adb forward tcp:0`, and holds one
socket for the session (`src/monkey.mjs` owns the whole lifecycle). A key is one `press <code>` line
and its reply: 2.7 ms at best and 8.9 ms median over seven runs, against 1238-1291 ms for the same
key over `input keyevent`, measured in the same session. Nothing is installed on the TV.

The socket is the fast path, never the only one. If monkey cannot be started, or its socket dies
mid-session, the key goes out over `input keyevent` unchanged (the log line says which route it took
and what it cost), and one restart on a fresh port is attempted in the background. A dead socket is
never re-dialed: a second connection to the same monkey process kills its own command loop, so the
restart is a new process. DEL, MOVE_END and all text stay on adb.

Both are handed back on exit: `done` ends the monkey process, the forward is removed, and the pid is
killed if it outlived the socket, because a client that disappears does not stop monkey on its own.

## Power

Off is a single keyevent. The TV goes dark within a few seconds and drops off the network with the
panel, so it cannot be reached at all until it is woken.

On takes three steps in this order: a wake-on-LAN magic packet brings the network back, the app
reconnects (adb lists only the devices it has been told to connect to), and a wake keyevent turns the
panel on. Dark to awake measured 9 to 11 seconds on the TV this was built against.

Wake-on-LAN has to be enabled once in the TV's own settings, as networked standby. The app cannot do it
for you: the adb shell user has no root on a stock TV.

## App list

Shows what the TV can launch, user-installed apps first, and caches the result per device. Enter
launches the selected app, r re-probes the TV. A cached list is shown straight away, which covers a TV
that is asleep and cannot answer a probe.

The same screen is the task manager. Every row carries a liveness marker (a filled dot for a live
process, a light one for a package that is not running), and the running packages with no launcher
activity are listed under the launchable ones so they can be stopped too. f cycles the filter:
everything, user apps, system/vendor, running only. k stops the selected package with `am force-stop`
and reports what actually happened, not what the command said: the pid is read before and after, because
`am force-stop` prints nothing and exits 0 even for a package that does not exist, and a persistent
system process comes back or is never killed at all. A package the shell cannot stop - the framework,
or System UI - is refused by the app rather than taken down for a keypress. Liveness comes from `ps -A`,
whose process names are package ids here; the line under the list says how many names that was and how
many of them are vendor services rather than packages.

Press i to install an APK that sits on this machine. That opens a picker: it lists the current
directory's subdirectories and its `*.apk` files, so a directory full of other files still shows the 2
APKs in it. Arrows select, Enter opens a directory or installs the selected APK, Backspace goes up one
level, h jumps to the home directory, Esc returns to the app list. A file dialog would have taken the
terminal's focus away from the TUI, so the walk happens in the TUI itself.

Inside the picker, p is the path prompt: type or paste a path and press Enter, for a file the picker
does not list. `~` is expanded and a relative path is resolved against the current directory, so pasting
from a file manager works. Progress and the result share one line, and the result is the device's own
verdict rather than the exit code: adb can exit 0 while printing `Failure [INSTALL_FAILED_...]`, and the
reason is what gets shown, with a hint underneath for the common ones (a downgrade needs `install -d`, a
signature mismatch means the installed app was signed with a different key).

Split APKs and app bundles (`.apkm`, `.xapk`) are not supported: those are zips holding a base APK and
its split configs, and installing them means unpacking first and calling `install-multiple`. Node has
no zip reader built in, so that would be a small module of its own.

## Device history

Devices are remembered with their address, MAC and label, so they can be reconnected or woken without
retyping anything. Only devices that are not currently connected appear in the selector, and x forgets
one. State lives in `~/.config/tv-remote-tui/`.

## Build a standalone binary

    npm run build:exe                            # this machine, adb embedded
    npm run build:exe:slim                       # same, but uses the adb on PATH
    node scripts/build.mjs --target linux-x64    # cross-build, installs that target's libraries
    node scripts/build.mjs --all                 # every supported target

The result needs no Node, no Bun and no adb on the target. Builds are per platform and architecture.

## Platforms

macOS (Intel and Apple Silicon), Linux and Windows, on x64 and arm64. Only three things in the app are
written per platform: where the cache and settings live, how the system's neighbour cache is read to
find the TV's MAC, and the name of the adb executable. The interface library ships prebuilt binaries
for all of these systems.

    npm run fetch:adb -- --target win32-x64      # platform-tools for a platform you build for

`npm run fetch:adb` on its own fetches for the machine you are on. Google publishes no arm64
platform-tools for Linux or Windows, so those two use the adb on PATH. `npm test` covers the
platform-specific code, including the neighbour-cache output of all three systems and the archive a
compiled binary unpacks its adb from.

A compiled binary unpacks its adb the first time it needs it, into
`<cache>/tv-remote-tui/platform-tools/<platform>-<arch>/`. On Windows that includes the two DLLs adb
will not start without. Cross-building installs the target's interface library first, which npm only
accepts with `--force` because the package declares another system. Linux needs both its glibc and
its musl build present. A build for a platform you are not on is produced but not exercised by the
build itself: the Linux x64 binary here was run in a Debian container, and it connected to the TV
using its own embedded adb.

## Layout

    src/app.mjs       the interface: screens, keys, rendering
    src/adb.mjs       adb wrapper, keycodes, text encoding, network scan
    src/power.mjs     power on and off
    src/apps.mjs      app probe, labels, launching
    src/apk-browser.mjs the APK picker: one directory read, directories + *.apk
    src/companion.mjs the TV-side service: probe, start on demand, adb fallback
    src/companion-build.mjs the APK: prebuilt when fresher, build.sh when not
    src/device-state.mjs per-TV setup record: installed, paired, version, last seen
    src/monkey.mjs    the warm key socket: start, port choice, one connection, teardown
    src/wol.mjs       wake-on-LAN packets
    src/devices.mjs   device history
    src/platform.mjs  the three per-platform differences
    src/arp.mjs       neighbour-cache lookup, per platform
    src/archive.mjs   tar reader/writer for the embedded adb
    scripts/          fetch-adb and build
    test/             platform tests, run with npm test
    tools/            screen capture and screenshot-review helpers
    run.mjs           portable launcher
    run.sh, run.cmd   launchers for POSIX and Windows
