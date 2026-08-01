import path from "node:path"
import { fileURLToPath } from "node:url"

import { finalizeSlice, parseFinalizeArguments } from "./slice-boundary.mjs"

const frontendRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..")
const repoRoot = path.resolve(frontendRoot, "..")

if (process.argv.includes("--help")) {
  console.log(`Usage: npm run finalize:slice -- \\
  --base <commit> \\
  --slice <lowercase-name> \\
  --subject <final-subject> \\
  --origin-event <64-character-buzz-event-id> [--dry-run]`)
  process.exit(0)
}

try {
  const result = finalizeSlice({ repoRoot, ...parseFinalizeArguments(process.argv.slice(2)) })
  if (result.newCommit) {
    console.log(JSON.stringify({
      finalized: true,
      baseCommit: result.baseCommit,
      previousHead: result.oldHead,
      commit: result.newCommit,
      checkpoints: result.checkpoints.map(({ commit, subject }) => ({ commit, subject })),
      recoveryRef: result.recoveryRef,
    }, null, 2))
  } else {
    process.stdout.write(result.message)
  }
} catch (cause) {
  console.error(cause instanceof Error ? cause.message : cause)
  process.exit(1)
}
