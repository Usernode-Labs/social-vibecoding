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

/** What the message says about a draft, shown until the saved row is read. */
export interface PreviewDraftCopy {
  title: string;
  project: string;
  details: string;
  appSlug: string | null;
}

/**
 * The preview open. A design's: the thread whose design it is, and the
 * version to show first (null: the newest). A request draft's (#6248): the
 * offer it draws, in the thread it was said in, or in Main (rootId null).
 */
export interface PreviewAt {
  conversationId: number;
  /** The thread the design or the draft is in; null for a draft said in Main. */
  rootId: number | null;
  version: number | null;
  /** What is being previewed: a thread's design, or a request draft waiting to be filed. */
  kind: 'design' | 'draft';
  /** A draft's offer (`homeroom_bot_dm_actions.id`); null for a design. */
  actionId: number | null;
  /** The message's own copy of a draft, until the pane reads the saved row. */
  copy: PreviewDraftCopy | null;
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
  open = {
    conversationId: at.conversationId, rootId: at.rootId, version: valid(at.version) ? at.version : null,
    kind: 'design', actionId: null, copy: null, seq,
  };
  notify();
  if (typeof window !== 'undefined' && !/^#homeroom-bot(?:\/|$)/.test(window.location.hash)) {
    window.location.hash = `homeroom-bot/thread/${at.rootId}`;
  }
}

/**
 * #6248: open the preview of a request draft the bot offered to file. It is
 * read only: the card keeps File it and Not now. Off the bot's tab it goes
 * there first, to the thread the draft was said in (or Main).
 */
export function openDraftPreview(at: { conversationId: number; rootId: number | null; actionId: number; copy?: PreviewDraftCopy }): void {
  if (!valid(at?.conversationId) || !valid(at?.actionId)) return;
  if (at.rootId !== null && at.rootId !== undefined && !valid(at.rootId)) return;
  const rootId = valid(at.rootId) ? at.rootId : null;
  seq += 1;
  open = { conversationId: at.conversationId, rootId, version: null, kind: 'draft', actionId: at.actionId, copy: at.copy || null, seq };
  notify();
  if (typeof window !== 'undefined' && !/^#homeroom-bot(?:\/|$)/.test(window.location.hash)) {
    window.location.hash = rootId === null ? 'homeroom-bot/main' : `homeroom-bot/thread/${rootId}`;
  }
}

/**
 * Pure: whether this preview stands beside the column's place. A design is
 * in a thread, so it needs that thread open; a draft said in Main (rootId
 * null) is shown while Main is the column's, and one in a thread while that
 * thread is.
 */
export function previewBeside(preview: Pick<PreviewAt, 'rootId'> | null, openRoot: number | null | undefined): boolean {
  return !!preview && preview.rootId === (openRoot ?? null);
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
