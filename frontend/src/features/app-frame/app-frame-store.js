/**
 * State for the App tab's embedded app frame (#1085 chunk H, step 2).
 *
 * `#app-iframe` is the single most dangerous element in the shell to re-render:
 * it is SOMEONE ELSE'S APPLICATION. Any reconciliation that changes the
 * element's identity — a different `key`, a different sibling position, a
 * conditional wrapper appearing or disappearing above it, a re-mounting parent —
 * restarts the child document and destroys whatever the user had typed inside
 * it. So the shape of this store is chosen to make that impossible:
 *
 * - **`src` is not in here.** It is assigned imperatively through the registered
 *   ref (`appFrameBridge.setSrc`) and nowhere else, exactly as for
 *   `#staging-iframe` (see ../staging/staging-store.js). If it were state, a
 *   re-render could re-apply the `src` prop, and re-applying `src` is a reload
 *   even when the value is unchanged.
 * - **`slug` is the ONLY thing the frame is keyed by.** A different app is a
 *   different frame and must be re-created; nothing else may be.
 * - **`active` is separate from `slug`.** Switching to the Dev tab PARKS the
 *   frame — its host is hidden, the element stays mounted and the app keeps
 *   running. Unmounting it (`slug: ''`) is reserved for genuinely leaving the
 *   app. This is the one deliberate behaviour change in chunk H, and the reason
 *   for it is the paragraph above: before this, App → Dev → App reloaded the
 *   embedded app and lost its state (public/js/app.js says so at the App/Dev
 *   switch: "switchTab('app') re-runs renderAppTab(), which replaces
 *   #app-content's innerHTML and therefore RELOADS the embedded app").
 *
 * React-free on purpose — see ../../lib/plain-store.js.
 */

import { createStore } from '../../lib/plain-store.js';

/**
 * The initial values MUST be the empty/hidden state the hand-written shell
 * prerendered: `#app-frame-host` ships `hidden` and EMPTY (there was no
 * `#app-iframe` in index.html at all), so `slug` is '' and no frame renders.
 * A first render that disagrees with the prerendered document is a hydration
 * mismatch, which `console.error`s and fails proposal checks.
 */
export const appFrameStore = createStore({
  /** Slug of the app whose frame is mounted; '' means no frame at all. */
  slug: '',
  /** Is `#app-frame-host` the visible half of #app-view? (Parked ⇒ false.) */
  active: false,
  /** #931 launch cross-fade: the frame starts at opacity 0 behind the cover. */
  faded: true,
  /** The launch cover, or null once revealed. See COVER_DEFAULTS. */
  cover: null,
});

/**
 * The launch cover's fields, in the order `_launchCoverHtml` emits them.
 *
 * `iconHtml` is the platform's own icon tile markup (`Home.iconTileFor`), which
 * is why it is rendered with `dangerouslySetInnerHTML`; `name` and `note` are
 * RAW text, because React escapes them (the legacy template called escapeHtml
 * itself).
 */
export const COVER_DEFAULTS = {
  iconKind: 'letter',
  iconHtml: '',
  name: '',
  note: 'Opening…',
  /** The 500ms rung of the reveal ladder. */
  spinner: false,
  /** `.app-launch-cover--out` — the 160ms fade before the cover is dropped. */
  out: false,
};

/**
 * The live `#app-iframe` element, registered by the island on mount.
 *
 * A registered ref rather than `document.getElementById`: the bridge must never
 * be able to act on an element React does not currently own, and
 * tests/app-frame-identity.test.js reads exactly what the island published.
 */
export const appFrameRefs = { iframe: null };
