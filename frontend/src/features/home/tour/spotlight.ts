/**
 * Where the hole goes, and where the card goes.
 *
 * Split out of ./index.tsx because the arithmetic is the part worth testing
 * and the part that has no business needing a browser: `placeCard` and
 * `padRect` are pure functions over numbers, and tests/home-tour.test.js
 * drives them directly. `findTarget` is the one piece that has to touch the
 * document, and it is three lines.
 */

/** A plain box, so the maths is testable without a DOMRect. */
export interface Box {
  top: number;
  left: number;
  width: number;
  height: number;
}

/** Breathing room between the highlighted element and the edge of the hole. */
export const SPOTLIGHT_PAD = 8;
/** Gap between the hole and the card, and between the card and the viewport. */
export const CARD_GAP = 12;
export const VIEWPORT_MARGIN = 12;
/** The card's width on anything wider than a phone. */
export const CARD_MAX_WIDTH = 340;

/**
 * The first candidate that is really on screen.
 *
 * "Really" is three conditions, and each one has cost a step its anchor at
 * some point in a tour like this: the element has to BE in the document, it
 * must not be sitting under a `hidden` class (the shell's own visibility
 * mechanism, see ../../../lib/legacy-dom.ts), and it must have a non-zero
 * box -- which is what rules out an empty section that is still rendered, and
 * is why the Discover lane can be the fallback for an empty Your apps.
 */
export function findTarget(
  selectors: readonly string[],
  doc: Document | null = typeof document === 'undefined' ? null : document,
): HTMLElement | null {
  if (!doc) return null;
  for (const selector of selectors) {
    let el: HTMLElement | null = null;
    try {
      el = doc.querySelector(selector) as HTMLElement | null;
    } catch {
      // A selector that does not parse is a bug in the table, not a reason to
      // take the whole tour down; the next candidate still gets its chance.
      continue;
    }
    if (!el) continue;
    if (el.classList.contains('hidden')) continue;
    const rect = el.getBoundingClientRect();
    if (rect.width <= 0 || rect.height <= 0) continue;
    return el;
  }
  return null;
}

/** Grow a target's box by the spotlight padding, clamped to the viewport. */
export function padRect(rect: Box, pad = SPOTLIGHT_PAD): Box {
  return {
    top: rect.top - pad,
    left: rect.left - pad,
    width: rect.width + pad * 2,
    height: rect.height + pad * 2,
  };
}

/** The card's width for a viewport, so a phone gets a full-bleed card. */
export function cardWidth(viewportWidth: number): number {
  return Math.min(CARD_MAX_WIDTH, Math.max(0, viewportWidth - VIEWPORT_MARGIN * 2));
}

/**
 * Where to put the card.
 *
 * Below the hole when it fits, above it when that is the side with room, and
 * pinned inside the viewport either way. With no hole (step 1, or a step
 * whose target went missing) the card centres, because there is nothing for
 * it to point at.
 */
export function placeCard(
  viewport: { width: number; height: number },
  card: { width: number; height: number },
  hole: Box | null,
): { top: number; left: number } {
  const maxTop = Math.max(VIEWPORT_MARGIN, viewport.height - card.height - VIEWPORT_MARGIN);
  const maxLeft = Math.max(VIEWPORT_MARGIN, viewport.width - card.width - VIEWPORT_MARGIN);

  if (!hole) {
    return {
      top: Math.max(VIEWPORT_MARGIN, Math.round((viewport.height - card.height) / 2)),
      left: Math.max(VIEWPORT_MARGIN, Math.round((viewport.width - card.width) / 2)),
    };
  }

  const below = hole.top + hole.height + CARD_GAP;
  const above = hole.top - CARD_GAP - card.height;
  let top: number;
  if (below + card.height + VIEWPORT_MARGIN <= viewport.height) top = below;
  else if (above >= VIEWPORT_MARGIN) top = above;
  // Neither side has room: the hole is taller than the space around it, so
  // the card takes the larger gap and the clamp below does the rest.
  else top = hole.top > viewport.height - (hole.top + hole.height) ? VIEWPORT_MARGIN : below;

  const centred = hole.left + hole.width / 2 - card.width / 2;
  return {
    top: Math.round(Math.max(VIEWPORT_MARGIN, Math.min(top, maxTop))),
    left: Math.round(Math.max(VIEWPORT_MARGIN, Math.min(centred, maxLeft))),
  };
}
