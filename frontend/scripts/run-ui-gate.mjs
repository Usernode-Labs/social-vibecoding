import { spawn } from "node:child_process"
import fs from "node:fs"
import path from "node:path"

import { assertPublishableHistory } from "./slice-boundary.mjs"
import { parseGateOptions } from "./ui-gate-options.mjs"
import {
  gitSnapshot,
  machineSnapshot,
  observedWorkers,
  resolveGateResources,
  writeGateArtifact,
} from "./ui-gate-telemetry.mjs"

const frontendRoot = process.cwd()
const repoRoot = path.resolve(frontendRoot, "..")
const authority = JSON.parse(fs.readFileSync(
  path.join(repoRoot, "agent-skills/ui-development/workflows.json"),
  "utf8",
))

let options
try {
  options = parseGateOptions(process.argv.slice(2), authority.fullGate.length)
} catch (cause) {
  console.error(cause instanceof Error ? cause.message : cause)
  process.exit(1)
}

if (process.argv.includes("--list")) {
  console.log(JSON.stringify(authority.fullGate.map((gate, index) => ({
    ...gate,
    step: index + 1,
    action: index < options.fromIndex ? "omitted" : options.skips.has(index) ? "skip" : "run",
    ...(options.skips.has(index) ? { reason: options.skips.get(index) } : {}),
  })), null, 2))
  process.exit(0)
}

const boundaryRun = options.fromIndex === 0 && options.skips.size === 0
const startedAt = new Date()
const startedMs = Date.now()
const owner = process.env.UI_GATE_OWNER?.trim() || "canonical-ui-gate"
const startSource = gitSnapshot(repoRoot)
const stages = []

function artifactResult(status, detail = {}) {
  const finishedAt = new Date()
  const endSource = gitSnapshot(repoRoot)
  const sourceStable = startSource.revision === endSource.revision && !endSource.dirty
  const artifact = {
    schemaVersion: 1,
    command: "npm run check:ui",
    receiptGrade: boundaryRun,
    startedAt: startedAt.toISOString(),
    finishedAt: finishedAt.toISOString(),
    wallTimeMs: Date.now() - startedMs,
    owner,
    machine: machineSnapshot(),
    invocation: {
      fromStep: options.fromIndex + 1,
      skipped: [...options.skips].map(([index, reason]) => ({ step: index + 1, reason })),
    },
    source: { start: startSource, end: endSource, stable: sourceStable },
    stages,
    result: { status, ...detail },
  }
  const output = writeGateArtifact({ frontendRoot, artifact })
  console.log(`\nUI gate timing artifact: ${path.relative(repoRoot, output)}`)
  return { artifact, output }
}

if (boundaryRun) {
  if (startSource.dirty) {
    console.error("receipt-grade UI gate requires a clean working tree")
    artifactResult("failed", {
      failure: { class: "policy", message: "working tree was dirty before the boundary gate" },
    })
    process.exit(1)
  }
  try {
    assertPublishableHistory(repoRoot)
  } catch (cause) {
    const message = cause instanceof Error ? cause.message : String(cause)
    console.error(message)
    artifactResult("failed", { failure: { class: "policy", message } })
    process.exit(1)
  }
}

let passed = 0
const skipped = []

for (const [index, gate] of authority.fullGate.entries()) {
  if (index < options.fromIndex) {
    stages.push({ step: index + 1, cwd: gate.cwd, command: gate.command, status: "omitted" })
    continue
  }
  if (options.skips.has(index)) {
    const reason = options.skips.get(index)
    skipped.push({ step: index + 1, command: gate.command, reason })
    stages.push({ step: index + 1, cwd: gate.cwd, command: gate.command, status: "skipped", reason })
    console.log(`\n[${index + 1}/${authority.fullGate.length}] SKIPPED ${gate.cwd}: ${gate.command} — ${reason}`)
    continue
  }
  console.log(`\n[${index + 1}/${authority.fullGate.length}] ${gate.cwd}: ${gate.command}`)
  const stageStartedAt = new Date()
  const stageStartedMs = Date.now()
  const run = await new Promise((resolve) => {
    const child = spawn(gate.command, {
      cwd: gate.cwd === "root" ? repoRoot : frontendRoot,
      shell: true,
      stdio: ["ignore", "pipe", "pipe"],
      env: process.env,
    })
    let stdout = ""
    let stderr = ""
    const append = (current, chunk) => `${current}${chunk}`.slice(-250000)
    child.stdout.setEncoding("utf8")
    child.stderr.setEncoding("utf8")
    child.stdout.on("data", (chunk) => { stdout = append(stdout, chunk) })
    child.stderr.on("data", (chunk) => { stderr = append(stderr, chunk) })
    child.on("error", (cause) => resolve({ code: 1, stdout, stderr: `${stderr}\n${cause.message}` }))
    child.on("close", (code) => resolve({ code, stdout, stderr }))
  })
  const combinedOutput = `${run.stdout}\n${run.stderr}`
  const resources = resolveGateResources(gate.resources, process.env, owner)
  if (resources.workers) resources.workers.observed = observedWorkers(combinedOutput)
  const summary = run.stdout.trim().split("\n").filter(Boolean).slice(-2).join(" · ")
  const stageRecord = {
    step: index + 1,
    cwd: gate.cwd,
    command: gate.command,
    kind: gate.kind || "check",
    status: run.code === 0 ? "passed" : "failed",
    startedAt: stageStartedAt.toISOString(),
    finishedAt: new Date().toISOString(),
    wallTimeMs: Date.now() - stageStartedMs,
    exitCode: run.code,
    summary: summary || null,
    resources,
  }
  stages.push(stageRecord)
  if (run.code !== 0) {
    process.stdout.write(run.stdout)
    process.stderr.write(run.stderr)
    artifactResult("failed", {
      passed,
      skipped: skipped.length,
      omitted: options.fromIndex,
      failure: {
        step: index + 1,
        class: process.env.UI_GATE_FAILURE_CLASS?.trim() || "unclassified",
        stageKind: stageRecord.kind,
        exitCode: run.code,
        stdoutTail: run.stdout.slice(-4000),
        stderrTail: run.stderr.slice(-4000),
      },
    })
    process.exit(run.code ?? 1)
  }
  console.log(summary || "passed")
  passed += 1
}
const completion = artifactResult("passed", {
  passed,
  skipped: skipped.length,
  omitted: options.fromIndex,
})
if (boundaryRun && !completion.artifact.source.stable) {
  console.error("UI gate source state changed while verification was running")
  completion.artifact.result = {
    status: "failed",
    passed,
    skipped: skipped.length,
    omitted: options.fromIndex,
    failure: { class: "source-state-changed" },
  }
  writeGateArtifact({ frontendRoot, artifact: completion.artifact, outputPath: completion.output })
  process.exit(1)
}
console.log(`\nUI gate completed: ${passed} passed, ${skipped.length} skipped, ${options.fromIndex} omitted before step ${options.fromIndex + 1}.`)
if (skipped.length) {
  console.log(JSON.stringify({ skipped }, null, 2))
}
