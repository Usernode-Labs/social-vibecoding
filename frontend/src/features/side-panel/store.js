/**
 * The side panel's state (#platform-side-panel), as a plain store.
 *
 * Plain JS on the lib/plain-store.js pattern for the reason every island
 * driven from outside React uses it: the controller that writes it
 * (./controller.ts) is also driven by public/js/app.js — the router says when
 * the running app leaves the screen — and by the panel's own document, and
 * none of that may wait for a render.
 *
 * THE INITIAL STATE IS THE PRERENDER. The island reads this with
 * useStoreState, whose server snapshot is the live store, so anything that
 * differed from these values at hydration would render different markup than
 * the document carries — React #418 on every route. Nothing writes this store
 * before hydration: its only writers are a viewer's click, the router's
 * transition callbacks and the panel document's reports, all of which happen
 * after App.init has run on DOMContentLoaded.
 */

import { createStore } from '../../lib/plain-store.js';

/**
 * @typedef {object} SidePanelState
 * @property {boolean} open      The viewer wants the panel on screen. Close
 *   clears it and keeps the frame, so reopening is a navigation rather than a
 *   second boot.
 * @property {string|null} frameSrc  The address the panel's document was
 *   loaded at, or null for no frame at all. Constant for the life of a frame:
 *   the frame is navigated from inside, never by a new `src`, which would be
 *   a reload.
 * @property {number} frameKey   Bumped each time a new frame is created, so a
 *   frame dropped with the app and a later one are different elements.
 * @property {string|null} route The page the panel shows, as a route (./routes.ts).
 * @property {string} title      The header row's title.
 * @property {boolean} canBack   Is there anywhere for Back to go?
 * @property {boolean} loading   The panel's document has not reported its
 *   first page yet; the frame stays transparent over a spinner until it has.
 */

/** @type {SidePanelState} */
export const INITIAL = {
  open: false,
  frameSrc: null,
  frameKey: 0,
  route: null,
  title: '',
  canBack: false,
  loading: false,
};

export const sidePanelStore = createStore(INITIAL);

/**
 * The live <iframe>, registered by the island's ref. The controller reaches
 * the panel's document through it; nothing renders from it.
 * @type {{ frame: HTMLIFrameElement | null }}
 */
export const sidePanelRefs = { frame: null };
