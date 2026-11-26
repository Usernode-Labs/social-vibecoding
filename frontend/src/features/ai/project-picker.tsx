/**
 * The Homeroom bot tab's More projects (30 Oct 2026, Evan, option B of four
 * drawn on a canvas): every project in any list, to pick the ones whose work
 * the lists show. 24 Nov 2026 (the three bands): the standard list opens it
 * from its one project filter, "All projects", on the head card's tools line
 * (./lists.tsx `data-ai-project-more`); the look's list from its rail's last
 * chip (./frame-list.tsx).
 *
 *   ( Find a project               )
 *   NEEDS YOU
 *   ☐ [tile] Homeroom              5 need you
 *   IN PROGRESS OR WAITING
 *   ☐ [tile] Run Club           1 in progress
 *   NOTHING OPEN
 *   ☐ [tile] Bird Count      2 live this week
 *   ─────────────────────────────────────────
 *   Show all projects                  Done
 *
 * The order is ./model.ts rankProjects'. A row is a checkbox and a pick
 * applies at once, so the lists change behind the panel as you go; Done
 * only closes. The filter then names what it shows (the project, or how many).
 *
 * From 768px it hangs under the filter, right edges together, sliding
 * right to stay 8px inside the window when it is near the window's left edge,
 * and closes on a press outside it, Escape, Back, or the page scrolling under
 * it (lib/menu.ts).
 * On a phone it is a sheet from the floor, presented by the Sheet
 * (lib/sheet.ts) as the community switcher's is
 * (features/workshop/community-switcher.tsx).
 *
 * Rendered only while open, into document.body: nothing here is in the
 * prerendered shell.
 */
import { useEffect, useRef, useState } from 'react';
import type { ReactNode, RefObject } from 'react';
import { createPortal } from 'react-dom';

import { Button } from '@/components/ui/button';
import { SectionHeader } from '@/components/ui/grouped-list';
import { SearchIcon } from '@/components/ui/icons';

import { useMessages } from '../../lib/i18n/react';
import { useMenu } from '../../lib/menu';
import { useSheet } from '../../lib/sheet';
import type { ProjectTally } from './model';
import { pickerMenuBox } from './picker-box';
import { SmallTile } from './small-tile';

interface PickerProps {
  ranked: ProjectTally[];
  picked: string[];
  onToggle: (slug: string) => void;
  onClear: () => void;
  onClose: () => void;
}

/** What a project has, in words: what asks for you first. */
function useNote(): (p: ProjectTally) => string {
  const t = useMessages('messages');
  return (p) => {
    if (p.needs) return t('messages:ai.filter.note.needs', { count: p.needs });
    if (p.progress) return t('messages:ai.filter.note.progress', { count: p.progress });
    if (p.waiting) return t('messages:ai.filter.note.waiting', { count: p.waiting });
    return t('messages:ai.filter.note.live', { count: p.live });
  };
}

function PickerBody({ ranked, picked, onToggle, onClear, onClose, search }: PickerProps & {
  search: RefObject<HTMLInputElement | null>;
}): ReactNode {
  const t = useMessages('messages');
  const note = useNote();
  const [query, setQuery] = useState('');
  const q = query.trim().toLowerCase();
  const shown = q ? ranked.filter((p) => (p.app.name || p.app.slug).toLowerCase().includes(q)) : ranked;
  const groups = [
    { key: 'needs', head: t('messages:ai.filter.group.needs'), items: shown.filter((p) => p.needs) },
    { key: 'busy', head: t('messages:ai.filter.group.busy'), items: shown.filter((p) => !p.needs && (p.progress || p.waiting)) },
    { key: 'quiet', head: t('messages:ai.filter.group.quiet'), items: shown.filter((p) => !p.needs && !p.progress && !p.waiting) },
  ].filter((g) => g.items.length);
  return (
    <>
      <label className="mx-1 mb-1 mt-0.5 flex h-[38px] shrink-0 items-center gap-2 rounded-xl bg-zinc-900/[0.05] px-3 text-zinc-500 focus-within:shadow-[inset_0_0_0_2px_var(--accent)] dark:bg-white/[0.08] dark:text-zinc-400">
        <SearchIcon className="h-[18px] w-[18px] shrink-0" aria-hidden="true" />
        <input
          ref={search}
          type="search"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder={t('messages:ai.filter.search')}
          aria-label={t('messages:ai.filter.search')}
          className="h-full min-w-0 flex-1 appearance-none border-0 bg-transparent p-0 text-base text-zinc-900 outline-none placeholder:text-zinc-500 dark:text-zinc-100 dark:placeholder:text-zinc-400 [&::-webkit-search-cancel-button]:hidden"
          data-ai-pick-search=""
        />
      </label>
      <div className="min-h-0 flex-1 overflow-y-auto overscroll-contain" data-ai-pick-list="">
        {groups.map((g) => (
          <div key={g.key} role="group" aria-labelledby={`ai-pick-${g.key}`} data-ai-pick-group={g.key}>
            <SectionHeader id={`ai-pick-${g.key}`} className="px-2.5 pb-1 pt-3">{g.head}</SectionHeader>
            {g.items.map((p) => (
              <label key={p.app.slug} className="flex min-h-[44px] cursor-pointer items-center gap-3 rounded-[10px] px-2.5 hover:bg-zinc-900/[0.04] dark:hover:bg-white/[0.06]" data-ai-pick={p.app.slug}>
                <input
                  type="checkbox"
                  className="h-[18px] w-[18px] shrink-0 cursor-pointer accent-zinc-900 dark:accent-zinc-100"
                  checked={picked.includes(p.app.slug)}
                  onChange={() => onToggle(p.app.slug)}
                />
                <SmallTile app={p.app} />
                <span className="min-w-0 flex-1 truncate text-[15px] font-medium text-zinc-900 dark:text-zinc-100">{p.app.name || p.app.slug}</span>
                <span className={p.needs
                  ? 'shrink-0 text-[13px] font-semibold text-violet-700 dark:text-violet-300'
                  : 'shrink-0 text-[13px] text-zinc-500 dark:text-zinc-400'}
                >
                  {note(p)}
                </span>
              </label>
            ))}
          </div>
        ))}
        {!groups.length ? (
          <p className="m-0 px-2.5 py-3 text-sm text-zinc-500 dark:text-zinc-400" data-ai-pick-none="">{t('messages:ai.filter.none', { query: query.trim() })}</p>
        ) : null}
      </div>
      <div className="mt-1 flex shrink-0 items-center justify-between gap-3 border-t border-[color:var(--app-sheet-line)] px-1.5 pt-2">
        <button
          type="button"
          className="min-h-[44px] px-1 text-[13px] font-semibold text-violet-700 hover:text-violet-800 disabled:cursor-default disabled:text-zinc-400 dark:text-violet-300 dark:hover:text-violet-200 dark:disabled:text-zinc-500 md:min-h-[36px]"
          onClick={() => { onClear(); onClose(); }}
          disabled={!picked.length}
          data-ai-pick-all=""
        >
          {t('messages:ai.filter.showAll')}
        </button>
        <Button type="button" size="sm" onClick={onClose} data-ai-pick-done="">{t('messages:ai.filter.done')}</Button>
      </div>
    </>
  );
}

/** From 768px: a menu under the project filter. */
function PickerMenu({ anchor, ...props }: PickerProps & { anchor: DOMRect }): ReactNode {
  const t = useMessages('messages');
  const panel = useRef<HTMLDivElement | null>(null);
  const search = useRef<HTMLInputElement | null>(null);
  // A press outside it, Escape, Back, the page moving under it, and focus:
  // into the search, and back to the filter (lib/menu.ts). The filter toggles
  // it on its own, so a press on it is not outside.
  const { panelProps } = useMenu(true, {
    panel,
    onClose: props.onClose,
    keys: 'panel',
    move: true,
    inside: (target) => !!target.closest('[data-ai-project-more]'),
    initialFocus: () => search.current,
  });
  // Right edges together when there is room; slid right to 8px inside the
  // window when the chip sits near its left edge (#6675, ./picker-box.ts).
  const box = pickerMenuBox(anchor, window.innerWidth);
  const style = { top: `${box.top}px`, left: `${box.left}px` };
  return (
    <div
      ref={panel}
      className="fixed z-[60] flex max-h-[min(70vh,560px)] w-[360px] max-w-[calc(var(--platform-float-w)_-_16px)] flex-col rounded-2xl bg-[color:var(--dc-sheet)] p-1.5 pb-2 text-zinc-900 shadow-[0_0_0_1px_var(--app-sheet-line),0_14px_40px_rgba(0,0,0,0.18)] dark:text-zinc-100"
      role="dialog"
      aria-label={t('messages:ai.filter.label')}
      style={style}
      data-ai-project-picker="menu"
      {...panelProps}
    >
      <PickerBody {...props} search={search} />
    </div>
  );
}

/** Under 768px: a sheet from the floor. */
function PickerSheet(props: PickerProps): ReactNode {
  const t = useMessages('messages');
  const search = useRef<HTMLInputElement | null>(null);
  // The kit's sheet when there is one (lib/sheet.ts). Focus goes to the
  // sheet itself, not the search: a phone's keyboard would come up over the
  // list.
  const { panelRef: panel, adopted, scrimProps } = useSheet({ kind: 'sheet', onClose: props.onClose });
  return (
    <div
      className={adopted ? 'contents' : 'fixed inset-0 z-[60] flex items-end bg-black/30'}
      {...scrimProps}
    >
      <div
        ref={panel}
        tabIndex={-1}
        className="flex max-h-[82dvh] w-full flex-col rounded-t-[22px] bg-[color:var(--dc-sheet)] px-2 pb-[calc(12px_+_var(--platform-safe-bottom,0px))] pt-1.5 text-zinc-900 shadow-[0_-8px_30px_rgba(0,0,0,0.18)] outline-none dark:text-zinc-100"
        role="dialog"
        aria-modal="true"
        aria-labelledby="ai-pick-title"
        data-ai-project-picker="sheet"
      >
        {adopted ? null : <span className="mx-auto mb-2 mt-0.5 h-[5px] w-9 shrink-0 rounded-[3px] bg-zinc-900/15 dark:bg-white/20" aria-hidden="true" />}
        <h2 id="ai-pick-title" className="m-0 px-3 pb-2 text-[17px] font-bold leading-[22px]">{t('messages:ai.filter.label')}</h2>
        <PickerBody {...props} search={search} />
      </div>
    </div>
  );
}

/** More projects, while it is open: a sheet on a phone, a menu under the More chip on a wide window. */
export function ProjectPicker({ sheet, anchor, ...props }: PickerProps & { sheet: boolean; anchor: DOMRect }): ReactNode {
  // A route change closes it: the page it was about has gone.
  const close = useRef(props.onClose);
  close.current = props.onClose;
  useEffect(() => {
    const onRoute = () => close.current();
    window.addEventListener('hashchange', onRoute);
    window.addEventListener('popstate', onRoute);
    return () => {
      window.removeEventListener('hashchange', onRoute);
      window.removeEventListener('popstate', onRoute);
    };
  }, []);
  if (typeof document === 'undefined') return null;
  return createPortal(sheet ? <PickerSheet {...props} /> : <PickerMenu anchor={anchor} {...props} />, document.body);
}
