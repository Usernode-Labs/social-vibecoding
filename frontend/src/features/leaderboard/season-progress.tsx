/**
 * How far through a scope of challenges the viewer is: "3/9 done in this
 * event" over one short segment per challenge.
 *
 * The ITERATION 03 board's quiet season summary. It is SHARED on purpose, like
 * ./challenge-card.tsx: Home's Challenges block and the Leaderboard screen's
 * Challenges tab draw this one component, so the same season reads the same
 * figure, words and bar on both. The board's rule is that progress has a scope
 * ("First challenges is 2 steps; the season is 9"), so the caller names it in
 * `caption` ("done in this event", "done in First challenges") and this file decides nothing
 * about which challenges count.
 *
 * One segment per challenge is only legible while there are few. Past
 * SEGMENT_LIMIT they would shrink to slivers on a phone, so the bar becomes one
 * continuous track filled to the same fraction.
 *
 * POINTS (#4565): an optional second line, "1,000 of 2,000 pts earned", over
 * its own continuous track — points are not counted one by one, so it is never
 * segmented. The caller totals them (which challenges count is the caller's
 * scope decision, like `done`/`total`); this file only draws the pair. The
 * fill is violet while points are still to earn and the cards' emerald once
 * every point on offer is earned. No `points`, or nothing on offer, and the
 * output is exactly what it was.
 *
 * Divs, not an SVG: a raw vector element under features/** is a glyph that
 * escaped icons.tsx as far as tests/shell-icon-set.test.js is concerned.
 */

export interface SeasonProgressView {
  /** Challenges finished in the scope. */
  done: number;
  /** Challenges in the scope. Nothing renders at zero. */
  total: number;
  /** What follows the figure: "done in this event", or "done" alone. */
  caption: string;
  /** Points earned of points on offer, over the same scope. Optional. */
  points?: { earned: number; total: number } | null;
}

export const SEGMENT_LIMIT = 24;

const ROW = 'flex min-w-0 items-baseline gap-1.5 text-sm leading-5';
const FRACTION = 'shrink-0 font-semibold tabular-nums text-zinc-900 dark:text-zinc-100';
const CAPTION = 'min-w-0 truncate font-medium text-zinc-500 dark:text-zinc-400';
const SEGMENT = 'h-[5px] min-w-0 flex-1 rounded-full';
const DONE = 'bg-violet-700 dark:bg-violet-400';
const TODO = 'bg-zinc-900/[0.07] dark:bg-white/10';
// Every point on offer, earned: the cards' green "Earned N pts", so a
// finished summary reads as the same good news the finished cards do.
const EARNED = 'bg-emerald-500 dark:bg-emerald-400';

const fmt = (n: number) => Math.round(n).toLocaleString('en-US');

export function SeasonProgress({
  view, id, className,
}: { view: SeasonProgressView; id?: string; className?: string }) {
  const total = Math.max(0, Math.floor(Number(view.total) || 0));
  if (!total) return null;
  const done = Math.max(0, Math.min(total, Math.floor(Number(view.done) || 0)));
  const pointsTotal = Math.max(0, Math.floor(Number(view.points && view.points.total) || 0));
  const points = pointsTotal > 0 ? view.points : null;
  const earned = points
    ? Math.max(0, Math.min(pointsTotal, Math.floor(Number(points.earned) || 0)))
    : 0;
  return (
    <div className={className ? `flex flex-col gap-2 ${className}` : 'flex flex-col gap-2'}>
      <p id={id} className={ROW}>
        <span className={FRACTION}>{`${done}/${total}`}</span>
        <span className={CAPTION}>{view.caption}</span>
      </p>
      <div
        role="meter"
        aria-valuemin={0}
        aria-valuemax={total}
        aria-valuenow={done}
        aria-label={`${done} of ${total} ${view.caption}`}
        className="flex gap-1"
      >
        {total <= SEGMENT_LIMIT
          ? Array.from({ length: total }, (_, i) => (
            <span key={i} className={`${SEGMENT} ${i < done ? DONE : TODO}`} />
          ))
          : (
            <span className={`relative overflow-hidden ${SEGMENT} ${TODO}`}>
              <span
                className={`absolute inset-y-0 left-0 rounded-full ${DONE}`}
                style={{ width: `${Math.round((done / total) * 100)}%` }}
              />
            </span>
          )}
      </div>
      {points ? (
        <div className="flex flex-col gap-2">
          <p className={ROW}>
            <span className={FRACTION}>{`${fmt(earned)} of ${fmt(pointsTotal)} pts`}</span>
            <span className={CAPTION}>earned</span>
          </p>
          <div
            role="meter"
            aria-valuemin={0}
            aria-valuemax={pointsTotal}
            aria-valuenow={earned}
            aria-label={`${fmt(earned)} of ${fmt(pointsTotal)} pts earned`}
            className="flex gap-1"
          >
            <span className={`relative overflow-hidden ${SEGMENT} ${TODO}`}>
              <span
                className={`absolute inset-y-0 left-0 rounded-full ${earned >= pointsTotal ? EARNED : DONE}`}
                style={{ width: `${Math.round((earned / pointsTotal) * 100)}%` }}
              />
            </span>
          </div>
        </div>
      ) : null}
    </div>
  );
}
