/**
 * The group chat composer's three module-fed rows and its status line, for
 * BOTH composers, as view models.
 *
 * ── Two scopes, one shape, and that is the point ──────────────────────
 *
 * The composer exists twice: `general` at the bottom of the chat sub-view,
 * and `thread` inside a topic's thread panel. They are the same control —
 * same reply chip, same attachment strip, same error line, same CSS — drawn
 * by one renderer each side of a `thread ? 'gc-thread-…' : 'gc-…'` ternary in
 * public/js/group-chat.js. Keeping them as two slots of one store keeps that
 * ternary a single decision instead of two components free to drift.
 *
 * Only one of the two is ever in the DOM. The slots exist so the module can
 * publish without first asking which, exactly as it used to write into
 * whichever id was present.
 *
 * ── What stays in group-chat.js ───────────────────────────────────────
 *
 * All of it except the markup: the upload lifecycle and its limits, the
 * object URLs and their revocation, the draft, the typing ping, the offline
 * queue that the status line reports on, and which message a staged reply
 * points at. `_removeAttachmentAt` takes an INDEX because that is what a
 * serialisable view model can carry — the live entry (with its File and its
 * object URL) never leaves the module.
 */

import { createStore } from '../../lib/plain-store.js';

/** The staged reply chip: "↩ Replying to @alice" over a one-line snippet. */
export interface QuoteChipView {
  label: string;
  snippet: string;
}

/** One pending upload, as its chip or thumbnail draws it. */
export interface PendingAttachmentView {
  /** Stable across re-renders of the same strip — the module's own key. */
  key: string;
  name: string;
  kind: string;
  /** MD / HTML / BIN, or null where the kind carries no tag. */
  badge: string | null;
  /** Pre-formatted by the module: "2 KB", "3.0 MB". */
  size: string;
  /** An image's local preview, before the upload finishes. Null otherwise. */
  thumbUrl: string | null;
  /** While true the chip shows "…" instead of a remove control. */
  uploading: boolean;
}

export interface ComposerSlot {
  quote: QuoteChipView | null;
  attachError: string | null;
  attachments: PendingAttachmentView[];
  /**
   * The one-line slot under the messages: who is typing, or — when the
   * socket is down, which wins because it is the actionable one — how many
   * messages are waiting to go out.
   */
  status: string;
}

export type ComposerScope = 'general' | 'thread';

export const EMPTY_SLOT: ComposerSlot = {
  quote: null,
  attachError: null,
  attachments: [],
  status: '',
};

export interface ComposerState {
  general: ComposerSlot;
  thread: ComposerSlot;
}

export const EMPTY_COMPOSER: ComposerState = { general: EMPTY_SLOT, thread: EMPTY_SLOT };

export const composerStore = createStore<ComposerState>(EMPTY_COMPOSER);
