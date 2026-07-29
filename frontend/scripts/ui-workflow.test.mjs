import assert from "node:assert/strict"
import { execFileSync } from "node:child_process"
import path from "node:path"
import test from "node:test"

const repoRoot = path.resolve(process.cwd(), "..")

function resolve(task, files = []) {
  return JSON.parse(execFileSync(process.execPath, [
    path.join(repoRoot, "tool/ui-workflow.mjs"),
    "--task", task,
    "--files", files.join(","),
    "--json",
  ], { cwd: repoRoot, encoding: "utf8" }))
}

test("copy-bearing component review composes content, component, and review", () => {
  const result = resolve("Polish Activity feed component copy and add Storybook state")
  for (const workflow of ["content", "component", "review"]) {
    assert.ok(result.classifications.includes(workflow))
  }
  assert.ok(result.checks.includes("npm run check:content"))
  assert.ok(result.checks.includes("npm run check:ui"))
})

test("contract-backed component work composes contract and component", () => {
  const result = resolve("Review a native bridge component before release")
  for (const workflow of ["contract", "component", "review"]) {
    assert.ok(result.classifications.includes(workflow))
  }
})

test("component consolidation resolves its semantic authority", () => {
  const result = resolve("Audit overlapping components and decide whether to consolidate them")
  assert.ok(result.classifications.includes("consolidation"))
  assert.ok(result.context.includes("frontend/design-system/relationships.json"))
})

test("unrelated files do not contaminate a task classification", () => {
  const result = resolve("Change the Apps route", ["docs/dev-chat-plan.md"])
  assert.deepEqual(result.changedFiles, [])
  assert.deepEqual(result.classifications, ["route"])
})
