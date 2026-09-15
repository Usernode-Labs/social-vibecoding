/**
 * The Challenges block: what the group is working towards.
 *
 * ── Two branches, and why the empty one is not "nothing" ──────────────
 *
 * With no season running the block STAYS — for everyone, admins included — and
 * says so in one line. A block that silently vanishes between seasons leaves
 * the viewer with no way to tell "nothing is running" from "this broke".
 *
 * ── A PLATE OF CARDS, and the card is the Challenges tab's ─────────────
 *
 * One card per challenge on a translucent plate that holds them and the season
 * summary together (`.home-challenges-plate` in app.css): at 55% the grouping
 * reads and the wallpaper's washes carry on through.
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
 * THE DEADLINE IS ON EVERY OPEN CARD, on the line under its title beside the
 * reward ("5d left · 500 pts"): the challenge's own end, else its event's,
 * else the season's.
 *
 * ── Group headers, without counts ─────────────────────────────────────
 *
 * When the cards on screen come from more than one of the board's groups
 * (Setup, This week, Always open, the season's other challenges), each group
 * opens with the tab's `GroupHeader`, static here: no toggle, no collapse and
 * no count, because the four cards Home is sent are not the whole group. The
 * header then owns the clock ("This week · 3d left", "Always open · no
 * deadline") and the cards under it drop theirs; Setup's keep their own.
 * Cards from one group draw no header at all. HomePanels.challengeGroups
 * decides all of it; the headers sit inside `.home-panel-rows` beside the
 * cards, which the declared checks select through.
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
 */

import { Fragment } from 'react';

import { ChallengeCard } from '../../leaderboard/challenge-card';
import { GroupHeader } from '../../leaderboard/group-header';
import { SeasonProgress } from '../../leaderboard/season-progress';
import type { ChallengeGroupView, ChallengesView } from '../panels-store';
import { PanelFooter, PanelShell, panels } from './ui';

export function ChallengesPanel({ view }: { view: ChallengesView }) {
  if (!view.rows.length) {
    return (
      <PanelShell panelKey={view.key} expanded={false} plate="soft" stamps={{ rows: 0 }}>
        <div className="home-panel-body">
          <p
            className="home-panel-rows home-panel-row flex items-center px-2.5 text-[13px] text-zinc-500 dark:text-zinc-400 cursor-pointer hover:bg-violet-500/[0.04] dark:hover:bg-violet-500/10 transition-colors"
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

  return (
    <PanelShell
      panelKey={view.key}
      expanded={view.expanded}
      plate="soft"
      stamps={{ rows: view.rows.length }}
      footer={(
        <PanelFooter
          panelKey={view.key}
          total={view.total}
          expanded={view.expanded}
          expandable={view.expandable !== false}
        />
      )}
    >
      {view.season ? <SeasonProgress view={view.season} className="home-panel-season px-1 pb-3 pt-0.5" /> : null}
      {/* #1915: padded on BOTH sides. With `pb-3` alone the line sat flush
          against the season progress's bottom hairline above it. */}
      {view.onboardingNote ? (
        <p className="px-1 py-3 text-sm text-zinc-500 dark:text-zinc-400" role="status">
          {view.onboardingNote}
        </p>
      ) : null}
      <div className="home-panel-body">
        <div className="home-panel-rows flex flex-col gap-2">
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
        </div>
      </div>
    </PanelShell>
  );
}
