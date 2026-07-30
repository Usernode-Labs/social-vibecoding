# Shell simplification — one bar, three tiers

**Status:** Implemented (2026-07-30); supersedes
`dynamic-shell-header-refinement.md` and folds in the findings of
`dynamic-shell-header-ripple-audit.md`

**Date:** 2026-07-30

## The one invariant

> A screen is **drawer + topbar + content**. The topbar is always present and
> renders the screen's only `h1`. No exceptions.

The only permitted variation is placement:

- `flow` — the bar reserves its height; content starts below it. All platform
  routes.
- `overlay` — the bar floats, translucent, over a full-bleed surface that owns
  the whole page. Focused app and staging preview.

Everything else — brand bars, page headers, app chrome, suppression rules,
full-bleed route lists — is deleted, not configured.

### Why "no exceptions" is the simplification

The previous design kept accumulating special cases because chrome ownership
was split three ways (`PlatformShell` header, `PageHeader`, `AppChrome`).
Each owner needed rules about when the others yield. With one owner, the rules
dissolve:

| Special case in the previous plan | Under the invariant |
|---|---|
| Suppress bar on `/login`, `/register`, `*` (double-`h1` breakage) | Gone. Those screens get the bar (`Sign in`, `Create account`, `Not found`); their card titles demote to `h2`. |
| `fullBleedRoute` regex list in `PlatformShell` | Gone as a concept; it is just `placement: overlay` on two routes. |
| Two lanes (27 `PageHeader` routes vs 12 `AppChrome` routes) converging | One lane. Every route projects into the same bar. |
| `AppChrome` vs `ShellContextBar` overlap | `AppChrome` deleted. |

## The three tiers

**Elements** — atomic, no domain knowledge, compose nothing of ours.
**Blocks** — compose elements into one reusable pattern with a props-only
contract. **Features** — entire pages; orchestrate blocks, own data loading,
routing, and authorization.

Mapped to the existing tree (no directory churn now; placement rules only):

| Tier | Lives in | Contents after this change |
|---|---|---|
| Elements | `@/components/ui`, plus owned atoms in `@/components` | shadcn primitives; `PlatformIcon`, `StatusDot`, `AppIdentity` |
| Blocks | `@/components`, or a feature folder while feature-local | `TopBar`, `PlatformNavigation`, `FocusedAppFrame`, `DevConsolePanel` |
| Features | `@/features/*` | routes; feature-local blocks stay inside their feature folder (`ExploreAppCard`, `HomeAppShortcut`) |

Rules:

- Elements never import blocks; blocks never import features.
- Blocks are props-only: no data fetching, no router coupling. Features supply
  behavior.
- A block used by exactly one feature lives in that feature's folder until a
  second consumer exists.
- Renaming directories to `elements/blocks/features` is possible later; it is
  deliberately **not** part of this change — the tiers are enforced by the
  rules above, not by folder names.

## The composition

```text
PlatformShell (feature-tier composition root)
├─ PlatformNavigation            drawer: destinations, brand, attention count
└─ inset card
   ├─ TopBar                     ☰ [back?] title ── [action?] — the only h1
   └─ route content              starts immediately; no headers of its own
```

`TopBar` is props-only. Its public contract is `title`, optional `action`,
optional back navigation, and `placement`. Nothing app-specific lives in the
block. Each route renders its own bar as the first child of the route viewport.
App routes use `AppTopBar`, a feature-tier adapter that resolves app identity
and Improve / Use / Close navigation before passing props to `TopBar`.

The implementation deliberately has no title projection hook and no
path-to-title registry. The route owns its title and its single `h1`; the shell
owns the drawer, inset card, and route viewport.

## Deletions

| Component | Fate | Reasoning |
|---|---|---|
| `PlatformShell` inline `<header>` | deleted | replaced by `TopBar` |
| `PageHeader` | **deleted as a component** | after the bar takes title + action, it held only typography; typography is classes, not a component |
| `HeaderLayout` | deleted; its single consumer (`home.tsx`) inlines the markup | one consumer does not justify a contract |
| `AppChrome` | **deleted** | fully redundant: title/actions → `TopBar`; status → `FocusedAppFrame` states; overlay → `placement` |
| `AppContextChrome` | replaced by `AppTopBar` — a feature-tier component | the value was the routing adapter, not a second chrome pattern; Improve/Use/Close navigation and nested-title composition survive |
| `fullBleedRoute` regexes | deleted | the two routes declare `placement: "overlay"` themselves |

`PageHeaderProps.action`, `compact`: gone with the component. The 3xl display
heading disappears from screens entirely; if a future entity page genuinely
needs a display-scale identity block, that is that feature's content, built
from elements — not a shared chrome component.

## Action policy as implemented

- Primary route actions move into the bar: Create dApp, Generate code, Open
  gallery, and the app-specific Improve / Use / Close controls supplied by
  `AppTopBar`.
- Existing manual Refresh controls remain available on the routes that already
  exposed them. The shell migration changes their placement, not their
  behavior. Automatic revalidation may replace individual controls later, but
  that requires route-specific evidence rather than a shell-wide deletion.
- The default action slot remains empty.

## What stays true from the earlier docs

- Route-owned titles: the route owns both the value and the `TopBar`; the
  shell owns the drawer, inset card, and viewport placement.
- The ~100px per screen reclaim requires the route-wrapper padding pass
  (32 wrappers with `py-8` sized for the deleted 3xl heading).
- Composite nested titles (`RecipeBot · Add allergy tags`) must be reproduced
  verbatim by `AppTopBar` — 29 spec files assert `h1` text and count, and
  they keep passing only if the strings match.
- Spec locators scoped inside route containers must rescope to the page.
- Hosted-iframe mount continuity, hash/deep-link, native Back, and bridge
  contracts are untouched.

## What shipped

All seven steps landed. Notes where the build refined the plan:

- **Routes render their own `TopBar`.** No projection layer (`useTopBar`) was
  needed: the route owns both its bar and its `h1`, the shell owns the drawer
  and the inset card. This resolved the original contract conflict with no new
  machinery, and made the auth/error screens ordinary rather than exceptional.
- **`AppTopBar`** (`@/features/apps/app-top-bar.tsx`) replaced
  `AppContextChrome` as a feature-tier component rather than a hook, so the
  12 app routes kept their conditional-render ergonomics.
- **`FocusedAppFrame.onFrameLoad` was deleted** — it existed only to feed
  AppChrome's status dot.
- **Safe areas:** the bar owns the top inset; the route viewport owns the
  horizontal insets it sits inside; an overlay bar offsets itself by the
  horizontal insets. `data-viewport-mode` is gone — a screen is full-bleed
  exactly when its bar is `overlay`, expressed in CSS with `:has()`.
- **Refresh behavior was preserved.** Existing `refreshKey` / `reloadToken`
  state and `NotificationsContent.onRefresh` remain connected to route actions
  in the new bar.
- **One known regression, tracked separately:** because chrome is route-owned,
  a route render error now unmounts the navigation trigger with it. An error
  boundary around the route viewport is the follow-up.

## Migration order

1. Add `TopBar` and the menu trigger; delete the inline shell header.
2. Auth/error screens: demote card `h1`s to `h2`.
3. `AppTopBar`; migrate the app routes; delete `AppChrome` +
   `AppContextChrome`; `/open` and `/preview` declare `overlay`.
4. Platform sweep: delete all 27 `PageHeader` usages, apply the action policy,
   fix the 32 wrappers' padding.
5. Delete `page-header.tsx`; inline `HeaderLayout` into `home.tsx`.
6. Rescope affected spec locators; full test run.
7. Amend `shell-refinement-guide.md`: replace the `PageHeader` and
   `AppChrome`/`FocusedAppFrame` contract entries with `TopBar`, and add the
   three-tier placement rules.

## Acceptance statement

One drawer, one bar, one `h1`. Elements compose into blocks, blocks into
features, and no screen spends two bars saying where you are.
