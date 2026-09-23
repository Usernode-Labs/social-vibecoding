import { useEffect, useRef, type RefObject } from 'react';

/**
 * Taking down a small popover anchored to the button that opened it — the
 * vote picker's desktop home (features/dev-board/card/dev-card.tsx) and
 * Messages' "+" (#2778).
 *
 * Where such a popover GOES is ./anchor-popover.ts (`placeUnderAnchor`);
 * this is the other half, what makes it go away, which the vote picker
 * carried inline. What each popover shows stays its own.
 */

import type { AnchorRect } from './anchor-popover';

/** The part of a DOMRect `placeUnderAnchor` places from. */
export function anchorRectOf(el: Element): AnchorRect {
  const r = el.getBoundingClientRect();
  return { top: r.top, bottom: r.bottom, right: r.right };
}

/**
 * While `open`, close on a click outside every element in `inside` (the
 * anchor and the panel), on Escape, and on any scroll or resize — a fixed
 * panel placed from a rect is wrong the moment that rect moves.
 *
 * The click listener is on the CAPTURE phase so a click that something else
 * stops still closes the panel. `close` is read through a ref: the effect
 * binds once per opening, and the caller's function may change identity on
 * every render in between.
 */
export function useAnchoredDismiss(
  open: boolean,
  inside: ReadonlyArray<RefObject<HTMLElement | null>>,
  close: () => void,
): void {
  const closeRef = useRef(close);
  closeRef.current = close;
  const insideRef = useRef(inside);
  insideRef.current = inside;
  useEffect(() => {
    if (!open) return undefined;
    const shut = () => closeRef.current();
    const onDoc = (ev: Event) => {
      const t = ev.target as Node | null;
      if (t && insideRef.current.some((ref) => ref.current?.contains(t))) return;
      shut();
    };
    const onKey = (ev: KeyboardEvent) => { if (ev.key === 'Escape') shut(); };
    document.addEventListener('click', onDoc, true);
    document.addEventListener('keydown', onKey);
    window.addEventListener('scroll', shut, true);
    window.addEventListener('resize', shut);
    return () => {
      document.removeEventListener('click', onDoc, true);
      document.removeEventListener('keydown', onKey);
      window.removeEventListener('scroll', shut, true);
      window.removeEventListener('resize', shut);
    };
  }, [open]);
}
