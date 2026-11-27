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
 *
 * ── Standing sheets: the Homeroom menu and Notifications ───────────────
 *
 * Two sheets are prerendered like the dialogs and opened by name from
 * classic scripts and the header (`window.AppContext`,
 * `window.NotificationsSheet`): their roots are always in the document, and
 * `data-open` slides them on the web. They had a presentation route of their
 * own (lib/sheet-controller.js), the third beside this and the dialogs', with
 * its own kit lift, Back claim and dismissal; each island wrote its own
 * Escape on top, and the menu its own outside press. They are this Sheet's
 * now. `createStandingSheet` is the name the callers open and close; `useSheet`
 * with `open` presents it while its flag is up, with what makes the two
 * different spelled as options rather than as a second implementation:
 *
 *   - `gate: 'touch'` and `home: 'body'`: the kit takes them on a phone only,
 *     and they wait on <body> between presentations; elsewhere `data-open`
 *     slides them, and `exitMs` is how long that takes to leave;
 *   - `surface`: they hold the one-open-panel slot (./open-surfaces.ts), and
 *     answer Escape while they are the top surface, wherever focus is, since
 *     the header stays live beside them;
 *   - `holdPage: false` and `trapFocus: false`: the page and the header stay
 *     usable beside them, as they always were;
 *   - `outside`: the menu is a popover under the mark on the web, with no
 *     scrim, so a press outside it (or in the running app's frame) closes it.
 */

import { useEffect, useMemo, useRef, useState, type MouseEvent, type PointerEvent, type RefObject } from 'react';

import { pushDismissible } from './back-stack';
import { kitSheetTakesEscape } from './kit-escape';
import { adoptKitSurface, type KitAdoption } from './kit-surface';
import { useIsomorphicLayoutEffect } from './legacy-dom';
import { claimSurface, isTopSurface } from './open-surfaces';
import { lockPage } from './page-lock';
import { useAnchoredDismiss } from './popover-dismiss';
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
  /**
   * A standing sheet (see the header): its panel is always rendered, and it
   * is presented while this is true. Left out, it is presented for as long
   * as the calling component is mounted.
   */
  open?: boolean;
  /**
   * When the kit takes it: whenever it is loaded (`'kit'`, the default), on
   * touch only, or never (`'none'`): a sheet its caller draws in place, as
   * the first session's are, which the Sheet still closes, holds focus in
   * and answers Back for.
   */
  gate?: 'kit' | 'touch' | 'none';
  /** Where the panel waits while the kit does not hold it (./kit-surface.ts). Default `'placeholder'`. */
  home?: 'placeholder' | 'body';
  /** Hold the page still while it is up (default true). */
  holdPage?: boolean;
  /** Keep Tab inside it (default true). */
  trapFocus?: boolean;
  /**
   * Its key in the one-open-panel list (./open-surfaces.ts), which its owner
   * claims. Escape then reaches it while it is the top surface there,
   * wherever focus is, rather than only while focus is in it.
   */
  surface?: string;
  /**
   * Close on a press outside it, for a sheet drawn with no scrim (the web
   * menu under the mark). A press in a frame counts, read from this side as
   * the window losing focus to it. `inside` spares more of the page: its
   * opener, a tour pointing into it. Only while the kit does not hold it;
   * the kit's backdrop takes that press itself.
   */
  outside?: { inside?: (target: Element) => boolean };
  /** How long its own presentation takes to leave (a CSS slide), for `onExited`. */
  exitMs?: number;
  /** Once it has left the screen: the kit's exit ended, or `exitMs` after it closed. */
  onExited?: () => void;
  /**
   * Whether Escape may close it now (default: always). The first session's
   * invite sheet says no while the OS share sheet is over it, whose own
   * Escape reaches the page too.
   */
  mayEscape?: () => boolean;
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
  /** The kit holds it as a bottom sheet, which never answers Escape itself (./kit-escape.ts). */
  kitSheet: () => boolean;
  panel: () => HTMLElement | null;
  close: () => void;
  /** Its key in ./open-surfaces.ts, for a sheet that holds a slot there. */
  surface?: string;
  trap: boolean;
  mayEscape: () => boolean;
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
    if (top.surface) {
      // #6981: a sheet in the one-open-panel list answers while it is on top
      // there (the welcome tour may stand over the menu), wherever focus is:
      // the header stays live beside it, and the bell keeps focus.
      if (!isTopSurface(top.surface)) return;
    } else {
      const active = document.activeElement;
      // Focus in something else (a menu over the sheet, a dialog) is that
      // surface's key, not this one's.
      if (!focusLost(active) && !top.contains(active)) return;
    }
    // Held by the kit as a bottom sheet: not while a kit surface is above it.
    if (top.kitSheet() && !kitSheetTakesEscape(e, document, top.panel())) return;
    if (!top.mayEscape()) return;
    e.preventDefault();
    top.close();
    return;
  }
  if (e.key !== 'Tab' || !top.trap) return;
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

/**
 * How many sheets are open: a screen's own Escape stands aside while one is
 * up over it (the make screen under "Something else…"), and tests count.
 */
export function openSheetCount(): number {
  return openSheets.length;
}

/* ── The hook ────────────────────────────────────────────────────────── */

/**
 * Present the calling component's panel as a sheet for as long as the
 * component is mounted, or, for a standing sheet, while `open` is true. See
 * the header for everything it owns.
 */
export function useSheet(options: SheetOptions): SheetResult {
  const panelRef = useRef<HTMLDivElement | null>(null);
  const rootRef = useRef<HTMLDivElement | null>(null);
  const [adopted, setAdopted] = useState(false);
  const opts = useRef(options);
  opts.current = options;
  const standing = options.open !== undefined;
  const up = options.open !== false;
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
    if (!up) return undefined;
    const panel = panelRef.current;
    if (!panel) return undefined;
    closing.current = false;
    openedAt.current = Date.now();
    const previousFocus = document.activeElement as HTMLElement | null;
    const {
      kind, hugDesignWidth, initialFocus, gate = 'kit', home = 'placeholder',
      holdPage = true, trapFocus = true, surface,
    } = opts.current;
    const target = initialFocus ? initialFocus(panel) : null;
    // The kit focuses `[autofocus]` (else its shell) when a modal has come
    // in, so the target is marked for it. An attribute, not React's
    // `autoFocus`, which focuses on mount, before the lift moves the node.
    if (target && kind === 'modal') target.setAttribute('autofocus', '');

    let live = true;
    // This presentation has left the screen, told once.
    let gone = false;
    const exited = () => {
      if (gone) return;
      gone = true;
      opts.current.onExited?.();
    };
    let adoption: KitAdoption | null = gate === 'none' ? null : adoptKitSurface({
      kind,
      contentEl: panel,
      adoptedOn: rootRef.current || undefined,
      home,
      gate,
      hugDesignWidth,
      // The kit's backdrop or Escape. Our own teardown dismisses the kit as
      // well, and that callback lands after the exit; `live` is false by
      // then, so it only reports the exit.
      onDismiss: () => {
        adoption = null;
        if (live) close();
        exited();
      },
    });
    // Held by the kit, it reports its own exit (above); otherwise the exit is
    // the caller's own presentation, `exitMs` long.
    const byKit = !!adoption;
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

    const unlock = holdPage ? lockPage(panel, { inert: false }) : null;
    const leave = addOpenSheet({
      contains: (node) => !!node && (panel.contains(node) || !!adoption?.handle.el?.contains(node)),
      kitModal: () => !!adoption && kind === 'modal',
      kitSheet: () => !!adoption && kind === 'sheet',
      panel: () => panel,
      close,
      surface,
      trap: trapFocus,
      mayEscape: () => opts.current.mayEscape?.() ?? true,
    });

    return () => {
      live = false;
      leave();
      unlock?.();
      const handle = adoption;
      adoption = null;
      // Its exit plays on a copy, and ends in `onDismiss` above.
      if (handle) handle.release();
      else if (!byKit && opts.current.onExited) setTimeout(exited, opts.current.exitMs || 0);
      // A standing sheet stays rendered: the next opening starts unadopted.
      if (standing) setAdopted(false);
      // Back to what opened it, unless something else has taken focus since
      // (a link that moved the page, a field on the next screen).
      const giveBack = () => {
        const active = document.activeElement;
        if (previousFocus && previousFocus.isConnected && (focusLost(active) || panel.contains(active))) {
          previousFocus.focus?.({ preventScroll: true });
        }
      };
      // A standing sheet's panel stays in the document, and React puts focus
      // back on the row it had before the commit this teardown runs in; so it
      // is given back once that commit is over.
      if (standing) queueMicrotask(giveBack);
      else giveBack();
    };
  }, [up]);

  // The device's Back closes it (./back-stack.ts). Closed any other way, the
  // claim is handed back as a navigating one: the record is spent a task
  // later, and only if nothing moved, so a sheet closed by a link that
  // navigates never sends the viewer back off the page the link opened.
  useEffect(() => {
    if (!up) return undefined;
    let backed = false;
    const release = pushDismissible(() => {
      backed = true;
      close();
      return true;
    });
    return () => { if (!backed) release({ navigating: true }); };
  }, [close, up]);

  // A press outside it, for a sheet with no scrim (`outside`): the shared
  // anchored dismissal (./popover-dismiss.ts), which lets the press land.
  const outside = up && !adopted && !!options.outside;
  useAnchoredDismiss(outside, [panelRef], close, {
    escape: false,
    move: false,
    also: (target) => !!opts.current.outside?.inside?.(target),
  });
  // And a press in a frame (#4260): the running app is another document, so
  // the press itself is never heard here. The window blurs and the frame
  // becomes the active element, which is that press read from this side, on
  // a mouse and a finger alike. Switching tabs or windows blurs too, but
  // leaves the active element where it was, so it closes nothing.
  useEffect(() => {
    if (!outside) return undefined;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const onBlur = () => {
      // The active element moves after the blur event, not before it.
      timer = setTimeout(() => {
        const active = document.activeElement;
        if (!active || active.tagName !== 'IFRAME') return;
        if (panelRef.current?.contains(active) || opts.current.outside?.inside?.(active)) return;
        close();
      }, 0);
    };
    window.addEventListener('blur', onBlur);
    return () => {
      window.removeEventListener('blur', onBlur);
      if (timer) clearTimeout(timer);
    };
  }, [outside, close]);

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

/* ── Standing sheets: the names the callers open them by ─────────────── */

/** A store with an `open` flag: the standing sheet's own (./plain-store.js). */
interface OpenFlagStore {
  get(): { open: boolean };
  set(patch: { open: boolean }): void;
}

export interface StandingSheetOptions {
  /** The root's id: its slot in ./open-surfaces.ts, and the sheet a field keeps focus in. */
  id: string;
  /**
   * Its `open` flag, which `useSheet` presents. Its mount module installs
   * `setFlush(flushSync)`, so opening has presented by the time `open()`
   * returns (`onOpen`, a caller's next line).
   */
  store: OpenFlagStore;
  /** After every `open()`, the sheet already up included. */
  onOpen?: () => void;
  /** The web presentation's slide out, in ms (app.css). */
  slideMs?: number;
  /** The longest a close's promise waits for an exit that never reports. */
  safetyMs?: number;
}

export interface StandingSheet {
  isOpen(): boolean;
  open(): void;
  toggle(): void;
  /** Resolves once it has left the screen, so the next surface can come up. */
  close(): Promise<void>;
  /** `close()`, before something else takes the screen underneath. */
  dismissForNav(): Promise<void>;
  /** Spread into `useSheet` beside `open`: how it is presented, and what closing means. */
  readonly present: Pick<SheetOptions,
    'kind' | 'gate' | 'home' | 'holdPage' | 'trapFocus' | 'surface' | 'exitMs' | 'onClose' | 'onExited'>;
}

/**
 * The input types that are NOT text entry: a sheet opened from another sheet
 * keeps whatever control had focus, and a menu, a button or a checkbox is not
 * holding a keyboard up.
 */
const NON_TEXT_INPUT_TYPES = new Set([
  'checkbox', 'radio', 'button', 'submit', 'reset', 'range', 'file', 'color',
  'image', 'hidden',
]);

/** Is `el` a field a keyboard is (or would be) open for? */
function isTextField(el: Element | null): el is HTMLElement {
  if (!el || typeof el !== 'object') return false;
  if ((el as HTMLElement).isContentEditable === true) return true;
  const tag = typeof el.tagName === 'string' ? el.tagName.toUpperCase() : '';
  if (tag === 'TEXTAREA') return true;
  if (tag !== 'INPUT') return false;
  const type = typeof el.getAttribute === 'function' ? el.getAttribute('type') : null;
  return !NON_TEXT_INPUT_TYPES.has(String(type || 'text').toLowerCase());
}

/**
 * Put away the keyboard of a field BEHIND the sheet that is opening (#6813).
 *
 * iOS does not take focus from a text field when a button is tapped, so
 * opening the bell while typing left the keyboard up; the kit rides the
 * sheet on the keyboard, so the sheet opened lifted above the screen with
 * only its last row visible. A field INSIDE the sheet keeps its focus: that
 * is the sheet's own search box, and the sheet fits above the keys.
 */
function blurFocusedFieldOutside(panel: HTMLElement): void {
  const active = typeof document !== 'undefined' ? document.activeElement : null;
  if (!isTextField(active)) return;
  if (typeof panel.contains === 'function' && panel.contains(active)) return;
  if (typeof active.blur === 'function') active.blur();
}

function currentHref(): string | null {
  try { return window.location.href; } catch { return null; }
}

/** Standing sheets, with the address each was opened at. */
const standing = new Map<StandingSheet, { openedAt: () => string | null }>();

// ANY OTHER NAVIGATION CLOSES AN OPEN STANDING SHEET. The header stays live
// beside one, and code can write an address with one up; left open, its Back
// record would end up under the new page, and the next Back would close it
// there instead of going back. Only a move AWAY from the address it opened at
// counts: the deep link that opened it (#notifications, rewritten to the
// screen underneath before the sheet presents) can still be delivering its
// own hashchange.
if (typeof window !== 'undefined' && typeof window.addEventListener === 'function') {
  const closeOnNavigation = () => {
    const here = currentHref();
    for (const [sheet, at] of standing) {
      const openedAt = at.openedAt();
      if (sheet.isOpen() && openedAt && openedAt !== here) void sheet.dismissForNav();
    }
  };
  window.addEventListener('hashchange', closeOnNavigation);
  window.addEventListener('popstate', closeOnNavigation);
}

/**
 * The name a standing sheet is opened and closed by. Its presentation is
 * `useSheet({ open, ...sheet.present })` in the component that renders it.
 */
export function createStandingSheet({
  id,
  store,
  onOpen,
  slideMs = 200,
  safetyMs = 500,
}: StandingSheetOptions): StandingSheet {
  // Whoever waits for this sheet to leave the screen.
  let waiters: Array<() => void> = [];
  let releaseSurface: (() => void) | null = null;
  let openedAt: string | null = null;

  const settle = () => {
    const waiting = waiters;
    waiters = [];
    for (const resolve of waiting) resolve();
  };
  const afterExit = () => new Promise<void>((resolve) => {
    waiters.push(resolve);
    // A teardown that never reports cannot hang a chained presentation.
    setTimeout(resolve, safetyMs);
  });
  const releaseSlot = () => {
    const release = releaseSurface;
    releaseSurface = null;
    release?.();
  };

  const sheet: StandingSheet = {
    isOpen: () => !!store.get().open,

    open() {
      const panel = document.getElementById(id);
      if (!panel) return;
      // One open panel at a time: this closes the others, the other standing
      // sheet among them, each through its own close.
      const claim = claimSurface(id, 'sheet', () => { void sheet.dismissForNav(); });
      releaseSurface?.();
      releaseSurface = claim;
      blurFocusedFieldOutside(panel);
      if (!sheet.isOpen()) {
        openedAt = currentHref();
        store.set({ open: true });
      }
      onOpen?.();
    },

    toggle() {
      if (sheet.isOpen()) void sheet.close();
      else sheet.open();
    },

    close() {
      // At the START of the close, so a sheet that is still leaving is never
      // closed again by another opening panel.
      releaseSlot();
      if (!sheet.isOpen()) return waiters.length ? afterExit() : Promise.resolve();
      const done = afterExit();
      openedAt = null;
      store.set({ open: false });
      return done;
    },

    dismissForNav() {
      return sheet.isOpen() ? sheet.close() : Promise.resolve();
    },

    present: {
      kind: 'sheet',
      gate: 'touch',
      home: 'body',
      holdPage: false,
      trapFocus: false,
      surface: id,
      exitMs: slideMs,
      onClose: () => { void sheet.close(); },
      onExited: settle,
    },
  };
  standing.set(sheet, { openedAt: () => openedAt });
  return sheet;
}
