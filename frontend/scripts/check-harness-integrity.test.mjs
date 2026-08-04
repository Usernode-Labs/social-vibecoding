import assert from "node:assert/strict"
import { spawnSync } from "node:child_process"
import fs from "node:fs"
import path from "node:path"
import test from "node:test"

import { wildcardEphemeralListeners } from "./test-loopback-listeners.mjs"

test("ephemeral test listeners require an explicit loopback host", () => {
  const source = `
    const first = app.listen(0)
    const second = server.listen(0, () => resolve(server))
    const safe = app.listen(0, "127.0.0.1", resolve)
    const quoted = "app.listen(0)"
    // app.listen(0)
  `

  assert.deepEqual(wildcardEphemeralListeners(source, "tests/example.test.js"), [
    { column: 19, file: "tests/example.test.js", line: 2 },
    { column: 20, file: "tests/example.test.js", line: 3 },
  ])
})

test("portable harness structure and continuous-integration parity validate deterministically", () => {
  const run = spawnSync(process.execPath, [
    "scripts/check-harness-integrity.mjs",
  ], { cwd: process.cwd(), encoding: "utf8" })
  assert.equal(run.status, 0, `${run.stdout}\n${run.stderr}`)
})

test("pull-request checks stamp the real branch head instead of the synthetic merge", () => {
  const ci = fs.readFileSync(
    path.resolve(process.cwd(), "..", ".github", "workflows", "frontend-checks.yml"),
    "utf8",
  )
  const pullRequestHeadRevision = "${{ github.event.pull_request.head.sha || github.sha }}"

  for (const revisionEvidence of [
    `ref: ${pullRequestHeadRevision}`,
    `name: harness-fitness-${pullRequestHeadRevision}`,
    `SV_REACT_SHELL_REVISION: ${pullRequestHeadRevision}`,
    `SOURCE_SHA: ${pullRequestHeadRevision}`,
    `name: react-shell-${pullRequestHeadRevision}`,
  ]) {
    assert.ok(ci.includes(revisionEvidence), `missing revision evidence: ${revisionEvidence}`)
  }
  assert.doesNotMatch(ci, /\${{\s*github\.sha\s*}}/)
})
