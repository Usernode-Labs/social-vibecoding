/**
 * The dev chat composer's pending-upload strip, as a view model.
 *
 * The strip itself is ../attachments/pending-strip.tsx's, shared with the
 * group chat's two composers — see that file for why. This holds only what
 * dev-chat.js publishes into it.
 *
 * ── What stays in dev-chat.js ─────────────────────────────────────────
 *
 * `pendingAttachments` and everything that touches it: the upload lifecycle,
 * the object URLs and their revocation, the per-kind badge (including the zip
 * entry count), the size formatting, and `_removeAttachment(idx)` — which
 * takes an index because that is what a serialisable view model can carry.
 */

import { createStore } from '../../lib/plain-store.js';
import type { PendingAttachmentView } from '../attachments/pending-strip';

export interface AttachStripState {
  items: PendingAttachmentView[];
}

export const attachStripStore = createStore<AttachStripState>({ items: [] });
