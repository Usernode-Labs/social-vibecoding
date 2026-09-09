/**
 * Whether the Notifications SHEET is presented.
 *
 * Deliberately separate from ./notifications-store.js, which holds the rows.
 * That store is written by ./notifications.js — a classic script compiled
 * into nine vm sandboxes across the test suite — and presentation state has
 * no business travelling through it. Kept apart from the app-context and
 * Messages sheets' own flags for the same reason those two are kept apart:
 * one flag per surface means two sheets can never fight over it.
 */

import { createStore } from '../../lib/plain-store.js';

export const notificationsSheetStore = createStore({
  /** Whether the sheet is presented. `data-open` on the root derives from it. */
  open: false,
  /**
   * Whether the presentation is a KIT sheet (touch) rather than the CSS
   * slide-over. The kit brings its own backdrop, so the web overlay only
   * raises when this is false — see lib/sheet-controller.js.
   */
  adopted: false,
});
