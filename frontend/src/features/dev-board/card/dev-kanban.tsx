/**
 * `#dev-kanban-board` — the kanban board — as the only React writer below
 * that host. The host stays app-view.js's; the columns, the stage strip and
 * every row render from `devKanbanStore`.
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
 * ── The pipeline (#4486) ──────────────────────────────────────────────
 *
 * The column heads and the phone's tab strip are ONE `StageStrip`: the steps
 * an idea goes through, Requests › Underway › Waiting for approval › Done,
 * each with its icon and its count. On a wide window they sit over their
 * columns, on the same grid; below 640px they are the tabs, one column at a
 * time, through the same `selectTab` (`AppView._onKanbanTabSelect`, which
 * persists the choice and republishes `activeTab`). The Workshop draws the
 * strip in All items' pinned head (../workshop/workshop.tsx), so the column
 * names stay on screen down a long column; it keeps the strip's sideways
 * scroll in step with the board's (`syncStrip`), since the two are siblings
 * and not one scroller: a sideways scroller around both would also be the
 * box the head pinned to, and it would stop pinning.
 *
 * All four columns are always in the DOM; `dev-kanban-col-active` marks the
 * one the strip shows and CSS acts on it only below 640px.
 *
 * ── A column is one card of rows (#4486) ──────────────────────────────
 *
 * Each column draws the Workshop's row (../workshop/work-row.tsx, variant
 * `board`): the line in words, the coloured category, the 💬 count, the
 * tags, the card's own bar with Vote and its ☰ menu. A tap on a row opens
 * the item's page, beside the board on a wide window (the Workshop's
 * `onOpen`) and as the page on a phone; nothing unfolds in place any more.
 * Waiting for approval keeps its Newest / Vote priority order, at the top of
 * its card, and Done says what is live at the top of its own.
 *
 * `?cards=open` still draws every card unfolded, as the board was before its
 * columns folded (#1787): the state the declared checks that read a card's
 * anatomy run in. That is the fold's open sheet (./fold.tsx), unchanged.
 */

import { useLayoutEffect, useRef, type MouseEvent, type ReactNode } from 'react';

import {
  ArrowUpIcon, BallotIcon, ChatBubbleTailIcon, CheckIcon, ChevronRightIcon, PencilSquareIcon,
} from '@/components/ui/icons';

import { useNarrowViewport } from '../../../lib/use-narrow';
import { useStoreState } from '../../../lib/use-store-state';
import { WorkList, type CardRow, type TopicRef } from '../workshop/work-row';
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

/** Each step's glyph: the Workshop tab's tiles for the same kinds of item. */
const STEP_ICON: Record<string, typeof CheckIcon> = {
  issues: ChatBubbleTailIcon,
  inprogress: PencilSquareIcon,
  inreview: BallotIcon,
  done: CheckIcon,
};

/** "2,760": a count as the strip says it. */
function countWords(n: number): string {
  return Number.isFinite(n) ? n.toLocaleString('en-US') : String(n);
}

/**
 * Keep the strip's sideways scroll on the board's. The strip pins in the
 * head while the board scrolls under it, so they cannot share one scroller
 * (see the header); the board is the one a reader scrolls, and the strip
 * follows it. Below 640px the board shows one column and never scrolls
 * sideways, and the strip is a row of tabs that scrolls on its own.
 */
export function syncStrip(board: HTMLElement | null): void {
  if (!board || typeof document === 'undefined') return;
  const strip = document.getElementById('dev-kanban-tabs');
  if (strip && strip.scrollLeft !== board.scrollLeft) strip.scrollLeft = board.scrollLeft;
}

/*
 * One step: the stage's icon, its name and its count, and the arrow to the
 * next. A real `role="tab"` with `aria-selected` and `aria-controls` naming
 * its column, as the phone's tabs always were: below 640px it IS the tab,
 * and on a wide window it is the heading over its column, the tab it would
 * be on a phone still marked. dapp.json's `#dev-kanban-tabs
 * [data-kanban-tab="…"]` checks and the suites here read these attributes.
 */
function Step({ col, active, loading, last }: { col: KanbanColView; active: boolean; loading: boolean; last: boolean }): ReactNode {
  const Icon = STEP_ICON[col.key] || PencilSquareIcon;
  return (
    <button
      type="button"
      role="tab"
      id={`dev-kanban-tab-${col.key}`}
      data-kanban-tab={col.key}
      aria-selected={active}
      aria-controls={`dev-kanban-col-${col.key}`}
      className="dev-kanban-step"
      title={col.hint || undefined}
      onClick={() => selectTab(col.key)}
    >
      <span className="dev-kanban-step-tile" data-kind={col.key} aria-hidden="true"><Icon aria-hidden="true" /></span>
      <span className="dev-kanban-step-name">{col.title}</span>
      <span className="dev-kanban-step-n">{loading ? <CountSkeleton /> : countWords(col.count)}</span>
      {last ? null : <ChevronRightIcon className="dev-kanban-step-arrow" aria-hidden="true" />}
    </button>
  );
}

/**
 * The pipeline: the four column heads as steps, joined by arrows (#4486).
 * Its own export because the Workshop draws it in All items' pinned head,
 * above the board's columns, from the same store.
 */
export function StageStrip(): ReactNode {
  const v = useStoreState(devKanbanStore);
  const narrow = useNarrowViewport();
  const ref = useRef<HTMLDivElement>(null);
  // On a phone the strip is a row of tabs that scrolls sideways: keep the
  // one that is up in view (a `?col=done` link opens on the last). On a wide
  // window it follows the board's own sideways scroll instead.
  useLayoutEffect(() => {
    const strip = ref.current;
    if (!strip) return;
    if (!narrow) { syncStrip(document.getElementById('dev-kanban')); return; }
    const tab = strip.querySelector<HTMLElement>('[aria-selected="true"]');
    if (!tab) return;
    const left = tab.offsetLeft - strip.offsetLeft;
    if (left < strip.scrollLeft) strip.scrollLeft = left;
    else if (left + tab.offsetWidth > strip.scrollLeft + strip.clientWidth) strip.scrollLeft = left + tab.offsetWidth - strip.clientWidth;
  }, [narrow, v.activeTab, v.cols.length]);
  if (!v.cols.length) return null;
  return (
    <div ref={ref} id="dev-kanban-tabs" role="tablist" aria-label="Board columns" className="dev-kanban-stages">
      {v.cols.map((col, i) => (
        <Step key={col.key} col={col} active={col.key === v.activeTab} loading={!!v.loading} last={i === v.cols.length - 1} />
      ))}
    </div>
  );
}

/** The rows of a column: runs of cards as one list of rows, with the column's dividers and notes between them. */
function ColumnRows({ rows, slug, openKey, onOpen }: {
  rows: ListRow[];
  slug: string;
  openKey: string | null;
  onOpen?: (event: MouseEvent<HTMLAnchorElement>, ref: TopicRef) => void;
}): ReactNode {
  const out: ReactNode[] = [];
  let run: CardRow[] = [];
  const flush = () => {
    if (!run.length) return;
    out.push(<WorkList key={`list:${run[0].key}`} rows={run} slug={slug} openKey={openKey} onOpen={onOpen} variant="board" />);
    run = [];
  };
  for (const row of rows) {
    if (row.t === 'card' && row.brief) { run.push(row); continue; }
    flush();
    out.push(<ListRowView key={row.key} row={row} />);
  }
  flush();
  return out;
}

function Column(
  { col, active, loading, deferred, slug, canPost, unfolded, openKey, onOpen }:
  {
    col: KanbanColView; active: boolean; loading: boolean; deferred: boolean;
    slug: string; canPost: boolean; unfolded: boolean;
    openKey: string | null;
    onOpen?: (event: MouseEvent<HTMLAnchorElement>, ref: TopicRef) => void;
  },
): ReactNode {
  const hostRef = useRef<HTMLDivElement>(null);
  const hasReviewSort = col.key === 'inreview' && !!col.reviewSort;
  const sortLabel = col.reviewSort === 'priority' ? 'Vote priority' : 'Newest';
  const nextSort = col.reviewSort === 'priority' ? 'newest' : 'priority';
  const nextSortLabel = nextSort === 'priority' ? 'Vote priority' : 'Newest';
  const statusTone = col.status?.tone === 'blocked'
    ? 'text-red-700 dark:text-red-300'
    : col.status?.tone === 'progress'
      ? 'text-violet-700 dark:text-violet-300'
      : 'text-zinc-500 dark:text-zinc-400';
  // `?cards=open` draws every card at full size, and a merged card's kudos
  // slot is a legacy-filled host (`_fillKudosHosts`, run by app-view.js
  // after every publish) — re-run here so a column that mounts between
  // publishes is whole on its first frame. A LAYOUT effect, so the pill is
  // in its band before paint rather than popping in a frame later.
  //
  // The unfolded card's GitHub-comment slot is the same kind of host and is
  // filled the same way (#1884, `_wireFeedComments`) — wired from the BOARD,
  // not from this column: that filler keeps ONE observer and replaces it on
  // every call, so four columns wiring their own would leave only the last
  // one watched.
  useLayoutEffect(() => {
    const host = hostRef.current;
    if (!host || !unfolded) return;
    callAppView('_fillKudosHosts', host);
    callAppView('_wireFeedComments', host.closest('#dev-kanban') || host);
  }, [unfolded]);
  let cards: ReactNode;
  // Below 640px this column is `display:none` unless it is the active one
  // (see .dev-kanban-col in app.css), so building its rows is work whose
  // only outcome is being hidden. The column SHELL still renders: same id,
  // same data-kanban-col, and the count is the strip's, from col.count, so
  // a deferred column still reports the right number. Only the rows wait,
  // and they arrive the moment the tab is tapped, because activeTab
  // republishes and this column stops being deferred.
  if (deferred) {
    cards = null;
  } else if (loading) {
    cards = <CardSkeleton n={2} label={`Loading ${col.title}`} />;
  } else if (col.empty) {
    cards = <div className="dev-kanban-empty">{col.empty}</div>;
  } else if (unfolded) {
    cards = (
      <div className="space-y-2">
        {col.rows.map((row: ListRow) => (
          <ListRowView
            key={row.key}
            row={row}
            fold={{
              slug,
              canPost,
              open: true,
              onToggle: () => {},
              // "Open card" rides in the action band: a column is too
              // narrow for the facts-line seat (fold.tsx).
              detail: 'actions',
              // No "Open session ›" line under a board card: app.css has no
              // rule for `.dev-ws-sheet-actions` inside `#dev-kanban`.
              sessionLink: false,
            }}
          />
        ))}
      </div>
    );
  } else {
    cards = <ColumnRows rows={col.rows} slug={slug} openKey={openKey} onOpen={onOpen} />;
  }
  const lead = hasReviewSort ? (
    <div className="dev-kanban-lead">
      <button
        type="button"
        className="dev-ws-chip dev-kanban-sort"
        aria-label={`Sort Waiting for approval: ${sortLabel}. Switch to ${nextSortLabel}.`}
        title={`${col.reviewSort === 'priority'
          ? 'Unvoted first, then fewest qualifying votes still needed. Within each vote group, already-qualified proposals follow those still short. Newest breaks ties.'
          : 'Most recently submitted for review first.'} Click to switch to ${nextSortLabel}.`}
        onClick={() => callAppView('_setReviewSort', nextSort)}
      >
        <ArrowUpIcon aria-hidden="true" className="dev-kanban-sort-icon" />
        {sortLabel}
      </button>
    </div>
  ) : (!loading && col.status ? (
    <p
      data-kanban-col-status={col.key}
      className={`dev-kanban-lead dev-kanban-status ${statusTone}`}
      title={col.status.title}
    >
      {col.status.text}
    </p>
  ) : null);
  const footer = !deferred && col.footer ? <div className="dev-kanban-foot"><FooterView f={col.footer} /></div> : null;
  return (
    <div
      ref={hostRef}
      id={`dev-kanban-col-${col.key}`}
      data-kanban-col={col.key}
      className={`dev-kanban-col${active ? ' dev-kanban-col-active' : ''}`}
      role="tabpanel"
      aria-labelledby={`dev-kanban-tab-${col.key}`}
    >
      {unfolded ? (
        <>
          {lead}
          {cards}
          {footer}
        </>
      ) : (
        <div className="dev-kanban-card">
          {lead}
          {cards}
          {footer}
        </div>
      )}
    </div>
  );
}

export function DevKanban({ openKey = null, onOpen }: {
  /** `kind:id` of the item whose page is open beside the board, to highlight its row. */
  openKey?: string | null;
  /** A plain click on a row: the Workshop opens its page beside the board, or lets the link go. */
  onOpen?: (event: MouseEvent<HTMLAnchorElement>, ref: TopicRef) => void;
} = {}): ReactNode {
  const v = useStoreState(devKanbanStore);
  // Wide viewports render every column — including the proposal-checks
  // runner, which asserts in a fixed 1280x800 frame.
  const narrow = useNarrowViewport();
  if (!v.cols.length) return null;
  return (
    <div
      id="dev-kanban"
      data-kanban-active={v.activeTab}
      data-cards-open={v.unfolded ? '' : undefined}
      onScroll={(e) => syncStrip(e.currentTarget)}
    >
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
          openKey={openKey}
          onOpen={onOpen}
        />
      ))}
    </div>
  );
}
