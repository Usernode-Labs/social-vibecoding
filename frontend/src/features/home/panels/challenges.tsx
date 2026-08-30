/**
 * The Challenges block: what the group is working towards.
 *
 * ── Two branches, and why the empty one is not "nothing" ──────────────
 *
 * With no season running the block STAYS — for everyone, admins included — and
 * says so in one line. A block that silently vanishes between seasons leaves
 * the viewer with no way to tell "nothing is running" from "this broke".
 *
 * ── The row is two lines, and every row has a track ───────────────────
 *
 * It was one 40px line — glyph · goal · count · reward — with a 9px bar riding
 * the bottom EDGE of the numeric rows only, inside a 14px "meter lane" that
 * `.home-panel-rows--metered` reserved on every row of the list so the goals
 * would share a baseline. Two things fell out of that and neither was chosen:
 * the reserved lane put ALL the text 7px above the row's true centre, and on a
 * yes-or-no challenge the lane was a hole where its neighbours had progress.
 *
 * So the row has a second LINE instead of a reserved strip. Goal, count and
 * reward take line one; the track takes line two and runs the full width of
 * the text column. And a yes-or-no challenge draws a TWO-STATE track — empty
 * or full — rather than nothing, which is what removes the mixed list: there
 * is no row without a bar, so there is no baseline left to protect and the
 * flex centring is over the whole row again.
 *
 * The lane's tokens and the bar's derived geometry are gone from app.css with
 * it; `.home-panel-bar-track` / `.home-panel-bar-fill` survive as the names
 * dapp.json and tests/home-panels-render.test.js select on.
 *
 * ── The standings preview is GONE ─────────────────────────────────────
 *
 * A block of leaderboard rows used to sit under the challenges — first as
 * something to spend the fixed 2x2 rectangle on, then, once the hamburger's
 * Leaderboard row was retired, as the home screen's only view of the
 * standings. It is removed: this area is called Challenges, and a second list
 * with its own label, its own footer and its own tap target inside one card
 * made the reader work out which list they were looking at before they could
 * read either. The standings are a screen, and the way to it is one tap from
 * here — "Open leaderboard", in this section's own heading, which renders in
 * every branch including the between-seasons one.
 *
 * What went with it: `FillView`/`FillRowView` and `HomePanels.fillView` on the
 * client, `attachLeaderboardFill` and its two board queries on the server (so
 * a home load asks for one thing less), the `data-fill` stamp, and
 * `.home-panel-fill*` / `.home-panel-lb-row` in app.css. `.home-panel-lb-browse`
 * — the heading's link — is a different thing and stays.
 */

import { ProgressRing } from '@/components/ui/progress-ring';
import type { ChallengeRowView, ChallengesView, SeasonView } from '../panels-store';
import { PanelFooter, PanelShell, panels } from './ui';

/**
 * The ring: how far through the season the viewer is, at the top of the card.
 *
 * It replaces the "· 1 of 6 · 3,900 pts left" that rode the section heading.
 * That string was chrome about the block sitting beside the block's name, its
 * leaderboard link and its ⋮ — and at 12px after all of those it still pushed
 * the area's own label into an ellipsis on a phone. As a ring it is content:
 * the first thing in the card, stating the one fact the card exists to state.
 *
 * The ring itself is `@/components/ui/progress-ring` — the geometry, the
 * twelve-o'clock start and the zero case all live there, because it is a shape
 * of the language rather than of this block, and because a raw SVG element
 * under `features/**` is a glyph that escaped icons.tsx as far as
 * tests/shell-icon-set.test.js is concerned — that scanner is a plain search
 * for the opening tag, comments included, so this sentence spells the tag out
 * in words rather than tripping the rule it is describing. What is this block's is the
 * COPY beside it: the points lead when there are any, because "what is left to
 * win" is the motivating number and the ring is already showing the fraction.
 */

function SeasonRing({ view }: { view: SeasonView }) {
  return (
    <div className="home-panel-season flex items-center gap-2.5 px-2.5 py-2">
      <ProgressRing pct={view.pct} label={view.fraction} title={view.label} />
      <div className="min-w-0">
        <div className="truncate whitespace-nowrap text-[13px] font-semibold text-zinc-900 dark:text-zinc-100">
          {view.lead}
        </div>
        {view.sub ? (
          <div className="truncate whitespace-nowrap text-[11px] text-zinc-500 dark:text-zinc-400">
            {view.sub}
          </div>
        ) : null}
      </div>
    </div>
  );
}

/**
 * One 56px row, two lines:
 *
 *   [well]  goal ………………………… 2/3  [6,500 pts]
 *           ▓▓▓▓▓▓▓▓▓▓▓▓░░░░░░░░░░░░░░░░░░░░░
 *
 * The COUNT sits on line one with the goal rather than beside the track,
 * because a count next to the bar is what stopped the bar being full width —
 * and the bar running the whole text column is the thing that makes a row
 * readable at a glance. The reward is on line one for the same reason.
 *
 * The well is 28px and holds the state: a hollow ring while the challenge is
 * open, a ✓ on emerald once it is done, with the track turning emerald to
 * match. Both states are the same box, so the goal's left edge does not move
 * between them.
 */
function ChallengeRow({ row }: { row: ChallengeRowView }) {
  const { meter } = row;
  return (
    <div
      className="home-panel-row flex items-center gap-2.5 px-2.5 cursor-pointer hover:bg-violet-500/[0.04] dark:hover:bg-violet-500/10 transition-colors"
      data-challenge-id={row.id}
      title={row.tip}
      onClick={() => panels()?.goToChallenges?.()}
    >
      {row.done ? (
        <span
          className="home-panel-glyph shrink-0 w-7 h-7 rounded-full flex items-center justify-center bg-emerald-500/15 text-emerald-700 text-[13px] leading-none dark:text-emerald-400"
          aria-hidden="true"
        >
          ✓
        </span>
      ) : (
        <span
          className="home-panel-glyph shrink-0 w-7 h-7 rounded-full flex items-center justify-center bg-violet-500/10"
          aria-hidden="true"
        >
          <span className="w-2.5 h-2.5 rounded-full border-2 border-violet-500/50 dark:border-violet-400/50" />
        </span>
      )}
      <div className="min-w-0 flex-1 flex flex-col gap-1.5">
        <div className="flex items-center gap-2 min-w-0">
          <span className="home-panel-goal flex-1 min-w-0 truncate whitespace-nowrap text-[13px] text-zinc-900 dark:text-zinc-100">
            {row.goal}
          </span>
          {/* A binary challenge prints no count — see ChallengeMeterView.binary. */}
          {meter.binary ? null : (
            <span className="shrink-0 whitespace-nowrap text-[11px] tabular-nums text-zinc-500 dark:text-zinc-400">
              {`${meter.current}/${meter.target}`}
            </span>
          )}
          {/*
              whitespace-nowrap on the chip is load-bearing: the reward is
              organiser prose and multi-word ("Up to 6,500 pts"), so without it
              a tight row wraps the chip to a second line the fixed row height
              clips.

              A TINTED CHIP, not bold accent text. `font-semibold
              text-violet-700` made the reward the loudest thing on a row whose
              subject is the GOAL: a column of blue "250 pts" read down the card
              before any of the sentences beside them did. A chip keeps it just
              as findable — it is the only tinted thing on the line — while
              letting the goal be read first.
          */}
          {row.reward ? (
            <span
              className={'shrink-0 whitespace-nowrap rounded-full bg-violet-500/10 px-1.5 py-0.5 '
                + 'text-[11px] font-medium text-violet-700 dark:bg-violet-500/15 dark:text-violet-300'}
            >
              {row.reward}
            </span>
          ) : null}
        </div>
        {/*
            THE TRACK IS SOLID, NOT OUTLINED. It was a hairline around a light
            interior, which is what an empty 0/5 needed back when it sat in a
            14px lane: without the border there was nothing to tell it from the
            row's own divider. On its own line at full width that same outline
            is the problem — an empty container spanning the card asks to be
            looked at, and a row that has not been started is the last thing on
            the list worth looking at. A filled zinc rail reads as a track not
            yet run, and it stops competing with the rows that do have a fill.
        */}
        <span
          className="home-panel-bar-track block h-1.5 w-full rounded-full bg-zinc-200 overflow-hidden dark:bg-zinc-800"
          role="progressbar"
          aria-valuenow={meter.current}
          aria-valuemin={0}
          aria-valuemax={meter.target}
          aria-label={`${row.goal || 'Challenge'}: ${meter.current} of ${meter.target}${meter.label}`}
        >
          <span
            className={row.done
              ? 'home-panel-bar-fill block h-full rounded-full bg-emerald-500'
              : 'home-panel-bar-fill block h-full rounded-full bg-violet-500'}
            style={{ width: `${meter.pct}%` }}
          />
        </span>
      </div>
    </div>
  );
}

export function ChallengesPanel({ view }: { view: ChallengesView }) {
  if (!view.rows.length) {
    return (
      <PanelShell panelKey={view.key} expanded={false} stamps={{ rows: 0 }}>
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

  return (
    <PanelShell
      panelKey={view.key}
      expanded={view.expanded}
      stamps={{ rows: view.rows.length }}
      footer={<PanelFooter panelKey={view.key} total={view.total} expanded={view.expanded} />}
    >
      {view.season ? <SeasonRing view={view.season} /> : null}
      <div className="home-panel-body">
        {/* No `--metered` modifier any more: the meter is a property of every
            row, so there is nothing for the LIST to reserve. */}
        <div className="home-panel-rows">
          {view.rows.map((row) => <ChallengeRow key={row.id} row={row} />)}
        </div>
      </div>
    </PanelShell>
  );
}
