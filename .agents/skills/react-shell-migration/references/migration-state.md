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
- `#admin-section-content` — **partly converted**. Every section but one
  renders from React (see below); `admin-topochain.js`'s eleven sub-sections
  are the only ones that still assign `innerHTML` into it.
- the two remaining leaderboard panes, the notification list, and the
  work-drawer list.
- the group chat's composer, thread shell, vote controls, spec-share panel and
  the two autocomplete menus.

Convert them one screen at a time, not as a sweep.

## The admin console's per-section seam

Eighteen of the console's section modules render from React (every `.tsx` in
`frontend/src/features/admin/`). The pattern is documented in AGENTS.md under
"Converting a console section to React"; the short version is that
`AdminConsole._renderSection` hands each module its host, so a converted
section swaps the `innerHTML` assignment for `mountLegacyPortal` and its
`destroy()` for `unmountLegacyPortal`. Everything else about the chassis is
untouched, which is why the two idioms coexist with no bridge.

The console had TWO populations of section, and the difference matters:

- **Delegated modules** — the ten that were already their own files behind
  `SECTION_MODULES`. All ten are `.tsx`: status, node, analytics, estimator,
  merges, gallery, campaigns, mail, push, e2e.
- **Self-rendered sections** — eight that the chassis drew itself, dispatched
  by a `switch` in `_renderSection`. All eight have MOVED OUT into their own
  `.tsx` modules (overview, codes, featured-apps, db-export, features, limits,
  users, and the rollover/staging-reap pair); each move deleted a `switch` arm
  and registered a `SECTION_MODULES` entry. Moving them out first, rather than
  converting them in place, is what kept the chassis file imperative:
  converting in place would have meant turning a 3,400-line router into a
  React file. The `switch` is gone entirely now — `_renderSection` is the
  `SECTION_MODULES` lookup plus the Overview default, and `admin-console.js`
  is down to 1,244 lines and 9 `innerHTML` sites from 3,420 and 47.

One file remains untouched:

- `admin-topochain.js` — about 4,550 lines, 138 `innerHTML` sites across
  eleven sub-sections with their own sub-nav. Convert it sub-section by
  sub-section, not as one chunk.

`overview` is the console's DEFAULT section, so `_renderSection`'s default
path dispatches through `_renderModule` too — that helper exists so both the
named and the default arm share one place that records the active module for
`_teardownActiveSection`.

### The one seam that is not the host

Rollover and Stale previews are the only sections with a caller outside the
console: `public/js/app.js` routes `admin_rollover_status` /
`admin_staging_reap_status` frames from the shell's `/ws/events` socket to
`AdminConsole.handleRolloverStatus` / `handleStagingReapStatus`, and calls
`loadRollover` / `loadStagingReap` on reconnect. That surface is the SHELL's,
so the conversion left it exactly where app.js looks for it: `admin-console.js`
keeps four thin forwarders and the two modules publish `handleStatus` /
`reload`. Each module holds a module-level `live` handle, set and cleared by an
effect, so a frame that arrives while the admin is elsewhere is dropped and the
next mount reads the job from the GET. Copy that shape for any future section
with an out-of-console caller — changing app.js instead would put shell routing
on the console's schedule.

## Step 3 sequence

Treat each row below as a separate chunk. Sizes are current.

### Converted

`#app-list` (home app grid), `#browse-list`, `#standings-tabs`, the settings
App-AI grants and agent-files lists, the group-chat transcript
(`#gc-messages` / `#gc-thread-messages`), and the eighteen admin sections
above — every console section except topochain's eleven.

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
3. Admin interior — `admin-topochain.js`, about 4,550 lines and 138 sites,
   per the seam above. It is all that is left of the console: the chassis
   (`admin-console.js`) is 1,244 lines and 9 sites, none of them a section.
   Convert its eleven sub-sections one at a time; they share a sub-nav, so
   the sub-nav host is its own ownership boundary and should go last.

## Staging fixtures

Several sections are empty in a prod-cloned staging database because their
tables are `staging:private`. Reach them with `/?demo=1#admin/<key>` — the
flag is read from `location.search`, so it goes BEFORE the hash. It covers the
screenshot gallery, merge debug, analytics, estimator accuracy, container
rollover and stale previews. Running the local server with
`USERNODE_ENV=staging` is what enables the substitution.
