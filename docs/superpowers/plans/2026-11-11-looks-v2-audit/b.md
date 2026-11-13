# Audit, group b: Messages and a project's pages (s15 to s31, s36, s37)

Checkout read: `/Users/salah/Dev/lingash/sv-skins` (`redesign/skins-2026-11-11`). Paths below are relative to it.
Short names: `WS` = `frontend/src/features/dev-board/workshop/workshop.tsx` (4,653 lines), `PF` =
`frontend/src/features/dev-board/workshop/frame/project-frame.tsx` (552), `MI` =
`frontend/src/features/messages/index.tsx`, `KIT` = `frontend/@/components/ui/kit.tsx`, `KCSS` =
`frontend/looks/kit.css`. "v2 css" = the `css` string of `tour-v2/site/proposals-v2.json`.

How the pages are wired today:
- Messages: `MI` `ConversationList` (758) branches at `if (frame)` (1025 to 1130): it builds `FrameInboxRow[]` from
  `found` and draws `MessagesFrameList` (+ `NewMessageSheet`). The conversation pane, reply thread and composer
  are the product's own, dressed by the wear map (`frontend/looks/looks.json` `wear.roots`: post, day, dhead,
  composer) and hand rules in `public/css/app.css` 27133 to 27144, 27390 to 27444.
- A project's page: `WS` `DevWorkshop` (3085). `frame` at 3096; kit props are built at 3797 to 4048 (`frameTabs`,
  `frameHead`, `frameWork`, `frameRule`, `frameAll`, `frameWorkshop`, `frameHub`) and drawn at 4068 to 4086, ahead
  of `{band}{tray}`. The standard body stays mounted in `.dev-ws-tabbody`; app.css 27166 to 27219 hides it for
  `data-project-frame="topics" | "workshop-kit" | "all-kit"`, and for `"status"` hides all but the ⋯ and five cards.

---

## s15-messages

- **Files**: kit `frontend/src/features/messages/frame-list.tsx` (`MessagesFrameList`, `FrameInboxRow`); wiring
  `MI` 1025 to 1130. Standard: `MI` `ConversationList` 1135 to 1296, `ConversationRow` (262), `GroupMemberCount`
  (218), `SectionHead` (653), `asides` (944), empty pane words `messages:thread.empty.title/body`.
- **Today under a look**: Head (Messages, "People and groups you talk to.", New message) · Tabs People (count)
  and Agents · a Search under the tabs ("Search people and messages") · one card of rows (face, name, last line,
  blue "N new" pill or grey time). Right pane: the product's "Choose a conversation" state.
- **Gap to v2**:
  1. Group rows: add the member-count pill after the name (v2 `.pill.gB-mc`, "3"). Data: `c.memberCount`, words
     `messages:inbox.memberCount` (as `GroupMemberCount`, `MI` 218). Needs a `titleEnd`/pill slot on
     `FrameInboxRow` (or pass `title` as a node).
  2. Search moves into the tabs row (v2 puts the field at the end of `nav.tabs`), placeholder "Search"
     (`messages:inbox.searchPlaceholder`), not `messages:frame.inbox.search`.
  3. People tab count: v2 shows unread from people. Use `unreadFromPeople` (already computed for `asides.people`,
     `MI` 946) in place of "rows with something new" (`frame-list.tsx` 54).
  4. Empty right pane: keep (`thread.empty.title`); v2 shows only the first sentence of `thread.empty.body`
     ("Your chats open here."). Product text is longer: keep the product's, or add a short id (open question 6).
- **Kit/CSS needs**: `Tabs` needs an `end` slot (search inside `.tabs`, v2 `.tabs .v`); a small count pill inside a
  row title (`gB-mc` in v2 css: 20px high, 8px pad). `gB-empty` is not needed (the product's own empty pane shows).
- **Tests that pin it**: `tests/messages-frame-list.test.js` (head, tabs, search, pills; test at line 83 reads
  `MI`), `tests/messages-inbox.test.js`, `tests/messages-screen.test.js` (read `MI`).
- **Size**: S. Three props and one slot. **Risks**: `MI` is read by 76 test files; add inside the `if (frame)`
  block only. `useSkin()` there is read after mount on purpose (hydration): do not move it.

## s16-messages-new

- **Files**: kit `frontend/src/features/messages/frame-new.tsx` (`NewMessageSheetView`, `NewMessageSheet`,
  `groupTitle`); opened at `MI` 1124/1127. Standard: `MI` `NEW_CHOICES` (525), `startNew` (534),
  `NewMessageButton` (559); then `create-dialog.tsx` (`messagesCreate` dialog, tabs Direct/Group, blocked people).
- **Today under a look**: a sheet "New message / One person is a direct message. Add more to make a group." with a
  To field, "People you talk to" rows (multi-pick), Start chat, "Or else → Agent chat", Blocked people at the foot.
- **Gap to v2**: the sheet holds three rows only, each with its line: Agent chat, Direct message, Group chat
  (`messages:inbox.new.{agent,direct,group}.{label,hint}`), title `messages:create.title` ("New message"), purpose
  `messages:inbox.new.menuName` ("Start a new conversation."). A press calls `startNew(key)`: agent →
  `startAgentSession({ entry: 'messages' })`; direct/group → `openDialog('messagesCreate', key)`, the product's
  own dialog (it already has search, group name, invite note and Blocked people). Remove: To field, people rows,
  Start chat, "Or else", the foot's Blocked link, `groupTitle` auto-naming and the sheet's own
  `createDirect`/`createGroup`/`listBlocks` state. `startNew` and `NEW_CHOICES` are module-private in `MI`: export
  them or pass `onPick` from `ConversationList`.
- **Kit/CSS needs**: none (`Sheet`, `Card`, `Row`, `Lead`). The create dialog must stay solid under see-through
  looks (`--dc-sheet` follows `--fr-solid` already, plan note of 10 Nov).
- **Tests that pin it**: `tests/messages-frame-new.test.js` (all seven tests describe the To-field sheet: rewrite),
  `tests/messages-frame-list.test.js`; create dialog: `tests/messages-screen.test.js`, `messages-inbox.test.js`,
  `qa-menus-keyboard.test.js`, `chat-sheets-audit.test.js`.
- **Size**: S. Mostly deletion. **Risks**: catalog ids `messages:frame.new.*` become unused (delete them with the
  code, `tests/language-extraction.test.js`); the standard dialog over the kit chrome on a phone is listed as
  "left as is" in the 11 Nov audit.

## s17-dm

- **Files**: no kit page. Standard `MI` `ThreadHeader` (1462), `threadWords` (1403), `ConversationThread` (2023),
  `composer.tsx`; wear map + app.css 27390 to 27444, 27871 to 27933. List beside it: `frame-list.tsx` (`on` row).
- **Today under a look**: the kit list with the open row lit; the product's header (face, name, "Direct message",
  full-width toggle, ⋯), days, posts in the kit's post style, the product's composer in the kit's composer shape.
- **Gap to v2**: none in content (v2 is today's pane). Only the list changes from s15 apply.
- **Kit/CSS needs**: none.
- **Tests**: `tests/messages-screen.test.js`, `messages-inbox.test.js`, `looks-css.test.js` (wear section).
- **Size**: S (nothing but s15). **Risks**: none new.

## s18-group

- **Files**: as s17. `GroupFaces` (`MI` 241; one face under a look, 246 to 249), `messages-dialog members`
  (`members-dialog.tsx`), quoted reply and thread cards: `message-row.tsx`, `ThreadActivityRow` (`MI` 2597).
- **Today under a look**: as s17 with "N members" (owner wording `header.subtitle.groupOwner`), the members button
  and ⋯; quotes, "N replies" and "replies in thread" cards are the product's markup, not in the wear map.
- **Gap to v2**: no content gap. Styling only: the quote (v2 `gB-q`: accent bar, author in accent) and the thread
  activity card (v2 `gB-act`: surface card, link in accent) are drawn by the product's classes with the standard
  look's colours. Add both to the wear map or hand rules so they take `--fr-*` tokens.
- **Kit/CSS needs**: wear rules for the quote block and the thread-activity card (`gB-q`, `gB-act` in v2 css are
  the reference); nothing in `KIT`.
- **Tests**: `tests/looks-css.test.js` (compiled section must equal the script's output), `messages-screen.test.js`.
- **Size**: S (CSS). **Risks**: after editing `frontend/looks/`, run `node scripts/build-looks-css.js` before
  `build:css` or `looks-css.test.js` fails.

## s19-thread

- **Files**: standard `MI` `ReplyThreadPanel` (2703; title `messages:replies.title` "Thread", count
  `messages:replies.count`, composer "Reply in thread…"). No kit file.
- **Today under a look**: the product's reply pane beside the conversation (desktop), a full page on a phone whose
  bar names it (plan, "Leftovers taken up").
- **Gap to v2**: content none. Layout: v2 draws it as the kit's right-hand panel over the conversation and a
  bottom sheet on a phone; today it is a third column / a page. Either restyle the pane as the kit `Sheet` shell
  by CSS (head = title + the group's name as the purpose line) or rule that the pane stands. Check that the
  pane's sub line says the conversation's name, as v2 does.
- **Kit/CSS needs**: none if ruled; else hand rules giving `.messages-reply-pane` the `.fr-sheet` surface.
- **Tests**: `tests/messages-screen.test.js`, `thread-page.test.js`, `keyboard-hold.test.js`.
- **Size**: S. **Risks**: the pane is resizable (`readReplyWidth`, `MI` 2690) and shared with a channel's thread
  (`AppReplyThreadPane` 3215) and the bot's Main chat (`inMain`): a restyle touches all three.

## s20-agents

- **Files**: kit `frame-list.tsx` (Agents tab); rows built at `MI` 1063 to 1103 (`mayor`, `session` entries).
  Standard: `MayorSessionRow` (`MI` 1863), `AgentSessionRow` (480), `shownInSection` (`inbox.ts` 267),
  `agentsExpanded` (950), archived toggle (957, 1012 to 1023), `changeRowWords`.
- **Today under a look**: purpose "Older chats with coding agents. New work with the bot is in the Homeroom bot
  tab.", its own search, a group label "N older chats", every agent chat as a row: title, "project · when", a
  status pill from the active change (or nothing).
- **Gap to v2**:
  1. Purpose: "Chats with coding agents." (drop the sentence pointing at the bot tab; new id or edit
     `messages:frame.inbox.agentsPurpose`). Remove the "N older chats" group label
     (`messages:frame.inbox.agentsCount`).
  2. Folding as the product: this week's chats (at most `AGENTS_SHOWN`), then one centred row
     "N older chats" / "Hide older chats" (`messages:inbox.older.show/hide`), then the older ones when open. Use
     `shownInSection('agents', entries, { expanded: agentsExpanded, searching, openKey, keep: asksForYou })`
     exactly as the standard list does (`MI` 1210 to 1224); `agentsExpanded` state already exists.
  3. Row line as the product's `MayorSessionRow`: `dotText([focusApp.name, state])` where state is
     `changeRowWords(change)` or `messages:agent.row.noChange` ("No active change"), with the date after it when a
     change is active ("Homeroom · Handed off · Oct 29"). Row end: the state pill when a change is active
     (ok for Ready/merged), else the date as `Meta`. Today the kit line is "project · when" and "No active change"
     is never said.
  4. Show archived / Hide archived (`messages:inbox.archived.*`, `archivedToggle` `MI` 1012) is missing under a
     look: add it as the last row and the archived group under it (`archived`, `readArchived`).
  5. Search field as s15 (in the tabs row, "Search").
- **Kit/CSS needs**: a centred link row inside a card (v2 `.row.showall`: centred, accent, 13px; not in `KCSS`).
- **Tests**: `tests/messages-frame-list.test.js` (test at 66 pins the Agents sentence, search and count),
  `tests/agent-chats-menu.test.js`, `messages-inbox.test.js`.
- **Size**: M. Rows, fold and archive need threading through `FrameInboxRow`. **Risks**: the fold state and the
  scroll anchor (`list-place.ts`, `orderKey` `MI` 994) are shared with the standard list.

## s21-communities, s22-communities-full (RETIRED)

`#communities` is rewritten to Home by the router (One Home); under a look that is `home/frame/home-frame.tsx`.
The kit still has an "All communities" page inside Home (`home/frame/home-all-communities.tsx`, opened by
`Home.showCommunities({ all: true })`), which is Home's (group a, s04). Nothing to remove for these two ids;
no code is keyed on them.

## s23-hub, s24-hub-full, s36-pourover-hub

- **Files**: kit `PF` `ProjectHubFrame` (116), `useActs` (54); props `WS` `frameHub` (3973 to 4044), `frameWork`
  (3831), `frameRule` (3842). Standard: `community-card.tsx` `CommunityCard` (924; Open app 1011, Invite 1200,
  Join 1127), `HeroActive` (599), `HeroCount` (558); `hub-cards.tsx` `ForYouCard` (702), `NeedsRow` (547),
  `NothingToVote` (489), `WorkshopRow` (596), `DiscussionRow` (621), `TopicsCard` (757), `RecentlyLive` (971);
  `actions-row.tsx` `DevPlusMenu`.
- **Today under a look**: Head (name, description; Invite + primary "Ask for a change" or Join; the hero's ⋯
  pinned at the head's end by app.css 27191 to 27208) · tabs · main: For you (Needs you row or quiet row, **Your
  work** row, #general row) · Recently live as **plain rows** ("Built by x") · Topics (3 + "All N") · side: People
  (active this week; audience + members) · **How a change goes live** · **The app** (Open).
- **Gap to v2**:
  1. Head: add the project's tile before the title (`app.iconUrl/iconEmoji`, Homeroom mark for the platform).
     Buttons become the hero's: **Open app** primary when `!actions.selfHosted`
     (`App.openAppTab(slug,'app')`, already in `frameHub` 4041; label `project:communityCard.openApp`), **Invite**
     line button (`inviteHere`), Join for a non-member, ⋯ as today. Remove **Ask for a change** (`onAsk`,
     `project:frame.ask`) from every project page head.
  2. For you, second row: always the **Workshop** row ("Workshop / What happened, and every item",
     `project:hub.workshop.sub`, `onWorkshop`), shown when `v.mine?.viewer` as `ForYouCard` does. Remove the Your
     work row from the Hub (`work` prop).
  3. For you, third row title: "Discussion #general" (`project:hub.forYou.discussion.title`, handle muted), line
     "@user: message · ago" (`hub.forYou.discussion.lastBy/last/postedBy/posted`), not "#general" with the time
     at the row's end. Unread pill stays.
  4. For you with no vote owed (s36): the quiet **line**, not a row: "Nothing more to vote on · N requests nobody
     has picked up" with the phrase a link to the Workshop (`project:hub.needs.noneButRequests`,
     `requestsAlone`, `none`; logic `NothingToVote` 489 incl. `alone`). Today the kit draws a "Needs you" row with
     `hub.needs.none` and never names the requests (`claims` is computed at 3982 but only gates the row).
     Also carry `hub.needs.joinToVote` under the Needs row for a non-member (`NeedsRow` 588).
  5. Recently live: three **picture cards** (v2 `.shots.s3` > `.shot` > `.pic` + `.cap2`: title bold, "who · ago"
     or "who · going live now"). Data is in `v.recentLive` rows: `picture`, `who`, `at`, `going`; fallbacks as
     `RecentlyLive` 1023 to 1035 (the app's tile, clock/check glyph) and the "own" card before anything went live
     (`ownLive`, `liveSinceLine`). Words `project:hub.recent.byAgo/byGoing/going`. Drop `frame.hub.builtBy`.
  6. Topics group: desktop none (v2 s23/s36 have no Topics group; the Topics tab holds them). Phone only (s24
     `.sec.p`): every live topic as a row: icon, "Name #handle", about line, unread pill, "Show N more" after six
     (`TopicsCard` 757, `HUB_TOPICS_SHOWN`). Today the kit shows three at every width with "All N".
  7. Side column: People only. First row gains the faces stack (up to five + "+N", `HeroActive` 599,
     `hub.people.moreFaces`); second row "Public community / 235 members" as today. Remove **How a change goes
     live** (`rule`) and **The app** (`app`) groups.
  8. Not in v2's drawing but in today's Hub and already kept behind the kit (app.css 27181): first-version card,
     update card, Share it, start-here, From its versions, the notification ask. Keep as they are.
- **Kit/CSS needs**: `Head` needs a `lead` slot (tile before the title; v2 `.head` starts with the tile). A
  picture-card group: `KCSS` has `.shots/.shot/.pic/.cap2` (207 to 212) but `.shots.s3`'s phone rule is only in v2
  css, and `KIT` has no component (the guest page writes `fr-shots` by hand,
  `features/guest/frame/project-frame.tsx` 29, 207: lift that `Shot` into `KIT`). An avatar stack: `.avs` is in
  `KCSS` (98, 99), no `KIT` component. A quiet line inside a card (v2 `.gC-quiet`). `.mut` inside a row title
  (v2 css) for "#general".
- **Tests that pin it**: `tests/project-hub-frame.test.js` (tests at 45, 54, 65, 74, 86, 96 pin two actions,
  "your work with the bot", rows with who built, the three side groups), `tests/guest-project-frame.test.js`,
  `tests/frame-app.test.js`; standard sources read by `community-hub.test.js`, `community-hub-details.test.js`,
  `community-card.test.js`, `hub-just-you.test.js`, `hub-first-day.test.js`, `polish-final-shape.test.js`.
- **Size**: M. One presentational file and `frameHub`; three small kit additions. **Risks**: `WS` is pinned line
  by line by about 50 suites (`{band}\n{tray}`, the hub-cards import line, `{tab === 'status' ? (pending ? null : (`):
  edit only inside `frameHub`/`frameHead`. The ⋯ is the hero's one node moved by CSS (27191 to 27208): the head's
  `margin-inline-end: 48px` assumes the acts end the row. A phone-only group must be CSS (`.p`), not a media
  hook, to avoid a first-paint flip.

## s25-places

- **Files**: kit `PF` `ProjectTopicsFrame` (244); state `frameTopics` (`WS` 3099), drawn 4068 to 4082. Standard:
  `project-places.tsx` `ProjectPlaces` (180), `placeRows` (74), `places.ts` `liveTopics`, `channelsOf`.
- **Today under a look**: Head (Topics, a two-sentence purpose, primary "Propose a topic") · tabs · main: Channels
  (#general) then Topics, each row with "N open requests · about" and an unread pill · side: "About topics /
  Changed by a vote".
- **Gap to v2**: purpose is the first sentence only ("Each topic is a channel and a category of work."). Remove
  the Propose button (`onPropose`) and the About group. Main = **Topics** only; side (first on a phone) =
  **Channels** with `general`. Rows are the name alone as the places list says it (`placeRows(...).topics[].label`,
  `.general.label`), hash lead, no line; keep the unread count the places list shows (`count`). Remove
  `requests`/`about` from the rows.
- **Kit/CSS needs**: none (`PageBody sideFirst`).
- **Tests**: `tests/project-hub-frame.test.js` (116 "Topics is a page of rows: #general, then each topic with its
  open requests…", 181).
- **Size**: S. **Risks**: Topics has no address (`frameTopics` is local state; a reload lands on the Hub). Propose
  a topic stays reachable in Settings & rules › Topics only: confirm that is acceptable.

## s26-needs

- **Files**: kit head only: `PF` `ProjectFrameHead` (77) at `WS` 4086, purpose `project:frame.place.needs`.
  Standard: `features/review-flow/review-flow.tsx` `ProjectReviewFlow` (1009), `ReviewFlow` (524), `ChangeBody`
  (287), `Strip` (218); `vote-sheet.tsx` `VoteSheet` (96); `compare.tsx`; `model.ts`; feed
  `GET /api/workshop/needs-feed`.
- **Today under a look**: kit head + tabs, then the product's review stage unchanged (its own bar with back,
  title and ⌄; one claim line; the picture sheet with plates and a strip; the vote row Yes | No + Skip/Next at
  the foot; help in the ⌄ card: Ask privately, Discussion, Try it). app.css 27213/27217 lets it span the width.
- **Gap to v2**: v2 lays the same item in two columns:
  - main card: a cap ("Change · Waiting for your approval"), "author · ago", the title (17px), the summary with
    "more", Before/After pictures with four view buttons, one tally line ("0 of 1 approval · your yes puts it
    live");
  - side "Your vote": Yes | No, Skip, a hint line; then a card of rows: Comments (count), Ask, Try it, More.
  From the product: title, summary, author (`item.title`, `item.summary || item.line`, `item.author`), pictures
  (`item.screens`, `CompareSlider`), Yes/No with the No-reason sheet (`VoteSheet` states `reason`, `voted`), Skip
  and Next (`onSkip`, `onNext`, `left`), help sheets `askq` / `talk` / `try`, the change's page link
  (`review.more.open`). Purpose: "The changes in {project} that wait on your vote, one at a time." (new words;
  today `frame.place.needs` says "What waits for your vote in {project}.").
  Doing it means a kit view over `ReviewFlow`'s state (run order, votes, sheet state, push animation), not CSS.
- **Kit/CSS needs**: `.status` (in `KCSS` 122), `.shots/.pic` (207), `.sub17` (121); missing: `.sub15`, `.sub13`,
  a two-button pair (v2 `gB-pair`), the view-mode buttons (`gB-views`), the item card (`gB-item`, `.by`).
- **Tests**: `tests/review-flow.test.js`, `needs-auto-advance.test.js`, `needs-vote-filter.test.js`,
  `needs-feed-advisory.test.js`, `workshop-vote-row-noun.test.js`, `shots-closeups.test.js`, `thread-page.test.js`,
  `needs-vote-inline.test.js`, `project-hub-frame.test.js` (96: "a place that is not the Hub keeps the head").
- **Size**: L. The stage measures itself (`heroHeight`, `pageRoom`, pointer gestures, FLIP between changes);
  splitting it into two columns is a second view of a 1,000-line component. **Risks**: see open question 1: several
  of v2's words do not exist in this source.

## s27-workshop, s28-workshop-full, s37-gamecorner-workshop

- **Files**: kit `PF` `ProjectWorkshopFrame` (317); props `WS` `frameWorkshop` (3909 to 3972), `frameRule` (3842),
  `frameWork` (3831). Standard (`WS` 4296 to 4424): `DashTiles` (946), `BotSlotsDoor` (`bot-slots.tsx` 128,
  `doorWords` 114), `ApprovalLine` (`community-card.tsx` 1639; `ruleSentence` 1561, `approvalStep` 1411),
  `YourWorkCard`/`YourWorkRow` (`your-work.tsx` 75/37; `FirstChangeCard`), `ThisWeek` (`week-pages.tsx` 345),
  `HappenedRow` (273), `WeekRow` (222), `clearSince`, `freshAct`, `PrivateRequests`.
- **Today under a look**: Head (Workshop, sentence; **All items** + **Ask for a change**) · tabs · main: "Where
  things are" (four figures, no sub-lines) · **Needs your vote** ballot card ("Review and vote") · Your work
  (one row, tool glyph) · **Recently live** rows · "Week by week" (four week rows) · side: Homeroom bot · Who
  decides ("N of M members say yes") · **Nobody is on these** (three requests + All N).
- **Gap to v2**:
  1. Head: no buttons (remove the `second` All items button and Ask for a change).
  2. **Overview** (label `project:workshop.part.overview`): one card with a head row "All items" + "See all"
     (`workshop.allItems.title`, `seeAll`, `seeAllFiltered` with the filter dot when `v.meta.filtered`; opens
     `openTab('all')`), then the four figures with their sub-lines: "N on you" under waiting on votes
     (`workshop.dash.onYou`, `owed`), "from N by this time last week" under live this week
     (`workshop.dash.fromLastWeek`, `d.shippedPrevWeekToDate`, `d.partial` → "N+"). Each figure keeps its press:
     votes → the one waiting item or All items (`v.dashboard.votesWaitingRefs`, `WS` 4347 to 4351), the others →
     `callAppView('openWorkshopStage', key); openTab('all')`. Today `Facts` has neither subs nor presses.
  3. **Your work**: a second card in Overview: the bot's avatar (`BOT_AVATAR`), "Your work", line "Next: …"
     (`deskLine`), right "Needs you: 8 · In progress: 5" (`deskWords`, `RichMessage` with the accent number), link
     `projectTabAddress(slug)`. Only for `v.mine?.viewer`. Keep `FirstChangeCard` in its place for a newcomer
     (`useFirstChange`), which the kit does not draw today.
  4. Remove: the ballot ("Needs your vote"), Recently live, "Nobody is on these" (and `unclaimed*` props).
  5. **What happened** (label `workshop.part.happened`, action "Mark all seen" = `clearSince`, disabled when
     `!sinceRows.length`): one card: "Nothing new since you were last here." when `v.since && !sinceRows.length`;
     the This week head row ("This week  9 Nov → now", "+N new", "116 live": `weekName`, `weekRange`,
     `weeks.row.fresh`, `weeks.row.live/liveAtLeast`); this week's item rows (new first, max 10, then 3 seen:
     `THIS_WEEK_NEW_MAX/SEEN`), each: new dot, title link (opens the side panel through `openItem`), "You" pill
     (`happened.row.you`), "Going live" pill, stuck pill, ago, and Build it on a new unclaimed request
     (`freshAct`); a centred "All of this week" row (`openWeekPage`); then past weeks as rows (`weeksShown`,
     `WEEKS_FIRST`=2: "Last week 2 Nov – 8 Nov … 390 live"); a centred "Earlier weeks" row (`setWeeksShown`) or
     the "This project started…" note. Today the kit lists four week rows and no items.
  6. Side **Homeroom bot**: keep; title "Building N of M", line "N waiting for votes · N requests in line"; lead
     is the bot's mark, not the spark glyph. Opens `openTab('bot')`.
  7. Side **Who decides**: say the product's sentence, not the kit's short form: title from `ruleSentence(...)`
     (names when `anyOf/allOf`, e.g. "evan or snait says yes"), line the wait (`approvalStep(...).wait`) or
     "After the checks pass"; group action **Rules** (`communityCard.rule.rules`) for `community.can_manage`,
     opening `UsernodeReact.dialogs.whoDecides`. Needs the approvers' names: `useApprovers` is private to
     `community-card.tsx` (1361); export it or lift the read. v2's words drop "A change goes live when"; the
     catalog's `communityCard.lineShort.*` may already be that form (check before adding ids).
  8. `PrivateRequests` (admins) is hidden under a look today (the tabbody is `display:none`): add it under What
     happened or leave it visible below the kit page.
- **Kit/CSS needs**: `Facts` items need `sub` and `onClick`/`href` (v2 `.fact .l.sub`, `.fact .v.wait`); a card
  head row (v2 `.row.sm.headrow`); week and item rows (v2 `.row.week`, `.row.item`, `.row .meta.ok`); the centred
  link row (`.row.showall`); a `Sec` action that can be disabled. None of these five rules is in `KCSS`.
- **Tests that pin it**: `tests/project-workshop-frame.test.js` (38 "All items beside Ask for a change", 53
  ballot, 67 "your work, what went live, and the weeks before", 79 "the requests nobody is on": all rewritten);
  standard: `tests/dev-workshop.test.js`, `polish-final-shape.test.js`, `title-hints.test.js`,
  `tap-targets-contrast-aria.test.js`, `who-decides-model.test.js`.
- **Size**: M to L. The week card is the bulk: rows, the side panel's lit row (`sideKey`), Build it. **Risks**:
  hooks in `WS` must sit at the top of `DevWorkshop` (React #310 was hit once). `HappenedRow` carries
  `data-ws-row`, `data-ws-open` that declared checks and `dev-workshop.test.js` select on in the standard body;
  the kit rows are a second drawing, so keep the standard ones mounted (hidden) as now. A week's own page and the
  bot's slots page stay standard bodies under `ProjectFrameHead` (`frameWorkshopUp` excludes `weekUp`).

## s29-all-items, s30-votes-waiting

- **Files**: kit `PF` `ProjectAllItemsFrame` (449), `AllItemRow`, `COL_STOP`; props `WS` `frameAll` (3865 to 3907),
  `frameKanban` (3161), `frameStage/frameMine/frameQuery` (3130). Standard (`WS` 4448 to 4648): `GroupStrip`
  (2683, `AppView._setWorkshopGroup`), `DevActionsRow` (`actions-row.tsx` 612) hosting `KanbanFiltersView`
  (`kanban-filters.tsx` 232; store `kanbanFiltersStore`: `q`, `count`, `chips`, `quick`), `SORTS` (861) +
  `sortKey` state (3101) + `orderThemesStable` (807), `ThemeCard` (369), `Lane` (293), `Faces` (338),
  `groupingNote`, the foot note (4628), `StageStrip` + `DevKanban` (By stage), `EmptyNote`.
- **Today under a look**: Head (All items, "N open requests and changes in P, newest first.", Invite + Ask) ·
  tabs **All / the board's columns** · a search of its own (client-side over titles) · one flat card of rows with
  the five-stop line and a word or pill · side: Show (Everyone's / Only yours) and Topics (people · items). s30 is
  this page's In review tab.
- **Gap to v2** (s30 is the same page; nothing separate to build):
  1. Purpose: "Every request and change in {project}, grouped by category or by stage." No head buttons.
  2. Tabs are the grouping: **By category / By stage** (`project:allItems.group.category/stage`), current from
     the published group (`group` in `WS`), press `callAppView('_setWorkshopGroup', key)`. Remove the stage tabs,
     `frameStage`, `COL_STOP`, `Track mini`, the flat list and `frame.allItems.all/open/purpose`.
  3. Search in the tabs row, placeholder `project:filters.search.placeholder`, driving the board's own filter
     (comments and `#` included, server `/board-search`), not a local title match. `AppView._onKanbanSearchInput`
     (`public/js/app-view.js` 15880) reads `#dev-kanban-search` from the DOM, so a kit field needs either a new
     `AppView` setter taking the text, or to be that node. Value from `kanbanFiltersStore.q` (+ `seq` as key).
  4. By category, main column: label "Topics · N categories" (`allItems.themes.topics` + `groupingNote`), one
     `hcard` per theme with a topic, then "Other categories" (`allItems.themes.other`). A card: icon (or letter on
     `swatchFor`), name, "N people | N items" (`allItems.theme.stat.*`), the saying (`theme.saying ||
     theme.description`), chips (+N new, in review, underway, open, live this week: `allItems.theme.chip.*`),
     faces (`theme.people`, 4 + "+N"), "Discuss in #channel ›" (`allItems.theme.discuss`,
     `placeHref(slug, channelPlace(handle))`, `openTab`) or the foot line for a category with no channel. Source:
     `themes` as `WS` already orders them. A card still opens to its lanes (`isOpen/toggleTheme`, `Lane`, "Open on
     Board ›"), and the foot note (`aiFootnote` …) and `EmptyNote` stay. `ThemeCard`, `Lane`, `Faces` are private
     to `WS`: draw them in the kit as a new view fed by `themes`, or keep the standard cards and wear them by CSS.
  5. By stage: the product's board (`StageStrip` + `DevKanban`) under the kit head, full width. Today the tabbody
     is hidden for `all-kit` (app.css 27167): show it for By stage (a distinct `data-project-frame` value).
  6. Side **Show**: three rows: Filters (opens `AppView._openKanbanFiltersDialog`, count from
     `kanbanFiltersStore.count`, active chips with their × = `_dismissKanbanFilter`), Assigned to you and
     the second quick filter, each a toggle (`_toggleKanbanQuickFilter('assignedToMe' | 'yours')`, pressed from
     `store.quick`; hidden when `quick` is null). Remove Everyone's / Only yours (`frameMine`).
  7. Side **Order categories** (`allItems.sort.label`): By people / By activity / By open items (`SORTS`), pressed
     = `sortKey`, press = `captureThemeTops(); setSortKey(key)`. Category view only. Remove the side Topics list.
  8. s30: the Workshop's "waiting on votes" figure already routes (one waiting → its page, else All items); with
     the In review tab gone there is nothing else to build.
- **Kit/CSS needs**: `.hcard`, `.s2`, the theme head/foot (`gB-th`, `gB-tf`, `.stat`), count chips with a dot, a
  pressed row with a check (exists: `Row on pressed`), the tabs-row search slot (as s15). None of the first three
  is in `KCSS`/`KIT`.
- **Tests that pin it**: `tests/project-all-items-frame.test.js` (all seven tests: rewrite),
  `tests/dev-kanban-filters.test.js`, `dev-workshop.test.js`, `dev-board-island.test.js`,
  `community-hub-details.test.js`, `polish-final-shape.test.js`; `frame-app.test.js` (bar trail).
- **Size**: L. A new kit view for the category cards with their open state, plus re-plumbing search and filters to
  the board's own. **Risks**: two search fields with one id if the standard bar stays mounted; the board buckets
  its columns only while By stage is up (`frameKanban` exists for that reason and can go once the flat list goes);
  `orderThemesStable` holds card order across re-sorts using measured tops (`themesRef`), which a second drawing
  would not feed; the filters persist per project in localStorage (#6509), so the kit must show active chips or a
  narrowed page explains nothing.

## s31-general

- **Files**: kit head only: `PF` `ProjectFrameHead` (77) with `page` unset, title `pageTitle('discussion')`,
  purpose `project:frame.place.channel` ("Where {project} talks."). Standard: `project-discussion.tsx`
  `GeneralChannel` (165) → `ChannelHead` (`channel-head.tsx` 41; mute `PUT /api/apps/:slug/channels/general/mute`,
  `generalMuted`) + `EmbeddedConversation` (`MI` 3306); the shared row and day label (`@/components/ui/chat.tsx`)
  emit the kit's post under a look; composer `messages/composer.tsx` with its formatting row.
- **Today under a look**: kit head + tabs; under it the product's channel: a line "Where everyone in P talks ·
  235 members" with the Mute pill at its end, then the transcript in a card and the composer.
- **Gap to v2**: purpose = the product's own sentence (`project:places.generalHead.about`, "Where everyone in
  {project} talks."), replacing `frame.place.channel`. Two columns: transcript (card) in the main column with the
  composer docked under it; side group **This channel**: one row "235 members"
  (`places.generalHead.members`) ending in the Mute / Muted button (state and write from `ChannelHead`). The
  standard `ChannelHead` line is then put away under a look. Title "#general" (`frame.hub.channel` with the
  handle). A topic's channel (`TopicChannel` 367) keeps its own head, figures and signals (the `page: 'channel'`
  case): unchanged.
- **Kit/CSS needs**: none in `KIT` (`Row` + `Btn small kind="line"`). Layout: the transcript and composer are
  siblings the product owns (`.dev-ws-discussion`), so the column is either CSS (as the request page's
  `side-stack.ts` measured column) or `ChannelHead` rendered a second time by the kit page in a `Cols` side.
  Reactions (v2 `gB-rx`) and quotes (`gB-q`) need the same wear rules as s18.
- **Tests**: `tests/channel-head.test.js`, `discussion-in-hub.test.js`, `homeroom-discussion-in-place.test.js`,
  `community-hub.test.js`, `keyboard-hold.test.js`, `project-hub-frame.test.js` (181).
- **Size**: M. **Risks**: the chat fits its box by measured height on a phone (the visual pass fixed it running
  under the tab bar); a side column changes that box. `ChannelHead` owns optimistic mute state: one owner only
  (lift the hook, do not mount two).

---

## Shared work (do once)

1. **`KIT`/`KCSS` additions** used by several steps: `Head` `lead` slot (s23, s24, s36); `Tabs` `end` slot for a
   search (s15, s20, s29); `Facts` `sub` + press (s27, s37); `Shots`/`Shot` picture cards lifted from the guest
   page (s23, s36; also s26); `Avs` face stack (s23, s29); centred link row `.row.showall` (s20, s27); card head
   row `.headrow`, `.row.week`, `.row.item`, `.meta.ok` (s27); `.hcard` family (s29); `.mut` in a title. Copy the
   rules from v2 css into `frontend/looks/kit.css`, then `node scripts/build-looks-css.js`, then `build:css`.
2. **Project page head**: remove Ask for a change and the Workshop's All items button from `useActs` (`PF` 54) and
   `frameHead` (`WS` 3827) once, for Hub, Topics, Workshop, All items, Needs you and channels.
3. **Wear rules** for a quoted reply, the thread-activity card and reactions (s18, s19, s31).
4. **Catalog**: delete the `project:frame.*` and `messages:frame.*` ids that go (ask, hub.rule, hub.app, hub.openApp,
   hub.builtBy, hub.allTopics, topics.propose/about/byVote*/requests*, workshop.where/needsVote/yourVote/yes/noMore/
   noPassed/needed/review/weeks/unclaimed/all, rule.*, allItems.* except what stays, inbox.agentsCount, new.*), and
   reuse the product's ids named above. English only; never touch other languages' catalogs.
5. **Tests**: the five kit suites (`messages-frame-list`, `messages-frame-new`, `project-hub-frame`,
   `project-workshop-frame`, `project-all-items-frame`) are rewritten with their pages; `looks-css.test.js` follows
   the compiled section.

## Suggested order

1. Shared kit/CSS additions (1) and the head buttons (2).
2. s15 + s20 + s16 (one file pair, small).
3. s23/s24/s36 Hub.
4. s25 Topics.
5. s27/s28/s37 Workshop.
6. s31 #general, with the wear rules for s18/s19.
7. s29/s30 All items.
8. s26 Needs you, after open question 1 is answered.

## Open questions

1. **s26 was drawn from the 6 Nov capture, and this source differs.** No string in `frontend/locales/en/` says
   "press ↓ or scroll for the next", "swipe up for the next", "0 of 1 approval · your yes puts it live" or a
   "Change · Waiting for your approval" cap on this page; the help rows are "Ask privately", "Discussion", "Try
   it" (no "Comments (N comments)", no "More"); the picture is the sheet of plates with a strip, not a
   Before/After pair with four view modes; the change's author has no "ago" (`item.author` only). Either the
   mockup is redrawn from `review-flow.tsx`, or new words, a comment count and a tally sentence are product work
   (the feed gives yes/no counts through `voteTallies`; "your yes puts it live" needs the rule per item).
2. **s29 "Created by you"**: the product's second quick filter is labelled "Yours" (`project:filters.quick.yours`).
   Rename in the catalog (a product copy change) or keep "Yours".
3. **s27/s37 Who decides wording**: v2 says "evan or snait says yes" and "11 of the 41 active members approve it"
   with the wait as a second line "After its checks pass. Or after a wait, if one approves and nobody objects.".
   The product has the full sentence (`communityCard.rule.*`/`line.*`), a short form (`lineShort.*`) and a wait
   phrase (`step.*.wait`). Confirm which existing ids give v2's two lines, or accept the product's sentence.
4. **s25**: with Propose a topic gone from the page, is Settings & rules › Topics the only door (as today)? And
   Topics still has no address under a look.
5. **s19**: the reply thread as the kit's panel/sheet, or the product's pane as ruled on 10 Nov?
6. **s15**: the empty pane's second sentence is cut in v2 ("Your chats open here."); the product's says more.
   Product words win unless told otherwise.
7. **s23 People tab count and faces**: `activity.active_people` returns at most a handful of names; v2's "+23"
   face needs only the count (have it). No missing data.
8. **s24 on a phone** lists the Topics on the Hub while the Topics tab also exists under a look: both, or drop
   the phone group now that tabs reach every place?
