/**
 * The app-context sheet's presentation flag (Streamlined Concept).
 *
 * Deliberately TINY: everything the sheet renders — the app's name, its
 * sessions here and elsewhere, the reference footer's facts — is already
 * ../improve/improve-store.js's state, published by the same classic-script
 * writers, and duplicating it would create two descriptions of one app that
 * drift. The one fact this surface owns is whether IT is open, kept apart
 * from the Improve sheet's own `open` so the two sheets can never fight
 * over a single flag.
 */

import { createStore } from '../../lib/plain-store.js';

export const appContextStore = createStore({
  /** Whether the sheet is presented. `data-open` on the root derives from it. */
  open: false,
  /**
   * Which of the sheet's two panes is showing (#2718).
   *
   * `'menu'` is the app's options; `'about'` is the facts about it — the
   * repository, sharing, the version, adding it to a home screen. Two PANES
   * of one sheet rather than two sheets, because the kit cannot present a
   * sheet while it is still dismissing another (the ordering
   * app-context-controller.js already works around for the wallet row), and
   * because "about" is where the menu goes rather than something that opens
   * over it. The header's close button becomes a back arrow on the second.
   *
   * Reset to `'menu'` on every close, so re-opening never lands on the pane
   * you left rather than the one you asked for.
   */
  view: 'menu',
  /**
   * Whether the presentation is a KIT sheet (touch) rather than the CSS
   * slide-over. The kit brings its own backdrop, so the web overlay only
   * raises when this is false — see lib/sheet-controller.js.
   */
  adopted: false,
});
