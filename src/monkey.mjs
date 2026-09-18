// Keys have two transports, and this module owns the fast one.
//
// `adb shell input keyevent` starts a fresh ART VM on the TV for EVERY call:
// measured 1.2-1.6 s on this set, and keeping the adb connection (or its shell)
// open saves only the ~0.08 s client spawn. `monkey --port <n>` runs a JVM *on*
// the device that takes commands over a socket, and `adb forward` brings that
// socket to this machine: measured 2.8-5.3 ms per key, about 250x. Nothing is
// installed on the TV for it.
//
// The grammar (recovered from the TV's own /system/framework/monkey.jar) is one
// command per line; the reply is `OK`, `OK:<msg>`, `ERROR` or `ERROR:<msg>`:
//
//     press <code>        down+up for one keycode, 4-8 ms   <- what this uses
//     key down|up <code>  exactly three tokens
//     sleep <ms>          a no-op, used here as the readiness probe
//     done                answers OK and ends the monkey process
//
// Three properties of that server decide the shape of everything below:
//
//   1. AN UNKNOWN VERB GETS NO REPLY AT ALL, so a silent socket is a misspelled
//      verb rather than a dead server. Every command is therefore sent with a
//      timeout, and the error names the command that went unanswered.
//   2. ONE CLIENT CONNECTION PER MONKEY PROCESS: the setup path starts a thread
//      that is already started when a second client arrives, and the uncaught
//      exception ends the monkey loop. So this module holds ONE socket, and when
//      it dies it restarts monkey on a NEW port instead of dialing again.
//   3. A SECOND `monkey --port <n>` WHILE THE FIRST IS ALIVE EXITS 251,
//      "Error binding to network socket." (it binds 127.0.0.1 with no
//      SO_REUSEADDR). Candidate ports are therefore tried in order and one is
//      only believed once the process is still alive AND the forward dials.
//
// The adb path in src/adb.mjs is the fallback and stays exactly as it was: if
// monkey cannot be started, dies mid-session, or answers an error, the key goes
// out over `input keyevent` and the session carries on. Text never comes through
// here: monkey's `type <text>` goes through the device's KeyCharacterMap, so the
// TV's layout remaps it exactly like `input text` — arbitrary text is the
// companion IME's job (src/companion.mjs). DEL and MOVE_END stay on adb too:
// they are text editing, and their bursts are cheap enough batched.
import { spawn, spawnSync } from "node:child_process"
import * as net from "node:net"
import { KEY, adb, adbBinary } from "./adb.mjs"

/** The keys this transport carries: D-pad, OK/Enter, Back, Home, volume. */
export const MONKEY_KEYS = new Set([
  KEY.UP,
  KEY.DOWN,
  KEY.LEFT,
  KEY.RIGHT,
  KEY.OK,
  KEY.ENTER,
  KEY.BACK,
  KEY.HOME,
  KEY.VOL_UP,
  KEY.VOL_DOWN,
])

/** True when every code of a burst is one monkey should carry. */
export function monkeyOwnsKeys(codes) {
  const list = Array.isArray(codes) ? codes : [codes]
  return list.length > 0 && list.every((code) => MONKEY_KEYS.has(code))
}

export const MONKEY = {
  // Candidate device ports, in order: below Android's ephemeral range (32768+)
  // and clear of the companion (7900) and adb (5555).
  ports: [1080, 1081, 1082, 1083, 1084, 1085],
  // One command in, one line out: 2.8-5.3 ms measured on this TV, so 400 ms is
  // ~80x the answer and still short enough to fall back inside one keypress.
  timeoutMs: 400,
  // How long monkey gets to bind before its port is called taken.
  startWaitMs: 900,
  // A dead socket gets a fresh process, bounded, so a TV that refuses to run
  // monkey at all cannot turn every key into a restart loop.
  restartLimit: 3,
  restartGapMs: 1000,
  quitWaitMs: 150,
  dialWaitMs: 700,
}

const sleep = (ms) => new Promise((done) => setTimeout(done, ms))
const firstLine = (s) => String(s ?? "").trim().split("\n")[0].slice(0, 200)

// The live socket, the device-side process, and the forward that reaches it.
let live = null
// Where the app's log lines go for things that happen without a caller: a
// restart that succeeded, a fallback that has become permanent. Set by
// ensureMonkey, which is the only entry point that starts anything.
let note = null
let restarts = 0
let restarting = false
let lastRestartAt = 0

let info = {
  state: "off", // "off" | "alive" | "failed"
  serial: null,
  pid: null, // the device-side monkey process, for teardown
  port: null, // the port monkey listens on, on the device
  localPort: null, // the local port adb forwards it to
  ms: null, // how long the start took, when it worked
  keys: 0, // keys carried by monkey this session
  points: 0, // pointer events (touch/tap) carried by monkey this session
  fails: 0, // keys that fell back to adb
  restarts: 0,
  detail: "not started",
}

/** What to show/log: never the live handles, always plain data. */
export function monkeyInfo() {
  return { ...info, alive: !!live }
}

/**
 * One connection per monkey process, one line per command: replies are matched
 * to commands in order, and any failure poisons the channel rather than being
 * papered over — a reply that never came desyncs every reply behind it, and the
 * only cure the server allows is a new process.
 */
function channelFor(socket) {
  let buffer = ""
  let dead = null
  const waiters = []

  const fail = (error) => {
    if (!dead) dead = error
    for (const waiter of waiters.splice(0)) waiter.done({ ok: false, error })
  }

  socket.setNoDelay(true)
  socket.on("data", (chunk) => {
    buffer += chunk.toString("utf8")
    let end
    while ((end = buffer.indexOf("\n")) >= 0) {
      const line = buffer.slice(0, end).trim()
      buffer = buffer.slice(end + 1)
      if (!line) continue
      const waiter = waiters.shift()
      if (waiter) waiter.done({ ok: true, line })
    }
  })
  socket.on("error", (error) => fail(error?.code ?? error?.message ?? "socket error"))
  socket.on("close", () => fail("the monkey socket closed"))

  return {
    get dead() {
      return dead
    },
    /** Send one command, resolve with its reply line or with why there isn't one. */
    send(command) {
      return new Promise((resolve) => {
        if (dead) return resolve({ ok: false, error: dead, command, ms: 0 })
        const started = process.hrtime.bigint()
        const waiter = {
          done(result) {
            clearTimeout(waiter.timer)
            const i = waiters.indexOf(waiter)
            if (i >= 0) waiters.splice(i, 1)
            resolve({
              ...result,
              command,
              ms: result.ms ?? Number(process.hrtime.bigint() - started) / 1e6,
            })
          },
        }
        waiter.timer = setTimeout(() => {
          const error = `no reply to "${command}" within ${MONKEY.timeoutMs} ms`
          waiter.done({ ok: false, error })
          fail(error)
        }, MONKEY.timeoutMs)
        waiters.push(waiter)
        try {
          socket.write(`${command}\n`)
        } catch (error) {
          waiter.done({ ok: false, error: String(error?.message ?? error) })
        }
      })
    },
  }
}

/** `adb forward tcp:0 tcp:<device>` asks adb for a free local port, so two
 * sessions — or another worker on this machine — cannot collide on the host. */
async function forward(bin, serial, devicePort) {
  const auto = await adb(["-s", serial, "forward", "tcp:0", `tcp:${devicePort}`], { timeout: 8000 })
  const assigned = Number((String(auto.out).match(/\d+/) ?? [])[0])
  if (auto.ok && Number.isInteger(assigned) && assigned > 0) return assigned
  const direct = await adb(["-s", serial, "forward", `tcp:${devicePort}`, `tcp:${devicePort}`], { timeout: 8000 })
  const bad = /cannot|fail|in use|error/i.test(`${direct.out} ${direct.err}`)
  return direct.ok && !bad ? devicePort : null
}

function removeForward(bin, serial, localPort) {
  return adb(["-s", serial, "forward", "--remove", `tcp:${localPort}`], { timeout: 8000 })
}

/** Dial the forwarded port. Nothing is listening → refused, and the caller moves on. */
function dial(localPort, timeout = MONKEY.dialWaitMs) {
  return new Promise((resolve) => {
    const socket = new net.Socket()
    let settled = false
    const finish = (result) => {
      if (settled) return
      settled = true
      resolve(result)
    }
    socket.setTimeout(timeout)
    socket.once("timeout", () => {
      socket.destroy()
      finish(null)
    })
    socket.once("error", () => {
      socket.destroy()
      finish(null)
    })
    socket.connect(localPort, "127.0.0.1", () => {
      socket.setTimeout(0)
      finish(socket)
    })
  })
}

/** The pids of monkey JVMs on the device — how our own is identified. */
async function monkeyPids(serial) {
  const r = await adb(["-s", serial, "shell", "ps -A -o PID,ARGS"], { timeout: 8000 })
  const pids = []
  for (const line of (r.out || "").split("\n")) {
    if (!/com\.android\.commands\.monkey\b/.test(line)) continue
    const pid = Number(line.trim().split(/\s+/)[0])
    if (Number.isInteger(pid) && pid > 0) pids.push(pid)
  }
  return pids
}

/**
 * Start monkey, forward it, hold one socket. Returns `{ ok, ...monkeyInfo() }`.
 *
 * This is where the port is really chosen: a candidate is spawned, given time to
 * bind, and then handed one connection. A port that is already taken (another
 * monkey, a vendor listener) either exits 251 with "Error binding to network
 * socket." — detected by the process being gone — or forwards to nothing.
 */
export async function startMonkey(serial, { onStep } = {}) {
  note = onStep ?? note
  const started = Date.now()
  const bin = await adbBinary()
  const tried = []

  for (const port of MONKEY.ports) {
    // Which device-side process is OURS: `$!` from the wrapper shell is not
    // reliably the JVM (measured — it reported the wrapping subshell, and
    // killing that left the JVM running), so the pid is the new entry in the
    // monkey process list across this spawn.
    const before = await monkeyPids(serial)
    const command = `monkey --port ${port} & echo monkey_pid=$!; wait $!`
    const child = spawn(bin, ["-s", serial, "shell", command], {
      stdio: ["ignore", "pipe", "pipe"],
    })
    let said = ""
    let exited = false
    child.stdout.on("data", (chunk) => {
      said += chunk.toString("utf8")
    })
    child.stderr.on("data", (chunk) => {
      said += chunk.toString("utf8")
    })
    child.once("exit", () => {
      exited = true
    })
    child.once("error", () => {
      exited = true
    })

    await sleep(MONKEY.startWaitMs)
    if (exited) {
      tried.push(`${port}: ${firstLine(said) || "monkey exited"}`)
      continue
    }
    const fresh = (await monkeyPids(serial)).filter((pid) => !before.includes(pid))
    const pid = fresh[0] ?? (Number((/monkey_pid=(\d+)/.exec(said) ?? [])[1]) || null)

    const localPort = await forward(bin, serial, port)
    if (!localPort) {
      tried.push(`${port}: adb forward failed`)
      child.kill("SIGTERM")
      // A candidate that is not taken over still has a JVM on the TV, and a JVM left
      // resident takes the one UiAutomation slot (measured): every attempt that is
      // given up on is cleaned up on the device side too, not just on this side.
      await killDevicePid({ serial, pid })
      continue
    }

    const socket = await dial(localPort)
    if (!socket) {
      tried.push(`${port}: the forward dialed nothing`)
      await removeForward(bin, serial, localPort)
      child.kill("SIGTERM")
      await killDevicePid({ serial, pid })
      continue
    }

    // Readiness has to be a round trip, not a connect: `sleep` is a no-op in the
    // grammar that still answers, so it proves the command loop is up without
    // pressing a key on the TV. A verb the server does not know answers nothing.
    const channel = channelFor(socket)
    const ready = await channel.send("sleep 1")
    if (!ready.ok || /^ERROR/i.test(ready.line ?? "")) {
      tried.push(`${port}: ${ready.error ?? ready.line}`)
      socket.destroy()
      await removeForward(bin, serial, localPort)
      child.kill("SIGTERM")
      // The one that matters most: a monkey that went quiet mid-handshake may still
      // have taken the slot on the way, and leaving it behind is what makes every
      // `uiautomator dump` after it die with rc=137 (measured).
      await killDevicePid({ serial, pid })
      continue
    }

    live = { socket, child, channel, bin, serial, pid, devicePort: port, localPort, keys: 0, points: 0 }
    info = {
      state: "alive",
      serial,
      pid,
      port,
      localPort,
      ms: Date.now() - started,
      keys: 0,
      points: 0,
      fails: 0,
      restarts,
      detail: `monkey pid ${pid ?? "?"} on device port ${port}, forwarded to 127.0.0.1:${localPort}`,
    }
    return { ok: true, ...monkeyInfo() }
  }

  info = {
    ...info,
    state: "failed",
    serial,
    pid: null,
    port: null,
    localPort: null,
    ms: Date.now() - started,
    restarts,
    detail: tried.length ? `no usable monkey port — ${tried.join("; ")}` : "no candidate ports",
  }
  return { ok: false, ...monkeyInfo() }
}

/**
 * Bring the transport up for a device, once. `force` retries a session that has
 * already failed (a new device, or a wake) — without it, a failed monkey stays
 * failed instead of being re-dialed on every keypress.
 */
export async function ensureMonkey({ serial, onStep, force = false } = {}) {
  note = onStep ?? note
  if (!serial) return { ok: false, ...monkeyInfo(), detail: "no device to start monkey on" }
  if (live && live.serial === serial) return { ok: true, ...monkeyInfo() }
  if (live) await stopMonkey(`switching to ${serial}`)
  if (!force && info.state === "failed" && info.serial === serial) return { ok: false, ...monkeyInfo() }
  return startMonkey(serial, { onStep })
}

/** Restart on a FRESH port after a failure — the server forbids a reconnect. */
function scheduleRestart(why) {
  if (restarting || restarts >= MONKEY.restartLimit) return
  if (Date.now() - lastRestartAt < MONKEY.restartGapMs) return
  restarts += 1
  restarting = true
  lastRestartAt = Date.now()
  const serial = info.serial
  note?.(`monkey died (${firstLine(why)}) — restarting it on a fresh port`)
  startMonkey(serial)
    .then((res) => {
      restarting = false
      note?.(
        res.ok
          ? `monkey back on port ${res.port} (restart ${restarts}/${MONKEY.restartLimit})`
          : `monkey restart failed — ${res.detail}`,
      )
    })
    .catch(() => {
      restarting = false
    })
}

/** Take the whole transport down after a failure, then try one fresh process. */
async function killLive(why) {
  const dead = live
  live = null
  if (!dead) return
  try {
    dead.socket.destroy()
  } catch {
    // already gone
  }
  if (dead.child.exitCode === null) dead.child.kill("SIGTERM")
  await killDevicePid(dead)
  await removeForward(dead.bin, dead.serial, dead.localPort)
  info = { ...info, state: "failed", detail: why }
  scheduleRestart(why)
}

/**
 * Kill the device-side process by pid, guarded by /proc so a recycled pid cannot
 * be hit. Needed because a client that goes away does NOT end monkey: measured
 * on this TV, the JVM stayed resident after its adb shell was killed, and the
 * `done` verb is no help once the socket is gone.
 */
function killDevicePid({ serial, pid }) {
  if (!pid) return Promise.resolve()
  return adb(["-s", serial, "shell", `if [ -d /proc/${pid} ]; then kill -9 ${pid}; fi; true`], { timeout: 8000 })
}

/**
 * Send keys over the held socket, one `press` per key, pipelined.
 *
 * There is deliberately no batching: at ~4 ms a key there is no window worth
 * gathering through, and the caller gets each key's own round trip back.
 */
export async function monkeyKeys(codes) {
  const t = live
  if (!t) return { ok: false, via: null, error: info.detail ?? "monkey is not running" }
  const list = Array.isArray(codes) ? codes : [codes]
  const started = process.hrtime.bigint()
  const replies = await Promise.all(list.map((code) => t.channel.send(`press ${code}`)))
  const ms = Number(process.hrtime.bigint() - started) / 1e6
  const bad = replies.find((r) => !r.ok || /^ERROR/i.test(r.line ?? ""))
  if (!bad) {
    t.keys += list.length
    info.keys += list.length
    return { ok: true, via: "monkey", ms, replies: replies.map((r) => r.line) }
  }
  const error = bad.error ?? bad.line
  info.fails += 1
  await killLive(`key failed: ${error}`)
  return { ok: false, via: "monkey", error, ms }
}

/**
 * Pointer events: monkey's own touch verbs, which are the ONLY way this project
 * can reach a screen coordinate. Grammar (recovered from the TV's own
 * monkey.jar, and confirmed against the device — see below):
 *
 *     touch down|up|move <x> <y>     tap <x> <y>
 *
 * Measured on the TCL (Android 11) through this module, 2026-09-18:
 *   - `touch move <x> <y>` alone: 4.00 ms mean / 250 cmds per second sustained,
 *     but it reaches NOTHING — a MOVE with no DOWN in front of it is dropped by
 *     the input pipeline (byte-identical frames, twice over).
 *   - `touch down <x> <y>` is delivered on its own (the framework draws its
 *     touch indicator at exactly <x>,<y> — the panel is 1:1 pixels).
 *   - `tap <x> <y>` activates what sits under it: 16.25 ms mean / 61 taps per
 *     second.
 *   - a short token count is an ERROR (`touch move 500` → ERROR:Invalid
 *     Argument), and coordinates are NOT validated: 2000/-5 answer OK.
 *
 * So a "pointer" here is a position we track ourselves plus taps: the TV draws
 * no cursor for these events (they are touchscreen-sourced, not mouse-sourced).
 */
export async function monkeyPointer(event) {
  const t = live
  if (!t) return { ok: false, via: null, error: info.detail ?? "monkey is not running" }
  const type = event?.type
  const x = Math.round(Number(event?.x))
  const y = Math.round(Number(event?.y))
  if (!["down", "up", "move", "tap"].includes(type)) {
    return { ok: false, via: "monkey", error: `unknown pointer event "${type}"` }
  }
  if (!Number.isFinite(x) || !Number.isFinite(y)) {
    return { ok: false, via: "monkey", error: `bad pointer coordinates (${event?.x}, ${event?.y})` }
  }
  const command = type === "tap" ? `tap ${x} ${y}` : `touch ${type} ${x} ${y}`
  const started = process.hrtime.bigint()
  const reply = await t.channel.send(command)
  const ms = Number(process.hrtime.bigint() - started) / 1e6
  if (reply.ok && !/^ERROR/i.test(reply.line ?? "")) {
    t.points += 1
    info.points += 1
    return { ok: true, via: "monkey", ms, command, detail: reply.line }
  }
  const error = reply.error ?? reply.line
  info.fails += 1
  await killLive(`pointer event failed: ${error}`)
  return { ok: false, via: "monkey", error, ms, command }
}

/** The TV has ONE UiAutomation slot, and a monkey that has carried a command holds
 * it, so any other client is refused while keys go over monkey — `uiautomator dump`
 * on this TCL dies with rc=137 in ~0.9 s (see mirror.mjs#dumpFailure). The two calls
 * below are how the app lends that slot to a reader and takes it back:
 *
 *   releaseSlot  stopMonkey, which kills the device-side JVM and frees the slot
 *   reclaimSlot  ensureMonkey({force:true}), on a fresh port (the server forbids a
 *                reconnect: one client connection per monkey process)
 *
 * Measured on the TCL (Android 11, 2 GB) 2026-09-18, through this module:
 *   - a dialled monkey holds it: dump rc=137 in 0.83-0.86 s, 3/3
 *   - releaseSlot costs 108-132 ms and the slot is free the moment the JVM is gone —
 *     the very next dump answered rc=0 in 2.42 s with no settle wait
 *   - reclaimSlot costs 1.3-1.5 s and lands on the port the freed process had
 *   - a whole handoff (stop, one full mirror read, restart) was 8.03 s, of which the
 *     read was 6.39 s, and the dump was SIGKILLed again afterwards (the monkey was
 *     back in charge of the slot)
 *
 * Nothing here decides WHEN a slot is worth lending — that is the caller's, and on
 * the app's adb route it is src/app.mjs#probeField.
 */

/** True while a monkey that has taken the TV's UiAutomation slot is live. */
export function monkeyHoldsSlot() {
  return !!live && info.state === "alive"
}

/**
 * Free the slot for a reader and report what that cost. Keys sent while the slot is
 * out go over `input keyevent` (the transport's own fallback, 1.2-1.6 s each): the
 * caller does not wait for the read, so the key path is only down for this call.
 */
export async function releaseSlot(reason = "a field read") {
  if (!live) return { ok: true, held: false, ms: 0, port: null, localPort: null, detail: "no monkey was holding it" }
  const started = Date.now()
  const port = info.port
  const localPort = info.localPort
  await stopMonkey(`lent the TV's UI automation slot out for ${reason}`)
  return {
    ok: true,
    held: true,
    ms: Date.now() - started,
    port,
    localPort,
    detail: `monkey (port ${port}) stopped, the slot is free`,
  }
}

/** Take the slot back: a fresh monkey process, on a port of its own choosing. */
export async function reclaimSlot({ serial, onStep } = {}) {
  note = onStep ?? note
  const target = serial ?? info.serial
  const started = Date.now()
  const res = await ensureMonkey({ serial: target, force: true, onStep })
  return { ...res, ms: Date.now() - started }
}

/**
 * Kill the monkey JVMs on the TV that this session is NOT driving.
 *
 * They are the second way the TV's one UiAutomation slot gets taken, and the one the
 * handoff cannot see, because `info.state` says "off" or "failed" while the slot is in
 * fact theirs. Measured on the TCL: with the app stopped and one leaked JVM resident,
 * `uiautomator dump` answered rc=137 — the mirror had nothing to hand back from, and
 * retried against a wall. The leak itself is ordinary: a start attempt that never
 * dialled leaves its JVM behind (a killed adb shell does not end monkey — measured),
 * and so does a session that was SIGKILLed mid-flight.
 */
export async function clearStrayMonkeys(serial) {
  const target = serial ?? info.serial
  if (!target) return { ok: false, killed: 0, pids: [], detail: "no device to look for monkey JVMs on" }
  const pids = (await monkeyPids(target)).filter((pid) => pid !== live?.pid)
  for (const pid of pids) await killDevicePid({ serial: target, pid })
  return {
    ok: true,
    killed: pids.length,
    pids,
    detail: pids.length
      ? `killed ${pids.length} monkey JVM(s) this session was not driving (pid ${pids.join(", ")})`
      : "no monkey JVM is running on the TV",
  }
}

/** Deliberate shutdown: `done` is answered and ends the process by itself. */
export async function stopMonkey(reason = "stopped") {
  const dead = live
  live = null
  if (!dead) {
    info = { ...info, state: "off", detail: reason }
    return { ok: true, ...monkeyInfo() }
  }
  const bye = dead.channel.send("done")
  await Promise.race([bye, sleep(MONKEY.quitWaitMs)])
  try {
    dead.socket.destroy()
  } catch {
    // already gone
  }
  if (dead.child.exitCode === null) dead.child.kill("SIGTERM")
  await killDevicePid(dead)
  await removeForward(dead.bin, dead.serial, dead.localPort)
  info = { ...info, state: "off", port: dead.devicePort, localPort: dead.localPort, detail: reason }
  return { ok: true, ...monkeyInfo() }
}

/**
 * The same teardown for a process that is on its way out: no promises to await,
 * and an orphaned monkey JVM has to be ruled out (a resident one on this 2 GB TV
 * was seen making `uiautomator dump` fail with rc=137).
 */
export function stopMonkeySync(reason = "exit") {
  const dead = live
  live = null
  if (!dead) return { ok: true }
  try {
    dead.socket.write("done\n")
    dead.socket.end()
  } catch {
    // the socket is already gone; the kill and the forward removal still run
  }
  if (dead.child.exitCode === null) dead.child.kill("SIGTERM")
  try {
    if (dead.pid) {
      spawnSync(dead.bin, ["-s", dead.serial, "shell", `if [ -d /proc/${dead.pid} ]; then kill -9 ${dead.pid}; fi; true`], {
        timeout: 4000,
        stdio: "ignore",
      })
    }
    spawnSync(dead.bin, ["-s", dead.serial, "forward", "--remove", `tcp:${dead.localPort}`], {
      timeout: 4000,
      stdio: "ignore",
    })
  } catch {
    // a leaked forward is recoverable with `adb forward --remove`; never fail exit
  }
  info = { ...info, state: "off", port: dead.devicePort, localPort: dead.localPort, detail: reason }
  return { ok: true }
}
