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
 * OPENING ONLY REFRESHES (#6527). Opening the sheet loads the latest rows and
 * marks nothing read: the badge and the Unread (N) count stay as they were
 * until the person clears something themselves (Mark all read, a row's clear,
 * opening a row). Opening used to clear what the bell counted (#6498), which
 * made a notification nobody had looked at leave Unread on every device.
 */

import { createSheetController } from '../../lib/sheet-controller.js';
import { notificationsSheetStore } from './notifications-sheet-store.js';

export const NotificationsSheet = createSheetController({
  elementId: 'notifications-sheet',
  store: notificationsSheetStore,
  // Opening the sheet only refreshes it (#6527): the rows that arrived while
  // it was closed land on screen, and nothing is marked read. Reading is
  // explicit — Mark all read, a row's clear, or opening a row.
  onOpen: () => Promise.resolve(window.Notifications?.refresh?.()),
});

if (typeof window !== 'undefined') {
  window.NotificationsSheet = NotificationsSheet;
}
