import assert from "node:assert/strict"
import fs from "node:fs"
import path from "node:path"
import test from "node:test"

import { namedExports, renderCatalog } from "./design-system-catalog-tools.mjs"

const frontendRoot = process.cwd()

test("pattern catalog entries expose every named source export", () => {
  const manifest = JSON.parse(fs.readFileSync(path.join(frontendRoot, "design-system.manifest.json"), "utf8"))
  const catalog = JSON.parse(renderCatalog())

  for (const pattern of manifest.patterns) {
    const source = fs.readFileSync(path.join(frontendRoot, pattern.module), "utf8")
    const component = catalog.components.find((candidate) => candidate.id === pattern.id)
    assert.deepEqual(component.exports, namedExports(source), pattern.id)
    assert.ok(component.exports.includes(pattern.export), `${pattern.id} must expose its primary export`)
  }
})
