// Which packages are running on the TV, and stopping one.
//
// WHAT A NON-ROOT SHELL CAN SEE — measured on this TCL Android 11 TV (API 30),
// uid 2000(shell), whose groups include 3009(readproc):
//
//   ps -A ..................... 295 processes, the whole system: root, system,
//                              media, logd, every app uid (u0_a84, u0_a85 …).
//                              0.20 s. On THIS set it is complete.
//   pm list packages .......... 125 packages, 0.12 s
//   pm list packages -3 ....... 5 user-installed packages, 0.11 s
//   dumpsys activity processes  0.15 s, 99 ProcessRecord blocks, 32 processes in
//                              the LRU list — the same app processes ps shows,
//                              plus their adj/cached state (not used here).
//
// So the often-repeated "ps -A from uid 2000 hides other apps on Android 11" is
// FALSE here: readproc makes /proc readable, and the three sources agree. The
// one real limit is in the other direction: `ps` prints process NAMES, and a
// process whose name is not an installed package id is dropped by the filter
// below — an app that renames its own process would look absent rather than
// misreported. There is nothing invisible-but-running to compensate for.
//
// KILLING. `am force-stop <pkg>` is the only usable route:
//
//   - it answers NOTHING and exits 0, including for a package that does not
//     exist (`am force-stop com.nonexistent.pkg` → rc=0, empty output), so the
//     exit code is never the verdict — the process list is;
//   - `kill -9 <pid>` is not an option from the shell: it owns no app process,
//     and the kernel answers "kill: 2642: Operation not permitted" (measured on
//     com.tcl.esticker, uid 1000). That refusal is what makes force-stop the
//     path rather than a preference.
import { adb } from "./adb.mjs"

/** `pkg:sub` / `pkg:service:0` → `pkg`. Process names are package ids for apps. */
export const packageOf = (name) => String(name).split(":")[0]

/** One `package:` line per entry, as `pm list packages` prints them. */
export function parsePackageList(out) {
  return new Set(
    String(out || "")
      .split("\n")
      .map((line) => line.replace(/^package:/, "").trim())
      .filter(Boolean),
  )
}

/**
 * `ps -A` rows → `[{ pid, name, pkg }]`, keeping only rows whose NAME looks
 * like a package id (a dot, no leading bracket — the kernel threads print as
 * `[kworker/0:0H]`). The caller narrows this to actually-installed packages.
 */
export function parseProcesses(out) {
  const rows = []
  for (const raw of String(out || "").split("\n")) {
    const line = raw.trim()
    if (!line || /^USER\s+PID\b/.test(line)) continue
    const f = line.split(/\s+/)
    if (f.length < 3) continue
    const pid = Number(f[1])
    const name = f[f.length - 1]
    if (!Number.isInteger(pid) || pid <= 0) continue
    if (!/^[A-Za-z]/.test(name) || !name.includes(".")) continue
    rows.push({ pid, name, pkg: packageOf(name) })
  }
  return rows
}

/**
 * The running packages, one entry per package (`pkg`, the first `pid` seen, and
 * whether the package is user-installed). Three probes in parallel, ~0.3 s wall.
 */
export async function probeProcesses(serial) {
  const [ps, allOut, thirdOut] = await Promise.all([
    adb(["-s", serial, "shell", "ps", "-A"]),
    adb(["-s", serial, "shell", "pm", "list", "packages"]),
    adb(["-s", serial, "shell", "pm", "list", "packages", "-3"]),
  ])

  const rows = parseProcesses(ps.out)
  const installed = parsePackageList(allOut.out)
  const user = parsePackageList(thirdOut.out)

  // Isolated renderers are named after the package that hosts them, not after the
  // app whose page they render (`com.google.android.webview:sandboxed_process0:…`
  // inside SmartTube). Stopping that package is meaningless and `pidof` on the
  // short name would not even find it, so they are counted and left out rather
  // than listed as something a human could act on. They die with their host.
  let sandboxed = 0
  const byPkg = new Map()
  for (const row of rows) {
    if (row.name.includes(":sandboxed_process")) {
      sandboxed += 1
      continue
    }
    // Only real packages: that is what filters out init, zygote, media.codec and
    // the other native process names that happen to contain a dot.
    if (installed.size && !installed.has(row.pkg)) continue
    const prev = byPkg.get(row.pkg)
    if (!prev || row.pid < prev.pid) byPkg.set(row.pkg, { pkg: row.pkg, pid: row.pid, user: user.has(row.pkg) })
  }

  const running = [...byPkg.values()].sort(
    (a, b) => Number(b.user) - Number(a.user) || a.pkg.localeCompare(b.pkg),
  )

  const error =
    !ps.ok && !ps.out
      ? ps.err || "ps -A failed"
      : !running.length && !installed.size
        ? "the TV listed no packages — probe failed"
        : null
  return {
    at: new Date().toISOString(),
    running,
    error: error || null,
    counts: {
      psRows: rows.length,
      packages: installed.size,
      userPackages: user.size,
      running: running.length,
      sandboxed,
    },
  }
}

/** `pidof <pkg>` → the pid, or null when nothing is running under that name. */
export async function pidOf(serial, pkg) {
  const r = await adb(["-s", serial, "shell", "pidof", pkg])
  const pid = Number((r.out || "").trim().split(/\s+/)[0])
  return Number.isInteger(pid) && pid > 0 ? pid : null
}

/** The exact command this app runs to stop a package, and what the TV answered. */
export function forceStop(serial, pkg) {
  return adb(["-s", serial, "shell", "am", "force-stop", pkg])
}

/**
 * The verdict for a stop, from what was measured rather than from the exit code:
 * `before` and `after` are the pids `pidof` reported, `r` the force-stop reply.
 * Kept pure so the wording and the cases are in one place.
 */
export function stopVerdict(label, { before, after, ok, err }) {
  if (!ok) return { level: "failed", text: `✗ force-stop refused — ${err || "adb failed"}` }
  if (before === null && after === null)
    return { level: "idle", text: `· ${label} was not running — force-stop sent, nothing to stop` }
  if (after === null) return { level: "stopped", text: `✓ stopped ${label} (pid ${before} gone) — am force-stop` }
  if (before === null)
    return { level: "appeared", text: `· ${label} is running now as pid ${after} — it was not before the command` }
  return {
    level: "back",
    text:
      before === after
        ? `✗ ${label} is still running (pid ${after}) — the TV accepted the command and nothing changed`
        : `✗ ${label} came back as pid ${after} — force-stop was accepted, the process restarted`,
  }
}

/** Force-stop + prove it with `pidof`, so "the command returned" is never the claim. */
export async function stopPackage(serial, pkg) {
  const started = Date.now()
  const before = await pidOf(serial, pkg)
  const r = await forceStop(serial, pkg)
  const after = await pidOf(serial, pkg)
  const verdict = stopVerdict(pkg, { before, after, ok: r.ok, err: r.err })
  return { pkg, before, after, ms: Date.now() - started, command: `am force-stop ${pkg}`, answer: r.out || r.err || "", ...verdict }
}

/** `--demo`: something to look at without a TV. */
export const DEMO_PROCS = [
  { pkg: "org.smarttube.stable", pid: 3972, user: true },
  { pkg: "com.fgl27.twitch", pid: 1219, user: true },
  { pkg: "com.tvremote.companion", pid: 4211, user: true },
  { pkg: "com.android.systemui", pid: 1035, user: false },
  { pkg: "com.tcl.esticker", pid: 2642, user: false },
  { pkg: "com.google.android.gms", pid: 1735, user: false },
]

export const demoRunning = () => new Map(DEMO_PROCS.map((p) => [p.pkg, p.pid]))
