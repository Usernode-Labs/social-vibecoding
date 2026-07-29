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
   complete `classifications` list: workflows compose, so a copy-bearing
   component review follows content, component, and review guidance rather
   than choosing one bucket. Follow the resolved context, evidence, checks,
   and stop conditions. Read
   [references/authority.md](references/authority.md) for component or
   authority work, [references/consolidation.md](references/consolidation.md)
   for overlap/removal decisions, [references/review.md](references/review.md)
   for visual review, and [references/evidence.md](references/evidence.md)
   before handoff.
2. Read root `AGENTS.md`, `frontend/AGENTS.md`, the target route, its API or
   bridge contract, and its existing legacy implementation when one exists.
3. Query the resolved catalog before broad source search:
   `cd frontend && npm run query:design-system -- "<job or pattern>"`.
   For potentially overlapping semantics, also run
   `npm run query:design-system -- --related "<job or pattern>"`.
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
   portable gate with `npm run check:ui` before handoff. The canonical command
   list and its CI evidence live in `workflows.json`; do not maintain a
   competing handwritten list.

For a text-bearing owned pattern, read
`frontend/design-system/content-guidelines.md` before inventing labels or
empty/error copy. Reuse the optional `content` contract when the pattern has
one; declare a new one only when its text behavior is a reusable authority
surface. Run `npm run check:content` and `npm run test:content` for changed
copy. The checker catches narrow static regressions, not prose quality: use
the named failure modes in review and keep legitimate migration exceptions
exact, owned, and expiring.

When the executing agent has the `design` (ui.sh) or `taste` skill available,
use it only after mechanical checks as a bounded review aid for composition,
responsive behaviour, and polish. Use Storybook states (and its MCP when
available) for isolated inspection before the integrated route. Record which
findings were accepted or rejected. Do not make optional tools prerequisites:
this repository skill, registry, workflows, and checks are the portable
contract for Codex, Claude, and other agents.

## Required checks

Run the resolver's narrow checks while iterating. Before handoff, run
`cd frontend && npm run check:ui`. CI runs the same underlying commands
independently, and `check:harness-integrity` fails if the authority, adapters,
package scripts, or CI evidence drift.

Do not call a route migrated on visual similarity alone. Record the preserved
contract and check output in `docs/react-migration.md`.

## New component decision

Before creating a component, state one of these outcomes in the PR or handoff:

- Reused an existing official component.
- Extended an owned pattern because its documented contract already covers the
  new state.
- Kept similar patterns distinct because their user jobs or interaction
  contracts differ; record their substitution boundary in
  `design-system/relationships.json`.
- Created a named platform pattern because the interaction cannot be expressed
  as a supported composition; include its states, owner and migration scope.
- Superseded or removed a pattern after recording usage evidence, replacement,
  migration path, and a reviewed semantic decision.
