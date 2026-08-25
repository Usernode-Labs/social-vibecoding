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
- nothing on the Dev screen but `showLaunchCoverShot`'s launch cover, which
  is deliberate — see "Large" below.
- the header's own strays, ALL of them native-only now:
  `header/wallet-sheet.js`, `header/node-pill.js` and
  `header/native-app-version.js` each `return` unless
  `window.usernode.isNative === true`, so like `#settings-usernode-section`
  they need a phone, not a browser. `native-chrome.js` and
  `screenshot-select.js` build no markup. `header/ai-credit.js` was the one
  browser-visible stray and has converted — see below.

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
- **The AI-credit row** (`#drawer-row-ai-budget` / `#ai-budget-slot`, in
  Settings → Anthropic API key). `header/ai-credit.js` publishes a view model
  and `header/ai-budget.tsx` draws it; the fetch, the throttle, the
  thresholds and the reset wording stay in the module. Three things from it:

  - **`.drawer-meter-part` is `white-space: nowrap`**, so the space BETWEEN
    parts is the only place the value may break. A separator folded into a
    part would make the whole figure unbreakable on a 15rem panel — the
    component renders a real space text node between parts for that reason,
    and a test pins it.
  - **`hidden` is a third state, not `!view`.** The row ships VISIBLE and
    empty and hides only once the me-scoped fetch has answered with nothing;
    collapsing that into "no view means hidden" would hide it on a document
    that has not fetched, and a declared check resolves
    `#drawer-row-ai-budget #ai-budget-slot` on a plain `/#settings/api-key`.
  - **A store a legacy module imports directly must be plain `.js`, imported
    WITH its extension.** `ai-credit.js` is an ES module in the bundle, so a
    test can `import()` it — but only if Node's resolver can follow the
    import, which it cannot do for a bare `./x` pointing at a `.ts`. Same
    arrangement as `app-frame/app-frame-store.js`. And the test reads the
    store from NODE's graph, not from the `loadTsx` bundle: esbuild gives
    each entry its own copy, so those are two different objects.

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

  **The composer went too, as ONE component with a `scope`.** The reply
  preview, the attach-error line and the attachment strip each existed TWICE —
  a general variant in a host `public/js/app-view.js` owned, and a thread
  variant inside the React shell — drawn by one renderer from one CSS rule.
  Splitting that into a thread component and a general one would have been the
  first time the two could disagree, so `features/group-chat/composer.tsx`
  takes a `scope`, which is the same ternary in the same one place. The
  pending-upload strip came out of it into `features/attachments/`, shared
  with the DEV chat's composer — the first component either screen took from
  the other, and the reason that one converted cleanly months later.

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
   whole repo for a call site — with comments stripped PER FILE (see the
   fourth check below), or a retirement note naming the thing counts as a use
   and an unterminated `/*` in one file hides every symbol in the next. It
   caught `_assigneeAvatarPlaceholderHtml` the day the chip spec started
   resolving the avatar itself.
2. **Empty hosts.** For each element a component renders with no children and
   an `id` or `data-*`, search for something that fills it. One reference (the
   render itself) means nothing does.
3. **Orphan lookups.** For each `getElementById('x')` / `querySelector('#x')`,
   search for something that renders `id="x"`. This is the mirror image, and
   it is how the unread dot turned up.

A fourth check has no script by default: **read the component against the
renderer it replaced, attribute by attribute.** The vote host and the quote
block were both cases where a host existed, was filled by something, and
still did not work, because the two ends had agreed on different names.

For a conversion big enough to be worth it, AUTOMATE that one: render the
same fixture rows through the pre-conversion builder (`git show HEAD:` it)
and through the model plus component, tokenise both — tag name, SORTED
attributes, normalised text — and diff the streams. Four normalisations make
it usable and none of them hides a behaviour change: entity spelling (React
writes `·`, the builders wrote `&middot;`), attribute order (React's is prop
order), `onclick` (a closure now, checked separately through the model), and
`<path/>` versus `<path></path>`. Two traps in writing it: strip comments PER
FILE before joining, or a `/*` inside one file's template literal swallows the
head of the next; and collapse an empty element's close tag on both sides, or
one extra `/path` token shifts everything after it and every card reads as
different. It found the card family identical in ten of eleven variants,
which is the difference between believing the conversion and knowing it.

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

### And a sixth: `dapp.json`'s checks are part of the contract, and some of
their hooks are side effects of string rendering

`tests/dapp-selectors-resolve.test.js` resolves declared selectors against the
STATIC prerendered document and explicitly excludes runtime-injected markup —
which is exactly what every converted card, chip and dialog is. So the local
suite cannot see a declared check that a conversion broke. The platform can,
and it costs a build and a vote to find out.

Three of the 405 broke on the Dev/home chunks, and none of them was a
behaviour change:

| the check's hook | why the conversion lost it |
| --- | --- |
| `.app-card[data-yours="true"][style*="grid-row"]` | React sets styles through the CSSOM one longhand at a time; `grid-column` + `grid-row` cover all four longhands of `grid-area`, so the browser re-serialises the block as the SHORTHAND and the text `grid-row` leaves the attribute |
| `.gc-vote-btn[onclick*="markIssueInProgress"]` | the inline handler became a closure |
| `.gc-vote-btn[onclick*="_setSessionShared"]` | same |

A fourth broke on the commit AFTER those three, and it is the sharpest of the
set because the code that caused it did not change: **`canEagerLaunch` — a
predicate — tore down the React roots that own `#app-content` on its way to
answering.** That was harmless while the App tab's placeholders were
hand-written `innerHTML`, which `unmountAllLegacyPortals` cannot touch. Once
they became a portal, `renderAppTab` painted "App failed to start · View build
log", `beginLaunch` asked the predicate four milliseconds later, and the
answer — no, this app is not running — arrived with the placeholder already
swept away. Nothing repainted it. **A function that decides must not tear down
before it has decided**; the teardown belongs at the write, in `beginLaunch`,
which is where it is now. It is worth grepping any predicate a converted
surface reaches for `_teardown`.

The `grid-row` one is the one to remember for a different reason: it is
invisible in the DOM inspector's own rendering and in every screenshot — the
tiles are in the right cells and the check still reports "selector not
found". A per-item inline
style that must keep its authored SPELLING has to be written with
`setAttribute` — see the header note in `frontend/src/features/home/app-grid.tsx`,
which also says why the effect is keyed on the placement rather than run on
every render.

The other two are the general case: **an `[onclick*="…"]` check names the
handler, and a conversion removes handler names from the markup.** The model
already carries the answer, so publish it — the card's `ActionButton` renders
`data-act={a.act?.fn}` — and move the check to `[data-act="…"]` in the same
commit. That is a change to a declared check and belongs in the proposal's
description, not in a quiet diff.

So, before submitting a chunk that converts anything a declared check selects
on: `grep` `dapp.json` for the ids, classes and attributes in the converted
subtree, and resolve each selector in a real browser on the route the check
names. `tests/declared-check-action-hooks.test.js` is the pattern for pinning
one locally afterwards — it reads the real dapp.json entry, renders the real
model, and fails here rather than on the platform.

Two traps in writing that browser sweep, both of which hid a real failure:

- **Normalise the path the way the runner does.** The platform IS the app under
  test, so `services/visuals.js` rewrites its own routes through
  `selfAppHashPath` before visiting them — `/app/x/dev` becomes `/#app/x/dev`.
  A sweep that visits the raw path lands somewhere else and reports three
  false failures.
- **`expectText` is a SEPARATE assertion, and it is `textContent`.** A check
  can have no selector at all — #288, "Errored app view shows the failure
  reason and build-log button", is only an `expectText` — so a sweep that
  resolves selectors and nothing else skips it entirely. That is how a blank
  App tab reached the platform. Use `textContent`, not `innerText`: `innerText`
  drops what CSS hides, and the native-kit demo and the admin console both keep
  real, declared-checked sections off screen.

### Large

1. **Dev screen — `public/js/app-view.js`. Done, bar the launch-cover
   screenshot state.** The board, the topic head, the three body-mounted
   modals and the App tab's placeholders have all converted. Every card,
   every surface that draws one, and every floating surface around them is
   React:

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
   | **the list feed, every card in it** | `#dev-feed` |
   | **the kanban board, its columns and tabs** | `#dev-kanban-board` |
   | **the opened topic's head — the card AND its body** | `#gc-thread-head` |
   | **the Generate-proposal dialog** | `#auto-session-modal` |
   | **the out-of-credits dialog** | `#credit-options-modal` |
   | **the app-AI consent dialog** | `#llm-consent-modal` |
   | **the App tab's five placeholder states** | `#app-content` (App tab) |

   Six of those are body-mounted floating hosts and share the seam the group
   chat's menus established: the module creates the element, measures it
   against something on screen and owns its `hidden` (or removes it on close);
   React owns only its children. Each store installs `setFlush(flushSync)`,
   because in every case the module measures or focuses on the line after it
   publishes.

   **The card family: one model, one component, seven builders.** Six card
   renderers plus the settled close-issue row shared one band builder and had
   five consumers, so a card could not convert before its consumers and a
   consumer could not convert before its cards. What converted is the shape
   they share: `card/model.ts` is a plain serialisable view model,
   `card/dev-card.tsx` renders it, and each `_render*Card` became a
   `_*CardModel` builder. `_feedView()` and `_kanbanView()` build the two list
   surfaces the same way.

   **Everything in the model is RESOLVED data.** `DEV_CARD_ICONS`,
   `ASSIGNEE_AVATAR_TINTS`, `_priorityMeta`, `_categoryMeta`,
   `statusPillState`, `blockReasons` — every table and derivation stayed in
   app-view.js and the builder puts the ANSWER in the model: the icon arrives
   as its tint classes and its SVG path, a chip as its label and its tint.
   That is not tidiness. app-view.js is a classic script the bundle cannot
   import and Tailwind's extractor is a regex over source text, so a palette
   copied into the component would exist twice with only one copy able to
   change colour.

   **Handlers are named calls, not closures.** A card's `onclick="AppView.
   castVote(12, 'yes')"` became `{ fn: 'castVote', args: [12, 'yes'] }`,
   because the model has to survive being published through a plain store.
   `call()` in the component dispatches by name and no-ops on an unknown one.
   The ⋯ menu is the exception and keeps its registry: a descriptor's `act`
   IS a closure, so `_registerCardMenu` still returns a key the rail stamps
   as `data-card-menu`.

   **Four in-place DOM passes became publishes**, and each was a second
   author on a node the card renders:

   - the 30s countdown ticker rewrote every pill's label; it publishes
     `Date.now()` through `cardNowStore` and each pill re-derives its own.
   - `_applyExploreChatAvailability` dimmed each Explore pill; the card pills
     read `aiEnabledStore`; the detail block's pills read it too now, so the
     DOM pass is gone entirely.
   - `_applyKanbanTab` toggled six classes per tab; `_onKanbanTabSelect`
     republishes `activeTab`.
   - `bumpThreadBadge` wrote the count, the tint, `hidden` and the band's
     #1139 `data-empty` flag; it bumps the cache and repaints, and the flag
     comes back out of the render inputs it cannot drift from.

   **Three seams stayed legacy-filled**, each rendered once, empty, with a
   constant className: `[data-kudos-host]` (`Kudos.renderButton` builds it,
   `attach`/`_refreshButton`/`_renderPopover` keep writing inside — four
   writers in another module), `.dev-feed-comments` (filled when its row
   scrolls into view) and `#dev-issue-title-error`.

   **The drag recognizer needs a REMOUNT, not a publish.** `_commitBoardOrder`
   calls `_repaintKanbanBoard(true)`, which drops the portal and mounts a
   fresh one: the recognizer physically moved those nodes, and React
   reconciling keyed children over rearranged DOM leaves cards where the
   gesture put them. `_dragState` still blocks every publish mid-gesture.

   **What the conversion was checked against.** Ten of the eleven card
   variants render structurally IDENTICAL markup to the pre-conversion string
   builders — same tags, same attributes, same text, compared token by token
   over fixture rows. The one difference is the kudos slot above. That check
   is the fourth one below, automated; the script is not checked in because
   it diffs against `git show HEAD:`, but it is worth rebuilding for any
   conversion this size.

   Two behaviours changed on purpose. The archived-sessions list is component
   state, so a background repaint no longer snaps it shut; and the inline
   title editor is rendered FROM `_editingIssueTitle` rather than written over
   the title, so it survives a repaint (the guard that skips the repaint is
   still there, and is now purely about not discarding typed text).

   **The topic head's BODY converted next, and unlike the card family it
   decomposed.** `_renderTopicHead` used to build the card and eight string
   renderers into one `innerHTML` and then bind four handlers into what it
   had just painted. It publishes `{ card, body }` now — `topic/model.ts`,
   drawn by `topic/topic-head.tsx` — and the handlers are closures. Nine
   builders retired into view builders that stayed in app-view.js:
   `_detailActionsHtml`, `_proposalDetailsHtml`, `_checksDetailHtml`,
   `_platformEnvDetailHtml`, `_consoleCheckDetailHtml`,
   `_mergeConflictDetailHtml`, `_voteRosterHtml`, `_transcriptSectionHtml`
   and `_recheckBtnHtml`.

   **Four renderers were drawing the same box.** The conflict note, the
   platform-variables note, the console-errors note and three of the checks
   block's five states were all a bordered, tinted box with a heading, some
   lines, sometimes a list, sometimes a button — written out four times with
   four hand-copied class strings. They are one `NoteBox` shape and one
   component now, and the tint is a NAME (`ok` / `warn` / `error` /
   `neutral`) resolved to complete class literals in one table. That is what
   keeps them one box as the palette moves. The checks VERDICT kept its own
   shape: its rows nest and its passing rows fold behind a `<details>`,
   neither of which the shared box should know about.

   Two things about the model that the string version got for free and a
   plain store does not:

   - **Prose with emphasis needs a run list.** Several of these sentences
     set a name mid-sentence in `font-medium` — "imported by **maya**",
     "Built with **Claude Code** by **maya**". `TextRun = string | { b }` is
     what carries that; a plain string silently drops it, and the tests
     caught exactly that.
   - **Block ORDER is the contract.** Conflict → checks → platform
     variables is what a reader scanning a blocked proposal reads top to
     bottom. Three separate fields let the component reorder them (the
     first cut did); a tagged `DetailBlock[]` cannot.

   **A publish that repaints can re-enter its own loader.** `_renderTopicHead`
   calls `_loadVoteRoster` on every paint — it always did, harmlessly, because
   the roster was written straight into a `#dev-vote-roster-N` node. Publishing
   the answer means REPAINTING, so the same line became fetch → publish →
   paint → fetch, a microtask loop that pegged a CPU core the moment a
   proposal topic opened. The load is guarded (one in-flight per session, and
   a cache), and the cache entry is dropped where the DATA changes —
   navigation and `refreshDevData` — not where the paint happens. **Any
   loader a converted renderer kicks off per paint has this shape**; check
   for it before publishing, because a test that renders in a vm resolves its
   stubbed `fetch` instantly and simply hangs.

   It had a second instance, and that one reached the platform. The shared-chat
   transcript's loader repainted the head unconditionally to swap the collapsed
   label ("Read the dev chat (9 messages)") for the expanded one, and
   `_renderTopicHead` calls it on every paint of an EXPANDED transcript. The
   first pass survives — it awaits its fetch, which unwinds the stack; the pass
   after it finds the cache, stays SYNCHRONOUS, and recurses until the stack
   overflows. Five console errors on load of every `/dev/shared/<id>` page,
   where `_renderTopicSubView` sets `_transcriptOpen` so the section arrives
   already open. Probing proposal topics and collapsed transcripts — which is
   what the chunk's own browser pass did — never reached it.

   So the rule is worth stating without the microtask detail: **a loader a
   renderer calls per paint must not unconditionally re-enter that renderer.**
   The roster guards with an in-flight set plus a cache; the transcript
   repaints only when the label it exists to swap has actually CHANGED.
   `tests/topic-head-loader-reentry.test.js` states it for both, and a
   renderer spy that counts its own calls is how a regression reports a number
   instead of a `RangeError` from inside the harness.

   **What stayed another owner's**, and why each is not a regression:

   - an issue's body and a proposal's summary — `DevChat.renderMarkdown`'s
     output, sanitised where it is built, rendered through
     `dangerouslySetInnerHTML` from a string the model carries.
   - the before/after tiles — `AppView.visualsTilesHtml`, which four other
     surfaces still call, so it stays a string builder.
   - `#dev-issue-comments` and `[data-transcript-body]` — genuine controller
     hosts, rendered once, empty, with a constant className.

   `cardPreviewHtml` went away with them: the string twin of the card's
   `Preview` existed only for `_detailActionsHtml`, and the head renders the
   labelled variant from the same `_cardPreviewSpec` truth table now, so the
   affordance has exactly one renderer again. Its two eye glyphs moved to
   `icons.tsx`.

   **The three body-mounted modals converted last**, as one chunk:
   `#auto-session-modal` (Generate proposal), `#credit-options-modal` (out
   of credits) and `#llm-consent-modal` (an app asking for AI access). They
   were three hand-transcribed copies of one dialog — scrim, centring
   wrapper, white/zinc-900 card, two-button footer — and the footer is where
   the reskin lands: an OUTLINED secondary on a floating card, which the
   widget language never draws, became `<Button variant="neutral"
   ink="neutral">`. They keep the body-mounted floating-host seam: the
   module still creates the scrim, owns its `hidden` and its dismissal, and
   removes it; React owns only the children.

   Three things in that chunk generalise:

   - **A dialog that RESOLVES needs its buttons to dispatch by name.** The
     promise lives in the module, so the card calls
     `AppView._autoSessionConfirm(id)` / `_llmConsentAllow()` and the module
     holds the settler. Same shape as a card's `{ fn, args }`.
   - **Validation is not view state.** The consent dialog's three checks
     decide what the promise resolves with, so they stayed in the module and
     `#llm-consent-error` is a controller host — rendered once, empty and
     `hidden`, exactly as it shipped.
   - **A caption driven by a `change` listener becomes per-option data.**
     `#auto-session-model-note` was rewritten by a handler; each option
     carries its own resolved `note`/`noteTitle` now and the selection is
     `useState`. The `<select>` stays uncontrolled.

   `CreditOptions.cardHtml` is still another module's markup, rendered
   through `dangerouslySetInnerHTML` from a string the model carries, and
   `CreditOptions.wire` only adds a delegated listener — so that seam needs
   no ownership-audit exception, and neither does the error line above
   (`textContent` and `classList` are not patched APIs).

   **And the App tab's placeholder states**, the five things `#app-content`
   shows when there is no running app to frame: spinning up, awaiting
   secrets, failed to start, not available, and offline-with-no-app-worker.
   They were five `innerHTML` strings plus two buttons bound by id
   afterwards — the branch re-renders on every status change, so a delegated
   listener would have re-attached — and they are one `AppStatusView` and one
   component now (`features/app-frame/app-status.tsx`).

   Two things about that host are worth carrying forward:

   - **`#app-content` is SHARED and single-owner anyway**, at the boundary
     rather than at a node inside it: every path into it runs
     `_teardownDevRoots()` first, exactly as `AdminConsole._renderSection`
     tears the previous section down. The audit entry is scoped with
     `when: '#app/recipebot/app'` for that reason; unscoped it would report
     every sibling surface's writes.
   - **There is NO string twin, deliberately.** `_appFrameDom` has one
     because the frame's element IDENTITY has to be assertable in Node; a
     placeholder is pure markup from data, so a second renderer would only
     be a copy to drift. `tests/app-frame-identity.test.js` holds the real
     store and asserts on the published view instead of on `innerHTML` —
     which is the general answer whenever a node-side harness is the reason
     a conversion looks blocked.

   `_teardownDevRoots` grew two lines with those chunks, and both are the
   same lesson: **a portal sweep does not clean up what is not a portal.** A
   body-mounted dialog's SCRIM is the module's, so `unmountAll` would have
   emptied its card and left an opaque overlay with no way out; and the
   placeholder's store would still have held the view its swept portal was
   rendering. The helper dismisses the dialogs and clears the store.

   What is LEFT on this screen is `showLaunchCoverShot` — deliberately, it is
   the one launch surface with no app behind it and `_launchCoverHtml` has
   four other callers — and `renderDevChatTab`'s `#dc-view`, which belongs to
   the Dev chat below.

2. **Dev chat — `frontend/src/features/dev-chat/dev-chat.js`, about 9,700
   lines. Started at the composer, finished at the screen.** It is DONE:

   | converted | host |
   | --- | --- |
   | the pending-upload strip | `#dc-attachments` |
   | the credit meter | `#dc-budget` |
   | the quick-reply pills | `#dc-quick-replies` |
   | the "Run on" controls | `#dc-runner` |
   | the app's session list | `#dc-session-list` |
   | **the session header strip** | `#dc-session-header` |
   | **the four banners** | `#dc-banners` |
   | **the transcript** | `#dc-messages` |
   | **the whole composer** | `#dc-composer-bar` |
   | **the whole screen** | `#dc-view` |

   ONE entry covers all ten in the ownership audit's `OWNED`. Each conversion
   absorbed the ones inside it — the composer took four strips, the screen
   took the composer and four more — so `{ sel: '#dc-view', except:
   ['#dc-spec-viewer', '#dc-staging-panel'] }` is the whole dev chat. It
   reports **0 legacy writes**.

   ### Two orphaned surfaces, and what to do with each

   The sweeps found two whole screens in here with no way to reach them.
   They are not the same case and were NOT treated the same way — the
   difference is worth having:

   - **`renderActiveSessions` is RETIRED.** Its hosts, `#dc-active-list`
     and `#dc-active-counter`, exist in NO markup anywhere in the tree, so
     the renderer resolved nothing and returned on its first line
     unconditionally, and `startActiveSessionsPoll` — a 5s cross-app poll —
     had no caller at all. That is a mechanical artifact, and
     `tests/nav-new-tab.test.js` was pinning a modifier-click contract for
     rows nobody could see. `loadActiveSessions` STAYS: five callers
     depend on it and its real job is seeding `SessionState` with the
     per-row busy flags the payload carries. The `.dc-active-*` rules in
     `app.css` are now orphaned too — left in place deliberately, because
     `tests/ios-native-performance.test.js` pins two of them as part of a
     native motion contract that cannot be verified from a browser.
   - **`renderSessionList` CONVERTED, and stays.** Its host is real markup
     — `renderChatView` writes it — but the branch that writes it runs only
     when the chat is open with `currentSession` null, and no route reaches
     that: `renderDevChatTab` bounces to the forum without a session id, the
     back control navigates to the forum, and the bare
     `#app/…/dev/sessions` route renders nothing. Verified in a browser with
     a counter around `renderChatView`, not inferred. **Deleting a product
     screen is not a migration's call to make**, so it converted like any
     other region and the finding is recorded here instead. Its dark-only
     tokens (`text-zinc-300` titles on `hover:bg-zinc-800/50`) were paired
     while converting: if the screen does come back it is legible in light
     mode, which it was not.

   The general rule the pair suggests: **a renderer whose HOST does not
   exist is dead and goes; a renderer whose host exists behind an
   unreachable branch is a product question and gets flagged.**

   ### What is left, and the one trap already found in it

   Two big renderers and a handful of small ones:

   - **`renderChatView`** (~420 lines) — **its header strip and its four
     banners are done**, and so is the COMPOSER (see below); what is left is
     the launchpad slot and the panes. (`renderMessages`, the other big
     renderer, is done too.)

     The strip was the natural first boundary and it carried three traps,
     all three of which generalise:

     - **A declared check can pin a POSITION, not just a node.** `dapp.json`
       selects the venue button as
       `#dc-session-header > button#dc-venue-select … :last-child` — a DIRECT
       child, and the last one. `BuildVenues.selectorHtml` built it as a
       string, and there is no way to feed a string into a component and keep
       it a direct child: a `dangerouslySetInnerHTML` wrapper becomes the
       direct child and the button a grandchild. So the button is JSX built
       from the `BuildVenues.venue()` spec that builder read, and
       `selectorHtml` is RETIRED. Its assertions did not go with it — they
       split: the venue LOOKUP is still asserted against build-venues.js, the
       MARKUP against the component.
     - **A mid-stream in-place patch becomes a scoped publish.**
       `_patchHeaderStatusPill` wrote `#dc-status-pill.innerHTML` precisely so
       a full `renderChatView` would not throw away a live message stream. Now
       that the strip is its own portal, republishing it re-renders the header
       ALONE — so it is `_repaintSessionHeader()`, and the pill is
       `MergeStatus.lifecycle`'s DESCRIPTOR travelling as data with the
       component drawing it, rather than `pillHtml`'s string.
     - **Converting one writer can expose a second.** `_setStreamingUI` also
       set `#dc-venue-select.disabled` in place. Harmless beside a string
       renderer; beside a rendered `disabled` it is a write React would
       clobber on its next paint. It republishes now. **After converting a
       host, grep for every in-place write to the ATTRIBUTES its children
       render, not just for `innerHTML`.**

     The header ELEMENT stays the module's, and for a different reason from
     the composer's four strips: `PlatformUI.attachScreenFx` writes a
     hairline/blur class onto it once the chat scrolls. Its one reader that
     went through a child — `getElementById('dc-back')?.closest('div')` —
     now names the element directly, because reaching a host through a child
     the portal owns depends on the portal having mounted.

     **The four banners went next**, as one chunk — not because they are
     similar (the sync banner is about the branch, the credits pair about
     money) but because they shared ONE slot and three copies of the same
     in-place dance. Each `_apply*Banner` read the live element, swapped its
     `outerHTML` when there was still something to say, `remove()`d it when
     there was not, and `insertAdjacentHTML`'d it back before
     `.dc-session-body` when it had to reappear; `_applySyncBanner` could not
     even do that last part and fell through to a whole `renderChatView` —
     rebuilding the transcript to make a strip appear. All of it exists for
     one reason, that a banner must change mid-session without disturbing an
     in-flight stream, and a store does that by construction.

     Three things from it generalise:

     - **`display: contents` is the answer when a host would change the box
       tree.** `#dc-view` is a flex column and the four banners were its
       direct flex children; a plain wrapper would have taken their place and
       made them block children of it — a different layout for the same
       markup, with nothing to fail. `#dc-banners` carries Tailwind's
       `contents`, so it generates no box. Same trick for the
       `CreditOptions.bannerActionsHtml` sink inside the credits banners,
       which a declared check selects into.
     - **Four templates that drifted become one shape.** The credits pair is
       one banner in two tenses, and its red half had three reasons (locked /
       unavailable / exhausted) written as three more templates. One
       `CreditsBannerView` with a tone, an icon NAME, a bold lead, an optional
       `[data-credits-reset]` sentence and a tail covers all four.
     - **Converting a renderer surfaces the in-place writes around it.**
       `startNewChange` set `btn.disabled` and `btn.textContent` by id — fine
       beside a string renderer, a write React clobbers on its next paint
       beside a rendered `disabled`. It is a published `pending` flag now.
       Same lesson as `#dc-venue-select.disabled` in the header chunk, and
       worth the grep every time: **after converting a host, look for
       in-place writes to the ATTRIBUTES its children render, not just for
       `innerHTML`.**

     Two shell rules bite on any chunk that brings new markup, and both are
     worth knowing before writing it rather than after the suite says so:
     `tests/shell-icon-set.test.js` forbids inline `d="M…"` in a feature file
     (the five banner glyphs became exports in
     `@/components/ui/icons.tsx`, and the ones that cannot prerender go in
     that file's expected-absent list with a reason), and
     `tests/shell-primitive-adoption.test.js` forbids a hand-written
     `bg-violet-600` button (the new-change button routes through `<Button>`;
     its cva table needed one new `disabledStyle` value, and the result is
     byte-identical, attribute order included). The sync banner's amber button
     stays hand-written on purpose — a warning strip's button is not the
     primary action's fill, and an amber `variant` would be a value invented
     for one call site in a table whose discipline is that every value is
     transcribed from a button that already exists.
   - ~~**`renderChatView`'s skeleton**~~ — **done, and it was the last string
     in the file.** `#dc-view`'s children: the session header, the four
     banners, the pane frame, the launchpad slot, the transcript, the
     composer, the two resizers, the two side panes, and (on the other
     branch) the app's session list.

     **A conversion ABSORBS the islands inside it, and this is the second
     time in two chunks.** The five regions listed above were portal hosts
     that this template wrote; once the skeleton is a component they are
     ordinary children, so their `mount*` bridge methods go and only
     `publish*` crosses the seam. The composer had already done the same for
     its four strips. What is left in `mount.ts` is ONE mount and eleven
     publishes, which is the shape the whole screen should have had.

     **The prize is what a re-render costs.** `renderChatView` runs on every
     3s status poll and used to assign `#dc-view.innerHTML` — destroying the
     transcript, the composer, every listener bound on them and whatever the
     user had typed. So much of dev-chat.js is written to SURVIVE that:
     `_restoreDraft`, `restoreSessionScroll`, the re-binding of every
     delegated click, `_maybeOpenShotOptions`' remembered-open latch. Mounting
     the same host twice is a reconcile, and a browser probe confirms it —
     after a full `renderChatView()` the transcript's row nodes are the same
     objects, the textarea is the same node with its typed value intact, and
     the scroller keeps its position.

     Three hosts inside it stay legacy-owned, and the reasons are all
     different, which is worth having as a set:

     - `#dc-spec-viewer` is a genuine CONTROLLER HOST — `_renderSpecViewer`
       fills it, and that renderer is not in this chunk.
     - `#dc-staging-panel` is a SLOT, not a container: the docked preview is
       an overlay positioned over its rect, and a `ResizeObserver` watches
       it. It renders empty and stays empty.
     - `#dc-session-header` renders its own children, but its `className` is
       a CONSTANT LITERAL because `PlatformUI.attachScreenFx` writes a
       hairline class onto that node once the chat scrolls. React never
       rewrites a className whose prop has not changed — the probe shows
       `platform-chat-header` surviving a full repaint — and an expression
       there would have dropped it.

     Two more things from it:

     - **A second author can be in another module, and this one was three
       lines long.** `public/js/app-view.js` prepended #194's one-shot
       "what a proposal is" hint with `insertAdjacentHTML('afterbegin')`,
       directly in front of the subtree React reconciles. It is a `hidden`-
       style FIELD now, latched by the render that shows it and cleared by
       the next one, which is exactly what the innerHTML write did to the
       node. Third instance of the sweep lesson, and the second one outside
       the module being converted.
     - **A conditional class run must be two complete literals.** The
       composer bar drops its border and padding in a launchpad but keeps
       the safe-area inset, and that was
       `class="… ${barEmpty ? '' : 'border-t …'}"`. Tailwind's extractor is
       a regex over source text, so the model carries a BOOLEAN and the
       component holds both strings whole.

     `_repaintDevFlow` shrank to three lines because of it. #1281's swap has
     two halves — the launchpad slot's markup and the composer's `hidden` —
     and they were baked into one innerHTML string, so changing which one was
     on screen meant a whole `renderChatView`. Both are publishes reading the
     same predicate now, so they cannot disagree and neither needs the
     transcript thrown away to land.

   - ~~**the composer**~~ — **done.** `#dc-composer-bar`'s children: the venue
     sentence, the two provider model controls, the saved drafts, the attach
     row, the pending strip, the error line, the form and the shortcut hint.

     **It looked like six independent controls and was one state.** Six
     writers reached into the bar, and every one of them was reading the same
     two questions — is a turn running, and where is this session built:
     `_setStreamingUI` (the send button's `disabled`, three state classes,
     `aria-label`, `title` and `innerHTML`; the field's `placeholder`; the
     OpenRouter row's `disabled`), `_syncSaveDraftBtn` (three more, plus
     `_syncShortcutHint`, whose only caller it was), `_renderSavedDrafts`,
     `_setAttachError` and `_refreshModelSelect`. Six stores would have been
     six copies of "is the chat busy"; one publish answers it once. **When
     several writers into one region are all reading the same predicate, that
     region is one chunk, however unrelated the controls look.**

     Four things worth copying:

     - **A converted region can ABSORB the islands inside it.**
       `#dc-attachments`, `#dc-quick-replies`, `#dc-runner` and `#dc-budget`
       were four portal hosts written by this template. Once the composer owns
       the markup they are ordinary children, so their `mount*` bridge methods
       went and only `publish*` crossed the seam. Each store's component grew
       a `*Bar` sibling that renders the ELEMENT as well as its contents —
       exactly the split `pending-strip.tsx` already had — which also folds
       away the two hand-toggled `*-active` classes: the class now comes from
       the same list that draws the rows, so there is one answer to "is this
       strip empty" instead of two that could disagree.
     - **A paint flag is not `isStreaming`.** `_setStreamingUI(true, …)` is
       called by the `?shot=busy` capture with no turn running at all (#801),
       and by the finish path with `false` on the line before the flag drops.
       The composer latches its own `_composerBusy` for that reason, and
       `renderChatView` resets it — which is what the idle template used to do
       implicitly.
     - **A cleared-per-render input has to be LATCHED for the publish era.**
       The venue-fallback sentence is reported once and then cleared, so a
       repaint does not re-explain a settled fact. Reading it inside
       `_composerView` would have cleared it on the first keystroke — the save
       icon and the hint republish on every one. It is latched into
       `_venueNoteForRender` by the render that shows it.
     - **The field stays UNCONTROLLED, and that is a rule with two authors
       behind it.** `_restoreDraft` and `_editSavedDraft` set `.value`;
       `_setupTextareaResize` grows `style.height` on every keystroke. Neither
       is rendered as a prop, so React never diffs them away — the same
       tolerated overlap the group chat's composer documents. Verified in a
       browser: the node survives a streaming repaint with its value and its
       grown height intact.

     Two shell rules bit, both predictable from the banner chunk's note:
     `tests/shell-primitive-adoption.test.js` forced the send button and the
     textarea through `<Button>` and `<Textarea>`, and the rendered class
     attribute did NOT move — `button.tsx` gained a `lead` group (the same
     group, for the same reason, that `input.tsx` already had: an app.css
     class that LEADS the string, where className cannot go) carrying
     `.dc-send-btn`, and `input.tsx` gained a `devComposer` lead and box. And
     `tests/shell-icon-set.test.js` forced the paperclip, the save floppy and
     the three draft-row actions into `icons.tsx`. Their FRAME is normalised
     onto the existing `stroked` factory — the templates put
     `stroke-linecap` on the `<svg>`, the factory puts it on each `<path>`;
     both inherit, and a fourth renderer to hold five glyphs' attribute
     placement is not worth it. None of the five prerenders, so all five are
     in that test's expected-absent list with the reason.

   - ~~**`renderMessages`**~~ — **done.** The transcript was one 560-line
     `container.innerHTML = …` with SIX writers on top of it, each of which
     existed because a full repaint mid-turn was too expensive: the streaming
     bubble at up to 60fps, `_patchProgressDom`/`_patchProgressSummary` on the
     log `<pre>` and four sibling spans, `_applyEstimate`/`_clearEstimate` on
     `.dc-cc-estimate`, `_tickElapsed` walking three `data-*` anchors once a
     second, `_syncActivityNode` appending and removing `#dc-spinner`, and one
     more in a different file entirely (see below).
     Every one of them is a publish now, because a republish IS the cheap
     repaint they were all working around — React touches the one node whose
     text changed.

     The design note that was written here beforehand — "the streaming bubble
     has to stay a controller host" — turned out to be **wrong, and instructive
     about why**. The premise was right (publishing 60fps through the
     transcript store would re-render every row) but the conclusion did not
     follow: the fix is a SECOND store that exactly one row subscribes to.
     `streamStore` carries one `{ key, html }`, the model marks the last
     conversational row `live` for the duration of a turn, and only that row
     renders the component that reads it. Keeping `.dc-msg-content` a
     controller host would in fact have been HARDER: React would have to
     render no children for a streaming row and `dangerouslySetInnerHTML` for
     a sealed one, and the transition INTO streaming — which happens whenever
     a status row arrives mid-turn — blanks the node until the next token.

     Six things from it generalise:

     - **Split the store by WRITE FREQUENCY, not by region.** Two stores for
       one host is right when one field changes per frame and the rest change
       per event. Same shape as the Dev card's `cardNowStore`.
     - **A ticking span should DERIVE, not be written to.** Three
       `textContent` passes over `#dc-messages` became one `nowStore` publish
       on the 1s heartbeat, with each row re-deriving its own label. The
       `data-elapsed-since` / `data-countdown-to` / `data-cohort-since`
       anchors stay in the markup anyway, because `_syncElapsedTicker` still
       reads them to decide whether the heartbeat needs to run at all — the
       gate is a DOM question, and it is the honest one.
     - **A "clear it now rather than wait for a render" writer is the same
       trade, and gets the same answer.** `_clearEstimate` blanked every
       `.dc-cc-estimate` by selector for exactly the reason
       `_patchProgressDom` patched by persist-id. That one was found by a
       test guard, not by the innerHTML grep, because it lives 700 lines from
       the renderer. **Grep for the CLASS NAMES the component renders, not
       only for the host id.**
     - **In-flight button state is the model's, and this time it was a bug.**
       `promotePR` set `btn.disabled` + `btn.innerHTML` on the button the
       click arrived on, and `renderMessages` runs on every 3s status poll —
       so a repaint mid-request would have restored the label AND cleared the
       re-entry guard, which is the double-submit #558 exists to stop. Third
       instance of the same lesson (`#dc-venue-select.disabled`, the
       new-change button, this) and the first where the in-place write was
       load-bearing rather than cosmetic.
     - **A writer can live in a module you were not converting.**
       `public/js/app.js`'s `mayor_reasoning` WS branch called
       `_renderStreamingMarkdown(el, …)` with a node it had resolved as
       `querySelectorAll('#dc-messages .dc-msg-assistant .dc-msg-content')
       [length - 1]` — the sixth writer, in a different file, found only by a
       repo-wide grep for the CLASS NAMES rather than for the host. It takes
       the MESSAGE now, like the two call sites inside dev-chat.js. Reading
       those three together also exposed a latent bug in the old shape: the
       model SKIPS an assistant row with no content, so the resumable-SSE
       `token` path — which pushed an empty placeholder, rendered, and only
       then appended — left "the last content node on the page" pointing at
       the PREVIOUS turn's bubble. That path now appends first and lets the
       fresh bubble arrive through a render, matching the POST-SSE path.
     - **A ref is not "after every render".** `_wireCreditsCards` and
       `_wireDevFlowCard` hand two FOREIGN cards to their own modules'
       idempotent `wire()`. A `useCallback` ref on a stable wrapper fires once
       per MOUNT, so a card that appears in a later publish would go unwired —
       the #1304 failure. They stayed three unconditional calls at the end of
       `renderMessages`, which works because `transcriptStore` flushes
       synchronously. `_bindDevFlowVisibility` in particular must not be gated
       on the walkthrough rendering here: in a hand-off venue it renders in the
       composer's place, and that path wires the card but not the re-check.

     Two markup details worth copying. **Order is part of the contract even
     inside one line**: the elapsed suffix sits BETWEEN the phase label and the
     AI guess in the coding-run summary, so it renders inside `ProgressSpans`
     rather than beside it — hoisting it to the component that owns the row
     put it after the cohort hint, which nothing but a reading of the old
     template would have caught. And **`data-default-open` belongs on the
     `dc-cc-attached` family alone**, because that is where `_ccOpenAttrs` put
     it; nothing reads it any more, and adding it to the four disclosures that
     never carried it is markup a conversion is not entitled to change.

     One finding from the browser pass, recorded rather than acted on:
     **`devFlowHtml` is always `''` on the current venue set.** The transcript
     asks for it as `_launchpadVenue() ? '' : _devFlowHtml()`, and
     `_devFlowTarget` answers non-null for exactly `web-claude-code` /
     `web-codex` — both of which `Launchpad.isLaunchpad` also claims, so the
     walkthrough only ever renders in the composer's place. Preserved verbatim
     (it predates this chunk, and which venues show a launchpad is a product
     question), but it means the in-transcript branch is unreachable today and
     could not be exercised in a browser.

     The tests that drove `renderMessages` through a fake `innerHTML` setter
     — seven files — go through `tests/lib/dev-transcript-html.js` now, the
     same shape as `tests/lib/dev-card-html.js`: `renderMessages` is still
     what runs (it drains the pending estimate, pairs each progress log with
     its status line, decides which row is live) and the markup comes back
     from the real component. Three serialization differences show up in
     every such re-point and are worth expecting: React writes `open=""` not
     a bare `open`, `&#x27;` for an apostrophe in a text child, and its own
     attribute order.

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

   **The screen is done.** Every host it draws is React's, and what is left of
   `dev-chat.js` is the module it should always have been: the fetches, the
   streaming protocol, the session lifecycle, and eleven view builders that
   hand plain data across a bridge.

   TWO renderers survive in the file, and neither is part of this screen:

   - **`_renderSpecViewer`** fills `#dc-spec-viewer`, the shared-spec reader.
     It has its own share popover, its own suggestion list and its own
     version picker — one surface, and its own chunk when it comes.
   - **`_switchCurrentCodingAgent`'s dialog** builds a DETACHED overlay and
     appends it to `document.body`, which is the group chat's card-menu case:
     the node never enters a subtree React reconciles, so the ownership rule
     has nothing to say about it.

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
