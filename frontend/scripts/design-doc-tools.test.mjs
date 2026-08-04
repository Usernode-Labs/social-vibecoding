import assert from "node:assert/strict"
import { execFileSync } from "node:child_process"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import test from "node:test"

import {
  generateDecisionLedger,
  productionDocImportViolations,
  validateDesignDocCitations,
} from "./design-doc-tools.mjs"

const event = (character) => character.repeat(64)

function runGit(root, args) {
  return execFileSync("git", args, { cwd: root, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim()
}

function commit(root, subject, origin) {
  fs.writeFileSync(path.join(root, `${subject.replace(/\W+/g, "-")}.txt`), subject)
  runGit(root, ["add", "."])
  runGit(root, ["commit", "-m", subject, "-m", `Task: fixture\nOrigin-Buzz-Event: ${origin}`])
  return runGit(root, ["rev-parse", "HEAD"])
}

function fixtureRoot() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "design-doc-tools-"))
  for (const directory of ["@/components", "@/docs", "design-system", "scripts", "src"]) {
    fs.mkdirSync(path.join(root, directory), { recursive: true })
  }
  fs.writeFileSync(path.join(root, "package.json"), JSON.stringify({ scripts: { "check:interface-laws": "node scanner", "test:storybook": "vitest" } }))
  fs.writeFileSync(path.join(root, "design-system/interface-laws.md"), "## 1. Surface role\n\nOne Paper.\n")
  fs.writeFileSync(path.join(root, "scripts/interface-law-tools.mjs"), 'finding(root, file, source, node, "no-paper-in-paper", "x", "fix")\n')
  fs.writeFileSync(path.join(root, "scripts/interface-law-tools.test.mjs"), 'function assertRuleCoverage(testName, findings, rules) { for (const rule of rules) assert.ok(findings.some((item) => item.rule === rule), testName) }\nconst surfaceTest = "surface structure"\ntest(surfaceTest, () => { assertRuleCoverage(surfaceTest, findings, ["no-paper-in-paper"]) })\ntest("negative structure", () => assert.ok(!findings.some((item) => item.rule === "invalid-surface-role")))\n')
  fs.writeFileSync(path.join(root, "@/docs/specimen.stories.tsx"), "export const DesktopLight = { play: () => expect(true).toBe(true) }\nexport const DesktopDark = {}\n")
  fs.writeFileSync(path.join(root, "@/docs/page.tsx"), "export function Page() { return null }\n")
  return root
}

test("structured citations resolve exact scanner rules, package checks, and test names", () => {
  const root = fixtureRoot()
  const citation = {
    version: 1,
    citations: [{
      id: "surface-rule",
      page: "surfaces",
      lawSection: "1. Surface role",
      kind: "scanner-rule",
      rule: "no-paper-in-paper",
      check: "check:interface-laws",
      test: { path: "scripts/interface-law-tools.test.mjs", name: "surface structure" },
      catches: "Nested Paper.",
      misses: "Dynamic composition.",
    }],
  }
  assert.deepEqual(validateDesignDocCitations(citation, { frontendRoot: root, requiredPages: ["surfaces"] }), [])
  citation.citations[0].check = "lint"
  assert.match(validateDesignDocCitations(citation, { frontendRoot: root, requiredPages: ["surfaces"] }).join("\n"), /interface-law scanner lane/)
  citation.citations[0].check = "check:interface-laws"
  citation.citations[0].rule = "invented-rule"
  assert.match(validateDesignDocCitations(citation, { frontendRoot: root, requiredPages: ["surfaces"] }).join("\n"), /does not exist in the scanner/)
  citation.citations[0].rule = "no-paper-in-paper"
  fs.writeFileSync(path.join(root, "scripts/interface-law-tools.test.mjs"), 'function assertRuleCoverage(testName, findings, rules) { for (const rule of rules) assert.ok(findings.some((item) => item.rule === rule), testName) }\nconst surfaceTest = "surface structure"\ntest(surfaceTest, () => { assertRuleCoverage(surfaceTest, findings, ["another-rule"]) })\n')
  assert.match(validateDesignDocCitations(citation, { frontendRoot: root, requiredPages: ["surfaces"] }).join("\n"), /does not exercise/)
  fs.writeFileSync(path.join(root, "scripts/interface-law-tools.test.mjs"), 'function assertRuleCoverage(testName, findings, rules) { for (const rule of rules) assert.ok(findings.some((item) => item.rule === rule), testName) }\nconst surfaceTest = "surface structure"\ntest(surfaceTest, () => { assertRuleCoverage(surfaceTest, findings, ["no-paper-in-paper"]) })\ntest("negative structure", () => assert.ok(!findings.some((item) => item.rule === "invalid-surface-role")))\n')
  citation.citations[0].rule = "invalid-surface-role"
  citation.citations[0].test.name = "negative structure"
  assert.match(validateDesignDocCitations(citation, { frontendRoot: root, requiredPages: ["surfaces"] }).join("\n"), /does not exercise/)
  citation.citations[0].rule = "no-paper-in-paper"
  citation.citations[0].test.name = "surface structure"
  fs.writeFileSync(path.join(root, "scripts/interface-law-tools.test.mjs"), 'function assertRuleCoverage() {}\nconst surfaceTest = "surface structure"\ntest(surfaceTest, () => { assertRuleCoverage(surfaceTest, findings, ["no-paper-in-paper"]) })\n')
  assert.match(validateDesignDocCitations(citation, { frontendRoot: root, requiredPages: ["surfaces"] }).join("\n"), /no substantive assertRuleCoverage helper/)
  fs.writeFileSync(path.join(root, "scripts/interface-law-tools.test.mjs"), 'function assertRuleCoverage(testName, findings, rules) { if (false) { for (const rule of rules) assert.ok(findings.some((item) => item.rule === rule), testName) } }\nconst surfaceTest = "surface structure"\ntest(surfaceTest, () => { assertRuleCoverage(surfaceTest, findings, ["no-paper-in-paper"]) })\n')
  assert.match(validateDesignDocCitations(citation, { frontendRoot: root, requiredPages: ["surfaces"] }).join("\n"), /no substantive assertRuleCoverage helper/)
  fs.writeFileSync(path.join(root, "scripts/interface-law-tools.test.mjs"), 'function assertRuleCoverage(testName, findings, rules) { for (const rule of []) assert.ok(findings.some((item) => item.rule === rule), testName) }\nconst surfaceTest = "surface structure"\ntest(surfaceTest, () => { assertRuleCoverage(surfaceTest, findings, ["no-paper-in-paper"]) })\n')
  assert.match(validateDesignDocCitations(citation, { frontendRoot: root, requiredPages: ["surfaces"] }).join("\n"), /no substantive assertRuleCoverage helper/)
  fs.writeFileSync(path.join(root, "scripts/interface-law-tools.test.mjs"), 'function assertRuleCoverage(testName, findings, rules) { for (const rule of rules) assert.ok(findings.some((item) => item.rule === rule), testName) }\nconst surfaceTest = "surface structure"\ntest(surfaceTest, () => { if (false) assertRuleCoverage(surfaceTest, findings, ["no-paper-in-paper"]) })\n')
  assert.match(validateDesignDocCitations(citation, { frontendRoot: root, requiredPages: ["surfaces"] }).join("\n"), /does not exercise/)
  delete citation.citations[0].page
  assert.match(validateDesignDocCitations(citation, { frontendRoot: root, requiredPages: ["surfaces"] }).join("\n"), /page does not resolve/)
})

test("rendered and review-only citations remain honest about their enforcement kind", () => {
  const root = fixtureRoot()
  const citations = {
    version: 1,
    citations: [
      {
        id: "rendered-surface",
        page: "surfaces",
        lawSection: "1. Surface role",
        kind: "rendered-test",
        check: "test:storybook",
        story: { path: "@/docs/specimen.stories.tsx", export: "DesktopLight" },
        catches: "Rendered specimen.",
        misses: "Other routes.",
      },
      {
        id: "review-surface",
        page: "surfaces",
        lawSection: "1. Surface role",
        kind: "review-only",
        review: { path: "design-system/interface-laws.md", instruction: "Review every route." },
        catches: "Semantic intent.",
        misses: "No automatic coverage.",
      },
    ],
  }
  assert.deepEqual(validateDesignDocCitations(citations, { frontendRoot: root, requiredPages: ["surfaces"] }), [])
  citations.citations[0].story.export = "DesktopDark"
  assert.match(validateDesignDocCitations(citations, { frontendRoot: root, requiredPages: ["surfaces"] }).join("\n"), /has no play assertion/)
  citations.citations[0].story.export = "DesktopLight"
  fs.writeFileSync(path.join(root, "@/docs/specimen.stories.tsx"), "export const DesktopLight = { play: undefined }\n")
  assert.match(validateDesignDocCitations(citations, { frontendRoot: root, requiredPages: ["surfaces"] }).join("\n"), /has no play assertion/)
  fs.writeFileSync(path.join(root, "@/docs/specimen.stories.tsx"), 'export const DesktopLight = { play: () => console.log("not an assertion") }\n')
  assert.match(validateDesignDocCitations(citations, { frontendRoot: root, requiredPages: ["surfaces"] }).join("\n"), /has no play assertion/)
  fs.writeFileSync(path.join(root, "@/docs/specimen.stories.tsx"), 'export const DesktopLight = { play: () => { if (false) expect(true).toBe(true) } }\n')
  assert.match(validateDesignDocCitations(citations, { frontendRoot: root, requiredPages: ["surfaces"] }).join("\n"), /has no play assertion/)
  fs.writeFileSync(path.join(root, "@/docs/specimen.stories.tsx"), 'export const DesktopLight = { play: () => expect(true) }\n')
  assert.match(validateDesignDocCitations(citations, { frontendRoot: root, requiredPages: ["surfaces"] }).join("\n"), /has no play assertion/)
  fs.writeFileSync(path.join(root, "@/docs/specimen.stories.tsx"), 'export const DesktopLight = { play: () => { false && expect(true).toBe(true) } }\n')
  assert.match(validateDesignDocCitations(citations, { frontendRoot: root, requiredPages: ["surfaces"] }).join("\n"), /has no play assertion/)
  fs.writeFileSync(path.join(root, "@/docs/specimen.stories.tsx"), "export const DesktopLight = { play: () => expect(true).toBe(true) }\n")
  citations.citations[0].check = "check:interface-laws"
  assert.match(validateDesignDocCitations(citations, { frontendRoot: root, requiredPages: ["surfaces"] }).join("\n"), /rendered Storybook test lane/)
  citations.citations[0].check = "test:storybook"
  citations.citations[1].check = "test:storybook"
  assert.match(validateDesignDocCitations(citations, { frontendRoot: root, requiredPages: ["surfaces"] }).join("\n"), /must not imply mechanical enforcement/)
})

test("production code cannot reach Storybook documentation through any static module form", () => {
  const cases = [
    'import { Page } from "@/docs/page"\n',
    'export { Page } from "../@/docs/page"\n',
    'const page = import("@/docs/page")\n',
    'const pages = import.meta.glob("@/docs/**")\n',
    'const pages = import.meta.glob(["@/docs/**", "@/components/**"])\n',
    'const pages = import.meta.glob("/@/docs/**")\n',
  ]
  for (const [index, source] of cases.entries()) {
    const root = fixtureRoot()
    fs.writeFileSync(path.join(root, "src", `case-${index}.ts`), source)
    assert.equal(productionDocImportViolations({ frontendRoot: root }).length, 1)
  }
  const root = fixtureRoot()
  fs.writeFileSync(path.join(root, "src/allowed.ts"), 'import type { ReactNode } from "react"\nexport type Value = ReactNode\n')
  fs.writeFileSync(path.join(root, "src/relay.mjs"), 'export { Page } from "@/docs/page"\n')
  assert.equal(productionDocImportViolations({ frontendRoot: root }).length, 1)
  fs.rmSync(path.join(root, "src/relay.mjs"))
  fs.writeFileSync(path.join(root, "src/relay.mts"), 'export { Page } from "@/docs/page"\n')
  assert.equal(productionDocImportViolations({ frontendRoot: root }).length, 1)
  fs.rmSync(path.join(root, "src/relay.mts"))
  fs.writeFileSync(path.join(root, "@/docs/consumer.ts"), 'import { Page } from "./page"\nexport { Page }\n')
  assert.deepEqual(productionDocImportViolations({ frontendRoot: root }), [])
})

test("decision ledger reads only pinned first-parent history and rejects hidden reachable commits", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "design-doc-ledger-"))
  runGit(root, ["init", "-b", "main"])
  runGit(root, ["config", "user.name", "Fixture"])
  runGit(root, ["config", "user.email", "fixture@example.com"])
  const boundary = commit(root, "boundary", event("1"))
  const spine = commit(root, "spine decision", event("2"))
  runGit(root, ["checkout", "-b", "private-recovery", boundary])
  const hidden = commit(root, "hidden checkpoint", event("3"))
  runGit(root, ["update-ref", "refs/buzz/slice-recovery/fixture", hidden])
  runGit(root, ["checkout", "main"])
  runGit(root, ["merge", "--no-ff", "private-recovery", "-m", "merge fixture"])
  runGit(root, ["checkout", "-b", "unrelated", boundary])
  const unrelated = commit(root, "unrelated checkpoint", event("4"))
  runGit(root, ["checkout", "main"])
  const authority = {
    version: 1,
    history: { startExclusive: boundary, traversal: "first-parent" },
    entries: [{
      commit: spine,
      decision: "Keep the spine exact.",
      originEvent: event("2"),
      receiptEvent: event("a"),
      approvalEvent: event("b"),
    }],
  }
  const ledger = generateDecisionLedger(authority, { repoRoot: root })
  assert.deepEqual(ledger.entries.map((entry) => entry.commit), [spine])
  authority.entries[0].commit = hidden
  authority.entries[0].originEvent = event("3")
  assert.throws(() => generateDecisionLedger(authority, { repoRoot: root }), /not on first-parent HEAD history/)
  authority.entries = []
  authority.history.startExclusive = hidden
  assert.throws(() => generateDecisionLedger(authority, { repoRoot: root }), /startExclusive must be on first-parent HEAD history/)
  authority.history.startExclusive = unrelated
  assert.throws(() => generateDecisionLedger(authority, { repoRoot: root }), /must be an ancestor of HEAD/)
})
