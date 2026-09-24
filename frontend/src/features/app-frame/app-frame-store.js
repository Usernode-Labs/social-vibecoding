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
import { BASE_ALLOW } from './app-frame-policy.js';

/**
 * `cover: null` needs declaring, or `tsc --noEmit` infers the field as `null`
 * and the island cannot read a cover off it. See COVER_DEFAULTS below for what
 * each cover field is.
 *
 * @typedef {{
 *   iconKind: string, iconHtml: string, name: string,
 *   note: string, spinner: boolean, out: boolean,
 * }} LaunchCoverState
 * @typedef {{
 *   slug: string, seq: number, background: string, sandboxReady: boolean,
 *   allow: string, navigatedAt: number,
 * }} KeptFrame
 * @typedef {{
 *   slug: string, active: boolean, faded: boolean, background: string,
 *   sandboxReady: boolean, allow: string, cover: LaunchCoverState | null,
 *   seq: number, navigatedAt: number, kept: KeptFrame[],
 * }} AppFrameState
 */

/**
 * How many apps stay LOADED at once (#2902): the one on screen plus the ones
 * you most recently left, each still running in its own frame, hidden. Resume
 * one and it is exactly where you left it; open one more than this and the
 * least recently used is dropped, and reloads when it is next opened.
 *
 * Three, because each is a whole other document in memory and a phone is where
 * that is felt first. A device that reports being small (Chrome's
 * `navigator.deviceMemory`, in GiB, rounded down) keeps one fewer.
 */
export const KEEP_ALIVE_LIMIT = 3;

/**
 * The limit for this device. `nav` is injectable for the tests.
 *
 * @param {{ deviceMemory?: number } | undefined} [nav]
 */
export function keepAliveLimit(nav = typeof navigator !== 'undefined' ? navigator : undefined) {
  const memory = Number(nav && nav.deviceMemory);
  if (Number.isFinite(memory) && memory > 0 && memory <= 2) return KEEP_ALIVE_LIMIT - 1;
  return KEEP_ALIVE_LIMIT;
}

/**
 * Every app with a live frame right now — the one on screen (or parked behind
 * its Workshop) first, then the kept ones, most recently used first. This is
 * what the green "still loaded" dot reads (Home's tiles, the rail's Recents).
 *
 * @param {AppFrameState} state
 * @returns {string[]}
 */
export function liveAppSlugs(state) {
  const out = [];
  if (state.slug) out.push(state.slug);
  for (const k of state.kept || []) if (k.slug && !out.includes(k.slug)) out.push(k.slug);
  return out;
}

/**
 * The initial values MUST be the empty/hidden state the hand-written shell
 * prerendered: `#app-frame-host` ships `hidden` and EMPTY (there was no
 * `#app-iframe` in index.html at all), so `slug` is '' and no frame renders.
 * A first render that disagrees with the prerendered document is a hydration
 * mismatch, which `console.error`s and fails proposal checks.
 */
export const appFrameStore = createStore(/** @type {AppFrameState} */ ({
  /** Slug of the app whose frame is mounted; '' means no frame at all. */
  slug: '',
  /** Is `#app-frame-host` the visible half of #app-view? (Parked ⇒ false.) */
  active: false,
  /** #931 launch cross-fade: the frame starts at opacity 0 behind the cover. */
  faded: true,
  /** #1581: the embedded document's opaque page color, reported by its bridge. */
  background: '',
  /** False while the source-less blank document must remain fully restricted. */
  sandboxReady: false,
  /**
   * #2219: the frame's Permissions Policy delegation, rebuilt from this
   * user's grants for this app on the line before every navigation.
   *
   * State, where `src` deliberately is not, and the difference is that a
   * re-render re-applying this value is a no-op: React writes the same
   * string to the same attribute and the document is untouched. Re-applying
   * `src` would be a reload. It starts at the ungated base so a frame that
   * navigates before any grant is read delegates nothing extra rather than
   * everything.
   */
  allow: BASE_ALLOW,
  /** The launch cover, or null once revealed. See COVER_DEFAULTS. */
  cover: null,
  /**
   * #2902: the mounted frame's place in the DOM. Every frame gets the next
   * number when it is CREATED and keeps it for life, and the island renders
   * frames in this order — so a frame is only ever appended or removed, never
   * moved. Moving an iframe in the DOM reloads it, which is exactly the loss
   * keeping it alive exists to prevent.
   */
  seq: 0,
  /** #2902: when the mounted frame last navigated (ms), 0 before it has. */
  navigatedAt: 0,
  /**
   * #2902: the apps you left that are still loaded, hidden, most recently used
   * first. The mounted frame is NOT in here; it is the top-level fields above.
   * Resuming one swaps it with the mounted frame without touching either
   * document. Capped by keepAliveLimit() - 1.
   */
  kept: [],
}));

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
 *
 * `kept` (#2902) holds the elements of the apps kept alive behind it, by slug,
 * registered by the same island. The bridge uses them for one thing only: to
 * tell a document it has been hidden or shown again (see `announce` in
 * ./app-frame-bridge.js).
 *
 * @type {{ iframe: HTMLIFrameElement | null, kept: Record<string, HTMLIFrameElement> }}
 */
export const appFrameRefs = { iframe: null, kept: {} };
