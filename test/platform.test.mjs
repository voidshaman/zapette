// Platform behaviour that cannot be exercised by running the app on one machine:
// the other systems' directory conventions, their neighbour-cache output, and the
// tar handling that a compiled binary uses to unpack its adb.
//
//   node --test test/
import assert from "node:assert/strict"
import { execFileSync } from "node:child_process"
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { test } from "node:test"
import { createTar, createTarGz, extractTar, extractTarGz } from "../src/archive.mjs"
import { arpMac, normalizeMac, parseArp, parseMac } from "../src/arp.mjs"
import { adbFiles, adbName, bunTarget, cacheDir, platformKey, platformToolsUrl, stateDir } from "../src/platform.mjs"

const scratch = () => mkdtempSync(join(tmpdir(), "zapette-test-"))

test("target naming matches OpenTUI packages and Bun's --target", () => {
  assert.equal(platformKey("darwin", "arm64"), "darwin-arm64")
  assert.equal(platformKey("win32", "x64"), "win32-x64")
  assert.equal(bunTarget("darwin", "arm64"), "bun-darwin-arm64")
  assert.equal(bunTarget("linux", "x64"), "bun-linux-x64")
  assert.equal(bunTarget("win32", "x64"), "bun-windows-x64")
})

test("cache directory follows each system's convention", () => {
  assert.equal(cacheDir("darwin", {}, "/Users/x"), join("/Users/x", "Library", "Caches"))
  assert.equal(cacheDir("linux", {}, "/home/x"), join("/home/x", ".cache"))
  assert.equal(cacheDir("linux", { XDG_CACHE_HOME: "/tmp/c" }, "/home/x"), "/tmp/c")
  assert.equal(cacheDir("win32", { LOCALAPPDATA: "C:/Users/x/AppData/Local" }, "C:/Users/x"), "C:/Users/x/AppData/Local")
})

test("state directory follows each system's convention", () => {
  assert.match(stateDir("darwin", {}, "/Users/x"), /Library\/Application Support|\/Users\/x\/\.config/)
  assert.ok(stateDir("linux", {}, "/home/x").includes("zapette"))
  assert.ok(stateDir("win32", { APPDATA: "C:/Users/x/AppData/Roaming" }, "C:/Users/x").startsWith("C:/Users/x/AppData/Roaming"))
})

test("adb file names per platform", () => {
  assert.equal(adbName("darwin"), "adb")
  assert.equal(adbName("linux"), "adb")
  assert.equal(adbName("win32"), "adb.exe")
  assert.deepEqual(adbFiles("linux"), ["adb"])
  // adb.exe will not start without the API dll sitting next to it
  assert.deepEqual(adbFiles("win32"), ["adb.exe", "AdbWinApi.dll", "AdbWinUsbApi.dll"])
})

test("platform-tools downloads exist only where Google publishes them", () => {
  assert.match(platformToolsUrl("darwin-x64"), /platform-tools-latest-darwin\.zip$/)
  assert.match(platformToolsUrl("darwin-arm64"), /platform-tools-latest-darwin\.zip$/) // universal build
  assert.match(platformToolsUrl("linux-x64"), /platform-tools-latest-linux\.zip$/)
  assert.match(platformToolsUrl("win32-x64"), /platform-tools-latest-windows\.zip$/)
  assert.equal(platformToolsUrl("linux-arm64"), null)
  assert.equal(platformToolsUrl("win32-arm64"), null)
})

test("MAC normalisation handles short first octets and dashes", () => {
  assert.equal(normalizeMac("aa:bb:cc:dd:ee:ff"), "aa:bb:cc:dd:ee:ff")
  assert.equal(normalizeMac("a:bb:cc:dd:ee:ff"), "0a:bb:cc:dd:ee:ff", "a one-digit first octet is padded")
  assert.equal(normalizeMac("AA-BB-CC-DD-EE-FF"), "aa:bb:cc:dd:ee:ff")
  assert.equal(parseMac("? (192.168.1.50) at aa:bb:cc:dd:ee:ff on en0 ifscope"), "aa:bb:cc:dd:ee:ff")
})

test("an IPv6 address is not mistaken for a MAC", () => {
  assert.equal(parseMac("fe80::97df:18fd:3cc8:ca41"), null)
  assert.equal(parseMac("2a01:cb00:11cd:2d00:58bf:160c:44d3"), null)
  assert.equal(parseMac("  192.168.1.50   00-00-00-00-00-00   invalid"), null)
})

test("ARP output of all three systems parses", () => {
  const macos = "? (192.168.1.50) at aa:bb:cc:dd:ee:ff on en0 ifscope [ethernet]"
  const macosEmpty = "? (192.168.1.50) at (incomplete) on en0 ifscope [ethernet]"
  const linuxNetTools = "192.168.1.50     ether   aa:bb:cc:dd:ee:ff   C                     eth0"
  const linuxIproute = [
    "2a01:cb00:11cd:2d00::1 dev eth0 lladdr aa:bb:cc:dd:ee:ff router REACHABLE",
    "192.168.1.50 dev eth0 lladdr aa:bb:cc:dd:ee:ff REACHABLE",
  ].join("\n")
  const windows = [
    "Interface: 192.168.1.20 --- 0x9",
    "  Internet Address      Physical Address      Type",
    "  192.168.1.50          aa-bb-cc-dd-ee-ff     dynamique",
  ].join("\r\n")

  assert.equal(parseArp(macos, "192.168.1.50"), "aa:bb:cc:dd:ee:ff")
  assert.equal(parseArp(macosEmpty, "192.168.1.50"), null)
  assert.equal(parseArp(linuxNetTools, "192.168.1.50"), "aa:bb:cc:dd:ee:ff")
  assert.equal(parseArp(linuxIproute, "192.168.1.50"), "aa:bb:cc:dd:ee:ff")
  assert.equal(parseArp(windows, "192.168.1.50"), "aa:bb:cc:dd:ee:ff")
  // a different device on the same cache is not an answer
  assert.equal(parseArp(windows, "192.168.1.99"), null)
})

test("arpMac asks each platform the right question and tolerates absence", async () => {
  const asked = []
  const mac = await arpMac("192.168.1.50", {
    platform: "win32",
    run: async (cmd, args) => {
      asked.push([cmd, ...args].join(" "))
      return "  192.168.1.50          aa-bb-cc-dd-ee-ff     dynamic"
    },
  })
  assert.equal(mac, "aa:bb:cc:dd:ee:ff")
  assert.deepEqual(asked, ["arp -a 192.168.1.50"])

  // Linux without net-tools installed: `arp` fails, `ip neigh` answers
  const askedLinux = []
  const macLinux = await arpMac("192.168.1.50", {
    platform: "linux",
    run: async (cmd, args) => {
      askedLinux.push([cmd, ...args].join(" "))
      if (cmd === "ip") return "192.168.1.50 dev eth0 lladdr aa:bb:cc:dd:ee:ff STALE"
      throw new Error("arp: command not found")
    },
  })
  assert.equal(macLinux, "aa:bb:cc:dd:ee:ff")
  assert.deepEqual(askedLinux, ["arp -n 192.168.1.50", "ip neigh show 192.168.1.50"])
})

test("the embedded toolchain survives a tar round trip", () => {
  const dir = scratch()
  try {
    const archive = createTarGz([
      { name: "adb", data: Buffer.from("#!/bin/sh\necho adb\n"), mode: 0o755 },
      { name: "AdbWinApi.dll", data: Buffer.from("dll bytes"), mode: 0o644 },
    ])
    const written = extractTarGz(archive, dir)
    assert.deepEqual(written.map((f) => f.name).sort(), ["AdbWinApi.dll", "adb"])
    assert.equal(readFileSync(join(dir, "adb"), "utf8"), "#!/bin/sh\necho adb\n")
    assert.equal(readFileSync(join(dir, "AdbWinApi.dll"), "utf8"), "dll bytes")
    if (process.platform !== "win32") {
      assert.ok(statSync(join(dir, "adb")).mode & 0o100, "adb must come out executable")
    }
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test("an uncompressed tar extracts too", () => {
  const dir = scratch()
  try {
    extractTar(createTar([{ name: "adb", data: Buffer.from("payload") }]), dir)
    assert.equal(readFileSync(join(dir, "adb"), "utf8"), "payload")
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test("pax extended headers (what GNU tar and bsdtar write) are honoured", (t) => {
  const dir = scratch()
  const src = scratch()
  try {
    writeFileSync(join(src, "a file with spaces.txt"), "pax body")
    const archive = join(dir, "pax.tar.gz")
    try {
      execFileSync("tar", ["--format=pax", "-czf", archive, "-C", src, "a file with spaces.txt"], { stdio: "ignore" })
    } catch {
      t.skip("no tar with --format=pax on this machine")
      return
    }
    const out = scratch()
    extractTarGz(readFileSync(archive), out)
    assert.equal(readFileSync(join(out, "a file with spaces.txt"), "utf8"), "pax body")
    rmSync(out, { recursive: true, force: true })
  } finally {
    rmSync(dir, { recursive: true, force: true })
    rmSync(src, { recursive: true, force: true })
  }
})

test("an entry that tries to escape the destination is refused", () => {
  const dir = scratch()
  try {
    const archive = createTar([{ name: "../../evil.txt", data: Buffer.from("nope") }])
    const written = extractTar(archive, dir)
    assert.deepEqual(written, [])
    assert.equal(existsSync(join(dir, "..", "..", "evil.txt")), false)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})
