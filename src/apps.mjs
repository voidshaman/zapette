// The TV's launchable apps: probed over adb, cached on disk, launched by component.
//
// Two things worth knowing (verified on a TCL Android 11 TV):
//
// - The cheap probe is the package manager's own activity resolver:
//     cmd package query-activities --brief -a android.intent.action.MAIN \
//       -c android.intent.category.LEANBACK_LAUNCHER
//   It returns `package/activity` pairs (~0.12s for 20 entries, and leanback is
//   the TV category: asking for LAUNCHER too catches the phone-style apps).
// - Package ids are not names, and adb cannot resolve a label's string resource,
//   so labels come from a small curated map and fall back to the id itself.
import { mkdirSync, readFileSync, writeFileSync } from "node:fs"
import { dirname, join } from "node:path"
import { adb } from "./adb.mjs"
import { historyPath } from "./devices.mjs"

const CATEGORIES = ["android.intent.category.LEANBACK_LAUNCHER", "android.intent.category.LAUNCHER"]

// Ids that say nothing about the app. Anything missing here shows its package id.
const NAMES = {
  "com.android.vending": "Play Store",
  "com.google.android.youtube.tv": "YouTube",
  "org.smarttube.stable": "SmartTube",
  "com.netflix.ninja": "Netflix",
  "com.amazon.amazonvideo.livingroom": "Prime Video",
  "com.fgl27.twitch": "Twitch (SmartTwitchTV)",
  "com.stremio.one": "Stremio",
  "com.spotify.tv.android": "Spotify",
  "com.disney.disneyplus": "Disney+",
  "com.hbo.hbonow": "HBO Max",
  "com.google.android.katniss": "Google Assistant",
  "com.android.tv.settings": "Settings",
  "com.google.android.tvlauncher": "TV launcher",
  "com.tcl.tv": "TCL live TV",
  "com.tcl.browser": "TCL browser",
  "org.xbmc.kodi": "Kodi",
  "com.plexapp.android": "Plex",
  "org.videolan.vlc": "VLC",
  "com.google.android.apps.tv.launcherx": "Google TV launcher",
  "com.android.systemui": "System UI",
}

export function appsPath() {
  return join(dirname(historyPath()), "apps.json")
}

export const labelFor = (pkg) => NAMES[pkg] ?? pkg

/** Cached probe for one TV: `{ at, apps }` or null when nothing was stored yet. */
export function loadApps(serial) {
  if (!serial) return null
  try {
    const parsed = JSON.parse(readFileSync(appsPath(), "utf8"))
    const entry = parsed?.bySerial?.[serial]
    return Array.isArray(entry?.apps) && entry.apps.length ? entry : null
  } catch {
    return null
  }
}

export function saveApps(serial, apps) {
  const file = appsPath()
  let all = { version: 1, bySerial: {} }
  try {
    const parsed = JSON.parse(readFileSync(file, "utf8"))
    if (parsed?.bySerial) all = parsed
  } catch {
    /* first write */
  }
  all.bySerial = { ...(all.bySerial ?? {}), [serial]: { at: new Date().toISOString(), apps } }
  try {
    mkdirSync(dirname(file), { recursive: true })
    writeFileSync(file, `${JSON.stringify(all, null, 2)}\n`)
    return true
  } catch {
    return false
  }
}

/**
 * Launchable components advertised by the device's package manager, one entry per
 * package (the leanback entry wins), user-installed apps first.
 */
export async function listApps(serial) {
  const seen = new Map()
  let error = null
  for (const category of CATEGORIES) {
    const r = await adb([
      "-s",
      serial,
      "shell",
      "cmd",
      "package",
      "query-activities",
      "--brief",
      "-a",
      "android.intent.action.MAIN",
      "-c",
      category,
    ])
    if (!r.ok && !r.out) {
      error = r.err || "query-activities failed"
      continue
    }
    for (const line of r.out.split("\n")) {
      const m = /^\s*([A-Za-z0-9_]+(?:\.[A-Za-z0-9_]+)+)\/([A-Za-z0-9_.$]+)\s*$/.exec(line)
      if (!m) continue
      const pkg = m[1]
      const activity = m[2]
      if (seen.has(pkg)) continue
      seen.set(pkg, { pkg, activity, component: `${pkg}/${activity}`, label: labelFor(pkg), category })
    }
  }

  const thirdParty = await adb(["-s", serial, "shell", "pm", "list", "packages", "-3"])
  const userPkgs = new Set(
    (thirdParty.out || "")
      .split("\n")
      .map((l) => l.replace(/^package:/, "").trim())
      .filter(Boolean),
  )

  const apps = [...seen.values()].map((a) => ({ ...a, user: userPkgs.has(a.pkg) }))
  apps.sort((a, b) => Number(b.user) - Number(a.user) || a.label.localeCompare(b.label))
  return { apps, error: apps.length ? null : (error ?? "the TV reported no launchable apps") }
}

/**
 * Start an app by component. `am start -n` is the precise way; if the activity
 * refuses, fall back to monkey, which asks the launcher intent instead.
 */
export async function launchApp(serial, app) {
  const r = await adb(["-s", serial, "shell", "am", "start", "-n", app.component])
  const text = `${r.out} ${r.err}`.trim()
  if (!/error|exception|does not exist|not found/i.test(text)) {
    return { ok: true, via: "am start", out: text }
  }
  const m = await adb([
    "-s",
    serial,
    "shell",
    "monkey",
    "-p",
    app.pkg,
    "-c",
    "android.intent.category.LEANBACK_LAUNCHER",
    "1",
  ])
  const mtext = `${m.out} ${m.err}`.trim()
  const ok = !/error|exception|aborted|no activities/i.test(mtext)
  return { ok, via: "monkey", out: ok ? mtext : `${text} | ${mtext}` }
}

/** `--demo`: a stand-in list so the screen can be designed without a TV. */
export const DEMO_APPS = [
  { pkg: "com.fgl27.twitch", activity: ".PlayerActivity", component: "com.fgl27.twitch/.PlayerActivity", label: "Twitch (SmartTwitchTV)", user: true },
  { pkg: "org.smarttube.stable", activity: "com.liskovsoft.smartyoutubetv2.tv.ui.main.SplashActivity", component: "org.smarttube.stable/com.liskovsoft.smartyoutubetv2.tv.ui.main.SplashActivity", label: "SmartTube", user: true },
  { pkg: "com.stremio.one", activity: "com.stremio.tv.MainActivity", component: "com.stremio.one/com.stremio.tv.MainActivity", label: "Stremio", user: true },
  { pkg: "com.netflix.ninja", activity: ".MainActivity", component: "com.netflix.ninja/.MainActivity", label: "Netflix", user: false },
  { pkg: "com.google.android.youtube.tv", activity: "com.google.android.apps.youtube.tv.activity.ShellActivity", component: "com.google.android.youtube.tv/com.google.android.apps.youtube.tv.activity.ShellActivity", label: "YouTube", user: false },
  { pkg: "com.android.vending", activity: "com.google.android.finsky.tvmainactivity.TvMainActivity", component: "com.android.vending/com.google.android.finsky.tvmainactivity.TvMainActivity", label: "Play Store", user: false },
]
