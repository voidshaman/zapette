// The edit planner behind mirror mode: every case is a pair of strings and the
// device calls that should bridge them. No TV needed.
//
// Every plan starts with MOVE_END because a uiautomator dump cannot report where
// the caret is, and guessing wrong puts an edit in the wrong place.
//
//   node --test test/
import assert from "node:assert/strict"
import { test } from "node:test"
import { findFieldNode, planCalls, planEdit, stripPlaceholder, unescapeXml } from "../src/mirror.mjs"

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
