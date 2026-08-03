import assert from "node:assert/strict"
import path from "node:path"
import test from "node:test"
import { fileURLToPath } from "node:url"

import {
  evaluateInterfaceLawRatchet,
  scanInterfaceSource,
  splitTailwindVariant,
} from "./interface-law-tools.mjs"

const frontendRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..")
const fixtureFile = path.join(frontendRoot, "@", "features", "fixture.tsx")

test("variant parsing ignores colons inside bracketed selectors", () => {
  assert.deepEqual(splitTailwindVariant("[&_[data-slot=card]]:bg-transparent"), {
    variants: ["[&_[data-slot=card]]"],
    utility: "bg-transparent",
  })
})

test("surface direction exempts ephemeral state and transparent removal but not attribute state", () => {
  const findings = scanInterfaceSource(frontendRoot, fixtureFile, `
    import { Card } from "@/components/ui/card"
    export function Fixture() {
      return <Card className="[&_[data-slot=card]]:bg-transparent hover:bg-muted data-[state=on]:bg-card rounded-2xl" />
    }
  `)
  assert.deepEqual(findings.filter((item) => item.rule === "caller-surface-direction").map((item) => item.match), ["data-[state=on]:bg-card"])
})

test("paper, recess, spacing, margin, radius, and primitive rules are structural", () => {
  const findings = scanInterfaceSource(frontendRoot, fixtureFile, `
    import { Card } from "@/components/ui/card"
    export function Fixture() {
      return <main data-surface="paper"><section data-surface="paper"><div data-surface="recess" /><Card className="mt-4 rounded-[2px]" /><div data-spacing-tier="macro" /><button>Save</button></section></main>
    }
  `)
  for (const rule of ["no-paper-in-paper", "named-recess-role", "no-caller-margin", "radius-ladder-only", "macro-spacing-outer-zone", "use-owned-primitive"]) {
    assert.ok(findings.some((item) => item.rule === rule), `missing ${rule}`)
  }
})

test("Sheet remains a legal drawer primitive name and the persistent overlay tenant is exact", () => {
  const findings = scanInterfaceSource(frontendRoot, fixtureFile, `
    import { Sheet } from "@/components/ui/sheet"
    export function Fixture() {
      return <><Sheet /><nav data-slot="other" data-surface="overlay" data-surface-persistence="persistent" /></>
    }
  `)
  assert.ok(!findings.some((item) => item.match.includes("<Sheet")))
  assert.ok(findings.some((item) => item.rule === "single-persistent-overlay"))
})

test("status colour is ink rather than a sixth surface role", () => {
  const findings = scanInterfaceSource(frontendRoot, fixtureFile, `
    export function Fixture() {
      return <div data-surface="status" />
    }
  `)
  const invalid = findings.find((item) => item.rule === "invalid-surface-role")
  assert.equal(invalid?.match, "status")
  assert.match(invalid?.remediation || "", /status colour is ink/)
})

test("exact warning ratchet rejects additions and requires resolved entries to be removed", () => {
  const accepted = [{ rule: "no-caller-margin", file: "@/a.tsx", match: "mt-2" }]
  assert.deepEqual(evaluateInterfaceLawRatchet(accepted, accepted), { added: [], resolved: [] })
  assert.equal(evaluateInterfaceLawRatchet([...accepted, { rule: "use-owned-primitive", file: "@/b.tsx", match: "<button>" }], accepted).added.length, 1)
  assert.equal(evaluateInterfaceLawRatchet([], accepted).resolved.length, 1)
  assert.equal(evaluateInterfaceLawRatchet([...accepted, ...accepted], [{ ...accepted[0], count: 2 }]).added.length, 0)
})
