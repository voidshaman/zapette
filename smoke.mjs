// Smoke test: does the native core load and render in-memory on Node 26 + FFI?
import { BoxRenderable, TextRenderable } from "@opentui/core"
import { createTestRenderer } from "@opentui/core/testing"

const setup = await createTestRenderer({ width: 40, height: 5 })
const box = new BoxRenderable(setup.renderer, { width: 40, height: 5, border: true })
box.add(new TextRenderable(setup.renderer, { content: "native core OK" }))
setup.renderer.root.add(box)
await setup.renderOnce()
const frame = setup.captureCharFrame()
console.log("--- frame ---")
console.log(frame)
setup.renderer.destroy()
console.log("destroyed cleanly")
