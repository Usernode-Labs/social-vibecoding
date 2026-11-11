# The looks, version 2: the first tour's layout, today's content — programme

> **For agentic workers:** one lane at a time per worktree; each lane reads its audit file first
> (`2026-11-11-looks-v2-audit/<group>.md`) and keeps its own task list.

**Goal.** Under each of the nine looks, every page draws **version 2** of the screen tour: the
layout of the first tour (the kit's frame, the title with its sentence, tabs across a page, two
columns, the kit's components) holding **the content of the product as it is today** (the
standard, no-look page: every section, text, control and feature it has, and nothing it does not
have). The standard look is not touched.

**Why (the owner, 11 Nov 2026).** The first programme (`2026-11-09-every-screen-in-the-kit.md`)
drew the first tour's mockups, which changed what pages contain: sections invented, merged or
dropped. The owner wants to keep the structure and content of the current design, which is well
worked, as the reference, and improve it later. He approved version 2 of all 112 screens:
<https://claude.ai/artifact/SARdBCdAGXpDy4z9H7k2hz> (switch "Today's content (v2)"). Its
sources, one outline per step (`python3 outline.py <step>`), are in
`/Users/salah/Dev/lingash/skins-tour-v2/tour-v2/`.

**The rule, when the two halves disagree.** Content always follows today's page. Layout follows
the first tour, except where the first tour's layout exists only to hold content today's page
does not have (then it goes with that content). A page the product no longer has (Discover, the
app detail page, the Communities list) is not drawn.

**Architecture: unchanged.** The kit's stylesheets (`frontend/looks/`, compiled by
`scripts/build-looks-css.js` into app.css's looks section), the kit's components
(`frontend/@/components/ui/kit.tsx`), the frame (`features/frame/frame-app.tsx`), kit pages
mounted as the first child of their screen, and the wear map for surfaces the product keeps
drawing. Version 2 changes what the kit pages hold, and prefers **wearing** the product's own
markup wherever the product's renderer is the content (conversations, sheets, static Settings
panes, the review stage), since that cannot drift from today's content.

**Reuse, do not rewrite.** Every addition names, in its audit file, the component, hook, store,
handler and catalog id of the standard page it comes from. A kit page binds that data to kit
components; it does not fetch or word anything on its own.

## Rulings taken with the plan (the owner may overturn any)

- **The chrome keeps its 10 Nov form**: the Homeroom mark and the look picker at the bar's end
  (the mark is the door to "Feedback & info"). The sidebar's You row opens the profile and its
  glyph Settings, as the standard rail does. The kit's account menu sheet goes (today has none).
- **Needs you** is today's review stage wearing the look; its mockup (s26) is redrawn from it.
- **New thread** stays where today opens it (the column on a desktop), wearing the kit.
- **Notifications and "Feedback & info"** are the product's own sheets wearing the look.
- **Gated addresses** behave as today: the bar names the place, an outline, the sign-in sheet.
- **A waiting account** keeps today's chrome (no member sidebar); w03, w12 and w13 are redrawn.
- **Settings' static panes** get neutral wrappers and stable `ui-*` names in the shared markup,
  dressed through the wear map; only React-owned panes may branch on the look.
- **Your changes / requests / votes** are tabs of You, fed by the bot's History for that kind.
- **Edit profile** is the product's dialog wearing the look.

## Lanes

| Lane | Screens | Audit | Size |
|---|---|---|---|
| P0 | Kit additions every lane needs (below) | all | M |
| H | Home (s01–s04), notifications and menu sheets (s05–s07), chrome | a | L |
| B | Homeroom bot lists and column (s08–s14) | a | L |
| M | Messages (s15–s20) | b | M |
| P | A project: Hub, Topics, Workshop, #general, All items (s23–s31, s36, s37) | b | L |
| T | A request and a change (s32–s35), the running app (s38) | c | L |
| Y | You and its tabs, edit, public profiles (s44–s52), Challenges, Standings (s53–s55) | d | L |
| S | Settings (s56–s73) | e | L |
| G | Signed out (o01–o27) and the waitlist (w01–w14) | fg | L |
| K | Make and Import (s42, s43), then Needs you (s26) | c, b | L |

**P0, the kit additions (one commit, before any lane):** `Head` slots (a line over the title, a
leading tile or avatar, a 13px line under the title); `Tabs` end slot (a search field); `Facts`
sub-line, tone and press, and a card-less form; a picture card and its grid (lifted from
`guest/frame/project-frame.tsx`); an avatar stack; flipped columns (`.cols.flip`); `.sub22`,
`.sub15`, `.sub13`, `.mut`; `.secnote`; a wrapping row (`.row.wrap` for title and line, so a
switch's sentence is never cut); `.row.showall`, `.headrow`, `.row.week`; `.hrow`/`.hcard`;
the week's bar chart; a thin progress bar and a meter; `.cap.over`, `.cap.sub`; a narrow page
(`.inner.narrow`); `Field` with a textarea, a counter and an after-slot; a select; an event
line (`evt`) as a wear root. Each lands in `frontend/looks/kit.css` (tour notation, kit tokens
only) and `kit.tsx`, compiled with `node scripts/build-looks-css.js`, pinned in
`tests/looks-css.test.js` / the kit's suite. The mockups' own extra CSS (`KIT_CSS` in the
builder's `kit.py`) is the reference for each rule.

**After P0 the lanes are independent** except for: `frontend/looks/kit.css` and `kit.tsx`
(additions only, at the end of the file), the catalogs (`frontend/locales/en/*.json`: each lane
its own namespace), `tests/baselines/test-durations.json` (re-add with
`node scripts/test-durations.js --add`), and `workshop.tsx` (lane P only; lane T does not touch
it). A lane works on its own branch `redesign/skins-v2-<lane>` cut from the P0 commit, in its
own worktree; lanes merge into `redesign/skins-2026-11-11` one at a time, recompiling the looks
section after each merge.

## Per lane, what "done" means

1. Every step of the lane draws its v2 outline under a look: same sections in the same order,
   same controls, the product's own words (catalog ids of the standard page).
2. Everything v1 invented and v2 dropped is removed from the kit page, its catalog entries and
   its suites.
3. The lane's frame suites are rewritten to pin v2 (what is there, and that what went is gone);
   `npm run test:changed -- --base <P0 sha> --files <changed>` passes; `npm run ensure:shell`
   builds; `node scripts/build-looks-css.js --check` passes; `tests/rtl-logical-css.test.js`,
   `tests/shell-id-inventory.test.js` and `tests/language-extraction.test.js` pass.
4. The standard look is unchanged: no standard-path markup, id or class is altered except the
   neutral wrappers Settings needs (recorded in the shell baseline's ADDED maps when an id).
5. Seen in a browser under Glass, Paper and Workbench, desktop and phone, light and dark, beside
   the v2 mockup (needs the local stack; see Notes).

## Notes

- 11 Nov: the six audits were read from source only; nothing was run in a browser. The local
  stack of the first programme (Docker Postgres with a production copy, env files, Playwright)
  lived in a session scratchpad that is gone; it has to be set up again before step 5.
- Open questions each audit lists at its end stay open until their lane reaches them.

### Lane Y, as built (11 Nov 2026)

What each step draws under a look now:

- **s44, s45 You, Overview** (`features/profile/frame/you-frame.tsx`): the `@handle` as the title (a display
  name, when one is set, on the 13px line under it), "Building since… · Changes live in N apps", Edit profile as
  a `line` button; six tabs; the work column is the bio (when set), the verified accounts as pills that open
  them, then Your work, Rewards, Account (Friends, App slots), Settings (Profile, Notifications, Settings with
  the wallet line in the native app) and Admin; the side column is In numbers and This week (up to four
  figures, the seven bars, the note, Share; the empty sentence when the week is empty).
- **s46 to s48 Changes, Requests, Votes** (`frame/you-history.tsx`): the bot's History for that kind, read
  with `useHistory`, by month then by project, one line each (glyph, number, title, how it ended), "Earlier
  months" as the last row; the projects to narrow to in the side column, small buttons over the list on a
  phone. One project picked is read from the server.
- **s49 Friends** (`frame/you-friends.tsx`): the product's own username search wearing the kit's field, who
  asked (Decline, Accept) and your friends in one group, the privacy line, Sent requests in the side column.
- **s50 Edit profile**: the product's dialog, dressed. Its title, group labels, groups and Save wear the kit's
  through `looks.json` (a new `cap` root, and `card`, `title`, `btn` extended); its rows are dressed by hand
  in app.css ("EDIT PROFILE"). Nothing is rebuilt.
- **s51, s52 public profiles** (`public-profile-card.tsx`): the picture in the head, the name, the handle, the
  friend button and Message, About with the bio alone, Report user, Verified in the side column. The page takes
  the frame's page area (`data-person-frame`). The preview inside Edit profile keeps the standard card.
- **s53, s54 Challenges** and **s55 Standings** (`features/leaderboard/frame/challenges-frame.tsx`): as the
  audit lists. Standings draws two frame roots (head and tabs; the two columns) with the screen's own picker
  ordered between them by app.css, wearing the kit's field; the Event card reads `eventBarStore`.

Rulings taken:

- **Tab addresses**: `#profile` is the Overview, `#profile?tab=changes|requests|votes|friends` the others
  (`frame/you-tabs.ts`). `Profile.open` reads it on every entry; a tab press replaces the address (Back leaves
  the page, and a step Back from a row's page returns to its tab). The store's `tab` is ignored by the
  standard page.
- Under a look the Your work rows open the tabs, and `Profile.showFriends()` (so `#profile?friends` and every
  caller) picks the Friends tab. `#homeroom-bot/history?kind=…` is untouched and still opens the bot page.
- **Feedback** is a tab that opens the product's "Your feedback" card; it is never the lit tab.
- You's head has no picture (the mockup has none; the bar shows it). The bio is kept, over the pills, since
  the standard card shows it and the mockup's person had none on that page.
- A public profile's title is the display name, or the bare username, with `@username` under it always, as
  the standard card says the two.
- The Notifications line keeps the catalog's words ("here and in each app").
- A member with no season history gets no picker and no Event card (one column), as on the standard page.
- Standings' "You" line is drawn when the board's view has it, as the standard page does.
- Six tabs are wider than a phone: the row scrolls sideways there (a hand rule in app.css, not a kit change).

Left, and why:

- The This week bars are one picture to a screen reader (the kit's `Bars`); the standard chart also says each
  day. It needs a per-day `spoken` on `Bars` (a kit change).
- Verified pills and a public profile's Verified rows open the other site with `window.open` on a plain
  click, since the kit's `Row` has no `target`.
- Standings' states other than the table (loading skeleton, error, private, no entries, the disclaimer) and a
  row's details are still the pane's standard markup inside the kit column. A challenge's own page is not the
  kit's.
- The bar's crumb on Challenges and Standings is the shell's ("Challenges", "Standings"), not "You › Challenges".
- The loading skeleton of You before its data is the standard one.
### Lane H, as built (11 Nov 2026)

**Home (s01 to s04), `features/home/frame/home-frame.tsx`.** One kit page: the head ("Home", "Your apps and
your communities.", no button), the search field, then the tour's 720 + 320 columns.

- *Search.* The kit field writes each change into `#home-search-input` and dispatches `input`, so
  `Home._wireSearch` and `use-home-query.ts` stay the one owner; Escape clears. `Home._searchField()` (new,
  `home.js`) returns the kit field under a look, and `Home.focusSearch`, Ctrl+K and `/` use it.
- *Pinned apps.* `gridStore` tiles with the standard tile's marks (made from, who it is for, still open), a
  status line and Retry, the tile menu on right-click; Edit, Add other apps, Done and New project under the
  standard heading's rules; "Show all N apps" (`chromeStore.moreCount`) unfolds the grid in place, which then
  ends in the New project tile. s03's page (`home-all-apps.tsx`) is deleted.
- *Pinned communities.* Tiles from `homePinsStore.pins` with `owed`, then Needs you, All communities and New
  community in the standard order and under its conditions; Edit puts a − on each pin; All communities (and
  a search, and `home:show-all-communities`) shows the unpinned ones faded with a +. s04's page
  (`home-all-communities.tsx`) is deleted. `Home.showCommunities` scrolls to `#home-frame-communities`.
- *Communities to join.* The kind filter, Featured as text cards (a grid of three; a sideways row on a
  phone), the rest as rows, each with a real Join (`Home.setMembership`), the standard paging, end line,
  failed + Try again, and empty lines. The line under a name is the standard's (votes, else members).
- *Next challenges.* The side column, one row per `panelsStore.challenges.rows`; a row's line is
  `stateLabel` (open question 2: the row view has no description); the one-line note is one card.
- Gone: the Needs you rows, Live this week, Your week, the season row, picture cards, the challenge cards
  under the columns, their four reads, and 68 `home:frame.*` ids (`frame.title` stays, `frame.purpose` is new).

**Rulings taken.** App tiles carry no count (question 1: the standard tile has none). Editing Pinned apps
removes tiles and adds others; **dragging to rearrange is left**: PlatformUI's gesture measures the hidden
standard grid's four-column cells, and the kit grid is six columns of flow. A hold on a touch screen does
not open the tile menu either (the hold recogniser is the same gesture); right-click does, and Edit is the
heading's link. The kit tile's menu has no "Edit My apps" item (it is offered only on `.app-card[data-yours]`).

**Left (question 8).** The waitlist card, the verify card and the iOS widget strip are not drawn under a
look: they are the standard components, and inside `.fr` the kit's reset would undress them. An account
they apply to does not see them on Home under a look. They need a wear pass of their own.

**Notifications (s05, s06).** The bar's bell calls `NotificationsSheet.toggle()`: the product's sheet, whole.
It wears the look by one hand-written block in app.css (THE BELL'S SHEET) and the wear map: `card` gained
`.notifications-card:where(#notifications-sheet *)`, and two new roots, `tabs` and `tab`, map the kit's tabs
onto `#notifications-screen-tabs` (so Glass draws its capsule, Workbench its box). Mark all read stays where
the product has it, in the sheet's head (question 5). `frame-sheets.tsx`, its suite and
`notifications:frame.*` are deleted.

**The Homeroom menu (s07).** Unchanged in content; drawn closer to the mockup by hand rules after THE
HOMEROOM MENU: the title at 24px, Suggest an improvement the whole width, the rows as one card. The kit's
account menu and `core:frame.menu.*` are deleted.

**Chrome.** As ruled: the mark and the look picker stay at the bar's end. The sidebar's You row opens the
profile and its glyph `#settings`; a phone's avatar is a link to You; the bar's search calls
`Home.focusSearch()`. The sidebar's pins and the App row's dot (question 9) are not carried over: not ruled,
and not in the mockup's frame.

**Seen in a browser** (local stack, account with 98 pinned communities and no unread notifications): Home in
Glass, Paper and Workbench, desktop and phone, light and dark; search, Show all, Edit and All communities
pressed; the bell's sheet with older notifications open in Glass, Paper, Workbench (desktop, phone, dark);
the menu in Glass (desktop) and Paper (phone, dark); the chrome's four presses on both widths. Not seen: an
unread notification's row (the copy has none for this account), a locked or failed app tile, the waitlist
states.
### Lane T, as built (11 Nov)

A request and a change (s32 to s35) and the running app (s38), on `redesign/skins-v2-t`
(`5a04e2738` to `92561bff2`). The pages are still the product's (`features/dev-board/topic/
request-head.tsx`, `change-head.tsx`); what a look changes is added beside their own lines.

- **The head (s32 to s35):** "Request #5998" (or "Change #6369") is a small line over the full
  title, with the page's ⋯. About and the Follow switch are gone with their hook, their five
  catalog entries and their rules; following stays a row of ⋯.
- **A change's page (s34, s35):** "The change" is a labelled card starting with who put it up,
  when and what built it. The context column is Status (the pill alone, with its counted vote
  once live), Votes and Tested: the product's own cards, each card's name the kit's label over
  it. "Ask Homeroom bot privately" is the kit's quiet small button.
- **A request's page (s32, s33):** "The request" is a labelled card starting with who asked and
  when. After it, in the words: the sentence (first sentence bold), the claim's small words and
  the one action. In the context column, under Status: the pill, the five stops and one line,
  drawn by the kit from Homeroom bot's own track when it has one (`topic/frame/topic-track.tsx`,
  through `bot-track.tsx`'s helpers), else the stage, else (a change built for it) the pill the
  standard bar wears beside the number.
- **The discussion (both pages)** is the product's stream, dressed by the wear map: its count
  is the section's label, the stream one card, what happened the kit's event line (`evt`, with
  `cap` and `sechead` for the label, and a second wearer of `card`: `"also"`, new in
  `scripts/build-looks-css.js`).
- **On a phone** where it stands leads the page, then the words; the head stays over the page.
- **A running app (s38):** on a desktop the bar says the project and "App" and carries Suggest.

Rulings taken (each the option closest to today's product):

- **Who asked** (audit c, question 1) is kept, as the by-line at the top of "The request".
- **The topic** (question 2) is kept on the small line over the title ("Request #5998 · topic").
- **A request with no bot track** (question 3) keeps the kit's five stops (`frameStop`), since
  one line for progress is drawn the same wherever a request appears; the standard page draws
  four of its own (Asked, Spec, Built, Voted in).
- **A change inside a request's page** (question 4) keeps the standard section.
- **A running app on a phone** (question 5) is not changed: the app has the whole screen.
- **Suggest** (question 6) follows the standard header's rule, so the frame's bar has it on a
  project's pages as well as beside its app. One condition (`onApp`) limits it to the app.
- **On a phone the head keeps two lines of title**, as the standard bar does: it stays over the
  page while it scrolls, and a full four-line title there would take a third of the screen.
- **What happened is said with the product's emoji**, drawn small and grey: the icons of the
  mockup would need the stream itself redrawn (transcript.tsx, not this lane's).
- **A page with nothing in its context column** (a closed request) is one column.

Left: the standard change section on a request's page (its Votes and Tested stay in the words'
column, in the standard pair); a spec card, the plan card and "Before and after" keep the
standard look's surfaces inside the kit's column; s38's back arrow (the standard header shows
none beside a running app on a desktop, so neither does the bar).

Seen in a browser on the local copy, which does open a change's own page now
(`/app/usernode-2d5619/dev/changes/6369`): the request and the change on a desktop in Glass,
Paper (light and dark), Workbench (light and dark) and Today, and on a phone in Glass and
Paper; the running app's bar in Glass and Workbench dark (the app itself does not load here).
The stream's card takes a look's fill and edge but not its blur: under Glass the blurred
card scrolling under the frosted composer left the composer half drawn in captures (whole
again after any repaint), and the shell blurs no scrolling plane anyway. A capture of a long
discussion taken before it settles can still show the composer half drawn; two seconds later
it is whole.
### Lane P, as built (11 Nov)

A project's pages under a look (`features/dev-board/workshop/frame/project-frame.tsx`, fed by the frame
closures of `workshop.tsx`). Needs you (s26) is untouched: its head keeps Invite and Ask for a change until
lane K takes the page.

- **Hub (s23, s24, s36).** The head is the hero's: tile, name, description, Open app (not on Homeroom's own
  page), Invite, Join; the hero's own ⋯ still stands at its end. For you: Needs you while any vote is owed
  (the pill for the unseen ones, "N skipped" otherwise, "Join to vote on these." for a non-member), else the
  quiet line with the requests nobody has picked up as its link; Workshop for anyone signed in; Discussion
  #general with its last line, the time never cut. Recently live is three picture cards (the project's tile
  where a change has no picture; the app itself before anything went live). The side column is People alone,
  with this week's faces, first on a phone. A phone also lists the topics (six, then Show N more). Gone: Ask
  for a change, the Your work row, Recently live as rows, the three-topic group, How a change goes live, The app.
- **Topics (s25).** The places list's own rows (`placeRows`): the topics in the work column, the channels
  beside them, each by its name with its unread count. Gone: Propose a topic, About topics, the lines.
- **Workshop (s27, s28, s37).** Overview: All items with See all (and the dot when a filter waits there) and
  the four figures with their lines, each opening what it counts; then the Your work card, or the product's
  first-change card for a newcomer. What happened: Mark all seen, this week's rows (new, You, Going live, a
  stuck merge, Build it), All of this week, the weeks before, Earlier weeks or when the project started.
  Beside them Homeroom bot's slots and Who decides. An admin's private requests stay under What happened.
  Gone: the head's buttons, the ballot, Recently live, the four week rows, Nobody is on these.
- **#general (s31).** The product's sentence under the title, the room in the content column and This
  channel beside it (members and Mute), drawn by `channel-head.tsx` from its one state. A reply thread
  beside the room takes the width back. A quoted reply in a project's channel wears the kit's quote.
- **All items (s29, s30).** The kit draws the head, the two groupings as tabs with the board's search at
  their end, and the side column (Show: Filters with its count and the active chips, Assigned to you, Yours;
  Order categories). The list is the product's own, laid in the kit's content column and wearing the look
  (wear map: `card` for a category's card, a new `cap` root for its two labels; hand rules for its inside).
  By stage the board has the page's width and keeps its filter chips over the columns. s30 needs nothing of
  its own: the Workshop's votes figure already routes.

Rulings taken:

- **Who decides** says the product's short sentence (`communityCard.lineShort.*`: "Goes live when its checks
  pass and evan or snait says yes.") with the wait as its line. The mockup's shorter form has no catalog id.
- **All items' categories are worn, not redrawn.** A second drawing would lose the lanes a card opens to,
  the order held across a re-sort (`themesRef`) and the panel's lit row. So a card keeps the product's
  parts (number over label, the chips, the faces' roster) in the kit's card.
- **The kit's search drives the board's own box**, which stays mounted behind it (`#dev-kanban-search`,
  `AppView._onKanbanSearchInput`), so comments and `#` are searched as on the standard page.
- **By stage has no side column**: the board takes the width, and the product's chip row stays over it.
- The second quick filter keeps the product's word, "Yours".
- Two labels are new words, both layout labels of the first tour: "This channel" (`frame.channel.this`) and
  #general's sentence as a sentence (`frame.place.general`, the standard line plus its full stop).
- No project page head but the Hub's (and Needs you's, see above) has buttons.

Left, and why:

- **What happened's item rows were not seen in a browser**: this copy of the database has no rows since the
  last visit on the projects tried. They are pinned by the suite only.
- **Topics still has no address** under a look (a reload lands on the Hub), and Propose a topic is reachable
  from Settings & rules only, as on the standard page.
- **A week's page, the bot's slots page and a topic's channel** are the standard bodies under the kit's head.
- **A place's own body is 32px from the page's edge** in every look but Workbench; Paper (40px) and Today
  (36px) set their head a few pixels further in.
- On a phone the channel's fitted box runs under the tab bar while the "changes are paused" banner is up
  (the box is measured without the banner); it does so before this lane's change too.

Learned:

- The scratchpad is shared by every lane's agent: keep scripts and logs in a folder of your own.
- `Btn` prefixes its `className` (`className="chip"`, not `k('chip')`).
- A v2 kit rule may not restate an old selector or use an old bare name (`tests/looks-css.test.js`): the
  picture card is `.shotc` inside `.shots.cards`.

### Lane B, as built (11 Nov 2026)

**The shared row model first** (`features/ai/lines.ts`, `useAiLines`). The `Line` objects `AiLists` built inline
moved there whole, with the chips' projects (`ranked`, `rail`, `past`, `toggle`), what a search keeps, the fresh
counts, the counts over each list, `heads`, `nothingHere` and `noMatches`. A glyph is a name (`Glyph`); each face
has its own icon for it (`GLYPHS` in `lists.tsx`, `ICON` in `frame-list.tsx`). The standard list renders the same
markup; `tests/ai-screen.test.js` changed only where it read the moved lines out of `lists.tsx` (four reads now
name `lines.ts`, and the "works" glyph is pinned as a name plus the standard face's icon map).

**s08, s09, s14, the lists** (`features/ai/frame-list.tsx`, rewritten). The head: the bot's tile, the title, the
counts sentence, and two round buttons (search, which opens the field under the head and Escape closes; the +).
The projects as tabs: All, the rail's projects, "N more" opening the product's `ProjectPicker`. Main Chat as one
small row in its own card. Then four groups of one card each, in the standard order: Needs you, Waiting & in
progress (with "Not moving · N" as its last row, opening its rows in place), Live this week (with the older-tab
reload note), History (its kinds as small buttons inside the card, months as rows, "Earlier months" last). A row
is one line: glyph (accent when it asks for you), the number in mono from 768px, the title (with "· N requests"),
then a blue pill or grey words; a private row ends in the product's ⋯ (`ThreadDoneMenu`, Mark done); on a phone a
second line where it is news. Folding is `groupRows`, so the lit row and a new row are never folded away; Needs
you holds its order under the pointer (`holdOrder`). The loading line, the failed note with Try again, "nothing
of yours in <project>", and "No threads match" are the standard's. With one project picked the lists are
narrowed, project names are not repeated, and Main Chat stays. The phone's Ask Homeroom bot bar is back over the
tab bar, wearing the kit's composer. Alone, the list is the kit's narrow page (784px, centred). Gone: the group
per project, the five-stop line on rows, second lines on a desktop, the labelled New thread button, the count on
All, and all fifteen `messages:frame.bot.*` ids.

**s10 Main Chat.** The kit head got the standard head's lock before "Only you can see this chat". The
conversation is the product's, worn, as before.

**s11 a request in the column.** Only the pane, as assigned: the shell's side-panel head beside the bot page is
dressed as the kit's open-item head (68px, 32px gutter, 40px tile, 17px name over the 13px line, the ⋯ and × as
round buttons). On a phone, a request opened from the lists keeps the standard page's pair of chips (Homeroom
bot, Workshop) at its top: `#gc-thread-back` is shown again there when it holds the pair, as small quiet buttons.

**s12 a private thread.** Already the product's pane, worn. Its row in the list is lit together with its ⋯, and
the ⋯ menu is dressed (it sits inside `.fr`, whose reset had undressed it).

**s13 New thread.** As ruled, the product's pane in the column (the whole screen on a phone), with today's
content. The five starts are rows in one card (the list wears the kit's card through `looks.json`; the rows and
their 40px glyph tile are hand rules in app.css), the two chips are small quiet buttons.

Rulings taken:

- **Project tabs toggle like the standard chips** (audit question 7): several may be picked, All means none, and
  a tab carries its count of new threads. Closest to today, and what the address (`?project=`) already carries.
- **Day dividers and the "Earlier" line stay** inside a project's rows (Needs you, Waiting & in progress), as
  small caps with a rule. The mockup's sample has none, but the standard list has had them since 6 Nov and #6262.
- The fresh pill beside "Needs you · N" and on a project's name, and the dot before a new row, are kept.
- The loading state is the standard's spoken words ("Loading…") as a grey line, not skeleton bars (the kit has none).
- A request's back chips show on a phone only when the page has the pair; a page with the one chip keeps the
  bar's arrow alone, as every kit page does.

Left, and why:

- **Main Chat's request cards and the bot's bulleted lines** (s10) are the product's own drawing, not the kit's
  rows in one card and small event lines. Wearing them means adding the ref cards to the wear map's `card` and
  `row`; the `row` root is Settings' (lane S), so it was left for after the merge.
- **The lock as a private thread's head lead** (s12): the product's head has no lead, and the lock is already
  before its line.
- **The "N more" picker and the chips' pickers** open the product's own menus and sheets, not the kit's sheet.
- The order inside a request's page in the column (Status first) is lane T's.
- In Paper, the list beside an open item runs past the page card's rounded bottom edge (it did before this lane).
- Not seen in a browser: a new (unread) Needs you row with the Earlier line, the failed and loading notes, the
  older-tab reload note, and a project in a community the person left (History). They are pinned in
  `tests/ai-frame-list.test.js` from fixtures instead.

### Lane M, as built (11 Nov 2026)

Messages (s15 to s20), on `redesign/skins-v2-m`, cut from `5f6faf062` (P0 and lanes Y, H, T, P, B).

- **s15, the list** (`features/messages/frame-list.tsx`, fed by the frame branch of `index.tsx`
  `ConversationList`). The head (Messages, "People and groups you talk to.", New message); People and Agents as
  tabs, People counting the unread messages from people (the standard heading's count); the product's search
  ("Search") under the tabs; then the tab's conversations as one card of rows. A group says how many are in it
  after its name (a people glyph and the figure, the words to a screen reader), a bot's direct message keeps
  its "AI" badge, an invitation's row says "Tap to review", a row ends in "N new" or its time. Offline, a failed
  read with Try again, the first read, an empty inbox with New conversation, and a search that matched nothing
  are the standard list's sentences. With nothing open the pane beside the list is the product's "Choose a
  conversation".
- **s20, Agents.** "Chats with coding agents." The standard section, folded by its own rule and state
  (`shownInSection`, `agentsExpanded`): this week's chats, the open one and any that asks for you, then "N older
  chats" as the card's centred link, which stays where it is with the older chats under it ("Hide older chats").
  An agent chat's line is `MayorSessionRow`'s (the project and its change's state, or "No active change";
  "Working…" while it works) and it ends in its date; a change in flight is `SessionRow`'s (project, what is
  known, when) and ends in its state as the one pill, from `sessionRowState` (new, beside `stateOf` in
  `features/improve/session-row.tsx`: the same word, and a kit tone). "Show archived" ends the card where the
  standard list offers it and opens the archived chats under their own label.
- **s16, New message** (`frame-new.tsx`). The kit's sheet with the standard menu's three choices (`NEW_CHOICES`):
  Agent chat, Direct message, Group chat, each with its line. A press closes the sheet and calls `startNew`:
  an agent chat starts; the other two open the product's create dialog on that tab. The dialog wears the look:
  its card carries `data-new-message` (it is lifted out of its root when shown), its Direct and Group switch
  and its buttons wear the look's tabs and buttons through `looks.json`, its title, fields, found people and
  blocked list are dressed by hand in app.css (NEW MESSAGE'S DIALOG).
- **s17, s18, a conversation.** The product's renderer, as before. Added by hand in app.css (VERSION 2, s17 to
  s19): a quoted reply and the reply staged over the composer are the kit's quote; reactions are the kit's
  small pills; the thread card under a message and a thread's replies in the stream are one small surface
  card, the open thread's with the accent's ring, the replies' glyph in the faces' column. These rules name
  the renderer's own classes, so a project's channel and the bot's chat get them too.
- **s19, the reply thread.** The product's pane, as ruled: beside the conversation (the list steps aside under
  1600px, as in the standard look), a page on a phone. In Messages it is flat with one line between it and
  the conversation, the kit's margins, and its count ("3 replies") is the day's label (a second wearer of `day`).

Gone: the To field, the people rows, Start chat, "Or else", the sheet's Blocked people, groups named after
their members, the "N older chats" label over Agents, the sentence sending new work to the bot's tab, a second
search placeholder, and twenty `messages:frame.*` ids. Three stay: the two sentences under the title and an
empty tab's line.

Rulings taken:

- **The search is under the tabs at every width** (audit, s15 point 2): the pane is 520px, and the mockup's own
  picture draws it there.
- **The empty pane keeps the product's two sentences** (question 6).
- **An agent chat's line keeps the change's title** when it has one ("Homeroom · title · Ready"), as the standard
  row does; the audit's shorter form would have dropped it.
- **A change waiting on you is the blue pill**, the kit's colour for what waits on you; the standard row draws
  it green like every settled state.
- **Agents has no count on its tab.** The standard heading's "N working" is not a count that asks for you.
- **An empty tab beside a full one says "Nothing here yet."** The standard list leaves the section out; a tab
  cannot be left out without the tabs moving.
- **The dialog's title is set by hand** (24px, the look's face): a `title` wearer would have meant editing
  Settings' suite while lane S is in it. Brand kit's serif title is the one thing lost.
- **The reply thread is a pane, not the kit's right sheet** (question 5, as ruled on 10 Nov).

Fixed on the way: under a look a continuation row's words started 12px after the first line's (the time's
gutter was 44px beside a 32px face; 38 and 26 in Workbench).

Left, and why:

- A change in flight's unread dot (the standard `SessionRow` reads the notifications store for it) is not on
  the kit row.
- The list does not hold its place across a live re-sort under a look (`list-place.ts` anchors the standard
  scroller), and "Oldest chats" (`InboxToEnd`) is not offered.
- The dialog's "Blocked people" link wraps to two lines on a phone beside Cancel and Create group.
- In Paper a long Agents list runs past the page card's rounded bottom edge, as lane B noted for its list.
- Not seen in a browser: an unread conversation (this copy has none), an invitation's row, a working agent,
  the offline note, the failed and empty states, the archived group with rows (seen opened, at its end). They
  are pinned in `tests/messages-frame-list.test.js`.

Seen in a browser (local stack): the list, Agents folded and open with Show archived, the New message sheet,
the dialog (Direct, Group, Blocked people), a direct message, a group and its reply thread, in Glass and Paper
(desktop and phone), Workbench (desktop, dark), Glass dark on a phone, and the dialog in Brand kit. The
standard list's capture is byte-identical before and after.
