# Hand-off: phone navigation drawer (Communities + Messages)

Reference material for the cloud session continuing this work. **Nothing under
`.handoff/` belongs in the proposal.** Read it, copy what you need to a scratch
directory, and build the proposal on a fresh branch cut from the base below, so
this commit is never uploaded.

## What Evan asked for

The phone design Evan picked on 17–18 Oct 2026 after a long mockup iteration:
phone 3, "Stack with changes", of the Homeroom Navigation Shortlist
(https://claude.ai/artifact/3w9swDnycFRYaf5AHCKXUn, version 10; its source is
`mockup/`: open `mockup/navigation-shortlist.html` in a browser, the third
phone). On 18 Oct he said "move on to making a proposal".

- **Phone only (< 768px). Desktop stays exactly as it is.** After the proposal
  is submitted, Evan wants to look *together* at what this design would mean at
  desktop width (change desktop too, or not). Explore only; no desktop changes
  in this proposal.
- Bottom tab bar stays.
- **Communities is a panning drawer with three levels**:
  0. the list of all your communities, at **85%** of the screen width, with a
     search at the top (focus widens it to the full width with a Cancel; Cancel
     or a pick narrows it again); the places layer peeks in at the right;
  1. the selected community's places (Hub, Needs you, Workshop, Channels:
     general, Topics), at **80%**, in the existing places-list styling; the page
     peeks in at the right;
  2. the place's page, full width.
- Each layer shows the next one peeking; tapping a peek goes there. The pan
  follows a finger; letting go past a quarter of the way lands on the next
  level. Back (header arrow) goes up one level.
- **Re-tapping the Communities tab goes back one level at a time** (page →
  places → communities), not all the way.
- Switching community from level 0 keeps the place you were on when the new
  community has it (Hub, Needs you, Workshop and #general are everywhere);
  otherwise it opens that community's Hub (topics vary per community).
- **Header motion tied to the drawer** (see `mockup/app.js`, `hmSet`):
  - The community colour (the existing community tint) blends in with depth:
    untinted at level 0, tinted at levels 1 and 2.
  - No back arrow at level 0 (it's the outermost level). The arrow fades in and
    slides in **from the right** (8px) going in; the reverse going back.
  - Titles: level 0 "Communities"; level 1 the community name alone; level 2
    the community name big with the page ("Workshop", "#general", "Hub"…) small
    under it.
  - Every title change moves the drawer's way: going in, the old title drifts
    left (−12px) as it fades and the new one arrives from the right (+24px)
    into its place beside the arrow; going back, the reverse.
  - Places ↔ page: the community name stays put (rising 7px to make room) and
    only the page name slides in horizontally from the right (it cancels the
    name's rise so it travels level), and back out to the right.
  - While dragging, all of it follows the finger (fractional depth); tab
    switches change the header at once. Reduced motion: crossfades in place.
- **Messages uses the same drawer**: level 0 the conversation list in the
  sidebar styling at 85% with the last open conversation peeking; level 1 the
  conversation, full width. In a conversation the header shows the
  conversation's name big and its subheader small ("Direct message",
  "3 members", "Builds what you ask for"…), with the back arrow, and the page
  no longer repeats that heading. Same title motion as Communities.
- Earlier decisions in the same review (already merged or filed, for context):
  #5383 (bar says Messages), #5384 (tray under the header), #5386 (tray close
  animation). Mockups never go into filed requests or PR text: words, exact
  copy and code pointers only.

## Defaults I (the previous session) took — tell Evan, he can override

- **Two proposals, Communities first.** (A) Communities drawer + header motion;
  (B) Messages drawer + conversation name in the header. Each is large; two
  votes are easier to review. Evan said "a proposal"; if he wants one, merge.
- **Level 0 reuses today's Communities list content** (Needs-you row, Public
  communities / Private communities / Just you sections with Show more, Join /
  Start), plus the new search at the top, rather than the mockup's illustrative
  "Waiting on your vote / Recent / More" sections. Same content as desktop and
  as the full-screen `#workshop-screen`; search filters communities by name.
- On the project page, the left-edge swipe (24px, as the tray has today) starts
  the pan from level 2; on levels 0/1 the whole drawer pans. Not every
  horizontal drag on a page (pages have horizontal scrollers and swipe-to-vote).
  Edge swipe stays off in iOS Safari (browser Back), as today.
- The hold-the-Communities-tab switcher stays as it is.

## Base and workflow

- App `usernode-2d5619`, canonical repo Usernode-Labs/social-vibecoding.
- **Base commit `0a2083e67b2a137914f8b0ca91c0ca6383bc26a3`** (Homeroom
  `get_checkout_status` verdict `current` on 18 Oct). Re-check with
  `get_checkout_status`; if main moved, use the commit Homeroom reports.
- `git switch -c proposal/nav-drawer-communities 0a2083e67b2a137914f8b0ca91c0ca6383bc26a3`
- Native proposal lifecycle (`.agents/skills/usernode-proposal/SKILL.md`):
  implement and test FIRST, then `proposal_start` and `proposal_push_commit`
  back-to-back (an empty draft can wedge with `branch_moved` if main moves),
  then `proposal_submit_build`. **Never promote without Evan's explicit OK in
  chat.** The CLI starts a device login when it has no credential: Evan
  approves it in a browser (he can do it from his phone). Never copy
  credentials around.
- The `proposal_*` tools may not be registered as MCP tools in a session. They
  worked by spawning the repo CLI's MCP server over stdio
  (`node tools/social-vibecoding mcp --profile production`) and calling it with
  `@modelcontextprotocol/sdk`'s `Client` + `StdioClientTransport`; payloads are
  in `result.structuredContent.body`. `proposal_push_commit` returns
  `host_execution_required` with an exact argv: run it as is. Upload limits:
  one single-parent non-merge commit per upload, ≤ 200 changed paths, ≤ 8 MiB.
- Tests: `npm run test:changed -- --base <base>`; full `npm test` only when
  shared code moved. Declared checks (dapp.json, 734 of a cap of 860) run at
  **1280×800 only**, so phone-only UI is not covered by them; keep all desktop
  markup like-for-like. Never refresh `tests/baselines/shell-markup.json` to go
  green: record deliberate id changes in `ADDED_IDS` / `RETIRED_IDS` with a
  reason (`tests/shell-id-inventory.test.js`).
- Visual evidence: phone stories are real (any declared viewport < 768px wide
  replays as a touch iPhone, `docs/proposal-visuals/before-after-shots.md`,
  "Phone screens"); declare 390×844 stories. If staging truly can't reach a
  state, `impact: none` with the reason is acceptable to Evan.

## iOS / motion rules that matter here (measured)

- Animate **transform and opacity only**; no `transition-delay` / WAAPI delay
  (either keeps WebKit from compositing it). Width/left transitions freeze
  during a busy main thread. Gate heavy work (a route swap) after the slide's
  `animation.ready` + one rAF (cap ~120ms) — `tab-press.ts` `schedulePress` is
  the in-repo pattern.
- **Fixed elements need an untransformed ancestor chain** (tab bar, faked-glass
  `::before`, app.css 21385-21447). Translating `#app-view` while the drawer is
  open will re-anchor fixed descendants to it: remove the transform entirely
  (not `translateX(0)`) at rest on level 2.
- Policy "no page slides on the phone" (`PlatformUI.phoneMotion`,
  `tests/phone-no-page-slides.test.js`, #2896/#2775) is about route
  push/pop; the drawer is a gesture surface, not a page slide — say so in the
  spec and keep that test meaningful (add the drawer as a stated exception if
  the test needs it).

## Code map at the base (file:line)

### Communities today
- **Two separate screens.** The list is `#workshop-screen`, React,
  `frontend/src/features/workshop/index.tsx` `WorkshopScreen` 457-696 (mounted
  Shell.tsx:205). The project page is `#app-view` (`AppViewIsland`,
  Shell.tsx:430) → `AppView.renderDevView` (public/js/app-view.js:4483) →
  `#dev-workshop` → `DevWorkshop`
  (`frontend/src/features/dev-board/workshop/workshop.tsx` 4107-5420).
  Moving between them is a router screen swap (`App.navigateToWorkshop`
  app.js:7227-7256 vs `App.navigateToApp(slug,'dev')`).
- List data: `workshopController` (index.tsx 791-941, bridge
  `window.UsernodeReact.workshop` 943-947): `/api/apps?scope=joined`,
  `/api/workshop/counts`, `/api/workshop/needs-feed`, re-read every 30s while
  open; store `features/workshop/workshop-store.js`. Sections:
  `features/workshop/sections.ts` 40-44; rows `AppRow` 313-370 (tap calls
  `AppView._landOnHub(slug)` then `App.navigateToApp(slug,'dev')`, 330-337).
  Needs-you row 545-569 opens `[data-workshop-pane="needs"]` (657-692,
  `NeedsReel` with swipe-to-vote). No search today.
- **Places are React state in `DevWorkshop`**, not in the URL:
  `const [tab, setTab] = useState(() => freshTab() || v.tab || 'status')` 4167;
  `openTab` 4190-4198; keys `WORKSHOP_TABS` app-view.js:11023
  (`status` = Hub, `discussion` = #general, `workshop`, `needs`, `all`, `plan`,
  `bot`) plus channels `c:<handle>` (`WORKSHOP_CHANNEL_RE` 11030);
  `_landOnHub` 11332, `_landOnTab(slug, tab)` 11461-11468 (dispatches
  `usernode:workshop-tab`), Back/Forward via `history.state.__unProjectTab`
  (11355-11437; router `_routeFromHash` app.js:4308-4330). Canonical address
  `/app/<slug>/workshop`, `?ws=<key>` deep-links a place (`placeHref`
  places.ts:138-144).
- **Places tray (phone)**: `places-tray.tsx` (`PlacesTray`, `useEdgeSwipe`
  80-106, `EDGE_PX=24`, `SWIPE_PX=48`, `edgeSwipeAllowed` 54-58),
  `project-places.tsx` (`ProjectPlaces`, rows `placeRows` 58-76),
  `place-bar.tsx` (`PlaceBar`, `PlacesButton`, `HeaderPlace` 118-134,
  `HeaderPlaceName`, `usePhoneHeader` 91-102), `place-store.ts`
  (`publishPlace`, `openPlace`, `registerPlaceOpener`, `toggleTray`),
  `places.ts`. Wiring in workshop.tsx 4509-4661 (`trayOpen`, `choosePlace`
  4607-4612, `publishPlace(...)` 4540). CSS app.css 19102-19246 (tray
  `.dev-ws-tray-root` fixed under the header, z-index 60).
- **Desktop** (≥ 768px): 76px strip + 264px `#platform-section-column`
  (`features/nav/section-column.tsx`, shows `ProjectPlaces` when on a project
  page). Leave untouched.
- **Header** (`features/header/platform-header.tsx`, React island):
  `#back-btn` 507-542 (click bound by app.js 4227-4255 → navigation),
  `HeaderPlace` 554 (phone places button), `HeaderTitle`
  (`header-title.tsx`: `#header-scope-switch` "Communities ⌄" on
  `#workshop-screen` 179-194; `#header-app-switch` tile + name + ⌄ on a
  project page 201-238; `#header-subtitle` inline 252-266). Title/back come
  from `App.setHeaderTitle` (app.js:8803) / `App.setBackIcon` (8715) via
  stores; `_BACK_SLOT` 8591-8604. Tint: `community-tint.ts`
  `useCommunityHeaderTint` 32-60 sets `--community-tint` +
  `data-community-tint` on `<html>`; CSS app.css 18911-18949 (`--brand-*` go
  white on the tint). Header height `--platform-header-h: 3.25rem`
  (`tests/header-height-parity.test.js`). Native iOS back swipe is enabled only
  when the header shows an arrow with an href (`native-back-navigation.ts`
  24-30) — a drawer back control should NOT be an href'd `#back-btn`, or
  WebKit's history swipe will fight the pan.
- **Tab bar** (`features/nav/tab-bar.tsx`): `onTabClick` 823-847; lit
  Communities → `pressLitTab(screen)` (`features/workshop/tab-ladder.ts`
  191-226, `rungFor` 69, `registerLevel` 97); hold → switcher
  (`createSwitcherHold` 366, phone only). Lit Messages has no handler.
  Tests pinning these: `communities-tab-ladder.test.js` (300 pins the lit
  branch), `nav-tab-bar.test.js`, `desktop-chrome-transitions.test.js` (no
  `setTimeout` in tab-bar.tsx).

### Messages today
- One screen, `#messages-screen` (`frontend/src/features/messages/index.tsx`
  `MessagesScreen` 2700-2791): `.messages-layout` holds `ConversationList`
  (836-1207, root `section.messages-list-pane` 1050, `hidden md:flex` when a
  conversation is open) and `ConversationThread` (1853-2290,
  `section.messages-thread-pane…` 2220; `ThreadHeader` 1307-1433 is the
  in-page heading with name + `.messages-thread-sub`; strings EN
  messages.json 3022-3059). Router app.js:5186-5276 →
  `navigateToMessages` 7622-7657; store `route()` store.ts:812-873.
- **The store forgets the open conversation on `route(null)`**
  (`publish({active:null, messages:[]})` store.ts:870) — the peek needs a
  remembered last conversation kept rendered (non-interactive) on phones.
- Header in a conversation: `syncChrome` store.ts:1162-1206 sets title
  "Messages" + arrow to `#messages` (pinned by
  `tests/messages-request-pending.test.js:189-198`). The subtitle exists in
  `headerTitleStore` but renders inline beside the name.
- Agent chats / agent sessions / dev sessions open on **separate screens** on
  phones (router rewrites, app.js:5209-5235); they are outside the drawer.
- Desktop two-pane (≥ 768px, and the sidebar-column rules app.css
  22691-22771 keyed on `#messages-screen > .messages-layout >
  .messages-list-pane`): leave untouched.
- Tests at risk: `messages-screen`, `messages-agent-pane`,
  `messages-full-width`, `messages-request-pending`, `messages-inbox`,
  `messages-blank-closes`, `section-column`, `platform-safe-bottom`,
  `channel-back-to-hub`, `homeroom-discussion-in-place`. Declared checks at
  1280 select deep chains in `#messages-screen` (keep desktop DOM).

### Tests most at risk for the Communities proposal
`project-places`, `header-place`, `section-column`, `back-navigation-pages`,
`communities-tab-ladder`, `workshop-screen`, `workshop-scope-tabs`,
`project-page-opens-at-head`, `dev-workshop` (band/PlaceBar ~4576, `?ws=`
~5048, pinned strip 6340-6431), `header-back-home`, `channel-back-to-hub`,
`shell-id-inventory`, `island-boundary`, `phone-no-page-slides`.

### Shell conventions for a new island
`<Island name="X"><X /></Island>` in Shell.tsx (name = component); first render
equals the prerender (hidden/empty; data in effects); new prerendered ids go in
`ADDED_IDS`; classes legacy code also writes go through `useHiddenClass` /
`useClassToggle` (`frontend/src/lib/legacy-dom.ts`); screen visibility only via
`frontend/src/lib/visibility-store.ts`; new strings in
`frontend/locales/en/<ns>.json` as `{text, description}`; add any new
React-owned host to `OWNED` in `scripts/audit-react-ownership.mjs`. No shared
`useIsPhone` in `lib/` (pattern: start `false`, settle in an effect, like
`usePhoneHeader`).

## Suggested architecture for proposal A (my plan, not yet validated)

- A phone-only React island (e.g. `features/nav-drawer/`), fixed between the
  header's bottom edge and the tab bar, shown on the project page
  (`screen==='app-view'`, dev tab). It holds a strip with L0 (the communities
  list, sharing components with `WorkshopScreen`, plus search) and L1
  (`ProjectPlaces` for the current slug, without the Switch foot). A small
  store holds `depth` (0/1/2) and the live fractional depth while dragging.
- Strip offsets: L0 at 0 (85%), L1 at 85% (80%), page from 165%. The page
  (`#app-view`) is translated by (165% + strip offset) while depth < 2, with no
  transform at rest on level 2. A transparent catcher over the peek handles
  "tap the peek".
- Replace the phone tray with the drawer (`HeaderPlace` → a drawer back
  control; `HeaderPlaceName` pill → the two-line title), keep the tray for the
  desktop folded-column case. Re-tap Communities on phone → `go(depth-1)`.
- `pushDismissible` while depth < 2 so Android Back returns to the page.
- Header motion by CSS transitions on transform/opacity (tap) and direct style
  writes during a drag, driven by the drawer store from inside the header
  island (its own refs only).
