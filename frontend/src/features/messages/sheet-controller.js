/**
 * window.MessagesSheet — presentation for the Messages sheet.
 *
 * ── Why a sheet and not a screen ───────────────────────────────────────
 *
 * Same reason as the bell's (see ../notifications/notifications-sheet-controller.js):
 * the chat bubble is in the header on every route, so a full-screen
 * Messages had to answer "back to where?" — and it answered home. Worse
 * here, because Messages had a SECOND back level of its own: a thread went
 * up to the list, the list went home, and both were driven by writing the
 * platform header's back arrow from a feature store. As a sheet the outer
 * level disappears (dismiss returns you to the screen underneath) and the
 * inner one becomes what it always was — a control inside this surface.
 *
 * Closing tears the thread down through ./store.ts's own `close()`, which
 * cancels an in-flight thread request and drops a pending share; leaving
 * Messages has always meant that, and dismissing the sheet is leaving.
 */

import { createSheetController } from '../../lib/sheet-controller.js';
import { messagesSheetStore } from './sheet-store.js';

export const MessagesSheet = createSheetController({
  elementId: 'messages-sheet',
  store: messagesSheetStore,
});

if (typeof window !== 'undefined') {
  window.MessagesSheet = MessagesSheet;
}
