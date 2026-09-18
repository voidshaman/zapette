// The TV renders injected key events through its own keyboard layout.
//
// `input text` converts a string into key events using the *US* layout (the TV's
// /system/usr/keychars/Virtual.kcm is plain QWERTY), and the TV's keyboard layer
// then turns each position back into a character using *its* layout. On this TV
// that layer is French AZERTY, so an injected "a" arrives as "q":
//
//   sent            shown by the TV
//   a q z w         q a w z
//   m ; ,           , m ;
//   @ ) _ -        2 0 degrees )
//   1               &
//
// Measured on the TCL (IME com.tcl.inputmethod.international/.T_IME, fr-FR);
// selecting Gboard instead makes the same injections arrive verbatim, which is
// what proves the layer responsible. To type a character on such a TV we must
// send the US character that sits at the same *key position*, which is what this
// table does. Identity for characters the two layouts agree on.
//
// Rows are key positions, left to right. Each entry is [unshifted, shifted].
const US = [
  ["`", "~"], ["1", "!"], ["2", "@"], ["3", "#"], ["4", "$"], ["5", "%"], ["6", "^"],
  ["7", "&"], ["8", "*"], ["9", "("], ["0", ")"], ["-", "_"], ["=", "+"],
  ["q", "Q"], ["w", "W"], ["e", "E"], ["r", "R"], ["t", "T"], ["y", "Y"], ["u", "U"],
  ["i", "I"], ["o", "O"], ["p", "P"], ["[", "{"], ["]", "}"], ["\\", "|"],
  ["a", "A"], ["s", "S"], ["d", "D"], ["f", "F"], ["g", "G"], ["h", "H"], ["j", "J"],
  ["k", "K"], ["l", "L"], [";", ":"], ["'", "\""],
  ["z", "Z"], ["x", "X"], ["c", "C"], ["v", "V"], ["b", "B"], ["n", "N"], ["m", "M"],
  [",", "<"], [".", ">"], ["/", "?"],
]

const FR = [
  ["\u00b2", "\u00b2"], ["&", "1"], ["\u00e9", "2"], ["\"", "3"], ["'", "4"], ["(", "5"], ["-", "6"],
  ["\u00e8", "7"], ["_", "8"], ["\u00e7", "9"], ["\u00e0", "0"], [")", "\u00b0"], ["=", "+"],
  ["a", "A"], ["z", "Z"], ["e", "E"], ["r", "R"], ["t", "T"], ["y", "Y"], ["u", "U"],
  ["i", "I"], ["o", "O"], ["p", "P"], ["^", "\u00a8"], ["$", "\u00a3"], ["*", "\u00b5"],
  ["q", "Q"], ["s", "S"], ["d", "D"], ["f", "F"], ["g", "G"], ["h", "H"], ["j", "J"],
  ["k", "K"], ["l", "L"], ["m", "M"], ["\u00f9", "%"],
  ["w", "W"], ["x", "X"], ["c", "C"], ["v", "V"], ["b", "B"], ["n", "N"], [",", "?"],
  [";", "."], [":", "/"], ["!", "\u00a7"],
]

/** To show `layout`'s character, send the US character at the same key position. */
export function buildSendMap(layout) {
  if (layout !== "azerty") return {}
  const map = {}
  for (let i = 0; i < US.length; i += 1) {
    for (let s = 0; s < 2; s += 1) {
      const target = FR[i]?.[s]
      const source = US[i]?.[s]
      if (target === undefined || source === undefined) continue
      if (target !== source) map[target] = source
    }
  }
  return map
}

const AZERTY = buildSendMap("azerty")

/** What the TV will actually display, given what we inject (for the log/tests). */
export function layoutPreview(text, layout) {
  if (layout !== "azerty") return String(text)
  const back = {}
  for (const [shown, sent] of Object.entries(AZERTY)) back[sent] = shown
  return [...String(text)].map((c) => back[c] ?? c).join("")
}

/** Translate text on its way out so the TV displays it as written. */
export function translate(text, layout) {
  if (layout !== "azerty") return String(text)
  return [...String(text)].map((c) => AZERTY[c] ?? c).join("")
}

/**
 * Which layout the TV will apply, from what the TV reports about itself. The
 * TCL keyboard on a French device remaps injected keys; the Android stock one
 * (Gboard) does not, and the device locale decides the rest.
 */
export function resolveLayout(ime = "", locale = "") {
  if (ime.includes("tcl.inputmethod") || ime.includes("tcl.ttvs")) return "azerty"
  if (ime.includes("inputmethod.latin")) return "qwerty"
  return /^fr\b|^fr[-_]/i.test(String(locale).trim()) ? "azerty" : "qwerty"
}

/** Characters the layout can emit at all: base and shift are all `input text` has. */
const PRODUCIBLE = {
  azerty: new Set([...FR.flat(), " "]),
  qwerty: new Set([...US.flat(), " "]),
}

/**
 * Characters the TV's keyboard cannot produce, so they will not arrive as typed.
 * On AZERTY that is everything behind AltGr: @ # { } [ ] | \ ~ ` and friends.
 * There is no way around it over adb: `input` can express base and shift only.
 */
export function untypeable(text, layout = "azerty") {
  const reachable = PRODUCIBLE[layout]
  if (!reachable) return []
  return [...new Set([...String(text)].filter((c) => !reachable.has(c)))]
}

/**
 * The stock keyboard on this platform passes injected key events through
 * unchanged, and a switch costs 0.15s (measured), taking effect immediately: an
 * injection sent right after the switch arrives verbatim. So the app can borrow
 * it for the duration of a send and hand the TV's own keyboard back afterwards.
 */
export const CLEAN_IME = "com.google.android.inputmethod.latin/com.android.inputmethod.latin.LatinIME"

/** What to do about the TV's keyboard while text is going out. Pure, so testable. */
export function keyboardAction({ clean, manual, own }) {
  if (manual) return "leave" // the user pinned it with i
  if (!clean) return "use-clean"
  return own && own !== CLEAN_IME ? "restore" : "leave" // nothing to hand back
}

export const LAYOUTS = ["auto", "azerty", "qwerty"]
