import { execFileSync } from "node:child_process"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"

import { wipCommitsInPublishRange } from "./slice-boundary.mjs"
import { wildcardEphemeralListeners } from "./test-loopback-listeners.mjs"
import { hasUnboundedTestTimeout } from "./ui-gate-process-supervisor.mjs"
import { gateMachineUnits, resolveGateGraph } from "./ui-gate-scheduler.mjs"

const frontendRoot = process.cwd()
const repoRoot = path.resolve(frontendRoot, "..")
const violations = []
const readJson = (relativePath) => JSON.parse(fs.readFileSync(path.join(repoRoot, relativePath), "utf8"))
const exists = (relativePath) => fs.existsSync(path.join(repoRoot, relativePath))

function filesBelow(relativeDirectory, predicate) {
  const directory = path.join(repoRoot, relativeDirectory)
  return fs.readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const relativePath = path.join(relativeDirectory, entry.name)
    if (entry.isDirectory()) return filesBelow(relativePath, predicate)
    return predicate(relativePath) ? [relativePath] : []
  })
}

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

const postEditScript = "frontend/scripts/post-edit-interface-laws.mjs"
const postEditCommand = `node \"$(git rev-parse --show-toplevel)/${postEditScript}\"`
if (!exists(postEditScript)) violations.push(`${postEditScript} must provide the shared per-edit interface-law check`)
for (const [configPath, matcher] of [[".codex/hooks.json", "^(?:apply_patch|Edit|Write)$"], [".claude/settings.json", "Edit|Write"]]) {
  if (!exists(configPath)) {
    violations.push(`${configPath} must invoke the per-edit interface-law check`)
    continue
  }
  const config = readJson(configPath)
  const groups = config.hooks?.PostToolUse || []
  const handler = groups.find((group) => group.matcher === matcher)?.hooks?.find((hook) => hook.type === "command")
  if (handler?.command !== postEditCommand) {
    violations.push(`${configPath} must invoke ${postEditScript} from the repository root`)
  }
  if (!Number.isFinite(handler?.timeout) || handler.timeout <= 0) {
    violations.push(`${configPath} must bound the per-edit interface-law check`)
  }
}

// Trigger: Buzz event c96af214339c272aa1d227ce441341f21ab594215f26e86aa25836f7a1723d7d
// proved that wildcard ephemeral listeners can be shadowed by a more-specific
// loopback listener on macOS. Proof: npm run check:harness-integrity. Owner: lead-codex.
for (const testPath of filesBelow("tests", (filePath) => filePath.endsWith(".test.js"))) {
  const source = fs.readFileSync(path.join(repoRoot, testPath), "utf8")
  for (const finding of wildcardEphemeralListeners(source, testPath)) {
    violations.push(`${finding.file}:${finding.line}:${finding.column} ephemeral test listeners must bind 127.0.0.1 explicitly`)
  }
}

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
const processLifecycle = workflows.processLifecycle
for (const field of ["triggerEvent", "proof", "owner"]) {
  if (typeof processLifecycle?.provenance?.[field] !== "string" || !processLifecycle.provenance[field].trim()) {
    violations.push(`processLifecycle.provenance must name ${field}`)
  }
}
if (processLifecycle?.provenance?.triggerEvent
  && !/^[a-f0-9]{64}$/.test(processLifecycle.provenance.triggerEvent)) {
  violations.push("processLifecycle.provenance.triggerEvent must be a Buzz event id")
}
if (!Number.isInteger(processLifecycle?.staleAfterMs) || processLifecycle.staleAfterMs < 60_000) {
  violations.push("processLifecycle.staleAfterMs must be at least one minute")
}
if (!Number.isInteger(processLifecycle?.terminationGraceMs) || processLifecycle.terminationGraceMs < 1_000) {
  violations.push("processLifecycle.terminationGraceMs must be at least one second")
}
const registeredServerPorts = new Set()
for (const server of processLifecycle?.registeredServers || []) {
  if (!/^[a-z0-9][a-z0-9-]*$/.test(server.id || "")) {
    violations.push("registered process server must have a kebab-case id")
  }
  if (!Number.isInteger(server.port) || server.port < 1 || server.port > 65535) {
    violations.push(`registered process server ${server.id || "unknown"} must have a valid port`)
  } else if (registeredServerPorts.has(server.port)) {
    violations.push(`registered process server port is duplicated: ${server.port}`)
  } else {
    registeredServerPorts.add(server.port)
  }
  for (const field of ["protocol", "owner", "expectedLifetime", "commandPattern"]) {
    if (typeof server[field] !== "string" || !server[field].trim()) {
      violations.push(`registered process server ${server.id || "unknown"} is missing ${field}`)
    }
  }
  if (typeof server.allowDuringGate !== "boolean") {
    violations.push(`registered process server ${server.id || "unknown"} must declare allowDuringGate`)
  }
  try {
    new RegExp(server.commandPattern, "i")
  } catch {
    violations.push(`registered process server ${server.id || "unknown"} has an invalid commandPattern`)
  }
}

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

const fixedGatePorts = new Map()
const fixedGateArtifacts = new Map()
for (const gate of workflows.fullGate || []) {
  const script = scriptForCommand(gate.command)
  if (gate.cwd === "frontend" && (!script || !frontendPackage.scripts[script])) {
    violations.push(`full gate command is not a frontend package script: ${gate.command}`)
  }
  for (const artifact of gate.resources?.artifacts || []) {
    if (!artifact.name || typeof artifact.name !== "string") {
      violations.push(`full gate artifact needs a name: ${gate.command}`)
    }
    if (typeof artifact.default !== "string" || !artifact.default.startsWith(".artifacts/")) {
      violations.push(`full gate artifact must stay below frontend/.artifacts: ${gate.command}`)
    }
    if (artifact.commandEnv !== undefined && !/^[A-Z][A-Z0-9_]*$/.test(artifact.commandEnv)) {
      violations.push(`full gate artifact command environment is invalid: ${gate.command}`)
    }
    const owner = fixedGateArtifacts.get(artifact.default)
    if (owner) {
      violations.push(`full gate artifact ${artifact.default} is shared by ${owner} and ${gate.command}`)
    } else {
      fixedGateArtifacts.set(artifact.default, gate.command)
    }
  }
  if (gate.cwd === "root" && gate.command === "npm test" && !rootPackage.scripts?.test) {
    violations.push("root npm test is missing")
  }
  if (!gate.ciEvidence || !ci.includes(gate.ciEvidence)) {
    violations.push(`full gate lacks continuous-integration evidence: ${gate.command}`)
  }
  if (!Number.isInteger(gate.timeoutMs) || gate.timeoutMs < 1_000) {
    violations.push(`full gate command needs a bounded timeoutMs: ${gate.command}`)
  }
  if (hasUnboundedTestTimeout(gate.command)) {
    violations.push(`full gate command must not disable test timeouts: ${gate.command}`)
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
    if (port.commandEnv !== undefined && !/^[A-Z][A-Z0-9_]*$/.test(port.commandEnv)) {
      violations.push(`full gate resource port command environment is invalid: ${gate.command}`)
    }
    if (typeof port.protocol !== "string" || !port.protocol.trim()) {
      violations.push(`full gate resource port must declare its protocol: ${gate.command}`)
    }
    if (fixed) {
      const owner = fixedGatePorts.get(port.default)
      if (owner) {
        violations.push(`full gate fixed port ${port.default} is shared by ${owner} and ${gate.command}`)
      } else {
        fixedGatePorts.set(port.default, gate.command)
      }
    }
  }
  if (gate.resources?.workers !== undefined) {
    const workers = gate.resources.workers
    const validWorkerValue = (value) => (Number.isInteger(value) && value > 0)
      || (typeof value === "string" && value.length > 0)
    const validWorkerObject = workers && typeof workers === "object"
      && validWorkerValue(workers.serial)
      && validWorkerValue(workers.parallel)
      && (workers.overrideEnv === undefined || /^[A-Z][A-Z0-9_]*$/.test(workers.overrideEnv))
      && (workers.commandEnv === undefined || /^[A-Z][A-Z0-9_]*$/.test(workers.commandEnv))
    if (!validWorkerValue(workers) && !validWorkerObject) {
      violations.push(`full gate worker ownership is invalid: ${gate.command}`)
    }
  }
  if (gate.resources?.serverReuse !== undefined) {
    const reuse = gate.resources.serverReuse
    if (typeof reuse?.allowed !== "boolean" || !/^[A-Z][A-Z0-9_]*$/.test(reuse.commandEnv || "")) {
      violations.push(`full gate server reuse ownership is invalid: ${gate.command}`)
    }
  }
}

for (const [name, command] of Object.entries(frontendPackage.scripts || {})) {
  if (hasUnboundedTestTimeout(command)) {
    violations.push(`frontend package command ${name} must not disable test timeouts`)
  }
}
for (const [name, command] of Object.entries(rootPackage.scripts || {})) {
  if (hasUnboundedTestTimeout(command)) {
    violations.push(`root package command ${name} must not disable test timeouts`)
  }
}
const sharedPlaywrightConfig = fs.readFileSync(path.join(repoRoot, "frontend/playwright.config.ts"), "utf8")
if (!sharedPlaywrightConfig.includes('process.env.PLAYWRIGHT_REUSE_EXISTING_SERVER === "true"')) {
  violations.push("shared Playwright server reuse must require explicit PLAYWRIGHT_REUSE_EXISTING_SERVER=true")
}
if (!ci.includes('PLAYWRIGHT_REUSE_EXISTING_SERVER: "true"')) {
  violations.push("continuous integration must explicitly authorize reuse of its prestarted service-worker preview")
}

if (!["serial", "parallel"].includes(workflows.gateGraph?.defaultMode)) {
  violations.push("gateGraph defaultMode must be serial or parallel")
}
try {
  const units = gateMachineUnits(
    workflows.gateGraph?.machineUnits,
    {},
    os.availableParallelism(),
  )
  resolveGateGraph(workflows.fullGate || [], workflows.gateGraph, units)
} catch (cause) {
  violations.push(`gateGraph is invalid: ${cause instanceof Error ? cause.message : cause}`)
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
