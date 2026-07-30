import assert from "node:assert/strict"
import { spawnSync } from "node:child_process"
import test from "node:test"

test("portable harness structure and continuous-integration parity validate deterministically", () => {
  const run = spawnSync(process.execPath, [
    "scripts/check-harness-integrity.mjs",
  ], { cwd: process.cwd(), encoding: "utf8" })
  assert.equal(run.status, 0, `${run.stdout}\n${run.stderr}`)
})
