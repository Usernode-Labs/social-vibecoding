# Admin Console shadcn Restyle Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Restyle all 18 admin-console sections plus shared chrome to the shadcn/ui dashboard-block look via a shared `AdminUI` class-recipe registry, with zero behavior change.

**Architecture:** A frozen, data-only global `window.AdminUI` defined near the top of `public/js/admin-console.js` (which loads before every `admin-*.js` section module) holds shadcn recipes transcribed to the platform's literal `zinc`/`violet` utilities. Every admin template string swaps ad-hoc classes for `${AdminUI.x}` interpolations. A static-analysis guard test keeps references and registry in sync.

**Tech Stack:** Vanilla JS globals (no modules), Tailwind CSS v3.4.17 (compiled, committed artifact), `node:test` runner.

**Spec:** `docs/superpowers/specs/2026-08-10-admin-shadcn-restyle-design.md`

## Global Constraints

- **Zero behavior change.** ids, `data-*` attributes, event wiring, `hidden` toggles, `AdminConsole.esc()` calls, and all interpolated data stay exactly as they are.
- **No structural DOM changes.** New wrapper elements only where a recipe strictly needs one (a table's scroll wrapper), and never around an element that a test or JS selects by position (`firstElementChild`, `children[n]`, `:nth-child`).
- **Do not touch** `frontend/**`, `public/index.html`, `public/shell/**`, `public/sw.js`, or any server code. No `npm run build:shell`.
- **Every class name stays a COMPLETE literal.** Tailwind's extractor is a regex over source text; `tests/tailwind-build.test.js` fails the suite on class names assembled from fragments. Never build a class string by concatenation, and never index the registry dynamically (`AdminUI.btn[variant]` is forbidden — the guard test can't check it).
- **Every commit that changes classes in `public/js/**` runs `npm run build:css` first and includes the regenerated `public/css/tailwind.css`.**
- Tailwind stays pinned at v3.4.17. No new dependencies, no CDN assets.
- Test runner: `npm test` runs everything; a single file runs with
  `node --require ./tests/lib/test-net.js --test --test-force-exit tests/<file>.test.js`.
- Existing `dark:` light+dark discipline is maintained: every recipe carries explicit `dark:` variants.

## Shared Restyle Procedure

Every restyle task (Tasks 2–8) applies this same procedure to its files. It is part of each task's requirements.

**Step A — Audit marker classes (before editing anything).** Enumerate every class name the file's JS itself queries or toggles; these must survive verbatim, alongside (not replaced by) recipe classes:

```bash
grep -nE "classList\.(add|remove|toggle|contains)|querySelector(All)?\(|closest\(|getElementsByClassName" public/js/<file>.js
```

Write the resulting class names down in the task's commit message body. `hidden` is always on this list.

**Step B — Swap classes using this mapping.** Only swap where the element plays the mapped role; when an element's classes don't map cleanly, leave them unchanged — zero behavior/visual-regression risk beats consistency:

| Current pattern (role) | Replace with |
|---|---|
| Section/panel container, e.g. `bg-zinc-50 dark:bg-zinc-900 rounded-lg p-4 border border-zinc-200 dark:border-zinc-800` | `${AdminUI.card} p-4` |
| Section `<h2>`/panel heading | `${AdminUI.cardTitle}` |
| Explanatory/muted copy (`text-sm text-zinc-500…` / `text-zinc-600 dark:text-zinc-400`) | `${AdminUI.muted}` |
| Primary violet button (`bg-violet-600 hover:bg-violet-500 … text-white`) | `${AdminUI.btn.primary}` |
| Neutral bordered button (`border border-zinc-300 dark:border-zinc-700 …`) | `${AdminUI.btn.outline}` |
| Bordered red/destructive button | `${AdminUI.btn.destructive}` |
| Small (`text-xs`, `px-3 py-1`) variants of the above | `${AdminUI.btn.primarySm}` / `outlineSm` / `destructiveSm` |
| Quiet text-link button (`text-zinc-400 hover:text-violet-400`, refresh links) | `${AdminUI.btn.link}` |
| `<table>` element | `${AdminUI.table}`, its border wrapper `${AdminUI.tableWrap}` (add wrapper `<div>` only if the table has none; never `overflow-x-auto` — nothing in the console scrolls sideways, #860) |
| `<thead>` row styling | `${AdminUI.thead}` on `<thead>`, `${AdminUI.th}` on each `<th>` |
| `<td>` cells / body rows | `${AdminUI.td}` / `${AdminUI.trHover}` on `<tr>` |
| Status pill/tag spans (emerald=ok, amber=warn, red=error, zinc=neutral) | `${AdminUI.badge.success}` / `warn` / `destructive` / `secondary` |
| Text `<input>` / `<select>` / `<textarea>` | `${AdminUI.input}` / `${AdminUI.select}` / `${AdminUI.textarea}` |
| Form labels | `${AdminUI.label}` |
| Full-screen modal overlay (`fixed inset-0 z-50 … bg-black/60`) | `${AdminUI.dialogOverlay}` |
| Modal panel (`bg-white dark:bg-zinc-900 rounded-xl p-6 …`) | `${AdminUI.dialogPanel}` |
| `<code>`/mono chips | `${AdminUI.kbd}` |
| `border-t` divider lines | `${AdminUI.separator}` |

Keep call-site-specific utilities (widths, margins, `shrink-0`, `flex-1`, grid classes) by appending them: `class="${AdminUI.btn.primary} shrink-0"`. Order: recipe first, extras after.

**Step C — Verify and commit.**

```bash
npm run build:css
node --require ./tests/lib/test-net.js --test --test-force-exit tests/admin-ui-registry.test.js
npm test
git add public/js/<files> public/css/tailwind.css
git commit   # message lists the audited marker classes preserved
```

If `npm test` shows a failure in any `tests/admin-*.test.js`, the swap changed something a test pins — restore that exact element's original classes rather than editing the test. (The frozen-markup/parity tests never fire here because `frontend/` is untouched.)

---

### Task 1: `AdminUI` registry + guard test

**Files:**
- Modify: `public/js/admin-console.js` (insert registry immediately before `const AdminConsole = {` at line ~61)
- Create: `tests/admin-ui-registry.test.js`

**Interfaces:**
- Produces: global `window.AdminUI` — frozen object of class-string constants; groups `AdminUI.btn.*` and `AdminUI.badge.*` are nested frozen objects. All later tasks interpolate these into template strings.

- [ ] **Step 1: Write the failing guard test**

```js
// tests/admin-ui-registry.test.js — static analysis: every AdminUI.<key>
// reference across the admin modules resolves to a key defined in the
// registry in admin-console.js, so a typo fails CI instead of silently
// rendering class="undefined". Mirrors the source-regex style of
// tests/shell-script-order.test.js.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const JS_DIR = path.join(__dirname, '..', 'public', 'js');
const ADMIN_FILES = fs.readdirSync(JS_DIR).filter((f) => /^admin(-|\.)/.test(f) && f.endsWith('.js'));

function loadRegistry() {
  const src = fs.readFileSync(path.join(JS_DIR, 'admin-console.js'), 'utf8');
  const m = src.match(/window\.AdminUI = Object\.freeze\(\{[\s\S]*?\n\}\);/);
  assert.ok(m, 'admin-console.js defines window.AdminUI = Object.freeze({ ... });');
  const sandbox = { window: {} };
  vm.runInNewContext(m[0], sandbox);
  return sandbox.window.AdminUI;
}

test('every AdminUI reference resolves to a defined registry key', () => {
  const registry = loadRegistry();
  const refRe = /\bAdminUI\.([A-Za-z_$][\w$]*)(?:\.([A-Za-z_$][\w$]*))?/g;
  for (const file of ADMIN_FILES) {
    const src = fs.readFileSync(path.join(JS_DIR, file), 'utf8');
    for (const [, k1, k2] of src.matchAll(refRe)) {
      const v1 = registry[k1];
      assert.notStrictEqual(v1, undefined, `${file}: AdminUI.${k1} is not defined`);
      if (typeof v1 === 'object') {
        assert.ok(k2, `${file}: AdminUI.${k1} is a group — reference a member (e.g. AdminUI.${k1}.primary)`);
        assert.strictEqual(typeof v1[k2], 'string', `${file}: AdminUI.${k1}.${k2} is not defined`);
        assert.ok(v1[k2].length > 0, `${file}: AdminUI.${k1}.${k2} is empty`);
      } else {
        assert.strictEqual(typeof v1, 'string', `${file}: AdminUI.${k1} is not a string`);
        assert.ok(v1.length > 0, `${file}: AdminUI.${k1} is empty`);
      }
    }
  }
});

test('registry values are complete literals (no template placeholders)', () => {
  const registry = loadRegistry();
  const flat = [];
  for (const [k, v] of Object.entries(registry)) {
    if (typeof v === 'string') flat.push([k, v]);
    else for (const [k2, v2] of Object.entries(v)) flat.push([`${k}.${k2}`, v2]);
  }
  assert.ok(flat.length >= 20, 'registry has a real set of recipes');
  for (const [k, v] of flat) {
    assert.doesNotMatch(v, /[${}]/, `AdminUI.${k} must be a plain class-string literal`);
  }
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `node --require ./tests/lib/test-net.js --test --test-force-exit tests/admin-ui-registry.test.js`
Expected: FAIL — "admin-console.js defines window.AdminUI" assertion (registry doesn't exist yet).

- [ ] **Step 3: Add the registry to `public/js/admin-console.js`**

Insert immediately above `const AdminConsole = {` (after the header comment block), exactly:

```js
// ── AdminUI: shared shadcn-style class recipes (see
// docs/superpowers/specs/2026-08-10-admin-shadcn-restyle-design.md) ──────
// Data-only class-string constants used by this file and every admin-*.js
// section module (all of which load after this file — see the script order
// in frontend/src/Shell.tsx). Buttons are composed verbatim from the
// variant table in frontend/@/components/ui/button.tsx so admin buttons
// pixel-match the shell's React <Button>. Every value is a COMPLETE class
// literal: Tailwind's extractor is a regex over public/js/** source, and
// tests/admin-ui-registry.test.js + tests/tailwind-build.test.js enforce
// the discipline. Never index this registry dynamically.
window.AdminUI = Object.freeze({
  // Surfaces — shadcn Card, density-matched to the console's p-4 rhythm.
  card: 'rounded-xl border border-zinc-200 dark:border-zinc-800 bg-white dark:bg-zinc-900 shadow-sm',
  cardHeader: 'flex items-center justify-between gap-2 mb-3',
  cardTitle: 'text-lg font-semibold text-zinc-900 dark:text-zinc-100',
  cardDescription: 'text-sm text-zinc-500 dark:text-zinc-400',
  // Tables — shadcn Table.
  tableWrap: 'w-full rounded-lg border border-zinc-200 dark:border-zinc-800',
  table: 'w-full text-sm',
  thead: 'border-b border-zinc-200 dark:border-zinc-800 bg-zinc-50 dark:bg-zinc-900/50',
  th: 'px-3 py-2 text-left align-middle text-[11px] font-medium uppercase tracking-wide text-zinc-500 dark:text-zinc-400',
  td: 'px-3 py-2 align-middle',
  trHover: 'border-b border-zinc-100 dark:border-zinc-800/60 transition-colors hover:bg-zinc-50 dark:hover:bg-zinc-800/50',
  // Buttons — button.tsx variants composed with its default / sm sizes.
  btn: Object.freeze({
    primary: 'font-medium transition-colors bg-violet-600 hover:bg-violet-500 text-white rounded-lg px-4 py-2 text-sm',
    outline: 'font-medium transition-colors border border-zinc-300 dark:border-zinc-700 text-zinc-600 dark:text-zinc-300 hover:bg-zinc-100 dark:hover:bg-zinc-900 rounded-lg px-4 py-2 text-sm',
    destructive: 'font-medium transition-colors border border-red-400 dark:border-red-700 text-red-600 dark:text-red-400 hover:bg-red-50 dark:hover:bg-red-950 rounded-lg px-4 py-2 text-sm',
    ghost: 'font-medium transition-colors text-zinc-400 hover:text-zinc-200',
    link: 'font-medium transition-colors text-zinc-500 hover:text-violet-400',
    primarySm: 'font-medium transition-colors bg-violet-600 hover:bg-violet-500 text-white rounded px-3 py-1 text-xs',
    outlineSm: 'font-medium transition-colors border border-zinc-300 dark:border-zinc-700 text-zinc-600 dark:text-zinc-300 hover:bg-zinc-100 dark:hover:bg-zinc-900 rounded px-3 py-1 text-xs',
    destructiveSm: 'font-medium transition-colors border border-red-400 dark:border-red-700 text-red-600 dark:text-red-400 hover:bg-red-50 dark:hover:bg-red-950 rounded px-3 py-1 text-xs',
  }),
  // Form controls.
  input: 'w-full rounded-lg border border-zinc-300 dark:border-zinc-700 bg-white dark:bg-zinc-800 px-3 py-2 text-sm text-zinc-900 dark:text-zinc-100 placeholder:text-zinc-400 dark:placeholder:text-zinc-500 focus:outline-none focus:border-violet-500',
  select: 'w-full rounded-lg border border-zinc-300 dark:border-zinc-700 bg-white dark:bg-zinc-800 px-3 py-2 text-sm text-zinc-900 dark:text-zinc-100 focus:outline-none focus:border-violet-500',
  textarea: 'w-full min-h-[80px] rounded-lg border border-zinc-300 dark:border-zinc-700 bg-white dark:bg-zinc-800 px-3 py-2 text-sm text-zinc-900 dark:text-zinc-100 placeholder:text-zinc-400 dark:placeholder:text-zinc-500 focus:outline-none focus:border-violet-500',
  label: 'text-sm font-medium text-zinc-700 dark:text-zinc-300',
  // Badges — shadcn Badge shape; success/warn use the console's existing
  // emerald/amber status conventions.
  badge: Object.freeze({
    default: 'inline-flex items-center rounded-md px-2 py-0.5 text-xs font-medium bg-violet-600 text-white',
    secondary: 'inline-flex items-center rounded-md px-2 py-0.5 text-xs font-medium bg-zinc-100 dark:bg-zinc-800 text-zinc-700 dark:text-zinc-300',
    outline: 'inline-flex items-center rounded-md border border-zinc-300 dark:border-zinc-700 px-2 py-0.5 text-xs font-medium text-zinc-600 dark:text-zinc-300',
    destructive: 'inline-flex items-center rounded-md px-2 py-0.5 text-xs font-medium bg-red-100 dark:bg-red-950 text-red-700 dark:text-red-300',
    success: 'inline-flex items-center rounded-md px-2 py-0.5 text-xs font-medium bg-emerald-100 dark:bg-emerald-950 text-emerald-700 dark:text-emerald-300',
    warn: 'inline-flex items-center rounded-md px-2 py-0.5 text-xs font-medium bg-amber-100 dark:bg-amber-950 text-amber-700 dark:text-amber-300',
  }),
  // Overlay.
  dialogOverlay: 'fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-4',
  dialogPanel: 'w-full max-w-md rounded-xl border border-zinc-200 dark:border-zinc-800 bg-white dark:bg-zinc-900 p-6 shadow-xl',
  // Typography / misc.
  sectionTitle: 'text-lg font-semibold text-zinc-900 dark:text-zinc-100',
  muted: 'text-sm text-zinc-500 dark:text-zinc-400',
  separator: 'border-t border-zinc-200 dark:border-zinc-800',
  kbd: 'rounded border border-zinc-300 dark:border-zinc-700 bg-zinc-100 dark:bg-zinc-800 px-1.5 py-0.5 font-mono text-xs text-zinc-700 dark:text-zinc-300',
});
```

- [ ] **Step 4: Run the guard test to verify it passes**

Run: `node --require ./tests/lib/test-net.js --test --test-force-exit tests/admin-ui-registry.test.js`
Expected: PASS (both tests).

- [ ] **Step 5: Rebuild CSS, run the full suite**

```bash
npm run build:css
npm test
```
Expected: all green; `tailwind-build.test.js` no longer reports the artifact stale.

- [ ] **Step 6: Commit**

```bash
git add public/js/admin-console.js tests/admin-ui-registry.test.js public/css/tailwind.css
git commit -m "Add AdminUI shadcn class-recipe registry with guard test"
```

---

### Task 2: Shared chrome in `admin-console.js`

**Files:**
- Modify: `public/js/admin-console.js` — the chrome templates only: `_renderShell` (~line 540: desktop sidebar container, view-only banner, section-content host), the sidebar nav button template (~line 499), the mobile two-level menu templates (~lines 514–532), the module-failed-to-load message (~line 699), and the temp-password modal (~lines 562–572).

**Interfaces:**
- Consumes: `window.AdminUI` from Task 1.
- Produces: nothing new — later tasks are independent.

- [ ] **Step 1: Audit marker classes** — run Shared Restyle Procedure Step A on `admin-console.js`. Known members: `hidden`, `admin-menu-row`, `admin-nav-btn` (verify), plus any others the grep reveals. These stay verbatim.
- [ ] **Step 2: Apply the Step B mapping to the chrome templates.** Specifics:
  - Mobile menu group container (`rounded-lg overflow-hidden border … bg-white dark:bg-zinc-900`, ~line 527) → `${AdminUI.card} overflow-hidden` (keep `rounded-lg`→`rounded-xl` change from the recipe).
  - Group headings (`text-[11px] uppercase tracking-wide text-zinc-400 …`) stay as-is — they already match the shadcn sidebar-label idiom; do not force-map.
  - View-only amber banner (~line 553): keep its amber palette; only normalize radius/border to `rounded-lg border` if not already.
  - Temp-password modal: overlay div → `${AdminUI.dialogOverlay}` (keep `hidden` first), panel div → `${AdminUI.dialogPanel}`, title → `${AdminUI.cardTitle}`, body copy → `${AdminUI.muted}` where it matches, `#admin-temp-pw-copy` → `${AdminUI.btn.primary} shrink-0`, `#admin-temp-pw-close` → `${AdminUI.btn.outline} mt-4 w-full`, `#admin-temp-pw-value` `<code>` → `${AdminUI.kbd} flex-1 min-w-0 break-all` (keep sizing extras).
- [ ] **Step 3: Verify and commit** — Shared Restyle Procedure Step C. Pay attention to `tests/admin-console-page.test.js`, `tests/admin-console-drawer-row.test.js`, `tests/admin-mobile-hierarchy.test.js`. Commit message: `Restyle admin chrome to AdminUI recipes` + audited marker-class list.

---

### Task 3: Inline sections — Users, Codes, Limits

**Files:**
- Modify: `public/js/admin-console.js` — only the `render`/template code for the users, codes, and limits sections (locate via `SECTIONS` keys `users`, `codes`, `limits` and their `render*` methods).

**Interfaces:** Consumes `window.AdminUI`. Produces nothing new.

- [ ] **Step 1: Audit marker classes** (Step A) for the three sections' code paths.
- [ ] **Step 2: Apply the Step B mapping.** These sections are table- and form-heavy: user list table → `tableWrap`/`table`/`thead`/`th`/`td`/`trHover`; role/status pills → `badge.*` by color role; quota/limit inputs → `input`; action buttons → `btn.primarySm`/`outlineSm`/`destructiveSm` (they are compact rows); the per-section panels → `${AdminUI.card} p-4`.
- [ ] **Step 3: Verify and commit** (Step C). Watch `tests/admin-limits-system.test.js`, `tests/admin-wallet.test.js`. Commit: `Restyle admin users/codes/limits sections`.

---

### Task 4: Inline sections — Features, Featured apps, Rollover, Staging-reap, DB export

**Files:**
- Modify: `public/js/admin-console.js` — the `render*` code for SECTIONS keys `features`, `featured-apps` (~line 756 `renderFeaturedSection`), `rollover`, `staging-reap`, `db-export`.

**Interfaces:** Consumes `window.AdminUI`. Produces nothing new.

- [ ] **Step 1: Audit marker classes** (Step A) for these sections' code paths.
- [ ] **Step 2: Apply the Step B mapping.** Known concrete swap: the featured-apps panel `bg-zinc-50 dark:bg-zinc-900 rounded-lg p-4 border border-zinc-200 dark:border-zinc-800` (~line 756) → `${AdminUI.card} p-4`; its heading (~758) → `${AdminUI.cardTitle}`; the refresh link (~759) → `${AdminUI.btn.link} text-xs`. Rollover/staging-reap confirmation buttons are destructive actions → `btn.destructive`; db-export status lines → `muted` + `badge.*`.
- [ ] **Step 3: Verify and commit** (Step C). Watch `tests/admin-submitted-features.test.js`, `tests/admin-rollover-surface.test.js`, `tests/admin-staging-reap-surface.test.js`. Commit: `Restyle admin features/featured/rollover/reap/db-export sections`.

---

### Task 5: `admin-status.js` + `admin-node.js`

**Files:**
- Modify: `public/js/admin-status.js` (41 KB), `public/js/admin-node.js` (17 KB)

**Interfaces:** Consumes `window.AdminUI`. Produces nothing new.

- [ ] **Step 1: Audit marker classes** (Step A) in both files — these poll and re-render, so double-check for classes used as re-render targets/selectors.
- [ ] **Step 2: Apply the Step B mapping.** Status tiles/health cards → `${AdminUI.card} p-4`; ok/warn/error indicators → `badge.success`/`warn`/`destructive`; event-log tables → table recipes; mono values → `kbd` only where already chip-styled (leave plain mono text alone).
- [ ] **Step 3: Verify and commit** (Step C). These two are the PUBLIC-mode sections (reachable by non-admins via old `/status`, `/node-status` links) — behavior identical, styling only. Commit: `Restyle admin status/node sections`.

---

### Task 6: `admin-merges.js`, `admin-gallery.js`, `admin-campaigns.js`, `admin-mail.js`

**Files:**
- Modify: `public/js/admin-merges.js` (19 KB), `public/js/admin-gallery.js` (13 KB), `public/js/admin-campaigns.js` (22 KB), `public/js/admin-mail.js` (21 KB)

**Interfaces:** Consumes `window.AdminUI`. Produces nothing new.

- [ ] **Step 1: Audit marker classes** (Step A) per file. `admin-campaigns.js` owns the `#admin/campaigns/<id>` sub-hash — its nav anchors keep their exact structure.
- [ ] **Step 2: Apply the Step B mapping** per file (panels → card, lists/tables → table recipes, action buttons → btn recipes, status pills → badges, mail test form → `input`/`label`/`btn.primary`).
- [ ] **Step 3: Verify and commit** (Step C). Watch `tests/admin-mail-console.test.js`. Commit: `Restyle admin merges/gallery/campaigns/mail sections`.

---

### Task 7: `admin-analytics.js` + `admin-estimator.js`

**Files:**
- Modify: `public/js/admin-analytics.js` (85 KB), `public/js/admin-estimator.js` (35 KB)

**Interfaces:** Consumes `window.AdminUI`. Produces nothing new.

- [ ] **Step 1: Audit marker classes** (Step A). Analytics re-renders charts on poll — enumerate carefully.
- [ ] **Step 2: Apply the Step B mapping to containers, filter bars, stat tiles, and tables ONLY.** Chart rendering internals (canvas/SVG drawing, series colors, axis markup) are explicitly out of scope per the spec — do not touch any code that draws chart geometry or picks series colors. Stat tiles → `${AdminUI.card} p-4` + `${AdminUI.muted}` labels; filter selects → `select`; date inputs → `input`.
- [ ] **Step 3: Verify and commit** (Step C). Watch `tests/dashboard-admin-split.test.js`. Commit: `Restyle admin analytics/estimator sections`.

---

### Task 8: `admin-topochain.js`

**Files:**
- Modify: `public/js/admin-topochain.js` (210 KB — largest module, own task/commit)

**Interfaces:** Consumes `window.AdminUI`. Produces nothing new.

- [ ] **Step 1: Audit marker classes** (Step A). This module owns a third hash level (`#admin/seasons/<sub>`) and many sub-views — enumerate selector classes exhaustively before editing.
- [ ] **Step 2: Apply the Step B mapping** sub-view by sub-view (seasons, events, challenges, accounts, settings…). Same rules; when in doubt on any element, leave it unchanged.
- [ ] **Step 3: Verify and commit** (Step C). Watch `tests/topochain-admin-api.test.js` / `-api2.test.js` (API-level; should be untouched) and any topochain UI tests. Commit: `Restyle admin topochain (seasons) section`.

---

### Task 9: Full verification + visual QA

**Files:** none modified (fixes loop back into the relevant task's files).

- [ ] **Step 1: Full suite + artifact freshness**

```bash
npm run build:css   # must be a no-op diff; if not, a commit missed its CSS
git status --short  # expect clean
npm test
```
Expected: suite green, working tree clean.

- [ ] **Step 2: Registry coverage sanity** — confirm no admin file still carries the old ad-hoc patterns for mapped roles where the map should have applied:

```bash
grep -n "bg-violet-600 hover:bg-violet-500" public/js/admin-*.js | grep -v "AdminUI" || true
```
Remaining hits are either the registry itself or deliberate leave-alones; each should be explainable.

- [ ] **Step 3: Visual walkthrough (the main QA gate).** Start the local stack (`make up`, wait for `http://localhost:3000/health` to report ok), sign in as the bootstrap admin (`USERNODE_ADMIN_USERNAME`/`USERNODE_ADMIN_PASSWORD` from the local env), open `#admin`, and walk **all 18 sections**, in **light and dark** themes, at **desktop and mobile** widths (mobile's two-level menu is its own code path). Checklist per section: renders without console errors; cards/tables/buttons/badges show the shadcn look; every interactive control still works (spot-check one read and, where safe, one write per section — use view-only sparingly); the view-only banner still renders for a `admin_readonly` user if one is available.
- [ ] **Step 4: Zero console errors on every route** — visit `#`, `#apps`, `#leaderboard`, `#profile`, `#settings`, `#admin` and each `#admin/<key>` with devtools open. A console error on any route fails proposal checks.
- [ ] **Step 5: Commit any QA fixes** (each fix loops through the owning task's Step C), then a final `git log --oneline` review: history should read registry → chrome → section groups → fixes.

---

## Self-Review (done at plan-writing time)

- **Spec coverage:** registry → Task 1; guard test → Task 1; chrome + all 18 sections → Tasks 2–8 (overview section has no dedicated render beyond chrome/status composition — its tiles are covered where they live; verify during Task 9 walkthrough); build:css-per-commit → Global Constraints + Step C; visual QA both themes/widths → Task 9; bisectable delivery shape → one commit per task.
- **Placeholder scan:** none — every step has exact code, commands, or a concrete mapping.
- **Type consistency:** registry keys used in Tasks 2–8 (`card`, `cardTitle`, `muted`, `btn.primary/outline/destructive/ghost/link/*Sm`, `tableWrap`, `table`, `thead`, `th`, `td`, `trHover`, `badge.*`, `input`, `select`, `textarea`, `label`, `dialogOverlay`, `dialogPanel`, `kbd`, `separator`, `sectionTitle`, `cardHeader`, `cardDescription`) all exist in Task 1's registry literal.
