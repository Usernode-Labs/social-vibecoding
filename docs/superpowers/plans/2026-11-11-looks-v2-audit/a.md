# Audit, group a: Home, the header's sheets, Homeroom bot, and the chrome

Checkout read: `/Users/salah/Dev/lingash/sv-skins` (branch `redesign/skins-2026-11-11`). Paths below are
relative to it; `F/` stands for `frontend/src/features/`. Nothing was run in a browser: every statement about
what is drawn comes from reading source, the kit CSS and the suites.

Kit = `frontend/@/components/ui/kit.tsx`, kit CSS = `frontend/looks/kit.css` (compiled into `public/css/app.css`
by `scripts/build-looks-css.js`). v2's own additions to the kit CSS are in
`skins-tour-v2/tour-v2/kit.py` `KIT_CSS` (lines 107-153) and `screens_a.py` `CSS` (lines 7-56).

---

## s01-home, s02-home-full (one page; s02 is the same page scrolled)

**Files**
- Kit: `F/home/frame/home-frame.tsx` `HomeFrame` (165), mounted by `F/home/index.tsx` `HomeScreen` (159) as
  the first child of `#home-screen`; the standard body stays mounted and hidden
  (`app.css` 26973 `[data-frame-page] > :not(.fr)`).
- Standard: `F/home/index.tsx` (search bar 183-235, `#home-apps-section` 302, then `PinnedCommunities`,
  `WaitlistCard`, `VerifyCard`, `ChallengesSection`, `HomeJoin`), `app-grid.tsx` `AppGrid`, `apps-more.tsx`
  `AppsMore`, `create-tile.tsx` `CreateTile`/`CreateCompact`, `pinned-communities.tsx` `PinnedCommunities`
  (189), `home-join.tsx` `HomeJoin`, `communities-to-join.tsx` `CommunitiesToJoin` (44),
  `panels/sections.tsx` `ChallengesSection`, `home.js` (`Home.render`, `setEditing`, `setMembership`,
  `_appsExpanded`, `_wireSearch`).

**Today under a look** (the 10 Nov proposal, not today's Home)
1. Head: "Home", a sentence counting what needs you (`home:frame.purposeNeeds*`), button "Make a project".
2. Main column: Pinned apps (11 tiles + "All N" tile, link Edit) · Pinned communities as **rows** (6, pinned
   then joined, "N to vote" pill, link "All N") · Featured as picture cards (`PicCard`) · Communities to
   join as rows (4, a fake Join word, link "Browse all").
3. Side column, 400px, first on a phone: Needs you (3 rows from `/api/workshop/needs-feed` +
   `/api/workshop/bot-questions`) · Live this week (`/api/workshop/live-feed`) · Your week (`Facts`) · Season.
4. Below both columns: challenges as `ChallengeCard`s in one sideways row.

**Gap to v2**
- Head: purpose becomes one fixed sentence ("Your apps and your communities.", new id, e.g.
  `home:frame.purpose`); remove the `acts` button (`home:frame.make`).
- Add the search field under the head (kit `Search`, placeholder `home:search.placeholder`). Behaviour must
  be the standard field's: `Home._wireSearch` reads `#home-search-input` and `use-home-query.ts` listens for
  `input` on that id. Cheapest reuse: the kit field writes its value into the hidden `#home-search-input`
  and dispatches `input` (and a click on `#home-search-clear` to clear), then the kit page reads
  `gridStore` (`view: 'search'`, `items`, `resultsHeading`, `emptyQuery`, `notice`) and `useHomeQuery()` +
  `matchesQuery` exactly as `PinnedCommunities` (214-221) and `CommunitiesToJoin` (list filter, 66-72) do.
  Ctrl+K / `/` (`search-shortcut.ts`, installed at `home.js` 2202) and `Home.focusSearch()` (`home.js` ~395)
  focus the hidden input: point both at the kit field under a look.
- Remove from the page: Needs you rows, Live this week, Your week, Season (all of `side` today, 317-368),
  Featured `PicCard` row, the `below` challenge cards, and the reads that only they use
  (`needs-feed`, `bot-questions`, `counts`, `live-feed`, `MyStanding`).
- `PageBody`: drop `wide` and `sideFirst` (v2 is the tour's 720 + 320, side column after the main one on a
  phone); `side` = Next challenges only.
- Pinned apps (label `home:grid.heading`): keep tiles; links **Edit** (`home:edit.start`, shown under the
  standard rule `canEdit`, `index.tsx` 141) and **New project** (`CreateCompact`'s case: only while
  `grid.create?.heldBack`; `create-tile.tsx` 169 for enabled/locked and `App.showCreateModal`). Replace
  the "All N" tile with a full-width row "Show all N apps" (`home:grid.showAll`, count
  `chromeStore.moreCount`, press = `apps-more.tsx` 47-52: `Home._appsExpanded = true; Home.render()`).
  Tiles come from `gridStore.items` as now, which already holds only the folded rows; drop `APPS_SHOWN`.
  While editing, the standard head shows "Add other apps" (`openAddAppsSheet`) and "Done"
  (`Home.setEditing(false)`); see Risks for the edit mode itself.
- Pinned communities (label `home:communities.heading`): rows become **tiles** in the same `Tiles` grid:
  `pins.pins` only (not the joined ones), each with `count = pins.owed[slug]`; then the three action tiles
  in the standard order and under the standard conditions (`pinned-communities.tsx` 272-299): **Needs you**
  (count `communityScopeStore.badgeNeeds`, opens `#needs`; see `NeedsTile` 149), **All communities**
  (toggles `showAll`, also on the `home:show-all-communities` event), **New community** (dashed,
  `offerCreate`/`createOn`, `App.showCreateModal`). Link **Edit** (`home:edit.start`/`edit.done`) toggles
  an unpin corner on each tile (`setHomePin(pin, false, say(name))`). Remove the "All N" link and
  `communityLine`.
- Communities to join (label `home:join.heading`): add the kind filter as small buttons (All + kinds:
  `presentCategories(pool)`, labels `auth:guest.category.*`, state `kind`), sub-label Featured
  (`home:join.featured`) over a row of text cards (tile 44 + Join, name, "Public community · N members",
  the description on two lines), then the rest as rows with a real **Join** button
  (`Home.setMembership(slug, true)`, `home-join.tsx` 50; label `home:join.button`/`buttonNamed`). Reuse
  `featuredApps`, `joinOrder`, `JOIN_PAGE` paging with the sentinel (`communities-to-join.tsx` 73-91), the
  end line (`home:join.end`/`endKind`), `join.failed` + Retry, `join.empty`/`allJoined`. The meta line is
  the standard's: votes when `open_votes`, else members (103-104). Remove `JOIN_SHOWN`, "Browse all", and
  the row-as-door-with-a-Join-word.
- Side column: **Next challenges**: label `challenges.heading` from `panelsStore.challenges` (already read,
  line 178), link See all (`home:challenges.seeAll.text` when `challenges.seeAll`), one `Row` per
  `challenges.rows`: lead icon, title `row.goal`, right `Pill` = `row.earned || row.reward`, press
  `HomePanels.goToChallenge(row.eventId, row.id)` (`panels/challenges.tsx` 110). The note state
  (`challenges.note`: all done / none) is one padded card.
- Today's Home also holds, and the kit page does not: `WaitlistCard`, `VerifyCard`, the iOS `WidgetStrip`,
  the grid's `notice` (offline, load failed). v2 does not draw them (not in the capture); they must still
  appear when they apply (see open questions).

**Kit/CSS needs**
- `.row.showall` (+ `.tiles + .row` hairline), `.cap.sub`, `.hcard` / `.hc-top` / `.t2` / `.s2` / `.s2.two`,
  `.btnrow.chips`, v2's `.hrow` as an equal-columns grid (kit.css has a scrolling `.hrow` for picture
  cards: keep both or switch on a modifier). All in `kit.py` 117-128.
- A tile-shaped action in `TileItem` (a `Lead` of 52px, radius 15; today done inline with
  `<Lead size={52}>`), a dashed variant for New community, a lit/pressed state for All communities
  (`gA-lit` in v2's s04), and a corner control on a tile (unpin, and pin for s04).
- `Head` has no slot between the title block and the columns for the search (`PageBody` takes `tabs`;
  either pass the `Search` there or add a `search` prop).

**Tests that pin it**: `tests/home-frame.test.js` (17 cases; nearly all assert the layout being removed:
Needs you rows, communities as rows, Live this week, Your week, challenge cards, Featured picture cards,
All apps / All communities pages), `tests/workshop-live-feed.test.js` (route stays; only its reader goes),
`tests/looks-css.test.js` (kit.css compile), `tests/language-extraction.test.js` (ids), any
`tests/baselines/test-durations.json` entry for a renamed suite.

**Size**: L. The page is rewritten around three standard sections' behaviour (search, edit modes, join
paging); about 40 `home:frame.*` ids retire.
**Risks**
- **Edit mode of Pinned apps** lives in the hidden standard grid: `Home.setEditing(true)` starts the
  wiggle, the remove badges and PlatformUI's drag on `#app-list`'s own children. Under a look that grid is
  `display: none`, so today's kit "Edit" link changes nothing visible. v2 needs either remove badges on kit
  tiles (the store has `editing`; removal handler is in `app-grid.tsx` edit branch ~285) without drag, or the
  standard grid shown in place while editing. Drag cannot be reused on kit tiles as is.
- Tile menus (hold / right-click "App actions", `grid.tile.tip`), tile status (creating, error, retry,
  locked) are in `HomeAppView` and drawn by `AppGrid`; the kit `TileItem` shows none of them.
- Hydration: the kit page mounts after mount only (`frame` state, `index.tsx` 137); keep it that way.
- The mock puts a count on some **app** tiles (Homeroom 5, Game Corner 6). `HomeAppView` carries no count
  and the standard app tile draws none: do not add one.

## s03-home-all-apps

**Files**: kit `F/home/frame/home-all-apps.tsx` `HomeAllApps`; standard `apps-more.tsx`, `home.js` 1011-1038
(the fold), `create-tile.tsx`.

**Today under a look**: a separate page ("All apps", breadcrumb Home › All apps through `useFramePage`):
tabs All / Pinned, a search, "Pinned to Home" tiles with "Edit pins", "Everything else, A to Z" from
`GET /api/apps` with an "N more" tile.

**Gap to v2**: the page is retired; v2 is Home with the grid unfolded.
- Delete `home-all-apps.tsx`, the `view === 'apps'` branch and the "All N" tile in `home-frame.tsx`
  (397, 432-438), and `home:frame.allApps.*` (11 ids).
- "Show all N apps" (s01) sets `Home._appsExpanded` and re-renders; `gridStore.items` then holds every
  tile and `chromeStore.moreCount` is 0, so the row goes. The grid ends with the **New project** tile:
  draw it from `gridStore.create` when `!create.heldBack` (`CreateTile`, `create-tile.tsx` 92: enabled or
  locked with `home:create.lockedTip`, press `App.showCreateModal`). The head's New project link shows only
  while `heldBack`, so the mock drawing both at once is not what the store says: follow the store.
- No `GET /api/apps` read is needed any more.

**Kit/CSS needs**: the dashed action tile (shared with New community).
**Tests**: `tests/home-frame.test.js` 177 ("All apps: tabs and a search…") and 221 ("Home opens each page
from its own group, and comes back").
**Size**: S once s01 is done (a deletion plus the trailing tile). **Risks**: `Home._appsExpanded` is
remembered for the visit (`home.js` 1773); nothing else.

## s04-home-all-communities

**Files**: kit `F/home/frame/home-all-communities.tsx` `HomeAllCommunities`; standard
`pinned-communities.tsx` (`showAll`, `unpinned`, `PinTile faded`, `onPin`).

**Today under a look**: a separate page ("All communities"): tabs All / Public / Private / Just you / Not
pinned, a search, rows grouped Needs you / Your communities, a side column "Votes waiting on you" and a
note about pins, button "New community". Opened by "All N" and by `Home.showCommunities({ all: true })`
(the sidebar's All communities, the bar's search) through the `home:show-all-communities` event
(`home-frame.tsx` 207).

**Gap to v2**: the page is retired; v2 is Home with the unpinned communities shown inside Pinned
communities.
- Delete `home-all-communities.tsx`, the `view === 'communities'` branch (398-404), the `OwedVote` type and
  `home:frame.allCommunities.*` (17 ids).
- In the kit's Pinned communities: `showAll` state toggled by the All communities tile (drawn lit while on)
  and set by the `home:show-all-communities` event; while on (or while searching), after the pinned tiles
  draw `pins.joined` minus the pinned ones as **faded tiles with a + corner**
  (`setHomePin({ ...c, member: true }, true, say(c.name))`, labels `home:communities.pinNamed`, toasts
  `communities.pinned`/`failed`). The three action tiles stay last. Not shown while editing (standard 266).
- `Home.showCommunities` already scrolls to `#home-communities-section`; under a look that node is hidden,
  so scroll to the kit section instead (give it the id the function can find, or listen for the event and
  scroll, as `show()` does today at 193).

**Kit/CSS needs**: a faded tile (`gA-dim`: opacity) and the + corner (`gA-plus`); neither is in kit.css.
**Tests**: `tests/home-frame.test.js` 194 and 221; `tests/frame-app.test.js` 132 only checks that All
communities calls `goToCommunity(null)` (unchanged).
**Size**: S after s01. **Risks**: `useFramePage` is no longer called from Home, so the bar's crumb and back
for Home go back to the shell's own; check that nothing else relied on Home's `frame:tab` listener.

## s05-notifications, s06-notifications-full (one sheet; s06 is it with older notifications open)

**Files**
- Kit: `F/frame/frame-sheets.tsx` `NotificationsFrameSheet` (74), `NotificationRow` (56); opened by the bar's
  bell, `frame-app.tsx` 309 `openFrameSheet('notifications')`.
- Standard: `F/notifications/notifications-sheet.tsx` `NotificationsSheetView` (1594; `CatchUpLine` 312,
  `AppGroupHead` 341, `MarkOlderRead` 429, `groupUnreadByApp` 504, `groupOlderByTime` 586, `foldRepeats` 632,
  `ScreenRow` 956), `notification-stacks.tsx` (`ProjectStack` 291, `CardHistory` 726),
  `notifications-list.tsx` (`NotificationsPinnedSections` 489: invites and saved),
  `notifications-search.js`, `notifications-kinds.js`, controller
  `notifications-sheet-controller.js` (`window.NotificationsSheet`), data `notifications-store.js`,
  `notifications.js` (`window.Notifications`).

**Today under a look**: the kit `Sheet kind="right"`: title, a sentence (`notifications:frame.purpose*`),
three flat groups from `notificationsStore.screenList`: "Needs an answer" (rows ending in a blue pill),
"News", "Earlier" (20 at most), and Mark all read. No search, no tabs, no per-project groups, no history,
no paging, no invites, no clear or save on a row. The standard sheet still exists beside it:
`App.openNotificationsSheet()` (`public/js/app.js` 8710, the `#notifications` address and push taps) opens
`#notifications-sheet` in its standard face under a look.

**Gap to v2**: v2 is the standard sheet's content, whole, in the kit's sheet:
title only (no sentence) · Search notifications · tabs "Unread (N)" and All · the catch-up line
("2 need you · 5 unread") · labels Needs you / Everything else · one group per project with Mark read ·
rows: unread dot, lead (tile, avatar or glyph), small line over the title, time, a ⌄ that opens what
happened (`CardHistory`) · "See older notifications" / "Hide older notifications" · Today / Yesterday /
Last 7 days cards (one per change, "N notifications") · "Mark everything older than a week as read" ·
Mark all read at the sheet's foot. Remove the blue Answer pill, the sentence, and the three groups.
- Recommended: do not rebuild 2,260 lines of behaviour in `frame-sheets.tsx`. Make the product's own sheet
  wear the kit, as the Homeroom menu and a conversation do: the bell calls
  `window.NotificationsSheet.toggle()` (what `F/header/platform-header.tsx` 761 does), delete
  `NotificationsFrameSheet`/`NotificationRow`/`NotificationView` and the `'notifications'` arm of
  `frameSheetStore`, and add a hand-written block in app.css (beside "THE HOMEROOM MENU", 27626) plus
  `looks.json` wear entries (`card`, `row`, `tabs`/`tab`, `search`, `cap`, `btn`) for
  `#notifications-sheet`. Everything v2 lists is then already there: search
  (`notifications-search.js`), tab count (`badgeTotal`), groups, folds, history, older sections, holds,
  swipe to clear, invites, the All tab's kind chips (#3206; v2 does not draw the All tab, they stay).
- The one thing to move: v2 puts Mark all read at the sheet's foot; the standard has it under the Unread
  tab with the list. CSS order or leave as the product has it (ask).
- Retire `notifications:frame.*` (8 ids).

**Kit/CSS needs** (as wear targets or kit classes): a row with an unread dot and a top-aligned two-line
text with the small line first (`gA-nt`, `.un`), the bold group label (`gA-lab`), the catch-up line
(`gA-catch`), `.search.flush`, a foot link row. `Sheet` has no slot for a search and tabs between head and
stack if it were rebuilt in the kit instead.
**Tests**: `tests/frame-sheets.test.js` 37, 57, 68 (the three-group sheet) and 99; `tests/frame-app.test.js`
(bell opens the frame sheet; "today's header … stay mounted"); the standard sheet's own suites
(`grep -l notifications-sheet tests/`) pin its class strings, which a wear-only change does not touch.
**Size**: M (wear route: one CSS block and the bell's handler, then checking nine looks × phone/desktop);
L if rebuilt in kit components.
**Risks**: `#notifications-sheet` is adopted by the native kit on a phone
(`.platform-sheet-adopted#notifications-sheet`, app.css 3075) and is a right rail on a desktop
(`.dc-lift-panel`, 10462): the look's CSS must cover both presentations. The chrome layer is z-index 30;
the sheet must sit over it.

## s07-logo-menu

**Files**
- Product menu (what v2 draws): `F/app-context/app-context-sheet.tsx` (`#apps-switcher-sheet` 675, title
  `agent:appContext.title` 741, `#improve-row-feedback`, `#app-menu-homeroom-card`/`#app-menu-row-workshop`
  995, `#app-menu-row-about` 1062, `#app-menu-row-add-homeroom` 1077, `#app-menu-legal` 1114 with Terms,
  Privacy, Report app, `#app-menu-version` 1156), controller `window.AppContext`, anchor
  `visibleMark()` in `F/app-context/index.tsx`.
- Kit: the bar's mark button `frame-app.tsx` 318 (`data-frame-mark`, `AppContext.toggle()`); look CSS
  app.css 27626-27655 ("THE HOMEROOM MENU") and the wear map (`card` → `#app-menu-homeroom-card`, `btn` →
  `#improve-row-feedback`).
- Also under a look, a second menu v2 does not have: `frame-sheets.tsx` `AccountMenuSheet` (115).

**Today under a look**: the mark at the bar's end opens the product's own "Feedback & info" menu, wearing
the look: this is v2's content already. Separately, the sidebar's sliders glyph on the You row and the
phone bar's avatar open `AccountMenuSheet`: your name and handle, Your profile, Settings, Dark theme
switch, Invite people, Suggest an improvement, Add Homeroom to your home screen, About + build, Sign out.

**Gap to v2**
- The menu itself: none in content. Compare the drawing once against the mock: title 24px with the
  "Homeroom" small-caps under it, Suggest an improvement as the full-width primary button, one card of
  single-line rows (Go to community with its "N decisions waiting on you" line in the accent, About
  Homeroom, Add Homeroom to your home screen on a phone), a centred foot of Terms · Privacy · Report app,
  then "Version: …". Popover 320px at the top right on a desktop, bottom sheet on a phone.
- Remove `AccountMenuSheet` (v2: "Not carried over … your name and handle as its title, Your profile,
  Settings, the Dark theme switch, Invite people and Sign out. Those are on You and in Settings"), its
  `'menu'` arm in `frameSheetStore`/`FrameSheets`, and `core:frame.menu.*` (9 ids) except what the chrome
  still labels. Its two doors need a new target (see Chrome).

**Kit/CSS needs**: none new (`.ov.pop`, `.sheet`, `.row.sm`, `.foot` exist); `gA-foot` (the legal row) and
`gA-acc` (accent line) are covered by the hand-written menu block.
**Tests**: `tests/frame-sheets.test.js` 76 ("the account menu: you, Homeroom, then sign out"), 94, 99;
`tests/frame-app.test.js` 80 (mark button and no leading phone mark) and 236 ("the Homeroom menu wears the
look").
**Size**: S. **Risks**: Sign out and the theme switch lose their only door in the chrome; both exist in
Settings (confirm before deleting).

## s08-bot, s09-bot-full (one page; s09 is it scrolled)

**Files**
- Kit: `F/ai/frame-list.tsx` `AiFrameList` (drawn by `F/ai/index.tsx` 920 in place of `AiLists`;
  `#ai-screen[data-frame-list]`); look CSS app.css 27106-27126.
- Standard: `F/ai/index.tsx` (the `hero` 860-905: tile, name, counts, search toggle, `NewThreadButton`; the
  ask bar 965-975), `F/ai/lists.tsx` `AiLists` (694; `Line` type 92, `MainChatRow` 323, `GroupMore` 404,
  `GroupList` 431, `Section` 539, chips 938-966), `F/ai/project-picker.tsx` `ProjectPicker` (240),
  `F/ai/model.ts` (`needsYou`, `inProgress`, `upNext`, `liveThisWeek`, `rankProjects`, `withProjects`,
  `railProjects`, `groupRows`, `GROUP_FIRST`, `freshCount`, `heroWords`, `whyOf`, `shortWords`, `prWord`),
  `F/ai/history.ts`.

**Today under a look**: head (title, counts sentence, a labelled "New thread" button) · tabs All (with a
count) + the busiest projects · a search field always shown · Main Chat as a two-line row ("Ask anything,
across every project") with an "N new" pill · **one labelled group per project** "Homeroom · needs you" of
two-line rows with a lead glyph and a pill · with a project picked, its work in progress with the mini
five-stop `Track` · under All, three flat groups without project names: Waiting & in progress (rows with
`Track`), Not moving (its own group with Show), Live this week · History: kinds as buttons in the group's
head, then one group per month. The phone's Ask Homeroom bot bar is hidden (app.css 27106).

**Gap to v2** (v2 = `AiLists`' content in the kit's head, tabs and groups)
- Head: add the bot's tile (48px) before the title; replace the labelled button with two round icon
  buttons, search (`messages:ai.search.open`, toggles the field as `searchOpen` does, `index.tsx` 842-845,
  Escape closes) and + (`messages:newThread.start`; today's `onNew` already does `openBlank();
  startNewThread(botId)`). The search field shows only while open. Remove `messages:frame.bot.new`,
  `frame.bot.search`.
- Tabs: All, the rail's projects (`railProjects(ranked, picked)`), then "**N more ⌄**" opening
  `ProjectPicker` (`lists.tsx` 952-966, `ai.filter.more`). Use `withProjects` so History's and a link's
  projects count (`lists.tsx` 744). Today's standard chips are multi-select (`toggle`) and carry a fresh
  badge (`freshByProject`); the kit tabs pick one. Keep single pick only if the owner accepts it. Remove
  the count on All.
- Main Chat: one small single-line row in its own card (no sentence); the unread word stays
  (`messages:ai.main.new`). Remove `frame.bot.mainLine`, `frame.bot.newCount`.
- The four lists, in this order, each **one group with one card**: "Needs you · N"
  (`ai.work.titleCount`), "Waiting & in progress · N" (`ai.busy.title`, count = busy + still), "Live this
  week · N" (`ai.live.title`), "History" (`ai.history.title`). Inside a card: a project head row (22px tile
  + name; hidden when one project is picked, `heads`, `lists.tsx` 911), then one **single-line row** per
  item: glyph (accent when `owe`), the number in mono ("#6370" or "PR 6198" by `prWord`; from 768px only),
  the title, and on the right the one word: a blue pill when it asks for you, plain grey otherwise
  ("Only you", a name, a day). A private row also ends in ⋯ (Mark done, `Line.done`). On a phone only, a
  second line where it is news (`Line.why`). "Show N more ⌄" per project (`GroupMore`, `groupRows`,
  `GROUP_FIRST`), "Not moving · N" as the last row of Waiting & in progress (opens the still rows in
  place), History's kinds (All, Changes, Requests, Votes, Only you) as a button row inside its card, month
  rows, "Earlier months" as the last row (`history.more`).
- Reuse: everything a row needs is the `Line` object `AiLists` builds (`lists.tsx` 780-895) and the
  grouping in `GroupList`/`Section`. Lift that building out of `AiLists` into a shared hook or module
  (say `ai/lines.ts`: need, busy, still, live and history lines, `ranked`, `rail`, `past`, the fresh
  counts, `noMatches`) with the glyph as a name, not a React node, so both faces draw the same lines. Then
  `AiFrameList` only maps lines to kit rows. Also carry over what the kit list lacks today: `failed` +
  Retry (`ListsFailed` 675), the loading skeleton, `ai.search.none`, `ai.filter.emptyProject`, the fresh
  dot and "N new" (`FreshBadge`, #6262), "· N requests" (#6421), `left` projects in History, the older-tab
  reload note (`ai.live.olderTab`), `onDone`.
- Remove: the per-project "· needs you" / "· in progress" groups, `Track` on rows, second lines on a
  desktop, the separate Not moving group, month groups as separate `Sec`s. Ids retired:
  `frame.bot.groupNeeds`, `needs`, `groupProgress`, `progress`, `show`, `showLess`, `showMore` (use
  `ai.work.showMore`/`showLess`), `onlyYou` (use `ai.short.private`).
- Phone: show the Ask Homeroom bot bar over the tab bar (delete the two `display: none` rules at app.css
  27106-27107 and let `.messages-composer-card.ai-askbar-card` wear the kit's `.composer`, which the wear
  map already maps).
- Width: v2 uses `.inner.narrow` (784px) while nothing is open; today's rule gives 720px (27111). Same idea.

**Kit/CSS needs**: a compact list inside a card (`gA-list`: no hairlines, 40px rows), project head row
(`gA-proj`), month row (`gA-month`), mono number cell (`gA-num`), the small glyph cell `.row .ei` (+ `.acc`),
"more" row (`.row.more`), `.row.item` weight, `.card.gA-main`, a leading tile in `Head` (`.head > .tile`),
`.ib.more` (filled icon button), `.inner.narrow`, a chevron on a tab. None is in kit.css; `Row` has no
`num`/`glyph` props and no trailing-control slot after `right` (the ⋯).
**Tests**: `tests/ai-frame-list.test.js` (all 11 cases assert today's kit list: per-project groups, the
five-stop line, the search, 520px panes), `tests/ai-screen.test.js` (standard list and hero source strings;
touched if line building moves out of `lists.tsx`), `tests/frame-app.test.js` 74.
**Size**: L. The row model must be shared first, then the kit face rewritten.
**Risks**: `tests/ai-screen.test.js` reads `lists.tsx`/`index.tsx` by string, so moving the line builder
breaks its regexes even with no behaviour change. `holdOrder`/`groupRows` keep a lit or fresh row in view
while folded; a kit re-implementation that skips them loses rows the person is on.

## s10-bot-main

**Files**: `F/ai/index.tsx` 1041-1054 (the kit head of `#ai-main-pane` under a look: `dhead`, tile, title,
`messages:ai.main.sub`, ×) and 1083 `EmbeddedConversation … mainChat` (the product's renderer, wearing the
kit through `looks.json` wear: `post`, `day`, `dhead`, `composer`, `ib`); phone: `F/ai/phone-drawer.tsx`
`AiDrawer` + `MainPane`, with the bar's crumb and back from `useFramePage` (`index.tsx` 859). Standard head:
`index.tsx` 1056-1080 (same words, plus a lock glyph).

**Today under a look**: the list (520px) and Main Chat beside it under the kit head, the conversation drawn
by the product and worn; × closes the column.

**Gap to v2**: small.
- Head: add the lock glyph before "Only you can see this chat" (the standard head has `LockIcon`, 1064);
  the × is desktop only in v2 (`ib d`): on a phone the bar's arrow goes back.
- Body: content is the product's by construction (your messages, the bot's replies, the request cards from
  `F/messages/ref-cards.tsx`, the composer with +, Message…, microphone, send). Check two drawings against
  the mock: the bot's bulleted lines as the kit's small event lines (`.evt` with `.ei`), and the request
  cards as kit rows in one card (lead #, title, "Request #N · Project", chevron). Neither is in the wear
  map today (`card` does not list the ref cards).
- No ⋯ in the head and no "vote from the chat": nothing to remove, the kit head never had them.

**Kit/CSS needs**: `gA-lock` (inline lock + words), `.thread.flat`; wear entries for ref cards → `card`/`row`.
**Tests**: `tests/ai-screen.test.js`, `tests/homeroom-bot-activity.test.js` (`data-ai-main-head`,
`#ai-main-title`), `tests/ai-frame-list.test.js` 105 (pane widths).
**Size**: S. **Risks**: the head is duplicated for the two faces in `index.tsx`; keep `#ai-main-title` and
`data-ai-main-close` on both (declared checks and suites select them).

## s11-bot-request

**Files**: the request's page in the shell's side panel (`openTopicInPanel`, `.side-panel`, look CSS app.css
27120-27126), drawn by the kit request page `F/dev-board/topic/frame/topic-frame.tsx` with
`F/dev-board/topic/request-head.tsx` (suite `tests/request-frame.test.js`). On a phone the request opens on
its own page (`/app/<slug>/dev/issues/<n>`).

**Today under a look**: the list with the row lit, and the side panel at the column's width with the kit's
request page inside it (plan notes, "Leftovers taken up", 10 Nov).

**Gap to v2**: owned by the request page's own step (the group that audits `topic-frame.tsx`); for this
step only the pane:
- Pane head as the kit's `dhead`: the project's tile (40px), the request's title, "Project · Request #N",
  ⋯ and × (× desktop only). Check `.side-panel-head` against it; it is the shell's head, restyled, not the
  kit's.
- Order inside: Status first (pill, five stops, "Nobody is working on this yet.", Reply to Homeroom bot),
  then The request (author, text, Show more, Translate, Screenshot), then "N reply/replies", then the
  Reply… box docked at the pane's foot.
- Remove, if the kit request page draws them in the panel: a blue Reply pill in the pane's head and the
  note "The bot is waiting for you" (v1's s11 inventions). `grep -n "waiting for you" F/dev-board/topic/frame/`
  to confirm; I did not find them in `F/ai/`.
- Phone: the two back chips "Homeroom bot" and "Workshop" at the top of the page (the request's "‹" chip;
  AGENTS.md "A request's ‹ chip names where its press goes").

**Kit/CSS needs**: `gA-author`, `gA-links`, `gA-shot` (author line, Show more / Translate links, screenshot
block) if not already in the request page's kit.
**Tests**: `tests/request-frame.test.js`, `tests/ai-frame-list.test.js` 105.
**Size**: S for the pane (the page itself is another step's). **Risks**: `.side-panel` is in `<body>` and
sized by `--ai-main-w` set with `:has(#ai-screen[data-frame-list]:not(.hidden))`; a rename of
`data-frame-list` breaks it silently.

## s12-bot-private

**Files**: `ReplyThreadPanel` with `inMain` in the bot's column (mounted through `EmbeddedConversation`),
`F/messages/private-thread-bar.tsx`, `private-thread-done.tsx` (Mark done in the ⋯); worn through the wear
map (`dhead` → `.messages-thread-header`, `post`, `composer`, `ib`).

**Today under a look**: the product's own thread pane in the column, wearing the kit: the thread's name,
"Only you can see this thread", ⋯ and ×, the bot's opener, the reply box.

**Gap to v2**: none in content (v2 dropped v1's Mark done button and blue note, which were never built).
Check the drawing: a lock as the head's lead and before the line, the "AI" pill after Homeroom bot, the
"No replies yet" rule (`gA-rule`: small grey words with a hairline to the right), placeholder
"Reply in thread…".

**Kit/CSS needs**: `gA-rule`, `gA-lock` as wear rules for the thread pane's own classes.
**Tests**: `tests/ai-screen.test.js`; the reply-thread suites pin the standard markup, untouched.
**Size**: S (CSS check only). **Risks**: none beyond the nine looks' own rules for `.dhead`.

## s13-bot-new-thread

**Files**: `F/messages/new-thread.tsx` `NewThreadPanel` (191; `<aside class="messages-reply-pane"
data-bot-new-thread-pane>` 371), `NEW_THREAD_STARTS` (71), `startNewThread`/`closeNewThread`/`useNewThread`
(126-143), `NewThreadButton` (168); `F/messages/project-picker.tsx` `ProjectChip` (96), `ProjectPicker`
(364); `F/messages/thread-builder.tsx` `BuilderChip` (145), `BuilderPicker` (328), `BuilderSetup` (356).

**Today under a look**: the kit list's + starts the blank thread, which is the product's column pane beside
the lists (ruling of 10 Nov in the plan: "the blank thread keeps the column pane"), wearing the kit's
`dhead` and `composer`.

**Gap to v2**: v2 draws today's content **in the kit's standard sheet over the lists** (centred on a
desktop, from the bottom on a phone), which reverses that ruling:
- Sheet title `messages:newThread.title`, sentence `messages:newThread.sub`, ×  = `closeNewThread()`.
- Body: the welcome (bot tile 44px, `newThread.welcome.title`, `newThread.welcome.sub`), the five starts as
  single-line rows in one card with a glyph each (`NEW_THREAD_STARTS`; a press writes the start into the
  box, `withStart`), then the two chips (`ProjectChip` "Any project ⌄", `BuilderChip` "Homeroom bot ⌄"),
  then the composer (+, `newThread.placeholder`, microphone, send).
- How: split `NewThreadPanel` into its stateful body and its shell; under a look render the body inside
  kit `Sheet` (portal to `<body>`), else in the `<aside>`. All state (draft, attachments, dictation,
  builder hand-off, `BuilderSetup` in the thread's place, the "draws" and hand-off hints, errors) stays in
  the body. A CSS-only route (the `<aside>` positioned as the sheet under `html[data-skin]`) is cheaper but
  has no backdrop or focus trap.
- Nothing to remove from the kit (v1's labelled field, "Or start from" sentences, Project row with Change
  and Start thread button were never built).

**Kit/CSS needs**: `gA-welcome` (centred tile, title, sentence), `gA-chip` (a small quiet button with a
leading glyph or tile and a chevron), the composer inside a sheet (`.sheet .composer` has no rule in
kit.css). The pickers already use the kit's sheet when it is there (`adoptKitSurface`, `gate: 'kit'`,
`thread-builder.tsx` 251).
**Tests**: `tests/bot-new-thread.test.js`, `tests/ai-screen.test.js`, `tests/ai-frame-list.test.js` 134
("the list's New thread starts the blank thread"), `tests/composer-keyboard.test.js`,
`tests/chat-foot.test.js`, `tests/design-pane.test.js` (all read `new-thread.tsx` by string).
**Size**: M. **Risks**: six suites read `new-thread.tsx`; the composer's keyboard handling
(`useComposerKeyboard`, `platform-kb-column`) assumes the column pane; a sheet from the bottom on a phone
needs the same keyboard inset. Needs the owner's yes, since it undoes a recorded ruling.

## s14-bot-project-chip

**Files**: as s08 (`AiFrameList`; `picked`, `onPick`; `lists.tsx` 746-760 for the filter rules).

**Today under a look**: with a tab picked: that project's needs as one group "Homeroom · needs you", its
work in progress as a second group with the mini five-stop line; Waiting, Not moving and the all-projects
groups are not drawn (`allBusy`/`still` are empty when `picked.length`, `frame-list.tsx` 116-117); Live and
History filtered.

**Gap to v2**: the same four lists as s08, filtered to the project, with no project head rows
(`heads = picked.length !== 1`), Main Chat still first, and the sentence under the title unchanged (counts
for all projects, `heroLine`). Falls out of s08's rewrite if the shared lines take `picked`:
- Remove the picked-only "in progress" group and its `Track` (190-209).
- Main Chat: today hidden when a project is picked (`q || picked.length ? null`, 157); v2 shows it.
- Group counts are the filtered ones ("Needs you · 4": `owedShown`, `lists.tsx` 909).
- `ai.filter.emptyProject` when the project has nothing.

**Kit/CSS needs**: none beyond s08's. **Tests**: `tests/ai-frame-list.test.js` 75 ("a picked project narrows
the list … with the five-stop line"). **Size**: S after s08. **Risks**: the address
(`#homeroom-bot?project=…`, `filter-address.ts`) must keep driving `picked`.

---

## Chrome

**Files**: `F/frame/frame-app.tsx` `FrameChrome` (sidebar 216-284, bar 286-325, tab bar 327-332),
`frame-sheets.tsx`, `frame-page-store.ts`, `look-picker.tsx`; look CSS app.css 26995-27095 and 27457-27470;
suite `tests/frame-app.test.js`. The mockup frame (identical in v1 and v2, and in every step of this group):

```
side:   brand (mark 28 + "Homeroom") · Home · Homeroom bot [n] · Messages [n] · cap "Recents" ·
        up to five community rows (tile 22, name, [n]) · "All communities" · foot: You (avatar 24, name, a glyph)
bar:    [phone: mark tile 28, or a back arrow on a deeper page] · crumb · space ·
        [desktop: search] · bell with dot · [phone: your avatar 28]
tabbar: Home · Bot [n] · Messages [n] · You        (phone)
```

No v2 step nests a project's places under its sidebar row (`kit.py` has `nest()` but no step uses it: 0 of
112); places are the page's tabs.

| Part | Product today | v2 frame | Gap |
| --- | --- | --- | --- |
| Sidebar brand, three places, counts | same (217-223) | same | none |
| "Recents" + rows + All communities | `useRailCommunities()`, count `c.needs` (224-246) | same | none. Today's standard sidebar also has pinned rows with a pin and the App row with its green dot; the mock has neither (ask) |
| Sidebar foot | You + a sliders glyph that opens `AccountMenuSheet` (247-283) | You + a glyph | the glyph's target goes with s07: make it Settings, as the standard rail's cog does (`F/nav/tab-bar.tsx` 1308 `#platform-rail-settings`, `href="#settings"`) |
| Bar, leading (phone) | nothing; back arrow when the page has one | the Homeroom mark, or a back arrow | add the leading mark on a phone when there is no back (it was removed on 10 Nov, `tests/frame-app.test.js` 91) |
| Bar, crumb | header's words, or project tile + name › place, or a kit page's own trail (107-126) | same | none |
| Bar, search (desktop) | `goToCommunity(null)` → Home with All communities open | a search glyph | keep, but land on Home's new search field (`Home.focusSearch()`), since All communities is no longer a page |
| Bar, look picker | `LookPicker variant="frame"` (admins) | absent | keep (admin tool, not a product surface) or move to Settings: ask |
| Bar, bell | opens `NotificationsFrameSheet` (309) | bell with dot | retarget to `NotificationsSheet.toggle()` (s05) |
| Bar, Homeroom mark + ⌄ at the end | `.ib.markbtn`, all widths, opens the product's menu (318-321) | absent | conflict: v2's s07 is "Click the Homeroom logo at the top" and draws the menu at the top-right corner, but the frame has no logo at the top right on a desktop (only the sidebar brand). Either keep the end button (product today), or make the sidebar brand and the phone's leading mark the doors and move `visibleMark()`'s anchor. Ask |
| Bar, avatar (phone) | opens `AccountMenuSheet` (322-324) | your avatar | retarget (You, `#profile`) once the account menu is removed |
| Tab bar | Home · Bot · Messages · You with counts (327-332) | same | none |
| Phone Ask bar on the bot tab | hidden under a look (app.css 27106) | `.composer` over the tab bar | show it (s08) |

**Kit/CSS needs**: none for the frame itself.
**Tests**: `tests/frame-app.test.js` 52 (sidebar order), 80 (bar: mark at the end, no leading phone mark),
132 (presses), 236 (menu wears the look); `tests/frame-sheets.test.js`; `tests/look-picker.test.js`.
**Size**: S to M, mostly decisions. **Risks**: `visibleMark()` and the menu's outside-click guard
(`F/app-context/index.tsx`) are tied to `[data-frame-mark]`; moving the door moves both.

---

## Work several steps share (do once)

1. **Kit additions**, in `kit.css` + `kit.tsx`, taken from `tour-v2/kit.py` `KIT_CSS` and `screens_a.py`
   `CSS` (rename `gA-*` to kit names): the compact list in a card (project head, single-line item with
   glyph, mono number, word, trailing control, "more" row); action / dashed / faded tiles and a tile corner;
   `.row.showall`; `.cap.sub`; text cards (`.hcard`, `.t2`, `.s2`); a leading tile in `Head`; a search slot
   in `PageBody`/`Sheet`; `.inner.narrow`. Then `node scripts/build-looks-css.js` (`tests/looks-css.test.js`).
2. **The bot's line model** lifted out of `F/ai/lists.tsx` so both faces draw the same lines (s08, s09, s14).
3. **Home's search bridge** to `#home-search-input` (s01 to s04, and the bar's search).
4. **Wear, not rebuild, for the two header sheets**: notifications joins the Homeroom menu as a product
   surface wearing the look; `frame-sheets.tsx` is then deleted whole (s05 to s07, Chrome).
5. **Catalog clean-up**: retire `home:frame.*` (most), `notifications:frame.*`, `core:frame.menu.*`,
   `messages:frame.bot.*` in favour of the standard ids named above; English only.

## Suggested order

1. Kit additions (1 above).
2. s05/s06 and s07 with the Chrome decisions (small code, removes a whole file, settles the bar).
3. s01/s02, then s03 and s04 (deletions once Home is today's).
4. The bot's line model, then s08/s09, then s14.
5. s10, s12, s11 (drawing checks on worn product surfaces).
6. s13 last (needs a ruling reversed).

## Open questions (v2 cannot be built from what the product has, or contradicts it)

1. **Counts on Pinned app tiles** (Homeroom 5, Game Corner 6, RecipeBot 2 in s01): the standard app tile has
   no count and `HomeAppView` no field. Only community tiles have one (`pins.owed`). Drop, or add a read?
2. **Next challenges' second line** ("Say yes or no on a change waiting on votes"): `ChallengeRowView` has
   `goal`, `stateLabel`, `reward`, `fill`, no description. Use `stateLabel`, or no second line?
3. **Editing Pinned apps under a look**: drag to rearrange is PlatformUI on the hidden standard grid. Remove
   badges only, or show the standard grid while editing?
4. **Where the Homeroom menu opens from** on a desktop (bar's end today; the mock's frame has no mark there),
   and what the sidebar's You glyph and the phone's avatar open once the account menu is gone.
5. **Mark all read** at the sheet's foot (v2) or under the Unread tab (product)?
6. **New thread as a sheet** (v2) reverses the 10 Nov ruling that it stays the column pane.
7. **Bot project tabs**: single pick (kit tabs) or the standard's multi-select chips with fresh badges?
8. **Waitlist card, Verify card, iOS widget strip, offline notice** on Home: not in the capture, present in
   today's Home for the accounts they apply to. Draw them in the kit page (how?) or leave those accounts on
   the standard body?
9. **The sidebar's pins and the App row's still-open dot** (today's standard sidebar): not in the mock's
   frame. Carry over or not?
