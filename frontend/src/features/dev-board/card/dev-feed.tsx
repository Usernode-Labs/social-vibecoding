/**
 * `#dev-feed` — the Dev screen's list-mode stream — as the only React
 * writer below that host. The host ELEMENT stays app-view.js's
 * (`_repaintDevBody` creates it inside #dev-body); everything under it
 * renders from `devFeedStore`.
 *
 * Two slots inside the tree stay legacy-FILLED, both rendered here once,
 * empty, with constant classNames:
 *
 * - `.dev-feed-comments[data-comments-for]` — `_wireFeedComments`'s
 *   IntersectionObserver fills each when its row scrolls into view.
 * - `[data-kudos-host]` (inside merged cards' action bands) —
 *   `_fillKudosHosts` + `Kudos.attach` own everything below.
 *
 * The footer buttons dispatch by name (showMoreFeed / loadMoreMerged), the
 * same calls their onclick attributes made.
 */

import type { ReactNode } from 'react';

import { useStoreState } from '../../../lib/use-store-state';
import { devFeedStore } from './cards-store';
import { FeedThread } from './feed-thread';
import { ListRowView } from './list-rows';
import type { FooterSpec } from './model';
import { CardSkeleton } from './skeleton';

function callAppView(fn: string): void {
  const av = typeof window !== 'undefined' ? (window as any).AppView : null;
  if (av && typeof av[fn] === 'function') av[fn]();
}

/** The trailing pager / truncation affordance, shared with the kanban columns. */
export function FooterView({ f }: { f: FooterSpec }): ReactNode {
  if (f.kind === 'showMore') {
    return (
      <button className="gc-vote-btn" onClick={() => callAppView('showMoreFeed')}>{`Show ${f.n} more`}</button>
    );
  }
  if (f.kind === 'loadMerged') {
    return (
      <button className="gc-vote-btn" disabled={f.loading} onClick={() => callAppView('loadMoreMerged')}>
        {f.loading ? 'Loading…' : (f.n != null ? `Load more (${f.n})` : 'Load more')}
      </button>
    );
  }
  if (f.kind === 'github') {
    return (
      <a href={f.href} target="_blank" rel="noopener" className="text-xs text-violet-700 hover:underline dark:text-violet-400">
        {'More open issues on GitHub →'}
      </a>
    );
  }
  return <span className="text-xs text-zinc-500 dark:text-zinc-500 italic">{`+${f.n} more completed`}</span>;
}

export function DevFeed(): ReactNode {
  const v = useStoreState(devFeedStore);
  // Before the first load lands there is nothing true to say about this
  // stream — not its emptiness, not its length. Draw its shape instead.
  if (v.loading) return <CardSkeleton n={4} label="Loading activity" />;
  return (
    <>
      {v.block.length ? (
        <div className="space-y-2 mb-2">
          {v.block.map((row) => <ListRowView key={row.key} row={row} />)}
        </div>
      ) : null}
      {/* Two different empty states, and telling them apart matters: an
          unfiltered stream with nothing in it is an invitation to start
          something, while a FILTERED one that came back empty is a statement
          about the filter. Offering "press + to propose a change" to someone
          who has just searched for a word answers a question they did not
          ask, and hides the one thing that would help — that the filter is
          what is hiding the rest. */}
      {v.emptyNote ? (
        <div className="text-xs text-zinc-500 dark:text-zinc-400 mb-2">
          {v.emptyNote.filtered ? (
            'Nothing here matches the current search and filters.'
          ) : (
            <>
              {v.emptyNote.loadFailed ? "Couldn't load open issues right now. " : ''}
              {'No activity yet. Press '}
              <span className="font-medium text-violet-700 dark:text-violet-400">+</span>
              {' to propose a change or file an issue.'}
            </>
          )}
        </div>
      ) : null}
      {v.entries.length ? (
        <div className="dev-feed-stream">
          {v.entries.map((row) => (
            <div key={row.key} className="dev-feed-entry">
              <ListRowView row={row} />
              {/* The GITHUB thread, read-only, filled by
                  AppView._fillFeedComments through this host. Issues only —
                  it is the only kind with a repository conversation. */}
              {row.t === 'card' && row.commentsFor != null ? (
                <div className="dev-feed-comments" data-comments-for={String(row.commentsFor)}></div>
              ) : null}
              {/* …and the APP's own thread for the same item, which is the one
                  a reply from here can join. See ./feed-thread.tsx. */}
              {row.t === 'card' && row.thread && v.slug ? (
                <FeedThread
                  slug={v.slug}
                  type={row.thread.type}
                  refId={row.thread.ref}
                  canPost={!!v.canPost}
                />
              ) : null}
            </div>
          ))}
        </div>
      ) : null}
      {v.footer ? <div className="mt-1"><FooterView f={v.footer} /></div> : null}
    </>
  );
}
