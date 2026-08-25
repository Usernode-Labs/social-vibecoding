/**
 * The embedded node's status, as one view model for TWO surfaces.
 *
 * ── Why one store and not two ─────────────────────────────────────────
 *
 * The drawer row and the detail sheet are different shapes on screen and the
 * same fact underneath: what is the node doing. `_render` and
 * `_renderSheetBody` were two writers reading one `_status` field, and every
 * `usernode:node-status` event called both. Two stores would have been two
 * copies of that answer, free to disagree for a frame — the rule the dev
 * chat's composer chunk wrote down, on a much smaller surface.
 *
 * ── The empty state is the hidden row ─────────────────────────────────
 *
 * `visible: false` is what the prerender renders, matching the `hidden` the
 * hand-written drawer shipped. The row is revealed for every native top
 * frame — desktop browsers and child-app iframes keep it hidden — and a
 * temporary bridge or provisioning problem must never rewrite navigation, so
 * `visible` and `status` are deliberately separate: an unavailable node is a
 * VISIBLE row reading "Unavailable", not a missing one.
 */

import { createStore } from '../../lib/plain-store.js';

/** From the app's chrome-level provider. `unavailable` is this file's fallback. */
export type NodeStatusKind =
  | 'synced' | 'syncing' | 'connecting' | 'offline' | 'unavailable';

export interface NodePillState {
  visible: boolean;
  status: NodeStatusKind;
  /**
   * The sheet's numbers. Null renders an em dash — the pill's events only fire
   * on state transitions, so these are stale between flips and the sheet
   * re-reads them on open.
   */
  localBestHeight: number | null;
  networkBestHeight: number | null;
  connectedPeers: number | null;
  totalPeers: number | null;
}

export const NODE_PILL_EMPTY: NodePillState = {
  visible: false,
  status: 'unavailable',
  localBestHeight: null,
  networkBestHeight: null,
  connectedPeers: null,
  totalPeers: null,
};

export const nodePillStore = createStore<NodePillState>(NODE_PILL_EMPTY);
