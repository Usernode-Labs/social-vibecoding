import assert from "node:assert/strict"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import test from "node:test"

import {
  baselineFromReport,
  collectHarnessFitness,
  fitnessSnapshot,
} from "./check-harness-fitness.mjs"

test("fitness report measures routed context without becoming a blocking gate", () => {
  const report = collectHarnessFitness({
    baselinePath: path.join(os.tmpdir(), `missing-harness-baseline-${process.pid}.json`),
    now: new Date("2026-07-31T00:00:00.000Z"),
  })
  assert.equal(report.schemaVersion, 1)
  assert.ok(report.metrics.routeContext.some((entry) => entry.id === "harness-task"))
  assert.ok(report.metrics.routeContext.every((entry) => entry.totalBytes > 0))
  assert.ok(report.warnings.some((warning) => warning.code === "missing-baseline"))
})

test("accepted baseline is a stable projection of measured evidence", () => {
  const temporaryDirectory = fs.mkdtempSync(path.join(os.tmpdir(), "harness-fitness-test-"))
  const baselinePath = path.join(temporaryDirectory, "baseline.json")
  try {
    const first = collectHarnessFitness({
      baselinePath,
      now: new Date("2026-07-31T00:00:00.000Z"),
    })
    fs.writeFileSync(baselinePath, `${JSON.stringify(baselineFromReport(first), null, 2)}\n`)
    const second = collectHarnessFitness({
      baselinePath,
      now: new Date("2026-07-31T00:00:00.000Z"),
    })
    assert.equal(second.acceptedBaseline.fingerprint, first.harnessFingerprint)
    assert.equal(second.acceptedBaseline.fingerprintMatches, true)
    assert.deepEqual(fitnessSnapshot(second.metrics), fitnessSnapshot(first.metrics))
    assert.equal(second.acceptedBaseline.contextDeltaBytes, 0)
    assert.equal(second.metrics.newBroadTriggers.length, 0)
    assert.ok(!second.warnings.some((warning) => warning.code === "broad-triggers"))
  } finally {
    fs.rmSync(temporaryDirectory, { recursive: true, force: true })
  }
})

test("recording a footprint does not imply a doctrine review", () => {
  const report = collectHarnessFitness({
    baselinePath: path.join(os.tmpdir(), `missing-harness-baseline-${process.pid}.json`),
    now: new Date("2026-07-31T00:00:00.000Z"),
  })
  assert.equal(baselineFromReport(report).doctrineReviewedAt, null)
  assert.equal(
    baselineFromReport(report, { doctrineReviewed: true }).doctrineReviewedAt,
    report.recordedAt,
  )
})

test("recording a new footprint carries an existing doctrine review forward", () => {
  const report = collectHarnessFitness({
    baselinePath: path.join(os.tmpdir(), `missing-harness-baseline-${process.pid}.json`),
    now: new Date("2026-07-31T00:00:00.000Z"),
  })
  report.evidence.doctrineReviewedAt = "2026-07-01T00:00:00.000Z"
  assert.equal(
    baselineFromReport(report).doctrineReviewedAt,
    "2026-07-01T00:00:00.000Z",
  )
})
