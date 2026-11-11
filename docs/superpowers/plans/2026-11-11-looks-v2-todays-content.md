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
