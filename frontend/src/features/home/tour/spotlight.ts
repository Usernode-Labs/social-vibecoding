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
 * The outline is `ring-2`: a 2px box-shadow drawn OUTSIDE the hole. A hole
 * that reaches the edge of the screen therefore loses that side of its ring,
 * which is how step 8's ring round the Me tab came to be cut off.
 */
export const RING_WIDTH = 2;

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

/**
 * The padding for a target that is itself one cell of a bar (#3240): a tab.
 * Tabs sit edge to edge, so the full padding cut the ring into the labels of
 * the tabs either side; the tab's own tap area is the breathing room.
 */
export const BAR_PAD = 2;
/**
 * The smallest hole worth painting (#3240). Anything thinner is a target that
 * is still arriving (below the screen, under a sheet that is still sliding
 * in) or one the insets have squeezed away, and a ring drawn round it read
 * as a stray blue line rather than a highlight.
 */
export const MIN_HOLE = 24;

/** Grow a target's box by the spotlight padding. */
export function padRect(rect: Box, pad = SPOTLIGHT_PAD): Box {
  return {
    top: rect.top - pad,
    left: rect.left - pad,
    width: rect.width + pad * 2,
    height: rect.height + pad * 2,
  };
}

/** A box on whole pixels, so sub-pixel jitter is not a new geometry every frame. */
export function roundBox(rect: Box): Box {
  const top = Math.round(rect.top);
  const left = Math.round(rect.left);
  return {
    top,
    left,
    width: Math.round(rect.left + rect.width) - left,
    height: Math.round(rect.top + rect.height) - top,
  };
}

/**
 * Keep a hole, and the ring drawn just outside it, inside `bound`.
 *
 * Only ever shrinks the hole; one the bound would erase comes back with a
 * zero side rather than a negative one, for `usableHole` to refuse.
 */
export function fitHoleIn(hole: Box, bound: Box): Box {
  const left = Math.max(hole.left, bound.left + RING_WIDTH);
  const right = Math.max(left, Math.min(hole.left + hole.width, bound.left + bound.width - RING_WIDTH));
  const top = Math.max(hole.top, bound.top + RING_WIDTH);
  const bottom = Math.max(top, Math.min(hole.top + hole.height, bound.top + bound.height - RING_WIDTH));
  return { top, left, width: right - left, height: bottom - top };
}

/** Is this hole big enough to paint (see MIN_HOLE)? */
export function usableHole(hole: Box | null): hole is Box {
  return !!hole && hole.width >= MIN_HOLE && hole.height >= MIN_HOLE;
}

/**
 * Keep the hole where its whole ring can be seen (QA 2026-09-24 Q30d).
 *
 * Three things clip a ring. The viewport's own edges: a target in a corner
 * (the Me tab, bottom right) pads past them, and the ring goes with the
 * overflow. The tab bar: a target taller than the screen (Challenges on a
 * phone) padded straight down over the bar, so the ring was drawn across
 * Home, Discover and the rest. And the header (#3240): a target scrolled up
 * under it had its ring drawn across the header. `bottomInset` is the bar's
 * height and `topInset` the header's bottom edge, each 0 when the target is
 * IN that bar, so a step that points into a bar keeps its ring there.
 *
 * Only ever shrinks the hole; a hole the insets would erase is returned as a
 * zero-height box at the band's edge rather than a negative one.
 */
export function fitHole(
  hole: Box,
  viewport: { width: number; height: number },
  bottomInset = 0,
  topInset = 0,
): Box {
  const top = Math.max(0, topInset);
  return fitHoleIn(hole, {
    top,
    left: 0,
    width: viewport.width,
    height: viewport.height - Math.max(0, bottomInset) - top,
  });
}

/**
 * How much of the bottom of the screen a tab bar covers: its height when it
 * is docked along the bottom edge, and 0 for anything else (#3240). From
 * 768px up the same `#platform-tabs` is the sidebar RAIL down the left edge,
 * and reading it as a bottom bar made the inset 748px on a 1280x800 screen,
 * which clamped every hole below the header to zero height.
 */
export function bottomBarInset(bar: Box, viewport: { width: number; height: number }): number {
  if (bar.width <= 0 || bar.height <= 0) return 0;
  if (bar.top + bar.height < viewport.height - 1 || bar.width < viewport.width / 2) return 0;
  return Math.max(0, viewport.height - bar.top);
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
 *
 * `bottomInset` is the tab bar's height when the target is not in it: the
 * card then stays above the bar rather than covering it.
 */
export function placeCard(
  viewport: { width: number; height: number },
  card: { width: number; height: number },
  hole: Box | null,
  safeTop = 0,
  bottomInset = 0,
): { top: number; left: number } {
  // The status bar is drawn over the page in the app, so the card's top
  // edge keeps clear of it as well as of the viewport's own edge.
  const minTop = VIEWPORT_MARGIN + Math.max(0, safeTop);
  const maxTop = Math.max(
    minTop, viewport.height - Math.max(0, bottomInset) - card.height - VIEWPORT_MARGIN,
  );
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
  if (below <= maxTop) top = below;
  else if (above >= minTop) top = above;
  // Neither side has room: the hole is taller than the space around it, so
  // the card has to sit ON it. QA 2026-09-24 Q30d: it used to take the
  // larger gap, which for a section taller than a phone meant the top, over
  // the very heading and progress the step was describing. A target reads
  // from its START, so while that start is on screen the card covers the
  // END instead (the bottom of the band, above the tab bar); only a target
  // whose start has scrolled off the top gets the card at the top.
  else top = hole.top >= minTop ? maxTop : minTop;

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
 * NARROW, where the panel takes the whole width: there is no "beside" left.
 * The card goes above the whole sheet when it fits there (#3240), so the
 * sheet's own title stays readable; when it does not, the rule relaxes to
 * the weaker one — clear of the ROW rather than clear of the panel, which is
 * exactly what `placeCard` already does, so that fallback is a call to it
 * rather than a second arrangement to maintain.
 */
export function placeCardForPanel(
  viewport: { width: number; height: number },
  card: { width: number; height: number },
  hole: Box | null,
  panel: Box | null,
  safeTop = 0,
  bottomInset = 0,
): { top: number; left: number } {
  if (!hole || !panel) return placeCard(viewport, card, hole, safeTop, bottomInset);
  const minTop = VIEWPORT_MARGIN + Math.max(0, safeTop);
  if (!roomLeftOfPanel(card, panel)) {
    // Narrow (#3240): clear the whole SHEET when there is room above it, so
    // the card does not sit on its title and close button while pointing at
    // a row below them; otherwise clear the row, as placeCard does.
    const above = panel.top - CARD_GAP - card.height;
    if (panel.top > minTop && hole.top >= panel.top && above >= minTop) {
      const maxLeft = Math.max(VIEWPORT_MARGIN, viewport.width - card.width - VIEWPORT_MARGIN);
      const centred = hole.left + hole.width / 2 - card.width / 2;
      return {
        top: Math.round(above),
        left: Math.round(Math.max(VIEWPORT_MARGIN, Math.min(centred, maxLeft))),
      };
    }
    return placeCard(viewport, card, hole, safeTop, bottomInset);
  }
  const maxTop = Math.max(minTop, viewport.height - card.height - VIEWPORT_MARGIN);
  const centred = hole.top + hole.height / 2 - card.height / 2;
  return {
    top: Math.round(Math.max(minTop, Math.min(centred, maxTop))),
    left: Math.round(Math.max(VIEWPORT_MARGIN, panel.left - CARD_GAP - card.width)),
  };
}
