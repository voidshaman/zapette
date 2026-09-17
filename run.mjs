#!/usr/bin/env node
// Portable launcher. OpenTUI's native core needs Node 26.4 or newer and the
// --experimental-ffi flag, but the `node` on PATH is often older (system, nvm,
// asdf). Find one that works and hand over to it. Deliberately written for old
// Node versions too, since it may be the first thing a fresh machine runs.
import { existsSync, readdirSync } from "node:fs"
import { homedir } from "node:os"
import { delimiter, join } from "node:path"
import { spawnSync } from "node:child_process"
import { fileURLToPath } from "node:url"

const MIN = [26, 4]
const exe = process.platform === "win32" ? "node.exe" : "node"
const here = join(fileURLToPath(import.meta.url), "..")

function versionOf(bin) {
  const r = spawnSync(bin, ["-p", "process.versions.node"], { encoding: "utf8" })
  const text = (r.stdout || "").trim()
  return r.status === 0 && /^\d+\.\d+\.\d+/.test(text) ? text : null
}

function newEnough(version) {
  const [major, minor] = version.split(".").map(Number)
  return major > MIN[0] || (major === MIN[0] && minor >= MIN[1])
}

function candidates() {
  const home = homedir()
  const list = []
  if (process.env.NODE_BIN) list.push(process.env.NODE_BIN)
  list.push(process.execPath)
  list.push(join(home, ".hermes", "node", "bin", exe))
  const nvm = join(home, ".nvm", "versions", "node")
  try {
    for (const dir of readdirSync(nvm).sort().reverse()) list.push(join(nvm, dir, "bin", exe))
  } catch {
    // no nvm, fine
  }
  for (const dir of (process.env.PATH || "").split(delimiter)) {
    if (dir) list.push(join(dir, exe))
  }
  if (process.platform === "win32") {
    list.push(join(process.env.ProgramFiles || "C:\\Program Files", "nodejs", exe))
  }
  return [...new Set(list)]
}

let chosen = null
for (const bin of candidates()) {
  if (bin !== exe && !existsSync(bin)) continue
  const version = versionOf(bin)
  if (version && newEnough(version)) {
    chosen = bin
    break
  }
}

if (!chosen) {
  console.error(`tv-remote-tui needs Node ${MIN.join(".")} or newer, and could not find one.`)
  console.error("Install it from https://nodejs.org, or set NODE_BIN to an existing install.")
  process.exit(1)
}

const result = spawnSync(
  chosen,
  ["--experimental-ffi", "--disable-warning=ExperimentalWarning", join(here, "src", "app.mjs"), ...process.argv.slice(2)],
  { stdio: "inherit" },
)
process.exit(result.status ?? 1)
