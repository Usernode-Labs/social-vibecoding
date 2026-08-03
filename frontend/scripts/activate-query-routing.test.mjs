import assert from "node:assert/strict"
import test from "node:test"

import { activateQueryRouting } from "./activate-query-routing.mjs"

function fixture() {
  return {
    policy: {
      phase: "pre-routing",
      ownerLock: { postRoutingCeilingBytes: 100 },
      componentReview: { routingCaseId: "component-review", postRoutingRatchetBytes: null },
      globalRatchets: { alwaysLoadedBytes: 20, skillActivationBytes: 10 },
    },
    measurement: {
      gitRevision: "a".repeat(40),
      alwaysLoadedBytes: 18,
      skillActivationBytes: 10,
      componentReview: {
        id: "component-review",
        totalBytes: 60,
        entries: [{ path: "law", bytes: 20 }, { path: "guidance", bytes: 40 }],
      },
    },
    discovery: {
      fixture: { componentId: "fixture" },
      ownerCeilingBytes: 100,
      route: {
        classifications: ["content", "component", "review"],
        context: [
          "agent-skills/ui-development/references/authority.md",
          "frontend/design-system/interface-laws.md",
        ],
        discovery: ["npm run query:design-system -- fixture"],
        totalBytes: 60,
      },
      query: { count: 1, componentIds: ["fixture"] },
      target: {
        id: "fixture",
        source: { path: "frontend/source.tsx", bytes: 1 },
        story: { path: "frontend/source.stories.tsx", bytes: 1 },
      },
    },
  }
}

test("activation records the achieved route once after discovery passes", () => {
  const { policy, measurement, discovery } = fixture()
  const result = activateQueryRouting(policy, measurement, discovery, {
    activatedAt: "2026-08-03T12:00:00Z",
  })
  assert.equal(result.phase, "post-routing")
  assert.equal(result.componentReview.postRoutingRatchetBytes, 60)
  assert.deepEqual(result.componentReview.postRoutingEntries, [
    { path: "law", acceptedBytes: 20 },
    { path: "guidance", acceptedBytes: 40 },
  ])
  assert.equal(result.globalRatchets.alwaysLoadedBytes, 18)
})

test("activation cannot re-run or cross the owner ceiling", () => {
  const first = fixture()
  first.policy.phase = "post-routing"
  assert.throws(() => activateQueryRouting(first.policy, first.measurement, first.discovery), /exactly once/)

  const second = fixture()
  second.measurement.componentReview.totalBytes = 101
  assert.throws(() => activateQueryRouting(second.policy, second.measurement, second.discovery), /ceiling is 100/)
})
