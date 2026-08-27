/**
 * `#dev-kanban-board` — the kanban board — as the only React writer below
 * that host. The host stays app-view.js's; the columns and every card
 * render from `devKanbanStore`.
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
 * ── Tabs (#814, re-cut) ───────────────────────────────────────────────
 *
 * THE STRIP IS NOT HERE ANY MORE. It is a row of the frame above this host
 * (../board-tabs.tsx), because `All` renders the STREAM on a narrow
 * viewport and a control living inside `#dev-body` would be destroyed by
 * the repaint it asked for.
 *
 * What stays is the half this file was always about: all four columns are
 * in the DOM whatever the tab says, `dev-kanban-col-active` marks the one
 * to draw, and CSS reads `#dev-kanban[data-kanban-active]` to decide
 * whether that marker means anything — `all` draws every column, any other
 * value draws that one, at every width.
 */

import type { ReactNode } from 'react';

import { useStoreState } from '../../../lib/use-store-state';
import { devKanbanStore } from './cards-store';
import { FooterView } from './dev-feed';
import { ListRowView } from './list-rows';
import type { KanbanColView, ListRow } from './model';
import { CardSkeleton, CountSkeleton } from './skeleton';

function Column({ col, active, loading }: { col: KanbanColView; active: boolean; loading: boolean }): ReactNode {
  let cards: ReactNode;
  if (loading) {
    // Two rows, not four: the point is to show the column is filling, and a
    // full-height stack of placeholders in each of four columns is a busier
    // screen than the one it is standing in for.
    cards = <CardSkeleton n={2} label={`Loading ${col.title}`} />;
  } else if (col.empty) {
    cards = <div className="text-xs text-zinc-500 dark:text-zinc-500 italic py-2">{col.empty}</div>;
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
        className="dev-kanban-col-head text-[0.9375rem] font-semibold text-zinc-500 dark:text-zinc-400 mb-2 px-0.5"
        title={col.hint || undefined}
      >
        {`${col.title} `}
        {loading
          ? <span className="text-zinc-500 dark:text-zinc-500 font-mono">{'· '}<CountSkeleton /></span>
          : <span className="text-zinc-500 dark:text-zinc-500 font-mono">{`· ${col.count}`}</span>}
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
    <div id="dev-kanban" className="flex gap-3 overflow-x-auto pb-2" data-kanban-active={v.activeTab}>
      {v.cols.map((col) => (
        <Column key={col.key} col={col} active={col.key === v.activeTab} loading={!!v.loading} />
      ))}
    </div>
  );
}
