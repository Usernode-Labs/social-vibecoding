/**
 * The Communities screen's Needs you tab as one feed (#3270).
 *
 * A project's own Needs you page is a feed of decisions, one per screen:
 * read it, answer it, and the next one is under it. This tab used to be a
 * list of lists instead — each of your projects as a heading with its owed
 * items under it — which asked you to decide where to look before you could
 * decide anything. So it is the same shape as the project's feed, with
 * everything mixed: every decision owed by you across all the projects you
 * are a member of, newest first (GET /api/workshop/needs-feed,
 * src/routes/workshop-overview.js), each card naming the project it belongs
 * to.
 *
 * ── What a card can do from here ───────────────────────────────────────
 *
 * A CHANGE is answered on the card: Yes and No are the platform's own vote
 * (AppView.castVote), carrying the approval epoch the server checks (#2038),
 * asking for a line on a No the way every vote does, and turning a
 * membership refusal into Join through the fetch wrapper. A GROUP DECISION
 * (a rename, a secret, closing a request) opens its own page, where its
 * options and consequences are shown: those votes can apply the decision on
 * the spot, and that belongs on the screen that explains it.
 *
 * An answered card stays where it is, saying how you voted, and the feed
 * moves on to the next one, so the list never jumps under a thumb.
 *
 * ── Island rules ──────────────────────────────────────────────────────
 *
 * Rendered only while the tab shows, from data the controller loads in an
 * effect; nothing here is in the prerendered document.
 */

import { useRef, useState } from 'react';

import { ChevronRightIcon } from '@/components/ui/icons';
import { AppIconContent, appIconKind } from '../apps/app-card-view';
import { agoStamp } from '../../lib/timestamp';

export type NeedsFeedItem = {
  kind: 'proposal' | 'governance';
  id: number;
  title: string;
  summary: string | null;
  author: string | null;
  number: number | null;
  epoch: number | null;
  at: string | null;
  yes: number | null;
  no: number | null;
  app: { slug: string; name: string; icon_url: string | null; icon_emoji: string | null };
};

/** Where a card opens: the item's own page inside its project. */
export function reelHref(item: Pick<NeedsFeedItem, 'kind' | 'id' | 'app'>): string {
  const app = encodeURIComponent(item.app.slug);
  return item.kind === 'governance' ? `#app/${app}/dev/governance/${item.id}` : `#app/${app}/dev/proposals/${item.id}`;
}

/**
 * A proposal's summary is Markdown written for its own page. On a card it is
 * a paragraph: headings, emphasis, code ticks and list markers go, a link
 * keeps its words, and the whitespace collapses.
 */
export function plainSummary(md: string | null | undefined): string {
  return String(md || '')
    .replace(/```[\s\S]*?```/g, ' ')
    .replace(/!\[[^\]]*\]\([^)]*\)/g, ' ')
    .replace(/\[([^\]]+)\]\([^)]*\)/g, '$1')
    .replace(/^\s{0,3}(#{1,6}|[-*+]|\d+\.)\s+/gm, '')
    .replace(/[*_`>~]/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

/** "2 yes · 1 no", or nothing before anyone has voted. */
export function tallyLine(item: Pick<NeedsFeedItem, 'yes' | 'no'>): string {
  const yes = Number(item.yes) || 0;
  const no = Number(item.no) || 0;
  if (!yes && !no) return '';
  return [yes ? `${yes} yes` : '', no ? `${no} no` : ''].filter(Boolean).join(' · ');
}

type Voted = Record<string, 'yes' | 'no'>;

function ReelCard({ item, index, total, voted, busy, onVote }: {
  item: NeedsFeedItem;
  index: number;
  total: number;
  voted: 'yes' | 'no' | undefined;
  busy: boolean;
  onVote: (item: NeedsFeedItem, vote: 'yes' | 'no') => void;
}) {
  const when = item.at ? agoStamp(item.at).text : '';
  const what = item.kind === 'governance' ? 'Group decision waiting on your vote' : 'Change waiting on your vote';
  const summary = plainSummary(item.summary);
  const tally = tallyLine(item);
  const tile = { icon_url: item.app.icon_url, icon_emoji: item.app.icon_emoji, name: item.app.name };
  return (
    <article
      className="workshop-reel-card"
      data-needs-card={item.kind}
      data-needs-app={item.app.slug}
      aria-posinset={index + 1}
      aria-setsize={total}
      aria-labelledby={`workshop-reel-title-${item.kind}-${item.id}`}
    >
      <div className="workshop-reel-top">
        <a
          className="workshop-reel-app"
          href={`#app/${encodeURIComponent(item.app.slug)}/workshop`}
          onClick={() => { (window as any).AppView?._landOnHub?.(item.app.slug); }}
        >
          <span className="app-icon-tile workshop-reel-tile" data-icon={appIconKind(tile as never)} aria-hidden="true">
            <AppIconContent app={tile as never} />
          </span>
          <span className="min-w-0 truncate">{item.app.name}</span>
        </a>
        <span className="workshop-reel-pos" aria-hidden="true">{index + 1} of {total}</span>
      </div>
      <p className="workshop-reel-what">{when ? `${what} · ${when}` : what}</p>
      <h3 className="workshop-reel-title" id={`workshop-reel-title-${item.kind}-${item.id}`}>
        <a href={reelHref(item)}>{item.title || (item.kind === 'governance' ? 'A group decision' : 'A change')}</a>
      </h3>
      {summary ? <p className="workshop-reel-summary">{summary}</p> : null}
      <p className="workshop-reel-by">
        {item.author ? <span>by @{item.author}</span> : null}
        {item.number != null ? <span>PR #{item.number}</span> : null}
        {tally ? <span>{tally}</span> : null}
      </p>
      <div className="workshop-reel-spacer" />
      {item.kind === 'proposal' ? (
        voted ? (
          <p className="workshop-reel-voted" data-needs-voted={voted}>
            You voted {voted}. <a href={reelHref(item)}>See it</a>
          </p>
        ) : (
          <div className="workshop-reel-answers">
            <p className="workshop-reel-ask">Should this change go in?</p>
            <div className="workshop-reel-buttons">
              <button type="button" className="workshop-reel-no" data-needs-answer="no" disabled={busy} onClick={() => onVote(item, 'no')}>No</button>
              <button type="button" className="workshop-reel-yes" data-needs-answer="yes" disabled={busy} onClick={() => onVote(item, 'yes')}>Yes</button>
            </div>
            <a className="workshop-reel-open" href={reelHref(item)}>
              Read the whole change
              <ChevronRightIcon className="w-4 h-4" aria-hidden="true" />
            </a>
          </div>
        )
      ) : (
        <div className="workshop-reel-answers">
          <a className="workshop-reel-decide" href={reelHref(item)} data-needs-answer="open">
            Open to decide
            <ChevronRightIcon className="w-4 h-4" aria-hidden="true" />
          </a>
        </div>
      )}
    </article>
  );
}

export function NeedsReel({ items, error, capped }: {
  items: NeedsFeedItem[] | null;
  error: boolean;
  /** The read stopped at its bound: there may be more than these. */
  capped: boolean;
}) {
  const [voted, setVoted] = useState<Voted>({});
  const [busy, setBusy] = useState<string | null>(null);
  const reelRef = useRef<HTMLDivElement | null>(null);

  if (error) {
    return <p className="px-4 pt-3 text-sm text-zinc-500 dark:text-zinc-400" data-needs-error="">Couldn't load what is waiting on you. Each project's own Needs you page still has it.</p>;
  }
  if (!items) {
    return <div className="workshop-reel workshop-reel-loading" data-needs-reel="" aria-busy="true" aria-label="Loading what needs you" />;
  }
  if (!items.length) {
    return <p className="px-4 pt-3 text-sm text-zinc-500 dark:text-zinc-400" data-needs-empty="">Nothing is waiting on your vote in any of your projects.</p>;
  }

  const keyOf = (item: NeedsFeedItem) => `${item.kind}:${item.id}`;
  // A vote lands, the card says so, and the feed moves to the next one.
  const next = (index: number) => {
    const reel = reelRef.current;
    const card = reel?.children[index + 1] as HTMLElement | undefined;
    if (reel && card) reel.scrollTo({ top: card.offsetTop - reel.offsetTop, behavior: 'smooth' });
  };
  const onVote = async (item: NeedsFeedItem, vote: 'yes' | 'no') => {
    const view = (window as any).AppView;
    const key = keyOf(item);
    if (busy || typeof view?.castVote !== 'function') return;
    setBusy(key);
    let ok = false;
    try {
      ok = !!(await view.castVote(item.id, vote, item.epoch));
    } catch {
      ok = false;
    } finally {
      setBusy(null);
    }
    if (!ok) return;
    setVoted((v) => ({ ...v, [key]: vote }));
    next(items.findIndex((it) => keyOf(it) === key));
  };

  return (
    <>
      <div className="workshop-reel" data-needs-reel="" ref={reelRef} role="feed" aria-label="Decisions waiting on you">
        {items.map((item, index) => (
          <ReelCard
            key={keyOf(item)}
            item={item}
            index={index}
            total={items.length}
            voted={voted[keyOf(item)]}
            busy={busy === keyOf(item)}
            onVote={(it, vote) => { void onVote(it, vote); }}
          />
        ))}
      </div>
      {capped ? (
        <p className="px-4 pt-2 text-xs text-zinc-500 dark:text-zinc-400" data-needs-capped="">
          Showing the newest {items.length}. Each project's own Needs you page has the rest.
        </p>
      ) : null}
    </>
  );
}
