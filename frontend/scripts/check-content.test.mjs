import assert from "node:assert/strict"
import test from "node:test"
import { checkSource } from "./check-content.mjs"

function rules(source, file) {
  return checkSource(source, file).map((finding) => finding.rule)
}

test("allows canonical shell dApp casing and an in-progress button ellipsis", () => {
  assert.deepEqual(rules('<Button aria-label="Loading…">Loading…</Button><p>dApps</p>', "@/features/apps/example.tsx"), [])
})

test("rejects the narrow mechanical content failures", () => {
  const source = '<><a href="/notifications">Notifications</a><Button>Open Dev</Button><Button>Continue...</Button><Button aria-label="Create app">Save</Button><p>Please use DApps.</p><p>Open the legacy shell</p></>'
  assert.deepEqual(rules(source, "@/features/apps/example.tsx"), [
    "activity-destination",
    "dev-improve",
    "button-ellipsis",
    "visible-label-accessible-name",
    "dapp-casing",
    "banned-filler",
    "migration-visible-copy",
  ])
})

test("keeps Expert Dev text out of the customer-action ratchet", () => {
  assert.deepEqual(rules('<Button>Back to Dev</Button>', "@/features/dev/example.tsx"), [])
})
