/**
 * A launcher tile that has not arrived yet — the one copy, for both grids.
 *
 * The authed launcher (`#app-list`, ../home/app-grid.tsx) and the signed-out
 * directory (`#landing-apps`, ../auth/landing.tsx) draw the SAME tile: a
 * 3.5rem `rounded-2xl` icon box over a fixed 26px title lane, in a
 * `rounded-xl p-3` cell. So they get the same placeholder, from here, rather
 * than the directory growing a second one that drifts the first time the tile
 * changes.
 *
 * `.app-card` is deliberately NOT on these. It carries the hover transition
 * and — more to the point — it is what the kit's placement recognizer and
 * `App._tileFor(slug)` select on; a placeholder answering either of those
 * queries is a tile that can be long-pressed, dragged, or zoomed into, and it
 * has no app behind it.
 */

import type { ReactNode } from 'react';

export function SkeletonTile(): ReactNode {
  return (
    <div className="relative rounded-xl p-3 flex flex-col items-center text-center gap-1.5">
      <div className="w-14 h-14 rounded-2xl bg-zinc-200 dark:bg-zinc-800 shrink-0"></div>
      <div className="w-full h-[26px] flex justify-center pt-1">
        <div className="h-2.5 w-2/3 rounded bg-zinc-200/70 dark:bg-zinc-800/70"></div>
      </div>
    </div>
  );
}

/**
 * `n` of them, pulsing together, with one screen-reader label beside the
 * geometry — a reader should hear "loading" once, not a description of
 * however many decorative rectangles.
 *
 * `className` is the GRID the caller draws into: the two callers have
 * different column counts (the launcher is a fixed 4, the directory ramps
 * 2→5 by breakpoint), and the placeholders have to sit in the same cells the
 * real tiles will.
 */
export function TileSkeleton({ n, label, className }: {
  n: number;
  label: string;
  className: string;
}): ReactNode {
  return (
    <>
      <div className="sr-only" role="status">{label}</div>
      <div className={`${className} animate-pulse`} aria-hidden="true">
        {Array.from({ length: n }, (_, i) => <SkeletonTile key={i} />)}
      </div>
    </>
  );
}
