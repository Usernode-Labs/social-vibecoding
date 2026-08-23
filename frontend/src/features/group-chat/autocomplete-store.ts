/**
 * The group chat composer's two autocomplete menus, as view models.
 *
 * `@name` (MentionAutocomplete) and `#123` / `PR#123` (RefAutocomplete) are
 * separate modules in `public/js/group-chat.js` with the same shape: detect the
 * token under the caret, filter a candidate list, and draw a floating listbox
 * anchored to the composer. Both used to build that listbox with `innerHTML`
 * and then re-toggle a class per row on every arrow key.
 *
 * ── One store, two slots ──────────────────────────────────────────────
 *
 * They are two menus, not one, because they are two modules with independent
 * open/close state and independent dismiss bindings. They share a store
 * because they share a composer: a token under the caret is `@`-shaped or
 * `#`-shaped, never both, so the two slots are never populated at once and
 * keeping them together makes that visible rather than incidental.
 *
 * ── What stays in group-chat.js ───────────────────────────────────────
 *
 * Everything that is not markup, which here is nearly everything: the token
 * detection, the candidate lists and their fetches, the accept-and-splice, the
 * capture-phase keydown, the dismiss listeners, and the POSITIONING — the menu
 * is `position: fixed` and its host is appended to `document.body`, measured
 * against the composer's rect. The host element is the module's; only its
 * CHILDREN are React's.
 */

import { createStore } from '../../lib/plain-store.js';

/** `you` is decided by the module, which knows the viewer. */
export interface MentionOption {
  username: string;
  you: boolean;
}

export interface RefOption {
  kind: 'pr' | 'issue';
  number: number;
  title: string;
}

export interface AutocompleteSlot<T> {
  items: T[];
  /** Highlighted row; -1 when closed. Arrow keys move it, they do not repaint. */
  active: number;
}

export interface AutocompleteState {
  mention: AutocompleteSlot<MentionOption>;
  ref: AutocompleteSlot<RefOption>;
}

/** Both closed. A menu's host ships empty and hidden, so this draws nothing. */
export const EMPTY_AUTOCOMPLETE: AutocompleteState = {
  mention: { items: [], active: -1 },
  ref: { items: [], active: -1 },
};

export const autocompleteStore = createStore<AutocompleteState>(EMPTY_AUTOCOMPLETE);
