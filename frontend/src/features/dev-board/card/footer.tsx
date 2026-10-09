/**
 * The trailing pager / truncation affordance at the foot of a kanban column. It lived
 * in the Activity feed's module (card/dev-feed.tsx) until the feed retired
 * in favour of the Workshop; the kanban was its other reader.
 *
 * The buttons dispatch by name: showAllDone, loadMoreMerged.
 */

import type { ReactNode } from 'react';

import type { FooterSpec } from './model';

function callAppView(fn: string): void {
  const av = typeof window !== 'undefined' ? (window as any).AppView : null;
  if (av && typeof av[fn] === 'function') av[fn]();
}

export function FooterView({ f }: { f: FooterSpec }): ReactNode {
  // #4486: the column's last line, in words, as the Workshop's lists end
  // ("Show 2,748 more"): a reveal at the foot of the column's card rather
  // than a pill button.
  if (f.kind === 'showAll') {
    return (
      <button type="button" className="dev-ws-reveal dev-kanban-more" onClick={() => callAppView('showAllDone')}>{`Show all ${f.n.toLocaleString('en-US')}`}</button>
    );
  }
  if (f.kind === 'loadMerged') {
    return (
      <button type="button" className="dev-ws-reveal dev-kanban-more" disabled={f.loading} onClick={() => callAppView('loadMoreMerged')}>
        {f.loading ? 'Loading…' : (f.n != null ? `Show ${f.n.toLocaleString('en-US')} more` : 'Show more')}
      </button>
    );
  }
  if (f.kind === 'github') {
    return (
      <a href={f.href} target="_blank" rel="noopener" className="text-xs text-violet-700 hover:underline dark:text-violet-400">
        {'More open requests →'}
      </a>
    );
  }
  return <span className="text-xs text-zinc-500 dark:text-zinc-500 italic">{`+${f.n} more completed`}</span>;
}

