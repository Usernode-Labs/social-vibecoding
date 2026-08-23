# Platform shell migration state

## Contents

- Step 2 closeout
- Plan deviations
- Remaining legacy-owned hosts
- Step 3 sequence
- Staging fixtures

## Step 2 closeout

All eight chunks A–H of #1040 landed with the like-for-like contract intact. All 32 regions render from components, and `tests/baselines/shell-markup.json` retained its original 444 ids. No chunk A–H retired an id; `ADDED_IDS` contains the deliberate additions with reasons.

`RETIRED_IDS` is not empty and was never the measure of this run. It contains `drawer-row-app-version` and `app-version-pill-slot`, both retired by the separate per-dApp-SHA removal. Read the map for its recorded reasons rather than treating emptiness as a migration goal.

## Plan deviations

### No Radix

`frontend/package.json` depends only on `class-variance-authority`, `clsx`, `react`/`react-dom`, and `tailwind-merge`. Every primitive under `frontend/@/components/ui/` is hand-rolled. The modules that shadow packages a shadcn recipe would normally install carry a “Why this is NOT …” header explaining the preserved behavior. Do not follow the old plan's instruction to add `@radix-ui/*`; a real Dialog primitive would first have to reconcile with the static-modal seam.

### Retirement usually meant relocation

Only `offline.js`, `settings.js`, `dev-chat.js`, and, in chunk I, `app-secrets.js` and `screenshot-select.js` genuinely left the page. Most relocated lines remain imperative code in the frontend bundle and still publish their `window.X` globals. “Converted to React” in the chunk issues means wrapped in a component, not rewritten.

### Dialogs are already stateful

Chunk I moved the static-modal lift inside React through `frontend/src/lib/static-modal.ts` and `features/dialogs/use-dialog.ts`. Drive all nine dialogs through `useDialog`; do not revisit the old `PlatformUI.adoptStaticModal` approach.

## Remaining legacy-owned hosts

A host is legacy-owned while a `public/js/**` or relocated module writes HTML
into it. The list below is the state after the widget-library run (#1120);
`scripts/audit-react-ownership.mjs` carries the converse — every host React
now reconciles — and is the thing to update when one moves across.

- `#app-content` and `#dc-view` — the Dev screen. `#dc-view` is created at
  runtime by `public/js/app-view.js`, so it cannot be converted independently.
- `#dev-body` — the Dev chat.
- `#home-panels` and the home grid's panel slots.
- `#settings-nav-desktop`, `#settings-mobile-menu-host`, and the settings
  interior.
- `#admin-section-content` — **partly converted**. Ten section modules render
  from React (see below); the console's own eight self-rendered sections and
  `admin-topochain.js`'s eleven sub-sections still assign `innerHTML` into it.
- the two remaining leaderboard panes, the notification list, and the
  work-drawer list.
- the group chat's composer, thread shell, vote controls, spec-share panel and
  the two autocomplete menus.

Convert them one screen at a time, not as a sweep.

## The admin console's per-section seam

Ten of the console's twelve top-level modules are React
(`admin-e2e`, `admin-gallery`, `admin-node`, `admin-merges`, `admin-push`,
`admin-campaigns`, `admin-mail`, `admin-status`, `admin-estimator`,
`admin-analytics` — all `.tsx`). The pattern is documented in AGENTS.md under
"Converting a console section to React"; the short version is that
`AdminConsole._renderSection` hands each module its host, so a converted
section swaps the `innerHTML` assignment for `mountLegacyPortal` and its
`destroy()` for `unmountLegacyPortal`. Everything else about the chassis is
untouched, which is why the two idioms coexist with no bridge.

Two files remain, and they are the reason the console is not finished:

- `admin-console.js` — about 3,420 lines, 47 `innerHTML` sites. This is the
  chassis (sidebar, mobile two-level router, view-only banner, temp-password
  dialog) PLUS eight sections it renders itself (users, codes, limits,
  features, featured-apps, rollover, staging-reap, db-export). The chassis and
  the sections are separable: the sections can move to their own `.tsx`
  modules behind `SECTION_MODULES` before the chassis is touched at all.
- `admin-topochain.js` — about 4,550 lines, 138 `innerHTML` sites across
  eleven sub-sections with their own sub-nav. Convert it sub-section by
  sub-section, not as one chunk.

## Step 3 sequence

Treat each row below as a separate chunk. Sizes are current.

### Converted

`#app-list` (home app grid), `#browse-list`, `#standings-tabs`, the settings
App-AI grants and agent-files lists, the group-chat transcript
(`#gc-messages` / `#gc-thread-messages`), and the ten admin sections above.

### Small, self-contained

1. `#profile-root` — `features/profile/profile.js`, about 555 lines and no
   `innerHTML` at all; it builds its subtree with `createElement` and
   `textContent`. Still the easiest start.
2. Notifications list — `features/notifications/notifications.js`, about
   1,670 lines and three sites.
3. Browse — `features/apps/browse.js` plus `app-card.js`, about 1,030 lines
   and two sites.
4. Work-drawer list — about 563 lines and two sites.

### Medium

1. Home grid — convert `home.js`, `home-panels.js` and `home-layout.js`
   together, about 5,640 lines and 18 sites; `home.js` plants the
   `[data-panel-slot]` hosts filled by `HomePanels.render()`.
2. Leaderboard — convert the remaining panes independently because they have
   separate lazy-mount lifecycles.
3. Settings interior — about 5,500 lines and nine sites.
4. Group chat, everything but the transcript — `public/js/group-chat.js`,
   about 3,580 lines and 21 sites. The transcript conversion left the
   composer, the thread shell, `[data-gc-vote-controls]`, the spec-share card
   and the mention/ref autocomplete menus as legacy hosts on purpose; each is
   its own ownership boundary.

### Large, deferred

1. Dev screen — `public/js/app-view.js`, about 14,140 lines and 71 sites.
2. Dev chat — `features/dev-chat/dev-chat.js`, about 9,820 lines and 58 sites.
   Streaming assistant output is the complication.
3. Admin interior — `admin-console.js` + `admin-topochain.js`, about 7,970
   lines and 185 sites, per the seam above.

## Staging fixtures

Several sections are empty in a prod-cloned staging database because their
tables are `staging:private`. Reach them with `/?demo=1#admin/<key>` — the
flag is read from `location.search`, so it goes BEFORE the hash. It covers the
screenshot gallery, merge debug, analytics and estimator accuracy. Running the
local server with `USERNODE_ENV=staging` is what enables the substitution.
