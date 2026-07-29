# Foundation slice specification: Apps home and platform hosting shell

**Status:** selected by product direction on 2026-07-28.
**Scope:** first Candidate A vertical slice; not yet an implementation authorization for unrelated surfaces.

## 2026-07-29 scope clarification

This is a **shell** slice. Apps Home, app detail, navigation, and the hosted-app
frame are governed by Candidate A. RecipeBot is deterministic fixture content
used to prove navigation and hosting; its child-app presentation is not part of
the shell design system. Do not modify child-app code or app-factory templates
while completing this slice.

## Prototype constraints (hard rules)

1. **One theme only.** Use the untouched official default shadcn theme for the selected Base UI configuration. No theme picker, dark-mode switch, custom palette, custom typography, custom radius scale, custom shadows, per-app accent colour, or preset experimentation in this slice.
2. **One representative hosted app.** Use **RecipeBot** as the app-level proof, because it is a relatively simple, understandable product with existing visual evidence. The prototype is `Apps home → RecipeBot detail → RecipeBot App`, with the App/Dev boundary visible. Do not rebuild the full Dev workspace in this slice.
3. **Default before taste.** When an official shadcn component offers a default composition/variant, use it unchanged. Record a limitation rather than polishing around it. The point is to learn the system's native shape before introducing a Usernode visual language.
4. **No hidden customization.** A class, token or component variant may be added only for required responsive layout, semantic state, accessibility, or documented host integration—not to alter the default aesthetic.

## User job

> Open the platform, understand where I am, find RecipeBot, understand what it does, open it, and remain oriented as I enter its hosted App/Dev experience.

## Why this is first

The catalogue and shell are the platform’s clearest existing mental model and the boundary every other surface depends on. They exercise the most important system contracts before we build complicated forms or work cards:

- cross-viewport navigation and layout;
- safe areas, single scroll ownership and keyboard behavior;
- semantic tokens and app identity treatment;
- app search/grid/list density;
- global attention/action placement;
- loading, empty, offline/degraded and capability states;
- route/history and hosted-app handoff;
- the boundary between platform chrome, hosted child-app identity and the shared Dev workspace.

## Relevant unmerged design evidence

Two Social Vibecoding discovery PRs provide a concrete direction to evaluate as part of this slice rather than rediscovering the idea from scratch:

- [PR #486 — Make dapps easier to discover and use](https://github.com/Usernode-Labs/social-vibecoding/pull/486), branch `codex/dapp-discoverability` (open).
- [PR #484 — Implement dApp discoverability: home IA, detail page, listing metadata](https://github.com/Usernode-Labs/social-vibecoding/pull/484), branch `dev/cyrcle_0-1783680663525` (open).

They propose the same useful conceptual shift: **Home is both a fast launcher for familiar apps and a discovery/evaluation surface for unfamiliar ones.** Their shared direction is: a primary Create affordance; saved/favourite apps as a direct-open fast path; category rails such as Games/Tools; richer purpose-first app metadata/search; an app detail page for evaluation; and separate builder/listing editing rather than crowding discovery cards.

Treat those PRs as a hypothesis, not an import target. Preserve the valuable split—**discovery → evaluation → open/improve**—but evaluate its visual hierarchy, metadata density, route compatibility, child-app privacy rules, native shortcut behavior and wide-browser layout against this slice's scenario matrix.

## Evidence

All paths below are relative to the curated visual baseline preserved at
`../visual-baseline`.

| Scenario | Visual evidence | What it establishes |
|---|---|---|
| Apps home, light/dark | `03-platform-shell/01--light.png`, `03-platform-shell/04--dark.png` | Search, two-column catalogue, app tile anatomy, utility header, theme state. |
| Navigation overlay | `03-platform-shell/02--light.png`, `03-platform-shell/03--dark.png` | Existing destination set and mobile sheet behavior; source material to reorganize, not blindly copy. |
| App entry and handoff | `09-app-entry-and-recipebot/04--loading.png`, `/05--app-tab-loaded.png`, `/06--developer-tab.png` | Loading boundary, platform frame, App/Dev transition. |
| Emoji inventory | `10-emoji-apps/00-catalog/01--emoji-inventory.png` | Child-app identity diversity and tile inventory. |
| Hosted cold load | `10-emoji-apps/01-supply-line/01--blank-loading-initial.png` plus equivalent app captures | Blank/initial hosted state is an observed compatibility state; it must be explicitly handled/tested rather than treated as a design ideal. |

## In scope

1. **Responsive platform shell**
   - named destination model: Apps, Work, Community, Account, conditional Admin;
   - narrow and wide navigation expressions for the same destinations;
   - contextual header/back/title model;
   - one intended scroll region and top/bottom safe-area ownership.
2. **Apps home**
   - app search;
   - responsive app browser/grid;
   - app tile: identity, availability, member summary and local action affordance;
   - explicit loading, empty, filtered-empty and degraded/offline states;
   - light/dark and long-name/dynamic-count states.
3. **RecipeBot app-detail and handoff boundary**
   - RecipeBot detail page with default component composition: identity, purpose, activity context, Open and Improve;
   - a small RecipeBot app surface using the same single default theme, representing search/tags/recipe-list content from the visual evidence;
   - route/frame transition from Apps home into a hosted app;
   - visible initial/loading/degraded state;
   - explicit App/Dev orientation state, without implementing the Dev workspace itself;
   - typed adapter/mocks for app inventory and host/bridge capability state.
4. **Verification loop**
   - deterministic Storybook scenarios at narrow, tablet and wide reference viewports;
   - an integration story/route using fixture data;
   - keyboard/focus/a11y/visual/performance evidence for this shell.

## Explicit exclusions

- Rebuilding the Work, Community, Account, Admin or Dev content surfaces.
- Rewriting every child app. RecipeBot is the sole controlled exception for this prototype; its current culinary identity is not being migrated as a production decision.
- Replacing Flutter-native settings, wallet, node, benchmark or profile routes.
- Solving all iframe/service-worker/auth/bridge issues; this slice defines the host-facing presentation seam and tests named states only.
- Installing a broad component library or community registry catalogue.

## Information architecture hypothesis to test

The current visual shell exposes many peer icon actions. The slice should prototype—not assume—the evolutionary organization:

```text
Apps (default)
Work
Community
Account
Admin (conditional)
```

The first acceptance question is whether this makes current destinations easier to find while retaining a compact mobile experience and a natural wide-browser expression. It is acceptable for the first real integration to retain legacy destinations behind compatible routes while the new navigation only proves the Apps path.

## Component/pattern boundary to prove

### Foundation candidates

- semantic color/type/spacing/radius/focus/motion tokens;
- responsive shell layout and navigation slots;
- icon action with accessible name and badge/count state;
- search field and async result state;
- app tile/list item anatomy;
- status/count badge;
- loading/empty/error/degraded boundary;
- menu/overflow trigger.

### Owned patterns, not generic primitives

- platform shell;
- app browser/catalogue;
- app tile;
- hosted-app handoff state;
- App/Dev context switch/orientation.

## Required scenario matrix

| Scenario | Narrow mobile | Wide browser |
|---|---|---|
| Normal app catalogue | search + touch grid, named destinations compactly accessible | denser grid and persistent named navigation where it earns space |
| Long names/counts | no overlap; identity remains scannable | same semantics with relaxed layout |
| Search / no matches | query stays visible; actionable empty state | same state, no density-only workaround |
| Loading / first launch | truthful initial/loading state; no indefinite blank ambiguity | equivalent route-level state |
| Offline/degraded | clear current status and recoverable action where available | same meaning, not merely a toast |
| RecipeBot detail | app identity/purpose with Open and Improve actions | same information hierarchy with room for richer context |
| RecipeBot open | transition to host/app frame with orientation | same route/identity, optional persistent context |
| Capability absent/old | no false available action; understandable fallback | same capability semantics |
| Light/dark + reduced motion | named visual and motion states | named visual and motion states |

## Acceptance criteria

1. A new user can name the current destination and find Apps/Work/Community/Account from both reference layouts without icon memorization.
2. An app tile exposes identity, availability, membership and local action without competing focal points or inaccessible text.
3. The shell has exactly one deliberate vertical scroll owner per scenario; safe-area and keyboard states are tested.
4. RecipeBot opening preserves an understandable platform-to-hosted-app boundary. For this prototype it intentionally shares the single default shadcn theme; this is a controlled learning constraint, not a permanent child-app identity decision.
5. Every matrix state is deterministic in Storybook and at least one real integration route with mocks.
6. No serious/critical automated accessibility finding; keyboard/focus and accessible-name tests pass.
7. An agent can discover the approved source/pattern, make a controlled change, and have an intentional token/import/story violation caught by the verification loop.

## First implementation sequence

1. Freeze this specification after a short visual/IA review.
2. Bootstrap the Candidate A workspace and its minimal official-source dependency allowlist, using the untouched default Base UI shadcn theme.
3. Define only the tokens and fixtures needed by this slice.
4. Implement shell + Apps home in isolation with all scenario stories.
5. Implement a single mock host handoff route and compare to visual evidence.
6. Add the four minimal agent skills and mechanical gates only as each is needed by the slice.
7. Review evidence; decide whether the next slice is Work attention, Account capability, or the lifecycle work item.
