/**
 * THE PHONE'S NAVIGATION DRAWER, AS NUMBERS (pure, so the tests drive it).
 *
 * Under the Communities tab a phone shows three levels side by side on one
 * strip, one window of it at a time (./nav-drawer.tsx):
 *
 *   0  your communities, 85% of the screen, the places peeking at its right
 *   1  the community's places, 80%, the page peeking at its right
 *   2  the place's page, the whole screen
 *
 * A level is a resting place; between two of them the strip is at a
 * fractional DEPTH (1.4 is 40% of the way from the places to the page),
 * which is what a finger leaves it at and what the header is drawn from
 * (`headerFrame`). Everything here is in screen widths, so it holds at any
 * phone's size.
 */

export type Level = 0 | 1 | 2;

/** Level 0's share of the screen. */
export const OUTER_SHARE = 0.85;
/** Level 1's share of the screen. */
export const PLACES_SHARE = 0.8;
/** Where each level starts on the strip, in screen widths. */
export const LEVEL_AT: readonly [number, number, number] = [0, OUTER_SHARE, OUTER_SHARE + PLACES_SHARE];
/** How far into the next level a pan must be let go to land there. */
export const LAND_SHARE = 0.25;
/** How far a finger moves, mostly sideways, before it is a pan. */
export const PAN_SLOP_PX = 8;
/** From this close to the left edge, a finger on the page starts a pan. */
export const EDGE_PX = 24;
/** The slide between two levels, and the header's with it. */
export const SLIDE_MS = 300;
/** With Reduce Motion the strip cuts, and the header crossfades this fast. */
export const REDUCED_MS = 150;
/**
 * The slide's curve, as CSS, and as the same curve in JS for the header,
 * which follows it frame by frame: an ease-out cubic.
 */
export const SLIDE_EASE = 'cubic-bezier(0.33, 1, 0.68, 1)';
export function easeOut(k: number): number {
  const t = Math.max(0, Math.min(1, k));
  return 1 - (1 - t) ** 3;
}

export function clampDepth(f: number): number {
  return Number.isFinite(f) ? Math.max(0, Math.min(2, f)) : 2;
}

/** How far the strip is moved left at depth `f`, in screen widths. */
export function offsetAt(f: number): number {
  const d = clampDepth(f);
  const lo = Math.min(1, Math.floor(d));
  return LEVEL_AT[lo] + (LEVEL_AT[lo + 1] - LEVEL_AT[lo]) * (d - lo);
}

/** The depth the strip is at when moved left by `offset` screen widths. */
export function depthAt(offset: number): number {
  const o = Math.max(0, Math.min(LEVEL_AT[2], Number(offset) || 0));
  if (o <= LEVEL_AT[1]) return o / LEVEL_AT[1];
  return 1 + (o - LEVEL_AT[1]) / (LEVEL_AT[2] - LEVEL_AT[1]);
}

/** Whether a finger that has moved `dx, dy` is panning sideways. */
export function isPan(dx: number, dy: number): boolean {
  return Math.abs(dx) > PAN_SLOP_PX && Math.abs(dx) > Math.abs(dy) * 1.2;
}

/**
 * Where a pan that started on `from` and was let go at `offset` (screen
 * widths) lands. Past a quarter of the way into a level is enough, in the
 * direction the finger went (`dx` < 0 is in, toward the page); a pan that
 * crossed a whole level and a quarter more goes two.
 */
export function landing(from: Level, offset: number, dx: number): Level {
  let to: number = from;
  if (dx < 0) {
    while (to < 2 && offset > LEVEL_AT[to] + LAND_SHARE * (LEVEL_AT[to + 1] - LEVEL_AT[to])) to += 1;
  } else if (dx > 0) {
    while (to > 0 && offset < LEVEL_AT[to] - LAND_SHARE * (LEVEL_AT[to] - LEVEL_AT[to - 1])) to -= 1;
  }
  return to as Level;
}

/**
 * THE HEADER AT DEPTH `f` (Evan's design, 18 Oct 2026). One value moves all
 * of it, so a tap (which animates `f`) and a drag (which sets it from the
 * finger) draw the same frames:
 *
 *   - the community's colour blends in with depth: none on your communities,
 *     all of it on the places and the page;
 *   - the back arrow fades in and arrives from the right (8px) as the strip
 *     leaves level 0; level 0 is the outermost, and has none;
 *   - "Communities" drifts left (−12px) as it fades, and the community's
 *     name arrives from the right (+24px) into its place beside the arrow;
 *   - from the places to the page the name stays, rising 7px to make room,
 *     and only the page's name slides in under it, from the right, without
 *     rising (it cancels the name's rise), and back out to the right.
 *
 * `slot` is how far left of the community's name the bar's own left edge
 * is (the arrow and its gap), where "Communities" sits with no arrow.
 * Reduce Motion keeps the fades and drops every movement.
 */
export interface HeaderFrame {
  tint: number;
  back: { opacity: number; x: number; live: boolean };
  outer: { opacity: number; x: number; y: number };
  inner: { opacity: number; x: number; y: number; subOpacity: number; subX: number; subY: number };
}

/** The small line's own ink, over the name's. */
export const SUB_OPACITY = 0.78;
/** How far the name sits down while it is alone on the row. */
const ALONE_Y = 7;

export function headerFrame(f: number, slot: number, reduced = false): HeaderFrame {
  const move = reduced ? 0 : 1;
  const d = clampDepth(f);
  const b = Math.min(1, d);
  const frame: HeaderFrame = {
    tint: b,
    back: { opacity: b, x: 8 * (1 - b) * move, live: b > 0.5 },
    outer: { opacity: 0, x: -slot, y: ALONE_Y },
    inner: { opacity: 1, x: 0, y: ALONE_Y, subOpacity: 0, subX: 24 * move, subY: -ALONE_Y },
  };
  if (d <= 1) {
    frame.outer = { opacity: 1 - d, x: -slot - 12 * d * move, y: ALONE_Y };
    frame.inner = { opacity: d, x: 24 * (1 - d) * move, y: ALONE_Y, subOpacity: 0, subX: 24 * move, subY: -ALONE_Y };
    return frame;
  }
  const t = d - 1;
  frame.inner = {
    opacity: 1,
    x: 0,
    y: ALONE_Y * (1 - t),
    subOpacity: SUB_OPACITY * t,
    subX: 24 * (1 - t) * move,
    subY: ALONE_Y * (t - 1),
  };
  return frame;
}

/**
 * The place another community opens on (Evan's design): the one you were on
 * when it has it, else its Hub. Hub, Needs you, the Workshop and #general are
 * in every community; a topic's channel only where that topic is live
 * (`topics`, its handles, or null when the record is not read yet). A page
 * under a place (All items, Homeroom bot's slots, the plan) is that place.
 */
export function keepPlace(place: string | null | undefined, topics: readonly string[] | null): string {
  if (place === 'all' || place === 'bot') return 'workshop';
  if (place === 'status' || place === 'needs' || place === 'workshop' || place === 'discussion') return place;
  if (typeof place === 'string' && place.startsWith('c:') && topics && topics.includes(place.slice(2))) return place;
  return 'status';
}
