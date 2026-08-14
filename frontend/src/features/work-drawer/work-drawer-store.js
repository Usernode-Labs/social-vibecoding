/**
 * The cog drawer's rendered state (#1191 slice 6, conversion 4).
 *
 * Unlike its twin ./notifications-store.js, this store is imported by the
 * controller directly rather than planted on it. ./work-drawer.js has imported
 * `adoptKitSurface` since #1120, so the four vm harnesses that evaluate its
 * real shipped source already go through tests/helpers/bundle-module.js, which
 * rewrites a static import into a read of an explicit stub table. One more
 * entry in that table is cheaper — and far more honest about the dependency —
 * than the `_store` plant notifications.js and browse.js need because they may
 * not grow an import at all.
 *
 * The VIEW is still computed in the controller. Everything ./work-drawer-list
 * .tsx receives is plain data, so the section builders stay ordinary functions
 * a sandbox can call and assert on — which is exactly what those harnesses do.
 */

import { createStore } from '../../lib/plain-store.js';

/**
 * The initial value is the PRERENDER state. frontend/scripts/build-shell.mjs
 * renders this island in Node, and the hand-written shell shipped
 * #work-drawer-list empty with #work-drawer-empty and #work-drawer-mark-all
 * both carrying `hidden` — which is what these three render.
 */
export const workDrawerStore = createStore({
  /** null until the first _renderList; else the section descriptors, in order. */
  sections: null,
  /** The "nothing in flight" hint. Hidden in the shipped markup. */
  empty: false,
  /** Whether the header's "Mark all read" shows — i.e. whether anything is pinned. */
  markAll: false,
});
