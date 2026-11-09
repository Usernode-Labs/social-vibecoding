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
