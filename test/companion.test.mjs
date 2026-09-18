// The client half of the companion's auth layer: the HMAC it computes, the key file
// it keeps, and the fact that neither the key nor an HMAC of it can end up in a log.
//
// The wire tests run against a fake companion that speaks the real handshake (send a
// nonce, read exactly one `AUTH <hex>` line, refuse everything else and answer no verb),
// so what is checked is the client's behaviour on the socket rather than a mock of it.
import test from "node:test"
import assert from "node:assert/strict"
import * as crypto from "node:crypto"
import * as fs from "node:fs"
import * as net from "node:net"
import * as os from "node:os"
import { join } from "node:path"

import {
  authAnswer,
  companionConfigDir,
  companionKeyMode,
  companionKeyPath,
  computeAuthHmac,
  createCompanionKey,
  deviceKey,
  ensureCompanionKey,
  readCompanionKey,
  scrub,
  sendCommand,
  companionLog,
  KEY_BYTES,
} from "../src/companion.mjs"

// Keep the real ~/.config out of this: the key path is the thing under test.
const configDir = fs.mkdtempSync(join(os.tmpdir(), "zapette-test-"))
process.env.ZAPETTE_CONFIG_DIR = configDir

// ---------------------------------------------------------------- the HMAC

// RFC 4231 test case 1 (key 0x0b x20, message "Hi There"): the published vector for
// HMAC-SHA256, so this checks the construction rather than the implementation
// agreeing with itself.
test("HMAC-SHA256 matches the published RFC 4231 vector", () => {
  assert.equal(
    computeAuthHmac("Hi There", "0b".repeat(20)),
    "b0344c61d8db38535ca8afceaf0bf12b881dc200c9833da726e9376c2e32cff7",
  )
})

// The shape the companion actually uses: a 32-byte key and the nonce as the hex string
// that arrived on the wire. Expected value computed independently with
// `printf <nonce> | openssl dgst -sha256 -mac HMAC -macopt hexkey:<key>`.
test("the auth answer is HMAC-SHA256(secret, nonceHex) in hex, as the TV computes it", () => {
  const key = "0a1b2c3d4e5f60718293a4b5c6d7e8f90a1b2c3d4e5f60718293a4b5c6d7e8f9"
  const nonce = "00112233445566778899aabbccddeeff"
  assert.equal(computeAuthHmac(nonce, key), "c5b765267d442fa4d5f3753a66a94587863729ee3af7a1281e40971203321a17")
  assert.equal(authAnswer(key, nonce), "AUTH c5b765267d442fa4d5f3753a66a94587863729ee3af7a1281e40971203321a17")
})

// ---------------------------------------------------------------- the key file

test("the key file is 0600, holds 32 random bytes as hex, and is reused", () => {
  const device = { serial: "10.0.0.9:5555", host: "10.0.0.9" }
  const created = createCompanionKey(device)

  assert.equal(companionKeyPath(device), join(configDir, `companion-${deviceKey(device)}.key`))
  assert.equal(companionKeyMode(device), "600")
  assert.equal(created.hex.length, KEY_BYTES * 2)
  assert.match(created.hex, /^[0-9a-f]{64}$/)

  const again = ensureCompanionKey(device)
  assert.equal(again.created, false)
  assert.equal(again.hex, created.hex, "a second call adopts the stored key instead of making one")

  // ...and a fresh key is a different key (32 random bytes, not a constant).
  const rotated = createCompanionKey(device)
  assert.notEqual(rotated.hex, created.hex)
  assert.equal(readCompanionKey(device).hex, rotated.hex)
  assert.equal(companionKeyMode(device), "600", "the mode survives a rewrite")
})

test("a key file that is not hex is refused rather than used", () => {
  const device = { serial: "10.0.0.10:5555", host: "10.0.0.10" }
  fs.mkdirSync(companionConfigDir(), { recursive: true })
  fs.writeFileSync(companionKeyPath(device), "not-a-key\n")
  const found = readCompanionKey(device)
  assert.equal(found.present, false)
  assert.match(found.error, /hex/)
})

// ---------------------------------------------------------------- no leaks

test("the module's log surface redacts anything key-shaped", () => {
  const key = createCompanionKey({ serial: "10.0.0.11:5555", host: "10.0.0.11" }).hex
  const auth = authAnswer(key, "00112233445566778899aabbccddeeff")

  assert.equal(scrub(`pushing ${key} over adb`), "pushing <redacted-hex> over adb")
  assert.equal(scrub(auth), "AUTH <redacted-hex>")

  const seen = []
  const realError = console.error
  process.env.TV_REMOTE_COMPANION_DEBUG = "1"
  console.error = (line) => seen.push(String(line))
  try {
    // Everything a careless diagnostic could carry: the key, the answer to the nonce,
    // and the file it lives in.
    companionLog(`provision ${key}; ${auth}; keyfile ${companionKeyPath({ serial: "10.0.0.11:5555" })}`)
  } finally {
    console.error = realError
    delete process.env.TV_REMOTE_COMPANION_DEBUG
  }

  assert.equal(seen.length, 1, "debug output goes through companionLog")
  assert.ok(!seen[0].includes(key), "the key must not appear in the log")
  assert.ok(!seen[0].includes(auth.slice(5)), "nor the HMAC that answers a nonce")
  assert.match(seen[0], /<redacted-hex>/)
})

// ---------------------------------------------------------------- the wire

/**
 * A fake companion: the real handshake, and nothing else. It sends a nonce, accepts
 * exactly one `AUTH <hex>` line, and thereafter answers one JSON line per command.
 * With no secret it answers `no_secret` and closes, like the device does.
 */
function fakeCompanion({ secret = null } = {}) {
  const commands = []
  const server = net.createServer((socket) => {
    socket.setNoDelay(true)
    if (!secret) {
      socket.write(`${JSON.stringify({ ok: false, cmd: "auth", error: "no_secret" })}\n`)
      socket.end()
      return
    }
    const nonce = crypto.randomBytes(16).toString("hex")
    socket.write(`${JSON.stringify({ ok: true, cmd: "auth", auth: "nonce", nonce })}\n`)
    const expected = computeAuthHmac(nonce, secret)
    let buffer = ""
    let authed = false
    socket.on("data", (chunk) => {
      buffer += chunk.toString("utf8")
      let end
      while ((end = buffer.indexOf("\n")) >= 0) {
        const line = buffer.slice(0, end)
        buffer = buffer.slice(end + 1)
        if (!authed) {
          authed = line.trim().toLowerCase() === `auth ${expected}`.toLowerCase()
          if (!authed) {
            // Wrong or missing answer: no verb is read, nothing more is sent.
            socket.destroy()
            return
          }
          continue
        }
        commands.push(line)
        socket.write(`${JSON.stringify({ ok: true, cmd: line.split(" ")[0], echo: line })}\n`)
      }
    })
  })
  return {
    commands,
    listen: () =>
      new Promise((resolve) => server.listen(0, "127.0.0.1", () => resolve(server.address().port))),
    close: () => new Promise((resolve) => server.close(resolve)),
  }
}

test("a correct key gets the verb through, and the verb follows the AUTH line", async () => {
  const key = crypto.randomBytes(KEY_BYTES).toString("hex")
  const tv = fakeCompanion({ secret: key })
  const port = await tv.listen()
  try {
    const r = await sendCommand({ host: "10.0.0.12", serial: "10.0.0.12:5555", localPort: port, key }, "ping")
    assert.equal(r.ok, true)
    assert.equal(r.reply.ok, true)
    assert.deepEqual(tv.commands, ["ping"])
  } finally {
    await tv.close()
  }
})

test("a wrong key gets no verb through: the companion closes and nothing is executed", async () => {
  const key = crypto.randomBytes(KEY_BYTES).toString("hex")
  const tv = fakeCompanion({ secret: key })
  const port = await tv.listen()
  try {
    const wrong = crypto.randomBytes(KEY_BYTES).toString("hex")
    const r = await sendCommand(
      { host: "10.0.0.13", serial: "10.0.0.13:5555", localPort: port, key: wrong },
      "commit SHOULD-NOT-LAND",
    )
    assert.equal(r.ok, false)
    assert.equal(r.reason, "auth-failed")
    assert.deepEqual(tv.commands, [], "no command may reach the companion after a bad AUTH")
  } finally {
    await tv.close()
  }
})

test("a companion with no secret accepts nothing, even from the right key", async () => {
  const tv = fakeCompanion({ secret: null })
  const port = await tv.listen()
  try {
    const key = crypto.randomBytes(KEY_BYTES).toString("hex")
    const r = await sendCommand({ host: "10.0.0.14", serial: "10.0.0.14:5555", localPort: port, key }, "ping")
    assert.equal(r.ok, false)
    assert.equal(r.reason, "no-secret")
    assert.deepEqual(tv.commands, [])
  } finally {
    await tv.close()
  }
})
