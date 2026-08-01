import assert from "node:assert/strict"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import test from "node:test"

import {
  gateResourceEnvironment,
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
      { name: "app", default: 4298, overrideEnv: "UI_GATE_E2E_PORT", commandEnv: "PLAYWRIGHT_PORT" },
      { name: "storybook", allocation: "dynamic" },
    ],
    artifacts: [
      { name: "playwright-output", default: ".artifacts/ui-gate/playwright/matrix", commandEnv: "PLAYWRIGHT_OUTPUT_DIR" },
    ],
    workers: {
      serial: "playwright-default",
      parallel: 8,
      overrideEnv: "UI_GATE_E2E_WORKERS",
      commandEnv: "PLAYWRIGHT_WORKERS",
    },
  }, { UI_GATE_E2E_PORT: "4301" }, "slice-b-gate", "parallel"), {
    owner: "slice-b-gate",
    ports: [
      { name: "app", effective: 4301, source: "UI_GATE_E2E_PORT", commandEnv: "PLAYWRIGHT_PORT" },
      { name: "storybook", effective: "dynamic", commandEnv: null },
    ],
    artifacts: [{
      name: "playwright-output",
      effective: ".artifacts/ui-gate/playwright/matrix",
      source: "authority-default",
      commandEnv: "PLAYWRIGHT_OUTPUT_DIR",
    }],
    workers: {
      requested: 8,
      observed: null,
      source: "authority-parallel",
      commandEnv: "PLAYWRIGHT_WORKERS",
    },
  })
})

test("derives only command-facing resource environment", () => {
  const resources = resolveGateResources({
    ports: [{ name: "app", default: 4298, commandEnv: "PLAYWRIGHT_PORT" }],
    artifacts: [{ name: "playwright-output", default: ".artifacts/ui-gate/playwright/matrix", commandEnv: "PLAYWRIGHT_OUTPUT_DIR" }],
    workers: { serial: "playwright-default", parallel: 8, commandEnv: "PLAYWRIGHT_WORKERS" },
  }, {}, "gate", "parallel")
  assert.deepEqual(gateResourceEnvironment(resources), {
    PLAYWRIGHT_PORT: "4298",
    PLAYWRIGHT_OUTPUT_DIR: ".artifacts/ui-gate/playwright/matrix",
    PLAYWRIGHT_WORKERS: "8",
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
