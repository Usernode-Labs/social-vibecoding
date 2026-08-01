import { execFileSync } from "node:child_process"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"

export function gitSnapshot(repoRoot) {
  return {
    revision: execFileSync("git", ["rev-parse", "HEAD"], {
      cwd: repoRoot,
      encoding: "utf8",
    }).trim(),
    dirty: Boolean(execFileSync("git", ["status", "--porcelain=v1"], {
      cwd: repoRoot,
      encoding: "utf8",
    }).trim()),
  }
}

export function observedWorkers(output) {
  const matches = [...output.matchAll(/Running\s+[\d,]+\s+tests?\s+using\s+(\d+)\s+workers?/gi)]
  return matches.length ? Number(matches.at(-1)[1]) : null
}

export function resolveGateResources(resources = {}, environment = process.env, owner = "canonical-ui-gate") {
  const ports = (resources.ports || []).map((port) => {
    if (port.allocation === "dynamic") return { name: port.name, effective: "dynamic" }
    const override = port.overrideEnv ? environment[port.overrideEnv] : null
    const effective = override ? Number(override) : port.default
    return {
      name: port.name,
      effective,
      source: override ? port.overrideEnv : "authority-default",
    }
  })
  return {
    owner,
    ports,
    workers: resources.workers ? { requested: resources.workers, observed: null } : null,
  }
}

export function defaultGateArtifactPath(frontendRoot, startedAt, revision) {
  const timestamp = startedAt.toISOString().replace(/[:.]/g, "-")
  return path.join(frontendRoot, ".artifacts", "ui-gate", `${timestamp}-${revision.slice(0, 12)}.json`)
}

export function writeGateArtifact({ frontendRoot, artifact, outputPath = process.env.UI_GATE_OUTPUT }) {
  const resolved = outputPath
    ? path.resolve(frontendRoot, outputPath)
    : defaultGateArtifactPath(frontendRoot, new Date(artifact.startedAt), artifact.source.start.revision)
  fs.mkdirSync(path.dirname(resolved), { recursive: true })
  fs.writeFileSync(resolved, `${JSON.stringify(artifact, null, 2)}\n`)
  return resolved
}

export function machineSnapshot() {
  return {
    availableParallelism: os.availableParallelism(),
    totalMemoryBytes: os.totalmem(),
    platform: process.platform,
    architecture: process.arch,
  }
}
