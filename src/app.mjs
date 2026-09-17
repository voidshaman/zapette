#!/usr/bin/env node
// TV Remote TUI — pilots an Android TV over wireless ADB.
//
// Layout: connection header on top, then three columns (VOLUME | D-PAD | TEXT)
// with a SEND MODE module below the text column. Module titles sit ABOVE their
// containers on heavy borders.
//
// Navigation is module-based: Tab cycles the focused module, 1-4 jump straight
// to one, and the focused module's border lights up. Inside a module the arrows
// do the obvious thing — D-PAD drives the TV, VOLUME changes the TV volume,
// TEXT takes typing, SEND MODE toggles instant vs whole-string sending.
//
// Tab (not Ctrl/Shift+Arrow) is the module switch on purpose: terminals and
// macOS swallow most Ctrl+Arrow / Shift+Arrow combinations before an app sees them.
import {
  BoxRenderable,
  InputRenderable,
  TextRenderable,
  createCliRenderer,
} from "@opentui/core"
import {
  KEY,
  connectDevice,
  inputText,
  keyevent,
  listDevices,
  looksWedged,
  musicVolume,
  restartServer,
  scanLan,
} from "./adb.mjs"
import { DEMO_APPS, launchApp, listApps, loadApps, saveApps } from "./apps.mjs"
import { forget, ipOf, loadHistory, remember } from "./devices.mjs"
import { powerOff, powerOn, wakefulness as readWakefulness } from "./power.mjs"
import { probeWol, resolveMac } from "./wol.mjs"

const C = {
  text: "#c8d3f5",
  dim: "#8a94c4",
  faint: "#5a6390",
  track: "#2f3450",
  accent: "#7aa2f7",
  hot: "#bb9af7",
  ok: "#9ece6a",
  warn: "#e0af68",
  err: "#f7768e",
}

// Every screen's containers are painted opaque. The renderer diffs frames, so a
// transparent container contributes *no* cell values for its interior — cells the
// previous screen painted there are simply left on screen (switching from the app
// list back to the remote left app-list text inside the D-PAD box). An opaque
// background makes each screen own its whole rectangle.
const BG = "#16161e"

const MODULES = ["dpad", "volume", "text", "sendmode"]
const MODULE_TITLES = { dpad: "D-PAD", volume: "VOLUME", text: "TEXT", sendmode: "SEND MODE" }
const VOL_ROWS = 12
const ROWS = 12

const state = {
  screen: "devices", // "devices" | "remote" | "apps"
  devices: [],
  found: [], // adb hosts discovered by a LAN scan, not yet connected
  history: loadHistory(), // persisted devices, so a TV can be reconnected or woken by name
  scanning: false,
  sel: 0,
  addrOpen: false,
  serial: null,
  deviceLabel: "",
  module: "dpad",
  sendMode: "block", // "block" | "instant"
  log: [],
  busy: false,
  echo: "",
  volume: null,
  volumeMax: 100,
  lastSent: "—",
  panel: null, // "Awake" | "Asleep" | null — read off the TV; drives the power button
  apps: [], // launchable apps on the current TV
  appsSel: 0,
  appsAt: null, // ISO timestamp of the last successful probe
  appsProbing: false,
}

// ---------------------------------------------------------------- renderer
const renderer = await createCliRenderer({
  exitOnCtrlC: true,
  targetFps: 30,
  backgroundColor: "#16161e",
})

const root = new BoxRenderable(renderer, { flexDirection: "column", gap: 0, paddingX: 1, height: "100%" })

// ---- header: connection info
const headerBox = new BoxRenderable(renderer, {
  borderStyle: "heavy",
  borderColor: C.faint,
  height: 3,
  alignItems: "center",
  backgroundColor: BG,
})
const headerRow = new BoxRenderable(renderer, { flexDirection: "row", gap: 1, height: 1 })
const headerDot = new TextRenderable(renderer, { content: "○", fg: C.faint })
const headerText = new TextRenderable(renderer, { content: "", fg: C.text })
headerRow.add(headerDot)
headerRow.add(headerText)
headerBox.add(headerRow)

const main = new BoxRenderable(renderer, { flexDirection: "column", flexGrow: 1, backgroundColor: BG })

const footerBox = new BoxRenderable(renderer, { height: 2, flexDirection: "column", paddingX: 1, backgroundColor: BG })
const footerHints = new TextRenderable(renderer, { content: "", fg: C.text })
const footerStatus = new TextRenderable(renderer, { content: "", fg: C.dim })
footerBox.add(footerHints)
footerBox.add(footerStatus)

root.add(headerBox)
root.add(main)
root.add(footerBox)
renderer.root.add(root)

// ---------------------------------------------------------------- devices screen
const devicesTitle = new TextRenderable(renderer, { content: "ADB DEVICES", fg: C.accent })
const devicesPanel = new BoxRenderable(renderer, {
  borderStyle: "heavy",
  borderColor: C.faint,
  flexGrow: 1,
  flexDirection: "column",
  paddingX: 1,
  backgroundColor: BG,
})
const rows = Array.from({ length: ROWS }, () => new TextRenderable(renderer, { content: "", fg: C.text }))
rows.forEach((r) => devicesPanel.add(r))

const addrLabel = new TextRenderable(renderer, { content: "Address to connect (ip:port) then ⏎ :", fg: C.accent })
const addrInput = new InputRenderable(renderer, {
  width: 30,
  placeholder: "192.168.1.50:5555",
  backgroundColor: "#1a1b26",
  focusedBackgroundColor: "#24283b",
  textColor: C.text,
  cursorColor: C.ok,
})
devicesPanel.add(addrLabel)
devicesPanel.add(addrInput)

const devicesCol = new BoxRenderable(renderer, { flexDirection: "column", flexGrow: 1, backgroundColor: BG })
devicesCol.add(devicesTitle)
devicesCol.add(devicesPanel)

// ---------------------------------------------------------------- apps screen
const appsTitle = new TextRenderable(renderer, { content: "APPS ON THIS TV", fg: C.accent })
const appsPanel = new BoxRenderable(renderer, {
  borderStyle: "heavy",
  borderColor: C.faint,
  flexGrow: 1,
  flexDirection: "column",
  paddingX: 1,
  backgroundColor: BG,
})
const appsRows = Array.from({ length: ROWS }, () => new TextRenderable(renderer, { content: "", fg: C.text }))
appsRows.forEach((r) => appsPanel.add(r))

const appsCol = new BoxRenderable(renderer, { flexDirection: "column", flexGrow: 1, backgroundColor: BG })
appsCol.add(appsTitle)
appsCol.add(appsPanel)

// ---------------------------------------------------------------- remote screen
const bodyRow = new BoxRenderable(renderer, { flexDirection: "row", gap: 1, flexGrow: 1, backgroundColor: BG })

/** Module title, rendered above its container; brightens when the module has focus. */
function moduleTitle(name) {
  return new TextRenderable(renderer, { content: MODULE_TITLES[name], fg: C.dim })
}

// ---- VOLUME module
const volumeTitle = moduleTitle("volume")
const volumeBox = new BoxRenderable(renderer, {
  borderStyle: "heavy",
  borderColor: C.faint,
  flexDirection: "column",
  alignItems: "center",
  justifyContent: "center",
  flexGrow: 1,
  backgroundColor: BG,
})
const volFill = new TextRenderable(renderer, { content: "", fg: C.accent })
const volTrack = new TextRenderable(renderer, { content: "", fg: C.track })
const volValue = new TextRenderable(renderer, { content: "", fg: C.text })
const volButtons = new BoxRenderable(renderer, { flexDirection: "row", gap: 1, height: 3 })
volButtons.add(makeKey(" − ", () => sendKey(KEY.VOL_DOWN, "VOLUME_DOWN"), 6))
volButtons.add(makeKey(" + ", () => sendKey(KEY.VOL_UP, "VOLUME_UP"), 6))
// Track on top, fill at the bottom: a fader reads as growing upward.
volumeBox.add(volTrack)
volumeBox.add(volFill)
volumeBox.add(volValue)
volumeBox.add(volButtons)

const volumeCol = new BoxRenderable(renderer, { flexDirection: "column", width: 20, backgroundColor: BG })
volumeCol.add(volumeTitle)
volumeCol.add(volumeBox)

// ---- D-PAD module
const KEY_W = 7
const dpadTitle = moduleTitle("dpad")
const dpadBox = new BoxRenderable(renderer, {
  borderStyle: "heavy",
  borderColor: C.faint,
  flexDirection: "column",
  alignItems: "center",
  justifyContent: "center",
  flexGrow: 1,
  backgroundColor: BG,
})

const padUp = new BoxRenderable(renderer, { flexDirection: "row", gap: 1, height: 3 })
padUp.add(new BoxRenderable(renderer, { width: KEY_W, height: 3 }))
padUp.add(makeKey(" ▲ ", () => sendKey(KEY.UP, "DPAD_UP"), KEY_W))
padUp.add(new BoxRenderable(renderer, { width: KEY_W, height: 3 }))

const padMid = new BoxRenderable(renderer, { flexDirection: "row", gap: 1, height: 3 })
padMid.add(makeKey(" ◀ ", () => sendKey(KEY.LEFT, "DPAD_LEFT"), KEY_W))
padMid.add(makeKey(" OK ", () => sendKey(KEY.OK, "DPAD_CENTER"), KEY_W, C.accent))
padMid.add(makeKey(" ▶ ", () => sendKey(KEY.RIGHT, "DPAD_RIGHT"), KEY_W))

const padDown = new BoxRenderable(renderer, { flexDirection: "row", gap: 1, height: 3 })
padDown.add(new BoxRenderable(renderer, { width: KEY_W, height: 3 }))
padDown.add(makeKey(" ▼ ", () => sendKey(KEY.DOWN, "DPAD_DOWN"), KEY_W))
padDown.add(new BoxRenderable(renderer, { width: KEY_W, height: 3 }))

const padExtras = new BoxRenderable(renderer, { flexDirection: "row", gap: 1, height: 3 })
padExtras.add(makeKey(" Back ", () => sendKey(KEY.BACK, "BACK"), 10))
padExtras.add(makeKey(" Home ", () => sendKey(KEY.HOME, "HOME"), 10))

// Power button: on/off for the whole TV. Its label and colour follow the panel
// state read from the device, so the button doubles as the status readout.
const powerLabel = new TextRenderable(renderer, { content: "⏻  Power", fg: C.text })
const powerButton = new BoxRenderable(renderer, {
  width: 11,
  height: 3,
  border: true,
  borderStyle: "rounded",
  borderColor: C.faint,
  alignItems: "center",
  justifyContent: "center",
  onMouseDown(event) {
    event.preventDefault?.()
    togglePower()
  },
  onMouseOver() {
    powerButton.borderColor = C.hot
    powerButton.backgroundColor = "#1f2335"
  },
  onMouseOut() {
    powerButton.borderColor = panelColor()
    powerButton.backgroundColor = "transparent"
  },
})
powerButton.add(powerLabel)
padExtras.add(powerButton)

dpadBox.add(padUp)
dpadBox.add(padMid)
dpadBox.add(padDown)
dpadBox.add(new TextRenderable(renderer, { content: " ", fg: C.faint }))
dpadBox.add(padExtras)

const dpadCol = new BoxRenderable(renderer, { flexDirection: "column", flexGrow: 1, backgroundColor: BG })
dpadCol.add(dpadTitle)
dpadCol.add(dpadBox)

// ---- TEXT module + SEND MODE module below it
const textTitle = moduleTitle("text")
const textBox = new BoxRenderable(renderer, {
  borderStyle: "heavy",
  borderColor: C.faint,
  flexDirection: "column",
  paddingX: 1,
  backgroundColor: BG,
})
const fieldBadge = new TextRenderable(renderer, { content: "", fg: C.dim })
const textInput = new InputRenderable(renderer, {
  width: 42,
  placeholder: "type here…",
  backgroundColor: "#1a1b26",
  focusedBackgroundColor: "#24283b",
  textColor: C.text,
  cursorColor: C.ok,
})
const echoText = new TextRenderable(renderer, { content: "", fg: C.ok, wrapMode: "char" })
const textHint = new TextRenderable(renderer, { content: "", fg: C.dim })
const histLabel = new TextRenderable(renderer, { content: "HISTORY", fg: C.dim })
const histText = new TextRenderable(renderer, { content: "", fg: C.dim, wrapMode: "char" })
const histBox = new BoxRenderable(renderer, {
  borderStyle: "heavy",
  borderColor: C.faint,
  flexGrow: 1,
  flexDirection: "column",
  paddingX: 1,
  backgroundColor: BG,
})
histBox.add(histText)

textBox.add(fieldBadge)
textBox.add(textInput)
textBox.add(echoText)
textBox.add(textHint)

const sendTitle = moduleTitle("sendmode")
const sendBox = new BoxRenderable(renderer, {
  borderStyle: "heavy",
  borderColor: C.faint,
  flexDirection: "column",
  height: 5,
  paddingX: 1,
  justifyContent: "center",
  backgroundColor: BG,
})
const sendInstantRow = new BoxRenderable(renderer, {
  height: 1,
  paddingX: 1,
  onMouseDown(event) {
    event.preventDefault?.()
    setSendMode("instant")
  },
})
const sendBlockRow = new BoxRenderable(renderer, {
  height: 1,
  paddingX: 1,
  onMouseDown(event) {
    event.preventDefault?.()
    setSendMode("block")
  },
})
const sendInstantText = new TextRenderable(renderer, { content: "", fg: C.dim })
const sendBlockText = new TextRenderable(renderer, { content: "", fg: C.dim })
sendInstantRow.add(sendInstantText)
sendBlockRow.add(sendBlockText)
sendBox.add(sendInstantRow)
sendBox.add(sendBlockRow)

const textCol = new BoxRenderable(renderer, { flexDirection: "column", backgroundColor: BG })
textCol.add(textTitle)
textCol.add(textBox)
textCol.add(sendTitle)
textCol.add(sendBox)
textCol.add(histLabel)
textCol.add(histBox)

bodyRow.add(volumeCol)
bodyRow.add(dpadCol)
bodyRow.add(textCol)

// Side columns adapt; the D-pad column takes whatever is left.
function layout(width) {
  const textW = Math.max(40, Math.min(58, Math.round(width * 0.34)))
  volumeCol.width = 20
  textCol.width = textW
  textInput.width = Math.max(20, textW - 6)
}
layout(renderer.width ?? 100)
renderer.on("resize", (width) => layout(width))

// ---------------------------------------------------------------- helpers
const firstLine = (s) => String(s ?? "").split("\n")[0].slice(0, 80)
const hasFocus = (name) => state.module === name
// The power button's colour *is* the TV's panel state.
const panelColor = () => (state.panel === "Awake" ? C.ok : state.panel ? C.warn : C.faint)
const panelWord = () => (state.panel ? state.panel.toUpperCase() : "UNKNOWN")

/** "12s ago" / "3m ago" / "2h ago" for the app-list probe timestamp. */
const timeAgo = (iso) => {
  if (!iso) return "never"
  const s = Math.max(0, (Date.now() - new Date(iso).getTime()) / 1000)
  return s < 90 ? `${Math.round(s)}s ago` : s < 5400 ? `${Math.round(s / 60)}m ago` : `${Math.round(s / 3600)}h ago`
}

/** First row of the app list to render, so the selection stays on screen. */
function appsWindow() {
  const n = state.apps.length
  if (n <= ROWS) return 0
  return Math.max(0, Math.min(n - ROWS, state.appsSel - Math.floor(ROWS / 2)))
}
// A letter key, whether the terminal reports "w" or "W" for shift+w.
const keyLetter = (name) => (typeof name === "string" && name.length === 1 ? name.toLowerCase() : null)
const keyIsUpper = (name, shift) =>
  Boolean(shift) ||
  (typeof name === "string" &&
    name.length === 1 &&
    name === name.toUpperCase() &&
    name !== name.toLowerCase())

/** A bordered, clickable key that highlights on hover. */
function makeKey(label, onClick, width, accent = C.faint) {
  const box = new BoxRenderable(renderer, {
    width,
    height: 3,
    border: true,
    borderStyle: "rounded",
    borderColor: accent,
    alignItems: "center",
    justifyContent: "center",
    onMouseDown(event) {
      event.preventDefault?.()
      onClick()
    },
    onMouseOver() {
      box.borderColor = C.hot
      box.backgroundColor = "#1f2335"
    },
    onMouseOut() {
      box.borderColor = accent
      box.backgroundColor = "transparent"
    },
  })
  box.add(new TextRenderable(renderer, { content: label, fg: C.text }))
  return box
}

function entries() {
  const connected = new Set(state.devices.map((d) => d.serial))
  return [
    ...state.devices.map((d) => ({ kind: "device", device: d })),
    ...state.found
      .filter((host) => !connected.has(`${host}:5555`))
      .map((host) => ({ kind: "found", host })),
    ...state.history
      .filter((d) => !connected.has(d.serial))
      .map((d) => ({ kind: "history", entry: d })),
    { kind: "connect" },
  ]
}

function pushLog(line) {
  state.log.unshift(line)
  if (state.log.length > 8) state.log.length = 8
}

// Every adb call runs through one chain so the TV sees inputs in order.
let chain = Promise.resolve()
function enqueue(fn) {
  chain = chain
    .then(fn)
    .catch((e) => {
      pushLog(`✗ ${firstLine(e?.message ?? e)}`)
      state.busy = false
      update()
    })
  return chain
}

function setSendMode(mode) {
  state.sendMode = mode
  update()
}

function focusModule(name) {
  state.module = name
  update()
}

function cycleModule(step) {
  const i = MODULES.indexOf(state.module)
  focusModule(MODULES[(i + step + MODULES.length) % MODULES.length])
}

function update() {
  const onRemote = state.screen === "remote"
  const instant = state.sendMode === "instant"

  // ---- header
  if (onRemote) {
    const awake = state.panel === "Awake"
    headerDot.content = state.busy ? "◌" : awake ? "●" : state.panel ? "◐" : "○"
    headerDot.fg = state.busy ? C.warn : awake ? C.ok : state.panel ? C.warn : C.faint
    headerText.content =
      `${state.deviceLabel}   ·   ${state.serial}   ·   ADB ${state.busy ? "busy…" : "connected"}` +
      `   ·   TV ${panelWord()}`
    headerBox.borderColor = state.busy ? C.warn : awake ? C.ok : C.faint
  } else if (state.screen === "apps") {
    headerDot.content = state.appsProbing ? "◌" : "●"
    headerDot.fg = state.appsProbing ? C.warn : C.ok
    headerText.content =
      `${state.deviceLabel || state.serial}   ·   ${state.apps.length} app(s)   ·   ` +
      `${state.appsProbing ? "probing the TV…" : `probed ${timeAgo(state.appsAt)}`}`
    headerBox.borderColor = state.appsProbing ? C.warn : C.faint
  } else {
    headerDot.content = "○"
    headerDot.fg = C.faint
    headerText.content = "no device selected — pick one below"
    headerBox.borderColor = C.faint
  }

  // ---- devices list
  const list = entries()
  rows.forEach((row, i) => {
    const e = list[i]
    if (!e) {
      row.visible = false
      row.content = ""
      return
    }
    row.visible = true
    const mark = i === state.sel ? "▸ " : "  "
    if (e.kind === "device") {
      const d = e.device
      const bad = d.state !== "device"
      row.content = `${mark}${d.serial}${d.model ? `   ${d.model}` : ""}${bad ? `   [${d.state}]` : ""}`
      row.fg = i === state.sel ? C.hot : bad ? C.err : C.text
    } else if (e.kind === "found") {
      row.content = `${mark}${e.host}:5555   found on the network — ⏎ connects`
      row.fg = i === state.sel ? C.hot : C.ok
    } else if (e.kind === "history") {
      // Persisted device: reconnect by name, and wake it if a MAC is known.
      const mac = e.entry.mac ? `   ${e.entry.mac}` : ""
      row.content = `${mark}${e.entry.label || e.entry.serial}   ${e.entry.ip || ipOf(e.entry.serial)}${mac}`
      row.fg = i === state.sel ? C.hot : C.dim
    } else {
      row.content = `${mark}+ Connect an address (ip:port)…`
      row.fg = i === state.sel ? C.hot : C.accent
    }
  })
  // ---- app rows (windowed around the selection)
  const appOff = appsWindow()
  appsRows.forEach((row, i) => {
    const a = state.apps[appOff + i]
    if (!a) {
      row.visible = false
      row.content = ""
      return
    }
    const index = appOff + i
    row.visible = true
    const mark = index === state.appsSel ? "▸ " : "  "
    row.content = `${mark}${a.user ? "★" : "○"} ${a.label}${a.label === a.pkg ? "" : `   ${a.pkg}`}`
    row.fg = index === state.appsSel ? C.hot : a.user ? C.text : C.dim
  })

  addrLabel.visible = state.addrOpen
  addrInput.visible = state.addrOpen
  if (state.addrOpen && state.screen === "devices") addrInput.focus()

  // ---- module focus chrome: the focused container lights up
  volumeBox.borderColor = hasFocus("volume") ? C.accent : C.faint
  dpadBox.borderColor = hasFocus("dpad") ? C.accent : C.faint
  textBox.borderColor = hasFocus("text") ? C.accent : C.faint
  sendBox.borderColor = hasFocus("sendmode") ? C.accent : C.faint
  volumeTitle.fg = hasFocus("volume") ? C.accent : C.dim
  dpadTitle.fg = hasFocus("dpad") ? C.accent : C.dim
  textTitle.fg = hasFocus("text") ? C.accent : C.dim
  sendTitle.fg = hasFocus("sendmode") ? C.accent : C.dim

  // ---- power button reports the panel state it read from the TV
  powerButton.borderColor = panelColor()
  powerLabel.content = state.panel === "Awake" ? "⏻  On" : state.panel ? "⏻  Wake" : "⏻  Power"
  powerLabel.fg = state.panel === "Awake" ? C.ok : state.panel ? C.warn : C.text

  // ---- volume fader
  const level = state.volume ?? 0
  const filled = Math.max(0, Math.min(VOL_ROWS, Math.round((level / state.volumeMax) * VOL_ROWS)))
  volFill.content = Array(filled).fill("████").join("\n")
  volTrack.content = Array(VOL_ROWS - filled).fill("████").join("\n")
  volValue.content = state.volume == null ? "– / 100" : `${state.volume} / ${state.volumeMax}`

  // ---- text + send mode
  if (onRemote) {
    textInput.visible = !instant
    echoText.visible = instant
    if (!instant && hasFocus("text")) textInput.focus()
    else textInput.blur()

    fieldBadge.content = instant ? "MODE: INSTANT" : "MODE: BLOCK"
    fieldBadge.fg = instant ? C.warn : C.dim
    echoText.content = instant ? `› ${state.echo || "…"}` : ""
    textHint.content = instant ? "⌫ = DEL" : ""

    sendInstantText.content = `${instant ? "●" : "○"} Instant — one key at a time`
    sendBlockText.content = `${instant ? "○" : "●"} Block — ⏎ sends the whole string`
    sendInstantText.fg = instant ? C.ok : C.dim
    sendBlockText.fg = instant ? C.dim : C.ok

    histText.content = state.log.length ? state.log.slice(0, 8).join("\n") : "—"
  }

  // ---- footer: context-sensitive for the focused module
  if (state.screen === "apps") {
    footerHints.content = "↑ ↓ select    ⏎ launch    r re-probe    l / Esc back    d devices"
    footerStatus.content = `${state.apps.length} app(s)   ·   probed ${timeAgo(state.appsAt)}${state.log[0] ? `        ${state.log[0]}` : ""}`
    return
  }
  if (!onRemote) {
    footerHints.content = state.addrOpen
      ? "Type the address then ⏎        Esc = cancel"
      : "↑ ↓ select    ⏎ open/connect    a add address    s scan    w wake    W WoL setup    x forget    r refresh    k restart adb"
    // Surface the last adb result here too, so failures are visible before you open a device.
    footerStatus.content = `${state.log[0] ? `${state.log[0]}        ` : ""}Tab switches module        Ctrl+C quits`
    return
  }

  footerHints.content =
    `MODULE ${MODULES.indexOf(state.module) + 1}/${MODULES.length} — ${MODULE_TITLES[state.module]}` +
    `        Tab / Shift+Tab switch module        1-4 jump`
  const detail =
    state.module === "dpad"
      ? "arrows drive the TV      ⏎ = OK      ⌫ / b = Back      h = Home      w = wake      s = sleep      p = toggle      l = apps"
      : state.module === "volume"
        ? "↑ ↓ change the TV volume      ← → switch module      − + also work"
        : state.module === "text"
          ? instant
            ? "type: every character is sent to the TV      ⌫ = DEL      Tab moves on"
            : "type your text      ⏎ sends it      ⌫ edits      ← → move the cursor"
          : "↑ ↓ or ← → choose the send mode      ⏎ toggles"
  footerStatus.content = `${detail}        last sent: ${state.lastSent}`
}

function setScreen(name) {
  state.screen = name
  for (const child of [...main.getChildren()]) main.remove(child)
  main.add(name === "devices" ? devicesCol : name === "apps" ? appsCol : bodyRow)
  update()
}

// ---------------------------------------------------------------- actions
function sendKey(code, label) {
  if (state.demo) {
    // Offline mode for UI work: no adb, but the UI reacts as if it worked.
    state.busy = true
    update()
    if (code === KEY.VOL_UP || code === KEY.VOL_DOWN) {
      // One keyevent == one step on the real TV (measured: 22 → 23).
      const next = (state.volume ?? 0) + (code === KEY.VOL_UP ? 1 : -1)
      state.volume = Math.max(0, Math.min(state.volumeMax, next))
      pushLog(`✓ ${state.volume} / ${state.volumeMax}`)
    } else {
      pushLog(`✓ ${label}`)
    }
    state.busy = false
    state.lastSent = label
    update()
    return
  }
  enqueue(async () => {
    state.busy = true
    update()
    const r = await keyevent(state.serial, code)
    state.busy = false
    state.lastSent = label
    pushLog(r.ok ? `✓ ${label}` : `✗ ${label} — ${firstLine(r.err)}`)
    if (code === KEY.VOL_UP || code === KEY.VOL_DOWN) {
      const v = await musicVolume(state.serial)
      if (v.ok) {
        state.volume = v.volume
        if (v.max) state.volumeMax = v.max
        pushLog(`✓ ${state.volume} / ${state.volumeMax}`)
      }
    }
    update()
  })
}

function sendText(text, { mirror = false } = {}) {
  const payload = text
  if (!payload) return
  if (state.demo) {
    state.lastSent = `text ${JSON.stringify(payload)}`
    if (mirror) state.echo += payload
    pushLog(`✓ text ${JSON.stringify(payload)}`)
    update()
    return
  }
  enqueue(async () => {
    state.busy = true
    update()
    const r = await inputText(state.serial, payload)
    state.busy = false
    state.lastSent = `text ${JSON.stringify(payload)}`
    if (mirror) state.echo += payload
    pushLog(r.ok ? `✓ text ${JSON.stringify(payload)}` : `✗ text — ${firstLine(r.err)}`)
    update()
  })
}

async function refreshDevices() {
  const { devices, error } = await listDevices()
  state.devices = devices
  if (error) pushLog(`✗ adb — ${firstLine(error)}`)
  else pushLog(`✓ ${devices.length} device(s)`)
  const max = entries().length - 1
  if (state.sel > max) state.sel = Math.max(0, max)
  update()
}

/** Connect, recovering once from a wedged adb server. Returns true on success. */
async function connectAddress(addr) {
  pushLog(`… connecting to ${addr}`)
  update()
  let r = await connectDevice(addr)
  if (!r.ok && looksWedged(r)) {
    pushLog("… adb server was wedged — restarting it")
    await restartServer()
    r = await connectDevice(addr)
  }
  const line = firstLine(r.out || r.err)
  const bad = /unable|cannot|failed|refused|no route/i.test(`${r.out} ${r.err}`)
  pushLog(`${r.ok && !bad ? "✓" : "✗"} ${line}`)
  await refreshDevices()
  const idx = state.devices.findIndex((d) => addr.startsWith(d.serial))
  if (idx >= 0) state.sel = idx
  update()
  const ok = r.ok && !bad
  if (ok) {
    // Automatic Wake-on-LAN setup: learn the MAC and record what the TV allows.
    const known = state.devices.find((d) => addr.startsWith(d.serial))
    await setupWol({ serial: addr, ip: ipOf(addr), label: known?.model || addr, quiet: true })
  }
  return ok
}

async function doConnect() {
  const addr = addrInput.value.trim()
  if (!addr) {
    pushLog("✗ empty address")
    update()
    return
  }
  addrInput.value = ""
  state.addrOpen = false
  await connectAddress(addr)
}

/** `adb devices` lists only connected devices, so probe the LAN for the adb port. */
async function doScan() {
  if (state.scanning) return
  state.scanning = true
  pushLog("… scanning the local network for port 5555")
  update()
  const { found, scanned } = await scanLan()
  state.scanning = false
  state.found = found
  pushLog(
    found.length
      ? `✓ ${found.length} adb host(s) found of ${scanned} probed`
      : `✗ no adb host found (${scanned} probed)`,
  )
  update()
}

function restartAdb() {
  enqueue(async () => {
    state.busy = true
    update()
    const r = await restartServer()
    state.busy = false
    pushLog(r.ok ? "✓ adb server restarted" : `✗ adb server — ${firstLine(r.err || r.out)}`)
    await refreshDevices()
    update()
  })
}

/** Resolve the MAC, probe what the device allows, and persist both. */
async function setupWol({ serial, ip, label, quiet = false }) {
  const mac = await resolveMac({ serial, ip })
  let probe = { verdict: "unknown" }
  try {
    probe = await probeWol(serial)
  } catch {
    // the TV may already have gone to sleep
  }
  state.history = remember({ serial, ip, label, mac: mac ?? undefined, wol: probe.verdict })
  if (!quiet) {
    pushLog(mac ? `✓ ${mac} — WoL: ${probe.verdict}` : "✗ could not read a MAC for this device")
    if (!probe.configurable) {
      pushLog("ℹ enable Wake-on-LAN on the TV itself (Network → Wake on LAN / networked standby)")
    }
  }
  update()
  return { mac, probe }
}

/** `w`: send the magic packet at the selected device (or the TV we're driving). */
function wakeTarget(target) {
  enqueue(async () => {
    const serial = target?.serial ?? (target?.host ? `${target.host}:5555` : state.serial)
    const ip = target?.ip ?? ipOf(serial)
    const known = state.history.find((d) => d.serial === serial || (ip && d.ip === ip))
    let mac = target?.mac ?? known?.mac ?? null
    if (!mac) mac = await resolveMac({ serial, ip })
    if (!mac) {
      pushLog(`✗ no MAC for ${ip || "that device"} — press W to run the WoL setup`)
      update()
      return
    }
    state.busy = true
    update()
    const onStep = (line) => {
      pushLog(`· ${line}`)
      update()
    }
    // The whole sequence: magic packet, reconnect, then KEYCODE_WAKEUP — a TV
    // that only answers the network is still a TV with a dark screen.
    const res = await powerOn({ serial, ip, mac, onStep })
    state.busy = false
    state.lastSent = "WAKE"
    pushLog(res.ok ? "✓ TV awake" : `✗ wake — ${firstLine(res.error ?? "failed")}`)
    if (serial === state.serial) state.panel = res.panel ?? state.panel
    await refreshDevices()
    update()
  })
}

/** `s`: put the TV we're driving to sleep — one keyevent, and the network goes with it. */
function sleepTarget() {
  if (!state.serial) {
    pushLog("✗ no device — connect one first")
    update()
    return
  }
  enqueue(async () => {
    state.busy = true
    update()
    const onStep = (line) => {
      pushLog(`· ${line}`)
      update()
    }
    const res = await powerOff({ serial: state.serial, onStep })
    state.busy = false
    state.panel = res.off ? "Asleep" : (res.panel ?? state.panel)
    state.lastSent = "POWER OFF"
    pushLog(res.ok ? "✓ TV asleep" : `✗ sleep — ${firstLine(res.error ?? "failed")}`)
    await refreshDevices()
    update()
  })
}

/** What `w` / `W` should act on: the selection, else the current device. */
function selectedTarget() {
  const e = entries()[state.sel]
  if (e?.kind === "history") return e.entry
  if (e?.kind === "device") return { serial: e.device.serial, ip: ipOf(e.device.serial), label: e.device.model }
  if (e?.kind === "found") return { serial: `${e.host}:5555`, ip: e.host, label: e.host }
  if (state.serial) return { serial: state.serial, ip: ipOf(state.serial), label: state.deviceLabel }
  return state.history[0] ?? null
}

// ---------------------------------------------------------------- apps
/** Probe the TV for launchable apps and cache them per serial. */
function probeApps() {
  if (!state.serial) {
    pushLog("✗ no device — connect one first")
    update()
    return
  }
  enqueue(async () => {
    state.appsProbing = true
    update()
    if (state.demo) {
      state.apps = DEMO_APPS
      state.appsAt = new Date().toISOString()
      state.appsProbing = false
      pushLog(`✓ ${DEMO_APPS.length} app(s) — demo`)
      update()
      return
    }
    const { apps, error } = await listApps(state.serial)
    state.appsProbing = false
    if (error) {
      pushLog(`✗ app probe — ${firstLine(error)}`)
      update()
      return
    }
    state.apps = apps
    state.appsAt = new Date().toISOString()
    state.appsSel = Math.min(state.appsSel, Math.max(0, apps.length - 1))
    saveApps(state.serial, apps)
    pushLog(`✓ ${apps.length} app(s) on the TV`)
    update()
  })
}

/** `l`: the app list — cached list first, then a fresh probe. */
function openApps() {
  if (!state.serial) {
    pushLog("✗ no device — connect one first")
    update()
    return
  }
  const cached = state.demo ? null : loadApps(state.serial)
  if (cached) {
    state.apps = cached.apps
    state.appsAt = cached.at
    state.appsSel = 0
  }
  setScreen("apps")
  probeApps()
}

function launchSelected() {
  const app = state.apps[state.appsSel]
  if (!app) return
  if (state.demo) {
    state.lastSent = `launch ${app.label}`
    pushLog(`✓ launched ${app.label} (demo)`)
    update()
    return
  }
  enqueue(async () => {
    state.busy = true
    update()
    const r = await launchApp(state.serial, app)
    state.busy = false
    state.lastSent = `launch ${app.label}`
    pushLog(r.ok ? `✓ launched ${app.label} (${r.via})` : `✗ launch — ${firstLine(r.out)}`)
    await refreshPanel()
    update()
  })
}

function openRemote(device) {
  state.serial = device.serial
  state.deviceLabel = device.model || device.device || device.serial
  // Persist it so it shows up in the history list next time.
  state.history = remember({
    serial: device.serial,
    ip: ipOf(device.serial),
    label: state.deviceLabel,
    mac: state.history.find((d) => d.serial === device.serial)?.mac,
  })
  state.module = "dpad"
  state.sendMode = "block"
  state.echo = ""
  state.log = []
  state.volume = null
  setScreen("remote")
  if (state.demo) return
  enqueue(async () => {
    const v = await musicVolume(state.serial)
    if (v.ok) {
      state.volume = v.volume
      if (v.max) state.volumeMax = v.max
    }
    state.panel = await readWakefulness(state.serial).catch(() => null)
    update()
  })
}

/** Read the panel state off the TV (null when it is not reachable). */
async function refreshPanel() {
  if (state.demo || !state.serial) return
  const panel = await readWakefulness(state.serial).catch(() => null)
  // A TV that has left the network keeps its last known state rather than
  // flipping to "unknown": we still know what we just told it to do.
  if (panel) state.panel = panel
  update()
}

/**
 * The on/off button. OFF is one keyevent; ON is magic packet → wait for adb →
 * KEYCODE_WAKEUP, because a sleeping TV has left the network entirely.
 */
function togglePower() {
  if (state.demo) {
    state.panel = state.panel === "Awake" ? "Asleep" : "Awake"
    pushLog(`✓ power — TV ${state.panel}`)
    update()
    return
  }
  if (!state.serial) {
    pushLog("✗ no device — connect one first")
    update()
    return
  }
  enqueue(async () => {
    state.busy = true
    update()
    const serial = state.serial
    const ip = ipOf(serial)
    const known = state.history.find((d) => d.serial === serial || d.ip === ip)
    const onStep = (line) => {
      pushLog(`· ${line}`)
      update()
    }
    const turningOff = state.panel === "Awake"
    const res = turningOff
      ? await powerOff({ serial, onStep })
      : await powerOn({ serial, ip, mac: known?.mac, onStep })
    state.busy = false
    state.panel = turningOff ? (res.off ? "Asleep" : (res.panel ?? state.panel)) : (res.panel ?? state.panel)
    pushLog(res.ok ? (turningOff ? "✓ TV off" : "✓ TV on") : `✗ power — ${firstLine(res.error ?? "failed")}`)
    if (res.ok) state.lastSent = turningOff ? "POWER OFF" : "POWER ON"
    await refreshDevices()
    await refreshPanel()
    update()
  })
}

// ---------------------------------------------------------------- keys
renderer.keyInput.on("keypress", (key) => {
  if (key.eventType === "release") return
  const name = key.name
  const ctrl = !!key.ctrl
  const shift = !!key.shift

  if (state.screen === "devices") return handleDevicesKey(key, name, shift)
  if (state.screen === "apps") return handleAppsKey(key, name, shift)
  return handleRemoteKey(key, name, ctrl, shift)
})

function handleDevicesKey(key, name, shift) {
  const letter = keyLetter(name)
  const upper = keyIsUpper(name, shift)
  if (state.addrOpen) {
    if (name === "escape") {
      state.addrOpen = false
      update()
      key.stopPropagation()
      return
    }
    if (name === "return") {
      enqueue(doConnect)
      key.stopPropagation()
      return
    }
    return // the address input handles the rest
  }

  if (name === "up" || name === "down") {
    const list = entries()
    state.sel = Math.min(list.length - 1, Math.max(0, state.sel + (name === "down" ? 1 : -1)))
    update()
    key.stopPropagation()
    return
  }
  if (name === "a") {
    state.addrOpen = true
    update()
    key.stopPropagation()
    return
  }
  if (name === "r") {
    enqueue(refreshDevices)
    key.stopPropagation()
    return
  }
  if (name === "s") {
    enqueue(doScan)
    key.stopPropagation()
    return
  }
  if (name === "k") {
    restartAdb()
    key.stopPropagation()
    return
  }
  // Wake-on-LAN: `w` fires the magic packet, `W` runs the setup for the selection.
  if (letter === "w") {
    const target = selectedTarget()
    if (!target) {
      pushLog("✗ nothing to act on — scan or connect first")
      update()
    } else if (upper) {
      enqueue(() => setupWol(target))
    } else {
      wakeTarget(target)
    }
    key.stopPropagation()
    return
  }
  if (letter === "x") {
    const e = entries()[state.sel]
    if (e?.kind === "history") {
      state.history = forget(e.entry.serial)
      pushLog(`✓ forgot ${e.entry.label || e.entry.serial}`)
      state.sel = Math.max(0, Math.min(state.sel, entries().length - 1))
      update()
    }
    key.stopPropagation()
    return
  }
  if (name === "return") {
    const e = entries()[state.sel]
    if (!e) return
    if (e.kind === "connect") {
      state.addrOpen = true
      update()
    } else if (e.kind === "found") {
      // Connect, then open it if the TV accepted us.
      const addr = `${e.host}:5555`
      enqueue(async () => {
        if (await connectAddress(addr)) {
          const d = state.devices.find((x) => x.serial.startsWith(e.host))
          if (d) openRemote(d)
        }
      })
    } else if (e.kind === "history") {
      // Reconnect a remembered device, then open it if the TV accepted us.
      enqueue(async () => {
        if (await connectAddress(e.entry.serial)) {
          const d = state.devices.find((x) => x.serial === e.entry.serial)
          if (d) openRemote(d)
        }
      })
    } else {
      openRemote(e.device)
    }
    key.stopPropagation()
  }
}

function handleAppsKey(key, name, shift) {
  const letter = keyLetter(name)
  if (name === "up" || name === "down") {
    if (state.apps.length) {
      state.appsSel = Math.min(state.apps.length - 1, Math.max(0, state.appsSel + (name === "down" ? 1 : -1)))
    }
    update()
    key.stopPropagation()
    return
  }
  if (name === "return") {
    launchSelected()
    key.stopPropagation()
    return
  }
  if (name === "r") {
    probeApps()
    key.stopPropagation()
    return
  }
  if (name === "d") {
    state.sel = Math.max(0, state.devices.findIndex((x) => x.serial === state.serial))
    setScreen("devices")
    key.stopPropagation()
    return
  }
  if (name === "escape" || letter === "l") {
    setScreen("remote")
    key.stopPropagation()
  }
}

function handleRemoteKey(key, name, ctrl, shift) {
  const instant = state.sendMode === "instant"
  const mod = state.module
  const letter = keyLetter(name)

  // ---- module switching: Tab only, and it works even inside TEXT (Tab is not
  // typable text, so it stays the way out of the text field).
  //
  // Key resolution order, and it is deliberate:
  //   1. Tab (always)
  //   2. TEXT — while the text box has focus every key belongs to the box, or in
  //      Instant mode to the TV. Typing "p2d" must never toggle the power or jump
  //      modules, so nothing else is even reachable from here.
  //   3. global shortcuts: 1-4, d, l, p, w, s
  //   4. the focused module (send mode / volume / d-pad)
  // Modules come last because they return early for unhandled keys, which would
  // otherwise swallow the global shortcuts whenever volume or send mode had focus.
  if (name === "tab") {
    cycleModule(shift ? -1 : 1)
    key.stopPropagation()
    return
  }

  // ---- TEXT module
  if (mod === "text") {
    if (!instant) {
      // Composing: the input owns the keyboard.
      if (name === "return") {
        const value = textInput.value
        if (value) {
          sendText(value)
          state.echo += value
          textInput.value = ""
        }
        key.stopPropagation()
        return
      }
      if (name === "escape") {
        // Esc clears the field first; on an empty field it moves on, so there is
        // always a way out of the text module without reaching for Tab.
        if (textInput.value) textInput.value = ""
        else cycleModule(1)
        update()
        key.stopPropagation()
      }
      return
    }
    // Instant: every printable key goes straight to the TV.
    if (name === "backspace") {
      sendKey(KEY.DEL, "DEL")
      key.stopPropagation()
      return
    }
    const ch = typeof key.sequence === "string" && key.sequence.length === 1 ? key.sequence : null
    if (!ctrl && ch && ch >= " ") {
      sendText(ch, { mirror: true })
      key.stopPropagation()
    }
    return
  }

  // ---- module / screen shortcuts: not available while the text field has focus
  if (!ctrl && ["1", "2", "3", "4"].includes(name)) {
    focusModule(MODULES[Number(name) - 1])
    key.stopPropagation()
    return
  }
  if (name === "d" && !ctrl) {
    state.sel = Math.max(0, state.devices.findIndex((x) => x.serial === state.serial))
    setScreen("devices")
    key.stopPropagation()
    return
  }
  if (letter === "l" && !ctrl) {
    openApps()
    key.stopPropagation()
    return
  }

  // ---- SEND MODE module
  if (mod === "sendmode") {
    if (["up", "down", "left", "right", "return", "space"].includes(name)) {
      setSendMode(instant ? "block" : "instant")
      key.stopPropagation()
    }
    return
  }

  // ---- VOLUME module
  if (mod === "volume") {
    if (name === "up" || name === "down") {
      const up = name === "up"
      sendKey(up ? KEY.VOL_UP : KEY.VOL_DOWN, up ? "VOLUME_UP" : "VOLUME_DOWN")
      key.stopPropagation()
      return
    }
    if (name === "left" || name === "right") {
      cycleModule(name === "right" ? 1 : -1)
      key.stopPropagation()
    }
    return
  }

  // ---- Power, from every module except TEXT (there the keyboard is the TV's)
  // Order matters here: TEXT and the global shortcuts above are resolved first,
  // then the focused module, so `l`/`p`/`w`/`s` never get swallowed by a module
  // that happens to return early for unhandled keys.

  if (letter === "p" && !ctrl) {
    togglePower()
    key.stopPropagation()
    return
  }
  if (letter === "w" && !ctrl) {
    // Wake the TV we're driving: magic packet, reconnect, KEYCODE_WAKEUP.
    wakeTarget({ serial: state.serial, ip: ipOf(state.serial), label: state.deviceLabel })
    key.stopPropagation()
    return
  }
  if (letter === "s" && !ctrl) {
    sleepTarget()
    key.stopPropagation()
    return
  }
  const arrows = { up: KEY.UP, down: KEY.DOWN, left: KEY.LEFT, right: KEY.RIGHT }
  const arrowLabels = { up: "DPAD_UP", down: "DPAD_DOWN", left: "DPAD_LEFT", right: "DPAD_RIGHT" }
  if (!ctrl && !shift && arrows[name] !== undefined) {
    sendKey(arrows[name], arrowLabels[name])
    key.stopPropagation()
    return
  }
  if (name === "return") {
    sendKey(KEY.OK, "DPAD_CENTER")
    key.stopPropagation()
    return
  }
  if (name === "backspace" || name === "b") {
    sendKey(KEY.BACK, "BACK")
    key.stopPropagation()
    return
  }
  if (name === "h") {
    sendKey(KEY.HOME, "HOME")
    key.stopPropagation()
    return
  }
  if (!ctrl && (name === "+" || name === "=")) {
    sendKey(KEY.VOL_UP, "VOLUME_UP")
    key.stopPropagation()
    return
  }
  if (!ctrl && (name === "-" || name === "_")) {
    sendKey(KEY.VOL_DOWN, "VOLUME_DOWN")
    key.stopPropagation()
  }
}

// ---------------------------------------------------------------- boot
// `--auto` opens the first connected device straight away (demos/screenshots).
const autoOpen = process.argv.includes("--auto") || process.env.TV_REMOTE_AUTO === "1"
// `--demo` drives the UI with no TV attached (design work, screenshots).
const demo = process.argv.includes("--demo") || process.env.TV_REMOTE_DEMO === "1"

async function boot() {
  if (demo) {
    state.demo = true
    openRemote({ serial: "demo", model: "Demo TV", device: "demo", state: "device" })
    state.volume = 24
    state.volumeMax = 100
    state.log = ["✓ device(s) — demo mode", "✓ VOLUME_UP", "✓ DPAD_RIGHT"]
    update()
    return
  }
  await refreshDevices()
  if (autoOpen) {
    const first = state.devices.find((d) => d.state === "device")
    if (first) openRemote(first)
  }
}

setScreen("devices")
enqueue(boot)
