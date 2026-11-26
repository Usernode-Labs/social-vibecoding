/**
 * THE SHEET: one way to put a card or a sheet over the page.
 *
 * ── What this replaces ────────────────────────────────────────────────
 *
 * Eighteen surfaces handed their own node to the native kit through
 * `adoptKitSurface` (./kit-surface.ts) and then wrote the rest out by hand:
 * the profile cards (friends, app slots, feedback, week share, staking, the
 * editor and its photo step), the ⋯ menu's pop-ups (updates, suggest back,
 * the card picture), the pickers (the Homeroom bot's projects, Messages'
 * project and builder, "Your communities"), and the install and get-app
 * sheets. They agreed on the lift and disagreed on everything around it:
 * some answered the device's Back and some did not, some closed on Escape
 * only while focus happened to be inside them, a few trapped Tab, about half
 * gave focus back to what opened them, and none held the page still.
 *
 * `useSheet` is that whole lifecycle, once. A component that renders while
 * its sheet is open calls it, puts `panelRef` on the node the kit lifts
 * (and `rootRef` on its in-place chrome, for a card), and passes the one
 * thing only it knows: what closing means (`onClose`). The rest is here:
 *
 *   - the kit lift, as the dialogs do it (./static-modal.ts): the same
 *     `adoptKitSurface` with `home: 'placeholder'` and `gate: 'kit'`, the
 *     same accessible name on the kit's shell, and the node brought home
 *     before React removes it (`release()`, which leaves the exit a copy);
 *   - the kit's backdrop or Escape, and the caller's own scrim when there is
 *     no kit (`scrimProps`, with the dialogs' ghost-click guard and their
 *     rule that a press which began inside is not a tap outside);
 *   - Escape, for the topmost sheet, while focus is in it or nowhere. A kit
 *     MODAL already answers Escape itself (topmost first), so this stands
 *     aside for one, and for any key something else has already handled
 *     (`defaultPrevented`: a dialog above, a menu that owns the key);
 *   - the device's Back (./back-stack.ts), released as a navigating close so
 *     a sheet that closes on the way to a link never undoes the link;
 *   - the page held still while it is up (./page-lock.ts, without `inert`:
 *     only the document's own scroll, which is a phone's page);
 *   - focus: into the sheet on open (`initialFocus`, else the kit's rule for
 *     a modal, else the sheet itself), kept inside it on Tab where the kit
 *     does not already keep it, and back to what had it on close.
 *
 * ── Why the dialogs do not use this, and this does not use them ────────
 *
 * The shell's own dialogs are prerendered: their root is in public/index.html
 * from the first paint, hidden, and `useDialog` (features/dialogs/use-dialog.ts)
 * shows and hides it from React state. A sheet here exists only while it is
 * open, so mounting it is opening it and unmounting it is closing it, and
 * there is no `hidden` to own. The two meet in ./static-modal.ts and
 * ./kit-surface.ts, which both go through, so a card looks and leaves the
 * same way whichever of the two put it up.
 */

import { useEffect, useMemo, useRef, useState, type MouseEvent, type PointerEvent, type RefObject } from 'react';

import { pushDismissible } from './back-stack';
import { adoptKitSurface, type KitAdoption } from './kit-surface';
import { useIsomorphicLayoutEffect } from './legacy-dom';
import { lockPage } from './page-lock';
import { MODAL_GESTURE_GUARD_MS, nameKitShell } from './static-modal';

export interface SheetOptions {
  /**
   * How the kit presents it: a centred card that scrolls (`'modal'`, the
   * kit's `presentModal`) or a bottom sheet that drags (`'sheet'`). Kept from
   * each caller as it was; the kit's own sheet cannot scroll a form.
   */
  kind: 'modal' | 'sheet';
  /**
   * Every way out ends here: the kit's backdrop and Escape, the caller's own
   * scrim, Escape, and Back. It must close the sheet, which for a component
   * that renders while open means making its owner stop rendering it.
   */
  onClose: () => void;
  /**
   * Size the kit's modal to the card's own `max-width` rather than the kit's
   * 480px (./kit-surface.ts `hugDesignWidth`).
   */
  hugDesignWidth?: boolean;
  /**
   * Where focus goes on open. For a kit modal it is marked `autofocus` too,
   * because the kit focuses that (or its own shell) once its entrance ends.
   * Without one: the kit's rule for a modal; for anything else the sheet's
   * `[autofocus]`, else the sheet itself when it can take focus.
   */
  initialFocus?: (panel: HTMLElement) => HTMLElement | null | undefined;
}

export interface SheetResult {
  /** On the node the kit lifts: the card, or the sheet's panel. */
  panelRef: RefObject<HTMLDivElement | null>;
  /**
   * On a card's in-place chrome, the node that takes `platform-<kind>-adopted`
   * while the card is lifted (app.css then hides it). Left unattached, the
   * panel takes the class itself, as a bottom sheet's does.
   */
  rootRef: RefObject<HTMLDivElement | null>;
  /** Whether the kit is presenting it; false means the caller's own presentation shows. */
  adopted: boolean;
  /** For the caller's own scrim when there is no kit: a tap on it closes the sheet. */
  scrimProps: {
    onPointerDown: (event: PointerEvent<HTMLElement>) => void;
    onClick: (event: MouseEvent<HTMLElement>) => void;
  };
}

/* ── The open sheets, for the keys ───────────────────────────────────── */

interface OpenSheet {
  contains: (node: Node | null) => boolean;
  /** The kit keeps Escape and Tab for its own modal. */
  kitModal: () => boolean;
  panel: () => HTMLElement | null;
  close: () => void;
}

/** Open sheets, oldest first; the last is the one the keys reach. */
const openSheets: OpenSheet[] = [];

const FOCUSABLE = 'a[href], button:not([disabled]), input:not([disabled]):not([type="hidden"]), '
  + 'select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"]), [contenteditable="true"]';

function focusablesIn(root: HTMLElement): HTMLElement[] {
  return Array.from(root.querySelectorAll<HTMLElement>(FOCUSABLE)).filter((el) => {
    if (el.closest('[hidden], [inert], [aria-hidden="true"]')) return false;
    return el.getClientRects().length > 0;
  });
}

/** Whether nothing in particular has focus: a press on a scrim drops it on <body>. */
function focusLost(active: Element | null): boolean {
  return !active || active === document.body || active === document.documentElement;
}

function onSheetKey(e: KeyboardEvent): void {
  const top = openSheets[openSheets.length - 1];
  if (!top || e.defaultPrevented || top.kitModal()) return;
  if (e.key === 'Escape') {
    // An overlay above the sheet that closes itself (a full-size picture),
    // as the kit's own Escape stands aside for it.
    if (document.querySelector('[data-owns-escape]')) return;
    const active = document.activeElement;
    // Focus in something else (a menu over the sheet, a dialog) is that
    // surface's key, not this one's.
    if (!focusLost(active) && !top.contains(active)) return;
    e.preventDefault();
    top.close();
    return;
  }
  if (e.key !== 'Tab') return;
  const panel = top.panel();
  if (!panel) return;
  const active = document.activeElement;
  const inside = !focusLost(active) && panel.contains(active);
  if (!inside && !focusLost(active)) return;
  const stops = focusablesIn(panel);
  if (!stops.length) return;
  const first = stops[0];
  const last = stops[stops.length - 1];
  let next: HTMLElement | null = null;
  if (!inside) next = e.shiftKey ? last : first;
  else if (e.shiftKey && (active === first || active === panel)) next = last;
  else if (!e.shiftKey && active === last) next = first;
  if (next) {
    e.preventDefault();
    next.focus({ preventScroll: true });
  }
}

function addOpenSheet(entry: OpenSheet): () => void {
  if (!openSheets.length) document.addEventListener('keydown', onSheetKey);
  openSheets.push(entry);
  return () => {
    const at = openSheets.indexOf(entry);
    if (at !== -1) openSheets.splice(at, 1);
    if (!openSheets.length) document.removeEventListener('keydown', onSheetKey);
  };
}

/** How many sheets are open. For tests. */
export function openSheetCount(): number {
  return openSheets.length;
}

/* ── The hook ────────────────────────────────────────────────────────── */

/**
 * Present the calling component's panel as a sheet for as long as the
 * component is mounted. See the header for everything it owns.
 */
export function useSheet(options: SheetOptions): SheetResult {
  const panelRef = useRef<HTMLDivElement | null>(null);
  const rootRef = useRef<HTMLDivElement | null>(null);
  const [adopted, setAdopted] = useState(false);
  const opts = useRef(options);
  opts.current = options;
  // When it opened, for the ghost click that follows the tap that opened it.
  const openedAt = useRef(0);
  // Closing is asked for once: the kit's backdrop, Escape and Back can all
  // land in the same frame, and the owner's close should run one time.
  const closing = useRef(false);
  const close = useMemo(() => () => {
    if (closing.current) return;
    closing.current = true;
    opts.current.onClose();
  }, []);

  useIsomorphicLayoutEffect(() => {
    const panel = panelRef.current;
    if (!panel) return undefined;
    closing.current = false;
    openedAt.current = Date.now();
    const previousFocus = document.activeElement as HTMLElement | null;
    const { kind, hugDesignWidth, initialFocus } = opts.current;
    const target = initialFocus ? initialFocus(panel) : null;
    // The kit focuses `[autofocus]` (else its shell) when a modal has come
    // in, so the target is marked for it. An attribute, not React's
    // `autoFocus`, which focuses on mount, before the lift moves the node.
    if (target && kind === 'modal') target.setAttribute('autofocus', '');

    let live = true;
    let adoption: KitAdoption | null = adoptKitSurface({
      kind,
      contentEl: panel,
      adoptedOn: rootRef.current || undefined,
      home: 'placeholder',
      gate: 'kit',
      hugDesignWidth,
      // The kit's backdrop or Escape. Our own teardown dismisses the kit as
      // well, and that callback lands after the exit; `live` is false by
      // then, so it is ignored.
      onDismiss: () => {
        adoption = null;
        if (live) close();
      },
    });
    // The kit's shell is the dialog while the card is lifted. A root that
    // names and describes the in-place dialog hands those to it; otherwise
    // the card's first heading names it, as the dialogs' does.
    const shell = adoption?.handle.el;
    const root = rootRef.current;
    if (shell && root) {
      for (const attr of ['aria-labelledby', 'aria-describedby']) {
        const value = root.getAttribute(attr);
        if (value) shell.setAttribute(attr, value);
      }
    }
    if (kind === 'modal') nameKitShell(adoption);
    setAdopted(!!adoption);
    const kitModal = !!adoption && kind === 'modal';

    if (!kitModal) {
      const into = target
        || panel.querySelector<HTMLElement>('[autofocus]')
        || (panel.hasAttribute('tabindex') ? panel : null);
      into?.focus({ preventScroll: true });
    }

    const unlock = lockPage(panel, { inert: false });
    const leave = addOpenSheet({
      contains: (node) => !!node && (panel.contains(node) || !!adoption?.handle.el?.contains(node)),
      kitModal: () => !!adoption && kind === 'modal',
      panel: () => panel,
      close,
    });

    return () => {
      live = false;
      leave();
      unlock();
      const handle = adoption;
      adoption = null;
      if (handle) handle.release();
      // Back to what opened it, unless something else has taken focus since
      // (a link that moved the page, a field on the next screen).
      const active = document.activeElement;
      if (previousFocus && previousFocus.isConnected && (focusLost(active) || panel.contains(active))) {
        previousFocus.focus?.({ preventScroll: true });
      }
    };
  }, []);

  // The device's Back closes it (./back-stack.ts). Closed any other way, the
  // claim is handed back as a navigating one: the record is spent a task
  // later, and only if nothing moved, so a sheet closed by a link that
  // navigates never sends the viewer back off the page the link opened.
  useEffect(() => {
    let backed = false;
    const release = pushDismissible(() => {
      backed = true;
      close();
      return true;
    });
    return () => { if (!backed) release({ navigating: true }); };
  }, [close]);

  // The caller's own scrim, when there is no kit: a press that began on it
  // and ended on it, outside the opening tap's ghost click.
  const scrimProps = useMemo(() => {
    let pressedOn = false;
    return {
      onPointerDown: (event: PointerEvent<HTMLElement>) => {
        pressedOn = event.target === event.currentTarget;
      },
      onClick: (event: MouseEvent<HTMLElement>) => {
        const began = pressedOn;
        pressedOn = false;
        if (event.target !== event.currentTarget) return;
        if (Date.now() - openedAt.current < MODAL_GESTURE_GUARD_MS) return;
        // A real press that began inside the sheet (a selection, a slip) is
        // not a tap outside it. A click with no press of its own keeps it.
        if (event.detail > 0 && !began) return;
        close();
      },
    };
  }, [close]);

  return { panelRef, rootRef, adopted, scrimProps };
}
