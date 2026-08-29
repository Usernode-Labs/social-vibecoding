/**
 * The Challenges block: what the group is working towards.
 *
 * ── Two branches, and why the empty one is not "nothing" ──────────────
 *
 * With no season running the block STAYS — for everyone, admins included — and
 * says so in one line. A block that silently vanishes between seasons leaves
 * the viewer with no way to tell "nothing is running" from "this broke".
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

import type { ChallengeRowView, ChallengesView } from '../panels-store';
import { PanelFooter, PanelShell, panels } from './ui';

/**
 * One 40px line: glyph · goal · count · reward, plus a 9px progress bar in the
 * meter lane along the row's bottom edge on numeric rows. Category, task, the
 * organiser CTA and the earned-points line are deliberately absent — they do
 * not fit at this density and all four live one tap away.
 */
function ChallengeRow({ row }: { row: ChallengeRowView }) {
  return (
    <div
      className="home-panel-row flex items-center gap-2 px-2.5 cursor-pointer hover:bg-violet-500/[0.04] dark:hover:bg-violet-500/10 transition-colors"
      data-challenge-id={row.id}
      title={row.tip}
      onClick={() => panels()?.goToChallenges?.()}
    >
      {/*
          A glyph, not a chip: same signal, a fraction of the width. Both
          states occupy the SAME 10px box (w-2.5), and that is not cosmetic
          symmetry — the goal text's left edge and the bar's `left-7` are both
          computed from this width (px-2.5 10 + glyph 10 + gap-2 8 = 28px), so
          a ✓ that sized itself intrinsically would shift the goal and
          desynchronise the bar from it on exactly the done rows.
      */}
      {row.done ? (
        <span
          className="home-panel-glyph shrink-0 w-2.5 h-2.5 flex items-center justify-center text-emerald-700 text-[11px] leading-none dark:text-emerald-400"
          aria-hidden="true"
        >
          ✓
        </span>
      ) : (
        <span
          className="home-panel-glyph shrink-0 w-2.5 h-2.5 rounded-full border border-zinc-300 dark:border-zinc-600"
          aria-hidden="true"
        />
      )}
      <span className="home-panel-goal flex-1 min-w-0 truncate whitespace-nowrap text-[13px] text-zinc-900 dark:text-zinc-100">
        {row.goal}
      </span>
      {row.meter ? (
        <span className="shrink-0 whitespace-nowrap text-[11px] tabular-nums text-zinc-500 dark:text-zinc-400">
          {`${row.meter.current}/${row.meter.target}`}
        </span>
      ) : null}
      {/*
          whitespace-nowrap on the chip is load-bearing: the reward is
          organiser prose and multi-word ("Up to 6,500 pts"), so without it a
          tight row wraps the chip to a second line the fixed row height clips.
      */}
      {row.reward ? (
        // A TINTED CHIP, not bold accent text. `font-semibold text-violet-700`
        // made the reward the loudest thing on a row whose subject is the
        // GOAL: a column of blue "250 pts" read down the card before any of
        // the sentences beside them did. A chip keeps it just as findable —
        // it is the only tinted thing on the row — while letting the goal be
        // read first, and it is the same chip language the rest of the shell
        // labels a value with.
        <span
          className={'shrink-0 whitespace-nowrap rounded-full bg-violet-500/10 px-1.5 py-0.5 '
            + 'text-[11px] font-medium text-violet-700 dark:bg-violet-500/15 dark:text-violet-300'}
        >
          {row.reward}
        </span>
      ) : null}
      {row.meter ? (
        // An OUTLINED bar: a faint hairline plus a light interior, so an empty
        // 0/5 track still reads as an empty bar. A borderless 2px grey fill
        // was indistinguishable from the row's own divider. Its GEOMETRY — 9px
        // tall, 5px clear of that divider, spanning from the goal's left edge
        // to 12px short of the right — is in app.css, derived from
        // --home-panel-meter-lane, so the lane and the bar move together.
        <span
          className="home-panel-bar-track absolute rounded-full border border-zinc-300/60 dark:border-zinc-600/60 bg-white dark:bg-zinc-900 overflow-hidden"
          role="progressbar"
          aria-valuenow={row.meter.current}
          aria-valuemin={0}
          aria-valuemax={row.meter.target}
          aria-label={`${row.goal || 'Challenge'}: ${row.meter.current} of ${row.meter.target}${row.meter.label}`}
        >
          <span
            className="home-panel-bar-fill block h-full bg-violet-500"
            style={{ width: `${row.meter.pct}%` }}
          />
        </span>
      ) : null}
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
      <div className="home-panel-body">
        {/*
            The meter lane is a property of the LIST, not of the row that draws
            a bar: reserving it on every row is what keeps the goals on one
            baseline. A block with no numeric challenge reserves nothing and
            its rows centre plainly.
        */}
        <div className={`home-panel-rows${view.metered ? ' home-panel-rows--metered' : ''}`}>
          {view.rows.map((row) => <ChallengeRow key={row.id} row={row} />)}
        </div>
      </div>
    </PanelShell>
  );
}
