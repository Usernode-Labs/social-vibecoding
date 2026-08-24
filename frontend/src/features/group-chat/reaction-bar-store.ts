/**
 * `#gc-react-bar` — the long-press reaction picker (#25), as a view model.
 *
 * The bar is one floating element shared by every message row: a long press
 * (or the hover button) points it at a row, positions it above that row and
 * un-hides it. Two things about its CONTENTS change while it is open, and
 * both used to be a `classList.toggle` reaching into the built markup:
 *
 *   * `gridOpen` — the `＋` control expands the curated grid under the quick
 *     row, and every open starts with it collapsed.
 *   * `editable` — the touch-only Edit action is offered on the viewer's own
 *     ordinary messages and on nothing else, so it is decided per row.
 *
 * ── What is NOT here ──────────────────────────────────────────────────
 *
 * The emoji themselves. `QUICK_REACTIONS` and `GRID_REACTIONS` are constants
 * in public/js/group-chat.js, fixed for the life of the page, and they reach
 * ./reaction-bar.tsx as props on the portal node — the mount IS their publish.
 * Republishing ~380 strings every time a thumb lands on a message would be a
 * lot of copying to say nothing new.
 *
 * Which message the bar is pointed at is not here either: it lives on the
 * host as `data-msg-id`, where `_reactFromBar` and `_startEdit` read it, and
 * the host is the module's.
 */

import { createStore } from '../../lib/plain-store.js';

export interface ReactionBarState {
  gridOpen: boolean;
  editable: boolean;
}

/** How every open starts: quick row only, Edit withheld until a row says so. */
export const EMPTY_REACTION_BAR: ReactionBarState = { gridOpen: false, editable: false };

export const reactionBarStore = createStore<ReactionBarState>(EMPTY_REACTION_BAR);
