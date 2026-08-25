/**
 * `#dev-kanban-board` — the kanban board — as the only React writer below
 * that host. The host stays app-view.js's; the columns, the mobile tab
 * strip and every card render from `devKanbanStore`.
 *
 * ── The drag seam (#613) ──────────────────────────────────────────────
 *
 * `_initKanbanDrag`'s pointer recognizer MOVES these nodes during a drag
 * (insertBefore straight into `.dev-drag-list`), which React cannot know
 * about. Three things keep that sound, mirroring the home widget strip:
 *
 * 1. `_dragState` blocks every publish for the life of the gesture (the
 *    same guard that blocked innerHTML repaints).
 * 2. On drop, `_commitBoardOrder` REMOUNTS the board portal rather than
 *    republishing into it — React would reconcile keyed children over DOM
 *    the recognizer already rearranged, and children it deems stationary
 *    get no DOM operation, leaving them wherever the drag put them. A
 *    remount rebuilds the column exactly as the old innerHTML did.
 * 3. The drag handle and item shells render here with the exact classes
 *    the recognizer selects on (`.dev-drag-handle`, `.dev-drag-item`,
 *    `data-order-key`), and the recognizer's own mid-gesture writes
 *    (`opacity-50`, `cursor-grabbing`) touch classes React never renders.
 *
 * ── Tabs (#814) ───────────────────────────────────────────────────────
 *
 * All four columns are always in the DOM; `dev-kanban-col-active` marks the
 * one the strip shows and CSS acts on it only below 640px. A tab tap calls
 * `AppView._onKanbanTabSelect`, which persists the choice and republishes
 * `activeTab` — replacing `_applyKanbanTab`'s class-toggling DOM pass.
 */

import type { ReactNode } from 'react';

import { GripDotsIcon } from '@/components/ui/icons';

import { useStoreState } from '../../../lib/use-store-state';
import { devKanbanStore } from './cards-store';
import { FooterView } from './dev-feed';
import { ListRowView } from './list-rows';
import type { KanbanColView, ListRow } from './model';

function selectTab(key: string): void {
  const av = typeof window !== 'undefined' ? (window as any).AppView : null;
  if (av && typeof av._onKanbanTabSelect === 'function') av._onKanbanTabSelect(key);
}

function Tab({ col, active }: { col: KanbanColView; active: boolean }): ReactNode {
  const cls = 'dev-kanban-tab flex-1 basis-0 min-w-0 min-h-[44px] px-1 py-1.5 flex flex-col items-center justify-center '
    + 'border-b-2 transition-colors '
    + (active
      ? 'border-violet-500 text-violet-500 font-semibold'
      : 'border-transparent text-zinc-500 dark:text-zinc-400 hover:text-zinc-700 dark:hover:text-zinc-200');
  const countCls = 'font-mono text-[11px] leading-tight '
    + (active ? 'text-violet-400' : (col.count ? 'text-zinc-400 dark:text-zinc-500' : 'text-zinc-300 dark:text-zinc-500'));
  return (
    <button
      type="button"
      role="tab"
      id={`dev-kanban-tab-${col.key}`}
      data-kanban-tab={col.key}
      aria-selected={active}
      aria-controls={`dev-kanban-col-${col.key}`}
      className={cls}
      onClick={() => selectTab(col.key)}
    >
      <span className="text-xs leading-tight truncate max-w-full">{col.title}</span>
      <span className={countCls}>{col.count}</span>
    </button>
  );
}

/** `_wrapDraggable`'s shell. No orderKey (read-only viewers) → no handle. */
function DragItem({ orderKey, children }: { orderKey?: string | null; children: ReactNode }): ReactNode {
  if (!orderKey) return <div className="dev-drag-item">{children}</div>;
  return (
    <div className="dev-drag-item relative pl-6" data-order-key={orderKey}>
      <button
        type="button"
        className="dev-drag-handle absolute left-0 top-0 bottom-0 w-6 flex items-center justify-center text-zinc-300 dark:text-zinc-500 hover:text-zinc-500 dark:hover:text-zinc-400 cursor-grab touch-none"
        aria-label="Drag to reorder"
        title="Drag to reorder"
      >
        <GripDotsIcon className="w-4 h-4" aria-hidden="true" />
      </button>
      {children}
    </div>
  );
}

function Column({ col, active }: { col: KanbanColView; active: boolean }): ReactNode {
  let cards: ReactNode;
  if (col.empty) {
    cards = <div className="text-xs text-zinc-400 dark:text-zinc-500 italic py-2">{col.empty}</div>;
  } else if (col.orderCol) {
    cards = (
      <div className="space-y-2 dev-drag-list" data-order-col={col.orderCol}>
        {col.rows.map((row: ListRow) => (
          <DragItem key={row.key} orderKey={row.t === 'card' ? row.orderKey : null}>
            <ListRowView row={row} />
          </DragItem>
        ))}
      </div>
    );
  } else {
    cards = (
      <div className="space-y-2">
        {col.rows.map((row) => <ListRowView key={row.key} row={row} />)}
      </div>
    );
  }
  return (
    <div
      id={`dev-kanban-col-${col.key}`}
      data-kanban-col={col.key}
      className={`dev-kanban-col${active ? ' dev-kanban-col-active' : ''}`}
    >
      <div
        className="dev-kanban-col-head text-[0.9375rem] font-semibold text-zinc-500 dark:text-zinc-400 mb-2 px-0.5"
        title={col.hint || undefined}
      >
        {`${col.title} `}
        <span className="text-zinc-400 dark:text-zinc-500 font-mono">{`· ${col.count}`}</span>
      </div>
      {cards}
      {col.footer ? <div className="mt-2"><FooterView f={col.footer} /></div> : null}
    </div>
  );
}

export function DevKanban(): ReactNode {
  const v = useStoreState(devKanbanStore);
  if (!v.cols.length) return null;
  return (
    <>
      <div
        id="dev-kanban-tabs"
        role="tablist"
        aria-label="Board columns"
        className="sm:hidden flex items-stretch gap-1 mb-2 border-b border-zinc-200 dark:border-zinc-800"
      >
        {v.cols.map((col) => <Tab key={col.key} col={col} active={col.key === v.activeTab} />)}
      </div>
      <div id="dev-kanban" className="flex gap-3 overflow-x-auto pb-2" data-kanban-active={v.activeTab}>
        {v.cols.map((col) => <Column key={col.key} col={col} active={col.key === v.activeTab} />)}
      </div>
    </>
  );
}
