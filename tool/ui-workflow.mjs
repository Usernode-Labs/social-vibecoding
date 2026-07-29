#!/usr/bin/env node

import { execFileSync } from "node:child_process"
import fs from "node:fs"
import path from "node:path"
import { fileURLToPath } from "node:url"

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..")
const frontendRoot = path.join(repoRoot, "frontend")
const taskIndex = process.argv.indexOf("--task")
const explicitTask = taskIndex >= 0 ? process.argv[taskIndex + 1] : ""
const json = process.argv.includes("--json")

const workflows = {
  authority: {
    description: "Change tokens, component contracts, registry distribution, or design-system policy.",
    context: [
      "frontend/design-system/authority.json",
      "frontend/design-system/tokens.json",
      "frontend/design-system/catalog.json",
      "frontend/registry.json",
      "frontend/design-system/exceptions.json",
    ],
    checks: [
      "npm run check:tokens",
      "npm run check:design-system",
      "npm run check:registry",
      "npm run check:style-policy",
      "npm run test:agent-battery",
    ],
    evidence: [
      "Generated token CSS, catalog, and CLI registry remain reproducible.",
      "Every exception is exact, owned, justified, expiring, and count-bounded.",
      "Candidate A battery records 5/5 enforcement.",
    ],
    stop: "Stop for design-system approver review before adding a new token, primitive, or exception category.",
  },
  component: {
    description: "Create or change a reusable shell component or platform pattern.",
    context: [
      "frontend/design-system/catalog.json",
      "frontend/design-system.manifest.json",
      "frontend/@/components/ui",
      "frontend/registry.json",
    ],
    checks: [
      "npm run check:design-system",
      "npm run check:style-policy",
      "npm run check:harness",
      "npm run test:storybook",
      "npm run typecheck",
    ],
    evidence: [
      "Reuse, extension, or new-pattern decision is stated.",
      "Named Storybook states cover variants and responsive/accessibility states.",
      "Catalog metadata names ownership, maturity, tokens, data boundary, and deprecation.",
    ],
    stop: "Stop if the interaction cannot be represented by an official primitive or an existing owned pattern; record the gap for approval.",
  },
  route: {
    description: "Migrate or change a platform-owned shell route.",
    context: [
      "frontend/AGENTS.md",
      "frontend/design-system/catalog.json",
      "docs/react-migration.md",
      "frontend/@/lib/routes.ts",
    ],
    checks: [
      "npm run check:style-policy",
      "npm run check:harness",
      "npm run typecheck",
      "npm run test:e2e",
      "npm run test:production-review",
    ],
    evidence: [
      "Loading, success, empty/error, permission/capability, mobile, and desktop states are exercised where applicable.",
      "Route, hash, history, and back behavior remain compatible.",
      "The route uses owned adapters rather than endpoints or platform globals.",
    ],
    stop: "Stop before retiring a legacy route until the route-parity record is complete and reviewed.",
  },
  contract: {
    description: "Change native bridge, iframe, auth, service-worker, offline, or history contracts.",
    context: [
      "frontend/AGENTS.md",
      "NATIVE-BRIDGE.md",
      "docs/react-migration.md",
      "frontend/scripts/check-cutover-contract.mjs",
    ],
    checks: [
      "npm run check:harness",
      "npm run test:native-bridge-contract",
      "npm run test:service-worker-contract",
      "npm run test:e2e",
      "npm run check:cutover-contract",
    ],
    evidence: [
      "Compatibility behavior is tested at the adapter and browser boundary.",
      "Security, origin, cookie, cache, and history assumptions are documented.",
      "A real WebView proof is required before production cutover.",
    ],
    stop: "Stop before deployment or legacy retirement without cross-repository and real-device proof.",
  },
  review: {
    description: "Review, polish, or release a completed shell slice.",
    context: [
      "frontend/design-system/catalog.json",
      "frontend/design-system/exceptions.json",
      "docs/react-migration.md",
    ],
    checks: [
      "npm run lint",
      "npm run check:tokens",
      "npm run check:design-system",
      "npm run check:registry",
      "npm run check:style-policy",
      "npm run check:harness",
      "npm run typecheck",
      "npm run build",
      "npm run check:bundle",
      "npm run test:storybook",
    ],
    evidence: [
      "Automated checks pass independently of agent instructions.",
      "Visual and accessibility evidence is attached for changed states.",
      "Known exceptions and unproven contracts are reported, not hidden.",
    ],
    stop: "Stop if any required evidence is missing; polish tools cannot waive a mechanical gate.",
  },
}

function changedFiles() {
  try {
    return execFileSync("git", ["status", "--porcelain=v1", "-uall"], {
      cwd: repoRoot,
      encoding: "utf8",
    }).trim().split("\n").filter(Boolean).map((line) => line.slice(3).replace(/^"|"$/g, ""))
  } catch {
    return []
  }
}

function classify(task, files) {
  const input = (task || files.join(" ")).toLowerCase()
  if (/(token|registry|design-system|design system|authority|primitive|exception)/.test(input)) return "authority"
  if (/(bridge|iframe|service.worker|offline|cookie|auth|history|deep.link|native)/.test(input)) return "contract"
  if (/(component|story|storybook|variant|pattern|card|reuse|extend|primitive)/.test(input)) return "component"
  if (/(review|polish|release|handoff|final|audit)/.test(input)) return "review"
  return "route"
}

if (!fs.existsSync(path.join(frontendRoot, "design-system", "catalog.json"))) {
  console.error("UI workflow resolver requires frontend/design-system/catalog.json.")
  process.exit(1)
}

const files = changedFiles()
const kind = classify(explicitTask, files)
const result = {
  version: 1,
  scope: "social-vibecoding-react-shell",
  excludes: ["child-app source", "app-factory scaffold", "hosted usernode-native/v1 consumers"],
  classification: kind,
  task: explicitTask || null,
  changedFiles: files,
  ...workflows[kind],
}

if (json) {
  console.log(JSON.stringify(result, null, 2))
} else {
  console.log(`# ${kind} workflow\n`)
  console.log(result.description)
  console.log("\nContext:")
  result.context.forEach((item) => console.log(`- ${item}`))
  console.log("\nChecks (run from frontend/):")
  result.checks.forEach((item) => console.log(`- ${item}`))
  console.log("\nEvidence:")
  result.evidence.forEach((item) => console.log(`- ${item}`))
  console.log(`\nStop condition:\n- ${result.stop}`)
}
