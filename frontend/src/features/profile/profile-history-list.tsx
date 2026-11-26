/**
 * Changes, Requests and Votes as tabs of the standard profile (#7134): the
 * person's own finished work for one kind, drawn in the same paper card and
 * rows as ./profile-recent-activity.tsx.
 *
 * The read and the rows are the Homeroom bot tab's History: ./../ai/history.ts
 * useHistory (GET /api/ai/history) and ./../ai/lines.ts useAiLines. No
 * project filter: the tab lists
 * every project at once, as the profile's Recent activity card does.
 *
 * Read after mount: the first render is the loading line only, so the
 * prerender and the hydrated page agree (../profile-view.tsx's header).
 */
import { useEffect, useState, type ReactNode } from 'react';

import { CheckIcon } from '@/components/ui/icons';
import { useMessages } from '../../lib/i18n/react';
import type { HistoryKind } from '../ai/filter-address';
import { useHistory } from '../ai/history';
import { useAiLines } from '../ai/lines';

const NONE: readonly string[] = [];
const NO_ROWS: never[] = [];
const nothing = () => {};

function isDemo(): boolean {
  if (typeof window === 'undefined') return false;
  return new URLSearchParams(window.location.search).get('demo') === '1';
}

const HEADING = {
  change: 'profile:work.changes.title',
  request: 'profile:work.requests.title',
  vote: 'profile:work.votes.title',
} as const;

export function ProfileHistoryList({ kind }: { kind: HistoryKind }): ReactNode {
  const t = useMessages('messages');
  const tp = useMessages('profile');
  const tc = useMessages('core');
  // Read once the tab is up, after mount: the first render is the loading line.
  const [showing, setShowing] = useState(0);
  useEffect(() => { setShowing(1); }, []);
  const history = useHistory({
    showing,
    signedIn: showing > 0 && typeof window !== 'undefined' && !!(window as any).App?.user,
    projects: NONE,
    kind,
    demo: isDemo(),
  });
  const { historyLines } = useAiLines({
    ready: history.ready, rows: NO_ROWS, owed: 0, progress: NO_ROWS, waiting: NO_ROWS, live: NO_ROWS,
    openRow: nothing, openThread: nothing, history,
  });
  // A line's own destination is its row's; the lines carry the wording only.
  const hrefs = new Map(history.rows.map((row) => [row.key, row.href]));
  const more = history.ready && history.next
    ? <p className="profile-history-more"><button type="button" onClick={history.more}>{t('messages:ai.history.earlier')}</button></p>
    : null;
  // Loading, empty and failed are the History card's words, drawn inside the
  // same paper card the rows are (#7134 review): a state is never a bare line.
  const state = !history.ready ? t('messages:ai.history.loading')
    : history.failed && !historyLines.length ? (
      <>{t('messages:ai.history.failed')} <button type="button" className="profile-history-again" onClick={history.retry}>{tc('core:common.tryAgain')}</button></>
    ) : !historyLines.length && !history.next ? t('messages:ai.history.empty') : null;
  return <section id="profile-history" data-profile-history={kind}>
    <h2>{tp(HEADING[kind])}</h2>
    {historyLines.length ? <ul>
      {historyLines.map((line) => {
        const href = hrefs.get(line.key) || null;
        const body = <>
          <span className="profile-recent-icon">{line.end?.kind === 'tick' ? <CheckIcon aria-hidden="true"/> : null}</span>
          <span className="profile-recent-copy"><strong>{line.app?.name || line.app?.slug || line.project || ''}</strong><span>{line.title}</span></span>
          {line.sub ? <span className="profile-history-end">{line.sub}</span> : null}
        </>;
        return <li key={line.key}>{href ? <a href={href}>{body}</a> : <span>{body}</span>}</li>;
      })}
    </ul> : state ? <ul><li className="profile-history-state">{state}</li></ul> : null}
    {more}
  </section>;
}
