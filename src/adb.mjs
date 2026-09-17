// Thin wrapper around the adb CLI. Every call is an argv array (no local shell),
// so nothing here can be mangled by the local shell.
//
// adb is resolved in this order, and every candidate is *run* before it is
// trusted — a macOS binary on Linux would otherwise fail later with something
// unhelpful like "spawn ENOEXEC":
//   1. $ADB_BIN, if set
//   2. the platform-tools archive embedded in a compiled executable, unpacked to
//      a cache dir first (a Bun embedded asset lives on a virtual $bunfs path
//      that cannot be exec'd, and Windows needs its two DLLs next to adb.exe)
//   3. platform-tools fetched into ./assets/platform-tools/<platform>-<arch>/
//   4. the single-file payload that ships in ./assets — macOS only, it is Mach-O
//   5. whatever `adb` (or `adb.exe`) is on PATH
import { execFile } from "node:child_process"
import { chmodSync, existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs"
import * as net from "node:net"
import { networkInterfaces } from "node:os"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"
import { promisify } from "node:util"
import { extractTarGz } from "./archive.mjs"
import { adbFiles, adbName, cacheDir, platformKey } from "./platform.mjs"

const execFileP = promisify(execFile)

let resolvedAdb = null
let adbWarning = null

/** Where an unpacked toolchain lives: <cache>/tv-remote-tui/platform-tools/<key>. */
export function toolsDir(key = platformKey()) {
  return join(cacheDir(), "tv-remote-tui", "platform-tools", key)
}

/** The message to show if the resolved adb had to be swapped or is missing. */
export function adbNote() {
  return adbWarning
}

/** Write bundled bytes somewhere exec'able, reusing an identical existing copy. */
function materialize(bytes, tag) {
  const dir = join(cacheDir(), "tv-remote-tui")
  const target = join(dir, `adb-${tag}`)
  try {
    if (existsSync(target) && statSync(target).size === bytes.length) {
      chmodSync(target, 0o755)
      return target
    }
    mkdirSync(dir, { recursive: true })
    writeFileSync(target, bytes, { mode: 0o755 })
    chmodSync(target, 0o755)
    return target
  } catch {
    return null
  }
}

/** Unpack an embedded platform-tools.tar.gz, once, and return its adb. */
function unpackEmbedded(bytes, key) {
  const platform = key.slice(0, key.lastIndexOf("-"))
  const dir = toolsDir(key)
  const bin = join(dir, adbName(platform))
  try {
    if (!existsSync(bin)) {
      mkdirSync(dir, { recursive: true })
      extractTarGz(bytes, dir)
    }
    for (const file of adbFiles(platform)) {
      const path = join(dir, file)
      if (existsSync(path)) chmodSync(path, 0o755)
    }
    return existsSync(bin) ? bin : null
  } catch {
    return null
  }
}

async function resolveAdb() {
  if (process.env.ADB_BIN) return process.env.ADB_BIN

  // 1) embedded at compile time (Bun only — Node has no "file" import type).
  //    A "slim" build defines EMBED_ADB=0 and falls through to a system adb.
  if (typeof globalThis.Bun !== "undefined" && process.env.EMBED_ADB !== "0") {
    try {
      const asset = await import("../assets/platform-tools.tar.gz", { with: { type: "file" } })
      const unpacked = unpackEmbedded(readFileSync(asset.default), platformKey())
      if (unpacked) return unpacked
    } catch {
      // no archive embedded — try the older single-file payload
    }
    try {
      const asset = await import("../assets/adb", { with: { type: "file" } })
      const path = materialize(readFileSync(asset.default), "bundled")
      if (path) return path
    } catch {
      // fall through
    }
  }

  const root = join(dirname(fileURLToPath(import.meta.url)), "..")

  // 2) platform-tools fetched for this platform, e.g. by `npm run fetch:adb`
  for (const key of [platformKey(), process.platform]) {
    const bin = join(root, "assets", "platform-tools", key, adbName())
    if (existsSync(bin)) return bin
  }

  // 3) the single-file payload in the repo: Mach-O, so only usable on macOS
  if (process.platform === "darwin") {
    const local = join(root, "assets", "adb")
    if (existsSync(local)) return local
  }

  // 4) an adb the user installed
  return adbName()
}

/** Does this binary actually execute on this machine? */
async function runs(bin) {
  try {
    await execFileP(bin, ["version"], { timeout: 15000, encoding: "utf8" })
    return true
  } catch {
    return false
  }
}

export async function adbBinary() {
  if (resolvedAdb) return resolvedAdb

  const candidate = await resolveAdb()
  if (await runs(candidate)) {
    resolvedAdb = candidate
    return resolvedAdb
  }

  const system = adbName()
  if (candidate !== system && (await runs(system))) {
    adbWarning = `${candidate} does not run on this machine — using the adb on PATH`
    resolvedAdb = system
    return resolvedAdb
  }
  adbWarning =
    candidate === system
      ? `no usable adb found (looked for "${system}" on PATH) — install platform-tools or run "npm run fetch:adb"`
      : `${candidate} does not run on this machine and there is no adb on PATH — run "npm run fetch:adb"`
  resolvedAdb = candidate
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
