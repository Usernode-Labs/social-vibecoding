import fs from "node:fs"
import path from "node:path"
import { fileURLToPath } from "node:url"

import {
  evaluateInterfaceLawRatchet,
  scanInterfaceFiles,
} from "./interface-law-tools.mjs"

const frontendRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..")
const repoRoot = path.resolve(frontendRoot, "..")
const governedFile = /^frontend\/@\/(?:components|features|docs)\/.+\.(?:ts|tsx)$/

function stringValues(value) {
  if (typeof value === "string") return [value]
  if (Array.isArray(value)) return value.flatMap(stringValues)
  if (value && typeof value === "object") return Object.values(value).flatMap(stringValues)
  return []
}

function patchPaths(toolInput) {
  return stringValues(toolInput).flatMap((value) => [
    ...value.matchAll(/^\*\*\* (?:Update|Add|Delete) File:\s+(.+)$/gm),
  ].map((match) => match[1].trim()))
}

function directPaths(toolInput) {
  if (!toolInput || typeof toolInput !== "object") return []
  return [toolInput.file_path, toolInput.filePath].filter((value) => typeof value === "string")
}

export function governedFilesFromHookInput(input, roots = { frontendRoot, repoRoot }) {
  const cwd = path.resolve(typeof input?.cwd === "string" ? input.cwd : roots.repoRoot)
  const candidates = [...directPaths(input?.tool_input), ...patchPaths(input?.tool_input)]
  return [...new Set(candidates.map((candidate) => (
    path.isAbsolute(candidate) ? path.resolve(candidate) : path.resolve(cwd, candidate)
  )).filter((absolutePath) => {
    const relativePath = path.relative(roots.repoRoot, absolutePath).split(path.sep).join("/")
    return governedFile.test(relativePath)
      && !relativePath.endsWith(".stories.tsx")
      && fs.existsSync(absolutePath)
  }))].sort()
}

function line(item, prefix) {
  return `${prefix} ${item.file}:${item.line}:${item.column} ${item.rule} (${item.match}) — ${item.remediation}`
}

export function reviewHookInput(input, roots = { frontendRoot, repoRoot }) {
  const files = governedFilesFromHookInput(input, roots)
  if (!files.length) return null

  const baseline = JSON.parse(fs.readFileSync(path.join(roots.frontendRoot, "design-system", "interface-law-baseline.json"), "utf8"))
  const findings = scanInterfaceFiles(roots.frontendRoot, files)
  const selected = new Set(files.map((fileName) => path.relative(roots.frontendRoot, fileName)))
  const accepted = baseline.findings.filter((item) => selected.has(item.file))
  const changes = evaluateInterfaceLawRatchet(findings, accepted)
  const details = [
    ...changes.added.map((item) => line(item, "NEW warning")),
    ...findings.filter((item) => !changes.added.some((added) => (
      added.rule === item.rule && added.file === item.file && added.match === item.match
    ))).map((item) => line(item, "Accepted warning")),
    ...changes.resolved.map((item) => `Resolved baseline warning ${item.file} ${item.rule} (${item.match}) ×${item.count}; lower the baseline before committing.`),
  ]
  const noun = files.length === 1 ? "file" : "files"
  const summary = `Interface law per-edit scan checked ${files.length} governed ${noun} (warning-first): ${findings.length} current, ${changes.added.length} new, ${changes.resolved.length} resolved.`
  return {
    hookSpecificOutput: {
      hookEventName: "PostToolUse",
      additionalContext: [summary, ...details].join("\n"),
    },
  }
}

export function runHook(rawInput) {
  if (!rawInput.trim()) return null
  try {
    return reviewHookInput(JSON.parse(rawInput))
  } catch (cause) {
    return {
      hookSpecificOutput: {
        hookEventName: "PostToolUse",
        additionalContext: `Interface law per-edit scan failed without blocking the edit: ${cause instanceof Error ? cause.message : cause}. Run npm --prefix frontend run check:interface-laws:file -- <path>.`,
      },
    }
  }
}

if (path.resolve(process.argv[1] || "") === fileURLToPath(import.meta.url)) {
  const result = runHook(fs.readFileSync(0, "utf8"))
  if (result) process.stdout.write(`${JSON.stringify(result)}\n`)
}
