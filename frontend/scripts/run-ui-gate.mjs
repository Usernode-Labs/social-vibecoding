import { spawn } from "node:child_process"
import fs from "node:fs"
import path from "node:path"

const frontendRoot = process.cwd()
const repoRoot = path.resolve(frontendRoot, "..")
const authority = JSON.parse(fs.readFileSync(
  path.join(repoRoot, "agent-skills/ui-development/workflows.json"),
  "utf8",
))

if (process.argv.includes("--list")) {
  console.log(JSON.stringify(authority.fullGate, null, 2))
  process.exit(0)
}

const fromIndex = process.argv.includes("--from")
  ? Math.max(0, Number(process.argv[process.argv.indexOf("--from") + 1] || 1) - 1)
  : 0

for (const [index, gate] of authority.fullGate.entries()) {
  if (index < fromIndex) continue
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
}
console.log(`\nUI gate passed: ${authority.fullGate.length - fromIndex}/${authority.fullGate.length} commands from step ${fromIndex + 1}.`)
