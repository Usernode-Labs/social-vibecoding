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
   lines. Started at the composer.** Five regions have converted:

   | converted | host |
   | --- | --- |
   | the pending-upload strip | `#dc-attachments` |
   | the credit meter | `#dc-budget` |
   | the quick-reply pills | `#dc-quick-replies` |
   | the "Run on" controls | `#dc-runner` |
   | **the app's session list** | `#dc-session-list` |

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

   - **`renderChatView`** (~420 lines) — the session header strip, four
     banners, the launchpad slot, the panes and the composer wrapper. The
     natural next chunk is the HEADER STRIP alone (`#dc-session-header`),
     which is a clean boundary, but **check the venue button before
     starting**: `dapp.json` selects
     `#dc-session-header > button#dc-venue-select … :last-child`, a DIRECT
     child and the last one, so `BuildVenues.selectorHtml`'s markup cannot
     go in through a wrapped `dangerouslySetInnerHTML` sink. Either render
     that button in React from a `BuildVenues.venue()` spec and retire
     `selectorHtml` (one production caller, two test files assert on the
     string), or leave the strip alone. The strip also carries two other
     seams: `#dc-status-pill`, which `_patchHeaderStatusPill` rewrites
     mid-stream ON PURPOSE so a live turn is not disturbed, and the header
     element itself, which `PlatformUI.attachScreenFx` writes classes to at
     runtime — so its `className` must stay constant.
   - **`renderMessages`** (~580 lines) — the transcript. The hard part is
     not the messages, it is `_writeStreamingHtml`: it assigns
     `el.innerHTML` on a bubble's content node at up to 60fps. Publishing
     that through a store would re-render the list every frame, so the
     streaming bubble has to stay a controller host the module keeps
     writing while React owns the finished messages. The group chat's
     transcript solved the same problem for `.gc-msg-content`; read that
     before designing this one.

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
