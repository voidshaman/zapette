# tv-remote-tui

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
    l                app list
    d                device selector

Inside D-pad, the arrows drive the TV, Enter is OK, Backspace or b is Back, h is Home. In Volume, up
and down change the TV volume, and the minus and plus buttons do the same; left and right switch
module. Every on-screen button is also clickable.

In Text, the box mirrors the TV's field by default: the field's contents are read into it, edits are
pushed to the TV after a pause, and Enter is the TV's OK button, so a search or a form can be filled
without leaving the module. Backspace edits the box; once it is empty it deletes on the TV instead, so
a block that has already been sent can still be corrected. Send mode picks between Mirror (the
default), Block, where Enter sends the whole string, and Instant, where every key goes to the TV as you
type. Send mode also shows which keyboard the TV is using: i switches the TV to one that passes text
through unchanged, k forces the translation by hand.

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
sent, including the letters AZERTY moves and words with doubled letters. Press i in the Send mode
module to switch, and i again to give the TV its own keyboard back; it is a TV-wide setting, so the app
only ever does it when asked.

The app reads the keyboard from the TV when it connects. Where it knows the layout remaps, it
translates letters on the way out, so a TV that cannot be switched still types mostly right; k cycles
that translation between automatic, on and off. Characters behind AltGr on AZERTY, `@` and `#` among
them, cannot be produced by `input text` at all, since it can express base and shift only: the app
names them instead of pretending they were sent.

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

## Input latency

Every `input` invocation starts a JVM on the TV: measured at roughly 1.7 seconds on the TCL, while a
shell round trip over the same link is 0.07 seconds. A call per keystroke is therefore unusable, so the
app sends immediately when the device is idle and gathers everything pressed while it is busy into
single calls. Ten characters cost two calls, not ten; three quick arrow presses cost two, not three.
The echo on screen is local and immediate, so the display never waits for the TV to answer.

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

Press i to install an APK that sits on this machine: type or paste the path and press Enter. `~` is
expanded and a relative path is resolved against the current directory, so pasting from a file manager
works. Progress and the result share one line, and the result is the device's own verdict rather than
the exit code: adb can exit 0 while printing `Failure [INSTALL_FAILED_...]`, and the reason is what
gets shown, with a hint underneath for the common ones (a downgrade needs `install -d`, a signature
mismatch means the installed app was signed with a different key).

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
