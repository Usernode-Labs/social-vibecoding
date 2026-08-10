# Admin console shadcn restyle — design

**Date:** 2026-08-10
**Status:** Approved for planning
**Approach:** Shared recipe registry (`AdminUI`) in `public/js/admin-console.js`, applied across all admin sections. No React conversion.

## Goal

Restyle the entire admin console — all 18 sections plus the shared chrome (desktop
sidebar nav, mobile two-level menu, section headers, view-only banner, modals) — to
the shadcn/ui dashboard-blocks visual language: cards, bordered tables, and a
consistent button/badge/input hierarchy. The restyle is a **visual refresh with zero
behavior change**: every control, table column, workflow, id, and DOM position stays
where it is.

## Non-goals

- No React conversion. `admin-console.js` and the `admin-*.js` section modules keep
  all their logic; this is not the step-2 migration.
- No layout regrouping, no new features, no removed features.
- No changes to `frontend/`, `Shell.tsx`, or `public/index.html` — the admin
  interior is JS-rendered into `#admin-root`, whose frozen host markup is untouched.
- No changes to admin API routes or payloads.
- Chart rendering internals in `admin-analytics.js` are out of scope; only their
  container cards are restyled.

## The `AdminUI` recipe registry

A frozen, data-only global defined near the top of `public/js/admin-console.js`,
which loads before all ten delegated `admin-*.js` section modules (verified against
the script order in `frontend/src/Shell.tsx`).

```js
window.AdminUI = Object.freeze({
  // Surfaces
  card, cardHeader, cardTitle, cardDescription, cardContent, cardFooter,
  // Tables
  tableWrap, table, thead, th, td, trHover,
  // Controls
  btn: Object.freeze({ primary, outline, ghost, destructive, sm, icon }),
  input, select, textarea, label,
  // Status
  badge: Object.freeze({ default, secondary, outline, destructive, success, warn }),
  // Overlay
  dialogOverlay, dialogPanel,
  // Typography / misc
  sectionTitle, muted, separator, kbd,
});
```

Recipe derivation rules (authoritative, in priority order):

1. **Buttons:** copied verbatim from the variant table in
   `frontend/@/components/ui/button.tsx`, so admin buttons pixel-match the shell's
   React `Button`. That file is the precedent for the whole registry: shadcn's
   recipe re-expressed as explicit utilities (`cssVariables: false` — no CSS-var
   theme layer).
2. **Everything else:** shadcn's `default`-style recipe transcribed to the
   console's existing palette mapping — borders `zinc-200` / `dark:zinc-800`,
   surfaces `white` / `dark:zinc-900`, primary accent `violet-600`
   (hover `violet-500`), muted text `zinc-500`/`zinc-400`. Every recipe carries
   explicit `dark:` variants; the console already uses this light+dark discipline.
   Example: `card` = `rounded-xl border border-zinc-200 dark:border-zinc-800
   bg-white dark:bg-zinc-900 shadow-sm`.
3. **`badge.success` / `badge.warn`** (which stock shadcn lacks) use the console's
   existing emerald / amber conventions, restated in the shadcn badge shape.

The registry holds class strings only — no functions, no logic. One-off spacing or
sizing is appended at the call site: `class="${AdminUI.card} mt-4"`.

## Application pass

Every template string in `admin-console.js` (shared chrome + the inline sections:
users, codes, limits, features, featured-apps, rollover, staging-reap, db-export)
and in the ten delegated modules (`admin-status.js`, `admin-node.js`,
`admin-analytics.js`, `admin-estimator.js`, `admin-merges.js`, `admin-gallery.js`,
`admin-campaigns.js`, `admin-mail.js`, `admin-topochain.js`) swaps its ad-hoc class
strings for `${AdminUI.x}` interpolations.

Hard rules for the pass:

- **ids, `data-*` attributes, and element structure are untouched.** New wrapper
  elements are allowed only where a recipe strictly needs one (e.g. a table's
  rounded-border scroll wrapper), and never around an element that a test or the
  JS selects by position (`firstElementChild`, `children[n]`, `:nth-child`, etc.).
- **Marker classes are audited first and preserved verbatim.** Before editing each
  file, enumerate every class the JS itself queries or toggles (`hidden`,
  `admin-menu-row`, anything appearing in `classList.*`, `querySelector*`, or
  `closest` calls) and keep those class names alongside the recipes.
- The `hidden` show/hide idiom is untouched everywhere.
- Escaping conventions (`AdminConsole.esc`) and all interpolated data stay as-is.

## Guard test

New `tests/admin-ui-registry.test.js`, following the repo's existing
static-analysis test style: regex-extract every `AdminUI.<key>` and
`AdminUI.<group>.<key>` reference across `public/js/admin-console.js` and
`public/js/admin-*.js`, parse the registry's defined keys from the
`admin-console.js` source, and assert every reference resolves. A typo'd recipe
reference fails CI instead of silently rendering `class="undefined"`.

## Build and verification workflow

Only `public/js/**` and `tests/` change:

- **No `build:shell`** — no `frontend/` sources are touched, so the committed
  `public/index.html` / `public/shell/assets/shell.js` artifacts stay as they are.
- **`npm run build:css` after the JS edits**, committing the regenerated
  `public/css/tailwind.css` in the same commit. Tailwind's content globs already
  scan `public/js/**`, so registry classes compile.
- Full test suite must pass, with particular attention to the 13
  `tests/admin-*.test.js` files and `tests/tailwind-build.test.js`.
- Zero console errors on any route (a console error fails proposal checks).
- **Visual QA is the main risk** given "everything in one go": walk all 18
  sections in the running app, before/after, in both light and dark themes, at
  desktop and mobile widths (the mobile two-level nav is its own code path).

## Delivery shape

One branch, committed in bisectable groups:

1. `AdminUI` registry + guard test.
2. Shared chrome (sidebar, mobile menu, banners, modals) + inline sections in
   `admin-console.js`.
3. Delegated modules, a few per commit (`admin-topochain.js`, at 210 KB, gets its
   own commit).
4. Each commit that adds new utility classes includes its `build:css` output.

## Success criteria

- All 18 admin sections and the shared chrome render in the shadcn dashboard-block
  style, visually consistent with each other and with the shell's existing
  zinc/violet look.
- No behavior change: every workflow works exactly as before; ids and DOM
  structure unchanged except cosmetic-only wrappers.
- Full test suite green, including the new registry guard test; no stale build
  artifacts; no console errors on any route.
