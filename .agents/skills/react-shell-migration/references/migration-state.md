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

The following deep hosts remain legacy-owned because a `public/js/**` or relocated module writes HTML into them:

- `#app-content`
- `#dc-view`
- `#dev-body`
- `#app-list`
- `#home-panels`
- `#settings-nav-desktop`
- `#settings-mobile-menu-host`
- `#admin-section-content`
- the three leaderboard panes
- `#profile-root`
- the notification and work-drawer list containers

Convert them one screen at a time, not as a sweep. `#dc-view` is created at runtime by `public/js/app-view.js`, so it cannot be converted independently of the Dev screen.

## Step 3 sequence

Treat each row below as a separate chunk.

### Small, self-contained

1. `#profile-root` — `features/profile/profile.js`, about 1,245 lines. Start here; it builds its subtree with `createElement` and `textContent` rather than `innerHTML`.
2. Notifications list — `features/notifications/notifications.js`, about 1,433 lines and five `innerHTML` sites.
3. Browse — `features/apps/browse.js` plus `app-card.js`, about 1,036 lines and seven sites.
4. Work-drawer list — about 563 lines and two sites.

### Medium

1. Home grid — convert `home.js`, `home-panels.js`, and `home-layout.js` together. They total about 5,465 lines and 19 `innerHTML` sites; `home.js` plants the `[data-panel-slot]` hosts filled by `HomePanels.render()`.
2. Leaderboard — convert the three panes independently because they have separate lazy-mount lifecycles.
3. Settings interior — about 4,186 lines and 22 sites.

### Large, deferred

1. Dev screen — `public/js/app-view.js`, about 15,041 lines and 79 sites.
2. Dev chat — about 9,198 lines and 54 sites.
3. Admin interior — about 12,800 lines and 246 sites. This is a separate product surface, not ordinary step-3 work; touch it only when an issue names it.
4. Group chat — about 3,369 lines and 23 sites.
5. Shell router — `public/js/app.js`, about 3,549 lines and four sites. Move it last regardless of size because it loads last and registers its `DOMContentLoaded` handler after every other module.

## Staging fixtures

These screens are empty on a fresh staging container, so conversions require fixtures. Check the existing seeds before adding one:

- `seedStagingNotifications`
- `seedStagingYourApps`
- `seedStagingHomeLayout`
- `seedStagingLeaderboardProfile`
- `seedStagingTopochain`
- `seedStagingBrowseCardBranches`

Together they cover nine notification kinds, four searchable apps, two home layouts, two seasons with standings and challenges, and the browse-card branch gaps found in #1120.
