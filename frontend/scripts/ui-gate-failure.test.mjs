import assert from "node:assert/strict"
import test from "node:test"

import { classifyGateFailure } from "./ui-gate-failure.mjs"

test("classifies known local infrastructure failures from output", () => {
  assert.deepEqual(classifyGateFailure({
    gate: { kind: "test" },
    stdout: "Error: Timed out waiting 60000ms from config.webServer.",
  }), {
    class: "environment",
    reason: "web-server-timeout",
    source: "output-signature",
  })
  assert.equal(classifyGateFailure({
    gate: { kind: "test" },
    stderr: "listen EADDRINUSE: address already in use 127.0.0.1:4298",
  }).class, "environment")
})

test("falls back to the stage kind without pretending to diagnose product cause", () => {
  assert.deepEqual(classifyGateFailure({ gate: { kind: "test" } }), {
    class: "test",
    reason: "test-command-exit",
    source: "stage-kind",
  })
  assert.equal(classifyGateFailure({ gate: { kind: "build" } }).class, "build")
  assert.equal(classifyGateFailure({ gate: {} }).class, "check")
})

test("preserves an explicit operator classification", () => {
  assert.deepEqual(classifyGateFailure({
    gate: { kind: "test" },
    stdout: "Timed out waiting 60000ms from config.webServer.",
    override: "known-test-race",
  }), {
    class: "known-test-race",
    reason: "operator-override",
    source: "operator",
  })
})
