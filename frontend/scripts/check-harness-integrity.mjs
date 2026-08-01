import { execFileSync } from "node:child_process"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"

import { wipCommitsInPublishRange } from "./slice-boundary.mjs"

const frontendRoot = process.cwd()
const repoRoot = path.resolve(frontendRoot, "..")
const violations = []
const readJson = (relativePath) => JSON.parse(fs.readFileSync(path.join(repoRoot, relativePath), "utf8"))
const exists = (relativePath) => fs.existsSync(path.join(repoRoot, relativePath))

function validateSkill(skillDirectory) {
  const name = path.basename(skillDirectory)
  const skillPath = path.join(skillDirectory, "SKILL.md")
  const skill = fs.readFileSync(path.join(repoRoot, skillPath), "utf8")
  const frontmatter = skill.match(/^---\n([\s\S]*?)\n---/)
  if (!frontmatter) {
    violations.push(`${skillPath} must have YAML frontmatter`)
  } else {
    const keys = [...frontmatter[1].matchAll(/^([a-z_]+):/gm)].map((match) => match[1])
    if (keys.join(",") !== "name,description") {
      violations.push(`${skillPath} frontmatter must contain only name and description`)
    }
    if (!new RegExp(`^name:\\s*${name}$`, "m").test(frontmatter[1])) {
      violations.push(`${skillPath} name must match its directory`)
    }
  }

  const metadataPath = path.join(skillDirectory, "agents/openai.yaml")
  if (!exists(metadataPath)) {
    violations.push(`${metadataPath} must expose OpenAI discovery metadata`)
    return
  }
  const metadata = fs.readFileSync(path.join(repoRoot, metadataPath), "utf8")
  for (const key of ["display_name", "short_description", "default_prompt"]) {
    if (!new RegExp(`^\\s+${key}:`, "m").test(metadata)) {
      violations.push(`${metadataPath} is missing ${key}`)
    }
  }
}

function validateClaudeAdapter(relativePath) {
  if (!exists(relativePath)) {
    violations.push(`${relativePath} must import its canonical AGENTS.md instructions`)
    return
  }
  if (!/^@AGENTS\.md$/m.test(fs.readFileSync(path.join(repoRoot, relativePath), "utf8"))) {
    violations.push(`${relativePath} must import its canonical AGENTS.md instructions`)
  }
}

const skillDirectories = fs.readdirSync(path.join(repoRoot, "agent-skills"), { withFileTypes: true })
  .filter((entry) => entry.isDirectory() && exists(path.join("agent-skills", entry.name, "SKILL.md")))
  .map((entry) => path.join("agent-skills", entry.name))
  .sort()
if (!skillDirectories.length) violations.push("agent-skills must contain at least one canonical skill")
skillDirectories.forEach(validateSkill)
validateClaudeAdapter("CLAUDE.md")
validateClaudeAdapter("frontend/CLAUDE.md")

const gitignore = fs.readFileSync(path.join(repoRoot, ".gitignore"), "utf8").split("\n")
for (const broadIgnore of [".agents/", ".claude/", ".codex/"]) {
  if (gitignore.includes(broadIgnore)) violations.push(`.gitignore must not hide the whole ${broadIgnore} adapter directory`)
}
for (const adapter of [".agents", ".claude"]) {
  for (const skillDirectory of skillDirectories) {
    const generatedLink = `${adapter}/skills/${path.basename(skillDirectory)}`
    if (!gitignore.includes(generatedLink)) {
      violations.push(`.gitignore must ignore only the generated discovery link: ${generatedLink}`)
    }
  }
}

const workflows = readJson("agent-skills/ui-development/workflows.json")
if (workflows.version !== 3) violations.push("workflows.json version must be 3")
if (!workflows.workflows?.[workflows.fallback]) violations.push("workflows.json fallback must name a workflow")

const frontendPackage = readJson("frontend/package.json")
const rootPackage = readJson("package.json")
const ci = fs.readFileSync(path.join(repoRoot, ".github/workflows/frontend-checks.yml"), "utf8")
const scriptForCommand = (command) => command.match(/^npm run ([\w:-]+)$/)?.[1]
const deterministicBattery = fs.readFileSync(
  path.join(repoRoot, "frontend/scripts/run-agent-battery.mjs"),
  "utf8",
)
if (!/actor:\s*process\.env\.AGENT_ACTOR\s*\|\|\s*"not-exposed-by-host"/.test(deterministicBattery)) {
  violations.push("deterministic agent battery must not attribute an unknown actor to a vendor")
}

for (const [id, workflow] of Object.entries(workflows.workflows || {})) {
  for (const field of ["description", "terms", "paths", "context", "checks", "evidence", "stop"]) {
    if (!(field in workflow)) violations.push(`workflow ${id} is missing ${field}`)
  }
  for (const context of workflow.context || []) {
    if (!exists(context)) violations.push(`workflow ${id} context does not exist: ${context}`)
  }
  for (const command of workflow.checks || []) {
    const script = scriptForCommand(command)
    if (!script || !frontendPackage.scripts[script]) {
      violations.push(`workflow ${id} check is not a frontend package script: ${command}`)
    }
  }
  for (const suppressed of workflow.suppresses || []) {
    if (!workflows.workflows[suppressed]) violations.push(`workflow ${id} suppresses unknown workflow ${suppressed}`)
  }
}

function pathsOverlap(scope, hint) {
  if (scope.endsWith("/")) {
    return hint.startsWith(scope) || (hint.endsWith("/") && scope.startsWith(hint))
  }
  return hint === scope || (!hint.endsWith("/") && (hint.includes(scope) || scope.includes(hint)))
}

const routePaths = Object.values(workflows.workflows || {}).flatMap((workflow) => workflow.paths || [])
for (const scope of workflows.changedFileScope || []) {
  if (!routePaths.some((hint) => pathsOverlap(scope, hint))) {
    violations.push(`changed-file scope has no workflow path owner: ${scope}`)
  }
}

for (const routingCase of workflows.routingCases || []) {
  let result
  try {
    result = JSON.parse(execFileSync(process.execPath, [
      path.join(repoRoot, "tool/ui-workflow.mjs"),
      "--task", routingCase.task || "",
      "--files", (routingCase.files || []).join(","),
      "--json",
    ], { cwd: repoRoot, encoding: "utf8" }))
  } catch (cause) {
    violations.push(`routing case ${routingCase.id} failed to execute: ${cause.message}`)
    continue
  }
  for (const expected of routingCase.expected || []) {
    if (!result.classifications.includes(expected)) {
      violations.push(`routing case ${routingCase.id} did not select ${expected}`)
    }
  }
  for (const forbidden of routingCase.forbidden || []) {
    if (result.classifications.includes(forbidden)) {
      violations.push(`routing case ${routingCase.id} incorrectly selected ${forbidden}`)
    }
  }
}
if (!(workflows.routingCases || []).length) violations.push("workflows.json must define routing regression cases")

for (const gate of workflows.fullGate || []) {
  const script = scriptForCommand(gate.command)
  if (gate.cwd === "frontend" && (!script || !frontendPackage.scripts[script])) {
    violations.push(`full gate command is not a frontend package script: ${gate.command}`)
  }
  if (gate.cwd === "root" && gate.command === "npm test" && !rootPackage.scripts?.test) {
    violations.push("root npm test is missing")
  }
  if (!gate.ciEvidence || !ci.includes(gate.ciEvidence)) {
    violations.push(`full gate lacks continuous-integration evidence: ${gate.command}`)
  }
  for (const port of gate.resources?.ports || []) {
    if (!port.name || typeof port.name !== "string") {
      violations.push(`full gate resource port needs a name: ${gate.command}`)
    }
    const fixed = Number.isInteger(port.default) && port.default > 0 && port.default < 65536
    const dynamic = port.allocation === "dynamic"
    if (fixed === dynamic) {
      violations.push(`full gate resource port needs exactly one fixed default or dynamic allocation: ${gate.command}`)
    }
    if (port.overrideEnv !== undefined && !/^[A-Z][A-Z0-9_]*$/.test(port.overrideEnv)) {
      violations.push(`full gate resource port override must name an environment variable: ${gate.command}`)
    }
  }
  if (gate.resources?.workers !== undefined) {
    const workers = gate.resources.workers
    if (!(Number.isInteger(workers) && workers > 0) && !(typeof workers === "string" && workers.length > 0)) {
      violations.push(`full gate worker ownership is invalid: ${gate.command}`)
    }
  }
}

if (!frontendPackage.scripts?.["finalize:slice"]?.includes("scripts/finalize-slice.mjs")) {
  violations.push("frontend package must expose the canonical slice finalizer")
}
for (const boundaryEvidence of [
  "fetch-depth: 0",
  "SLICE_BOUNDARY_CHECK:",
  "SLICE_PUBLISH_BASE:",
]) {
  if (!ci.includes(boundaryEvidence)) {
    violations.push(`continuous integration is missing publish-boundary evidence: ${boundaryEvidence}`)
  }
}

if (process.env.CI || process.env.SLICE_BOUNDARY_CHECK === "true") {
  try {
    for (const checkpoint of wipCommitsInPublishRange(repoRoot)) {
      violations.push(`publish range contains private checkpoint ${checkpoint.commit.slice(0, 12)}: ${checkpoint.subject}`)
    }
  } catch (cause) {
    violations.push(`publish-range validation failed: ${cause instanceof Error ? cause.message : cause}`)
  }
}

const adapterRoot = fs.mkdtempSync(path.join(os.tmpdir(), "agent-skill-adapters-"))
try {
  execFileSync("bash", [path.join(repoRoot, "tool/setup-agent-skills.sh")], {
    cwd: repoRoot,
    env: { ...process.env, AGENT_SKILL_SETUP_ROOT: adapterRoot },
    stdio: "pipe",
  })
  for (const adapter of [".agents", ".claude"]) {
    for (const skillDirectory of skillDirectories) {
      const name = path.basename(skillDirectory)
      const installed = path.join(adapterRoot, adapter, "skills", name)
      if (!fs.existsSync(path.join(installed, "SKILL.md"))) {
        violations.push(`${adapter} adapter does not resolve ${name}`)
        continue
      }
      if (fs.realpathSync(installed) !== fs.realpathSync(path.join(repoRoot, skillDirectory))) {
        violations.push(`${adapter} adapter does not target canonical skill ${name}`)
      }
    }
  }
} finally {
  fs.rmSync(adapterRoot, { recursive: true, force: true })
}

if (violations.length) {
  console.error(`Harness integrity check failed:\n\n${violations.map((item) => `- ${item}`).join("\n")}`)
  process.exit(1)
}
console.log(`Harness integrity check passed: ${skillDirectories.length} canonical skills, two vendor-consumed adapters, ${(workflows.routingCases || []).length} routing regressions, and ${workflows.fullGate.length} continuous-integration-parity gates.`)
