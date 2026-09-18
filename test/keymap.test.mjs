// The layout compat layer.
//
// `measured` is raw evidence from this TV: injecting the left string displayed
// the right one (read back from the search field, and confirmed on pixels for the
// longer strings). The table has to reproduce every one of those pairs.
import assert from "node:assert/strict"
import { test } from "node:test"
import {
  CLEAN_IME,
  buildSendMap,
  keyboardAction,
  layoutPreview,
  resolveLayout,
  translate,
  untypeable,
} from "../src/keymap.mjs"

const measured = [
  ["a", "q"], ["q", "a"], ["z", "w"], ["w", "z"], // the swap the user reported
  ["m", ","], [";", "m"], [",", ";"],             // m sits where ; is
  [".", ":"], ["@", "2"], [")", "0"], ["-", ")"], ["_", "\u00b0"],
  ["1", "&"],                                     // AZERTY's digits are shifted
  ["AZERTY", "QWERTY"],
  ["azqw m", "qwaz ,"],
  ["abcdefghijklmnopqrstuvwxyz", "qbcdefghijkl,noparstuvzxyw"],
  ["hello world", "hello zorld"],
]

test("every pair measured on the TV is reproduced by the table", () => {
  for (const [sent, shown] of measured) {
    assert.equal(layoutPreview(sent, "azerty"), shown, `injecting ${sent} should display ${shown}`)
  }
})

test("what the app types is what the TV displays: translate then preview is identity", () => {
  for (const text of ["hello world", "recherche films 2024", "azqw m", "\u00c9\u00e0\u00e7\u00f9", "1+1=2", "c'est bon !"]) {
    assert.equal(layoutPreview(translate(text, "azerty"), "azerty"), text, `${text} should round trip`)
  }
})

test("the inverse of each measured pair is what gets sent", () => {
  assert.equal(translate("q", "azerty"), "a")
  assert.equal(translate("a", "azerty"), "q")
  assert.equal(translate("w", "azerty"), "z")
  assert.equal(translate("z", "azerty"), "w")
  assert.equal(translate(",", "azerty"), "m")
  assert.equal(translate(":", "azerty"), ".")
  assert.equal(translate("2", "azerty"), "@")
  assert.equal(translate("0", "azerty"), ")")
  assert.equal(translate(")", "azerty"), "-")
  assert.equal(translate("1", "azerty"), "!")
})

test("the letters both layouts agree on are sent untouched", () => {
  for (const c of "bcdefghijkl noprstuvxy") {
    assert.equal(translate(c, "azerty"), c)
  }
})

test("the table covers the moved keys and every entry round trips", () => {
  const map = buildSendMap("azerty")
  assert.ok(Object.keys(map).length > 30, "the table should cover the moved keys")
  for (const shown of Object.keys(map)) {
    assert.equal(layoutPreview(map[shown], "azerty"), shown, `${shown} should round trip`)
  }
})

test("a qwerty TV gets the text verbatim", () => {
  assert.equal(translate("hello world", "qwerty"), "hello world")
  assert.equal(translate("a z q w m ; , @ )", "qwerty"), "a z q w m ; , @ )")
  assert.equal(layoutPreview("hello world", "qwerty"), "hello world")
})

test("characters outside the table are passed through", () => {
  assert.equal(translate("\t", "azerty"), "\t")
  assert.equal(translate("step\there", "azerty"), "step\there")
  assert.equal(translate("\u20ac", "azerty"), "\u20ac")
})

test("base and shift are all input text can express, so AltGr characters are out of reach", () => {
  // measured: injecting "@" displayed "2"; on AZERTY "@" is AltGr+0
  assert.equal(layoutPreview("@", "azerty"), "2")
  assert.equal(translate("@", "azerty"), "@")
  assert.deepEqual(untypeable("mail@example.com", "azerty"), ["@"])
  assert.deepEqual(untypeable("hello world 1,2 3!?", "azerty"), [])
  assert.deepEqual(untypeable("a@b#c", "qwerty"), [])
})

test("the TV's keyboard is borrowed only while text is going out", () => {
  const tcl = "com.tcl.inputmethod.international/.T_IME"
  // TV on its own remapping keyboard, nothing pinned: borrow the pass-through one
  assert.equal(keyboardAction({ clean: false, manual: false, own: tcl }), "use-clean")
  // borrowed: hand the TV's own keyboard back
  assert.equal(keyboardAction({ clean: true, manual: false, own: tcl }), "restore")
  // pinned with i: leave both states alone
  assert.equal(keyboardAction({ clean: true, manual: true, own: tcl }), "leave")
  assert.equal(keyboardAction({ clean: false, manual: true, own: tcl }), "leave")
  // already the stock keyboard: nothing to borrow, nothing to hand back
  assert.equal(keyboardAction({ clean: true, manual: false, own: CLEAN_IME }), "leave")
  assert.equal(keyboardAction({ clean: true, manual: false, own: "" }), "leave")
})

test("the layout is read from what the TV reports about itself", () => {
  assert.equal(resolveLayout("com.tcl.inputmethod.international/.T_IME", "fr-FR"), "azerty")
  assert.equal(resolveLayout("com.google.android.inputmethod.latin/com.android.inputmethod.latin.LatinIME", "fr-FR"), "qwerty")
  assert.equal(resolveLayout("", "fr-FR"), "azerty")
  assert.equal(resolveLayout("", "en-US"), "qwerty")
  assert.equal(resolveLayout("com.tcl.inputmethod.international/.T_IME", "en-US"), "azerty")
})
