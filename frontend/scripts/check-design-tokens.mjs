import fs from "node:fs"
import path from "node:path"

import { checkDesignTokens, renderDesignTokens } from "./design-token-tools.mjs"

const canonical = JSON.parse(fs.readFileSync(path.join(process.cwd(), "design-system", "tokens.json"), "utf8"))

function expectRejected(label, mutate) {
  const candidate = structuredClone(canonical)
  mutate(candidate.semantic)
  try {
    renderDesignTokens(candidate)
  } catch {
    return
  }
  throw new Error(`mutation guard accepted ${label}`)
}

try {
  checkDesignTokens()
  expectRejected("flattened foreground hierarchy", (semantic) => {
    for (const mode of ["light", "dark"]) {
      semantic[mode]["fg-primary"].$value.alpha = 0.999
      semantic[mode]["fg-secondary"].$value.alpha = 0.998
      semantic[mode]["fg-tertiary"].$value.alpha = 0.997
    }
  })
  expectRejected("chromatic Container ink", (semantic) => {
    semantic.light.container.$value.components = [0, 0.2, 300]
  })
  expectRejected("chromatic muted fill", (semantic) => {
    semantic.light.muted.$value.components = [0.7, 0.3, 350]
  })
  expectRejected("Popover outside Paper", (semantic) => {
    semantic.dark.popover.$value = { colorSpace: "oklch", components: [0.1, 0, 0] }
  })
  expectRejected("noncanonical Container alpha", (semantic) => {
    semantic.light.container.$value.alpha = 0.05
  })
  expectRejected("Sidebar outside Canvas", (semantic) => {
    semantic.light.sidebar.$value = { colorSpace: "oklch", components: [0.985, 0, 0] }
  })
  console.log("Design-token check passed: canonical DTCG tokens and generated CSS agree.")
} catch (error) {
  console.error(`Design-token check failed:\n\n- ${error.message}`)
  process.exit(1)
}
