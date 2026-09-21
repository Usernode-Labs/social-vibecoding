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

- The default test uses synthetic users, app state, issue text, and commits.
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

1. Start two isolated local fixture apps with the same initial state. The
   head variant adds a username suggestion after the user opens Invite and
   types into the dialog; the base variant does not.
2. Feed a checked-in, typed replay plan to the actual capture image and
   `evidence/replay-runner.js`. Recreate both app containers between passes.
3. Use `src/services/visual-evidence-replay.js` to parse each run, enforce
   the plan hash, compare the two clean passes, and require the exact PNG/WebM
   artifact set.
4. Write the second pass's focused/context PNGs, paired WebM, and a manifest
   to `.local-visual-evidence/<run-id>/`. The manifest must identify this as
   a **synthetic** fixture run, not a real proposal revision.
5. Verify that the command exits nonzero on a replay or media failure, cleans
   up its containers/network, and leaves no success manifest on failure.

Run it with:

```sh
npm run test:visual-evidence:local
```

Acceptance: the command reports two matching passes and produces four PNGs
plus one playable WebM. A person can compare before/after directly. This
milestone isolates browser, crop, animation, encoding, protocol, and replay
failures from platform scheduling or model failures.

To try another deterministic flow, copy
`scripts/local-visual-evidence/plan.json`, edit its typed actions and
assertions, then run
`npm run test:visual-evidence:local -- --plan /absolute/path/to/plan.json`.
The fixture app is in `scripts/local-visual-evidence/fixture-app.js`; change
both variants there when testing another UI behaviour. This mode exercises
the real capture path without booting Homeroom or calling any model.

The first run found a real platform defect: the browser runner included a
null optional provenance field that the replay comparison did not expect.
The comparison now normalizes that field. A subsequent run produced four
PNGs and a 1.5-second, 4 fps VP9 WebM. A deliberately broken selector exited
nonzero without leaving a success manifest, container, or Docker network.

## Milestone 2: local Homeroom and proposal fixture

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
3. Create a tiny Git fixture app with two commits and deterministic seed data.
   Register it through the local platform, create an issue locally, and
   submit a local proposal pointing to those exact commits. Use the same
   visual intent and replay plan as Milestone 1.
4. Exercise the author-plan route, evidence run state transitions, artifact
   storage, authenticated media routes, and the proposal card. Export the
   resulting captures into the same local output directory for inspection.
5. Test a changed head, a broken selector, a missing artifact, and a failed
   WebM encoding. Each case must show a specific failure and never publish a
   home-page or stale-head substitute.

Acceptance: one local command creates an issue and proposal and reaches a
`Captured` card with the five media artifacts. No GitHub PR or production
service is required.

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
- Each pass's result and diagnostics, plus the comparison verdict.
- Artifact names, MIME types, byte counts, and SHA-256 digests.
- The actual PNGs and WebM from pass two.

The runner may use synthetic 40-character fixture revision labels in
Milestone 1 because its input contract requires SHA-shaped provenance. The
manifest must say so. Milestone 2 replaces them with real Git commit SHAs.
