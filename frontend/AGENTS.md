# React shell guide

This directory is the staged React replacement for the legacy static shell.

## Boundaries

- Candidate A governs the platform shell, platform-owned routes, reusable
  shell patterns, and the shell-side hosted-app frame. It does not govern
  child-app source, app-factory scaffolds/prompts, or existing
  `usernode-native/v1` consumers.
- Keep all existing API, session-cookie, native bridge, iframe, service-worker,
  hash URL, and external-link contracts working while their consumers migrate.
- Put server reads/writes in `@/lib`; components do not call endpoints directly.
- Start with the official local shadcn/Base UI primitives in `@/components/ui`.
  Compose an owned platform pattern before introducing a new primitive.
- Use `PlatformIcon` for platform navigation, actions, status, and inline UI
  glyphs. `AppIdentity` is the separate, deliberately larger application
  artwork contract; do not use it as a generic interface icon.
- Every reusable presentation component needs named state evidence in
  Storybook before reuse. Every migrated route needs deterministic desktop
  and mobile browser coverage. Route-only orchestration is evidenced by its
  fixture-driven browser tests, not a fake Storybook network environment.
- Dev conversations use the official `MessageScroller`, `Message`, `Bubble`,
  `Marker`, and `Attachment` components. The scroller owns anchoring and
  jump-to-latest behavior; no route may add a competing scroll hook.
- `@shadcn/helpers/ai-sdk` is for deterministic Storybook and test
  conversations only. Production Dev state remains behind an owned API / SSE
  adapter until reconnect and capability contracts migrate.
- The React Dev composer uses only `@/lib/dev-chat-api.ts`: upload attachments
  before a turn, then start the server's existing primary SSE while the owned
  `EventSource` adapter renders the resumable session-bus feed. Do not add a
  second streaming protocol or call Dev endpoints from components.
- Treat platform governance and GitHub issues as separate domains. Governance
  uses database proposal IDs and legacy `dev/governance/:id`; GitHub issues
  use issue numbers and legacy `dev/issues/:number`. Do not share route
  builders, detail lookups, or mutation assumptions between them.
- Do not import files from legacy `public/js` into React. Adapt its API contract
  instead, and leave the legacy route reachable until parity is explicitly met.

## Commands

```sh
npm run lint
npm run check:tokens
npm run check:design-system
npm run check:relationships
npm run check:registry
npm run check:style-policy
npm run check:harness
npm run check:harness-integrity
npm run test:harness
npm run test:agent-battery
npm run typecheck
npm run test:e2e
npm run test:production-review
npm run test:native-bridge-contract
npm run test:service-worker-contract
npm run build
npm run check:bundle
npm run test:storybook
npm run check:cutover-contract
npm run check:ui
```

`npm run test:e2e` is a fixture-driven parity check, not proof of live native
WebView behavior. Add a host-level contract test when changing bridge, iframe,
safe-area, history, authentication, or offline behavior.

## Owned pattern registry

`design-system/tokens.json` is the canonical DTCG token source.
`design-system.manifest.json` lists reusable owned platform patterns and named
Storybook states; `design-system/authority.json` resolves that manifest into
the governed `design-system/catalog.json`. `registry.json` is the owned shadcn
CLI distribution surface. `design-system/relationships.json` records reviewed
keep-distinct, extend, supersede, and remove decisions by user job and
substitution boundary; visual similarity alone is not a consolidation reason.
Update the appropriate authority source with a
pattern's public export or deterministic state evidence, regenerate its
derived artifact, and run the full authority checks. These files validate
listed shell contracts; they do not infer or govern child-app components.

Add an optional `performance` authority override only for a collection,
streaming surface, high-frequency interaction, or component with meaningful
mount continuity. Record the expected collection class, update frequency,
state scope, virtualization decision, mount policy, sensitive interactions,
and follow-up point. Do not invent timing targets or add contracts to ordinary
primitives. `review-later` marks components such as the Dev board for later
profiling; it does not authorize speculative memoization or make performance a
current CI timing gate.

## Content authority

`design-system/content-guidelines.md` is the human writing authority for the
platform shell. Text-bearing registered patterns may opt into the small
`content` contract in `design-system/authority.json`; the resolved metadata is
published in `design-system/catalog.json`. It records layer, canonical terms,
required states, accessible-name policy, and reviewed failure modes only.

Run `npm run check:content` and `npm run test:content` when changing shell
copy, labels, or text-bearing patterns. The checker is intentionally limited
to static high-confidence regressions. Do not add a broad stylistic lint or
apply it to child-app code. Existing migration copy belongs in the exact,
owned, expiring `design-system/content-exceptions.json` ledger until the route
gets a separately reviewed replacement.

## Portable agent harness

`agent-skills/ui-development/workflows.json` is the canonical composable task
router and full-gate authority. `node tool/ui-workflow.mjs --task "<task>"`
may select several workflows; follow all of them. `npm run check:ui` executes
the same full gate CI is required to expose. `npm run
check:harness-integrity` validates the skill package, context paths, package
scripts, CI parity, `.agents`/`.claude`/`.codex` adapters, and live-battery
fingerprint. `check:harness` remains the source architecture boundary and is
not a substitute for harness self-integrity.
