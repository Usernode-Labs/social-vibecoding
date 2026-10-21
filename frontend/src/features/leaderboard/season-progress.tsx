/**
 * The summary over the Challenges tab's grid: one line, "3,500 pts · 4 of 11
 * done", over one bar of done out of all.
 *
 * The Semi design (2026-10-16) took the season out of it. It used to name a
 * scope ("done in First challenges", "done in this event", "done in Season
 * 2"), segment the bar one challenge at a time and add a second line and bar
 * for the points on offer. Now the tab is the challenges running now, so the
 * line says only what the viewer has: the points they earned, in bold, and how
 * many of the challenges on the tab they finished.
 *
 * The caller decides which challenges count and what the points are; this
 * file only says it. The line is one catalog message (the points as its one
 * numbered tag), so a translator sees the whole sentence. Without a points
 * figure (`points` null) the line is the count alone.
 *
 * The bar is violet while challenges are left and the cards' emerald once
 * every one is done: there the end is the good news (AGENTS.md, "Type and
 * colour").
 *
 * Divs, not an SVG: a raw vector element under features/** is a glyph that
 * escaped icons.tsx as far as tests/shell-icon-set.test.js is concerned.
 */

import { RichMessage, useMessages } from '../../lib/i18n/react';

export interface SeasonProgressView {
  /** Challenges finished. */
  done: number;
  /** Challenges on the tab. Nothing renders at zero. */
  total: number;
  /** The points the viewer has earned on them, or null when unknown. */
  points?: number | null;
}

const ROW = 'min-w-0 truncate text-sm leading-5 text-zinc-500 dark:text-zinc-400';
const POINTS = 'font-semibold tabular-nums text-zinc-900 dark:text-zinc-100';
const TRACK = 'relative h-[5px] w-full overflow-hidden rounded-full bg-zinc-900/[0.07] dark:bg-white/10';
const FILL = 'absolute inset-y-0 left-0 rounded-full bg-violet-700 dark:bg-violet-400';
const FILL_DONE = 'absolute inset-y-0 left-0 rounded-full bg-emerald-500 dark:bg-emerald-400';

const fmt = (n: number) => Math.round(n).toLocaleString('en-US');

export function SeasonProgress({
  view, id, className,
}: { view: SeasonProgressView; id?: string; className?: string }) {
  const t = useMessages('leaderboard');
  const total = Math.max(0, Math.floor(Number(view.total) || 0));
  if (!total) return null;
  const done = Math.max(0, Math.min(total, Math.floor(Number(view.done) || 0)));
  const raw = typeof view.points === 'number' ? view.points : NaN;
  const points = Number.isFinite(raw) ? Math.max(0, Math.round(raw)) : null;
  const counts = { done, count: total };
  return (
    <div className={className ? `flex flex-col gap-2 ${className}` : 'flex flex-col gap-2'}>
      <p id={id} className={ROW}>
        {points == null ? t('leaderboard:progress.plainLabel', counts) : (
          <RichMessage
            id="leaderboard:progress.summary"
            values={{
              ...counts,
              points: t('leaderboard:challenges.points', { count: points, points: fmt(points) }),
            }}
            components={[<span className={POINTS} />]}
          />
        )}
      </p>
      <div
        role="meter"
        aria-valuemin={0}
        aria-valuemax={total}
        aria-valuenow={done}
        aria-label={t('leaderboard:progress.plainLabel', counts)}
        className={TRACK}
      >
        <span
          className={done >= total ? FILL_DONE : FILL}
          style={{ width: `${Math.round((done / total) * 100)}%` }}
        />
      </div>
    </div>
  );
}
