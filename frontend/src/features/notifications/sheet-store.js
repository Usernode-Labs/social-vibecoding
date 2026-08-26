/**
 * Whether the notifications sheet is presenting (#1436).
 *
 * The list itself is NOT here. `./notifications-store.js` owns the rows, the
 * unread counts and the per-group fold, and `./notifications.js` still drives
 * them exactly as it did while the list lived inside the hamburger — nothing
 * about the data moved, only the surface around it.
 *
 * This is deliberately one boolean rather than folding `open` into the list
 * store: the list store is written from the notification stream at any time,
 * including while the sheet is shut, and a presentation flag living in it
 * would make every arriving notification a reason to re-render the panel's
 * chrome.
 */

import { createStore } from '../../lib/plain-store.js';

/**
 * @typedef {Object} NotificationsSheetState
 * @property {boolean} open
 */

/** @type {import('../../lib/plain-store.js').Store<NotificationsSheetState>} */
export const notificationsSheetStore = createStore({ open: false });
