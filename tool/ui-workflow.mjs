#!/usr/bin/env node

import { execFileSync } from "node:child_process"
import fs from "node:fs"
import path from "node:path"
import { fileURLToPath } from "node:url"

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..")
const frontendRoot = path.join(repoRoot, "frontend")
const workflowAuthorityPath = path.join(
  repoRoot,
  "agent-skills",
  "ui-development",
  "workflows.json",
)
const taskIndex = process.argv.indexOf("--task")
const explicitTask = taskIndex >= 0 ? process.argv[taskIndex + 1] : ""
const filesIndex = process.argv.indexOf("--files")
const json = process.argv.includes("--json")
const authority = JSON.parse(fs.readFileSync(workflowAuthorityPath, "utf8"))
const workflows = authority.workflows
const inChangedFileScope = (file) => authority.changedFileScope.some((prefix) => (
  prefix.endsWith("/") ? file.startsWith(prefix) : file === prefix
))
const explicitFiles = filesIndex >= 0
  ? (process.argv[filesIndex + 1] || "").split(",").map((file) => file.trim()).filter(Boolean).filter(inChangedFileScope)
  : null

function changedFiles() {
  try {
    return execFileSync("git", ["status", "--porcelain=v1", "-uall"], {
      cwd: repoRoot,
      encoding: "utf8",
    }).trim().split("\n").filter(Boolean)
      .map((line) => line.slice(3).replace(/^"|"$/g, ""))
      .filter(inChangedFileScope)
  } catch {
    return []
  }
}

function matchesPath(file, hint) {
  if (hint.startsWith(".")) return file.endsWith(hint)
  return hint.endsWith("/") ? file.startsWith(hint) : file.includes(hint)
}

function classify(task, files) {
  const input = task.toLowerCase()
  const matches = Object.entries(workflows)
    .filter(([, workflow]) => (
      (task && workflow.terms.some((term) => input.includes(term)))
      || files.some((file) => workflow.paths.some((hint) => matchesPath(file, hint)))
    ))
    .sort(([, left], [, right]) => right.priority - left.priority)
    .map(([id]) => id)

  return matches.length ? matches : [authority.fallback]
}

function unique(items) {
  return [...new Set(items)]
}

if (!fs.existsSync(path.join(frontendRoot, "design-system", "catalog.json"))) {
  console.error("UI workflow resolver requires frontend/design-system/catalog.json.")
  process.exit(1)
}

const files = explicitFiles ?? changedFiles()
const classifications = classify(explicitTask, files)
const selected = classifications.map((kind) => workflows[kind])
const result = {
  version: authority.version,
  scope: authority.scope,
  excludes: authority.excludes,
  classification: classifications[0],
  classifications,
  task: explicitTask || null,
  changedFiles: files,
  descriptions: selected.map((workflow) => workflow.description),
  context: unique(selected.flatMap((workflow) => workflow.context)),
  checks: unique(selected.flatMap((workflow) => workflow.checks)),
  evidence: unique(selected.flatMap((workflow) => workflow.evidence)),
  stopConditions: unique(selected.map((workflow) => workflow.stop)),
}
result.description = result.descriptions.join(" ")
result.stop = result.stopConditions.join(" ")

if (json) {
  console.log(JSON.stringify(result, null, 2))
} else {
  console.log(`# ${classifications.join(" + ")} workflow\n`)
  console.log(result.description)
  console.log("\nContext:")
  result.context.forEach((item) => console.log(`- ${item}`))
  console.log("\nChecks (run from frontend/):")
  result.checks.forEach((item) => console.log(`- ${item}`))
  console.log("\nEvidence:")
  result.evidence.forEach((item) => console.log(`- ${item}`))
  console.log(`\nStop condition:\n- ${result.stop}`)
}
