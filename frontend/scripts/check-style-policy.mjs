import path from "node:path"
import {
  applyStyleExceptions,
  formatStyleViolation,
  governedStyleFiles,
  scanStyleFiles,
} from "./style-policy-tools.mjs"

const frontendRoot = process.cwd()
const fixtureIndex = process.argv.indexOf("--fixture")
const fixture = fixtureIndex >= 0 ? process.argv[fixtureIndex + 1] : null
const reportJson = process.argv.includes("--report-json")
const files = fixture ? [path.resolve(frontendRoot, fixture)] : governedStyleFiles(frontendRoot)
const scanned = scanStyleFiles(frontendRoot, files)
const violations = fixture ? scanned : applyStyleExceptions(frontendRoot, scanned)

if (reportJson) {
  console.log(JSON.stringify(scanned, null, 2))
  process.exit(0)
}

if (violations.length) {
  console.error("Shell style policy failed:\n\n" + violations.map((item) => `- ${formatStyleViolation(item)}`).join("\n"))
  process.exit(1)
}

console.log(`Shell style policy passed: ${files.length} governed pattern modules use semantic tokens or exact, owned, time-bounded exceptions.`)
