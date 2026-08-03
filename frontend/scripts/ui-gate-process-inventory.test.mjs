import assert from "node:assert/strict"
import test from "node:test"

import {
  elapsedTimeMs,
  evaluateGateProcessInventory,
  parseListeningPorts,
  parseProcessTable,
} from "./ui-gate-process-inventory.mjs"

const lifecycle = {
  staleAfterMs: 10_800_000,
  registeredServers: [{
    id: "manual-production-review",
    port: 5175,
    protocol: "https",
    owner: "implementation-lead",
    expectedLifetime: "explicit manual review session",
    allowDuringGate: true,
    commandPattern: "node_modules/\\.bin/vite.*--port 5175",
  }],
}

test("parses BSD elapsed time, process cost, and listening ports", () => {
  assert.equal(elapsedTimeMs("01-08:19:42"), 116_382_000)
  assert.deepEqual(parseProcessTable("lukasimrich 26713 26699 01-08:19:42 3:10.15 0.0 node node_modules/.bin/vite --port 5175\n"), [{
    user: "lukasimrich",
    pid: 26713,
    parentPid: 26699,
    ageMs: 116_382_000,
    cpuTime: "3:10.15",
    cpuPercent: 0,
    command: "node node_modules/.bin/vite --port 5175",
  }])
  assert.deepEqual([...parseListeningPorts("p26713\ncnode\nn127.0.0.1:5175\n").values()], [{
    pid: 26713,
    command: "node",
    ports: [5175],
  }])
})

test("records the old registered HTTPS review server without blocking the gate", () => {
  const result = evaluateGateProcessInventory({
    processOutput: "lukasimrich 26713 26699 01-08:19:42 3:10.15 0.0 node node_modules/.bin/vite --host 127.0.0.1 --port 5175\n",
    listenerOutput: "p26713\ncnode\nn127.0.0.1:5175\n",
    lifecycle,
    reservations: [],
    currentPid: 99,
  })
  assert.equal(result.status, "passed")
  assert.deepEqual(result.observations[0].ports, [5175])
  assert.equal(result.observations[0].protocol, "https")
  assert.equal(result.observations[0].logicalOwner, "implementation-lead")
  assert.equal(result.violations.length, 0)
})

test("blocks stale unowned test and Storybook processes", () => {
  const result = evaluateGateProcessInventory({
    processOutput: [
      "lukasimrich 6715 1 08:42:00 521:00.00 100.0 node --test --test-timeout=0 scripts/interface-law-tools.test.mjs",
      "lukasimrich 26925 1 01-07:00:00 1865:00.00 100.5 node node_modules/.bin/storybook dev -p 6007",
    ].join("\n"),
    listenerOutput: "p26925\ncnode\nn127.0.0.1:6007\n",
    lifecycle,
    reservations: [],
    currentPid: 99,
  })
  assert.equal(result.status, "failed")
  assert.deepEqual(result.violations.map(({ reason }) => reason), [
    "stale-unowned-process",
    "stale-unowned-process",
  ])
  assert.equal(result.observations[0].cpuPercent, 100)
  assert.equal(result.observations[1].cpuTime, "1865:00.00")
})

test("blocks even a recent process when it occupies a reserved gate port", () => {
  const result = evaluateGateProcessInventory({
    processOutput: "lukasimrich 7000 1 00:02 0:00.01 0.0 node node_modules/.bin/vite --port 4298\n",
    listenerOutput: "p7000\ncnode\nn127.0.0.1:4298\n",
    lifecycle,
    reservations: [{ port: 4298, protocol: "http", name: "browser", stageId: "browser-matrix", owner: "gate" }],
    currentPid: 99,
  })
  assert.equal(result.status, "failed")
  assert.equal(result.violations[0].reason, "reserved-port-in-use")
  assert.match(result.violations[0].message, /http port 4298/)
})

test("blocks a reserved listener that appears after the process snapshot", () => {
  const result = evaluateGateProcessInventory({
    processOutput: "",
    listenerOutput: "p7001\ncnode\nn127.0.0.1:4298\n",
    lifecycle,
    reservations: [{ port: 4298, protocol: "http", name: "browser", stageId: "browser-matrix", owner: "gate" }],
    currentPid: 99,
  })
  assert.equal(result.status, "failed")
  assert.equal(result.violations[0].reason, "reserved-port-in-use")
  assert.equal(result.violations[0].pid, 7001)
})
