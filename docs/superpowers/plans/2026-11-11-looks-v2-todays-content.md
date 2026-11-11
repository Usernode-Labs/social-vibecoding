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

### Lane S, as built (11 Nov 2026)

Settings stays the product's own screen: no kit page was written. The standard markup carries stable `ui-*`
names and a few neutral wrappers that draw nothing in the standard look; `frontend/looks/looks.json` ("wear")
gives each the kit's component inside `#settings-root`, so every look's own rules reach it; the SETTINGS
block of app.css says the layout and what the wear cannot. The standard look and the New look were compared
with a build of the base commit, page by page, desktop and phone: the same pixels (but the port in the MCP
address and the build's version word, which differ between two builds).

What each step draws under a look now:

- **s56 the frame and the list**: a head ("Settings", "Your account, your preferences and your tools.",
  `settings:frame.head.purpose`, the one new catalog entry) above two columns; the list first at 360px (the
  kit's search field, a small-caps label over one card of 48px rows per group, glyph, name, the count or the
  Beta pill, the open page lit), the open section at 680px under its name at 22px. The bar says
  `Settings › <page>`, and `You › Settings` on the phone's list (`SettingsFrameCrumb`, settings-nav.tsx). On a
  phone the list is the page, with the head; a section is its own page under the bar's arrow, named at 22px,
  without the head. The nineteen `settings:frame.purpose.*` sentences are gone with their tests.
- **s57 Account**: the profile card is one row (picture, name, Edit profile as a link, no chevron); Sign-in's
  three cards with Change as links, their editors' fields and buttons the kit's; Delete account a full-width
  bad button.
- **s58 Linked accounts**: the page's label is not repeated; "Weekly credits" a small-caps label, the tier and
  provider rows the kit's, Connected a pill, the two notes under the card.
- **s59 Privacy**: the two choices are radio rows in a card; each switch is a row with its On or Off word and
  the switch at the end; the texts line is a note under the card; Usage data is one card of the two lists, the
  two closing lines its notes.
- **s60 Linked devices**: Phones and Browsers are small-caps labels, each over one card of rows; Unlink and
  Sign out are bad-toned links (the confirm step keeps its Cancel beside it); This browser is a pill.
- **s61 AI usage & models** (partly, see below): the credit row, building time (label, card, the kit's 6px
  meter, the request rows with their share, the note), the spend card, and the two keys as a field with its
  button in a card each.
- **s62 Connectors & CLI** (partly): the address as a field with Copy and Test connection, How it works as a
  link, "Your AI tools" a label, each tool a card whose connections are rows with Disconnect; the CLI guide one
  card of three numbered steps with their command lines; the credentials one card of rows with Revoke.
- **s63 Agent instructions & skills**: each kind is a label with its Upload button over one card (the empty
  line, or a row per file); the name form is a card of fields.
- **s64 Appearance, s65 Accessibility**: the three choices are radio rows in a card (the segmented track's own
  buttons, standing as rows, each with a radio mark the standard look never draws, `.ui-look-only`); the
  sidebar switch (desktop only) and High contrast are switch rows in their own cards.
- **s66 Language**: the select as the kit's field in a card.
- **s67 Notifications**: one switch row with Send a test alert under it; the ten push categories one card of
  switch rows; the per-app defaults one card of switch rows, then "Apps set differently" as a label over its
  card or its empty line.
- **s68 App permissions**: three labelled parts, each list one card (a grant: the app, Cap $ field, today's
  spend in the mono face, Revoke).
- **s69 Developer**: each part one card with one switch row; Admin preview draws nothing for a non-admin.
- **s70 Welcome tour, s71 User guide, s72 About**: the button and its hint; the two labelled cards of wrapping
  rows; the version rows in one card (mono values) and Legal as a card of four links.
- **s73 Experimental**: the four switches are rows of one card, the Look menu a field in a second card with
  its hint; the local agents part keeps its place.

Rulings taken:

- **No node is swapped by look.** Every pane, React-owned or static, keeps one markup for both looks; the
  look is CSS alone. A switch row in a static pane is a `.ui-swrow` wrapper round the label and its sentence:
  the label's box steps aside (`display: contents`) and a grid puts the switch at the end, so the input, its
  id and its listener are untouched. Privacy's switch rows, whose whole row is the label, turn by
  `flex-direction: row-reverse`.
- **The wear is scoped with `:is(#settings-root *)`**, not `:where()`: the standard sheet's own rules reach a
  heading with six classes, and a worn rule has to outrank them. A hand rule that must outrank a worn one
  names `#settings-screen` as well. `hidden` is restated for the screen, since a worn `display` outranks the
  utility and settings.js shows and hides by that class.
- **Where Settings shares a root with another page** (cap, card, title, btn) it is a wearer of its own
  (`"also"` in looks.json), so its id weighs on nobody else's rule; btn's Settings wearer has parts of its own
  (quiet, bad, sm, block, line) and the auth pages, the sign-in sheet and Edit profile's Save keep theirs. The
  head's box is laid by hand: as a root, `head` would take every rule that names the head before a button
  away from the other wearers of btn.
- **Fields, buttons and links are worn by the product's own classes** (an input, select or textarea inside a
  section; a button with a fill or a border; a violet or red text button), so the shared primitives
  (`button.tsx`, `input.tsx`, `select.tsx`, `switch.tsx`) are untouched. `ui-btn`, `ui-link`, `ui-inp` name
  the few that have none of those classes.
- **The list is part of the page** under a look: not a sticky sheet that scrolls on its own (the mockup's
  columns). Its rows keep one line for the name and one for a phone subtitle.
- **Crumbs**: `Settings › <page>` on a desktop always (the audit's question 3); `You › Settings` only on the
  phone's list. The arrow is the shell's own back button.
- **768 to 1023px** keeps the phone's two levels beside the frame's sidebar, as today.
- **Homeroom Wallet and the Homeroom app page** have no mockup: they wear what the rest wears (labels,
  switches, buttons, fields) and nothing was drawn for them. Neither can be opened in a desktop browser on the
  local copy, so neither was seen.

Left, and why:

- **s61**: the OpenRouter part is not one card. The included-key box, the personal key card and the model
  block (filter, Favorites, Refresh, the model select and its star, Reasoning effort, the two default buttons)
  are separate cards; the model block is hidden on the local copy (no model list), so its wear was not seen.
  settings.js toggles `hidden` on most of these ids, which is why they were not regrouped.
- **s62**: a tool's guided set-up (the disclosure's inside: steps, code blocks, the naming and permission-rule
  blocks) keeps the product's own boxes inside the kit's card; only its buttons and fields are worn.
- **s63**: Upload stands on the label's line above the card, not at the end of a row inside it.
- **s68**: a grant's row keeps the product's two-line shape (name and spend, then the cap and Revoke).
- Inline links inside a sentence keep their underline. The radio mark is drawn by hand-set rules on the kit's
  `chk` (no check glyph inside; a dot).
- The filter's results and the recent searches wear the card and row; a look's own hover state for a list
  row is not drawn (the kit has none).

#### Settings after the visual pass (fix group 4, 11 Nov 2026)

The rules of lane S held: one markup for both looks, no node settings.js binds moved or re-created, the
standard look compared before and after on all seventeen pages, desktop and phone (the same pixels outside
the sidebar's live counts).

- **A field's value is the ink.** The worn `.inp` is the kit's wrapper, whose own colour is the placeholder's;
  the hand rule that said the ink tied with the worn rule (two ids each) and lost by order. It names three ids
  now. The wear map's `inp` entry was not rewritten.
- **Copy and Test connection** are both the kit's small button (`ui-btn-sm` on Test connection, whose `w-full`
  kept it out of the map's `sm`), centred on the field. **The Look menu's card** keeps 16px at its head.
- **s61 is one card.** A neutral wrapper (`ui-onecard`) stands round the included key, the saved key's two
  lines, the personal key and the model block; under a look each loses its own card inside it. Every node keeps
  its id, its order and the `hidden` settings.js toggles; nothing is moved at run time. The personal key's label
  is a field's label inside the card, and each key is a field with its small button beside it (`ui-keyrow`).
  The included key's row and the model block are still hidden on the local copy, so they were not seen.
- **s62, inside a tool's guided set-up**: the product's nodes in the kit's type and tokens (numbers as the lead
  tile at 24px, the accent once ticked; code and bold words in the ink; the two labels small caps; the further
  help a sunk box of rows; a file's lines on the kit's ground in the mono face). Dressed by hand rules only.
- **s63**: each kind's block is the card (`ui-card ui-filecard`); a grid puts Upload at the end of the first
  row and the files, when there are some, across the card under it. A kind with nothing under its name (while
  the files load or fail) is still a card.
- Also: Legal's links are rows; the version row is centred; the check discs of Linked accounts and the profile
  row's letter are the look's (the letter wears the kit's avatar, a new root `av`, on the person's own colour);
  a note's bold words are the ink; the Usage data card keeps 12px between its lists; the line under the push
  categories starts with the notes; the phone list's rows stand 12px apart so "Connectors & CLI" is whole.
- Not done here: the bar's title under its buttons and the Reconnecting banner over the bar (group 1); a field
  inside a white card in Pastel and Paper has almost no edge (the look's own `.inp`, group 1's file); the tab
  bar's glow with the filter focused in Glass dark was not reproduced.

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
  its card carries `data-new-message` (it is lifted out of its root when shown), its title, its Direct and
  Group switch and its buttons wear the look's title, tabs and buttons through `looks.json`, its fields, found
  people and blocked list are dressed by hand in app.css (NEW MESSAGE'S DIALOG).
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
- **The dialog's title wears the look's title** (a further wearer of `title`, added when the skins branch with
  lane S was merged in), at a sheet's 24px by one hand rule; Brand kit's serif shows.
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
### Lane G, as built (11 Nov 2026)

Signed out (o01 to o27) and the waitlist (w01 to w14), on `redesign/skins-v2-g`, cut from `5f6faf062`.

- **Members' addresses opened signed out (o12 to o15, o17, o22 to o25).** As ruled, they behave as in the
  standard look: the sign-in sheet opens by itself over the outline of a page. The first tour's page
  (`guest/frame/gated-frame.tsx`), its suite and its 28 catalog entries are gone. Under a look the outline
  (`DeepLinkBackdrop`) starts under the frame's bar, on the look's ground, drawn with the kit's surface in
  place of the blur (app.css, A MEMBERS' ADDRESS OPENED BY A VISITOR), and the bar names the place:
  `gatePlaceWords` (`auth/deep-link-sign-in.tsx`) gives Messages, Homeroom bot, You, Settings or Challenges in
  the brand's place, or after the brand a project's Workshop (Needs you), then "Request #N" or "Change #N".
  The landing renders those words unseen in its own header under a look (`GatePlace`), which the bar already
  reads (`guest-chrome.tsx` `readLanding`, `trail`).
- **The landing (o01 to o03) and an account in line looking around (w03),** `guest/frame/landing-frame.tsx`.
  The head is the welcome over the headline, its sentence and the one button (Join the waitlist, or Sign up);
  the three points are one card in the side column, first on a phone; then the search (kept on the history
  entry, as the standard page keeps it), this device's Pinned apps (a tile opens the app, its corner unpins)
  and Pinned communities, and Communities. Communities is drawn by the one view Home has for it under a look,
  lifted out of `home-frame.tsx` into `home/frame/to-join.tsx` (`ToJoinView`): the kinds, Featured as cards,
  the rest as rows, the standard paging and lines. A visitor's card has no button: tile, "New", how many
  people used it lately, name, sentence, and the whole card or row is the link. w03 is the same page under
  Home's title and sentence, the search under the head, with "You're on the waitlist" (the standard card's
  sentence and "Your spot on the waitlist") as the side column. Gone: Try an app first, Try an app now, Look,
  Homeroom today, With an account as a labelled group, and 14 `auth:frame.landing.*` entries.
- **A public project's page (o20, o21, w12, w13),** `guest/frame/project-frame.tsx`: the icon, the name,
  "Public community", the sentence and the facts line by the standard band's minimums; Try it, Join, Pin,
  Share. Each change up for a vote is a card (before and after, name, sentence, the share of yeses, the
  tally, Vote or "once you're in"). Beside the Hub: the picture (the illustration and its dark twin, else the
  icon on the community's colour), What's happening, People and From the chat; on a phone the picture and
  What's happening lead and People and the chat come last. Beside the Workshop: Requests. The guest banner
  and `auth:frame.project.guest` are gone. The bar names the tab after the project when it is not the Hub.
- **The sign-in sheet (o04 to o06).** Under a look the first step, the phone step and the password step are
  laid out as the kit's sheet by a branch of the sheet's own render (`kitSteps`, a hoisted function after
  the standard render, called inside the sheet's own shell): the field's card, the other ways as rows in one
  card under "or", the primary button, the terms as the foot, the Email code | Password switch as the look's
  tabs. Fields, ids, refs, handlers and every `data-sign-in-*` hook are the sheet's own. The other steps
  keep wearing the look.
- **The stand-alone pages (o07 to o11) and the waiting room (w01, w02; w04 to w09 and w14 are sent to it by
  the router).** CSS only, no node or id moved: a form is `display: contents` in its column and `order`
  places what it holds (app.css, "Version 2 (11 Nov 2026) lays each stand-alone page out"). Title, fields in
  a card, the other ways as rows, the primary button last, the terms. In the waiting room Look around goes
  last and the invite card's title is the label over it.
- **A profile signed out (o26):** the guest's bar comes up for `#profile/<name>` with nobody let in, naming
  it, with Sign in (the landing's sheet over that address) and Sign up (the landing); the page is the kit's
  lone line. **A dead invite link (o27):** the landing's own section laid out as a stand-alone page.

Rulings taken:

- **One drawing of Communities, Home's.** o01 to o03 draw Featured as the kit's text cards and the rest as
  rows, as the signed-in Home does under a look and as w03's mockup does; o01's mockup drew picture cards
  with covers. The owner's ruling for this lane was to reuse Home's sections; a visitor therefore sees no
  cover pictures on the landing under a look.
- **The switch wins over "Use a password"** (audit question 6): from the bar's Sign in and from Join the
  waitlist the product puts Email code | Password on the first step, so there is no such row; an invite's
  sheet, which has no switch, keeps its own ways (a phone number, email) as rows and its "Already on
  Homeroom?" line in the foot.
- **One layout for o20 and w12** (question 3): What's happening stands beside the page for both.
- **Today's chrome for an account in line** (question 1, as ruled): the guest's bar; no sidebar, no tab bar.
- **Homeroom's own project signed out** (question 2): it is not in the public directory on this copy, so a
  visitor gets the sheet (o22 to o25) and a waiting account, which is never asked to sign in, gets the
  landing; the code's one rule for both is untouched.
- **The phone's bar keeps one way in** (question 4), as before: Sign up is the page's own button there.
- A search with no match shows nothing under the field, as the standard page does (the first tour's "No
  communities match that." is gone with its entry).

Left, and why:

- **A gated address's sheet opens on the email step when Apple and Google are not known yet** (it did on the
  local copy, where the options were injected late): that step is not one of the three laid out as the
  kit's sheet, so it wears the look as before. `code`, `phone-code`, `forgot`, `username`, `account` and
  `link` likewise (question 5).
- **The rows of a stand-alone page are drawn by hand** (the kit's surface and hairline, 20px corners), not
  through the wear map: the `row` root is Settings', and a row there is a link inside a wrapper. Under
  Workbench their corners are rounder than the look's cards. (The reset view's heading wears the kit's
  title as a further `title.also` wearer, since the merge with lanes S and M.)
- **`display: contents` on the forms**: an old Safari (before 16) drops such a form from the accessibility
  tree.
- **Not seen with a real account in line** (none can be made on the local copy without mail): w03's side
  column and head, w12 and w13's "once you're in" words, and the account's name in the bar are held by
  render tests; the waiting room's layout was seen signed out, by calling `AuthScreens.showWaiting()`.
- A change's before and after pictures did not load on the local copy (its storage answers 500), so the vote
  card's pictures were seen as empty frames with their captions.

### Lane K, as built (11 Nov 2026)

Needs you (s26), then Make and Import (s42, s43), on `redesign/skins-v2-k` (cut from `cbfa34ecd`: P0 and
lanes Y, H, T, P, B, S).

What each step draws under a look now:

- **s26 Needs you, a project's.** The head is the kit's title, sentence ("What waits for your vote in
  <project>.") and the places as tabs, with no button: the first tour's Invite and Ask for a change are gone
  with `useActs`, `onAsk` and the two catalog ids (`project:frame.ask`, `frame.invite`), so no place's head
  but the Hub's has buttons. Under it the review stage is the product's (`features/review-flow/`), not
  redrawn and not told about the look. It wears it: the wear map makes the change's page the look's card
  (and the help rows' group), its back and its ⌄ the round button, its title the 17px heading, Skip, Next,
  Send, "Open the change page", the reason chips, the vote-kind chips and the end's buttons the button (quiet
  until chosen), a help row the 48px row, the reason's field the field. One block of hand rules in app.css
  (NEEDS YOU, THE REVIEW STAGE) maps the stage's own `--rf-*` colours to the kit's tokens, makes Yes | No's
  chosen side the accent, and keeps what a worn rule would undo. It sets no width, height or position of the
  page, the picture, the strip or the sheet: the stage measures and animates itself as before.
- **`#needs`, the cross-project page**, shares the stage, so it wears the same. It has no head of its own
  (the bar says Needs you), as on the standard page.
- **s43 Import** (`features/first-session/frame/make-frame.tsx` `ImportFrame`): the title and its sentence in
  the head with Import it, "Describe a new project instead" beside it on a desktop and the close control at
  its end; one narrow column: Repository, one card of the two fields (the address with Check or Re-check
  beside its box and the status line under it, the name), then the note about the repo, the error, and the
  link back to describing on a phone.
- **s42 Make** (`MakeFrame`): the question in the head with Make it, "Import from a GitHub repo" (a link
  under the form on a phone) and the close control; Start from an idea as four cards (the picked one ringed;
  the fourth opens the same sheet and is taken over by a pick from it); Your idea, one card of the two fields
  with the microphone inside the box, or a picked idea's sentence with its blank, its choices as small
  buttons, Write it yourself and the game's own box; the line about speed under the card; Who can change it
  in the side column as two rows (the rule with Change, which opens the line's own sheet; What happens next,
  which opens the note's four lines in place). The bar says Home › New project and its arrow leaves the way
  the close control does.

How Make is built: one branch in `MakeScreen`, before the standard render (`if (kit)`), and one in
`ImportForm` (`if (frame)`), hand the screen's own state, refs and handlers to the presentational file. The
root, the scroller, every id and `data-*` name are the standard screen's, so the page lock, the keyboard
surface, the kept draft, dictation and the request are unchanged. `kit` is true only from Create, under a
look, below the frame's bar; the first session's Make keeps the whole screen and the standard form. The
standard render was not edited: captures of `look=standard` before and after are the same pixels (Make and
Import, desktop and phone, compared pixel by pixel).

Rulings taken:

- **"Make keeps its form" (the first programme, 10 Nov) is overturned**: version 2 draws Make and Import in
  the kit's layout. The second render branch was chosen over a `useMakeForm` hook because it leaves every
  pinned line of the standard path where it is.
- **Needs you is worn, not redrawn**, as ruled; the s26 mockup followed an old capture and was redrawn from
  the product (see below). Its purpose line keeps today's words.
- **The stage's card is solid** under a see-through look (as the item page's stream is): a change slides in
  over the one that leaves. Paper's is the sunk tone with white controls, as Paper draws a card.
- **The stage keeps its place**: a centred 520px column, on a desktop and a phone, as on the standard page.
- **The close control is kept** on Make and Import (the mockup has none): the round button at the head's end.
  The import page is 64px wider than the kit's narrow page so its title keeps one line beside it.
- **What happens next** (audit c, question 7) opens in place under its row; a row cannot hover.
- **A picked idea's sentence** (question 8) is kept inside "Your idea", with its chips as the kit's small
  buttons.
- **The allowance row** is the product's own block, so it stands outside the frame root, under the page.
- Three labels are new words, all layout labels of the first tour: "Your idea", "Who can change it"
  (`onboarding:firstSession.make.frame.*`) and "Repository" (`…import.frame.repository`).

The s26 mockup (`skins-tour-v2/tour-v2/screens_b.py`, the `s26-needs` entry only) is redrawn to what the
product shows: the head and tabs, then one card with the back, the title and ⌄, the line, the picture with
its caption and switch, the strip, and Yes | No with Skip. Checked with `check.py` and rendered; not combined
and not published.

Left, and why:

- **On a phone, Make it is in the head**, above the fields, as the mockup has it; Return in the name still
  submits. The standard form has it under the fields.
- **The made screen after Make** is still the standard screen in the frame's page area.
- **The sheets** (the rule's presets, Something else…, the stage's vote sheet) are the product's own sheets,
  solid under a look, not the kit's `Sheet`.
- **On the phone emulation used here the stage's vote row sits under the tab bar** on `#needs`, in the
  standard look as well (the "Add it to your home screen" strip is not counted in the stage's height
  there). Not changed: the stage's height is its own.
- **Workbench keeps the picture's 32px corners** inside its 10px card: the stage opens a screen onto those
  corners from code.
- Not seen in a browser: a vote cast (Yes, No and its reason sheet, Next), since a vote writes to the shared
  copy; the vote-kind chips on a project's page (only on `#needs`); dictation; the allowance row at its
  limit; a successful repo check (imports are paused on this copy); a real picture (this copy has no shots
  storage, so the stage's picture is its ground alone).

### Fix pass, group 1 (Home, the bell, the Homeroom menu, Homeroom bot, the chrome; and the shared kit and frame)

What the visual pass found (`visual/v1.md`, and the shared faults of v2 to v5) and what was done.

**The chrome (`features/frame/frame-app.tsx`, kit.css, app.css "THE FRAME IN THE SHELL")**

- The bar's last crumb is a box of its own (`.ci > .cw > .cn`), cut with an ellipsis before the bar's
  buttons: a request's, a project's or a Settings section's name no longer runs under them on a phone, in any
  look. `.crumb` itself is not restated (version 2 may only add).
- On a phone the bar says the line the standard header has under Main Chat ("Only you can see this chat"):
  it reads `nav-drawer/bot-drawer.ts`, the store the standard two-line title reads, as `.cs.p` under the name.
  For an admin the look picker and the theme button leave about 85px for both lines, so the line is cut
  ("Only you can …"); for a member the two buttons are not there.
- The bar's first button, on a desktop, hides and shows the sidebar. It presses the standard header's own
  `#sidebar-toggle`, and the frame reads the same fact (`navStore.railOpen`): folded, both layers are the
  kit's `.noside` frame and the page area starts at the window's edge. There is no hover peek under a look.
- The chrome starts under the offline strip ("Reconnecting to Homeroom"), as it did under the install strip:
  the same five rules for `body.is-offline`, with `--browser-banner-h` so both strips together are counted.

**The kit**

- Mosaic's "a list is a grid of tiles" (`mosaic.css`) leaves out `.list` and any card holding `.tiles`, a
  show-all row, or a one-line row of version 2 (`.item`, `.proj`, `.month`, `.th`, `.rk`) at any depth: Home's
  Pinned apps and You's History tabs (rows inside a group per project) are plain cards again. A card of plain
  rows with a lead (Communities to join, a Hub's For you) is still the mosaic.
- The phone rule that wraps an item row is for a row outside a compact list (`.row.item:not(.list .row)`),
  so the Workshop's "What happened" still wraps and Homeroom bot's rows are one line, as the standard list's.
- `PageBody`/`Cols` have `tail`: the work column's last groups, put after the side column on a phone
  (`.cols.mix`). Home's directory is its tail, so Next challenges comes before Communities to join.
- `Bars`: a day with nothing in it is `.bcol.none`, a 2px baseline in `--faint`, not a stub of the accent.
- A launcher tile's marks (`.at .tag`) take `--solid` where the look has one (Glass dark: a faint disc on a
  white tile). `--solid` is allowed in version 2's rules by `tests/looks-css.test.js` beside `tc` and `bn`.
- `scripts/build-looks-css.js` sets `--fr-page` on `<body>` for a look with a flat page (Brand kit). Make's
  and Import's overlay paints `var(--fr-page, var(--home-wallpaper, var(--fr-ground)))`: the wallpaper's
  washes where the look keeps the wallpaper, the flat page where it does not.

**The pages**

- Home in a narrow window (app.css "HOME UNDER A LOOK, IN A NARROW WINDOW"): the page is a container; under
  912px of page it is one column in the phone's order, under 560px the tiles are four across. The kit's files
  take no at-rules, so widths between the tour's 1440px and a phone are hand rules of the page.
- Homeroom bot: the list's pane is a container; under 480px (beside an open chat in a 1024px window) the title
  is the phone's 24px, the gutter 16px and a row gives up its number. The counts line breaks evenly. A project
  tab has the project's tile. The phone's "Ask Homeroom bot" bar takes the look's opaque surface. A private
  thread or New thread on a phone keeps a 16px gutter.
- The Homeroom menu: a row's words take a second line before they are cut.

**Left as they are, and why**

- The tab bar's own see-through ground on a phone (Glass, Mosaic): the look's glass, as the tour drew it.
- "Bot" on the phone's tab: the mockup's word. A decision for the owner.
- Home: 12 apps folded (two rows of the kit's six, as the standard's two rows of four), a challenge row
  without its picture and arrow (ruled: the row's line is its state), community tiles without the standard's
  ring, the search field always on show on a phone (the mockup's page), Featured's two cards in three columns.
- "No replies yet" in small capitals: the reply pane wears the kit's day rule (`looks.json`, the Messages
  lane's wear, shared with Messages' own reply pane); changing it is that group's.
- The list beside an open request scrolled past its head, and a private thread's title cut in the narrower
  pane: the tour's 520px list and what is left for the column.

### Fix group 3, as built (11 Nov 2026): the visual pass on lanes T, K and Y

Work list: `skins-tour-v2/visual/v3.md`. Captures: `skins-tour-v2/local/caps/f3-*.png`.

- **Challenges on a phone (s53).** An open challenge is the kit's wrapping row (`<Row wrap>`), so its name and
  its line are whole beside the points pill.
- **The friend search (s49).** The kit's page resets every margin and padding inside it, so the result list's
  utilities said nothing there. Its card, rows, picture and friend button are spelt in the Friends block of
  app.css with the kit's values (`.row`, `.av`, `.btn.sm`); an act (Add friend, Accept) keeps the accent.
- **You's Changes, Requests and Votes (s46 to s48) hold what History holds.** The rows are built by the bot's
  lists' own model (`features/ai/lines.ts` `useAiLines`, fed History's rows alone) and drawn by the rows the
  bot's page draws under a look (`features/ai/frame-list.tsx` `Groups`, now exported, with one new prop,
  `where`). So a project folds after its first three rows with "Show N more" (`GROUP_FIRST.live`, as History),
  a row's own line ("Homeroom · #6454") is its tooltip and its spoken words, and on a phone it is the row's
  second line, which is where the number is said there. One project picked: its name is not said again over
  its rows, as on the bot's page. A row is a button that opens its page, as History's is (it was a link).
  "You left" is said in History's own words; `profile:frame.projectLeft` is removed. On a phone how a row ended
  stays beside its title instead of dropping under it.
- **A request and a change (s32 to s35).** The reply box is as wide as the cards it answers (the standard
  thread's 12px and 32px insets are dropped under a look). The Tested card's Open app is the kit's small quiet
  button.
- **Import (s43).** The page is 1024px at most, so the title and its sentence keep one line each beside the
  buttons in every look (measured: a 498px sentence beside 439px of buttons).
- **Friends (s49).** A friend's row has the chevron the standard rows have.
- **Edit profile (s50).** Display name and Bio are the kit's sunk field under their label.
- **A public profile with no bio (s51, s52).** One column: the verified accounts lead it, then Report user.

Rulings taken: the standard History row has no visible second line (its project and number are its tooltip),
so the tabs draw that line on a phone only, where the number has no column; on a desktop it is the tooltip.
Left, and why: see the hand-back table (the bar's title and Mosaic's tiles are group 1's; the kit's `Bars`,
the product's menus, sheets and dialogs, and the wash behind Make are outside these pages' files).
### Fix group 2, as built (11 Nov 2026)

What the visual pass found on Messages and a project's pages (`skins-tour-v2/visual/v2.md`), on
`redesign/skins-v2-fix2`, cut from `5e90072f2`.

Fixed:

- **All items by stage: the Done column** (A). The board's pane was held to the 720px content column: the rule
  that frees it (`… [data-all-group="stage"] ~ .dev-ws-tabbody > * { max-width: none }`) weighed the same as
  the later rule for every place's body and lost to it. It now carries the same `:not([data-ws-tab="needs"])`
  and wins. Under the kit's column the board still scrolls sideways where four columns do not fit, as the
  standard board does.
- **Your work on a phone** (A). The counts ("Needs you: 5 · In progress: 6") end the row on a desktop
  (`meta d`) and stand under it on a phone, as a `cardnote last p` inside the card.
- **Messages, Try again** (B). `state.reading` (a read under way with no conversation in hand) keeps "Nothing
  here yet." away. The standard list says nothing there either.
- **Messages, a long group name** (B). The name is in a `cut` span, which is what gives way; the "AI" badge
  and the member count keep their place (three hand rules under `[data-messages-frame-list]`).
- **#general on a phone while a banner is up** (B). Under a look, in a phone browser, with either pause
  notice shown, `#dev-forum-scroll` takes the window less the header itself and the page's box is what the
  flex chain leaves (`height: auto`), so the room ends at the tab bar. The standard page's measure
  (`--ws-fit`) is not touched and its composer is still cut there.
- **Who decides** (C): the named approvers' faces lead their names (`rule.faces`, the kit's `Avs` at 20px,
  inline by one hand rule). **"3 on you"** (C) is in the accent (`subAsks`). **Order categories** (C) are radio
  rows (the kit's `chk round`). **The board's search** (C) holds its placeholder (360px at the tabs' end, 12px
  margins on a phone). **A category's name on two lines** (C) keeps its second line under its first (the glyph
  hangs before it). **The Hub's People line** (C) is printed whole (`wrap="all"`).

Not faults:

- A deleted account's face says "D": the kit's face is a name's first letter for everybody (`Av`), where the
  standard list draws two initials.
- Mosaic draws Topics as tiles without arrows: that is the look ("Lists become tiles", `mosaic.css`), and the
  Channels row beside it is in the side column, which it leaves as rows.
- Pourover's bar has no Suggest on a phone in the standard look either.

Left to group 1: the project's name in the bar running under the bar's buttons on a phone.
### Fix group 5, as built (11 Nov 2026): signed out and the waiting room

Repairs to lane G after the visual pass (`skins-tour-v2/visual/v5.md`), on `redesign/skins-v2-fix5`, cut
from `5e90072f2`. What changed, and what a later lane should know:

- **The waiting room's controls are worn, not dressed by hand.** Look around, Join, Save and the "How did
  you find us?" choices wear the button (a choice not taken is the quiet small one, the chosen one the
  look's primary; Save and Join dim while they cannot be pressed), Skip the link, the country and the
  invite's field the field, and "Two quick questions" the card with its title as the label over it, as the
  invite card's is. A dead invite link's title and Continue wear the title and the button. A hand-set
  `background: var(--fr-acc)` was the cause of the blue buttons under Brand kit and Sunrise: a look says its
  own button, and only a worn node gets it.
- **These wearers are named by the nodes' own hooks** (`form[data-waiting-about="ask"]`,
  `a[data-waiting-look-around][href="#apps"]`, `#waiting-about-save`, …), not by `#auth-waiting-screen`:
  `tests/looks-css.test.js` holds that version 2's kit rules name no waiting-room node, and a wearer of
  `btn`, `inp` or `link` picks up the few version 2 rules that place those inside a kit element (ten
  selectors, none of which can match in the room, which holds no kit element). The guard's count is 47 now
  and its bound 53.
- **The fields of the stand-alone pages and of the sign-in sheet wear the kit's field** (`inp`), in place of
  a hand-set `--fr-ground` box. Every look but the kit's default restates its field (Paper white, Sunrise
  sunk, Workbench 34px square), so the hand-set one was a cream box on Paper's white and matched no look.
- **The address in the room's sentence** breaks only when it cannot fit a line (`overflow-wrap: anywhere`
  under a look; the standard room's `break-all` is untouched).
- **The sheet's dimming covers the bar.** The sheet is the landing screen's child, and that screen is a
  layer under the guest's bar (40 under 41); while a sheet is up the screen is the upper one
  (`#auth-landing-screen:has([data-sign-in-sheet])`, in the sheet's own block of app.css).
- **The sheet's email step is laid out as the kit's sheet** (`kitSteps`), the fourth such step: the field's
  card, "or" over a card of rows ("Other ways to continue" when Apple and Google are known, the phone, an
  invite's ways), Send code, and the terms only where the standard step says them. A members' address
  opened by a visitor asks for the sheet before the providers have answered, so it opens on
  this step or on the first one as the timing falls (both were captured locally with the options answered in
  the test browser, on one address); the standard look does the same, and under a look both are now the
  kit's sheet. Every step that carries Email code | Password now draws it as the look's
  tabs. `code`, `phone-code`, `forgot`, `username`, `account` and `link` still only wear the look.
- **`#login-form` and `#register-form` keep their box.** The ways that stood after each form are its last
  child now, in a neutral wrapper (`.auth-ways`: a class, no id, so the shell baseline is unchanged) that
  takes back the one gap the form would put before it (`-mt-4` in the login form's `gap-4`, `!mt-0` in the
  register form's `space-y-4`). Under a look the form is the flex column `order` works in. Sixteen
  `look=standard` captures (sign in, forgot, email code, register; desktop and phone; light and dark) are
  the same bytes before and after, and so are the Glass and Paper captures of the two pages.
  `#otp-step-email` and `#recovery-email` still step aside with `display: contents`: they are `<div>`s with
  no role to lose, and what `order` puts between their children (the error, the status, the way back) is
  shared with the steps beside them.
- Smaller: the landing's search is flush in the page's column (one gap, not two); on a phone the three
  points are their titles alone, as the standard landing; `#challenges` names the bar Challenges; "I already
  have a code" stands 16px under the primary button; a public project's four buttons take 12px of padding
  on a phone and may wrap; the Discussion tab's Join stands 16px under its sentence.

Left, and why:

- **Communities on the landing** (ten featured cards in three columns, a blank tile while an icon loads, two
  tile sizes down the rows, the closing line at the start): all drawn by `home/frame/to-join.tsx`, Home's
  own view, which the landing only mounts.
- The rows of a stand-alone page are still drawn by hand (the `row` root is Settings').
- Not seen: the room with a real account in line, and what follows Save, Skip or Join (nothing was
  submitted). The room was seen through `/?shot=waiting` and `/?shot=waiting-invite`.

### Leftovers, group C (11 Nov 2026): Settings' last pieces, and the standard look compared with the base

**Settings (s56 to s73).** The rules of lane S held: one markup for both looks, no node settings.js binds
moved or re-created, every id and class kept; what was added is names that draw nothing in the standard look.

- **The list stays in view on a desktop** (overturns lane S's ruling "the list is part of the page"): under a
  look `#settings-sidebar-col` sticks 16px under the bar once the head has scrolled away and scrolls on its
  own when it is taller than the window, as the standard look's list does. It is 8px larger on every side
  and takes them back as margins, so the cards keep their shadows inside the scroller.
- **A field inside a card has an edge in Pastel and Paper** (the Language and Look menus, the Cap $ field, the
  keys): Pastel takes the sunk fill it uses on a white sheet with a hairline; Paper keeps its white field
  with a ring that shows. Said in Settings' own block (`html[data-skin="pastel"|"paper"] #settings-screen …`),
  not in the looks' files.
- **In Paper a quiet button inside a card is the white one** (found reading the dark steps: Upload, Change
  and the rest stood sunk on a sunk card, in light too). Paper says so itself (`.card .btn.quiet`), but the
  wear map repeats a rule for the wearers of one component at a time, so that rule reached Settings' cards
  holding the kit's own button and never Settings' own buttons. Said by hand for this screen; **needs group
  A** for the cause (below).
- **With the keys up on a phone the tab bar goes while Settings is open.** The standard look hides
  `#platform-tabs` on `html.un-kb` and `html.platform-kb-open`; the frame's `.fr-tabbar` had no such rule,
  so with "Find a setting" focused it rode on the keyboard (seen by focusing the field with a tap and making
  the page as short as the app's web view makes it: `platform-kb-open` comes on). The frame measures its
  page area, so the room returns to the page by itself. The rule is scoped to Settings here; the same fault
  is on every page with a field on a phone (**needs group A**, below).
- **Disconnect in a tool's card is the small bad button** (`ui-btn-sm` on the button, which had no class
  that says small).
- **Homeroom Wallet** (shown locally from the console: `Settings.state.walletLinkEnabled = true;
  Settings._renderWalletSection(); Settings._renderNavIfOpen(); location.hash = '#settings/wallet'`, with
  `Settings.state.usernodePubkey` set or cleared and `Settings._walletPollTimer` set for the three states):
  the page's note, then the button; or the QR in a card (`ui-card` on `#wallet-linking`) with its time left
  and Cancel under it, the code on its white ground; or the linked key as one row of a card
  (`ui-card ui-walletkey`), mono, behind the look's tick.
- **Homeroom app** (opened locally with `/#settings/usernode?usernodedemo=ios`, which draws the connection
  and the permissions; every other part was drawn by publishing a sample model from the console,
  `window.UsernodeReact.settingsUsernode.publish({…})`): each part is one card headed by its name and its
  note. The card is the part's own box (`ui-card ui-unsec` on `UnSection`'s root, the block the standard
  look rules off), and a status row is named `ui-unrow`; everything else is dressed by hand rules under
  `#settings-usernode-section` (the state's dot and word in the look's ok or waiting ink, a switch at the
  end of its row, notices as tinted boxes, the help's questions as sunk boxes, mono for build and error
  words). **No wrapper stands round a part's nodes.** A first version put one there (`ui-unbody`), and the
  comparison with the base caught it changing the standard look: the standard sheet styles the paragraph
  that follows a heading (`.settings-sheet h3 + p`: 15px, 14px under it), which About's first build line
  and Account's sentence are, and the wrapper stood between the two. The lesson for any further wrapper in
  Settings: a neutral wrapper is neutral only if nothing in the standard sheet reads the nodes on either
  side of it as neighbours.
- **Dark mode.** All eighteen steps were read in Glass dark on a desktop, and the four the visual pass had
  not read in dark (s63 calm, s66, s67 on a phone, s70) in a second look each on a phone or a desktop. One
  fault found (Paper's quiet button, above); nothing else.

Needs group A (shared files, not changed here):

- `scripts/build-looks-css.js` / the wear map: a kit rule naming two components (`.card .btn.quiet`) is
  repeated for the wearers of the first only, with the kit's class kept for the second
  (`:is(.ui-glist,.ui-card):is(#settings-root *) .fr-btn.fr-quiet`). It should pair a root's wearer with
  the same page's wearer of the other root. Only `paper.css` has such a rule today
  (`.card .btn.quiet,.card .btn.line{background:var(--surface);box-shadow:none}`). With that fixed, the hand
  rule "IN PAPER A QUIET BUTTON INSIDE A CARD" in Settings' block can go.
- The frame's hand rules: `@media (max-width: 767.98px) { html[data-skin]:is(.un-kb, .platform-kb-open)
  .fr.fr-shell .fr-tabbar { display: none; } }`, for every page (Messages' composer, the bot, #general, a
  request's reply box all keep the bar on the keys today). With it, Settings' scoped copy can go.
