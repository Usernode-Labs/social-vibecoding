import { execFileSync } from "node:child_process"

import { resolveGateResources } from "./ui-gate-telemetry.mjs"

const SUSPICIOUS_COMMANDS = [
  ["vite", /(?:node_modules\/(?:\.bin\/)?vite|\bvite\s+--)/i],
  ["storybook", /(?:node_modules\/(?:\.bin\/)?storybook|\bstorybook\s+(?:dev|build))/i],
  ["node-test", /\bnode\b.*(?:\s--test(?:\s|$)|node:test)/i],
  ["playwright", /(?:node_modules\/(?:\.bin\/)?playwright|\bplaywright\s+test\b|ms-playwright)/i],
]

export function elapsedTimeMs(value) {
  const match = String(value).trim().match(/^(?:(\d+)-)?(?:(\d+):)?(\d+):(\d+)$/)
  if (!match) return null
  const [, days = "0", hours = "0", minutes, seconds] = match
  return (((Number(days) * 24 + Number(hours)) * 60 + Number(minutes)) * 60 + Number(seconds)) * 1_000
}

export function parseProcessTable(output) {
  return String(output).split("\n").flatMap((line) => {
    const match = line.trim().match(/^(\S+)\s+(\d+)\s+(\d+)\s+(\S+)\s+(\S+)\s+([\d.]+)\s+(.*)$/)
    if (!match) return []
    const [, user, pid, parentPid, elapsed, cpuTime, cpuPercent, command] = match
    return [{
      user,
      pid: Number(pid),
      parentPid: Number(parentPid),
      ageMs: elapsedTimeMs(elapsed),
      cpuTime,
      cpuPercent: Number(cpuPercent),
      command,
    }]
  })
}

export function parseListeningPorts(output) {
  const listeners = new Map()
  let pid = null
  let command = null
  for (const line of String(output).split("\n")) {
    const field = line[0]
    const value = line.slice(1)
    if (field === "p") {
      pid = Number(value)
      command = null
    } else if (field === "c") {
      command = value
    } else if (field === "n" && Number.isInteger(pid)) {
      const port = Number(value.match(/:(\d+)$/)?.[1])
      if (!Number.isInteger(port)) continue
      const existing = listeners.get(pid) || { pid, command, ports: [] }
      existing.command ||= command
      if (!existing.ports.includes(port)) existing.ports.push(port)
      listeners.set(pid, existing)
    }
  }
  return listeners
}

export function gatePortReservations(graph, environment, owner, mode) {
  return graph.flatMap((stage) => {
    const resources = resolveGateResources(stage.gate.resources, environment, owner, mode)
    return resources.ports.flatMap((port) => Number.isInteger(port.effective) ? [{
      port: port.effective,
      protocol: port.protocol || "tcp",
      name: port.name,
      stageId: stage.id,
      owner,
    }] : [])
  })
}

function commandKind(command) {
  return SUSPICIOUS_COMMANDS.find(([, pattern]) => pattern.test(command))?.[0] || null
}

function registeredServerFor(processRecord, ports, servers) {
  return servers.find((server) => ports.includes(server.port)
    && new RegExp(server.commandPattern, "i").test(processRecord.command)) || null
}

export function evaluateGateProcessInventory({
  processOutput,
  listenerOutput,
  lifecycle,
  reservations,
  currentPid = process.pid,
}) {
  const processes = parseProcessTable(processOutput)
  const listeners = parseListeningPorts(listenerOutput)
  const registeredServers = lifecycle.registeredServers || []
  const observations = []
  const violations = []
  const reportedReservedListeners = new Set()

  for (const processRecord of processes) {
    if (processRecord.pid === currentPid) continue
    const ports = listeners.get(processRecord.pid)?.ports || []
    const reserved = reservations.filter((reservation) => ports.includes(reservation.port))
    const registration = registeredServerFor(processRecord, ports, registeredServers)
    const kind = commandKind(processRecord.command)
    const relevant = kind || reserved.length || registration
    if (!relevant) continue

    const observation = {
      ...processRecord,
      ports,
      kind: kind || "listener",
      logicalOwner: registration?.owner || "unregistered",
      protocol: registration?.protocol || reserved[0]?.protocol || "tcp",
      expectedLifetime: registration?.expectedLifetime || null,
      registeredServer: registration?.id || null,
    }
    observations.push(observation)

    for (const reservation of reserved) {
      reportedReservedListeners.add(`${processRecord.pid}:${reservation.port}`)
      violations.push({
        reason: "reserved-port-in-use",
        pid: processRecord.pid,
        port: reservation.port,
        stageId: reservation.stageId,
        message: `${reservation.protocol} port ${reservation.port} for ${reservation.stageId} is already owned by pid ${processRecord.pid}`,
      })
    }

    if (registration && !registration.allowDuringGate) {
      violations.push({
        reason: "registered-server-not-allowed",
        pid: processRecord.pid,
        port: registration.port,
        message: `${registration.id} is not allowed during the canonical UI gate`,
      })
    } else if (kind && processRecord.ageMs >= lifecycle.staleAfterMs && !registration) {
      violations.push({
        reason: "stale-unowned-process",
        pid: processRecord.pid,
        kind,
        ageMs: processRecord.ageMs,
        message: `unregistered ${kind} process ${processRecord.pid} is older than ${lifecycle.staleAfterMs}ms`,
      })
    }
  }

  for (const listener of listeners.values()) {
    for (const reservation of reservations.filter(({ port }) => listener.ports.includes(port))) {
      const key = `${listener.pid}:${reservation.port}`
      if (reportedReservedListeners.has(key)) continue
      violations.push({
        reason: "reserved-port-in-use",
        pid: listener.pid,
        port: reservation.port,
        stageId: reservation.stageId,
        message: `${reservation.protocol} port ${reservation.port} for ${reservation.stageId} is already owned by pid ${listener.pid}`,
      })
    }
  }

  for (const server of registeredServers) {
    const listener = [...listeners.values()].find(({ ports }) => ports.includes(server.port))
    if (!listener) continue
    const processRecord = processes.find(({ pid }) => pid === listener.pid)
    if (!processRecord || !new RegExp(server.commandPattern, "i").test(processRecord.command)) {
      violations.push({
        reason: "registered-port-owner-mismatch",
        pid: listener.pid,
        port: server.port,
        message: `${server.protocol} port ${server.port} is not running the registered ${server.id} command`,
      })
    }
  }

  return {
    status: violations.length ? "failed" : "passed",
    staleAfterMs: lifecycle.staleAfterMs,
    reservations,
    registeredServers,
    observations,
    violations,
  }
}

function executeInventoryCommand(command, args) {
  try {
    return execFileSync(command, args, { encoding: "utf8", maxBuffer: 5_000_000 })
  } catch (cause) {
    if (command === "lsof" && cause?.status === 1) return String(cause.stdout || "")
    throw cause
  }
}

export function inspectGateProcesses({ lifecycle, reservations, execute = executeInventoryCommand }) {
  const processOutput = execute("ps", ["-axo", "user=,pid=,ppid=,etime=,time=,%cpu=,command="])
  const listenerOutput = execute("lsof", ["-nP", "-iTCP", "-sTCP:LISTEN", "-Fpcn"])
  return evaluateGateProcessInventory({ processOutput, listenerOutput, lifecycle, reservations })
}
