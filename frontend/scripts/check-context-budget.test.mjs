import assert from "node:assert/strict"
import test from "node:test"

import {
  collectContextBudgetMeasurement,
  evaluateContextBudget,
  readContextBudgetPolicy,
} from "./check-context-budget.mjs"

function fixture() {
  return {
    policy: {
      schemaVersion: 1,
      phase: "post-routing",
      ownerLock: {
        eventId: "c".repeat(64),
        lockedAt: "2026-08-03T00:00:00Z",
        postRoutingCeilingBytes: 100,
      },
      authoritySlice: {
        startRevision: "a".repeat(40),
        componentReviewStartBytes: 60,
        componentReviewAcceptedBytes: 60,
        guidanceDeltaBytes: 0,
        alwaysLoadedStartBytes: 10,
        skillActivationStartBytes: 5,
      },
      componentReview: {
        routingCaseId: "component-review",
        buckets: {
          payload: { startBytes: 40, maximumBytes: 40, entries: [{ path: "payload", startBytes: 40 }] },
          guidance: { startBytes: 20, maximumBytes: 20, entries: [{ path: "guidance", startBytes: 20 }] },
        },
        postRoutingRatchetBytes: 60,
        postRoutingEntries: [
          { path: "payload", acceptedBytes: 40 },
          { path: "guidance", acceptedBytes: 20 },
        ],
      },
      routingSlice: {
        startRevision: "a".repeat(40),
        activatedAt: "2026-08-03T00:00:00Z",
        batteryCommand: "npm run check:progressive-context",
      },
      globalRatchets: { alwaysLoadedBytes: 10, skillActivationBytes: 5 },
      exceptions: [],
    },
    measurement: {
      recordedAt: "2026-08-03T00:00:00.000Z",
      gitRevision: "b".repeat(64),
      gitWorktreeDirty: false,
      alwaysLoadedBytes: 10,
      skillActivationBytes: 5,
      componentReview: {
        id: "component-review",
        totalBytes: 60,
        entries: [{ path: "payload", bytes: 40 }, { path: "guidance", bytes: 20 }],
      },
    },
  }
}

test("committed context budget matches the measured repository state", () => {
  const report = evaluateContextBudget(
    readContextBudgetPolicy(),
    collectContextBudgetMeasurement({ now: new Date("2026-08-03T11:17:46Z") }),
    { now: new Date("2026-08-03T11:17:46Z") },
  )
  assert.deepEqual(report.violations, [])
})

test("owner ceiling has no exception path", () => {
  const { policy, measurement } = fixture()
  measurement.componentReview.entries[0].bytes = 90
  measurement.componentReview.totalBytes = 110
  policy.exceptions.push({
    id: "temporary-total-growth",
    metric: "postRoutingBytes",
    allowedBytes: 110,
    owner: "frontend-platform",
    reason: "Test attempted ceiling waiver.",
    expires: "2026-08-31",
  })
  const report = evaluateContextBudget(policy, measurement, { now: new Date("2026-08-03T00:00:00Z") })
  assert.ok(report.violations.some((item) => item.includes("cannot exceed the non-waivable owner ceiling")))
  assert.ok(report.violations.some((item) => item.includes("non-waivable ceiling is 100")))
})

test("an exact active exception may raise a ratchet below the ceiling", () => {
  const { policy, measurement } = fixture()
  measurement.componentReview.entries[0].bytes = 50
  measurement.componentReview.totalBytes = 70
  policy.exceptions.push({
    id: "temporary-total-growth",
    metric: "postRoutingBytes",
    allowedBytes: 70,
    owner: "frontend-platform",
    reason: "Exercise the bounded ratchet exception.",
    expires: "2026-08-31",
  })
  const report = evaluateContextBudget(policy, measurement, { now: new Date("2026-08-03T00:00:00Z") })
  assert.deepEqual(report.violations, [])
})

test("bucket membership cannot drift silently", () => {
  const { policy, measurement } = fixture()
  measurement.componentReview.entries.push({ path: "unclassified", bytes: 1 })
  measurement.componentReview.totalBytes += 1
  const report = evaluateContextBudget(policy, measurement, { now: new Date("2026-08-03T00:00:00Z") })
  assert.ok(report.violations.some((item) => item.includes("is not in postRoutingEntries")))
})

test("expired exceptions fail even when the current measurement is below the base ratchet", () => {
  const { policy, measurement } = fixture()
  policy.exceptions.push({
    id: "expired-growth",
    metric: "alwaysLoadedBytes",
    allowedBytes: 12,
    owner: "frontend-platform",
    reason: "Exercise expiry enforcement.",
    expires: "2026-08-02",
  })
  const report = evaluateContextBudget(policy, measurement, { now: new Date("2026-08-03T00:00:00Z") })
  assert.ok(report.violations.some((item) => item.includes("expired on 2026-08-02")))
})
