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
  adbNote,
  connectDevice,
  installApk,
  listPackages,
  inputText,
  adb as adbRaw,
  keyevent,
  listDevices,
  looksWedged,
  musicVolume,
  packagePath,
  probePort,
  restartServer,
  scanLan,
  shell,
} from "./adb.mjs"
import { existsSync } from "node:fs"
import { homedir } from "node:os"
import { basename, join, resolve } from "node:path"
import { DEMO_APPS, labelFor, launchApp, listApps, loadApps, saveApps } from "./apps.mjs"
import { DEMO_PROCS, demoRunning, probeProcesses, stopPackage } from "./processes.mjs"
// Picking an APK by walking the disk instead of typing a path (src/apk-browser.mjs).
import { listDir, parentDir, sizeLabel, tildePath } from "./apk-browser.mjs"
import { forget, ipOf, loadHistory, remember } from "./devices.mjs"
// Per-device setup state: whether the companion is installed and paired on a TV,
// so "first connect" is a file that is there or not (src/device-state.mjs).
import { setupStatus, writeDeviceState } from "./device-state.mjs"
// The companion APK on this machine: the prebuilt one when it is newer than the
// sources, companion/build.sh when it is not (src/companion-build.mjs).
import { buildCompanionApk, companionApkStatus, BUILD_SCRIPT } from "./companion-build.mjs"
import { CLEAN_IME, keyboardAction, resolveLayout, untypeable } from "./keymap.mjs"
import { applyPlan, killedDumpRecovery, moveCaret, needsSlotHandoff, planEdit, probeRetryMs, readField, slotKnowledge, stripPlaceholder } from "./mirror.mjs"
import { deviceState, powerOff, powerOn, wakefulness as readWakefulness } from "./power.mjs"
import { probeWol, resolveMac } from "./wol.mjs"
// The companion APK on the TV: probed, never assumed. See src/companion.mjs.
import {
  COMPANION,
  COMPANION_IME,
  COMPANION_IME_GRANT,
  START_GAP_MS,
  START_TRIES,
  commitCompanion,
  companionDevice,
  ensureCompanionKey,
  imeOff,
  imeOn,
  pingCompanion,
  probeCompanion,
  provisionCompanionSecret,
  readCompanion,
  removeCompanionForward,
  removeCompanionForwardsSync,
  startCompanionService,
} from "./companion.mjs"
// Keys: the warm monkey socket first, `input keyevent` when it is not there.
// See src/monkey.mjs, which owns that socket's whole lifecycle.
import {
  clearStrayMonkeys,
  ensureMonkey,
  monkeyHoldsSlot,
  monkeyInfo,
  monkeyKeys,
  monkeyOwnsKeys,
  monkeyPointer,
  reclaimSlot,
  releaseSlot,
  stopMonkey,
  stopMonkeySync,
} from "./monkey.mjs"
// Cursor mode: the pointer model (position + gain) is pure and lives in
// src/cursor.mjs; this file wires the mouse events and the `tap` to it.
import { CURSOR, createCursor, cursorLine, cursorMove, cursorReach } from "./cursor.mjs"

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

// The setup flow's steps, in the order they run. Each one is a real action with a
// real verdict (src/app.mjs#SETUP_RUNNERS) — the list is what the installer screen
// renders and what stops at the first failure.
const SETUP_STEPS = [
  { id: "adb", label: "checking adb" },
  { id: "apk", label: "preparing the APK" },
  { id: "install", label: "installing the companion" },
  { id: "pair", label: "pairing this machine's key" },
  { id: "verify", label: "verifying (authenticated ping)" },
]
const SETUP_MARKS = { pending: "○", running: "◐", done: "✓", failed: "✗" }

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
  sendMode: "mirror", // "mirror" (edit the TV's field here) | "block" | "instant"
  layout: "auto", // what the TV's keyboard is: "auto" | "azerty" | "qwerty"
  tvKeyboard: "qwerty", // what the TV reported (auto resolves to this)
  tvIme: "", // the TV's current input method
  tvImeOwn: "", // the one the TV came with, so it can be given back
  tvImeClean: false, // true while the TV runs the keyboard we switched it to
  tvImeManual: false, // true when the user pinned the TV's keyboard with i
  tvLocale: "", // the TV's locale, which settles the layout when the name does not
  caret: 0, // where the caret sits in the mirrored field
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
  // What is RUNNING on the TV: pkg → pid from the last probe (src/processes.mjs),
  // the user-installed subset of it, and what that probe saw. A live process is
  // the only proof a stop worked, so this is also the kill verdict.
  procs: new Map(),
  procsUser: new Set(),
  procsAt: null,
  procsProbing: false,
  procsCounts: null, // { psRows, packages, userPackages, running, sandboxed }
  // Which slice of the one list is showing: everything, user apps, system apps,
  // or only what has a live process. Cycled with `f` on the app list.
  appsFilter: "all",
  apkOpen: false, // the "install an APK from this machine" path prompt is showing
  // The APK picker: { dir, entries, sel, truncated, apkCount, error, note } while
  // the filesystem screen is up, null otherwise. See src/apk-browser.mjs.
  apkBrowse: null,
  // The first-connect / setup screen: { phase, device, steps, summary } while it
  // is up ("checking" | "prompt" | "running" | "done" | "failed"), null otherwise.
  // See needsSetup() in the connect path.
  setup: null,
  companion: null, // last companion probe: { state, host, detail, ms, version } — null until probed
  companionProbing: false,
  companionIme: false, // true while the *companion's* IME is the one the TV selected
  companionImeVia: null, // "companion" (selected in-process over the socket) or "adb"
  companionTyping: { commits: 0, verified: 0, unverified: 0, fellBack: 0 }, // what the companion route actually did
  // Cursor mode: the local mouse drives a TV pointer. `on` is the mode, the rest
  // is the pointer (see src/cursor.mjs for why the position lives here and not on
  // the TV) plus what a session did, which the footer reports.
  cursor: {
    on: false,
    pointer: createCursor(),
    last: null, // the last terminal cell the mouse was seen at
    moves: 0,
    clicks: 0,
    lastTap: null, // { x, y, ms, via }
  },
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
// Which path the client is on: adb always, the companion when it answers. Kept
// as its own renderable so it can carry its own colour.
const headerPath = new TextRenderable(renderer, { content: "", fg: C.faint })
headerRow.add(headerDot)
headerRow.add(headerText)
headerRow.add(headerPath)
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

// Cursor mode listens on the RENDERER's root, not on a panel: mouse events bubble
// from whatever cell was hit, so the ancestor sees every one of them, and a
// handler that returns without calling preventDefault changes nothing for the
// rest of the app (that is what keeps the normal screens untouched).
renderer.root.onMouse = (event) => handleCursorMouse(event)

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

const apkLabel = new TextRenderable(renderer, { content: "APK on this machine (path) then ⏎ :", fg: C.accent })
const apkInput = new InputRenderable(renderer, {
  width: 60,
  placeholder: "~/Downloads/some-app.apk",
  backgroundColor: "#1a1b26",
  focusedBackgroundColor: "#24283b",
  textColor: C.text,
  cursorColor: C.ok,
})
appsPanel.add(apkLabel)
appsPanel.add(apkInput)
// The line under the list: what is running, and what the process probe left out.
// It is the honest half of the running view — a shell *can* see everything here,
// but only package names are actionable, so the rest is counted, not hidden.
const appsNote = new TextRenderable(renderer, { content: "", fg: C.dim })
appsPanel.add(appsNote)

const appsCol = new BoxRenderable(renderer, { flexDirection: "column", flexGrow: 1, backgroundColor: BG })
appsCol.add(appsTitle)
appsCol.add(appsPanel)

// ---------------------------------------------------------------- APK picker
// Choosing the file by walking the disk instead of typing a path. A directory
// and every `*.apk` in it, in the same list-with-a-selection shape as the app
// list, so the keys and the look are already familiar. Confirming a file hands
// its path to the same installFromPath() the path prompt uses — one installer,
// and the verdict on screen is still the device's.
const apkTitle = new TextRenderable(renderer, { content: "PICK AN APK ON THIS MACHINE", fg: C.accent })
const apkPanel = new BoxRenderable(renderer, {
  borderStyle: "heavy",
  borderColor: C.faint,
  flexGrow: 1,
  flexDirection: "column",
  paddingX: 1,
  backgroundColor: BG,
})
const apkDirLine = new TextRenderable(renderer, { content: "", fg: C.text })
const apkRows = Array.from({ length: ROWS }, () => new TextRenderable(renderer, { content: "", fg: C.text }))
const apkNote = new TextRenderable(renderer, { content: "", fg: C.dim })
apkPanel.add(apkDirLine)
apkRows.forEach((r) => apkPanel.add(r))
apkPanel.add(apkNote)

const apkCol = new BoxRenderable(renderer, { flexDirection: "column", flexGrow: 1, backgroundColor: BG })
apkCol.add(apkTitle)
apkCol.add(apkPanel)

// ---------------------------------------------------------------- setup screen
// The first-connect question and the steps that follow it. Deliberately plain:
// the module titles, borders and markers the rest of the app already uses, no
// animation and no new colour.
const setupTitle = new TextRenderable(renderer, { content: "COMPANION SETUP", fg: C.accent })
const setupPanel = new BoxRenderable(renderer, {
  borderStyle: "heavy",
  borderColor: C.faint,
  flexGrow: 1,
  flexDirection: "column",
  paddingX: 1,
  backgroundColor: BG,
})
const setupDevice = new TextRenderable(renderer, { content: "", fg: C.text })
const setupQuestion = new TextRenderable(renderer, { content: "", fg: C.hot, wrapMode: "char" })
const setupRows = Array.from({ length: SETUP_STEPS.length }, () =>
  new TextRenderable(renderer, { content: "", fg: C.dim, wrapMode: "char" }),
)
const setupSummary = new TextRenderable(renderer, { content: "", fg: C.dim, wrapMode: "char" })
setupPanel.add(setupDevice)
setupPanel.add(setupQuestion)
setupPanel.add(new TextRenderable(renderer, { content: " ", fg: C.dim }))
setupRows.forEach((row) => setupPanel.add(row))
setupPanel.add(new TextRenderable(renderer, { content: " ", fg: C.dim }))
setupPanel.add(setupSummary)

const setupCol = new BoxRenderable(renderer, { flexDirection: "column", flexGrow: 1, backgroundColor: BG })
setupCol.add(setupTitle)
setupCol.add(setupPanel)

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
  height: 7,
  paddingX: 1,
  justifyContent: "center",
  backgroundColor: BG,
})
const sendMirrorRow = new BoxRenderable(renderer, {
  height: 1,
  paddingX: 1,
  onMouseDown(event) {
    event.preventDefault?.()
    setSendMode("mirror")
  },
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
const sendKeysRow = new BoxRenderable(renderer, {
  height: 1,
  paddingX: 1,
  onMouseDown(event) {
    event.preventDefault?.()
    cycleLayout()
  },
})
const sendMirrorText = new TextRenderable(renderer, { content: "", fg: C.dim })
const sendInstantText = new TextRenderable(renderer, { content: "", fg: C.dim })
const sendBlockText = new TextRenderable(renderer, { content: "", fg: C.dim })
const sendKeysText = new TextRenderable(renderer, { content: "", fg: C.dim })
sendKeysRow.add(sendKeysText)
sendMirrorRow.add(sendMirrorText)
sendInstantRow.add(sendInstantText)
sendBlockRow.add(sendBlockText)
sendBox.add(sendMirrorRow)
sendBox.add(sendBlockRow)
sendBox.add(sendInstantRow)
sendBox.add(sendKeysRow)

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

/** The filters `f` cycles on the app list. "everything" first, as it is today. */
const APP_FILTERS = ["all", "user", "system", "running"]
const FILTER_LABEL = { all: "everything", user: "user apps", system: "system/vendor", running: "running only" }

/**
 * The one list the `l` menu shows (src/processes.mjs supplies the running set).
 *
 * It is the launchable apps — each carrying whether it is running and its pid —
 * joined by the running packages that have no launcher activity at all
 * (com.tcl.miracast, the TCL services …), because those are exactly what a person
 * opens a task manager to stop. Launchable entries keep the order they already
 * had; the running-only extras sit after them, so the screen looks unchanged
 * until a marker or a filter is asked for. `f` then narrows it.
 */
function visibleApps() {
  const listed = state.apps.map((a) => ({
    ...a,
    running: state.procs.has(a.pkg),
    pid: state.procs.get(a.pkg) ?? null,
  }))
  const known = new Set(listed.map((a) => a.pkg))
  const extra = [...state.procs]
    .filter(([pkg]) => !known.has(pkg))
    .map(([pkg, pid]) => ({
      pkg,
      pid,
      activity: null,
      component: null,
      label: labelFor(pkg),
      user: state.procsUser.has(pkg),
      running: true,
      noLauncher: true,
    }))
  const all = [...listed, ...extra]
  const f = state.appsFilter
  return all.filter((a) =>
    f === "user" ? a.user : f === "system" ? !a.user : f === "running" ? a.running : true,
  )
}

/** The line under the app list: what is running, and what the probe left out. */
function appsNoteText(list) {
  if (state.procsProbing) return "reading the TV's process list (ps -A)…"
  const c = state.procsCounts
  const bits = [`${state.procs.size} running package(s)`]
  if (c) {
    const notPackages = c.psRows - c.running - (c.sandboxed ?? 0)
    if (notPackages > 0) {
      bits.push(
        `ps -A listed ${c.psRows} package-like name(s); ${notPackages} are HAL/vendor services, not packages`,
      )
    }
    if (c.sandboxed) bits.push(`${c.sandboxed} isolated renderer(s) not listed — they die with their host`)
  }
  if (state.appsFilter !== "all") bits.push(`${list.length} shown by the ${FILTER_LABEL[state.appsFilter]} filter`)
  return bits.join("   ·   ")
}

/** First row of the app list to render, so the selection stays on screen. */
function appsWindow(list = visibleApps()) {
  const n = list.length
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

// ---------------------------------------------------------------- mirror
// What the TV's focused field is believed to hold, and where its caret is. Read
// with a probe (uiautomator, ~2.5s), kept current by tracking our own edits, and
// corrected by another probe on demand. See src/mirror.mjs for the measurements.
const mirror = {
  known: false,
  text: "",
  caret: 0,
  probedAt: 0,
  failures: 0, // consecutive failed field reads, for the retry backoff
  pending: false, // local text the TV has never been told about (a sync was dropped)
  notedUnknown: false, // the "field not read yet" line is said once, not per keystroke
  imeHeld: false, // mirror mode is what holds the companion IME right now
}
// Emptiness, as this TV reports it: an empty field hands back its own hint. The
// short list covers the common cases and any new hint is learned the first time
// the field is emptied (see `learnHint`).
const hints = new Set(["rechercher", "recherchez", "search", "search youtube", "search youtube tv"])
const TRANSLATE_NOTE = "letters get translated, but a repeated key can still go missing"
const KEYBOARD_LEASE_MS = 6000 // how long the TV's own keyboard stays away after a send
let learnHint = false
const MIRROR_DEBOUNCE_MS = 1200 // a burst of typing goes out as one edit run
// The companion route's pause: a sync there is commit + read-back, so the only
// thing the wait buys is coalescing keystrokes, not hiding a slow device.
const MIRROR_DEBOUNCE_COMPANION_MS = 150
const MIRROR_REFRESH_MS = 20000 // re-read the field this often while it has focus
// The same refresh when a read has to borrow the TV's UiAutomation slot back from
// monkey, which costs the measured 8.03 s handoff (src/app.mjs#probeField). Spreading
// those reads out is what keeps the fast key path up: at 20 s a handoff would hold a
// quarter of every mirror session, and it is only worth paying when the TV is idle.
const MIRROR_REFRESH_SLOT_MS = 60000

// What this session has learned about the TV's one UiAutomation slot: null until a
// read says something, then whether a dump needs monkey's slot handed back first
// (src/mirror.mjs#needsSlotHandoff).
let slotHandoff = null
// The one handed-back read that may be in flight; it runs outside the call chain.
let slotRead = null
// True from the moment the slot is lent out to the moment the read's continuation
// takes it back. A deliberate stop in that window (power off, leaving the device) must
// not be undone by the continuation, so it clears this flag.
let slotPaused = false
// Edits that reached the TV's field. A read that started before one of them landed
// saw a field that no longer exists (applyFieldRead).
let editSeq = 0

function scheduleSync() {
  if (syncTimer) clearTimeout(syncTimer)
  syncTimer = setTimeout(() => {
    syncTimer = null
    enqueue(syncMirror)
  }, mirrorDebounce())
}
let syncTimer = null

/**
 * How long a burst of typing is gathered before it goes out as one edit.
 *
 * On the adb route this is the compensation for the slow path: a sync costs ~1.5 s,
 * so waiting 1.2 s for the keystrokes to stop is what keeps a burst to one edit
 * instead of one per key. On the companion route a whole sync costs a few
 * milliseconds, so the pause is not hiding anything — it is just latency being
 * added to the user's own typing, and it shrinks to one frame's worth.
 */
function mirrorDebounce() {
  return typingPath().route === "companion" ? MIRROR_DEBOUNCE_COMPANION_MS : MIRROR_DEBOUNCE_MS
}

/** What the TV's keyboard is, after the user's override is taken into account. */
function effectiveLayout() {
  return state.layout === "auto" ? state.tvKeyboard : state.layout
}

/**
 * Ask the TV what keyboard it will render our key events with. The TCL keyboard
 * on a French set remaps them (see src/keymap.mjs); the stock one does not, so
 * this decides whether the app translates before injecting.
 */
async function detectKeyboard() {
  if (!state.serial || state.demo) return
  const ime = await adbRaw(["-s", state.serial, "shell", "settings", "get", "secure", "default_input_method"])
  const locale = await adbRaw(["-s", state.serial, "shell", "getprop", "persist.sys.locale"])
  const name = (ime.out || "").trim()
  state.tvLocale = (locale.out || "").trim()
  // Only a keyboard we would have to fix counts as the TV's own — never the stock
  // one we borrow, and never the companion's IME: those are selections we made,
  // and handing one of them back would leave the TV without its own keyboard.
  if (name && name !== CLEAN_IME && name !== COMPANION_IME && !state.tvImeOwn) state.tvImeOwn = name
  setKeyboardState(name)
  pushLog(
    state.tvKeyboard === "azerty"
      ? `⌨ TV keyboard: ${keyboardName(name)} — it remaps injected keys (a↔q, z↔w) and swallows repeated ones; ${TRANSLATE_NOTE}`
      : `⌨ TV keyboard: ${keyboardName(name)} — injected text arrives as typed`,
  )
}

/** Keep our idea of the TV's keyboard, and the layout that follows from it, in step. */
function setKeyboardState(ime) {
  state.tvIme = ime
  state.tvKeyboard = resolveLayout(ime, state.tvLocale)
  state.tvImeClean = state.tvKeyboard === "qwerty"
  update()
}

/**
 * Borrow the TV's pass-through keyboard for as long as text is going out.
 *
 * Switching costs 0.15s and takes effect immediately (measured), so this happens
 * on demand rather than on connect: nothing about the TV changes until the sender
 * actually needs it, and releaseKeyboardSoon() hands its keyboard back after.
 */
async function ensureCleanKeyboard() {
  if (state.demo || !state.serial) return
  // BYPASS (companion route): borrowing a pass-through keyboard exists to stop the
  // TV's own layout rewriting injected key positions. `commitText` sends no
  // keycodes, so there is nothing to work around. The mechanism is untouched and
  // still runs on the adb route.
  if (typingPath().route === "companion") return
  const todo = keyboardAction({ clean: state.tvImeClean, manual: state.tvImeManual, own: state.tvImeOwn })
  if (todo !== "use-clean") return
  const r = await adbRaw(["-s", state.serial, "shell", "ime", "set", CLEAN_IME])
  if (!r.ok) {
    pushLog(`✗ could not switch the TV's keyboard — ${firstLine(r.err || r.out)}`)
    update()
    return
  }
  setKeyboardState(CLEAN_IME)
  pushLog(`⌨ sending with ${keyboardName(CLEAN_IME)} — ${keyboardName(state.tvImeOwn)} comes back when you stop`)
}

/** Hand the TV its own keyboard back once nothing has been sent for a moment. */
function releaseKeyboardSoon() {
  if (state.tvImeManual) return
  // BYPASS (companion route): this is the pass-through keyboard's lease. The
  // companion route borrows a different IME and has its own lease below.
  if (typingPath().route === "companion") return
  if (leaseTimer) clearTimeout(leaseTimer)
  leaseTimer = setTimeout(() => {
    leaseTimer = null
    enqueue(restoreOwnKeyboard)
  }, KEYBOARD_LEASE_MS)
}
let leaseTimer = null

async function restoreOwnKeyboard() {
  const todo = keyboardAction({ clean: state.tvImeClean, manual: state.tvImeManual, own: state.tvImeOwn })
  if (todo !== "restore") return
  const r = await adbRaw(["-s", state.serial, "shell", "ime", "set", state.tvImeOwn])
  if (!r.ok) return
  setKeyboardState(state.tvImeOwn)
  pushLog(`⌨ TV keyboard back to ${keyboardName(state.tvImeOwn)}`)
}

/** A short name for an input method id, for the log and the panel. */
function keyboardName(ime) {
  if (!ime) return "unknown"
  if (ime.includes("tcl.inputmethod")) return "TCL"
  if (ime.includes("inputmethod.latin")) return "Gboard"
  return ime.split("/")[0].split(".").pop()
}

/**
 * Switch the TV's own keyboard for one that passes injected keys through.
 *
 * Measured on the TCL: with its own keyboard an injected "hello" arrives as
 * "hell" and "helloworld" as "hellzorld" — the AZERTY remap plus repeated keys
 * being swallowed. With the stock keyboard the same injections arrive verbatim,
 * so this is the fix for typing, not a translation table. It is a TV-wide
 * setting, so it is only ever done when asked for, and can be undone the same way.
 */
async function switchTvKeyboard() {
  if (!state.serial || state.demo) return
  const back = state.tvImeClean
  const target = back ? state.tvImeOwn : CLEAN_IME
  if (!target) {
    pushLog("⌨ this TV is already answering with the keyboard text needs")
    update()
    return
  }
  await adbRaw(["-s", state.serial, "shell", "ime", "enable", target])
  const r = await adbRaw(["-s", state.serial, "shell", "ime", "set", target])
  if (!r.ok) {
    pushLog(`✗ could not change the TV's keyboard — ${firstLine(r.err || r.out)}`)
    update()
    return
  }
  state.tvImeManual = !back // pinning the borrowed keyboard is what i is for
  pushLog(
    back
      ? `⌨ TV keyboard back to ${keyboardName(target)} — switching while sending resumes`
      : `⌨ TV pinned to ${keyboardName(target)} — text arrives as typed`,
  )
  setKeyboardState(target)
  mirror.known = false
}

/** Warn when the text asks for characters the TV's keyboard cannot produce. */
function noteUntypeable(text) {
  // BYPASS (companion route): the warning is about `input`'s key positions, and
  // commitText does not use any — the characters this warns about (everything
  // behind AltGr on AZERTY) arrive verbatim over the companion.
  if (typingPath().route === "companion") return
  const missing = untypeable(text, effectiveLayout())
  if (!missing.length) return
  pushLog(`⚠ the TV's keyboard cannot type ${missing.map((c) => `"${c}"`).join(", ")} — it will show something else`)
}

/**
 * Read the TV's field for the mirror, on whichever route is carrying text.
 *
 * The adb route reads through `uiautomator dump` (src/mirror.mjs) and needs both
 * of that module's compensations: the dump catches a PREFIX of an animated field
 * (measured again on SmartTube: "hello" read back as "hell") and an empty field
 * reports its own hint as its text ("Rechercher").
 *
 * The companion route reads through the IME's own InputConnection FIRST, and the
 * dump stays as the fallback behind it. Two measurements decide that order:
 *
 *   - cost: 4.5-5.4 ms for `read extracted` against ~2.5 s for a dump;
 *   - and the dump is not merely slow here, it is unusable. Measured on the TCL:
 *     a monkey JVM resident but never dialled -> dump rc=0 in 2.4 s; the same
 *     monkey with ONE command sent over its socket -> dump rc=137 ("Killed") in
 *     0.97 s. The app drives keys over monkey, so from the first keypress of a
 *     session the TV's single UiAutomation slot is taken and the dump dies. The IME
 *     needs none of that, which makes it the only reader that works while monkey
 *     is in use.
 *
 * The IME answers with the field's content only yes/no (no keycodes, no hint), which
 * is exactly what the mirror wants: a commit's full content is present at +6..17 ms
 * while the field has painted nothing yet, and a read mid-reveal returns a prefix —
 * so one read of the field's content is the correct read there (the dump's second
 * read and hint filtering buy nothing and are not applied), and an EMPTY streamed
 * field answers content "" rather than wearing "Rechercher".
 *
 * `read extracted` answering `extracted_text_null` is the one other thing it can
 * say, and it means the focused field is gone — an answer about the field, not a
 * failed read, so it is reported as such instead of asking the dump the same
 * question 2.5 s later (and being killed for asking).
 *
 * A read that fails for any other reason is not evidence about the field, so it
 * falls back to the dump instead of reporting the field as gone.
 *
 * What the adb route does about the slot: nothing here — this function only reports
 * the dump's own verdict (rc=137 included, see dumpFailure). Giving the dump the slot
 * it needs is probeField's job, because that means stopping monkey, and a transport
 * decision belongs at the one place that chooses between transports.
 */
async function readMirrorField() {
  if (probeFailures > 0) {
    // Test hook (TV_REMOTE_MIRROR_FAIL_PROBES): pretend this read failed, so the
    // retry path can be exercised against a TV whose reads are working.
    probeFailures -= 1
    const error = `forced field-read failure (rc=137), ${probeFailures} left to force`
    pushLog(`ℹ ${error}`)
    return { ok: false, error, killed: true, via: "forced" }
  }
  const path = typingPath()
  if (path.route === "companion") {
    // The companion's IME is what reads the field, and it is only ours to read while
    // it is the TV's selected method: `ensureCompanionIme` takes it (and says so in
    // the log). While mirror mode is what is active it stays taken — see
    // holdCompanionIme — so a probe is 5 ms rather than a 0.35 s re-selection.
    if (await ensureCompanionIme(path.device)) {
      holdCompanionIme()
      const r = await readCompanion(path.device, { mode: "extracted" })
      if (r.ok && r.reply?.ok) {
        return { ok: true, text: typeof r.reply.text === "string" ? r.reply.text : "", via: "ime" }
      }
      const why = firstLine(r.reply?.error ?? r.error ?? "no answer")
      if (why === "extracted_text_null") return { ok: false, error: "no text field is on screen", via: "ime" }
      pushLog(`ℹ companion read — ${why}; reading the field with a dump`)
    }
  }
  const d = await readField(state.serial)
  return { ...d, via: "dump" }
}

// How many field reads to force into failure (0 in normal use). See readMirrorField.
let probeFailures = Number(process.env.TV_REMOTE_MIRROR_FAIL_PROBES ?? 0) || 0

/**
 * The next field read, armed from BOTH probe paths: a success schedules the periodic
 * refresh, a failure its retry. Only armed while mirror mode is what is on screen, and
 * re-arming replaces any pending one.
 *
 * Arming from the success path alone was the bug this card is about: one failed read
 * at start-up left nothing armed, so the field was never read again for the session
 * and every keystroke was dropped without a word.
 */
let probeTimer = null
function armProbe(ms) {
  if (probeTimer) clearTimeout(probeTimer)
  probeTimer = null
  if (state.demo || state.sendMode !== "mirror" || state.module !== "text") return
  probeTimer = setTimeout(() => {
    probeTimer = null
    if (state.sendMode === "mirror" && state.module === "text") enqueue(probeField)
  }, ms)
}

/**
 * One line for a failed read: what happened, what it costs, and when the retry is.
 *
 * `handedBack` says the read had already been given the slot (monkey stopped), so
 * the slot cannot be the explanation any more — which is worth saying, because a dump
 * that is still SIGKILLed with monkey out of the way is a new fact about the TV.
 */
function probeFailureNote(r, failures, waitMs, handedBack = false) {
  const seen = failures > 1 ? `, try ${failures}` : ""
  // A dump that came back SIGKILLed is a fact about the TV's UiAutomation slot, not
  // about the field — and monkey is what holds it.
  const slot = !r.killed
    ? ""
    : handedBack
      ? "; the dump was killed even with monkey stopped and the slot handed back"
      : monkeyInfo().state === "alive"
        ? "; monkey holds the TV's UI automation slot, so the dump cannot run while keys go over it"
        : "; no monkey of ours is alive, so the slot is held by a JVM this session is not driving"
  const typing = mirror.known
    ? "typing carries on against the field last read"
    : "mirror mode cannot type until a read lands"
  return `could not read the TV's field (${firstLine(r.error)}${seen}${slot}) — retrying in ${(waitMs / 1000).toFixed(1)}s; ${typing}`
}

/**
 * Read the TV's field. Cheap enough to do on entry, after OK, and periodically.
 *
 * On the adb route the reader is `uiautomator dump`, and the TV has ONE UiAutomation
 * slot: monkey takes it on its first command, so from the first keypress of a session
 * the dump is SIGKILLed (rc=137, measured) and the mirror had no reader at all. The
 * slot is therefore lent to the read: monkey is stopped (which kills the device-side
 * JVM and frees the slot at once), the field is read, and monkey is brought back on a
 * fresh port. Measured on the TCL: stop 105-132 ms, read 6.4 s, restart 1.3-1.5 s (2.9 s
 * once, under load) — 8.0 s per handoff, which is why it is only paid once the TV has
 * said the dump needs it (src/mirror.mjs#needsSlotHandoff) and why reads that pay it are
 * spread out (MIRROR_REFRESH_SLOT_MS).
 *
 * The stop happens here, on the call chain, and the read plus the restart run on their
 * own continuation. Awaiting the whole handoff here would hold the key path for the
 * 8 s — a key pressed during a probe would arrive 8 s late. Out on its own the monkey
 * is simply gone, so those keys fall back to `input keyevent` (1.2-1.6 s each, the
 * transport's own fallback) and land when they are pressed; the price is that an edit
 * can interleave with the read, which applyFieldRead drops.
 */
async function probeField() {
  if (!state.serial || state.demo || state.sendMode !== "mirror") return
  // One handed-back read at a time: it is what arms the next probe when it finishes.
  if (slotRead) return
  if (monkeyHoldsSlot() && needsSlotHandoff(slotHandoff)) {
    const released = await releaseSlot("a mirror field read")
    if (released.held) {
      const seq = editSeq
      slotPaused = true
      pushLog(`· slot: monkey stopped (port ${released.port}, ${released.ms} ms) — reading the TV's field with the slot free`)
      update()
      slotRead = (async () => {
        const r = await readMirrorField()
        if (slotPaused) {
          const back = await reclaimSlot({ serial: state.serial, onStep: monkeyStep })
          slotPaused = false
          pushLog(
            back.ok
              ? `· slot: monkey back on port ${back.port} in ${back.ms} ms — keys over monkey again`
              : `✗ slot: monkey did not come back (${firstLine(back.detail)}) — keys stay on adb`,
          )
        } else {
          // Something stopped monkey deliberately while the read was out (the TV was
          // powered off, the device changed): leave it stopped.
          pushLog("· slot: monkey was stopped on purpose — left off")
        }
        applyFieldRead(r, { seq, handedBack: true })
      })()
      // The continuation owns its own errors: nothing downstream awaits it.
        .catch((e) => pushLog(`✗ slot read — ${firstLine(e?.message ?? e)}`))
        .finally(() => {
          slotRead = null
          slotPaused = false
          update()
        })
      return
    }
  }
  let r = await readMirrorField()
  // A dump the TV killed while no monkey of ours is alive has nothing to hand back
  // from: the slot belongs to a monkey JVM this session is not driving, and killing it
  // is the only way the next read can work (see mirror.mjs#killedDumpRecovery).
  if (killedDumpRecovery({ killed: r.killed, monkeyAlive: monkeyHoldsSlot() }) === "clear-strays") {
    const cleared = await clearStrayMonkeys(state.serial)
    if (cleared.killed) {
      pushLog(`· slot: ${cleared.detail} — re-reading the TV's field`)
      update()
      r = await readMirrorField()
    }
  }
  applyFieldRead(r, { seq: editSeq })
}

/**
 * Take one read's verdict into the model: the mirror's idea of the field, the log,
 * the retry, and what the session now knows about the TV's UiAutomation slot.
 *
 * `seq` is the edit count the read started at. Only a handed-back read can be stale
 * like that — it runs outside the call chain, so an edit that landed while it was in
 * flight has already moved the field on, and its answer is no longer evidence about
 * it. Dropping it (and re-reading) is what keeps the model from going backwards; a
 * read in the chain can never see this.
 */
function applyFieldRead(r, { seq = editSeq, handedBack = false } = {}) {
  if (seq !== editSeq) {
    pushLog("ℹ the field was edited while a read was in flight — re-reading it")
    update()
    if (!slotRead) enqueue(probeField)
    return
  }
  const alive = monkeyHoldsSlot()
  if (!r.ok) {
    // The forced-failure test hook says nothing about this TV, so it must not teach
    // the session that the dump needs the slot handed back.
    if (r.via !== "forced") {
      slotHandoff = slotKnowledge(slotHandoff, { ok: false, killed: !!r.killed, monkeyAlive: alive, handedBack })
    }
    mirror.failures += 1
    const wait = probeRetryMs(mirror.failures)
    pushLog(`ℹ ${probeFailureNote(r, mirror.failures, wait, handedBack)}`)
    update()
    armProbe(wait)
    return
  }
  slotHandoff = slotKnowledge(slotHandoff, { ok: true, killed: false, monkeyAlive: alive, handedBack })
  mirror.failures = 0
  mirror.notedUnknown = false
  let text = r.text
  let shownHint = false
  if (r.via === "ime") {
    // The IME read is the field's content, never its placeholder, and it is
    // complete when it answers: the hint list and the second read have nothing
    // left to do here, and applying them could only corrupt a field that really
    // does hold the word "rechercher". Nothing to learn either — an empty field
    // answers "" rather than wearing a hint.
    learnHint = false
  } else {
    // A field we just emptied tells us what it uses to say "empty".
    if (learnHint && text.trim()) {
      hints.add(text.trim().toLowerCase())
      learnHint = false
    }
    text = stripPlaceholder(text, hints)
    shownHint = text !== r.text
  }
  // Never clobber local text the user has typed but not sent yet.
  const dirty = textInput.value !== mirror.text
  mirror.known = true
  mirror.text = text
  mirror.probedAt = Date.now()
  if (dirty) {
    pushLog(`ℹ the TV field moved on — holding ${textInput.value.length} local char(s)`)
    // Unless the box is the only place that text exists: keystrokes that arrived while
    // the field was unknown were dropped (syncMirror), and the sync they were owed is
    // paid now that the field can be diffed again.
    if (mirror.pending) {
      mirror.pending = false
      pushLog(`✓ field readable again — sending the ${textInput.value.length} local char(s) it was holding`)
      scheduleSync()
    }
  } else {
    mirror.caret = text.length
    state.caret = text.length
    textInput.value = text
    pushLog(
      (shownHint ? `✓ TV field is empty (it shows its hint "${r.text}")` : `✓ TV field holds ${text.length} char(s)`) +
        ` [${r.via}${handedBack ? " · slot handed back" : ""}]`,
    )
  }
  update()
  armProbe(alive && needsSlotHandoff(slotHandoff) ? MIRROR_REFRESH_SLOT_MS : MIRROR_REFRESH_MS)
}

/** Where the caret lands after a local change, derived from the change itself. */
function caretAfterChange(before, after) {
  let p = 0
  while (p < before.length && p < after.length && before[p] === after[p]) p += 1
  return after.length > before.length ? p + (after.length - before.length) : p
}

/** Send the local text as the shortest edit the TV needs. */
async function syncMirror() {
  if (state.sendMode !== "mirror" || !state.serial || state.demo) return
  if (!mirror.known) {
    // Nothing probed yet: do not guess at the field's contents — but do not go quiet
    // either. Every keystroke that arrives here used to be dropped with no error shown
    // and no re-read armed, which is how one failed probe at start-up turned the text
    // module into a local-only text box. Remember that the box holds text the TV has
    // not been told about (the next successful probe pays that sync) and put a read back
    // on the wire if none is already on its way.
    mirror.pending = true
    if (!mirror.notedUnknown) {
      mirror.notedUnknown = true
      pushLog("ℹ the TV's field has not been read yet — holding your text here and re-reading now")
      update()
    }
    if (!probeTimer) enqueue(probeField)
    return
  }
  const desired = textInput.value
  if (desired !== mirror.text) {
    const plan = planEdit(mirror.text, desired)
    await ensureCleanKeyboard()
    const res = await applyPlan(state.serial, plan, {
      layout: effectiveLayout(),
      // Text goes through the typing route; the caret and delete calls stay adb
      // keyevents, which the companion has no verb for (and none is needed: a DEL
      // burst is one call, not one per character).
      insert: (value) => insertText(value, { expect: desired }),
    })
    releaseKeyboardSoon()
    if (res.ok) {
      mirror.text = desired
      mirror.caret = plan.caretTo
      state.caret = plan.caretTo
      // The field just moved: a handed-back read that started before this landed (see
      // applyFieldRead) is no longer evidence about it.
      editSeq += 1
      pushLog(`✓ TV field ← ${res.labels.join("  ") || "no change"} [${res.route ?? "keys"}]`)
      // An edit that removed text leaned on our idea of what the field held, so
      // read it back and correct the model if the TV disagreed.
      // An edit that emptied the field teaches us its hint text on the next read.
      if (desired === "") learnHint = true
      if (plan.removeLength > 0 || res.drifted) {
        mirror.probedAt = 0
        enqueue(probeField)
      }
    } else {
      pushLog(`✗ edit failed — ${firstLine(res.error)}`)
      mirror.probedAt = 0
      enqueue(probeField)
    }
    update()
    return
  }
  const delta = state.caret - mirror.caret
  if (delta) {
    const res = await moveCaret(state.serial, delta)
    if (res.ok) {
      mirror.caret = state.caret
      pushLog(`✓ TV caret ${delta > 0 ? "+" : ""}${delta}`)
    }
    update()
  }
}

/** Sync first, then a key, so navigation never overtakes the text. */
function enqueueAfterSync(part) {
  if (syncTimer) {
    clearTimeout(syncTimer)
    syncTimer = null
  }
  enqueue(syncMirror)
  enqueuePart(part)
}

// ---------------------------------------------------------------- batching
// Sending is the slow part, and it is the TV that is slow, not the network: a
// shell round trip measures 0.07s here, but every `input` invocation starts a
// JVM on the device and costs about 1.7s. A call per keystroke therefore makes
// typing unusable.
//
// So: when nothing is on the wire, send at once (a single key press gains no
// latency at all), and gather everything pressed while the device is busy into
// one call. No delay timer — the 1.7s the TV takes to answer *is* the batching
// window. The echo is applied on the key press, never on the reply, so the
// display never trails the fingers.
const pending = { parts: [], inFlight: 0 }

/** Queue text or a keycode, merging into the neighbouring part of the same kind. */
function enqueuePart(part) {
  const last = pending.parts[pending.parts.length - 1]
  if (part.text !== undefined) {
    if (last && last.text !== undefined) last.text += part.text
    else pending.parts.push({ text: part.text })
  } else if (last && last.codes) {
    last.codes.push(part.code)
    last.label = part.label
  } else {
    pending.parts.push({ codes: [part.code], label: part.label })
  }
  if (pending.inFlight === 0) flushPending()
}

/** Send everything gathered, in order, as one call per run of the same kind. */
function flushPending() {
  const parts = pending.parts.splice(0)
  for (const part of parts) {
    if (part.text !== undefined) sendText(part.text)
    else sendKey(part.codes, part.label)
  }
}

/** One device call finished: anything typed meanwhile goes out now, in one call. */
function sendDone() {
  pending.inFlight = Math.max(0, pending.inFlight - 1)
  if (pending.inFlight === 0 && pending.parts.length) flushPending()
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

function cycleLayout() {
  const order = ["auto", "azerty", "qwerty"]
  state.layout = order[(order.indexOf(state.layout) + 1) % order.length]
  pushLog(`⌨ keyboard override: ${state.layout.toUpperCase()}`)
  update()
}

function setSendMode(mode) {
  state.sendMode = mode
  if (mode === "mirror") {
    mirror.known = false
    enqueue(probeField)
  } else {
    // Mirror mode is what borrows the companion's IME for its reads; leaving it hands
    // the TV its keyboard back rather than holding a lease nothing needs.
    releaseMirrorIme()
  }
  update()
}

function focusModule(name) {
  state.module = name
  if (name === "text" && state.sendMode === "mirror") enqueue(probeField)
  else if (name !== "text") releaseMirrorIme()
  update()
}

function cycleModule(step) {
  const i = MODULES.indexOf(state.module)
  focusModule(MODULES[(i + step + MODULES.length) % MODULES.length])
}

function update() {
  // The setup screen owns the whole window while it is up: its own header, step
  // list and footer, none of which are the remote's or the device list's.
  if (state.screen === "setup") return updateSetup()

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
    const tag = companionTag()
    headerPath.content = `   ·   ${tag.word}`
    headerPath.fg = tag.fg
  } else if (state.screen === "apps") {
    const probing = state.appsProbing || state.procsProbing
    const shown = visibleApps()
    headerDot.content = probing ? "◌" : "●"
    headerDot.fg = probing ? C.warn : C.ok
    headerText.content =
      `${state.deviceLabel || state.serial}   ·   ${shown.length} app(s)` +
      `   ·   ${state.procs.size} running on the TV   ·   ${FILTER_LABEL[state.appsFilter]}` +
      `   ·   ${probing ? "probing the TV…" : `probed ${timeAgo(state.appsAt)}`}`
    headerBox.borderColor = probing ? C.warn : C.faint
    headerPath.content = ""
  } else if (state.screen === "apk") {
    const b = state.apkBrowse
    headerDot.content = "●"
    headerDot.fg = C.accent
    headerText.content =
      `${state.deviceLabel || state.serial || "no device"}   ·   APK on this machine   ·   ` +
      `${b ? `${tildePath(b.dir)}` : ""}`
    headerBox.borderColor = C.faint
    headerPath.content = b?.apkCount ? `   ·   ${b.apkCount} apk(s) here` : ""
    headerPath.fg = b?.apkCount ? C.ok : C.faint
  } else {
    headerDot.content = "○"
    headerDot.fg = C.faint
    headerText.content = "no device selected — pick one below"
    headerBox.borderColor = C.faint
    headerPath.content = ""
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
  const appList = visibleApps()
  const appOff = appsWindow(appList)
  appsRows.forEach((row, i) => {
    const a = appList[appOff + i]
    if (!a) {
      row.visible = false
      row.content = ""
      return
    }
    const index = appOff + i
    row.visible = true
    const mark = index === state.appsSel ? "▸ " : "  "
    // The liveness column: ● = a live process, · = not running. It says what the
    // row would stop, before the key is pressed.
    const live = a.running ? "●" : "·"
    const where = a.label === a.pkg ? "" : `   ${a.pkg}`
    const what = a.noLauncher ? "   no launcher — k stops it" : ""
    row.content = `${mark}${a.user ? "★" : "○"} ${live} ${a.label}${where}${what}`
    row.fg = index === state.appsSel ? C.hot : a.user ? C.text : C.dim
  })
  appsNote.content = appsNoteText(appList)

  // ---- APK picker rows: directories to walk into, `*.apk`s to install
  if (state.apkBrowse) {
    const b = state.apkBrowse
    const off = apkWindow()
    apkDirLine.content = `${tildePath(b.dir)}/`
    apkRows.forEach((row, i) => {
      const e = b.entries[off + i]
      if (!e) {
        row.visible = false
        row.content = ""
        return
      }
      const index = off + i
      row.visible = true
      const mark = index === b.sel ? "▸ " : "  "
      row.content =
        e.kind === "dir" ? `${mark}${e.name}/` : `${mark}${e.name}   ${sizeLabel(e.size)}`
      row.fg = index === b.sel ? C.hot : e.kind === "dir" ? C.dim : C.text
    })
    apkNote.content =
      b.note ||
      (b.truncated ? `${b.truncated} more entr(ies) not shown` : "") ||
      (b.entries.length
        ? `${b.entries.length - b.apkCount} dir(s), ${b.apkCount} apk(s) — ⏎ opens a directory / installs an APK`
        : "no subdirectories and no .apk here — ⌫ or h to go elsewhere, p to type a path")
  }

  addrLabel.visible = state.addrOpen
  addrInput.visible = state.addrOpen
  if (state.addrOpen && state.screen === "devices") addrInput.focus()

  apkLabel.visible = state.apkOpen
  apkInput.visible = state.apkOpen
  if (state.apkOpen && state.screen === "apps") apkInput.focus()

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

    const mode = state.sendMode
    fieldBadge.content = `MODE: ${mode.toUpperCase()}`
    fieldBadge.fg = mode === "instant" ? C.warn : mode === "mirror" ? C.ok : C.dim
    echoText.content = instant ? `› ${state.echo || "…"}` : ""
    textHint.content = instant ? "⌫ = DEL" : ""

    sendMirrorText.content = `${mode === "mirror" ? "●" : "○"} Mirror — the TV's field, edited here`
    sendBlockText.content = `${mode === "block" ? "●" : "○"} Block — ⏎ sends the string`
    sendInstantText.content = `${mode === "instant" ? "●" : "○"} Instant — one key at a time`
    sendKeysText.content =
      `⌨ TV keyboard: ${keyboardName(state.tvIme)} ${state.tvKeyboard.toUpperCase()}` +
      (state.tvImeManual ? "   i unpins" : "   auto while sending (i pins)") +
      (state.layout === "auto" ? "" : `  forced ${state.layout.toUpperCase()}`)
    sendKeysText.fg = state.tvImeClean ? C.ok : C.warn
    sendMirrorText.fg = mode === "mirror" ? C.ok : C.dim
    sendBlockText.fg = mode === "block" ? C.ok : C.dim
    sendInstantText.fg = mode === "instant" ? C.ok : C.dim

    histText.content = state.log.length ? state.log.slice(0, 8).join("\n") : "—"
  }

  // ---- footer: context-sensitive for the focused module
  if (state.screen === "apk") {
    footerHints.content =
      "↑ ↓ select    ⏎ open a directory / install the APK    ⌫ up a level    h home    p type a path    Esc back to the app list"
    const b = state.apkBrowse
    footerStatus.content = b
      ? `${tildePath(b.dir)}${b.note ? `        ${b.note}` : ""}${state.log[0] ? `        ${state.log[0]}` : ""}`
      : "reading the directory…"
    return
  }
  if (state.screen === "apps") {
    footerHints.content = state.apkOpen
      ? "Type the path to an APK then ⏎        Esc = cancel"
      : "↑ ↓ select    ⏎ launch    k stop (task manager)    f filter    i pick an APK    r re-probe    l / Esc back    d devices"
    const shown = visibleApps()
    footerStatus.content =
      `${shown.length} app(s) shown   ·   ${FILTER_LABEL[state.appsFilter]}` +
      `${state.log[0] ? `        ${state.log[0]}` : ""}`
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

  // Cursor mode owns the footer while it is on: the TV renders no pointer, so this
  // readout is the only place the position is visible at all.
  if (state.cursor.on) {
    const c = state.cursor
    footerHints.content =
      `◉ CURSOR MODE — pointer ${cursorLine(c.pointer)}        move the mouse        ` +
      `left click = tap on the TV        m / Esc releases`
    footerStatus.content =
      `the TV draws no cursor of its own for these events, so this position is the feedback` +
      `        ${c.clicks} click(s), ${c.moves} move(s)` +
      (c.lastTap ? `        last tap ${c.lastTap.x},${c.lastTap.y} in ${c.lastTap.ms} ms via ${c.lastTap.via}` : "") +
      `${state.log[0] ? `        ${state.log[0]}` : ""}`
    return
  }

  footerHints.content =
    `MODULE ${MODULES.indexOf(state.module) + 1}/${MODULES.length} — ${MODULE_TITLES[state.module]}` +
    `        Tab / Shift+Tab switch module        1-4 jump`
  const detail =
    state.module === "dpad"
      ? "arrows drive the TV      ⏎ = OK      ⌫ / b = Back      h = Home      w = wake      s = sleep      p = toggle      l = apps      c = companion probe      m = cursor mode"
      : state.module === "volume"
        ? "↑ ↓ change the TV volume      ← → switch module      − + also work"
        : state.module === "text"
          ? state.sendMode === "mirror"
            ? "type: the TV's field is edited as you pause      ↑ ↓ fields      ⏎ = OK      Esc empties it"
            : instant
              ? "type: every character is sent to the TV      ⌫ = DEL      Tab moves on"
              : "type your text      ⏎ sends it      ⌫ edits      ← → move the cursor"
          : "↑ ↓ or ← → choose the send mode      ⏎ toggles      i = fix the TV's keyboard      k = force the layout"
  footerStatus.content = `${detail}        last sent: ${state.lastSent}`
}

// ---------------------------------------------------------------- APK picker
// Reading a directory is a synchronous listing: a few hundred names is
// sub-millisecond, so there is nothing here worth an async round trip and a
// "reading…" state — except that the filesystem can refuse, which is what the
// note line and the `note` field carry.

/** First row of the picker list to render, so the selection stays on screen. */
function apkWindow() {
  const n = state.apkBrowse?.entries.length ?? 0
  if (n <= apkRows.length) return 0
  return Math.max(0, Math.min(n - apkRows.length, state.apkBrowse.sel - Math.floor(apkRows.length / 2)))
}

/**
 * Show `dir`. A directory that cannot be read (permissions, removed under us)
 * leaves the previous one on screen and says what the filesystem said — an
 * unreadable directory must not look like an empty one.
 */
function showDir(dir) {
  const listing = listDir(dir)
  if (!listing.ok) {
    if (state.apkBrowse) state.apkBrowse.note = `✗ ${listing.error}`
    else state.apkBrowse = { ...listing, sel: 0, note: `✗ ${listing.error}` }
    return false
  }
  state.apkBrowse = { ...listing, sel: 0, note: "" }
  return true
}

/** `i` on the app list: start the walk where the app was launched from. */
function openApkPicker() {
  showDir(state.apkBrowse?.dir ?? process.cwd())
  setScreen("apk")
}

function handleApkKey(key, name) {
  const b = state.apkBrowse
  if (!b) {
    setScreen("apps")
    return
  }
  const letter = keyLetter(name)

  if (name === "up" || name === "down") {
    const n = b.entries.length
    if (n) b.sel = Math.min(n - 1, Math.max(0, b.sel + (name === "down" ? 1 : -1)))
    update()
    key.stopPropagation()
    return
  }
  if (name === "return") {
    const entry = b.entries[b.sel]
    if (!entry) return
    if (entry.kind === "dir") {
      showDir(entry.path)
      update()
    } else {
      // Straight back to the app list, where installFromPath() already reports
      // progress and the device's verdict — one install path, not two.
      setScreen("apps")
      installFromPath(entry.path)
    }
    key.stopPropagation()
    return
  }
  if (name === "backspace" || name === "left") {
    showDir(parentDir(b.dir))
    update()
    key.stopPropagation()
    return
  }
  if (letter === "h") {
    showDir(homedir())
    update()
    key.stopPropagation()
    return
  }
  if (letter === "p") {
    // The typed/pasted path, exactly as before: the picker is a way to choose a
    // file, not the only way to name one.
    state.apkOpen = true
    setScreen("apps")
    key.stopPropagation()
    return
  }
  if (name === "escape") {
    setScreen("apps")
    key.stopPropagation()
  }
}

function setScreen(name) {
  flushPending() // nothing typed should be stranded by a screen change
  // Leaving the remote ends the mirror's lease on the companion IME with it.
  if (name !== "remote") releaseMirrorIme()
  // ...and cursor mode goes with the screen it belongs to: it swallows the mouse
  // (preventDefault), which on the app list would break clicking a row.
  if (name !== "remote" && state.cursor.on) {
    state.cursor.on = false
    state.cursor.last = null
    pushLog("· cursor mode off — left the remote screen")
  }
  state.screen = name
  for (const child of [...main.getChildren()]) main.remove(child)
  main.add(
    name === "devices"
      ? devicesCol
      : name === "apps"
        ? appsCol
        : name === "apk"
          ? apkCol
          : name === "setup"
            ? setupCol
            : bodyRow,
  )
  update()
}

// ---------------------------------------------------------------- actions
/** `adb input keyevent` takes several codes at once, so a burst is one call. */
function sendKey(code, label) {
  const codes = Array.isArray(code) ? code : [code]
  const what = codes.length > 1 ? `${label} x${codes.length}` : label
  const volume = codes.some((c) => c === KEY.VOL_UP || c === KEY.VOL_DOWN)

  if (state.demo) {
    // Offline mode for UI work: no adb, but the UI reacts as if it worked.
    state.busy = true
    update()
    if (volume) {
      // One keyevent == one step on the real TV (measured: 22 → 23).
      const step = codes.filter((c) => c === KEY.VOL_UP).length - codes.filter((c) => c === KEY.VOL_DOWN).length
      const next = (state.volume ?? 0) + step
      state.volume = Math.max(0, Math.min(state.volumeMax, next))
      pushLog(`✓ ${state.volume} / ${state.volumeMax}`)
    } else {
      pushLog(`✓ ${what}`)
    }
    state.busy = false
    state.lastSent = what
    update()
    return
  }
  pending.inFlight += 1
  enqueue(async () => {
    try {
      state.busy = true
      update()
      const r = await sendCodes(codes)
      state.busy = false
      state.lastSent = what
      const how = `${r.route}${r.ms === undefined ? "" : ` ${r.ms.toFixed(1)} ms`}`
      pushLog(r.ok ? `✓ ${what} — ${how}` : `✗ ${what} — ${firstLine(r.err)}`)
      if (volume) {
        const v = await musicVolume(state.serial)
        if (v.ok) {
          state.volume = v.volume
          if (v.max) state.volumeMax = v.max
          pushLog(`✓ ${state.volume} / ${state.volumeMax}`)
        }
      }
    } finally {
      sendDone()
    }
    update()
  })
}

// ---------------------------------------------------------------- key route
// Keys have two transports and this is where one is chosen. monkey's socket
// answers a key in ~4 ms (src/monkey.mjs owns its whole lifecycle); `input
// keyevent` costs 1.2-1.6 s per call because it starts an ART VM on the TV, and
// stays as the fallback — if monkey is not up, or dies mid-session, the same
// codes go out over adb rather than the key being lost.
//
// Nothing here batches monkey keys: at 4 ms there is no window worth gathering
// through, so each press is its own `press <code>` and the queue hop above (one
// call in flight, ~5 ms) is the whole delay. The adb path's batching stays as it
// was — 1.2 s per call still needs it, and DEL/MOVE_END bursts still use it.
//
// Resending on adb after a monkey failure can duplicate a key that was in fact
// delivered but whose reply was lost (a timeout is 80x the measured round trip).
// Duplicating a D-pad step occasionally is the cheaper failure for a remote: a
// key the user pressed and the TV never saw is the worse one.

/** One key burst: monkey when it owns these codes, adb otherwise and after a failure. */
async function sendCodes(codes) {
  if (monkeyOwnsKeys(codes) && monkeyInfo().state === "alive") {
    const r = await monkeyKeys(codes)
    if (r.ok) return { ok: true, route: "monkey", ms: r.ms }
    pushLog(`✗ monkey — ${firstLine(r.error)}; key over adb`)
    update()
  }
  // The fallback is timed too: the log line is where the difference shows.
  const started = process.hrtime.bigint()
  const r = await keyevent(state.serial, codes)
  const ms = Number(process.hrtime.bigint() - started) / 1e6
  return { ok: r.ok, route: "adb", err: r.err, out: r.out, ms }
}

/** Log lines from the transport itself: a restart happens without a keypress. */
function monkeyStep(line) {
  pushLog(`· ${line}`)
  update()
}

/** Bring the socket up for the device being driven (idempotent per device). */
function startMonkeyFor({ force = false } = {}) {
  if (state.demo || !state.serial) return
  enqueue(async () => {
    const res = await ensureMonkey({ serial: state.serial, onStep: monkeyStep, force })
    pushLog(
      res.ok
        ? `✓ keys over monkey — device port ${res.port}, local ${res.localPort}, ${res.ms} ms to start`
        : `✗ monkey — ${firstLine(res.detail)}; keys stay on adb`,
    )
    update()
  })
}

/** Hand the socket and the device-side JVM back (this TV has 2 GB and is shared). */
function stopMonkeyFor(reason) {
  // A deliberate stop wins over the continuation of a handed-back read (see
  // slotPaused) — including when monkey is already down for that read, which is why
  // this is cleared before the early return.
  slotPaused = false
  if (monkeyInfo().state === "off") return
  enqueue(async () => {
    await stopMonkey(reason)
    pushLog(`· monkey stopped — ${reason}`)
    update()
  })
}

// ---------------------------------------------------------------- cursor mode
//
// A shortcut (`m`) turns this machine's mouse into a pointer on the TV, and the
// same key releases it. Two measured facts decide the whole shape:
//
//   1. THE TV DRAWS NO POINTER for events injected over monkey. They are
//      touchscreen-sourced, not mouse-sourced, and a bare `touch move <x> <y>`
//      is dropped by the input pipeline (byte-identical frames, with the
//      framework's touch indicator and pointer-location overlays on).
//   2. `tap <x> <y>` DOES land: 16.25 ms, 61/s, and it activated a real target
//      (a video tile in SmartTube, a button in the companion's own activity).
//
// So the position is kept here and shown in the footer, mouse movement costs
// nothing on the wire, and a click is one tap at the position. Holding a touch
// down to make the TV's own overlay follow the mouse was rejected: it would drag
// whatever is under it (lists scroll, seek bars move) on every mouse move.
//
// The events come from OpenTUI's hit grid; `renderer.root` is the ancestor of
// every panel, so it sees the whole window's mouse traffic (bubbling), and its
// handler runs for events nothing else wants.

/** One click at a time, and only the freshest: a queue would act on positions the user has already left. */
let tapInFlight = null
let tapNext = null

/** `m` — enter cursor mode, or leave it. The SAME key both ways, as asked. */
function toggleCursorMode() {
  const c = state.cursor
  if (state.demo || !state.serial) {
    pushLog("✗ cursor mode needs a connected TV")
    update()
    return
  }
  c.on = !c.on
  if (c.on) {
    // Start in the middle of the panel, so the first click is never a surprise
    // somewhere the user did not aim at.
    c.pointer = createCursor()
    c.last = null
    c.moves = 0
    c.clicks = 0
    c.lastTap = null
    const reach = cursorReach()
    pushLog(
      `◉ cursor mode ON — pointer at ${cursorLine(c.pointer)}; the TV draws no cursor of its own, ` +
        `so this position IS the feedback`,
    )
    pushLog(
      `· move the mouse: ${reach.slowPx} px per cell, ${reach.flickPx} px for a 6-cell flick ` +
        `(${reach.slow} cells of slow movement, ${reach.flick} of flicking, to cross the panel)`,
    )
  } else {
    const last = c.lastTap
    pushLog(
      `· cursor mode off — ${c.clicks} click(s), ${c.moves} move(s)` +
        (last ? `; last tap ${last.x},${last.y} in ${last.ms} ms via ${last.via}` : ""),
    )
  }
  update()
}

/**
 * Every mouse event the renderer hands us, while the mode is on. `onMouse` on the
 * root gets the bubbled event whatever cell it hit; `preventDefault` keeps the
 * toolkit out of it (no focus jump, no text selection) because here the mouse
 * belongs to the TV, not to the terminal.
 */
function handleCursorMouse(event) {
  const c = state.cursor
  if (!c.on) return
  const type = event?.type
  if (type !== "move" && type !== "drag" && type !== "down" && type !== "up") return
  event.preventDefault?.()

  const last = c.last
  c.last = { x: event.x, y: event.y }
  // A delta needs a previous cell, so the first event of a session only parks
  // the mouse: moving by the whole screen on the first twitch is not a pointer.
  if (last && (type === "move" || type === "drag" || type === "down")) {
    const step = cursorMove(c.pointer, event.x - last.x, event.y - last.y)
    if (step.dx || step.dy) c.moves += 1
  }
  if (type === "down" && event.button === 0) cursorTap()
  update()
}

/** A left click: tap the TV where the pointer is right now. */
function cursorTap() {
  const c = state.cursor
  if (tapNext) return // a click is already waiting for the wire; don't stack
  c.clicks += 1
  tapNext = { x: c.pointer.x, y: c.pointer.y }
  if (tapInFlight) return
  tapInFlight = (async () => {
    while (tapNext) {
      const at = tapNext
      tapNext = null
      const res = await tapAt(at.x, at.y)
      c.lastTap = { x: at.x, y: at.y, ms: Math.round(res.ms ?? 0), via: res.via ?? "none" }
      pushLog(
        res.ok
          ? `✓ tap ${at.x},${at.y} — ${Math.round(res.ms ?? 0)} ms via ${res.via}`
          : `✗ tap ${at.x},${at.y} — ${firstLine(res.error ?? "failed")}`,
      )
      update()
    }
    tapInFlight = null
  })()
}

/**
 * The click itself. monkey's `tap` first (16 ms measured); `input tap` when the
 * socket is not up — the adb path has to keep working for a user who never
 * installs anything, and it does, at 1.2-1.6 s.
 */
async function tapAt(x, y) {
  if (monkeyInfo().state !== "alive") {
    await ensureMonkey({ serial: state.serial, onStep: monkeyStep })
  }
  if (monkeyInfo().state === "alive") {
    const r = await monkeyPointer({ type: "tap", x, y })
    if (r.ok) return { ok: true, via: "monkey", ms: r.ms }
    pushLog(`✗ monkey tap — ${firstLine(r.error)}; tapping over adb`)
  }
  const started = process.hrtime.bigint()
  const r = await shell(state.serial, `input tap ${Math.round(x)} ${Math.round(y)}`)
  return {
    ok: r.ok,
    via: "adb",
    ms: Number(process.hrtime.bigint() - started) / 1e6,
    error: r.ok ? null : firstLine(r.err || r.out || "input tap failed"),
  }
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
  pending.inFlight += 1
  enqueue(async () => {
    try {
      state.busy = true
      update()
      noteUntypeable(payload)
      await ensureCleanKeyboard()
      // The one place the route is chosen: companion `commit` or the adb `input`.
      const r = await insertText(payload)
      releaseKeyboardSoon()
      state.busy = false
      state.lastSent = `text ${JSON.stringify(payload)}`
      if (mirror) state.echo += payload
      pushLog(
        r.ok
          ? `✓ text ${JSON.stringify(payload)} [${r.route ?? routeWord()}]`
          : `✗ text — ${firstLine(r.error ?? r.err)}`,
      )
    } finally {
      sendDone()
    }
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
  flushPending()
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
    // The TV was off the network, so anything it was running is gone: ask again.
    if (res.ok && serial === state.serial) probeCompanionNow()
  })
}

/** `s`: put the TV we're driving to sleep — one keyevent, and the network goes with it. */
function sleepTarget() {
  flushPending()
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

// ---------------------------------------------------------------- companion
/**
 * `c`, and once on connect: ask the TV whether the companion is there, and start
 * it if it is installed but not answering. Nothing else in the app may assume the
 * service is running — it is not kept alive between uses — and this is also the
 * only thing that decides which path the UI reports.
 *
 * It never loops: a TV that is asleep comes back as "TV asleep" and the wake is
 * offered instead of another socket retry against a host that is not there.
 */
function probeCompanionNow() {
  if (state.demo || !state.serial) return
  enqueue(async () => {
    state.companionProbing = true
    update()
    const res = await probeCompanion({
      serial: state.serial,
      ip: ipOf(state.serial),
      onStep: (line) => {
        pushLog(`· ${line}`)
        update()
      },
    })
    state.companionProbing = false
    state.companion = { ...res, at: Date.now() }
    pushLog(companionLine(res))
    // A companion that answers is a fact about this device: write it down, so a TV
    // that was set up outside this flow is never offered the setup again.
    if (res.state === "alive" || res.state === "started") recordCompanionFound(res)
    // A TV that is not on the network cannot be probed any further: offer the
    // wake instead of leaving the user with a dead socket.
    if (res.state === "asleep") pushLog("ℹ w sends the magic packet and wakes the TV")
    update()
  })
}

/** One log line per probe outcome: what was found, and where that leaves us. */
function companionLine(res) {
  // The route is the forward, not the TV's LAN address: the companion binds loopback
  // only, so this machine reaches it at 127.0.0.1:<localPort>, which adb forwards to
  // the TV's own 7900. Say both, because "which local port" is the useful half.
  const where = `127.0.0.1:${res.localPort ?? "?"} → ${res.host ?? state.serial}:${COMPANION.port} via adb forward`
  switch (res.state) {
    case "alive":
    case "started": {
      const what = res.version ? `v${res.version}${res.pid ? `, pid ${res.pid}` : ""}, ` : ""
      // Text is routed over it from here on (commit + read-back); keys, volume,
      // launching and power still go over adb, which has no companion verb.
      return (
        `✓ companion ${res.state === "started" ? "started and " : ""}authenticated on ${where}` +
        ` in ${res.ms} ms (${what}text goes over it — keys stay on adb)` +
        (res.provisioned ? " · this machine's key was provisioned over adb" : "")
      )
    }
    case "unpaired":
      return `✗ companion is running but refuses this machine's key — ${res.detail}`
    case "missing":
      return (
        `✗ companion is not installed on the TV — install ${res.apk} from the app list (l, then i)` +
        (res.apkPresent ? "" : " (that APK is not on this machine either)")
      )
    case "asleep":
      return `✗ TV asleep — ${res.detail}`
    default:
      return `✗ companion probe — ${res.detail}`
  }
}

/**
 * The header's transport tag: which path typing takes, and why it is not the
 * companion when it is not.
 */
function companionTag() {
  if (state.companionProbing) return { word: "path: typing via adb · companion probing…", fg: C.warn }
  const c = state.companion
  if (c?.state === "alive" || c?.state === "started") {
    const n = state.companionTyping
    const done = n.commits ? ` · ${n.commits} commit(s), ${n.verified} verified` : ""
    return { word: `path: typing via companion (adb forward :${c.localPort ?? "?"})${done}`, fg: C.ok }
  }
  if (!c) return { word: "path: typing via adb", fg: C.faint }
  if (c.state === "missing") return { word: "path: typing via adb · no companion installed", fg: C.warn }
  if (c.state === "unpaired") return { word: "path: typing via adb · companion not paired", fg: C.warn }
  if (c.state === "asleep") return { word: "path: typing via adb · TV asleep", fg: C.warn }
  return { word: "path: typing via adb · companion no answer", fg: C.err }
}

// ---------------------------------------------------------------- companion setup
// The first-connect flow: ask before touching the TV, then walk the steps, stop
// at the first failure, and record the outcome per device (src/device-state.mjs).
//
// What "first connect" means here: there is no setup record for this device, AND
// the companion does not already answer an authenticated ping. The prompt says
// the app is "not set up", so that has to be true — the one thing worse than
// asking is asking about a TV that is already set up. The check that settles it
// is a READ (`provision:false`), so declining can never push a key onto the TV.
//
// The question is answerable from the keyboard alone: y / ⏎ / space = set it up,
// n / Esc = not now. "Not now" is recorded, so it is asked once per device.
const setupState = (patch = {}) => ({ ...(state.setup ?? {}), ...patch })

function blankSteps() {
  return SETUP_STEPS.map((step) => ({ ...step, status: "pending", note: "" }))
}

/** The MAC this machine learned for a device (its history entry), or null. */
function macOf(serial) {
  const ip = ipOf(serial)
  const known = state.history.find((d) => d.serial === serial || (ip && d.ip === ip))
  return known?.mac ?? null
}

/**
 * A device plus the MAC this machine knows for it: the pair the state file is
 * looked up by, so a TV that came back on a different address finds its record.
 */
function stateDevice(device) {
  return { serial: device?.serial, mac: macOf(device?.serial) }
}

/**
 * A probe that found the companion answering is a fact about this device: write it
 * down, so a TV set up outside this flow is never offered the setup again. A record
 * that already says both halves are done is left alone.
 */
function recordCompanionFound(res) {
  if (state.demo || !state.serial) return
  const device = stateDevice({ serial: state.serial })
  const status = setupStatus(device)
  if (status.record?.companion_installed && status.record?.secret_provisioned) return
  writeDeviceState(device, {
    label: state.deviceLabel,
    ip: ipOf(state.serial),
    companion_installed: true,
    secret_provisioned: true,
    companion_version: res.version ?? null,
    setup: "found",
    verified_at: new Date().toISOString(),
  })
}

function markStep(id, status, note) {
  const step = state.setup?.steps?.find((s) => s.id === id)
  if (!step) return
  step.status = status
  if (note !== undefined) step.note = note
  update()
}

/**
 * The check that runs between "no record" and the prompt: is this TV already set
 * up?
 *
 * It is the companion's own lifecycle with provisioning OFF
 * (`probeCompanion({ provision: false })`): a companion that is installed but idle
 * is started and probed — that idle state is its normal one between uses, and
 * reading it as "not set up" would prompt the user about a TV that is already set
 * up, the one regression worth designing against. What it can NOT do is write:
 * no key is pushed (`no_secret` is reported, not repaired) and nothing is
 * installed — both of those only happen after the user says yes.
 */
async function firstConnectCheck(device) {
  if (!state.setup || state.setup.phase !== "checking") return
  const res = await probeCompanion({
    serial: device.serial,
    ip: ipOf(device.serial),
    provision: false,
    onStep: (line) => pushLog(`· ${line}`),
  })
  if (!state.setup || state.setup.phase !== "checking") return
  if (res.state === "alive" || res.state === "started") {
    writeDeviceState(stateDevice(device), {
      mac: macOf(device.serial),
      label: state.deviceLabel,
      ip: ipOf(device.serial),
      companion_installed: true,
      secret_provisioned: true,
      companion_version: res.version ?? null,
      setup: "found",
      verified_at: new Date().toISOString(),
    })
    pushLog(
      `✓ companion already set up on this TV (v${res.version ?? "?"}) — recorded for this device, nothing installed`,
    )
    landInRemote(device)
    return
  }
  state.setup = setupState({ phase: "prompt", summary: `checked this TV first: ${setupReason(res)}` })
  update()
}

/** Why there is no companion to talk to, in one line, from the pre-check's answer. */
function setupReason(res) {
  switch (res?.state) {
    case "missing":
      return "the companion package is not installed on it"
    case "unpaired":
      return "the companion is there but holds no key of ours"
    case "asleep":
      return "the TV is not reachable over adb"
    case "failed":
      return firstLine(res.detail ?? "something answered that is not the companion")
    default:
      return firstLine(res?.detail ?? res?.reason ?? "no answer")
  }
}

/**
 * The normal connect, once the setup question is settled (or was never worth
 * asking). `probe:false` is the refusal path: probing can provision a key over
 * adb, which is the thing the user just declined.
 */
function connectTail(device, { probe = true } = {}) {
  if (probe) probeCompanionNow()
  startMonkeyFor({ force: true })
}

function landInRemote(device) {
  state.setup = null
  setScreen("remote")
  connectTail(device)
}

/** The user said yes: run the steps, visibly. */
function startSetupRun() {
  const device = state.setup?.device
  if (!device) return
  state.setup = setupState({ phase: "running", steps: blankSteps(), summary: "working…" })
  update()
  enqueue(() => runSetup(device))
}

/**
 * Walk the steps in order. The first failure ends the run — the steps after it
 * stay "pending" on screen, which is what happened — and nothing further is sent
 * to the TV until the user asks for it (r to retry, n to stay on adb).
 */
async function runSetup(device) {
  const started = Date.now()
  const results = {}
  for (const step of SETUP_STEPS) {
    if (!state.setup || state.setup.phase !== "running") return
    markStep(step.id, "running", "")
    let r
    try {
      r = await SETUP_RUNNERS[step.id](device, { note: (line) => markStep(step.id, "running", line) })
    } catch (e) {
      r = { ok: false, note: e?.message ?? String(e) }
    }
    results[step.id] = r
    if (!r.ok) {
      markStep(step.id, "failed", r.note ?? "no reason given")
      state.setup.phase = "failed"
      state.setup.summary =
        `Stopped at "${step.label}" — ${r.note ?? "no reason given"}. ` +
        "Nothing further was sent to the TV: n keeps this TV on the adb path, r tries the setup again."
      pushLog(`✗ companion setup — ${step.label}: ${firstLine(r.note ?? "failed")}`)
      update()
      return
    }
    markStep(step.id, "done", r.note ?? "")
  }

  const v = results.verify?.data ?? {}
  const seconds = ((Date.now() - started) / 1000).toFixed(1)
  const written = writeDeviceState(stateDevice(device), {
    mac: macOf(device.serial),
    label: state.deviceLabel,
    ip: ipOf(device.serial),
    apk: basename(companionApkStatus().path),
    companion_installed: true,
    secret_provisioned: true,
    companion_version: v.version ?? null,
    setup: "installed",
    installed_at: new Date().toISOString(),
    verified_at: new Date().toISOString(),
    verify_ms: v.ms ?? null,
  })
  // The probe result this run just proved, so the header stops saying "probing".
  state.companion = {
    state: "alive",
    host: ipOf(device.serial),
    serial: device.serial,
    localPort: v.localPort ?? null,
    version: v.version ?? null,
    pid: v.pid ?? null,
    paired: true,
    provisioned: true,
    reply: null,
    ms: v.ms ?? null,
    at: Date.now(),
  }
  state.setup.phase = "done"
  state.setup.recordPath = written.path
  state.setup.summary =
    `Done in ${seconds}s — the companion answered an authenticated ping (v${v.version ?? "?"}, pid ${v.pid ?? "?"}) on ` +
    `127.0.0.1:${v.localPort ?? "?"} → ${ipOf(device.serial)}:${COMPANION.port} via adb forward. ` +
    "Text goes over it from here; keys stay on adb."
  pushLog(`✓ companion set up and verified in ${seconds}s (v${v.version ?? "?"}) — typing goes over it from here`)
  update()
}

/** "Not now": recorded, so this device is asked once and never again. */
function refuseSetup() {
  const device = state.setup?.device
  state.setup = null
  if (!device) {
    setScreen("remote")
    return
  }
  writeDeviceState(stateDevice(device), {
    label: state.deviceLabel,
    setup: "refused",
    refused_at: new Date().toISOString(),
  })
  pushLog("ℹ companion setup declined — this TV stays on the adb path (typing over adb); it will not be asked again")
  setScreen("remote")
  connectTail(device, { probe: false })
}

// ---- the steps themselves. Each returns { ok, note, data? }.

/** 1. Is the TV usable on adb at all? Without this nothing else can work. */
async function stepAdb(device, { note }) {
  const { serial } = device
  let reach = await deviceState(serial)
  if (reach !== "device") {
    note(`adb lists it as ${reach ?? "absent"} — trying a direct connect`)
    if (await probePort(ipOf(serial), COMPANION.adbPort, 1500)) {
      await connectDevice(serial)
      await sleep(300)
      reach = await deviceState(serial)
    }
  }
  return reach === "device"
    ? { ok: true, note: `adb is connected to ${serial}` }
    : { ok: false, note: `adb cannot reach ${serial} (${reach ?? "not listed"}) — wake the TV and try again` }
}

/** 2. The APK: the prebuilt one when it is newer than the sources, else build it. */
async function stepApk(device, { note }) {
  const status = companionApkStatus()
  if (status.present && !status.stale) {
    return { ok: true, note: `using ${basename(status.path)} (${status.bytes} bytes, newer than the sources)` }
  }
  if (!status.scriptPresent) {
    return {
      ok: false,
      note: status.present
        ? `${basename(status.path)} is older than the sources and ${BUILD_SCRIPT} is missing`
        : `no APK at ${status.path} and no ${BUILD_SCRIPT} to build one`,
    }
  }
  note(status.present ? `${basename(status.path)} is older than the sources — building it` : "no APK yet — building it")
  const built = await buildCompanionApk({ onLine: (line) => note(firstLine(line)) })
  if (!built.ok) return { ok: false, note: built.error ?? `${BUILD_SCRIPT} exited ${built.code}: ${built.tail}` }
  const after = companionApkStatus()
  return after.present
    ? { ok: true, note: `built ${basename(after.path)} (${after.bytes} bytes) in ${(built.ms / 1000).toFixed(1)}s` }
    : { ok: false, note: `${BUILD_SCRIPT} reported success but no APK is on disk` }
}

/** 3. Install it, and check the package list — the exit code is not the verdict. */
async function stepInstall(device, { note }) {
  const { serial } = device
  const apk = companionApkStatus()
  if (!apk.present) return { ok: false, note: `no APK at ${apk.path}` }
  const before = await packagePath(serial, COMPANION.pkg)
  note(before.length ? `already installed (${before[0]}) — reinstalling this build` : "pushing the APK to the TV")
  const res = await installApk(serial, apk.path, { onProgress: (percent) => note(`installing… ${percent}%`) })
  if (!res.ok) {
    const code = res.reason ? String(res.reason).split(":")[0].trim() : null
    const rest = code && res.reason !== code ? firstLine(String(res.reason).slice(code.length + 1)) : null
    return { ok: false, note: `${code ?? "install failed"}${rest ? ` — ${rest}` : ""}` }
  }
  const after = await packagePath(serial, COMPANION.pkg)
  if (!after.length) return { ok: false, note: "the package is not on the TV after the install" }
  // The one-off privileged permission the companion needs to select its own IME.
  // Not fatal: without it the typing path selects the IME over adb instead.
  const grant = await adbRaw([
    "-s",
    serial,
    "shell",
    "pm",
    "grant",
    COMPANION.pkg,
    "android.permission.WRITE_SECURE_SETTINGS",
  ])
  const bad = /error|exception|denial|not found|unknown/i.test(`${grant.out} ${grant.err}`)
  return {
    ok: true,
    note:
      `${after[0].split("/").pop()} installed` +
      (grant.ok && !bad ? "" : " (WRITE_SECURE_SETTINGS not granted — the IME will be selected over adb)"),
    data: { path: after[0], granted: grant.ok && !bad },
  }
}

/** 4. Push this machine's key over adb. The key itself never reaches a log. */
async function stepPair(device, { note }) {
  const key = ensureCompanionKey(device)
  note(`pushing this machine's key over adb (${basename(key.path)}${key.created ? ", created now" : ""})`)
  const pushed = await provisionCompanionSecret(device.serial, key.hex, { onStep: (line) => note(line) })
  if (!pushed.ok) return { ok: false, note: pushed.line || "the am command that carries the key failed" }
  await sleep(150)
  return { ok: true, note: "the TV accepted this machine's key", data: { keyPath: key.path } }
}

/** 5. The only thing that counts as done: an authenticated answer from the companion. */
async function stepVerify(device, { note }) {
  const target = companionDevice(ipOf(device.serial), device.serial)
  for (let i = 1; i <= START_TRIES; i++) {
    const r = await pingCompanion(target, { provision: false })
    if (r.ok && r.reply?.ok) {
      return {
        ok: true,
        note: `authenticated ping answered in ${r.ms} ms (v${r.reply.version ?? "?"}, pid ${r.reply.pid ?? "?"})`,
        data: {
          version: r.reply.version ?? null,
          pid: r.reply.pid ?? null,
          localPort: r.localPort ?? null,
          ms: r.ms ?? null,
        },
      }
    }
    if (i === 1) {
      note(`no answer yet (${r.reason ?? "error"}) — starting the service`)
      await startCompanionService(device.serial)
    } else {
      note(`still nothing (${r.reason ?? "error"})`)
    }
    if (i < START_TRIES) await sleep(START_GAP_MS)
  }
  return {
    ok: false,
    note: `the companion never answered an authenticated ping after ${START_TRIES} tries — nothing was recorded for this device`,
  }
}

const SETUP_RUNNERS = { adb: stepAdb, apk: stepApk, install: stepInstall, pair: stepPair, verify: stepVerify }

/** The installer screen: a device header, the step list, one summary line. */
function updateSetup() {
  const setup = state.setup ?? {}
  const phase = setup.phase ?? "prompt"
  const steps = setup.steps ?? blankSteps()
  const doneCount = steps.filter((s) => s.status === "done").length

  // ---- header: the device, and where the run has got to
  headerDot.content = phase === "done" ? "✓" : phase === "failed" ? "✗" : "◌"
  headerDot.fg = phase === "done" ? C.ok : phase === "failed" ? C.err : C.warn
  headerText.content =
    `${state.deviceLabel || state.serial}   ·   ${state.serial}   ·   companion setup ` +
    (phase === "checking"
      ? "checking…"
      : phase === "done"
        ? "complete"
        : phase === "failed"
          ? "failed"
          : phase === "running"
            ? `${doneCount}/${steps.length}`
            : "required")
  headerBox.borderColor = phase === "done" ? C.ok : phase === "failed" ? C.err : C.faint
  headerPath.content = ""
  headerPath.fg = C.faint

  // ---- the panel
  setupDevice.content = `${state.deviceLabel || state.serial}   ·   ${state.serial}`
  setupQuestion.content =
    phase === "prompt"
      ? `Companion app is not set up on this TV (${state.deviceLabel || state.serial}). Install and pair it now? [Y/n]`
      : phase === "checking"
        ? "Looking for a companion on this TV over adb — read-only, nothing is written."
        : phase === "running"
          ? `Setting the companion up on ${state.deviceLabel || state.serial}.`
          : phase === "done"
            ? `Companion set up on ${state.deviceLabel || state.serial}.`
            : "Setup stopped."
  setupRows.forEach((row, i) => {
    const step = steps[i]
    if (!step) {
      row.visible = false
      row.content = ""
      return
    }
    row.visible = true
    row.content = `${SETUP_MARKS[step.status] ?? SETUP_MARKS.pending} ${step.label}${step.note ? ` — ${step.note}` : ""}`
    row.fg =
      step.status === "done" ? C.ok : step.status === "failed" ? C.err : step.status === "running" ? C.text : C.dim
  })
  setupSummary.content = setup.summary ?? ""

  // ---- footer
  footerHints.content =
    phase === "prompt"
      ? "y / ⏎ install and pair        n / Esc not now — stay on adb"
      : phase === "checking"
        ? "one read-only ping, then the question"
        : phase === "running"
          ? "each step reports its own verdict; the run stops at the first failure"
          : phase === "done"
            ? "⏎ (or any key) opens the remote"
            : "r try the setup again        n / Esc not now — stay on adb"
  footerStatus.content =
    phase === "prompt"
      ? "no setup record for this device yet — answering once settles it for good"
      : phase === "checking"
        ? `adb forward to ${ipOf(state.serial)}:${COMPANION.port}, then one authenticated ping`
        : phase === "running"
          ? "the TV is only touched by these steps"
          : phase === "done"
            ? `recorded in ${setup.recordPath ?? "the per-device state file"}`
            : "nothing else was sent to the TV"
}

// ---------------------------------------------------------------- typing route
// Text has two routes and this is where one is chosen. The companion's `commit`
// sends no keycodes, so the TV's keyboard layout is never consulted: there is
// nothing to translate, no repeated key to lose and nothing worth batching. The
// three mechanisms that exist to compensate for `input`'s 1.2 s round trip and its
// layout remapping therefore stay exactly where they are and are *bypassed* on the
// companion route — each one checks `typingPath()` itself and returns early, so the
// call sites (sendText, syncMirror) are the same code they were:
//
//   mechanism                       adb route        companion route
//   layout translation (keymap)     used             bypassed: commit sends no keycodes
//   borrowed pass-through keyboard  used             bypassed: nothing to work around
//   keystroke batching              used             bypassed: 3-7 ms per commit
//
// Nothing is deleted: with the companion absent, stopped or unreachable, every one
// of them runs exactly as it did before this route existed.

const sleep = (ms) => new Promise((done) => setTimeout(done, ms))
// How long the selected companion IME gets to bind before the route gives up on
// it: its own `read` verb answers `ime_not_selected` until the service is bound.
const COMPANION_IME_BIND_TRIES = 4
const COMPANION_IME_BIND_GAP_MS = 150

/**
 * Which path typing takes, decided in one place.
 *
 * `companion` — a probe (on connect, on `c`, after a wake) found the socket
 * answering, so text goes over `commit` and the field is read back to check it
 * landed. `adb` — everything else, including a companion that was up and stopped
 * answering: the failure demotes it here, so the next keystroke is back on adb.
 */
function typingPath() {
  const host = state.serial ? ipOf(state.serial) : null
  const c = state.companion
  if (!state.demo && host && (c?.state === "alive" || c?.state === "started")) {
    // The route is a device, not a host: the companion is on the TV's own loopback
    // and this machine only reaches it through the adb forward for that serial.
    return { route: "companion", host, device: companionDevice(host, state.serial), localPort: c.localPort ?? null }
  }
  return { route: "adb", host: null, device: null }
}

/** The route, as one word, for the log and the header. */
function routeWord(path = typingPath()) {
  return path.route === "companion" ? "companion" : "adb"
}

/** A companion that stopped answering: said out loud, and the route demoted to adb. */
function demoteCompanion(detail) {
  state.companion = {
    ...(state.companion ?? {}),
    state: "failed",
    host: state.companion?.host ?? ipOf(state.serial) ?? null,
    detail,
    at: Date.now(),
  }
  pushLog(`✗ companion — ${detail}; typing goes back to adb`)
  update()
}

/**
 * Put the *companion's* IME in place while text is going out, and wait until it is
 * actually bound.
 *
 * `commit` goes through an InputMethodService, and the framework only hands one an
 * InputConnection while it is the TV's selected input method — so this one adb
 * call stays on the typing path (t_14c284f4 moves it in-process). This is NOT the
 * pass-through keyboard the adb route borrows: that mechanism is untouched and
 * still borrows Gboard for itself when the adb path sends.
 *
 * `ime set` returning 0 says the *setting* was written, not that the service is
 * bound: measured on this TV, the companion's IME answers `ime_not_selected` for
 * a moment after the switch (and after a fresh start of the process), and after a
 * fresh install the manager leaves the method unbound entirely
 * (mBoundToMethod=false) until it is switched away and back. So the wait is the
 * companion's own answer, and the switch-away-and-back is the retry — both
 * bounded, and the route falls back to adb rather than spinning.
 *
 * What the TV's own keyboard is stays in state.tvIme/tvKeyboard — that is what the
 * adb route translates for, and what gets handed back below.
 */
async function ensureCompanionIme(device) {
  if (state.demo || !state.serial) return false
  if (state.companionIme) return true

  // In-process first: `ime on` writes the same secure setting adb's `ime set` writes
  // (measured 3-18 ms on the device against 0.15 s over adb), so the typing path has
  // no adb call in it at all. It needs the one-off grant recorded in
  // COMPANION_IME_GRANT; without it the verb answers ok:false /
  // error:"no_write_secure_settings", which is an instruction to fall back, not to
  // retry. Any failure here falls through to the adb path below, unchanged.
  const via = await imeOn(device)
  if (via.ok && via.reply?.ok) {
    if (await companionImeBound(device)) {
      state.companionIme = true
      state.companionImeVia = "companion"
      if (!state.tvImeOwn && via.reply.previous) state.tvImeOwn = via.reply.previous
      pushLog(
        `⌨ companion IME in place for sending (selecting it cost ${via.reply.switch_ms} ms)${state.tvImeOwn ? ` — ${keyboardName(state.tvImeOwn)} comes back when you stop` : ""}`,
      )
      update()
      return true
    }
    pushLog("⌨ companion IME selected in-process but never bound — falling back to adb")
  } else {
    const why = via.reply?.error ?? via.reason
    pushLog(
      why === "no_write_secure_settings"
        ? `⌨ companion cannot select its own IME (WRITE_SECURE_SETTINGS not granted) — the typing path stays on adb; grant it once with: adb shell ${COMPANION_IME_GRANT}`
        : `⌨ companion IME selection over the socket failed (${why}) — falling back to adb`,
    )
    update()
  }

  await adbRaw(["-s", state.serial, "shell", "ime", "enable", COMPANION_IME])
  let r = await adbRaw(["-s", state.serial, "shell", "ime", "set", COMPANION_IME])
  if (!r.ok) {
    pushLog(`✗ companion IME could not be selected — ${firstLine(r.err || r.out)}`)
    update()
    return false
  }
  if (!(await companionImeBound(device))) {
    pushLog("⌨ companion IME not bound yet — switching away and back")
    if (state.tvImeOwn) await adbRaw(["-s", state.serial, "shell", "ime", "set", state.tvImeOwn])
    r = await adbRaw(["-s", state.serial, "shell", "ime", "set", COMPANION_IME])
    if (!r.ok || !(await companionImeBound(device))) {
      pushLog("✗ companion IME never bound — the companion cannot carry text right now")
      update()
      return false
    }
  }
  state.companionIme = true
  state.companionImeVia = "adb"
  pushLog(
    `⌨ companion IME in place for sending (selected over adb)${state.tvImeOwn ? ` — ${keyboardName(state.tvImeOwn)} comes back when you stop` : ""}`,
  )
  return true
}

/**
 * Is the companion's IME reachable? Its own service answers, so ask it rather than
 * reading `dumpsys` and interpreting it. Only `ime_not_selected` means "not bound
 * yet"; anything else the service can answer (a field that is not there) means the
 * method is up and the field is the problem.
 */
async function companionImeBound(device) {
  for (let i = 1; i <= COMPANION_IME_BIND_TRIES; i++) {
    const back = await readCompanion(device)
    if (back.ok && back.reply?.ok) return true
    const error = back.reply?.error ?? back.reason
    if (error && error !== "ime_not_selected") return true
    if (i < COMPANION_IME_BIND_TRIES) await sleep(COMPANION_IME_BIND_GAP_MS)
  }
  return false
}

/**
 * Hand the TV its own keyboard back. Its own timer, separate from the pass-through
 * keyboard's lease, because the two routes borrow different IMEs and one must not
 * release — or keep alive — the other.
 */
function releaseCompanionImeSoon() {
  if (state.tvImeManual) return
  if (companionLeaseTimer) clearTimeout(companionLeaseTimer)
  companionLeaseTimer = setTimeout(() => {
    companionLeaseTimer = null
    enqueue(releaseCompanionIme)
  }, KEYBOARD_LEASE_MS)
}
let companionLeaseTimer = null

/**
 * Hold the companion IME for as long as mirror mode is what is active, instead of
 * taking it again for every field read.
 *
 * Mirror mode reads the field on entry, after every OK and every 20 s, and each
 * re-selection costs ~0.35 s (enable + set + bind check) against a 4.5 ms read. The
 * lease is handed back the moment the text module, mirror mode or the remote itself is
 * left (releaseMirrorIme), and it is the same single lease the sending path uses —
 * `releaseCompanionIme` restores whatever keyboard the TV had, so nothing is stranded.
 */
function holdCompanionIme() {
  if (companionLeaseTimer) {
    clearTimeout(companionLeaseTimer)
    companionLeaseTimer = null
  }
  mirror.imeHeld = true
}

/** Hand the companion's IME back when mirror mode stops being the thing on screen. */
function releaseMirrorIme() {
  if (!mirror.imeHeld) return
  mirror.imeHeld = false
  if (state.tvImeManual) return
  enqueue(releaseCompanionIme)
}

async function releaseCompanionIme() {
  if (!state.companionIme) return
  const via = state.companionImeVia
  state.companionIme = false
  state.companionImeVia = null

  // Released the same way it was taken: a session that selected the IME over the socket
  // hands it back over the socket (`ime off` restores the IME the companion recorded
  // before it took over). A session that selected it with `adb ime set` releases with
  // adb, as before.
  if (via === "companion") {
    const r = await imeOff(companionDevice(ipOf(state.serial), state.serial))
    if (r.ok && r.reply?.ok) {
      const back = r.reply.current
      if (state.tvImeOwn && back !== state.tvImeOwn) {
        // The TV's own keyboard moved while we held the IME: put back what the app knows
        // is its default rather than leaving whatever the companion recorded.
        await adbRaw(["-s", state.serial, "shell", "ime", "set", state.tvImeOwn])
        setKeyboardState(state.tvImeOwn)
        pushLog(`⌨ companion IME released — ${keyboardName(state.tvImeOwn)} back in place`)
        return
      }
      setKeyboardState(back)
      pushLog(`⌨ companion IME released — ${keyboardName(back)} back in place`)
      return
    }
    pushLog(`✗ in-process release failed (${r.reply?.error ?? r.reason}) — handing the keyboard back over adb`)
  }

  const target = state.tvImeOwn
  if (!target) {
    pushLog("⌨ companion IME left selected — the TV's own keyboard is unknown")
    return
  }
  const r = await adbRaw(["-s", state.serial, "shell", "ime", "set", target])
  if (!r.ok) {
    pushLog(`✗ could not hand the TV its keyboard back — ${firstLine(r.err || r.out)}`)
    update()
    return
  }
  setKeyboardState(target)
  pushLog(`⌨ companion IME released — ${keyboardName(target)} back in place`)
}

/**
 * Did the field take what was committed?
 *
 * `ok:true` from `commit` means "handed to the connection", not "on screen" — it
 * has been measured answering ok while changing nothing once the app ran its own
 * search on a previous commit. So the text is read back and checked where the API
 * says the caret is: after a commit the caret sits immediately after what was
 * inserted, and `read cursor` derives the caret (selectionStart) from
 * getTextBeforeCursor.
 *
 *   match     — the committed text is right before the caret (and the whole field
 *               matches the caller's model, when it has one)
 *   drifted   — the text landed, but the field is not what the caller modelled:
 *               reported, not resent, so no character is duplicated
 *   mismatch  — the text is not there: the caller resends it over adb
 *   unreadable— the read itself failed (no field, no connection); nothing
 *               contradicts the commit, so it is reported as unverified rather
 *               than sent twice
 *
 * Stated limits: `read cursor` cannot tell an empty field from a fieldless screen
 * (both answer ""), and `read extracted` errors when nothing is focused. Neither
 * is papered over — a field that went away reads as a mismatch and the text is
 * re-sent over adb, which is the right way round: a duplicate character beats a
 * dropped one.
 */
function compareField(reply, { chunk, expect = null }) {
  if (!reply?.ok || !reply.reply?.ok) {
    return { status: "unreadable", error: reply?.reply?.error ?? reply?.error ?? "no answer", text: "" }
  }
  const r = reply.reply
  const text = typeof r.text === "string" ? r.text : ""
  const caret = typeof r.selectionStart === "number" ? r.selectionStart : null
  const chunkAtCaret =
    caret === null ? text.includes(chunk) : text.slice(Math.max(0, caret - chunk.length), caret) === chunk
  if (!chunkAtCaret) return { status: "mismatch", text, caret, source: r.source }
  if (expect !== null && text !== expect) return { status: "drifted", text, caret, source: r.source }
  return { status: "match", text, caret, source: r.source }
}

/**
 * One commit and its read-back, one socket connection each. Never throws: the
 * caller falls back to adb on `retryOnAdb`.
 */
async function commitViaCompanion(device, text, expect) {
  const started = Date.now()
  if (!(await ensureCompanionIme(device))) {
    return { ok: false, route: "companion", error: "the companion IME is not selected", retryOnAdb: true }
  }
  const sent = await commitCompanion(device, text)
  if (!sent.ok || !sent.reply?.ok) {
    const why = sent.ok ? sent.reply?.error ?? "refused" : `${sent.reason ?? "error"} (${sent.error ?? "no answer"})`
    // The caller demotes the route and falls back for this send: a socket failure
    // means the service is gone and a verb error means the command did not land,
    // and neither is a reason to keep sending text into a route that is not taking it.
    return { ok: false, route: "companion", error: `commit ${why}`, retryOnAdb: true }
  }
  state.companionTyping.commits += 1
  if (sent.folded) pushLog("⚠ the committed text held a line break — folded to a space (one command per line)")

  const back = await readCompanion(device)
  const check = compareField(back, { chunk: text, expect })
  const ms = Date.now() - started
  if (check.status === "match") {
    state.companionTyping.verified += 1
    state.companionTyping.lastMs = ms
    return { ok: true, route: "companion", ms, field: check.text, caret: check.caret, verified: true }
  }
  state.companionTyping.unverified += 1
  if (check.status === "drifted") {
    pushLog(`⚠ companion commit landed, but the field holds ${check.text.length} char(s) and the model says ${expect?.length ?? "?"}`)
    return { ok: true, route: "companion", ms, field: check.text, caret: check.caret, verified: false, drifted: true }
  }
  pushLog(
    `⚠ companion said ok but the field does not hold it (${check.status}${check.error ? `: ${check.error}` : ""}) — sending over adb`,
  )
  return { ok: false, route: "companion", error: `the field did not take ${JSON.stringify(text.slice(0, 20))}`, retryOnAdb: true }
}

/**
 * Put `text` into the TV's focused field — the only place a send happens. The
 * companion branch is commit + read-back; the adb branch is the call this used to
 * be, translated by src/adb.mjs exactly as before.
 *
 * A companion that refuses, or whose commit does not show up in the field, is
 * demoted here and the text goes out over adb *with the adb route's own
 * compensations* (translation + borrowed keyboard): they were bypassed for the
 * companion route, and half-compensating — translating for a layout that is not
 * remapping — produces exactly the mangled text this project exists to avoid.
 * A slow character beats a lost or a corrupted one.
 */
async function insertText(text, { expect = null } = {}) {
  if (!text) return { ok: true, route: "none", calls: 0 }
  const path = typingPath()
  let fellBack = false
  if (path.route === "companion") {
    const r = await commitViaCompanion(path.device, text, expect)
    if (r.ok) {
      releaseCompanionImeSoon()
      return r
    }
    if (!r.retryOnAdb) return r
    state.companionTyping.fellBack += 1
    demoteCompanion(r.error)
    await releaseCompanionIme() // never type through the companion's IME on the adb route
    // demoteCompanion has just flipped typingPath to adb, which is what lets the
    // two bypassed compensations run here.
    await ensureCleanKeyboard()
    fellBack = true
  }
  const r = await inputText(state.serial, text, effectiveLayout())
  if (fellBack) releaseKeyboardSoon()
  return { ...r, route: "adb", fellBack }
}

// ---------------------------------------------------------------- apps
/** The probe itself, awaitable, so a caller can log its own line after it. */
async function runProbe({ quiet = false } = {}) {
  state.appsProbing = true
  update()
  if (state.demo) {
    state.apps = DEMO_APPS
    state.appsAt = new Date().toISOString()
    state.appsProbing = false
    await runProcProbe({ quiet: true })
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
  state.appsSel = Math.min(state.appsSel, Math.max(0, visibleApps().length - 1))
  saveApps(state.serial, apps)
  // The running set comes with the app list: one `l` press answers "what is on
  // this TV and what of it is live", and a kill has a baseline to be measured
  // against.
  await runProcProbe({ quiet: true })
  if (!quiet) pushLog(`✓ ${apps.length} app(s) on the TV`)
  update()
}

/**
 * The running-process probe (src/processes.mjs): which packages a shell can see
 * with a live process right now. ~0.3 s (three adb calls in parallel).
 */
async function runProcProbe({ quiet = false } = {}) {
  if (state.demo) {
    state.procs = demoRunning()
    state.procsUser = new Set(DEMO_PROCS.filter((p) => p.user).map((p) => p.pkg))
    state.procsCounts = {
      psRows: DEMO_PROCS.length,
      packages: DEMO_APPS.length,
      userPackages: DEMO_PROCS.filter((p) => p.user).length,
      running: DEMO_PROCS.length,
      sandboxed: 0,
    }
    state.procsAt = new Date().toISOString()
    return
  }
  state.procsProbing = true
  update()
  const r = await probeProcesses(state.serial)
  state.procsProbing = false
  if (r.error) {
    pushLog(`✗ running probe — ${firstLine(r.error)}`)
    update()
    return
  }
  state.procs = new Map(r.running.map((p) => [p.pkg, p.pid]))
  state.procsUser = new Set(r.running.filter((p) => p.user).map((p) => p.pkg))
  state.procsCounts = r.counts
  state.procsAt = r.at
  if (!quiet) pushLog(`✓ ${r.running.length} package(s) running`)
  update()
}

/** `f` on the app list: everything → user → system/vendor → running → … */
function cycleAppsFilter() {
  const next = (APP_FILTERS.indexOf(state.appsFilter) + 1) % APP_FILTERS.length
  state.appsFilter = APP_FILTERS[next]
  state.appsSel = Math.min(state.appsSel, Math.max(0, visibleApps().length - 1))
  pushLog(`· filter: ${FILTER_LABEL[state.appsFilter]}`)
  update()
}

/** Probe the TV for launchable apps and cache them per serial. */
function probeApps(options) {
  if (!state.serial) {
    pushLog("✗ no device — connect one first")
    update()
    return
  }
  enqueue(() => runProbe(options))
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

/**
 * `i` on the app list: install an APK that sits on this machine. The progress
 * line lives at the top of the log and is replaced by the verdict, so a slow
 * push over Wi-Fi never looks like a hang. Success is not taken from the exit
 * code alone: the package list is read before and after and the difference is
 * what gets reported.
 */
function installFromPath(input) {
  flushPending()
  const expanded = input.startsWith("~") ? join(homedir(), input.slice(1)) : input
  const file = resolve(expanded)
  if (!existsSync(file)) {
    pushLog(`✗ no such file — ${file}`)
    update()
    return
  }
  const name = basename(file)
  enqueue(async () => {
    state.busy = true
    pushLog(`… installing ${name}`)
    update()
    const before = await listPackages(state.serial).catch(() => new Set())
    const started = Date.now()
    const res = await installApk(state.serial, file, {
      onProgress: (percent) => {
        state.log[0] = `… installing ${name}  ${percent}%`
        update()
      },
    })
    state.busy = false
    const seconds = ((Date.now() - started) / 1000).toFixed(1)

    if (!res.ok) {
      // adb puts the message inside the reason, e.g.
      // "INSTALL_PARSE_FAILED_NOT_APK: Failed to parse ...": keep the code on the
      // verdict line and the rest underneath.
      const code = res.reason ? res.reason.split(":")[0].trim() : null
      const extra = res.reason && res.reason !== code ? res.reason.slice(code.length + 1).trim() : null
      // Newest line first, so the verdict ends up at log[0], where it is read.
      if (code === "INSTALL_FAILED_VERSION_DOWNGRADE") {
        pushLog("ℹ that APK is older than the one installed — allow it with install -d")
      }
      if (code === "INSTALL_FAILED_UPDATE_INCOMPATIBLE") {
        pushLog("ℹ signature mismatch, the installed app is signed with another key")
      }
      const detail = firstLine(extra || res.err || res.out)
      if (detail) pushLog(`  ${detail}`)
      pushLog(`✗ install failed — ${code ?? "no verdict from the TV"}`)
      update()
      return
    }

    const after = await listPackages(state.serial).catch(() => new Set())
    const added = [...after].filter((pkg) => !before.has(pkg))
    const what = added.length === 1 ? ` — new: ${labelFor(added[0])}` : added.length > 1 ? ` — ${added.length} new packages` : ""
    // Refresh first, then state the verdict: only log[0] is on screen here, and
    // the probe's own line would otherwise sit on top of the result.
    await runProbe({ quiet: true })
    state.log[0] = `✓ installed ${name} in ${seconds}s${what}`
    state.lastSent = `install ${name}`
    update()
  })
}

function launchSelected() {
  flushPending()
  const app = visibleApps()[state.appsSel]
  if (!app) return
  if (state.demo) {
    state.lastSent = `launch ${app.label}`
    pushLog(`✓ launched ${app.label} (demo)`)
    update()
    return
  }
  if (!app.component) {
    // A running package with no launcher activity — it was listed to be stopped.
    pushLog(`· ${app.label} has no launcher activity — k stops it`)
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
    // Launching is a change of the process list: read it back rather than assume.
    await runProcProbe({ quiet: true })
    update()
  })
}

/**
 * The two packages whose loss is visible on the TV itself: `android` is the
 * system server, and System UI is the screen the owner is looking at. force-stop
 * would be accepted by neither in a useful way, so the key refuses them instead
 * of taking the TV down for a keypress.
 */
const STOP_REFUSED = new Set(["android", "com.android.systemui"])

/**
 * `k`: stop the selected package. The claim is never "the command returned" —
 * `am force-stop` prints nothing and exits 0 even for a package that does not
 * exist — so the pid is read before and after and the verdict is that difference
 * (stopVerdict in src/processes.mjs).
 */
function killSelected() {
  flushPending()
  const app = visibleApps()[state.appsSel]
  if (!app) return
  if (STOP_REFUSED.has(app.pkg)) {
    pushLog(`✗ refusing to stop ${app.label} — it is the TV's own screen/framework`)
    update()
    return
  }
  if (state.demo) {
    state.procs.delete(app.pkg)
    state.lastSent = `stop ${app.label}`
    pushLog(`✓ stopped ${app.label} (demo — force-stop not sent)`)
    update()
    return
  }
  enqueue(async () => {
    state.busy = true
    pushLog(`… stopping ${app.label}`)
    update()
    const r = await stopPackage(state.serial, app.pkg)
    state.busy = false
    state.lastSent = `stop ${app.label}`
    // The map follows the measurement, not the intent: a package that is still
    // there keeps its (possibly new) pid, one that is gone leaves the list.
    if (r.after) state.procs.set(app.pkg, r.after)
    else state.procs.delete(app.pkg)
    state.appsSel = Math.min(state.appsSel, Math.max(0, visibleApps().length - 1))
    pushLog(`${r.text} [${r.ms} ms]`)
    update()
  })
}

function openRemote(device) {
  // A companion forward belongs to the device it was made for: dropping the previous
  // one keeps exactly one live per TV, and the new device gets its own on first use.
  const previous = state.serial
  if (previous && previous !== device.serial) enqueue(() => removeCompanionForward(previous))
  state.serial = device.serial
  if (!state.demo && device.serial !== "demo") enqueue(detectKeyboard)
  state.deviceLabel = device.model || device.device || device.serial
  // Persist it so it shows up in the history list next time.
  state.history = remember({
    serial: device.serial,
    ip: ipOf(device.serial),
    label: state.deviceLabel,
    mac: state.history.find((d) => d.serial === device.serial)?.mac,
  })
  state.module = "dpad"
  state.sendMode = "mirror" // the mode that needs no reaching for Enter
  state.caret = 0
  state.echo = ""
  state.log = []
  state.volume = null
  state.companion = null // a new TV has its own companion state: never assume it is up

  // First connect: nothing on this machine says this TV has been set up, so the
  // question comes before anything touches the device (src/device-state.mjs). A
  // device whose companion already answers an authenticated ping is recorded
  // instead, and never asked about.
  const offer = state.demo ? { needed: false } : setupStatus(stateDevice(device))
  state.setup = offer.needed ? { phase: "checking", device, steps: blankSteps(), summary: offer.why } : null
  setScreen(offer.needed ? "setup" : "remote")
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
  if (offer.needed) {
    // The setup screen is up: the check runs first, then the question.
    enqueue(() => firstConnectCheck(device))
    return
  }
  // Probe the companion once, on connect: the service is not kept running, so
  // this is the only thing that may claim it is there — and bring the key socket
  // up with the connection, so the first D-pad press is already on the fast path.
  //
  // A device whose setup was declined is not probed on connect either: the probe's
  // migration path can push this machine's key over adb, which is the thing the
  // user said no to. `c` still probes on request.
  connectTail(device, { probe: offer.record?.setup !== "refused" })
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
  flushPending()
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
    // Coming back from off: whatever the TV was running went with the panel.
    if (res.ok && !turningOff) probeCompanionNow()
    // Same for the key socket: it went down with the TV (the JVM lived on the
    // device), and a stale one would just time out on the next keypress.
    if (res.ok) {
      if (turningOff) stopMonkeyFor("TV off")
      else startMonkeyFor({ force: true })
    }
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
  if (state.screen === "apk") return handleApkKey(key, name)
  if (state.screen === "setup") return handleSetupKey(key, name)
  return handleRemoteKey(key, name, ctrl, shift)
})

/**
 * The setup screen's keys. The whole prompt is answerable from the keyboard:
 * y / ⏎ / space = install and pair, n / Esc = not now. While the check or the run
 * is in flight the keyboard is swallowed — a key there would race the flow rather
 * than answer anything.
 */
function handleSetupKey(key, name) {
  const setup = state.setup
  if (!setup) return
  const letter = keyLetter(name)
  const yes = letter === "y" || name === "return" || name === "space"
  const no = letter === "n" || name === "escape"

  if (setup.phase === "prompt") {
    if (no) {
      refuseSetup()
      key.stopPropagation()
      return
    }
    if (yes) {
      startSetupRun()
      key.stopPropagation()
    }
    return // anything else is not an answer
  }
  if (setup.phase === "done") {
    landInRemote(setup.device)
    key.stopPropagation()
    return
  }
  if (setup.phase === "failed") {
    if (letter === "r") {
      startSetupRun()
      key.stopPropagation()
      return
    }
    if (no) {
      refuseSetup()
      key.stopPropagation()
    }
    return
  }
  // "checking" and "running": the flow owns the screen until it says otherwise.
  key.stopPropagation()
}

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

/**
 * Mirror mode: the local box is a copy of the TV's field, so there is nothing to
 * "send" — edits are pushed after a pause. Enter stays the TV's OK button, which
 * is what makes a search or a form usable without leaving this module.
 */
function handleMirrorKey(key, name, ctrl) {
  const before = textInput.value

  if (name === "return") {
    enqueueAfterSync({ code: KEY.OK, label: "OK" })
    // OK usually leaves the field; re-read once it has landed
    setTimeout(() => {
      mirror.probedAt = 0
      enqueue(probeField)
    }, 2500)
    key.stopPropagation()
    return
  }
  if (name === "up" || name === "down") {
    const up = name === "up"
    enqueueAfterSync({ code: up ? KEY.UP : KEY.DOWN, label: up ? "DPAD_UP" : "DPAD_DOWN" })
    key.stopPropagation()
    return
  }
  if (name === "escape") {
    // Esc empties the box (which empties the TV's field on the next sync); on an
    // empty box it moves on, so the module can always be left.
    if (before) {
      textInput.value = ""
      state.caret = 0
      scheduleSync()
    } else {
      cycleModule(1)
    }
    update()
    key.stopPropagation()
    return
  }
  if (name === "left" || name === "right") {
    const length = textInput.value.length
    state.caret = name === "left" ? Math.max(0, state.caret - 1) : Math.min(length, state.caret + 1)
    scheduleSync()
    return // the widget moves its own caret; we mirror the position to the TV
  }

  // Typing and backspace: the widget owns the edit. Whether the box already holds
  // the new character when this runs depends on when the widget flushes input, so
  // the sync is scheduled unconditionally — it diffs whatever the box holds at
  // fire time — and the deferred read only keeps our idea of the caret honest.
  setTimeout(() => {
    const after = textInput.value
    if (after !== before) state.caret = caretAfterChange(before, after)
  }, 0)
  scheduleSync()
  update()
}

function handleAppsKey(key, name, shift) {
  const letter = keyLetter(name)

  if (state.apkOpen) {
    if (name === "escape") {
      state.apkOpen = false
      apkInput.value = ""
      update()
      key.stopPropagation()
      return
    }
    if (name === "return") {
      const path = apkInput.value.trim()
      state.apkOpen = false
      apkInput.value = ""
      update()
      if (path) installFromPath(path)
      key.stopPropagation()
      return
    }
    return // the path input owns the keyboard
  }

  if (letter === "i") {
    // `i` picks a file from the filesystem; `p` inside the picker is the old
    // type-or-paste-a-path prompt, unchanged.
    openApkPicker()
    key.stopPropagation()
    return
  }
  if (letter === "k") {
    killSelected()
    key.stopPropagation()
    return
  }
  if (letter === "f") {
    cycleAppsFilter()
    key.stopPropagation()
    return
  }
  if (name === "up" || name === "down") {
    const n = visibleApps().length
    if (n) {
      state.appsSel = Math.min(n - 1, Math.max(0, state.appsSel + (name === "down" ? 1 : -1)))
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

  // ---- cursor mode's own way out, wherever the focus is: it owns the mouse, so
  // it needs a key that is not the mouse. `m` is the mode's key and Esc is the
  // universal "leave this mode" — both release it.
  if (state.cursor.on && (name === "escape" || (letter === "m" && !ctrl))) {
    toggleCursorMode()
    key.stopPropagation()
    return
  }

  // ---- TEXT module
  if (mod === "text") {
    if (state.sendMode === "mirror") {
      handleMirrorKey(key, name, ctrl)
      return
    }
    if (!instant) {
      // Composing: the input owns the keyboard.
      //
      // Once a block has been sent the field is empty again, so Backspace has
      // nothing local to delete and only means one thing: erase on the TV.
      // Repeats batch into a single keyevent call like every other keystroke.
      if (name === "backspace" && !textInput.value) {
        enqueuePart({ code: KEY.DEL, label: "DEL" })
        key.stopPropagation()
        return
      }
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
    // Instant: every printable key goes to the TV, batched. The echo is local
    // and immediate — waiting 1.7s for the device to confirm a letter is what
    // made typing feel broken.
    if (name === "backspace") {
      state.echo = state.echo.slice(0, -1)
      enqueuePart({ code: KEY.DEL, label: "DEL" })
      update()
      key.stopPropagation()
      return
    }
    const ch = typeof key.sequence === "string" && key.sequence.length === 1 ? key.sequence : null
    if (!ctrl && ch && ch >= " ") {
      state.echo += ch
      // BYPASS (companion route): gathering keystrokes into one call exists because
      // one `input` costs 1.2-1.6 s. A commit is single-digit milliseconds, so each
      // character goes out on its own — nothing to gather, nothing to wait for.
      // The adb route still batches, unchanged.
      if (typingPath().route === "companion") sendText(ch)
      else enqueuePart({ text: ch })
      update()
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
  if (letter === "c" && !ctrl) {
    // Probe the companion: is it installed, is it answering, start it if not.
    probeCompanionNow()
    key.stopPropagation()
    return
  }
  if (letter === "m" && !ctrl) {
    // Cursor mode: the local mouse drives a TV pointer, and `m` again (or Esc,
    // above) hands the mouse back. See toggleCursorMode().
    toggleCursorMode()
    key.stopPropagation()
    return
  }

  // ---- SEND MODE module
  if (mod === "sendmode") {
    if (["up", "down", "left", "right", "return", "space"].includes(name)) {
      const order = ["mirror", "block", "instant"]
      setSendMode(order[(order.indexOf(state.sendMode) + 1) % order.length])
      key.stopPropagation()
    } else if (name === "k") {
      cycleLayout()
      key.stopPropagation()
    } else if (name === "i") {
      enqueue(switchTvKeyboard)
      key.stopPropagation()
    }
    return
  }

  // ---- VOLUME module
  if (mod === "volume") {
    if (name === "up" || name === "down") {
      const up = name === "up"
      enqueuePart({ code: up ? KEY.VOL_UP : KEY.VOL_DOWN, label: up ? "VOLUME_UP" : "VOLUME_DOWN" })
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
    enqueuePart({ code: arrows[name], label: arrowLabels[name] })
    key.stopPropagation()
    return
  }
  if (name === "return") {
    enqueuePart({ code: KEY.OK, label: "DPAD_CENTER" })
    key.stopPropagation()
    return
  }
  if (name === "backspace" || name === "b") {
    enqueuePart({ code: KEY.BACK, label: "BACK" })
    key.stopPropagation()
    return
  }
  if (name === "h") {
    enqueuePart({ code: KEY.HOME, label: "HOME" })
    key.stopPropagation()
    return
  }
  if (!ctrl && (name === "+" || name === "=")) {
    enqueuePart({ code: KEY.VOL_UP, label: "VOLUME_UP" })
    key.stopPropagation()
    return
  }
  if (!ctrl && (name === "-" || name === "_")) {
    enqueuePart({ code: KEY.VOL_DOWN, label: "VOLUME_DOWN" })
    key.stopPropagation()
  }
}

// ---------------------------------------------------------------- boot
// `--auto` opens the first connected device straight away (demos/screenshots).
const autoOpen = process.argv.includes("--auto") || process.env.TV_REMOTE_AUTO === "1"
// `--demo` drives the UI with no TV attached (design work, screenshots).
const demo = process.argv.includes("--demo") || process.env.TV_REMOTE_DEMO === "1"

async function boot() {
  // Say it out loud when adb had to be swapped or is missing: on a platform with
  // no staged toolchain this is the difference between "nothing works" and a fix.
  const note = adbNote()
  if (note && !demo) pushLog(`ℹ ${note}`)
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

// The key transport is a socket plus a JVM on the TV: hand both back however the
// app ends, so a 2 GB set is not left with a resident monkey (one was enough to
// make `uiautomator dump` fail with rc=137). The companion's `adb forward` is handed
// back for the same reason: it is a listener on 127.0.0.1 of this machine, and it
// must not outlive the session that made it.
process.on("exit", () => {
  stopMonkeySync("app exit")
  removeCompanionForwardsSync("app exit")
})
for (const signal of ["SIGINT", "SIGTERM", "SIGHUP"]) {
  process.on(signal, () => {
    stopMonkeySync(signal)
    removeCompanionForwardsSync(signal)
    process.exit(0)
  })
}
