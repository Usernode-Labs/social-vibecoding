/**
 * The Challenges block: what the viewer can do next.
 *
 * ── Named by what it holds (the Semi design, 2026-10-16) ───────────────
 *
 * HomePanels.challengesView decides, and the section heading says it:
 *
 *   First challenges — every First challenge while any is unfinished, in the
 *                      admin's order, the done ones in place as the card's
 *                      one-line finished shape (#4563).
 *   Next challenges  — once those are done: up to three open challenges,
 *                      in the Challenges tab's order (polish N11: not by
 *                      progress, which reshuffled them on screen).
 *   Challenges       — over ONE LINE when nothing is open: "All done for
 *                      this week" when this week's are all done, otherwise
 *                      "No challenges right now".
 *
 * The heading and its "See all" are ./sections.tsx's (they sit in the static
 * section heading, filled in once the view arrives); this file draws what is
 * under them.
 *
 * What the block used to carry and does not any more: the season progress
 * line and bar (`.home-panel-season`), the points total, "N of M done", the
 * group headers (This week, Always open, Season challenges, and the Done
 * header `home-challenge-done-head`), the clocks on them and on the cards,
 * the footer's "See all N challenges" / "Show less" toggle, and the "Open
 * challenges" link. The Challenges tab, one tap away behind "See all", has
 * the whole list.
 *
 * ── A ROW OF CARDS (One Home, #6361; a column until then), and the card
 *    is the Challenges tab's ─────────────────────────────────────────
 *
 * The cards sit straight on the page ground, in one row under the section
 * heading that scrolls sideways, with no plate around them (`PanelShell
 * plate="none"`): the cards are surfaces of their own. The heading ends on
 * `pb-1.5` and the body opens on `pt-2`, a 14px step, and the cards sit
 * `gap-2.5` (10px) apart, the step of the featured apps rail. Nothing is
 * inset: the cards start where the heading's label starts.
 *
 * THE CARD IS SHARED. It is `ChallengeCard` from
 * features/leaderboard/challenge-card.tsx, the same component the
 * Leaderboard screen's Challenges tab draws, so a challenge reads the same
 * state, words and reward on both surfaces. Home hands it no deadline. Only
 * the root class `home-challenge-card` and `data-challenge-id` are this
 * block's, because the declared checks and the tests select on them.
 *
 * ── The one line ──────────────────────────────────────────────────────
 *
 * With nothing open the block STAYS, for everyone, and says why in one card:
 * a block that silently vanished would leave the viewer unable to tell
 * "nothing to do" from "this broke". It is a statement, not a control: "See
 * all" beside the heading is the way to the tab when there is one. It keeps
 * `home-panel-rows home-panel-row` and the article's `data-rows="0"`, which
 * the declared checks select the empty state by.
 *
 * ── Loading and failure ───────────────────────────────────────────────
 *
 * Until the first paint (both the panels' read and the apps') the section
 * holds its heading's box with no words and three card skeletons, at the
 * height this device last drew it (./sections.tsx, ../../../lib/first-paint-reserve.ts). A failed
 * read keeps no copy, so the section is hidden (HomePanels.ensureLoaded is
 * silent on failure); there is no error state to draw.
 */

import { ChallengeCard } from '../../leaderboard/challenge-card';
import type { ChallengesView } from '../panels-store';
import { PanelShell, panels } from './ui';

export function ChallengesPanel({ view }: { view: ChallengesView }) {
  if (view.note) {
    return (
      <PanelShell panelKey={view.key} plate="none" stamps={{ rows: 0 }}>
        <div className="home-panel-body pt-2">
          {/* Rows are 15 over 13 (AGENTS.md): the title at 15px/650, the
              sentence at 13px muted. White on the page ground like the
              challenge cards, so the line sits where a card would, with the
              20px corners of a card this short. `.home-panel-row` gives it
              its fixed 56px height (app.css) and its nowrap, so the two
              lines are centred in it rather than padded. */}
          <div className="home-panel-rows home-panel-row home-challenges-note flex flex-col justify-center gap-0.5 rounded-[1.25rem] bg-white px-4 dark:bg-zinc-900">
            <p className="truncate text-[15px] font-[650] leading-5 text-zinc-900 dark:text-zinc-100">
              {view.note.title}
            </p>
            <p className="truncate text-[13px] leading-[1.125rem] text-zinc-500 dark:text-zinc-400">
              {view.note.text}
            </p>
          </div>
        </div>
      </PanelShell>
    );
  }

  return (
    <PanelShell panelKey={view.key} plate="none" stamps={{ rows: view.rows.length }}>
      {/* ONE HOME (#6361): ONE ROW THAT SCROLLS SIDEWAYS, under Pinned
          communities. The cards are the same; each is a fixed width so the
          next one peeks in from the edge and says the row goes on. The row
          runs to the screen's edges on a phone (`-mx-3 px-3`, the section's
          own gutter given back) and snaps a card to the gutter. */}
      <div className="home-panel-body pt-2">
        <div className="home-panel-rows -mx-3 flex snap-x snap-mandatory scroll-px-3 gap-2.5 overflow-x-auto px-3 pb-1 [-ms-overflow-style:none] [scrollbar-width:none] [&::-webkit-scrollbar]:hidden">
          {/* Each card is the row's own child, as the declared checks
              select it (`.home-panel-rows > .home-challenge-card`). */}
          {view.rows.map((row) => (
            <ChallengeCard
              key={row.id}
              view={row}
              className="home-challenge-card w-[min(19rem,82vw)] shrink-0 snap-start"
              data-challenge-id={row.id}
              onClick={() => panels()?.goToChallenge?.(row.eventId, row.id)}
            />
          ))}
        </div>
      </div>
    </PanelShell>
  );
}
