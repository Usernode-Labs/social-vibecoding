export function parseGateOptions(argv, gateCount, defaultMode = "serial") {
  let fromIndex = 0
  const skips = new Map()
  let mode = defaultMode

  if (!["serial", "parallel"].includes(defaultMode)) {
    throw new Error(`unknown default UI gate mode: ${defaultMode}`)
  }

  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index]
    if (argument === "--serial") {
      mode = "serial"
      continue
    }
    if (argument === "--from") {
      const step = Number(argv[index + 1])
      if (!Number.isInteger(step) || step < 1 || step > gateCount) {
        throw new Error(`--from must name a gate step from 1 to ${gateCount}`)
      }
      fromIndex = step - 1
      index += 1
      continue
    }
    if (argument === "--skip") {
      const value = argv[index + 1] || ""
      const separator = value.indexOf("=")
      const step = Number(separator < 0 ? value : value.slice(0, separator))
      const reason = separator < 0 ? "" : value.slice(separator + 1).trim()
      if (!Number.isInteger(step) || step < 1 || step > gateCount || !reason) {
        throw new Error(`--skip must use STEP=REASON with a step from 1 to ${gateCount}`)
      }
      skips.set(step - 1, reason)
      index += 1
    }
  }

  for (const step of skips.keys()) {
    if (step < fromIndex) {
      throw new Error(`gate step ${step + 1} cannot be both before --from and explicitly skipped`)
    }
  }

  return { fromIndex, skips, mode }
}
