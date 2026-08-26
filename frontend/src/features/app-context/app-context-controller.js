/**
 * The app-context sheet's controller (Streamlined Concept) — window.AppContext.
 *
 * The presentation is ../../lib/sheet-controller.js's now — the same chassis
 * Notifications and Messages present through, extracted when they became
 * sheets too. What stays here is the two things that are this sheet's own:
 * it refuses to open without an app in context, and opening it asks the
 * Improve controller to refresh the session lists both surfaces share.
 *
 * The DATA half is deliberately absent — the sheet renders from improveStore.
 *
 * One caller outside React: `header-title-tab.tsx`'s tap goes through
 * `window.AppContext.toggle()` (published below, the same seam every
 * classic-script-reachable controller uses).
 */

import { createSheetController } from '../../lib/sheet-controller.js';
import { improveStore } from '../improve/improve-store.js';
import { Improve } from '../improve/improve-controller.js';
import { appContextStore } from './app-context-store.js';

export const AppContext = createSheetController({
  elementId: 'apps-switcher-sheet',
  store: appContextStore,
  canOpen: () => !!improveStore.get().slug,
  onOpen: () => Improve.loadSessions(),
});

if (typeof window !== 'undefined') {
  window.AppContext = AppContext;
  // The sheet is modal over whatever the address bar now names, so ANY
  // hash-driven navigation dismisses it — rows call dismissForNav
  // themselves, but browser back/forward and programmatic hash writes
  // arrive here instead (found in the evidence run: a deep link rendered
  // Activity underneath a still-open sheet).
  window.addEventListener('hashchange', () => AppContext.dismissForNav());
}
