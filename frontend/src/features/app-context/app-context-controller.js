/**
 * The app-context sheet's controller (Streamlined Concept) — window.AppContext.
 *
 * A standing sheet (../../lib/sheet.ts), as Notifications is: this is the name
 * it is opened and closed by, and ./index.tsx presents it through `useSheet`.
 * What stays here is this sheet's own: its panes, and opening straight onto
 * one of them.
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

import { createStandingSheet } from '../../lib/sheet';
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
  createStandingSheet({
    id: 'apps-switcher-sheet',
    store: appContextStore,
  }),
  {
    /** Show the facts about the app in context — the sheet's second pane. */
    showAbout() {
      appContextStore.set({ view: 'about', back: 'menu' });
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
     *
     * From About's Invite the sheet is already open, and `back: 'about'`
     * makes its back disc return there.
     *
     * @param {{ back?: 'about' }} [opts]
     */
    openInvite(opts = {}) {
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
        // Audit D07: from About, Back retraces the step. From anywhere else
        // (the hub's Invite, the Share dialog) the sheet opened on this pane,
        // so there is no menu behind it to go back to: only the close.
        appContextStore.set({ back: opts.back === 'about' ? 'about' : 'none' });
        openAt('invite');
      });
    },
    /** Back to the app's options. */
    showMenu() {
      appContextStore.set({ view: 'menu', back: 'menu' });
    },
    /** The header's back disc: one step back, to the pane this one came from. */
    goBack() {
      const { view, back } = appContextStore.get();
      appContextStore.set({ view: view === 'invite' && back === 'about' ? 'about' : 'menu', back: 'menu' });
    },
  },
);

/**
 * Open the sheet on `view` rather than on the menu. The pane is published
 * first, then the sheet: `open()` publishes `open: true`, and the kit takes
 * the root as that renders and measures it there and then (../../lib/sheet.ts),
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
// controller's type from what createStandingSheet returns, and a later
// `AppContext.showAbout = …` adds a method the callers cannot see.
//
// Closing resets to the menu, so re-opening lands on the pane you asked for
// and never on the one you left.
//
// A SUBSCRIPTION rather than a wrapper around close(), so that every way the
// flag goes down (the kit's swipe and backdrop, Back, Escape, a navigation)
// resets the pane, and there is nothing to keep in step when another way is
// added.
let wasOpen = appContextStore.get().open;
appContextStore.subscribe(() => {
  const { open } = appContextStore.get();
  if (wasOpen && !open) appContextStore.set({ view: 'menu', back: 'menu' });
  wasOpen = open;
});


// The sheet is modal over whatever the address bar now names, so ANY
// client-side navigation dismisses it (found in the shots run: a deep link
// rendered Activity underneath a still-open sheet). Rows call dismissForNav
// themselves; browser back/forward and programmatic fragment writes are the
// Sheet's, which closes a standing sheet on any move away from where it opened.
if (typeof window !== 'undefined') {
  window.AppContext = AppContext;
}
