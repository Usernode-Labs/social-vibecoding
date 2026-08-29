/**
 * `#dev-kanban-board` — the kanban board — as the only React writer below
 * that host. The host stays app-view.js's; the columns, the mobile tab
 * strip and every card render from `devKanbanStore`.
 *
 * ── The retired drag seam (#613) ──────────────────────────────────────
 *
 * Cards once carried a six-dot grip in a 24px left gutter, and
 * `_initKanbanDrag`'s pointer recognizer reordered a column by moving these
 * nodes underneath React. The grip was the gesture's only entry point, and
 * it cost every card that gutter on the narrowest screen there is — so the
 * whole affordance is gone: no handle, no recognizer, no `_dragState`
 * publish guard, no remount-on-drop. What survives is the READ side.
 * `_applyManualOrder` still lays a saved order over the derived one in
 * `_kanbanView`, so a column somebody already arranged keeps its
 * arrangement; nothing in the UI can write a new one.
 *
 * ── Tabs (#814) ───────────────────────────────────────────────────────
 *
 * All four columns are always in the DOM; `dev-kanban-col-active` marks the
 * one the strip shows and CSS acts on it only below 640px. A tab tap calls
 * `AppView._onKanbanTabSelect`, which persists the choice and republishes
 * `activeTab` — replacing `_applyKanbanTab`'s class-toggling DOM pass.
 */

import type { ReactNode } from 'react';

import { useStoreState } from '../../../lib/use-store-state';
import { devKanbanStore } from './cards-store';
import { FooterView } from './dev-feed';
import { ListRowView } from './list-rows';
import type { KanbanColView, ListRow } from './model';
import { CardSkeleton, CountSkeleton } from './skeleton';

function selectTab(key: string): void {
  const av = typeof window !== 'undefined' ? (window as any).AppView : null;
  if (av && typeof av._onKanbanTabSelect === 'function') av._onKanbanTabSelect(key);
}

function Tab({ col, active, loading }: { col: KanbanColView; active: boolean; loading: boolean }): ReactNode {
  const cls = 'dev-kanban-tab flex-1 basis-0 min-w-0 min-h-[44px] px-1 py-1.5 flex flex-col items-center justify-center '
    + 'border-b-2 transition-colors '
    + (active
      ? 'border-zinc-900 text-zinc-900 font-semibold dark:border-zinc-100 dark:text-zinc-100'
      : 'border-transparent text-zinc-500 dark:text-zinc-300 hover:text-zinc-700 dark:hover:text-zinc-200');
  const countCls = 'font-mono text-[11px] leading-tight '
    // The SELECTED tab's count carried a -400 dark step, which sat a tier
    // under the plain grey of the tabs either side of it — this ramp pairs a
    // light 700 with a dark 300.
    //
    // The zero-count half was zinc-300/zinc-400: Lc 16.2 light on the page
    // ground vs 41.1 dark (APCA-W3 0.1.9), so a zero read as absent in light
    // and merely dim in dark. zinc-400/zinc-400 is 46.6/41.1 — still clearly
    // the de-emphasised state, but the same one in both themes.
    + (active ? 'text-azure-700 dark:text-azure-300' : (col.count ? 'text-zinc-500 dark:text-zinc-300' : 'text-zinc-400 dark:text-zinc-400'));
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
      <span className={countCls}>{loading ? <CountSkeleton /> : col.count}</span>
    </button>
  );
}

function Column({ col, active, loading }: { col: KanbanColView; active: boolean; loading: boolean }): ReactNode {
  let cards: ReactNode;
  if (loading) {
    // Two rows, not four: the point is to show the column is filling, and a
    // full-height stack of placeholders in each of four columns is a busier
    // screen than the one it is standing in for.
    cards = <CardSkeleton n={2} label={`Loading ${col.title}`} />;
  } else if (col.empty) {
    cards = <div className="text-xs text-zinc-500 dark:text-zinc-300 italic py-2">{col.empty}</div>;
  } else {
    cards = (
      <div className="space-y-2">
        {col.rows.map((row: ListRow) => <ListRowView key={row.key} row={row} />)}
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
        className="dev-kanban-col-head text-[0.9375rem] font-semibold text-zinc-500 dark:text-zinc-300 mb-2 px-0.5"
        title={col.hint || undefined}
      >
        {`${col.title} `}
        {loading
          ? <span className="text-zinc-500 dark:text-zinc-300 font-mono">{'· '}<CountSkeleton /></span>
          : <span className="text-zinc-500 dark:text-zinc-300 font-mono">{`· ${col.count}`}</span>}
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
        {v.cols.map((col) => (
          <Tab key={col.key} col={col} active={col.key === v.activeTab} loading={!!v.loading} />
        ))}
      </div>
      <div id="dev-kanban" className="flex gap-3 overflow-x-auto pb-2" data-kanban-active={v.activeTab}>
        {v.cols.map((col) => (
          <Column key={col.key} col={col} active={col.key === v.activeTab} loading={!!v.loading} />
        ))}
      </div>
    </>
  );
}
