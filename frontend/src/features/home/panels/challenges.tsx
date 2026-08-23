/**
 * The Challenges block: what the group is working towards, plus a preview of
 * the standings under it.
 *
 * ── Two branches, and why the empty one is not "nothing" ──────────────
 *
 * With no season running the block STAYS — for everyone, admins included — and
 * says so. A block that silently vanishes between seasons leaves the viewer
 * with no way to tell "nothing is running" from "this broke". That line leads
 * and the LEADERBOARD fill takes the rest, which between seasons is the only
 * thing this area has to show.
 *
 * ── The fill is the point, not the packing material ───────────────────
 *
 * The standings preview used to be a desktop-tile affordance: something had to
 * spend the fixed 2x2 rectangle. THE UI OVERHAUL retired the hamburger's
 * Leaderboard row, so these rows are how the home screen shows the standings
 * at all, and they draw at every width. Only an EXPANDED challenge list
 * suppresses them — that state exists to show every row the season has, and a
 * standings preview under thirty challenges is not a preview.
 *
 * `.home-panel-lb-row` is load-bearing rather than decoration: it is what
 * separates a tap that goes to the Leaderboard screen from one that goes to
 * Challenges, and the two lists sit in the same block.
 */

import type { ChallengeRowView, ChallengesView, FillView } from '../panels-store';
import {
  FillFooter, LeaderboardLink, PanelFooter, PanelShell, PanelTitle, panels,
} from './ui';

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
          className="home-panel-glyph shrink-0 w-2.5 h-2.5 flex items-center justify-center text-emerald-500 text-[11px] leading-none"
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
        <span className="shrink-0 whitespace-nowrap text-[11px] font-semibold text-violet-600 dark:text-violet-400">
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

/**
 * One leaderboard line, on the challenge row's geometry: the rank sits in the
 * glyph's 10px column, the name takes the goal's lane, and the score takes the
 * reward chip's slot — so the two kinds of row line up rather than reading as
 * two lists jammed together.
 */
function FillRow({ row, kind }: { row: FillRowView; kind: 'topochain' | 'kudos' }) {
  return (
    <div
      className={`home-panel-row home-panel-lb-row flex items-center gap-2 px-2.5 cursor-pointer hover:bg-violet-500/[0.04] dark:hover:bg-violet-500/10 transition-colors${
        row.you ? ' home-panel-lb-you bg-violet-500/[0.06] dark:bg-violet-500/10' : ''
      }`}
      data-lb-kind={kind}
      title={row.tip}
      onClick={() => panels()?.goToLeaderboard?.(kind)}
    >
      <span
        className="home-panel-glyph shrink-0 w-2.5 text-[10px] leading-none tabular-nums text-right text-zinc-400 dark:text-zinc-500"
        aria-hidden="true"
      >
        {row.rankLabel}
      </span>
      <span
        className={`home-panel-goal flex-1 min-w-0 truncate whitespace-nowrap text-[13px] ${
          row.you ? 'font-semibold text-zinc-900 dark:text-zinc-100' : 'text-zinc-900 dark:text-zinc-100'
        }`}
      >
        {row.name}
      </span>
      {/*
          A zero score is muted rather than a violet chip: "0" shouted in the
          accent colour reads as a warning, not as a starting point.
      */}
      {row.hasScore ? (
        <span className="shrink-0 whitespace-nowrap text-[11px] font-semibold text-violet-600 dark:text-violet-400">
          {row.scoreText}
        </span>
      ) : (
        <span className="shrink-0 whitespace-nowrap text-[11px] text-zinc-400 dark:text-zinc-500">
          0
        </span>
      )}
    </div>
  );
}

function FillBlock({ fill }: { fill: FillView }) {
  return (
    <div className="home-panel-fill flex-none" data-fill-kind={fill.kind}>
      <div className="home-panel-fill-label flex items-center px-2.5 text-[0.9375rem] text-zinc-400 dark:text-zinc-500">
        {fill.label}
      </div>
      {fill.rows.map((row, i) => (
        <FillRow key={`${row.rankLabel}:${row.name}:${i}`} row={row} kind={fill.kind} />
      ))}
    </div>
  );
}

export function ChallengesPanel({ view }: { view: ChallengesView }) {
  const fillRows = view.fill ? view.fill.rows.length : 0;

  if (!view.rows.length) {
    return (
      <PanelShell
        panelKey={view.key}
        expanded={false}
        stamps={{ rows: 0, fill: fillRows }}
        title={
          // flex-1 so the ⋮ sits at the right edge, same as the populated
          // branch — this state is on every home screen now, so its chrome has
          // to match the one beside it.
          <>
            <PanelTitle>{view.title}</PanelTitle>
            <LeaderboardLink />
          </>
        }
        footer={view.fill && fillRows ? <FillFooter kind={view.fill.kind} /> : null}
      >
        <div className="home-panel-body">
          <p
            className="home-panel-rows home-panel-row flex items-center px-2.5 text-[13px] text-zinc-500 dark:text-zinc-400 cursor-pointer hover:bg-violet-500/[0.04] dark:hover:bg-violet-500/10 transition-colors"
            title="Go to the Challenges tab on the Leaderboard screen"
            onClick={() => panels()?.goToChallenges?.()}
          >
            No challenges are running right now
          </p>
          {view.fill ? <FillBlock fill={view.fill} /> : null}
        </div>
      </PanelShell>
    );
  }

  return (
    <PanelShell
      panelKey={view.key}
      expanded={view.expanded}
      stamps={{ rows: view.rows.length, fill: fillRows }}
      title={
        // truncate (which carries white-space: nowrap) plus an explicit nowrap
        // on the counter: it must never push the title onto a second line, it
        // gets clipped with an ellipsis instead. The leaderboard link is a
        // shrink-0 sibling, so a long summary truncates rather than pushing
        // the control off the bar.
        <>
          <PanelTitle>
            {view.title}
            {view.summary ? (
              <span className="whitespace-nowrap">{` · ${view.summary}`}</span>
            ) : null}
          </PanelTitle>
          <LeaderboardLink />
        </>
      }
      footer={<PanelFooter panelKey={view.key} total={view.total} expanded={view.expanded} />}
    >
      <div className="home-panel-body">
        {/*
            The meter lane is a property of the LIST, not of the row that draws
            a bar: reserving it on every row is what keeps the goals on one
            baseline. A block with no numeric challenge reserves nothing and
            its rows centre plainly. The fill sits OUTSIDE this list, so
            leaderboard rows never inherit the lane's padding.
        */}
        <div className={`home-panel-rows${view.metered ? ' home-panel-rows--metered' : ''}`}>
          {view.rows.map((row) => <ChallengeRow key={row.id} row={row} />)}
        </div>
        {view.fill ? <FillBlock fill={view.fill} /> : null}
      </div>
    </PanelShell>
  );
}
