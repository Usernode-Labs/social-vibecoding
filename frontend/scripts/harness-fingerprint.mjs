import crypto from "node:crypto"
import fs from "node:fs"
import path from "node:path"
import { fileURLToPath } from "node:url"

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..")
const roots = [
  "AGENTS.md",
  "CLAUDE.md",
  "frontend/AGENTS.md",
  "agent-skills/ui-development",
  "tool/ui-workflow.mjs",
  "tool/setup-agent-skills.sh",
  "frontend/design-system/authority.json",
  "frontend/design-system.manifest.json",
  "frontend/design-system/relationships.json",
  "frontend/design-system/agent-battery.tasks.json",
  "frontend/package.json",
  "frontend/scripts/check-component-relationships.mjs",
  "frontend/scripts/check-harness-integrity.mjs",
  "frontend/scripts/check-harness-policy.mjs",
  "frontend/scripts/check-style-policy.mjs",
  "frontend/scripts/component-relationship-tools.mjs",
  "frontend/scripts/query-design-system.mjs",
  "frontend/scripts/run-agent-battery.mjs",
  "frontend/scripts/run-live-agent-battery.mjs",
  "frontend/scripts/run-ui-gate.mjs",
  ".github/workflows/frontend-checks.yml",
]

function filesUnder(relativePath) {
  const absolutePath = path.join(repoRoot, relativePath)
  if (!fs.existsSync(absolutePath)) return []
  if (fs.statSync(absolutePath).isFile()) return [relativePath]
  return fs.readdirSync(absolutePath, { withFileTypes: true })
    .flatMap((entry) => filesUnder(path.join(relativePath, entry.name)))
}

export function harnessFingerprint() {
  const hash = crypto.createHash("sha256")
  const files = roots.flatMap(filesUnder).sort()
  for (const file of files) {
    hash.update(file)
    hash.update("\0")
    hash.update(fs.readFileSync(path.join(repoRoot, file)))
    hash.update("\0")
  }
  return { algorithm: "sha256", value: hash.digest("hex"), files }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  console.log(JSON.stringify(harnessFingerprint(), null, 2))
}
