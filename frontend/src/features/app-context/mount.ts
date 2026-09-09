/**
 * The legacy → React seam for the app-context sheet (Streamlined Concept).
 *
 * Same shape as ../improve/mount.ts: install the flush, re-export the pair.
 * The controller publishes `window.AppContext` at its own module scope — the
 * header title tab's tap and any classic script reach it there.
 *
 * `setFlush(flushSync)` is load-bearing for the same reason it is on the
 * Improve store: `AppContext.open()` publishes `open: true` and then hands
 * `#app-context-sheet` to the kit, which measures the content's height ONCE
 * at present time to seed the sheet's slide-up spring.
 */

import { flushSync } from 'react-dom';

import { AppContext } from './app-context-controller.js';
import { appContextStore } from './app-context-store.js';

appContextStore.setFlush(flushSync);

export { appContextStore, AppContext };
