import { spawn } from "node:child_process"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"

import { assertPublishableHistory } from "./slice-boundary.mjs"
import { classifyGateFailure } from "./ui-gate-failure.mjs"
import { acquireMachineLease, releaseMachineLease } from "./ui-gate-machine-lease.mjs"
import { parseGateOptions } from "./ui-gate-options.mjs"
import {
  gatePortReservations,
  inspectGateProcesses,
} from "./ui-gate-process-inventory.mjs"
import {
  createProcessSupervisor,
  signalExitCode,
} from "./ui-gate-process-supervisor.mjs"
import { gateMachineUnits, resolveGateGraph, runGateSchedule } from "./ui-gate-scheduler.mjs"
import {
  gateResourceEnvironment,
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
const machineUnits = gateMachineUnits(
  authority.gateGraph?.machineUnits,
  process.env,
  os.availableParallelism(),
)
const graph = resolveGateGraph(authority.fullGate, authority.gateGraph, machineUnits)

let options
try {
  options = parseGateOptions(
    process.argv.slice(2),
    authority.fullGate.length,
    authority.gateGraph.defaultMode,
  )
} catch (cause) {
  console.error(cause instanceof Error ? cause.message : cause)
  process.exit(1)
}

if (process.argv.includes("--list")) {
  console.log(JSON.stringify(graph.map((stage) => ({
    ...stage.gate,
    id: stage.id,
    step: stage.step,
    units: stage.units,
    priority: stage.priority,
    dependsOn: stage.dependsOn,
    mode: options.mode,
    action: stage.step - 1 < options.fromIndex
      ? "omitted"
      : options.skips.has(stage.step - 1) ? "skip" : "run",
    ...(options.skips.has(stage.step - 1) ? { reason: options.skips.get(stage.step - 1) } : {}),
  })), null, 2))
  process.exit(0)
}

const boundaryRun = options.fromIndex === 0 && options.skips.size === 0
const startedAt = new Date()
const startedMs = Date.now()
const owner = process.env.UI_GATE_OWNER?.trim() || "canonical-ui-gate"
const startSource = gitSnapshot(repoRoot)
const stages = []
let lease = null
let maxUnitsObserved = 0
let processPreflight = null
const supervisor = createProcessSupervisor({
  graceMs: authority.processLifecycle.terminationGraceMs,
})
supervisor.install()

function artifactResult(status, detail = {}) {
  const finishedAt = new Date()
  const endSource = gitSnapshot(repoRoot)
  const sourceStable = startSource.revision === endSource.revision && !endSource.dirty
  const artifact = {
    schemaVersion: 3,
    command: options.mode === "serial" ? "npm run check:ui -- --serial" : "npm run check:ui",
    receiptGrade: boundaryRun,
    startedAt: startedAt.toISOString(),
    finishedAt: finishedAt.toISOString(),
    wallTimeMs: Date.now() - startedMs,
    owner,
    machine: machineSnapshot(),
    invocation: {
      mode: options.mode,
      machineUnits,
      maxUnitsObserved,
      lease: lease ? {
        path: lease.leasePath,
        pid: lease.record.pid,
        owner: lease.record.owner,
        units: lease.record.units,
        acquiredAt: lease.record.acquiredAt,
      } : null,
      fromStep: options.fromIndex + 1,
      skipped: [...options.skips].map(([index, reason]) => ({ step: index + 1, reason })),
      processPreflight,
    },
    source: { start: startSource, end: endSource, stable: sourceStable },
    stages: [...stages].sort((left, right) => left.step - right.step),
    result: { status, ...detail },
  }
  const output = writeGateArtifact({ frontendRoot, artifact })
  console.log(`\nUI gate timing artifact: ${path.relative(repoRoot, output)}`)
  return { artifact, output }
}

function spawnStage(stage) {
  const gate = stage.gate
  const stageStartedAt = new Date()
  const stageStartedMs = Date.now()
  const resources = resolveGateResources(gate.resources, process.env, owner, options.mode)
  const childEnvironment = {
    ...process.env,
    ...gateResourceEnvironment(resources),
  }

  return new Promise((resolve) => {
    const child = spawn(gate.command, {
      cwd: gate.cwd === "root" ? repoRoot : frontendRoot,
      shell: true,
      detached: process.platform !== "win32",
      stdio: ["ignore", "pipe", "pipe"],
      env: childEnvironment,
    })
    const supervision = supervisor.track(child, {
      label: stage.id,
      timeoutMs: gate.timeoutMs,
      onTerminate: (reason) => {
        const detail = reason.type === "timeout"
          ? `after ${reason.timeoutMs}ms`
          : reason.type === "signal"
            ? `on ${reason.signal}`
            : "during runner finalization"
        console.error(`\n[${stage.step}/${graph.length}] stopping ${stage.id} process group ${detail}`)
      },
    })
    let stdout = ""
    let stderr = ""
    let settled = false
    const append = (current, chunk) => `${current}${chunk}`.slice(-250000)
    child.stdout.setEncoding("utf8")
    child.stderr.setEncoding("utf8")
    child.stdout.on("data", (chunk) => { stdout = append(stdout, chunk) })
    child.stderr.on("data", (chunk) => { stderr = append(stderr, chunk) })
    const finish = (run) => {
      if (settled) return
      settled = true
      resolve(run)
    }
    child.on("error", (cause) => {
      const termination = supervision.finish()
      finish({ code: 1, stdout, stderr: `${stderr}\n${cause.message}`, termination })
    })
    child.on("close", (code, signal) => {
      const termination = supervision.finish()
      const effectiveCode = termination?.type === "timeout"
        ? 124
        : termination?.type === "signal"
          ? signalExitCode(termination.signal)
          : termination
            ? 1
            : code ?? signalExitCode(signal)
      finish({ code: effectiveCode, stdout, stderr, termination })
    })
  }).then((run) => {
    const combinedOutput = `${run.stdout}\n${run.stderr}`
    if (resources.workers) resources.workers.observed = observedWorkers(combinedOutput)
    const summary = run.stdout.trim().split("\n").filter(Boolean).slice(-2).join(" · ")
    const failure = run.code === 0 ? null : run.termination
      ? {
          class: run.termination.type === "timeout" ? "timeout" : "interrupted",
          reason: run.termination.type === "timeout"
            ? "stage-timeout"
            : run.termination.type === "signal" ? "runner-signal" : "runner-finalize",
          message: run.termination.type === "timeout"
            ? `${stage.id} exceeded its ${run.termination.timeoutMs}ms authority timeout`
            : run.termination.type === "signal"
              ? `${stage.id} was stopped by ${run.termination.signal}`
              : `${stage.id} was stopped during runner finalization`,
        }
      : classifyGateFailure({
          gate,
          stdout: run.stdout,
          stderr: run.stderr,
          override: process.env.UI_GATE_FAILURE_CLASS || "",
        })
    const stageRecord = {
      id: stage.id,
      step: stage.step,
      cwd: gate.cwd,
      command: gate.command,
      kind: gate.kind || "check",
      units: stage.units,
      priority: stage.priority,
      dependsOn: stage.dependsOn,
      mode: options.mode,
      status: run.code === 0 ? "passed" : "failed",
      startedAt: stageStartedAt.toISOString(),
      finishedAt: new Date().toISOString(),
      wallTimeMs: Date.now() - stageStartedMs,
      timeoutMs: gate.timeoutMs,
      exitCode: run.code,
      summary: summary || null,
      resources,
      ...(run.termination ? { termination: run.termination } : {}),
      ...(failure ? { failure } : {}),
    }
    stages.push(stageRecord)
    return { ...run, summary, failure, stageRecord }
  })
}

async function main() {
  if (boundaryRun) {
    if (startSource.dirty) {
      console.error("receipt-grade UI gate requires a clean working tree")
      artifactResult("failed", {
        failure: { class: "policy", message: "working tree was dirty before the boundary gate" },
      })
      return 1
    }
    try {
      assertPublishableHistory(repoRoot)
    } catch (cause) {
      const message = cause instanceof Error ? cause.message : String(cause)
      console.error(message)
      artifactResult("failed", { failure: { class: "policy", message } })
      return 1
    }
  }

  try {
    lease = acquireMachineLease({
      repoRoot,
      owner,
      revision: startSource.revision,
      units: machineUnits,
    })
  } catch (cause) {
    const message = cause instanceof Error ? cause.message : String(cause)
    console.error(message)
    artifactResult("failed", {
      failure: { class: "environment", reason: "machine-lease-unavailable", message },
    })
    return 1
  }

  if (supervisor.interruptedSignal) {
    artifactResult("failed", {
      failure: {
        class: "interrupted",
        reason: "runner-signal",
        message: `UI gate received ${supervisor.interruptedSignal} before scheduling`,
      },
    })
    return signalExitCode(supervisor.interruptedSignal)
  }

  try {
    const reservations = gatePortReservations(graph, process.env, owner, options.mode)
    processPreflight = inspectGateProcesses({
      lifecycle: authority.processLifecycle,
      reservations,
    })
  } catch (cause) {
    const message = cause instanceof Error ? cause.message : String(cause)
    console.error(`UI gate process preflight failed: ${message}`)
    artifactResult("failed", {
      failure: { class: "environment", reason: "process-inventory-unavailable", message },
    })
    return 1
  }

  if (supervisor.interruptedSignal) {
    artifactResult("failed", {
      failure: {
        class: "interrupted",
        reason: "runner-signal",
        message: `UI gate received ${supervisor.interruptedSignal} during process preflight`,
      },
    })
    return signalExitCode(supervisor.interruptedSignal)
  }

  for (const observation of processPreflight.observations) {
    const ports = observation.ports.length ? `; ports ${observation.ports.join(", ")}` : ""
    console.log(`UI gate process observation: ${observation.kind} pid ${observation.pid}, owner ${observation.logicalOwner}, age ${observation.ageMs}ms, CPU ${observation.cpuPercent}% current / ${observation.averageCpuPercent}% lifetime / ${observation.cpuTime} cumulative${ports}`)
  }
  if (processPreflight.violations.length) {
    for (const violation of processPreflight.violations) console.error(`UI gate process violation: ${violation.message}`)
    artifactResult("failed", {
      failure: {
        class: "environment",
        reason: "process-preflight-failed",
        message: `${processPreflight.violations.length} process lifecycle violation(s) block the UI gate`,
      },
    })
    return 1
  }

  const satisfiedIds = []
  const runnable = []
  const skipped = []
  for (const stage of graph) {
    const index = stage.step - 1
    if (index < options.fromIndex) {
      stages.push({
        id: stage.id,
        step: stage.step,
        cwd: stage.gate.cwd,
        command: stage.gate.command,
        status: "omitted",
      })
      satisfiedIds.push(stage.id)
    } else if (options.skips.has(index)) {
      const reason = options.skips.get(index)
      skipped.push({ step: stage.step, command: stage.gate.command, reason })
      stages.push({
        id: stage.id,
        step: stage.step,
        cwd: stage.gate.cwd,
        command: stage.gate.command,
        status: "skipped",
        reason,
      })
      satisfiedIds.push(stage.id)
      console.log(`\n[${stage.step}/${graph.length}] SKIPPED ${stage.gate.cwd}: ${stage.gate.command} — ${reason}`)
    } else {
      runnable.push(stage)
    }
  }

  const schedule = await runGateSchedule({
    stages: runnable,
    mode: options.mode,
    machineUnits,
    satisfiedIds,
    onStageStart: (stage, usedUnits) => {
      console.log(`\n[${stage.step}/${graph.length}] ${stage.gate.cwd}: ${stage.gate.command} (${stage.units} units; ${usedUnits}/${machineUnits} active)`)
    },
    runStage: spawnStage,
  })
  maxUnitsObserved = schedule.maxUnitsObserved

  for (const { result } of schedule.results) {
    if (result.code === 0) console.log(`[${result.stageRecord.step}/${graph.length}] ${result.summary || "passed"}`)
  }
  for (const stage of schedule.notStarted) {
    stages.push({
      id: stage.id,
      step: stage.step,
      cwd: stage.gate.cwd,
      command: stage.gate.command,
      status: "not-run",
      reason: "blocked-by-failure",
    })
  }

  const passed = schedule.results.filter(({ result }) => result.code === 0).length
  if (schedule.failures.length) {
    for (const { result } of schedule.failures) {
      process.stdout.write(result.stdout)
      process.stderr.write(result.stderr)
    }
    const primary = schedule.failures[0].result
    artifactResult("failed", {
      passed,
      skipped: skipped.length,
      omitted: options.fromIndex,
      failure: {
        step: primary.stageRecord.step,
        ...primary.failure,
        stageKind: primary.stageRecord.kind,
        exitCode: primary.code,
        stdoutTail: primary.stdout.slice(-4000),
        stderrTail: primary.stderr.slice(-4000),
      },
      failures: schedule.failures.map(({ result }) => ({
        step: result.stageRecord.step,
        ...result.failure,
        exitCode: result.code,
      })),
      notStarted: schedule.notStarted.map(({ step, id }) => ({ step, id })),
    })
    return primary.code || 1
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
    return 1
  }
  console.log(`\nUI gate completed in ${options.mode} mode: ${passed} passed, ${skipped.length} skipped, ${options.fromIndex} omitted before step ${options.fromIndex + 1}.`)
  if (skipped.length) console.log(JSON.stringify({ skipped }, null, 2))
  return 0
}

let exitCode = 1
try {
  exitCode = await main()
} catch (cause) {
  const message = cause instanceof Error ? cause.stack || cause.message : String(cause)
  console.error(message)
  try {
    artifactResult("failed", {
      failure: { class: "runner", reason: "orchestrator-error", message },
    })
  } catch (artifactCause) {
    console.error(`UI gate could not write its failure artifact: ${artifactCause instanceof Error ? artifactCause.message : artifactCause}`)
  }
} finally {
  supervisor.dispose({ terminateActive: true })
  releaseMachineLease(lease)
}
process.exitCode = exitCode
