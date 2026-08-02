const assert = require("node:assert/strict")
const fs = require("node:fs")
const os = require("node:os")
const path = require("node:path")
const { spawnSync } = require("node:child_process")
const test = require("node:test")

const repoRoot = path.resolve(__dirname, "..")
const hook = path.join(repoRoot, ".githooks", "commit-msg")

test("is executable as the configured Git hook", () => {
  assert.notEqual(fs.statSync(hook).mode & 0o111, 0)
})

function checkMessage(message) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "commit-message-hook-"))
  const messageFile = path.join(directory, "COMMIT_EDITMSG")
  fs.writeFileSync(messageFile, message)
  const run = spawnSync("sh", [hook, messageFile], {
    cwd: repoRoot,
    encoding: "utf8",
  })
  fs.rmSync(directory, { force: true, recursive: true })
  return run
}

test("accepts free prose followed by a final Task trailer block", () => {
  const run = checkMessage(`Keep commits readable

Explain the durable outcome and why it matters.

Task: commit-grammar
Plan-Step: tooling-commit-grammar
Signed-off-by: Slice Tester <slice@example.invalid>
`)

  assert.equal(run.status, 0, run.stderr)
})

test("rejects a subject longer than 72 characters", () => {
  const run = checkMessage(`${"x".repeat(73)}

Task: commit-grammar
`)

  assert.equal(run.status, 1)
  assert.match(run.stderr, /at most 72 characters/)
})

test("rejects a message without a final trailer block", () => {
  const run = checkMessage(`Keep commits readable

This message ends as prose.
`)

  assert.equal(run.status, 1)
  assert.match(run.stderr, /must end with a parseable trailer block/)
})

test("rejects trailers followed by another prose paragraph", () => {
  const run = checkMessage(`Keep commits readable

Task: commit-grammar

This prose illegally follows the trailer.
`)

  assert.equal(run.status, 1)
  assert.match(run.stderr, /must end with a parseable trailer block/)
})

test("rejects a final trailer block without a non-empty Task", () => {
  const missing = checkMessage(`Keep commits readable

Signed-off-by: Slice Tester <slice@example.invalid>
`)
  const empty = checkMessage(`Keep commits readable

Task:
Signed-off-by: Slice Tester <slice@example.invalid>
`)

  assert.equal(missing.status, 1)
  assert.match(missing.stderr, /non-empty Task/)
  assert.equal(empty.status, 1)
  assert.match(empty.stderr, /non-empty Task/)
})
