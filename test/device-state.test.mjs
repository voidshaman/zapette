// The per-device setup state: what makes "first connect" a fact, and what keeps
// the question from being asked twice.
//
// These run against a real directory (a temp one, via ZAPETTE_CONFIG_DIR), so
// what is checked is the file the app will actually read and write — including
// the MAC fallback that keeps a re-leased TV's record findable.
import test from "node:test"
import assert from "node:assert/strict"
import * as fs from "node:fs"
import * as os from "node:os"
import { join } from "node:path"

import { createCompanionKey, companionConfigDir } from "../src/companion.mjs"
import {
  deviceStatePath,
  findDeviceState,
  listDeviceStates,
  macKey,
  readDeviceState,
  setupStatus,
  writeDeviceState,
} from "../src/device-state.mjs"

const configDir = fs.mkdtempSync(join(os.tmpdir(), "zapette-state-"))
process.env.ZAPETTE_CONFIG_DIR = configDir

const tv = { serial: "192.168.1.50:5555", model: "Smart TV Pro" }
const MAC = "8c:3b:b3:b4:1e:47" // macOS `arp` prints this with a short first octet

test("a device with no record is a first connect", () => {
  const status = setupStatus({ serial: tv.serial, mac: MAC })
  assert.equal(status.needed, true)
  assert.match(status.why, /no setup record/)
  assert.equal(deviceStatePath(tv), join(configDir, "device-192.168.1.50-5555.json"))
  assert.equal(fs.existsSync(deviceStatePath(tv)), false)
})

test("a record survives a round trip with the fields the setup records", () => {
  writeDeviceState({ serial: tv.serial, mac: MAC }, { mac: MAC, label: tv.model })
  const { present, record } = readDeviceState(tv)
  assert.equal(present, true)
  assert.equal(record.version, 1)
  assert.equal(record.key, "192.168.1.50-5555")
  assert.equal(record.serial, tv.serial)
  assert.equal(record.mac, MAC, "the MAC is stored in the canonical arp.mjs form")
  assert.ok(record.last_seen, "every write stamps last_seen")

  // Written, but not finished: the setup is still owed.
  const status = setupStatus({ serial: tv.serial, mac: MAC })
  assert.equal(status.needed, true)
  assert.match(status.why, /did not finish/)
})

test("installed AND paired is what stops the question", () => {
  writeDeviceState({ serial: tv.serial, mac: MAC }, { companion_installed: true })
  assert.equal(setupStatus({ serial: tv.serial, mac: MAC }).needed, true, "half a setup is not a setup")

  writeDeviceState({ serial: tv.serial, mac: MAC }, { secret_provisioned: true, companion_version: "0.1.0" })
  const status = setupStatus({ serial: tv.serial, mac: MAC })
  assert.equal(status.needed, false)
  assert.match(status.why, /installed and paired/)
  assert.match(status.why, /0\.1\.0/)
  assert.equal(status.matched, "serial")
})

test("a refusal is final for that device and nothing else is inferred from it", () => {
  const other = { serial: "192.168.1.22:5555", mac: "aa:bb:cc:dd:ee:01" }
  writeDeviceState(other, { setup: "refused", refused_at: new Date().toISOString() })
  const status = setupStatus(other)
  assert.equal(status.needed, false)
  assert.match(status.why, /declined/)
  // A refusal says nothing about the TV, so it must not claim the companion is absent.
  assert.ok(status.record.companion_installed === undefined)
})

test("a TV that came back on another address finds its record by MAC", () => {
  const moved = { serial: "192.168.1.99:5555", mac: MAC }
  const found = findDeviceState(moved)
  assert.equal(found.present, true)
  assert.equal(found.matched, "mac")
  assert.equal(found.path, deviceStatePath(tv), "the record is the one written for the old address")

  // And a write goes back into that same file instead of splitting the state.
  const before = listDeviceStates().length
  writeDeviceState(moved, { serial: moved.serial })
  assert.equal(listDeviceStates().length, before)
  assert.equal(findDeviceState(moved).record.serial, "192.168.1.99:5555")

  // A different TV is still a first connect.
  assert.equal(setupStatus({ serial: "192.168.1.40:5555", mac: "aa:bb:cc:dd:ee:ff" }).needed, true)
})

test("macKey normalises the forms arp prints", () => {
  assert.equal(macKey("aa:bb:cc:dd:ee:ff"), "aa:bb:cc:dd:ee:ff")
  assert.equal(macKey("8C:3B:B3:B4:1E:47"), macKey("8c-3b-b3-b4-1e-47"))
  assert.equal(macKey("not a mac"), null)
  assert.equal(macKey(null), null)
})

test("the record says the pairing happened, never what the key is", () => {
  const device = { serial: "10.9.9.9:5555", mac: "aa:bb:cc:00:11:22" }
  const key = createCompanionKey(device)
  writeDeviceState(device, {
    mac: device.mac,
    companion_installed: true,
    secret_provisioned: true,
    companion_version: "0.1.0",
  })
  const text = fs.readFileSync(deviceStatePath(device), "utf8")
  assert.ok(!text.includes(key.hex), "the key itself must never be in the state file")
  assert.ok(!text.includes(key.hex.slice(0, 16)), "nor any usable part of it")
  assert.equal(fs.existsSync(join(companionConfigDir(), "companion-10.9.9.9-5555.key")), true)
})
