/**
 * Recent threads: Home's card in `#home-aside` (./index.tsx), a full-width
 * row of its own under Pinned apps, or from 1280px under the brand look the
 * column beside them (`app.css`, "NEEDS YOU BESIDE PINNED APPS").
 *
 * It was the Needs you card (#6816) and now lists the project's recent
 * threads, the same list the notifications sheet's Recent threads tab shows
 * (#6785): every discussion the viewer took part in, newest activity first.
 * The file, the exported component and the section's id keep the names they
 * had because the look's CSS knows the card by `#home-needs-card`; what is on
 * screen is "Recent threads".
 *
 * Each row is drawn like that sheet's own row (ThreadRow, ../notifications/
 * notifications-sheet.tsx): the project's 44px tile, what the thread is
 * ("Change #6800", "Request #6790", "Decision"), its title on one line, then
 * the project and how long ago something last happened in it. There is no
 * pill: a row here is not something asked of the viewer.
 *
 * Beside Pinned apps the column lists as many rows as fit, measured from the
 * column's height, and when some do not fit its last row says how many more
 * there are and opens the sheet's Recent threads list. Everywhere else it
 * lists NEEDS_ROWS, as it always has.
 *
 * Nothing in the prerender: the list is read in an effect, and only where the
 * column is displayed, so a phone asks for nothing it does not draw. Until it
 * lands, the count the last visit saw on this device holds the card's place.
 */

import { useEffect, useRef, useState, type ReactNode, type RefObject } from 'react';

import { RichMessage, useMessages } from '../../lib/i18n/react';
import { sharedJson } from '../../lib/shared-read';
import { agoStamp } from '../../lib/timestamp';
import { useStoreState } from '../../lib/use-store-state';
import { AppIconContent, appIconKind } from '../apps/app-card-view';
import { notificationsSheetStore } from '../notifications/notifications-sheet-store.js';
import { SectionHeading } from './panels/ui';
import { WipCard, WipHeadMore, WipSkelRow } from './wip-kit';

/** What the card reads of a recent thread (/api/me/recent-threads, services/recent-threads.js). */
export interface RecentThreadItem {
  threadId: number;
  /** What the thread is: a request, a change, or a decision. */
  kind: string;
  /** The change's or request's number, where it has one. */
  number?: number | null;
  title: string;
  appSlug?: string;
  appName?: string;
  appIconEmoji?: string | null;
  appIconUrl?: string | null;
  /** When something last happened in it, for the row's "2h ago". */
  lastAt?: string | null;
  /** The page it opens. */
  href: string;
}

/** How many recent threads the card asks for: more than any column lists, and the page's own maximum. */
export const THREADS_LIMIT = 50;

/** Where the count of the last visit is kept on the device, for the first paint's placeholder. */
export const NEEDS_HINT_KEY = 'homeroom:recent-threads';
export function readNeedsHint(): number {
  try { return Math.max(0, Math.trunc(Number(window.localStorage.getItem(NEEDS_HINT_KEY)) || 0)); } catch { return 0; }
}
export function writeNeedsHint(count: number): void {
  try {
    if (count > 0) window.localStorage.setItem(NEEDS_HINT_KEY, String(count));
    else window.localStorage.removeItem(NEEDS_HINT_KEY);
  } catch { /* the next load draws no placeholder */ }
}

/** How many threads the card lists where it cannot measure its column (two lines of four on a wide screen). */
export const NEEDS_ROWS = 8;

/**
 * The rows' first line, as a three-line row reads it (the notifications
 * sheet's Recent threads rows): what the thread is, and its number where it
 * has one. A decision has no number of its own.
 */
export function kindId(thread: Pick<RecentThreadItem, 'kind' | 'number'>): string {
  if (thread.kind === 'decision') return 'home:needsCard.kind.decision';
  if (thread.kind === 'request') {
    return thread.number == null ? 'home:needsCard.kind.requestBare' : 'home:needsCard.kind.request';
  }
  return thread.number == null ? 'home:needsCard.kind.changeBare' : 'home:needsCard.kind.change';
}

/**
 * What the card lists, given the number of rows its column fits (`fit`, from
 * useBesideFit). Without a measurement it lists NEEDS_ROWS and nothing more,
 * as every layout but the column beside Pinned apps does. With one it lists
 * every thread that fits, and when some do not, one row of the space goes to
 * "N more": the rows shown plus `more` are the whole list, which is the count
 * in the heading. `total` is that count when the list runs past the one page
 * the card asked for (so the rows it holds are fewer than there are).
 */
export function needsLayout(feed: RecentThreadItem[], fit: number | null, total = feed.length): { rows: RecentThreadItem[]; more: number } {
  if (fit == null) return { rows: feed.slice(0, NEEDS_ROWS), more: 0 };
  if (total <= fit) return { rows: feed, more: 0 };
  const rows = feed.slice(0, Math.max(0, fit - 1));
  return { rows, more: total - rows.length };
}

/** One row's height before any row has been measured: a three-line row and its padding. */
const ROW_FALLBACK = 68;

/**
 * How many rows the card's column beside Pinned apps fits, or `null` where
 * the card is not that column (under 1280px, on a phone, or with nothing to
 * measure), so those layouts list as they always have.
 *
 * The column is the section's parent, and it is the column only while the
 * page's grid puts it in column 2 (`app.css`, "NEEDS YOU BESIDE PINNED
 * APPS"). It holds `contain: size`, so Pinned apps alone sets its height and
 * the rows the card draws cannot change it: measuring can never chase its own
 * result. The room is the column's height less the heading and the panel's
 * padding, over one row's own height (the first row's, so a text-size change
 * is counted). Nothing here runs in the prerender.
 */
export function useBesideFit(
  sectionRef: RefObject<HTMLElement | null>,
  listRef: RefObject<HTMLUListElement | null>,
  /** Whether the card is drawn at all: it goes up after the first paint when the list arrives. */
  drawn = true,
): number | null {
  const [fit, setFit] = useState<number | null>(null);
  useEffect(() => {
    const section = sectionRef.current;
    const aside = section?.parentElement;
    if (!drawn || !section || !aside || typeof ResizeObserver === 'undefined') {
      setFit(null);
      return undefined;
    }
    const measure = () => {
      if (getComputedStyle(aside).gridColumnStart !== '2') { setFit(null); return; }
      const panel = section.querySelector('.wip-panel');
      const heading = section.firstElementChild as HTMLElement | null;
      if (!(panel instanceof HTMLElement)) { setFit(null); return; }
      const style = getComputedStyle(panel);
      const padding = (parseFloat(style.paddingTop) || 0) + (parseFloat(style.paddingBottom) || 0);
      const avail = aside.clientHeight - (heading?.offsetHeight || 0) - padding;
      const first = listRef.current?.querySelector('li');
      const rowH = first ? first.getBoundingClientRect().height : 0;
      const next = Math.max(2, Math.floor(avail / (rowH > 0 ? rowH : ROW_FALLBACK)));
      setFit((was) => (was === next ? was : next));
    };
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(aside);
    observer.observe(section);
    window.addEventListener('resize', measure);
    return () => {
      observer.disconnect();
      window.removeEventListener('resize', measure);
    };
  }, [sectionRef, listRef, drawn]);
  return fit;
}

/**
 * Open the sheet's Recent threads list over Home: the card shows the newest
 * few, and the heading, the last row and every "more" lead there. The tab is
 * left on the sheet's store for it to pick up as it opens (its own state is
 * the sheet's business).
 */
export function openThreadsList(): void {
  try { notificationsSheetStore.set({ tab: 'threads' }); } catch { /* the sheet opens on its own tab */ }
  const win = window as any;
  try {
    if (typeof win.App?.openNotificationsSheet === 'function') { win.App.openNotificationsSheet(); return; }
    win.NotificationsSheet?.open?.();
  } catch { /* the page stays where it is */ }
}

function demoQuery(): string {
  try {
    return new URLSearchParams(location.search).get('demo') === '1' ? '&demo=1' : '';
  } catch {
    return '';
  }
}

export function NeedsYouCard(): ReactNode {
  const t = useMessages('home');
  // Until the list is read this load, the card stands on what the last visit
  // saw on this device, so its place is held from the first paint and nothing
  // under it moves when the list arrives. Somebody with no threads last time
  // gets no placeholder to flash and go.
  const [hint] = useState(readNeedsHint);
  const [feed, setFeed] = useState<RecentThreadItem[] | null>(null);
  // The list's own count: the server's whole answer, which outlasts one page
  // of rows, so the heading's number is the rows shown plus the "more" row.
  const [serverTotal, setServerTotal] = useState<number | null>(null);
  useEffect(() => {
    let live = true;
    sharedJson<{ threads?: RecentThreadItem[]; total?: number }>(
      `/api/me/recent-threads?limit=${THREADS_LIMIT}${demoQuery()}`,
      { fresh: true },
    )
      .then((body) => {
        if (!live || !body || !Array.isArray(body.threads)) return;
        setFeed(body.threads);
        setServerTotal(Number.isFinite(Number(body.total)) ? Number(body.total) : body.threads.length);
      })
      .catch(() => { /* nothing to list: the card keeps its place until the next visit */ });
    return () => { live = false; };
  }, []);

  const count = feed ? (serverTotal ?? feed.length) : hint;
  const drawn = feed ? feed.length > 0 : hint > 0;
  useEffect(() => { if (feed) writeNeedsHint(count); }, [feed, count]);

  // Beside Pinned apps the column lists what fits of the list, and its last
  // row says how many more there are; everywhere else it lists NEEDS_ROWS.
  const sectionRef = useRef<HTMLElement | null>(null);
  const listRef = useRef<HTMLUListElement | null>(null);
  const fit = useBesideFit(sectionRef, listRef, drawn);
  if (!drawn) return null;
  const threads = feed || [];
  const { rows, more } = needsLayout(threads, fit, count);
  const leftOut = count - rows.length;

  return (
    <section ref={sectionRef} id="home-needs-card" aria-label={t('home:needsCard.eyebrow')} data-threads={String(count)}>
      {/* The section's label line, on the page as every section's is: the
          label, the count beside it and a chevron, all one thing to press,
          opening the sheet's list of every recent thread. */}
      <SectionHeading>
        <WipHeadMore
          id="home-needs-card-btn"
          direction="right"
          onClick={openThreadsList}
          label={leftOut > 0 ? t('home:needsCard.seeAllCount', { count }) : t('home:needsCard.seeAll')}
        >
          <span id="home-needs-card-title" className="wip-head-words">{t('home:needsCard.eyebrow')}</span>
          <span className="wip-count" aria-hidden="true">{count}</span>
        </WipHeadMore>
        <span className="sr-only">{t('home:needsCard.total', { count })}</span>
      </SectionHeading>
      {/* What happened lately, in one to four columns by the room there is, each a row that opens its thread. */}
      {!feed ? (
        // The list is on its way: as many placeholder rows as the last visit
        // saw (as far as the card lists), in the same columns, so the card is
        // its own height.
        <WipCard className="wip-panel animate-pulse" data-tone="ask" data-loading="" role="status" aria-label={t('home:grid.loading')}>
          <ul className="wip-rows wip-rows-cols">
            {Array.from({ length: Math.min(hint, NEEDS_ROWS) }, (_, i) => <li key={i}><WipSkelRow /></li>)}
          </ul>
        </WipCard>
      ) : rows.length || more ? (
        <WipCard className="wip-panel" data-tone="ask">
        <ul ref={listRef} className="wip-rows wip-rows-cols" aria-labelledby="home-needs-card-title">
          {rows.map((thread) => {
            // The shape AvatarChip hands an app tile, so the notifications
            // sheet's row and this one draw a project's icon alike.
            const app = {
              name: thread.appName || '',
              icon_url: thread.appIconUrl || null,
              icon_emoji: thread.appIconEmoji || null,
            };
            const { text: when, title: whenTitle } = agoStamp(thread.lastAt);
            return (
              <li key={thread.threadId}>
                <a className="wip-row" href={thread.href} data-recent-thread={thread.threadId}>
                  <span
                    aria-hidden="true"
                    data-icon={appIconKind(app)}
                    className="app-icon-tile w-11 h-11 shrink-0 rounded-xl overflow-hidden flex items-center justify-center font-bold text-lg"
                  >
                    <AppIconContent app={app} />
                  </span>
                  <span className="wip-item-text">
                    <span className="wip-item-kind block text-xs text-zinc-500 dark:text-zinc-400 truncate">
                      {t(kindId(thread), { number: thread.number == null ? '' : String(thread.number) })}
                    </span>
                    <b className="wip-item-title block text-[15px] font-[650] truncate">{thread.title}</b>
                    {thread.lastAt ? (
                      <span className="wip-item-meta block text-[13px] text-zinc-500 dark:text-zinc-400 truncate">
                        <RichMessage
                          id="home:needsCard.meta"
                          values={{ project: app.name, when }}
                          components={[<time title={whenTitle} />]}
                        />
                      </span>
                    ) : (
                      <span className="wip-item-meta block text-[13px] text-zinc-500 dark:text-zinc-400 truncate">{app.name}</span>
                    )}
                  </span>
                </a>
              </li>
            );
          })}
          {more > 0 ? (
            // What did not fit is said, not hidden: the rows above plus this
            // number are the count in the heading, and it opens the whole list.
            <li>
              <button type="button" className="wip-row wip-row-more" data-threads-more="" onClick={openThreadsList}>
                {t('home:needsCard.more', { count: more })}
              </button>
            </li>
          ) : null}
        </ul>
        </WipCard>
      ) : null}
    </section>
  );
}
