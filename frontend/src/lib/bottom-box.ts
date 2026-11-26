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
 * Two components draw such a box, and both report: Messages' composer
 * (features/messages/composer.tsx: a conversation, a project's #general and
 * topic channels, a thread with Homeroom bot) and the group chat's
 * (features/group-chat/composer.tsx: a request's or a change's page).
 *
 * Where there is no IntersectionObserver nothing is ever reported, and the
 * strip stays where it was: showing the way back is the safe side.
 */

import { useEffect, useRef } from 'react';

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

/**
 * Watch one element and keep its word in the store. Returns the undo.
 *
 * The observer's root is the screen and its threshold is 0, the defaults,
 * and both are meant. Measured against the screen, a box counts through
 * every clip between it and the person: one in its own scroller, in a fixed
 * footer or in a sheet is drawn, and one in a drawer level slid off the side
 * or under a `display: none` screen is not. Any part showing is enough.
 */
export function watchBottomBox(el: Element | null): () => void {
  if (!el || typeof IntersectionObserver === 'undefined') return () => undefined;
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
}

/** Report the element with this id as a box at the foot of the page while it is drawn. */
export function useBottomBox(id: string, on = true): void {
  useEffect(() => {
    if (!on || typeof document === 'undefined') return undefined;
    return watchBottomBox(document.getElementById(id));
  }, [id, on]);
}

/**
 * The same, for a composer that draws its box on some renders and a notice
 * on others, where an effect run once would miss the box arriving. `find`
 * is asked after every render, and the watch moves only when the element it
 * answers is a different one.
 */
export function useBottomBoxOf(find: () => Element | null): void {
  const watched = useRef<Element | null>(null);
  const undo = useRef<(() => void) | null>(null);
  useEffect(() => {
    const el = find();
    if (el === watched.current) return;
    undo.current?.();
    watched.current = el;
    undo.current = el ? watchBottomBox(el) : null;
  });
  useEffect(() => () => {
    undo.current?.();
    undo.current = null;
    watched.current = null;
  }, []);
}
