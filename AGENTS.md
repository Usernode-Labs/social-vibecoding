# Social Vibecoding React migration

## Purpose

This branch migrates the platform UI from the existing static, vanilla-JS
shell to React and official shadcn/Base UI components without changing the
server/API, authentication, bridge, iframe, service-worker, hash-link, or
child-app security contracts until an equivalent replacement is verified.

## Universal working agreement

This file is deliberately vendor-neutral. Codex, Claude, and other coding
agents should read it before making migration changes.

For React route, component, or UI-review work, read
`agent-skills/ui-development/SKILL.md`. For agent-harness maintenance or model
fitness review, read `agent-skills/harness-fitness/SKILL.md`. Run
`tool/setup-agent-skills.sh` to expose canonical project skills through the
local `.agents` Codex and `.claude` Claude discovery paths; those generated
links are intentionally ignored.
Begin UI work with `node tool/ui-workflow.mjs --task "<task>"`; it provides
progressive, task-specific context and gates without depending on one agent
vendor's hook runtime. Its classifications compose: follow every selected
workflow, not only the first label. Run `cd frontend && npm run check:ui`
before handoff; harness integrity proves that authority still matches package
scripts, continuous integration, adapters, and the deterministic agent
battery. The expensive live-agent evaluator is a prerelease diagnostic, not a
per-commit freshness gate.

1. Preserve a working legacy route until its React replacement has parity
   evidence for loading, error, empty, permission, narrow and desktop states.
2. Reuse an official shadcn source component before creating an owned pattern.
3. Keep API calls in the React data layer; do not introduce direct `fetch()`
   calls in presentation components.
4. Treat hashes, browser history, native bridge capability discovery, iframe
   sandboxing, session cookies, and service-worker behaviour as public
   compatibility contracts.
5. Add a harness rule only after a specific migration failure proves it is
   needed. Record the trigger, proof command and owner next to that rule.
6. For a registered text-bearing pattern, use the optional content contract in
   `frontend/design-system/authority.json`, read
   `frontend/design-system/content-guidelines.md`, and run
   `npm run check:content` from `frontend/`. The gate is deliberately narrow;
   use its exact, expiring ledger for existing migration copy rather than
   pretending subjective writing judgment is mechanically decidable.

## Commit messages

Write for a future reader who has the diff but not the task conversation.

- Use an imperative subject that describes the outcome, not the files changed.
- Add a body only when the change has context the diff cannot explain.
- Preserve the reason for the change and any important decision, tradeoff, or
  intentional deviation.
- Record meaningful verification completed before the commit was created and
  any known remaining risk that affects future work. Never predict a pass.
- Record exact-commit boundary results after the commit in the generated UI-gate
  timing artifact and a signed Buzz receipt keyed to the immutable commit. Do
  not amend the commit to backfill those results; that would change the state
  the gate verified.
- Omit empty headings, diff summaries, file lists, session transcripts,
  abandoned debugging paths, and agent, model, token, or task metadata.
- Never claim a test or check passed unless it was run.

## Commit size and shape

- Keep one concern per commit. If the subject needs "and", split the change.
- Do not mix mechanical output with semantic implementation. Generated
  catalogs, lockfiles, codemod output, and bulk evidence scaffolding belong in
  commits labeled as mechanical so reviewers can distinguish derived changes
  from decisions.
- Treat roughly 400 hand-written changed lines or 20 files as a soft review
  limit. If a semantic commit exceeds it, explain in the body why the change
  cannot be split without breaking its contract.
- Every published slice commit must pass its required gate on its own. A commit
  that cannot be checked independently is either too large or cut at the wrong
  boundary. Private slice checkpoints are the explicit exception below.
- Keep enforcement advisory unless a specific failure proves a mechanical rule
  is needed. Commit shape remains a review judgment, not a line-count contest.

## Private slice checkpoints and boundary gates

Use private checkpoints to protect small increments without multiplying the
authoritative gate cost. This rule was triggered by owner event
`5686d957a1d9c393f87c432bbcb370baa125c6ba432821af11b1e51627863b1f`,
after empty commit bodies and duplicate full-gate runs made the existing process
neither durable nor economical. The implementation lead owns the final boundary;
the independent reviewer re-derives its evidence.

- During one slice, commit coherent increments as `wip(<slice-name>): <step>`.
  Keep them private. Each checkpoint needs a meaningful body plus the normal
  human trailers, but no authoritative full gate. Narrow feedback such as
  `npx playwright test --only-changed <slice-base>` is permitted and must not be
  reported as boundary evidence.
- Run the finalizer once with `--dry-run`, then without it:

  ```sh
  cd frontend
  npm run finalize:slice -- --base <slice-base> --slice <slice-name> \
    --subject "<outcome>" --origin-event <buzz-event-id>
  ```

  The finalizer preserves checkpoint messages oldest-first, creates a recovery
  reference under `refs/buzz/slice-recovery/`, and atomically replaces the
  private checkpoints with one reviewable commit.
- Run `npm run check:ui` exactly once on that clean final commit. The runner
  rejects `wip(` commits in the publish range, records every stage's command,
  duration, dependency, machine-unit budget, port and worker ownership, result,
  and failure class beneath `frontend/.artifacts/ui-gate/`, and fails if source
  state moves during the run. A change to the runner itself may compare one
  serial and one parallel run at the same immutable commit; this is a measured
  parity experiment, not permission to duplicate routine boundary gates.
- The full gate defaults to the dependency graph in
  `agent-skills/ui-development/workflows.json`. One repository-wide machine
  lease admits the run, dedicated default ports and per-lane Playwright output
  directories prevent suite collisions, and the graph never exceeds its
  declared machine-unit budget. After the first failure no new stage starts;
  already-running stages finish and remain visible in the artifact.
  `npm run check:ui -- --serial` is the authoritative fallback. The output
  isolation was proven necessary by Buzz event
  `0dba585cd0ca6694d705175df1546eb1ae4637fc49811a406a90cdd5f31755c1`,
  where two correctly port-isolated lanes still collided while cleaning the
  same default Playwright artifact directory.
- Independent craft checks disclose their port and worker use and do not overlap
  an announced full gate. The machine lease covers canonical gate invocations;
  direct focused commands remain an explicit cross-agent coordination contract.
- Failure classification distinguishes proven environment signatures from the
  command's declared test, build, or check kind. It is triage evidence, not a
  claim about product root cause; `UI_GATE_FAILURE_CLASS` is a disclosed operator
  override.
- Never push a `wip(` commit. Continuous integration fetches full history and
  enforces the same publish-range rule.

The scheduling rule was triggered by the same owner event above after measured
gate runs showed that duplicate execution and cross-agent contention, rather
than the 25-stage contract, caused the waiting tax. The implementation lead owns
the graph and lease; the independent reviewer owns the matched-outcome check.

Proof: `npm run test:harness`, `npm run check:harness-integrity`, one clean
exact-commit `npm run check:ui -- --serial`, and one clean exact-commit
`npm run check:ui` from `frontend/` when the scheduler changes. Routine slices
run only the latter.

## Design-authority scope

The Candidate A design authority governs only the React platform shell:
platform-owned routes, reusable shell patterns, and the shell-side hosted-app
frame. It explicitly excludes child-app source, the app-factory
scaffold/prompts, and hosted `usernode-native/v1` consumers. Do not edit child
apps to demonstrate shell conformance.

## Migration evidence required per route

- deterministic fixture evidence for loading, success, empty/error and any
  capability/permission variation. Use Storybook for reusable presentation
  components and fixture-driven browser tests for routes, adapters, and
  host-contract behavior;
- desktop and mobile browser interaction evidence;
- accessibility scan with no critical or serious violations;
- an explicit compatibility note for route/hash/back behaviour.

## Commands

Legacy server tests remain authoritative for server behaviour:

```sh
npm test
```

React migration commands live in `frontend/` and will be listed in its
package manifest. Run only the narrowest relevant checks while iterating, and
run the full migration gate before handoff.

## Scope boundary

Do not delete `public/js`, legacy HTML, or any deployment route merely because
a new React screen exists. Removal requires the route-parity checklist in
`docs/react-migration.md` to be complete and reviewed.
