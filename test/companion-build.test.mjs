// Which APK the setup flow will install: the prebuilt one when it is newer than
// every source file, and the build script when it is not. Runs against a temp
// fixture tree, so the answer is checked against mtimes this test controls rather
// than against whatever dist/ happens to hold today.
import test from "node:test"
import assert from "node:assert/strict"
import * as fs from "node:fs"
import * as os from "node:os"
import { join } from "node:path"

import { BUILD_SCRIPT, companionApkStatus, newestSourceMtime, repoRoot } from "../src/companion-build.mjs"

function fixture() {
  const root = fs.mkdtempSync(join(os.tmpdir(), "tv-remote-tui-apk-"))
  fs.mkdirSync(join(root, "dist"), { recursive: true })
  fs.mkdirSync(join(root, "companion", "src"), { recursive: true })
  fs.writeFileSync(join(root, BUILD_SCRIPT), "#!/usr/bin/env bash\nexit 0\n")
  touch(join(root, BUILD_SCRIPT), 3600) // the script is an input, but not a fresh one
  return root
}

const touch = (path, secondsAgo) => {
  const t = (Date.now() - secondsAgo * 1000) / 1000
  fs.utimesSync(path, t, t)
}

test("no APK is reported as absent, not as stale", () => {
  const root = fixture()
  const status = companionApkStatus({ root })
  assert.equal(status.present, false)
  assert.equal(status.stale, false)
  assert.equal(status.bytes, 0)
  assert.equal(status.scriptPresent, true)
})

test("an APK newer than the sources is what the setup installs", () => {
  const root = fixture()
  const java = join(root, "companion", "src", "Thing.java")
  fs.writeFileSync(java, "class Thing {}\n")
  touch(java, 600)
  const apk = join(root, "dist", "tv-companion.apk")
  fs.writeFileSync(apk, "APK")
  touch(apk, 60)

  const status = companionApkStatus({ root })
  assert.equal(status.present, true)
  assert.equal(status.stale, false, "a source older than the APK does not make it stale")
  assert.equal(status.bytes, 3)
})

test("a source newer than the APK makes it stale — and a missing build script is its own answer", () => {
  const root = fixture()
  const apk = join(root, "dist", "tv-companion.apk")
  fs.writeFileSync(apk, "APK")
  touch(apk, 600)
  const java = join(root, "companion", "src", "Thing.java")
  fs.writeFileSync(java, "class Thing {}\n")
  touch(java, 60)

  assert.equal(companionApkStatus({ root }).stale, true)

  fs.rmSync(join(root, BUILD_SCRIPT))
  const status = companionApkStatus({ root })
  assert.equal(status.stale, true)
  assert.equal(status.scriptPresent, false)
})

test("a leftover build directory is not a source", () => {
  const root = fixture()
  const apk = join(root, "dist", "tv-companion.apk")
  fs.writeFileSync(apk, "APK")
  touch(apk, 600)
  const intermediate = join(root, "companion", "build")
  fs.mkdirSync(intermediate, { recursive: true })
  fs.writeFileSync(join(intermediate, "classes.dex"), "x")
  touch(join(intermediate, "classes.dex"), 30)

  assert.equal(companionApkStatus({ root }).stale, false, "companion/build is a --debug artefact, not an input")
  assert.ok(newestSourceMtime(join(root, "companion")) > 0)
})

test("notes are not sources: editing a README must not rebuild the APK", () => {
  const root = fixture()
  const apk = join(root, "dist", "tv-companion.apk")
  fs.writeFileSync(apk, "APK")
  touch(apk, 600)
  const java = join(root, "companion", "src", "Thing.java")
  fs.writeFileSync(java, "class Thing {}\n")
  touch(java, 3600)
  const readme = join(root, "companion", "README.md")
  fs.writeFileSync(readme, "docs\n")
  touch(readme, 10)

  assert.equal(companionApkStatus({ root }).stale, false, "only java/xml/sh are inputs")
})

test("this repository's own APK is present and not older than its sources", (t) => {
  const status = companionApkStatus({ root: repoRoot() })
  assert.equal(status.scriptPresent, true)
  // dist/ is gitignored, so a clean checkout has no APK to inspect. This is a
  // freshness guard for a working tree, not a correctness assertion: skip it
  // rather than fail, or CI reports a bug that is not one.
  if (!status.present) return t.skip(`no prebuilt APK at ${status.path} (dist/ is not committed)`)
  assert.equal(status.stale, false, "dist/tv-companion.apk is older than companion/ — the setup would rebuild it")
})
