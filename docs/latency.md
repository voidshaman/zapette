# Latency: what each path costs

Measured on one TCL Android 11 set over wireless adb; the numbers are the point of this
project, so they are kept raw rather than rounded into a claim.

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

