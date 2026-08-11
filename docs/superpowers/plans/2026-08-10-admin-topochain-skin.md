# Admin Topochain Skin Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Restyle the `/#admin` console to look exactly like `../topochain`'s admin UI (gray neutrals, indigo accent, Heroicons-outline, airy tables, ring-tinted pill badges) — classes only, zero content/structure/behavior change.

**Architecture:** Rewrite the frozen `AdminUI` class-recipe registry in `public/js/admin-console.js` to topochain's vocabulary, then run a deterministic hue sweep (`zinc-→gray-`, `violet-→indigo-` + hover/focus fixups) over every `public/js/admin-*.js`, convert `admin-node.js` off its CSS-variable look, recolor the status pills in `app.css`, and rebuild the committed Tailwind artifact. Spec: `docs/superpowers/specs/2026-08-10-admin-topochain-skin-design.md`.

**Tech Stack:** Vanilla JS template-literal rendering, Tailwind v3.4.17 (compiled, committed artifact), node:test suites.

## Global Constraints

- Tailwind stays pinned at **v3.4.17**; light mode is topochain verbatim, dark mode is the translation white→gray-900, gray-200→gray-800 (borders), gray-900→gray-100 (text), gray-50→gray-800/50 (tint fills), indigo-600 stays with indigo-400/300 for dark text accents.
- **Never** introduce `overflow-x-auto` anywhere in `admin-console.js` (`tests/admin-console-page.test.js` regexes raw source).
- `AdminUI` keeps **all existing keys**; every value stays a complete class-string literal with no `$`, `{`, `}` (`tests/admin-ui-registry.test.js`); never index it dynamically.
- Marker classes and ids must survive verbatim: `hidden`, `admin-nav-item`, `admin-menu-row`, `admin-only`, `is-admin`, `pill` / `pill-running|stopped|missing|creating`, `mono`, every `data-admin-section` / `data-featured-*`, every element id.
- Mobile menu stays a list: no `role="tab"` / `aria-selected` inside `_mobileMenuHtml` (desktop sidebar keeps its existing `role="tab"`), rows keep `min-h-[44px]`, `md:` stays the only breakpoint (`tests/admin-mobile-hierarchy.test.js`).
- **No edits under `frontend/`** → do not run `build:shell`. After all JS/CSS edits: `npm run build:css` and commit `public/css/tailwind.css` in the same commit (`tests/tailwind-build.test.js`).
- Icons are inline Heroicons-v2-outline literals (`fill="none" stroke="currentColor" viewBox="0 0 24 24"`), `stroke-width="1.5"` `w-5 h-5` for nav, `stroke-width="2"` for small utility chevrons. No icon library, no CDN.
- macOS/BSD sed: always `sed -i ''` (empty-string backup arg).
- Run tests with `node --test tests/<file>` from the repo root.

---

### Task 1: Rewrite the AdminUI registry

**Files:**
- Modify: `public/js/admin-console.js:61-120` (the comment header + `window.AdminUI` literal)

**Interfaces:**
- Produces: `window.AdminUI` with the exact same key set as today (`card`, `cardHeader`, `cardTitle`, `cardDescription`, `tableWrap`, `table`, `thead`, `th`, `td`, `trHover`, `btn.{primary,outline,destructive,ghost,link,primarySm,outlineSm,destructiveSm}`, `input`, `select`, `textarea`, `label`, `badge.{default,secondary,outline,destructive,success,warn}`, `dialogOverlay`, `dialogPanel`, `sectionTitle`, `muted`, `separator`, `kbd`). Later tasks rely on these names being unchanged.

- [ ] **Step 1: Replace the registry block**

Replace lines 61–120 (comment + frozen object) with:

```js
// ── AdminUI: shared class recipes, topochain admin vocabulary (see
// docs/superpowers/specs/2026-08-10-admin-topochain-skin-design.md) ──────
// Data-only class-string constants used by this file and every admin-*.js
// section module (all of which load after this file — see the script order
// in frontend/src/Shell.tsx). Light mode matches ../topochain's admin
// verbatim (gray neutrals, indigo accent); dark: variants are the fixed
// translation documented in the spec. Every value is a COMPLETE class
// literal: Tailwind's extractor is a regex over public/js/** source, and
// tests/admin-ui-registry.test.js + tests/tailwind-build.test.js enforce
// the discipline. Never index this registry dynamically.
window.AdminUI = Object.freeze({
  // Surfaces — topochain card: white, rounded-xl, gray-200 hairline, soft shadow.
  card: 'bg-white dark:bg-gray-900 rounded-xl border border-gray-200 dark:border-gray-800 shadow-sm',
  cardHeader: 'flex items-center justify-between gap-2 mb-4',
  cardTitle: 'text-lg font-semibold text-gray-900 dark:text-gray-100',
  cardDescription: 'text-sm text-gray-500 dark:text-gray-400',
  // Tables — topochain data-table. NOTE: deliberately no sideways-scroll
  // utility on the wrapper — nothing in the console scrolls horizontally
  // (#860, pinned by admin-console-page.test.js, which regexes this file's
  // raw source).
  tableWrap: 'w-full rounded-lg border border-gray-200 dark:border-gray-800',
  table: 'w-full text-sm',
  thead: 'border-b border-gray-200 dark:border-gray-800 bg-gray-50 dark:bg-gray-900/50',
  th: 'px-6 py-3 text-left align-middle text-xs font-medium uppercase tracking-wider text-gray-500 dark:text-gray-400',
  td: 'px-6 py-4 align-middle',
  trHover: 'border-b border-gray-100 dark:border-gray-800/60 transition-colors hover:bg-gray-50 dark:hover:bg-gray-800/50',
  // Buttons — topochain's canonical button strings.
  btn: Object.freeze({
    primary: 'bg-indigo-600 hover:bg-indigo-700 text-white px-4 py-2 rounded-lg transition-colors text-sm font-medium',
    outline: 'inline-flex items-center gap-1.5 px-4 py-2 text-sm font-medium text-gray-700 dark:text-gray-300 bg-white dark:bg-gray-900 border border-gray-300 dark:border-gray-700 rounded-lg hover:bg-gray-50 dark:hover:bg-gray-800 transition-colors',
    destructive: 'bg-red-600 hover:bg-red-700 text-white px-4 py-2 rounded-lg transition-colors text-sm font-medium',
    ghost: 'font-medium transition-colors text-gray-500 hover:text-gray-700 dark:text-gray-400 dark:hover:text-gray-200',
    link: 'font-medium transition-colors text-indigo-600 hover:text-indigo-800 dark:text-indigo-400 dark:hover:text-indigo-300',
    primarySm: 'bg-indigo-600 hover:bg-indigo-700 text-white px-3 py-1.5 rounded-lg transition-colors text-xs font-medium',
    outlineSm: 'inline-flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium text-gray-700 dark:text-gray-300 bg-white dark:bg-gray-900 border border-gray-300 dark:border-gray-700 rounded-lg hover:bg-gray-50 dark:hover:bg-gray-800 transition-colors',
    destructiveSm: 'bg-red-600 hover:bg-red-700 text-white px-3 py-1.5 rounded-lg transition-colors text-xs font-medium',
  }),
  // Form controls — topochain's canonical input string (+ dark translation).
  input: 'w-full border border-gray-300 dark:border-gray-700 bg-white dark:bg-gray-800 rounded-lg px-3 py-2 text-sm text-gray-900 dark:text-gray-100 placeholder:text-gray-400 dark:placeholder:text-gray-500 focus:outline-none focus:ring-2 focus:ring-indigo-500 focus:border-indigo-500',
  select: 'w-full border border-gray-300 dark:border-gray-700 bg-white dark:bg-gray-800 rounded-lg px-3 py-2 text-sm text-gray-900 dark:text-gray-100 focus:outline-none focus:ring-2 focus:ring-indigo-500 focus:border-indigo-500',
  textarea: 'w-full min-h-[80px] border border-gray-300 dark:border-gray-700 bg-white dark:bg-gray-800 rounded-lg px-3 py-2 text-sm text-gray-900 dark:text-gray-100 placeholder:text-gray-400 dark:placeholder:text-gray-500 focus:outline-none focus:ring-2 focus:ring-indigo-500 focus:border-indigo-500',
  label: 'text-sm font-medium text-gray-700 dark:text-gray-300',
  // Badges — topochain's ring-tinted rounded-full pills.
  badge: Object.freeze({
    default: 'inline-flex items-center rounded-full px-2 py-0.5 text-xs font-medium bg-gray-50 text-gray-600 ring-1 ring-inset ring-gray-500/10 dark:bg-gray-500/10 dark:text-gray-300 dark:ring-gray-400/20',
    secondary: 'inline-flex items-center rounded-full px-2 py-0.5 text-xs font-medium bg-indigo-50 text-indigo-700 ring-1 ring-inset ring-indigo-700/10 dark:bg-indigo-500/10 dark:text-indigo-300 dark:ring-indigo-400/20',
    outline: 'inline-flex items-center rounded-full border border-gray-300 dark:border-gray-700 px-2 py-0.5 text-xs font-medium text-gray-600 dark:text-gray-300',
    destructive: 'inline-flex items-center rounded-full px-2 py-0.5 text-xs font-medium bg-red-50 text-red-700 ring-1 ring-inset ring-red-700/10 dark:bg-red-500/10 dark:text-red-300 dark:ring-red-400/20',
    success: 'inline-flex items-center rounded-full px-2 py-0.5 text-xs font-medium bg-emerald-50 text-emerald-700 ring-1 ring-inset ring-emerald-700/10 dark:bg-emerald-500/10 dark:text-emerald-300 dark:ring-emerald-400/20',
    warn: 'inline-flex items-center rounded-full px-2 py-0.5 text-xs font-medium bg-amber-50 text-amber-700 ring-1 ring-inset ring-amber-700/10 dark:bg-amber-500/10 dark:text-amber-300 dark:ring-amber-400/20',
  }),
  // Overlay — topochain modal: black/50 backdrop, xl-rounded white panel.
  dialogOverlay: 'fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-4',
  dialogPanel: 'w-full max-w-md bg-white dark:bg-gray-900 rounded-xl border border-gray-200 dark:border-gray-800 p-6 shadow-xl',
  // Typography / misc.
  sectionTitle: 'text-lg font-semibold text-gray-900 dark:text-gray-100',
  muted: 'text-sm text-gray-500 dark:text-gray-400',
  separator: 'border-t border-gray-200 dark:border-gray-800',
  kbd: 'rounded border border-gray-300 dark:border-gray-700 bg-gray-100 dark:bg-gray-800 px-1.5 py-0.5 font-mono text-xs text-gray-700 dark:text-gray-300',
});
```

Notes: `ghost` and `link` stay text-style buttons (their call sites are bare
text affordances — a filled "secondary" pill would change layout); `link`
adopts topochain's `text-indigo-600 hover:text-indigo-800` link hues.
`label` deliberately does NOT gain `block`/`mb-1` — call sites control layout.

- [ ] **Step 2: Run the registry + console tests**

Run: `node --test tests/admin-ui-registry.test.js tests/admin-console-page.test.js`
Expected: PASS (all keys resolve, values are pure literals, no `overflow-x-auto`).

- [ ] **Step 3: Commit**

```bash
git add public/js/admin-console.js
git commit -m "Restyle AdminUI registry to topochain gray/indigo vocabulary"
```

---

### Task 2: Console chrome — sidebar icons, nav, mobile menu, shell

**Files:**
- Modify: `public/js/admin-console.js` (`_navItemsHtml` ~:551, `_mobileMenuHtml` ~:574, `_renderShell` ~:596; add `NAV_ICONS` right after `LEGACY_SECTION_KEYS` ~:220)

**Interfaces:**
- Consumes: `AdminUI` recipes from Task 1.
- Produces: `AdminConsole.NAV_ICONS` — frozen map, section key → complete inline `<svg>` string (used by both nav renderers; nothing outside this file uses it).

- [ ] **Step 1: Add the NAV_ICONS map**

Insert after the `LEGACY_SECTION_KEYS` object (before `_canonicalSection`):

```js
  // Heroicons v2 outline, one per section — same icon treatment as
  // ../topochain's admin sidebar (w-5 h-5, stroke-width 1.5). Path data is
  // copied from topochain's blade views where an equivalent icon exists.
  // Complete inline literals; the shell loads no cross-origin assets.
  NAV_ICONS: Object.freeze({
    'overview': '<svg class="w-5 h-5 shrink-0" fill="none" stroke="currentColor" viewBox="0 0 24 24" stroke-width="1.5" aria-hidden="true"><path stroke-linecap="round" stroke-linejoin="round" d="M3.75 6A2.25 2.25 0 016 3.75h2.25A2.25 2.25 0 0110.5 6v2.25a2.25 2.25 0 01-2.25 2.25H6a2.25 2.25 0 01-2.25-2.25V6zM3.75 15.75A2.25 2.25 0 016 13.5h2.25a2.25 2.25 0 012.25 2.25V18a2.25 2.25 0 01-2.25 2.25H6A2.25 2.25 0 013.75 18v-2.25zM13.5 6a2.25 2.25 0 012.25-2.25H18A2.25 2.25 0 0120.25 6v2.25A2.25 2.25 0 0118 10.5h-2.25a2.25 2.25 0 01-2.25-2.25V6zM13.5 15.75a2.25 2.25 0 012.25-2.25H18a2.25 2.25 0 012.25 2.25V18A2.25 2.25 0 0118 20.25h-2.25A2.25 2.25 0 0113.5 18v-2.25z"/></svg>',
    'status': '<svg class="w-5 h-5 shrink-0" fill="none" stroke="currentColor" viewBox="0 0 24 24" stroke-width="1.5" aria-hidden="true"><path stroke-linecap="round" stroke-linejoin="round" d="M9 12.75L11.25 15 15 9.75M21 12a9 9 0 11-18 0 9 9 0 0118 0z"/></svg>',
    'node': '<svg class="w-5 h-5 shrink-0" fill="none" stroke="currentColor" viewBox="0 0 24 24" stroke-width="1.5" aria-hidden="true"><path stroke-linecap="round" stroke-linejoin="round" d="M21 7.5l-9-5.25L3 7.5m18 0l-9 5.25m9-5.25v9l-9 5.25M3 7.5l9 5.25M3 7.5v9l9 5.25m0-9v9"/></svg>',
    'merges': '<svg class="w-5 h-5 shrink-0" fill="none" stroke="currentColor" viewBox="0 0 24 24" stroke-width="1.5" aria-hidden="true"><path stroke-linecap="round" stroke-linejoin="round" d="M17.25 6.75L22.5 12l-5.25 5.25m-10.5 0L1.5 12l5.25-5.25m7.5-3l-4.5 16.5"/></svg>',
    'rollover': '<svg class="w-5 h-5 shrink-0" fill="none" stroke="currentColor" viewBox="0 0 24 24" stroke-width="1.5" aria-hidden="true"><path stroke-linecap="round" stroke-linejoin="round" d="M4.5 12a7.5 7.5 0 0015 0m-15 0a7.5 7.5 0 1115 0m-15 0H3m16.5 0H21m-1.5 0H12m-8.457 3.077l1.41-.513m14.095-5.13l1.41-.513M5.106 17.785l1.15-.964m11.49-9.642l1.149-.964M7.501 19.795l.75-1.3m7.5-12.99l.75-1.3m-6.063 16.658l.26-1.477m2.605-14.772l.26-1.477m0 17.726l-.26-1.477M10.698 4.614l-.26-1.477M16.5 19.794l-.75-1.299M7.5 4.205L12 12m6.894 5.785l-1.149-.964M6.256 7.794l-1.15-.964"/></svg>',
    'staging-reap': '<svg class="w-5 h-5 shrink-0" fill="none" stroke="currentColor" viewBox="0 0 24 24" stroke-width="1.5" aria-hidden="true"><path stroke-linecap="round" stroke-linejoin="round" d="M14.74 9l-.346 9m-4.788 0L9.26 9m9.968-3.21c.342.052.682.107 1.022.166m-1.022-.165L18.16 19.673a2.25 2.25 0 01-2.244 2.077H8.084a2.25 2.25 0 01-2.244-2.077L4.772 5.79m14.456 0a48.108 48.108 0 00-3.478-.397m-12 .562c.34-.059.68-.114 1.022-.165m0 0a48.11 48.11 0 013.478-.397m7.5 0v-.916c0-1.18-.91-2.164-2.09-2.201a51.964 51.964 0 00-3.32 0c-1.18.037-2.09 1.022-2.09 2.201v.916m7.5 0a48.667 48.667 0 00-7.5 0"/></svg>',
    'users': '<svg class="w-5 h-5 shrink-0" fill="none" stroke="currentColor" viewBox="0 0 24 24" stroke-width="1.5" aria-hidden="true"><path stroke-linecap="round" stroke-linejoin="round" d="M15 19.128a9.38 9.38 0 002.625.372 9.337 9.337 0 004.121-.952 4.125 4.125 0 00-7.533-2.493M15 19.128v-.003c0-1.113-.285-2.16-.786-3.07M15 19.128v.106A12.318 12.318 0 018.624 21c-2.331 0-4.512-.645-6.374-1.766l-.001-.109a6.375 6.375 0 0111.964-3.07M12 6.375a3.375 3.375 0 11-6.75 0 3.375 3.375 0 016.75 0zm8.25 2.25a2.625 2.625 0 11-5.25 0 2.625 2.625 0 015.25 0z"/></svg>',
    'codes': '<svg class="w-5 h-5 shrink-0" fill="none" stroke="currentColor" viewBox="0 0 24 24" stroke-width="1.5" aria-hidden="true"><path stroke-linecap="round" stroke-linejoin="round" d="M15.75 5.25a3 3 0 013 3m3 0a6 6 0 01-7.029 5.912c-.563-.097-1.159.026-1.563.43L10.5 17.25H8.25v2.25H6v2.25H2.25v-2.818c0-.597.237-1.17.659-1.591l6.499-6.499c.404-.404.527-1 .43-1.563A6 6 0 1121.75 8.25z"/></svg>',
    'limits': '<svg class="w-5 h-5 shrink-0" fill="none" stroke="currentColor" viewBox="0 0 24 24" stroke-width="1.5" aria-hidden="true"><path stroke-linecap="round" stroke-linejoin="round" d="M12 6v12m-3-2.818l.879.659c1.171.879 3.07.879 4.242 0 1.172-.879 1.172-2.303 0-3.182C13.536 12.219 12.768 12 12 12c-.725 0-1.45-.22-2.003-.659-1.106-.879-1.106-2.303 0-3.182s2.9-.879 4.006 0l.415.33M21 12a9 9 0 11-18 0 9 9 0 0118 0z"/></svg>',
    'analytics': '<svg class="w-5 h-5 shrink-0" fill="none" stroke="currentColor" viewBox="0 0 24 24" stroke-width="1.5" aria-hidden="true"><path stroke-linecap="round" stroke-linejoin="round" d="M3 13.125C3 12.504 3.504 12 4.125 12h2.25c.621 0 1.125.504 1.125 1.125v6.75C7.5 20.496 6.996 21 6.375 21h-2.25A1.125 1.125 0 013 19.875v-6.75zM9.75 8.625c0-.621.504-1.125 1.125-1.125h2.25c.621 0 1.125.504 1.125 1.125v11.25c0 .621-.504 1.125-1.125 1.125h-2.25a1.125 1.125 0 01-1.125-1.125V8.625zM16.5 4.125c0-.621.504-1.125 1.125-1.125h2.25C20.496 3 21 3.504 21 4.125v15.75c0 .621-.504 1.125-1.125 1.125h-2.25a1.125 1.125 0 01-1.125-1.125V4.125z"/></svg>',
    'estimator': '<svg class="w-5 h-5 shrink-0" fill="none" stroke="currentColor" viewBox="0 0 24 24" stroke-width="1.5" aria-hidden="true"><path stroke-linecap="round" stroke-linejoin="round" d="M10.5 6h9.75M10.5 6a1.5 1.5 0 11-3 0m3 0a1.5 1.5 0 10-3 0M3.75 6H7.5m3 12h9.75m-9.75 0a1.5 1.5 0 01-3 0m3 0a1.5 1.5 0 00-3 0m-3.75 0H7.5m9-6h3.75m-3.75 0a1.5 1.5 0 01-3 0m3 0a1.5 1.5 0 00-3 0m-9.75 0h9.75"/></svg>',
    'gallery': '<svg class="w-5 h-5 shrink-0" fill="none" stroke="currentColor" viewBox="0 0 24 24" stroke-width="1.5" aria-hidden="true"><path stroke-linecap="round" stroke-linejoin="round" d="M2.25 15.75l5.159-5.159a2.25 2.25 0 013.182 0l5.159 5.159m-1.5-1.5l1.409-1.409a2.25 2.25 0 013.182 0l2.909 2.909m-18 3.75h16.5a1.5 1.5 0 001.5-1.5V6a1.5 1.5 0 00-1.5-1.5H3.75A1.5 1.5 0 002.25 6v12a1.5 1.5 0 001.5 1.5zm10.5-11.25h.008v.008h-.008V8.25zm.375 0a.375.375 0 11-.75 0 .375.375 0 01.75 0z"/></svg>',
    'features': '<svg class="w-5 h-5 shrink-0" fill="none" stroke="currentColor" viewBox="0 0 24 24" stroke-width="1.5" aria-hidden="true"><path stroke-linecap="round" stroke-linejoin="round" d="M12 18v-5.25m0 0a6.01 6.01 0 001.5-.189m-1.5.189a6.01 6.01 0 01-1.5-.189m3.75 7.478a12.06 12.06 0 01-4.5 0m3.75 2.383a14.406 14.406 0 01-3 0M14.25 18v-.192c0-.983.658-1.823 1.508-2.316a7.5 7.5 0 10-7.517 0c.85.493 1.509 1.333 1.509 2.316V18"/></svg>',
    'campaigns': '<svg class="w-5 h-5 shrink-0" fill="none" stroke="currentColor" viewBox="0 0 24 24" stroke-width="1.5" aria-hidden="true"><path stroke-linecap="round" stroke-linejoin="round" d="M10.34 15.84c-.688-.06-1.386-.09-2.09-.09H7.5a4.5 4.5 0 110-9h.75c.704 0 1.402-.03 2.09-.09m0 9.18c.253.962.584 1.892.985 2.783.247.55.06 1.21-.463 1.511l-.657.38c-.551.318-1.26.117-1.527-.461a20.845 20.845 0 01-1.44-4.282m3.102.069a18.03 18.03 0 01-.59-4.59c0-1.586.205-3.124.59-4.59m0 9.18a23.848 23.848 0 018.835 2.535M10.34 6.66a23.847 23.847 0 008.835-2.535m0 0A23.74 23.74 0 0018.795 3m.38 1.125a23.91 23.91 0 011.014 5.395m-1.014 8.855c-.118.38-.245.754-.38 1.125m.38-1.125a23.91 23.91 0 001.014-5.395m0-3.46c.495.413.811 1.035.811 1.73 0 .695-.316 1.317-.811 1.73m0-3.46a24.347 24.347 0 010 3.46"/></svg>',
    'featured-apps': '<svg class="w-5 h-5 shrink-0" fill="none" stroke="currentColor" viewBox="0 0 24 24" stroke-width="1.5" aria-hidden="true"><path stroke-linecap="round" stroke-linejoin="round" d="M11.48 3.499a.562.562 0 011.04 0l2.125 5.111a.563.563 0 00.475.345l5.518.442c.499.04.701.663.321.988l-4.204 3.602a.563.563 0 00-.182.557l1.285 5.385a.562.562 0 01-.84.61l-4.725-2.885a.563.563 0 00-.586 0L6.982 20.54a.562.562 0 01-.84-.61l1.285-5.386a.562.562 0 00-.182-.557l-4.204-3.602a.562.562 0 01.321-.988l5.518-.442a.563.563 0 00.475-.345L11.48 3.5z"/></svg>',
    'db-export': '<svg class="w-5 h-5 shrink-0" fill="none" stroke="currentColor" viewBox="0 0 24 24" stroke-width="1.5" aria-hidden="true"><path stroke-linecap="round" stroke-linejoin="round" d="M20.25 6.375c0 2.278-3.694 4.125-8.25 4.125S3.75 8.653 3.75 6.375m16.5 0c0-2.278-3.694-4.125-8.25-4.125S3.75 4.097 3.75 6.375m16.5 0v11.25c0 2.278-3.694 4.125-8.25 4.125s-8.25-1.847-8.25-4.125V6.375m16.5 0v3.75m-16.5-3.75v3.75m16.5 0v3.75C20.25 16.153 16.556 18 12 18s-8.25-1.847-8.25-4.125v-3.75m16.5 0c0 2.278-3.694 4.125-8.25 4.125s-8.25-1.847-8.25-4.125"/></svg>',
    'mail': '<svg class="w-5 h-5 shrink-0" fill="none" stroke="currentColor" viewBox="0 0 24 24" stroke-width="1.5" aria-hidden="true"><path stroke-linecap="round" stroke-linejoin="round" d="M21.75 6.75v10.5a2.25 2.25 0 01-2.25 2.25h-15a2.25 2.25 0 01-2.25-2.25V6.75m19.5 0A2.25 2.25 0 0019.5 4.5h-15a2.25 2.25 0 00-2.25 2.25m19.5 0v.243a2.25 2.25 0 01-1.07 1.916l-7.5 4.615a2.25 2.25 0 01-2.36 0L3.32 8.91a2.25 2.25 0 01-1.07-1.916V6.75"/></svg>',
    'seasons': '<svg class="w-5 h-5 shrink-0" fill="none" stroke="currentColor" viewBox="0 0 24 24" stroke-width="1.5" aria-hidden="true"><path stroke-linecap="round" stroke-linejoin="round" d="M16.5 18.75h-9m9 0a3 3 0 013 3h-15a3 3 0 013-3m9 0v-3.375c0-.621-.503-1.125-1.125-1.125h-.871M7.5 18.75v-3.375c0-.621.504-1.125 1.125-1.125h.872m5.007 0H9.497m5.007 0a7.454 7.454 0 01-.982-3.172M9.497 14.25a7.454 7.454 0 00.981-3.172M5.25 4.236c-.982.143-1.954.317-2.916.52A6.003 6.003 0 007.73 9.728M5.25 4.236V4.5c0 2.108.966 3.99 2.48 5.228M5.25 4.236V2.721C7.456 2.41 9.71 2.25 12 2.25c2.291 0 4.545.16 6.75.47v1.516M7.73 9.728a6.726 6.726 0 002.748 1.35m8.272-6.842V4.5c0 2.108-.966 3.99-2.48 5.228m2.48-5.492a46.32 46.32 0 012.916.52 6.003 6.003 0 01-5.395 4.972m0 0a6.726 6.726 0 01-2.749 1.35m0 0a6.772 6.772 0 01-3.044 0"/></svg>',
  }),
```

- [ ] **Step 2: Restyle `_navItemsHtml`**

Replace the whole method with:

```js
  _navItemsHtml() {
    const active = AdminConsole._section;
    const itemHtml = (s) => {
      const isActive = s.key === active;
      const cls = 'admin-nav-item flex items-center gap-3 w-full text-left rounded-md px-3 py-2.5 text-sm font-medium transition-colors '
        + (isActive
          ? 'bg-gray-100 dark:bg-gray-800 text-gray-900 dark:text-gray-100'
          : 'text-gray-600 dark:text-gray-400 hover:bg-gray-50 dark:hover:bg-gray-800/60');
      return `<button type="button" role="tab" aria-selected="${isActive ? 'true' : 'false'}"
        data-admin-section="${s.key}" class="${cls}">${AdminConsole.NAV_ICONS[s.key] || ''}<span class="flex-1 min-w-0 truncate">${AdminConsole.esc(s.label)}</span></button>`;
    };
    return AdminConsole._groupedSections().map((g, i) => `
      <div class="${i === 0 ? '' : 'mt-6'}">
        <div class="px-3 py-1.5 text-xs font-semibold uppercase tracking-wider text-gray-400 dark:text-gray-500">${AdminConsole.esc(g.name)}</div>
        ${g.items.map(itemHtml).join('')}
      </div>`).join('');
  },
```

(Group separators become pure whitespace like topochain — no `border-t`.)

- [ ] **Step 3: Restyle `_mobileMenuHtml`**

Replace the chevron constant and `rowHtml`/group markup (structure, marker
classes, 44px target and `-mx-4` wrapper unchanged):

```js
  _mobileMenuHtml() {
    const chevron = `<svg class="w-4 h-4 shrink-0 text-gray-400 dark:text-gray-500" fill="none" stroke="currentColor" viewBox="0 0 24 24" stroke-width="2" aria-hidden="true"><path stroke-linecap="round" stroke-linejoin="round" d="M9 5l7 7-7 7"/></svg>`;
    const rowHtml = (s) => `
      <button type="button" data-admin-section="${s.key}"
              class="admin-menu-row flex items-center gap-3 w-full text-left min-h-[44px] px-4 py-2
                     border-b border-gray-100 dark:border-gray-800
                     text-gray-700 dark:text-gray-200
                     hover:bg-gray-50 dark:hover:bg-gray-800/60 transition-colors">
        <span class="text-gray-400 dark:text-gray-500">${AdminConsole.NAV_ICONS[s.key] || ''}</span>
        <span class="flex-1 min-w-0 text-sm font-medium truncate">${AdminConsole.esc(s.label)}</span>
        ${chevron}
      </button>`;
    const groups = AdminConsole._groupedSections().map((g) => `
      <div class="mb-5">
        <div class="px-4 pb-1.5 text-xs font-semibold uppercase tracking-wider text-gray-400 dark:text-gray-500">${AdminConsole.esc(g.name)}</div>
        <div class="${AdminUI.card} overflow-hidden
                    [&>button:last-child]:border-b-0">
          ${g.items.map(rowHtml).join('')}
        </div>
      </div>`).join('');
    return `<nav id="admin-mobile-menu" aria-label="Admin sections" class="-mx-4">${groups}</nav>`;
  },
```

- [ ] **Step 4: Restyle `_renderShell` one-offs**

In `_renderShell`, keep the structure and every id, and make exactly these
class edits:

- Sidebar `<nav id="admin-nav-desktop">`: `hidden md:block md:w-56 shrink-0 space-y-1` → `hidden md:block md:w-64 shrink-0 space-y-1` (topochain sidebar width).
- Banner div: `bg-amber-100 dark:bg-amber-950/50 border border-amber-300 dark:border-amber-800 text-amber-800 dark:text-amber-200 rounded-lg px-4 py-3 mb-4 text-sm` → `bg-amber-50 dark:bg-amber-950/50 border border-amber-200 dark:border-amber-800 text-amber-800 dark:text-amber-200 rounded-lg px-4 py-3 mb-4 text-sm` (topochain alert tint).
- Temp-password modal copy: `text-zinc-800 dark:text-zinc-200` → `text-gray-800 dark:text-gray-200`; the `#settings/password` link `text-violet-500 hover:text-violet-400 underline` → `text-indigo-600 hover:text-indigo-800 dark:text-indigo-400 dark:hover:text-indigo-300 underline`; the `<code>` block `bg-zinc-100 dark:bg-zinc-800 border border-zinc-300 dark:border-zinc-700 … text-zinc-900 dark:text-zinc-100` → same with `gray` in place of `zinc`.

- [ ] **Step 5: Run the nav/mobile tests**

Run: `node --test tests/admin-mobile-hierarchy.test.js tests/admin-console-drawer-row.test.js tests/admin-console-page.test.js`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add public/js/admin-console.js
git commit -m "Topochain-style admin chrome: gray/indigo nav with Heroicons"
```

---

### Task 3: Hue sweep of admin-console.js

**Files:**
- Modify: `public/js/admin-console.js` (the 9 inline section renderers and any remaining literals)

**Interfaces:**
- Consumes: `AdminUI` recipes (Task 1). No new interfaces produced.

- [ ] **Step 1: Run the deterministic sweep**

```bash
f=public/js/admin-console.js
sed -i '' -e 's/zinc-/gray-/g' -e 's/violet-/indigo-/g' "$f"
sed -i '' -e 's/hover:bg-indigo-500/hover:bg-indigo-700/g' \
          -e 's/hover:text-indigo-400/hover:text-indigo-800 dark:hover:text-indigo-300/g' \
          -e 's/focus:outline-none focus:border-indigo-500/focus:outline-none focus:ring-2 focus:ring-indigo-500 focus:border-indigo-500/g' "$f"
```

- [ ] **Step 2: Hand-fix the non-mechanical leftovers**

- `grep -n 'indigo-600/10' public/js/admin-console.js` — any active/selected
  row tint `bg-indigo-600/10 text-indigo-600 dark:text-indigo-400` becomes
  `bg-gray-100 dark:bg-gray-800 text-gray-900 dark:text-gray-100`
  (topochain marks "active" with a gray fill, not an accent tint).
- `grep -n 'rounded-md px-2 py-0.5' public/js/admin-console.js` — any
  hand-rolled badge literal `inline-flex items-center rounded-md px-2 py-0.5
  text-xs font-medium <colors>` becomes the matching `${AdminUI.badge.*}`
  ref: emerald→`success`, amber→`warn`, red→`destructive`,
  indigo-filled→`secondary`, neutral→`default`.
- `grep -n 'gray-925\|gray-1000' public/js/admin-console.js` — sanity check
  that the sed produced only real Tailwind shades (it should find nothing).

- [ ] **Step 3: Verify zero old hues and run the console suites**

```bash
grep -c 'zinc-\|violet-' public/js/admin-console.js   # expect 0
node --test tests/admin-ui-registry.test.js tests/admin-console-page.test.js \
  tests/view-only-admin.test.js tests/admin-limits-system.test.js \
  tests/admin-rollover-surface.test.js tests/admin-staging-reap-surface.test.js \
  tests/admin-submitted-features.test.js
```
Expected: grep prints 0; tests PASS.

- [ ] **Step 4: Commit**

```bash
git add public/js/admin-console.js
git commit -m "Sweep admin-console.js inline sections to gray/indigo"
```

---

### Task 4: Hue sweep of admin-topochain.js and admin-analytics.js

**Files:**
- Modify: `public/js/admin-topochain.js`, `public/js/admin-analytics.js`

**Interfaces:**
- Consumes: `AdminUI` recipes (Task 1). No new interfaces produced.

- [ ] **Step 1: Run the same sweep on both files**

```bash
for f in public/js/admin-topochain.js public/js/admin-analytics.js; do
  sed -i '' -e 's/zinc-/gray-/g' -e 's/violet-/indigo-/g' "$f"
  sed -i '' -e 's/hover:bg-indigo-500/hover:bg-indigo-700/g' \
            -e 's/hover:text-indigo-400/hover:text-indigo-800 dark:hover:text-indigo-300/g' \
            -e 's/focus:outline-none focus:border-indigo-500/focus:outline-none focus:ring-2 focus:ring-indigo-500 focus:border-indigo-500/g' "$f"
done
```

- [ ] **Step 2: Hand-fix leftovers (same two grep passes as Task 3 Step 2)**

`grep -n 'indigo-600/10' <file>` → active states become
`bg-gray-100 dark:bg-gray-800 text-gray-900 dark:text-gray-100`.
`grep -n 'rounded-md px-2 py-0.5' <file>` → badge literals become
`${AdminUI.badge.*}` refs by the same color mapping. In
`admin-analytics.js`, hand-drawn SVG chart hues: keep semantic
emerald/amber/red, and swap any remaining indigo *fill/stroke hex values*
`#8b5cf6`/`#7c3aed`/`#a78bfa` to indigo `#6366f1`/`#4f46e5`/`#818cf8`.

- [ ] **Step 3: Verify and test**

```bash
grep -c 'zinc-\|violet-' public/js/admin-topochain.js public/js/admin-analytics.js  # expect 0 for both
node --test tests/topochain-admin-screens.test.js
```
Expected: 0 matches; PASS (the test's `legacy` list asserts old strings are ABSENT — the sweep satisfies it).

- [ ] **Step 4: Commit**

```bash
git add public/js/admin-topochain.js public/js/admin-analytics.js
git commit -m "Sweep seasons and analytics admin sections to gray/indigo"
```

---

### Task 5: Hue sweep of the six remaining modules

**Files:**
- Modify: `public/js/admin-status.js`, `public/js/admin-estimator.js`, `public/js/admin-merges.js`, `public/js/admin-mail.js`, `public/js/admin-campaigns.js`, `public/js/admin-gallery.js`

**Interfaces:**
- Consumes: `AdminUI` recipes (Task 1). No new interfaces produced.

- [ ] **Step 1: Run the same sweep**

```bash
for f in public/js/admin-status.js public/js/admin-estimator.js \
         public/js/admin-merges.js public/js/admin-mail.js \
         public/js/admin-campaigns.js public/js/admin-gallery.js; do
  sed -i '' -e 's/zinc-/gray-/g' -e 's/violet-/indigo-/g' "$f"
  sed -i '' -e 's/hover:bg-indigo-500/hover:bg-indigo-700/g' \
            -e 's/hover:text-indigo-400/hover:text-indigo-800 dark:hover:text-indigo-300/g' \
            -e 's/focus:outline-none focus:border-indigo-500/focus:outline-none focus:ring-2 focus:ring-indigo-500 focus:border-indigo-500/g' "$f"
done
```

- [ ] **Step 2: Hand-fix leftovers (same two grep passes as Task 3 Step 2, per file)**

- [ ] **Step 3: Verify and test**

```bash
grep -c 'zinc-\|violet-' public/js/admin-{status,estimator,merges,mail,campaigns,gallery}.js  # expect 0 for all
node --test tests/admin-mail-console.test.js tests/estimator-card-render.test.js \
  tests/dashboard-admin-split.test.js
```
Expected: 0 matches everywhere; tests PASS.

- [ ] **Step 4: Commit**

```bash
git add public/js/admin-status.js public/js/admin-estimator.js \
  public/js/admin-merges.js public/js/admin-mail.js \
  public/js/admin-campaigns.js public/js/admin-gallery.js
git commit -m "Sweep remaining admin section modules to gray/indigo"
```

---

### Task 6: Convert admin-node.js to registry classes; drop its CSS-variable look

**Files:**
- Modify: `public/js/admin-node.js` (markup + `statusBadge` + `_setConn`)
- Modify: `public/css/app.css:5722-5831` (delete the `#admin-node-root` blocks; KEEP the shared `.mono` rule at ~:5703 and everything above it)

**Interfaces:**
- Consumes: `AdminUI.card`, `AdminUI.cardTitle`, `AdminUI.badge.*`, `AdminUI.muted` (Task 1); `AdminNode.render(host)` / `destroy()` contract with `AdminConsole.SECTION_MODULES` is unchanged.
- Produces: module-level `NodeUI` const in `admin-node.js` (local class recipes; complete literals so Tailwind's extractor sees them).

- [ ] **Step 1: Add local class recipes**

Insert after the file's header comment, before `const AdminNode = {`:

```js
// Local class recipes for this section — complete literals (Tailwind's
// extractor scans this file; see the AdminUI note in admin-console.js).
// The section previously kept the dapp-server.js status-page look via
// scoped --un-ns-* CSS variables in app.css; it now shares the console's
// topochain-style vocabulary.
const NodeUI = Object.freeze({
  kv: 'grid grid-cols-[max-content_1fr] items-baseline gap-x-6 gap-y-1.5 text-sm',
  label: 'text-gray-500 dark:text-gray-400',
  val: 'break-all text-gray-900 dark:text-gray-100',
  small: 'text-[11px] text-gray-500 dark:text-gray-400',
  empty: 'py-1.5 text-xs italic text-gray-500 dark:text-gray-400',
  errText: 'text-xs text-red-600 dark:text-red-400',
  warnText: 'text-xs text-amber-600 dark:text-amber-400',
  code: 'rounded bg-gray-100 dark:bg-gray-800 px-1 py-0.5 font-mono text-xs',
  link: 'text-indigo-600 hover:text-indigo-800 dark:text-indigo-400 dark:hover:text-indigo-300 hover:underline',
  details: 'rounded-lg bg-gray-50 dark:bg-gray-800/50 px-3 py-1.5 my-2',
  summary: 'cursor-pointer select-none py-1 text-[13px] font-medium text-gray-700 dark:text-gray-300',
  syncBar: 'mt-1 h-1.5 w-full max-w-[240px] overflow-hidden rounded-full bg-gray-200 dark:bg-gray-800',
  syncFill: 'h-full rounded-full bg-indigo-600 transition-all duration-300',
  syncFillFull: 'h-full rounded-full bg-emerald-500 transition-all duration-300',
});
```

- [ ] **Step 2: Rewrite `statusBadge` onto AdminUI badges**

```js
  statusBadge(status) {
    const s = String(status || 'unknown');
    let cls = AdminUI.badge.default;
    if (s === 'Synced' || s === 'ok') cls = AdminUI.badge.success;
    else if (s === 'Syncing' || s === 'Connected') cls = AdminUI.badge.secondary;
    else if (s === 'Connecting' || s === 'bad_response' || s === 'degraded') cls = AdminUI.badge.warn;
    else if (s === 'unreachable') cls = AdminUI.badge.destructive;
    else if (s === 'mock') cls = AdminUI.badge.default;
    return '<span class="' + cls + '">' + AdminNode.esc(s) + '</span>';
  },
```

- [ ] **Step 3: Rewrite `render(host)` markup**

Same ids, same structure, registry classes:

```js
  render(host) {
    host.innerHTML = `
      <div id="admin-node-root">
        <div class="mb-1 flex flex-wrap items-baseline justify-between gap-2">
          <div>
            <h2 id="admin-node-server-name" class="text-2xl font-bold text-gray-900 dark:text-gray-100">Loading…</h2>
            <div class="mb-6 text-[13px] text-gray-500 dark:text-gray-400" id="admin-node-server-meta"></div>
          </div>
          <div class="flex items-center gap-1.5 text-[11px] text-gray-500 dark:text-gray-400" id="admin-node-conn"><span id="admin-node-led" class="inline-block h-2 w-2 rounded-full bg-gray-300 dark:bg-gray-600"></span><span id="admin-node-conn-text">connecting…</span></div>
        </div>

        <div class="${AdminUI.card} p-6 mb-4">
          <h3 class="${AdminUI.cardTitle} mb-3">Node</h3>
          <div id="admin-node-body" class="${NodeUI.empty}">Loading…</div>
        </div>

        <div class="${AdminUI.card} p-6 mb-4">
          <h3 class="${AdminUI.cardTitle} mb-3">Explorer</h3>
          <div id="admin-node-explorer-body" class="${NodeUI.empty}">Loading…</div>
        </div>

        <div class="${AdminUI.card} p-6 mb-4">
          <h3 class="${AdminUI.cardTitle} mb-3">Chain-dependent services</h3>
          <div id="admin-node-services-body" class="${NodeUI.empty}">Loading…</div>
        </div>

        <div class="${NodeUI.small} mt-[18px] text-center">
          Updated <span id="admin-node-last-updated">—</span> · polling
          <code class="${NodeUI.code}">/api/node-status/full</code> ·
          JSON snapshot at <a href="/api/node-status/full" target="_blank" rel="noopener" class="${NodeUI.link}">/api/node-status/full</a>
        </div>
      </div>`;

    AdminNode._fetchOnce();
    clearInterval(AdminNode._timer);
    AdminNode._timer = setInterval(AdminNode._fetchOnce, AdminNode.POLL_MS);
  },
```

- [ ] **Step 4: Rewrite `_setConn` (LED via classes, no `.conn` CSS)**

```js
  _setConn(state) {
    const led = AdminNode._$('admin-node-led');
    const t = AdminNode._$('admin-node-conn-text');
    if (!led || !t) return;
    if (state === 'live') {
      led.className = 'inline-block h-2 w-2 rounded-full bg-emerald-500';
      t.textContent = 'live (2s poll)';
    } else if (state === 'dead') {
      led.className = 'inline-block h-2 w-2 rounded-full bg-red-500';
      t.textContent = 'disconnected';
    } else {
      led.className = 'inline-block h-2 w-2 rounded-full bg-gray-300 dark:bg-gray-600';
      t.textContent = 'connecting…';
    }
  },
```

(The old markup had `<span class="led">` inside `#admin-node-conn` and
`el.className = 'conn ' + state` — the new markup in Step 3 gives the LED its
own id instead. No other caller touches `.conn`/`.led`.)

- [ ] **Step 5: Sweep the string-built row markup**

Throughout `renderNode` / `renderExplorer` / `renderServices` replace class
tokens inside the concatenated strings (ids and text untouched):

- `'<div class="kv">'` → `'<div class="' + NodeUI.kv + '">'` (also the `style="margin-top:8px"` variants: keep the inline style, swap the class).
- `class="label"` → `class="' + NodeUI.label + '"` and `class="val"` → `class="' + NodeUI.val + '"` (`class="val mono"` → `NodeUI.val + ' mono font-mono text-xs'`).
- `class="small"` → `NodeUI.small`; `class="err-text"` → `NodeUI.errText`; `class="warn-text"` → `NodeUI.warnText`; `class="empty"` (the `body.className = 'empty'` assignments) → `body.className = NodeUI.empty` and `body.className = ''` stays.
- `'<details open>'` → `'<details open class="' + NodeUI.details + '">'`; `<summary>` → `'<summary class="' + NodeUI.summary + '">'`.
- Sync bar: `'<div class="sync-bar"><div class="sync-fill' + (pct >= 99.9 ? ' full' : '') + '" …'` → `'<div class="' + NodeUI.syncBar + '"><div class="' + (pct >= 99.9 ? NodeUI.syncFillFull : NodeUI.syncFill) + '" style="width:' + pct + '%"></div></div>'`.
- The UTXO explainer: `<code>` gains `class="' + NodeUI.code + '"`; the GitHub `<a … style="color:var(--un-ns-accent)">` → `class="' + NodeUI.link + '"` (drop the style attr).

- [ ] **Step 6: Delete the dead CSS in app.css**

In `public/css/app.css`, delete from the comment block
`/* ── Node & chain (was public/node-status.html) …` (~line 5718) through the
last `#admin-node-root a:hover { text-decoration: underline; }` rule
(~line 5831). KEEP the earlier `#admin-status-root .mono, #admin-node-root
.mono { … }` rule and the `#admin-status-root:not(.is-admin) .admin-only`
rule — both still serve rendered markup.

- [ ] **Step 7: Verify and test**

```bash
grep -c 'un-ns-' public/js/admin-node.js public/css/app.css   # expect 0 for both
grep -c 'zinc-\|violet-' public/js/admin-node.js              # expect 0
node --test tests/admin-console-page.test.js
```
Expected: zeros; PASS.

- [ ] **Step 8: Commit**

```bash
git add public/js/admin-node.js public/css/app.css
git commit -m "Convert Node & chain section to topochain-style registry classes"
```

---

### Task 7: Recolor status pills in app.css

**Files:**
- Modify: `public/css/app.css` (~:5674-5701, the `#admin-status-root .pill*` rules)

**Interfaces:**
- Consumes/produces nothing new — `.pill`, `.pill-*`, `.dot` class names are behavioral markers and stay.

- [ ] **Step 1: Replace the pill color rules**

Keep the `.pill` and `.pill .dot` shape rules as-is. Replace the four
color pairs + light overrides with topochain semantics (emerald / amber /
red / indigo, dark-first like the rest of the block):

```css
#admin-status-root .pill-running { background: rgba(16, 185, 129, 0.1); color: #34d399; }
#admin-status-root .pill-running .dot { background: #10b981; box-shadow: 0 0 6px #10b981; }
#admin-status-root .pill-stopped { background: rgba(245, 158, 11, 0.1); color: #fbbf24; }
#admin-status-root .pill-stopped .dot { background: #f59e0b; }
#admin-status-root .pill-missing { background: rgba(239, 68, 68, 0.1); color: #f87171; }
#admin-status-root .pill-missing .dot { background: #ef4444; }
#admin-status-root .pill-creating { background: rgba(99, 102, 241, 0.1); color: #818cf8; }
#admin-status-root .pill-creating .dot { background: #6366f1; }

/* Light-mode pill overrides — topochain's badge tints (50-shade bg,
   700-shade text). The shell toggles `.dark` on <html>, so target the
   light state via html:not(.dark). Dots stay solid and saturated. */
html:not(.dark) #admin-status-root .pill-running { background: #ecfdf5; color: #047857; }
html:not(.dark) #admin-status-root .pill-stopped { background: #fffbeb; color: #b45309; }
html:not(.dark) #admin-status-root .pill-missing { background: #fef2f2; color: #b91c1c; }
html:not(.dark) #admin-status-root .pill-creating { background: #eef2ff; color: #4338ca; }
```

- [ ] **Step 2: Commit**

```bash
git add public/css/app.css
git commit -m "Recolor status pills to topochain badge palette"
```

---

### Task 8: Rebuild Tailwind artifact, full suite, visual pass

**Files:**
- Modify (generated): `public/css/tailwind.css`

**Interfaces:** none.

- [ ] **Step 1: Rebuild the compiled stylesheet**

Run: `npm run build:css`
Expected: exits 0, `public/css/tailwind.css` changes (new gray/indigo utilities appear; do NOT run `build:shell` — no `frontend/` file changed).

- [ ] **Step 2: Run the whole test suite**

Run: `npm test`
Expected: PASS, including `tests/tailwind-build.test.js` (artifact fresh) and `tests/shell-build.test.js` (untouched shell still in sync). If any test fails on a class assertion, fix the test ONLY if it pins an old admin hue; otherwise fix the code.

- [ ] **Step 3: Visual pass in the browser**

Start the local stack if needed (`make up`, wait for `http://localhost:3000/health` to report ok). Open `http://localhost:3000/#admin` and click through all 18 sections in light AND dark theme; check `/#admin/status`, `/#admin/node`, `/#admin/seasons`, and the mobile menu at a narrow viewport. Verify: no console errors, no unstyled (missing-utility) surfaces, sidebar icons render, badges are ring-tinted rounded-full pills.

- [ ] **Step 4: Commit the artifact**

```bash
git add public/css/tailwind.css
git commit -m "Rebuild Tailwind artifact for admin topochain skin"
```
