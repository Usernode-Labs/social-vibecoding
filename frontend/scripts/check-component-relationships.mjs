import fs from "node:fs"
import path from "node:path"

import { relationshipViolations } from "./component-relationship-tools.mjs"

const frontendRoot = process.cwd()
const catalog = JSON.parse(fs.readFileSync(path.join(frontendRoot, "design-system", "catalog.json"), "utf8"))
const relationships = JSON.parse(fs.readFileSync(
  path.join(frontendRoot, "design-system", "relationships.json"),
  "utf8",
))
const violations = relationshipViolations(catalog, relationships)

if (violations.length) {
  console.error(`Component relationship check failed:\n\n${violations.map((item) => `- ${item}`).join("\n")}`)
  process.exit(1)
}

console.log(`Component relationship check passed: ${relationships.decisions.length} reviewed semantic decisions remain explicit.`)
