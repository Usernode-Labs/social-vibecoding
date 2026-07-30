import { spawn } from "node:child_process"
import fs from "node:fs"
import path from "node:path"

import { parseGateOptions } from "./ui-gate-options.mjs"

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

let passed = 0
const skipped = []

for (const [index, gate] of authority.fullGate.entries()) {
  if (index < options.fromIndex) continue
  if (options.skips.has(index)) {
    const reason = options.skips.get(index)
    skipped.push({ step: index + 1, command: gate.command, reason })
    console.log(`\n[${index + 1}/${authority.fullGate.length}] SKIPPED ${gate.cwd}: ${gate.command} — ${reason}`)
    continue
  }
  console.log(`\n[${index + 1}/${authority.fullGate.length}] ${gate.cwd}: ${gate.command}`)
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
    child.on("close", (code) => resolve({ code, stdout, stderr }))
  })
  if (run.code !== 0) {
    process.stdout.write(run.stdout)
    process.stderr.write(run.stderr)
    process.exit(run.code ?? 1)
  }
  const summary = run.stdout.trim().split("\n").filter(Boolean).slice(-2).join(" · ")
  console.log(summary || "passed")
  passed += 1
}
console.log(`\nUI gate completed: ${passed} passed, ${skipped.length} skipped, ${options.fromIndex} omitted before step ${options.fromIndex + 1}.`)
if (skipped.length) {
  console.log(JSON.stringify({ skipped }, null, 2))
}
