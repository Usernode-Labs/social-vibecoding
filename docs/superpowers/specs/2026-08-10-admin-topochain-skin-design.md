# Admin console: topochain visual skin

**Date:** 2026-08-10
**Status:** Approved (design reviewed in session; dark variants / full sweep / system font confirmed by user)

## Goal

Make `/#admin/` look exactly like the admin UI of the sibling `../topochain`
repo (Laravel Blade + Tailwind v4, gray/indigo, Heroicons-outline). **Visual
style only** — icons, fonts, buttons, inputs, cards, tables, badges, nav.
Content, DOM structure, ids, routes, and behavior are unchanged.

## Decisions (user-confirmed)

1. **Dark mode:** topochain's admin is light-only. Ours keeps dark variants:
   light mode matches topochain verbatim; dark mode is a faithful translation
   (white → gray-900 surfaces, gray-200 → gray-800 borders, gray-900 →
   gray-100 text, indigo-600 accent with indigo-400 text accents).
2. **Scope:** full sweep. All 10 `public/js/admin-*.js` files, including
   converting `admin-node.js` off its private `--un-ns-*` CSS-variable look.
3. **Font:** system stack. Topochain declares `Instrument Sans` but never
   loads it, so its real rendered font is the system sans — same as ours.
   No font work.
4. **Page background:** keep the app's own page background. The admin area is
   not painted `bg-gray-100`; the surrounding shell stays app-styled.
5. **Sidebar icons:** nav items gain inline Heroicons-v2-outline icons
   (`w-5 h-5`, `stroke-width="1.5"`), matching topochain's sidebar.

## Approach

Rewrite the frozen `AdminUI` recipe registry
(`public/js/admin-console.js:71`) from zinc/violet to topochain's gray/indigo
vocabulary, then sweep every `admin-*.js` for one-off class strings,
converting them to the same vocabulary (through the registry where a recipe
fits). This repeats the mechanism proven safe by #1059: dapp.json checks and
unit tests pin ids/text, never classes.

Rejected alternatives:

- **CSS-variable theme layer** — the repo deliberately runs shadcn with
  `cssVariables: false`; introducing tokens contradicts that decision.
- **Porting topochain's Blade component markup** — changes structure/content,
  which is out of scope and breaks id/selector-pinning tests.

## Visual mapping

Light mode is topochain verbatim; dark classes appended per the translation
rule above.

| Recipe | New value (light part) |
|---|---|
| `card` | `bg-white rounded-xl border border-gray-200 shadow-sm` |
| `cardTitle` | `text-lg font-semibold text-gray-900` |
| `cardDescription` / `muted` | `text-sm text-gray-500` |
| `btn.primary` | `bg-indigo-600 hover:bg-indigo-700 text-white px-4 py-2 rounded-lg transition-colors text-sm font-medium` |
| `btn.outline` | `inline-flex items-center gap-1.5 px-3 py-1.5 text-sm font-medium text-gray-700 bg-white border border-gray-300 rounded-lg hover:bg-gray-50 transition-colors` |
| `btn.ghost` | `bg-gray-100 hover:bg-gray-200 text-gray-700 px-4 py-2 rounded-lg transition-colors text-sm font-medium` (topochain "secondary") |
| `btn.destructive` | `bg-red-600 hover:bg-red-700 text-white px-4 py-2 rounded-lg transition-colors text-sm font-medium` |
| `btn.link` | `text-indigo-600 hover:text-indigo-800 text-sm` |
| `btn.*Sm` | same hue set at `px-3 py-1.5` / `text-xs` compact sizing |
| `input`/`select`/`textarea` | `w-full border border-gray-300 rounded-lg px-3 py-2 text-sm text-gray-900 focus:ring-2 focus:ring-indigo-500 focus:border-indigo-500` |
| `label` | `block text-sm font-medium text-gray-700 mb-1` |
| `tableWrap` | `rounded-lg border border-gray-200` (no `overflow-x-auto` — test-enforced) |
| `thead` | `bg-gray-50` |
| `th` | `px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider` |
| `td` | `px-6 py-4 text-sm text-gray-900` |
| `trHover` | `hover:bg-gray-50 transition-colors` |
| `badge.*` | `inline-flex items-center rounded-full px-2 py-0.5 text-xs font-medium bg-{c}-50 text-{c}-700 ring-1 ring-inset ring-{c}-700/10`; default=gray, secondary=indigo, success=emerald, warn=amber, destructive=red |
| `dialogPanel` | `bg-white rounded-xl shadow-xl` panel over `bg-black/50` overlay |
| sidebar group label | `px-3 py-1.5 text-xs font-semibold text-gray-400 uppercase tracking-wider` |
| sidebar link | `flex items-center gap-3 px-3 py-2.5 text-sm font-medium rounded-md`; active `bg-gray-100 text-gray-900`, idle `text-gray-600 hover:bg-gray-50` |
| page title | `text-2xl font-bold text-gray-900` |

Semantic hues: indigo = accent/links/focus, amber = edit affordances,
red = destructive, emerald = success/active. Violet disappears from admin
code entirely; neutral scale moves from re-tinted `zinc` to stock `gray`
(which is exactly topochain's palette, since topochain uses stock Tailwind).

Icons: all inline SVGs normalized to Heroicons-v2-outline style
(`fill="none" stroke="currentColor" viewBox="0 0 24 24"`), `stroke-width`
1.5 for nav (`w-5 h-5`), 2 for small action/utility icons.

## Full-sweep specifics

- `admin-node.js`: markup switches to registry classes; its `#admin-node-root`
  CSS-variable rules in `public/css/app.css` are removed.
- `#admin-status-root .pill*` rules in `app.css` are **recolored** to
  topochain's palette (emerald/amber/red/gray), not deleted — the `pill-*`
  class names are behavioral markers.
- Every `admin-*.js` file swept: no `violet-` or `zinc-` class survives in
  admin code.

## Hard constraints

- No `overflow-x-auto` anywhere in `admin-console.js`
  (`tests/admin-console-page.test.js`).
- All existing `AdminUI` keys kept; values remain pure class-string literals
  (`tests/admin-ui-registry.test.js`).
- Marker classes and ids survive: `hidden`, `admin-nav-item`,
  `admin-menu-row`, `admin-only`, `is-admin`, `pill`/`pill-*`, `mono`,
  `data-admin-section`, all element ids.
- Mobile nav rules hold: list not tabs (no `role="tab"`/`aria-selected`),
  44px targets, `md:` stays the breakpoint
  (`tests/admin-mobile-hierarchy.test.js`).
- No `frontend/` edits → no `build:shell`, no markup-parity risk.
- Tailwind stays v3.4.17. Topochain's strings are v4-authored but every class
  used is v3.4-compatible (`size-*`, `text-sm/6`, ring opacity).
- After JS/CSS edits: `npm run build:css` and commit
  `public/css/tailwind.css` in the same commit
  (`tests/tailwind-build.test.js`).

## Testing

- Existing suites are the safety net: `admin-ui-registry`,
  `admin-console-page`, `admin-mobile-hierarchy`, `tailwind-build`, plus all
  per-section admin tests and the dapp.json selector checks.
- Update any test only if it asserts old class fragments (registry test
  asserts shape, not hues — expected to pass unmodified).
- Manual pass: open every admin section in light and dark themes and compare
  against topochain's admin.
