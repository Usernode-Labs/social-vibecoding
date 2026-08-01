import assert from "node:assert/strict"
import test from "node:test"

import {
  gateMachineUnits,
  resolveGateGraph,
  runGateSchedule,
} from "./ui-gate-scheduler.mjs"

const gates = [
  { command: "root" },
  { command: "matrix" },
  { command: "build" },
  { command: "service-worker" },
]
const graph = {
  stages: [
    { id: "root", step: 1, units: 1, priority: 90 },
    { id: "matrix", step: 2, units: 8, priority: 100 },
    { id: "build", step: 3, units: 2, priority: 80 },
    { id: "service-worker", step: 4, units: 2, priority: 70, dependsOn: ["build"] },
  ],
}

test("validates a complete acyclic gate graph and machine budget", () => {
  assert.equal(gateMachineUnits({ default: 16, overrideEnv: "UI_GATE_MACHINE_UNITS" }, {}, 8), 16)
  assert.equal(gateMachineUnits({ default: 16, overrideEnv: "UI_GATE_MACHINE_UNITS" }, { UI_GATE_MACHINE_UNITS: "12" }, 8), 12)
  assert.deepEqual(resolveGateGraph(gates, graph, 16).map(({ id }) => id), [
    "root", "matrix", "build", "service-worker",
  ])
  assert.throws(() => resolveGateGraph(gates, {
    stages: graph.stages.map((stage) => stage.id === "build" ? { ...stage, dependsOn: ["service-worker"] } : stage),
  }, 16), /dependency cycle/)
})

test("runs ready stages within one budget and waits for dependencies", async () => {
  const stages = resolveGateGraph(gates, graph, 10)
  const events = []
  const delays = { root: 12, matrix: 18, build: 4, "service-worker": 1 }
  const result = await runGateSchedule({
    stages,
    mode: "parallel",
    machineUnits: 10,
    onStageStart: (stage, used) => events.push(`start:${stage.id}:${used}`),
    runStage: async (stage) => {
      await new Promise((resolve) => setTimeout(resolve, delays[stage.id]))
      events.push(`end:${stage.id}`)
      return { code: 0 }
    },
  })
  assert.equal(result.failures.length, 0)
  assert.equal(result.maxUnitsObserved, 10)
  assert.ok(events.indexOf("end:build") < events.findIndex((event) => event.startsWith("start:service-worker:")))
})

test("serial fallback preserves step order", async () => {
  const order = []
  const result = await runGateSchedule({
    stages: resolveGateGraph(gates, graph, 10),
    mode: "serial",
    machineUnits: 10,
    runStage: async (stage) => {
      order.push(stage.id)
      return { code: 0 }
    },
  })
  assert.deepEqual(order, ["root", "matrix", "build", "service-worker"])
  assert.equal(result.notStarted.length, 0)
})

test("does not launch new work after a parallel failure", async () => {
  const started = []
  const result = await runGateSchedule({
    stages: resolveGateGraph(gates, graph, 9),
    mode: "parallel",
    machineUnits: 9,
    onStageStart: (stage) => started.push(stage.id),
    runStage: async (stage) => ({ code: stage.id === "matrix" ? 1 : 0 }),
  })
  assert.equal(result.failures[0].stage.id, "matrix")
  assert.ok(!started.includes("build"))
  assert.ok(result.notStarted.some(({ id }) => id === "service-worker"))
})
