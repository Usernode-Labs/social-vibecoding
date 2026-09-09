/**
 * `#attr-popover` — the priority / category / assignee picker a card's
 * metadata chip opens — as a view model.
 *
 * ── The host is the module's, the children are React's ────────────────
 *
 * Same seam as the group chat's floating menus. `public/js/app-view.js`
 * creates the element, appends it to `document.body`, measures the chip it
 * hangs under and clamps the result into the viewport, and REMOVES the node on
 * close. None of that is markup. What moved is what is inside it.
 *
 * ── One shape for three fields ────────────────────────────────────────
 *
 * The three variants differ in what they list, not in how they list it: a head,
 * some rows, sometimes a second head with the app's custom options under it,
 * and sometimes an add box. Modelling them as `groups` rather than as three
 * branches is what keeps the row itself — the label, the tally, the check, the
 * `data-attr-opt-*` the click handler reads — written once.
 *
 * ── What stays in app-view.js ─────────────────────────────────────────
 *
 * Every decision: the vocabulary (`ATTR_PRIORITY_VALUES`, the six built-in
 * categories and the app's custom ones), the tint each value carries, the
 * fetch, the vote POST and its optimistic repaint, the case-folding that turns
 * a typed "Bug" into a vote for the built-in `bug`, and the typeahead's
 * debounce against /api/users/search. The component is handed the answer.
 */

import { createStore } from '../../lib/plain-store.js';

export type AttrField = 'priority' | 'category' | 'assignee';

/** One row. `dot` is the tint class pair, absent on an assignee row. */
export interface AttrOptionView {
  value: string;
  dot: string | null;
  label: string;
  count: number;
  /** The viewer's current pick. On assignee, re-clicking it withdraws. */
  mine: boolean;
}

export interface AttrGroupView {
  head: string;
  /** The custom block's head carries a rule above it. */
  divided: boolean;
  options: AttrOptionView[];
}

/** The type-a-new-one box under the rows. Absent for priority. */
export interface AttrAddView {
  inputId: string;
  buttonId: string;
  placeholder: string;
  maxLength: number;
  /**
   * #600: the assignee box defaults to the viewer's own name, so "assign it
   * to me" is one click of Add — but only when they have no current pick, so
   * a vote they already made is never quietly overwritten.
   */
  defaultValue: string;
  /** Assignee only: the typeahead panel exists under the input. */
  suggest: boolean;
}

export interface AttrPopoverState {
  phase: 'idle' | 'loading' | 'error' | 'ready';
  field: AttrField | null;
  groups: AttrGroupView[];
  /** "No suggestions yet." — assignee only, when nobody has voted. */
  emptyNote: string | null;
  add: AttrAddView | null;
  /** Usernames from the live typeahead. Cleared when the box empties. */
  suggestions: string[];
}

export const EMPTY_ATTR_POPOVER: AttrPopoverState = {
  phase: 'idle',
  field: null,
  groups: [],
  emptyNote: null,
  add: null,
  suggestions: [],
};

export const attrPopoverStore = createStore<AttrPopoverState>(EMPTY_ATTR_POPOVER);
