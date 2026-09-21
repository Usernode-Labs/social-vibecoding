# Local visual evidence test plan

## Goal

Exercise the same interaction replay and PNG/WebM generation used for proposal
visual evidence, then exercise the full issue-to-proposal flow on a local
Homeroom instance **with the normal evidence agent**. A passing test must leave
files a person can open and judge. No model gives a relevance verdict.

Keep two distinct results: deterministic capture validation, which supplies a
plan, and local agent validation, in which the selected model explores the
paired apps and submits its own plan through the normal evidence tools. Only
the second result addresses failures such as `evidence_agent_failed` and
`evidence_agent_timeout` that happen before capture.

This branch carries the issue #2560 replay fixes and the human-review change.
The local harness lives on `b/visual-evidence-local-harness-main-2698` until
those commits land. Use the PR's Git base and head SHAs to identify the exact
revision under review.

## Boundaries

- The default test uses synthetic users and app state, with two real local Git
  commits for the demo app.
  It makes no production API calls and needs no model credentials.
- The fixture app, browser, capture image, output files, and platform database
  run locally. Deterministic plan-file mode is offline. A full agent run calls
  the selected model provider using a separately configured test credential;
  it does not use this interactive Codex conversation as an API.
- A future read-only connector may copy selected issue/proposal metadata from
  the real platform into a local fixture. It must omit tokens, secrets,
  private app data, and personal messages. It must never copy a production
  database or write back to production.
- `verified` remains the internal name for passing replay checks. People
  inspect the captured media before deciding whether it supports a claim.
- The model's job is to turn an accepted user flow into a typed replay plan.
  The browser runner executes actions and creates PNG/WebM bytes without a
  model call. An author plan skips evidence-agent dispatch and is valid only
  for the deterministic baseline. It cannot count as a normal-flow agent test.
- A GPT test is useful when GPT is the selected, tool-capable model on the
  production `codex_openrouter` worker path. A standalone GPT planner that
  returns JSON for the author-plan route would skip the worker, evidence MCP
  tools, browser exploration, timeout, and fallback behavior. It cannot be a
  parity gate. If direct OpenAI API support is wanted, add it as a real agent
  backend first, then test that backend through the same evidence tools.

## Milestone 1: runnable capture contract

**Status: implemented and exercised locally.** Run
`npm run test:visual-evidence:local`.

Prerequisites: Docker Engine running and repository dependencies installed
with `npm ci`. The command pulls its Node fixture image if needed and builds
the repository's capture image on first use. Fixture servers have no host
ports; the run creates and removes its own Docker network.

1. Create a disposable local Git repository with two exact commits of the
   demo app. The head commit adds a username suggestion after the user opens
   Invite and types into the dialog; the base commit does not. Start each
   checkout in its own isolated container with the same initial state.
2. Feed a checked-in, typed replay plan to the actual capture image and
   `evidence/replay-runner.js`. Recreate both app containers between passes.
3. Use `src/services/visual-evidence-replay.js` to parse each run, enforce
   the plan hash, compare the two clean passes, and require the exact PNG/WebM
   artifact set.
4. Write the second pass's focused/context PNGs, paired WebM, and a manifest
   to `.local-visual-evidence/<run-id>/`. Also save the local Git bundle and
   change patch, and split the paired WebM into individual before and after
   review videos. The manifest must identify this as a **local Git fixture**
   run, not a real proposal revision.
5. Verify that the command exits nonzero on a replay or media failure, cleans
   up its containers/network, and leaves no success manifest on failure.

Run it with:

```sh
npm run test:visual-evidence:local
```

Acceptance: the command reports two matching passes and produces four PNGs,
one paired WebM, and two playable side-specific review WebMs. A person can
compare before/after directly. This
milestone isolates browser, crop, animation, encoding, protocol, and replay
failures from platform scheduling or model failures.

To try another deterministic flow, copy
`scripts/local-visual-evidence/plan.json`, edit its typed actions and
assertions, then run
`npm run test:visual-evidence:local -- --plan /absolute/path/to/plan.json`.
The fixture app is in `scripts/local-visual-evidence/fixture-app.js`; change
the base UI there and update the single-commit change at
`LOCAL_EVIDENCE_CHANGE_POINT` in `run.js` when testing another behaviour.
This mode exercises
the real capture path without booting Homeroom or calling any model.

The first run found a real platform defect: the browser runner included a
null optional provenance field that the replay comparison did not expect.
The comparison now normalizes that field. A subsequent Git-backed run
produced four PNGs, a 1.5-second, 4 fps VP9 paired WebM, and two individual
VP9 review videos. A deliberately broken selector exited nonzero without
leaving a success manifest, container, or Docker network.

## Milestone 2: local Homeroom and proposal fixture

**Status: local database/coordinator path exercised; HTTP author-plan and
authenticated card review still pending.** To create a local-only development
config and boot the platform, run:

```sh
npm run visual-evidence:local-setup
make up
npm run test:visual-evidence:platform-local
```

The setup command creates an ignored `.env` with generated secrets if no
`.env` exists; it refuses to replace another configuration. The capture
command checks that local configuration, then creates a labeled demo app,
issue, and proposal in the local database and leaves them there for
inspection. It injects only local Git resolution, fixture runtime
provisioning, and fixture identities. The production coordinator, state
transitions, two-pass replay, artifact persistence, and view serializer run
unchanged. Its output includes the paired WebM and separate before/after
review videos. The tested run reached `verified` with five stored artifacts
and zero evidence-agent attempts.

The normal issue creation route requires a GitHub twin, and the normal
author-plan route currently invokes GitHub-backed revision provisioning.
This command seeds local test records and invokes the same author-plan
coordinator path directly. Finish the following steps before calling the
entire HTTP issue-to-proposal flow local and offline:

1. Add a local-only repository provider for evidence runs. Today
   `resolveRevisionContext` calls GitHub for the comparison and
   `checkoutExactRevision` in `visual-evidence-environment.js` gets a GitHub
   clone URL directly. The local provider must resolve changed files and
   check out exact SHAs from a bare Git fixture without either call. The
   **normal agent run also requires** `worker.js`'s warm bootstrap to clone
   that same fixture; cover its public-repo check and clone URL with the
   local provider. Serve the fixture Git repository on the isolated Docker
   network so both platform and worker can reach it. Keep production GitHub
   behavior unchanged and require an explicit local-only configuration guard.
   Fence every outbound GitHub mutation too: scheduling calls the PR-body
   evidence-link sync, so a lab session must never point that call at a real
   pull request.
2. Add a dedicated Compose overlay for the existing `docker-compose.dev.yml`
   stack. Keep it on a separate network and local volumes so it cannot share
   data with another development stack. Supply generated local-only secrets
   through an ignored env file. Document the native node sidecar dependency
   and provide a preflight that reports precisely what is missing.
   The current local stack boots with generated local-only keys and a Quay
   mirror for its pinned MinIO image. Its native node sidecar is unavailable
   in this checkout; the direct capture harness does not need that sidecar.
3. Route local test issue/proposal creation through a dedicated local-only
   API adapter, so the standard author-plan HTTP route can schedule the same
   two exact commits without a GitHub issue or pull request. Keep local
   fixture records visibly labeled and never enable this adapter in a
   production configuration.
4. Exercise the author-plan route, evidence run state transitions, artifact
   storage, authenticated media routes, and the proposal card. Export the
   resulting captures into the same local output directory for inspection.
5. Test a changed head, a broken selector, a missing artifact, and a failed
   WebM encoding. Each case must show a specific failure and never publish a
   home-page or stale-head substitute.

Acceptance: one local command creates an issue and proposal and reaches a
`Captured` card with the five media artifacts. No GitHub PR or production
service is required.

## Historical merged-change replay

**Status: three real revisions from proposals whose visual evidence failed
historically pass local replay.** Read-only production proposal records
identified PR #2548 (`evidence_agent_failed`), #2678
(`evidence_agent_timeout`), and #2688 (`evidence_agent_timeout`). Their exact
base and head SHAs, accepted claims, viewports, and media types are pinned in
`scripts/local-visual-evidence/historical-cases.json`. Each typed plan is
checked against that snapshot before replay, so a local test cannot silently
omit a claim or turn a screenshot request into a video. After setting up and
starting the local Homeroom stack, run one case with:

```sh
npm run test:visual-evidence:historical -- 2548
npm run test:visual-evidence:historical -- 2678
npm run test:visual-evidence:historical -- 2688
```

The command fetches any missing Git objects, verifies each clean checkout's
full SHA, builds both exact Docker revisions, snapshots the **local** database,
and starts each revision against a separate clone. It mints the platform's
normal short-lived capture JWTs for that local data. It runs the production
browser replay and encoder twice, rebuilding the database clones between
passes, then writes focused/context PNGs and a manifest with SHA/digest
provenance under
`.local-visual-evidence/historical-<pr>-<run-id>/`. It removes temporary
containers and cloned databases after the run. Only Git source and selected
issue/proposal metadata came from the real platform; no production database,
user data, or model credential is imported.

The #2678 and #2688 claims request `animation: none`; each produces four PNGs
and **no WebM**. Two #2548 claims also produce PNGs only. Its third claim
requests `animation: steps`, so the browser records the actual Settings,
Home, and Improve interaction on both revisions and produces a paired WebM
for each viewport. A wait-only plan cannot request a steps video, and replay
rejects a recording with no visible interaction. `animation: motion` likewise
requires changing captured frames. The proposal card mentions video only
when one was produced.

These cases establish whether deterministic replay and media generation can
show the real change when handed a valid plan. Codex wrote the plans here;
the historical evidence agent did not. The live failures happened before any
capture artifacts were produced. A passing local replay does **not** prove
that the live evidence agent will author a valid plan or complete before its
timeout. Milestone 3 must repeat at least one historical case without handing
the agent that plan. Human review is still required to decide whether the
media supports each change.

The run exposed a local fixture blocker: a newly seeded `usernode-capture`
member had no platform access, so authenticated captures loaded the waitlist
and its API requests returned 403. The seed now grants that non-interactive,
non-admin identity platform access on creation and repairs existing local
fixtures on boot. This failure was observed in local revision containers; the
historical proposal failure labels alone do not establish that it was their
production root cause.

## Milestone 3: normal evidence agent on the local platform

**Status: not implemented; local model access is blocked.** The current local
platform command injects a fixture environment, identities, and worker, and
submits `authorPlan`. Its assertion that `agentAttempts === 0` confirms it
bypasses the failure-prone agent path. The historical command invokes replay
directly. Neither is a normal-flow agent test.

The current checkout has no locally usable model credential. The user's
Homeroom-managed model access is kept server-side and cannot be supplied to a
local worker through the existing user API. An account-scoped inference relay
does not exist. Therefore a local model request cannot be made through the
normal worker yet; the deterministic successes above must not be presented as
agent-path successes. A production rerun of historical proposal #2548 reached
agent exploration and then failed with `evidence_agent_timeout`. That rerun
used the deployed production code, not this branch, and exposed no trace that
proves a successful model request/response. Importing this PR builds and
checks its app revision, but the imported proposal's evidence run is scheduled
by Homeroom's already deployed coordinator and worker. An import alone does
not exercise this branch's evidence agent with managed model access.

| Part of the live flow | Current local coverage | Needed for agent parity |
| --- | --- | --- |
| Exact base/head source and reproducible PNG/WebM replay | Synthetic and historical runs | Keep as the fast baseline |
| Durable coordinator and stored artifacts | Synthetic author-plan run | Exercise without `authorPlan` |
| Real revision provisioning and app database resets | Historical runner has its own setup; synthetic coordinator replaces the environment | Use `visual-evidence-environment` |
| Hosted worker, model, and evidence/browser tools | Skipped | Use the actual worker and selected model |
| Authenticated evidence route and proposal card | Pending | Check the reviewer-visible result |

1. Complete the Milestone 2 local Git provider and isolated platform stack.
   Seed a real fixture app database and proposal session with exact base/head
   SHAs, accepted visual intent, a local test identity, and the intended agent
   backend/model. Use the production environment service for app-secret
   resolution, image builds, database clone/reset, deploy, and cleanup. Inject
   the local Git provider only where remote repository resolution is needed;
   do not replace the environment, worker, identity, or replay services with
   fixture implementations for this mode.
2. Provide a real model-access path to the local worker: either configure a
   test-scoped credential in the local credential store or implement an
   account-scoped inference relay that uses Homeroom-managed access. The relay
   would be a separate platform feature requiring deployment, authorization,
   usage limits, and billing safeguards; it cannot be simulated by this
   harness. For `codex_openrouter`, set the backend flag and a tool-capable
   model, then run the repository's actual worker image with
   `mode: evidence`. If Claude is the selected live backend, test Claude too.
   Report an unavailable credential or unsupported model as a preflight
   failure; do not silently call a different model and label it equivalent.
3. Trigger the local proposal's normal rerun/preview route **without**
   `authorPlan`. The orchestrator must dispatch `visual-evidence-agent`, and
   the worker must use its normal `evidence_get_context`, base/head browser,
   `evidence_reset_side`, and `evidence_run_plan` tools. The platform must
   perform the same two clean replays, store the artifacts, and serve them on
   its authenticated evidence routes and proposal card. Run this once for the
   synthetic UI change and at least once for a historically failed revision,
   without exposing its previously hand-written replay plan to the model.
4. Record enough provenance to prove which path ran: selected and actual
   backend/model (including any fallback), prompt/worker contract revision,
   evidence tool call count, submitted plan/hash, base/head SHAs, fixture and
   image digests, two replay-pass results, artifact MIME types and bytes,
   agent time, replay time, and model usage. Add these fields to the local
   manifest and safe run trace where absent. Redact tokens and private data.
   `agentAttempts > 0` alone is insufficient: a failed dispatch increments it
   before the worker ever calls `evidence_run_plan`.
5. Make the local command fail unless the model actually submitted a plan
   through `evidence_run_plan`, two fresh passes agreed, and the authenticated
   reviewer view exposes precisely the requested PNGs and any genuine
   interaction WebMs. Exercise timeout, broken selector/repair, stale head,
   worker bootstrap failure, and missing credential as distinct failures.
   Deterministic model/tool stubs are suitable for these fault tests, but a
   stubbed success cannot satisfy the normal-flow acceptance gate.

Acceptance: a single opt-in local command runs the normal evidence agent and
worker against isolated local app revisions and data, records the actual model
backend, and leaves reviewable media. The default deterministic commands stay
cheap and credential-free. This acceptance cannot be claimed until a real
local model-access path exists. A branch-specific platform and worker
environment with managed model access is another way to test before merge;
the ordinary app PR import only checks and previews the branch revision.

## Release gate and remaining differences

Use the deterministic run after capture, replay, or encoding edits. Use the
opt-in normal-agent run after planner, prompt, worker, provisioning, auth, or
orchestrator edits. Repeat a historically failed case before proposing a fix
for an agent failure. Then run one normal proposal in a **branch-specific
platform and worker staging environment** with the intended model access,
before merge. The ordinary app PR import does not supply this gate: its
evidence coordinator still runs deployed code, and the staged app cannot
build nested previews. A local Docker run cannot prove behavior in the
production Kubernetes worker runtime, live routing, or the actual user's
credential/model choice. Until this branch-specific gate exists and passes,
live evidence-agent reliability remains unverified.

PR #2709 was initially imported as proposal 4675 at head
`eabe9b70d4118556b0372739b23f0855233ee401`. Its staging preview and
checks passed, but no visual claim was accepted on that proposal and Homeroom
recorded that there was nothing to run. This validates the branch's build and
declared checks, not its new evidence-agent path.

## Evidence to keep from each run

- The typed plan and its canonical hash.
- Fixture identity and, in Milestone 2, exact base/head Git SHAs.
- The two local Git commits, their bundle, and the app change patch.
- Each pass's result and diagnostics, plus the comparison verdict.
- Artifact names, MIME types, byte counts, and SHA-256 digests.
- The actual PNGs and any declared WebM from pass two.
- Side-specific review WebMs only when a paired WebM exists.

Milestone 1 uses real commit SHAs from a disposable local repository. The
manifest labels them as local fixture commits. Milestone 2 uses the same
provenance contract for a proposal registered in the local platform database.
