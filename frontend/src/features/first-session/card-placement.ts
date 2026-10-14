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
 * ./index.tsx `footTop` reads it the same way (a bar counts only when it
 * lies across the screen's foot), and passes the foot it found here as
 * `foot`: the top of the phone's tab bar and Resume strip, or the window's
 * own height when nothing lies along the foot (a laptop beside its rail).
 */
import type { CSSProperties } from 'react';

import { type Box, VIEWPORT_MARGIN } from '../home/tour/spotlight';
import type { TourStep } from './tour-steps';

/** The status bar's height in the app (the shell's token), 0 in a browser tab. */
export const SAFE_TOP = 'var(--platform-safe-top, env(safe-area-inset-top, 0px))';

/** The home indicator's strip in the app (the shell's token), 0 in a browser tab. */
export const SAFE_BOTTOM = 'var(--platform-safe-bottom, env(safe-area-inset-bottom, 0px))';

/** How far a card near the foot of the screen sits above the bar there, or above the screen's edge. */
export const CARD_GAP = 20;

/**
 * The least room a card keeps above its foot: its counter, title, a line of
 * text and its buttons. A window too short for that over the card's anchor
 * gets the card lower, over its target, rather than a card squeezed to nothing.
 */
export const MIN_CARD_ROOM = 160;

/** What the card is placed against, measured by the caller. */
export type CardAnchors = {
  /**
   * The top of the bars lying along the screen's foot (./index.tsx footTop):
   * the phone's tab bar and the Resume strip on it. The window's own height
   * when there are none, which is what the sidebar rail beside the screen
   * from 768px up is: its top is the header's foot, not the screen's.
   */
  foot: number;
  /** The top edge of the element a `{ above }` step names, when it is on the page. */
  aboveTop: number | null;
  /** The bottom edge of the element a `{ below }` step names, when it is on the page. */
  belowBottom?: number | null;
  /** The hole's padding round its target (./index.tsx PAD). */
  pad: number;
};

/**
 * A card hung by its foot, `bottom` px up the screen, kept whole on it: the
 * foot on screen, and the top edge never higher than a margin under the
 * status bar. A card taller than that room scrolls inside it rather than
 * running off the top. `clearOfIndicator` adds the home indicator's strip
 * under the foot, for a screen with no bar of its own to stand on.
 */
function fromBottom(bottom: number, height: number, clearOfIndicator = false): CSSProperties {
  const at = Math.max(VIEWPORT_MARGIN, Math.min(bottom, height - VIEWPORT_MARGIN - MIN_CARD_ROOM));
  const room = `${height - at - VIEWPORT_MARGIN}px - ${SAFE_TOP}`;
  return clearOfIndicator
    ? { bottom: `calc(${at}px + ${SAFE_BOTTOM})`, maxHeight: `calc(${room} - ${SAFE_BOTTOM})`, overflowY: 'auto' }
    : { bottom: at, maxHeight: `calc(${room})`, overflowY: 'auto' };
}

/**
 * A card hung by its top edge, never higher than a margin under the status
 * bar and never longer than the room left under it: a card taller than that
 * scrolls inside it. Null when the room under `top` is less than a card needs
 * (a short window, a target low down): the caller hangs it by its foot.
 */
function fromTop(top: number, height: number): CSSProperties | null {
  if (height - top - VIEWPORT_MARGIN < MIN_CARD_ROOM) return null;
  const at = `max(${top}px, calc(${VIEWPORT_MARGIN}px + ${SAFE_TOP}))`;
  return { top: at, maxHeight: `calc(${height - VIEWPORT_MARGIN}px - ${at})`, overflowY: 'auto' };
}

/** The coach card's position for a target box, as inline style. */
export function cardPosition(
  box: Box | null,
  place: TourStep['place'],
  viewport: { width: number; height: number },
  { foot, aboveTop, belowBottom = null, pad }: CardAnchors,
): CSSProperties {
  const H = viewport.height;
  // The foot of the screen: above the bottom bar on a phone, and the window's
  // own bottom edge (and the app's home indicator) where there is none.
  const aboveFoot = foot < H ? fromBottom(H - foot + CARD_GAP, H) : fromBottom(CARD_GAP, H, true);
  if (!box) return aboveFoot;
  if (place && typeof place === 'object') {
    if ('below' in place && belowBottom != null) return fromTop(belowBottom + 12, H) ?? aboveFoot;
    if ('above' in place && aboveTop != null) return fromBottom(H - aboveTop + 12, H);
  }
  if (place === 'bottom' || box.height > H * 0.45) return aboveFoot;
  const middle = box.top + box.height / 2;
  if (middle >= foot) return aboveFoot;
  if (middle > H / 2) return fromBottom(H - box.top + pad + 12, H);
  return fromTop(box.top + box.height + pad + 12, H) ?? fromBottom(H - box.top + pad + 12, H);
}
