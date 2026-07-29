---
name: ui-development
description: Build or review a Social Vibecoding React UI slice while preserving platform contracts and using the official local shadcn/Base UI system. Use for React routes, components, visual refinements, component additions, Storybook states, browser/a11y verification, and design-system conformance in frontend/.
---

# UI development

Use this skill for the compiled React shell only. Treat legacy `public/js` as a
behavioural reference, never as a component import source.

## Workflow

1. From the repository root, run
   `node tool/ui-workflow.mjs --task "<plain-language task>"`. Follow its
   classified context, evidence, checks, and stop condition. Read
   [references/authority.md](references/authority.md) for component or
   authority work and [references/evidence.md](references/evidence.md) before
   handoff.
2. Read root `AGENTS.md`, `frontend/AGENTS.md`, the target route, its API or
   bridge contract, and its existing legacy implementation when one exists.
3. Query the resolved catalog before broad source search:
   `cd frontend && npm run query:design-system -- "<job or pattern>"`.
   Then inspect the matching source, `@/components/ui`, owned registry and
   existing stories before adding a primitive. Avoid printing or searching the
   entire generated catalog when a precise query is sufficient.
   Use the official shadcn/Base UI component where it fits. Compose an owned
   platform pattern only when the interaction is platform-specific.
4. Keep endpoint calls in `@/lib`; keep native bridge, iframe, cookie,
   service-worker, hash/deep-link, and browser-history behaviour explicit.
5. Implement loading, empty, error, permission/capability, narrow and desktop
   states. Keep one primary action per state and use accessible labels for icon
   actions. Use `PlatformIcon` for platform UI glyphs; reserve `AppIdentity`
   for application artwork.
6. Add deterministic evidence: stories for reusable presentation components;
   fixture-driven Playwright coverage for every changed route state or
   compatibility contract. Do not simulate complex route networking in a
   story merely to satisfy catalog coverage.
   When creating or changing an owned reusable platform pattern, update
   `frontend/design-system.manifest.json` with its export and named story
   states; the manifest is an explicit registry, not automatic discovery.
   Add a scoped performance contract only when the pattern owns a collection,
   streaming updates, a high-frequency interaction, or mount continuity.
   Record assumptions and flag later profiling; do not invent render-count,
   frame-rate, or timing thresholds during ordinary component work.
7. Run the narrowest relevant checks while working, then run the complete
   frontend gate before handoff.

When the executing agent has the `design` (ui.sh) or `taste` skill available,
use it as a review aid for composition, responsive behaviour, and polish. Do
not make either a prerequisite: this repository skill, its component registry,
and the checks below are the portable contract for all agents.

## Required checks

Run from `frontend/`:

```sh
npm run lint
npm run check:tokens
npm run check:design-system
npm run check:registry
npm run check:style-policy
npm run check:harness
npm run test:agent-battery
npm run typecheck
npm run test:e2e
npm run test:production-review
npm run build
npm run test:storybook
npm run check:bundle
```

Do not call a route migrated on visual similarity alone. Record the preserved
contract and check output in `docs/react-migration.md`.

## New component decision

Before creating a component, state one of these outcomes in the PR or handoff:

- Reused an existing official component.
- Extended an owned pattern because its documented contract already covers the
  new state.
- Created a named platform pattern because the interaction cannot be expressed
  as a supported composition; include its states, owner and migration scope.
