/**
 * The presentation half every platform SHEET shares.
 *
 * Three surfaces present the same way — the app-context sheet behind the
 * header's title tab, Notifications and Messages behind their header glyphs —
 * and they were going to be three copies of the same forty lines. This is
 * that shape, extracted at the third caller: open/close/toggle, the kit sheet
 * adoption on touch with a CSS-slide fallback on desktop, the
 * dismiss-completion promise, and dismissal before a navigation.
 *
 * ── The publish-then-present order is load-bearing ─────────────────────
 *
 * `open()` publishes `open: true` and only THEN hands the element to the kit,
 * because the kit sheet measures the content's height ONCE at present time to
 * seed its slide-up spring. Every caller therefore has to install
 * `store.setFlush(flushSync)` in its mount module, or the publish is still
 * queued when the measurement happens and the sheet springs from nothing.
 *
 * ── One surface at a time ──────────────────────────────────────────────
 *
 * Every controller built here registers itself, and opening one closes the
 * hamburger drawer, the Improve panel and every OTHER registered sheet. The
 * app-context sheet used to do the first two by hand and knew nothing about
 * sheets that did not exist yet; a registry means the third and fourth
 * surface get the courtesy for free, and cannot forget to pay it.
 *
 * ── What it deliberately does NOT own ──────────────────────────────────
 *
 * Routing. A sheet is not a screen: it presents OVER whatever is on screen
 * and dismisses back to it, which is the whole reason Messages and
 * Notifications stopped being screen roots — a full screen needs a back
 * button, and a back button needs to know where it came from. Callers that
 * still answer a deep link (`#notifications`, `#messages/<id>`) resolve it to
 * a real screen first and then open the sheet over it.
 */

import { adoptKitSurface } from './kit-surface';

const REGISTRY = new Set();

/**
 * @param {object} opts
 * @param {string} opts.elementId      The sheet root's id, as the kit adopts it.
 * @param {object} opts.store          A plain-store with an `open` boolean.
 * @param {() => boolean} [opts.canOpen]  Refuse to present when this is false.
 * @param {() => void} [opts.onOpen]      Fired after a successful present.
 * @param {number} [opts.legacyCloseMs]   Must match the CSS transition.
 */
export function createSheetController({
  elementId,
  store,
  canOpen,
  onOpen,
  legacyCloseMs = 200,
  dismissSafetyMs = 500,
}) {
  const controller = {
    _sheet: null,
    _dismissWaiters: [],

    /** Matches the root's transition duration in app.css. */
    LEGACY_CLOSE_MS: legacyCloseMs,
    /** Hard cap on the completion promise — a kit teardown that never fires
        cannot hang a chained presentation forever. */
    DISMISS_SAFETY_MS: dismissSafetyMs,

    isOpen() {
      return !!store.get().open;
    },

    toggle() {
      if (controller.isOpen()) controller.close();
      else controller.open();
    },

    open() {
      if (typeof canOpen === 'function' && !canOpen()) return;
      const panel = document.getElementById(elementId);
      if (!panel) return;
      controller._closeSiblings();

      if (!controller._sheet) {
        // Publish BEFORE presenting — see the header note.
        store.set({ open: true });
        const sheet = adoptSheet(panel, () => {
          controller._sheet = null;
          store.set({ open: false, adopted: false });
          controller._resolveDismissWaiters();
        });
        if (sheet) {
          controller._sheet = sheet;
          // Adopted: the kit's own backdrop dims the scene, and it fades with
          // the sheet's spring — so the web overlay stays down. Left up, it
          // held the dim at full strength through the whole exit and only
          // faded after the teardown, which read as the background snapping
          // (and while open the two 40% backdrops stacked into an over-dim).
          // Published AFTER the present on purpose: the store flush is
          // synchronous, so the overlay's `data-open` never reaches a paint.
          // The hamburger's kit path has always skipped its overlay this way.
          store.set({ adopted: true });
          if (onOpen) onOpen();
          return;
        }
        // Kit refused (desktop, or no kit): the CSS slide presents instead.
      }
      store.set({ open: true });
      if (onOpen) onOpen();
    },

    close() {
      if (controller._sheet) {
        const done = controller._afterDismiss();
        controller._sheet.dismiss();
        return done;
      }
      if (!controller.isOpen()) return Promise.resolve();
      store.set({ open: false });
      const done = controller._afterDismiss();
      setTimeout(() => controller._resolveDismissWaiters(), controller.LEGACY_CLOSE_MS);
      return done;
    },

    /** Close before something else takes the screen underneath. */
    dismissForNav() {
      if (controller.isOpen()) return controller.close();
      return Promise.resolve();
    },

    _closeSiblings() {
      // The Improve panel predates the registry and is not built here.
      window.Improve?.dismissForNav?.();
      for (const other of REGISTRY) {
        if (other !== controller) other.dismissForNav();
      }
    },

    _afterDismiss() {
      return new Promise((resolve) => {
        controller._dismissWaiters.push(resolve);
        setTimeout(resolve, controller.DISMISS_SAFETY_MS);
      });
    },

    _resolveDismissWaiters() {
      const waiters = controller._dismissWaiters;
      controller._dismissWaiters = [];
      for (const resolve of waiters) resolve();
    },
  };

  REGISTRY.add(controller);
  return controller;
}

/**
 * The kit hand-off, in one place so the three sheets present identically.
 * `adoptKitSurface` is already safe to evaluate in the SSG prerender pass —
 * it gates on the kit being present — which is why it can be a plain import
 * here, exactly as ../features/app-context/app-context-controller.js had it.
 */
function adoptSheet(contentEl, onDismiss) {
  return adoptKitSurface({
    kind: 'sheet',
    contentEl,
    home: 'body',
    gate: 'touch',
    onDismiss,
  });
}
