/**
 * The bell drawer's rendered state (#1191 slice 6, conversion 2).
 *
 * ── Why the controller does not import this file ───────────────────────
 *
 * ./notifications.js is deliberately still an import-free module: nine test
 * harnesses (tests/devchat-alerts.test.js, tests/social-push-web.test.js)
 * evaluate its real shipped source with `vm.runInNewContext`, which compiles a
 * CLASSIC script. The moment it grows a static `import`, all nine die with
 * "Cannot use import statement outside a module" — the exact breakage
 * tests/helpers/bundle-module.js was written to paper over for the modules
 * that genuinely need a seam.
 *
 * The controller does not need one. It reaches this store through
 * `Notifications._store`, planted by ./mount.ts, and no-ops when it is absent
 * — which is precisely the state those sandboxes run in, and the reason they
 * did not have to change.
 *
 * ── Why the VIEW is computed in the controller, not here ───────────────
 *
 * The per-kind row copy has two renderers until slice 6's fourth conversion
 * lands: this island's React rows, and the HTML string
 * `WorkDrawer.renderPendingSection` still splices into #work-drawer-list
 * through `Notifications._renderRow`. Both are built from ONE descriptor —
 * `rowView` in ./notifications.js — so the copy has a single source while the
 * two renderers coexist. Pushing the finished descriptor tree through the
 * store keeps ./notifications-list.tsx purely presentational: it imports
 * nothing from the controller and never reaches for `window`.
 */

import { createStore } from '../../lib/plain-store.js';

/**
 * The initial value is the PRERENDER state, and it has to be: the SSG pass in
 * frontend/scripts/build-shell.mjs renders this island in Node, and the
 * hand-written shell shipped all three containers empty (with #notifications-
 * empty carrying `hidden`). `list: null` and `invites: null` mean "nothing has
 * been fetched yet", which renders exactly that.
 */
export const notificationsStore = createStore({
  /** null until the first _renderInvites; else an array of invite descriptors. */
  invites: null,
  /** null until the first _renderList; else an array of entry descriptors. */
  list: null,
  /** The "you'll get pinged here" hint. Hidden in the shipped markup. */
  empty: false,
  /** PlatformUI.isTouch() at render time — gates the swipe-action wiring. */
  touch: false,
});
