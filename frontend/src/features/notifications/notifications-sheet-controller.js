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
 *
 * OPENING IS ALSO READING (#6498). Once the refresh that fills the sheet has
 * landed, `Notifications.markReadOnOpen()` clears what the bell counts, so
 * the badge drops; the rows the sheet was showing stay listed, dimmed, until
 * it closes (the sheet's useHeldUnread). A refresh that failed or was
 * superseded clears nothing, so nothing the person was not shown is marked.
 * A sheet opened by the `?shot=notifications` deep link is a capture, not
 * reading, so it marks nothing: `_shotOpened` is set before the sheet
 * presents.
 */

import { createSheetController } from '../../lib/sheet-controller.js';
import { notificationsSheetStore } from './notifications-sheet-store.js';

export const NotificationsSheet = createSheetController({
  elementId: 'notifications-sheet',
  store: notificationsSheetStore,
  // Opening the sheet is also READING it (#6498): refresh first, so the
  // rows that arrived while it was closed are on screen, then clear what
  // the bell counts. Only a landed refresh clears — a failed or superseded
  // one returns false, and rows the person was never shown must not be
  // marked read.
  onOpen: () => Promise.resolve(window.Notifications?.refresh?.())
    .then((ok) => {
      if (ok && !window.Notifications?._shotOpened) window.Notifications?.markReadOnOpen?.();
    }),
});

if (typeof window !== 'undefined') {
  window.NotificationsSheet = NotificationsSheet;
}
