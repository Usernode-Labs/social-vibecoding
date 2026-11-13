/**
 * The context column of an item's page, under one of the frame's looks.
 *
 * The page's status and its progress cards are separate children of the
 * page's one column, in the order the product writes them, and other
 * suites hold those lines as written, so they cannot be gathered into one
 * wrapper. A column needs them stacked beside the words at heights nobody
 * knows ahead: this measures each one that is on the page and says where it
 * goes (`--fr-side-top` on the part, `--fr-side-h` on their host, and
 * `--fr-side-pull` on the page's scroller for what follows the host). app.css
 * places them from those numbers on a wide window and ignores them on a
 * phone, where they lead the page in one column.
 *
 * A page with none of them (a closed request, one whose change says where
 * it stands in its own section) has no column: `--fr-side-w`, said on the
 * page's sheet, is the room the column takes (its 320px and the 32px
 * between), and nothing when no part is there, so the words take the page.
 * What the discussion lacks of the column's foot is `--fr-side-tail`: the
 * room left under it, so the column never ends below the page.
 */
import { useEffect } from 'react';

const GAP = 24;
const COLUMN = 352;

/** While `on`, stack the host's direct children matching `parts`, top to bottom in that order. */
export function useSideStack(on: boolean, hostSelector: string, parts: readonly string[]): void {
  const key = parts.join('|');
  useEffect(() => {
    if (!on || typeof document === 'undefined' || typeof ResizeObserver === 'undefined') return undefined;
    let host: HTMLElement | null = null;
    let scroller: HTMLElement | null = null;
    let sheet: HTMLElement | null = null;
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
      sheet = host.closest<HTMLElement>('.dev-request-sheet');
      sheet?.style.setProperty('--fr-side-w', `${top ? COLUMN : 0}px`);
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
      const pull = Math.max(0, sideH - wordsH);
      scroller?.style.setProperty('--fr-side-pull', `${pull}px`);
      // The discussion is the next thing in the scroller after the page's
      // head. It is a card of its own height, so what it lacks of the
      // column's foot is left as room under it instead of stretching it.
      const talk = scroller?.querySelector<HTMLElement>(':scope > #gc-thread-messages') || null;
      scroller?.style.setProperty('--fr-side-tail', `${Math.max(0, pull - (talk ? talk.offsetHeight : 0))}px`);
      const next = talk ? [host, ...found, talk] : [host, ...found];
      if (next.length !== watched.length || next.some((el, i) => el !== watched[i])) {
        sizes.disconnect();
        watched = next;
        for (const el of watched) sizes.observe(el);
      }
    }
    // A part arrives or leaves with the page's data (the status gives way to
    // the progress card, a change's cards wait for its thread): look again then.
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
      if (sheet) sheet.style.removeProperty('--fr-side-w');
      if (scroller) { scroller.style.removeProperty('--fr-side-pull'); scroller.style.removeProperty('--fr-side-tail'); }
    };
  }, [on, hostSelector, key]);
}
