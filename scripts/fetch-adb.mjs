#!/usr/bin/env node
// Download Google's platform-tools for a target platform and install adb where
// the app looks for it at runtime: assets/platform-tools/<platform>-<arch>/.
//
//   node scripts/fetch-adb.mjs                    # this machine
//   node scripts/fetch-adb.mjs --target linux-x64 # a target you want to build for
//   node scripts/fetch-adb.mjs --stage            # also write the embed archive
//
// Google ships one universal macOS build and x64 builds for Linux and Windows,
// so linux-arm64 and win32-arm64 have no download and fall back to a system adb.
import { execFileSync } from "node:child_process"
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { basename, join } from "node:path"
import { fileURLToPath, pathToFileURL } from "node:url"
import { createTarGz } from "../src/archive.mjs"
import { adbFiles, adbName, platformKey, platformToolsUrl, splitKey } from "../src/platform.mjs"

const root = join(fileURLToPath(import.meta.url), "..", "..")
export const archivePath = join(root, "assets", "platform-tools.tar.gz")
export const toolDir = (key) => join(root, "assets", "platform-tools", key)

function log(...args) {
  console.log("[adb]", ...args)
}

/** Download a URL to a file. */
async function download(url, dest) {
  const response = await fetch(url, { redirect: "follow" })
  if (!response.ok) throw new Error(`download failed: ${response.status} ${response.statusText}`)
  const bytes = Buffer.from(await response.arrayBuffer())
  writeFileSync(dest, bytes)
  return bytes.length
}

/** Google ships zips; there is no zip support in Node, so use the system tool. */
function unzip(zip, dest) {
  const attempts = [
    ["unzip", ["-o", "-q", zip, "-d", dest]],
    ["tar", ["-xf", zip, "-C", dest]], // bsdtar reads zip (macOS, Windows 10+)
  ]
  for (const [cmd, args] of attempts) {
    try {
      execFileSync(cmd, args, { stdio: "ignore" })
      return true
    } catch {
      // try the next extractor
    }
  }
  return false
}

/** Fetch platform-tools for `key` and install the files adb needs. */
export async function fetchAdb(key = platformKey()) {
  const url = platformToolsUrl(key)
  if (!url) {
    log(`${key}: no official platform-tools build, the app will use the adb on PATH`)
    return { key, ok: false, reason: "no-download" }
  }
  const dest = toolDir(key)
  if (adbFiles(splitKey(key).platform).every((f) => existsSync(join(dest, f)))) {
    log(`${key}: already present in assets/platform-tools/${key}`)
    return { key, ok: true, cached: true }
  }

  const scratch = mkdtempSync(join(tmpdir(), "platform-tools-"))
  try {
    const zip = join(scratch, basename(new URL(url).pathname))
    log(`${key}: downloading ${url}`)
    const size = await download(url, zip)
    log(`${key}: ${(size / 1024 / 1024).toFixed(1)} MB, extracting`)
    if (!unzip(zip, scratch)) {
      throw new Error("could not extract the zip (needs `unzip` or a `tar` that reads zip)")
    }
    const inner = join(scratch, "platform-tools")
    if (!existsSync(inner)) throw new Error("the download did not contain a platform-tools directory")

    mkdirSync(dest, { recursive: true })
    const wanted = [...adbFiles(splitKey(key).platform), "NOTICE.txt", "source.properties"]
    for (const file of wanted) {
      if (existsSync(join(inner, file))) copyFileSync(join(inner, file), join(dest, file))
    }
    for (const file of adbFiles(splitKey(key).platform)) {
      if (!existsSync(join(dest, file))) throw new Error(`the download had no ${file}`)
    }
    log(`${key}: installed adb into assets/platform-tools/${key}`)
    return { key, ok: true }
  } finally {
    rmSync(scratch, { recursive: true, force: true })
  }
}

/** Pack the fetched toolchain into the archive a compiled binary embeds. */
export function stageArchive(key = platformKey()) {
  const dir = toolDir(key)
  const files = adbFiles(splitKey(key).platform).map((name) => ({
    name,
    data: readFileSync(join(dir, name)),
    mode: name.toLowerCase().endsWith(".dll") ? 0o644 : 0o755,
  }))
  if (!files.length) throw new Error(`nothing staged for ${key}`)
  writeFileSync(archivePath, createTarGz(files))
  const size = readFileSync(archivePath).length
  log(`staged ${files.length} file(s) for ${key} into assets/platform-tools.tar.gz (${(size / 1024 / 1024).toFixed(1)} MB)`)
  return archivePath
}

async function main() {
  const argv = process.argv.slice(2)
  // --target linux-x64 --target win32-x64, or --target=x64-style, or comma separated
  const targets = argv.flatMap((arg, i) => {
    if (arg === "--target") return (argv[i + 1] ?? "").split(",")
    if (arg.startsWith("--target=")) return arg.slice("--target=".length).split(",")
    return []
  }).filter(Boolean)
  const keys = targets.length ? targets : [platformKey()]
  const stage = argv.includes("--stage")

  for (const key of keys) {
    const result = await fetchAdb(key)
    if (stage && result.ok) stageArchive(key)
  }
}

// Only run when invoked as a script: build.mjs imports the functions above.
const isMain = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href
if (isMain) {
  main().catch((error) => {
    console.error("[adb] failed:", error.message)
    process.exit(1)
  })
}
