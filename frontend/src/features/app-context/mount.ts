/**
 * The legacy → React seam for the app-context sheet (Streamlined Concept).
 *
 * Same shape as ../improve/mount.ts: install the flush, re-export the pair.
 * The controller publishes `window.AppContext` at its own module scope — the
 * header title tab's tap and any classic script reach it there.
 *
 * `setFlush(flushSync)` is load-bearing: `AppContext.open()` publishes
 * `open: true`, and the sheet is presented (lib/sheet.ts `useSheet`) before it
 * returns, so a caller's next line (the tour pointing at a row) finds it up.
 */

import { flushSync } from 'react-dom';

import { AppContext } from './app-context-controller.js';
import { appContextStore } from './app-context-store.js';
// Publishes window.PlatformTarget at module scope — before App.init, whose
// first route is the first thing that may ask it (Home.publishImproveTarget,
// on a cold load of any tab but Home). See the file's header.
import './platform-target.js';

appContextStore.setFlush(flushSync);

export { appContextStore, AppContext };
