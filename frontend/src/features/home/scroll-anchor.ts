/**
 * HOME KEEPS ITS PLACE WHEN THE SCREEN CHANGES WIDTH (phone review, 23 Nov
 * 2026, item 141).
 *
 * Unfolding the iPhone Duo (cover to inner screen, upright to sideways) gives
 * Home a layout half as tall, and WebKit kept the scroll offset in pixels:
 * scrolled to Next challenges on the cover, the unfolded page opened on the
 * Featured card with the challenges gone above it. WebKit has no
 * `overflow-anchor`, the browser feature that does this elsewhere.
 *
 * So Home remembers which of its sections is at the top of the view, and how
 * far into it the view is, whenever it scrolls; when the scroller's width
 * changes it scrolls that section back to the same place. Where the browser
 * has already done it (Chromium's own anchoring), the shift is zero and
 * nothing moves. At rest (the search row parked under the header, or the top
 * of the page) nothing is remembered: the search row's own parking decides.
 */

/** The parts of Home that can be at the top of the view, in page order. */
export const ANCHORS = '#home-apps-section, #home-aside, #home-challenges-section, [data-home-join-featured], #home-join-section > *';

export interface Anchor { el: Element; offset: number }

interface Box { top: number; bottom: number; height: number }

/**
 * The first part whose bottom is below the view's top edge, with how far its
 * top is from that edge (negative once the view is inside it).
 */
export function pickAnchor(parts: ReadonlyArray<{ el: Element; box: Box }>, viewTop: number): Anchor | null {
  for (const { el, box } of parts) {
    if (box.height > 0 && box.bottom > viewTop) return { el, offset: box.top - viewTop };
  }
  return null;
}

/** How far to scroll so the anchor is where it was: its top now, less where it stood. */
export function anchorShift(anchor: Anchor, nowTop: number, viewTop: number): number {
  const shift = (nowTop - viewTop) - anchor.offset;
  return Math.abs(shift) < 1 ? 0 : Math.round(shift);
}

/**
 * Watch `screen` (Home's scroller). `restTop` is the offset that reads as
 * not scrolled (the parked search row's height). Returns the cleanup.
 */
export function keepHomeAnchor(screen: HTMLElement | null, restTop: () => number): () => void {
  if (!screen || typeof window === 'undefined' || typeof ResizeObserver === 'undefined') return () => {};
  let anchor: Anchor | null = null;
  let width = screen.clientWidth;
  const viewTop = () => screen.getBoundingClientRect().top;
  const remember = () => {
    if (!width || screen.scrollTop <= restTop()) { anchor = null; return; }
    const parts = [...screen.querySelectorAll(ANCHORS)].map((el) => ({ el, box: el.getBoundingClientRect() }));
    anchor = pickAnchor(parts, viewTop());
  };
  let queued = 0;
  const onScroll = () => {
    if (queued) return;
    queued = window.requestAnimationFrame(() => { queued = 0; remember(); });
  };
  screen.addEventListener('scroll', onScroll, { passive: true });
  const watch = new ResizeObserver(() => {
    const was = width;
    width = screen.clientWidth;
    // Shown again after another screen, or hidden: nothing to keep.
    if (!was || !width || was === width) return;
    const held = anchor;
    if (!held || !held.el.isConnected) return;
    const shift = anchorShift(held, held.el.getBoundingClientRect().top, viewTop());
    if (shift) screen.scrollTop += shift;
  });
  watch.observe(screen);
  remember();
  return () => {
    screen.removeEventListener('scroll', onScroll);
    watch.disconnect();
    if (queued) window.cancelAnimationFrame(queued);
  };
}
