import fs from "node:fs"
import path from "node:path"
import { fileURLToPath } from "node:url"

import {
  evaluateInterfaceLawRatchet,
  governedInterfaceFiles,
  scanInterfaceFiles,
  stagedInterfaceSources,
} from "./interface-law-tools.mjs"

const frontendRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..")
const baselinePath = path.join(frontendRoot, "design-system", "interface-law-baseline.json")
const args = process.argv.slice(2)
const fileIndex = args.indexOf("--file")
if (fileIndex >= 0 && !args[fileIndex + 1]) {
  throw new Error("--file requires a path relative to frontend")
}
const editFile = fileIndex >= 0 ? path.resolve(frontendRoot, args[fileIndex + 1]) : null
const staged = args.includes("--staged")
const reportJson = args.includes("--report-json")
const baseline = JSON.parse(fs.readFileSync(baselinePath, "utf8"))

let files
let sourceOverrides = new Map()
if (editFile) files = [editFile]
else if (staged) ({ files, sources: sourceOverrides } = stagedInterfaceSources(frontendRoot))
else files = governedInterfaceFiles(frontendRoot)

const findings = scanInterfaceFiles(frontendRoot, files, sourceOverrides)
const selectedFiles = new Set(files.map((fileName) => path.relative(frontendRoot, fileName)))
const accepted = baseline.findings.filter((item) => selectedFiles.has(item.file))
const changes = evaluateInterfaceLawRatchet(findings, accepted)
const mode = editFile ? "per-edit" : staged ? "per-commit" : "per-gate"

if (reportJson) {
  console.log(JSON.stringify({ mode, files: files.length, findings, changes }, null, 2))
  process.exit(0)
}

console.log(`Interface law check (${mode}, warning-first): ${files.length} file(s), ${findings.length} accepted warning(s).`)
for (const item of findings) {
  console.warn(`- warning ${item.file}:${item.line}:${item.column} ${item.rule} (${item.match}) — ${item.remediation}`)
}

if (editFile) process.exit(0)
if (changes.added.length || changes.resolved.length) {
  const lines = [
    ...changes.added.map((item) => `- new ${item.file}:${item.line}:${item.column} ${item.rule} (${item.match})`),
    ...changes.resolved.map((item) => `- resolved ${item.file} ${item.rule} (${item.match}) ×${item.count}; lower or remove it in design-system/interface-law-baseline.json`),
  ]
  console.error(`Interface law ratchet changed:\n\n${lines.join("\n")}`)
  process.exit(1)
}
