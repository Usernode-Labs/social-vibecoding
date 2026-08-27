/**
 * window.NotificationsSheet — presentation for the Notifications sheet.
 *
 * ── Why a sheet and not a screen ───────────────────────────────────────
 *
 * It was a full screen root with the header's back arrow pointing home. The
 * bell is reachable from EVERY screen, so "back" from it was a guess: open
 * it from a dev session and the arrow took you home, not to the session you
 * were reading. A sheet has no such question to answer — it presents over
 * whatever is on screen and dismisses back to exactly that.
 *
 * Rows still navigate away (`_onItemClick` writes `location.hash`), which is
 * why ./notifications.js calls `_dismissSheetForNav()` first: the sheet is
 * modal over the destination, so it has to be gone before the destination
 * arrives.
 *
 * The refresh moved here from the screen root's pull-to-refresh. A kit sheet
 * owns the vertical drag for its own dismiss gesture, so a pull-down inside
 * one cannot also mean "reload"; fetching on open is the same promise the
 * gesture made, minus the conflict.
 */

import { createSheetController } from '../../lib/sheet-controller.js';
import { notificationsSheetStore } from './notifications-sheet-store.js';

export const NotificationsSheet = createSheetController({
  elementId: 'notifications-sheet',
  store: notificationsSheetStore,
  onOpen: () => { window.Notifications?.refresh?.(); },
});

if (typeof window !== 'undefined') {
  window.NotificationsSheet = NotificationsSheet;
}
