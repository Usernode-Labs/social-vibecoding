import assert from "node:assert/strict"
import test from "node:test"

import {
  buildTokenDemo,
  collectPrCaseEvidence,
  PR_CASE_BASE_REVISION,
  PR_CASE_BRANCH_REVISION,
} from "./pr-case-tools.mjs"

test("token demonstration proves propagation and refusal without mutating authority", () => {
  const demo = buildTokenDemo()
  assert.equal(demo.propagatedLine, "--primary: oklch(0.32 0.08 255);")
  assert.match(demo.rejection, /Canvas to Paper lightness step -0\.010 is below 0\.020/)
  assert.equal(demo.canonicalSha256, "2b2c6f6fc2ccef641a149d3949fd18ca7f5df6dd343db56b61bd08dc8ed1556b")
})

test("claim manifest pins revisions, units, commands, and stable slide identifiers", () => {
  const evidence = collectPrCaseEvidence()
  assert.deepEqual(evidence.generatedFrom, {
    comparisonBaseRevision: PR_CASE_BASE_REVISION,
    comparisonBranchRevision: PR_CASE_BRANCH_REVISION,
    projectionAuthority: {
      tokenHarness: evidence.generatedFrom.projectionAuthority.tokenHarness,
      contextHarness: evidence.generatedFrom.projectionAuthority.contextHarness,
      capture: evidence.generatedFrom.projectionAuthority.capture,
    },
  })
  assert.equal(evidence.claims.length, 14)
  assert.equal(new Set(evidence.claims.map((claim) => claim.id)).size, evidence.claims.length)
  assert.equal(new Set(evidence.claims.map((claim) => claim.slideId)).size, evidence.claims.length)
  for (const claim of evidence.claims) {
    assert.match(claim.id, /^R\d+$/)
    assert.ok(claim.command)
    assert.ok(claim.sources.length)
    assert.ok(claim.metrics.length)
    for (const metric of claim.metrics) {
      assert.ok(metric.id)
      assert.ok(metric.unit)
      assert.ok(metric.revision)
      assert.ok(metric.scope)
      assert.ok(Object.hasOwn(metric, "value"))
    }
  }
  assert.equal(evidence.claims[8].slideId, "regression-caught")
  assert.deepEqual(evidence.facts.surfaceSize, {
    legacy: {
      markup: { files: 14, lines: 3671 },
      styling: { files: 2, lines: 4624 },
      scripts: { files: 47, lines: 53856 },
      total: { files: 63, lines: 62151 },
    },
    react: {
      product: { files: 174, lines: 25138 },
      proof: { files: 246, lines: 37416 },
      configuration: { files: 28, lines: 2786 },
      total: { files: 448, lines: 65340 },
    },
  })
  assert.deepEqual(evidence.facts.routeShape, {
    basename: "/react",
    proposalPattern: "/apps/:slug/dev/proposals/:proposalId",
    legacyExample: "/#app/usernode-2d5619/dev/proposals/2971",
    reactExample: "/react/apps/usernode-2d5619/dev/proposals/2971",
  })
})
