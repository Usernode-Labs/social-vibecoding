/**
 * Needs you: the second card of Home's side column (`#home-aside`,
 * ./index.tsx), under the New project card, from 1280px.
 *
 * It is drawn only while a vote waits on the viewer: the same count Home's
 * Needs you tile and the tab badge read (`badgeNeeds`,
 * ../workshop/community-scope.ts), which a vote cast anywhere lowers. With
 * something waiting it reads the Needs you feed
 * (GET /api/workshop/needs-feed, the page's own read) for what the count
 * cannot say: how many of them the viewer's vote decides, how many are
 * advisory, and which communities they are in.
 *
 * The whole card is one link to Needs you (`#needs`), the page of every
 * decision owed across the viewer's projects, one per screen.
 *
 * Nothing in the prerender: the count starts unknown. The feed is read in
 * an effect, and only where the column is displayed, so a phone asks for
 * nothing it does not draw.
 */

import { useEffect, useState, type ReactNode } from 'react';

import { ChevronRightIcon } from '@/components/ui/icons';

import { RichMessage, useMessages } from '../../lib/i18n/react';
import { sharedJson } from '../../lib/shared-read';
import { useStoreState } from '../../lib/use-store-state';
import { communityScopeStore } from '../workshop/community-scope';

/** What the card reads of a feed item (../workshop/needs-reel.tsx NeedsFeedItem). */
export interface NeedsCardItem {
  kind: string;
  id: number;
  title: string;
  advisory?: boolean;
  uncounted?: boolean;
  app?: { slug: string; name: string; icon_url?: string | null; icon_emoji?: string | null } | null;
}

/** True for an item whose outcome the viewer's vote can change. */
export function decides(item: NeedsCardItem): boolean {
  return !item.advisory && !item.uncounted;
}

/**
 * The card's numbers. `waiting` is the count of votes waiting; once the feed
 * is read its own length is the total, so the two parts in words add up to
 * the number beside them.
 */
export function needsSummary(waiting: number, feed: NeedsCardItem[] | null): { total: number; decide: number; advisory: number } | null {
  if (!feed) return waiting > 0 ? { total: waiting, decide: 0, advisory: 0 } : null;
  if (!feed.length) return null;
  const decide = feed.filter(decides).length;
  return { total: feed.length, decide, advisory: feed.length - decide };
}

function demoQuery(): string {
  try {
    return new URLSearchParams(location.search).get('demo') === '1' ? '?demo=1' : '';
  } catch {
    return '';
  }
}

function columnShown(): boolean {
  try {
    return typeof window !== 'undefined' && !!window.matchMedia?.('(min-width: 1280px)').matches;
  } catch {
    return false;
  }
}

// One quiet row that is a link, not a list. The number sits in
// a soft accent square, the words beside it, and under them the icons of
// the communities that wait, with the split in words. Complete class
// literals (Tailwind reads source text).
const CARD = 'home-needs-card group flex min-w-0 flex-col gap-3 rounded-[20px] bg-[color:var(--dc-sheet-solid)] p-4 '
  + '[box-shadow:0_0_0_1px_var(--app-sheet-line)_inset] transition-shadow '
  + 'hover:[box-shadow:0_0_0_1px_var(--accent)_inset]';
const COUNT = 'flex h-11 min-w-[44px] shrink-0 items-center justify-center rounded-2xl bg-violet-50 px-2 '
  + 'text-[20px] font-bold tracking-tight text-violet-700 dark:bg-violet-900/40 dark:text-violet-200';
const ICON = 'flex h-6 w-6 shrink-0 items-center justify-center overflow-hidden rounded-md bg-zinc-100 '
  + 'text-[11px] font-bold text-zinc-600 ring-2 ring-[color:var(--dc-sheet-solid)] dark:bg-zinc-800 dark:text-zinc-300';

/** The communities that wait, once each, in the feed's order: four at most. */
export function waitingApps(feed: NeedsCardItem[] | null): NonNullable<NeedsCardItem['app']>[] {
  const seen = new Set<string>();
  const out: NonNullable<NeedsCardItem['app']>[] = [];
  for (const item of feed || []) {
    if (!item.app || seen.has(item.app.slug)) continue;
    seen.add(item.app.slug);
    out.push(item.app);
    if (out.length === 4) break;
  }
  return out;
}

function AppIcon({ app }: { app: NeedsCardItem['app'] }) {
  if (app?.icon_url) {
    return <img src={app.icon_url} alt="" draggable={false} className={`${ICON} object-cover`} />;
  }
  return <span className={ICON} aria-hidden="true">{app?.icon_emoji || (app?.name || '').slice(0, 1).toUpperCase()}</span>;
}

export function NeedsYouCard(): ReactNode {
  const t = useMessages('home');
  const { badgeNeeds } = useStoreState(communityScopeStore) as { badgeNeeds?: number | null };
  const waiting = Math.max(0, Number(badgeNeeds) || 0);
  const [feed, setFeed] = useState<NeedsCardItem[] | null>(null);
  // Whether the column is displayed, followed as the window is resized: a
  // window widened past 1280px reads the feed it had no use for before.
  const [shown, setShown] = useState(false);
  useEffect(() => {
    setShown(columnShown());
    let query: MediaQueryList | null = null;
    try { query = window.matchMedia('(min-width: 1280px)'); } catch { return undefined; }
    const onChange = () => setShown(columnShown());
    query.addEventListener?.('change', onChange);
    return () => query?.removeEventListener?.('change', onChange);
  }, []);

  // Read again whenever the count moves: a vote cast, or a new one opened.
  useEffect(() => {
    if (!waiting) { setFeed(null); return undefined; }
    if (!shown) return undefined;
    let live = true;
    sharedJson<{ items?: NeedsCardItem[] }>(`/api/workshop/needs-feed${demoQuery()}`, { fresh: true })
      .then((body) => { if (live && body && Array.isArray(body.items)) setFeed(body.items); })
      .catch(() => { /* the card keeps its count; the page says what failed */ });
    return () => { live = false; };
  }, [waiting, shown]);

  const summary = needsSummary(waiting, feed);
  if (!summary) return null;
  const apps = waitingApps(feed);

  return (
    <section id="home-needs-card" aria-labelledby="home-needs-card-title" data-needs={String(summary.total)}>
      <a id="home-needs-card-btn" href="#needs" className={CARD}>
        <span className="flex items-center gap-3">
          <span className={COUNT} aria-hidden="true">{summary.total}</span>
          <span className="min-w-0 flex-1">
            <b id="home-needs-card-title" className="block text-[15px] font-semibold leading-tight text-zinc-900 dark:text-zinc-50">
              {t('home:needsCard.eyebrow')}
            </b>
            <span className="mt-0.5 block text-[13px] leading-snug text-zinc-600 dark:text-zinc-300">
              {t('home:needsCard.waiting', { count: summary.total })}
            </span>
          </span>
          <ChevronRightIcon className="h-4 w-4 shrink-0 text-zinc-500 transition-colors group-hover:text-[color:var(--accent)] dark:text-zinc-400" aria-hidden="true" />
        </span>
        {feed ? (
          <span className="flex items-center gap-2 text-[12px] text-zinc-600 dark:text-zinc-300">
            <span className="flex -space-x-1.5" aria-hidden="true">
              {apps.map((app) => <AppIcon key={app.slug} app={app} />)}
            </span>
            <span className="min-w-0 flex-1 truncate text-end">
              <RichMessage
                id="home:needsCard.decide"
                values={{ count: summary.decide }}
                components={[<b className="font-bold text-zinc-900 dark:text-zinc-50" />]}
              />
              {/* Zero says nothing. */}
              {summary.advisory ? (
                <>
                  {' · '}
                  <RichMessage
                    id="home:needsCard.advisory"
                    values={{ count: summary.advisory }}
                    components={[<b className="font-bold text-zinc-900 dark:text-zinc-50" />]}
                  />
                </>
              ) : null}
            </span>
          </span>
        ) : null}
      </a>
    </section>
  );
}
