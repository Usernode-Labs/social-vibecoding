import assert from "node:assert/strict"
import fs from "node:fs"
import path from "node:path"
import test from "node:test"

import { relationshipViolations } from "./component-relationship-tools.mjs"

const frontendRoot = process.cwd()
const catalog = JSON.parse(fs.readFileSync(path.join(frontendRoot, "design-system", "catalog.json"), "utf8"))
const relationships = JSON.parse(fs.readFileSync(
  path.join(frontendRoot, "design-system", "relationships.json"),
  "utf8",
))

test("committed relationship authority is valid", () => {
  assert.deepEqual(relationshipViolations(catalog, relationships), [])
})

test("keep-distinct decisions require a user job for every component", () => {
  const invalid = structuredClone(relationships)
  invalid.decisions[0].jobs = invalid.decisions[0].jobs.slice(0, 1)
  assert.match(
    relationshipViolations(catalog, invalid).join("\n"),
    /jobs is missing app-identity/,
  )
})

test("supersession cannot omit a replacement and migration", () => {
  const invalid = structuredClone(relationships)
  invalid.decisions[0].decision = "supersede"
  assert.match(
    relationshipViolations(catalog, invalid).join("\n"),
    /migration is required[\s\S]*replacement must name/,
  )
})
