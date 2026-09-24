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
  safeTop = 0,
): { top: number; left: number } {
  // The status bar is drawn over the page in the app, so the card's top
  // edge keeps clear of it as well as of the viewport's own edge.
  const minTop = VIEWPORT_MARGIN + Math.max(0, safeTop);
  const maxTop = Math.max(minTop, viewport.height - card.height - VIEWPORT_MARGIN);
  const maxLeft = Math.max(VIEWPORT_MARGIN, viewport.width - card.width - VIEWPORT_MARGIN);

  if (!hole) {
    return {
      top: Math.max(minTop, Math.round((viewport.height - card.height) / 2)),
      left: Math.max(VIEWPORT_MARGIN, Math.round((viewport.width - card.width) / 2)),
    };
  }

  const below = hole.top + hole.height + CARD_GAP;
  const above = hole.top - CARD_GAP - card.height;
  let top: number;
  if (below + card.height + VIEWPORT_MARGIN <= viewport.height) top = below;
  else if (above >= minTop) top = above;
  // Neither side has room: the hole is taller than the space around it, so
  // the card takes the larger gap and the clamp below does the rest.
  else top = hole.top > viewport.height - (hole.top + hole.height) ? minTop : below;

  const centred = hole.left + hole.width / 2 - card.width / 2;
  return {
    top: Math.round(Math.max(minTop, Math.min(top, maxTop))),
    left: Math.round(Math.max(VIEWPORT_MARGIN, Math.min(centred, maxLeft))),
  };
}

/**
 * The four panels that make the dim, laid out around the hole.
 *
 * Returned in the order the overlay renders them: top, right, bottom, left.
 * They tile the viewport minus the hole exactly, which is what makes the
 * cut-out a real hole: they are the elements that receive pointer events, so
 * what is not covered by one of them is genuinely clickable.
 *
 * With no hole the top panel takes the whole viewport and the other three
 * collapse to nothing, so "dim everything" needs no separate element and no
 * branch at the call site.
 */
export function shadeBoxes(
  viewport: { width: number; height: number },
  hole: Box | null,
): [Box, Box, Box, Box] {
  if (!hole) {
    const full = { top: 0, left: 0, width: viewport.width, height: viewport.height };
    const none = { top: 0, left: 0, width: 0, height: 0 };
    return [full, { ...none }, { ...none }, { ...none }];
  }
  // Clamped to the viewport, because a target can be scrolled half off it and
  // a negative width would paint the shade in the wrong place.
  const top = Math.max(0, Math.min(hole.top, viewport.height));
  const bottom = Math.max(top, Math.min(hole.top + hole.height, viewport.height));
  const left = Math.max(0, Math.min(hole.left, viewport.width));
  const right = Math.max(left, Math.min(hole.left + hole.width, viewport.width));
  const band = bottom - top;
  return [
    { top: 0, left: 0, width: viewport.width, height: top },
    { top, left: right, width: Math.max(0, viewport.width - right), height: band },
    { top: bottom, left: 0, width: viewport.width, height: Math.max(0, viewport.height - bottom) },
    { top, left: 0, width: left, height: band },
  ];
}

/**
 * The Improve panel's box, or null when there is nothing presented.
 *
 * Measured on the kit's sheet when the panel has been ADOPTED into one (the
 * touch path, see ../../improve/improve-controller.js), because that wrapper
 * is the surface the viewer sees; on desktop the kit refuses and the panel is
 * its own surface. Only ever called for a step that needs the panel open, so
 * a closed panel's off-screen rect never reaches the caller.
 */
export function panelBox(
  doc: Document | null = typeof document === 'undefined' ? null : document,
): Box | null {
  const panel = doc?.getElementById('apps-switcher-sheet');
  if (!panel) return null;
  const surface = panel.closest('.un-sheet') ?? panel;
  const rect = surface.getBoundingClientRect();
  if (rect.width <= 0 || rect.height <= 0) return null;
  return { top: rect.top, left: rect.left, width: rect.width, height: rect.height };
}

/** Is there room for the card between the viewport's left edge and the panel? */
export function roomLeftOfPanel(card: { width: number }, panel: Box): boolean {
  return panel.left - CARD_GAP - card.width >= VIEWPORT_MARGIN;
}

/**
 * Where to put the card while the Improve panel is open.
 *
 * The card must not sit ON the panel: a tooltip drawn over the thing it is
 * pointing at hides the row it is describing, and on the platform's own
 * sheet it reads as part of the panel rather than as the tour.
 *
 * DESKTOP, where the panel is a right-side sheet: the card's RIGHT edge goes
 * against the panel's LEFT edge with one gap between them, and it lines up
 * vertically with the middle of the highlighted row, so the eye travels
 * straight across from the sentence to the control. Clamped to the viewport
 * like everything else here.
 *
 * NARROW, where the panel takes the whole width: there is no "beside" left,
 * so the rule relaxes to the weaker one the design asks for — clear of the
 * ROW rather than clear of the panel. That is exactly what `placeCard`
 * already does (below the hole when it fits, above it when it does not), so
 * the fallback is a call to it rather than a second arrangement to maintain.
 */
export function placeCardForPanel(
  viewport: { width: number; height: number },
  card: { width: number; height: number },
  hole: Box | null,
  panel: Box | null,
  safeTop = 0,
): { top: number; left: number } {
  if (!hole || !panel || !roomLeftOfPanel(card, panel)) {
    return placeCard(viewport, card, hole, safeTop);
  }
  const minTop = VIEWPORT_MARGIN + Math.max(0, safeTop);
  const maxTop = Math.max(minTop, viewport.height - card.height - VIEWPORT_MARGIN);
  const centred = hole.top + hole.height / 2 - card.height / 2;
  return {
    top: Math.round(Math.max(minTop, Math.min(centred, maxTop))),
    left: Math.round(Math.max(VIEWPORT_MARGIN, panel.left - CARD_GAP - card.width)),
  };
}
