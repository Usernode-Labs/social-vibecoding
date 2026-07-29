# React shell rewrite record

This directory makes the rewrite understandable and repeatable. It preserves the
intent that led to the work, the user-visible evidence used to scope it, the
reviews that changed the plan, and the verification contract used to decide
whether the approach should continue.

It is not a second product specification. Current implementation rules live in
the repository `AGENTS.md`, the frontend `AGENTS.md`, the design-system
authority under `frontend/design-system`, and the portable
`agent-skills/ui-development` skill.

## The progression of intent

1. **Understand the existing product before choosing components.**
   The code index and screenshot audit identify what users encounter, not merely
   which CSS classes happen to exist.
2. **Commit explicitly to a React candidate.**
   The decision plan and pre-registration record define Candidate A as a React,
   shadcn, Base UI, Tailwind, Storybook stack and define measurable rejection
   criteria.
3. **Prove one evolutionary slice.**
   The Apps home and platform-shell slice keeps familiar information
   architecture while replacing presentation with official primitives and one
   restrained theme.
4. **Expand shell parity without deleting the legacy frontend.**
   Authentication, catalog, community, development, administration, settings,
   and feedback routes were moved behind adapters while the old frontend
   remained the fallback.
5. **Turn visual consistency into design authority.**
   Canonical DTCG tokens, an owned shadcn registry, component metadata,
   architecture/style policies, Storybook scenarios, and CI make the rules
   inspectable and enforceable.
6. **Prove that agents can operate the system.**
   The T1–T5 battery tests discovery, reuse, composition, violation detection,
   and repair. The continuation record states what passed and what remains
   outside this branch.

## What is authoritative now

- `AGENTS.md` — repository-wide migration boundaries.
- `frontend/AGENTS.md` — frontend-specific working rules.
- `frontend/design-system/tokens.json` — canonical token source.
- `frontend/design-system.manifest.json` →
  `frontend/design-system/authority.json` →
  `frontend/design-system/catalog.json` — component ownership and contracts.
- `frontend/registry.json` — owned shadcn registry index.
- `agent-skills/ui-development/SKILL.md` — portable agent workflow.
- `docs/candidate-a-shell-continuation.md` — continuation decision and remaining
  blockers.

## Historical evidence

- [`inception/`](inception/) contains the planning, discovery, and option-space
  documents. Some alternatives there were intentionally not pursued.
- [`reviews/`](reviews/) contains the substantive reviews that tightened the
  decision mechanics, accessibility posture, and verification loop.
- [`visual-baseline/`](visual-baseline/) contains the curated shell-facing
  screenshots used to identify routes, states, and interaction patterns.

Historical documents are evidence of reasoning, not current instructions. When
they conflict with current authority, current authority wins.

The exact intent-based commit sequence and post-commit proof are recorded in
[`MILESTONES.md`](MILESTONES.md).

## Current refinement checkpoint

The original verified checkpoint at `bb47cbe` remains historical evidence.
The current shell authority has since grown to 44 manifest patterns,
12 component performance contracts, 2 owned registry entries, and style-policy
coverage over 162 modules. The fresh catalog run covers 47 Storybook files /
228 tests. The T1–T5 agent battery passes 5/5, including T4 deliberate
enforcement at 5/5.

The current user-facing destination is **Activity**. The existing
`/react/notifications` route, notification API, live events, pagination, and
internal module names remain compatibility contracts; they do not define the
product label.

Home/Explore and the M6c quiet pass are complete. M7 closes only with M7a
`e6c05ab` plus M7b/M11 `c0fb2c4`; platform navigation, contextual app chrome,
and the intended route-wide `PageHeader`/available-width composition are now
committed. The closure sweep in `bd6e380` removes the last duplicate recovery
navigation control. Login, Register, `HostedApp`, `StagingPreview`, and
`NotFound` are documented semantic/layout exceptions. Activity unification is
committed and its authority is aligned in `1becfcb`.

Host-cutover preparation now continues through `0e5617c`: relay provenance and
host contracts, service-worker/session isolation, exact-artifact deployment,
deliberate legacy-shortcut deferral, complete CI authority gates, a sanitized
physical-device runbook, and trusted-frame external navigation are committed.
These are browser and pipeline contracts; they do not close physical G6.

The current verification record is: 727 browser tests passed, 53 intentionally
skipped, 0 failed; the complete root suite passed 3,277/3,277;
production-readonly review passed 40/40; native bridge contract passed 8/8;
Storybook passed 228/228; and the initial React JavaScript is 4.1 KiB gzip
against the 160 KiB budget. The cutover contract reports 10 verified, 0 failed,
with one explicit `native-webview-e2e` blocker. Production cutover therefore
remains a G6 no-go under
[`../shell-host-cutover-evidence.md`](../shell-host-cutover-evidence.md);
Motion is deferred and legacy-shell retirement is not authorized.

## Scope boundary

This branch governs the **Social Vibecoding platform shell**. It does not create
the app-factory design system for hosted child apps, replace
`usernode-native/v1`, retire legacy routes, or claim production WebView cutover.
Those are recorded as later work rather than being hidden inside this example.

## Replaying the rewrite

From `frontend/`:

```bash
(cd .. && npm ci)
npm ci
npm run build:tokens
npm run build:catalog
npm run build:registry
npm run lint
npm run check:tokens
npm run check:design-system
npm run check:registry
npm run check:style-policy
npm run test:content
npm run check:content
npm run check:harness
npm run test:agent-battery
npm run typecheck
npm run test:storybook
npm run check:storybook-build
npm run test:e2e
npm run test:production-review
npm run test:native-bridge-contract
npm run test:service-worker-contract
npm run build
(cd .. && npm test)
npm run check:bundle
npm run check:cutover-contract
```

`npm run check:cutover-ready` is deliberately not part of the passing replay
set. It must fail while G6 remains closed; a later cutover candidate runs it as
the final no-blocker assertion rather than weakening its requirements.

For the guided agent workflow:

```bash
node tool/ui-workflow.mjs --task "<task>"
node tool/ui-workflow.mjs --task "<task>" --json
```

The branch history is intentionally split into intent-based commits: discovery
and charter, governed shell implementation, portable harness and CI, and final
verification record. This makes each milestone reviewable without pretending
that every intermediate experiment deserved preservation.
