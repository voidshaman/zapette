// Picking an APK off this machine: a plain directory walk, no dependencies.
//
// Why a walk in the TUI and not a native file dialog: this app IS a full-screen
// terminal UI. macOS's `osascript`, Linux's zenity/kdialog and Windows'
// PowerShell pickers each open a window that takes the focus away from the
// terminal, so the TUI would have to be suspended and restored around one, and
// each platform path would need its own "the tool is not installed" fallback.
// A directory walk costs one readdir per step, behaves the same in every
// terminal, and reuses the app's existing key vocabulary.
//
// What it lists is deliberately narrow: subdirectories (so the tree can be
// walked) and `*.apk` files (the only files that can be installed). That is the
// filter — a directory of 300 files shows the 2 APKs in it.
import { readdirSync, statSync } from "node:fs"
import { homedir } from "node:os"
import { dirname, join, resolve, sep } from "node:path"

// A directory can hold thousands of entries; the panel shows a dozen. Reading
// the whole name list is cheap, but rendering/sorting it is not free, so the
// tail is cut and counted rather than silently dropped.
const MAX_ENTRIES = 400

/** `~` and relative paths, resolved the way the path prompt resolves them. */
function expandPath(input, cwd = process.cwd()) {
  const text = String(input ?? "").trim()
  if (!text) return cwd
  const home = homedir()
  const expanded =
    text === "~" || text.startsWith(`~${sep}`) || text.startsWith("~/")
      ? join(home, text.slice(1))
      : text
  return resolve(cwd, expanded)
}

/** A path as it is shown: the home directory shrinks to `~`. */
export function tildePath(path) {
  const home = homedir()
  if (path === home) return "~"
  return path.startsWith(home + sep) ? `~${path.slice(home.length)}` : path
}

export const parentDir = (dir) => dirname(dir)

/** "812 B" / "1.4 MB" — enough to tell two builds of the same APK apart. */
export function sizeLabel(bytes) {
  if (!Number.isFinite(bytes)) return ""
  if (bytes < 1024) return `${bytes} B`
  const units = ["KB", "MB", "GB"]
  let value = bytes / 1024
  let unit = 0
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024
    unit += 1
  }
  return `${value.toFixed(value < 10 ? 1 : 0)} ${units[unit]}`
}

/**
 * One directory's worth of choices. Never throws: an unreadable directory
 * (permissions, it was removed under us) comes back as a plain error string so
 * the screen can say what the filesystem said instead of going blank.
 */
export function listDir(input, { max = MAX_ENTRIES, cwd = process.cwd() } = {}) {
  const dir = expandPath(input, cwd)
  let names
  try {
    names = readdirSync(dir)
  } catch (error) {
    const message = String(error?.message ?? error)
    const code = error?.code
    return {
      ok: false,
      dir,
      entries: [],
      truncated: 0,
      apkCount: 0,
      error: code && !message.startsWith(code) ? `${code}: ${message}` : message,
    }
  }

  const dirs = []
  const apks = []
  for (const name of names) {
    if (name.startsWith(".")) continue // dotfiles are not what a person picks an APK from
    const path = join(dir, name)
    let st
    try {
      st = statSync(path) // follows symlinks; a dangling one or a denied entry is skipped
    } catch {
      continue
    }
    if (st.isDirectory()) dirs.push({ kind: "dir", name, path })
    else if (st.isFile() && /\.apk$/i.test(name)) apks.push({ kind: "apk", name, path, size: st.size })
  }

  const byName = (a, b) => a.name.localeCompare(b.name, undefined, { sensitivity: "base" })
  dirs.sort(byName)
  apks.sort(byName)
  const all = [...dirs, ...apks]
  const entries = all.slice(0, max)
  return {
    ok: true,
    dir,
    entries,
    truncated: all.length - entries.length,
    apkCount: apks.length,
    error: null,
  }
}
