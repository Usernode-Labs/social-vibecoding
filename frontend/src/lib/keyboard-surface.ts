import { useEffect, useRef, type RefObject } from 'react';

import { KB_OPEN_CLASS } from './keyboard-open';

/**
 * A FULL-SCREEN SURFACE'S FIELDS WITH THE KEYBOARD UP (iPhone 17 simulator,
 * iOS 26 Safari, 5 Oct 2026).
 *
 * The sign-in sheet's password step (features/auth/sign-in-sheet.tsx) had
 * its Sign in button behind the keyboard and the password field half under
 * the keyboard's floating bar; the first session's "What do you want to
 * make?" (features/first-session/make.tsx) had "Make it" under that bar once
 * a press had scrolled the form. Two things put them there, and app.css plus
 * lib/keyboard-open.ts take the first away: the surface was laid out over
 * the whole page with the keys over its foot, and it is now padded into the
 * band the reader can see (`.platform-kb-surface`, `.platform-kb-sheet`).
 *
 * The second is iOS's own reveal. A tapped field is revealed by PANNING the
 * page, which carries a fixed surface up with it: the make screen's wordmark
 * went off the top of the glass, and the pan reveals the field alone, never
 * the button under it. So, as the kit does for its own modals (native.js
 * `attachModalFieldFocus`) and for a chat's scroller
 * (`attachKeyboardAvoidance`), this takes the tap on a text field inside the
 * surface's scroller and focuses the field with `preventScroll`: no pan.
 * That includes the first tap on a field focused from code (both screens put
 * the caret in their first field when they open), which iOS raises no
 * keyboard for and which it would otherwise reveal natively on that tap.
 *
 * Then it reveals, inside the scroller, once the keyboard has settled: the
 * field, and with it its form's submit button when the two fit together, so
 * "Sign in" and "Make it" are on screen as the keys come up. The arithmetic
 * reads only the scroller's own box, which already ends where the keys
 * begin. It never reads `innerHeight` (iOS collapses it to the visual
 * viewport with the keys up) and never assumes a height for what iOS draws
 * above the keys: if the form bar goes, the band grows and the field and the
 * button still sit right on the keys.
 *
 * A focus moved by code while the keyboard is up (Return to the next field,
 * "Make it" to a missing answer, the sheet's next step) is revealed the same
 * way; callers focus with `preventScroll` so that is the only movement. So
 * is a field whose form grows under it with the keys up (the make screen's
 * "Say what it should do first." line arriving under the description pushed
 * Make it 8px under the keys in the harness): the scroller's content is
 * watched for size while the keys are up. A
 * field that already has its keys keeps its native taps (caret, selection),
 * a drag past the slop is a scroll, not a tap, and a finger the kit's
 * gesture arbiter has given to a recognizer is left alone.
 *
 * A bottom sheet also RIDES the keys (`ride`): when the keyboard's arrival
 * or departure moves it by a keyboard's height in one step (Safari's band
 * changing in the viewport's first event, or the app's web view being
 * resized), it is put back where it was with a `translate` and eased to its
 * new place over the keys' own quarter second, as the kit's sheet rides
 * `--un-kb-inset`. One movement, transform only (the Web Animations API, so
 * no style or class of the sheet's is touched and its own open and close
 * transitions compose with it), and none with reduced motion.
 *
 * Structural no-op on a desktop, without `visualViewport`, or without the
 * kit. Nothing is written to the DOM but the scroller's scrollTop and, for a
 * ride, a short-lived animation.
 */

/** px of finger travel that makes a tap a drag (the kit's KB_TAP_SLOP). */
export const TAP_SLOP = 8;
/** Quiet after the last visualViewport event before revealing (ms; the kit's KB_SETTLE_MS). */
export const SETTLE_MS = 120;
/** Reveal anyway when no viewport event follows a focus (ms): a hardware keyboard, or a host that reports late. */
export const FALLBACK_MS = 400;
/** Air kept between a revealed field and the scroller's edges (px). */
export const REVEAL_MARGIN = 12;
/** A ride lasts as long as the keys take to come up (ms). */
export const RIDE_MS = 250;
/** Only a keyboard-sized step is ridden (px): a host resizing frame by frame moves a little each time. */
export const RIDE_MIN = 100;

/** Where a sheet that moved from `from` to `to` (its layout top, px) starts its ride, as a translate; null for no ride. */
export function rideOffset(from: number | null | undefined, to: number, reduced = false): number | null {
  if (reduced || from == null || !Number.isFinite(from) || !Number.isFinite(to)) return null;
  const d = Math.round(from - to);
  return Math.abs(d) >= RIDE_MIN ? d : null;
}

/**
 * The scrollTop that brings a field into the scroller's view, with the
 * button under it when both fit. All in one coordinate space (viewport px):
 * `viewTop`/`viewBottom` are the scroller's visible box, the rest are the
 * field's and the button's. Moves as little as it can, never past the
 * scroller's range, and never scrolls a field taller than the view past its
 * own top.
 */
export function revealScrollTop(input: {
  scrollTop: number;
  scrollMax: number;
  viewTop: number;
  viewBottom: number;
  fieldTop: number;
  fieldBottom: number;
  actionTop?: number | null;
  actionBottom?: number | null;
  margin?: number;
}): number {
  const margin = input.margin == null ? REVEAL_MARGIN : input.margin;
  const top = input.viewTop + margin;
  const bottom = input.viewBottom - margin;
  let want = input.fieldBottom;
  // The button too, when it is under the field and the two fit.
  if (input.actionTop != null && input.actionBottom != null
    && input.actionTop >= input.fieldTop
    && input.actionBottom - input.fieldTop <= bottom - top) {
    want = Math.max(want, input.actionBottom);
  }
  let delta = 0;
  if (want > bottom) delta = Math.min(want - bottom, Math.max(0, input.fieldTop - top));
  else if (input.fieldTop < top) delta = input.fieldTop - top;
  const max = Math.max(0, input.scrollMax);
  return Math.max(0, Math.min(max, Math.round(input.scrollTop + delta)));
}

type FieldLike = Element & {
  type?: string;
  readOnly?: boolean;
  disabled?: boolean;
  isContentEditable?: boolean;
  form?: HTMLFormElement | null;
  focus(options?: FocusOptions): void;
  blur(): void;
};

type KitLike = {
  platform?: string;
  physics?: { keyboardCanBeUp?: (input: unknown) => boolean } | null;
  gestures?: { owner?: (seq: string) => unknown } | null;
} | null | undefined;

type SizeObserverLike = new (callback: () => void) => { observe(target: Element): void; disconnect(): void };

type WinLike = {
  unNative?: KitLike;
  ResizeObserver?: SizeObserverLike;
  visualViewport?: (Pick<EventTarget, 'addEventListener' | 'removeEventListener'>) | null;
  matchMedia?: (query: string) => { matches: boolean };
  requestAnimationFrame?: (fn: () => void) => unknown;
  setTimeout: (fn: () => void, ms: number) => unknown;
  clearTimeout: (id: unknown) => void;
  addEventListener?: (type: string, fn: () => void, options?: unknown) => void;
  removeEventListener?: (type: string, fn: () => void, options?: unknown) => void;
};

type DocLike = {
  activeElement: Element | null;
  documentElement: { classList: { contains(name: string): boolean } };
};

/** A text field the keyboard serves, inside `scroller`, at or above `target`. */
function fieldAt(target: unknown, scroller: Element, kit: KitLike): FieldLike | null {
  const node = target as Element | null;
  if (!node || (node as Node).nodeType !== 1 || typeof node.closest !== 'function') return null;
  const field = node.closest('input, textarea, [contenteditable]') as FieldLike | null;
  if (!field || !scroller.contains(field)) return null;
  const classify = kit?.physics?.keyboardCanBeUp;
  if (typeof classify !== 'function') return null;
  try {
    return classify({
      tag: field.tagName,
      type: field.type,
      readOnly: !!field.readOnly,
      disabled: !!field.disabled,
      contentEditable: !!field.isContentEditable,
    }) ? field : null;
  } catch {
    return null;
  }
}

/** The submit button of the field's form, when it is inside the scroller too. */
function actionOf(field: FieldLike, scroller: Element): Element | null {
  const form = field.form || (field.closest ? field.closest('form') : null);
  const button = form ? form.querySelector('button[type="submit"], input[type="submit"]') : null;
  return button && scroller.contains(button) ? button : null;
}

/**
 * Take taps on the scroller's text fields without iOS's pan, and reveal the
 * focused field (and its form's button) inside the scroller once the
 * keyboard has settled. Returns the detach.
 */
export function attachKeyboardSurface(
  scroller: HTMLElement | null | undefined,
  win: WinLike | undefined = typeof window !== 'undefined' ? (window as unknown as WinLike) : undefined,
  doc: DocLike | undefined = typeof document !== 'undefined' ? (document as unknown as DocLike) : undefined,
  options: { ride?: boolean } = {},
): () => void {
  const kit = win?.unNative;
  const vv = win?.visualViewport;
  if (!scroller || !win || !doc || !vv || !kit || kit.platform === 'desktop') return () => {};

  let touch: { x: number; y: number; moved: boolean } | null = null;
  let pending: FieldLike | null = null;
  let settle: unknown = null;
  let fallback: unknown = null;
  // Fields focused from code whose first tap has been taken already: every
  // later tap there places the caret natively (a hardware keyboard never
  // raises the class).
  const offered = new WeakSet<Element>();

  const keysUp = () => {
    const root = doc.documentElement;
    return root.classList.contains(KB_OPEN_CLASS) || root.classList.contains('un-kb');
  };
  const reduced = () => {
    try { return !!win.matchMedia?.('(prefers-reduced-motion: reduce)').matches; } catch { return false; }
  };

  // The ride: the sheet's layout top (offsetTop: no transform counts, so a
  // ride in flight does not skew the next) before a keyboard moved it.
  const rides = !!options.ride && typeof (scroller as { animate?: unknown }).animate === 'function';
  let rideFrom: number | null = null;
  const mark = () => { if (rides) rideFrom = scroller.offsetTop; };
  const ride = () => {
    if (!rides) return;
    const to = scroller.offsetTop;
    const d = rideOffset(rideFrom, to, reduced());
    rideFrom = to;
    if (d == null) return;
    try {
      scroller.animate([{ translate: `0 ${d}px` }, { translate: '0 0' }], { duration: RIDE_MS, easing: 'ease-out' });
    } catch { /* it simply lands where it is */ }
  };

  const reveal = (field: FieldLike | null) => {
    if (!field || doc.activeElement !== field || !scroller.contains(field)) return;
    const view = scroller.getBoundingClientRect();
    const box = field.getBoundingClientRect();
    const action = actionOf(field, scroller);
    const act = action ? action.getBoundingClientRect() : null;
    const top = revealScrollTop({
      scrollTop: scroller.scrollTop,
      scrollMax: scroller.scrollHeight - scroller.clientHeight,
      viewTop: view.top,
      viewBottom: view.bottom,
      fieldTop: box.top,
      fieldBottom: box.bottom,
      actionTop: act ? act.top : null,
      actionBottom: act ? act.bottom : null,
    });
    if (top === Math.round(scroller.scrollTop)) return;
    try {
      scroller.scrollTo({ top, behavior: reduced() ? 'auto' : 'smooth' });
    } catch {
      scroller.scrollTop = top;
    }
  };

  const clearTimers = () => {
    if (settle != null) win.clearTimeout(settle);
    if (fallback != null) win.clearTimeout(fallback);
    settle = null;
    fallback = null;
  };
  const revealPending = () => {
    clearTimers();
    const field = pending || (doc.activeElement as FieldLike | null);
    pending = null;
    reveal(field && scroller.contains(field) ? field : null);
  };

  // A field just focused: at once when the keys are already up (a hop
  // between fields fires no viewport event), else once they have settled.
  const schedule = (field: FieldLike) => {
    pending = field;
    clearTimers();
    if (keysUp()) {
      const raf = win.requestAnimationFrame;
      if (typeof raf === 'function') raf(revealPending);
      else revealPending();
      return;
    }
    fallback = win.setTimeout(revealPending, FALLBACK_MS);
  };

  // Every burst of viewport events (the keys coming up, the QuickType row
  // arriving late) ends in one reveal of whatever field here has focus.
  const onViewport = () => {
    // lib/keyboard-open.ts heard this event first (it listens from boot) and
    // has moved the band: the sheet is at its new place now.
    ride();
    const active = doc.activeElement;
    if (!pending && !(active && scroller.contains(active))) return;
    if (settle != null) win.clearTimeout(settle);
    settle = win.setTimeout(revealPending, SETTLE_MS);
  };

  // The keys going down: the band drops in the blur itself (keyboard-open's
  // capture listener on the document), so where the sheet was is read before
  // that, from the window's capture, and the ride runs once it has moved.
  const onBlurOut = () => {
    if (!rides) return;
    mark();
    const raf = win.requestAnimationFrame;
    if (typeof raf === 'function') raf(ride);
  };

  const onTouchStart = (e: TouchEvent) => {
    mark();
    touch = e.touches.length === 1 ? { x: e.touches[0].clientX, y: e.touches[0].clientY, moved: false } : null;
  };
  const onTouchMove = (e: TouchEvent) => {
    if (!touch || touch.moved) return;
    if (e.touches.length !== 1) { touch.moved = true; return; }
    if (Math.abs(e.touches[0].clientX - touch.x) > TAP_SLOP || Math.abs(e.touches[0].clientY - touch.y) > TAP_SLOP) touch.moved = true;
  };
  const onTouchCancel = () => { touch = null; };
  const onTouchEnd = (e: TouchEvent) => {
    const t = touch;
    touch = null;
    if (!t || t.moved || !e.cancelable) return;
    if (e.touches && e.touches.length) return;
    try { if (kit.gestures?.owner?.('touch') != null) return; } catch { /* no arbiter */ }
    const field = fieldAt(e.target, scroller, kit);
    if (!field) return;
    if (doc.activeElement === field) {
      // Its keys are up (or this tap raised them once already): the tap
      // places the caret, natively.
      if (keysUp() || offered.has(field)) return;
      // Focused from code, so iOS raises the keys on this tap, and pans.
      // Refocused inside the tap, they come up without the pan.
      offered.add(field);
      try { field.blur(); } catch { /* refocus below */ }
    }
    e.preventDefault();
    try { field.focus({ preventScroll: true }); } catch { field.focus(); }
    schedule(field);
  };

  // A focus moved by code (Return to the next field, a press to a missing
  // answer, the next step's field): revealed like a tap's.
  const onFocusIn = (e: FocusEvent) => {
    const field = fieldAt(e.target, scroller, kit);
    if (field && keysUp()) schedule(field);
  };

  scroller.addEventListener('touchstart', onTouchStart, { passive: true });
  scroller.addEventListener('touchmove', onTouchMove, { passive: true });
  scroller.addEventListener('touchend', onTouchEnd, { passive: false });
  scroller.addEventListener('touchcancel', onTouchCancel, { passive: true });
  scroller.addEventListener('focusin', onFocusIn);
  // The content growing under the focused field with the keys up (a hint, an
  // error line): its field and button revealed again.
  const Sizes = win.ResizeObserver;
  const sizes = typeof Sizes === 'function' ? new Sizes(() => {
    const active = doc.activeElement as FieldLike | null;
    if (keysUp() && active && scroller.contains(active)) schedule(active);
  }) : null;
  if (sizes) for (const child of Array.from(scroller.children || [])) sizes.observe(child);
  vv.addEventListener('resize', onViewport, { passive: true });
  vv.addEventListener('scroll', onViewport, { passive: true });
  // The app's web view: resized with the keys, the window's own resize.
  if (rides) win.addEventListener?.('resize', ride, { passive: true });
  if (rides) win.addEventListener?.('focusout', onBlurOut, true);
  mark();

  let done = false;
  return () => {
    if (done) return;
    done = true;
    clearTimers();
    pending = null;
    scroller.removeEventListener('touchstart', onTouchStart);
    scroller.removeEventListener('touchmove', onTouchMove);
    scroller.removeEventListener('touchend', onTouchEnd);
    scroller.removeEventListener('touchcancel', onTouchCancel);
    scroller.removeEventListener('focusin', onFocusIn);
    sizes?.disconnect();
    vv.removeEventListener('resize', onViewport);
    vv.removeEventListener('scroll', onViewport);
    if (rides) win.removeEventListener?.('resize', ride, { passive: true });
    if (rides) win.removeEventListener?.('focusout', onBlurOut, true);
  };
}

/**
 * attachKeyboardSurface on whatever element `ref` holds, re-attached when
 * React hands it a new node (the sheet renders its panel only while open).
 */
export function useKeyboardSurface(ref: RefObject<HTMLElement | null>, options: { ride?: boolean } = {}): void {
  const attached = useRef<{ el: HTMLElement; detach: () => void } | null>(null);
  const ride = !!options.ride;
  useEffect(() => {
    const el = ref.current;
    if ((attached.current?.el || null) === el) return;
    attached.current?.detach();
    attached.current = el ? { el, detach: attachKeyboardSurface(el, undefined, undefined, { ride }) } : null;
  });
  useEffect(() => () => {
    attached.current?.detach();
    attached.current = null;
  }, []);
}
