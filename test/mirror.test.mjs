// The edit planner behind mirror mode: every case is a pair of strings and the
// device calls that should bridge them. No TV needed.
//
// Every plan starts with MOVE_END because a uiautomator dump cannot report where
// the caret is, and guessing wrong puts an edit in the wrong place.
//
//   node --test test/
import assert from "node:assert/strict"
import { test } from "node:test"
import { dumpFailure, findFieldNode, killedDumpRecovery, needsSlotHandoff, planCalls, planEdit, probeRetryMs, slotKnowledge, stripPlaceholder, unescapeXml } from "../src/mirror.mjs"

const labels = (plan) => planCalls(plan).map((c) => c.label)

test("appending at the end parks the caret, then sends the text", () => {
  const plan = planEdit("rofl", "roflgator")
  assert.equal(plan.removeStart, 4)
  assert.equal(plan.removeLength, 0)
  assert.equal(plan.insert, "gator")
  // the caret is already at the end, so nothing to walk back
  assert.deepEqual(labels(plan), ["END", "text 5"])
  assert.equal(plan.caretTo, 9)
})

test("typing from empty parks the caret and sends one string", () => {
  const plan = planEdit("", "recherche")
  assert.equal(plan.insert, "recherche")
  assert.deepEqual(labels(plan), ["END", "text 9"])
})

test("editing in the middle walks back, deletes, and inserts, leaving the caret after it", () => {
  const plan = planEdit("abcdXeYf", "abcdef")
  assert.equal(plan.removeStart, 4)
  assert.equal(plan.removeLength, 3) // XeY
  assert.equal(plan.insert, "e")
  assert.deepEqual(labels(plan), ["END", "←1", "DEL x3", "text 1"])
  assert.equal(plan.caretTo, 5)
})

test("deleting a run needs no insert", () => {
  const plan = planEdit("hello world", "hello")
  assert.equal(plan.removeLength, 6)
  assert.equal(plan.insert, "")
  assert.deepEqual(labels(plan), ["END", "DEL x6"])
})

test("clearing the field deletes all of it, including the last character", () => {
  // this is the case that failed against the TV before MOVE_END: the caret was
  // not at the end, so the run stopped one short and a leftover stayed behind
  const plan = planEdit("abcdXeYf", "")
  assert.equal(plan.removeStart, 0)
  assert.equal(plan.removeLength, 8)
  assert.deepEqual(labels(plan), ["END", "DEL x8"])
})

test("a change at the start walks the caret back to it", () => {
  const plan = planEdit("hello", "Hello")
  assert.equal(plan.removeStart, 0)
  assert.equal(plan.removeLength, 1)
  assert.equal(plan.insert, "H")
  assert.deepEqual(labels(plan), ["END", "←4", "DEL x1", "text 1"])
})

test("an identical string needs no edit at all", () => {
  const plan = planEdit("same", "same")
  assert.equal(plan.removeLength, 0)
  assert.equal(plan.insert, "")
  assert.deepEqual(labels(plan), ["END"]) // nothing but the caret park
})

test("only the differing middle is touched, not the whole string", () => {
  const long = "a".repeat(50)
  const plan = planEdit(`${long}b${long}`, `${long}c${long}`)
  assert.equal(plan.removeLength, 1)
  assert.equal(plan.insert, "c")
  const calls = planCalls(plan)
  assert.equal(calls.length, 4) // END, one walk-back, one delete, one insert
  assert.equal(calls.filter((c) => c.kind === "text").length, 1)
})

test("the field node is found by the tail of its resource id, and entities decoded", () => {
  const xml = [
    '<hierarchy><node class="android.widget.FrameLayout" resource-id="org.smarttube.stable:id/lb_search_bar" />',
    '<node class="android.widget.TextView" resource-id="org.smarttube.stable:id/text_tag_name" text="120FPS TEST" />',
    '<node class="StreamingTextView" resource-id="org.smarttube.stable:id/lb_search_text_editor" text="rofl&amp;gator" focused="true" />',
    "</hierarchy>",
  ].join("\n")
  const node = findFieldNode(xml)
  assert.ok(node)
  assert.equal(node.id, "org.smarttube.stable:id/lb_search_text_editor")
  assert.equal(unescapeXml(node.text), "rofl&gator")
  assert.equal(node.focused, true)
})

test("an empty field reports its hint, which is emptiness and not content", () => {
  // measured: the TCL's search box reads back as "Rechercher" when it is empty
  const hints = new Set(["rechercher", "search"])
  assert.equal(stripPlaceholder("Rechercher", hints), "")
  assert.equal(stripPlaceholder(" search ", hints), "")
  assert.equal(stripPlaceholder("", hints), "")
  assert.equal(stripPlaceholder("hello world", hints), "hello world")
  assert.equal(stripPlaceholder("Rechercher", new Set()), "Rechercher")
  assert.equal(stripPlaceholder(null, hints), "")
})

test("a screen with no field reports nothing rather than the first node", () => {
  assert.equal(findFieldNode('<node resource-id="org.smarttube.stable:id/search_orb" />'), null)
  assert.equal(findFieldNode(""), null)
})

test("a failed field read backs off, and never stops trying", () => {
  // one failed read at start-up used to end mirror mode for the session: the re-probe
  // timer was armed only from the success path
  assert.equal(probeRetryMs(1), 600)
  assert.equal(probeRetryMs(2), 1500)
  assert.equal(probeRetryMs(3), 4000)
  assert.equal(probeRetryMs(4), 10000)
  // stays at the slow path rather than growing without bound
  assert.equal(probeRetryMs(9), 10000)
  // defensive: no count, or nonsense, is still one retry
  assert.equal(probeRetryMs(0), 600)
  assert.equal(probeRetryMs(undefined), 600)
})

test("a dump that was SIGKILLed is named as such, not as an unexplained failure", () => {
  // measured on the TCL: with a *used* monkey holding the UiAutomation slot,
  // uiautomator answers rc=137 in ~1 s while the adb client itself exits 0
  assert.match(dumpFailure({ rc: 137, out: "Killed\nrc=137" }), /rc=137/)
  assert.match(dumpFailure({ rc: 1, out: "rc=1" }), /exited 1/)
  assert.equal(dumpFailure({ rc: null, err: "device offline" }), "device offline")
  assert.equal(dumpFailure({}), "uiautomator dump failed")
})

test("the slot is only lent out once the TV has proved the dump needs it", () => {
  // nothing learned yet: ask the dump plainly. Being refused costs 0.83 s (measured),
  // and a TV whose monkey does not take the slot never needs a handoff at all.
  assert.equal(needsSlotHandoff(null), false)
  // learned: a plain read came back SIGKILLed while monkey was alive
  assert.equal(needsSlotHandoff(true), true)
  // learned: a plain read worked with monkey alive — no handoff, ever
  assert.equal(needsSlotHandoff(false), false)
})

test("only the reads that can teach something about the slot do", () => {
  // a plain dump killed with monkey alive is the TV's one slot: hand it back from now on
  assert.equal(slotKnowledge(null, { ok: false, killed: true, monkeyAlive: true }), true)
  // a read that HAD the slot handed back and worked: still a slot the dump needs —
  // this is the one that matters, because monkey is alive again by the time the read
  // is taken into the model (its restart is what hands the slot back)
  assert.equal(slotKnowledge(true, { ok: true, killed: false, monkeyAlive: true, handedBack: true }), true)
  // a plain read that worked with monkey alive: this TV's monkey does not hold the slot
  assert.equal(slotKnowledge(true, { ok: true, killed: false, monkeyAlive: true, handedBack: false }), false)
  // a failure that is not the slot (device offline, no field on screen): no lesson
  assert.equal(slotKnowledge(true, { ok: false, killed: false, monkeyAlive: true, handedBack: true }), true)
  assert.equal(slotKnowledge(null, { ok: false, killed: false, monkeyAlive: true }), null)
  // no monkey, no slot to argue about — what a read says about the field is not
  // evidence about the slot (a resident but never-dialled monkey does not hold it)
  assert.equal(slotKnowledge(true, { ok: false, killed: true, monkeyAlive: false }), true)
  assert.equal(slotKnowledge(null, { ok: true, killed: false, monkeyAlive: false }), null)
})

test("the adb route's sequence: refused once, handed back for every read after that", () => {
  // What the TCL does: the session's first plain read is killed, the retry hands the
  // slot back and lands, and every read after it goes straight to the handoff instead
  // of paying another refusal.
  let known = null
  const read = (r) => {
    known = slotKnowledge(known, r)
    return needsSlotHandoff(known)
  }
  assert.equal(read({ ok: false, killed: true, monkeyAlive: true }), true)
  assert.equal(read({ ok: true, monkeyAlive: true, handedBack: true }), true)
  assert.equal(read({ ok: true, monkeyAlive: true, handedBack: true }), true)
})

test("a killed dump with no monkey of ours alive is a stray JVM, not a handoff", () => {
  // measured on the TCL: with the app stopped and one leaked monkey JVM resident, every
  // dump was rc=137 while monkeyInfo().state was "off" — nothing to hand back from
  assert.equal(killedDumpRecovery({ killed: true, monkeyAlive: true }), "handoff")
  assert.equal(killedDumpRecovery({ killed: true, monkeyAlive: false }), "clear-strays")
  // a failure that is not the TV killing the dump is not about the slot at all
  assert.equal(killedDumpRecovery({ killed: false, monkeyAlive: true }), "none")
  assert.equal(killedDumpRecovery({ killed: false, monkeyAlive: false }), "none")
  assert.equal(killedDumpRecovery({}), "none")
})
