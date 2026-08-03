import fs from "node:fs"
import path from "node:path"
import { fileURLToPath } from "node:url"

import {
  collectContextBudgetMeasurement,
  readContextBudgetPolicy,
} from "./check-context-budget.mjs"
import {
  collectProgressiveContext,
  evaluateProgressiveContext,
} from "./check-progressive-context.mjs"

const frontendRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..")
const defaultPolicyPath = path.join(frontendRoot, "design-system/context-budget.json")

export function activateQueryRouting(policy, measurement, discovery, options = {}) {
  const violations = evaluateProgressiveContext(discovery)
  if (violations.length) {
    throw new Error(`query-routing discovery battery failed:\n${violations.map((item) => `- ${item}`).join("\n")}`)
  }
  if (policy.phase !== "pre-routing" || policy.componentReview?.postRoutingRatchetBytes !== null) {
    throw new Error("query routing may activate exactly once from the pre-routing phase")
  }
  if (measurement.componentReview.id !== policy.componentReview.routingCaseId) {
    throw new Error(`query routing measured unexpected case ${measurement.componentReview.id}`)
  }
  const ceiling = policy.ownerLock?.postRoutingCeilingBytes
  if (!Number.isInteger(ceiling) || measurement.componentReview.totalBytes > ceiling) {
    throw new Error(`query-routing result is ${measurement.componentReview.totalBytes} bytes; ceiling is ${ceiling}`)
  }
  const activatedAt = options.activatedAt || new Date().toISOString()
  if (Number.isNaN(new Date(activatedAt).getTime())) throw new Error("activatedAt must be an ISO date-time")

  return {
    ...structuredClone(policy),
    phase: "post-routing",
    routingSlice: {
      startRevision: measurement.gitRevision,
      activatedAt,
      batteryCommand: "npm run check:progressive-context",
      fixture: discovery.fixture,
    },
    componentReview: {
      ...structuredClone(policy.componentReview),
      postRoutingRatchetBytes: measurement.componentReview.totalBytes,
      postRoutingEntries: measurement.componentReview.entries.map((entry) => ({
        path: entry.path,
        acceptedBytes: entry.bytes,
      })),
    },
    globalRatchets: {
      alwaysLoadedBytes: Math.min(policy.globalRatchets.alwaysLoadedBytes, measurement.alwaysLoadedBytes),
      skillActivationBytes: Math.min(policy.globalRatchets.skillActivationBytes, measurement.skillActivationBytes),
    },
  }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const policyPath = process.env.CONTEXT_BUDGET_POLICY_PATH || defaultPolicyPath
  const measurement = collectContextBudgetMeasurement()
  const discovery = collectProgressiveContext()
  const activated = activateQueryRouting(
    readContextBudgetPolicy(policyPath),
    measurement,
    discovery,
  )
  fs.writeFileSync(policyPath, `${JSON.stringify(activated, null, 2)}\n`)
  console.log(`Activated post-routing context budget at ${measurement.componentReview.totalBytes} bytes after the progressive discovery battery passed.`)
}
