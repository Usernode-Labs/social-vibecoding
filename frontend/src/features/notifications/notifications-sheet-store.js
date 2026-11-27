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
  /**
   * Whether the sheet is presented. `data-open` on the root derives from it,
   * and `useSheet` (lib/sheet.ts) presents it while it is up.
   */
  open: false,
  /**
   * The tab a caller outside the sheet asks it to open on (`#6816`: Home's
   * Recent threads card). The sheet reads it as it opens and clears it, so it
   * is a request for this opening, not a setting; null is nothing asked.
   */
  tab: null,
});
