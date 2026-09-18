<div align="center">

# zapette

**A terminal remote for an Android TV, built so that typing on one stops hurting.**

Text lands in the TV's own focused field in **66 ms** instead of 2.2 s.
Keys answer in **2.7 ms** instead of 1238 ms.

[![test](https://github.com/voidshaman/zapette/actions/workflows/test.yml/badge.svg)](https://github.com/voidshaman/zapette/actions/workflows/test.yml)
[![companion-apk](https://github.com/voidshaman/zapette/actions/workflows/companion-apk.yml/badge.svg)](https://github.com/voidshaman/zapette/actions/workflows/companion-apk.yml)
[![licence: GPL-3.0-only](https://img.shields.io/badge/licence-GPL--3.0--only-blue)](LICENSE)

[Install](#install) · [Usage](#usage) · [Features](#features) · [Why it is fast](#why-it-is-fast) · [FAQ](#faq) · [Docs](#docs)

</div>

## Try it without a TV

```text
 ┏━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━┓
 ┃      ○ Demo TV   ·   demo   ·   ADB connected   ·   TV UNKNOWN    ·   path: typing via adb     ┃
 ┗━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━┛
 VOLUME               D-PAD                                TEXT
 ┏━━━━━━━━━━━━━━━━━━┓ ┏━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━┓ ┏━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━┓
 ┃                  ┃ ┃                                  ┃ ┃ MODE: MIRROR                         ┃
 ┃                  ┃ ┃                                  ┃ ┃ type here…                           ┃
 ┃                  ┃ ┃                                  ┃ ┃                                      ┃
 ┃       ████       ┃ ┃                                  ┃ ┗━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━┛
 ┃       ████       ┃ ┃                                  ┃ SEND MODE
 ┃       ████       ┃ ┃              ╭─────╮             ┃ ┏━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━┓
 ┃       ████       ┃ ┃              │  ▲  │             ┃ ┃                                      ┃
 ┃       ████       ┃ ┃              ╰─────╯             ┃ ┃  ● Mirror — the TV's field, edited   ┃
 ┃       ████       ┃ ┃      ╭─────╮ ╭─────╮ ╭─────╮     ┃ ┃  ○ Block — ⏎ sends the string        ┃
 ┃       ████       ┃ ┃      │  ◀  │ │ OK  │ │  ▶  │     ┃ ┃  ○ Instant — one key at a time       ┃
 ┃       ████       ┃ ┃      ╰─────╯ ╰─────╯ ╰─────╯     ┃ ┃  ⌨ TV keyboard: unknown QWERTY       ┃
 ┃       ████       ┃ ┃              ╭─────╮             ┃ ┗━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━┛
 ┃       ████       ┃ ┃              │  ▼  │             ┃ HISTORY
 ┃       ████       ┃ ┃              ╰─────╯             ┃ ┏━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━┓
 ┃       ████       ┃ ┃                                  ┃ ┃ ✓ device(s) — demo mode              ┃
 ┃     24 / 100     ┃ ┃ ╭────────╮ ╭────────╮ ╭─────────╮┃ ┃ ✓ VOLUME_UP                          ┃
 ┃   ╭────╮ ╭────╮  ┃ ┃ │  Back  │ │  Home  │ │⏻  Power │┃ ┃ ✓ DPAD_RIGHT                         ┃
 ┃   │ −  │ │ +  │  ┃ ┃ ╰────────╯ ╰────────╯ ╰─────────╯┃ ┃                                      ┃
 ┃   ╰────╯ ╰────╯  ┃ ┃                                  ┃ ┃                                      ┃
 ┃                  ┃ ┃                                  ┃ ┃                                      ┃
 ┃                  ┃ ┃                                  ┃ ┃                                      ┃
 ┃                  ┃ ┃                                  ┃ ┃                                      ┃
 ┗━━━━━━━━━━━━━━━━━━┛ ┗━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━┛ ┗━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━┛
  MODULE 2/4 — VOLUME        Tab / Shift+Tab switch module        1-4 jump
  ↑ ↓ change the TV volume      ← → switch module      − + also work        last sent: —
```

<sub>Real output of `./run.sh --demo`, which drives the whole UI offline. Every number in this README
was measured on a real set, not estimated.</sub>

## Install

**From a release** — grab the binary for your platform from [Releases](../../releases). It carries its
own adb, so it needs no Node and no npm.

**From source**

```sh
git clone https://github.com/voidshaman/zapette
cd zapette
npm install
./run.sh
```

Needs **Node 26.4+**, and a TV with wireless debugging enabled (Developer options → ADB over network).

## Usage

```sh
./run.sh          # pick a device, then the remote
./run.sh --auto   # first connected device
./run.sh --demo   # no TV: drive the UI offline
```

| what | how |
|---|---|
| **Type** | `3` for Text. The box mirrors the TV's field: edit here and the difference is pushed to the TV. Enter is the TV's OK. |
| **Steer** | Arrows, Enter and Backspace in the D-pad module — or click the on-screen buttons. |
| **Apps** | `l` lists what the TV can launch and what is running: Enter launches, `k` stops, `f` filters, `i` installs an APK from this machine. |
| **Power** | `w` wakes it (Wake-on-LAN), `s` sleeps it, `p` toggles. Dark to awake takes 9–11 s. |
| **Companion** | `c` probes the TV-side service, starting it if it is not running. |
| **Cursor** | `m` hands this machine's mouse to a pointer on the TV; `m` or Esc releases it. |

<details>
<summary><b>Every key</b></summary>

| key | does |
|---|---|
| `Tab` / `Shift+Tab` | switch module (works from inside the text box) |
| `1` `2` `3` `4` | jump to D-pad / Volume / Text / Send mode |
| arrows, `Enter`, `Backspace`/`b`, `h` | drive the TV: direction, OK, Back, Home |
| `↑` `↓` or `−` `+` | volume, in the Volume module |
| `w` / `s` / `p` | wake / sleep / power |
| `l` | app list and task manager |
| `i` | install an APK (opens a filesystem picker) |
| `c` | probe the companion service |
| `m` | cursor mode |
| `d` | device selector |
| `Esc` | leave a screen or release cursor mode |

While the text box has focus the keyboard belongs to it, so no shortcut can fire — `Tab` still gets
you out.

</details>

## Features

- **Type into the TV's own field.** No on-screen keyboard: the box mirrors whatever the TV has focused,
  you edit it here, and the change is pushed back.
- **Keys in single-digit milliseconds.** D-pad, Back, Home, Enter and volume ride a warm `monkey`
  socket instead of spawning a JVM per key — about **460× faster** than `adb shell input keyevent`.
- **A fallback under every fast path.** The plain adb route stays byte-identical and the route is
  chosen in one place, so a TV with neither the companion app nor monkey still works.
- **Optional companion APK.** A small app on the TV answers text and keys over a socket bound to its
  **loopback**, behind a per-device HMAC secret provisioned over adb. Nothing on the LAN can reach it.
- **First-connect setup.** The first time it meets a TV it asks before touching it, then installs and
  pairs the companion in five visible steps. Declining leaves the adb path intact.
- **App launcher and task manager.** `l` shows what the TV can launch and what is running; `k` stops a
  package and reports what actually happened rather than what the command said.
- **APK installer.** `i` walks this machine's filesystem inside the TUI and installs through the
  device's own verdict, not adb's exit code.
- **Cursor mode.** `m` gives the TV a pointer driven by your mouse; taps land, and the position is
  shown in the footer because TV apps draw no cursor for injected motion.
- **Cross-platform.** macOS, Linux and Windows on x64 and arm64; a compiled binary embeds its own adb.

## Why it is fast

| path | cost |
|---|---|
| text, companion route | **66 ms** per send (415 ms on the first, which selects the IME) |
| text, adb route | 2.2 s |
| keys, monkey socket | **2.7 ms** best / 8.9 ms median |
| keys, `adb shell input keyevent` | 1238 ms |
| companion ping, via `adb forward` | 8.4 ms |

Plain `adb shell input` starts a JVM on the TV for every call, which is why a naive remote feels like
typing through mud. Two things avoid it: a long-lived `monkey` socket for keys, and the companion's own
IME for text, which commits a whole string in one call. Both are additive — pull either away and the
app degrades to plain adb instead of breaking.

## FAQ

<details>
<summary>Does it need root?</summary>

No. The stock adb shell user has no root on these TVs, and nothing here asks for it.
</details>

<details>
<summary>Why does my TV show the wrong letters, or lose repeated ones?</summary>

`adb shell input text` sends a **US key position**, and the TV renders that position through its own
keyboard — on an AZERTY set, `q` arrives as `a`. Repeated characters can also be eaten as multi-press.
The app reads the TV's keyboard layout on connect and borrows a pass-through keyboard while text is
going out, then hands the TV its own back. Details in [docs/typing.md](docs/typing.md).
</details>

<details>
<summary>Is the companion app required?</summary>

No. Everything works over adb without it; the companion exists only to remove the per-keystroke JVM
spawn. See [docs/companion.md](docs/companion.md).
</details>

<details>
<summary>Can something else on my network drive my TV through this?</summary>

No. The companion binds to the TV's loopback only, and every connection must answer an HMAC challenge
against a secret that was provisioned over adb. A companion with no secret stored accepts nothing.
</details>

<details>
<summary>My TV keeps going to sleep on its own.</summary>

That is the TV's own power policy, not the app — one set tested here sleeps on a vendor auto-standby
timer within minutes of idle. Wake-on-LAN brings the network back (enable "networked standby" in the
TV's settings first), and `w` does that for you.
</details>

## Docs

| | |
|---|---|
| [docs/typing.md](docs/typing.md) | the TV's own keyboard, AZERTY, characters it eats, mirror mode and carets |
| [docs/latency.md](docs/latency.md) | why batching exists, how the monkey socket works, power timings |
| [docs/companion.md](docs/companion.md) | the APK, its security model, the first-connect install flow |
| [docs/apps.md](docs/apps.md) | app list, task manager, APK installer, device history |
| [docs/build.md](docs/build.md) | standalone binaries, cross-building, per-platform notes |
| [HANDOFF.md](HANDOFF.md) | working state and the raw measurements |

## Licence

**GPL-3.0-only.** The vendored adb is Apache-2.0 (see [`assets/NOTICE.txt`](assets/NOTICE.txt)), which
is compatible with GPLv3.
