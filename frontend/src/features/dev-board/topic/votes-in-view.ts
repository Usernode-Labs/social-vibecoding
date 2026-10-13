/**
 * A door that sends someone to vote on a change opens its page with the
 * Votes card in view, below the sheet's header, instead of at the top.
 *
 * Run four (13 Oct 2026): the App tab's "See the change" opened Club Votes'
 * change at its title, and the Votes card with the Vote button sat a screen
 * and a half down; scrolled to by hand, it stopped half under the "Change
 * #N" header. The same holds for every later change a person is asked to
 * vote on, so this is any door's to ask, not the first version's:
 *
 *   askVotesInView(id)    the door, just before it opens change `id`'s page
 *                         (published as `UsernodeReact.devBoard.showVotes`
 *                         for public/js/**: AppView.openFirstVersionChange,
 *                         a vote's notification);
 *   takeVotesInView(id)   the page (./change-head.tsx), once, when it draws
 *                         that change or hears an ask while it is on screen
 *                         (onVotesAsked): whether it was asked, recently;
 *   holdVotesInView(card) brings the card into view and keeps it there while
 *                         the page settles: the thread's first load puts its
 *                         scroller back at the top (group-chat.js
 *                         renderThread, #363), and the words, the plan and
 *                         the shots above it arrive and grow. It lets go at
 *                         the reader's first touch, wheel or key, or after
 *                         HOLD_MS.
 */

/** How long an ask waits for its page: a door that opened nothing is forgotten. */
export const ASK_TTL_MS = 30_000;
/** How long the card is held in view while the page settles. */
export const HOLD_MS = 6_000;
/** The room left above the card, under the header. */
export const GAP_PX = 12;

let asked: { id: number; at: number } | null = null;
const listeners = new Set<() => void>();

/**
 * The door: change `sessionId`'s page should open at its Votes card. A page
 * of that change already on screen hears it at once (onVotesAsked): its
 * address does not change, so nothing else would bring the card into view.
 */
export function askVotesInView(sessionId: unknown, now: number = Date.now()): void {
  const id = Number(sessionId);
  asked = Number.isInteger(id) && id > 0 ? { id, at: now } : null;
  if (asked) listeners.forEach((listener) => listener());
}

/** A page on screen, told of each ask (it takes its own with takeVotesInView). Returns the unsubscribe. */
export function onVotesAsked(listener: () => void): () => void {
  listeners.add(listener);
  return () => { listeners.delete(listener); };
}

/** The page: whether change `sessionId` was asked for, recently. Answers once. */
export function takeVotesInView(sessionId: unknown, now: number = Date.now()): boolean {
  const id = Number(sessionId);
  const ask = asked;
  if (!ask || ask.id !== id) return false;
  asked = null;
  return now - ask.at <= ASK_TTL_MS;
}

/**
 * Pure: how far to scroll so a card whose top is at `cardTop` sits `gap`
 * below `viewTop`, the lowest of the scroller's own top and the bottom of
 * any header drawn over it. Positive is down.
 */
export function votesScrollDelta({ cardTop, scrollerTop, headerBottom = null, gap = GAP_PX }: {
  cardTop: number;
  scrollerTop: number;
  headerBottom?: number | null;
  gap?: number;
}): number {
  const viewTop = Math.max(scrollerTop, typeof headerBottom === 'number' && Number.isFinite(headerBottom) ? headerBottom : -Infinity);
  return Math.round(cardTop - viewTop - gap);
}

const LET_GO = ['wheel', 'touchstart', 'pointerdown', 'keydown'] as const;

/**
 * Bring `card` into view under the change sheet's header and hold it there
 * while the page settles (above). Returns the release. Never throws.
 */
export function holdVotesInView(card: HTMLElement, { ms = HOLD_MS }: { ms?: number } = {}): () => void {
  if (typeof window === 'undefined' || !card) return () => {};
  const doc = card.ownerDocument || document;
  const scroller = card.closest<HTMLElement>('#gc-thread-scroll');
  const page = !scroller;
  let done = false;
  const place = () => {
    if (done || !card.isConnected) return;
    const header = doc.getElementById('gc-thread-bar');
    const headerBox = header ? header.getBoundingClientRect() : null;
    const delta = votesScrollDelta({
      cardTop: card.getBoundingClientRect().top,
      scrollerTop: scroller ? scroller.getBoundingClientRect().top : 0,
      headerBottom: headerBox && headerBox.height > 0 ? headerBox.bottom : null,
    });
    if (Math.abs(delta) < 1) return;
    if (page) window.scrollBy(0, delta);
    else (scroller as HTMLElement).scrollTop += delta;
  };
  const target: HTMLElement | Window = scroller || window;
  const resize = typeof ResizeObserver === 'function' ? new ResizeObserver(() => place()) : null;
  if (resize) {
    const watched = scroller ? [scroller, ...Array.from(scroller.children)] : [card];
    watched.forEach((el) => resize.observe(el));
  }
  const release = () => {
    if (done) return;
    done = true;
    resize?.disconnect();
    target.removeEventListener('scroll', place);
    LET_GO.forEach((type) => doc.removeEventListener(type, release, true));
    window.clearTimeout(timer);
  };
  // Another scroll that is not the reader's (the thread's first load putting
  // it back at the top) is put right. The reader's own touch, wheel, press
  // or key, anywhere on the page, ends the hold before it moves anything.
  target.addEventListener('scroll', place, { passive: true });
  LET_GO.forEach((type) => doc.addEventListener(type, release, { capture: true, passive: true }));
  const timer = window.setTimeout(release, ms);
  place();
  return release;
}
