# Handoff

State of this project and the plan for the next step. Measurements are from the
TV this was built against: a TCL Android TV, Android 11 (API 30), armeabi-v7a,
`192.168.1.50:5555`, locale fr-FR, reachable over wireless adb.

## Where it stands

Repo `~/Projects/tv-remote-tui`, branch `main`, local only, nothing pushed.
HEAD `9d84613`, 34 tests passing (`npm test`).

Commits, oldest first: `41e4966` initial, `135fe58` cross-platform, `3a970c6`
APK install, `18a4760` typing batching, `c3c3f1c` stop embedding adb twice,
`ef48d19` erase fix, `2b20dfa` mirror mode + keyboard layouts, `9d84613` borrow
the pass-through keyboard.

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

## Measurements

Cost of one action, host round trip, minimum of three:

| what | cost |
|---|---|
| `adb shell getprop` (native command) | 0.08 s |
| `adb shell cmd -l` (Java command) | 0.16 s |
| `adb shell input keyevent` | 1.2 - 1.6 s |
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
commanded over a socket through `adb forward`) starts and answers, but every
command form tried returned `ERROR:Invalid Argument`. Worth one more attempt on
the command grammar, since it would be a warm JVM with no install at all.

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

## Tools

- `tools/tui-capture.py` drives the app in a pty and prints the rendered screen.
  It takes `--wait` (before each `--send`) and `--hold` (how long to keep the app
  alive after the last one). **A run must outlive its last keystroke**: work that
  is batched or waiting on a typing pause lands after the send, and killing the
  app there hides exactly what the run was meant to show. That trap produced two
  false "the append never synced" reports before it was found.
- `tools/ask-vision.py` reads an image with a vision model; used for pixels.
- Field reads while developing: dump to `/sdcard`, `cat` it back, match the node
  whose resource-id ends in `lb_search_text_editor`.

## Planned: a companion APK

Goal: take adb out of the hot path. One small APK on the TV, three roles, with
adb kept as a probed fallback.

1. **Socket server** (TCP, say 7878) - transport. A command then costs LAN round
   trip plus an in-process injection, tens of milliseconds instead of 1.2 s.
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
