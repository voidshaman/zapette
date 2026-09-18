// The companion's lifecycle, from the client side: probe, start on demand, and
// stay on adb when it is not there.
//
// The TV is off most of the time and the companion service is deliberately NOT
// kept running between uses, so nothing here may assume it is alive. What a
// probe has to answer, in this order:
//
//   1. does the socket answer?                → state "alive"
//   2. if not, is the TV reachable at all?    → no: "asleep", and the caller
//      offers the wake-on-LAN path (src/power.mjs, src/wol.mjs) instead of
//      retrying a socket that cannot possibly come back on its own
//   3. is the package installed?               → no: "missing", said out loud,
//      never installed without being asked
//   4. installed but silent → start the service over adb and retry briefly
//                                              → "started" or "failed"
//
// ROUTE (this module owns both halves of it):
//
//   The companion binds 127.0.0.1 only, so there is no LAN route to it any more.
//   Every connection here goes through `adb forward tcp:0 tcp:7900`, which adb
//   binds to 127.0.0.1 on THIS machine — the forward is created once per device,
//   reused for every verb, and removed on teardown (and on a device switch). Measured
//   cost of the detour against the old direct LAN route: see companion/MEASUREMENTS.txt.
//
// AUTH (the part that makes reaching the loopback useless without the secret):
//
//   The first line the companion sends is a fresh 16-byte nonce; this client answers
//   `AUTH <hmac-sha256(secret, nonceHex)>` and only then sends a verb. The secret is
//   provisioned over adb (`--es companion_secret <hex>`, see provisionCompanionSecret)
//   and stored here at <config>/companion-<device>.key with mode 0600; it is never
//   printed, never logged, and never travels over the socket. A companion that has no
//   secret answers `no_secret` and closes: that is the migration path, not an error,
//   and `callCompanion` provisions and retries once when it sees it.
//
// The adb path in src/app.mjs is untouched by all of this: a companion that is absent,
// stopped, unpaired or that refuses our key leaves the app exactly as it was.
import * as crypto from "node:crypto"
import * as fs from "node:fs"
import * as net from "node:net"
import * as os from "node:os"
import { existsSync } from "node:fs"
import { spawnSync } from "node:child_process"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"
import { adb, adbBinary, connectDevice, packagePath, probePort } from "./adb.mjs"
import { deviceState } from "./power.mjs"

export const COMPANION = {
  pkg: "com.zapette.companion",
  service: "com.zapette.companion/.CompanionService",
  port: 7900,
  // The device side of `adb -s <serial> forward tcp:X tcp:7900`: the companion only
  // ever listens on the TV's own loopback, so adb is the only way in.
  adbPort: 5555,
  apk: "dist/zapette-companion.apk",
  secretExtra: "companion_secret",
  forgetExtra: "companion_forget_secret",
  keyPrefix: "companion-",
}

// The IME half of the companion: the service `commit` and `read` go through. The
// framework only hands an InputMethodService an InputConnection while it is the
// *selected* one, so this has to be the TV's current input method for text to
// land. Since t_14c284f4 the companion selects it ITSELF (`ime on`) by writing the
// same secure setting adb's `ime set` writes — the typing path carries no adb call.
export const COMPANION_IME = "com.zapette.companion/.CompanionIme"

// The one adb command that unlocks in-process selection, run once per install:
// WRITE_SECURE_SETTINGS is a privileged permission, and `pm grant` is the only way
// an ordinary app gets it. Without it `ime on` answers
// `{"ok":false,"error":"no_write_secure_settings"}` and the caller stays on adb.
export const COMPANION_IME_GRANT = `pm grant ${COMPANION.pkg} android.permission.WRITE_SECURE_SETTINGS`

// A loopback socket through an adb forward answers in milliseconds, so a short
// timeout is enough to tell "nothing is listening" from "the host is not answering".
export const PROBE_TIMEOUT_MS = 700
// `commit` and `read` run on the IME's main thread and the service's own latch is
// 3 s, so the wait is per-verb rather than the probe's 700 ms: a commit is a
// request the device is already committed to answering, and cutting it off at
// 700 ms would report a live companion as dead.
export const VERB_TIMEOUT_MS = 2500
// Post-start retries: the service is started by `am`, so the listener comes up
// with the process, not with the command's return.
export const START_TRIES = 4
export const START_GAP_MS = 700
// The secret is 32 random bytes; the companion refuses anything under 16.
export const KEY_BYTES = 32

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

/** Absolute path of the companion APK on this machine, and whether it is there. */
export function companionApk() {
  const path = join(dirname(fileURLToPath(import.meta.url)), "..", COMPANION.apk)
  return { path, present: existsSync(path) }
}

// ---------------------------------------------------------------- the secret

/**
 * Where the per-device key lives: `~/.config/zapette/companion-<device>.key`
 * (XDG_CONFIG_HOME honoured, ZAPETTE_CONFIG_DIR overrides it — the tests use
 * that to keep a real key file out of the way).
 */
export function companionConfigDir() {
  const override = process.env.ZAPETTE_CONFIG_DIR
  if (override) return override
  const base = process.env.XDG_CONFIG_HOME || join(os.homedir(), ".config")
  return join(base, "zapette")
}

/** A file-safe device key: the adb serial, with the `:` of `ip:5555` made safe. */
export function deviceKey(device) {
  const serial = typeof device === "string" ? device : device?.serial
  if (!serial) throw new Error("the companion key is per device: no serial to key it on")
  return String(serial).replace(/[^A-Za-z0-9._-]/g, "-")
}

export function companionKeyPath(device) {
  return join(companionConfigDir(), `${COMPANION.keyPrefix}${deviceKey(device)}.key`)
}

/** The stored key, or `{ present: false }`. Never returns it to a log by itself. */
export function readCompanionKey(device) {
  const path = companionKeyPath(device)
  try {
    const hex = fs.readFileSync(path, "utf8").trim()
    if (!/^[0-9a-f]{32,}$/i.test(hex)) return { present: false, path, error: "the key file is not hex" }
    return { present: true, path, hex: hex.toLowerCase() }
  } catch (e) {
    return { present: false, path, error: e.code === "ENOENT" ? "no key file yet" : String(e.code ?? e.message) }
  }
}

/**
 * Write a NEW key for a device: 32 random bytes, hex, mode 0600 (the file is created
 * with that mode, not chmod-ed afterwards, so it is never readable by anyone else even
 * for a moment). Overwrites: this is how a re-pair starts over.
 */
export function createCompanionKey(device) {
  const path = companionKeyPath(device)
  fs.mkdirSync(dirname(path), { recursive: true, mode: 0o700 })
  const hex = crypto.randomBytes(KEY_BYTES).toString("hex")
  fs.writeFileSync(path, `${hex}\n`, { mode: 0o600 })
  fs.chmodSync(path, 0o600) // an existing file keeps its old mode through writeFileSync
  return { path, hex, created: true }
}

/** The key for a device, generating one the first time it is needed. */
export function ensureCompanionKey(device) {
  const found = readCompanionKey(device)
  if (found.present) return { ...found, created: false }
  return createCompanionKey(device)
}

/** The key file's mode as an octal string ("600"), or null when it is not there. */
export function companionKeyMode(device) {
  try {
    return (fs.statSync(companionKeyPath(device)).mode & 0o777).toString(8)
  } catch {
    return null
  }
}

/**
 * HMAC-SHA256(secret, nonce), lowercase hex — the one definition both sides share
 * (companion/…/CompanionSecret.java#hmacHex): KEY is the secret's decoded bytes,
 * MESSAGE is the nonce exactly as the companion sent it, i.e. its hex characters.
 */
export function computeAuthHmac(nonceHex, keyHex) {
  return crypto.createHmac("sha256", Buffer.from(keyHex, "hex")).update(String(nonceHex), "utf8").digest("hex")
}

/** The one line the handshake expects, without its newline. */
export function authAnswer(keyHex, nonceHex) {
  return `AUTH ${computeAuthHmac(nonceHex, keyHex)}`
}

/**
 * Anything that looks like a key or an HMAC, gone. Applied to every diagnostic this
 * module produces, so a stray hex run in an `am` echo or an error message cannot
 * become a leaked secret.
 */
export function scrub(text) {
  return String(text ?? "").replace(/[0-9a-f]{32,}/gi, "<redacted-hex>")
}

/** Debug output: off by default, scrubbed always, and never fed a key deliberately. */
export function companionLog(line) {
  if (!process.env.TV_REMOTE_COMPANION_DEBUG) return
  console.error(`[companion] ${scrub(line)}`)
}

// ---------------------------------------------------------------- the forward

// serial → { localPort, bin }. A forward is created once and reused: `adb forward
// tcp:0` asks adb for a free LOCAL port, so two sessions on this machine cannot
// collide, and `--remove` takes back exactly that one.
const forwards = new Map()

/**
 * The loopback route to the companion: `adb -s <serial> forward tcp:0 tcp:7900`.
 * Reused for every verb; `force` replaces a forward that has gone stale (a device
 * that reconnected has lost it — adb drops forwards with the transport).
 */
export async function ensureCompanionForward({ serial, force = false } = {}) {
  const key = String(serial)
  if (!force && forwards.has(key)) return { ok: true, serial: key, localPort: forwards.get(key).localPort, reused: true }

  if (forwards.has(key)) await removeCompanionForward(key)
  const bin = await adbBinary()
  const auto = await adb(["-s", key, "forward", "tcp:0", `tcp:${COMPANION.port}`], { timeout: 8000 })
  const assigned = Number((String(auto.out).match(/\d+/) ?? [])[0])
  if (auto.ok && Number.isInteger(assigned) && assigned > 0) {
    forwards.set(key, { localPort: assigned, bin })
    return { ok: true, serial: key, localPort: assigned, reused: false }
  }
  // Some adb builds do not answer `tcp:0`; the same-numbered local port is the fallback.
  const direct = await adb(["-s", key, "forward", `tcp:${COMPANION.port}`, `tcp:${COMPANION.port}`], { timeout: 8000 })
  const bad = /cannot|fail|in use|error/i.test(`${direct.out} ${direct.err}`)
  if (direct.ok && !bad) {
    forwards.set(key, { localPort: COMPANION.port, bin })
    return { ok: true, serial: key, localPort: COMPANION.port, reused: false, fallback: true }
  }
  return {
    ok: false,
    serial: key,
    error: scrub(`${auto.err || auto.out || "adb forward failed"}`).slice(0, 160),
  }
}

export async function removeCompanionForward(serial) {
  const key = String(serial)
  const held = forwards.get(key)
  if (!held) return { ok: true, removed: false }
  forwards.delete(key)
  const bin = held.bin ?? (await adbBinary())
  const r = await adb(["-s", key, "forward", "--remove", `tcp:${held.localPort}`], { timeout: 8000 })
  return { ok: r.ok, removed: true, localPort: held.localPort }
}

/**
 * The same teardown for a process that is on its way out: `process.on("exit")` cannot
 * await, so this shells out synchronously. A leaked forward is recoverable with
 * `adb forward --remove`, so nothing here is allowed to throw.
 */
export function removeCompanionForwardsSync(reason = "exit") {
  const held = [...forwards.entries()]
  forwards.clear()
  if (!held.length) return { ok: true, removed: 0 }
  try {
    for (const [serial, fwd] of held) {
      spawnSync(fwd.bin ?? "adb", ["-s", serial, "forward", "--remove", `tcp:${fwd.localPort}`], {
        timeout: 4000,
        stdio: "ignore",
      })
    }
  } catch {
    // never fail exit
  }
  companionLog(`removed ${held.length} forward(s) on ${reason}`)
  return { ok: true, removed: held.length }
}

/** Which forwards are held right now (diagnostics and tests). */
export function companionForwards() {
  return [...forwards.entries()].map(([serial, fwd]) => ({ serial, localPort: fwd.localPort }))
}

// ---------------------------------------------------------------- the wire

/** A device as this module wants it: the adb serial it is forwarded on, plus its LAN address. */
export function companionDevice(host, serial = null) {
  return { host, serial: serial ?? `${host}:${COMPANION.adbPort}` }
}

function normalizeDevice(device) {
  if (device && typeof device === "object") return companionDevice(device.host ?? String(device.serial ?? "").split(":")[0], device.serial)
  const host = String(device ?? "")
  return companionDevice(host.split(":")[0], host.includes(":") ? host : null)
}

/** Map a connect failure onto what it actually tells us about the TV. */
function classify(error) {
  switch (error?.code) {
    case "ECONNREFUSED":
      // Something answered with a reset: the forward is up and nothing is listening
      // behind it — the companion service is not running (it may also mean the cached
      // forward is stale, which the caller retries once as a fresh forward).
      return { reason: "refused", error: `nothing is listening on the companion's loopback port ${COMPANION.port}` }
    case "EHOSTUNREACH":
    case "ENETUNREACH":
    case "EHOSTDOWN":
    case "ENOTFOUND":
    case "EADDRNOTAVAIL":
      return { reason: "unreachable", error: `${error.code} — the host is not answering at all` }
    case "ETIMEDOUT":
      return { reason: "no-answer", error: "the connection timed out" }
    default:
      return { reason: "error", error: error?.code ?? error?.message ?? "socket error" }
  }
}

/**
 * One authenticated command: dial the forward, answer the nonce, then send the
 * command on the same connection. One line in, one JSON line out — the companion's
 * own framing (see companion/src/com/zapette/companion/CompanionServer.java).
 *
 * The handshake is not optional and not skippable: the verb line is only written
 * after `AUTH <hmac>` has gone out, and the companion runs no verb until it has
 * checked that HMAC. A companion with no secret answers `no_secret` and closes; a
 * wrong answer closes the socket silently (reason "auth-failed"); a key that does not
 * match what the TV holds reads the same way — the two are told apart by the message,
 * not by pretending to know which one it was.
 *
 * Never throws: a failed call is an answer too, and the caller decides what it means.
 */
export function sendCommand(route, command, { timeout = PROBE_TIMEOUT_MS } = {}) {
  return new Promise((resolve) => {
    const started = Date.now()
    const socket = new net.Socket()
    let buffer = ""
    let settled = false
    let authed = false
    // Which half of the exchange the socket ended in: a close before the nonce arrived
    // says nothing about our key, a close after we answered it is the companion hanging
    // up on the AUTH line — which is what a wrong secret looks like, since a successful
    // handshake has no ack of its own.
    let stage = "handshake"

    const finish = (result) => {
      if (settled) return
      settled = true
      socket.destroy()
      resolve({
        ...result,
        host: route.host ?? route.serial,
        port: COMPANION.port,
        localPort: route.localPort ?? null,
        ms: Date.now() - started,
      })
    }

    socket.setTimeout(timeout)
    socket.once("timeout", () => finish({ ok: false, reason: "no-answer", error: `no answer within ${timeout} ms` }))
    socket.once("error", (error) => finish({ ok: false, ...classify(error) }))
    socket.once("close", () => finish({
      ok: false,
      reason: stage === "auth" ? "auth-failed" : "closed",
      error: stage === "auth"
        ? "the companion closed the connection after the AUTH line: the key does not match"
        : "the companion closed the connection during the handshake",
    }))

    socket.on("data", (chunk) => {
      buffer += chunk.toString("utf8")
      let end
      while ((end = buffer.indexOf("\n")) >= 0) {
        const line = buffer.slice(0, end).trim()
        buffer = buffer.slice(end + 1)
        if (!line) continue
        let reply
        try {
          reply = JSON.parse(line)
        } catch {
          return finish({ ok: false, reason: "bad-reply", line, error: `not JSON: ${scrub(line).slice(0, 60)}` })
        }
        if (!authed) {
          if (!route.key) {
            return finish({ ok: false, reason: "no-key", error: "no key was loaded for this device" })
          }
          if (reply.error === "no_secret") {
            return finish({
              ok: false,
              reason: "no-secret",
              reply,
              error: "the companion has no secret provisioned (fail closed: it accepts nobody)",
            })
          }
          if (reply.auth !== "nonce" || typeof reply.nonce !== "string") {
            return finish({
              ok: false,
              reason: "not-companion",
              reply,
              error: `the first line was not a companion nonce: ${scrub(line).slice(0, 60)}`,
            })
          }
          authed = true
          stage = "auth"
          socket.write(`${authAnswer(route.key, reply.nonce)}\n${command}\n`)
          continue
        }
        return finish({ ok: true, line, reply, authed: true })
      }
    })

    socket.connect(route.localPort, "127.0.0.1")
  })
}

/**
 * A full companion call for one verb: the route (forward + key), the command, and the
 * ONE migration step this design has — a companion that answers `no_secret` gets the
 * key that is already on this machine pushed to it over adb, and the verb is retried
 * once. That is the normal first-run path for an APK installed before this layer
 * existed, not an error path.
 *
 * `provision: false` turns the migration off (used by the tests and by anything that
 * must look without touching the TV).
 */
export async function callCompanion(device, command, { timeout = PROBE_TIMEOUT_MS, provision = true, onStep } = {}) {
  const target = normalizeDevice(device)
  const forward = await ensureCompanionForward({ serial: target.serial })
  if (!forward.ok) {
    return { ok: false, reason: "no-forward", host: target.host, serial: target.serial, error: forward.error, ms: 0 }
  }
  const key = ensureCompanionKey(target)
  const route = { ...target, localPort: forward.localPort, key: key.hex }

  let result = await sendCommand(route, command, { timeout })

  // A refused connection through a forward we are holding is usually a forward whose
  // device has reconnected: drop it so the next attempt builds a new one, and use the
  // one retry here rather than making the caller wait for it.
  if (!result.ok && result.reason === "refused" && forward.reused) {
    await ensureCompanionForward({ serial: target.serial, force: true })
    const fresh = await ensureCompanionForward({ serial: target.serial })
    if (fresh.ok) result = await sendCommand({ ...route, localPort: fresh.localPort }, command, { timeout })
  }

  if (!result.ok && result.reason === "no-secret" && provision) {
    onStep?.(`the TV holds no secret — provisioning this device's key over adb`)
    const pushed = await provisionCompanionSecret(target.serial, key.hex, { onStep })
    if (pushed.ok) {
      const again = await sendCommand(route, command, { timeout })
      return {
        ...again,
        provisioned: true,
        keyPath: key.path,
        keyCreated: key.created,
        serviceLine: pushed.line,
      }
    }
    return { ...result, provisioned: false, error: `${result.error}; pushing a secret over adb failed: ${pushed.line}` }
  }

  return { ...result, keyPath: key.path, keyCreated: key.created }
}

/** The probe: the companion answers its own `ping` verb — and only after the HMAC. */
export function pingCompanion(device, options) {
  return callCompanion(device, "ping", { timeout: PROBE_TIMEOUT_MS, ...options })
}

/**
 * `commit <text>`: hand the focused field a finished string through the
 * companion IME's InputConnection.
 *
 * The protocol is one command per *line* and the verb takes the raw remainder of
 * that line, so a newline inside the text would be read as the next command. The
 * app's box is single-line; anything else is folded to a space and reported, not
 * silently dropped.
 */
export function commitCompanion(device, text, options = {}) {
  const oneLine = String(text).replace(/[\r\n]+/g, " ")
  return callCompanion(device, `commit ${oneLine}`, { timeout: VERB_TIMEOUT_MS, ...options }).then((r) => ({
    ...r,
    folded: oneLine.length !== String(text).length,
  }))
}

/**
 * `read [mode] [before] [after]`: the focused field's text, "cursor" mode by
 * default (getSurroundingText does not exist on this API-30 TV — see
 * companion/README.md). Used to check a commit landed: the reply carries `text`,
 * `len` and a caret (`selectionStart`/`selectionEnd`), or `ok:false` with a
 * machine-readable `error` (`ime_not_selected`, `no_input_connection`, ...).
 */
export function readCompanion(device, { mode = "cursor", before = 5000, after = 5000, ...options } = {}) {
  return callCompanion(device, `read ${mode} ${before} ${after}`, { timeout: VERB_TIMEOUT_MS, ...options })
}

/**
 * `ime on | off | state`: the companion selecting the TV's input method itself.
 *
 * `on` records the TV's own IME, appends the companion's id to enabled_input_methods
 * and writes default_input_method — measured 3-18 ms on the device, against 0.15 s for
 * the same switch over adb. `off` gives the recorded IME back; never guesses one.
 * `state` reads only (current, previous, enabled, selected, running, granted).
 *
 * The reply is the same flat JSON as everything else, and the failure the caller has
 * to be able to act on is `ok:false` / `error:"no_write_secure_settings"` (with `need`
 * and `grant` in it) — that means the one-off grant is missing and the adb path is
 * the answer, not a retry.
 */
export function imeVerb(device, verb, options = {}) {
  return callCompanion(device, `ime ${verb}`, { timeout: VERB_TIMEOUT_MS, ...options })
}

export const imeOn = (device, options) => imeVerb(device, "on", options)
export const imeOff = (device, options) => imeVerb(device, "off", options)
export const imeState = (device, options) => imeVerb(device, "state", options)

// ---------------------------------------------------------------- provisioning

/**
 * Push the secret to the TV over adb: `am start-foreground-service --es companion_secret
 * <hex>`. This is the ONLY way a secret reaches the device — adb here is the trust root
 * (RSA key plus the TV's on-screen confirmation), and the value never crosses the socket.
 *
 * The returned `line` is the `am` output with anything key-shaped scrubbed out: a
 * diagnostic must never be the thing that leaks the secret.
 */
export async function provisionCompanionSecret(serial, keyHex, { onStep } = {}) {
  const r = await adb(
    ["-s", serial, "shell", "am", "start-foreground-service", "-n", COMPANION.service, "--es", COMPANION.secretExtra, keyHex],
    { timeout: 15000 },
  )
  const text = scrub(`${r.out} ${r.err}`.trim().replace(/\s+/g, " "))
  const failed = /error|exception|denial|does not exist|unable to|not found|unknown/i.test(text)
  onStep?.(failed ? `pairing over adb: ${text.slice(0, 120)}` : "pushed this device's key over adb")
  return { ok: r.ok && !failed, line: text.split("Intent")[0]?.trim().slice(0, 120) || text.slice(0, 120) }
}

/** Take the secret back off the TV: it then refuses every connection, ours included. */
export async function forgetCompanionSecret(serial, { onStep } = {}) {
  const r = await adb(
    ["-s", serial, "shell", "am", "start-foreground-service", "-n", COMPANION.service, "--ez", COMPANION.forgetExtra, "true"],
    { timeout: 15000 },
  )
  const text = scrub(`${r.out} ${r.err}`.trim().replace(/\s+/g, " "))
  const failed = /error|exception|denial|does not exist|unable to|not found|unknown/i.test(text)
  onStep?.(failed ? `un-pairing failed: ${text.slice(0, 120)}` : "cleared the secret on the TV")
  return { ok: r.ok && !failed, line: text.split("Intent")[0]?.trim().slice(0, 120) || text.slice(0, 120) }
}

/**
 * Pairing, end to end: adopt the key already on this machine or generate one, push it
 * over adb, and — the only thing that counts as done — prove the TV accepts it with an
 * authenticated `ping`. `rotate: true` starts over from a fresh key.
 */
export async function pairCompanion(device, { rotate = false, onStep } = {}) {
  const target = normalizeDevice(device)
  const key = rotate ? createCompanionKey(target) : ensureCompanionKey(target)
  const pushed = await provisionCompanionSecret(target.serial, key.hex, { onStep })
  if (!pushed.ok) return { ok: false, stage: "pairing", keyPath: key.path, error: pushed.line }
  await sleep(120)
  const ping = await callCompanion(device, "ping", { provision: false, onStep })
  if (ping.ok && ping.reply?.ok) {
    return { ok: true, stage: "verified", keyPath: key.path, keyCreated: key.created, version: ping.reply.version, ms: ping.ms }
  }
  return {
    ok: false,
    stage: "verifying",
    keyPath: key.path,
    error: `${ping.reason ?? "error"}: ${scrub(ping.error ?? "the companion did not answer a ping")}`,
  }
}

// ---------------------------------------------------------------- lifecycle

/**
 * `am start-foreground-service -n com.zapette.companion/.CompanionService`.
 *
 * The command's output is not the verdict — `am` reports what it dispatched, not
 * what came up — so only an explicit error is believed here, and the socket
 * retry afterwards is what decides.
 */
export async function startCompanionService(serial) {
  const r = await adb(["-s", serial, "shell", "am", "start-foreground-service", "-n", COMPANION.service])
  const text = `${r.out} ${r.err}`.trim().replace(/\s+/g, " ")
  const failed = /error|exception|denial|does not exist|unable to|not found|unknown/i.test(text)
  return { ok: !failed, line: text.split("\n")[0]?.slice(0, 120) ?? "", raw: text }
}

/**
 * `state` is "alive" when the service was already up, "started" when this probe
 * is the one that brought it up — the UI says different things for the two, and
 * only the second means the TV was changed by us.
 */
function alive(result, host, how, state = "alive") {
  return {
    state,
    host,
    serial: result.serial ?? null,
    how,
    ms: result.ms,
    localPort: result.localPort ?? null,
    version: result.reply?.version ?? null,
    pid: result.reply?.pid ?? null,
    paired: true,
    provisioned: result.provisioned === true,
    keyPath: result.keyPath ?? null,
    reply: result.reply ?? null,
  }
}

/**
 * The whole lifecycle in one call. Returns `{ state, host, detail, ... }` with
 * `state` one of:
 *
 *   alive     — the socket answered (we did not necessarily start it)
 *   started   — it was installed but silent; started over adb, and it answered
 *   missing   — the package is not on the TV: say so, never auto-install
 *   asleep    — the TV is not reachable at all: the caller offers the wake
 *   failed    — installed and started, and still nothing on the port
 *   unpaired  — it answered, but only to refuse: it holds no secret (or not ours)
 *
 * Every probe reads; the only things it writes are the adb forward, the one-off
 * provisioning of a key when the TV has none, and the service start, and only after
 * the package check has passed.
 *
 * `provision: false` turns off the one write that would push a key over adb (`no_secret`
 * is then reported, not repaired). It is for callers that ask the TV whether it is set
 * up BEFORE the user has agreed to anything: the service start stays, because a
 * companion that is installed but idle is its normal state and must not read as
 * "not set up" — see src/app.mjs#firstConnectCheck.
 */
export async function probeCompanion({ serial, ip, onStep, provision = true } = {}) {
  const host = ip ?? String(serial ?? "").split(":")[0]
  const note = (line) => onStep?.(line)
  if (!host) return { state: "failed", host: null, detail: "no device address to probe" }
  const device = companionDevice(host, serial)

  const first = await pingCompanion(device, { onStep: note, provision })
  if (first.ok && first.reply?.ok) return alive(first, host, "answered on the first probe")
  if (first.ok) {
    // Something is on the loopback port and speaking, but it is not our protocol.
    return {
      state: "failed",
      host,
      detail: `something on ${COMPANION.port} is not the companion: ${scrub(first.line).slice(0, 60)}`,
    }
  }
  if (first.reason === "auth-failed") {
    return {
      state: "unpaired",
      host,
      serial,
      detail:
        `the companion refused this machine's key (${first.keyPath}) — it may be paired to another key file; ` +
        "re-pair it to use the companion route (typing stays on adb)",
    }
  }

  // Nothing answered. Whether that is fixable depends on whether the TV is up at
  // all: waking it is a different action from starting a service, and retrying
  // the socket on a TV that has left the network is the spinning this avoids.
  let reach = await deviceState(serial)
  if (reach !== "device") {
    note(`adb lists ${serial} as ${reach ?? "absent"}`)
    if (await probePort(host, COMPANION.adbPort, 1500)) {
      await connectDevice(serial)
      await sleep(300)
      reach = await deviceState(serial)
    }
  }
  if (reach !== "device") {
    return {
      state: "asleep",
      host,
      reason: first.reason,
      detail: `the companion did not answer (${scrub(first.error)}) and adb cannot reach ${host}:${COMPANION.adbPort} either`,
    }
  }

  const paths = await packagePath(serial, COMPANION.pkg)
  if (!paths.length) {
    const apk = companionApk()
    return {
      state: "missing",
      host,
      apk: apk.path,
      apkPresent: apk.present,
      detail: "the companion package is not installed on the TV",
    }
  }

  const started = await startCompanionService(serial)
  note(started.ok ? "started the companion service over adb" : `am said: ${started.line}`)

  for (let i = 1; i <= START_TRIES; i++) {
    const again = await pingCompanion(device, { onStep: note, provision })
    if (again.ok && again.reply?.ok) {
      return alive(again, host, `up after starting the service (probe ${i})`, "started")
    }
    if (again.reason === "no-secret") {
      // Fail-closed and paired-by-nobody: the service is up, so say what it needs
      // instead of retrying a socket that will keep answering the same thing.
      return {
        state: "unpaired",
        host,
        serial,
        localPort: again.localPort ?? null,
        detail: scrub(again.error),
      }
    }
    if (i < START_TRIES) await sleep(START_GAP_MS)
  }

  return {
    state: "failed",
    host,
    detail: `installed (${paths[0]}) and started, but nothing answered on the companion's loopback port after ${START_TRIES} probes`,
  }
}
