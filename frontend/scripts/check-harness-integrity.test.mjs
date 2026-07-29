import assert from "node:assert/strict"
import { spawnSync } from "node:child_process"
import test from "node:test"

test("portable harness structure and CI parity validate without live freshness", () => {
  const run = spawnSync(process.execPath, [
    "scripts/check-harness-integrity.mjs",
    "--skip-evidence-freshness",
  ], { cwd: process.cwd(), encoding: "utf8" })
  assert.equal(run.status, 0, `${run.stdout}\n${run.stderr}`)
})
