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

function positiveInteger(value, label) {
  const parsed = Number(value)
  if (!Number.isInteger(parsed) || parsed < 1) throw new Error(`${label} must be a positive integer`)
  return parsed
}

export function resolveGateResources(
  resources = {},
  environment = process.env,
  owner = "canonical-ui-gate",
  mode = "serial",
) {
  const ports = (resources.ports || []).map((port) => {
    if (port.allocation === "dynamic") return { name: port.name, effective: "dynamic", commandEnv: port.commandEnv || null }
    const override = port.overrideEnv ? environment[port.overrideEnv] : null
    const effective = positiveInteger(override || port.default, `${port.name} port`)
    return {
      name: port.name,
      effective,
      source: override ? port.overrideEnv : "authority-default",
      commandEnv: port.commandEnv || null,
    }
  })
  const artifacts = (resources.artifacts || []).map((artifact) => ({
    name: artifact.name,
    effective: artifact.default,
    source: "authority-default",
    commandEnv: artifact.commandEnv || null,
  }))
  let workers = null
  if (resources.workers !== undefined) {
    if (typeof resources.workers === "object") {
      const override = resources.workers.overrideEnv ? environment[resources.workers.overrideEnv] : null
      const requested = override
        ? positiveInteger(override, "UI gate worker override")
        : resources.workers[mode]
      workers = {
        requested,
        observed: null,
        source: override ? resources.workers.overrideEnv : `authority-${mode}`,
        commandEnv: resources.workers.commandEnv || null,
      }
    } else {
      workers = {
        requested: resources.workers,
        observed: null,
        source: "authority-fixed",
        commandEnv: null,
      }
    }
  }
  return {
    owner,
    ports,
    artifacts,
    workers,
  }
}

export function gateResourceEnvironment(resolvedResources) {
  const environment = {}
  for (const port of resolvedResources.ports || []) {
    if (port.commandEnv && Number.isInteger(port.effective)) {
      environment[port.commandEnv] = String(port.effective)
    }
  }
  for (const artifact of resolvedResources.artifacts || []) {
    if (artifact.commandEnv) environment[artifact.commandEnv] = artifact.effective
  }
  const workers = resolvedResources.workers
  if (workers?.commandEnv && Number.isInteger(workers.requested)) {
    environment[workers.commandEnv] = String(workers.requested)
  }
  return environment
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
