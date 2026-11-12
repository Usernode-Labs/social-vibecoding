# Audit, group d: You, your work lists, friends, profiles, challenges, standings (s44 to s55)

Checkout read: `/Users/salah/Dev/lingash/sv-skins` at `2fe96b8af` (branch `redesign/skins-2026-11-11`). Paths below are relative to it.
Short names: `kit.tsx` = `frontend/@/components/ui/kit.tsx`, `kit.css` = `frontend/looks/kit.css`, `P/` = `frontend/src/features/profile/`, `L/` = `frontend/src/features/leaderboard/`, `A/` = `frontend/src/features/ai/`.
Nothing was run in a browser; everything here is read from source.

---

## s44-profile and s45-profile-full (You, Overview)

**Files**
- Kit: `P/frame/you-frame.tsx` `YouFrame` (1-120). Mounted by `P/profile-view.tsx` `YouInFrame` (403-425), chosen in `ProfileRoot` at 529. Screen area: `public/css/app.css` 27315-27321 (`data-you-frame`).
- Standard: `P/profile-view.tsx` `IdentityCard` (80), `StatCards` (170), `ActivityCard` (221); `P/account-panel.tsx` `WorkPanel` (146), `RewardsPanel` (207), `AccountPanel` (245), `SettingsPanel` (293), `AdminPanel` (361). View: `P/profile-store.js` `buildProfileView` (752), `identityView` (242), `statsView` (274), `activityView` (315), `moreRowsView` (449).

**Today under a look**
- Head: title = display name (`identity.name`); purpose = `identity.sub` and the verified chips joined with `profile:frame.pair`; buttons Edit profile (primary) and, while published, Open public page.
- No tabs.
- Main: In numbers (`Facts`), Your work (4 rows), This week as two rows of words (time, apps), no chart.
- Side: Public page (Public profile row, Copy public link), Rewards (Challenges & standings), Account (Friends, App slots, Notifications, Settings, Admin as rows of one card).

**Gap to v2**
1. Title is the handle. `identityView` only returns `handle` when a display name is set (245-246) and `sub` is already joined. Add `username` and the facts as a list (since, apps) to `identityView`, so the page can say `@username` and "Building since… · Changes live in N apps" without the handle or the chips. Ids exist: `profile:identity.buildingSince`, `profile:identity.apps`.
2. Buttons: Edit profile only, kind `line`. Remove the Open public page link (you-frame 65).
3. Add tabs: Overview, Changes, Requests, Feedback, Votes, Friends (`Tabs`, `PageBody tabs=`). See "Shared work" 1.
4. Main column, in order:
   - Verified pills from `identity.chips` (`verifiedSocialLinksView`, store 198; labels are already "Verified GitHub · name"). Keep them links (`chip.href`, external).
   - Your work: as today (you-frame 102-109). Changes, Requests, Votes and Friends rows should pick the tab once tabs exist.
   - Rewards: move from side to main (you-frame 80-84).
   - Account: Friends and App slots only.
   - Settings (new group, `profile:settings.heading`): Profile (`#profile?edit`, `profile:settings.profile.*`), Notifications, Settings with its hint. Copy `SettingsPanel`'s wallet variant of the hint (account-panel 293-300, `more.settings.hintWallet`).
   - Admin (own group, `profile:admin.heading`, with `admin.console.hint`), when `admin`.
5. Side column:
   - In numbers: move here (`view.stats`, zeros hidden as today).
   - This week: one card of up to four figures (`activity.time`/`timeLabel`, `apps`/`appsLabel`, `merged`/`mergedLabel`, `challenges`/`challengesLabel`), the seven bars (`activity.days`: `label`, `heightPct`, `zero`, `today`, `peakLabel`, `spoken`), then `profile:activity.note`. Share stays the group's link (`Profile.showWeekShare`). All of it is in `activityView` already; `ActivityCard` 248-309 is the reference, including `aria-label` `profile:activity.chartLabel` and the `sr-only` spoken day.
   - Empty week: standard draws the card with `profile:activity.empty`; the kit page draws nothing (110). Draw the empty sentence.
6. Remove the Public page group and the `publicPage` prop (you-frame 25-26, 70-79; profile-view 417). Then unused: `profile:frame.copy`, `profile:frame.week.time`, `profile:frame.week.apps`, and `publicStatus` on `YouInFrame`.

**Kit/CSS needs**
- A bar chart (`.bars`, `.bcol`, `.bl`, `.bv` in the tour's `kit.py` KIT_CSS) and `.foot.left`: not in `kit.css`.
- `Facts` always wraps itself in a `Card` (kit.tsx 254); This week needs figures, bars and note in one card: add an inset form (`.facts.inset`, `.facts+.bars`).
- A row of pills under the head (`.mechips` / `btnrow`), and `Pill` as a link.

**Tests that pin it**: `tests/you-frame.test.js` (8 tests; four of them assert exactly what v2 removes: "one strip", "two rows of words, with no chart", the context column's order, Public page as second button). Also read `profile-view.tsx`: `me-page`, `profile-activity`, `profile-week-share`, `screen-skeletons`, `friends-ui`, `admin-console-entry-row`, `topochain-profile-web`, `no-glass-one-scheme`, `section-heading-primitives`, `qa-sweep-shared-polish`, `profile-feedback-list`, `avatar-crop`, `challenge-deep-link`. `profile-store.js` is pinned by most of the same.

**Size**: M. The data is all in the view; the work is the chart component, the regroup and rewriting `you-frame.test.js`. **Risks**: `identityView` is shared with the standard card, so add fields, do not change `sub`. The skeleton shown before data is the standard one (`ProfileSkeleton`), not the kit's.

---

## s46-your-changes, s47-your-requests, s48-your-votes (History, one kind, as tabs of You)

**Files**
- Kit today: `A/frame-list.tsx` `AiFrameList`, History block 229-267 (rows 246-262). Reached by `#homeroom-bot/history?kind=change|request|vote` (`A/filter-address.ts` `historyAddress` 104; you-frame 104-107 link there).
- Standard: `A/lists.tsx` History card 891-919 and 1065-1125 (`GroupList` by project, `heads`), chips 1073-1085.
- Model, reusable as is: `A/history.ts` `useHistory` (177), `byMonth` (71), `monthName` (84), `historyWords` (105), `historyGlyph` (136), `historyTooltip` (124), `historyPath` (148); `A/model.ts` `byProject`, `rankProjects`; server `GET /api/ai/history?kind=&project=&before=`.

**Today under a look**: not on You at all. The You rows open the Homeroom bot page, whose kit list ends in a History group: kinds as small buttons, then one group per month of flat rows (glyph, title, "Project · #n" as the line, the outcome word). No project heads inside a month, no project picker of its own (the page's tabs narrow it).

**Gap to v2** (one component, three kinds)
1. New tab body in `P/frame/` (say `YouHistory({ kind })`) drawn inside the You shell:
   - Rows: `useHistory({ showing, signedIn, projects: picked, kind, demo })`. `signedIn` and `demo` are computed in `A/index.tsx` 610-616; copy that.
   - Per month (`byMonth`, label `monthName`): per project (`byProject`) a small head row (tile, name, "· You left" from `row.left`, `messages:ai.history.left`), then one short row per item: glyph (`historyGlyph`; the icon map `HISTORY_ICON` at frame-list 46 is not exported, export it), number (`#n`, or "PR n" when `row.change && row.app.changesOnGithub`, see lists.tsx 905), title, `historyWords` as the grey word. A decision has no number.
   - "Earlier months" as the last row: `history.more`, shown while `history.next`; loading, failed (`history.retry`) and empty sentences are `messages:ai.history.loading|failed|empty`.
   - A row opens `row.href`. `openHistory` (A/index.tsx 741) uses the bot page's own column, so here it is plain navigation.
2. Project filter: side column "Projects" card (All projects, then each project, the picked one lit, pressed state) from 768px; a row of small buttons over the list on a phone. The standard takes its projects from the rows it has (lists.tsx 772-778). One project picked makes the server narrow (`historyPath` 150); several is client side.
3. Not drawn: the kinds buttons (the tab is the kind), `solo` rows, the five-stop line.
4. The You rows and tab addresses must reach these tabs. See "Shared work" 1 and open question 1.

**Kit/CSS needs**: a project head row (`gD-proj`: 40px, 13px bold), a fixed number column (`gD-num`, 52px tabular), a small glyph slot (`.row .ei`), `.row.item` (weight 500), `.row.showall`, a pick row with a check (`gD-pick`). `Row` has no slot between lead and title: add `num`, or build these rows from classes. `.d` / `.p` (desktop only, phone only) exist in kit.css 15 against `.hr.phone`; check they compile for the product's width rule.

**Tests that pin it**: `tests/ai-frame-list.test.js` 143-165 (History in the bot list; unchanged if that list stays), `tests/ai-history-card.test.js`, `tests/profile-your-work.test.js` (the You rows' hrefs), `tests/ai-history-postgres.test.js` (server, untouched). New test for the tab.

**Size**: M for the three together. The reads and words exist; the rows, picker and tests are new. **Risks**: `useHistory` re-reads on `showing`; give it a counter that moves when the tab is shown. History for one kind pages by month, so a narrow project can show "Earlier months" with nothing above it (the standard has the same).

---

## s49-friends (Friends as a tab)

**Files**
- Kit today: none. `#profile?friends` and the Friends row call `Profile.showFriends()`, which draws the standard dialog `P/friends-sheet.tsx` `FriendsSheet` (38) around `P/friends-section.tsx` `FriendsSection` (69). The plan notes say "the product's dialog, solid".
- Standard: the same two files, plus `frontend/src/features/friends/friend-search.tsx` (`#profile-friend-search`). View: `friendsView` (store 688); state `friendsPending`, `friendsStatus`; actions `Profile.answerFriendRequest(id, yes)`, `Profile.cancelFriendRequest(id)`.

**Today under a look**: the standard Friends card as a modal over You.

**Gap to v2**
1. New tab body (say `YouFriends`) inside the You shell, from `view.friends` (already built on every own-profile view, profile-view 503):
   - The search: reuse `FriendSearch lists={view}`; it is standard markup (input and result list), so it needs the kit's face or a wear rule.
   - "Friends" group, one card: incoming rows first (avatar, `@username` as a link to `row.href`, `row.meta`, Decline quiet and Accept, disabled while `pendingId === row.id`), then friends as rows that open `row.href`. Empty: `profile:friends.empty` or `friends.loadFailed` by `view.loaded`.
   - Under it `profile:friends.privacy`, and `status` as an alert when set.
   - Side column: "Sent requests" (`profile:friends.sentHeading`) with Cancel, only when `view.outgoing.length`.
2. Under a look `#profile?friends` and the Friends row pick the tab instead of setting `friendsOpen` (profile.js ~715-750; profile-view 501-507 still mounts the dialog).
3. Keep the data attributes the dialog has (`data-friend-request`, `-accept`, `-decline`, `data-friend`, `data-friend-sent`, `-cancel`) where cheap; `tests/friends-ui.test.js` reads them in the standard file only.

**Kit/CSS needs**: `.secnote`; a row with two small buttons at its end (`Row right` takes a fragment; check wrapping at 390px); `.search.flush`.

**Tests that pin it**: `tests/friends-ui.test.js`, `tests/no-glass-one-scheme.test.js` (standard files). New test for the tab.

**Size**: S to M. **Risks**: the search's result list is the only standard-looking block left on the tab if it is not restyled.

---

## s50-edit-profile (the sheet)

**Files**
- Kit today: none. `P/profile-edit-sheet.tsx` `ProfileEditSheet` (309-721) is the product's dialog, lifted into the native kit modal by `adoptKitSurface` (372), made solid under a look (`--dc-sheet` follows `--fr-solid`).
- Its groups, in order: Photo (478), Your name (521), About (550), Public page `PublicPage` (224, drawn at 578), Verified social accounts (588), Username (644), Account email (671), error line, Save, Cancel.

**Today under a look**: the standard dialog. Its content and order are already v2's, word for word.

**Gap to v2**: face only.
- Draw it as the kit's sheet: title, groups as kit cards and rows, fields with their counters, one Save button.
- Recommended: keep the component and its ids, and dress it (a `looks.json` "wear" root for `#profile-edit-sheet`, or kit classes beside the existing ones). Rebuilding it on `kit.tsx` `Sheet` means re-doing the crop dialog hand-off (`inert`, the crop rendered last, 704-717), the kept draft on dismiss (347, 388), `returnKeyHandler`, and the constant root classes the native kit writes to.
- Today has three things the mockup does not show; they are today's content, so keep them: Remove photo (499), Cancel (699), the status and error lines.

**Kit/CSS needs**: a field label with a counter at its end (`gD-lab`, `gD-count`); a multi-line field (`Field` is an `<input>` only); an action row in the accent (`gD-act`); a row line in green (`gD-okline`); `.secnote`; a sheet body that scrolls (`gD-scroll`). `Tog` and `Pill kind="ok"` exist.

**Tests that pin it**: `profile-editor-back`, `transition-glitches`, `return-to-next`, `profiles-route`, `section-heading-primitives`, `me-page`, `topochain-profile-web`, `avatar-crop`.

**Size**: M by dressing, L by rebuilding. **Risks**: eight suites read this file's strings; declared checks select its ids; `ROOT_CLASS` and `CARD_CLASS` must stay constants. See also the preview bug under s51.

---

## s51-public-profile-self and s52-public-profile-other

**Files**
- Kit: `P/public-profile-card.tsx` `PublicProfileCard`, frame branch 92-132. Mounted by `ProfileRoot` 470-481 (inside a `lg:max-w-2xl` wrapper).
- Standard: the same file 133-190; `P/message-button.tsx`, `frontend/src/features/friends/friend-button.tsx`; view `buildProfileView` 759-783 (`allowReport`, `allowMessage`, `friendship`).

**Today under a look**: title = display name (or handle), purpose = handle, buttons Friend then Message; main "About" card with a row (avatar, name, handle) then the bio; Report user link; side "Verified" rows (GitHub, X).

**Gap to v2**
1. Avatar moves into the head, beside the title. Remove the row at 121.
2. About holds the bio only; with no bio, no About group (today the card would be empty after step 1).
3. Buttons: v2 has Friends as `line` and Message as primary. Both are the shell's `<Button>` (not kit `Btn`); check what they wear under a look and give them the kit's classes if nothing does.
4. Report user stays under About (126). Its classes `fr-bad-link` and `fr-bio` (122, 126) are not defined in `kit.css` or `app.css`: define them or use existing ones.
5. s51 (your own page) is the same component with no buttons: nothing else to change.

**Kit/CSS needs**: a lead slot on `Head` / `PageBody` for an avatar (`.head>.tile` in the tour's CSS); a red link (`gD-report`).

**Tests that pin it**: `tests/public-profile-frame.test.js` (3 tests; the first asserts the About row), `profiles-route`, `person-message-button`, `me-page`, `friends-ui`, `topochain-profile-web`, `no-glass-one-scheme`.

**Size**: S. **Risks, both existing bugs in this file**:
- `useMessages` is imported twice (31 and 39). A bundler should refuse a duplicate binding; confirm the shell builds from this checkout.
- The frame branch is taken for every caller. Edit profile's "What's on it" preview (`profile-edit-sheet.tsx` 301) therefore draws a whole kit page (`PageBody`, `data-public-profile-frame`) inside the dialog under a look, though the comment at 87-91 says the preview keeps the standard card. Add a prop (`preview`) and skip the frame branch there.

---

## s53-challenges and s54-challenges-full

**Files**
- Kit: `L/frame/challenges-frame.tsx` `ChallengesFrame` (26-96). Mounted by `L/challenges-pane.tsx` `ChallengesInFrame` (679-722), drawn at 792-794; the standard parts stay mounted and hidden (`app.css` 27285-27289).
- Standard: `L/your-standing.tsx` `YourStanding` (83-123, token 44-81); `L/season-progress.tsx` `SeasonProgress` (44); `challenges-pane.tsx` `Grid` (318-390), `LockedChallengesCard`. Stores: `myStandingStore` / `standingView` (`L/my-standing.js`), `topochainChallengesStore` (`grid.progress`, `grid.groups`, `grid.notice`, `lockedCount`, `onboardingEventId`).

**Today under a look**: title Challenges; purpose = "#16 of 149 ranked · pending · 15,128 pts · 10 of 11 done" joined; tabs. Main: one group per heading, open challenges as rows (trophy, name, state, points as grey words, chevron), done ones as short rows (green check, points). Side: Your standing as two figures (rank, points), the update note, the token row.

**Gap to v2**
1. Purpose: `leaderboard:standing.pointsNote`, fixed. Drop the joined sentence (pane 689-701, 713).
2. Main, first: a card with "**15,128 pts** · 10 of 11 done" over one bar. Data `grid.progress` (`done`, `total`, `points`), words `leaderboard:progress.summary` / `progress.plainLabel` with `challenges.points`, as `SeasonProgress` 53-80 (meter role and label included; green when all done).
3. Open rows: points as a `Pill`, not `Meta` (frame 88). Done rows: points in green (`Meta` has no tone).
4. Side: "Your standing" as one card: the rank large with "of N ranked" beside it (`standing.rankOf` / `standing.rank`; the pane already splits it at 703), then `standing.pointsNote` and `standing.updateNote` as two small sentences. Remove the `Facts` and the separate `Note` (frame 50-55). Keep `standing.pending` and the token rows (frame 56-78): today's card has them (your-standing 111, 120) and the mockup's person has none. Rank unknown: `standing.yourStanding`.
5. Side goes above the list on a phone (`sideFirst`).
6. Today's content the kit page drops, to add: the "first challenges" link (`onboardingEventId`, `leaderboard:challenges.toFirst`, pane 349-356) and the locked placeholder (`LockedChallengesCard count names`, pane 381-385; the kit shows `grid.notice` instead, which the standard hides when the placeholder is drawn). The error and empty grid states fall back to standard markup with the kit page absent (792): draw them in the kit page too, or the page loses its head and tabs there.

**Kit/CSS needs**: a thin progress bar (`gD-bar`; kit.css has only the ballot's `.bar2`), `.sub22`, `.sub15`, `.mut`, a padded card of text (`gD-stand`, `.txt` exists only under `.status` and `.post`), `Meta` tone `ok` (`.row .meta.ok`).

**Tests that pin it**: `tests/challenges-frame.test.js` (6 tests; "your standing as the one sentence" and "two figures and one note" assert what v2 removes), `your-standing`, `season-progress-render`, `challenge-groups`, `topochain-screens`, `screen-skeletons`, `challenge-detail-page`, `challenge-deep-link`, `desktop-layout-audit-6`.

**Size**: S to M. **Risks**: the standard grid stays mounted for the declared check on `#tc-se-challenge-summary`; keep that arrangement. A challenge's own page is not the kit's and is out of this step.

---

## s55-standings

**Files**
- Kit: `L/frame/challenges-frame.tsx` `StandingsFrameHead` (103-119), `StandingsFrameRows` (131-162). Mounted by `L/topochain-standings.tsx` `StandingsInFrameHead` (604-623), `Body` 424-441, pane 625-648. Layout by `app.css` 27293-27313 (flex order: head, event bar, body; body at 720px).
- Standard: `L/event-bar.tsx` `EventBarView` (150), `Hero` (96), store `event-bar-store.js`, `TopochainEventContext.select(id)`; `topochain-standings.tsx` `ChallengeLine` (155), `NonPodiumChip` (192), `YouLine` (260), `StandingsTable` (275), `DrillPanel` (554).

**Today under a look**: kit head (purpose = "#16 of 149 ranked") and tabs; then the standard picker and event card, full width; then one 720px column: the standard challenges line, disclaimer and chip, and the kit's rows under a "This season" label with the rank in a lead circle. The "You · #16 · …" line is not drawn (428).

**Gap to v2**
1. Purpose: `standing.pointsNote`. Drop the rank sentence (604-614); `MyStanding.load()` is then not needed here.
2. Picker under the tabs, in the kit's field. It is a native `<select id="tc-ev-select">` in another host (`#leaderboard-event-bar`); a declared check anchors on that id, so restyle that node (wear or classes), do not draw a second one.
3. Two columns. Side (above the list on a phone): "Event" card from the hero (`name`, `statusLabel` as a pill, `description`, `dates`, `seasonNote` → `eventBar.seasonNote`, `fallbackNote`), plus its loading, error and none states. The hero is drawn by `EventBar` outside the pane, so either the kit page reads `eventBarStore` and draws the card itself (and app.css hides `#tc-ev-hero` under `data-standings-frame`), or the two hosts are placed as grid columns in app.css. The first is simpler to keep right on a phone.
4. Main column: the challenges line with its link (`standings.challengesDone` / `viewChallenges`, `_goToChallenges`, id `tc-lb-to-challenges`) and the chip (`tc-lb-non-podium-toggle`, `aria-pressed`, `_toggleNonPodium`) as a small quiet button; then the You line as a lit one-row card (`standings.you`, `_openViewerRow`, id `tc-lb-you`): remove the `frame ? null` at 428; then the table card.
5. Table card: a header row from `view.headers[c]` (Rank, User, Season points), rank as plain figures in a 44px column instead of `Lead`, points in ink. Remove the group label (`standings.frame.season|event` become unused). Non-podium rows keep their line; the open row keeps `DrillPanel` under it.
6. A member without history gets no picker and no card (`history` false, event-bar 154): the page is then one column.

**Kit/CSS needs**: a select in the kit's field (kit has `Search` and `Field` only); `gD-rk`, `gD-th`, `gD-pts`, `gD-line`; `.sub22`, pill beside it.

**Tests that pin it**: `tests/standings-frame.test.js` (5 tests, including the app.css lines for the 720px rows), `tests/challenges-frame.test.js` 89 ("Standings wears the same head"), `standings-screen`, `topochain-screens`, `language-extraction`, `activity-row`, `screen-skeletons`, `qa-sweep-shared-polish`.

**Size**: M. **Risks**: the pane and the event bar are separate React hosts whose `hidden` the legacy `Leaderboard._applySection()` toggles; the current look relies on `display: contents` and flex order (app.css 27302-27306), which a two-column layout has to replace, not extend. The other body states (loading, error, private, no entries, all excluded) are standard markup inside the kit column.

---

## Work several steps share (do once)

1. **The You shell and its tabs** (s44 to s50): head (handle, facts, Edit profile), six tabs, and a tab state `ProfileRoot` owns. It needs addresses: today `#profile?friends|feedback|slots|edit` are one-shot flags that `Profile.open` takes off the address (profile.js 189-200, 715-830). Decide the tab addresses first, then make the Your work rows, the Friends row and `useFramePage` (crumb "You › Changes") follow them.
2. **Kit additions**, all from the tour's `kit.py` `KIT_CSS` and `screens_d.py` `CSS`, into `kit.css` with components in `kit.tsx`: bars chart; inset `Facts`; `.secnote`; `.sub22` / `.sub15` / `.mut`; `Head` lead slot; `Meta` tone; a number column and small-glyph rows; project head row; `.row.showall`; thin progress bar; red link; field with counter and a textarea; a kit select.
3. **The leaderboard head**: Challenges and Standings share title, purpose (`standing.pointsNote`) and tabs; make one head component for both.
4. **Catalog**: remove ids left unused (`profile:frame.week.*`, `profile:frame.copy`, `leaderboard:standings.frame.*`, maybe `leaderboard:frame.pair|pts|points`); new words only for "Projects", "All projects", "Overview", "Event" and the tab names where no id exists (`messages:ai.history.kind.*` covers Changes, Requests, Votes; `profile:friends.title` Friends).
5. **Rewrite the four frame suites** with the pages: `you-frame`, `challenges-frame`, `standings-frame`, `public-profile-frame`.

## Suggested order

1. Kit additions (2), with `tests/looks-css.test.js`.
2. s51, s52: small, and fixes the preview and the duplicate import.
3. s53, s54, then s55 (shared head; s55 last, it has the layout risk).
4. The You shell and Overview (s44, s45).
5. Friends tab (s49).
6. History tabs (s46 to s48).
7. Edit profile (s50), by dressing.

## Open questions

1. **Where do the old addresses go?** `#homeroom-bot/history?kind=…` opens the bot page today, and the standard look must keep that. Under a look, do the You rows and that address open the You tab, or does the bot page keep its History group as well? (v2 marks this "To decide".) Either way the tab needs an address of its own.
2. **The Feedback tab has no v2 mockup.** Today it is the dialog `P/feedback-sheet.tsx` over `view.feedback` (`feedbackListView`, store 561). Draw its list as the tab body in the same row form, or keep the dialog and leave the tab out?
3. **App slots** stays a dialog (`AppSlotsSheet`) in v2's Overview row; confirm.
4. **Notifications hint**: v2 says "here and in your inbox"; the catalog (this branch and main) says "here and in each app". Which is right?
5. **Standings picker for a member with no season history**: v2 shows the picker and the Event card; the product gives that member neither. Assumed: follow the product.
6. **Edit profile**: dress the product's dialog, or rebuild on the kit's `Sheet`? The answer changes the size from M to L.
7. No data or endpoint is missing for any of the twelve steps.
