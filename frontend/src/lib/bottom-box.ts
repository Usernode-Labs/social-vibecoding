/**
 * "This page has its own box at the foot of the screen."
 *
 * On a phone the Resume strip (features/nav/parked-strip.tsx) rests on the
 * tab bar, and a page with a reply box at its foot then stacks three things
 * there: the box, the strip and the bar (phone audit of 25 Nov 2026, request
 * 7164). The strip steps aside while such a box is drawn, and this is how it
 * knows.
 *
 * A box says so itself, from its own element, and only while it is DRAWN:
 * a composer stays mounted on screens that are hidden, in a drawer level
 * slid off the side, and under a place that is not the open one, and none of
 * those is at the foot of what the person is looking at. An
 * IntersectionObserver answers exactly that (nothing intersects while an
 * ancestor is `display: none` or the element is off the screen), with no
 * route to read and no moment to guess at when a page loads late.
 *
 * It is a count, not a flag: two boxes can be drawn at once (a thread open
 * beside a channel), and one going away must not clear the other's word.
 *
 * Where there is no IntersectionObserver nothing is ever reported, and the
 * strip stays where it was: showing the way back is the safe side.
 */

import { useEffect } from 'react';

import { createStore } from './plain-store.js';

export const bottomBoxStore = createStore({ count: 0 });

/** One box's word, kept in step with the store. Returns its undo. */
export function reportBottomBox(): { set: (drawn: boolean) => void; clear: () => void } {
  let counted = false;
  const set = (drawn: boolean) => {
    if (drawn === counted) return;
    counted = drawn;
    const now = bottomBoxStore.get().count + (drawn ? 1 : -1);
    bottomBoxStore.set({ count: Math.max(0, now) });
  };
  return { set, clear: () => set(false) };
}

/** Whether the element is drawn where a person can see it. */
function seen(el: Element, entry: IntersectionObserverEntry): boolean {
  if (!entry.isIntersecting) return false;
  const check = (el as Element & {
    checkVisibility?: (options?: { visibilityProperty?: boolean }) => boolean;
  }).checkVisibility;
  return typeof check === 'function' ? check.call(el, { visibilityProperty: true }) : true;
}

/** Report the element with this id as a box at the foot of the page while it is drawn. */
export function useBottomBox(id: string, on = true): void {
  useEffect(() => {
    const el = typeof document === 'undefined' ? null : document.getElementById(id);
    if (!on || !el || typeof IntersectionObserver === 'undefined') return undefined;
    const report = reportBottomBox();
    const observer = new IntersectionObserver((entries) => {
      const last = entries[entries.length - 1];
      if (last) report.set(seen(el, last));
    });
    observer.observe(el);
    return () => {
      observer.disconnect();
      report.clear();
    };
  }, [id, on]);
}
