import { useEffect, useRef, type RefObject } from 'react';

/**
 * A small popover anchored to the button that opened it — the vote picker's
 * desktop home (features/dev-board/card/dev-card.tsx), shared (#2778).
 *
 * The vote popup was the first of these and carried both halves inline: where
 * the panel goes, and what takes it down. Messages' "+" (DM / group / agent)
 * is the second, so the two halves live here and both read them, rather than
 * a second copy drifting from the first. What each popover SHOWS stays its
 * own: this is placement and dismissal, not a component.
 *
 * Body-mounted and `position: fixed`, which is why the caller portals the
 * panel to `document.body`: a scrolling list or a sideways-scrolling kanban
 * would clip anything drawn inside it.
 */

export interface AnchorRect {
  top: number;
  bottom: number;
  right: number;
}

/** The part of a DOMRect a popover is placed from. */
export function anchorRectOf(el: Element): AnchorRect {
  const r = el.getBoundingClientRect();
  return { top: r.top, bottom: r.bottom, right: r.right };
}

/**
 * Where a `width` × `height` panel goes: right-aligned under the anchor,
 * kept 8px inside the window, and flipped above the anchor when there is no
 * room below it.
 */
export function anchoredPopoverPosition(
  rect: AnchorRect,
  width: number,
  height: number,
  view: { width: number; height: number } = typeof window === 'undefined'
    ? { width: 1024, height: 768 }
    : { width: window.innerWidth, height: window.innerHeight },
): { top: number; left: number } {
  const left = Math.min(Math.max(8, rect.right - width), view.width - width - 8);
  let top = rect.bottom + 6;
  if (top + height > view.height - 8) top = Math.max(8, rect.top - height - 6);
  return { top: Math.round(top), left: Math.round(left) };
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
