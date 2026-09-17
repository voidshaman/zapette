#!/usr/bin/env node
// Send a Wake-on-LAN magic packet to a remembered device, from the shell.
//
//   node tools/wake.mjs            # the most recent device in history
//   node tools/wake.mjs 192.168.1.50
//
// Uses the MAC persisted in the device history, so it works while the TV is
// asleep and answering nothing at all on the network.
import { ipOf, loadHistory } from "../src/devices.mjs"
import { resolveMac, wake } from "../src/wol.mjs"

const arg = process.argv[2]
const devices = loadHistory()
const entry = arg
  ? devices.find((d) => d.serial === arg || d.ip === arg || d.serial.startsWith(arg))
  : devices[0]

if (!entry) {
  console.error(arg ? `no device in history matching "${arg}"` : "device history is empty")
  process.exit(1)
}

const serial = entry.serial
const ip = entry.ip ?? ipOf(serial)
const mac = entry.mac ?? (await resolveMac({ serial, ip }))
if (!mac) {
  console.error(`could not determine a MAC for ${serial}`)
  process.exit(1)
}

const result = await wake(mac, { ip })
console.log(`wake -> ${mac}  (${entry.label ?? serial})`)
console.log(`  sent ${result.sent.length} packet(s): ${result.sent.join(", ")}`)
if (result.failures.length) console.log(`  failures: ${result.failures.join(", ")}`)
