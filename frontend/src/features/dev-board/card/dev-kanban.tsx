/**
 * `#dev-kanban-board` — the kanban board — as the only React writer below
 * that host. The host stays app-view.js's; the columns, the pipeline heads
 * and every row render from `devKanbanStore`.
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
 * ── The pipeline heads (was the tab strip, #814) ──────────────────────
 *
 * Each column leads with its stage icon, its name and its count, so the row
 * of heads reads as the pipeline of a piece of work: Requests › Underway ›
 * Waiting for approval › Done. The heads carry `data-kanban-tab` and select
 * through `AppView._onKanbanTabSelect` (which persists the choice and
 * republishes `activeTab`), the seam the old `#dev-kanban-tabs` strip used —
 * the strip is retired. Below 640px, where only one column shows at a time,
 * the heads ARE the tabs: a `.dev-kanban-pipe` tablist above the board, one
 * `role="tab"` per column, replaces both the old strip and the in-column
 * head (which CSS hides there).
 *
 * ── Rows, not cards ───────────────────────────────────────────────────
 *
 * Each column draws its items as the Workshop tab's rows (#4457,
 * ../workshop/work-row.tsx) inside one list — not a tall card per item,
 * unfolded in place. The row keeps what the card did well (the vote with
 * its count, the category chip, the 💬 count, and a row-level ☰ with the
 * card menu's own descriptors) and loses the coloured edge and glyph the
 * column head now says. The model attaches each row's `brief` and menu key
 * (app-view.js `_kanbanView`), and a plain click opens the item's page in
 * the pane beside the board (workshop/side-panel.tsx, via the opener the
 * Workshop registers) on a wide window; a phone, a modified click or a
 * middle click takes the row's own link.
 *
 * `?cards=open` draws every card unfolded: the board as it was, and the
 * state the declared checks that read a card's anatomy run in.
 */

import { useLayoutEffect, useRef, type ReactNode } from 'react';

import { Button } from '@/components/ui/button';
import {
  ArrowUpIcon, ChatBubbleTailIcon, CheckIcon, PencilSquareIcon, BallotIcon,
} from '@/components/ui/icons';
import { SECTION_TAB_ACTIVE, SECTION_TAB_INACTIVE } from '@/components/ui/tabs';

import { useNarrowViewport } from '../../../lib/use-narrow';
import { useStoreState } from '../../../lib/use-store-state';
import { devKanbanStore } from './cards-store';
import { callAppView } from './fold';
import { FooterView } from './footer';
import { ListRowView } from './list-rows';
import type { KanbanColView, ListRow } from './model';
import { CardSkeleton, CountSkeleton } from './skeleton';
import { WorkList } from '../workshop/work-row';
import { openRowInPanel } from '../workshop/side-panel';

function selectTab(key: string): void {
  const av = typeof window !== 'undefined' ? (window as any).AppView : null;
  if (av && typeof av._onKanbanTabSelect === 'function') av._onKanbanTabSelect(key);
}

/** The stage icon each pipeline head wears — the row tiles' own glyphs. */
const STAGE_ICONS: Record<string, typeof CheckIcon> = {
  issues: ChatBubbleTailIcon,
  inprogress: PencilSquareIcon,
  inreview: BallotIcon,
  done: CheckIcon,
};

/*
 * One pipeline head. The segmented, lit-when-selected treatment is the
 * Stage / Category switch's (`dev-ws-group`), via SECTION_TAB_ACTIVE /
 * INACTIVE — the same pair the old strip wore.
 *
 * `asTab` is the phone's: the head IS the tab, inside the `.dev-kanban-pipe`
 * tablist, and says `role="tab"`. On a wide window it is the column's own
 * head, a plain control that names the stage (aria-selected still says
 * which is up, as it did on the old strip's tabs).
 */
function PipeHead({ col, active, loading, asTab = false }: {
  col: KanbanColView; active: boolean; loading: boolean; asTab?: boolean;
}): ReactNode {
  const Icon = STAGE_ICONS[col.key] || PencilSquareIcon;
  const cls = 'dev-kanban-pipe-head '
    + (active ? SECTION_TAB_ACTIVE : SECTION_TAB_INACTIVE);
  return (
    <button
      type="button"
      {...(asTab
        // The tab's own id lives only in the tablist: the head inside each
        // column renders the same button again, and an id must not repeat.
        ? { role: 'tab' as const, id: `dev-kanban-tab-${col.key}`, 'aria-controls': `dev-kanban-col-${col.key}` }
        : {})}
      data-kanban-tab={col.key}
      aria-selected={active}
      className={cls}
      title={col.hint || undefined}
      onClick={() => selectTab(col.key)}
    >
      <Icon aria-hidden="true" className="dev-kanban-pipe-icon" />
      <span className="dev-kanban-pipe-name">{col.title}</span>
      <span className="dev-kanban-pipe-count">{loading ? <CountSkeleton /> : col.count}</span>
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
  const hostRef = useRef<HTMLDivElement>(null);
  const hasReviewSort = col.key === 'inreview' && !!col.reviewSort;
  const sortLabel = col.reviewSort === 'priority' ? 'Vote priority' : 'Newest';
  const nextSort = col.reviewSort === 'priority' ? 'newest' : 'priority';
  const nextSortLabel = nextSort === 'priority' ? 'Vote priority' : 'Newest';
  const statusTone = col.status?.tone === 'blocked'
    ? 'text-red-700 dark:text-red-300'
    : col.status?.tone === 'progress'
      ? 'text-violet-700 dark:text-violet-300'
      : col.status?.tone === 'ok'
        ? 'text-emerald-700 dark:text-emerald-300'
        : 'text-zinc-500 dark:text-zinc-400';
  // A merged card's kudos slot is a legacy-filled host (`_fillKudosHosts`,
  // run by app-view.js after every publish). A fold happens BETWEEN
  // publishes, so the slot a card just unfolded with would stay empty until
  // the next repaint; re-run the filler here. It skips filled hosts.
  //
  // A LAYOUT effect, not a plain one: a plain effect runs after the browser
  // has painted the card with the slot empty, so the kudos pill popped in a
  // frame later and shoved "Open card" along the band — the flicker at the
  // bottom-left of every merged card on open. Before paint, the card is
  // whole on its first frame, and the band's fold measurement (which
  // watches its own subtree) re-folds around the filled slot in the same
  // frame.
  //
  // The unfolded card's GitHub-comment slot is the same kind of host and is
  // filled the same way (#1884, `_wireFeedComments`) — but wired from the
  // BOARD, not from this column. That filler keeps ONE observer and replaces
  // it on every call, so four columns wiring their own would leave only the
  // last one watched; one call from `#dev-kanban` covers all four, and a
  // fold only ever happens in one column at a time.
  useLayoutEffect(() => {
    const host = hostRef.current;
    if (!host) return;
    callAppView('_fillKudosHosts', host);
    callAppView('_wireFeedComments', host.closest('#dev-kanban') || host);
  }, [unfolded]);
  let rows: ReactNode;
  // Below 640px this column is `display:none` unless it is the active one
  // (see .dev-kanban-col in app.css), so building its rows is work whose
  // only outcome is being hidden. On a warm board that was three quarters
  // of the render — measured as the largest single item in a phone-shaped
  // profile, ahead of every network wait left in the boot.
  //
  // The column SHELL still renders: same id, same data-kanban-col. Only the
  // rows wait, and they arrive the moment a pipe head is tapped, because
  // activeTab republishes and this column stops being deferred.
  if (deferred) {
    rows = null;
  } else if (loading) {
    // Two rows, not four: the point is to show the column is filling, and a
    // full-height stack of placeholders in each of four columns is a busier
    // screen than the one it is standing in for.
    rows = <CardSkeleton n={2} label={`Loading ${col.title}`} />;
  } else if (col.empty) {
    rows = <div className="text-xs text-zinc-500 dark:text-zinc-500 italic py-2">{col.empty}</div>;
  } else if (unfolded) {
    // `?cards=open`: every card at full size, the board as it was — the
    // state the declared checks that read a card's anatomy run in.
    rows = (
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
              detail: 'actions',
              sessionLink: false,
            }}
          />
        ))}
      </div>
    );
  } else {
    // The Workshop tab's rows, in one hairline-divided list per column.
    // Rows that are not card rows — Underway's dividers, the archived
    // toggle, the session-filter note — are drawn as they always were.
    const cards = col.rows.filter((r): r is Extract<ListRow, { t: 'card' }> => r.t === 'card' && !!r.brief);
    const others = col.rows.filter((r) => !(r.t === 'card' && !!r.brief));
    rows = (
      <div className="space-y-2">
        {others.map((row: ListRow) => <ListRowView key={row.key} row={row} />)}
        {cards.length ? (
          <WorkList
            rows={cards}
            slug={slug}
            board
            menu
            onOpen={(e, ref) => openRowInPanel(e, ref)}
          />
        ) : null}
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
      {/* `flex-wrap`: at a 1280px window with the sidebar open a column is
          ~230px and the Waiting-for-approval head has no room beside its
          sort control (it overlapped it, count and all). Wrapping drops the
          sort control to a right-aligned second line only when a column is
          that tight; wider columns keep the one row. */}
      <div className="mb-2 flex min-h-[36px] flex-wrap items-center justify-between gap-x-2 gap-y-0 px-0.5">
        <PipeHead col={col} active={active} loading={loading} />
        {hasReviewSort ? (
          <Button
            type="button"
            variant="unstyled"
            size="none"
            ink="muted"
            aria-label={`Sort Waiting for approval: ${sortLabel}. Switch to ${nextSortLabel}.`}
            title={`${col.reviewSort === 'priority'
              ? 'Unvoted first, then fewest qualifying votes still needed. Within each vote group, already-qualified proposals follow those still short. Newest breaks ties.'
              : 'Most recently submitted for review first.'} Click to switch to ${nextSortLabel}.`}
            className="ml-auto inline-flex min-h-[44px] shrink-0 items-center gap-1.5 rounded-lg px-2 text-xs font-medium whitespace-nowrap focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-violet-500"
            onClick={() => callAppView('_setReviewSort', nextSort)}
          >
            <ArrowUpIcon aria-hidden="true" className="h-3.5 w-3.5 rotate-180" />
            {sortLabel}
          </Button>
        ) : null}
      </div>
      {!loading && col.status ? (
        <div
          data-kanban-col-status={col.key}
          className={`text-[11px] leading-snug font-medium mb-2 px-0.5 ${statusTone}`}
          title={col.status.title}
        >
          {col.status.text}
        </div>
      ) : null}
      {rows}
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
      {/*
          Below 640px the pipe heads ARE the tabs: one tablist above the
          board, one tab per column, in place of the retired
          `#dev-kanban-tabs` strip. At 640px and up CSS hides it — the
          in-column heads label the columns there — and it never takes part
          in the layout.
      */}
      <div
        className="dev-kanban-pipe"
        role="tablist"
        aria-label="Board columns"
      >
        {v.cols.map((col) => (
          <PipeHead key={col.key} col={col} active={col.key === v.activeTab} loading={!!v.loading} asTab />
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
