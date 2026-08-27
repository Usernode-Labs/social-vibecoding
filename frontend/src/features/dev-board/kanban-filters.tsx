/**
 * `#dev-kanban-filterbar` — the kanban board's filter strip — as the only
 * React writer below that host.
 *
 * Streamlined Concept: the strip is search + a `Filters (n)` chip that opens
 * the Filters dialog (features/dialogs/board-filters.tsx) + one dismissable
 * chip per active filter. The selects and the needs-vote toggle that used to
 * stand here live in that dialog now.
 *
 * ── One pill, every time ──────────────────────────────────────────────
 *
 * Every control here is the SAME Material filter chip: 32px tall, fully
 * rounded, hairline outline, compact label, in the two states it actually has
 * — unselected is an outlined transparent pill, selected is a filled tonal one
 * that KEEPS the outline so the row's rhythm does not shift by a pixel when
 * you toggle it. The `Filters (n)` chip wears the selected state while any
 * dialog-owned filter is set; an active-filter chip always wears it.
 *
 * The search field is the one control that is not a chip: it takes typing, so
 * it keeps a real field's affordance. It wears the chip's height and radius so
 * the row still reads as one strip.
 *
 * ── The search box is uncontrolled, on purpose ────────────────────────
 *
 * An ordinary board repaint must not disturb what someone is typing or where
 * their caret sits — that is why the bar's node used to be left untouched
 * while `#dev-kanban-board` was rewritten around it. `defaultValue` plus a
 * `key` the module bumps when the Search chip is dismissed preserves exactly
 * that: every repaint reconciles the same node, and only the dismissal
 * replaces it. See ./kanban-filters-store.ts.
 *
 * ── What stays in app-view.js ─────────────────────────────────────────
 *
 * The filters themselves (`_kanbanFilters`, persisted per app in
 * sessionStorage), the 150ms debounce on typing, which cards each filter
 * keeps, the chip-row data and the `Filters (n)` count, the dialog's open()
 * payload (vocabularies included), and the repaint every control triggers.
 */

import {
  kanbanFiltersStore,
  type KanbanFiltersState,
} from './kanban-filters-store';
import { useStoreState } from '../../lib/use-store-state';

function controller(): any {
  return (typeof window !== 'undefined' ? (window as any).AppView : null) || null;
}

/**
 * The chip's three class runs, as literals.
 *
 * Deliberately NOT imported from app-view.js — that file is a classic script
 * this bundle cannot import, and Tailwind's extractor is a regex over source
 * text, so a class name that only exists over there would compile to nothing
 * from here. That is also why the app-view.js copies were deleted rather than
 * left in place as the source of truth: two ends to keep identical, only one
 * of which Tailwind can see.
 */
const CHIP_BASE = 'h-8 rounded-full border border-transparent text-xs transition-colors shrink-0 '
  + 'inline-flex items-center gap-1';
const CHIP_IDLE = 'bg-white dark:bg-zinc-900 '
  + 'text-zinc-900 dark:text-zinc-100 hover:bg-zinc-50 dark:hover:bg-zinc-800';
const CHIP_ON = 'bg-zinc-900 text-white dark:bg-zinc-100 dark:text-zinc-900';

const chipCls = (active: boolean) => `${CHIP_BASE} px-3 ${active ? CHIP_ON : CHIP_IDLE}`;

const SEARCH_CLS = 'h-8 rounded-full border border-zinc-300 dark:border-zinc-700 '
  + 'bg-white dark:bg-zinc-800 px-3 text-xs text-zinc-900 dark:text-zinc-100 '
  + 'flex-1 min-w-[10rem]';

export function KanbanFiltersView({
  mounted, q, count, chips, seq,
}: KanbanFiltersState) {
  if (!mounted) return null;
  return (
    <div id="dev-filter-row" className="flex flex-wrap items-center gap-2">
      <input
        key={`q${seq}`}
        id="dev-kanban-search"
        type="search"
        placeholder="Search title, author, or #"
        defaultValue={q}
        aria-label="Filter cards"
        className={SEARCH_CLS}
        onChange={() => controller()?._onKanbanSearchInput?.()}
      />
      <button
        id="dev-kanban-filters-btn"
        type="button"
        aria-haspopup="dialog"
        className={chipCls(count > 0)}
        title="Filter the board"
        onClick={() => controller()?._openKanbanFiltersDialog?.()}
      >
        {count > 0 ? `Filters (${count})` : 'Filters'}
      </button>
      <span id="dev-kanban-active-chips" className="contents">
        {chips.map((chip) => (
          <button
            key={chip.key}
            type="button"
            data-filter-chip={chip.key}
            className={chipCls(true)}
            aria-label={`Remove filter: ${chip.label}`}
            onClick={() => controller()?._dismissKanbanFilter?.(chip.key)}
          >
            {chip.label}
            <span aria-hidden="true">×</span>
          </button>
        ))}
      </span>
    </div>
  );
}

export function KanbanFilters() {
  return <KanbanFiltersView {...useStoreState<KanbanFiltersState>(kanbanFiltersStore)} />;
}
