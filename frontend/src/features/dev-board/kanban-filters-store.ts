/**
 * The kanban board's filter bar, as a view model.
 *
 * ── Why the options are DATA and not derived here ─────────────────────
 *
 * Both data-driven selects keep the current selection in their list even when
 * it vanishes from the source — an assignee whose last card was merged away, a
 * custom category the app retired — so an active filter never silently
 * self-clears. That rule lives with the data, in `_kanbanAssigneeOptions` and
 * `_kanbanCategoryOptionsHtml`'s successor, and it is why this carries option
 * lists rather than the cards they were derived from.
 *
 * ── `seq` is what Clear resets ────────────────────────────────────────
 *
 * The search box is UNCONTROLLED: an ordinary board repaint must not disturb
 * what someone is typing or where their caret is, which is exactly what a
 * controlled value re-rendered from the store would do. `defaultValue` is only
 * read when the node is created, so Clear — the one path that has to put the
 * box back to empty — bumps `seq`, which the component uses as the field's
 * `key`. A new key is a new node, and a new node reads `defaultValue` again.
 */

import { createStore } from '../../lib/plain-store.js';

export interface FilterOption {
  value: string;
  label: string;
}

export interface KanbanFiltersState {
  /** False on the feed, which has no filters — the bar draws nothing. */
  mounted: boolean;
  q: string;
  priority: string;
  category: string;
  assignee: string;
  needsVote: boolean;
  /** Any filter set — decides whether Clear is offered. */
  active: boolean;
  categories: FilterOption[];
  assignees: FilterOption[];
  /** Bumped by Clear; the search field's `key`. See the header. */
  seq: number;
}

export const EMPTY_KANBAN_FILTERS: KanbanFiltersState = {
  mounted: false,
  q: '',
  priority: '',
  category: '',
  assignee: '',
  needsVote: false,
  active: false,
  categories: [],
  assignees: [],
  seq: 0,
};

export const kanbanFiltersStore = createStore<KanbanFiltersState>(EMPTY_KANBAN_FILTERS);
