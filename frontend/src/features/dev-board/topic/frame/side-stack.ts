/**
 * The context column of an item's page, under one of the frame's looks.
 *
 * The page's status, its progress card and About are separate children of
 * the page's one column, in the order the product writes them, and other
 * suites hold those lines as written, so they cannot be gathered into one
 * wrapper. A column needs them stacked beside the words at heights nobody
 * knows ahead: this measures each one that is on the page and says where it
 * goes (`--fr-side-top` on the part, `--fr-side-h` on their host, and
 * `--fr-side-pull` on the page's scroller for what follows the host). app.css
 * places them from those two numbers on a wide window and ignores both on a
 * phone, where they stay in the page's own order.
 */
import { useEffect } from 'react';

const GAP = 16;

/** While `on`, stack the host's direct children matching `parts`, top to bottom in that order. */
export function useSideStack(on: boolean, hostSelector: string, parts: readonly string[]): void {
  const key = parts.join('|');
  useEffect(() => {
    if (!on || typeof document === 'undefined' || typeof ResizeObserver === 'undefined') return undefined;
    let host: HTMLElement | null = null;
    let scroller: HTMLElement | null = null;
    let watched: Element[] = [];
    const sizes = new ResizeObserver(place);
    function place() {
      host = document.querySelector<HTMLElement>(hostSelector);
      if (!host) return;
      const found: HTMLElement[] = [];
      for (const part of parts) {
        for (const el of host.querySelectorAll<HTMLElement>(`:scope > ${part}`)) found.push(el);
      }
      let top = 0;
      for (const el of found) {
        if (!el.offsetHeight) continue;
        el.style.setProperty('--fr-side-top', `${top}px`);
        top += el.offsetHeight + GAP;
      }
      const sideH = Math.max(0, top - GAP);
      host.style.setProperty('--fr-side-h', `${sideH}px`);
      // What follows the host in the page (the discussion) belongs to the
      // words' column: how far the column of parts stands below the words
      // is how far it may be drawn up. Said on the scroller, which both see.
      let wordsH = 0;
      for (const child of host.children) {
        const el = child as HTMLElement;
        if (found.includes(el) || !el.offsetHeight) continue;
        wordsH = Math.max(wordsH, el.offsetTop + el.offsetHeight);
      }
      scroller = host.closest<HTMLElement>('.dev-request-scroll, .messages-thread-scroll');
      scroller?.style.setProperty('--fr-side-pull', `${Math.max(0, sideH - wordsH)}px`);
      const next = [host, ...found];
      if (next.length !== watched.length || next.some((el, i) => el !== watched[i])) {
        sizes.disconnect();
        watched = next;
        for (const el of watched) sizes.observe(el);
      }
    }
    // A part arrives or leaves with the page's data (the status gives way to
    // the progress card, About waits for the request): look again then.
    // Once a frame at most: the page around it changes often (a reply, a
    // card filling in), and placing is only worth doing when it has settled.
    let queued = 0;
    const kids = new MutationObserver(() => {
      if (queued) return;
      queued = window.requestAnimationFrame(() => { queued = 0; place(); });
    });
    kids.observe(document.body, { childList: true, subtree: true });
    place();
    return () => {
      if (queued) window.cancelAnimationFrame(queued);
      kids.disconnect();
      sizes.disconnect();
      if (host) host.style.removeProperty('--fr-side-h');
      if (scroller) scroller.style.removeProperty('--fr-side-pull');
    };
  }, [on, hostSelector, key]);
}
