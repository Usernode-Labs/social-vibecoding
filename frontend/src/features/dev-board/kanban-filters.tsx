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

import { useLayoutEffect, useRef, useState } from 'react';

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

/**
 * #1935: the two one-tap filters for the viewer's own board. They are the
 * same chip as everything else in the strip, as TOGGLES — selected while on,
 * with aria-pressed saying so — rather than options buried in the dialog,
 * because "what is mine" is the filter people reach for most.
 */
const QUICK_FILTERS: Array<{ key: 'assignedToMe' | 'createdByMe'; label: string }> = [
  { key: 'assignedToMe', label: 'Assigned to you' },
  { key: 'createdByMe', label: 'Created by you' },
];

/**
 * `gap-2` and `min-w-[10rem]`, as numbers.
 *
 * The measurement below has to reason about the row's one-line requirement,
 * and the search field's contribution to that is its MINIMUM rather than the
 * width it happens to have: it is `flex-1`, so it swallows whatever slack is
 * going and its current width says nothing about whether the row fits. Both
 * are the literals in the class strings above; a mismatch here would move the
 * two chips a few pixels early or late, which is why they sit next to each
 * other rather than being read back out of the computed style on every frame.
 */
const ROW_GAP_PX = 8;
const SEARCH_MIN_PX = 160;

/**
 * Do the two quick filters fit on the strip's one line?
 *
 * ── Why this is measured and not a media query ────────────────────────
 *
 * The row holds a search field, a `Filters (n)` chip, these two, and one
 * dismissable chip per active filter. Whether they fit is therefore a
 * question about its CONTENTS at a width, not about the width: three active
 * filters at 1000px overflow where none does at 700. A breakpoint would hide
 * the pair on a wide window with a clean row and keep them on a narrow one
 * with four chips, which is the wrong answer in both directions.
 *
 * ── Why it cannot oscillate ───────────────────────────────────────────
 *
 * The naive test — "did the row wrap?" — feeds back into itself: hiding the
 * chips un-wraps the row, which says they fit, which shows them again. So
 * this measures the FULL one-line requirement every time, including the two
 * chips whether or not they are currently rendered. Their widths are cached
 * the first time they are (their labels are constants, so one measurement is
 * the truth), and the comparison is against a number that does not move when
 * the answer changes.
 *
 * The strip starts by rendering them, so the first pass always populates that
 * cache. It runs in a LAYOUT effect, so the correction lands before the
 * browser paints rather than as a visible flicker on a narrow window.
 */
function useQuickFiltersFit(
  rowRef: React.RefObject<HTMLDivElement | null>,
  quickShown: boolean,
): boolean {
  const [fits, setFits] = useState(true);
  // The pair's own width plus the gap each one needs. Null until they have
  // been on screen once.
  const pairRef = useRef<number | null>(null);
  // Read inside `measure`, which is created once, so the current answer
  // reaches it without making the observer depend on it.
  const shownRef = useRef(quickShown);
  shownRef.current = quickShown;
  const measureRef = useRef<(() => void) | null>(null);

  // ONE OBSERVER for the component's life, not one per render. The board
  // republishes this strip on every repaint, and tearing a ResizeObserver
  // down and building another each time is work for nothing — the row's own
  // size changes are what it is watching, and those it sees either way.
  useLayoutEffect(() => {
    const row = rowRef.current;
    if (!row) return undefined;

    const measure = () => {
      const quickShownNow = shownRef.current;
      // The laid-out boxes, which are NOT `row.children`:
      // `#dev-kanban-active-chips` is `display: contents`, so its chips are
      // the row's own flex items and the span itself has no box.
      const boxes: HTMLElement[] = [];
      for (const child of Array.from(row.children) as HTMLElement[]) {
        if (child.id === 'dev-kanban-active-chips') {
          boxes.push(...(Array.from(child.children) as HTMLElement[]));
        } else {
          boxes.push(child);
        }
      }
      if (!boxes.length) return;

      let needed = 0;
      let pair = 0;
      for (const box of boxes) {
        const own = box.id === 'dev-kanban-search' ? SEARCH_MIN_PX : box.offsetWidth;
        needed += own;
        if (box.dataset.quickFilter) pair += own + ROW_GAP_PX;
      }
      needed += ROW_GAP_PX * (boxes.length - 1);

      if (quickShownNow && pair) pairRef.current = pair;
      // Not on screen: add back what they would cost, so the number being
      // compared is the same one either way. With no cache yet there is
      // nothing to move, so the row is reported as fitting.
      if (!quickShownNow) needed += pairRef.current ?? 0;

      const avail = row.clientWidth;
      if (avail > 0) setFits(needed <= avail);
    };

    measureRef.current = measure;
    measure();
    if (typeof ResizeObserver === 'undefined') return () => { measureRef.current = null; };
    const ro = new ResizeObserver(measure);
    ro.observe(row);
    return () => { ro.disconnect(); measureRef.current = null; };
  }, [rowRef]);

  // The row's CONTENTS change without its size changing — a filter chip
  // arrives, the search text is cleared — and the observer above sees none of
  // that. Re-measuring on every render is cheap (a handful of `offsetWidth`
  // reads inside a layout effect that has already forced layout) and is the
  // only thing that keeps the answer current when the row grows by a chip.
  useLayoutEffect(() => { measureRef.current?.(); });

  return fits;
}

export function KanbanFiltersView({
  mounted, q, count, chips, seq, quick,
}: KanbanFiltersState) {
  const rowRef = useRef<HTMLDivElement | null>(null);
  const fits = useQuickFiltersFit(rowRef, !!quick);
  // The decision is the board's, not this component's: the dialog's payload,
  // the `Filters (n)` count and the chip row all turn on it, and all three are
  // built in app-view.js. Reported from a layout effect so the publish it
  // triggers lands in the same frame.
  useLayoutEffect(() => {
    if (!mounted) return;
    controller()?._setQuickFiltersInDialog?.(!fits);
  }, [fits, mounted]);
  if (!mounted) return null;
  return (
    <div id="dev-filter-row" ref={rowRef} className="flex flex-wrap items-center gap-2">
      <input
        key={`q${seq}`}
        id="dev-kanban-search"
        type="search"
        placeholder="Search cards, comments, or #"
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
      {quick ? QUICK_FILTERS.map(({ key, label }) => (
        <button
          key={key}
          type="button"
          data-quick-filter={key}
          aria-pressed={quick[key] ? 'true' : 'false'}
          className={chipCls(quick[key])}
          onClick={() => controller()?._toggleKanbanQuickFilter?.(key)}
        >
          {label}
        </button>
      )) : null}
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
