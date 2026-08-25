/**
 * The app-context sheet's controller (Streamlined Concept) — window.AppContext.
 *
 * The presentation half of ../improve/improve-controller.js, cloned for the
 * sheet behind the header's center title tab: open/close/toggle, the kit
 * sheet adoption on touch, the dismiss-completion promise, and dismissal
 * before a row navigates. The DATA half is deliberately absent — the sheet
 * renders from improveStore, and opening it simply asks the Improve
 * controller to refresh the session lists both surfaces share.
 *
 * One caller outside React: `header-title-tab.tsx`'s tap goes through
 * `window.AppContext.toggle()` (published below, the same seam every
 * classic-script-reachable controller uses).
 */

import { adoptKitSurface } from '../../lib/kit-surface';
import { improveStore } from '../improve/improve-store.js';
import { Improve } from '../improve/improve-controller.js';
import { appContextStore } from './app-context-store.js';

export const AppContext = {
  _sheet: null,

  /** Matches #apps-switcher-sheet's transition in app.css. */
  LEGACY_CLOSE_MS: 200,
  /** Hard cap on the completion promise — a kit teardown that never fires
      cannot hang a chained presentation forever. */
  DISMISS_SAFETY_MS: 500,
  _dismissWaiters: [],

  toggle() {
    if (appContextStore.get().open) AppContext.close();
    else AppContext.open();
  },

  open() {
    if (!improveStore.get().slug) return;
    const panel = document.getElementById('apps-switcher-sheet');
    if (!panel) return;
    // One surface at a time — the same courtesy every drawer pays the others.
    if (window.HeaderMenu?.isPresenting?.()) window.HeaderMenu.close?.();
    window.Improve?.dismissForNav?.();

    if (!AppContext._sheet) {
      // Publish `open` BEFORE presenting: the kit sheet measures the
      // content's height once at present time to seed its slide-up spring
      // (the store's injected flushSync makes the write synchronous).
      appContextStore.set({ open: true });
      const sheet = adoptKitSurface({
        kind: 'sheet',
        contentEl: panel,
        home: 'body',
        gate: 'touch',
        onDismiss: () => {
          AppContext._sheet = null;
          appContextStore.set({ open: false });
          AppContext._resolveDismissWaiters();
        },
      });
      if (sheet) {
        AppContext._sheet = sheet;
        Improve.loadSessions();
        return;
      }
      // Kit refused (desktop, or no kit): the CSS slide below presents.
    }
    appContextStore.set({ open: true });
    Improve.loadSessions();
  },

  close() {
    if (AppContext._sheet) {
      const done = AppContext._afterDismiss();
      AppContext._sheet.dismiss();
      return done;
    }
    if (!appContextStore.get().open) return Promise.resolve();
    appContextStore.set({ open: false });
    const done = AppContext._afterDismiss();
    setTimeout(() => AppContext._resolveDismissWaiters(), AppContext.LEGACY_CLOSE_MS);
    return done;
  },

  _afterDismiss() {
    return new Promise((resolve) => {
      AppContext._dismissWaiters.push(resolve);
      setTimeout(resolve, AppContext.DISMISS_SAFETY_MS);
    });
  },

  _resolveDismissWaiters() {
    const waiters = AppContext._dismissWaiters;
    AppContext._dismissWaiters = [];
    for (const resolve of waiters) resolve();
  },

  /** Close before a row navigates — on touch the sheet is modal over the
      destination; on desktop the slide-over covers it just the same. */
  dismissForNav() {
    if (appContextStore.get().open) AppContext.close();
  },
};

if (typeof window !== 'undefined') {
  window.AppContext = AppContext;
  // The sheet is modal over whatever the address bar now names, so ANY
  // hash-driven navigation dismisses it — rows call dismissForNav
  // themselves, but browser back/forward and programmatic hash writes
  // arrive here instead (found in the evidence run: a deep link rendered
  // Activity underneath a still-open sheet).
  window.addEventListener('hashchange', () => AppContext.dismissForNav());
}
