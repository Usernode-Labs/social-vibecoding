# Frontend Design-System Policies

## Active scope correction — 2026-07-29

These policies govern the Social Vibecoding **platform shell only**:
platform-owned React routes, reusable shell components, and the hosted-app
frame. They do not govern child-app source, app-factory scaffolds/prompts, or
existing hosted `usernode-native/v1` consumers. Do not change child apps to
demonstrate shell conformance.

The machine-readable authority is now canonical:

- `frontend/design-system/tokens.json` — DTCG token source;
- `frontend/design-system/authority.json` — scope and ownership;
- `frontend/design-system/catalog.json` — resolved component contracts;
- `frontend/registry.json` — owned shadcn CLI distribution;
- `frontend/design-system/exceptions.json` — exact, expiring exceptions.

When prose and these validated artifacts differ, stop and repair the authority
instead of silently choosing one.

This is the evolving post-selection policy document. It is intentionally **not** part of the frozen platform-decision pack. A spike implements only the minimum stated in the pre-registration pack: axe serious/critical gate, keyboard checks, WCAG token-pair validation, numeric budgets, and one visual-diff path.

## Authority and conformance

- DTCG-compatible semantic tokens and Usernode registry metadata are canonical.
- Governed components use named variants, token unions, required stories, and explicit exception metadata.
- CI rejects raw color/spacing/radius/motion values, arbitrary utilities, prohibited infrastructure imports, missing scenarios, and expired exceptions.
- Storybook is rendered evidence and test surface; it is not the token or component authority.

## Component and scenario contract

Every governed public component declares its owner, maturity, tokens, variants, responsive behavior, accessibility contract, data boundary, and scenarios. Scenarios cover applicable theme, viewport, safe area, keyboard, reduced motion, asynchronous state, offline state, and bridge capability state. A new public component requires a gap proof demonstrating why an existing primitive/pattern cannot be reused or extended.

## Accessibility

Target WCAG 2.2 AA. Use accessible headless primitives as a foundation but verify rendered behavior with axe, keyboard interaction tests, and human review. Enforce approved foreground/background token pairs, non-color status cues, visible focus, semantic names, and readable body typography. APCA is a diagnostic, not a WCAG conformance claim.

## Performance and runtime evidence

Maintain bundle, WebView interaction, and visual-regression budgets; verify on the pinned Android WebView device as well as browser tooling. Production telemetry links user-visible failure, bridge failure, service-worker state, and performance regressions to a component/version/release. Chrome DevTools MCP is optional diagnostic support, not the performance authority.

## Agent workflow

Project-local skills guide intake → registry search/gap proof → component work → scenario/test creation → integration → verification/release. Agents can propose but not approve primitives, tokens, visual baselines, or exceptions. MCP/CLI tools are replaceable transports; lint, tests, CI, registry metadata, and source APIs remain the enforceable contract.

## Change and recovery

Version tokens/components, mark deprecations, preserve compatible hosted-kit and legacy-route seams, migrate consumers, then remove old paths only after verified coexistence. Every policy exception has an owner, reason, expiry, and debt review.
