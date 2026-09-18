// Per-device companion setup state: one small JSON file per TV, so "first
// connect" is a file that is there or not, rather than a guess.
//
// KEY: the adb serial, through the same deviceKey() the companion's own secret
// file is named with (src/companion.mjs) — so one decision names both files and
// they sit side by side:
//
//   ~/.config/zapette/device-192.168.1.50-5555.json
//   ~/.config/zapette/companion-192.168.1.50-5555.key
//
// The serial is not stable forever (it is `ip:5555`, and the TV's address comes
// from DHCP), so the record also carries the MAC and lookup falls back to
// matching it across the records in this directory: a TV that came back on a
// different address still finds its own record instead of looking like a first
// connect — which is exactly the prompt nobody wants to answer twice.
//
// The MAC is not the primary key because at first connect it can still be
// unknown (the ARP entry may not exist yet, see src/arp.mjs), and a record
// written under the serial must not be orphaned the moment the MAC is learned.
// A MAC match keeps the file where it is and only updates the serial inside it.
//
// Nothing secret ever goes in here: the record says whether the pairing
// happened, never what the key is (the key lives in its own 0600 file).
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs"
import { basename, dirname, join } from "node:path"
import { normalizeMac } from "./arp.mjs"
import { companionConfigDir, deviceKey } from "./companion.mjs"

export const DEVICE_STATE_VERSION = 1
const PREFIX = "device-"
const SUFFIX = ".json"

/** `~/.config/zapette/device-<key>.json` (ZAPETTE_CONFIG_DIR honoured). */
export function deviceStatePath(device) {
  return join(companionConfigDir(), `${PREFIX}${deviceKey(device)}${SUFFIX}`)
}

/** The device key a state file is named after, from the file name. */
function keyOfPath(path) {
  const name = basename(String(path))
  return name.startsWith(PREFIX) && name.endsWith(SUFFIX) ? name.slice(PREFIX.length, -SUFFIX.length) : null
}

function parse(path) {
  try {
    const record = JSON.parse(readFileSync(path, "utf8"))
    return record && typeof record === "object" && !Array.isArray(record) ? record : null
  } catch {
    return null
  }
}

/** One record by its exact path. `{ present, path, record }`. */
export function readDeviceState(device) {
  const path = deviceStatePath(device)
  const record = parse(path)
  return { present: Boolean(record), path, record }
}

/** Every readable record in the config directory (diagnostics and the MAC fallback). */
export function listDeviceStates() {
  let names = []
  try {
    names = readdirSync(companionConfigDir())
  } catch {
    return []
  }
  return names
    .filter((name) => name.startsWith(PREFIX) && name.endsWith(SUFFIX))
    .map((name) => {
      const path = join(companionConfigDir(), name)
      return { path, key: keyOfPath(path), record: parse(path) }
    })
    .filter((entry) => entry.record)
}

// The shape arp.mjs reads off three platforms: 1-2 hex digits per octet (macOS
// prints a short first one), colon or dash separated.
const MAC_SHAPE = /^(?:[0-9a-f]{1,2}[:-]){5}[0-9a-f]{1,2}$/i

/**
 * A MAC in the canonical form this project uses everywhere
 * (`aa:bb:cc:dd:ee:ff`, src/arp.mjs#normalizeMac), or null when the text is not a
 * MAC at all — `normalizeMac` alone would happily "normalise" a sentence.
 */
export function macKey(mac) {
  const text = String(mac ?? "").trim()
  return MAC_SHAPE.test(text) ? normalizeMac(text) : null
}

/**
 * The record for this device: the file named after its serial first, then any
 * record whose MAC matches. `matched` says which one answered, so a caller can
 * tell "we have been here" from "we found it by MAC".
 */
export function findDeviceState({ serial, mac = null } = {}) {
  if (!serial) return { present: false, path: null, record: null, matched: null }
  const primary = readDeviceState({ serial })
  if (primary.present) return { ...primary, matched: "serial" }
  const want = macKey(mac)
  if (want) {
    for (const entry of listDeviceStates()) {
      if (macKey(entry.record.mac) === want) {
        return { present: true, path: entry.path, record: entry.record, matched: "mac" }
      }
    }
  }
  return { present: false, path: primary.path, record: null, matched: null }
}

/**
 * Merge `patch` into this device's record and write it, stamping `last_seen`.
 * Writes back to the file the record was found in (so a MAC match does not
 * split the state across two files), else to the serial-named one.
 *
 * Callers must not pass key material: this file is not secret and is not
 * written with restrictive permissions.
 */
export function writeDeviceState(device, patch = {}) {
  const found = findDeviceState(device)
  const path = found.present ? found.path : deviceStatePath(device)
  const merge = { ...patch }
  // Stored canonical (arp.mjs's form), so the MAC fallback above compares like
  // with like whichever platform wrote the entry.
  if ("mac" in merge) merge.mac = macKey(merge.mac) ?? merge.mac ?? null
  const record = {
    ...(found.record ?? {}),
    ...merge,
    version: DEVICE_STATE_VERSION,
    key: keyOfPath(path) ?? deviceKey(device),
    serial: device?.serial ?? found.record?.serial ?? null,
    last_seen: new Date().toISOString(),
  }
  mkdirSync(dirname(path), { recursive: true })
  writeFileSync(path, `${JSON.stringify(record, null, 2)}\n`)
  return { path, record }
}

/**
 * Does this device still need the first-connect setup, and why?
 *
 *   needed — there is no record at all (a genuine first connect), or the last
 *            attempt did not get as far as a verified pairing
 *   not    — the record says the companion is installed AND paired, or that the
 *            user declined the setup for this TV (asked once, never again)
 *
 * `why` is a sentence for the log, not for the prompt.
 */
export function setupStatus({ serial, mac = null } = {}) {
  const found = findDeviceState({ serial, mac })
  if (!found.present) return { needed: true, why: "no setup record for this device", ...found }
  const r = found.record
  if (r.setup === "refused") {
    return { needed: false, why: `setup was declined on ${r.refused_at ?? "an earlier connect"}`, ...found }
  }
  if (r.companion_installed && r.secret_provisioned) {
    return { needed: false, why: `the companion is installed and paired${r.companion_version ? ` (v${r.companion_version})` : ""}`, ...found }
  }
  return { needed: true, why: "the last setup did not finish", ...found }
}

/** Does this device have a record at all? (The card's own definition of first connect.) */
export function hasDeviceState(device) {
  return existsSync(deviceStatePath(device))
}
