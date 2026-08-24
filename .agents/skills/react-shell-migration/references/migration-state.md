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

- `#dc-view` — the Dev chat's host, created at runtime by
  `public/js/app-view.js`, so it cannot be converted independently.
  `#app-content` itself is no longer on this list: all four Dev sub-views mount
  a React frame into it.
- `#settings-nav-desktop`, `#settings-mobile-menu-host`, and
  `#settings-usernode-section` — see "The settings interior" below.
- nothing on the Leaderboard screen. See the note under "Converted".
- `#dev-body` and the card family it holds — the Dev screen's remaining chunk.
  See "Large" below for what that is and what has to move with it.
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
- **The settings interior, except one section.** The panes have been React
  markup since chunk D, with settings.js binding every control by id; what this
  run converted is the five places it also BUILT rows — the CLI credentials
  list, the connectors list, the social-account block (~330 lines: tier card,
  provider rows, audit and stranded notes, the admin diagnostics panel), the
  attached-machines list, and the build-flow preference, which it had been
  INJECTING into the Connections pane at runtime.

  **`#settings-usernode-section` is deliberately NOT converted.** It is ~1,100
  lines across a helper family (`_unEl` / `_unSection` / `_unToggle` /
  `_unButton` / `_unStatusRow`) and eight sub-sections, and it is unverifiable
  from a browser: `_renderUsernodeBody` does `if (this._unDemoMode()) return;`
  after the connection and permissions boxes, because "the sections below all
  read the live bridge, which a browser does not have". So `?usernodedemo=ios`
  covers maybe 200 of those lines and the rest — node sleep, block production,
  privacy, widget icons, diagnostics, about & legal, the account hint, social
  push — needs a real device. Convert it as its own chunk, on a phone; the
  `mobile-push-testing` skill exists for that half of it.
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

- **The group chat, except the composer.** The transcript went first; this run
  took the rest, one boundary at a time: the two autocomplete menus
  (`#gc-mention-menu` / `#gc-ref-menu`), the shared-spec reader
  (`#gc-spec-side-panel`), the thread panel's whole shell
  (`GroupChat.mountThread`), and the long-press reaction bar
  (`#gc-react-bar`). Three of those are body-level floating hosts and share one
  seam: the module still creates the element, measures it against something on
  screen and owns its `hidden`; React owns only its children, through a portal
  mounted once. All three stores install `setFlush(flushSync)`, because in each
  case the module measures the host on the line after it publishes.

  **What is left is the composer, and it is the Dev screen's boundary.** The
  reply preview, the attach-error line and the attachment strip each exist
  TWICE — a general variant in a host `public/js/app-view.js` owns, and a
  thread variant inside the React shell — drawn by one renderer from one CSS
  rule. `.gc-quoted` shares its rules with `.gc-reply-preview-inner` the same
  way. Converting either half alone splits a deliberate pair, so they go with
  the Dev screen.

### Read this before the next screen: an empty host fails silently

The single most productive thing in this run was not a conversion. It was
asking, of every string renderer in a converted module: **who calls this?**

`public/js/group-chat.js` had SIX members with no caller left, and four of them
were a live regression rather than dead weight — the earlier transcript
conversion had replaced each with an empty host and nothing ever filled it:

| what was missing | how it looked |
| --- | --- |
| the shared-spec card | a `[data-gc-spec-share]` div with nothing in it |
| a message's attachments | a `[data-gc-attachments]` div, ditto |
| a vote row's Yes/No pair and tally | `data-gc-vote-controls` is not the `[data-vote-controls]` the module selects |
| a reaction pill's click | an onClick calling `toggleReaction`, which is not a method |
| a quoted reply's snippet and icon | drawn as `ThreadReplySummary` — "1 reply alice" |
| the unread dot, both directions | a lookup for `[data-unread-dot]`, an attribute React does not render |

None of it threw. None of it failed a test — one test asserted the EMPTY HOST
was present and passed. The ownership audit could not see any of it either: it
watches for legacy WRITES into React subtrees, and every one of these was a
write that MISSED.

Three sweeps catch this class, and they are cheap enough to run after every
chunk:

1. **Uncalled members.** For each `^  name(` in a converted module, search the
   whole repo for a call site — with comments stripped, or a retirement note
   naming the thing counts as a use.
2. **Empty hosts.** For each element a component renders with no children and
   an `id` or `data-*`, search for something that fills it. One reference (the
   render itself) means nothing does.
3. **Orphan lookups.** For each `getElementById('x')` / `querySelector('#x')`,
   search for something that renders `id="x"`. This is the mirror image, and
   it is how the unread dot turned up.

A fourth check has no script: **read the component against the renderer it
replaced, attribute by attribute.** The vote host and the quote block were
both cases where a host existed, was filled by something, and still did not
work, because the two ends had agreed on different names.

And a fifth is about the ownership audit itself: **run it signed in, with the
cookie's own host.** `scripts/audit-react-ownership.mjs` takes an `AUTH`
storage state, and without one most of the route list renders an empty
`#app-content` — no Dev board, no Dev chat composer, no admin console — while
the script still prints a confident "0 legacy writes". The saved cookie is
scoped to the host it was captured on, so `http://127.0.0.1:3000` and
`http://localhost:3000` are not interchangeable; the wrong one is silently
anonymous. Getting this wrong hid a real finding (`refreshVoteControls`
writing into `#gc-messages`) behind a clean run. Check that one route actually
rendered before believing a zero.

### Large

1. **Dev screen — `public/js/app-view.js`. Started; the card family is what is
   left.** Every FLOATING and INDEPENDENT surface has converted:

   | converted | host |
   | --- | --- |
   | the general chat pane and its composer | `#dev-chat-body` |
   | the topic sub-view's frame | `#app-content` |
   | the metadata picker | `#attr-popover` |
   | the card's ⋯ menu | `.dev-card-menu` |
   | the voting-help popover | `#voting-help-popover` |
   | the kanban filter bar | `#dev-kanban-filterbar` |
   | an issue's GitHub thread | `#dev-issue-comments` |
   | the locked-app banner | `#dev-locked-notice` |

   Three of those are body-mounted floating hosts and share the seam the group
   chat's menus established: the module creates the element, measures it
   against something on screen and owns its `hidden` (or removes it on close);
   React owns only its children. Each store installs `setFlush(flushSync)`,
   because in every case the module measures or focuses on the line after it
   publishes.

   **What is left is one chunk, and it does not decompose.** The six card
   renderers — `_renderIssueRow`, `_renderProposalCard`, `_renderGovCard`,
   `_renderMySessionCard`, `_renderSharedSessionCard`, `_renderMergedCard` /
   `_renderCompletedCloseIssueCard` — share one shell (`_cardContentHtml`,
   `_cardBadgesHtml`, `_cardRailHtml`, `_cardActionsHtml`, `statusPillHtml`,
   `voteCountPill`, `voteButtonsHtml`, `_attrChipHtml`, `cardPreviewHtml`,
   `checksBadgeHtml`, `closesPillHtml`) and have exactly five consumers: the
   feed (`_renderFeedInner`), the kanban (`_renderKanbanInner`), the
   in-progress strip, the merged list and the topic head (`_renderTopicHead`).
   A card cannot convert before its consumers, and a consumer cannot convert
   before the cards it draws — so it is one commit of roughly 2,500 lines of
   renderer, not a sequence.

   **Two live in-place writers have to move with it**, and both are tractable:

   - `_applyExploreChatAvailability` sets `disabled`, `title` and two classes
     on every `.gc-explore-chat-btn` after a memoised `/api/budget` check. It
     becomes an `aiEnabled` field on the view model, republished when the
     promise settles.
   - the 30s countdown ticker rewrites `.gc-vote-count-label`'s text on every
     `[data-window-ends]` pill. It becomes a `now` tick the pills' labels
     derive from — it already walks every pill, so the cost is unchanged.

   `refreshVoteControls` needs no move: the group chat's transcript already
   proved the pattern (the host's CONTENTS stay the module's, the row's TINT
   becomes a patched field, and `patchTranscriptMessage` drops a patch that
   says nothing new so the effect that calls it cannot loop).

   Smaller pieces that are genuinely independent and could go first:
   `#dev-locked-notice`'s siblings in the same list (`#dev-chat-card-preview`,
   `#dc-secrets-state`), the three body-mounted modals (generate-proposal,
   LLM consent, credits — the last embeds `CreditOptions.cardHtml`, another
   module's markup, so it keeps a controller-host seam), the shared-session
   transcript slot (its body comes from `public/js/session-transcript.js`),
   and `renderAppTab` / `renderDevChatTab`'s shells.

2. **Dev chat — `frontend/src/features/dev-chat/dev-chat.js`, about 9,820
   lines and 58 sites. Started at the composer.** Four strips have converted:

   | converted | host |
   | --- | --- |
   | the pending-upload strip | `#dc-attachments` |
   | the credit meter | `#dc-budget` |
   | the quick-reply pills | `#dc-quick-replies` |
   | the "Run on" controls | `#dc-runner` |

   All four are the host-is-mine/children-are-React's seam: `renderChatView`'s
   template writes each ELEMENT and the module toggles the class that gives it
   a height (`dc-attach-strip-active`, `dc-quick-replies-active`), so React
   owns only the children. `renderChatView` rebuilds all four on every
   chat-view render, so each mounts per publish and the previous host's portal
   entry is swept as detached by `pruneDetachedLegacyPortals`. All four hosts
   are in the ownership audit's `OWNED`, swept on
   `#app/recipebot/dev/sessions/1`.

   The pending strip is `features/attachments/pending-strip.tsx`, SHARED with
   the group chat's two composers — the first component either screen took
   from the other. It exports two things on purpose: `PendingStripRows` (the
   rows alone, for a host the legacy template already emitted) and
   `PendingStrip` (the element plus its rows, for a caller that owns the whole
   thing). Mounting the wrong one nests `#dc-attachments` inside itself, which
   is a real bug this made once and `tests/attachments-pending-strip.test.js`
   now pins.

   **`dev-chat.js` must stay import-free.** A dozen test files load it with
   `vm.runInContext(SRC)` as a classic SCRIPT, where a top-level `import` is a
   syntax error — adding four of them broke 194 tests. The bridge is
   `features/dev-chat/mount.ts`, imported by `main.tsx` before the module and
   published as `window.UsernodeReact.devChat`; the module reads it at call
   time and bails when it is absent. Both files' headers say so, and the test
   above asserts it.

   What is left is the big half: `renderChatView`'s own shell, `renderMessages`
   and the streaming assistant output. Streaming is the complication — the
   message list is appended to token by token, so it wants a store that
   patches one row rather than republishing the list.

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
