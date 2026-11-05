/**
 * Home's "Continue where you left off" card (#4025): one row, the change the
 * viewer worked on last, which reopens it. With nothing to continue the card
 * draws nothing and Home is as it was.
 *
 * The row and the list are the bell's Agents tab's and Messages': SessionRow
 * from ../improve/session-row.tsx over the Improve store (`sessions` +
 * `otherSessions`, one fetch of /api/me/active-sessions), so a change's
 * Working / Ready / Needs you cannot say two things in two places.
 *
 * NOT IN THE PRERENDER: the first render is nothing at all, because the store
 * starts with `sessionsLoaded` false and no viewer, and the list is asked for
 * in an effect. So hydration has nothing to disagree with, and no id joins the
 * shell's baseline.
 */

import { useEffect } from 'react';

import { GroupedList } from '@/components/ui/grouped-list';

import { useMessages } from '../../lib/i18n/react';
import { useStoreState } from '../../lib/use-store-state';
import { useVisibility } from '../../lib/visibility-store';
import { improveStore } from '../improve/improve-store.js';
import { SessionRow, type SessionRowView } from '../improve/session-row';
import { navStore } from '../nav/nav-store.js';
import { gridStore } from './grid-store';
import { SectionHeading } from './panels/ui';

/** Worked on longer ago than this, a change has been set down, not left off. */
export const CONTINUE_WINDOW_MS = 7 * 24 * 60 * 60 * 1000;

type ContinueRow = SessionRowView & { sortAt?: number };

/**
 * The one row, or null: the change in flight touched most recently, inside the
 * window. Work orders are out, because they run on the viewer's own machine
 * and there is no conversation here to go back into. So are merging and merged
 * changes: the list carries them since #6042 so Messages can say Live, and
 * there is nothing left to continue in one.
 */
export function pickContinueRow(rows: ContinueRow[], now: number): ContinueRow | null {
  let best: ContinueRow | null = null;
  for (const row of rows) {
    if (row.kind !== 'session') continue;
    if (row.sessionStatus === 'merging' || row.sessionStatus === 'merged') continue;
    const at = row.sortAt || 0;
    if (!at || now - at > CONTINUE_WINDOW_MS) continue;
    if (!best || at > (best.sortAt || 0)) best = row;
  }
  return best;
}

export function ContinueCardView({ row }: { row: SessionRowView }) {
  const t = useMessages('home');
  return (
    <section id="home-continue-card" className="px-3" aria-label={t('home:continue.heading')}>
      <SectionHeading>{t('home:continue.heading')}</SectionHeading>
      <GroupedList className="mx-0">
        <SessionRow session={row} showApp onNavigate={() => {}} />
      </GroupedList>
    </section>
  );
}

export function ContinueCard() {
  const { sessions, otherSessions, sessionsLoaded } = useStoreState(improveStore) as {
    sessions: ContinueRow[];
    otherSessions: ContinueRow[];
    sessionsLoaded: boolean;
  };
  const { viewer } = useStoreState(navStore) as { viewer: string | null };
  const { view } = useStoreState(gridStore);
  const onHome = useVisibility('home-screen', true);

  // The Improve store only fills itself once an app target exists, so a cold
  // Home has to ask, and every return to Home asks again: the list is a row of
  // what the viewer did elsewhere. A session snapshot is unverified and a 401
  // here is a console error, so a boot from one asks on `sv:session` instead,
  // which app.js dispatches with the server's answer. loadSessions keeps the
  // last list on a failure and ignores an answer a newer load overtook.
  useEffect(() => {
    if (!onHome) return undefined;
    const ask = () => {
      const app = (window as any).App;
      if (!app?.user || app._sessionFromSnapshot) return;
      void Promise.resolve((window as any).Improve?.loadSessions?.()).catch(() => {});
    };
    ask();
    document.addEventListener('sv:session', ask);
    return () => document.removeEventListener('sv:session', ask);
  }, [onHome]);

  // A search's results belong directly under the search bar.
  if (!sessionsLoaded || !viewer || view === 'search') return null;
  const row = pickContinueRow([...sessions, ...otherSessions], Date.now());
  return row ? <ContinueCardView row={row} /> : null;
}
