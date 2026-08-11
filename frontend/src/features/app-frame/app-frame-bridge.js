/**
 * The App tab's app-frame bridge (#1085 chunk H, step 2).
 *
 * Split out of ./mount.ts, and plain JS with no React import, for one reason:
 * tests/app-frame-identity.test.js drives THIS code — the real bridge over the
 * real store — against the real public/js/app-view.js. An identity guarantee
 * asserted against a re-implementation is not an identity guarantee.
 *
 * `public/js/app-view.js` calls every method here by name through
 * `AppView._appFrame()`, which resolves `window.UsernodeReact.appFrame` or falls
 * back to `AppView._appFrameDom` — an adapter with this exact API that keeps
 * writing `#app-content` by hand for contexts where this bundle is not present.
 * Exactly one of the two is live in any context, so no node ever has two
 * writers.
 *
 * ── The one method whose answer differs between the two adapters ──────────
 *
 * `keeps({ slug, src })`. The React bridge says yes when the mounted frame is
 * already this app at already this url, which is what makes a tab switch and a
 * chromeless exit free. The DOM adapter says no, always: it has no frame that
 * survives an `#app-content` write, so "rebuild" is the only truthful answer it
 * can give — and that is exactly the pre-chunk-H behaviour the vm-context tests
 * pin. The difference is the point of the chunk, not a leak.
 */

import { appFrameRefs, appFrameStore, COVER_DEFAULTS } from './app-frame-store.js';

/** Frames created. A tab switch must NEVER move this. */
let mounts = 0;
/**
 * Genuine `src` assignments on #app-iframe — i.e. document loads.
 *
 * tests/app-frame-identity.test.js's core assertion: every state change that is
 * not a navigation (tab switch, chromeless enter/exit, staging preview open and
 * close, surface flip, cover reveal) must leave this untouched AND leave the
 * element the same object; a token refresh moves it by exactly one, on that
 * same element.
 */
let navigations = 0;

const srcOf = (el) => (el && typeof el.getAttribute === 'function' ? el.getAttribute('src') : null) || '';

export const appFrameBridge = {
  /**
   * Show the frame host with a frame for `slug`, optionally behind a launch
   * cover. Mounting the app that is ALREADY mounted only re-activates it —
   * `slug` is unchanged, so React keeps the element.
   *
   * Returns whether a frame element is live afterwards, which is what
   * `beginLaunch` needs before it can arm the reveal ladder on it. The store's
   * flush is `flushSync` (see ./mount.ts), so the ref is registered by the time
   * this returns.
   */
  mount({ slug, cover = null, faded = true } = {}) {
    if (!slug) return false;
    if (appFrameStore.get().slug !== slug) mounts += 1;
    appFrameStore.set({
      slug,
      active: true,
      faded: !!faded,
      cover: cover ? { ...COVER_DEFAULTS, ...cover } : null,
    });
    return !!appFrameRefs.iframe;
  },

  /**
   * Is the mounted frame already this app at this url? A `true` here is a
   * render that must touch nothing at all.
   */
  keeps({ slug, src } = {}) {
    if (!slug || !src) return false;
    const el = appFrameRefs.iframe;
    if (!el) return false;
    return appFrameStore.get().slug === slug && srcOf(el) === src;
  },

  /** Reveal the (already mounted) frame host — the App tab is on screen again. */
  activate() {
    if (!appFrameStore.get().slug) return false;
    appFrameStore.set({ active: true });
    return true;
  },
  /**
   * Hide the frame host and hand #app-content back to whatever is painting
   * there (Dev mode, a status placeholder). The frame stays mounted and the app
   * keeps running — see the `active` note in ./app-frame-store.js.
   */
  park() {
    appFrameStore.set({ active: false });
  },
  isActive() {
    return appFrameStore.get().active;
  },
  /** Drop the frame entirely: the app is being left, not parked. */
  unmount() {
    appFrameStore.set({ slug: '', active: false, faded: true, cover: null });
  },

  slug() {
    return appFrameStore.get().slug;
  },
  /** The live element, or null before hydration / while unmounted. */
  frame() {
    return appFrameRefs.iframe;
  },
  hasFrame() {
    return !!appFrameRefs.iframe;
  },

  /**
   * Point the frame at `src`. The ONLY way its `src` ever changes, and an
   * imperative write by design — see app-frame-store.js.
   */
  setSrc(src) {
    const el = appFrameRefs.iframe;
    if (!el || !src) return false;
    navigations += 1;
    el.src = src;
    return true;
  },

  /**
   * Install the frame's load handler.
   *
   * `el.onload = fn` rather than `addEventListener`, deliberately: the element
   * now outlives a render, so a listener added per render would stack. The
   * property slot holds one handler, and the reveal ladder
   * (`AppView.watchSurfaceLoad`) writes the same slot — the two are alternative
   * paths over the same frame, never concurrent.
   */
  setOnLoad(fn) {
    const el = appFrameRefs.iframe;
    if (!el) return false;
    el.onload = fn || null;
    return true;
  },

  // ── The launch cover (#931) ─────────────────────────────────────────────
  hasCover() {
    return !!appFrameStore.get().cover;
  },
  coverSpinner(visible) {
    appFrameStore.set((s) => (s.cover ? { ...s, cover: { ...s.cover, spinner: !!visible } } : s));
  },
  coverNote(text) {
    appFrameStore.set((s) => (s.cover ? { ...s, cover: { ...s.cover, note: text || '' } } : s));
  },
  /**
   * Cross-fade the app in and the cover out. `reduceMotion` drops the cover
   * outright (the CSS kills both transitions on that path anyway); otherwise
   * the caller drops it after LAUNCH_FADE_MS, exactly as `cover.remove()` used
   * to be scheduled.
   */
  reveal({ reduceMotion = false } = {}) {
    appFrameStore.set({ faded: false });
    if (!appFrameStore.get().cover) return false;
    if (reduceMotion) {
      appFrameStore.set({ cover: null });
      return false;
    }
    appFrameStore.set((s) => (s.cover ? { ...s, cover: { ...s.cover, out: true } } : s));
    return true;
  },
  dropCover() {
    appFrameStore.set({ cover: null });
  },

  /** Diagnostics for tests/app-frame-identity.test.js. */
  stats() {
    return { mounts, navigations };
  },
};
