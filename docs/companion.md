# The companion APK

An optional small app on the TV side. The app works without it - this route exists to remove
the per-keystroke JVM spawn that plain `adb shell input` costs.

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

