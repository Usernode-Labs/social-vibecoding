/**
 * The change page's run bar (#4452): the arithmetic behind "About 4 minutes
 * left". Pure, so the tests can run it against a fixed clock.
 *
 * The estimate is the MEDIAN of the app's last ten finished runs for each
 * part (AppView._runEstimates, GET /api/apps/:slug/run-estimate). What is
 * left is what those parts still owe: the build ages against its own start
 * stamp, and the checks and the shots run at the same time, so the wait is
 * the build's remainder plus the LONGER of the two.
 */

import type { RunBarView } from './model';

type Bar = NonNullable<RunBarView>;

/**
 * Milliseconds left, or null when there is nothing to say: no estimate for
 * the app yet, the run is waiting for a checks slot (that wait depends on
 * other proposals), or a part that is running right now has no median to
 * age against.
 */
export function remainingMs(bar: Bar | null | undefined, now: number): number | null {
  if (!bar || !bar.estimate || bar.phase === 'queued') return null;
  const t = bar.timing;
  const est = bar.estimate;

  // A part that is not running owes nothing. A running one owes its median
  // less what it has already spent; with no start stamp recorded, its whole
  // median.
  const aged = (median: number | null, startedAt: number | null, live: boolean): number | null => {
    if (median == null) return null;
    if (!live) return 0;
    if (typeof startedAt !== 'number' || !Number.isFinite(startedAt)) return median;
    return Math.max(0, median - (now - startedAt));
  };

  const buildRem = aged(est.buildMs, t.buildStartedAt, t.buildLive);
  if (buildRem == null) return null;
  const checksRem = aged(est.checksMs, t.checksStartedAt, t.checksLive);
  if (checksRem == null) return null;

  // The shots: omitted or done, they owe nothing. With no median of their
  // own they are simply left out of the sum — unless they are the only part
  // still running, in which case there is nothing to estimate from.
  let shotsRem: number | null = 0;
  if (t.shotsLive) {
    if (est.shotsMs == null) {
      if (!t.buildLive && !t.checksLive) return null;
    } else {
      const spent = typeof t.shotsStartedAt === 'number' && Number.isFinite(t.shotsStartedAt)
        ? now - t.shotsStartedAt : 0;
      shotsRem = Math.max(0, est.shotsMs - spent);
    }
  } else if (bar.segments.some((s) => s.key === 'shots' && s.state === 'todo')) {
    shotsRem = est.shotsMs;
  }

  return buildRem + Math.max(checksRem, shotsRem == null ? 0 : shotsRem);
}

/** "About 4 minutes left", "About a minute left", or the overrun's line. */
export function etaText(ms: number | null): string {
  if (ms == null) return '';
  if (ms === 0) return 'Taking longer than usual';
  if (ms <= 90 * 1000) return 'About a minute left';
  return `About ${Math.round(ms / 60000)} minutes left`;
}
