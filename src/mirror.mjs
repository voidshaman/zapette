// Mirroring the TV's focused text field.
//
// Verified on the TCL (Android 11, Leanback search field):
//   - the field's contents are readable from `uiautomator dump`: the node whose
//     resource-id ends in lb_search_text_editor carries the query in its `text`
//     attribute, and the dump takes ~2.5s
//   - the caret is real over adb: DPAD_LEFT/RIGHT move it inside the field, and
//     `input text` inserts at it (typing "abcdef", LEFT LEFT, "X" gave "abcdXef")
//   - a plain shell round trip is 0.07s, but every `input` invocation starts a
//     JVM on the device and costs ~1.7s
//
// So the local text box is the mirror: edits are diffed against what the TV is
// believed to hold and applied as the shortest run of device calls — one call to
// move the caret, one to delete, one to insert, and only the runs that are needed.
import { adb, keyevent, inputText, KEY } from "./adb.mjs"

// Leanback's search field; other apps name theirs differently.
export const LEANBACK_FIELD = "lb_search_text_editor"
const DUMP_PATH = "/sdcard/tv-remote-ui.xml"

/** Find the field node in a uiautomator dump. Pure, so it can be tested. */
export function findFieldNode(xml, id = LEANBACK_FIELD) {
  for (const match of String(xml ?? "").matchAll(/<node[^>]*>/g)) {
    const tag = match[0]
    const rid = /resource-id="([^"]*)"/.exec(tag)?.[1] ?? ""
    if (!rid.endsWith(id)) continue
    return {
      id: rid,
      text: /text="([^"]*)"/.exec(tag)?.[1] ?? "",
      editable: /editable="true"/.test(tag),
      focused: /focused="true"/.test(tag),
    }
  }
  return null
}

/** Unescape the handful of entities uiautomator writes into attribute values. */
export function unescapeXml(text) {
  return String(text ?? "")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&#10;/g, "\n")
    .replace(/&amp;/g, "&")
}

const sleep = (ms) => new Promise((done) => setTimeout(done, ms))

/** One shot at the dump: write it on the TV, read it back, pick the field out. */
async function dumpField(serial, id) {
  const dumped = await adb(["-s", serial, "shell", "uiautomator", "dump", DUMP_PATH], { timeout: 40000 })
  if (!dumped.ok && !/dumped to/i.test(`${dumped.out} ${dumped.err}`)) {
    return { ok: false, error: dumped.err || "uiautomator dump failed" }
  }
  const xml = await adb(["-s", serial, "shell", "cat", DUMP_PATH], { timeout: 40000 })
  if (!xml.ok) return { ok: false, error: xml.err || "could not read the dump back" }
  const node = findFieldNode(xml.out, id)
  if (!node) return { ok: false, error: "no text field is on screen" }
  return { ok: true, text: unescapeXml(node.text), id: node.id, editable: node.editable }
}

/**
 * Read the field the TV currently has focused.
 *
 * Read twice, a moment apart, and keep the second: Leanback's search field is a
 * StreamingTextView that animates its text in, so a dump taken straight after
 * typing can catch a prefix of it — sending "hello" has been read back as
 * "hell".
 */
export async function readField(serial, { id = LEANBACK_FIELD, settleMs = 1200 } = {}) {
  const first = await dumpField(serial, id)
  if (!first.ok || !settleMs) return first
  await sleep(settleMs)
  const second = await dumpField(serial, id)
  return second.ok ? second : first
}

/**
 * An empty Android field reports its *hint* as its accessible text, so a search
 * box with nothing in it reads back as "Rechercher" rather than "". Treating
 * that as content would fill the local box with a word the TV does not hold.
 */
export function stripPlaceholder(text, hints) {
  const value = String(text ?? "")
  return hints?.has(value.trim().toLowerCase()) ? "" : value
}

/**
 * The shortest edit that turns `current` into `desired`, given where the TV's
 * caret currently is. Pure: this is the part worth testing.
 *
 * `removeStart` is where the differing run begins, `removeLength` how many
 * characters the TV must drop, `insert` what goes in their place.
 */
export function planEdit(current, desired) {
  const from = String(current ?? "")
  const to = String(desired ?? "")
  let prefix = 0
  while (prefix < from.length && prefix < to.length && from[prefix] === to[prefix]) prefix += 1
  let suffix = 0
  while (
    suffix < from.length - prefix &&
    suffix < to.length - prefix &&
    from[from.length - 1 - suffix] === to[to.length - 1 - suffix]
  ) {
    suffix += 1
  }
  const removeLength = from.length - prefix - suffix
  const insert = to.slice(prefix, to.length - suffix)
  return {
    removeStart: prefix,
    removeLength,
    insert,
    fromLength: from.length,
    // DEL deletes backwards from the caret, so the caret goes to the end of the
    // run being removed, then the insert leaves it after the new text.
    caretToRemoveFrom: prefix + removeLength,
    caretTo: prefix + insert.length,
    text: to,
  }
}

/**
 * The device calls a plan needs. Pure, so the shape of every edit is testable.
 *
 * It always starts with MOVE_END: where the caret sits is the one thing a
 * uiautomator dump does not report, and guessing it wrong puts an edit in the
 * wrong place (measured: clearing an 8-character field left its last character
 * behind and the next insert landed in front of it). Parking the caret at the
 * end first costs one call and makes everything after it deterministic.
 */
export function planCalls(plan) {
  const calls = [{ kind: "keys", codes: [KEY.MOVE_END], label: "END" }]
  const back = plan.fromLength - (plan.removeStart + plan.removeLength)
  if (back > 0) calls.push({ kind: "keys", codes: Array(back).fill(KEY.LEFT), label: `←${back}` })
  if (plan.removeLength > 0) {
    calls.push({ kind: "keys", codes: Array(plan.removeLength).fill(KEY.DEL), label: `DEL x${plan.removeLength}` })
  }
  if (plan.insert) calls.push({ kind: "text", value: plan.insert, label: `text ${plan.insert.length}` })
  return calls
}

/** Apply a plan and report what was sent; the caller updates its model. */
export async function applyPlan(serial, plan, options = {}) {
  const calls = planCalls(plan)
  for (const call of calls) {
    const r =
      call.kind === "text"
        ? await inputText(serial, call.value, options.layout)
        : await keyevent(serial, call.codes)
    if (!r.ok) {
      return { ok: false, error: r.err || r.out || "the TV refused the edit", sent: calls.map((c) => c.label) }
    }
  }
  return { ok: true, calls: calls.length, labels: calls.map((c) => c.label), caret: plan.caretTo }
}

/** Move the TV's caret by `delta` characters (one call, however far). */
export async function moveCaret(serial, delta) {
  if (!delta) return { ok: true, calls: 0 }
  const codes = Array(Math.abs(delta)).fill(delta > 0 ? KEY.RIGHT : KEY.LEFT)
  const r = await keyevent(serial, codes)
  return { ok: r.ok, calls: 1, error: r.err }
}

/** Read, diff and apply in one go: the whole sync in a single call. */
export async function syncField(serial, desired, model = { text: "", caret: 0 }, { id } = {}) {
  const read = await readField(serial, { id })
  if (!read.ok) return { ok: false, error: read.error }
  const plan = planEdit(read.text, desired)
  if (plan.removeLength === 0 && !plan.insert) {
    return { ok: true, calls: 0, unchanged: true, text: read.text, caret: read.text.length }
  }
  const applied = await applyPlan(serial, plan)
  return { ...applied, text: applied.ok ? plan.text : read.text, caret: plan.caretTo }
}
