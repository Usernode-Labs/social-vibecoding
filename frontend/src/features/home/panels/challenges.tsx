/**
 * The Challenges block: what the group is working towards.
 *
 * ── Two branches, and why the empty one is not "nothing" ──────────────
 *
 * With no season running the block STAYS — for everyone, admins included — and
 * says so in one line. A block that silently vanishes between seasons leaves
 * the viewer with no way to tell "nothing is running" from "this broke".
 *
 * ── A FLAT COLUMN OF CARDS, and the card is the Challenges tab's ───────
 *
 * The ITERATION 03 board's Home screen draws this area straight on the page
 * ground: the season summary, the group headers, one card per challenge and
 * the footer, stacked in one column under the section heading. There is no
 * plate around them (`PanelShell plate="none"`, as Discover) and no rule
 * between them. The cards and the headers are surfaces of their own, so a
 * translucent plate behind them was a second frame, and its 0.625rem padding
 * pulled the whole block in from the heading's left edge.
 *
 * ONE RHYTHM: every band in the column is a 14px step from the one above it.
 * The heading ends on `pb-1.5`, so each band here opens on `pt-2` and closes
 * on `pb-1.5` (6px + 8px). Inside the rows list the cards, the headers and the
 * locked placeholder sit `gap-2.5` (10px) apart, the same step as the featured
 * apps rail (`.home-discover-rail` in app.css). Nothing is inset: the season line, the headers, the cards
 * and the footer all start where the heading's label starts.
 *
 * THE CARD IS SHARED. It is `ChallengeCard` from
 * features/leaderboard/challenge-card.tsx, the same component the Leaderboard
 * screen's Challenges tab draws, so a challenge reads the same state, words and
 * reward on both surfaces. This block used to draw its own: a tinted card, a
 * category word in the well ("ONBOARDI / NG" on a phone), and a pill with a
 * ○/✓ or a count capsule, the season deadline and a plain reward. Only the
 * root class `home-challenge-card` and `data-challenge-id` are this block's,
 * because the declared checks and the tests select on them.
 *
 * A CARD'S DEADLINE sits on the line under its title beside the reward ("5d
 * left · 500 pts"): the challenge's own end, else its event's, else the
 * season's. Only Get started's open cards draw it; every other group's header
 * carries the clock instead (below).
 *
 * ── Group headers, without counts ─────────────────────────────────────
 *
 * The cards are the Challenges tab's list in the tab's order: grouped by the
 * board's categories (Get started, This week, Always open, the season's other
 * challenges, and a finished Get started last), and collapsed to the first
 * four cards of that list, so the cap takes the first groups and may cut the
 * last one short. EVERY group opens with the tab's `GroupHeader`, one group on
 * screen included, static here: no toggle, no collapse and no count, because a
 * collapsed block does not draw the whole group. The header owns the clock
 * ("This week · 3d left", "Always open · no deadline") and the cards under it
 * drop theirs; Get started's keep their own. HomePanels.orderRows and
 * HomePanels.challengeGroups decide all of it; the headers sit inside
 * `.home-panel-rows` beside the cards, which the declared checks select
 * through, so nothing comes between the season progress and the body.
 *
 * ── While setup gates the season ──────────────────────────────────────
 *
 * The server sends only setup's challenges until setup is finished, plus how
 * many it holds back (`lockedCount`). Those draw as ONE dashed placeholder
 * after the last card, inside `.home-panel-rows` so it keeps the cards' 10px
 * step, but it is not a `.home-challenge-card`: the declared checks and the
 * tests count and select real cards. Its second line ("Finish setup to
 * unlock") is the unlock note, so the note is not drawn beside it.
 *
 * The note itself sits UNDER the challenges, after `.home-panel-body`: the
 * season progress leads, then the cards, then what they unlock. That keeps
 * `.home-panel-season + .home-panel-body` adjacent in every state. It shows
 * only while setup is locked and no placeholder draws (no count to draw):
 * "Finish these to unlock the rest of the season." Once unlocked there is no
 * note.
 *
 * ── The standings preview is GONE ─────────────────────────────────────
 *
 * A block of leaderboard rows used to sit under the challenges. It is
 * removed: this area is called Challenges, and a second list with its own
 * label inside one card made the reader work out which list they were looking
 * at before they could read either. The way to the Leaderboard screen is one
 * tap from here — "Open challenges" (#1916), in this section's own heading,
 * which renders in every branch including the between-seasons one and lands
 * on the screen's Challenges tab, one tab from the standings.
 *
 * It is the ONLY one. The footer used to repeat "Open challenges" at its right
 * end, one card below the heading's; that copy is gone, so the footer draws
 * only when its "See all N challenges" toggle has something to reveal.
 */

import { Fragment } from 'react';

import { ChallengeCard } from '../../leaderboard/challenge-card';
import { GroupHeader } from '../../leaderboard/group-header';
import { LockedChallengesCard } from '../../leaderboard/locked-challenges-card';
import { SeasonProgress } from '../../leaderboard/season-progress';
import type { ChallengeGroupView, ChallengesView } from '../panels-store';
import { PanelFooter, PanelShell, panels } from './ui';

export function ChallengesPanel({ view }: { view: ChallengesView }) {
  if (!view.rows.length) {
    // The line's hover is a text colour, not a tint: with no plate and no
    // inset a background would fill a square box starting at the first glyph,
    // and `.home-panel-body` clips overflow, so a negative-margin inset cannot
    // widen it past the text either.
    return (
      <PanelShell panelKey={view.key} expanded={false} plate="none" stamps={{ rows: 0 }}>
        <div className="home-panel-body">
          <p
            className="home-panel-rows home-panel-row flex items-center text-[13px] text-zinc-500 dark:text-zinc-400 cursor-pointer hover:text-zinc-700 dark:hover:text-zinc-200 transition-colors"
            title="Go to the Challenges tab on the Leaderboard screen"
            onClick={() => panels()?.goToChallenges?.()}
          >
            No challenges are running right now
          </p>
        </div>
      </PanelShell>
    );
  }

  const groups: ChallengeGroupView[] = view.groups
    ?? [{ key: 'all', heading: null, meta: null, rows: view.rows }];
  const lockedCount = view.lockedCount ?? 0;
  const hasFooter = view.expandable !== false;
  const hasNote = !!view.onboardingNote && !(lockedCount > 0);

  return (
    <PanelShell
      panelKey={view.key}
      expanded={view.expanded}
      plate="none"
      stamps={{ rows: view.rows.length }}
      footer={hasFooter ? (
        <PanelFooter panelKey={view.key} total={view.total} expanded={view.expanded} />
      ) : null}
    >
      {view.season ? <SeasonProgress view={view.season} className="home-panel-season pt-2 pb-1.5" /> : null}
      {/* The body closes on `pb-1.5` only when a band follows it (the footer or
          the note), as the first half of their 14px step. A block that ends at
          its last card ends there, on the section's own bottom padding, as
          Discover does. */}
      <div className={hasFooter || hasNote ? 'home-panel-body pt-2 pb-1.5' : 'home-panel-body pt-2'}>
        <div className="home-panel-rows flex flex-col gap-2.5">
          {groups.map((g) => (
            <Fragment key={g.key}>
              {g.heading ? <GroupHeader heading={g.heading} meta={g.meta} /> : null}
              {g.rows.map((row) => (
                <ChallengeCard
                  key={row.id}
                  view={row}
                  className="home-challenge-card"
                  data-challenge-id={row.id}
                  onClick={() => panels()?.goToChallenge?.(row.eventId, row.id)}
                />
              ))}
            </Fragment>
          ))}
          <LockedChallengesCard count={lockedCount} className="home-challenge-locked" />
        </div>
      </div>
      {/* #1915 kept this line off its neighbours. It still is, by the column's
          one rhythm (`pt-2 pb-1.5`, see the header) rather than by a padding
          of its own against a hairline that is gone. It follows the cards,
          and the placeholder's own second line stands in for it. */}
      {hasNote ? (
        <p className="pt-2 pb-1.5 text-sm text-zinc-500 dark:text-zinc-400" role="status">
          {view.onboardingNote}
        </p>
      ) : null}
    </PanelShell>
  );
}
