import crypto from "node:crypto"
import { execFileSync } from "node:child_process"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"

function processIsAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false
  try {
    process.kill(pid, 0)
    return true
  } catch (cause) {
    return cause?.code === "EPERM"
  }
}

export function defaultMachineLeasePath(repoRoot) {
  const commonDirectory = execFileSync("git", ["rev-parse", "--git-common-dir"], {
    cwd: repoRoot,
    encoding: "utf8",
  }).trim()
  const canonical = path.resolve(repoRoot, commonDirectory)
  const repositoryKey = crypto.createHash("sha256").update(canonical).digest("hex").slice(0, 16)
  return path.join(os.tmpdir(), `usernode-ui-gate-${repositoryKey}.lock`)
}

function readLease(leasePath) {
  try {
    return JSON.parse(fs.readFileSync(leasePath, "utf8"))
  } catch {
    return null
  }
}

export function acquireMachineLease({
  repoRoot,
  owner,
  revision,
  units,
  leasePath = defaultMachineLeasePath(repoRoot),
  pid = process.pid,
  now = new Date(),
  isPidAlive = processIsAlive,
}) {
  const token = crypto.randomUUID()
  const record = {
    schemaVersion: 1,
    token,
    pid,
    owner,
    revision,
    units,
    acquiredAt: now.toISOString(),
  }

  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      const descriptor = fs.openSync(leasePath, "wx", 0o600)
      try {
        fs.writeFileSync(descriptor, `${JSON.stringify(record, null, 2)}\n`)
      } finally {
        fs.closeSync(descriptor)
      }
      return { leasePath, record }
    } catch (cause) {
      if (cause?.code !== "EEXIST") throw cause
      const existing = readLease(leasePath)
      const ageMs = existing ? null : Date.now() - fs.statSync(leasePath).mtimeMs
      if (existing && isPidAlive(existing.pid)) {
        throw new Error(`UI gate machine lease is owned by ${existing.owner || "unknown"} (pid ${existing.pid}) since ${existing.acquiredAt || "unknown"}`)
      }
      if (!existing && ageMs < 30_000) {
        throw new Error("UI gate machine lease exists but is not readable yet")
      }
      fs.unlinkSync(leasePath)
    }
  }
  throw new Error("unable to acquire UI gate machine lease")
}

export function releaseMachineLease(lease) {
  if (!lease?.leasePath || !lease.record?.token) return false
  const existing = readLease(lease.leasePath)
  if (!existing || existing.token !== lease.record.token) return false
  fs.unlinkSync(lease.leasePath)
  return true
}
