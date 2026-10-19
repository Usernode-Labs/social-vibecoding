/**
 * `#lb-your-standing` — the viewer's own standing, the first card of the
 * Challenges tab: "#22 of 161 people".
 *
 * It is where the Me screen's rank and token allocation went when Me became
 * the prototype's compact page: the Me row that leads here is "Challenges &
 * standings", and this is the standing. The Semi design (2026-10-16) took the
 * season name, the update note and the points by event off it; the points
 * the viewer earned are on the summary line under it. #5473 brought the
 * update note back, shorter and with the right timing: people could not tell
 * why their rank moved with no activity of their own.
 * ./my-standing.js holds the reads and every decision; this file draws them.
 *
 * Rendered inside #tc-se-grid, so it steps aside with the grid while a
 * challenge's detail page is open, and only once the pane has mounted — the
 * prerender and the first render carry none of it. Its data arrives from the
 * effect below, never from a render.
 */

import { useEffect, type ReactNode } from 'react';

import { Button } from '@/components/ui/button';
import { RichMessage, useMessages } from '../../lib/i18n/react';
import { useStoreState } from '../../lib/use-store-state';
import { MyStanding, myStandingStore, standingView } from './my-standing.js';

type TokenView =
  | { gated: true }
  | { gated: false; empty: boolean; amount: string; revealed: boolean };

type StandingView = {
  /** The viewer's place, or null before the standings have them. */
  rank: number | null;
  /** How many people the standings rank; 0 when the server did not say. */
  people: number;
  pending: string | null;
  token: TokenView;
};

const RANK = 'text-2xl font-extrabold tabular-nums text-zinc-900 dark:text-zinc-100';
const LINE = 'flex min-w-0 items-baseline gap-2 text-sm text-zinc-500 dark:text-zinc-400';

/** The allocation, when it concerns the viewer — the Me card's rules, moved. */
function Token({ token }: { token: TokenView }): ReactNode {
  const t = useMessages('leaderboard');
  if (token.gated) {
    return (
      <div className="mt-3 border-t border-zinc-100 pt-3 dark:border-zinc-800">
        <div className="text-sm font-semibold">{t('leaderboard:standing.token.withheld')}</div>
        <p className="mt-0.5 text-sm text-zinc-500 dark:text-zinc-400">
          {t('leaderboard:standing.token.review')}
        </p>
        <Button variant="neutral" size="sm" ink="neutral" className="mt-2" onClick={() => MyStanding.reviewTerms()}>
          {t('leaderboard:standing.token.reviewTerms')}
        </Button>
      </div>
    );
  }
  if (token.empty) return null;
  return (
    <div className="mt-3 border-t border-zinc-100 pt-3 dark:border-zinc-800">
      <div className="flex items-baseline justify-between gap-3">
        <span className="text-sm text-zinc-500 dark:text-zinc-400">{t('leaderboard:standing.token.label')}</span>
        <span
          className={token.revealed ? 'text-lg font-bold tabular-nums' : 'text-lg font-bold tabular-nums blur-md select-none'}
          aria-hidden={token.revealed ? 'false' : 'true'}
        >
          {token.amount}
        </span>
      </div>
      <p className="mt-1 text-xs text-zinc-500 dark:text-zinc-400">
        {t('leaderboard:standing.token.note')}
      </p>
      {token.revealed ? null : (
        <Button variant="neutral" size="sm" ink="neutral" className="mt-2" onClick={() => MyStanding.revealTokens()}>
          {t('leaderboard:standing.token.reveal')}
        </Button>
      )}
    </div>
  );
}

export function YourStanding(): ReactNode {
  const state = useStoreState(myStandingStore);
  // Subscribed before the view is built: its lines are read as it is.
  const t = useMessages('leaderboard');
  // Every open of the tab re-reads: one small me-scoped read, and a figure
  // that moves with every snapshot.
  useEffect(() => { void MyStanding.load(); }, []);
  const view = standingView(state) as StandingView | null;
  if (!view) return null;
  return (
    <section id="lb-your-standing" aria-label={t('leaderboard:standing.label')} className="mb-4 rounded-2xl bg-white p-4 dark:bg-zinc-900">
      <p className={LINE}>
        {view.rank == null ? (
          <span className="text-[1.0625rem] font-bold text-zinc-900 dark:text-zinc-100">{t('leaderboard:standing.yourStanding')}</span>
        ) : view.people > 0 ? (
          <RichMessage
            id="leaderboard:standing.rankOf"
            values={{ rank: view.rank, count: view.people, number: view.people.toLocaleString('en-US') }}
            components={[<span className={RANK} />]}
          />
        ) : (
          <RichMessage
            id="leaderboard:standing.rank"
            values={{ rank: view.rank }}
            components={[<span className={RANK} />]}
          />
        )}
      </p>
      {view.pending ? (
        <p className="mt-2 text-sm font-medium text-zinc-700 dark:text-zinc-300">{view.pending}</p>
      ) : null}
      <p className="mt-1 text-xs text-zinc-500 dark:text-zinc-400">
        {t('leaderboard:standing.pointsNote')}
      </p>
      <p className="mt-1 text-xs text-zinc-500 dark:text-zinc-400">
        {t('leaderboard:standing.updateNote')}
      </p>
      <Token token={view.token} />
    </section>
  );
}
