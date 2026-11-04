/**
 * A DESIGN'S PREVIEW — now the detail column with a design in it (#6230,
 * 3 Nov 2026). The store, the layout rule and the address live in
 * ./detail.ts; this is the design card's and the design pane's spelling of
 * them, kept so those files and their tests read the same as before:
 *
 *   from 1500px   list | thread | preview     the three side by side
 *   768–1499px    thread | preview            in halves; the list steps aside
 *   a phone       preview                     the whole screen, with a back
 *                                             arrow to the thread
 */

import { closeDetail, openDetail, useDetail, detailLayout as layoutOf, THREE_COLUMNS } from './detail';

export type PreviewLayout = 'three' | 'halves' | 'full';

export { THREE_COLUMNS };

/** Pure: how the preview stands beside the thread, by the window. */
export function previewLayout({ phone, three }: { phone: boolean; three: boolean }): PreviewLayout {
  return layoutOf('bot', { phone, wide: three });
}

/** Open the preview of the design in thread `rootId` of the chat `conversationId`, at `version` (null: the newest). */
export function openPreview(at: { conversationId: number; rootId: number; version?: number | null; from?: string | null }): void {
  openDetail({ kind: 'design', ref: { conversationId: at?.conversationId, rootId: at?.rootId }, version: at?.version ?? null, from: at?.from ?? null });
}

/** Close the preview. */
export function closePreview(): void {
  closeDetail();
}

/** The design preview open now, or null. */
export function usePreview(): { conversationId: number; rootId: number; version: number | null; seq: number } | null {
  const entry = useDetail();
  if (!entry || entry.kind !== 'design' || !entry.ref.conversationId || !entry.ref.rootId) return null;
  return { conversationId: entry.ref.conversationId, rootId: entry.ref.rootId, version: entry.version, seq: entry.seq };
}
