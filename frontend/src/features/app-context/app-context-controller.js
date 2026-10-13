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
 * The one exception is which PANE is showing, which is presentation and lives
 * in ./app-context-store.js with `open` (see the two-pane note below). The
 * invite pane's read is started here, but it is ./invite-data.ts's: the
 * opener only waits on it, so the sheet goes up once (openInvite).
 *
 * One caller outside React: `../header/platform-mark.tsx`'s tap goes through
 * `window.AppContext.toggle()` (published below, the same seam every
 * classic-script-reachable controller uses).
 */

import { createSheetController } from '../../lib/sheet-controller.js';
import { improveStore } from '../improve/improve-store.js';
import { appContextStore } from './app-context-store.js';
import { prepareInvite } from './invite-data';

/**
 * How long Invite waits for its link before the sheet goes up without it.
 *
 * The sheet goes up at the height of what it first shows, so it waits for
 * the invite pane's answer (./invite-data.ts) and presents once, at the
 * pane's real height. Long enough for the read on a phone, which is about
 * 200ms; short enough that a slow one still answers the tap promptly, with
 * the pane's skeleton standing at the loaded height until the link comes.
 */
export const INVITE_WAIT_MS = 300;

// No `canOpen` gate. #1431 had `!!improveStore.get().slug`, which matched the
// title tab it opened: both existed only inside an app. #1443 made the chip
// unconditional and moved the platform's destinations in here, so a menu that
// refuses to open on Home — the one screen you most need it from — would be
// the gate outliving its reason. Nothing about the sheet needs a target now:
// the app-scoped section renders only when there is one.
export const AppContext = Object.assign(
  createSheetController({
    elementId: 'apps-switcher-sheet',
    store: appContextStore,
  }),
  {
    /** Show the facts about the app in context — the sheet's second pane. */
    showAbout() {
      appContextStore.set({ view: 'about' });
    },
    /**
     * The invite pane, in a sheet that is already open. To OPEN onto it,
     * openInvite() below.
     */
    showInvite() {
      appContextStore.set({ view: 'invite' });
    },
    /**
     * Open straight onto the invite pane: the hub's Invite, the Share
     * dialog's "Invite people". One present, at the pane's own height, with
     * one fade of the dim.
     *
     * It was `open()` then `showInvite()`, which presented the menu and
     * swapped the pane under it, and the pane opened on a one-line "Making
     * your link…" that grew when the link came. The kit measures a sheet when
     * it presents and, when the content grows after, slides it up again and
     * restarts the dim from the share of the sheet that was added: a short
     * rise, then a tall one, with the dim fading in twice.
     *
     * So the pane's state is read first, for up to INVITE_WAIT_MS, and the
     * pane is chosen before the sheet opens (openAt), so the first thing the
     * kit measures is the pane as it will stay.
     */
    openInvite() {
      const { slug } = improveStore.get();
      const ready = slug
        ? Promise.race([
          prepareInvite(slug),
          new Promise((resolve) => { setTimeout(resolve, INVITE_WAIT_MS); }),
        ])
        : Promise.resolve();
      return ready.then(() => {
        // Somewhere else by now (a tab, Back): its project is not in context.
        if (improveStore.get().slug !== slug) return;
        openAt('invite');
      });
    },
    /** Back to the app's options. */
    showMenu() {
      appContextStore.set({ view: 'menu' });
    },
  },
);

/**
 * Open the sheet on `view` rather than on the menu. The pane is published
 * first, then the sheet: `open()` publishes `open: true` and hands the root to
 * the kit, which measures it there and then (../../lib/sheet-controller.js),
 * so the pane it measures has to be the one asked for. Were the open refused
 * (no sheet in the document), the pane goes back to the menu, or the next
 * open from the mark would land on it.
 *
 * @param {'about' | 'invite'} view
 */
function openAt(view) {
  appContextStore.set({ view });
  AppContext.open();
  if (!AppContext.isOpen()) appContextStore.set({ view: 'menu' });
}

// ── The two panes (#2718) ──────────────────────────────────────────────
//
// The sheet shows the app's OPTIONS or the facts ABOUT it, and the second is
// where the first goes rather than something that opens over it. Two panes of
// one sheet, because the kit cannot present a sheet while it is still
// dismissing another — the ordering the wallet row already works around.
//
// The two methods are folded in with Object.assign rather than assigned as
// properties afterwards, because this file is checked: TypeScript infers this
// controller's type from what createSheetController returns, and a later
// `AppContext.showAbout = …` adds a method the callers cannot see.
//
// Closing resets to the menu, so re-opening lands on the pane you asked for
// and never on the one you left.
//
// A SUBSCRIPTION rather than a wrapper around close(), because close() is not
// the only way this sheet goes away: the kit's own dismissal — a swipe, a tap
// on its backdrop — resolves through adoptSheet's callback and publishes
// `open: false` without passing through the controller at all. Watching the
// flag catches every path, including that one, and there is nothing to keep
// in step when another is added.
let wasOpen = appContextStore.get().open;
appContextStore.subscribe(() => {
  const { open } = appContextStore.get();
  if (wasOpen && !open) appContextStore.set({ view: 'menu' });
  wasOpen = open;
});


if (typeof window !== 'undefined') {
  window.AppContext = AppContext;
  // The sheet is modal over whatever the address bar now names, so ANY
  // client-side navigation dismisses it — rows call dismissForNav themselves,
  // but browser back/forward and programmatic fragment writes arrive through
  // these events instead (found in the shots run: a deep link rendered
  // Activity underneath a still-open sheet). Clean pushState navigation uses
  // popstate on traversal; legacy platform routes still use hashchange.
  window.addEventListener('popstate', () => AppContext.dismissForNav());
  window.addEventListener('hashchange', () => AppContext.dismissForNav());
}
