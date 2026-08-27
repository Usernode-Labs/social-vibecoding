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
 * One caller outside React: `app-switcher-chip.tsx`'s tap goes through
 * `window.AppContext.toggle()` (published below, the same seam every
 * classic-script-reachable controller uses).
 */

import { createSheetController } from '../../lib/sheet-controller.js';
import { appContextStore } from './app-context-store.js';

// No `canOpen` gate. #1431 had `!!improveStore.get().slug`, which matched the
// title tab it opened: both existed only inside an app. #1443 made the chip
// unconditional and moved the platform's destinations in here, so a menu that
// refuses to open on Home — the one screen you most need it from — would be
// the gate outliving its reason. Nothing about the sheet needs a target now:
// the app-scoped section renders only when there is one.
export const AppContext = createSheetController({
  elementId: 'apps-switcher-sheet',
  store: appContextStore,
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
