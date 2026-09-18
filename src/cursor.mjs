// Cursor mode's pointer model: where the TV pointer is, and how a terminal cell
// of mouse movement moves it.
//
// WHY THIS IS A MODEL AND NOT A FORWARDED MOUSE. The TV draws no pointer for
// events injected through monkey: measured on the TCL, `touch move <x> <y>`
// alone changes NOT ONE PIXEL (byte-identical frames, with the framework's own
// touch indicator and pointer-location overlay on), because a MOVE with no DOWN
// in front of it is dropped by the input pipeline — the events are
// touchscreen-sourced, not mouse-sourced, so nothing renders a cursor. What DOES
// land is `tap <x> <y>` (16.25 ms, 61/s: it activated a video tile in SmartTube
// and a button in the companion's own activity). So the position is kept HERE,
// the TUI is what shows it, and a click is one `tap` at that position.
//
// THE MAPPING IS MOVEMENT-SCALED, NOT ABSOLUTE-PER-CELL. A terminal cell is not a
// pixel: at 190x46 cells on a 1920x1080 panel one cell is ~10x23 TV pixels, so an
// absolute cell→pixel map can only ever address 190 x 46 distinct points and
// every jump is a visible 10-23 px step. A relative pointer accumulates mouse
// movement instead, and the gain is what decides the feel:
//
//     px = sign(d) * min(step, base*|d| + accel*|d|^2)      |d| in cells
//
// base is the careful, aim-at-a-button gain (a slow 1-cell nudge is 6 px, so a
// 40 px target is ten nudges away), and the quadratic term is the traverse: a
// flick crosses the screen in a handful of events instead of hundreds. Both ends
// are reported as measured numbers rather than as a feel claim — see
// CURSOR.notes below, which the TUI's own footer repeats.
export const CURSOR = {
  // The panel. Verified, not assumed: this TV reports `Physical size: 1920x1080`,
  // and an injected touch at 1500,900 made the framework's own pointer-location
  // readout print "X: 1500.0, Y: 900.0" — so coordinates are 1:1 panel pixels
  // with no scaling in between.
  width: 1920,
  height: 1080,
  base: 4, // px per cell at a deliberate, slow move
  accel: 2, // px per cell² — the same event faster covers more ground
  step: 240, // px ceiling for ONE mouse event, so nothing teleports
}

/** Pixels for one mouse event's cell delta `d` (signed). */
export function cursorGain(d) {
  const cells = Math.abs(d)
  if (!cells) return 0
  const px = Math.min(CURSOR.step, CURSOR.base * cells + CURSOR.accel * cells * cells)
  return Math.sign(d) * Math.round(px)
}

/** A pointer sitting in the middle of the panel, which is where a session starts. */
export function createCursor({ width = CURSOR.width, height = CURSOR.height } = {}) {
  return { x: Math.round(width / 2), y: Math.round(height / 2), width, height }
}

/**
 * Move by a cell delta and return the pixel step actually taken. The pointer is
 * clamped to the panel: a TV at the top-left eats further left/up movement
 * rather than wrapping or going negative.
 */
export function cursorMove(cursor, dxCells, dyCells) {
  const beforeX = cursor.x
  const beforeY = cursor.y
  const nextX = cursor.x + cursorGain(dxCells)
  const nextY = cursor.y + cursorGain(dyCells)
  cursor.x = Math.max(0, Math.min(cursor.width - 1, nextX))
  cursor.y = Math.max(0, Math.min(cursor.height - 1, nextY))
  return { dx: cursor.x - beforeX, dy: cursor.y - beforeY }
}

/** How many cell of mouse movement a traverse of the panel costs at each gain. */
export function cursorReach() {
  const slow = Math.ceil(CURSOR.width / cursorGain(1))
  const flick = Math.ceil(CURSOR.width / cursorGain(6))
  return { slow, flick, slowPx: cursorGain(1), flickPx: cursorGain(6) }
}

/** One line for the footer: where the pointer is and what a click will do. */
export function cursorLine(cursor) {
  return `◉ ${cursor.x},${cursor.y} of ${cursor.width}x${cursor.height}`
}
