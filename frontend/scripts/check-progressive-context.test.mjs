import assert from "node:assert/strict"
import test from "node:test"

import {
  collectProgressiveContext,
  evaluateProgressiveContext,
} from "./check-progressive-context.mjs"

test("component review discovers representative patterns, primitives, and sub-exports without bulk loading", () => {
  const report = collectProgressiveContext()
  assert.deepEqual(evaluateProgressiveContext(report), [])
  assert.deepEqual(report.discoveryCases.map((item) => item.target.id), [
    "home-app-shortcut",
    "primitive-toggle-group",
    "status-dot",
    "primitive-card",
  ])
  const toggleGroup = report.discoveryCases.find((item) => item.fixture.exportName === "ToggleGroupItem")
  assert.ok(toggleGroup.target.exports.includes("ToggleGroupItem"))
  assert.ok(report.discoveryCases.every((item) => item.target.source.bytes > 0 && item.target.story.bytes > 0))
})

test("discovery battery fails when the target story disappears", () => {
  const report = collectProgressiveContext()
  report.discoveryCases[2].target.story = null
  assert.ok(evaluateProgressiveContext(report).some((item) => item.includes("target story")))
})

test("discovery battery fails when a named sub-export disappears", () => {
  const report = collectProgressiveContext()
  report.discoveryCases[1].target.exports = ["ToggleGroup"]
  assert.ok(evaluateProgressiveContext(report).some((item) => item.includes("ToggleGroupItem")))
})
