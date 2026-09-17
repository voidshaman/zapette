// Persisted device history: the TVs this machine has connected to, their IP and
// MAC, so they can be reconnected or woken without retyping anything.
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs"
import { homedir } from "node:os"
import { dirname, join } from "node:path"

export function historyPath() {
  if (process.env.TV_REMOTE_STATE) return process.env.TV_REMOTE_STATE
  const base = process.env.XDG_CONFIG_HOME || join(homedir(), ".config")
  return join(base, "tv-remote-tui", "devices.json")
}

export function loadHistory() {
  try {
    const parsed = JSON.parse(readFileSync(historyPath(), "utf8"))
    return Array.isArray(parsed?.devices) ? parsed.devices : []
  } catch {
    return []
  }
}

function save(devices) {
  const file = historyPath()
  try {
    mkdirSync(dirname(file), { recursive: true })
    writeFileSync(file, `${JSON.stringify({ version: 1, devices }, null, 2)}\n`)
    return true
  } catch {
    return false
  }
}

/** Insert or update one device (keyed by serial) and move it to the front. */
export function remember(entry) {
  if (!entry?.serial) return loadHistory()
  const rest = loadHistory().filter((d) => d.serial !== entry.serial)
  const previous = loadHistory().find((d) => d.serial === entry.serial) ?? {}
  const merged = { ...previous, ...entry, lastSeen: new Date().toISOString() }
  const devices = [merged, ...rest]
  save(devices)
  return devices
}

export function forget(serial) {
  const devices = loadHistory().filter((d) => d.serial !== serial)
  save(devices)
  return devices
}

/** "192.168.1.50:5555" → "192.168.1.50" */
export function ipOf(serial) {
  return String(serial ?? "").split(":")[0]
}
