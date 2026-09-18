# zapette

[![test](https://github.com/voidshaman/zapette/actions/workflows/test.yml/badge.svg)](https://github.com/voidshaman/zapette/actions/workflows/test.yml)
[![companion-apk](https://github.com/voidshaman/zapette/actions/workflows/companion-apk.yml/badge.svg)](https://github.com/voidshaman/zapette/actions/workflows/companion-apk.yml)

A terminal remote for an Android TV, built to remove the delay in typing on one. Text reaches the TV's
own focused field in ~66 ms instead of the 2.2 s that `adb shell input` costs, and keys answer in
single-digit milliseconds.

## Features

- **Type into the TV's own field.** The box mirrors whatever the TV has focused: read it, edit it here,
  and the difference is pushed back. No on-screen keyboard.
- **Keys at 2.7 ms.** D-pad, Back, Home, Enter and volume ride a warm `monkey` socket instead of a
  per-key JVM spawn — about 460× faster than `adb shell input keyevent`.
- **Always with a fallback.** Every fast path has the plain adb route underneath it, chosen in one
  place. A TV with neither the companion nor monkey still works, unchanged.
- **Optional companion APK.** A small app on the TV answers text and key commands over a socket bound
  to its loopback, behind a per-device HMAC secret. Nothing on the LAN can reach it.
- **First-connect setup.** The first time it meets a TV it asks before touching it, then installs and
  pairs the companion in five visible steps. Declining leaves the adb path intact.
- **App launcher and task manager.** `l` shows what the TV can launch and what is running; `k` stops a
  package and reports what actually happened, `f` filters.
- **APK installer.** `i` walks this machine's filesystem inside the TUI and installs through the
  device's own verdict rather than adb's exit code.
- **Cursor mode.** `m` hands the mouse to a pointer on the TV; taps land, and the position is reported
  in the footer because TV apps draw no cursor for injected motion.
- **Wake and power.** Wake-on-LAN brings the network back, a key lights the panel — 9–11 s dark to awake.
- **Cross-platform.** macOS, Linux and Windows, x64 and arm64; a compiled binary embeds its own adb.

## Requirements

- Node 26.4 or newer (`NODE_BIN` overrides which one the launcher uses).
- A TV with wireless debugging enabled (Developer options → ADB over network).
- adb: macOS source runs use the copy in the repo, `npm run fetch:adb` installs it for any other
  platform, and failing both the app falls back to the adb on `PATH`. A compiled binary carries its own.

## Run

    ./run.sh          # pick a device, then the remote
    ./run.sh --auto   # first connected device
    ./run.sh --demo   # no TV: drive the UI offline

`run.cmd` is the same launcher on Windows; both are thin wrappers around `node run.mjs`.

## Keys

    Tab / Shift+Tab   switch module (also from inside the text box)
    1 2 3 4           jump to D-pad / Volume / Text / Send mode
    w / s / p         wake / sleep / power
    l                 app list  (Enter launch, k stop, f filter, i install, r re-probe)
    c                 probe the companion service, starting it if needed
    m                 cursor mode (m or Escape releases)
    d                 device selector

Arrows drive the TV, Enter is OK, Backspace or `b` is Back, `h` is Home. The focused module's border
lights up, and every on-screen button is also clickable. While the text box has focus the keyboard
belongs to it, so no shortcut can fire — Tab still gets you out.

## What each path costs

| path | cost |
|---|---|
| text, companion route | **66 ms** per send (415 ms on the first, which selects the IME) |
| text, adb route | 2.2 s |
| keys, monkey socket | **2.7 ms** best / 8.9 ms median |
| keys, `adb shell input keyevent` | 1238 ms |
| companion ping via `adb forward` | 8.4 ms |
| wake, dark to awake | 9–11 s |

## Deeper notes

- [docs/typing.md](docs/typing.md) — the TV's own keyboard, AZERTY, characters it eats, mirror mode
- [docs/latency.md](docs/latency.md) — why batching exists, the monkey socket, power timings
- [docs/companion.md](docs/companion.md) — the APK, its security model, the first-connect flow
- [docs/apps.md](docs/apps.md) — app list, task manager, APK installer, device history
- [docs/build.md](docs/build.md) — standalone binaries and per-platform notes
- [HANDOFF.md](HANDOFF.md) — working state and measurements

## Layout

    src/app.mjs        the interface: screens, keys, rendering
    src/adb.mjs        adb wrapper, keycodes, text encoding, network scan
    src/monkey.mjs     the warm key socket: start, port choice, teardown
    src/companion.mjs  companion client: probe, provision the key, adb fallback
    src/mirror.mjs     reading and editing the TV's focused field
    src/apps.mjs, apk-browser.mjs, processes.mjs   app list, APK picker, task manager
    src/power.mjs, wol.mjs, devices.mjs, device-state.mjs, arp.mjs, platform.mjs, archive.mjs
    companion/         the TV-side app, built by companion/build.sh
    test/              run with npm test
    docs/              the notes above
    tools/             screen capture and screenshot-review helpers

## Licence

GPL-3.0-only. The vendored adb is Apache-2.0 (see `assets/NOTICE.txt`).
