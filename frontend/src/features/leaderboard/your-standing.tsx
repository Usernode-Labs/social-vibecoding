/**
 * `#lb-your-standing` — the viewer's own season standing, the first card of
 * the Challenges tab (the prototype's "Season 3 · #3 · 9 pts · you").
 *
 * It is where the Me screen's points, rank, per-event breakdown and token
 * allocation went when Me became the prototype's compact page: the Me row
 * that leads here is "Challenges & standings", and this is the standing.
 * ./my-standing.js holds the reads and every decision; this file draws them.
 *
 * Rendered inside #tc-se-grid, so it steps aside with the grid while a
 * challenge's detail page is open, and only once the pane has mounted — the
 * prerender and the first render carry none of it. Its data arrives from the
 * effect below, never from a render.
 */

import { useEffect, type ReactNode } from 'react';

import { Button } from '@/components/ui/button';
import { useStoreState } from '../../lib/use-store-state';
import { MyStanding, myStandingStore, standingView } from './my-standing.js';

type TokenView =
  | { gated: true }
  | { gated: false; empty: boolean; amount: string; revealed: boolean };

type StandingView = {
  season: string;
  sub: string;
  rank: string;
  detail: string;
  breakdown: { key: string; label: string; points: string }[];
  token: TokenView;
};

/** The allocation, when it concerns the viewer — the Me card's rules, moved. */
function Token({ token }: { token: TokenView }): ReactNode {
  if (token.gated) {
    return (
      <div className="mt-3 border-t border-zinc-100 pt-3 dark:border-zinc-800">
        <div className="text-sm font-semibold">Token allocation withheld</div>
        <p className="mt-0.5 text-sm text-zinc-500 dark:text-zinc-400">
          Review and accept the terms to see your token allocation.
        </p>
        <Button variant="neutral" size="sm" ink="neutral" className="mt-2" onClick={() => MyStanding.reviewTerms()}>
          Review terms
        </Button>
      </div>
    );
  }
  if (token.empty) return null;
  return (
    <div className="mt-3 border-t border-zinc-100 pt-3 dark:border-zinc-800">
      <div className="flex items-baseline justify-between gap-3">
        <span className="text-sm text-zinc-500 dark:text-zinc-400">Token allocation</span>
        <span
          className={token.revealed ? 'text-lg font-bold tabular-nums' : 'text-lg font-bold tabular-nums blur-md select-none'}
          aria-hidden={token.revealed ? 'false' : 'true'}
        >
          {token.amount}
        </span>
      </div>
      <p className="mt-1 text-xs text-zinc-500 dark:text-zinc-400">
        Your share of the season&rsquo;s token pool. Allocations are provisional and
        subject to the program terms.
      </p>
      {token.revealed ? null : (
        <Button variant="neutral" size="sm" ink="neutral" className="mt-2" onClick={() => MyStanding.revealTokens()}>
          Reveal
        </Button>
      )}
    </div>
  );
}

export function YourStanding(): ReactNode {
  const state = useStoreState(myStandingStore);
  // Every open of the tab re-reads: two small me-scoped reads, and a figure
  // that moves with every snapshot.
  useEffect(() => { void MyStanding.load(); }, []);
  const view = standingView(state) as StandingView | null;
  if (!view) return null;
  return (
    <section id="lb-your-standing" aria-label="Your standing" className="mb-4 rounded-2xl bg-white p-4 dark:bg-zinc-900">
      <div className="flex items-center justify-between gap-3">
        <div className="min-w-0">
          <div className="truncate text-[1.0625rem] font-bold text-zinc-900 dark:text-zinc-100">{view.season}</div>
          <div className="text-sm text-zinc-500 dark:text-zinc-400">{view.sub}</div>
        </div>
        <div className="shrink-0 text-right">
          <div className="text-2xl font-extrabold tabular-nums text-zinc-900 dark:text-zinc-100">{view.rank}</div>
          <div className="text-sm text-zinc-500 dark:text-zinc-400">{view.detail}</div>
        </div>
      </div>
      {view.breakdown.length ? (
        <details className="mt-3 border-t border-zinc-100 pt-3 dark:border-zinc-800">
          <summary className="cursor-pointer text-sm font-medium text-violet-700 dark:text-violet-400">
            Points by event
          </summary>
          <ul className="mt-2 space-y-1.5">
            {view.breakdown.map((row) => (
              <li key={row.key} className="flex items-center gap-3 text-sm">
                <span className="min-w-0 flex-1 truncate text-zinc-700 dark:text-zinc-300">{row.label}</span>
                <span className="shrink-0 font-semibold text-violet-700 dark:text-violet-400">{row.points}</span>
              </li>
            ))}
          </ul>
        </details>
      ) : null}
      <Token token={view.token} />
    </section>
  );
}
