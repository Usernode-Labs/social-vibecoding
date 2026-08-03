import fs from "node:fs"
import path from "node:path"
import { fileURLToPath } from "node:url"

import { collectHarnessFitness, fitnessSnapshot } from "./check-harness-fitness.mjs"

const frontendRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..")
const defaultPolicyPath = path.join(frontendRoot, "design-system/context-budget.json")
const knownMetrics = new Set([
  "payloadBytes",
  "guidanceBytes",
  "alwaysLoadedBytes",
  "skillActivationBytes",
  "postRoutingBytes",
])

function integer(value) {
  return Number.isInteger(value) && value >= 0
}

function endOfDay(value) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value || "")) return null
  const date = new Date(`${value}T23:59:59.999Z`)
  return Number.isNaN(date.getTime()) ? null : date
}

function validatedExceptions(policy, now, violations) {
  const byMetric = new Map()
  if (!Array.isArray(policy.exceptions)) {
    violations.push("context-budget exceptions must be an array")
    return byMetric
  }
  for (const exception of policy.exceptions) {
    if (!knownMetrics.has(exception.metric)) {
      violations.push(`exception ${exception.id || "<missing-id>"} names unknown metric ${exception.metric}`)
      continue
    }
    if (!exception.id || !exception.owner || !exception.reason || !integer(exception.allowedBytes)) {
      violations.push(`exception ${exception.id || "<missing-id>"} must be exact, owned, and justified`)
      continue
    }
    const expiry = endOfDay(exception.expires)
    if (!expiry) {
      violations.push(`exception ${exception.id} has an invalid expiry date`)
      continue
    }
    if (expiry < now) {
      violations.push(`exception ${exception.id} expired on ${exception.expires}`)
      continue
    }
    if (exception.metric === "postRoutingBytes"
      && exception.allowedBytes > (policy.ownerLock?.postRoutingCeilingBytes ?? -1)) {
      violations.push(`exception ${exception.id} cannot exceed the non-waivable owner ceiling`)
      continue
    }
    const matching = byMetric.get(exception.metric) || []
    matching.push(exception)
    byMetric.set(exception.metric, matching)
  }
  return byMetric
}

function activeLimit(metric, baseLimit, exceptions, violations) {
  const matching = exceptions.get(metric) || []
  if (matching.length > 1) {
    violations.push(`metric ${metric} has more than one active upward exception`)
  }
  for (const exception of matching) {
    if (exception.allowedBytes <= baseLimit) {
      violations.push(`exception ${exception.id} must raise, not restate, the ${metric} ratchet`)
    }
  }
  return matching.reduce(
    (limit, exception) => Math.max(limit, exception.allowedBytes),
    baseLimit,
  )
}

function bucketMeasurement(bucket, measuredEntries, bucketName, violations, options = {}) {
  const requirePresent = options.requirePresent ?? true
  if (!integer(bucket.startBytes) || !integer(bucket.maximumBytes)) {
    violations.push(`${bucketName} bucket needs integer startBytes and maximumBytes`)
  }
  const paths = []
  let recordedStartBytes = 0
  const entries = Array.isArray(bucket.entries) ? bucket.entries : []
  if (!Array.isArray(bucket.entries)) violations.push(`${bucketName} bucket entries must be an array`)
  for (const entry of entries) {
    if (!entry.path || !integer(entry.startBytes)) {
      violations.push(`${bucketName} bucket entries need path and startBytes`)
      continue
    }
    paths.push(entry.path)
    recordedStartBytes += entry.startBytes
  }
  if (new Set(paths).size !== paths.length) {
    violations.push(`${bucketName} bucket contains duplicate paths`)
  }
  if (recordedStartBytes !== bucket.startBytes) {
    violations.push(`${bucketName} startBytes does not equal its enumerated entry total`)
  }
  return {
    paths,
    bytes: paths.reduce((total, relativePath) => {
      const entry = measuredEntries.get(relativePath)
      if (!entry) {
        if (requirePresent) {
          violations.push(`${bucketName} entry is absent from the routed component review: ${relativePath}`)
        }
        return total
      }
      return total + entry.bytes
    }, 0),
  }
}

function postRoutingMeasurement(componentReview, measuredEntries, totalBytes, violations) {
  const entries = Array.isArray(componentReview?.postRoutingEntries)
    ? componentReview.postRoutingEntries
    : []
  if (!Array.isArray(componentReview?.postRoutingEntries)) {
    violations.push("postRoutingEntries must be an array in post-routing phase")
  }
  const paths = []
  let acceptedBytes = 0
  for (const entry of entries) {
    if (!entry.path || !integer(entry.acceptedBytes)) {
      violations.push("postRoutingEntries need path and acceptedBytes")
      continue
    }
    paths.push(entry.path)
    acceptedBytes += entry.acceptedBytes
  }
  if (new Set(paths).size !== paths.length) {
    violations.push("postRoutingEntries contain duplicate paths")
  }
  for (const path of paths) {
    if (!measuredEntries.has(path)) {
      violations.push(`post-routing entry is absent from component review: ${path}`)
    }
  }
  for (const path of measuredEntries.keys()) {
    if (!paths.includes(path)) {
      violations.push(`routed component-review entry is not in postRoutingEntries: ${path}`)
    }
  }
  if (acceptedBytes !== componentReview?.postRoutingRatchetBytes) {
    violations.push("postRoutingRatchetBytes does not equal its accepted entry total")
  }
  if ([...measuredEntries.values()].reduce((total, entry) => total + entry.bytes, 0) !== totalBytes) {
    violations.push("post-routing entry bytes do not equal the routed total")
  }
}

export function collectContextBudgetMeasurement(options = {}) {
  const fitness = collectHarnessFitness(options)
  const snapshot = fitnessSnapshot(fitness.metrics)
  const componentReview = fitness.metrics.routeContext.find((entry) => entry.id === "component-review")
  if (!componentReview) throw new Error("Harness fitness has no component-review routing case")
  return {
    recordedAt: fitness.recordedAt,
    gitRevision: fitness.gitRevision,
    gitWorktreeDirty: fitness.gitWorktreeDirty,
    alwaysLoadedBytes: snapshot.alwaysLoadedBytes,
    skillActivationBytes: snapshot.skillActivationBytes,
    componentReview: {
      id: componentReview.id,
      classifications: componentReview.classifications,
      totalBytes: componentReview.totalBytes,
      entries: componentReview.context.map((entry) => ({ path: entry.path, bytes: entry.bytes })),
    },
  }
}

export function evaluateContextBudget(policy, measurement, options = {}) {
  const now = options.now || new Date()
  const violations = []
  if (policy.schemaVersion !== 1) violations.push("context-budget schemaVersion must be 1")
  if (!["pre-routing", "post-routing"].includes(policy.phase)) {
    violations.push("context-budget phase must be pre-routing or post-routing")
  }
  if (!integer(policy.ownerLock?.postRoutingCeilingBytes)) {
    violations.push("ownerLock.postRoutingCeilingBytes must be a non-negative integer")
  }
  if (!/^[0-9a-f]{64}$/.test(policy.ownerLock?.eventId || "")) {
    violations.push("ownerLock.eventId must be the full owner event id")
  }
  if (Number.isNaN(new Date(policy.ownerLock?.lockedAt || "").getTime())) {
    violations.push("ownerLock.lockedAt must be an ISO date-time")
  }
  if (!/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/.test(policy.authoritySlice?.startRevision || "")) {
    violations.push("authoritySlice.startRevision must be a full Git revision")
  }
  for (const field of [
    "componentReviewStartBytes",
    "componentReviewAcceptedBytes",
    "guidanceDeltaBytes",
    "alwaysLoadedStartBytes",
    "skillActivationStartBytes",
  ]) {
    if (!integer(policy.authoritySlice?.[field])) {
      violations.push(`authoritySlice.${field} must be a non-negative integer`)
    }
  }
  if (policy.componentReview?.routingCaseId !== measurement.componentReview.id) {
    violations.push(`context budget must govern routing case ${measurement.componentReview.id}`)
  }
  for (const field of ["alwaysLoadedBytes", "skillActivationBytes"]) {
    if (!integer(policy.globalRatchets?.[field])) {
      violations.push(`globalRatchets.${field} must be a non-negative integer`)
    }
  }

  const measuredEntries = new Map(measurement.componentReview.entries.map((entry) => [entry.path, entry]))
  const preRouting = policy.phase === "pre-routing"
  const payload = bucketMeasurement(
    policy.componentReview?.buckets?.payload || {},
    measuredEntries,
    "payload",
    violations,
    { requirePresent: preRouting },
  )
  const guidance = bucketMeasurement(
    policy.componentReview?.buckets?.guidance || {},
    measuredEntries,
    "guidance",
    violations,
    { requirePresent: preRouting },
  )
  const listedPaths = [...payload.paths, ...guidance.paths]
  if (new Set(listedPaths).size !== listedPaths.length) {
    violations.push("component-review bucket membership overlaps")
  }
  if (preRouting) {
    for (const entry of measurement.componentReview.entries) {
      if (!listedPaths.includes(entry.path)) {
        violations.push(`routed component-review entry is not classified: ${entry.path}`)
      }
    }
    if (payload.bytes + guidance.bytes !== measurement.componentReview.totalBytes) {
      violations.push("component-review bucket totals do not equal the routed total")
    }
  }
  const recordedStartBytes = (policy.componentReview?.buckets?.payload?.startBytes ?? -1)
    + (policy.componentReview?.buckets?.guidance?.startBytes ?? -1)
  if (policy.authoritySlice?.componentReviewStartBytes !== recordedStartBytes) {
    violations.push("authoritySlice.componentReviewStartBytes does not equal the bucket start total")
  }
  const acceptedBytes = (policy.componentReview?.buckets?.payload?.maximumBytes ?? -1)
    + (policy.componentReview?.buckets?.guidance?.maximumBytes ?? -1)
  if (policy.authoritySlice?.componentReviewAcceptedBytes !== acceptedBytes) {
    violations.push("authoritySlice.componentReviewAcceptedBytes does not equal the accepted bucket total")
  }
  const guidanceDelta = (policy.componentReview?.buckets?.guidance?.maximumBytes ?? -1)
    - (policy.componentReview?.buckets?.guidance?.startBytes ?? -1)
  if (policy.authoritySlice?.guidanceDeltaBytes !== guidanceDelta) {
    violations.push("authoritySlice.guidanceDeltaBytes does not equal the guidance rebaseline")
  }
  if (policy.phase === "pre-routing" && policy.componentReview?.postRoutingRatchetBytes !== null) {
    violations.push("postRoutingRatchetBytes must remain null before query routing passes")
  }
  if (policy.phase === "post-routing" && !integer(policy.componentReview?.postRoutingRatchetBytes)) {
    violations.push("postRoutingRatchetBytes must be set in post-routing phase")
  }
  if (policy.phase === "post-routing") {
    if (!/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/.test(policy.routingSlice?.startRevision || "")) {
      violations.push("routingSlice.startRevision must be a full Git revision")
    }
    if (Number.isNaN(new Date(policy.routingSlice?.activatedAt || "").getTime())) {
      violations.push("routingSlice.activatedAt must be an ISO date-time")
    }
    if (policy.routingSlice?.batteryCommand !== "npm run check:progressive-context") {
      violations.push("routingSlice must name the progressive discovery battery")
    }
    postRoutingMeasurement(
      policy.componentReview,
      measuredEntries,
      measurement.componentReview.totalBytes,
      violations,
    )
  }

  const exceptions = validatedExceptions(policy, now, violations)
  const limits = {
    payloadBytes: activeLimit(
      "payloadBytes",
      policy.componentReview?.buckets?.payload?.maximumBytes ?? -1,
      exceptions,
      violations,
    ),
    guidanceBytes: activeLimit(
      "guidanceBytes",
      policy.componentReview?.buckets?.guidance?.maximumBytes ?? -1,
      exceptions,
      violations,
    ),
    alwaysLoadedBytes: activeLimit(
      "alwaysLoadedBytes",
      policy.globalRatchets?.alwaysLoadedBytes ?? -1,
      exceptions,
      violations,
    ),
    skillActivationBytes: activeLimit(
      "skillActivationBytes",
      policy.globalRatchets?.skillActivationBytes ?? -1,
      exceptions,
      violations,
    ),
    postRoutingBytes: policy.phase === "post-routing"
      ? activeLimit(
          "postRoutingBytes",
          policy.componentReview?.postRoutingRatchetBytes ?? -1,
          exceptions,
          violations,
        )
      : null,
  }
  const current = {
    payloadBytes: payload.bytes,
    guidanceBytes: guidance.bytes,
    alwaysLoadedBytes: measurement.alwaysLoadedBytes,
    skillActivationBytes: measurement.skillActivationBytes,
    postRoutingBytes: measurement.componentReview.totalBytes,
  }

  for (const metric of ["alwaysLoadedBytes", "skillActivationBytes"]) {
    if (!integer(limits[metric])) violations.push(`${metric} ratchet must be a non-negative integer`)
    else if (current[metric] > limits[metric]) {
      violations.push(`${metric} is ${current[metric]} bytes; limit is ${limits[metric]}`)
    }
  }
  if (policy.phase === "pre-routing") {
    for (const metric of ["payloadBytes", "guidanceBytes"]) {
      if (!integer(limits[metric])) violations.push(`${metric} ratchet must be a non-negative integer`)
      else if (current[metric] > limits[metric]) {
        violations.push(`${metric} is ${current[metric]} bytes; limit is ${limits[metric]}`)
      }
    }
  } else {
    const ceiling = policy.ownerLock?.postRoutingCeilingBytes ?? -1
    if (current.postRoutingBytes > ceiling) {
      violations.push(`postRoutingBytes is ${current.postRoutingBytes}; non-waivable ceiling is ${ceiling}`)
    }
    if (integer(limits.postRoutingBytes) && current.postRoutingBytes > limits.postRoutingBytes) {
      violations.push(`postRoutingBytes is ${current.postRoutingBytes}; ratchet is ${limits.postRoutingBytes}`)
    }
  }

  return {
    schemaVersion: 1,
    phase: policy.phase,
    recordedAt: measurement.recordedAt,
    gitRevision: measurement.gitRevision,
    gitWorktreeDirty: measurement.gitWorktreeDirty,
    current,
    limits,
    ownerCeilingBytes: policy.ownerLock?.postRoutingCeilingBytes ?? null,
    violations,
  }
}

export function readContextBudgetPolicy(policyPath = defaultPolicyPath) {
  return JSON.parse(fs.readFileSync(policyPath, "utf8"))
}

function printSummary(report) {
  console.log("Context budget check (blocking):")
  console.log(`- Phase: ${report.phase}`)
  console.log(`- Component review: ${report.current.postRoutingBytes} bytes`)
  if (report.phase === "pre-routing") {
    console.log(`- Payload: ${report.current.payloadBytes}/${report.limits.payloadBytes} bytes`)
    console.log(`- Guidance: ${report.current.guidanceBytes}/${report.limits.guidanceBytes} bytes`)
  } else {
    console.log(`- Post-routing ratchet: ${report.limits.postRoutingBytes} bytes`)
    console.log(`- Owner ceiling: ${report.ownerCeilingBytes} bytes`)
  }
  console.log(`- Always loaded: ${report.current.alwaysLoadedBytes}/${report.limits.alwaysLoadedBytes} bytes`)
  console.log(`- Skill activation: ${report.current.skillActivationBytes}/${report.limits.skillActivationBytes} bytes`)
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const policyPath = process.env.CONTEXT_BUDGET_POLICY_PATH || defaultPolicyPath
  const report = evaluateContextBudget(
    readContextBudgetPolicy(policyPath),
    collectContextBudgetMeasurement(),
  )
  if (process.argv.includes("--json")) console.log(JSON.stringify(report, null, 2))
  else printSummary(report)
  if (report.violations.length) {
    console.error(`Context budget check failed:\n\n${report.violations.map((item) => `- ${item}`).join("\n")}`)
    process.exit(1)
  }
}
