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

import {
  appFrameRefs, appFrameStore, COVER_DEFAULTS, keepAliveLimit, liveAppSlugs,
} from './app-frame-store.js';
import { allowAttribute, BASE_ALLOW, isSafeAppFrameSrc, sameFrameSrc } from './app-frame-policy.js';

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
/** #2902: the last `seq` handed out — see `seq` in ./app-frame-store.js. */
let frames = 0;

/**
 * #2902: the slug whose mounted frame was RESUMED — brought back from being
 * kept alive, document untouched — and has not navigated since. renderAppTab
 * adopts such a frame even though the src it would build carries a newer
 * token than the one the document booted with; see `resumed()`.
 */
let resumedSlug = '';

/** The mounted frame, as a kept-alive record (#2902). */
const keptRecord = (s) => ({
  slug: s.slug,
  seq: s.seq,
  background: s.background,
  sandboxReady: s.sandboxReady,
  allow: s.allow,
  navigatedAt: s.navigatedAt,
  title: s.title,
});

/**
 * Tell an app's document it has been hidden, or shown again (#2902). The
 * shared bridge (public/usernode-bridge/v1/bridge.js) pauses the page's audio
 * and video on `hidden` and resumes what it paused on `visible`, and fires
 * `usernode:visibility-changed` for anything else an app wants to stop. A
 * frame kept alive behind the one on screen must not keep playing into the
 * room. Best-effort: a document without the bridge simply ignores it.
 */
function announce(el, visible) {
  try {
    el?.contentWindow?.postMessage({ __usernode_visibility: visible ? 'visible' : 'hidden' }, '*');
  } catch { /* a frame mid-teardown has nothing to tell */ }
}

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
  mount({ slug, cover = null, faded = true, title = '' } = {}) {
    if (!slug) return false;
    const current = appFrameStore.get();
    const sameFrame = current.slug === slug;
    // The frame's accessible name (QA 2026-09-24 Q20): the caller's app name,
    // else the launch cover's, else whatever this app's frame already had.
    const named = title || (cover && cover.name) || '';
    if (sameFrame) {
      appFrameStore.set({
        active: true,
        faded: !!faded,
        cover: cover ? { ...COVER_DEFAULTS, ...cover } : null,
        title: named || current.title,
      });
      return !!appFrameRefs.iframe;
    }
    // #2902: a DIFFERENT app. The one mounted now is not dropped — if it ever
    // loaded a document it is kept alive, hidden, at the front of the kept
    // list, and the least recently used beyond the limit are let go. If the
    // app being mounted is itself kept, its element comes back (same `key`, so
    // React keeps the node) with the attributes its document was loaded with.
    const restored = current.kept.find((k) => k.slug === slug) || null;
    let kept = current.kept.filter((k) => k.slug !== slug);
    if (current.slug && current.navigatedAt) kept = [keptRecord(current), ...kept];
    kept = kept.slice(0, Math.max(0, keepAliveLimit() - 1));
    if (!restored) mounts += 1;
    const outgoing = current.slug ? appFrameRefs.iframe : null;
    resumedSlug = '';
    appFrameStore.set({
      slug,
      seq: restored ? restored.seq : (frames += 1),
      active: true,
      faded: !!faded,
      // A DIFFERENT app starts from the ungated base. setSrc recomputes it
      // before the navigation that would use it, so this is belt-and-braces
      // rather than the gate — but the belt is one line and what it guards
      // against is one app's camera grant sitting on another app's frame.
      background: restored ? restored.background : '',
      sandboxReady: restored ? restored.sandboxReady : false,
      allow: restored ? restored.allow : BASE_ALLOW,
      navigatedAt: restored ? restored.navigatedAt : 0,
      title: named || (restored && restored.title) || '',
      cover: cover ? { ...COVER_DEFAULTS, ...cover } : null,
      kept,
    });
    if (outgoing && kept.some((k) => k.slug === current.slug)) announce(outgoing, false);
    return !!appFrameRefs.iframe;
  },

  /**
   * #2902: bring `slug`'s frame back exactly as it was left — no cover, no
   * navigation, the same document. True when there was one to bring back:
   * the app's frame is mounted or kept, it has loaded a document, and that
   * load is younger than `maxAgeMs` (the caller passes the token refresh
   * period, past which the document's token is due a refresh anyway and a
   * reload is what would have happened had it stayed on screen). False
   * leaves everything as it was, and the caller launches the ordinary way.
   */
  resume(slug, { maxAgeMs = 0 } = {}) {
    if (!slug) return false;
    const current = appFrameStore.get();
    const fresh = (at) => at > 0 && (!maxAgeMs || Date.now() - at < maxAgeMs);
    if (current.slug === slug) {
      if (!appFrameRefs.iframe || !current.sandboxReady || !fresh(current.navigatedAt)) return false;
      appFrameStore.set({ active: true, faded: false, cover: null });
    } else {
      const kept = current.kept.find((k) => k.slug === slug);
      if (!kept || !kept.sandboxReady || !fresh(kept.navigatedAt)) return false;
      appFrameBridge.mount({ slug, faded: false });
      if (appFrameStore.get().slug !== slug || !appFrameRefs.iframe) return false;
    }
    resumedSlug = slug;
    announce(appFrameRefs.iframe, true);
    return true;
  },

  /**
   * #2902: was the mounted frame for `slug` resumed, and has it not navigated
   * since? Such a frame is the user's document as they left it, and a render
   * must adopt it rather than rebuild it — see renderAppTab.
   */
  resumed(slug) {
    return !!slug && resumedSlug === slug && appFrameStore.get().slug === slug
      && !!appFrameRefs.iframe;
  },

  /** #2902: every app with a live frame, mounted first. */
  liveSlugs() {
    return liveAppSlugs(appFrameStore.get());
  },

  /** #2902: ms since the mounted frame last navigated; 0 if it has not. */
  navigatedAgo() {
    const at = appFrameStore.get().navigatedAt;
    return at ? Math.max(0, Date.now() - at) : 0;
  },

  /**
   * Is the mounted frame already this app at this url? A `true` here is a
   * render that must touch nothing at all.
   */
  keeps({ slug, src } = {}) {
    if (!slug || !src) return false;
    const el = appFrameRefs.iframe;
    if (!el) return false;
    // #3257: a theme toggle since the frame loaded is not a new url.
    return appFrameStore.get().slug === slug && sameFrameSrc(srcOf(el), src);
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
  /**
   * Drop the mounted frame entirely: there is no running app behind it worth
   * keeping (a placeholder, a screenshot state). Frames kept alive for OTHER
   * apps stay as they are.
   */
  unmount() {
    resumedSlug = '';
    appFrameStore.set({
      slug: '', active: false, faded: true, background: '', sandboxReady: false,
      allow: BASE_ALLOW, cover: null, seq: 0, navigatedAt: 0, title: '',
    });
  },

  /**
   * #2902: the app is being LEFT (backing out to Home). Its frame is kept
   * alive, hidden, so reopening it is instant and exactly as it was — unless
   * it never loaded a document, in which case there is nothing to keep and it
   * is dropped like `unmount`.
   */
  retire() {
    const current = appFrameStore.get();
    const el = appFrameRefs.iframe;
    if (!current.slug || !current.navigatedAt || !el) {
      appFrameBridge.unmount();
      return false;
    }
    const kept = [keptRecord(current), ...current.kept.filter((k) => k.slug !== current.slug)]
      .slice(0, keepAliveLimit());
    resumedSlug = '';
    appFrameStore.set({
      slug: '', active: false, faded: true, background: '', sandboxReady: false,
      allow: BASE_ALLOW, cover: null, seq: 0, navigatedAt: 0, title: '', kept,
    });
    announce(el, false);
    return true;
  },

  /**
   * #2902: let one app's frame go — a kept one, or the mounted one. For an app
   * whose build just changed underneath it: the next open loads the new one.
   */
  evict(slug) {
    if (!slug) return false;
    const current = appFrameStore.get();
    if (current.slug === slug) {
      appFrameBridge.unmount();
      return true;
    }
    if (!current.kept.some((k) => k.slug === slug)) return false;
    appFrameStore.set({ kept: current.kept.filter((k) => k.slug !== slug) });
    return true;
  },

  /**
   * #2902: `?shot=apps-kept` only. Stand up kept records for `slugs` as the
   * fully restricted pending frame — `sandboxReady: false`, never navigated
   * — so the dot and the hidden frames can be pictured and checked. Such a
   * record cannot be resumed (resume requires a sandboxed, loaded document);
   * opening the app launches it the ordinary way.
   */
  keepForShot(slugs = []) {
    const current = appFrameStore.get();
    const fresh = slugs.filter((slug) => slug && slug !== current.slug
      && !current.kept.some((k) => k.slug === slug));
    const kept = [
      ...fresh.map((slug) => ({
        slug, seq: (frames += 1), background: '', sandboxReady: false,
        allow: BASE_ALLOW, navigatedAt: Date.now(), title: '',
      })),
      ...current.kept,
    ].slice(0, keepAliveLimit());
    appFrameStore.set({ kept });
    return kept.length;
  },

  /** #2902: let every frame go — sign-out. Nothing of one viewer's apps outlives them. */
  evictAll() {
    appFrameBridge.unmount();
    appFrameStore.set({ kept: [] });
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

  /** Paint iOS's iframe overscroll surface without navigating or remounting it. */
  setBackground(background) {
    if (!appFrameRefs.iframe) return;
    appFrameStore.set({ background: background || '' });
  },

  /**
   * Point the frame at `src`. The ONLY way its `src` ever changes, and an
   * imperative write by design — see app-frame-store.js.
   *
   * `granted` (#2219) is this user's granted capabilities for this app, as
   * the iframe-token mint returned them. It has to arrive HERE, with the
   * navigation, and not a moment later: a frame's Permissions Policy is
   * computed from `allow` when it navigates, so an attribute written after
   * the fact applies to nothing. That is the same two-phase property the
   * sandbox switch below relies on, and the same flushSync carries both.
   *
   * Omitting `granted` narrows the frame to the ungated base rather than
   * leaving the previous app's delegation in place. A caller that has not
   * read the grants yet must not accidentally hand them on.
   */
  setSrc(src, { granted = [] } = {}) {
    const el = appFrameRefs.iframe;
    if (!el || !src) return false;
    const platformOrigin = el.ownerDocument?.defaultView?.location?.origin;
    if (!isSafeAppFrameSrc(src, platformOrigin)) return false;
    // flushSync updates the sandbox AND the permission policy on this same
    // element before the navigation.
    appFrameStore.set({ sandboxReady: true, allow: allowAttribute(granted), navigatedAt: Date.now() });
    resumedSlug = '';
    navigations += 1;
    el.src = src;
    return true;
  },

  /**
   * The delegation the mounted frame's CURRENT document actually holds.
   *
   * Read back off the store rather than the element so it answers the same
   * before and after a render. The permission relay uses it to tell "granted
   * and live" apart from "granted, and this document predates the grant" —
   * the difference between answering the app and reloading it.
   */
  allow() {
    return appFrameStore.get().allow;
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
