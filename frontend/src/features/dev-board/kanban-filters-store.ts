/**
 * The kanban board's filter bar, as a view model.
 *
 * Streamlined Concept: the bar is search + a `Filters (n)` chip + one
 * dismissable chip per active filter. The priority / category / assignee
 * selects and the needs-vote toggle live in the Filters dialog
 * (features/dialogs/board-filters.tsx) now, and the option vocabularies ride
 * that dialog's open() payload — so this store carries no option lists, just
 * the search text, the dialog-owned filter count and the active-chip rows.
 *
 * ── `seq` is what empties the search box ──────────────────────────────
 *
 * The search box is UNCONTROLLED: an ordinary board repaint must not disturb
 * what someone is typing or where their caret is, which is exactly what a
 * controlled value re-rendered from the store would do. `defaultValue` is only
 * read when the node is created, so the one path that has to put the box back
 * to empty — dismissing the Search chip — bumps `seq`, which the component
 * uses as the field's `key`. A new key is a new node, and a new node reads
 * `defaultValue` again.
 */

import { createStore } from '../../lib/plain-store.js';

export interface FilterChip {
  /** The `_kanbanFilters` key this chip's × clears. */
  key: string;
  label: string;
}

export interface KanbanFiltersState {
  /** False on the feed, which has no filters — the bar draws nothing. */
  mounted: boolean;
  q: string;
  /** How many dialog-owned filters are set — the `Filters (n)` count. */
  count: number;
  /** One entry per active filter, in app-view.js's fixed order. */
  chips: FilterChip[];
  /** Bumped when the Search chip is dismissed; the search field's `key`. */
  seq: number;
}

export const EMPTY_KANBAN_FILTERS: KanbanFiltersState = {
  mounted: false,
  q: '',
  count: 0,
  chips: [],
  seq: 0,
};

export const kanbanFiltersStore = createStore<KanbanFiltersState>(EMPTY_KANBAN_FILTERS);
