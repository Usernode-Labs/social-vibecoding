/**
 * Where the tour's card goes. ./index.tsx `cardPlacement` measures what this
 * reads; this is the arithmetic, pure, so
 * tests/first-session-card-placement.test.js runs it over numbers.
 *
 * #4182: the card's foot was set from `#platform-tabs`' top edge, taken for
 * the top of the phone's bottom bar. From 768px up that element is the
 * sidebar rail down the left edge, whose top is the header's foot, so a card
 * placed at the bottom of the screen ended about 40px from the top of the
 * window, and only its Skip, Back and Next showed, under the browser's own
 * bar. The home tour met the same rail (#3240): ../home/tour/spotlight.ts
 * `bottomBarInset` counts the bar only while it is docked along the bottom.
 */
import type { CSSProperties } from 'react';

import { bottomBarInset, type Box, VIEWPORT_MARGIN } from '../home/tour/spotlight';
import type { TourStep } from './tour-steps';

/** The status bar's height in the app (the shell's token), 0 in a browser tab. */
export const SAFE_TOP = 'var(--platform-safe-top, env(safe-area-inset-top, 0px))';

/**
 * The least room a card keeps above its foot: its counter, title, a line of
 * text and its buttons. A window too short for that over the card's anchor
 * gets the card lower, over its target, rather than a card squeezed to nothing.
 */
export const MIN_CARD_ROOM = 160;

/** What the card is placed against, measured by the caller. */
export type CardAnchors = {
  /** `#platform-tabs`' box: the phone's bottom bar, or the rail from 768px up. */
  bar: Box | null;
  /** The top edge of the element a `{ above }` step names, when it is on the page. */
  aboveTop: number | null;
  /** The hole's padding round its target (./index.tsx PAD). */
  pad: number;
};

/**
 * A card hung by its foot, `bottom` px up the screen, kept whole on it: the
 * foot on screen, and the top edge never higher than a margin under the
 * status bar. A card taller than that room scrolls inside it rather than
 * running off the top.
 */
function fromBottom(bottom: number, height: number): CSSProperties {
  const at = Math.max(VIEWPORT_MARGIN, Math.min(bottom, height - VIEWPORT_MARGIN - MIN_CARD_ROOM));
  return { bottom: at, maxHeight: `calc(${height - at - VIEWPORT_MARGIN}px - ${SAFE_TOP})`, overflowY: 'auto' };
}

/** The coach card's position for a target box, as inline style. */
export function cardPosition(
  box: Box | null,
  place: TourStep['place'],
  viewport: { width: number; height: number },
  { bar, aboveTop, pad }: CardAnchors,
): CSSProperties {
  const H = viewport.height;
  // The foot of the screen: above the bottom bar on a phone, and the window's
  // own bottom edge beside the rail.
  const foot = (bar ? bottomBarInset(bar, viewport) : 0) + 16;
  if (!box) return fromBottom(foot, H);
  if (place && typeof place === 'object' && aboveTop != null) return fromBottom(H - aboveTop + 12, H);
  if (place === 'bottom') return fromBottom(foot, H);
  if (box.height > H * 0.45) return fromBottom(Math.max(16, H - (box.top + box.height) + 20), H);
  if (box.top + box.height / 2 > H / 2) return fromBottom(H - box.top + pad + 12, H);
  return { top: `max(${box.top + box.height + pad + 12}px, calc(${VIEWPORT_MARGIN}px + ${SAFE_TOP}))` };
}
