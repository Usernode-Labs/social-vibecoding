import assert from "node:assert/strict"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import test from "node:test"

import {
  observedWorkers,
  resolveGateResources,
  writeGateArtifact,
} from "./ui-gate-telemetry.mjs"

test("extracts the effective browser worker count from suite output", () => {
  assert.equal(observedWorkers("Running 826 tests using 12 workers\n768 passed"), 12)
  assert.equal(observedWorkers("6 passed"), null)
})

test("resolves fixed, overridden, and dynamic resource ownership", () => {
  assert.deepEqual(resolveGateResources({
    ports: [
      { name: "app", default: 4173, overrideEnv: "PLAYWRIGHT_PORT" },
      { name: "storybook", allocation: "dynamic" },
    ],
    workers: "playwright-default",
  }, { PLAYWRIGHT_PORT: "4296" }, "slice-a-gate"), {
    owner: "slice-a-gate",
    ports: [
      { name: "app", effective: 4296, source: "PLAYWRIGHT_PORT" },
      { name: "storybook", effective: "dynamic" },
    ],
    workers: { requested: "playwright-default", observed: null },
  })
})

test("writes a dated machine-readable artifact outside tracked source", () => {
  const frontendRoot = fs.mkdtempSync(path.join(os.tmpdir(), "ui-gate-artifact-"))
  const artifact = {
    schemaVersion: 1,
    startedAt: "2026-08-01T10:00:00.000Z",
    source: { start: { revision: "a".repeat(40), dirty: false } },
    result: { status: "passed" },
  }
  const output = writeGateArtifact({ frontendRoot, artifact })
  assert.ok(output.startsWith(path.join(frontendRoot, ".artifacts", "ui-gate")))
  assert.deepEqual(JSON.parse(fs.readFileSync(output, "utf8")), artifact)
})
