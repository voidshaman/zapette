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
  // The exit status is echoed by the device shell on purpose: when the TV SIGKILLs
  // uiautomator the adb client still exits 0, so without this the failure is an
  // unexplained `Command failed: <cmd>` (see dumpFailure).
  const dumped = await adb(["-s", serial, "shell", `uiautomator dump ${DUMP_PATH}; echo "rc=$?"`], { timeout: 40000 })
  const last = [...String(dumped.out ?? "").matchAll(/rc=(\d+)/g)].pop()
  const rc = last ? Number(last[1]) : null
  if (rc !== 0 && !/dumped to/i.test(`${dumped.out} ${dumped.err}`)) {
    const error = dumped.ok ? dumpFailure({ rc, out: dumped.out, err: dumped.err }) : dumped.err || "uiautomator dump failed"
    return { ok: false, error, rc, killed: rc === 137 }
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

// How the field probe recovers from a read that failed: back off, keep trying, never
// give up for the session. A single failed read at start-up used to end mirror mode
// (app.mjs): the re-probe timer was armed only from the success path, so nothing was
// ever read again and every keystroke was dropped with no error shown.
export const PROBE_RETRY_MS = [600, 1500, 4000, 10000]

/** The wait before re-probing, after `failures` consecutive failed reads. */
export function probeRetryMs(failures) {
  const n = Number.isFinite(failures) ? Math.max(1, Math.floor(failures)) : 1
  return PROBE_RETRY_MS[Math.min(n, PROBE_RETRY_MS.length) - 1]
}

/**
 * Whether the next dump read has to hand the TV's UiAutomation slot back first.
 *
 * The slot is the reason the adb route had no reader at all: monkey takes it on its
 * first command and the dump is SIGKILLed from then on (see dumpFailure), so a read
 * that needs the slot to be free has to stop monkey, read, and start it again —
 * src/monkey.mjs#releaseSlot/#reclaimSlot, orchestrated by src/app.mjs#probeField.
 *
 * `known` is what this session has learned so far: `null` nothing yet (ask the dump
 * plainly: it costs 0.83 s to be refused, and a TV that does not refuse needs no
 * handoff at all), `true` a dump really was killed while monkey was alive, `false` a
 * dump worked while monkey was alive. Handing the slot back is the expensive option
 * (8.03 s measured for stop + read + restart on the TCL), so it is only used once
 * the TV has said the dump cannot run without it.
 */
export function needsSlotHandoff(known) {
  return known === true
}

/**
 * What one read concluded about the slot, for the next one — the whole learning rule,
 * kept pure.
 *
 *   - a read that succeeded with monkey out of the way (handedBack) proves the dump
 *     needs the slot: it was only taken out because a plain read had been killed, so
 *     the next read goes straight to the handoff instead of paying another refusal
 *   - a read that succeeded with monkey alive proves the opposite — this TV's monkey
 *     does not take the slot from the dump — and no handoff is ever needed
 *   - a dump that came back SIGKILLed while monkey is alive is the TV's one slot, so
 *     from now on the handoff happens before asking
 *   - anything else teaches nothing, and neither does any read taken while no monkey
 *     holds the slot (a resident but never-dialled monkey does not: measured, dump
 *     rc=0 in 2.4 s with the JVM idle)
 */
export function slotKnowledge(known, { ok, killed, monkeyAlive, handedBack } = {}) {
  if (ok && monkeyAlive) return Boolean(handedBack)
  if (!ok && monkeyAlive && killed) return true
  return known
}

/**
 * What a dump that the TV killed means for the reader to try next.
 *
 *   "handoff"       a monkey of ours is alive, so it holds the slot: stop it, read, and
 *                   start it again (src/monkey.mjs#releaseSlot / #reclaimSlot)
 *   "clear-strays"  no monkey of ours is alive, so the slot belongs to a JVM this
 *                   session is not driving — a start attempt that never dialled, or a
 *                   previous session killed mid-flight. There is nothing to hand back
 *                   from: it has to be killed (src/monkey.mjs#clearStrayMonkeys).
 *                   Measured on the TCL: with the app stopped and one leaked JVM
 *                   resident, every dump was rc=137 and the mirror retried forever.
 *   "none"          not a slot problem at all — the field, the device, or the dump
 */
export function killedDumpRecovery({ killed, monkeyAlive } = {}) {
  if (!killed) return "none"
  return monkeyAlive ? "handoff" : "clear-strays"
}

const firstLine = (s) => String(s ?? "").trim().split("\n")[0].slice(0, 200)

/**
 * Why a dump read failed, in one line.
 *
 * The exit status comes from the device shell, not from adb: `uiautomator` is
 * SIGKILLed on this TV (rc=137, in ~1 s) while a *used* monkey holds the single
 * UiAutomation slot, and the adb client then exits 0 — the `echo rc=$?` after the
 * command is what it sees. Measured on the TCL: monkey resident and never dialled,
 * dump rc=0 in 2.4 s; the same monkey with ONE command sent over its socket, dump
 * rc=137 ("Killed") in 0.97 s. Without the status the log said `Command failed:
 * <cmd>` with no reason at all, which is what made this fault unreadable.
 */
export function dumpFailure({ rc, err, out } = {}) {
  if (rc === 137) return "the TV killed uiautomator (rc=137) mid-dump"
  if (rc != null && rc !== 0) return `uiautomator dump exited ${rc}`
  return firstLine(err || out) || "uiautomator dump failed"
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

/**
 * Apply a plan and report what was sent; the caller updates its model.
 *
 * `options.insert` is how the caller routes the text: the app passes its typing
 * path (companion `commit` or the adb `input text`), so this module stays about
 * *where* an edit goes and never about *how* the string travels. Without it the
 * behaviour is exactly what it was: one translated `input text` call.
 */
export async function applyPlan(serial, plan, options = {}) {
  const calls = planCalls(plan)
  const insert = options.insert ?? ((value) => inputText(serial, value, options.layout))
  let route = null
  let insertResult = null
  for (const call of calls) {
    const r = call.kind === "text" ? await insert(call.value) : await keyevent(serial, call.codes)
    if (!r.ok) {
      const reason = r.error || r.err || r.out || "the TV refused the edit"
      return { ok: false, error: reason, route: r.route ?? null, sent: calls.map((c) => c.label) }
    }
    if (call.kind === "text") {
      insertResult = r
      if (r.route) route = r.route
    }
  }
  return {
    ok: true,
    calls: calls.length,
    labels: calls.map((c) => c.label),
    caret: plan.caretTo,
    route,
    // The text call's own verdict, when the route can report one: `verified` is a
    // read-back check, `drifted` means the text landed in a field that is not what
    // the caller modelled.
    verified: insertResult?.verified,
    drifted: insertResult?.drifted ?? false,
    field: insertResult?.field,
  }
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
