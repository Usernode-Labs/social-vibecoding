/**
 * The staging-preview / visual-compare bridge bodies (#1085 chunk H, step 1).
 *
 * Split out of ./mount.ts, and plain JS with no React import, for one reason:
 * tests/staging-iframe-identity.test.js drives THIS code — the real bridge over
 * the real store — against the real public/js/app-view.js. A bridge that only
 * existed inside a react-dom import could not be exercised by the root test
 * suite (which runs with no frontend/node_modules), and an identity guarantee
 * asserted against a re-implementation is not an identity guarantee.
 *
 * ./mount.ts owns the two things that genuinely need React: pointing each
 * store's flush at `flushSync`, and publishing these objects on
 * `window.UsernodeReact`.
 */

import {
  stagingHandlers,
  stagingRefs,
  stagingStore,
  visualCompareHandlers,
  visualCompareStore,
} from './staging-store.js';

/**
 * Counts genuine `src` assignments on #staging-iframe.
 *
 * The identity test's core assertion: every state change that is NOT a
 * navigation (open, close, dock, un-dock, loader text, testing panel) must
 * leave this untouched, and the element must be the same object throughout.
 */
let navigations = 0;

export const stagingBridge = {
  open() {
    stagingStore.set({ open: true });
  },
  close() {
    stagingStore.set({
      open: false,
      loaderVisible: false,
      testBtnHidden: true,
      testPanelHidden: true,
      testHtml: '',
      fsBtnHidden: true,
    });
  },
  isOpen() {
    return stagingStore.get().open;
  },

  /** #771 — 'docked' | 'fullscreen'. Never touches the iframe. */
  setMode(mode) {
    const docked = mode === 'docked';
    stagingStore.set(docked ? { mode: 'docked' } : { mode: 'fullscreen', dockRect: null });
  },
  mode() {
    return stagingStore.get().mode;
  },
  /** Pin the docked overlay over the dev-chat slot's rect (or release it). */
  setDockRect(rect) {
    const next = rect
      ? {
        top: Math.round(rect.top),
        left: Math.round(rect.left),
        width: Math.round(rect.width),
        height: Math.round(rect.height),
      }
      : null;
    const current = stagingStore.get().dockRect;
    if (next && current
      && current.top === next.top && current.left === next.left
      && current.width === next.width && current.height === next.height) return;
    stagingStore.set({ dockRect: next });
  },

  setUrlLabel(text) {
    stagingStore.set({ urlLabel: text || '' });
  },

  /** #816: an EXPLICIT '' clears a line; `undefined` leaves it alone. */
  setLoader(visible, patch = {}) {
    const next = { loaderVisible: !!visible };
    if (patch.title !== undefined) next.loaderTitle = patch.title;
    if (patch.sub !== undefined) next.loaderSub = patch.sub;
    stagingStore.set(next);
  },

  setTestBtn({ hidden, title } = {}) {
    stagingStore.set({ testBtnHidden: !!hidden, testBtnTitle: title || '' });
  },
  setTestHtml(html) {
    stagingStore.set({ testHtml: html || '' });
  },
  setTestPanelHidden(hidden) {
    stagingStore.set({ testPanelHidden: !!hidden });
  },
  isTestPanelHidden() {
    return stagingStore.get().testPanelHidden;
  },

  setFullscreenBtn({ hidden, text, title } = {}) {
    stagingStore.set({
      fsBtnHidden: !!hidden,
      fsBtnText: text === undefined ? stagingStore.get().fsBtnText : text,
      fsBtnTitle: title || '',
    });
  },

  /** The live iframe element, or null before hydration. */
  frame() {
    return stagingRefs.iframe;
  },
  /**
   * Point the preview at `src`. The ONLY way its `src` ever changes, and an
   * imperative write by design — see staging-store.js.
   */
  setSrc(src) {
    const el = stagingRefs.iframe;
    if (!el || !src) return false;
    navigations += 1;
    el.src = src;
    return true;
  },
  /** `iframe.src = ''` — drops the previous preview without touching the element. */
  clearSrc() {
    const el = stagingRefs.iframe;
    if (el) el.src = '';
  },

  setHandlers(patch) {
    Object.assign(stagingHandlers, patch);
  },

  /** Diagnostics for tests/staging-iframe-identity.test.js. */
  stats() {
    return { navigations };
  },
};

export const visualCompareBridge = {
  open({ label, bodyHtml, openedAt } = {}) {
    visualCompareStore.set({
      open: true,
      openedAt: openedAt || 0,
      label: label || '',
      bodyHtml: bodyHtml || '',
    });
  },
  close() {
    // Clearing the body (rather than only hiding the overlay) is what stops a
    // looping <video> inside a comparison — see #353.
    visualCompareStore.set({ open: false, bodyHtml: '', label: '' });
  },
  openedAt() {
    return visualCompareStore.get().openedAt;
  },
  setHandlers(patch) {
    Object.assign(visualCompareHandlers, patch);
  },
};
