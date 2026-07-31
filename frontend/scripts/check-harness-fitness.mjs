import { execFileSync } from "node:child_process"
import fs from "node:fs"
import path from "node:path"
import { fileURLToPath } from "node:url"

import { harnessFingerprint } from "./harness-fingerprint.mjs"

const frontendRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..")
const repoRoot = path.resolve(frontendRoot, "..")
const defaultBaselinePath = path.join(frontendRoot, "design-system/harness-fitness-baseline.json")
const defaultEvidencePath = path.join(frontendRoot, "design-system/evidence/candidate-a-shell-live-agent-battery.json")

function filesUnder(relativePath) {
  const absolutePath = path.join(repoRoot, relativePath)
  if (!fs.existsSync(absolutePath)) return []
  if (fs.statSync(absolutePath).isFile()) return [relativePath]
  return fs.readdirSync(absolutePath, { withFileTypes: true })
    .flatMap((entry) => filesUnder(path.join(relativePath, entry.name)))
}

function footprint(relativePath) {
  const files = filesUnder(relativePath)
  const bytes = files.reduce((total, file) => total + fs.statSync(path.join(repoRoot, file)).size, 0)
  return { bytes, estimatedTokens: Math.ceil(bytes / 4), files: files.length }
}

function read(relativePath) {
  return fs.readFileSync(path.join(repoRoot, relativePath), "utf8")
}

function skillDirectories() {
  return fs.readdirSync(path.join(repoRoot, "agent-skills"), { withFileTypes: true })
    .filter((entry) => entry.isDirectory() && fs.existsSync(path.join(repoRoot, "agent-skills", entry.name, "SKILL.md")))
    .map((entry) => `agent-skills/${entry.name}`)
    .sort()
}

function normalizedInstructionLines(paths) {
  const occurrences = new Map()
  for (const relativePath of paths) {
    for (const rawLine of read(relativePath).split("\n")) {
      const line = rawLine
        .replace(/`[^`]+`/g, "<symbol>")
        .replace(/\[[^\]]+\]\([^)]+\)/g, "<link>")
        .replace(/^\s*(?:[-*]|\d+\.)\s*/, "")
        .replace(/\s+/g, " ")
        .trim()
        .toLowerCase()
      if (line.length < 60) continue
      const files = occurrences.get(line) || new Set()
      files.add(relativePath)
      occurrences.set(line, files)
    }
  }
  return [...occurrences.entries()]
    .filter(([, files]) => files.size > 1)
    .map(([line, files]) => ({ line, files: [...files].sort() }))
    .sort((left, right) => left.line.localeCompare(right.line))
}

function ruleProvenance() {
  const lines = read("AGENTS.md").split("\n")
  const rules = []
  for (let index = 0; index < lines.length; index += 1) {
    if (!/^\d+\.\s/.test(lines[index])) continue
    const neighborhood = lines.slice(index, index + 4).join(" ")
    rules.push({
      rule: lines[index].replace(/^\d+\.\s*/, "").trim(),
      recorded: /\btrigger\b/i.test(neighborhood) && /\bproof\b/i.test(neighborhood) && /\bowner\b/i.test(neighborhood),
    })
  }
  return rules
}

function routeContext(authority, routingCase) {
  const output = JSON.parse(execFileSync(process.execPath, [
    path.join(repoRoot, "tool/ui-workflow.mjs"),
    "--task", routingCase.task || "",
    "--files", (routingCase.files || []).join(","),
    "--json",
  ], { cwd: repoRoot, encoding: "utf8" }))
  const context = output.context.map((relativePath) => ({
    path: relativePath,
    ...footprint(relativePath),
  }))
  return {
    id: routingCase.id,
    classifications: output.classifications,
    context,
    totalBytes: context.reduce((total, item) => total + item.bytes, 0),
    estimatedTokens: context.reduce((total, item) => total + item.estimatedTokens, 0),
  }
}

function daysSince(value, now) {
  if (!value) return null
  return Math.floor((now.getTime() - new Date(value).getTime()) / 86_400_000)
}

function broadTriggerKey(trigger) {
  return `${trigger.workflow}:${trigger.term}`
}

export function collectHarnessFitness(options = {}) {
  const now = options.now || new Date()
  const baselinePath = options.baselinePath || process.env.HARNESS_FITNESS_BASELINE_PATH || defaultBaselinePath
  const authority = JSON.parse(read("agent-skills/ui-development/workflows.json"))
  const skills = skillDirectories()
  const instructionPaths = ["AGENTS.md", "frontend/AGENTS.md"]
  const adapterPaths = ["CLAUDE.md", "frontend/CLAUDE.md"]
  const skillPaths = skills.map((directory) => `${directory}/SKILL.md`)
  const baseline = fs.existsSync(baselinePath) ? JSON.parse(fs.readFileSync(baselinePath, "utf8")) : null
  const liveEvidence = fs.existsSync(defaultEvidencePath)
    ? JSON.parse(fs.readFileSync(defaultEvidencePath, "utf8"))
    : null

  const broadTerms = new Set(["audit", "change", "final", "review", "update"])
  const broadTriggers = Object.entries(authority.workflows).flatMap(([workflow, definition]) => (
    definition.terms.filter((term) => broadTerms.has(term)).map((term) => ({ workflow, term }))
  ))
  const acceptedBroadTriggers = new Set(baseline?.acceptedBroadTriggers || [])
  const newBroadTriggers = broadTriggers.filter((trigger) => !acceptedBroadTriggers.has(broadTriggerKey(trigger)))
  const provenance = ruleProvenance()
  const metrics = {
    alwaysLoaded: Object.fromEntries(instructionPaths.map((relativePath) => [relativePath, footprint(relativePath)])),
    adapters: Object.fromEntries(adapterPaths.map((relativePath) => [relativePath, footprint(relativePath)])),
    skillActivation: Object.fromEntries(skillPaths.map((relativePath) => [relativePath, footprint(relativePath)])),
    discoveryMetadata: Object.fromEntries(skills.map((directory) => [
      directory,
      {
        skillFrontmatter: footprint(`${directory}/SKILL.md`).bytes
          - Buffer.byteLength(read(`${directory}/SKILL.md`).replace(/^---\n[\s\S]*?\n---\n?/, "")),
        openai: footprint(`${directory}/agents/openai.yaml`).bytes,
      },
    ])),
    routeContext: authority.routingCases.map((routingCase) => routeContext(authority, routingCase)),
    duplicateInstructions: normalizedInstructionLines([...instructionPaths, ...skillPaths]),
    broadTriggers,
    newBroadTriggers,
    ruleProvenance: provenance,
  }
  const liveEvidenceAgeDays = daysSince(liveEvidence?.recordedAt, now)
  const doctrineReviewAgeDays = daysSince(baseline?.doctrineReviewedAt, now)
  const warnings = []
  if (!baseline) warnings.push({ code: "missing-baseline", message: "No accepted harness-fitness baseline exists." })
  if (metrics.duplicateInstructions.length) {
    warnings.push({
      code: "instruction-duplication",
      message: `${metrics.duplicateInstructions.length} long instruction line(s) repeat across loaded surfaces.`,
    })
  }
  if (newBroadTriggers.length) {
    warnings.push({ code: "broad-triggers", message: `${newBroadTriggers.length} new broad workflow trigger(s) need review.` })
  }
  const unrecordedRules = provenance.filter((rule) => !rule.recorded)
  if (unrecordedRules.length) {
    warnings.push({
      code: "rule-provenance",
      message: `${unrecordedRules.length} numbered harness rule(s) lack adjacent trigger, proof, and owner provenance.`,
    })
  }
  if (liveEvidenceAgeDays === null) {
    warnings.push({ code: "missing-live-evidence", message: "No matched live-agent evidence is recorded." })
  } else if (liveEvidenceAgeDays > 90) {
    warnings.push({ code: "stale-live-evidence", message: `Matched live-agent evidence is ${liveEvidenceAgeDays} days old.` })
  }
  if (doctrineReviewAgeDays === null || doctrineReviewAgeDays > 90) {
    warnings.push({
      code: "stale-doctrine-review",
      message: doctrineReviewAgeDays === null
        ? "No primary-source doctrine review date is recorded."
        : `Primary-source doctrine review is ${doctrineReviewAgeDays} days old.`,
    })
  }

  const currentFingerprint = harnessFingerprint()
  const snapshot = fitnessSnapshot(metrics)
  const baselineSnapshot = baseline?.metrics || null
  return {
    schemaVersion: 1,
    recordedAt: now.toISOString(),
    gitRevision: execFileSync("git", ["rev-parse", "HEAD"], { cwd: repoRoot, encoding: "utf8" }).trim(),
    gitWorktreeDirty: Boolean(execFileSync("git", ["status", "--porcelain=v1"], {
      cwd: repoRoot,
      encoding: "utf8",
    }).trim()),
    harnessFingerprint: currentFingerprint.value,
    acceptedBaseline: baseline
      ? {
          acceptedAt: baseline.acceptedAt,
          fingerprint: baseline.harnessFingerprint,
          fingerprintMatches: baseline.harnessFingerprint === currentFingerprint.value,
          contextDeltaBytes: baselineSnapshot
            ? snapshot.totalRoutedContextBytes - baselineSnapshot.totalRoutedContextBytes
            : null,
          alwaysLoadedDeltaBytes: baselineSnapshot
            ? snapshot.alwaysLoadedBytes - baselineSnapshot.alwaysLoadedBytes
            : null,
        }
      : null,
    evidence: {
      liveAgentRecordedAt: liveEvidence?.recordedAt || null,
      liveAgentAgeDays: liveEvidenceAgeDays,
      doctrineReviewedAt: baseline?.doctrineReviewedAt || null,
      doctrineReviewAgeDays,
    },
    metrics,
    warnings,
  }
}

export function fitnessSnapshot(metrics) {
  return {
    alwaysLoadedBytes: Object.values(metrics.alwaysLoaded)
      .reduce((total, item) => total + item.bytes, 0),
    adapterBytes: Object.values(metrics.adapters)
      .reduce((total, item) => total + item.bytes, 0),
    skillActivationBytes: Object.values(metrics.skillActivation)
      .reduce((total, item) => total + item.bytes, 0),
    totalRoutedContextBytes: metrics.routeContext
      .reduce((total, item) => total + item.totalBytes, 0),
    maximumRoutedContextBytes: Math.max(...metrics.routeContext.map((item) => item.totalBytes), 0),
    routeContext: Object.fromEntries(metrics.routeContext.map((item) => [item.id, {
      classifications: item.classifications,
      bytes: item.totalBytes,
      estimatedTokens: item.estimatedTokens,
    }])),
    duplicateInstructionCount: metrics.duplicateInstructions.length,
    broadTriggerCount: metrics.broadTriggers.length,
    unprovenRuleCount: metrics.ruleProvenance.filter((rule) => !rule.recorded).length,
  }
}

export function baselineFromReport(report, options = {}) {
  return {
    schemaVersion: 1,
    acceptedAt: report.recordedAt,
    doctrineReviewedAt: options.doctrineReviewed
      ? report.recordedAt
      : report.evidence.doctrineReviewedAt,
    sourceRevision: report.gitRevision,
    sourceWorktreeDirty: report.gitWorktreeDirty,
    harnessFingerprint: report.harnessFingerprint,
    acceptedBroadTriggers: report.metrics.broadTriggers.map(broadTriggerKey).sort(),
    metrics: fitnessSnapshot(report.metrics),
  }
}

function printSummary(report) {
  const routeMaximum = report.metrics.routeContext.reduce(
    (largest, item) => item.totalBytes > largest.totalBytes ? item : largest,
    { id: "none", totalBytes: 0, estimatedTokens: 0 },
  )
  console.log("Harness fitness report (advisory; never blocks):")
  console.log(`- Fingerprint: ${report.harnessFingerprint}${report.acceptedBaseline?.fingerprintMatches ? " (accepted)" : ""}`)
  console.log(`- Largest representative routed context: ${routeMaximum.id}, ${routeMaximum.totalBytes} bytes (~${routeMaximum.estimatedTokens} tokens)`)
  console.log(`- Long cross-surface duplicates: ${report.metrics.duplicateInstructions.length}`)
  console.log(`- Broad triggers: ${report.metrics.broadTriggers.length} (${report.metrics.newBroadTriggers.length} new)`)
  console.log(`- Warnings: ${report.warnings.length}`)
  report.warnings.forEach((warning) => console.log(`  - ${warning.code}: ${warning.message}`))
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const report = collectHarnessFitness()
  if (process.argv.includes("--json")) {
    console.log(JSON.stringify(report, null, 2))
  } else {
    printSummary(report)
  }
  const outputPath = process.env.HARNESS_FITNESS_OUTPUT
  if (outputPath) fs.writeFileSync(outputPath, `${JSON.stringify(report, null, 2)}\n`)
  if (process.argv.includes("--record")) {
    const baselinePath = process.env.HARNESS_FITNESS_BASELINE_PATH || defaultBaselinePath
    fs.writeFileSync(baselinePath, `${JSON.stringify(baselineFromReport(report, {
      doctrineReviewed: process.argv.includes("--doctrine-reviewed"),
    }), null, 2)}\n`)
    console.log(`Recorded accepted baseline at ${path.relative(repoRoot, baselinePath)}.`)
  }
}
