import assert from "node:assert/strict"
import { spawnSync } from "node:child_process"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import test from "node:test"

import {
  assertPublishableHistory,
  finalizeSlice,
  parseFinalizeArguments,
  wipCommitsInPublishRange,
} from "./slice-boundary.mjs"

const identity = { name: "Slice Tester", email: "slice@example.invalid" }
const originEvent = "a".repeat(64)

function git(repoRoot, args) {
  const run = spawnSync("git", args, { cwd: repoRoot, encoding: "utf8" })
  assert.equal(run.status, 0, `${run.stdout}\n${run.stderr}`)
  return run.stdout.trim()
}

function checkpoint(repoRoot, subject, body, task = "harness-slice-a") {
  git(repoRoot, [
    "commit",
    "--allow-empty",
    "-m", subject,
    "-m", body,
    "--trailer", `Task: ${task}`,
    "--trailer", `Co-authored-by: ${identity.name} <${identity.email}>`,
    "--trailer", `Signed-off-by: ${identity.name} <${identity.email}>`,
  ])
}

function fixture() {
  const repoRoot = fs.mkdtempSync(path.join(os.tmpdir(), "slice-boundary-"))
  git(repoRoot, ["init", "-b", "main"])
  git(repoRoot, ["config", "user.name", identity.name])
  git(repoRoot, ["config", "user.email", identity.email])
  git(repoRoot, ["commit", "--allow-empty", "-m", "base"])
  const base = git(repoRoot, ["rev-parse", "HEAD"])
  checkpoint(repoRoot, "wip(harness-slice-a): first checkpoint", "First checkpoint body.")
  checkpoint(repoRoot, "wip(harness-slice-a): second checkpoint", "Second checkpoint body.")
  return { repoRoot, base }
}

test("finalizes checkpoint messages oldest-first with a recovery reference", () => {
  const { repoRoot, base } = fixture()
  const before = git(repoRoot, ["rev-parse", "HEAD"])
  const result = finalizeSlice({
    repoRoot,
    base,
    slice: "harness-slice-a",
    subject: "Make slice boundaries auditable",
    originEvent,
    now: new Date("2026-08-01T10:00:00.000Z"),
  })

  assert.equal(result.oldHead, before)
  assert.equal(git(repoRoot, ["rev-parse", `${result.recoveryRef}^{commit}`]), before)
  assert.equal(git(repoRoot, ["rev-parse", "HEAD^"]), base)
  assert.equal(git(repoRoot, ["status", "--porcelain=v1"]), "")
  assert.equal(wipCommitsInPublishRange(repoRoot, { SLICE_PUBLISH_BASE: base }).length, 0)

  const message = git(repoRoot, ["show", "--no-patch", "--format=%B", "HEAD"])
  const first = message.indexOf("wip(harness-slice-a): first checkpoint")
  const second = message.indexOf("wip(harness-slice-a): second checkpoint")
  assert.ok(first >= 0 && second > first, message)
  assert.match(message, /First checkpoint body\./)
  assert.match(message, /Second checkpoint body\./)
  assert.match(message, new RegExp(`Origin-Buzz-Event: ${originEvent}`))
  assert.match(message, /Task: harness-slice-a/)
  assert.ok(message.endsWith(`Signed-off-by: ${identity.name} <${identity.email}>`))
  const trailers = git(repoRoot, ["log", "-1", "--format=%(trailers:key=Task,key=Origin-Buzz-Event)"])
  assert.match(trailers, /Task: harness-slice-a/)
  assert.match(trailers, new RegExp(`Origin-Buzz-Event: ${originEvent}`))
})

test("detects private checkpoints in the publish range", () => {
  const { repoRoot, base } = fixture()
  const environment = { SLICE_PUBLISH_BASE: base }
  assert.equal(wipCommitsInPublishRange(repoRoot, environment).length, 2)
  assert.throws(() => assertPublishableHistory(repoRoot, environment), /private checkpoint commits/)

  const malformed = fs.mkdtempSync(path.join(os.tmpdir(), "slice-boundary-malformed-"))
  git(malformed, ["init", "-b", "main"])
  git(malformed, ["config", "user.name", identity.name])
  git(malformed, ["config", "user.email", identity.email])
  git(malformed, ["commit", "--allow-empty", "-m", "base"])
  const malformedBase = git(malformed, ["rev-parse", "HEAD"])
  git(malformed, ["commit", "--allow-empty", "-m", "wip(bad)"])
  assert.equal(wipCommitsInPublishRange(malformed, { SLICE_PUBLISH_BASE: malformedBase }).length, 1)
})

test("refuses a dirty tree or a checkpoint from another slice", () => {
  const dirty = fixture()
  fs.writeFileSync(path.join(dirty.repoRoot, "dirty.txt"), "dirty\n")
  assert.throws(() => finalizeSlice({
    repoRoot: dirty.repoRoot,
    base: dirty.base,
    slice: "harness-slice-a",
    subject: "Make slice boundaries auditable",
    originEvent,
  }), /clean working tree/)

  const wrong = fixture()
  checkpoint(wrong.repoRoot, "wip(other-slice): wrong checkpoint", "Wrong slice body.", "other-slice")
  assert.throws(() => finalizeSlice({
    repoRoot: wrong.repoRoot,
    base: wrong.base,
    slice: "harness-slice-a",
    subject: "Make slice boundaries auditable",
    originEvent,
  }), /must start with wip\(harness-slice-a\):/)

  const wrongTask = fixture()
  checkpoint(wrongTask.repoRoot, "wip(harness-slice-a): wrong task", "Wrong task body.", "other-slice")
  assert.throws(() => finalizeSlice({
    repoRoot: wrongTask.repoRoot,
    base: wrongTask.base,
    slice: "harness-slice-a",
    subject: "Make slice boundaries auditable",
    originEvent,
  }), /needs final Task: harness-slice-a/)

  const escaped = fixture()
  checkpoint(escaped.repoRoot, "wip(harness-slice-a): escaped body", "First line.\\n\\nSecond line.")
  assert.throws(() => finalizeSlice({
    repoRoot: escaped.repoRoot,
    base: escaped.base,
    slice: "harness-slice-a",
    subject: "Make slice boundaries auditable",
    originEvent,
  }), /literal \\n\\n text/)
})

test("parses a complete finalizer command", () => {
  assert.deepEqual(parseFinalizeArguments([
    "--base", "HEAD~2",
    "--slice", "harness-slice-a",
    "--subject", "Make slice boundaries auditable",
    "--origin-event", originEvent,
    "--dry-run",
  ]), {
    base: "HEAD~2",
    slice: "harness-slice-a",
    subject: "Make slice boundaries auditable",
    originEvent,
    dryRun: true,
  })
  assert.throws(() => parseFinalizeArguments(["--base", "HEAD"]), /--slice is required/)
})
