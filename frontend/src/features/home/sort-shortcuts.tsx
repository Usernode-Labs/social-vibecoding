/**
 * "Sort A–Z" — the Shortcuts heading's one action (#3750).
 *
 * A one-shot press, not a mode: `Home.sortShortcutsAZ()` hands the cells the
 * tiles already occupy back out in name order and saves the result the way a
 * drop is saved, so dragging afterwards is the manual arrangement with
 * nothing to switch off.
 *
 * Rendered only while `chromeStore.sortable` holds — two or more tiles, not
 * already in name order, and no search — so a press that would move nothing
 * is never offered. The store starts false, which is what keeps the
 * prerendered heading exactly the bare label it shipped as (the hydration
 * contract): the button arrives with the first `Home.render()`.
 *
 * Same treatment as the other headings' actions (`BrowseLink` in
 * ./panels/ui.tsx): 14px semibold in the accent, no glyph.
 */

import { useStoreState } from '../../lib/use-store-state';
import { chromeStore } from './chrome-store';

function controller(): any {
  return (typeof window !== 'undefined' ? (window as any).Home : null) || null;
}

/** The button, as a pure function of the flag — callable in a test. */
export function SortShortcutsBody({ sortable }: { sortable: boolean }) {
  if (!sortable) return null;
  return (
    <button
      type="button"
      id="home-shortcuts-sort-btn"
      className="shrink-0 flex items-center text-[14px] font-semibold text-[color:var(--accent)] hover:underline whitespace-nowrap un-touch-target"
      title="Arrange your shortcuts alphabetically"
      aria-label="Sort shortcuts A to Z"
      onClick={(e) => {
        e.stopPropagation();
        controller()?.sortShortcutsAZ?.();
      }}
    >
      Sort A–Z
    </button>
  );
}

export function SortShortcuts() {
  const { sortable } = useStoreState(chromeStore);
  return <SortShortcutsBody sortable={sortable} />;
}
