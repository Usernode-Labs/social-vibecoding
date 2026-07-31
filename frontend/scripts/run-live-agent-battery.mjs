import { execFileSync, spawnSync } from "node:child_process"
import crypto from "node:crypto"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"

import { harnessFingerprint } from "./harness-fingerprint.mjs"
import { runLiveAgent, supportedLiveRunners } from "./live-agent-runners.mjs"

const frontendRoot = process.cwd()
const repoRoot = path.resolve(frontendRoot, "..")
const evidenceDirectory = path.join(frontendRoot, "design-system", "evidence")
const evidencePath = path.join(evidenceDirectory, "candidate-a-shell-live-agent-battery.json")
const maxInputTokensPerTask = Number(process.env.AGENT_BATTERY_MAX_INPUT_TOKENS || 275_000)
const trials = Number(process.env.AGENT_BATTERY_TRIALS || 2)
const initialRepositoryStatus = repositoryStatus()
const requestedRunners = (process.env.AGENT_BATTERY_RUNNERS || supportedLiveRunners.join(","))
  .split(",")
  .map((runner) => runner.trim())
  .filter(Boolean)
for (const runner of requestedRunners) {
  if (!supportedLiveRunners.includes(runner)) throw new Error(`Unsupported runner ${runner}`)
}

function common(task) {
  return `You are executing the Usernode live agent battery ${task}. Work read-only. Read AGENTS.md and agent-skills/ui-development/SKILL.md, run the repository workflow resolver with the exact task, use precise catalog/source queries, and do not modify files. Return only one concise JSON object.`
}

const taskDefinitions = [
  {
    id: "T1",
    prompt: `${common("T1: discover a personal Home app shortcut before creating one")}
Run: node tool/ui-workflow.mjs --task "Discover and reuse the existing personal Home app shortcut" --files "" --json
Then from frontend run: npm run query:design-system -- "Home app shortcut"
Return keys task, classification, decision, component, owner, maturity, variants, dataBoundary, commandsRun, interventions.`,
    grade: (answer) => (
      (answer?.classification === "component" || answer?.classification?.includes?.("component"))
      && /reuse/i.test(answer?.decision || "")
      && /home-app-shortcut|HomeAppShortcut/.test(answer?.component || "")
    ),
  },
  {
    id: "T2",
    prompt: `${common("T2: decide how to add a destructive button")}
Run: node tool/ui-workflow.mjs --task "Extend a shell Button for a destructive action" --files "" --json
Inspect only frontend/@/components/ui/button.tsx and frontend/design-system/catalog.json as needed.
Return keys task, classification, decision, source, variant, rationale, commandsRun, interventions. The correct decision must avoid a competing Button when an official local destructive variant exists.`,
    grade: (answer) => (
      answer?.classification === "component"
      && /reuse|extend/i.test(answer?.decision || "")
      && /destructive/.test(answer?.variant || "")
    ),
  },
  {
    id: "T3",
    prompt: `${common("T3: discover the development-board compound")}
Run: node tool/ui-workflow.mjs --task "Reuse the existing development board pattern and its Storybook states" --files "" --json
Then from frontend run: npm run query:design-system -- "dev board"
Return keys task, classification, decision, component, variants, dataBoundary, story, commandsRun, interventions.`,
    grade: (answer) => {
      const component = typeof answer?.component === "string"
        ? answer.component
        : `${answer?.component?.name || ""} ${answer?.component?.module || ""}`
      return (
        (answer?.classification === "component" || answer?.classification?.includes?.("component"))
        && /reuse/i.test(answer?.decision || "")
        && /dev-board|DevBoard/.test(component)
      )
    },
  },
  {
    id: "T4",
    prompt: `${common("T4: prove deliberate style violations are rejected")}
From frontend run the raw-color and arbitrary-utility fixture checks five times total. Do not hide or alter failures. The checks must exit non-zero and name a rule, location, and remediation.
Return keys task, enforcement, attempts, actionable, commandsRun, interventions.`,
    grade: (answer) => /\b5\/5\b/.test(answer?.enforcement || "") && answer?.actionable === true,
  },
  {
    id: "T6",
    prompt: `${common("T6: decide whether Home app shortcuts and Explore app cards should be consolidated")}
Run: node tool/ui-workflow.mjs --task "Audit overlapping Home shortcut and Explore card components" --files "" --json
Then from frontend run: npm run query:design-system -- --related "home app"
Return keys task, classifications, decision, components, jobs, substitutionBoundary, commandsRun, interventions.`,
    grade: (answer) => (
      answer?.decision === "keep-distinct"
      && answer?.components?.length === 2
      && Boolean(answer?.substitutionBoundary)
    ),
  },
  {
    id: "T7",
    prompt: `${common("T7: resolve a copy-bearing component review")}
Run: node tool/ui-workflow.mjs --task "Polish Activity feed component copy and add Storybook state" --files "" --json
Return keys task, classifications, contentChecks, fullReviewCheck, context, commandsRun, interventions. Preserve the resolver's complete classifications rather than choosing one.`,
    grade: (answer) => (
      ["content", "component", "review"].every((id) => answer?.classifications?.includes(id))
      && /check:content/.test(JSON.stringify(answer?.contentChecks || ""))
      && /check:ui/.test(answer?.fullReviewCheck || "")
    ),
  },
]

function repositoryStatus() {
  return execFileSync("git", ["status", "--porcelain=v1", "-uall"], {
    cwd: repoRoot,
    encoding: "utf8",
  })
}

async function runReadOnlyTask(runner, definition, trial) {
  const before = repositoryStatus()
  const result = await runLiveAgent(runner, definition.id, definition.prompt, repoRoot)
  const after = repositoryStatus()
  result.trial = trial
  result.unexpectedWrites = before !== after
  result.inputTokenBudget = maxInputTokensPerTask
  result.withinInputTokenBudget = !result.usage
    || (result.usage.input_tokens || 0) <= maxInputTokensPerTask
  result.pass = result.exitCode === 0
    && definition.grade(result.answer)
    && !result.unexpectedWrites
    && result.withinInputTokenBudget
  return result
}

function createRepairFixture() {
  const fixtureRoot = fs.mkdtempSync(path.join(os.tmpdir(), "candidate-a-t5-"))
  for (const directory of [
    "agent-skills/ui-development/references",
    "frontend/design-system",
    "tool",
  ]) fs.mkdirSync(path.join(fixtureRoot, directory), { recursive: true })
  for (const relativePath of [
    "AGENTS.md",
    "agent-skills/ui-development/SKILL.md",
    "agent-skills/ui-development/workflows.json",
    "agent-skills/ui-development/references/authority.md",
    "agent-skills/ui-development/references/consolidation.md",
    "agent-skills/ui-development/references/evidence.md",
    "agent-skills/ui-development/references/review.md",
    "tool/ui-workflow.mjs",
    "frontend/design-system/catalog.json",
  ]) fs.copyFileSync(path.join(repoRoot, relativePath), path.join(fixtureRoot, relativePath))
  fs.writeFileSync(path.join(fixtureRoot, "component.tsx"), [
    "export function BrokenStory() {",
    "  return <button type=\"button\"><span aria-hidden=\"true\">⚙</span></button>",
    "}",
    "",
  ].join("\n"))
  fs.writeFileSync(path.join(fixtureRoot, "check-a11y.mjs"), [
    "import fs from 'node:fs'",
    "const source = fs.readFileSync('component.tsx', 'utf8')",
    "if (!/<button[^>]+aria-label=(?:\\\"[^\\\"]+\\\"|'[^']+')/.test(source)) {",
    "  console.error('Story accessibility check failed: icon-only button needs an accessible aria-label.')",
    "  process.exit(1)",
    "}",
    "console.log('Story accessibility check passed: icon-only button has an accessible name.')",
    "",
  ].join("\n"))
  return fixtureRoot
}

function fixtureState(fixtureRoot) {
  function visit(relativePath = "") {
    return fs.readdirSync(path.join(fixtureRoot, relativePath), { withFileTypes: true })
      .flatMap((entry) => {
        const child = path.join(relativePath, entry.name)
        return entry.isDirectory() ? visit(child) : [child]
      })
  }
  return Object.fromEntries(visit().sort().map((relativePath) => [
    relativePath,
    crypto.createHash("sha256").update(fs.readFileSync(path.join(fixtureRoot, relativePath))).digest("hex"),
  ]))
}

async function runRepairTask(runner, trial) {
  const fixtureRoot = createRepairFixture()
  try {
    const beforeState = fixtureState(fixtureRoot)
    const prompt = "You are executing the Usernode live agent battery T5 in an isolated writable fixture. Read AGENTS.md and agent-skills/ui-development/SKILL.md. Run node tool/ui-workflow.mjs --task \"Repair a Storybook accessibility failure\" and node check-a11y.mjs, repair only component.tsx so the icon-only Storybook-style control has an accessible name, rerun the check, and do not create other files. Return only one concise JSON object with keys task, decision, changedFile, initialFailure, finalResult, retries, commandsRun, interventions."
    const result = await runLiveAgent(runner, "T5", prompt, fixtureRoot, {
      writable: true,
      skipGitCheck: true,
    })
    const fixtureCheck = spawnSync(process.execPath, ["check-a11y.mjs"], {
      cwd: fixtureRoot,
      encoding: "utf8",
    })
    const afterState = fixtureState(fixtureRoot)
    const changedFiles = [...new Set([...Object.keys(beforeState), ...Object.keys(afterState)])]
      .filter((file) => beforeState[file] !== afterState[file])
      .sort()
    result.trial = trial
    result.fixtureOutput = fixtureCheck.stdout.trim() || fixtureCheck.stderr.trim()
    result.changedFiles = changedFiles
    result.unexpectedWrites = JSON.stringify(changedFiles) !== JSON.stringify(["component.tsx"])
    result.inputTokenBudget = maxInputTokensPerTask
    result.withinInputTokenBudget = !result.usage
      || (result.usage.input_tokens || 0) <= maxInputTokensPerTask
    result.pass = result.exitCode === 0
      && fixtureCheck.status === 0
      && /pass/i.test(result.answer?.finalResult || "")
      && !result.unexpectedWrites
      && result.withinInputTokenBudget
    return result
  } finally {
    fs.rmSync(fixtureRoot, { recursive: true, force: true })
  }
}

const description = {
  schemaVersion: 3,
  behavioralRunners: requestedRunners,
  trialsPerTask: trials,
  tasks: [...taskDefinitions.map((task) => task.id), "T5"].sort(),
  matchedConditions: {
    outcomeGraders: "shared final-state and structured-answer graders",
    inputTokenBudgetPerTask: maxInputTokensPerTask,
    effort: "low",
    timeoutMs: 180_000,
    permissionIntent: "read-only except isolated T5 repair fixture",
    nativePermissionProfiles: "recorded per result because command-line interfaces differ",
  },
}
if (process.argv.includes("--describe")) {
  console.log(JSON.stringify(description, null, 2))
  process.exit(0)
}
if (process.argv.includes("--smoke")) {
  const smoke = []
  for (const runner of requestedRunners) {
    const result = await runLiveAgent(
      runner,
      "smoke",
      `Return only this JSON object with no markdown: {"runner":"${runner}","ok":true}`,
      repoRoot,
      { timeoutMs: 60_000 },
    )
    result.pass = result.exitCode === 0
      && result.answer?.runner === runner
      && result.answer?.ok === true
    smoke.push(result)
  }
  console.log(JSON.stringify(smoke, null, 2))
  if (smoke.some((result) => !result.pass)) process.exit(1)
  process.exit(0)
}

const startedAt = Date.now()
const results = []
for (const runner of requestedRunners) {
  for (let trial = 1; trial <= trials; trial += 1) {
    for (const definition of taskDefinitions) {
      results.push(await runReadOnlyTask(runner, definition, trial))
    }
    results.push(await runRepairTask(runner, trial))
  }
}

const totals = results.reduce((total, item) => ({
  inputTokens: total.inputTokens + (item.usage?.input_tokens || 0),
  cachedInputTokens: total.cachedInputTokens + (item.usage?.cached_input_tokens || 0),
  outputTokens: total.outputTokens + (item.usage?.output_tokens || 0),
  reasoningOutputTokens: total.reasoningOutputTokens + (item.usage?.reasoning_output_tokens || 0),
}), { inputTokens: 0, cachedInputTokens: 0, outputTokens: 0, reasoningOutputTokens: 0 })
const runnerResults = Object.fromEntries(requestedRunners.map((runner) => {
  const tasks = results.filter((result) => result.runner === runner)
  return [runner, {
    result: `${tasks.filter((task) => task.pass).length}/${tasks.length}`,
    pass: tasks.every((task) => task.pass),
  }]
}))
const evidence = {
  ...description,
  candidate: "A",
  decisionScope: "Social Vibecoding React shell only",
  harnessFingerprint: harnessFingerprint().value,
  gitRevision: execFileSync("git", ["rev-parse", "HEAD"], { cwd: repoRoot, encoding: "utf8" }).trim(),
  gitWorktreeDirtyAtStart: Boolean(initialRepositoryStatus.trim()),
  portability: {
    canonicalSkills: [
      "agent-skills/ui-development/SKILL.md",
      "agent-skills/harness-fitness/SKILL.md",
    ],
    discoveryAdapters: [".agents", ".claude"],
    behavioralRunners: requestedRunners,
    unsupportedClaims: [],
  },
  recordedAt: new Date().toISOString(),
  wallTimeMs: Date.now() - startedAt,
  result: `${results.filter((item) => item.pass).length}/${results.length}`,
  pass: results.every((item) => item.pass),
  runnerResults,
  totals,
  tasks: results,
}

fs.mkdirSync(evidenceDirectory, { recursive: true })
fs.writeFileSync(evidencePath, `${JSON.stringify(evidence, null, 2)}\n`)
console.log(`Candidate A matched live agent battery: ${evidence.result}; ${totals.inputTokens} input tokens, ${evidence.wallTimeMs} ms.`)
console.log("Recorded design-system/evidence/candidate-a-shell-live-agent-battery.json.")
if (!evidence.pass) process.exit(1)
