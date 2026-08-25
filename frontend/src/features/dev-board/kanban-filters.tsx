/**
 * `#dev-kanban-filterbar` — the kanban board's filter strip — as the only
 * React writer below that host.
 *
 * ── One pill, five times ──────────────────────────────────────────────
 *
 * Every control here is the SAME Material filter chip: 32px tall, fully
 * rounded, hairline outline, compact label, in the two states it actually has
 * — unselected is an outlined transparent pill, selected is a filled tonal one
 * that KEEPS the outline so the row's rhythm does not shift by a pixel when
 * you toggle it. The class strings below are the ones `_kanbanNeedsVoteChipCls`
 * used to write onto the chip by hand; that builder and its three constants
 * are retired from app-view.js and this is where they live now.
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
 * `key` the module bumps on Clear preserves exactly that: every repaint
 * reconciles the same node, and only Clear replaces it. See
 * ./kanban-filters-store.ts.
 *
 * ── What stays in app-view.js ─────────────────────────────────────────
 *
 * The filters themselves (`_kanbanFilters`, persisted per app in
 * sessionStorage), the 150ms debounce on typing, which cards each filter
 * keeps, both option lists and the rule that a selected option is never
 * dropped from its list, and the repaint every control triggers.
 */

import {
  kanbanFiltersStore,
  type FilterOption,
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
// `appearance-none` and the explicit right padding are what stop the native
// arrow from breaking the pill's shape; the caret is drawn as a background
// image in app.css off `.dev-chip-select`.
const selectCls = (active: boolean) =>
  `${CHIP_BASE} dev-chip-select pl-3 pr-7 ${active ? CHIP_ON : CHIP_IDLE}`;

const SEARCH_CLS = 'h-8 rounded-full border border-zinc-300 dark:border-zinc-700 '
  + 'bg-white dark:bg-zinc-800 px-3 text-xs text-zinc-900 dark:text-zinc-100 '
  + 'flex-1 min-w-[10rem]';

function FilterSelect({
  id, label, value, options, onPick,
}: {
  id: string;
  label: string;
  value: string;
  options: FilterOption[];
  onPick: (value: string) => void;
}) {
  return (
    <select
      id={id}
      className={selectCls(!!value)}
      aria-label={label}
      value={value}
      onChange={(e) => onPick(e.target.value)}
    >
      {options.map((option) => (
        <option key={option.value} value={option.value}>{option.label}</option>
      ))}
    </select>
  );
}

export function KanbanFiltersView({
  mounted, q, priority, category, assignee, needsVote, active, categories, assignees, seq,
}: KanbanFiltersState) {
  if (!mounted) return null;
  const pick = (field: string) => (value: string) => controller()?._setKanbanFilter?.(field, value);
  return (
    <div id="dev-filter-row" className="flex flex-wrap items-center gap-2">
      <input
        key={`q${seq}`}
        id="dev-kanban-search"
        type="search"
        placeholder="Filter by title, author or #number"
        defaultValue={q}
        aria-label="Filter cards"
        className={SEARCH_CLS}
        onChange={() => controller()?._onKanbanSearchInput?.()}
      />
      <FilterSelect
        id="dev-kanban-priority"
        label="Filter by priority"
        value={priority}
        options={[
          { value: '', label: 'Any priority' },
          { value: 'high', label: 'High' },
          { value: 'medium', label: 'Medium' },
          { value: 'low', label: 'Low' },
        ]}
        onPick={pick('priority')}
      />
      <FilterSelect
        id="dev-kanban-category"
        label="Filter by category"
        value={category}
        options={categories}
        onPick={pick('category')}
      />
      <FilterSelect
        id="dev-kanban-assignee"
        label="Filter by assignee or author"
        value={assignee}
        options={assignees}
        onPick={pick('assignee')}
      />
      <button
        id="dev-kanban-needsvote"
        type="button"
        aria-pressed={needsVote}
        className={chipCls(needsVote)}
        title="Show only proposals you haven't voted on"
        onClick={() => controller()?._toggleKanbanNeedsVote?.()}
      >
        Needs my vote
      </button>
      <button
        id="dev-kanban-clear"
        type="button"
        className={`text-xs text-violet-700 hover:underline shrink-0${active ? '' : ' hidden'}`}
        onClick={() => controller()?._clearKanbanFilters?.()}
      >
        Clear
      </button>
    </div>
  );
}

export function KanbanFilters() {
  return <KanbanFiltersView {...useStoreState<KanbanFiltersState>(kanbanFiltersStore)} />;
}
