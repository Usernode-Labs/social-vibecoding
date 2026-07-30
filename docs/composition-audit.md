# Composition audit — granularity of the existing UI

**Status:** Corrected; executable tier and source-derived coverage authority updated

**Date:** 2026-07-30

**Companion to:** `shell-simplification.md` (which declared the three tiers)

The first pass audited the curated registry and its then-current 46 stories.
That proved the listed contracts were internally consistent; it did not prove
that the registry covered production source. The correction audits 107
production interface modules directly: 29 local primitives, 12 shell modules,
66 feature modules, 92 story modules, 12 real form modules, and the route
registry in `src/main.tsx`.

## 0. The composition pass was scaffolding, not composition — fixed

The earlier `shell-composition.stories.tsx` was written *before* the
implementation and never converted. It fabricated Home from `Card` +
`AppIdentity` + a local `homeApps` array, and the focused app from a dashed
placeholder `div`. It imported **no route component and no real block**, so it
could not detect drift by construction: changing `HomeView` or `TopBar` left
those stories untouched and still green. That is why the composition pass
"doesn't look like it happened" — as evidence, it wasn't real.

It now composes the actual blocks — `PlatformNavigation`, `HomeView` (and
`HomeAppShortcut` transitively), `AppTopBar`, `FocusedAppFrame` — inside the
real shell frame (`SidebarProvider` → `SidebarInset` →
`data-slot="route-viewport"`), so the safe-area and inset-card CSS resolves as
it does in the app. Five stories: Home (desktop/mobile), focused dApp
(desktop/mobile), nested dApp route.

**Composing for real immediately paid for itself:** it reconfirmed that
`FocusedAppFrame` must sit below `DevConsoleProvider` because it registers its
iframe with the console. This is not a catalog contradiction: the resolved
contract already calls the frame `host-adapter-fed`, and its isolated story
does include the provider. The composition story now proves that shell-level
precondition where it actually matters.

## 1. The automated story evidence ran without CSS — fixed

The original `vitest --project=storybook` run rendered stories **without
compiled Tailwind utilities**. Demonstrated twice:

- `TopBar` with `placement="overlay"` computes `position: static` in the
  runner; the same story in a real browser computes `absolute`.
- A deliberately long title produced `scrollWidth === clientWidth` — the
  `truncate` utility had no effect.

The cause had two layers:

- `.storybook/vitest.setup.ts` retained a pre-10.3 manual annotation
  workaround. Storybook 10.5 explicitly skips its automatic annotation setup
  when that call is present.
- More importantly, the Storybook test project did not extend
  `vite.config.ts`, so it never loaded the application’s
  `@tailwindcss/vite` pipeline. Importing `index.css` alone could not compile
  utilities.

The repair removes the retired manual annotation path, keeps the stylesheet
explicit in the browser setup, and makes the test project extend the
application Vite configuration. `TopBar` stories now assert computed
`position: absolute` and the three computed truncation properties. The
composition story repeats the overlay assertion inside the real shell frame.

This immediately exposed eight real accessibility failures which the unstyled
axe pass could not see. Four shared fixes closed them:

- destructive badges now use the paired solid destructive foreground and
  background tokens;
- challenge progress uses a proportional bottom rail so its fill never sits
  behind status text;
- disabled field labels remain readable instead of inheriting 50% opacity;
- disabled input-group helper text remains readable instead of inheriting 50%
  opacity.

Receipt at the route-owned TopBar commit: `npm run test:storybook` passes 91
files / 388 tests with compiled styles and the accessibility addon active.

## 2. Import-graph findings — normalized

The first audit over-read directory names as tier authority.
`platform-shell-navigation.ts` is not a props-only block; it is the shell’s
state adapter. Its import of `node-presentation-status` is a placement smell,
not a block→feature runtime violation. Moving that mapping mechanically to
`@/lib` would invert the dependency on `StatusDotPresentation` unless the
shared status type moved too. No cosmetic move was made.

`PlatformShell`, `DevConsoleProvider`, `DevCompletionAlerts`, and
`DevConsoleSheet` are feature-tier composition internals still living under
the historical `@/components` directory. The accepted model explicitly
deferred directory churn, so their placement is recorded rather than “fixed”
by shuffling imports.

`AppTopBar` remains the actual model gap: it is feature-tier behavior with 12
consumers, seven outside `features/apps`. The current authority has no named
cross-feature location. It stays owned by `features/apps` until that convention
is decided; moving it now would merely rename the ambiguity.

## 3. Single-consumer findings — no relocation required

There are still six single-runtime-consumer modules and none is dead.
Five are private parts of a composition root. `ThemeSwitcher` is the apparent
exception, but it is intentionally published through `registry.json`; the
settings route is only its in-repository runtime consumer. Moving it into
`features/account` would break the registered distribution contract, so that
proposal is rejected.

`distribution` is not a tier signal. It answers who may consume a pattern:
41 are shell-internal and two are registry-distributed. Tier answers what the
pattern does. The two fields now remain deliberately separate.

## 4. Tier authority and source-derived coverage — implemented

`design-system.manifest.json` is now version 4. It still requires one tier on
every registered owned pattern, and now points at
`design-system/coverage.json` for exact runtime and route evidence
assignments. The production source tree, not either JSON list, remains the
discovery authority.

- 3 elements;
- 25 blocks;
- 15 features.

The catalog generator now also discovers all 29 modules under
`@/components/ui` and publishes their dedicated same-module stories as
Elements. The design-system checker independently discovers those primitives
and fails if any primitive or named state disappears.

The same checker walks production components and features, discovers routes
from `src/main.tsx`, and enforces these boundaries:

- all 12 modules that render a real `<form>` have same-module Storybook
  evidence;
- reusable non-route modules require a same-module story or one exact
  runtime-only assignment;
- route modules without a same-module presentation story require exact
  fixture-driven browser evidence;
- stale runtime or route assignments fail once the source no longer needs
  them.

The current source-derived exception surface is four runtime compositions and
14 route adapters. All 92 story modules are visible under:

```
Elements 32 · Blocks 33 · Features 26 · Compositions 1
```

`Compositions/Shell` remains the one intentional cross-tier group.

## 5. What is now genuinely evidenced

- **29/29 local primitives have dedicated stories.** Button, Field, Input,
  Select, Textarea, Switch, Card, Alert, dialogs, tabs, sheets, and the
  conversation primitives are visible source-derived Elements rather than
  omissions hidden by a curated list.
- **12/12 real form modules have direct stories.** The eight previously coupled
  route forms now expose props-driven presentations without moving request or
  authentication behavior into Storybook.
- **Every non-route feature module has a same-module story.** The four
  storyless shell internals are named runtime compositions with exact
  composition or browser evidence.
- **The 14 storyless route modules have exact browser assignments.** The other
  22 route modules retain same-module presentation stories. This corrects the
  earlier false claim that route views were already split consistently.
- **43 owned patterns remain explicitly governed.** The source-derived
  primitive catalog and coverage checker supplement that registry; they do not
  turn child applications or route adapters into owned reusable patterns.
- **No proven block→feature runtime violation.** The earlier single hit was a
  feature adapter stored under the historical components directory.
- **No dead modules.**

## Remaining follow-ups

1. Decide and document a cross-feature owner for feature-tier modules such as
   `AppTopBar`; do not move it until that naming rule exists.
2. If directory-tier enforcement becomes desirable, move the shell composition
   root and its private adapters as one reviewed change. Do not move one pure
   mapping to make the graph look cleaner.
3. Keep the source-derived coverage and computed-style assertions in the
   Storybook gate. A future test
   configuration that drops the application Vite pipeline now fails loudly.
4. Complete manual narrow/wide, light/dark visual review when the prescribed
   browser backend is available. Automated accessibility and computed-style
   evidence do not impersonate human visual approval.
