# Verify a visual evidence plan before opening a PR

For platform UI changes, the implementing Codex or Claude session can author
the exact replay plan while it still has the code, user flow, and local browser
in context. The plan is useful only after the same capture engine has actually
run it against both revisions. This command performs that local run before a
PR exists:

```sh
npm run verify:visual-evidence:local -- \
  --base <exact-40-character-base-commit> \
  --head <exact-40-character-final-local-commit> \
  --intent /absolute/path/to/visual-intent.json \
  --plan /absolute/path/to/replay-plan.json
```

The intent is the proposal's version-1 `visualEvidence` value. The plan uses
the same claims, personas, viewports, and requested media, adding typed
`replay` actions, locators, focus regions, and assertions. The command rejects
a plan that changes the intent. The plan schema and examples are in
`src/services/visual-evidence-plan.js` and
`scripts/local-visual-evidence/historical-2548-plan.json`.

## Local authoring loop

1. Commit the app change locally and record its full base and head SHAs. A
   worktree that still has uncommitted app changes is not the head image the
   verifier will build. Set up the local development environment with
   `npm run visual-evidence:local-setup` and `make up`. If the local stack runs
   from another checkout, pass its local-only `.env` with `--env-file`.
2. Use the local browser and source code to discover the actual controls and
   their accessible roles, labels, or stable selectors. Write the intent and
   executable plan for the specific user-visible claim. Choose `animation:
   none` for a static state, `steps` for meaningful user interactions, and
   `motion` only when movement is the claim.
3. Run the command. It checks out the two exact commits, builds both Docker
   images, snapshots the *local* database, and restores that same snapshot
   separately for base and head. It mints the normal local capture identities
   and runs the production browser replay/encoder twice, restoring the
   snapshot between passes. A failed locator, action, assertion, media check,
   or reproducibility check exits nonzero and writes a failure JSON file.
4. On success, inspect the PNGs and any WebM in
   `.local-visual-evidence/pre-pr-<run-id>/`. Confirm that the captures show
   the claim; replay success alone only proves the steps ran reproducibly and
   produced valid media. Fix the app or plan and rerun until they do.
5. Open the PR only with a plan whose manifest has `passed: true`, the exact
   final head SHA, and the plan hash of the plan you will submit. If any code
   commit changes that head, rerun. The platform must still replay the plan
   on its own isolated base/head environments after import.

The command reads Git objects and the local development database. It does not
read production data, call a model, create a PR, or submit a proposal. It does
not invent fixture users or app content. The local fixture may lack a state
needed for the claim; in that case, the author must create representative
*local* test state or report that the evidence cannot yet be verified.

## Scope

This runner currently targets the Homeroom platform repository and its local
Compose stack. It is the pre-PR verification path for local platform changes,
including the browser actions and PNG/WebM creation that previously happened
only after import. It does not exercise hosted model dispatch or prove that a
different production database contains the same state. Other app repositories
need an app-specific way to launch exact base/head revisions with equivalent
local fixture data and capture identities before this gate can apply to them.
