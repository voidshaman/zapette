// A tar reader and writer, plus gzip.
//
// Why not just zip the platform-tools download and unpack it at runtime: Node has
// no zip support at all, while tar is a trivially simple format it can do with
// zlib alone. The writer always emits plain ustar with the platform independent
// of locale or xattr habits; the reader additionally copes with the GNU and pax
// extensions that `tar` produces on other machines (pax 'x', GNU 'L'), so an
// archive made by hand still unpacks.
import { mkdirSync, writeFileSync } from "node:fs"
import { join, resolve, sep } from "node:path"
import { gunzipSync, gzipSync } from "node:zlib"

const BLOCK = 512

function octal(value, length) {
  return value.toString(8).padStart(length - 1, "0") + "\0"
}

function readString(block, offset, length) {
  const end = block.indexOf(0, offset)
  const slice = block.subarray(offset, end === -1 || end > offset + length ? offset + length : end)
  return slice.toString("utf8").trim()
}

/** octal, or base-256 for the big values GNU tar writes (`0x80` leading byte). */
function readNumber(block, offset, length) {
  const slice = block.subarray(offset, offset + length)
  if (slice[0] & 0x80) {
    let value = BigInt(slice[0] & 0x7f)
    for (const byte of slice.subarray(1)) value = (value << 8n) | BigInt(byte)
    return Number(value)
  }
  const text = slice.toString("utf8").replace(/\0.*$/s, "").trim()
  return text ? parseInt(text, 8) || 0 : 0
}

function header({ name, size, mode }) {
  const block = Buffer.alloc(BLOCK)
  block.write(name, 0, 100, "utf8")
  block.write(octal(mode & 0o7777, 8), 100)
  block.write(octal(0, 8), 108)
  block.write(octal(0, 8), 116)
  block.write(octal(size, 12), 124)
  block.write(octal(Math.floor(Date.now() / 1000), 12), 136)
  block.write("        ", 148) // checksum placeholder
  block.write("0", 156) // regular file
  block.write("ustar", 257)
  block.write("00", 263)
  return block
}

function withChecksum(block) {
  let sum = 0
  for (const byte of block) sum += byte
  block.write(sum.toString(8).padStart(6, "0") + "\0 ", 148)
  return block
}

/** files: [{ name, data, mode }] — names must be short ASCII relative paths. */
export function createTar(files) {
  const parts = []
  for (const file of files) {
    const data = Buffer.isBuffer(file.data) ? file.data : Buffer.from(file.data)
    parts.push(withChecksum(header({ name: file.name, size: data.length, mode: file.mode ?? 0o644 })))
    parts.push(data)
    const padding = (BLOCK - (data.length % BLOCK)) % BLOCK
    if (padding) parts.push(Buffer.alloc(padding))
  }
  parts.push(Buffer.alloc(BLOCK * 2)) // end-of-archive marker
  return Buffer.concat(parts)
}

export function createTarGz(files) {
  return gzipSync(createTar(files), { level: 9 })
}

/** Parse pax records: "<length> key=value\n" repeated. */
function parsePax(text, into) {
  let offset = 0
  while (offset < text.length) {
    const space = text.indexOf(" ", offset)
    if (space === -1) break
    const length = Number.parseInt(text.slice(offset, space), 10)
    if (!Number.isFinite(length) || length <= 0) break
    const record = text.slice(space + 1, offset + length - 1)
    const eq = record.indexOf("=")
    if (eq > 0) {
      const key = record.slice(0, eq)
      const value = record.slice(eq + 1)
      if (key === "path") into.name = value
      if (key === "mode") into.mode = Number.parseInt(value, 8)
    }
    offset += length
  }
}

/**
 * Unpack a tar (optionally gzipped) into destDir. Returns the files written.
 * Entries that try to escape destDir are refused rather than followed.
 */
export function extractTar(buffer, destDir) {
  const tar = buffer[0] === 0x1f && buffer[1] === 0x8b ? gunzipSync(buffer) : buffer
  const root = resolve(destDir)
  const written = []
  let offset = 0
  let pending = {}

  while (offset + BLOCK <= tar.length) {
    const block = tar.subarray(offset, offset + BLOCK)
    offset += BLOCK
    if (block.every((byte) => byte === 0)) break // end of archive

    const entry = { ...pending }
    pending = {}
    const rawName = readString(block, 0, 100)
    const prefix = readString(block, 345, 155)
    entry.name = entry.name ?? (prefix ? `${prefix}/${rawName}` : rawName)
    entry.mode = entry.mode ?? readNumber(block, 100, 8)
    const size = readNumber(block, 124, 12)
    const type = String.fromCharCode(block[156] || 0x30)

    const data = tar.subarray(offset, offset + size)
    offset += Math.ceil(size / BLOCK) * BLOCK

    if (type === "x" || type === "g") {
      parsePax(data.toString("utf8"), (pending = {}))
      continue
    }
    if (type === "L" || type === "K") {
      // GNU long name/link: the data is the name for the next entry
      pending.name = data.toString("utf8").replace(/\0.*$/s, "").trim()
      continue
    }
    if (type !== "0" && type !== "7" && type !== "5") continue // symlinks etc.
    if (!entry.name || entry.name.endsWith("/")) continue

    const target = resolve(join(root, entry.name))
    if (target !== root && !target.startsWith(root + sep)) continue // path traversal
    mkdirSync(resolve(target, ".."), { recursive: true })
    writeFileSync(target, data, { mode: (entry.mode || 0o644) & 0o777 })
    written.push({ name: entry.name, path: target, size })
  }
  return written
}

export function extractTarGz(buffer, destDir) {
  return extractTar(buffer, destDir)
}
