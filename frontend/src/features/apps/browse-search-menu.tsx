/**
 * The menu under Discover's search field (#6197): Recent searches while the
 * field is empty, Suggestions while it is not. ./browse-screen.tsx holds the
 * open/closed state and the keys; ./browse.js decides what is listed and what
 * a pick does. It is closed in the first render, so nothing here reaches the
 * prerendered shell.
 *
 * Recent searches are two columns of tiles (#5967), each with the icon of the
 * search's best match today, or a search glyph when nothing matches. Two rows
 * show until More; the options stay one listbox, in reading order.
 *
 * NOT INSIDE #browse-search-bar. From 768px the bar wears `clip-path: inset(0)`
 * in app.css, which is what keeps its fixed wallpaper layer to the band, and a
 * clip takes everything inside it, a positioned card included. So the card is
 * a child of #browse-screen, placed under the field by measurement. It is
 * absolute in the screen's scrolling box, and the bar is not pinned, so the
 * two scroll together.
 *
 * Keyboard focus stays in the field the whole time (aria-activedescendant).
 * Pressing inside the card cancels the mousedown, which is what keeps the field
 * from blurring and closing the card under the press; the pick itself is the
 * click, so a finger scrolling the page across a row picks nothing.
 */

import type { MouseEvent, ReactNode } from 'react';

import { PLANE_FILL, SectionHeader } from '@/components/ui/grouped-list';
import { ChevronDownIcon, ChevronUpIcon, DraftTrashIcon, SearchIcon } from '@/components/ui/icons';
import { useMessages } from '../../lib/i18n/react';
import { AppIconContent, appIconKind } from './app-card-view';

export const SEARCH_MENU_LISTBOX_ID = 'browse-search-options';
export const searchOptionId = (index: number): string => `browse-search-option-${index}`;

export type SearchMenuPosition = { top: number; left: number; width: number };
type Suggestion = { slug: string; name: string; app: Record<string, any> };
/** One recent search and the app its thumbnail shows, if any still matches. */
export type RecentTile = { query: string; app: Record<string, any> | null };

/** Two rows of two, before More. */
export const RECENT_FOLDED_TILES = 4;

const keepFieldFocus = (e: MouseEvent) => e.preventDefault();

const HEADING = 'pt-3 pb-1';
const OPTION = 'flex w-full cursor-pointer items-center gap-3 px-4 min-h-[44px] md:min-h-[36px] '
  + 'text-[15px] text-zinc-900 dark:text-zinc-100 hover:bg-zinc-500/10';
const OPTION_ACTIVE = 'bg-zinc-500/10';
const TILE_CLASS = 'flex min-w-0 min-h-[52px] cursor-pointer items-center gap-2.5 rounded-xl p-2 '
  + 'text-[15px] leading-5 text-zinc-900 dark:text-zinc-100 hover:bg-zinc-500/15';
const TILE = `${TILE_CLASS} bg-zinc-500/5`;
const TILE_ACTIVE = `${TILE_CLASS} bg-zinc-500/15`;

function Option({ index, active, label, onPick, resting = OPTION, lit = `${OPTION} ${OPTION_ACTIVE}`, children }: {
  index: number;
  active: boolean;
  label: string;
  onPick: () => void;
  resting?: string;
  lit?: string;
  children: ReactNode;
}): ReactNode {
  return (
    <div
      id={searchOptionId(index)}
      role="option"
      aria-selected={active}
      aria-label={label}
      className={active ? lit : resting}
      onClick={onPick}
    >
      {children}
    </div>
  );
}

export function BrowseSearchMenu({
  position, activeIndex, recent, recentToggle = null, suggestions,
  onPickRecent, onPickSuggestion, onClearRecent, onToggleRecent,
}: {
  position: SearchMenuPosition;
  activeIndex: number;
  /** The tiles showing, while the field is empty; else null. */
  recent: RecentTile[] | null;
  /** What the toggle under the tiles offers; null when they all fit. */
  recentToggle?: 'more' | 'less' | null;
  /** The matching names, while the field holds text; else null. */
  suggestions: Suggestion[] | null;
  onPickRecent: (query: string) => void;
  onPickSuggestion: (suggestion: Suggestion) => void;
  onClearRecent: () => void;
  onToggleRecent?: () => void;
}): ReactNode {
  const t = useMessages('discover');
  return (
    <div
      data-browse-search-menu=""
      className={`absolute z-40 overflow-hidden rounded-[20px] pb-2 ${PLANE_FILL} shadow-[inset_0_0_0_1px_var(--app-sheet-line),0_8px_24px_rgba(0,0,0,0.14)]`}
      style={{ top: position.top, left: position.left, width: position.width }}
      onMouseDown={keepFieldFocus}
    >
      {recent ? (
        <>
          <div className="flex items-center justify-between gap-2 pe-2">
            <SectionHeader className={HEADING}>{t('discover:search.recent.heading')}</SectionHeader>
            <button
              type="button"
              id="browse-search-recent-clear"
              className="mt-1.5 inline-flex h-11 w-11 md:h-8 md:w-8 shrink-0 items-center justify-center rounded-full text-zinc-500 hover:bg-zinc-500/10 hover:text-zinc-900 dark:text-zinc-400 dark:hover:text-zinc-100"
              title={t('discover:search.recent.clearLabel')}
              aria-label={t('discover:search.recent.clearLabel')}
              onClick={onClearRecent}
            >
              <DraftTrashIcon width={18} height={18} aria-hidden="true" />
            </button>
          </div>
          <div
            id={SEARCH_MENU_LISTBOX_ID}
            role="listbox"
            aria-label={t('discover:search.recent.heading')}
            className="grid grid-cols-2 gap-2 px-2"
          >
            {recent.map(({ query, app }, i) => (
              <Option
                key={query}
                index={i}
                active={i === activeIndex}
                label={query}
                onPick={() => onPickRecent(query)}
                resting={TILE}
                lit={TILE_ACTIVE}
              >
                {app ? (
                  <span
                    className="app-icon-tile flex h-9 w-9 shrink-0 items-center justify-center overflow-hidden rounded-lg text-sm font-bold [&>span]:text-xl"
                    data-icon={appIconKind(app)}
                    aria-hidden="true"
                  >
                    <AppIconContent app={app} eager />
                  </span>
                ) : (
                  <span
                    className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg bg-zinc-500/10 text-zinc-500 dark:text-zinc-400"
                    data-recent-no-match=""
                    aria-hidden="true"
                  >
                    <SearchIcon className="h-4 w-4" aria-hidden="true" />
                  </span>
                )}
                <span className="min-w-0 break-words line-clamp-2">{query}</span>
              </Option>
            ))}
          </div>
          {recentToggle ? (
            <div className="flex justify-center pt-1">
              <button
                type="button"
                id="browse-search-recent-more"
                className="inline-flex min-h-[44px] md:min-h-[32px] items-center gap-1 rounded-full px-3 text-[13px] font-medium text-zinc-500 hover:text-zinc-900 dark:text-zinc-400 dark:hover:text-zinc-100"
                aria-expanded={recentToggle === 'less'}
                aria-controls={SEARCH_MENU_LISTBOX_ID}
                onClick={onToggleRecent}
              >
                {recentToggle === 'more' ? t('discover:search.recent.more') : t('discover:search.recent.less')}
                {recentToggle === 'more'
                  ? <ChevronDownIcon className="h-3.5 w-3.5" aria-hidden="true" />
                  : <ChevronUpIcon className="h-3.5 w-3.5" aria-hidden="true" />}
              </button>
            </div>
          ) : null}
        </>
      ) : null}
      {suggestions ? (
        <>
          <SectionHeader className={HEADING}>{t('discover:search.suggest.heading')}</SectionHeader>
          <div id={SEARCH_MENU_LISTBOX_ID} role="listbox" aria-label={t('discover:search.suggest.listLabel')}>
            {suggestions.map((s, i) => (
              <Option key={s.slug} index={i} active={i === activeIndex} label={s.name} onPick={() => onPickSuggestion(s)}>
                {/* The emoji glyph is sized for a row's 44px tile. */}
                <span
                  className="app-icon-tile flex h-7 w-7 shrink-0 items-center justify-center overflow-hidden rounded-lg text-sm font-bold [&>span]:text-base"
                  data-icon={appIconKind(s.app)}
                  aria-hidden="true"
                >
                  <AppIconContent app={s.app} eager />
                </span>
                <span className="min-w-0 truncate">{s.name}</span>
              </Option>
            ))}
          </div>
        </>
      ) : null}
    </div>
  );
}
