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
