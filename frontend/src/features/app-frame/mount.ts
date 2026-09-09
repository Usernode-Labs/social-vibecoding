/**
 * The legacy → React seam for the App tab's app frame (#1085 chunk H, step 2).
 *
 * Same shape as ../staging/mount.ts, and for the same reasons.
 * `public/js/app-view.js` is a classic script that runs before this bundle, so
 * it calls by name: `AppView._appFrame().mount({…})` resolves
 * `window.UsernodeReact.appFrame`. Published at module scope (main.tsx imports
 * this above `hydrateRoot`) because `beginLaunch` runs inside
 * `PlatformUI.transition`'s reveal callback and reads the frame element on its
 * very next line, to arm the load ladder on it.
 *
 * app-view.js keeps an equivalent DOM adapter (`AppView._appFrameDom`) that
 * writes `#app-content` by hand — the pre-chunk-H code path, unchanged — for
 * contexts where this bundle is not present at all. Both implement the same API;
 * exactly one of them is live in any given context, so there is never a second
 * writer for these nodes.
 *
 * The bridge body itself lives in ./app-frame-bridge.js, which imports no React:
 * that is what lets tests/app-frame-identity.test.js drive the real bridge. This
 * file adds the two React-dependent halves.
 *
 * The `typeof window !== 'undefined'` guard is load-bearing: the SSG prerender
 * pass evaluates this whole module graph in Node.
 */

import { createElement } from 'react';
import { flushSync } from 'react-dom';

import { mountLegacyPortal, unmountLegacyPortal } from '../../lib/legacy-portals';
import { appFrameBridge } from './app-frame-bridge.js';
import { appFrameStore } from './app-frame-store.js';
import { AppStatus, type AppStatusView } from './app-status';
import { appStatusStore } from './app-status-store.js';

// `beginLaunch` does `frame.mount(…)` and then immediately `frame.frame()`, to
// assign `src` and arm the reveal ladder in the same tick as the tap. Without a
// synchronous flush React 18 would batch the mount and hand it back a null ref.
appFrameStore.setFlush(flushSync);

/**
 * And the App tab's placeholder states (./app-status.tsx), on their own
 * bridge rather than on `appFrameBridge`: the frame bridge's whole contract
 * is "mutate the element you already have", and app-view.js keeps a DOM twin
 * of it (`_appFrameDom`) that has to implement the same API. A placeholder is
 * neither — it is a region that replaces the frame — so mixing them would
 * force the twin to grow a method it can have no answer for.
 *
 * `renderAppTab` sets the surface and re-reads the host straight after
 * mounting, so this store flushes synchronously too.
 */
appStatusStore.setFlush(flushSync);

export const appStatusBridge = {
  mount(host: Element | null, view: AppStatusView): void {
    appStatusStore.set({ view });
    mountLegacyPortal(host, createElement(AppStatus));
  },
  unmount(host: Element | null): void {
    appStatusStore.set({ view: null });
    unmountLegacyPortal(host);
  },
  /**
   * Forget the published placeholder without touching portals.
   * `_teardownDevRoots` drops every portal in one sweep — including this
   * one — so the host is already gone by the time anything else claims
   * `#app-content`; what is left is the stale view, which would otherwise
   * flash for one frame the next time a placeholder mounted.
   */
  clear(): void {
    appStatusStore.set({ view: null });
  },
};

export { appFrameBridge };

if (typeof window !== 'undefined') {
  const host = window as unknown as { UsernodeReact?: Record<string, unknown> };
  const bridge = (host.UsernodeReact ||= {});
  bridge.appFrame = appFrameBridge;
  bridge.appStatus = appStatusBridge;
}
