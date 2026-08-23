# Platform shell migration state

## Contents

- Step 2 closeout
- Plan deviations
- Remaining legacy-owned hosts
- The admin console: done
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
- `#settings-nav-desktop`, `#settings-mobile-menu-host`, and the settings
  interior.
- nothing on the Leaderboard screen. See the note under "Converted".
- the group chat's composer, thread shell, vote controls, spec-share panel and
  the two autocomplete menus.
- the header's own strays: `header/ai-credit.js`, `header/wallet-sheet.js`,
  `header/node-pill.js`, `native-chrome.js` and `screenshot-select.js`.

`members-controller.js` and `app-secrets-controller.js` are NOT on this list
and should not be added: AGENTS.md documents both as legitimate legacy hosts
inside a converted dialog.

Convert them one screen at a time, not as a sweep.

## The admin console: done

**Every admin section and every programme screen renders from React.** The
console has no `innerHTML` section left, and neither chassis builds markup:

- `frontend/src/features/admin/admin-console.js` — 1,244 lines (from 3,420).
  Routing, the nav, `canWrite` / `_alert` / `_confirm`, the money helpers, and
  four WS forwarders. `_renderSection` is a `SECTION_MODULES` lookup plus the
  Overview default; the `switch` it dispatched its own renderers through is
  gone.
- `frontend/src/features/admin/admin-topochain.js` — 424 lines (from 4,550).
  A router for the eleven programme screens: the address
  (`_subFromHash` / `_readSeasonEventsDeepLink` / `_syncHash`), the
  screen-switch lifecycle, and the three helpers the screens defer to. Its
  whole markup-helper family — `esc`, `safeHref`, `_field`, `_panel`, `_list`,
  `_pagerHtml`, `_skeleton`, `_empty`, `_error` … — is deleted, not kept as a
  second copy that drifts.
- `frontend/src/features/admin/*.tsx` — the eighteen console sections.
- `frontend/src/features/admin/topochain/*.tsx` — the eleven programme screens
  plus the programme users card, over `ui.tsx` (the shared chrome),
  `tokens.ts` (the control-styling strings both renderers used while the
  conversion ran), `api.ts` (fetch + the picker sources) and
  `challenge-fields.ts` (the Add-challenge template contract, as pure
  functions).

The pattern for adding one is in AGENTS.md under "The console is React — add a
section the same way". Four things that run through the whole conversion and
are worth knowing before touching it:

- **The two nested hosts.** `#admin-section-content` is the console's; a
  programme screen's is `#admin-topo-content`, which `admin-topochain.js`
  recreates on every screen switch — so a converted screen is unmounted BEFORE
  the `innerHTML` that discards the node.
- **The seams that are not the host.** `public/js/app.js` routes two WS frame
  types to `AdminConsole.handleRolloverStatus` / `handleStagingReapStatus` and
  calls two loaders on socket reconnect; that surface is the SHELL's, so the
  console keeps thin forwarders and the modules publish `handleStatus` /
  `reload`. Delegations' "View account" imports `openAccountDetail` from
  Onchain accounts. Seasons' "View events" writes `_se.seasonFilter` and jumps.
  Copy the explicit-export shape for any new one: a bare global read broke the
  first of them silently.
- **The address stayed with the router.** Season events is deep-linkable at
  `#admin/season-events/<id>[/new-challenge[/<templateId>]]`, and
  `admin-topochain.js` still parses and writes it. The screen seeds itself
  from `_se` / `_ch` and publishes back through one helper.
- **Two exemptions retired with the work.** The audit's
  `except: ['#admin-users-programme']` (the programme users card's host) and
  `shell-icon-set.test.js`'s byte-for-byte glyph anchor against `_panel()`
  both went when the thing they described stopped existing. Read their
  replacements before adding a new exemption of your own.

## Step 3 sequence

Treat each row below as a separate chunk. Sizes are current.

### Converted

- The WHOLE admin console — eighteen console sections, eleven programme
  screens and the programme users card. See its own section above.
- `#standings-tabs`, the settings App-AI grants and agent-files lists, and the
  group-chat transcript (`#gc-messages` / `#gc-thread-messages`).
- The four "small, self-contained" screens this list used to sequence:
  `#profile-root`, the notifications list, Browse (`#browse-list` /
  `#browse-detail`) and the work-drawer list. Each kept its module — the data,
  the fetches and the gestures stayed — and gained a store plus components.
- **The WHOLE Leaderboard screen.** The three panes went first; the shared
  event bar (`#leaderboard-event-bar`, the picker and hero both Topochain-domain
  panes select through) followed. `kudos.js` still contains `innerHTML` and is
  NOT a remaining target: one site fills the retired `#kudos-budget-slot`
  (kept as a re-homing seam — see tests/shell-id-inventory.test.js), and the
  rest are the hover popover inside `Kudos.renderButton`'s HTML string, which
  `app-view.js` inlines into the Dev screen's PR panels. That popover's
  ownership boundary is the Dev screen, not this one.
- **The WHOLE home screen.** `#app-list` (the launcher canvas),
  `#home-widget-strip-section` and `#home-apps-more` (the two hosts outside
  it), and the three fixed sections below it — Discover, Challenges and Create
  app. `home.js` and `home-panels.js` between them assign markup in exactly two
  places now, both on DETACHED elements: the card menu's rich header, which the
  kit adopts, and the drag overlay's cells.

Two things from the home conversion are worth reading before the next screen:

- **`Home._showGridOverlay` appends into `#app-list`, which React owns.** It
  is a deliberate exception resting on a TIMING invariant rather than a
  boundary — the overlay exists only between onLift and onSettle, and
  `render()` / `load()` are the only publishers of the grid model, both
  returning early while `_dragActive` holds. The ownership audit never drags,
  so it cannot see any of this; `tests/home-grid-placement.test.js` pins both
  halves instead.
- **A helper whose whole job was re-wiring after a repaint is DEAD, not
  spare.** `Home.wireCreateButtons()` did a `cloneNode` + `replaceChild` to
  clear stale listeners; once its block was React's it had no caller and no
  other matching element, and leaving it would have left a structural DOM write
  pointed at a host React reconciles. Delete those with their caller.

### Medium

1. Settings interior — about 5,500 lines and nine sites.
2. Group chat, everything but the transcript — `public/js/group-chat.js`,
   about 3,580 lines and 21 sites. The transcript conversion left the
   composer, the thread shell, `[data-gc-vote-controls]`, the spec-share card
   and the mention/ref autocomplete menus as legacy hosts on purpose; each is
   its own ownership boundary.

### Large, deferred

1. Dev screen — `public/js/app-view.js`, about 14,140 lines and 71 sites.
2. Dev chat — `features/dev-chat/dev-chat.js`, about 9,820 lines and 58 sites.
   Streaming assistant output is the complication.
3. ~~Admin interior~~ — **done**. See "The admin console: done" above.

## Staging fixtures

Several sections are empty in a prod-cloned staging database because their
tables are `staging:private`. Reach them with `/?demo=1#admin/<key>` — the
flag is read from `location.search`, so it goes BEFORE the hash. It covers the
screenshot gallery, merge debug, analytics, estimator accuracy, container
rollover and stale previews. Running the local server with
`USERNODE_ENV=staging` is what enables the substitution.

Two things the seed does NOT cover, worth knowing before concluding a screen
is broken: `waitlist_signups.answers` is empty on every row, so the survey
block on Stale previews' sibling screen is unreachable in a preview (its
executed test is `tests/topochain-waitlist-survey.test.js`); and
`available-activity-types` lists only templates an event has NOT used, so the
Add-challenge picker is empty on a fully-populated event — use one of the
unfilled seeded events.
