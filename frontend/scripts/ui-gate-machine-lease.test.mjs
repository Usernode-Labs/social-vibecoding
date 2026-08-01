import assert from "node:assert/strict"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import test from "node:test"

import { acquireMachineLease, releaseMachineLease } from "./ui-gate-machine-lease.mjs"

function leaseFixture() {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "ui-gate-lease-"))
  return path.join(directory, "gate.lock")
}

test("owns and releases one machine lease", () => {
  const leasePath = leaseFixture()
  const lease = acquireMachineLease({
    repoRoot: process.cwd(),
    owner: "lead-codex",
    revision: "a".repeat(40),
    units: 16,
    leasePath,
  })
  assert.equal(JSON.parse(fs.readFileSync(leasePath, "utf8")).owner, "lead-codex")
  assert.throws(() => acquireMachineLease({
    repoRoot: process.cwd(),
    owner: "lead-claude",
    revision: "a".repeat(40),
    units: 16,
    leasePath,
  }), /owned by lead-codex/)
  assert.equal(releaseMachineLease(lease), true)
  assert.equal(fs.existsSync(leasePath), false)
})

test("reclaims a lease whose process is gone", () => {
  const leasePath = leaseFixture()
  fs.writeFileSync(leasePath, JSON.stringify({
    token: "stale",
    pid: 999_999,
    owner: "gone",
    acquiredAt: "2026-07-31T00:00:00.000Z",
  }))
  const lease = acquireMachineLease({
    repoRoot: process.cwd(),
    owner: "lead-codex",
    revision: "b".repeat(40),
    units: 12,
    leasePath,
    isPidAlive: () => false,
  })
  assert.equal(lease.record.owner, "lead-codex")
  assert.equal(releaseMachineLease(lease), true)
})

test("does not release a lease replaced by another owner", () => {
  const leasePath = leaseFixture()
  const lease = acquireMachineLease({
    repoRoot: process.cwd(),
    owner: "lead-codex",
    revision: "c".repeat(40),
    units: 8,
    leasePath,
  })
  fs.writeFileSync(leasePath, JSON.stringify({ token: "replacement" }))
  assert.equal(releaseMachineLease(lease), false)
  assert.equal(fs.existsSync(leasePath), true)
})
