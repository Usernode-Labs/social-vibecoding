import assert from "node:assert/strict"
import test from "node:test"

import {
  collectProgressiveContext,
  evaluateProgressiveContext,
} from "./check-progressive-context.mjs"

test("component review discovers one catalog entry and its target files without bulk loading", () => {
  const report = collectProgressiveContext()
  assert.deepEqual(evaluateProgressiveContext(report), [])
  assert.equal(report.target.id, "home-app-shortcut")
  assert.ok(report.target.source.bytes > 0)
  assert.ok(report.target.story.bytes > 0)
})

test("discovery battery fails when the target story disappears", () => {
  const report = collectProgressiveContext()
  report.target.story = null
  assert.ok(evaluateProgressiveContext(report).some((item) => item.includes("target story")))
})
