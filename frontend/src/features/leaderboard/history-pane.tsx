/**
 * The History pane — `#leaderboard-history-root`, the fourth pane of the
 * Leaderboard screen: the seasons that have ended, one card each.
 *
 * The prototype's History segment, card for card: the season's name and when
 * it ended on the first line, the winner's avatar and "Lee won with 3,100 pts
 * · you finished #4" on the second, and a pill per event naming who took it.
 * Everything it says comes from ./history.js's `historyView`; this file only
 * turns that into elements.
 *
 * `mounted: false` renders NOTHING: the root ships empty and hidden in the
 * prerendered shell (History is never the default section), and the first
 * open of the tab is what mounts it. `hidden` on the root is
 * Leaderboard._applySection's, exactly as on the three sibling roots — the
 * root's className is a constant in ./index.tsx, so React never writes it.
 */

import { type ReactNode } from 'react';

import { Skeleton, SkeletonGroup } from '@/components/ui/skeleton';
import { useStoreState } from '../../lib/use-store-state';
import { historyStore, historyView } from './history.js';

type SeasonView = {
  key: string;
  name: string;
  ended: string | null;
  winnerInitial: string | null;
  line: string;
  events: { key: string; label: string }[];
};

type View =
  | { kind: 'none' }
  | { kind: 'loading' }
  | { kind: 'error'; message: string }
  | { kind: 'empty'; message: string }
  | { kind: 'seasons'; seasons: SeasonView[] };

const CARD = 'rounded-2xl bg-white dark:bg-zinc-900 p-4';
const HINT = 'py-8 text-center text-sm text-zinc-500 dark:text-zinc-400';

function Loading(): ReactNode {
  return (
    <SkeletonGroup label="Loading past seasons" className="space-y-3">
      {Array.from({ length: 2 }, (_, i) => (
        <div key={i} className={CARD}>
          <div className="flex items-center justify-between gap-3">
            <Skeleton className="w-28 h-4" />
            <Skeleton shape="muted" className="w-20" />
          </div>
          <div className="mt-3 flex items-center gap-2">
            <Skeleton shape="circle" className="w-7 h-7" />
            <Skeleton className="w-48" />
          </div>
          <div className="mt-3 flex gap-1.5">
            <Skeleton shape="block" className="w-24 h-6 rounded-full" />
            <Skeleton shape="block" className="w-24 h-6 rounded-full" />
          </div>
        </div>
      ))}
    </SkeletonGroup>
  );
}

function SeasonCard({ season }: { season: SeasonView }): ReactNode {
  return (
    <article className={CARD} data-history-season={season.key}>
      <div className="flex items-baseline justify-between gap-3">
        <h3 className="min-w-0 truncate text-[1.0625rem] font-bold text-zinc-900 dark:text-zinc-100">
          {season.name}
        </h3>
        {season.ended ? (
          <span className="shrink-0 text-sm text-zinc-500 dark:text-zinc-400">{season.ended}</span>
        ) : null}
      </div>
      <p className="mt-2 flex items-center gap-2 text-sm text-zinc-700 dark:text-zinc-300">
        {season.winnerInitial ? (
          <span
            aria-hidden="true"
            className="flex h-7 w-7 shrink-0 items-center justify-center rounded-full bg-violet-100 text-xs font-bold text-violet-700 dark:bg-violet-900/40 dark:text-violet-300"
          >
            {season.winnerInitial}
          </span>
        ) : null}
        <span className="min-w-0" data-history-result="">{season.line}</span>
      </p>
      {season.events.length ? (
        <ul className="mt-3 flex flex-wrap gap-1.5" aria-label="Event winners">
          {season.events.map((ev) => (
            <li
              key={ev.key}
              data-history-event={ev.key}
              className="rounded-full bg-zinc-100 px-2.5 py-1 text-xs font-medium text-zinc-600 dark:bg-zinc-800 dark:text-zinc-300"
            >
              {ev.label}
            </li>
          ))}
        </ul>
      ) : null}
    </article>
  );
}

export function HistoryPane(): ReactNode {
  const view = historyView(useStoreState(historyStore)) as View;
  if (view.kind === 'none') return null;
  if (view.kind === 'loading') return <Loading />;
  if (view.kind === 'error') {
    return <p className="py-8 text-center text-sm text-red-700 dark:text-red-400">{view.message}</p>;
  }
  if (view.kind === 'empty') return <p className={HINT}>{view.message}</p>;
  return (
    <div id="lb-history-seasons" className="space-y-3">
      {view.seasons.map((season) => <SeasonCard key={season.key} season={season} />)}
    </div>
  );
}
