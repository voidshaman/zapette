// Thin wrapper around the adb CLI. Every call is an argv array (no local shell),
// so nothing here can be mangled by the local shell.
//
// adb itself is resolved in this order:
//   1. $ADB_BIN, if set
//   2. the copy embedded in a compiled executable — extracted to a cache dir first,
//      because a Bun embedded asset lives on a virtual $bunfs path that cannot be exec'd
//   3. the copy shipped in ./assets (source runs)
//   4. whatever `adb` is on PATH
import { execFile } from "node:child_process"
import { chmodSync, existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs"
import * as net from "node:net"
import { homedir, networkInterfaces } from "node:os"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"
import { promisify } from "node:util"

const execFileP = promisify(execFile)

let resolvedAdb = null

function cacheDir() {
  const base =
    process.platform === "darwin"
      ? join(homedir(), "Library", "Caches")
      : process.env.XDG_CACHE_HOME || join(homedir(), ".cache")
  return join(base, "tv-remote-tui")
}

/** Write bundled bytes somewhere exec'able, reusing an identical existing copy. */
function materialize(bytes, tag) {
  const target = join(cacheDir(), `adb-${tag}`)
  try {
    if (existsSync(target) && statSync(target).size === bytes.length) {
      chmodSync(target, 0o755)
      return target
    }
    mkdirSync(cacheDir(), { recursive: true })
    writeFileSync(target, bytes, { mode: 0o755 })
    chmodSync(target, 0o755)
    return target
  } catch {
    return null
  }
}

export async function adbBinary() {
  if (resolvedAdb) return resolvedAdb

  if (process.env.ADB_BIN) {
    resolvedAdb = process.env.ADB_BIN
    return resolvedAdb
  }

  // 1) asset embedded at compile time (Bun only — Node has no "file" import type).
  //    A "slim" build defines EMBED_ADB=0 and falls through to a system adb instead.
  if (typeof globalThis.Bun !== "undefined" && process.env.EMBED_ADB !== "0") {
    try {
      const asset = await import("../assets/adb", { with: { type: "file" } })
      const path = materialize(readFileSync(asset.default), "bundled")
      if (path) {
        resolvedAdb = path
        return resolvedAdb
      }
    } catch {
      // fall through to the source copy
    }
  }

  // 2) the copy that ships with the source tree
  try {
    const local = join(dirname(fileURLToPath(import.meta.url)), "..", "assets", "adb")
    if (existsSync(local)) {
      resolvedAdb = local
      return resolvedAdb
    }
  } catch {
    // fall through to PATH
  }

  // 3) an adb the user installed
  resolvedAdb = "adb"
  return resolvedAdb
}

export async function adb(args, { timeout = 20000 } = {}) {
  const bin = await adbBinary()
  try {
    const { stdout, stderr } = await execFileP(bin, args, {
      timeout,
      maxBuffer: 8 << 20,
      encoding: "utf8",
    })
    return { ok: true, out: (stdout ?? "").trim(), err: (stderr ?? "").trim() }
  } catch (e) {
    return {
      ok: false,
      out: (e.stdout ?? "").trim(),
      err: `${e.stderr ?? ""} ${e.message ?? ""}`.trim(),
    }
  }
}

// Android keycodes we care about.
export const KEY = {
  HOME: 3,
  BACK: 4,
  UP: 19,
  DOWN: 20,
  LEFT: 21,
  RIGHT: 22,
  OK: 23,
  VOL_UP: 24,
  VOL_DOWN: 25,
  POWER: 26,
  DEL: 67,
  ENTER: 66,
  MENU: 82,
  PLAY_PAUSE: 85,
}

export const KEY_LABEL = {
  [KEY.UP]: "DPAD_UP",
  [KEY.DOWN]: "DPAD_DOWN",
  [KEY.LEFT]: "DPAD_LEFT",
  [KEY.RIGHT]: "DPAD_RIGHT",
  [KEY.OK]: "DPAD_CENTER",
  [KEY.VOL_UP]: "VOLUME_UP",
  [KEY.VOL_DOWN]: "VOLUME_DOWN",
  [KEY.BACK]: "BACK",
  [KEY.HOME]: "HOME",
  [KEY.DEL]: "DEL",
  [KEY.ENTER]: "ENTER",
}

/** `adb devices -l` → [{ serial, state, model, ... }] */
export async function listDevices() {
  const r = await adb(["devices", "-l"])
  const devices = []
  // adb prints the daemon banner on stdout *and* we trim it; only parse the table.
  for (const rawLine of r.out.split("\n").slice(1)) {
    const line = rawLine.trim()
    if (!line || line.startsWith("*")) continue
    const parts = line.split(/\s+/)
    const serial = parts.shift()
    const state = parts.shift() ?? "unknown"
    const meta = {}
    for (const p of parts) {
      const i = p.indexOf(":")
      if (i > 0) meta[p.slice(0, i)] = p.slice(i + 1)
    }
    if (serial) {
      devices.push({ serial, state, model: meta.model ?? "", product: meta.product ?? "", device: meta.device ?? "" })
    }
  }
  return { devices, error: r.ok || r.out ? null : r.err || "adb not found" }
}

export async function connectDevice(address) {
  return adb(["connect", address], { timeout: 15000 })
}

/**
 * The adb *server* is a separate daemon and can wedge: it then reports
 * "No route to host" for a TV that is plainly reachable. Killing and restarting
 * it is the only recovery.
 */
export async function restartServer() {
  await adb(["kill-server"], { timeout: 10000 })
  return adb(["start-server"], { timeout: 20000 })
}

/** True for the failures a server restart actually cures. */
export function looksWedged(result) {
  const text = `${result?.out ?? ""} ${result?.err ?? ""}`
  return /no route to host|cannot connect to daemon|failed to connect|couldn't connect|daemon not running/i.test(text)
}

export function probePort(host, port, timeout) {
  return new Promise((resolve) => {
    const socket = new net.Socket()
    let settled = false
    const finish = (ok) => {
      if (settled) return
      settled = true
      socket.destroy()
      resolve(ok)
    }
    socket.setTimeout(timeout)
    socket.once("connect", () => finish(true))
    socket.once("timeout", () => finish(false))
    socket.once("error", () => finish(false))
    socket.connect(port, host)
  })
}

/**
 * `adb devices` only lists devices you already connected to, so finding a TV on
 * the LAN means probing the local /24 for the adb port.
 */
export async function scanLan({ port = 5555, timeout = 400, concurrency = 96, onHost } = {}) {
  const bases = new Set()
  for (const list of Object.values(networkInterfaces())) {
    for (const iface of list ?? []) {
      if (iface.family !== "IPv4" || iface.internal) continue
      const o = iface.address.split(".")
      bases.add(`${o[0]}.${o[1]}.${o[2]}`)
    }
  }
  const hosts = []
  for (const base of bases) for (let i = 1; i <= 254; i++) hosts.push(`${base}.${i}`)

  const found = []
  let cursor = 0
  const workers = Array.from({ length: Math.min(concurrency, hosts.length) }, async () => {
    while (cursor < hosts.length) {
      const host = hosts[cursor++]
      if (await probePort(host, port, timeout)) {
        found.push(host)
        onHost?.(found.length)
      }
    }
  })
  await Promise.all(workers)
  return { found: found.sort((a, b) => a.localeCompare(b, undefined, { numeric: true })), scanned: hosts.length }
}

export async function disconnectDevice(address) {
  return adb(["disconnect", address], { timeout: 15000 })
}

/** Run a raw command through the device's own shell (it parses the string). */
export async function shell(serial, command) {
  return adb(["-s", serial, "shell", command])
}

/** Send one (or more) keycodes to a device. */
export async function keyevent(serial, codes) {
  const list = Array.isArray(codes) ? codes : [codes]
  return adb(["-s", serial, "shell", "input", "keyevent", ...list.map(String)])
}

/**
 * `input text` funnels the string through the device's KeyCharacterMap:
 * a literal space must be spelled %s. The value is then wrapped in single
 * quotes because adb joins argv with spaces before the *device* shell sees it.
 */
export function encodeInputText(text) {
  return text.replace(/ /g, "%s")
}

function deviceShellQuote(s) {
  return `'${s.replace(/'/g, `'\\''`)}'`
}

export async function inputText(serial, text) {
  if (!text) return { ok: true, out: "", err: "" }
  return adb(["-s", serial, "shell", "input", "text", deviceShellQuote(encodeInputText(text))])
}

/** Read the current STREAM_MUSIC volume (0-100 scale on Android TV). */
export async function musicVolume(serial) {
  const r = await adb(["-s", serial, "shell", "dumpsys", "audio"])
  if (!r.ok) return { ok: false, err: r.err }
  const block = r.out.split("STREAM_MUSIC:")[1]
  if (!block) return { ok: false, err: "STREAM_MUSIC not found" }
  const segment = block.split("- STREAM_")[0]
  const vol = /streamVolume:(\d+)/.exec(segment)
  const max = /Max:\s*(\d+)/.exec(segment)
  return { ok: true, volume: vol ? Number(vol[1]) : null, max: max ? Number(max[1]) : null }
}
