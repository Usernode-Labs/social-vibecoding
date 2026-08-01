function graphCycle(stagesById) {
  const visiting = new Set()
  const visited = new Set()

  function visit(id, path = []) {
    if (visiting.has(id)) return [...path, id]
    if (visited.has(id)) return null
    visiting.add(id)
    const stage = stagesById.get(id)
    for (const dependency of stage.dependsOn) {
      const cycle = visit(dependency, [...path, id])
      if (cycle) return cycle
    }
    visiting.delete(id)
    visited.add(id)
    return null
  }

  for (const id of stagesById.keys()) {
    const cycle = visit(id)
    if (cycle) return cycle
  }
  return null
}

export function gateMachineUnits(machineAuthority, environment = process.env, availableParallelism = 1) {
  const override = machineAuthority?.overrideEnv ? environment[machineAuthority.overrideEnv] : null
  const value = override ? Number(override) : machineAuthority?.default || availableParallelism
  if (!Number.isInteger(value) || value < 1) {
    throw new Error("UI gate machine units must be a positive integer")
  }
  return value
}

export function resolveGateGraph(gates, graph, machineUnits) {
  if (!graph || !Array.isArray(graph.stages)) throw new Error("gateGraph.stages must be an array")
  if (graph.stages.length !== gates.length) {
    throw new Error(`gateGraph must describe all ${gates.length} full-gate stages`)
  }

  const byStep = new Map()
  const byId = new Map()
  for (const stage of graph.stages) {
    if (!Number.isInteger(stage.step) || stage.step < 1 || stage.step > gates.length) {
      throw new Error(`gateGraph stage has invalid step: ${stage.step}`)
    }
    if (byStep.has(stage.step)) throw new Error(`gateGraph duplicates step ${stage.step}`)
    if (!/^[a-z0-9][a-z0-9-]*$/.test(stage.id || "")) {
      throw new Error(`gateGraph step ${stage.step} has an invalid id`)
    }
    if (byId.has(stage.id)) throw new Error(`gateGraph duplicates id ${stage.id}`)
    if (!Number.isInteger(stage.units) || stage.units < 1 || stage.units > machineUnits) {
      throw new Error(`gateGraph stage ${stage.id} has invalid machine units`)
    }
    const normalized = {
      ...stage,
      dependsOn: stage.dependsOn || [],
      priority: stage.priority || 0,
      gate: gates[stage.step - 1],
    }
    byStep.set(stage.step, normalized)
    byId.set(stage.id, normalized)
  }

  for (const stage of byId.values()) {
    for (const dependency of stage.dependsOn) {
      if (!byId.has(dependency)) throw new Error(`gateGraph stage ${stage.id} depends on unknown ${dependency}`)
      if (dependency === stage.id) throw new Error(`gateGraph stage ${stage.id} depends on itself`)
    }
  }
  const cycle = graphCycle(byId)
  if (cycle) throw new Error(`gateGraph contains a dependency cycle: ${cycle.join(" -> ")}`)

  return [...byStep.values()].sort((left, right) => left.step - right.step)
}

export async function runGateSchedule({
  stages,
  mode,
  machineUnits,
  satisfiedIds = [],
  runStage,
  onStageStart = () => {},
}) {
  if (!["serial", "parallel"].includes(mode)) throw new Error(`unknown UI gate mode: ${mode}`)
  const completed = new Set(satisfiedIds)
  const results = []
  const failures = []
  let maxUnitsObserved = 0

  if (mode === "serial") {
    for (const stage of [...stages].sort((left, right) => left.step - right.step)) {
      const missing = stage.dependsOn.filter((dependency) => !completed.has(dependency))
      if (missing.length) throw new Error(`serial gate stage ${stage.id} is missing dependencies: ${missing.join(", ")}`)
      onStageStart(stage, stage.units)
      maxUnitsObserved = Math.max(maxUnitsObserved, stage.units)
      const result = await runStage(stage)
      results.push({ stage, result })
      if (result.code !== 0) {
        failures.push({ stage, result })
        break
      }
      completed.add(stage.id)
    }
    const started = new Set(results.map(({ stage }) => stage.id))
    return {
      results,
      failures,
      notStarted: stages.filter((stage) => !started.has(stage.id)),
      maxUnitsObserved,
    }
  }

  const pending = new Map(stages.map((stage) => [stage.id, stage]))
  const running = new Map()
  let usedUnits = 0
  let stopLaunching = false

  function readyStages() {
    return [...pending.values()]
      .filter((stage) => stage.dependsOn.every((dependency) => completed.has(dependency)))
      .sort((left, right) => right.priority - left.priority || left.step - right.step)
  }

  function launchReady() {
    if (stopLaunching) return
    for (const stage of readyStages()) {
      if (stage.units > machineUnits - usedUnits) continue
      pending.delete(stage.id)
      usedUnits += stage.units
      maxUnitsObserved = Math.max(maxUnitsObserved, usedUnits)
      onStageStart(stage, usedUnits)
      const promise = Promise.resolve()
        .then(() => runStage(stage))
        .catch((cause) => ({ code: 1, schedulerError: cause instanceof Error ? cause.message : String(cause) }))
        .then((result) => ({ stage, result }))
      running.set(stage.id, { stage, promise })
    }
  }

  while (pending.size || running.size) {
    launchReady()
    if (!running.size) {
      if (stopLaunching) break
      const blocked = [...pending.values()].map(({ id }) => id).join(", ")
      throw new Error(`UI gate scheduler cannot launch remaining stages: ${blocked}`)
    }
    const completion = await Promise.race([...running.values()].map(({ promise }) => promise))
    running.delete(completion.stage.id)
    usedUnits -= completion.stage.units
    results.push(completion)
    if (completion.result.code === 0) {
      completed.add(completion.stage.id)
    } else {
      failures.push(completion)
      stopLaunching = true
    }
  }

  return {
    results,
    failures,
    notStarted: [...pending.values()],
    maxUnitsObserved,
  }
}
