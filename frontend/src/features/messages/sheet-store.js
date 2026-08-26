/**
 * Whether the Messages SHEET is presented.
 *
 * Kept out of ./store.ts deliberately: that store holds conversations,
 * messages and the list<->thread route, and is driven by fetches and WS
 * events. Presentation is one boolean with a different lifetime, and one
 * flag per surface is what stops two sheets fighting over a single one.
 */

import { createStore } from '../../lib/plain-store.js';

export const messagesSheetStore = createStore({
  /** Whether the sheet is presented. `data-open` on the root derives from it. */
  open: false,
});
