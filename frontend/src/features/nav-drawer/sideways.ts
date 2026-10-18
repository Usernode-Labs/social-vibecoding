/**
 * WHERE A FINGER MAY PAN A DRAWER BACK FROM ITS DEEPEST LEVEL (Evan, 18 Oct
 * 2026): from anywhere on the page, or in the conversation, unless it starts
 * on something that already moves sideways itself.
 *
 * The left edge (EDGE_PX) is the drawer's wherever it starts, as it was the
 * tray's, except in Safari on an iPhone, where it is the browser's own Back
 * and the drawer leaves it alone. Past the edge a swipe right is the
 * drawer's unless the finger landed on sideways UI:
 *
 *   - a surface that takes the sideways drag itself and says so with its
 *     `touch-action` (a Needs-you card's swipe-to-vote is `pan-y`; a
 *     drawing surface is `none`). A vertical scroller that says `pan-y` is
 *     not one: that is only the scroller handing sideways to whoever wants
 *     it, which the drawers' own lists do;
 *   - anything that scrolls sideways (a chip row, a pager, a wide code block);
 *   - a field being typed in or a range being slid;
 *   - text already selected, whose handles the finger may be dragging.
 *
 * `html, body` say `pan-x pan-y` (no pinch zoom), which allows both ways and
 * so marks nothing. The walk stops below `stop`, the drawer's own page.
 */

import { EDGE_PX } from './drawer-math';

/** What the walk reads of the window; a parameter so a test can hand it plain objects. */
export interface SidewaysView {
  getComputedStyle(el: Element): { touchAction?: string; overflowX?: string; overflowY?: string };
  getSelection?(): { isCollapsed: boolean } | null;
}

const TYPED = /^(text|search|email|url|tel|password|number|range|date|time|datetime-local|month|week)$/;

function isField(el: Element): boolean {
  const tag = el.tagName;
  if (tag === 'TEXTAREA' || tag === 'SELECT') return true;
  if (tag === 'INPUT') return TYPED.test(String((el as HTMLInputElement).type || 'text').toLowerCase());
  return (el as HTMLElement).isContentEditable === true;
}

/** Whether a `touch-action` value claims the sideways drag (or every drag) for the element itself. Pure. */
export function claimsSideways(touchAction: string | undefined, scrollsY: boolean): boolean {
  const value = String(touchAction || 'auto').trim();
  if (value === 'auto' || value === 'manipulation') return false;
  if (value === 'none') return true;
  const x = /\bpan-(x|left|right)\b/.test(value);
  const y = /\bpan-(y|up|down)\b/.test(value);
  if (x && y) return false;
  // Vertical only: a surface that takes sideways in script, unless it is a
  // vertical scroller only handing sideways on.
  if (y) return !scrollsY;
  return true;
}

/** Whether the touch on `target` started on sideways UI, below `stop`. */
export function startsOnSideways(target: Element | null, stop: Element | null, view: SidewaysView): boolean {
  try {
    const selection = view.getSelection?.();
    if (selection && !selection.isCollapsed) return true;
  } catch { /* no selection to read */ }
  for (let el: Element | null = target; el && el !== stop; el = el.parentElement) {
    if (isField(el)) return true;
    const cs = view.getComputedStyle(el);
    const scrollsY = /auto|scroll/.test(String(cs.overflowY || ''));
    if (claimsSideways(cs.touchAction, scrollsY)) return true;
    const box = el as HTMLElement;
    if (/auto|scroll/.test(String(cs.overflowX || '')) && box.scrollWidth > box.clientWidth + 1) return true;
  }
  return false;
}

/**
 * Whether a touch at `x` may start the pan back: the edge when the page may
 * take it, and past the edge anywhere that is not sideways UI. Pure.
 */
export function swipeBackMayStart(at: { x: number; takesEdge: boolean; sideways: boolean }): boolean {
  if (at.x <= EDGE_PX) return at.takesEdge;
  return !at.sideways;
}
