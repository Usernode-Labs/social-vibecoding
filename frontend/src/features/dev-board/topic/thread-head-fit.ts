/**
 * THE THREAD'S HEAD SAYS ITS TITLE, AND TIGHTENS AS THE READER SCROLLS
 * (19 Nov 2026). A request's or a change's page leads with a head card, as
 * the Homeroom bot page leads with its own: the project's tile, a small line
 * (the project, the topic, "Request #N" and where it stands) over the title
 * in two lines (app.css "THE THREAD'S HEAD IS A CARD"). It lies over the top
 * of the thread's scroller, so two things are read off it here:
 *
 *   - its height, as `--thread-head-h` on the page (`.dev-request`): the
 *     scroller starts under it, and a title of one line or two, or a window
 *     that wraps it differently, moves where that is. Read only while the
 *     head is at its full size, so the scroller's top never moves on scroll.
 *   - whether the thread has scrolled, as `data-thread-head-tight` on the
 *     page: then the head tightens to one line of title over the small line,
 *     and the cards go up behind it. Nothing in the scroller moves when it
 *     does, so tightening cannot feed back into the scroll that caused it.
 *
 * Found from the head itself, never by a document-wide id: another pane can
 * hold the same page (#4640).
 */

import { useEffect, type RefObject } from 'react';

/** How far the thread scrolls before its head tightens. */
export const HEAD_TIGHT_AFTER_PX = 24;

/**
 * Fit the page to `head` and follow its scroller; returns what undoes it.
 * Does nothing (and undoes nothing) when the head is not in a thread page.
 */
export function fitThreadHead(head: HTMLElement): () => void {
  const page = head.closest<HTMLElement>('.dev-request');
  const scroller = page?.querySelector<HTMLElement>(':scope > .dev-request-sheet > .dev-request-scroll') || null;
  if (!page || !scroller) return () => {};
  let tight = false;
  const measure = () => {
    if (tight) return;
    const h = Math.round(head.getBoundingClientRect().height);
    if (h > 0) page.style.setProperty('--thread-head-h', `${h}px`);
  };
  const onScroll = () => {
    const next = scroller.scrollTop > HEAD_TIGHT_AFTER_PX;
    if (next === tight) return;
    tight = next;
    page.toggleAttribute('data-thread-head-tight', tight);
  };
  const resize = typeof ResizeObserver === 'function' ? new ResizeObserver(measure) : null;
  resize?.observe(head);
  measure();
  onScroll();
  scroller.addEventListener('scroll', onScroll, { passive: true });
  return () => {
    resize?.disconnect();
    scroller.removeEventListener('scroll', onScroll);
    page.removeAttribute('data-thread-head-tight');
    page.style.removeProperty('--thread-head-h');
  };
}

/** `on` is false where the head is not drawn (a frame look's page draws the kit's head). */
export function useThreadHeadFit(ref: RefObject<HTMLElement | null>, on: boolean): void {
  useEffect(() => {
    const head = on ? ref.current : null;
    return head ? fitThreadHead(head) : undefined;
  }, [ref, on]);
}
