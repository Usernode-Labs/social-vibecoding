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
 *
 * ── The cards fold (#1787) ────────────────────────────────────────────
 *
 * A column draws each card as the Workshop's one-line row and unfolds the
 * one you tap into the dense card, in place (./fold.tsx). Which row is open
 * is the COLUMN's state — one per column, so a board with four open cards
 * is still four columns of rows — and it lives in the component, so the
 * WS-driven republishes that repaint the board leave it alone. The open card
 * is the card the column always drew, with the Workshop's "Open card" toggle
 * as the last pill of its action band (the facts-line seat moves the actions
 * up beside it, which a column cannot hold) and the item's own page one link
 * below. `?cards=open` draws every card unfolded: the board as it was, and
 * the state the declared checks that read a card's anatomy run in.
 */

import { useEffect, useRef, useState, type ReactNode } from 'react';

import { useNarrowViewport } from '../../../lib/use-narrow';
import { useStoreState } from '../../../lib/use-store-state';
import { devKanbanStore } from './cards-store';
import { callAppView } from './fold';
import { FooterView } from './footer';
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
      ? 'border-violet-500 text-violet-700 font-semibold dark:text-violet-400'
      : 'border-transparent text-zinc-500 dark:text-zinc-400 hover:text-zinc-700 dark:hover:text-zinc-200');
  const countCls = 'font-mono text-[11px] leading-tight '
    + (active ? 'text-violet-700 dark:text-violet-400' : (col.count ? 'text-zinc-500 dark:text-zinc-500' : 'text-zinc-300 dark:text-zinc-500'));
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

function Column(
  { col, active, loading, deferred, slug, canPost, unfolded }:
  {
    col: KanbanColView; active: boolean; loading: boolean; deferred: boolean;
    slug: string; canPost: boolean; unfolded: boolean;
  },
): ReactNode {
  // The one open card, by row key. Toggling the open one closes it; opening
  // another closes the first. Survives republishes because it is here and
  // not in the view model.
  const [openKey, setOpenKey] = useState<string | null>(null);
  const hostRef = useRef<HTMLDivElement>(null);
  // A merged card's kudos slot is a legacy-filled host (`_fillKudosHosts`,
  // run by app-view.js after every publish). A fold happens BETWEEN
  // publishes, so the slot a card just unfolded with would stay empty until
  // the next repaint; re-run the filler here. It skips filled hosts.
  useEffect(() => {
    if (hostRef.current) callAppView('_fillKudosHosts', hostRef.current);
  }, [openKey, unfolded]);
  let cards: ReactNode;
  // Below 640px this column is `display:none` unless it is the active one
  // (see .dev-kanban-col in app.css), so building its cards is work whose
  // only outcome is being hidden. On a warm board that was three quarters
  // of the render — measured as the largest single item in a phone-shaped
  // profile, ahead of every network wait left in the boot.
  //
  // The column SHELL still renders: same id, same data-kanban-col, same
  // heading, same count — the count comes from col.count, not from
  // rows.length, so a deferred column still reports the right number in
  // both the heading and its tab. Only the rows wait, and they arrive the
  // moment the tab is tapped, because activeTab republishes and this
  // column stops being deferred.
  if (deferred) {
    cards = null;
  } else if (loading) {
    // Two rows, not four: the point is to show the column is filling, and a
    // full-height stack of placeholders in each of four columns is a busier
    // screen than the one it is standing in for.
    cards = <CardSkeleton n={2} label={`Loading ${col.title}`} />;
  } else if (col.empty) {
    cards = <div className="text-xs text-zinc-500 dark:text-zinc-500 italic py-2">{col.empty}</div>;
  } else {
    cards = (
      <div className="space-y-2">
        {col.rows.map((row: ListRow) => (
          <ListRowView
            key={row.key}
            row={row}
            fold={{
              slug,
              canPost,
              open: unfolded || openKey === row.key,
              onToggle: () => setOpenKey((k) => (k === row.key ? null : row.key)),
              // "Open card" rides in the action band here, not on the facts
              // line: a column is too narrow for the actions that seat moves
              // up beside it (fold.tsx).
              detail: 'actions',
            }}
          />
        ))}
      </div>
    );
  }
  return (
    <div
      ref={hostRef}
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
      {(!deferred && col.footer) ? <div className="mt-2"><FooterView f={col.footer} /></div> : null}
    </div>
  );
}

export function DevKanban(): ReactNode {
  const v = useStoreState(devKanbanStore);
  // Wide viewports render every column, exactly as before — including the
  // proposal-checks runner, which asserts in a fixed 1280x800 frame.
  const narrow = useNarrowViewport();
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
          <Column
            key={col.key}
            col={col}
            active={col.key === v.activeTab}
            loading={!!v.loading}
            deferred={narrow && col.key !== v.activeTab}
            slug={v.slug || ''}
            canPost={!!v.canPost}
            unfolded={!!v.unfolded}
          />
        ))}
      </div>
    </>
  );
}
