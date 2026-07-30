import { execFileSync } from "node:child_process"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { fileURLToPath } from "node:url"
import { harnessFingerprint } from "./harness-fingerprint.mjs"

const frontendRoot = process.cwd()
const repoRoot = path.resolve(frontendRoot, "..")
const skipEvidenceFreshness = process.argv.includes("--skip-evidence-freshness")
const violations = []
const readJson = (relativePath) => JSON.parse(fs.readFileSync(path.join(repoRoot, relativePath), "utf8"))

const skillPath = path.join(repoRoot, "agent-skills/ui-development/SKILL.md")
const skill = fs.readFileSync(skillPath, "utf8")
const frontmatter = skill.match(/^---\n([\s\S]*?)\n---/)
if (!frontmatter) {
  violations.push("ui-development/SKILL.md must have YAML frontmatter")
} else {
  const keys = [...frontmatter[1].matchAll(/^([a-z_]+):/gm)].map((match) => match[1])
  if (keys.join(",") !== "name,description") violations.push("SKILL.md frontmatter must contain only name and description")
  if (!/^name:\s*ui-development$/m.test(frontmatter[1])) violations.push("SKILL.md name must match its directory")
}

const claudeAdapterPath = path.join(repoRoot, "CLAUDE.md")
if (!fs.existsSync(claudeAdapterPath)) {
  violations.push("CLAUDE.md must import the canonical AGENTS.md instructions")
} else {
  const claudeAdapter = fs.readFileSync(claudeAdapterPath, "utf8")
  if (!/^@AGENTS\.md$/m.test(claudeAdapter)) {
    violations.push("CLAUDE.md must import the canonical AGENTS.md instructions")
  }
}

const openaiYaml = fs.readFileSync(path.join(repoRoot, "agent-skills/ui-development/agents/openai.yaml"), "utf8")
for (const key of ["display_name", "short_description", "default_prompt"]) {
  if (!new RegExp(`^\\s+${key}:`, "m").test(openaiYaml)) violations.push(`agents/openai.yaml is missing ${key}`)
}

const workflows = readJson("agent-skills/ui-development/workflows.json")
if (workflows.version !== 2) violations.push("workflows.json version must be 2")
if (!workflows.workflows?.[workflows.fallback]) violations.push("workflows.json fallback must name a workflow")
for (const [id, workflow] of Object.entries(workflows.workflows || {})) {
  for (const field of ["description", "terms", "paths", "context", "checks", "evidence", "stop"]) {
    if (!(field in workflow)) violations.push(`workflow ${id} is missing ${field}`)
  }
  for (const context of workflow.context || []) {
    if (!fs.existsSync(path.join(repoRoot, context))) violations.push(`workflow ${id} context does not exist: ${context}`)
  }
}

const frontendPackage = readJson("frontend/package.json")
const rootPackage = readJson("package.json")
const ci = fs.readFileSync(path.join(repoRoot, ".github/workflows/frontend-checks.yml"), "utf8")
for (const gate of workflows.fullGate || []) {
  const match = gate.command.match(/^npm run ([\w:-]+)$/)
  if (gate.cwd === "frontend" && (!match || !frontendPackage.scripts[match[1]])) {
    violations.push(`full gate command is not a frontend package script: ${gate.command}`)
  }
  if (gate.cwd === "root" && gate.command === "npm test" && !rootPackage.scripts?.test) {
    violations.push("root npm test is missing")
  }
  if (!gate.ciEvidence || !ci.includes(gate.ciEvidence)) {
    violations.push(`full gate lacks CI evidence: ${gate.command}`)
  }
}

const adapterRoot = fs.mkdtempSync(path.join(os.tmpdir(), "ui-skill-adapters-"))
try {
  execFileSync("bash", [path.join(repoRoot, "tool/setup-agent-skills.sh")], {
    cwd: repoRoot,
    env: { ...process.env, AGENT_SKILL_SETUP_ROOT: adapterRoot },
    stdio: "pipe",
  })
  for (const adapter of [".agents", ".claude", ".codex"]) {
    const installed = path.join(adapterRoot, adapter, "skills/ui-development")
    if (!fs.existsSync(path.join(installed, "SKILL.md"))) violations.push(`${adapter} adapter does not resolve the canonical skill`)
    if (fs.realpathSync(installed) !== fs.realpathSync(path.dirname(skillPath))) {
      violations.push(`${adapter} adapter does not target the canonical skill`)
    }
  }
} finally {
  fs.rmSync(adapterRoot, { recursive: true, force: true })
}

if (!skipEvidenceFreshness) {
  const liveEvidencePath = path.join(frontendRoot, "design-system/evidence/candidate-a-shell-live-agent-battery.json")
  if (!fs.existsSync(liveEvidencePath)) {
    violations.push("live agent battery evidence is missing")
  } else {
    const evidence = JSON.parse(fs.readFileSync(liveEvidencePath, "utf8"))
    const current = harnessFingerprint()
    if (evidence.harnessFingerprint !== current.value) {
      violations.push("live agent battery evidence is stale for the current harness fingerprint")
    }
  }
}

if (violations.length) {
  console.error(`Harness integrity check failed:\n\n${violations.map((item) => `- ${item}`).join("\n")}`)
  process.exit(1)
}
console.log(`Harness integrity check passed: composable workflows, ${workflows.fullGate.length} CI-parity gates, three portable adapters, and ${skipEvidenceFreshness ? "freshness skipped" : "fresh live evidence"}.`)
