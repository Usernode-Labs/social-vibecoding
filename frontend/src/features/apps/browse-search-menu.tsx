/**
 * The menu under Discover's search field (#6197): Recent searches while the
 * field is empty, Suggestions while it is not. ./browse-screen.tsx holds the
 * open/closed state and the keys; ./browse.js decides what is listed and what
 * a pick does. It is closed in the first render, so nothing here reaches the
 * prerendered shell.
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
import { useMessages } from '../../lib/i18n/react';
import { AppIconContent, appIconKind } from './app-card-view';

export const SEARCH_MENU_LISTBOX_ID = 'browse-search-options';
export const searchOptionId = (index: number): string => `browse-search-option-${index}`;

export type SearchMenuPosition = { top: number; left: number; width: number };
type Suggestion = { slug: string; name: string; app: Record<string, any> };

const keepFieldFocus = (e: MouseEvent) => e.preventDefault();

const HEADING = 'pt-3 pb-1';
const OPTION = 'flex w-full cursor-pointer items-center gap-3 px-4 min-h-[44px] md:min-h-[36px] '
  + 'text-[15px] text-zinc-900 dark:text-zinc-100 hover:bg-zinc-500/10';
const OPTION_ACTIVE = 'bg-zinc-500/10';

function Option({ index, active, label, onPick, children }: {
  index: number;
  active: boolean;
  label: string;
  onPick: () => void;
  children: ReactNode;
}): ReactNode {
  return (
    <div
      id={searchOptionId(index)}
      role="option"
      aria-selected={active}
      aria-label={label}
      className={active ? `${OPTION} ${OPTION_ACTIVE}` : OPTION}
      onClick={onPick}
    >
      {children}
    </div>
  );
}

export function BrowseSearchMenu({
  position, activeIndex, recent, suggestions, onPickRecent, onPickSuggestion, onClearRecent,
}: {
  position: SearchMenuPosition;
  activeIndex: number;
  /** The last searches, while the field is empty; else null. */
  recent: string[] | null;
  /** The matching names, while the field holds text; else null. */
  suggestions: Suggestion[] | null;
  onPickRecent: (query: string) => void;
  onPickSuggestion: (suggestion: Suggestion) => void;
  onClearRecent: () => void;
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
              className="mt-1.5 inline-flex min-h-[44px] md:min-h-[28px] shrink-0 items-center rounded-full px-2.5 text-[13px] font-medium text-zinc-500 hover:text-zinc-900 dark:text-zinc-400 dark:hover:text-zinc-100"
              aria-label={t('discover:search.recent.clearLabel')}
              onClick={onClearRecent}
            >
              {t('discover:search.recent.clear')}
            </button>
          </div>
          <div id={SEARCH_MENU_LISTBOX_ID} role="listbox" aria-label={t('discover:search.recent.heading')}>
            {recent.map((q, i) => (
              <Option key={q} index={i} active={i === activeIndex} label={q} onPick={() => onPickRecent(q)}>
                <span className="min-w-0 truncate">{q}</span>
              </Option>
            ))}
          </div>
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
