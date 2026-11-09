# Every screen in the tour's kit — programme

> **For agentic workers:** REQUIRED SUB-SKILL: superpowers:executing-plans. One milestone at a
> time; each milestone gets its own task list when it starts.

**Goal:** every screen the 2026-11-06 screen tour draws (about 115: 73 signed in, 27 signed
out, 12 on the waitlist) renders in the product exactly as the tour draws it, under each of the
nine looks, at desktop and phone width, in light and dark.

**Why the first attempt did not match (9 Nov, the user's check against the tour).** The
foundation and looks plans kept today's sidebar, header and tab bar and drew only Home's body,
from Tailwind primitives carrying a hand-picked subset of each look's values. The tour is built
another way: one kit of components (`page()`, `sheet()`, `s()`, `r()`, `tiles()` … in the
tour's `kit.mjs`) with one stylesheet (`kit.css`), and a look is one more stylesheet over it.
Nothing short of drawing with that kit and those stylesheets lines up.

**Architecture.**

- **The kit's stylesheets are the product's.** `frontend/looks/kit.css` and one file per look
  (`glass.css`, `brandkit.css` …) are the tour's own files, kept in the tour's notation.
  `scripts/build-looks-css.js` compiles them into a marked section of `public/css/app.css`:
  classes prefixed `fr-`, tokens prefixed `--fr-`, `.hr` → `html[data-skin="<id>"]`,
  `.dark` → `.dark` on `<html>`, `.phone` → `@media (max-width: 767.98px)`, each rule keeping
  the weight it had relative to its neighbours. A test holds the section to the script's output.
- **The kit's components are React** (`frontend/@/components/ui/kit.tsx`): `Page` pieces,
  `Sec`, `List`, `Row`, `Tiles`, `Facts`, `Sheet` …, emitting the kit's markup. A screen is its
  data bound to them, as in the tour (`screens/*.mjs` is the blueprint for each).
- **Under a look the frame owns the viewport.** One island (`features/frame/frame-app.tsx`)
  draws the kit's sidebar, bar, banner, page area and phone tab bar with real navigation, counts
  and recents; today's chrome is hidden. A screen drawn in the kit renders in the page area; a
  screen not yet drawn keeps its own body, placed in the page area, until its milestone.
- **The standard look is not touched.** Everything above is behind `isFrameSkin()`.

**Acceptance, per screen:** the product beside the tour's own render of the same step, for
each look × desktop/phone × light/dark (`tour/compare.mjs` in the session scratchpad), read by
eye; differences are data (real names and counts), never structure or style.

## Milestones (the tour's order)

| # | Screens (tour ids) | Count |
|---|---|---|
| M1 | The kit, the chrome (sidebar, bar, banner, tab bar), Home (s01–s04) | 4 + chrome |
| M2 | Sheets on Home: notifications, account menu (s05–s07) | 3 |
| M3 | Homeroom bot (s08–s14) | 7 |
| M4 | Messages (s15–s20) | 6 |
| M5 | Communities and a project: list, hub, places, Needs you, Workshop, all items, votes, #general (s21–s31, s36–s37) | 13 |
| M6 | A request and a change (s32–s35) | 4 |
| M7 | A running app, Discover, app detail, Make (s38–s43) | 6 |
| M8 | You: profile, your changes/requests/votes, friends, edit, public profiles (s44–s52) | 9 |
| M9 | Challenges and standings (s53–s55) | 3 |
| M10 | Settings, 18 panes (s56–s73) | 18 |
| M11 | Signed out: landing, sign-in sheets, gated screens, public pages (o01–o27) | 27 |
| M12 | Waitlist (w01–w14) | 12 |

## Notes

### M1, as built (9 Nov)

Done, on `redesign/one-frame-glass` (`d8171aa56`, `49e27f359`):

- **The kit's stylesheets.** `frontend/looks/` holds the tour's `kit.css` and nine look files
  verbatim; `scripts/build-looks-css.js` compiles them into the `looks:begin … looks:end`
  section of app.css (104 KB), with each look's fonts, tint, opaque fallback and (Brand kit)
  page from `looks.json`. `tests/looks-css.test.js` holds the mapping and the section.
- **The kit's components.** `frontend/@/components/ui/kit.tsx` and `kit-icons.ts` (the tour's 76
  glyphs). The hand-made `frame.tsx` / `status.tsx` and the hand-ported look blocks are gone.
- **The chrome.** `features/frame/frame-app.tsx` draws the kit's sidebar, bar and phone tab bar
  from the stores the shell's own navigation reads, and hands each press to the shell's own
  control (today's header and tab bar stay mounted, unseen). It publishes the page area it
  measures; app.css ("THE FRAME IN THE SHELL") maps that onto `--platform-rail-full`,
  `--platform-header-h` and `--platform-tabs-h`, so a screen not yet drawn in the kit sits in
  the page area too. An inert copy behind the screens paints the page column (Paper's sheet).
- **Home (s01).** The tour's page with the product's data. Compared with the tour's own render
  for all nine looks, desktop and phone, light and dark: the same structure and positions.

Left in M1:

- **Home's side column.** The tour shows "Live this week" and the season rank. There is no
  endpoint for changes that went live across a viewer's communities (`/api/leaderboard/prs` is
  the kudos board, and returned nothing for the week), nor a one-call season rank; the page
  reads the former and so draws no side column today. Needs one small read route.
- **The bar's search.** It calls `Home.focusSearch()`, whose input belongs to the standard body
  that is hidden under a look. The tour gives search no page of its own; decide where it opens.
- **s02–s04** (Home scrolled, all apps, all communities): the groups' "All N" links go to the
  standard destinations.
- **A community's places.** Today's sidebar nests them under its row; the tour makes them the
  page's tabs (M5). Until then a project's page has its row lit and no place list beside it.
- **JetBrains Mono.** The kit's `--fm` names it and seven looks keep it; it is not vendored, so
  `.fr-mono` text falls back to the system mono until a screen that shows ids is drawn (M6).

Things learned that the next milestones need:

- The local server reads `public/shell/release.json` once at boot. After `npm run
  ensure:shell`, restart it, or a browser with the service worker keeps yesterday's shell.
- A look's rule only beats a kit rule the way it did in the tour because the compiler keeps
  weights (`[data-skin][data-skin]` for phone rules). Never hand-edit the generated section.
- A row's name and line are spans (they sit inside links and buttons); app.css gives them the
  block box, at a weight under any kit rule that says otherwise.
- A fixed layer with a negative z-index sinks under `<body>`'s background unless `<body>` is a
  stacking context (`isolation: isolate` while the chrome is up).


### M2 to M4, as built (9 Nov)

Done since M1 (commits `dd59f4774` to `05a13bf7b`):

- **Home's side column, All apps, All communities (s01–s04)** and the two sheets on Home
  (**Notifications, the account menu**, s05–s07). `GET /api/workshop/live-feed` is the read the
  side column needed; it applies the same visibility filter as the app list.
- **Homeroom bot (s08, s09, s14):** the kit's list beside Main Chat, the tour's split.
- **Messages (s15–s18, s20):** the kit's list with People and Agents as the page's tabs, New
  message as the standard sheet, and the open conversation in the open-item pane.
- **How a conversation is drawn.** The product's renderer still draws it (message rows, the
  head, the composer): it has hundreds of behaviours the kit's markup has no word for. Instead,
  `looks.json` "wear" maps the kit's `post`, `day`, `dhead`, `composer` and `ib` onto the
  product's classes and the compiler repeats each of their rules for those, so every look's own
  rules for a conversation apply. app.css ("A CONVERSATION WEARS THE KIT") sets aside only what
  the standard look sets and the kit does not. The same mechanism serves any other surface the
  product must keep drawing itself (a request's thread in M6, a channel in M5).
- **`useLiveSkin()`** (lib/skin.ts) is the look for anything drawn many times over or mounted
  after the first paint: one listener for all readers, no standard-markup flash.

Rulings made on the way (each costs a redo of that piece if wrong):

- A person's consecutive messages stay separate rows, drawn as one post (the tour merges them
  into one text; the product keeps each message's own actions).
- New message has one field, as the tour draws it. A group made there is named after the people
  in it; the standard dialog's name and note fields are not asked. Blocked people is a link at
  the sheet's foot, which the tour does not draw: the dialog was the only place that listed them.
- With nothing open, Messages keeps the split (list left, "Choose a conversation" beside it);
  the tour never draws that state.
- The conversation head keeps the product's Full width disc beside the ⋯; the tour draws only ⋯.
- A bold word a person wrote is not coloured as an accent (the kit's `.post .txt b` is left out
  of the wear map).

Left in M3 and M4:

- **s10–s13** (a request and a private thread in the bot's pane, the bot's New thread sheet).
- **s19, the reply thread.** It is the product's side panel wearing the kit's posts and composer,
  not yet the kit's side sheet; on a phone it is a full page, not a sheet from the bottom, and
  the bar's arrow there should go back to the chat.
- **A message's reply link** is the product's thread card, not the kit's one-line "3 replies".
- **An agent chat (s20's open pane).** A handed-off chat opens its request's page (M6).
- The head's line says "Direct message"; the tour adds the communities two people share, which
  no endpoint gives. New message's rows have no second line for the same reason.

Things learned:

- A hook behind `&&` is a crash when the left side flips (`drawerOn && !isFrameSkin(use…())`).
  `tests/messages-frame-stream.test.js` refuses the pattern anywhere under `frontend/src`.
- A catalog entry may not start or end with a space: join data (usernames) in code instead.
- A worn kit rule would also reach the New look ("brand" carries `data-skin` too); the compiler
  leaves it out with `:where(:not([data-skin="brand"]))`, at no weight.
- The whole-suite runner can stall on one file when hundreds run together; each passes alone.
  Run suites in bounded chunks (scratchpad `tour/run-suites.sh`).

### M5, as built (9 and 10 Nov)

Rebased onto main `10a33681e` on 10 Nov (38 commits, none behind).

Done: a project's page in the kit (`features/dev-board/workshop/frame/project-frame.tsx`,
presentational; `workshop.tsx` computes its props just before its return and draws it ahead of
`{band}{tray}`, which stay as written).

- **The Hub (s23, s24, s36), Topics (s25), the Workshop (s27, s28, s37)** are drawn in the kit
  from what the page's own Hub and Workshop read. Join is the primary button for someone signed
  in who is not a member.
- **#general and the topics' channels (s31)** use the one message style: the app chat's shared
  row and day label (`@/components/ui/chat.tsx`) emit the kit's post under a look.
- **The bar on a project's page** leads with the project's tile and name, then the place; its
  arrow goes up to the Hub, then Home.
- **All communities (s21, s22)** was built with Home in M1: tabs by audience, a search, Needs
  you, the rest, votes waiting beside them.
- **A look picker beside the bell**, for admins (`features/frame/look-picker.tsx`).

Left in M5:

- **Needs you (s26)** keeps the product's review stage (the change's before and after, Yes / No
  with a reason, Skip) under the kit's head. The tour draws a ballot and "Replies you owe" rows;
  the stage is how a vote is actually reviewed and cast, so this is a ruling until told otherwise.
- **All items (s29) and votes waiting (s30)** keep their standard body under the kit's head: the
  tour's stage tabs, one row per item with the five-stop line, and Show / Sort beside them.
- **A week's page** (from Week by week) and **Homeroom bot's slots page** are the standard bodies.
- **A channel's context column** (members, Notify me, pinned) is not drawn; the channel keeps its
  own line and Mute over the transcript, and its card around the posts.
- **All communities** has no "New since you last looked" / "Quiet" split: nothing says per
  community what is new since the last look.
- What the standard Hub also carries and the kit's does not yet: the first-version card, the
  update card, Share it, the start-here prompt and the notification ask. They stay mounted behind
  the kit's Hub, unseen; each needs a kit form (a note or a row) or a ruling to drop it.

Rulings:

- The approval rule is said in a few words on the kit's rows ("11 of 41 members say yes"), with
  the wait, or "After the checks pass", as its line.
- The Workshop's figures are the product's four (open, nobody on them, waiting on votes, live
  this week); the tour's five stages (Plan, Build, Checks, Vote, Live) are not counted anywhere.
- The Workshop's ballot has one button, Review and vote, which opens Needs you: a No says why,
  which two inline buttons leave no room for.
- Your work is one row (the bot tab's summary for this project), not the tour's row per item.
- The Hub shows three topics and "All N". Topics is a page of the kit only: it has no address of
  its own, and a topic's channel is lit as Topics.

Learned:

- `workshop.tsx` is pinned line by line by a dozen suites (`{band}\n{tray}`, the hub-cards
  import, `{tab === 'status' ? (pending ? null : (`). Add, never rewrite; hide with CSS.
- app.css may not look inside the board's hosts with `:has()`; say the state on `<html>` instead
  (`data-project-frame`, set by the kit page while it is mounted).
- The tour's CSS is left-to-right only. The compiler writes logical sides
  (`mapDeclarations`); hand rules in app.css must too (`tests/rtl-logical-css.test.js`).
- A flex column shrinks a child with `margin: auto` to its content: give it `width: 100%`.
- Rebasing: the durations baseline keeps main's side through a throwaway merge driver, and the
  frame's suites are re-added once at the end.

Next: M6 (a request and a change, s32 to s35). Their pages are `features/dev-board/topic/*`
(6,600 lines) inside a host app-view.js creates; their threads should wear the kit the way a
conversation does.

### M6, M8 and M10, as built (10 Nov)

Done (`2794197c3` to `0fe7f6f2d`):

- **A request's page and a change's page (s32 to s35).** The page is still the product's
  (`features/dev-board/topic/request-head.tsx`, `change-head.tsx`). Under a look it says its
  trail to the bar (project, Workshop, the item), its head is the kit's
  (`topic/frame/topic-frame.tsx`), the request's words and status wear the look's card
  (`looks.json` "wear": card), and status, progress and About stand in a 320px context column.
  Those are separate children the page writes in its own order and fifteen suites hold its lines,
  so the column is laid from measured heights (`topic/frame/side-stack.ts`).
- **The You tab (s44, s45).** `features/profile/frame/you-frame.tsx`: the profile's own view
  with another face. A kit page says it is up on `<html>` through one shared hook now
  (`features/frame/frame-flag.ts`).
- **Settings (s57 to s73).** Laid out as the kit's page by app.css alone, every section at once:
  the section first at 720px with the kit's title, the list of sections 320px beside it.
- **The look picker** beside the bell gained a light and dark toggle.

Not verified live: a change with a page of its own. On this copy every change address lands on
its request's page (one page per thread), so the change page's kit head and column are held by
tests only.

Left in these milestones:

- **A request's page:** the tour's primary button in the head (the product keeps its action in
  the Status card, where its reason is), the "Follow this request" row, the status card in the
  kit's own form (pill, five-stop line, one sentence). The plan card, spec cards and a change's
  section keep the standard look's surfaces inside the kit's column. A change built for a
  request keeps its votes and checks in its section, not in the context column.
- **You:** the tabs (Changes, Requests, Votes, Friends) are rows, not tabs; Public page and
  Copy link; the public profile (s51, s52), Edit profile as the kit's sheet (s50), friends
  (s49) and the three "your …" lists (s46 to s48), which are the bot tab's history.
- **Settings:** the index page of five groups (s56) exists only on a phone (the product's
  level 1); a section's own groups keep the standard look's rows and controls; no sentence
  under a section's title; "Worth a look" is not drawn.

Not started: M7 (a running app, Discover, an app's page, Make), M9 (Challenges and standings),
M11 (signed out, 27 screens), M12 (waitlist, 12 screens).

Learned:

- An item's address on this local copy: `/app/usernode-2d5619/dev/issues/5998` (Homeroom's slug
  is `usernode-2d5619`). Game Corner's items answer 404 here under every look.
- `position: absolute` parts stacked by a measuring hook is the way to make a column out of
  siblings that may not be wrapped; what follows their host is drawn up by `--fr-side-pull`.
- A hand rule that must beat one of the kit's phone rules says the attribute twice
  (`html[data-skin][data-skin]`), as the compiler does.

### M7, M9, M11 and M12, as built (10 Nov)

Done (`007228394` to `392f6e39a`):

- **Challenges and Standings (s53 to s55).** `features/leaderboard/frame/challenges-frame.tsx`:
  your standing as the one line, what to earn and what is done as rows; Standings keeps its own
  table under the same head and tabs.
- **Make (s42, s43)** sits in the frame's page area by app.css alone. A sheet that must be solid
  is solid under a see-through look (`--fr-solid`, from `looks.json` `opaque`).
- **The project's ⋯ menu** stands at the end of the kit Hub's head: the one node the standard
  hero draws, with the hero put away around it.
- **The guest's frame (the chrome of o01 to o27).** `features/frame/guest-chrome.tsx`: one bar,
  no sidebar, no tab bar, up while one of the anonymous shell's six screens is. It reads the
  screen's own header (back, an open app's or project's name, the landing's buttons, Sign out
  in the waiting room) and hands every press to it. In a phone browser, where the document
  scrolls, the screen starts under the bar by a margin.
- **The landing (o01 to o03).** `features/guest/frame/landing-frame.tsx`, ahead of the standard
  guest Discover: the product's own headline and sentence, the kinds of community as tabs, what
  an account adds, apps to try, every public community as a row ending in Look.
- **The sign-in sheet (o04 to o06) and the stand-alone pages (o07 to o11).** The product's own
  sheet and forms, every step, wearing the kit's title, card and button through the wear map and
  laid out as the kit's sheet and 504px column by app.css.
- **A members' page opened by a visitor (o12 to o14).** `features/guest/frame/gated-frame.tsx`:
  a page of its own with Sign in as its primary button; the sheet opens from it and no longer by
  itself under a look.
- **A public community's page for a visitor (o22, o23).** `features/guest/frame/project-frame
  .tsx`, a view the product's page hands its data and state to.
- **The waiting room (w01, w02)** as a stand-alone page, and an account in line looking around
  on the kit's landing (w03).

Rulings:

- **Words are the product's.** The landing says "On Homeroom, communities make apps together"
  and the three points the product already makes, not the tour's "Apps your group makes
  together" and three numbered steps: those words are translated and tested, and the points are
  not a sequence. The bar's second button says "Sign up", as the product's does.
- **A vote on a visitor's page is a row, not the ballot.** The public overview gives yeses and
  noes, not how many may vote or how many it takes.
- **The compiler leaves out a worn rule that hangs a kit state on the product's node** (`.btn.sm`
  on a form's own button): it could match nothing, and nine looks repeated it.

Not the product's to draw, so not drawn:

- **Discover and an app's own page (s39 to s41, o16, o20, o21, w12).** One Home (#6361) retired
  both: their addresses open Home and the project's hub. A running app (s38) is the app's own
  frame.
- **Looking around as a member while on the waitlist (w04 to w09, w13, w14).** The tour proposes
  the member's frame for an account in line; today the member's APIs answer such an account
  with nothing, so those pages would be empty. That is a product change with a server side, not
  a look.
- **"Happening now" on the landing** (one real vote, open now): the public directory says how
  many votes a community has open, not which.
- **Settings without an account (o15), Challenges without one (o17), a public profile (o26)
  and a dead invite link as its own page (o27):** the product answers the first three with the
  gated page and the last with the landing's own note.

Not verified live: the waiting room with a real account in line (this copy has no way to make
one without mail). Its layout was checked signed out, on a desktop width only; an account's
name in the bar and the kit landing in `waiting` mode are held by render tests.

Left, as before: Needs you as a kit page (kept as the review stage by ruling), All items and
votes waiting (s29, s30), a reply thread as the kit's sheet (s19), the bot's panes (s10 to
s13), Settings' index on a desktop (s56) and each section's own rows, You's sub-screens (s46 to
s52), Standings as kit rows, and the request page's leftovers above.

### Leftovers taken up (10 Nov, night)

Done (`6111fe6bb` to the commit after `29048a3f1`):

- **The bot's column (s11 to s13).** A request opened from the kit list stands in the shell's
  side panel, which now takes the kit column's width and line; New thread starts the blank
  thread, as the standard "+" does. The blank thread stays the product's column pane, not the
  tour's sheet (ruling: it is the product's own design, and every start it offers is there).
- **All items (s29).** `ProjectAllItemsFrame`: the board's columns as the page's tabs, one row
  per item with the five-stop line and its word or pill, Show beside them. The board buckets
  its columns only while its own By stage pane is up, so the kit page asks
  `AppView._kanbanView()` itself whenever the Workshop view is republished. Votes waiting (s30)
  is the In review tab of this page, not a page of its own.
- **History in the kit's bot list (s46 to s48):** your changes, requests and votes, by month,
  with the kinds as small buttons; `#homeroom-bot/history?kind=change` lands on it.
- **A public profile (s51, o26)** as the kit's page. **Edit profile (s50)** keeps the product's
  dialog, now solid: `--dc-sheet` follows `--fr-solid` as `--dc-sheet-solid` does.
- **The reply thread (s19)** needed nothing more: under a look it is the side pane beside the
  conversation, a full page on a phone whose bar names it and whose arrow returns to the chat.

Learned: a hook added to the Workshop page must sit with the others at its top; a hook after
the page's early returns is React error #310 (rendered more hooks than before) on the first
render that reaches it.

Still left: Needs you as a kit page (kept as the review stage by ruling), Settings' index on a
desktop (s56: the product has no index there, by ruling) and each section's own rows, Friends
as a page (s49: the product's dialog, solid), Standings as kit rows, and the request page's
leftovers.
