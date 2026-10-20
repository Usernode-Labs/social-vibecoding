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
/**
 * Messages on the same drawer (./messages-drawer.ts): the conversation list
 * at 85%, then the conversation, the whole screen.
 */
export const MESSAGES_AT: readonly [number, number] = [0, OUTER_SHARE];
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

/** How far a strip of levels at `stops` is moved left at depth `f`, in screen widths. */
export function offsetIn(stops: readonly number[], f: number): number {
  const deepest = stops.length - 1;
  const d = Math.max(0, Math.min(deepest, Number.isFinite(f) ? f : deepest));
  const lo = Math.min(deepest - 1, Math.floor(d));
  return stops[lo] + (stops[lo + 1] - stops[lo]) * (d - lo);
}

/** The depth a strip of levels at `stops` is at when moved left by `offset` screen widths. */
export function depthIn(stops: readonly number[], offset: number): number {
  const deepest = stops.length - 1;
  const o = Math.max(0, Math.min(stops[deepest], Number(offset) || 0));
  let lo = 0;
  while (lo < deepest - 1 && o > stops[lo + 1]) lo += 1;
  return lo + (o - stops[lo]) / (stops[lo + 1] - stops[lo]);
}

/** How far the strip is moved left at depth `f`, in screen widths. */
export function offsetAt(f: number): number {
  return offsetIn(LEVEL_AT, f);
}

/** The depth the strip is at when moved left by `offset` screen widths. */
export function depthAt(offset: number): number {
  return depthIn(LEVEL_AT, offset);
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
  return landingIn(LEVEL_AT, from, offset, dx) as Level;
}

/** `landing`, for a strip of levels at `stops`. */
export function landingIn(stops: readonly number[], from: number, offset: number, dx: number): number {
  const deepest = stops.length - 1;
  let to = from;
  if (dx < 0) {
    while (to < deepest && offset > stops[to] + LAND_SHARE * (stops[to + 1] - stops[to])) to += 1;
  } else if (dx > 0) {
    while (to > 0 && offset < stops[to] - LAND_SHARE * (stops[to] - stops[to - 1])) to -= 1;
  }
  return to;
}

/**
 * THE HEADER AT DEPTH `f` (Evan's design, 18 Oct 2026). One value moves all
 * of it, so a tap (which animates `f`) and a drag (which sets it from the
 * finger) draw the same frames:
 *
 *   - the community's colour blends in with depth: none on your communities,
 *     all of it on the places and the page;
 *   - the back arrow is there on every level, level 0 included: there it
 *     returns to the page, as the device's Back does;
 *   - "Communities" sits beside the arrow and drifts left (−12px) as it
 *     fades, and the community's name arrives from the right (+24px) into
 *     its place beside the arrow;
 *   - from the places to the page the name stays, rising 7px to make room,
 *     and only the page's name slides in under it, from the right, without
 *     rising (it cancels the name's rise), and back out to the right.
 *
 * `slot` is how far left of the community's name the bar's own left edge
 * is (the arrow and its gap), where Messages' "Messages" sits with no arrow;
 * Communities' titles no longer use it. Reduce Motion keeps the fades and
 * drops every movement.
 *
 * MESSAGES (`messages`): two levels, the list and a conversation, and no
 * colour. The conversation's name arrives with its line under it ("Direct
 * message", "3 members") already in place, the way a new title arrives.
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

export function headerFrame(f: number, slot: number, reduced = false, messages = false): HeaderFrame {
  const move = reduced ? 0 : 1;
  const d = messages ? Math.max(0, Math.min(1, Number.isFinite(f) ? f : 1)) : clampDepth(f);
  const b = Math.min(1, d);
  if (messages) {
    return {
      tint: 0,
      back: { opacity: b, x: 8 * (1 - b) * move, live: b > 0.5 },
      outer: { opacity: 1 - d, x: -slot - 12 * d * move, y: ALONE_Y },
      inner: { opacity: d, x: 24 * (1 - d) * move, y: 0, subOpacity: SUB_OPACITY, subX: 0, subY: 0 },
    };
  }
  const frame: HeaderFrame = {
    tint: b,
    back: { opacity: 1, x: 0, live: true },
    outer: { opacity: 0, x: -12 * move || 0, y: ALONE_Y },
    inner: { opacity: 1, x: 0, y: ALONE_Y, subOpacity: 0, subX: 24 * move, subY: -ALONE_Y },
  };
  if (d <= 1) {
    frame.outer = { opacity: 1 - d, x: -12 * d * move || 0, y: ALONE_Y };
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

/**
 * Two frames, so the slide is on the compositor before heavy work runs;
 * never later than `capMs`. A switch of community (./nav-drawer.tsx) and a
 * conversation let go of in Messages (../messages/phone-drawer.tsx) start
 * their slide first and route through this.
 */
export function afterSlideStarts(run: () => void, capMs = 120): void {
  if (typeof requestAnimationFrame !== 'function') {
    run();
    return;
  }
  let done = false;
  const once = () => {
    if (done) return;
    done = true;
    run();
  };
  requestAnimationFrame(() => requestAnimationFrame(once));
  setTimeout(once, capMs);
}
