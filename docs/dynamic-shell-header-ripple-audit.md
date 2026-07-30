# Dynamic shell header — ripple audit

**Status:** Historical findings; reconciled with the implemented TopBar sweep

**Date:** 2026-07-30

**Companion to:** `platform-navigation-proposal.md`,
`shell-refinement-guide.md`, and the refinement design
(`dynamic-shell-header-refinement.md`)

This is the pre-implementation ripple audit. It is retained because its
duplicate-chrome, wrapper-spacing, and locator findings shaped the shipped
sweep. Names and recommendations below describe that historical tree. The
implemented result is `TopBar` plus the feature-tier `AppTopBar`; there is no
`ShellContextBar`, `PageHeader`, `AppChrome`, or `AppContextChrome` in current
production source.

## Finding 1 — the app lane has the same bug, and it was never counted

The refinement doc described the two-bar problem as a `PageHeader` problem
across 27 platform routes. It is worse than that.

Twelve app routes (`app-details`, `app-dev`, `app-members`, `app-recovery`,
`dev-session`, `session-spec-viewer`, `shared-session`, `group-discussion`,
`dev-proposal-detail`, `dev-governance-detail`, `github-issue-detail`, plus
the `app-context-chrome` adapter) render **no `PageHeader` at all** — their
`h1` lives inside `AppChrome`, via `AppContextChrome` with `placement="flow"`.

Meanwhile `platform-shell.tsx`'s `fullBleedRoute` suppresses the shell header
for exactly two patterns:

```
/apps/:slug/open
/apps/:slug/dev/sessions/:sessionId/preview
```

So every other app route rendered the static `dApps` bar **plus** the
AppChrome bar. Totals across 39 routes follow. The two full-bleed routes are
part of the app lane, not an additional bucket:

| Lane | Routes | Today |
|---|---|---|
| Platform (`PageHeader` owns `h1`) | 27 | `dApps` bar + page header = **2 bars** |
| App flow (`AppChrome` owns `h1`) | 10 | `dApps` bar + app chrome = **2 bars** |
| App full-bleed (`/open`, `/preview`) | 2 | AppChrome alone = **1 bar** ✓ |

**37 of 39 routes ship two bars.** The sweep is 39 routes, not 27, and the two
lanes must converge on one bar rather than being fixed separately.

## Finding 2 — most `PageHeader` actions must not be promoted at all

Of 27 `PageHeader` usages, 15 pass `action`. Broken down:

| Action | Count | Routes |
|---|---|---|
| Refresh / reload only | 12 | work, account, settings, node-status, status, admin-overview, admin-users, admin-features, spend-limits, merge-debug, notifications (+ more), … |
| Genuine primary action | 3 | `Create dApp` (explore), `Generate code` (activation-codes), `Open gallery` (gallery — alongside a Refresh) |

**Twelve of fifteen "primary actions" are Refresh.** That is not a primary
action; it is a data-staleness workaround occupying the most valuable slot on
the screen. The accepted proposal already rules on this — its contextual-action
table says Activity gets "Mark all read; **secondary refresh in overflow**",
and "Home | None required".

The audit recommended demoting or removing routine Refresh actions. The owner
subsequently required the composed-shell ideas to survive without losing
working behavior, so the implementation preserves those existing Refresh
controls in `TopBar`. Their eventual replacement by automatic revalidation is
a route-level decision, not part of this shell sweep.

This confirms the reading that prompted this audit: `PageHeader` should carry
no actions, and the context bar taking over is correct — but most of what
`PageHeader` carries today should not be promoted anywhere.

## Finding 3 — remove the props, do not merely stop using them

- `action` must leave `PageHeaderProps`. Left in place, the next contributor
  re-adds a route action below the bar and the duplication returns.
- `compact` has **zero** feature consumers (only `page-header.tsx` itself and
  its stories). Dead prop — delete it with the sweep.
- `HeaderLayout` has exactly **one** consumer (`home.tsx`). The claim that it
  "survives as the section-heading layout" is thinner than assumed; keep it,
  but do not treat it as load-bearing.

## Finding 4 — the space saving lives in the route wrappers, not the bar

The bar is 56px against the old header's 64px — only 8px. The real reclaim
comes from what sits below it:

- **32 route wrappers** hardcode
  `isolate flex w-full flex-1 flex-col gap-6 px-4 py-8 antialiased sm:px-6`.
  That `py-8` (32px) exists to breathe under a 3xl display heading.
- Removing the `PageHeader` block itself is ~76px (heading + gap).

8px (bar) + ~76px (header block) + 16px (py-8 → py-4) ≈ **100px per screen**.
If the sweep does not touch those 32 wrappers, the change costs a refactor and
delivers 8px. **The wrapper padding pass is not optional polish; it is where
the goal is met.**

## Finding 5 — four routes will render two `h1`s (real breakage)

`/login`, `/register`, `*` (not-found), and the wallet-access screens all sit
**inside** `PlatformShell` and already own an `h1` inside a `Card`/`Empty`:

| Route | Existing `h1` |
|---|---|
| `/login` | "Welcome back" / "Reset your password" / "Finish signing out" |
| `/register` | "Create your account" |
| `*` | "Page not found" |
| wallet-access | dynamic `title` |

A bar that unconditionally renders a title `h1` produces **two `h1`s** on these
screens: an axe *serious* landmark/heading violation, plus failures in
`not-found.spec.ts` and friends asserting `toHaveCount(1)`.

Implemented outcome: no suppression registry. Auth and error routes render the
same `TopBar`, and their card or empty-state titles were demoted so the route
still has exactly one `h1`. The drawer trigger remains available.

## Finding 6 — tests mostly survive; the break is locator scope, not text

29 spec files assert `getByRole("heading", { level: 1 })`, by accessible name
or by count. Because the bar renders the same text at the same heading level,
**name and count assertions keep passing** — this is what makes the refactor
verifiable rather than a rewrite.

Two real breakages:

1. **Route-scoped locators.** Specs that assert the `h1` *within* a route
   container (e.g. `work.getByRole("heading", { level: 1 })`) fail, because the
   `h1` moves out of the route subtree and into the shell. Those locators must
   be rescoped to the page.
2. **Composite nested titles.** AppChrome composes
   `RecipeBot · Add allergy tags` from `app.name` + `nestedLabel`, and specs
   assert that exact string. The bar's override path must reproduce the
   composition verbatim, or `app-dev`/`github-issues`/`dev-session` specs fail.

## Finding 7 — `AppChrome` and `ShellContextBar` are now one job, two components

After the overlay change, `ShellContextBar` does menu + back + title + actions
+ overlay placement. `AppChrome` does identity + title + status dot +
Improve/Use/Close/overflow + overlay placement. The overlap is nearly total —
precisely the duplication the original audit flagged between the shell header
and `PageHeader`.

Implemented outcome: `TopBar` is the shared props-only block. `AppTopBar` is
the thin feature-tier routing adapter. `AppChrome`, `AppContextChrome`, and
the experimental `ShellContextBar` are absent.

## Historical sweep order and shipped resolution

1. Add the bar-title projection (`useShellBar`) plus the **suppression rule**
   for auth/error/full-bleed routes (Finding 5) — before any route edits.
2. Converge the app lane: fold `AppChrome` into the bar, keep
   `AppContextChrome` as adapter, preserve composite nested titles (Findings
   1, 7, 6.2).
3. Platform lane: delete `PageHeader` usages; promote **3** actions, demote
   **12** Refreshes to overflow (Finding 2).
4. Remove `action` and `compact` from `PageHeaderProps` (Finding 3).
5. Sweep the 32 route wrappers' padding (Finding 4).
6. Rescope route-scoped `h1` locators; re-run the 29 affected specs
   (Finding 6.1).
7. Amend `shell-refinement-guide.md` contracts per the refinement doc.

The shipped sequence differed in one important way: routes render `TopBar`
directly instead of projecting state into a shell hook. That keeps title
authority with the route and avoids another registry. Manual Refresh actions
were preserved. The remaining structural findings—one bar, one `h1`, overlay
placement for the two full-bleed routes, wrapper-padding reduction, old chrome
deletion, and locator migration—were implemented.
