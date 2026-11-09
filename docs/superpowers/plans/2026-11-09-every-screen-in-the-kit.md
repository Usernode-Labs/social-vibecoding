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
