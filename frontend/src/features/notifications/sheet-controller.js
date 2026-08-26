/**
 * `window.NotificationsSheet` — presentation for the notifications sheet
 * (#1436).
 *
 * ── Why the bell came back ─────────────────────────────────────────────
 *
 * THE UI OVERHAUL merged it into the hamburger, on the reasoning that two
 * top-right drawers opening the same way one slot apart were one affordance
 * too many. That reasoning was right about the DRAWERS and wrong about the
 * destination: it left "what happened while I was away" as a list inside an
 * unlabeled menu, one level down from where you look for it.
 *
 * #1436 does not undo the merge so much as finish it. The hamburger is gone
 * entirely — its trigger is the labeled app-switcher chip on the left now —
 * so the bell is no longer a second drawer beside a first one. It is the only
 * control that opens this surface, and it carries the badge that names it.
 *
 * The ids are the ORIGINAL ones. `#notifications-btn`, `#notifications-badge`
 * and `#notifications-panel` were retired by the overhaul and are un-retired
 * here rather than replaced with new spellings, which is what lets
 * `Notifications._renderBadge` keep painting the same node with no change at
 * all, and what keeps the declared checks that resolve them meaningful.
 *
 * ── Presentation is the Improve panel's, not a third idiom ─────────────
 *
 * Same `adoptKitSurface({ kind: 'sheet', gate: 'touch' })` call, same
 * `data-open` attribute switch, same `.shell-sheet` rules in app.css — which
 * #1436 generalised out of `#improve-panel` for exactly this reason. A third
 * hand-rolled sheet is how two sheets start disagreeing about how far up the
 * screen they may come and what dismisses them.
 *
 * ── One surface at a time ──────────────────────────────────────────────
 *
 * Opening this closes the Improve panel and the switcher menu, and both of
 * those close this — the same courtesy the bell and cog drawers used to pay
 * each other. Without it a tap on the bell with the switcher open leaves two
 * modal surfaces stacked, and on the kit path the second `present` steals the
 * node out from under the first one's teardown.
 */

import { adoptKitSurface } from '../../lib/kit-surface';

import { notificationsSheetStore } from './sheet-store.js';

export const NotificationsSheet = {
  /** @type {import('../../lib/kit-surface').KitSurfaceHandle|null} */
  _sheet: null,

  /** Matches #notifications-panel's transition in app.css. */
  LEGACY_CLOSE_MS: 200,

  isPresenting() {
    return Boolean(notificationsSheetStore.get().open);
  },

  open() {
    const panel = document.getElementById('notifications-panel');
    if (!panel) return;

    // Close whatever else is modal first. Read through `window` rather than
    // importing: these are sibling surfaces, and importing each other's
    // controllers would make the three of them one dependency knot.
    const w = /** @type {any} */ (window);
    if (w.HeaderMenu?.isPresenting?.()) w.HeaderMenu.close?.();
    if (w.UsernodeReact?.improve?.isPresenting?.()) w.UsernodeReact.improve.close?.();

    // ONCE, above the touch/desktop fork, because both presentations are the
    // surface becoming visible and a listener that had to know which one it
    // was would be reading an implementation detail.
    NotificationsSheet._announceOpen();

    if (!NotificationsSheet._sheet) {
      // Publish BEFORE presenting: the kit measures the content's height once
      // at present time to seed the slide-up spring, and plain-store's
      // injected flushSync means React has painted the rows by the time
      // adoptKitSurface reads the element. Batched, the sheet springs to the
      // height of the previous frame — an empty panel.
      notificationsSheetStore.set({ open: true });
      const sheet = adoptKitSurface({
        kind: 'sheet',
        contentEl: panel,
        home: 'body',
        gate: 'touch',
        onDismiss: () => {
          NotificationsSheet._sheet = null;
          notificationsSheetStore.set({ open: false });
        },
      });
      if (sheet) {
        NotificationsSheet._sheet = sheet;
        return;
      }
      // The kit refused (desktop, or no kit). adoptKitSurface has already
      // rolled its own bookkeeping back and the CSS slide-over below is the
      // presentation; `open` is published, so there is nothing more to do.
    }
    notificationsSheetStore.set({ open: true });
  },

  close() {
    if (NotificationsSheet._sheet) {
      // The kit's exit spring calls onDismiss, which publishes `open: false`.
      // Publishing it here too would empty the sheet a frame before it began
      // animating out.
      NotificationsSheet._sheet.dismiss();
      return;
    }
    if (!notificationsSheetStore.get().open) return;
    notificationsSheetStore.set({ open: false });
  },

  toggle() {
    if (NotificationsSheet.isPresenting()) NotificationsSheet.close();
    else NotificationsSheet.open();
  },

  /**
   * Close before a row navigates. Same contract as `Improve.dismissForNav`:
   * on touch the sheet is modal over the screen a notification is about to
   * take you to, so it has to come down first.
   */
  dismissForNav() {
    if (NotificationsSheet.isPresenting()) NotificationsSheet.close();
  },

  /**
   * The same announcement `HeaderMenu._announceOpen()` made, under the same
   * name, dispatched once above the touch/desktop fork because both
   * presentations are "the surface became visible".
   *
   * `./notifications.js` listens for it and re-collapses every group, which is
   * the requirement rather than a preference to remember: a list that reopens
   * with yesterday's groups unrolled buries today's rows under them. Keeping
   * the EVENT rather than calling a method is what leaves notifications.js
   * untouched by this move.
   */
  _announceOpen() {
    try {
      document.dispatchEvent(new CustomEvent('sv:drawer-open'));
    } catch { /* a browser too old for CustomEvent */ }
  },
};

if (typeof window !== 'undefined') {
  /** @type {any} */ (window).NotificationsSheet = NotificationsSheet;
}
