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

import { flushSync } from 'react-dom';

import { appFrameBridge } from './app-frame-bridge.js';
import { appFrameStore } from './app-frame-store.js';

// `beginLaunch` does `frame.mount(…)` and then immediately `frame.frame()`, to
// assign `src` and arm the reveal ladder in the same tick as the tap. Without a
// synchronous flush React 18 would batch the mount and hand it back a null ref.
appFrameStore.setFlush(flushSync);

export { appFrameBridge };

if (typeof window !== 'undefined') {
  const host = window as unknown as { UsernodeReact?: Record<string, unknown> };
  const bridge = (host.UsernodeReact ||= {});
  bridge.appFrame = appFrameBridge;
}
