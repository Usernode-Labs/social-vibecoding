/**
 * The installed mobile app's version row, as a view model (#1101).
 *
 * ── Why this one needed no bridge ─────────────────────────────────────
 *
 * `native-app-version.js` is imported by ./header-menu.tsx, so it is an
 * ordinary module in this bundle and imports the store directly — the same
 * arrangement ../improve/improve-controller.js has, and unlike dev-chat.js,
 * which a dozen `vm`-based tests load as a classic SCRIPT and which therefore
 * has to reach React by name.
 *
 * ── The empty string IS the hidden row ────────────────────────────────
 *
 * `frontend/scripts/build-shell.mjs` prerenders the drawer in Node from this
 * initial value, so it has to describe the row the hand-written shell shipped:
 * present, empty and `hidden`. The value arrives from a bridge read in an
 * effect, never from render — a first render that disagrees with the
 * prerendered document is a hydration mismatch, and a console error on any
 * route fails proposal checks.
 *
 * ── Why it is not part of the drawer's own store ──────────────────────
 *
 * ../improve/improve-store.js is the PANEL's state. This is one row's, owned
 * by a different feature, published from a native bridge read that has nothing
 * to do with the panel's open/closed lifecycle. Folding it in would mean the
 * whole drawer re-renders when a version string lands, and would put a header
 * concern inside the improve feature's model.
 */

import { createStore } from '../../lib/plain-store.js';

export interface NativeAppVersionState {
  /**
   * `appVersion` or `appVersion/buildNumber`, already formatted and clamped by
   * the module. Empty means no conclusive read yet, which is the hidden row —
   * this is never the open dApp's commit hash.
   */
  value: string;
}

export const nativeAppVersionStore = createStore<NativeAppVersionState>({ value: '' });
