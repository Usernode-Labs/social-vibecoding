/**
 * THE PAGE UNDER A FULL-SCREEN SCREEN HOLDS STILL (onboarding run, 12 Oct
 * 2026, iPhone 17 Safari, #4893).
 *
 * "What do you want to make?", the made screen after it and "You're in" are
 * `fixed` boxes over the live shell, and Home stays under them. In a phone
 * browser the document itself is Home's scroller (./browser-scroll.ts), so a
 * drag on one of those boxes that its own scroller did not take (the wordmark
 * bar, a form shorter than the screen, the end of what scrolls) went on to
 * the document: Home scrolled underneath, and its cards came up behind the
 * status bar over the top of the screen. Nothing stopped a Tab, or a screen
 * reader, from walking out onto Home either.
 *
 * lockPage(over) holds the page while `over` is up:
 *
 *   - <html> takes PAGE_LOCKED, and app.css stops the document scrolling
 *     (`overflow: hidden` on the root, which iOS honours since 16). It is not
 *     moved: the page is where it was when the screen goes.
 *   - with `inert` (the default), every child of <body> before `over` takes
 *     the `inert` attribute: the shell's header, screens, bars and the
 *     dialogs' roots. No tap, focus or screen reader reaches them. What is
 *     put on <body> after it stays live: a sheet the screen opens there
 *     (Who can change it), the kit's sheets, alerts and toasts. A child that
 *     is inert already is someone else's to let go of (the parked strip on
 *     its way out), so it is left alone, and the release lets go of only
 *     what this lock made inert.
 *
 * Locks nest: <html> keeps the class until the last lock in its document is
 * released, and a child stays inert until the last lock that made it so is,
 * so one screen handing over to the next never lets the page go in between,
 * whichever of the two lets go first.
 *
 * AND OUT OF SIGHT (onboarding run three, 12 Oct 2026, iPhone 17 Safari):
 * the make and made screens run on 200px under Safari's toolbar (app.css),
 * but Safari draws a fixed box only to the foot of its layout viewport, so
 * the band behind the translucent toolbar showed Home: its cards, "Try an
 * app". What a lock makes inert also takes PAGE_HIDDEN, which app.css draws
 * at no opacity, so that band is the page's own ground. Only with `inert`:
 * from Create the header and what stands above the screen stay in sight.
 */

import { type RefObject, useLayoutEffect } from 'react';

export const PAGE_LOCKED = 'platform-page-locked';
/** On each child a lock made inert: drawn at no opacity while the lock holds (app.css). */
export const PAGE_HIDDEN = 'data-page-locked';

type Lockable = {
  ownerDocument: Document | null;
  parentElement: Element | null;
  previousElementSibling: Element | null;
};

// How many locks hold each document, and each child this module made inert.
const held = new WeakMap<Document, number>();
const ours = new WeakMap<Element, number>();
const SKIP = new Set(['SCRIPT', 'STYLE', 'LINK', 'TEMPLATE']);

/** Hold the page under `over` (see the header). Answers the release, which is safe to call twice. */
export function lockPage(over: Lockable | null, { inert = true }: { inert?: boolean } = {}): () => void {
  const doc = over?.ownerDocument;
  if (!over || !doc) return () => {};
  held.set(doc, (held.get(doc) || 0) + 1);
  doc.documentElement.classList.add(PAGE_LOCKED);
  const made: Element[] = [];
  if (inert && over.parentElement === doc.body) {
    for (let el = over.previousElementSibling; el; el = el.previousElementSibling) {
      if (SKIP.has(el.tagName)) continue;
      const n = ours.get(el) || 0;
      if (!n && el.hasAttribute('inert')) continue;
      if (!n) {
        el.setAttribute('inert', '');
        el.setAttribute(PAGE_HIDDEN, '');
      }
      ours.set(el, n + 1);
      made.push(el);
    }
  }
  let released = false;
  return () => {
    if (released) return;
    released = true;
    for (const el of made) {
      const n = (ours.get(el) || 1) - 1;
      if (n > 0) {
        ours.set(el, n);
        continue;
      }
      ours.delete(el);
      el.removeAttribute('inert');
      el.removeAttribute(PAGE_HIDDEN);
    }
    const left = (held.get(doc) || 1) - 1;
    if (left > 0) {
      held.set(doc, left);
      return;
    }
    held.delete(doc);
    doc.documentElement.classList.remove(PAGE_LOCKED);
  };
}

/**
 * The page held while the component whose root `ref` names is mounted.
 * A layout effect, so it holds before the first frame is painted (a screen
 * drawn with flushSync included) and lets go in the commit that takes the
 * screen down, before whatever replaces it measures the page.
 */
export function usePageLock(ref: RefObject<Element | null>, { inert = true }: { inert?: boolean } = {}): void {
  useLayoutEffect(() => lockPage(ref.current, { inert }), [ref, inert]);
}
