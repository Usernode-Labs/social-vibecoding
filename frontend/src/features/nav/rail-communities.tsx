/**
 * #platform-rail-communities — your communities, in the desktop's sidebar of
 * rows (D, 18 Oct 2026, ./sidebar-rows.ts).
 *
 * ── What it is ───────────────────────────────────────────────────────
 *
 * Under a Communities heading, the five communities you opened last, each its
 * own tile, its name and the votes it waits on you for. Pressing one switches
 * to it in place, keeping the place you were on when it has it
 * (../workshop/community-scope.ts goToCommunity), as the phone's drawer does.
 * Pressing the one you are on goes up its page a level at a time and stops at
 * its Hub (../workshop/tab-ladder.ts pressLitTab). After them, the
 * Communities tab itself, drawn as "All 13 communities" (./tab-bar.tsx), opens
 * the list of every community.
 *
 * ── The places, under the row (v3) ───────────────────────────────────
 *
 * The community whose page is up opens under its row: Hub, Needs you and
 * Workshop, then #general under Channels and the topics under Topics, the
 * first two and "Show N more" (../dev-board/workshop/project-places.tsx, the
 * list the section column drew beside the strip, which steps aside from
 * 1024px). A press moves the page in place, as a press in that column did.
 * The row itself keeps `aria-current` but gives its fill to the place lit
 * under it, and its count to Needs you, which says the same votes. A
 * community you are only visiting, which is not one of the five, has a row
 * at the top for as long as you are on its page, so its places are always
 * here. The part opens and shuts on the one clock ./rail-nest.tsx keeps.
 *
 * THE HEADING HOLDS A SEARCH, shown while the pointer is over the section or
 * the search has focus (app.css). It is All communities with its search box
 * focused and lit (../workshop/communities-search.ts).
 *
 * ── Which five ───────────────────────────────────────────────────────
 *
 * This device's own order, kept per viewer (`railCommunities`): the five
 * most recently active of your communities to begin with, and after that a
 * community you open that is not among them comes in at the top, pushing the
 * last one out. A community already listed keeps its row, so a row never
 * moves under the pointer that pressed it. Only communities you are in are
 * listed: a page you are visiting is not one of yours until you join it.
 *
 * ── Where it is, and when ─────────────────────────────────────────────
 *
 * Between the Messages tab and the Communities tab, in the reading order the
 * sidebar shows. On the 76px strip (768px to 1024px) and on the phone's bar
 * app.css does not draw it: the bar's five cells and the strip's tabs are as
 * they were.
 *
 * ── The initial render is the prerender ──────────────────────────────
 *
 * The heading and the search ship in the document; the rows do not. The
 * community list arrives from GET /api/apps after sign-in (warmCommunities)
 * and this device's order from localStorage in an effect, so the prerendered
 * document and the first client render agree on a heading and no rows.
 */

import { Fragment, useEffect, useState, type MouseEvent } from 'react';

import { SearchIcon } from '@/components/ui/icons';

import { useMessages } from '../../lib/i18n/react';
import { useStoreState } from '../../lib/use-store-state';
import { AppIconContent, appIconKind } from '../apps/app-card-view';
import { devWorkshopStore } from '../dev-board/card/cards-store';
import { useCommunity } from '../dev-board/workshop/community-card';
import { openPlace, placeStore } from '../dev-board/workshop/place-store';
import { ProjectPlaces } from '../dev-board/workshop/project-places';
import { openCommunitiesSearch } from '../workshop/communities-search';
import { communityScopeStore, goToCommunity, type CommunityInfo } from '../workshop/community-scope';
import { pressLitTab } from '../workshop/tab-ladder';
import { navStore } from './nav-store.js';
import { NestSlot } from './rail-nest';
import { useSidebarRows } from './sidebar-rows';

/** How many communities the sidebar lists. */
export const RAIL_COMMUNITIES = 5;

/** How many of a community's topics its nested places draw before "Show N more". */
export const RAIL_TOPICS = 2;

/**
 * The rows the section draws: the five, and first, while its page is up, a
 * community you are visiting that is not among them. Pure.
 */
export function railRows(shown: readonly string[], onPage: string | null): string[] {
  return onPage && !shown.includes(onPage) ? [onPage, ...shown] : [...shown];
}

/** This device's order, per viewer. */
const KEY = 'platformRailCommunities:v1';

/**
 * The communities the sidebar lists: the ones this device kept that are still
 * among yours, in its order, then the most recently active of the rest, at
 * most `limit`. `list` is every community you are in, newest first (the
 * scope store's). Pure.
 */
export function railCommunities(kept: readonly string[], list: readonly string[] | null, limit = RAIL_COMMUNITIES): string[] {
  if (!list) return [];
  const out: string[] = [];
  for (const slug of [...kept, ...list]) {
    if (out.length >= limit) break;
    if (list.includes(slug) && !out.includes(slug)) out.push(slug);
  }
  return out;
}

/**
 * The order after `slug` was opened: unchanged when it is already listed (or
 * is not one of yours), else `slug` first and the last one out. Pure.
 */
export function noteOpened(shown: readonly string[], slug: string | null, list: readonly string[] | null, limit = RAIL_COMMUNITIES): string[] | null {
  if (!slug || !list || !list.includes(slug) || shown.includes(slug)) return null;
  return [slug, ...shown].slice(0, limit);
}

function readKept(viewer: string | null): string[] {
  if (!viewer) return [];
  try {
    const raw = JSON.parse(window.localStorage.getItem(KEY) || 'null');
    return raw && raw.viewer === viewer && Array.isArray(raw.slugs)
      ? raw.slugs.filter((s: unknown): s is string => typeof s === 'string')
      : [];
  } catch {
    return [];
  }
}

function saveKept(viewer: string | null, slugs: string[]): void {
  if (!viewer) return;
  try { window.localStorage.setItem(KEY, JSON.stringify({ viewer, slugs })); } catch { /* the order lasts this visit */ }
}

/**
 * The five, kept current: read from this device once the viewer is named,
 * and moved when a community not among them is opened. ./tab-bar.tsx reads
 * it once and hands it to the section and to the All row's count.
 */
export function useRailCommunities(): string[] {
  const { viewer } = useStoreState(navStore);
  const { slug, list } = useStoreState(communityScopeStore);
  // Whose order `slugs` is: a community opened before this viewer's order
  // has been read must not write over it.
  const [kept, setKept] = useState<{ viewer: string | null; slugs: string[] }>({ viewer: null, slugs: [] });
  useEffect(() => { setKept({ viewer, slugs: readKept(viewer) }); }, [viewer]);
  const ready = !!viewer && kept.viewer === viewer;
  const shown = railCommunities(ready ? kept.slugs : [], list);
  const shownKey = shown.join();
  useEffect(() => {
    if (!ready) return;
    const next = noteOpened(shown, slug, list);
    if (!next) return;
    setKept({ viewer, slugs: next });
    saveKept(viewer, next);
    // `shown` is read through its key: the same five are the same answer.
  }, [ready, slug, list, viewer, shownKey]);
  return shown;
}

/** The votes in your communities the sidebar does not list: the All row's count. Pure. */
export function votesElsewhere(shown: readonly string[], list: readonly string[] | null, info: Record<string, CommunityInfo>): number {
  if (!list) return 0;
  return list.reduce((n, s) => (shown.includes(s) || info[s]?.unchosen ? n : n + (Number(info[s]?.needs) || 0)), 0);
}

/** A community's places, nested under its row: the section column's list, kept short. */
function RailPlaces({ slug }: { slug: string }) {
  const place = useStoreState(placeStore);
  const v = useStoreState(devWorkshopStore);
  const community = useCommunity(slug);
  const here = place.slug === slug;
  return (
    <ProjectPlaces
      slug={slug}
      name={community?.name || slug}
      // Nothing lit until the page has said where it is.
      place={here ? place.place : null}
      owed={here ? place.owed : 0}
      places={community?.places}
      // #2915: the Workshop's dot, as the page's own list draws it.
      filtered={here && v.slug === slug && !!v.meta?.filtered && place.place !== 'all'}
      fold={RAIL_TOPICS}
      onPlace={(key) => { openPlace(slug, key); }}
    />
  );
}

function isNativeClick(event: MouseEvent): boolean {
  const nav = (window as unknown as { NavLink?: { isNativeClick?: (e: unknown) => boolean } }).NavLink;
  return !!nav?.isNativeClick?.(event);
}

export function RailCommunities({ shown }: { shown: string[] }) {
  const t = useMessages('core');
  const { slug: scoped, info } = useStoreState(communityScopeStore);
  const { screen, tab } = useStoreState(navStore);
  const sidebarRows = useSidebarRows();
  // The community whose page is on screen: the Communities tab is lit there
  // (#app-view on its `dev` tab), and the scope names which.
  const onPage = screen === 'app-view' && tab === 'workshop' ? scoped : null;
  // Its places open under it with the page, as the inbox's part shuts.
  const nested = sidebarRows && onPage ? onPage : null;
  const rows = sidebarRows ? railRows(shown, onPage) : shown;
  const visiting = rows.find((slug) => !shown.includes(slug)) || null;
  const visit = useCommunity(visiting || '');
  return (
    <div
      id="platform-rail-communities"
      className="platform-rail-communities"
      role="group"
      aria-labelledby="platform-rail-communities-label"
    >
      <div className="platform-rail-head">
        <span id="platform-rail-communities-label" className="platform-rail-head-label">{t('core:rail.communities')}</span>
        <a
          id="platform-rail-search"
          className="platform-rail-search"
          href="#communities"
          aria-label={t('core:rail.search')}
          title={t('core:rail.search')}
          onClick={(event) => {
            if (isNativeClick(event)) return;
            event.preventDefault();
            openCommunitiesSearch();
          }}
        >
          <SearchIcon className="platform-rail-search-glyph" aria-hidden="true" />
        </a>
      </div>
      {rows.map((slug) => {
        const c = info[slug];
        const name = c?.name || (slug === visiting ? visit?.name : null) || slug;
        const record = { icon_url: c?.iconUrl || null, icon_emoji: c?.iconEmoji || null, name };
        const open = nested === slug;
        // Open, its votes are Needs you's count under it.
        const votes = c && !c.unchosen && !open ? Number(c.needs) || 0 : 0;
        const lit = onPage === slug;
        return (
          <Fragment key={slug}>
            <a
              className="platform-rail-community"
              href={`#app/${encodeURIComponent(slug)}/workshop`}
              data-rail-community={slug}
              {...(open ? { 'data-rail-open': '' } : {})}
              title={name}
              aria-current={lit ? 'page' : undefined}
              onClick={(event) => {
                if (isNativeClick(event)) return;
                event.preventDefault();
                if (lit) pressLitTab(screen, { stopAtCommunity: true });
                else goToCommunity(slug);
              }}
            >
              <span className="app-icon-tile platform-rail-tile" data-icon={appIconKind(record)} aria-hidden="true">
                <AppIconContent app={record} />
              </span>
              <span className="platform-rail-name">{name}</span>
              {votes > 0 ? (
                <span className="platform-rail-votes" aria-label={t('core:tabs.votesWaiting', { count: votes })}>
                  {votes > 99 ? '99+' : String(votes)}
                </span>
              ) : null}
            </a>
            <NestSlot open={open} className="platform-rail-nest" rows=".dev-ws-place, .dev-ws-places-head">
              <RailPlaces slug={slug} />
            </NestSlot>
          </Fragment>
        );
      })}
    </div>
  );
}
