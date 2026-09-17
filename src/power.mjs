// Power on/off for an Android TV over wireless adb — the "on/off button".
//
// OFF is one keyevent: KEYCODE_SLEEP (223). Measured on the TCL: the panel goes
// dark within ~3s and the network goes with it (port 5555 closes, adb drops to
// offline). Nothing listens for a remote after that.
//
// ON is a two-step dance, because a sleeping TV is not on the network at all:
//   1. a Wake-on-LAN magic packet brings the NIC/Android back (measured 5-18s),
//   2. KEYCODE_WAKEUP (224) then lights the panel.
// Step 2 is not optional: after the packet adb is reachable but reports
// mWakefulness=Asleep with no focused window — the box is up, the screen is
// dark. ~3-4s after 224 it reports Awake with a focused window again.
import { adb, connectDevice, disconnectDevice, keyevent, listDevices, probePort } from "./adb.mjs"
import { wake } from "./wol.mjs"

export const POWER_KEY = { SLEEP: 223, WAKEUP: 224 }
export const POWER_ON_TIMEOUT = 60000

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

/** "Awake" | "Asleep" | "Dozing" | null when adb cannot answer. */
export async function wakefulness(serial) {
  const r = await adb(["-s", serial, "shell", "dumpsys", "power"], { timeout: 12000 })
  if (!r.ok) return null
  const m = /mWakefulness=(\w+)/.exec(r.out)
  return m ? m[1] : null
}

/** "device" | "offline" | "unauthorized" | null when adb does not list it. */
export async function deviceState(serial) {
  const { devices } = await listDevices()
  return devices.find((d) => d.serial === serial)?.state ?? null
}

/** Poll until adb reports the device as usable, or the timeout runs out. */
/**
 * Wait for the TV to be usable on adb. Two things have to happen and neither is
 * automatic: the magic packet brings the TV's adbd back, and then *we* have to
 * connect to it — `adb devices` only ever lists devices adb was told to connect
 * to, so a TV whose port 5555 is wide open still shows up as nothing at all.
 */
export async function waitForTv(
  serial,
  { ip, timeout = POWER_ON_TIMEOUT, interval = 2000, rearm, rearmEvery = 15000, onTick } = {},
) {
  const host = ip ?? serial.split(":")[0]
  const started = Date.now()
  let last = "\u0000"
  let lastArm = 0
  let lastKnock = -9999
  for (;;) {
    const waited = Date.now() - started
    let state = await deviceState(serial)

    // Knock on the door: if the TV's port is up, register the transport.
    if (state !== "device" && waited - lastKnock >= 2000) {
      lastKnock = waited
      if (await probePort(host, 5555, 1500)) {
        await connectDevice(serial)
        state = await deviceState(serial)
      }
    }

    if (state !== last) {
      onTick?.(state, waited)
      last = state
    }
    if (state === "device") return { ok: true, waited, state }
    // A single magic packet is not always enough on this TV (the first one has
    // been seen to do nothing at all): re-arm every 15s until it answers.
    if (rearm && waited - lastArm >= rearmEvery) {
      lastArm = waited
      await rearm(waited)
    }
    if (waited >= timeout) return { ok: false, waited, state }
    await sleep(interval)
  }
}

/** `p` when the panel is up: KEYCODE_SLEEP. */
export async function powerOff({ serial, onStep = () => {} }) {
  const steps = []
  const note = (line) => {
    steps.push(line)
    onStep(line)
  }
  const state = await deviceState(serial)
  if (state !== "device") {
    note(`adb is ${state ?? "not listing this device"} — cannot reach the TV to sleep it`)
    return { ok: false, error: "the TV is not on adb", steps }
  }
  const before = await wakefulness(serial)
  if (!before) {
    note("the TV does not answer on adb — it is already off the network")
    return { ok: true, panel: null, off: true, steps }
  }
  if (before !== "Awake") {
    note(`panel already ${before}`)
    return { ok: true, panel: before, steps }
  }
  note(`KEYCODE_SLEEP (${POWER_KEY.SLEEP}) — panel was ${before ?? "unknown"}`)
  const r = await keyevent(serial, POWER_KEY.SLEEP)
  if (!r.ok) return { ok: false, error: r.err, steps }
  await sleep(2500)
  const after = await wakefulness(serial).catch(() => null)
  note(after ? `panel is now ${after}` : "the TV left the network with the panel (expected)")
  return { ok: true, panel: after, off: after !== "Awake", steps }
}

/**
 * `p` when the panel is dark: magic packet if the TV is off the network, then
 * KEYCODE_WAKEUP. Returns the panel state it ended in.
 */
export async function powerOn({ serial, ip, mac, timeout = POWER_ON_TIMEOUT, onStep = () => {} }) {
  const steps = []
  const note = (line) => {
    steps.push(line)
    onStep(line)
  }

  const state = await deviceState(serial)
  let panel = null
  if (state === "device") {
    panel = await wakefulness(serial)
    if (panel) {
      note(`adb is up — panel ${panel}`)
      if (panel === "Awake") return { ok: true, alreadyOn: true, panel, steps }
    } else {
      // adb happily keeps listing a TV that has gone dark: the transport is
      // stale and every command on it would just time out. Drop it, so the
      // Wake-on-LAN path below is the one that runs.
      note("adb still lists this device but it does not answer — dropping the stale transport")
      await disconnectDevice(serial)
    }
  }

  if (!panel) {
    if (!mac) {
      note("no MAC known for this TV — press W to run the Wake-on-LAN setup")
      return { ok: false, error: "no MAC known", steps }
    }
    const r = await wake(mac, { ip })
    note(
      r.sent.length
        ? `WoL magic packet → ${mac} (${r.sent.length} packets)`
        : `WoL failed — ${r.failures[0] ?? "unknown error"}`,
    )
    if (!r.sent.length) return { ok: false, error: r.failures[0] ?? "WoL failed", steps }

    const waited = await waitForTv(serial, {
      ip,
      timeout,
      rearm: async (ms) => {
        const again = await wake(mac, { ip })
        note(`re-armed with another magic packet at ${Math.round(ms / 1000)}s (${again.sent.length} sent)`)
      },
      onTick: (s, ms) => note(`waiting for the TV: ${s ?? "off the network"} (${Math.round(ms / 1000)}s)`),
    })
    if (!waited.ok) {
      note(`the TV did not come back on adb within ${Math.round(timeout / 1000)}s`)
      return { ok: false, error: "no adb after the magic packet", steps }
    }
    panel = await wakefulness(serial)
    note(`adb is up after ${Math.round(waited.waited / 1000)}s — panel ${panel ?? "unknown"}`)
    if (panel === "Awake") return { ok: true, panel, steps }
  }

  note(`KEYCODE_WAKEUP (${POWER_KEY.WAKEUP})`)
  const r = await keyevent(serial, POWER_KEY.WAKEUP)
  if (!r.ok) return { ok: false, error: r.err, steps }
  await sleep(3000)
  panel = await wakefulness(serial).catch(() => null)
  note(panel ? `panel is now ${panel}` : "panel state unreadable — the TV dropped off again")
  return { ok: panel === "Awake", panel, steps }
}
