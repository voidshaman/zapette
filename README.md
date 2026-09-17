# tv-remote-tui

A terminal remote for an Android TV, driven over wireless ADB. Pick a device, then use one screen to
run it: D-pad, volume, text entry, power, and the apps installed on the TV.

## Requirements

- Node 26.4 or newer. `run.sh` finds a suitable one; override with `NODE_BIN=/path/to/node`.
- A TV with wireless debugging enabled (Developer options, ADB over network).
- adb, bundled with the project: `assets/adb` for a source run, or inside the compiled binary.

## Run

    ./run.sh          # choose a device, then the remote
    ./run.sh --auto   # open the first connected device
    ./run.sh --demo   # no TV: drives the UI offline

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
module. In Text, type and press Enter to send the string, or use instant mode and every key goes to the
TV as you type. Send mode toggles instant and block. Every on-screen button is also clickable.

Keys resolve in this order: Tab first, then the text box, then the shortcuts above, then the focused
module. So while the text box has focus the keyboard belongs to it and no shortcut can fire; Tab still
gets you out, and Escape on an empty field moves on.

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

## Device history

Devices are remembered with their address, MAC and label, so they can be reconnected or woken without
retyping anything. Only devices that are not currently connected appear in the selector, and x forgets
one. State lives in `~/.config/tv-remote-tui/`.

## Build a standalone binary

    npm run build:exe          # embeds the runtime, the TUI library and adb
    npm run build:exe:slim     # same, but uses the adb on PATH

The result needs no Node, no Bun and no adb on the target. Builds are per platform and architecture.

## Layout

    src/app.mjs      the interface: screens, keys, rendering
    src/adb.mjs      adb wrapper, keycodes, text encoding, network scan
    src/power.mjs    power on and off
    src/apps.mjs     app probe, labels, launching
    src/wol.mjs      wake-on-LAN packets
    src/devices.mjs  device history
    tools/           screen capture and screenshot-review helpers
    run.sh           launcher
