/**
 * State for the staging-preview overlay and the before/after compare overlay
 * (#1085 chunk H).
 *
 * Both are written by `public/js/app-view.js`, which is a classic script and
 * cannot import from this bundle, so each store is fed through a bridge on
 * `window.UsernodeReact` (see ./mount.ts). React-free on purpose — see
 * ../../lib/plain-store.js.
 *
 * ── What is NOT in here, and why ───────────────────────────────────────
 *
 * The iframe's `src`. `#staging-iframe` is rendered exactly once and every
 * change to what it displays is an imperative assignment through a ref
 * (`stagingBridge.setSrc`, `stagingBridge.clearSrc`). If `src` were state, a
 * React re-render would carry it — and a render that re-creates the element,
 * or a `src` prop React decides to re-apply, RELOADS the preview. #771's whole
 * design is that the docked ↔ fullscreen toggle is "the same element, same
 * iframe: toggling never reloads the preview", and the loader/testing-panel
 * states have the same requirement.
 *
 * Click handlers are not state either: they live in a mutable holder the
 * island reads through stable dispatchers, so re-pointing "Back to session"
 * (what `back.onclick = …` used to do) never re-renders anything.
 */

import { createStore } from '../../lib/plain-store.js';

/**
 * `null` and `0` initial values need declaring, or `tsc --noEmit` infers the
 * literal's own type (`null`, `never`) and every island that reads the field
 * fails to compile.
 *
 * @typedef {{ top: number, left: number, width: number, height: number }} DockRect
 * @typedef {{
 *   open: boolean, mode: string, dockRect: DockRect | null, urlLabel: string,
 *   loaderVisible: boolean, loaderTitle: string, loaderSub: string,
 *   testBtnHidden: boolean, testBtnTitle: string, testPanelHidden: boolean,
 *   testHtml: string, fsBtnHidden: boolean, fsBtnText: string, fsBtnTitle: string,
 * }} StagingState
 * @typedef {{ open: boolean, openedAt: number, label: string, bodyHtml: string }} VisualCompareState
 */

/**
 * The initial values MUST equal the markup the hand-written shell shipped —
 * the overlay is hidden, the loader is hidden, its title reads
 * "Opening preview…" (#816: neutral, promising no wait) and its sub-line is
 * empty. A first render that disagrees with the prerendered document is a
 * hydration mismatch, which `console.error`s and fails proposal checks.
 */
export const stagingStore = createStore(/** @type {StagingState} */ ({
  open: false,
  /** 'fullscreen' | 'docked' (#771). */
  mode: 'fullscreen',
  /** Pinned rect while docked: { top, left, width, height } | null. */
  dockRect: null,
  urlLabel: '',
  loaderVisible: false,
  loaderTitle: 'Opening preview…',
  loaderSub: '',
  testBtnHidden: true,
  testBtnTitle: '',
  testPanelHidden: true,
  /** Sanitized markdown from DevChat.renderMarkdown, or escaped plain text. */
  testHtml: '',
  fsBtnHidden: true,
  fsBtnText: 'Full screen',
  fsBtnTitle: '',
}));

/**
 * The live `#staging-iframe` element, registered by the island on mount.
 *
 * A registered ref rather than `document.getElementById`: the bridge must never
 * be able to act on an element React does not currently own, and the identity
 * test in tests/staging-iframe-identity.test.js reads exactly what the island
 * published.
 */
/** @type {{ iframe: HTMLIFrameElement | null }} */
export const stagingRefs = { iframe: null };

/**
 * Click handlers, re-pointed by app-view.js where it used to assign `.onclick`.
 *
 * @type {Record<'onBack' | 'onDockClose' | 'onFullscreen' | 'onTest' | 'onTestingClose',
 *   ((ev?: Event) => void) | null>}
 */
export const stagingHandlers = {
  onBack: null,
  onDockClose: null,
  onFullscreen: null,
  onTest: null,
  onTestingClose: null,
};

export const visualCompareStore = createStore(/** @type {VisualCompareState} */ ({
  open: false,
  /**
   * `Date.now()` at open, rendered as `data-opened-at` so
   * `AppView.modalDismissGuarded` keeps swallowing the opening tap's ghost
   * click exactly as it does for the hand-written modals (it reads
   * `dataset.openedAt`).
   */
  openedAt: 0,
  label: '',
  /** Built by AppView.openVisualComparison from server-side capture ids. */
  bodyHtml: '',
}));

/**
 * Same holder pattern as the staging overlay's.
 *
 * @type {Record<'onBack' | 'onBackdrop', ((ev?: Event) => void) | null>}
 */
export const visualCompareHandlers = {
  onBack: null,
  /** Called only for a click on the overlay root itself, never a child. */
  onBackdrop: null,
};
