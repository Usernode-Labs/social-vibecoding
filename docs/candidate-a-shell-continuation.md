# Candidate A shell continuation record

## Decision

Continue Candidate A for the Social Vibecoding React **platform shell only**.
The authority includes platform-owned routes, reusable shell patterns, and the
shell-side hosted-app frame. It excludes child-app source, app-factory
scaffolds/prompts, and existing `usernode-native/v1` consumers.

## Authorization basis

The product owner explicitly requested on 2026-07-29 that Candidate A's missing
design authority and agent-lifecycle evidence be completed while narrowing the
plan to the shell and deferring the app-factory boundary.

## Historical continuation evidence at `bb47cbe`

- Canonical DTCG tokens: `frontend/design-system/tokens.json`
- Resolved authority/catalog: `frontend/design-system/authority.json` and
  `frontend/design-system/catalog.json`
- Owned shadcn registry: `frontend/registry.json` and generated
  `frontend/public/r`
- Enforcement: token, catalog, registry, style-policy and architecture checks
- Executable component catalog: 37 Storybook files / 135 named states pass in
  Chromium with axe assertions enabled; the catalog production build also
  passes
- Portable workflow: `agent-skills/ui-development` and
  `tool/ui-workflow.mjs`
- Agent battery:
  `frontend/design-system/evidence/candidate-a-shell-battery.json`
  — T1–T5 pass; deliberate violation enforcement is 5/5
- Fresh-agent battery:
  `frontend/design-system/evidence/candidate-a-shell-live-agent-battery.json`
  — T1–T5 pass using separate Codex CLI turns
- Retry and intervention ledger:
  `frontend/design-system/evidence/candidate-a-shell-live-agent-retries.json`
  — 1,157,008 lifecycle input tokens, 291,980 ms known execution time,
  two retries, and two harness interventions

The 37 Storybook files / 135 named states above are the preserved measurements
from the `bb47cbe` continuation checkpoint. They are not current catalog totals.

## Current refinement evidence

- Home/Explore split: `a989984`
- M7a platform drawer and focused-frame continuity: `e6c05ab`
- M6c quiet refinement plus its separately scoped integrity/contrast follow-up:
  `13f74d6`
- Activity unification over the existing notifications transport:
  `0eb307f`, with design-authority alignment in `1becfcb`
- M7b/M11 contextual app chrome and route composition: `c0fb2c4`
- M7 closure sweep removing duplicate recovery navigation: `bd6e380`
- Host cutover no-go record: `cc6d3d9` and
  `docs/shell-host-cutover-evidence.md`
- Current authority: 44 manifest patterns, 12 component performance
  contracts, 2 registry entries, and style-policy coverage over 163 modules
- Agent lifecycle: T1–T5 passes 5/5, including deliberate T4 enforcement at
  5/5
- Current harness extension: T1–T8 passes 8/8. T6 discovers reviewed component
  relationships, T7 composes content/component/review workflows, and T8 proves
  skill/adapters/package-script/CI integrity. The live run records the exact
  harness fingerprint and does not claim Claude behavioral execution.
- Fresh Codex behavioral run: 7/7 tasks pass within the pre-registered 275,000
  input-token ceiling per task (1,028,847 total; exact cached-token detail is
  retained in the JSON evidence). The
  deterministic T8 supplies self-integrity proof rather than spending another
  model turn on a mechanical check.
- Current Storybook verification: 47 files / 228 tests
- Browser verification: 655 passed, 53 intentional skips, 0 failed
- Production-readonly review: 40/40 passed
- Native bridge contract: 8/8 passed
- Production build: 2,074 modules transformed
- Initial React JavaScript: 142.2 KiB gzip against the 160 KiB budget
- Cutover contract: 9 verified, 0 failed, with 1 explicit
  `native-webview-e2e` blocker

M6c is complete. M7 is complete only at `c0fb2c4`: `e6c05ab` supplied M7a,
while `c0fb2c4` supplied M7b and the route-composition work recorded as M11;
`bd6e380` is the final narrow source-sweep follow-up. The intended shell routes
now use the shared `PageHeader` and available-width canvas. Login, Register,
`HostedApp`, `StagingPreview`, and `NotFound` are explicit semantic/layout
exceptions rather than unfinished bulk migration.

Activity is the canonical product label. The `/react/notifications` route,
notification API, live events, pagination, and internal module/type names are
retained compatibility boundaries, not a separate product concept.

## Execution record

- Branch: `codex/react-shadcn-migration`
- Baseline commit: `808f7da68ddd563563bc7152fb6db3e0ee9933ae`
- Technical executor: Codex current task
- Technical attestation date: 2026-07-29
- Retries/interventions: recorded in the battery evidence
- Token telemetry: Codex CLI JSONL supplied per-task usage for the live
  battery. The deterministic in-process battery still marks tokens
  unavailable because that host surface does not expose them.

## Conditions

This record authorizes continued shell work, not production cutover and not an
app-factory design system. Native WebView, iframe/bridge, authentication,
offline/service-worker, visual-baseline, and route-retirement proofs remain
independent gates. New tokens, primitive categories, or exception categories
require shell design-system approver review.

The implemented browser/static portion of M8 is proven. The cutover contract
still reports the explicit `native-webview-e2e` blocker, so G6 remains a host
no-go. M9 Motion remains deferred and M10 cutover/legacy-shell retirement
remain no-go. Do not interpret this continuation record as release
authorization.

Technical attestation: **Codex — 2026-07-29**

Product continuation authorization: **recorded from the user's explicit
instruction in the current task; final release approval remains separate.**

This is a human-readable technical attestation, not a cryptographic signature.
The historical live-agent run lacked a pre-registered token ceiling; that
deviation and the exact observed usage are retained in the retry ledger. Any
new live-agent battery must record its ceiling before execution.
