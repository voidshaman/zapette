// Preparing the companion APK: is there one, is it newer than the sources, and
// building it when it is not.
//
// The APK is checked into this tree's dist/ and rebuilt by
// companion/build.sh (aapt2 + javac + d8 + apksigner, no Gradle, no network).
// Building it takes tens of seconds, so the setup flow prefers a prebuilt APK
// that is newer than every source file under companion/ and only shells out to
// the build script when it is missing or stale.
import { existsSync, readdirSync, statSync } from "node:fs"
import { spawn } from "node:child_process"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"

export const APK_PATH = "dist/tv-companion.apk"
export const BUILD_SCRIPT = "companion/build.sh"
const SOURCE_DIR = "companion"
// Intermediates of a --debug build; they are not inputs.
const SKIP = new Set(["build", ".DS_Store"])
// What build.sh actually reads: java, resources/manifest XML, and itself. Notes
// (README.md, MEASUREMENTS.txt) are not inputs — editing one must not rebuild the
// APK, or a documentation pass would make every install rebuild.
const INPUT_EXTENSIONS = new Set(["java", "xml", "sh"])

/** The repository root this module lives in (src/..). */
export function repoRoot() {
  return join(dirname(fileURLToPath(import.meta.url)), "..")
}

/**
 * Newest mtime of a build INPUT under `dir`, recursively, in ms since the epoch
 * (0 if there is nothing there). Directories are not compared, so a `build/` left
 * behind by a --debug run cannot make the APK look stale, and only files
 * build.sh reads count.
 */
export function newestSourceMtime(dir) {
  let newest = 0
  let entries
  try {
    entries = readdirSync(dir, { withFileTypes: true })
  } catch {
    return 0
  }
  for (const entry of entries) {
    if (SKIP.has(entry.name)) continue
    const path = join(dir, entry.name)
    if (entry.isDirectory()) newest = Math.max(newest, newestSourceMtime(path))
    else if (INPUT_EXTENSIONS.has(entry.name.split(".").pop())) {
      try {
        newest = Math.max(newest, statSync(path).mtimeMs)
      } catch {
        // a file that vanished mid-walk is not an input
      }
    }
  }
  return newest
}

/**
 * The APK's state on this machine. `stale` is true only when an APK is there and
 * a source file is newer than it — a missing APK is reported as not present and
 * nothing more.
 */
export function companionApkStatus({ root = repoRoot() } = {}) {
  const path = join(root, APK_PATH)
  const script = join(root, BUILD_SCRIPT)
  let stat = null
  try {
    stat = statSync(path)
  } catch {
    stat = null
  }
  const present = Boolean(stat?.isFile())
  const sourceMtime = newestSourceMtime(join(root, SOURCE_DIR))
  return {
    path,
    present,
    bytes: stat?.size ?? 0,
    apkMtime: stat?.mtimeMs ?? 0,
    sourceMtime,
    stale: present && sourceMtime > stat.mtimeMs,
    script,
    scriptPresent: existsSync(script),
  }
}

/**
 * Run companion/build.sh. Never throws: a missing toolchain comes back as
 * `ok:false` with build.sh's own sentence ("no JDK found …") in `tail`, which is
 * the thing worth showing the user.
 */
export function buildCompanionApk({ root = repoRoot(), timeoutMs = 240000, onLine } = {}) {
  return new Promise((resolve) => {
    const script = join(root, BUILD_SCRIPT)
    const started = Date.now()
    if (!existsSync(script)) {
      return resolve({ ok: false, error: `${BUILD_SCRIPT} is not on this machine`, ms: 0, tail: "" })
    }
    let child
    try {
      child = spawn("bash", [script], { cwd: root, stdio: ["ignore", "pipe", "pipe"] })
    } catch (e) {
      return resolve({ ok: false, error: `could not start bash: ${e?.message ?? e}`, ms: 0, tail: "" })
    }
    const lines = []
    const feed = (chunk) => {
      for (const line of chunk.toString("utf8").split("\n")) {
        const text = line.trim()
        if (!text) continue
        lines.push(text)
        if (lines.length > 40) lines.shift()
        onLine?.(text)
      }
    }
    child.stdout.on("data", feed)
    child.stderr.on("data", feed)
    const timer = setTimeout(() => {
      try {
        child.kill("SIGKILL")
      } catch {
        // already gone
      }
      resolve({ ok: false, error: `${BUILD_SCRIPT} timed out after ${Math.round(timeoutMs / 1000)}s`, ms: Date.now() - started, tail: lines.slice(-3).join(" | ") })
    }, timeoutMs)
    child.once("error", (e) => {
      clearTimeout(timer)
      resolve({ ok: false, error: `could not run ${BUILD_SCRIPT}: ${e?.message ?? e}`, ms: Date.now() - started, tail: "" })
    })
    child.once("exit", (code) => {
      clearTimeout(timer)
      resolve({ ok: code === 0, code, ms: Date.now() - started, tail: lines.slice(-3).join(" | "), lines })
    })
  })
}
