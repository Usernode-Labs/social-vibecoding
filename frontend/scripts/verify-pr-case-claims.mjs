import { execSync } from "node:child_process"
import assert from "node:assert/strict"
import fs from "node:fs"
import path from "node:path"
import { fileURLToPath } from "node:url"

const frontendRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..")
const repoRoot = path.resolve(frontendRoot, "..")
const evidence = JSON.parse(fs.readFileSync(path.join(repoRoot, "docs", "pr-case", "claims.json"), "utf8"))

for (const claim of evidence.claims) {
  try {
    const output = execSync(claim.command, {
      cwd: repoRoot,
      encoding: "utf8",
      shell: true,
      stdio: ["ignore", "pipe", "pipe"],
      maxBuffer: 32 * 1024 * 1024,
    }).trim()
    const actual = JSON.parse(output)
    assert.deepEqual(actual, { id: claim.id, metrics: claim.metrics })
    console.log(`${claim.id} reproduced exactly: ${claim.metrics.length} structured metric(s).`)
  } catch (error) {
    throw new Error(`${claim.id} reproduce command failed or drifted:\n${claim.command}\n\n${error.stderr?.trim() || error.message}`)
  }
}

console.log(`Verified ${evidence.claims.length} pull-request case reproduce commands.`)
