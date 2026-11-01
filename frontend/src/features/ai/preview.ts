/**
 * A DESIGN'S PREVIEW, ITS OWN COLUMN ON THE HOMEROOM BOT TAB (1 Nov 2026,
 * threads, one loop C1). Any private thread of the chat can hold a design
 * (services/design-threads.js); each version is said in the thread with a
 * small picture of it and Open preview (../messages/design-card.tsx), which
 * opens the design pane (../messages/design-pane.tsx) beside the thread:
 *
 *   from 1500px   list | thread | preview     the three side by side
 *   768–1499px    thread | preview            in halves; the list steps aside
 *                                             (the tab, or the preview's ×,
 *                                             brings it back)
 *   a phone       preview                     the whole screen, with a back
 *                                             arrow to the thread
 *
 * Which design is open, and at which version, is this small store's, so the
 * card that opens it and the page that draws it need nothing of each other's.
 * Pure but for that state; no React beyond one hook.
 */

import { useSyncExternalStore } from 'react';

/** The preview open: the thread whose design it is, and the version to show first (null: the newest). */
export interface PreviewAt {
  conversationId: number;
  rootId: number;
  version: number | null;
  /** Counts each open, so a second press on the same version shows it again. */
  seq: number;
}

export type PreviewLayout = 'three' | 'halves' | 'full';

/** Where the three columns fit (the list's 480px, the thread's 440px and a preview of 360px or more, beside the rail). */
export const THREE_COLUMNS = '(min-width: 1500px)';

/** Pure: how the preview stands beside the thread, by the window (phone, then whether three columns fit). */
export function previewLayout({ phone, three }: { phone: boolean; three: boolean }): PreviewLayout {
  if (phone) return 'full';
  return three ? 'three' : 'halves';
}

let open: PreviewAt | null = null;
let seq = 0;
const listeners = new Set<() => void>();
const notify = () => listeners.forEach((fn) => fn());

function valid(id: unknown): id is number {
  return typeof id === 'number' && Number.isSafeInteger(id) && id > 0 && id <= 2147483647;
}

/**
 * Open the preview of the design in thread `rootId` of the bot's chat
 * `conversationId`, at `version` (null: the newest). Off the bot's tab it
 * goes there first, to that thread.
 */
export function openPreview(at: { conversationId: number; rootId: number; version?: number | null }): void {
  if (!valid(at?.conversationId) || !valid(at?.rootId)) return;
  seq += 1;
  open = { conversationId: at.conversationId, rootId: at.rootId, version: valid(at.version) ? at.version : null, seq };
  notify();
  if (typeof window !== 'undefined' && !/^#homeroom-bot(?:\/|$)/.test(window.location.hash)) {
    window.location.hash = `homeroom-bot/thread/${at.rootId}`;
  }
}

/** Close the preview. */
export function closePreview(): void {
  if (!open) return;
  open = null;
  notify();
}

/** The preview open now, or null. Null on the server and in the first render. */
export function usePreview(): PreviewAt | null {
  return useSyncExternalStore(
    (fn) => { listeners.add(fn); return () => { listeners.delete(fn); }; },
    () => open,
    () => null,
  );
}
