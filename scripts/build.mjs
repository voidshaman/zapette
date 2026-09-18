#!/usr/bin/env node
// Build standalone binaries with Bun.
//
//   node scripts/build.mjs                     # this machine, adb embedded
//   node scripts/build.mjs --slim              # no adb embedded
//   node scripts/build.mjs --target linux-x64  # cross-build (installs that
//                                              # target's OpenTUI native package)
//   node scripts/build.mjs --all               # every supported target
//
// A target's adb is staged first, so the binary embeds the toolchain for the
// platform it is built for, not for the machine doing the building.
import { execFileSync } from "node:child_process"
import { rmSync, statSync } from "node:fs"
import { join } from "node:path"
import { fileURLToPath } from "node:url"
import { adbFiles, bunTarget, platformKey, platformToolsUrl, splitKey } from "../src/platform.mjs"
import { archivePath, fetchAdb, stageArchive, toolDir } from "./fetch-adb.mjs"

const root = join(fileURLToPath(import.meta.url), "..", "..")
const CORE_VERSION = "0.5.11"
const ALL = ["darwin-x64", "darwin-arm64", "linux-x64", "linux-arm64", "win32-x64", "win32-arm64"]

function run(cmd, args, options = {}) {
  execFileSync(cmd, args, { stdio: "inherit", cwd: root, ...options })
}

/**
 * Cross-building installs foreign native packages, and a later host build would
 * embed them too (the binary grew from 75 to 93 MB that way). Put the tree back
 * the way npm wants it for this machine once the cross-builds are done.
 */
function pruneToHost() {
  console.log("[build] restoring the local package tree")
  run("npm", ["install", "--no-audit", "--no-fund"], { stdio: "ignore" })
}

function ensureBun() {
  try {
    run("bun", ["--version"], { stdio: "ignore" })
  } catch {
    console.error("bun is required for a standalone build: https://bun.sh")
    process.exit(1)
  }
}

/**
 * The OpenTUI native packages a target needs at bundle time. Linux has two: the
 * glibc build and the musl build, and the bundle resolves both branches even
 * though only one is used at runtime, so both have to be installed.
 */
function nativePackages(target) {
  const { platform, arch } = splitKey(target)
  const base = `@opentui/core-${platform}-${arch}`
  return platform === "linux" ? [base, `${base}-musl`] : [base]
}

function installNative(target) {
  // The host's own node_modules normally satisfies the host target, so this is
  // skipped - EXCEPT on Linux. There the bundle resolves the musl branch as well
  // (see nativePackages), `npm ci` installs only the glibc build, and building
  // linux-x64 on a linux-x64 runner therefore fails with
  //   error: Could not resolve: "@opentui/core-linux-x64-musl"
  // which is exactly how a release once shipped without a Linux x64 binary.
  const { platform } = splitKey(target)
  if (target === platformKey() && platform !== "linux") return
  const names = nativePackages(target)
  console.log(`[build] installing ${names.join(", ")} for the cross-build`)
  // One command for all of them: a second `npm install --no-save` prunes the
  // packages the first one added, because they are not in package.json.
  // --force is needed too: npm refuses a package declaring another os/cpu
  // (EBADPLATFORM), which is exactly what cross-building asks for.
  run("npm", ["install", "--no-save", "--no-package-lock", "--force", ...names.map((n) => `${n}@${CORE_VERSION}`)])
}

async function build(target, { slim }) {
  const { platform } = splitKey(target)
  const embed = !slim && Boolean(platformToolsUrl(target))

  if (embed) {
    const have = adbFiles(platform).every((f) => {
      try {
        return statSync(join(toolDir(target), f)).size > 0
      } catch {
        return false
      }
    })
    if (!have) await fetchAdb(target)
    stageArchive(target)
  } else if (!slim) {
    console.log(`[build] ${target}: no adb to embed, the binary will use the adb on PATH`)
  }
  if (slim) rmSync(archivePath, { force: true })

  installNative(target)
  const stem =
    target === platformKey()
      ? `dist/zapette${slim ? "-slim" : ""}`
      : `dist/zapette-${target}${slim ? "-slim" : ""}`
  // Windows binaries carry .exe; say it explicitly so the reported path matches
  // what Bun writes (it would add the extension itself otherwise).
  const outfile = splitKey(target).platform === "win32" ? `${stem}.exe` : stem
  const args = ["build", "--compile", "--minify", `--target=${bunTarget(...Object.values(splitKey(target)))}`]
  if (embed) args.push("--define", "process.env.EMBED_ADB='\"1\"'")
  else args.push("--define", "process.env.EMBED_ADB='\"0\"'")
  args.push("./src/app.mjs", "--outfile", outfile)
  console.log(`[build] bun ${args.join(" ")}`)
  run("bun", args)
  const size = (statSync(join(root, outfile)).size / 1024 / 1024).toFixed(1)
  console.log(`[build] ${outfile} — ${size} MB\n`)
}

async function main() {
  const argv = process.argv.slice(2)
  const slim = argv.includes("--slim")
  ensureBun()
  if (argv.includes("--all")) {
    for (const target of ALL) {
      try {
        await build(target, { slim })
      } catch (error) {
        console.error(`[build] ${target} failed: ${error.message}`)
      }
    }
    if (!argv.includes("--keep-natives")) pruneToHost()
    return
  }
  const flag = argv.find((arg) => arg === "--target" || arg.startsWith("--target="))
  const target =
    flag === "--target" ? argv[argv.indexOf(flag) + 1] : flag ? flag.slice("--target=".length) : platformKey()
  await build(target, { slim })
  if (target !== platformKey() && !argv.includes("--keep-natives")) pruneToHost()
}

main().catch((error) => {
  console.error("[build] failed:", error.message)
  process.exit(1)
})
