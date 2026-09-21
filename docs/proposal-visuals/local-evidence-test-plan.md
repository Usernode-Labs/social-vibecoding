# Local visual evidence test plan

## Goal

Exercise the same interaction replay and PNG/WebM generation used for proposal
visual evidence, then exercise the full issue-to-proposal flow on a local
Homeroom instance. A passing test must leave files a person can open and judge.
No model gives a relevance verdict.

This branch starts from main commit
`4472166f44e459c2503f1ddf52b992d37910ba9f` and carries the issue #2560
replay fixes and the human-review change. The local harness lives on
`b/visual-evidence-local-harness-main-2698` until those commits land.

## Boundaries

- The default test uses synthetic users and app state, with two real local Git
  commits for the demo app.
  It makes no production API calls and needs no model credentials.
- The fixture app, browser, capture image, and output files run locally in
  Milestone 1. Milestone 2 adds a local platform database. An optional OpenAI
  model adapter would make a remote API request; file-plan
  mode stays offline. The [Responses API](https://developers.openai.com/api/docs/quickstart)
  is the documented route for an automated GPT adapter. This interactive
  Codex task can also write or revise a plan file during development.
- A future read-only connector may copy selected issue/proposal metadata from
  the real platform into a local fixture. It must omit tokens, secrets,
  private app data, and personal messages. It must never copy a production
  database or write back to production.
- `verified` remains the internal name for passing replay checks. People
  inspect the captured media before deciding whether it supports a claim.
- The model's job is to turn an accepted user flow into a typed replay plan.
  The browser runner executes actions and creates PNG/WebM bytes without a
  model call. Submitting an author plan skips the separate evidence-agent
  dispatch, including its fallback model. The local lab will use that route.

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
   check out exact SHAs from a bare Git fixture without either call. Inject
   it at those two seams, keeping the production GitHub provider unchanged.
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
historically are available as local replay cases.** The read-only production
proposal listing identified PR #2548 (`evidence_agent_failed`), #2678
(`evidence_agent_timeout`), and #2688 (`evidence_agent_timeout`). Their exact
base and head SHAs are pinned in `scripts/local-visual-evidence/run-historical.js`.
The individual typed plans live alongside it. After setting up and starting
the local Homeroom stack, run one case with:

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
passes, then writes focused/context PNGs, paired WebMs, separate before/after
review WebMs, and a manifest with SHA/digest provenance under
`.local-visual-evidence/historical-<pr>-<run-id>/`. It removes temporary
containers and cloned databases after the run. Only Git source and selected
issue/proposal metadata came from the real platform; no production database,
user data, or model credential is imported.

The supplied plans have one visual checkpoint each, so their WebMs are short
before/after views rather than continuous recordings of a long interaction.

These cases establish whether deterministic replay and media generation can
show the real change when handed a valid plan. Codex wrote the plans here;
the historical evidence agent did not. A passing case does **not** mean the
old agent timeout/failure or the normal HTTP proposal path is fixed. The
remaining Milestone 2 route test and Milestone 3 planner test are the gates
for that claim. Human review is still required to decide whether the media
supports each change.

The run exposed a local fixture blocker: a newly seeded `usernode-capture`
member had no platform access, so authenticated captures loaded the waitlist
and its API requests returned 403. The seed now grants that non-interactive,
non-admin identity platform access on creation and repairs existing local
fixtures on boot. This failure was observed in local revision containers; the
historical proposal failure labels alone do not establish that it was their
production root cause.

## Milestone 3: GPT planning and optional real metadata

1. Keep the plan-file path as the deterministic baseline. Add an explicit
   `openai` planner adapter only for runs that ask for model-generated flows.
   It receives sanitized intent and local fixture URLs, returns a typed plan,
   and never returns a relevance verdict. Validate the plan with
   `parseReplayPlan` before submitting it through the author-plan route.
   Require a separately configured API key; do not add a hidden model call
   to every test. This route must not dispatch the platform's fallback model.
2. Add a read-only metadata importer for selected real issues/proposals.
   Save a small, redacted JSON fixture with stable local IDs. It may supply
   claims and steps, but local Git commits and local seeded app data remain
   the replay targets.
3. Run the same acceptance case in file-plan and GPT-plan modes. Record model
   usage separately from replay/capture time and bytes, so a planning failure
   is distinguishable from a PNG/WebM failure.

Acceptance: local replay remains reproducible without a model; a GPT-generated
plan can be substituted deliberately, and human inspection remains the only
semantic review of the media.

## Evidence to keep from each run

- The typed plan and its canonical hash.
- Fixture identity and, in Milestone 2, exact base/head Git SHAs.
- The two local Git commits, their bundle, and the app change patch.
- Each pass's result and diagnostics, plus the comparison verdict.
- Artifact names, MIME types, byte counts, and SHA-256 digests.
- The actual PNGs and WebM from pass two.
- Side-specific review WebMs derived from the verified paired WebM.

Milestone 1 uses real commit SHAs from a disposable local repository. The
manifest labels them as local fixture commits. Milestone 2 uses the same
provenance contract for a proposal registered in the local platform database.
