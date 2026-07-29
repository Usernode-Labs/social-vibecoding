# Shell component audit

A collaborative semantic audit of the React platform shell. Each batch traces
registered and unregistered patterns to their consumers, records the contract
they actually carry, and proposes a decision before any refactor.

Scope is the Social Vibecoding platform shell as defined in
`frontend/design-system/authority.json`. Hosted child apps, the app-factory
scaffold, and `usernode-native/v1` are out of scope.

Worker-facing decisions are consolidated in
[`shell-refinement-guide.md`](shell-refinement-guide.md); parallel delivery and
cutover gates are in [`shell-execution-plan.md`](shell-execution-plan.md).

Status legend for decisions: **proposed** (awaiting review), **accepted**,
**superseded** (replaced by a later accepted decision; the record names it),
**applied**.

Batch order: shell + Apps Home → actions and controls → surfaces/content states
→ navigation and overlays → Dev/chat compounds → account/admin patterns.

## Reconciliation record — 2026-07-29

Batch 1 was reviewed together with the separately authored
[`platform-navigation-proposal.md`](platform-navigation-proposal.md), which is
the accepted product direction (Home / Explore / drawer / contextual app
chrome). Decisions below are re-marked against it: structural findings are
accepted largely as written; the Apps Home pattern decisions (P10, P11) and the
header/sidebar merge (P4) are superseded by the proposal's information
architecture; the `PlatformShell` registration proposal (P1) is superseded by a
composition/presentation split.

Authorship, for the record: this audit was produced by a Claude session; the
navigation proposal was authored separately; a Codex task reviewed both
read-only and produced no files. The two documents are complementary, not one
work product.

Amendments accepted during reconciliation:

1. The structural-integrity patch stays mechanical — single `main`, `nav`
   landmark, per-route `h2`→`h1` element swap with no styling normalization.
   `PageHeader` adoption is a later, separately reviewable pass.
2. Style-policy broadening (S3) and the `PlatformShell` split (P1) are a
   package: the composition-only orchestrator is acceptable only because the
   broadened scan still covers it.
3. Before broadening enforcement, run the widened scan as an inventory and land
   the patch with owner/expiry exception-ledger entries for every pre-existing
   violation, so the commit is green without pulling registration work forward.
4. `meta-viewport` joins the axe allowlist only in the same commit that relaxes
   the viewport tag (S5 is still blocked on a real WebView check).
5. `app-card` gets an explicit deprecate → migrate → delete path (P10).
6. `FocusedAppFrame` is registered with a declared `performance` authority
   override (mount continuity), not just prose in the proposal.
7. The drawer is expressed with the official shadcn `Sidebar` as far as it will
   go; the owned surface is limited to the iframe inert/focus contract and the
   attention indicator.
8. shadcn Create owns the upstream baseline. The current project resolves to
   Base UI + Nova `b2fA`; Base UI + Luma `b1VlIttI` is the exact proposed
   target pending the explicit freeze gate. Adoption is a scratch comparison
   and component-by-component merge, never a blanket overwrite. See
   [`shadcn-create-baseline.md`](shadcn-create-baseline.md).
9. User-facing contribution labels use **Improve**. Technical routes
   (`/dev`), diagnostics, and historical evidence may retain **Dev**.
10. Motion is deferred until static focused-app mount continuity and real
    WebView behavior pass. Current contracts record candidate metadata only.
11. `AppIdentity` uses an immutable-ID-to-finite-palette-token mapping. Runtime
    generated hues are no longer an accepted implementation or ledger escape.

---

## Batch 1 — platform shell and Apps Home

Baseline: `9dddc22` on `codex/react-shadcn-migration`, working tree clean.

### Evidence captured

| Source | Where |
| --- | --- |
| Running shell, desktop + mobile, light + dark | Vite dev server, `/react/` |
| Storybook states | `apps-appcard--running`, `--unavailable`, `--reorder-controls`; `foundation-platform-icon--*`; `foundation-theme-switcher--*` |
| Accessibility | `@axe-core/playwright`, unfiltered by impact, at 1280×900 and 390×844 |
| Authority | `design-system.manifest.json`, `design-system/authority.json`, `design-system/catalog.json`, `design-system/exceptions.json`, `registry.json` |

Unfiltered axe results on `/react/` (desktop and mobile) and
`/react/apps/recipebot`:

```
[moderate] landmark-main-is-top-level    Main landmark should not be contained in another landmark
[moderate] landmark-no-duplicate-main    Document should not have more than one main landmark
[moderate] landmark-unique               Landmarks should have a unique role or role/label/title
[moderate] meta-viewport                 Zooming and scaling must not be disabled
[moderate] region                        All page content should be contained by landmarks
[serious]  color-contrast                Avatar fallback on /react/apps/recipebot (2 nodes)
```

The suite asserts only `critical` and `serious` (`tests/apps-home.spec.ts:280`
and 34 sibling specs), so every `moderate` finding above passes CI today. The
`serious` contrast finding is on `app-details`, which is not one of the routes
whose axe assertion runs unscoped against that state.

---

### Systemic findings (affect the whole shell, not one pattern)

#### S1. Two `<main>` landmarks on every route

`SidebarInset` renders `<main>` (`@/components/ui/sidebar.tsx:307`) and all 37
route modules render their own `<main>` inside it. Result on every screen:
nested main, duplicate main, non-unique landmark.

- **Consumers:** 37 route modules plus `@/components/route-fallback.tsx:2`.
- **Decision (accepted):** the shell owns the `main` landmark. `SidebarInset`
  keeps `<main>`; routes become `<div>` / `<section>`. Lands in the
  structural-integrity patch as its own commit, together with the mechanical
  per-route `h2`→`h1` swap (S4) and the landmark/heading axe allowlist (S2).

#### S2. The accessibility gate cannot see landmark or heading defects

Every spec filters to `critical`/`serious`. All five findings above are
`moderate` and therefore invisible to CI, which is why they survived to a
verified milestone.

- **Decision (accepted):** keep the `critical`/`serious` hard gate, and add an
  explicit allowlist-based `moderate` gate for landmark and heading rules so
  regressions in shell structure fail rather than pass silently.
  `meta-viewport` is added to the allowlist only in the same commit that
  relaxes the viewport tag, since S5 is still blocked on WebView verification.

#### S3. Style policy only governs manifest-listed modules

`governedStyleFiles()` (`frontend/scripts/style-policy-tools.mjs:73`) derives
its file list solely from `design-system.manifest.json`. Everything not in the
manifest — `platform-shell.tsx`, `apps-home.tsx`, `app-identity.tsx`,
`route-fallback.tsx`, and every route module — is never scanned for raw colour
or arbitrary utilities.

Registry membership is therefore also enforcement coverage. `AppIdentity` is the
concrete casualty: `frontend/AGENTS.md:16-18` names it as a governed contract,
but it is in no authority artifact and ships raw `hsl()` inline styles
(`@/features/apps/app-identity.tsx:11`).

- **Decision (accepted):** extend the style policy to all of `@/features` and
  `@/components` rather than only manifest entries, keeping the exception ledger
  as the escape hatch. Register the patterns that carry a real contract
  (see P2, P9). This is a package with the P1 split: the composition-only
  `PlatformShell` is acceptable only because the broadened scan covers it.
  Sequence: run the widened scan as an inventory first, then land with
  owner/expiry ledger entries for every pre-existing violation.

#### S4. No page-title system

Three competing conventions for one job:

| Convention | Element | Type scale | Where |
| --- | --- | --- | --- |
| Shell chrome title | `<h1>` | `font-semibold` | `platform-shell.tsx:159`, constant string `dApps` on every route |
| Route title as `h1` | `<h1>` | `text-2xl` | `apps-home.tsx:117` |
| Route title as `h1` | `<h1>` | `text-3xl` | `shared-session.tsx:41` |
| Route title as `h2` | `<h2>` | `text-3xl` | `work.tsx:83`, `notifications.tsx:99`, `settings.tsx:235`, `challenges.tsx:242`, `admin-overview.tsx:63`, and the rest |

Consequences: the only `h1` on most screens is the constant `dApps`; Apps Home
and Shared Dev session each emit a second `h1`; the visible page title is
demoted to `h2` almost everywhere; `document.title` is only ever written by the
native bridge (`@/lib/native-bridge.ts:91`), so the browser tab reads `dApps`
throughout.

- **Decision (accepted, amended):** create one owned `PageHeader` pattern
  (title, optional description, optional primary action), make it the sole `h1`
  per route, and reduce the shell header title to a non-heading, route-aware
  label. Registered pattern with named states. Amendments: the
  structural-integrity patch does only the mechanical element swap so each
  route's existing visible title becomes its `h1`; `PageHeader` is built
  Storybook-first in the contracts phase and adopted in a second pass. Back
  affordances follow the navigation proposal — chrome-owned Back for genuine
  nested routes, page-body back buttons removed — rather than a `PageHeader`
  back slot.

#### S5. Pinch-zoom disabled shell-wide

`frontend/index.html:5` sets `maximum-scale=1.0, user-scalable=no`.
`viewport-fit=cover` is needed for the native safe-area contract;
`user-scalable=no` is not, and is a WCAG 1.4.4 concern.

- **Decision (proposed — still open):** keep `viewport-fit=cover`, drop
  `maximum-scale` and `user-scalable`. Blocked on a real Flutter WebView
  iOS/Android check, since this is a host-contract surface. Until it lands,
  `meta-viewport` stays out of the S2 axe allowlist.

#### S6. Stale authority reference

`docs/rewrite-history/README.md:44` lists
`frontend/design-system/components.json` as authoritative. That file does not
exist; the real chain is `design-system.manifest.json` →
`design-system/authority.json` → `design-system/catalog.json`.

- **Decision (accepted):** correct the reference in the structural-integrity
  patch.

---

### Pattern audit

#### P1. `PlatformShell` — unregistered

- **User job:** give every platform screen persistent identity, navigation,
  global actions, and theme control.
- **Semantic role:** application chrome. Owns the `banner` and (should own) the
  `navigation` and `main` landmarks.
- **Consumers:** every route in the shell. `@/components/platform-shell.tsx:148`.
- **Visual/story evidence:** running UI only. **No Storybook states at all** —
  the single most-reused surface in the system has no named state evidence,
  while 37 leaf patterns do.
- **States:** admin / non-admin (`AdminLink`), admin-preview banner active,
  sidebar expanded / offcanvas, dev-console open, light / dark.
- **Accessibility contract:** currently unmet — no `nav` landmark (axe `region`
  flags sidebar content as outside any landmark), constant `h1`, duplicated
  accessible names (see P3, P4).
- **Data boundary:** mixed. `AdminLink` calls `getAdminUser` directly inside the
  shell; everything else is static. Acceptable under `adapter-fed`, but it means
  the shell cannot be storied without a network stub.
- **Performance contract:** not applicable — fixed-size chrome, no collection.
  It does own **mount continuity** for the whole app: it must not remount on
  navigation.
- **Overlap:** none; it is the root.
- **Decision (superseded — by the reconciled split):** `PlatformShell` stays
  **composition-only**: orchestration, routing, providers, and data adapters,
  with no public contract and no registry entry. The registered, props-only
  presentation views are **`PlatformNavigation`** (drawer/sidebar: destinations,
  attention count, Node state, admin visibility) and
  **`AppChrome`/`FocusedAppFrame`** (open-app chrome), each built
  Storybook-first with named states. Condition: this split is acceptable only
  together with S3's enforcement broadening — otherwise the unregistered
  orchestrator escapes the style policy again.
- **Rationale:** registering the shell was a proxy for two real needs — story
  evidence and style enforcement. The split provides both without giving the
  orchestrator a public surface it should not have.

#### P2. Page title / `PageHeader` — does not exist

- **User job:** tell the user which screen they are on and offer its primary
  action.
- **Semantic role:** the route's `h1` and primary action slot.
- **Consumers:** ~15 route modules, each hand-rolling it (see S4 table).
- **States:** with/without description, with/without primary action, with/without
  back affordance, narrow (action wraps below title) and desktop.
- **Accessibility contract:** exactly one `h1` per route; the action is a real
  button/link with a visible label.
- **Data boundary:** props-only.
- **Performance contract:** not applicable.
- **Overlap:** `AppSection` (P8) does the same job one level down. They share
  structure but differ in heading level and role, so per the consolidation
  rules they should share a lower-level primitive, not merge.
- **Decision (accepted):** **create a registered pattern**, `PageHeader`, plus a
  shared unregistered layout primitive it and `AppSection` both use. Built
  Storybook-first in the contracts phase; see S4 for the two-pass adoption.
- **Rationale:** same user job, same behaviour, same state model, same
  responsive meaning across ~15 consumers, currently expressed three different
  ways.

#### P3. `IconLink` — shell-local composition

- **User job:** reach a global destination from the header.
- **Semantic role:** icon-only navigation link with a tooltip.
- **Consumers:** 5 uses, all inside `platform-shell.tsx:38`. No external
  consumer.
- **Visual evidence:** header icon row, desktop and mobile screenshots.
- **States:** default, hover/tooltip, focus. No active state despite being
  navigation.
- **Accessibility contract — currently violated three ways:**
  - `aria-label` is set on both the `Button` and the inner `<a>`
    (`platform-shell.tsx:45-47`);
  - `title` duplicates the accessible name *and* races the shadcn `Tooltip`, so
    a native browser tooltip and a rendered tooltip both appear;
  - `type="button"` is emitted onto `<a>` elements (confirmed in the a11y tree).
- **Data boundary:** props-only.
- **Performance contract:** not applicable.
- **Overlap:** the touch-target expansion hack `size-[max(100%,3rem)]` appears
  twice with two different implementations — a child `<span>` in `IconLink` and
  an `after:` pseudo-element on `SidebarTrigger` (`platform-shell.tsx:51` and
  `:158`) — for one job.
- **Decision (accepted):** **composition-only, do not register.** It has no
  independent contract outside the shell. Fix the three a11y defects in place
  and extract the touch-target expansion into a single shared utility used by
  both call sites. Note: the global toolbar itself is removed by the navigation
  proposal, so these fixes apply only if any interim shell ships before the
  drawer lands; the touch-target utility carries forward to the new app chrome
  (48×48 target rule).
- **Rationale:** one consumer, no independent contract; registering it would add
  a public surface for something the shell alone composes.

#### P4. Header action row vs sidebar navigation — duplication

- **User job:** the two surfaces answer different questions ("where can I go?"
  vs "what can I do from here?") but currently overlap.
- **Evidence (a11y tree, `/react/`):** `Account` appears twice
  (`ref_7` sidebar, `ref_12` header); `Settings` appears twice (`ref_8`,
  `ref_13`); `Apps` appears twice (`ref_1` sidebar header, `ref_2` sidebar
  Platform group), both pointing at `/react/`.
- **Additional defect:** the sidebar header link has visible text `dApps` and
  accessible name `Apps` (`platform-shell.tsx:104`) — a WCAG 2.5.3 *Label in
  Name* failure.
- **Additional defect:** the `Apps` navigation item uses the `Menu` (hamburger)
  glyph as a content icon (`platform-shell.tsx:33`), which reads as "open a
  menu", not "apps".
- **Mobile:** at 375px the header carries six tap targets, unlabelled, two of
  which duplicate sidebar entries.
- **Decision (superseded — by the navigation proposal):** the drawer owns all
  global destinations (Home, Explore, Work, Challenges, Activity; Node as a
  technical section; Account, Settings, Send feedback, conditional Admin as
  bottom utilities). The header becomes contextual chrome: menu with attention
  dot, current app/route identity, at most one primary action plus overflow,
  Back/Close per route depth. Reassignments: Leaderboard → Challenges,
  Notifications → Activity, Theme → Settings, Dev Console → app
  overflow/improvement chrome. The label-in-name failure and the
  `Menu`-as-content
  glyph disappear with the toolbar; if any interim shell ships first, fix them
  then.
- **Rationale:** same destination reached two ways at the same altitude is
  unjustified variance and doubles the mobile header's cost; the proposal
  resolves it structurally instead of trimming the toolbar.

#### P5. `PlatformIcon` — registered, `stable`, `registry`

- **User job:** one canonical size grid for platform glyphs.
- **Consumers:** pervasive across all features.
- **Evidence:** `Default`, `SmallInline`, `Control`, `LargeFeature`.
- **Contract:** decorative icons hidden; standalone semantic icons require
  `aria-label`; canonical size grid. Implementation matches
  (`@/components/platform-icon.tsx:24-25`).
- **Decision (accepted):** **keep unchanged.** This one is healthy.

#### P6. `ThemeSwitcherView` / `ThemeSwitcher` — registered

- **User job:** choose light or dark.
- **Consumers:** sidebar footer (`platform-shell.tsx:129`); settings.
- **Evidence:** `LightSelected`, `DarkSelected`; verified working in the running
  UI (clicking Light re-themes correctly).
- **Contract gap:** the authority requires "one mutually exclusive light/dark
  choice set" and "communicate the selected mode programmatically". The official
  `ToggleGroup` renders two independent `aria-pressed` toggle buttons, which
  does not express mutual exclusivity to assistive technology.
- **Resolved — the missing "system" option is a confirmed regression, with a
  storage-contract trap.** The legacy shell ships a three-way Light / Dark /
  System selector (`public/index.html:284-286`) with an explicit byte-compatible
  storage contract (`public/js/theme.js:1-8`): `'light'`/`'dark'` stored
  explicitly, **key absent = system**, and choosing System *removes* the key.
  The React side reads the same `theme` key but `ThemeMode` is
  `"light" | "dark"` only (`@/lib/theme.ts:1`), and `setThemeMode` always
  writes the key with no way to remove it. Consequence: the first touch of the
  React switcher permanently disables OS-following, and the still-live legacy
  shell (same key, inline no-flash guards in every legacy HTML page) inherits
  that loss.
- **Decision (accepted, amended):** **keep the adapter, rebuild the control in
  Settings.** Theme moves out of the sidebar into Settings per the navigation
  proposal. The Settings control is three-way Light / Dark / System, where
  System deletes the key to stay byte-compatible with the legacy no-flash
  guards. Adopt mutually exclusive (radio-group) semantics when rebuilding; do
  not invent a custom control.

#### P7. `RouteFallback` — unregistered

- **User job:** hold layout while a lazy route loads.
- **Consumers:** router suspense boundary. `@/components/route-fallback.tsx:2`.
- **Defects:** renders its own `<main>` (feeds S1); hand-rolls `animate-pulse`
  instead of using the `Skeleton` primitive, which 38 other modules use.
- **Decision (accepted):** **composition-only, keep unregistered.** Use
  `Skeleton`, drop the `<main>`; lands with the structural-integrity patch.

#### P8. `AppSection` — Apps Home local composition

- **User job:** group a set of app cards under a titled band with an optional
  action.
- **Consumers:** 2 uses, both in `apps-home.tsx:24`.
- **Contract:** `<section aria-label>` + `h2` + optional description + optional
  action.
- **Overlap:** structurally identical to P2's `PageHeader` but semantically a
  section, not a page.
- **Decision (accepted):** **composition-only, do not register.** Share the
  lower-level header layout primitive with `PageHeader`; keep the components
  distinct because heading level and landmark role differ. Its Apps Home
  consumers dissolve into Home and Explore, but the section-band shape recurs
  there ("Your apps", "Needs attention"), so the primitive survives the split.
- **Rationale:** consolidation rule — structurally similar, semantically
  different, so share a primitive rather than merging.

#### P9. `AppIdentity` — unregistered but contractually named

- **User job:** identify an app visually where its artwork is the subject.
- **Semantic role:** application artwork; explicitly *not* an interface icon
  (`frontend/AGENTS.md:16-18`).
- **Consumers:** `app-card.tsx:20`, `app-details.tsx`, and other app surfaces.
- **Defects:**
  - absent from the manifest, authority overrides, catalog, registry, and
    exception ledger, despite being named as a contract in prose;
  - therefore never scanned by the style policy (S3);
  - hardcodes `hsl(...)` background and foreground inline
    (`app-identity.tsx:11`) with fixed lightness tuned for dark surfaces, so the
    monogram tiles stay dark blocks in light mode — visible in the light-mode
    screenshots.
- **States:** artwork present (`icon_url`), monogram fallback. Light and dark.
- **Accessibility contract:** decorative (`alt=""` / `aria-hidden`) because the
  app name is always adjacent. That is correct and worth recording explicitly.
- **Data boundary:** props-only (`AppRecord`).
- **Performance contract:** not applicable.
- **Decision (accepted, amended):** **register as an owned pattern** with named
  states (`Artwork`, `ArtworkFailure`, `MonogramLight`, `MonogramDark`) and a
  finite semantic palette. A frozen mapping resolves immutable app ID to a
  stable palette token with coordinated light/dark surface, foreground, and
  border roles. Runtime-generated hues are prohibited rather than offered as a
  ledger escape. `AppIdentity` becomes the shared artwork primitive underneath
  both `HomeAppShortcut` and `ExploreAppCard`.
- **Rationale:** it already carries a documented contract and is reused; the
  registry is the only thing that makes that contract enforceable.

#### P10. `AppCard` — registered

- **User job:** recognise an app and act on it from a list.
- **Consumers:** `apps-home.tsx` (both sections). `@/features/apps/app-card.tsx:13`.
- **Evidence:** `Running`, `Unavailable`, `ReorderControls`.
- **States:** collaborator badge, non-running status badge, active-user count,
  optional footer actions.
- **Accessibility:** accessible name is `"View details <App>"`, which reads
  awkwardly; footer arrow controls are labelled correctly.
- **Data boundary:** props-only, per the authority override. Correct.
- **Performance contract:** not currently declared. Collection size is the
  user's app list — **small-to-medium**, update frequency **interactive**
  (search filter, reorder), state **local**, virtualization **not needed**. Worth
  recording as a scoped contract rather than left blank, but it does not need a
  profiling flag.
- **Semantic defect:** the primary action uses the `ExternalLink` glyph
  (`app-card.tsx:36`) for an *internal* navigation to the detail route. The same
  glyph correctly means "leave the platform into the hosted app" on
  `app-details.tsx:175`. One glyph, two opposed meanings.
- **UX defect:** the page promises "Open something familiar", but the card's
  only action is `View details`, so opening a familiar app costs two
  navigations.
- **Decision (superseded — by the Home/Explore split):** the extension is not
  built. `HomeAppShortcut` (direct launch) and `ExploreAppCard` (discovery and
  detail entry) replace `AppCard`; they stay separate components sharing
  `AppIdentity` and metadata primitives, because launching and evaluating are
  different user jobs. Both defects dissolve: shortcuts open apps directly, and
  the `ExternalLink` glyph question disappears with the `View details` action.
  **End-of-life path (accepted):** when the successors are registered, mark
  `app-card` `deprecated` in the authority (no new uses); migrate consumers and
  the spec surface during the split (`tests/apps-home.spec.ts`, the
  `test:production-review` file list in `frontend/package.json`, and the
  `data-testid="app-card-*"` / `"apps-home"` anchors); then delete its
  manifest entry, catalog output, authority override, and stories in a cleanup
  commit. The scoped performance observations above (small-to-medium,
  interactive, local, no virtualization) transfer to the successors' authority
  entries.

#### P11. Apps Home composition — `AppsHome`

- **User job:** find and open an app.
- **Consumers:** route `/react/`. `@/features/apps/apps-home.tsx:55`.
- **Evidence:** fixture-driven Playwright coverage; running UI, desktop and
  mobile, light and dark.
- **Defects:**
  - **Every "Your apps" card is repeated verbatim in "All apps."** Confirmed in
    the DOM: `recipebot`, `pantry-planner`, `trailmap` each render twice, with
    duplicate `data-testid` values. `tests/apps-home.spec.ts:51` works around
    this by scoping to the `Your apps` region. On mobile this means scrolling
    past the same cards twice.
  - The empty state is always titled `No matches` / "Try an app name or slug"
    (`apps-home.tsx:141-142`), including when the user has no apps at all and
    has typed nothing. First-run and no-results are different jobs.
  - `CardSkeleton` (`apps-home.tsx:39`) hand-rolls `AppCard`'s structure, so the
    two drift independently.
- **Performance contract:** collection **small-to-medium**, filtered on every
  keystroke, **local** state, no virtualization, no profiling flag.
- **Decision (superseded — by the Home/Explore split):** the route splits into a
  sparse personal Home (`/react/`) and an Explore catalog (`/react/explore`),
  which removes the duplication outright — the product question is resolved as
  *remove, don't rename*. Two observations carry forward to the successors:
  empty-collection vs no-search-results are distinct jobs (they become Home
  empty, Explore empty, and Explore no-results states in the required
  evidence), and loading skeletons must be derived from the real card/shortcut
  components so they cannot drift.

#### P12. Reorder interaction — `AppCard` footer arrows vs `DevBoard` drag

- **User job:** both let a user reorder an owned collection.
- **Evidence:** `apps-appcard--reorder-controls` (Earlier/Later arrow buttons);
  `dev-board` uses `@dnd-kit/sortable`.
- **Difference:** the app rail is a short personal list with an explicit
  reorder mode; the board is a large multi-column work surface with drag as the
  natural affordance.
- **Decision (accepted):** **keep distinct.** Same job, but the collection
  semantics and scale differ legitimately, and the arrow model is the more
  accessible one. Record the divergence explicitly rather than leaving it
  implicit, and confirm the board has a keyboard reorder path. The app-rail
  reorder interaction transfers to Home's shortcut management when
  `HomeAppShortcut` replaces the card rail.
- **Rationale:** consolidation rule — do not force one component when contextual
  differences are legitimate.

---

### Successor patterns (from the reconciliation)

To be built Storybook-first and registered with named states, accessibility
contracts, and tokens before wiring to live data:

| Pattern | Job | Notes |
| --- | --- | --- |
| `PlatformNavigation` | Props-only drawer/sidebar presentation | States: open/closed, attention/no-attention, each Node dot state, admin/non-admin, mobile temporary vs wide persistent. Express through the official `Sidebar` as far as it goes; owned scope is the attention indicator and (later) the iframe inert/focus interplay. |
| `PageHeader` | Route title + description + one contextual action | Sole `h1` per route; shares a layout primitive with `AppSection`-style bands. |
| `HomeAppShortcut` | Direct personal app launch | Labeled icon, never icon-only. |
| `ExploreAppCard` | Catalog discovery and detail entry | Separate from `HomeAppShortcut` by job, shared primitives underneath. |
| `AppIdentity` | App artwork / monogram fallback | Registered with immutable-ID → finite token mapping, artwork-failure and Unicode-aware monogram states (P9). |
| `StatusDot` | One liveness rendering primitive | Explicit Node, App, and Connection adapters map truthful domain states to shared semantic roles; mappings do not collapse the domain models. |
| `FocusedAppFrame` / `AppChrome` | Open-app containment and contextual controls | Registered with a declared `performance` authority override: mount continuity of the hosted iframe across drawer open/close, `sensitiveInteractions` = drawer translate + inert toggle, `followUp: profile-before-cutover`. |

Retirement: `app-card` follows the deprecate → migrate → delete path in P10.

### Deferred to later batches

- `DevConsoleTrigger` / `DevConsolePanel` / `DevConsoleSheet` /
  `DevCompletionAlerts` — mounted in the shell but belong to the Dev/chat batch.
- `AdminPreviewBanner` (`platform-shell.tsx:77`) — belongs to the account/admin
  batch; note that it reloads the page on restore.
- The `serious` avatar contrast violation on `/react/apps/recipebot` is **not**
  deferred: as a live `serious` finding it lands with the structural-integrity
  patch, ahead of its batch.

### Resolution of the batch-1 open questions

1. Header contents once navigation consolidates — **resolved** by the
   navigation proposal: the header holds contextual chrome only (menu with
   attention dot, current identity, one primary action, overflow, Back/Close);
   all global destinations move to the drawer (P4).
2. "All apps" duplication — **resolved**: the Home/Explore split removes the
   overlap rather than renaming the bands (P11).
3. Dropping `user-scalable=no` — **still open**, blocked on a real Flutter
   WebView iOS/Android check (S5). The only remaining batch-1 blocker.
4. Missing "system" theme option — **resolved with evidence**: confirmed
   regression against the legacy three-way selector, including the
   key-absent-means-system storage contract the React adapter currently cannot
   express (P6).
