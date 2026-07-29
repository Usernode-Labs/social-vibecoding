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
- `frontend/design-system/components.json` — component ownership and contracts.
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

## Scope boundary

This branch governs the **Social Vibecoding platform shell**. It does not create
the app-factory design system for hosted child apps, replace
`usernode-native/v1`, retire legacy routes, or claim production WebView cutover.
Those are recorded as later work rather than being hidden inside this example.

## Replaying the rewrite

From `frontend/`:

```bash
npm ci
npm run check:authority
npm run check:architecture
npm run check:styles
npm run typecheck
npm run test:storybook
npm run test:e2e
npm run build
npm run agent:battery
```

For the guided agent workflow:

```bash
node tool/ui-workflow.mjs start
node tool/ui-workflow.mjs verify
```

The branch history is intentionally split into intent-based commits: discovery
and charter, governed shell implementation, portable harness and CI, and final
verification record. This makes each milestone reviewable without pretending
that every intermediate experiment deserved preservation.
