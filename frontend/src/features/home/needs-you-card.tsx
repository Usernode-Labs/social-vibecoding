/**
 * Needs you: Home's card under Standard (WIP) (`#home-aside`, ./index.tsx),
 * a full-width row of its own, just above Challenges.
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

import { useEffect, useRef, useState, type ReactNode, type RefObject } from 'react';

import { RichMessage, useMessages } from '../../lib/i18n/react';
import { sharedJson } from '../../lib/shared-read';
import { agoStamp } from '../../lib/timestamp';
import { useStoreState } from '../../lib/use-store-state';
import { AppIconContent, appIconKind } from '../apps/app-card-view';
import { placeHref } from '../dev-board/workshop/places';
import { communityScopeStore } from '../workshop/community-scope';
import { SectionHeading } from './panels/ui';
import { WipCard, WipHeadMore, WipSkelRow } from './wip-kit';

/** What the card reads of a feed item (../workshop/needs-reel.tsx NeedsFeedItem). */
export interface NeedsCardItem {
  kind: string;
  id: number;
  title: string;
  /** The change's or request's number, where it has one. */
  number?: number | null;
  /** When it started waiting, for the row's "2h ago". */
  at?: string | null;
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

// The card is the look's own (./wip-kit.tsx, app.css "STANDARD (WIP)"): its
// label, the count and See all on one line, then what waits as rows in
// one to four columns by the screen's width, each with its whole title, opening its project's Needs you.

/** Where the count of the last visit is kept on the device, for the first paint's placeholder. */
export const NEEDS_HINT_KEY = 'homeroom:needs-waiting';
export function readNeedsHint(): number {
  try { return Math.max(0, Math.trunc(Number(window.localStorage.getItem(NEEDS_HINT_KEY)) || 0)); } catch { return 0; }
}
export function writeNeedsHint(count: number): void {
  try {
    if (count > 0) window.localStorage.setItem(NEEDS_HINT_KEY, String(count));
    else window.localStorage.removeItem(NEEDS_HINT_KEY);
  } catch { /* the next load draws no placeholder */ }
}

/** How many decisions the card lists where it cannot measure its column (two lines of four on a wide screen). */
export const NEEDS_ROWS = 8;

/**
 * The rows' first line, as a three-line row reads it (the notifications
 * sheet's Recent threads rows): what waits, and its number where it has one.
 * A competing set of changes and a question the bot asked are decided on
 * their request's page, so both read "Request #N".
 */
export function kindId(item: NeedsCardItem): string {
  if (item.kind === 'governance') return 'home:needsCard.kind.decision';
  if (item.kind === 'ballot' || item.kind === 'question') {
    return item.number == null ? 'home:needsCard.kind.requestBare' : 'home:needsCard.kind.request';
  }
  return item.number == null ? 'home:needsCard.kind.changeBare' : 'home:needsCard.kind.change';
}

/**
 * What the card lists, given the number of rows its column fits (`fit`, from
 * useBesideFit). Without a measurement it lists NEEDS_ROWS and nothing more,
 * as every layout but the column beside Pinned apps does. With one it lists
 * every waiting decision that fits, and when some do not, one row of the
 * space goes to "N more": the rows shown plus `more` are the whole feed,
 * which is the count in the heading.
 */
export function needsLayout(feed: NeedsCardItem[], fit: number | null): { rows: NeedsCardItem[]; more: number } {
  if (fit == null) return { rows: feed.slice(0, NEEDS_ROWS), more: 0 };
  if (feed.length <= fit) return { rows: feed, more: 0 };
  const rows = feed.slice(0, Math.max(0, fit - 1));
  return { rows, more: feed.length - rows.length };
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
  /** Whether the card is drawn at all: it goes up after the first paint when the count arrives. */
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

/** A plain tap opens the project on its Needs you; the browser keeps a new tab's click. */
function openNeeds(event: React.MouseEvent<HTMLAnchorElement>, slug: string) {
  const win = window as any;
  if (win.NavLink?.isNativeClick?.(event)) return;
  event.preventDefault();
  try { win.AppView?._landOnTab?.(slug, 'needs'); } catch { /* the page opens on what it remembers */ }
  win.App?.navigateToApp?.(slug, 'dev');
}

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

export function NeedsYouCard(): ReactNode {
  const t = useMessages('home');
  const { badgeNeeds } = useStoreState(communityScopeStore) as { badgeNeeds?: number | null };
  // Until the count is known this load, the card stands on what the last
  // visit saw on this device, so its place is held from the first paint and
  // nothing under it moves when the count and the list arrive. Somebody with
  // nothing waiting last time gets no placeholder to flash and go.
  const [hint] = useState(readNeedsHint);
  const known = typeof badgeNeeds === 'number';
  const waiting = Math.max(0, known ? Number(badgeNeeds) || 0 : hint);
  useEffect(() => { if (known) writeNeedsHint(Number(badgeNeeds) || 0); }, [known, badgeNeeds]);
  const [feed, setFeed] = useState<NeedsCardItem[] | null>(null);
  // Read again whenever the count moves: a vote cast, or a new one opened.
  useEffect(() => {
    if (!waiting) { setFeed(null); return undefined; }
    // The remembered count draws the placeholder; the list is read once the
    // count is this load's own.
    if (!known) return undefined;
    let live = true;
    sharedJson<{ items?: NeedsCardItem[] }>(`/api/workshop/needs-feed${demoQuery()}`, { fresh: true })
      .then((body) => { if (live && body && Array.isArray(body.items)) setFeed(body.items); })
      .catch(() => { /* the card keeps its count; the page says what failed */ });
    return () => { live = false; };
  }, [waiting, known]);

  const summary = needsSummary(waiting, feed);
  // Beside Pinned apps the column lists what fits of the feed, and its last
  // row says how many more wait; everywhere else it lists NEEDS_ROWS.
  const sectionRef = useRef<HTMLElement | null>(null);
  const listRef = useRef<HTMLUListElement | null>(null);
  const fit = useBesideFit(sectionRef, listRef, !!summary);
  if (!summary) return null;
  const items = feed || [];
  const { rows, more } = needsLayout(items, fit);
  const leftOut = items.length - rows.length;

  return (
    <section ref={sectionRef} id="home-needs-card" aria-label={t('home:needsCard.eyebrow')} data-needs={String(summary.total)}>
      {/* The section's label line, on the page as every section's is: the
          label, the count beside it and a chevron, all one link that opens
          all of Needs you. */}
      <SectionHeading>
        <WipHeadMore
          id="home-needs-card-btn"
          direction="right"
          href="#needs"
          label={leftOut > 0 ? t('home:needsCard.seeAllCount', { count: summary.total }) : t('home:needsCard.seeAll')}
        >
          <span id="home-needs-card-title" className="wip-head-words">{t('home:needsCard.eyebrow')}</span>
          <span className="wip-count" aria-hidden="true">{summary.total}</span>
        </WipHeadMore>
        <span className="sr-only">{t('home:needsCard.waiting', { count: summary.total })}</span>
      </SectionHeading>
      {/* What waits, in one to four columns by the room there is, each a row that opens its project's Needs you. */}
      {!feed ? (
        // The list is on its way: as many placeholder rows as wait (as far as
        // the card lists), in the same columns, so the card is its own height.
        <WipCard className="wip-panel animate-pulse" data-tone="ask" data-loading="" role="status" aria-label={t('home:grid.loading')}>
          <ul className="wip-rows wip-rows-cols">
            {Array.from({ length: Math.min(summary.total, NEEDS_ROWS) }, (_, i) => <li key={i}><WipSkelRow /></li>)}
          </ul>
        </WipCard>
      ) : rows.length || more ? (
        <WipCard className="wip-panel" data-tone="ask">
        <ul ref={listRef} className="wip-rows wip-rows-cols" aria-labelledby="home-needs-card-title">
          {rows.map((item) => {
            const slug = item.app?.slug || '';
            // The shape AvatarChip hands an app tile, so the notifications
            // sheet's row and this one draw a project's icon alike.
            const app = {
              name: item.app?.name || '',
              icon_url: item.app?.icon_url || null,
              icon_emoji: item.app?.icon_emoji || null,
            };
            const { text: when, title: whenTitle } = agoStamp(item.at);
            return (
              <li key={`${item.kind}:${item.id}`}>
                <a
                  className="wip-row"
                  href={slug ? placeHref(slug, 'needs') : '#needs'}
                  data-needs-item={`${item.kind}:${item.id}`}
                  onClick={slug ? (event) => openNeeds(event, slug) : undefined}
                >
                  <span
                    aria-hidden="true"
                    data-icon={appIconKind(app)}
                    className="app-icon-tile w-11 h-11 shrink-0 rounded-xl overflow-hidden flex items-center justify-center font-bold text-lg"
                  >
                    <AppIconContent app={app} />
                  </span>
                  <span className="wip-item-text">
                    <span className="wip-item-kind block text-xs text-zinc-500 dark:text-zinc-400 truncate">
                      {t(kindId(item), { number: item.number == null ? '' : String(item.number) })}
                    </span>
                    <b className="wip-item-title block text-[15px] font-[650] truncate">{item.title}</b>
                    {item.at ? (
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
                  <span className={decides(item) ? 'wip-pill wip-pill-action' : 'wip-pill'}>
                    {decides(item) ? t('home:needsCard.vote') : t('home:needsCard.advisoryPill')}
                  </span>
                </a>
              </li>
            );
          })}
          {more > 0 ? (
            // What did not fit is said, not hidden: the rows above plus this
            // number are the count in the heading.
            <li>
              <a className="wip-row wip-row-more" href="#needs" data-needs-more="">
                {t('home:needsCard.more', { count: more })}
              </a>
            </li>
          ) : null}
        </ul>
        </WipCard>
      ) : null}
    </section>
  );
}
