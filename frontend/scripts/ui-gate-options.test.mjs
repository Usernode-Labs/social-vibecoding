import assert from "node:assert/strict"
import test from "node:test"

import { parseGateOptions } from "./ui-gate-options.mjs"

test("records an explicit skip reason without hiding later stages", () => {
  const options = parseGateOptions(["--skip", "18=parked authentication lane"], 23, "parallel")
  assert.equal(options.fromIndex, 0)
  assert.equal(options.mode, "parallel")
  assert.deepEqual([...options.skips], [[17, "parked authentication lane"]])
})

test("supports resuming from a later stage", () => {
  const options = parseGateOptions(["--from", "7"], 23)
  assert.equal(options.fromIndex, 6)
  assert.equal(options.mode, "serial")
  assert.equal(options.skips.size, 0)
})

test("selects the serial fallback explicitly", () => {
  const options = parseGateOptions(["--serial"], 23, "parallel")
  assert.equal(options.mode, "serial")
})

test("rejects an unreasoned or out-of-range skip", () => {
  assert.throws(
    () => parseGateOptions(["--skip", "18"], 23),
    /STEP=REASON/,
  )
  assert.throws(
    () => parseGateOptions(["--skip", "24=not a real stage"], 23),
    /STEP=REASON/,
  )
})

test("rejects a skip hidden before the resumed stage", () => {
  assert.throws(
    () => parseGateOptions(["--from", "9", "--skip", "4=already omitted"], 23),
    /both before --from and explicitly skipped/,
  )
})
