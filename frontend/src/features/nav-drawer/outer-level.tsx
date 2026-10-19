/**
 * LEVEL 0 OF THE PHONE'S DRAWER: every community you are in.
 *
 * The Communities screen's own list (../workshop/index.tsx), drawn at 85% of
 * the screen with the places peeking beside it: Needs you when a vote waits,
 * then Public communities, Private communities and Just you, three at a time
 * with Show more, then Join and Start. The rows and sections are that
 * screen's components, so the two lists cannot drift; what is the drawer's
 * own is the search at the top and what a row does when pressed. A row
 * switches community IN PLACE (`onPick`), keeping the place you were on when
 * the new community has it, rather than opening its hub as a door.
 *
 * THE SEARCH. Focus widens the level to the whole screen (the places slide
 * out of the way) with a Cancel beside the field; Cancel, a pick, the lit
 * tab or the header's arrow narrow it again and clear it. It filters your
 * communities by name, as one list.
 *
 * Its data is the screen's two reads (GET /api/apps?scope=joined and
 * /api/workshop/counts), asked for when the level is first wanted and again
 * each time it comes into view, kept here between visits. The screen's own
 * rows, when it has them, are the first paint.
 */

import { useEffect, useRef, useState, type ReactNode, type Ref } from 'react';

import { GroupedList, ListRow, SectionHeader } from '@/components/ui/grouped-list';
import { IconTile } from '@/components/ui/icon-tile';
import { PlusIcon, SearchIcon, SpeechCheckIcon } from '@/components/ui/icons';

import { useMessages } from '../../lib/i18n/react';
import { AppsLoadError } from '../apps/load-error';
import {
  AppRow, groupRows, joinCounts, needsApps, orderRows, RowSkeletons, Section, unseenRow, type WorkshopRow,
} from '../workshop/index';
import { useNeedsSeen } from '../workshop/needs-seen';
import { matchRows } from '../workshop/sections';
import { workshopStore } from '../workshop/workshop-store.js';
import { setSearching } from './drawer-store';

type Rows = WorkshopRow[] | null;
type AppHalf = Omit<WorkshopRow, 'working' | 'needs'>;

let cached: Rows = null;
let failed = false;
let reading: Promise<void> | null = null;
const listeners = new Set<() => void>();

function publish(): void {
  for (const listener of [...listeners]) listener();
}

/** The two reads, joined; the counts may fail, the list may not. */
export function readCommunities(): Promise<void> {
  if (reading) return reading;
  reading = (async () => {
    try {
      const [appsRes, countsRes] = await Promise.all([
        fetch('/api/apps?scope=joined'),
        fetch('/api/workshop/counts', { cache: 'no-cache' }).catch(() => null),
      ]);
      if (!appsRes.ok) throw new Error(`apps ${appsRes.status}`);
      const data = await appsRes.json();
      const list = (data?.apps || []) as Array<Record<string, unknown>>;
      // Membership through the predicate Discover's Join pill reads, as the
      // Communities screen's own list does.
      const home = (window as unknown as { Home?: { isJoined?: (app: unknown) => boolean } }).Home;
      const joined = home?.isJoined
        ? (app: Record<string, unknown>) => !!home.isJoined?.(app)
        : (app: Record<string, unknown>) => !!app?.is_member;
      let counts = {};
      if (countsRes && countsRes.ok) {
        const c = await countsRes.json().catch(() => null);
        if (c && c.counts && typeof c.counts === 'object') counts = c.counts;
      }
      cached = joinCounts(list.filter(joined) as AppHalf[], counts);
      failed = false;
    } catch {
      // Offline is a state: the list kept from before stays, else the error.
      failed = !cached;
    } finally {
      reading = null;
      publish();
    }
  })();
  return reading;
}

function useCommunities(wanted: boolean): { rows: Rows; error: boolean } {
  const [, bump] = useState(0);
  useEffect(() => {
    const listener = () => bump((n) => n + 1);
    listeners.add(listener);
    return () => { listeners.delete(listener); };
  }, []);
  useEffect(() => {
    if (wanted) void readCommunities();
  }, [wanted]);
  const seed = cached || (workshopStore.get() as { rows: Rows }).rows || null;
  return { rows: seed, error: failed && !seed };
}

/**
 * The rows whose name has `query` in it, in the list's own order, an exact
 * name first (#5472). The rule itself is the screen's: ./sections.ts holds
 * it, where the drawer can read it without importing the screen back.
 * Pure.
 */
export function matchCommunities(rows: readonly WorkshopRow[], query: string): WorkshopRow[] {
  return matchRows(rows, query);
}

/** The cross-community Needs you feed: the Communities screen's page. */
function openNeedsFeed(): void {
  const w = window as unknown as { UsernodeReact?: { workshop?: { setTab?: (tab: string) => void } } };
  try { w.UsernodeReact?.workshop?.setTab?.('needs'); } catch { /* the screen opens on its list */ }
  window.location.hash = '#communities';
}

export function OuterLevel({ current, searching, wanted, onPick, listRef }: {
  /** The community the drawer is on. */
  current: string | null;
  searching: boolean;
  /** The level is on screen, or about to be. */
  wanted: boolean;
  onPick: (row: WorkshopRow) => void;
  listRef: Ref<HTMLDivElement>;
}): ReactNode {
  const t = useMessages('communities');
  useNeedsSeen();
  const { rows: raw, error } = useCommunities(wanted);
  const [query, setQuery] = useState('');
  const input = useRef<HTMLInputElement>(null);
  // Narrowed (Cancel, a pick, the tab, the arrow): the search is over.
  useEffect(() => {
    if (searching) return;
    setQuery('');
    if (input.current && document.activeElement === input.current) input.current.blur();
  }, [searching]);

  const rows = raw ? orderRows(raw.map(unseenRow)) : null;
  const q = query.trim();
  const totals = rows && rows.length > 0
    ? rows.reduce((acc, row) => ({ needs: acc.needs + (row.needs || 0), owed: acc.owed + (row.owedCount || 0) }), { needs: 0, owed: 0 })
    : null;
  const empty = !!rows && rows.length === 0 && !error;

  let body: ReactNode;
  if (error) {
    body = (
      <GroupedList tone="plane">
        <AppsLoadError title={t('communities:list.loadError')} onRetry={() => { void readCommunities(); }} />
      </GroupedList>
    );
  } else if (rows === null) {
    body = <GroupedList tone="plane"><RowSkeletons /></GroupedList>;
  } else if (q) {
    const found = matchCommunities(rows, q);
    body = found.length ? (
      <GroupedList tone="plane" data-nav-drawer-results="">
        {found.map((row) => <AppRow key={row.slug} row={row} onOpen={onPick} current={row.slug === current} />)}
      </GroupedList>
    ) : (
      <p className="nav-drawer-outer-none" data-nav-drawer-none="">{t('communities:drawer.search.none', { query: q })}</p>
    );
  } else {
    body = (
      <>
        {totals && totals.owed > 0 ? (
          <section aria-labelledby="nav-drawer-needs-heading">
            <SectionHeader id="nav-drawer-needs-heading">{t('communities:needsYou.heading')}</SectionHeader>
            <GroupedList tone="plane">
              <ListRow
                as="button"
                data-nav-drawer-needs=""
                onClick={openNeedsFeed}
                leading={(
                  <span className="app-icon-tile w-11 h-11 shrink-0 rounded-xl flex items-center justify-center bg-violet-50 text-violet-700 dark:bg-violet-950/40 dark:text-violet-300">
                    <SpeechCheckIcon className="w-5 h-5" aria-hidden="true" />
                  </span>
                )}
                title={totals.needs > 0
                  ? t('communities:needsYou.waiting', { count: totals.needs })
                  : t('communities:needsYou.skipped', { count: totals.owed })}
                subtitle={needsApps(rows, !totals.needs)}
                trailing={<span className="text-sm font-semibold text-violet-700 dark:text-violet-300">{t('communities:needsYou.review')}</span>}
                chevron={false}
              />
            </GroupedList>
          </section>
        ) : null}
        {empty ? (
          <GroupedList tone="plane">
            <ListRow
              as="a"
              href="#apps"
              title={t('communities:list.empty.title')}
              subtitle={t('communities:list.empty.subtitle')}
              subtitleClassName="whitespace-normal"
            />
          </GroupedList>
        ) : groupRows(rows).map((section) => (
          <Section
            key={section.key}
            audience={section.key}
            label={section.label}
            count={section.count}
            rows={section.rows}
            idPrefix="nav-drawer-section"
            onOpen={onPick}
            current={current}
          />
        ))}
        <GroupedList tone="plane" className="mt-6">
          {empty ? null : (
            <ListRow
              as="a"
              href="#apps"
              leading={<IconTile size="sm" tint="neutral"><SearchIcon aria-hidden="true" /></IconTile>}
              title={t('communities:list.join.title')}
              subtitle={t('communities:list.join.subtitle')}
            />
          )}
          <ListRow
            as="button"
            onClick={() => { (window as unknown as { App?: { showCreateModal?: () => void } }).App?.showCreateModal?.(); }}
            leading={<IconTile size="sm" tint="neutral"><PlusIcon aria-hidden="true" /></IconTile>}
            title={t('communities:list.start.title')}
            subtitle={t('communities:list.start.subtitle')}
          />
        </GroupedList>
      </>
    );
  }

  return (
    <>
      <div className="nav-drawer-search">
        <label className="nav-drawer-search-box">
          <SearchIcon className="nav-drawer-search-glyph" aria-hidden="true" />
          <input
            ref={input}
            type="search"
            className="nav-drawer-search-input"
            value={query}
            placeholder={t('communities:drawer.search.placeholder')}
            aria-label={t('communities:drawer.search.label')}
            autoComplete="off"
            autoCapitalize="off"
            spellCheck={false}
            enterKeyHint="search"
            onFocus={() => setSearching(true)}
            onChange={(e) => setQuery(e.target.value)}
          />
        </label>
        {searching ? (
          <button type="button" className="nav-drawer-search-cancel" data-nav-drawer-cancel="" onClick={() => setSearching(false)}>
            {t('communities:drawer.search.cancel')}
          </button>
        ) : null}
      </div>
      <div ref={listRef} className="nav-drawer-outer-list" tabIndex={-1}>
        {body}
      </div>
    </>
  );
}
