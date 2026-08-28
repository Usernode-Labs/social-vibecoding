/**
 * `#dev-kanban-tabs` — the Board's ONE display control.
 *
 * ── What this replaces ─────────────────────────────────────────────────
 *
 * The board carried two controls for one question. A Kanban|Feed mode
 * (a localStorage preference, last seen as a pair of pills under the
 * Improve panel's Board row) chose the LAYOUT, and inside kanban this
 * strip chose the COLUMN — except CSS hid the strip above 640px, so on a
 * desktop it did not exist and on a phone the layout pills governed a
 * board you could only see one column of anyway. Each control was
 * invisible exactly where the other one mattered.
 *
 * There is one strip now, at every width:
 *
 *     All · Issues · Underway · In review · Done
 *
 * `All` is the whole board drawn to fit — the four columns side by side
 * where there is room, the recency-ordered stream where there is not.
 * Every other tab is that column alone, on a phone and on a desktop
 * alike. Nobody stores a layout and nobody picks one; it falls out of the
 * tab and the viewport (`AppView._boardLayout()`).
 *
 * ── Why it lives in the FRAME and not in the board ─────────────────────
 *
 * It was `card/dev-kanban.tsx`'s markup, which put it inside `#dev-body`
 * — the host `_repaintDevBody()` replaces wholesale. That was survivable
 * while the strip only ever appeared over the kanban. It is not now: on a
 * narrow viewport `All` renders the STREAM, and a strip living inside the
 * thing it switches away from would vanish the moment you used it.
 *
 * So it is a row of `<DevBoardFrame/>`, above `#dev-forum-scroll` — which
 * also pins it, as the board draws it, instead of scrolling it away with
 * the cards. The store is unchanged (`devKanbanStore`): app-view.js
 * publishes the same view model from both layouts (`_publishBoardView`),
 * so the counts are live whichever surface is under the strip.
 *
 * ── Why `All` carries no number ────────────────────────────────────────
 *
 * Every other tab counts its own column, and a fifth number here would
 * read as their sum. It cannot be one: `Done` shows the true merged TOTAL
 * rather than the rows it has loaded (#433), so the honest sum is either
 * a lifetime figure that dwarfs the rest of the strip or an arithmetic
 * that visibly does not add up. `All` is not a bucket — it is the absence
 * of a filter — so it gets a label and the empty half of the two-line
 * rhythm the other four keep.
 */

import type { ReactNode } from 'react';

import { useStoreState } from '../../lib/use-store-state';
import { devKanbanStore } from './card/cards-store';
import type { KanbanColView } from './card/model';
import { CountSkeleton } from './card/skeleton';

/** `AppView._onBoardTabSelect`, the one entry point the strip has. */
function selectTab(key: string): void {
  const av = typeof window !== 'undefined' ? (window as any).AppView : null;
  if (av && typeof av._onBoardTabSelect === 'function') av._onBoardTabSelect(key);
}

const TAB_BASE = 'dev-kanban-tab flex-1 basis-0 min-w-0 min-h-[44px] px-1 py-1.5 '
  + 'flex flex-col items-center justify-center border-b-2 transition-colors ';
const TAB_ON = 'border-violet-500 text-violet-700 font-semibold dark:text-violet-400';
const TAB_OFF = 'border-transparent text-zinc-500 dark:text-zinc-400 '
  + 'hover:text-zinc-700 dark:hover:text-zinc-200';

function Tab({ tabKey, title, count, active, loading }: {
  tabKey: string;
  title: string;
  /** null on `All` — see the header. */
  count: number | null;
  active: boolean;
  loading: boolean;
}): ReactNode {
  const countCls = 'font-mono text-[11px] leading-tight '
    + (active
      ? 'text-violet-700 dark:text-violet-400'
      : (count ? 'text-zinc-500 dark:text-zinc-500' : 'text-zinc-300 dark:text-zinc-500'));
  return (
    <button
      type="button"
      role="tab"
      id={`dev-kanban-tab-${tabKey}`}
      data-kanban-tab={tabKey}
      aria-selected={active}
      // `All` controls whichever surface is under the strip rather than one
      // column, and on a narrow viewport that is #dev-feed — so it names no
      // single element and takes no aria-controls.
      {...(count === null ? {} : { 'aria-controls': `dev-kanban-col-${tabKey}` })}
      className={TAB_BASE + (active ? TAB_ON : TAB_OFF)}
      onClick={() => selectTab(tabKey)}
    >
      <span className="text-xs leading-tight truncate max-w-full">{title}</span>
      {/* Rendered even when empty: the strip's height is two lines, and a tab
          that dropped the second one would sit taller than its neighbours. */}
      <span className={countCls}>
        {count === null ? ' ' : (loading ? <CountSkeleton /> : count)}
      </span>
    </button>
  );
}

export function BoardTabs(): ReactNode {
  const v = useStoreState(devKanbanStore);
  // Nothing to switch between until the first publish — and the strip ships
  // in the frame, so an empty render here is what a cold board paints.
  if (!v.cols.length) return null;
  return (
    <div
      id="dev-kanban-tabs"
      role="tablist"
      aria-label="Board"
      className="flex items-stretch gap-1 px-3 border-b border-zinc-200 dark:border-zinc-800 shrink-0"
    >
      <Tab
        tabKey="all"
        title="All"
        count={null}
        active={v.activeTab === 'all'}
        loading={!!v.loading}
      />
      {v.cols.map((col: KanbanColView) => (
        <Tab
          key={col.key}
          tabKey={col.key}
          title={col.title}
          count={col.count}
          active={col.key === v.activeTab}
          loading={!!v.loading}
        />
      ))}
    </div>
  );
}
