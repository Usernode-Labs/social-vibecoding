/**
 * The Settings screen's two navigation hosts (#1191 slice 6, conversion 8 —
 * the last surface in the slice).
 *
 * `#settings-nav-desktop` and `#settings-mobile-menu-host` were the only two
 * nodes on this screen that ../settings.js ever innerHTML-wrote. The section
 * panes are NOT here and are not converting: settings.js binds every control
 * inside them by id exactly once in init(), so a rebuilt pane is a pane whose
 * controls silently stop working. That is a real conversion of its own —
 * the binding code has to move with the markup — and it is deferred.
 *
 * ONE descriptor per host rather than one shared object, because the two
 * hosts genuinely paint at different rates: `_renderNav()` always refreshes
 * the sidebar, but the mobile menu is cleared to `null` whenever the viewport
 * is desktop or the user has drilled into a section. Keeping them apart means
 * a desktop section switch does not re-key the (empty) menu, and the phone's
 * level-2 state is spelled as `mobile: null` rather than as an empty list.
 *
 * `null` on either side means "nothing rendered here yet", which is also the
 * PRERENDER state: both hosts ship empty in the hand-written shell, and
 * ./settings-nav.tsx renders exactly that from `null`. Data lands in
 * `Settings.init()` → `_renderNav()`, i.e. in an effect, never in the initial
 * render.
 *
 * PLANTED, not imported. ../settings.js is a classic IIFE with no exports at
 * all, and tests/settings-mobile-push.test.js evaluates its real source with
 * `vm.runInContext` — no module loader, so an `import` there is a syntax
 * error. ./mount.ts plants this store on `Settings._store`, and every write
 * goes through `?.` so both that vm and the SSG prerender pass see a no-op.
 */

import { createStore } from '../../lib/plain-store.js';

export const settingsNavStore = createStore({
  /** The #settings-nav-desktop descriptor (see Settings._navView), or null. */
  desktop: null,
  /**
   * The #settings-mobile-menu-host descriptor (see Settings._menuView), or
   * null — which is both "not rendered yet" and "this host is empty right
   * now", exactly as the empty-string innerHTML write meant before.
   */
  mobile: null,
});
