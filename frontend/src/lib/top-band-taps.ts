/**
 * THE COVER'S DEAD BAND: iPhone Duo (30 Oct 2026).
 *
 * Folded, the Duo's cover moves the status bar into the column down its
 * right edge (./side-strip.ts), so the page runs to the top of the glass and
 * the header's controls sit 8 to 36px down. On the Duo simulator (iOS 27.1)
 * a tap in the top ~62px of the cover never becomes a click, in any app:
 * touchstart and touchend reach the page, but iOS fails every gesture
 * recognizer there. WebKit's tap never fires (no mouseover, no mousedown, no
 * click), and neither does a plain native tap recognizer on the app's own
 * window. Deferring the system's top-edge gestures, turning off
 * scroll-to-top and hiding the status bar each left the band as it was.
 * From about 64px down, taps work. On a real Duo it is "sometimes", which
 * fits a system swipe zone that a resting finger, which always moves a
 * little, loses to.
 *
 * So on the Duo layout the page finishes those taps itself. A touch that
 * starts in the band with one finger, moves no more than TAP_SLOP_PX and
 * lifts within TAP_MAX_MS is a tap: its touchend is default-prevented, so
 * WebKit never adds a click of its own and nothing fires twice, and the
 * element under the finger gets one click (or focus, for a field). A swipe,
 * a second finger, a long press or a touch something else already handled
 * is left alone.
 *
 * Only while `data-side-strip` is on <html>: Mobile Safari keeps the Duo's
 * column for itself, and no other phone hands the page one.
 */

import { STRIP_ATTR } from './side-strip';

/** How far down the cover's band reaches: measured 62 to 65px. */
export const BAND_PX = 64;
/** A finger that moves further than this is swiping, not tapping. */
export const TAP_SLOP_PX = 10;
/** Held longer than this, it is a press, not a tap. */
export const TAP_MAX_MS = 500;

type Start = { id: number; x: number; y: number; at: number };

type Field = HTMLElement & { isContentEditable?: boolean };

function isField(el: Element): el is Field {
  const tag = el.tagName;
  if (tag === 'TEXTAREA' || tag === 'SELECT') return true;
  if (tag === 'INPUT') {
    const type = ((el as HTMLInputElement).type || 'text').toLowerCase();
    return !['button', 'submit', 'reset', 'checkbox', 'radio', 'image', 'file', 'range', 'color'].includes(type);
  }
  return !!(el as Field).isContentEditable;
}

function touchById(list: TouchList | undefined, id: number): Touch | null {
  if (!list) return null;
  for (let i = 0; i < list.length; i++) if (list[i].identifier === id) return list[i];
  return null;
}

export function watchTopBandTaps(doc: Document = document, win: Window = window): () => void {
  let start: Start | null = null;

  const onStart = (e: TouchEvent) => {
    start = null;
    if (!doc.documentElement.hasAttribute(STRIP_ATTR) || e.touches.length !== 1) return;
    const t = e.touches[0];
    if (t.clientY >= BAND_PX) return;
    start = { id: t.identifier, x: t.clientX, y: t.clientY, at: e.timeStamp };
  };

  const onMove = (e: TouchEvent) => {
    if (!start) return;
    const t = touchById(e.touches, start.id);
    if (!t || Math.hypot(t.clientX - start.x, t.clientY - start.y) > TAP_SLOP_PX) start = null;
  };

  const onCancel = () => { start = null; };

  const onEnd = (e: TouchEvent) => {
    const s = start;
    start = null;
    if (!s || e.defaultPrevented || e.touches.length > 0) return;
    const t = touchById(e.changedTouches, s.id);
    if (!t) return;
    if (Math.hypot(t.clientX - s.x, t.clientY - s.y) > TAP_SLOP_PX) return;
    if (e.timeStamp - s.at > TAP_MAX_MS) return;
    const el = doc.elementFromPoint(t.clientX, t.clientY);
    if (!el) return;
    e.preventDefault();
    if (isField(el)) {
      try { el.focus(); } catch { /* nothing to focus */ }
      return;
    }
    el.dispatchEvent(new win.MouseEvent('click', {
      bubbles: true,
      cancelable: true,
      composed: true,
      view: win,
      detail: 1,
      clientX: t.clientX,
      clientY: t.clientY,
      screenX: t.screenX,
      screenY: t.screenY,
    }));
  };

  win.addEventListener('touchstart', onStart, { capture: true, passive: true });
  win.addEventListener('touchmove', onMove, { capture: true, passive: true });
  win.addEventListener('touchcancel', onCancel, { capture: true, passive: true });
  // Bubbling, on the window: the last listener to see the touchend, so one a
  // control handled itself (default-prevented) is never clicked again.
  win.addEventListener('touchend', onEnd, { passive: false });
  return () => {
    win.removeEventListener('touchstart', onStart, { capture: true });
    win.removeEventListener('touchmove', onMove, { capture: true });
    win.removeEventListener('touchcancel', onCancel, { capture: true });
    win.removeEventListener('touchend', onEnd);
  };
}

if (typeof window !== 'undefined' && typeof document !== 'undefined') {
  watchTopBandTaps();
}
