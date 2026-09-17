// Wake-on-LAN: resolving a TV's MAC and sending a magic packet.
//
// What can and cannot be automated on an Android TV (verified on a TCL/Realtek
// Android 11 unit): the shell user is uid 2000 with no root, every
// /sys/class/net/eth0/* path is permission-denied and there is no wol/wake_on
// settings key. So the *device-side* enable (the TV's own "Wake on LAN" /
// "networked standby" option) cannot be flipped over adb — but the MAC address
// can be discovered, and the magic packet itself is sent from this machine.
import * as dgram from "node:dgram"
import { adb, shell } from "./adb.mjs"
// MAC parsing and the per-platform neighbour-cache lookup live in arp.mjs.
import { arpMac, parseMac } from "./arp.mjs"

/** Ask the device itself, in case it is more permissive than this one was. */
export async function deviceMac(serial) {
  const attempts = [
    "cat /sys/class/net/eth0/address",
    "ip link show eth0",
    "dumpsys ethernet | grep -i -m1 mac",
    "cat /sys/class/net/wlan0/address",
  ]
  for (const command of attempts) {
    const r = await shell(serial, command)
    const mac = parseMac(r.out)
    if (mac && mac !== "00:00:00:00:00:00") return mac
  }
  return null
}

export async function resolveMac({ serial, ip }) {
  return (await arpMac(ip)) ?? (await deviceMac(serial))
}

/** Probe what the device will let us do about Wake-on-LAN. */
export async function probeWol(serial) {
  const [id, sysfs, keys] = await Promise.all([
    shell(serial, "id"),
    shell(serial, "cat /sys/class/net/eth0/flags 2>&1"),
    shell(serial, "settings list global | grep -ciE 'wol|wake_on|networked_standby'"),
  ])
  const root = /\buid=0\b/.test(id.out)
  const sysfsReadable = !/denied|no such file/i.test(`${sysfs.out} ${sysfs.err}`)
  const settingKeys = Number((keys.out || "0").trim()) || 0
  return {
    root,
    sysfsReadable,
    settingKeys,
    configurable: root && sysfsReadable,
    verdict: root
      ? sysfsReadable
        ? "can be configured from here"
        : "root shell, but no WoL sysfs node on this device"
      : "needs root, or the TV's own Wake-on-LAN setting",
  }
}

function magicPacketBuffer(mac) {
  const bytes = mac.split(":").map((h) => parseInt(h, 16))
  const payload = Buffer.alloc(6 + 16 * 6, 0xff)
  for (let i = 0; i < 16; i++) {
    for (let j = 0; j < 6; j++) payload[6 + i * 6 + j] = bytes[j]
  }
  return payload
}

/**
 * Send the magic packet to every address that could reach the TV: the subnet
 * broadcast, the limited broadcast, and the device's unicast IP. Ports 9 and 7
 * are both conventional for WoL.
 */
export async function wake(mac, { ip, ports = [9, 7] } = {}) {
  const packet = magicPacketBuffer(mac)
  const targets = new Set(["255.255.255.255"])
  if (ip) {
    const o = ip.split(".")
    if (o.length === 4) targets.add(`${o[0]}.${o[1]}.${o[2]}.255`)
    targets.add(ip)
  }

  const sent = []
  const failures = []
  for (const port of ports) {
    for (const address of targets) {
      await new Promise((resolve) => {
        const socket = dgram.createSocket("udp4")
        const done = (err) => {
          socket.close()
          if (err) failures.push(`${address}:${port} ${err.code ?? err.message}`)
          else sent.push(`${address}:${port}`)
          resolve()
        }
        socket.once("error", done)
        socket.bind(() => {
          try {
            socket.setBroadcast(true)
          } catch {
            /* not fatal: broadcast may already be allowed */
          }
          socket.send(packet, port, address, (err) => done(err))
        })
      })
    }
  }
  return { sent, failures, bytes: packet.length, mac }
}
