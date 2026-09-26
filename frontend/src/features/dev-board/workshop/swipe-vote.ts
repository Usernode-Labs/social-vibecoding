/**
 * Swipe to vote on a Needs-you card (#3052): right is Yes, left is No.
 *
 * This module is the gesture and nothing else: when a drag is a swipe, how
 * far is far enough, what a release decides and what a frame looks like. It
 * holds no React and touches no DOM, so the rules are testable as rules
 * (tests/workshop-swipe-vote.test.js). The feed item wires pointer events to
 * `createSwipeTracker` and hands a commit to the feed's own `answer`, which
 * is the ONLY vote path: a No goes through castVote's "What's not working
 * for you?" prompt, and nothing is sent until that line is given.
 *
 * Three rules keep a swipe from being a vote nobody meant:
 *
 *   - The feed scrolls vertically. A drag is a swipe only once it has moved
 *     past a slop AND is clearly sideways; anything else, diagonals
 *     included, is the scroll's, and stays the scroll's for the rest of the
 *     gesture. (The card also carries `touch-action: pan-y`, so the browser
 *     pans vertical drags itself and sends pointercancel.)
 *   - One touch. A mouse or pen never starts one, a second finger cancels
 *     the gesture, and pointercancel ends it without a vote.
 *   - The release decides, and it re-reads eligibility then: a card that was
 *     answered or started sending while the finger was down does not vote.
 */

export type SwipeSide = 'yes' | 'no';
export type SwipeAllowed = { yes: boolean; no: boolean };

/** How far a finger moves before the drag has a direction at all. */
export const SWIPE_SLOP = 10;
/** A swipe must be this many times more sideways than vertical. */
export const SWIPE_DOMINANCE = 1.5;
/** The commit distance as a share of the card's width... */
export const SWIPE_COMMIT_FRACTION = 0.3;
/** ...and never less than this, so a narrow card still needs a real drag. */
export const SWIPE_MIN_COMMIT = 80;
/** The card's tilt at the commit distance. */
const SWIPE_MAX_TILT_DEG = 6;

/** Which way a drag is going, once it has gone far enough to say. */
export function lockAxis(dx: number, dy: number): 'pending' | 'x' | 'y' {
  const ax = Math.abs(dx);
  const ay = Math.abs(dy);
  if (ax < SWIPE_SLOP && ay < SWIPE_SLOP) return 'pending';
  return ax > ay * SWIPE_DOMINANCE ? 'x' : 'y';
}

export function commitDistance(width: number): number {
  return Math.max(SWIPE_MIN_COMMIT, Math.round((width || 0) * SWIPE_COMMIT_FRACTION));
}

export function sideFor(dx: number): SwipeSide {
  return dx > 0 ? 'yes' : 'no';
}

/** What a release at `dx` votes, or null for "spring back". */
export function releaseDecision(dx: number, width: number, allowed: SwipeAllowed): SwipeSide | null {
  if (!dx) return null;
  const side = sideFor(dx);
  if (!allowed[side]) return null;
  return Math.abs(dx) >= commitDistance(width) ? side : null;
}

export type SwipeFrame = {
  side: SwipeSide;
  /** The card's transform; empty where motion is unwelcome or the side is barred. */
  transform: string;
  /** Each note's opacity, 0..1. */
  yes: number;
  no: number;
  /** Past the commit distance: releasing now votes. */
  armed: boolean;
};

/** One frame of the drag: where the card sits and how much of each note shows. */
export function swipeVisual(dx: number, width: number, allowed: SwipeAllowed, reducedMotion: boolean): SwipeFrame {
  const side = sideFor(dx);
  if (!dx || !allowed[side]) return { side, transform: '', yes: 0, no: 0, armed: false };
  const d = commitDistance(width);
  const p = Math.min(1, Math.abs(dx) / d);
  const tilt = Math.round((dx / d) * SWIPE_MAX_TILT_DEG * 100) / 100;
  const clampedTilt = Math.max(-SWIPE_MAX_TILT_DEG * 1.5, Math.min(SWIPE_MAX_TILT_DEG * 1.5, tilt));
  return {
    side,
    transform: reducedMotion ? '' : `translate3d(${Math.round(dx * 10) / 10}px, 0, 0) rotate(${clampedTilt}deg)`,
    yes: side === 'yes' ? p : 0,
    no: side === 'no' ? p : 0,
    armed: Math.abs(dx) >= d,
  };
}

/** The part of a Needs-you queue row this module reads. */
type SwipeRow = {
  kind: string;
  yes: { act: { fn: string } | null } | null;
  no: { act: { fn: string } | null } | null;
};

/**
 * Which sides of this card a swipe may take. The same rule as the sheet's
 * buttons (a side with a castVote action), narrowed to a card that is not
 * already answered or on its way: a swipe never flips a vote.
 */
export function swipeAllowed(row: SwipeRow, answered: boolean, sending: boolean): SwipeAllowed {
  if (row.kind !== 'vote' || answered || sending) return { yes: false, no: false };
  const castable = (s: SwipeRow['yes']) => !!(s && s.act && s.act.fn === 'castVote');
  return { yes: castable(row.yes), no: castable(row.no) };
}

export function anySwipe(a: SwipeAllowed): boolean {
  return a.yes || a.no;
}

export type SwipePointer = { pointerId: number; pointerType: string; isPrimary: boolean; x: number; y: number };

export type SwipeTracker = {
  /** True when this pointer started a gesture the tracker is following. */
  down(e: SwipePointer): boolean;
  /** True when the drag is a swipe: the caller should stop the event. */
  move(e: SwipePointer): boolean;
  up(e: SwipePointer): void;
  cancel(): void;
  /** Whether the click that ends this gesture should be swallowed (once). */
  consumeClick(): boolean;
};

export function createSwipeTracker(opts: {
  allowed: () => SwipeAllowed;
  width: () => number;
  reducedMotion: () => boolean;
  /** A frame to draw, or null for "back to rest". */
  onFrame: (frame: SwipeFrame | null) => void;
  onCommit: (side: SwipeSide) => void;
}): SwipeTracker {
  let id: number | null = null;
  let x0 = 0;
  let y0 = 0;
  let dx = 0;
  let axis: 'pending' | 'x' | 'y' = 'pending';
  let swallow = false;

  const reset = () => {
    const drew = axis === 'x';
    id = null;
    dx = 0;
    axis = 'pending';
    if (drew) opts.onFrame(null);
  };

  return {
    down(e) {
      if (id !== null) {
        // A second finger: this is a pinch or a fumble, not a vote.
        if (e.pointerId !== id) reset();
        return false;
      }
      // A touch drag usually ends with no click at all, so a swallow left
      // over from it must not eat the next, genuine tap.
      swallow = false;
      if (e.pointerType !== 'touch' || !e.isPrimary) return false;
      if (!anySwipe(opts.allowed())) return false;
      id = e.pointerId;
      x0 = e.x;
      y0 = e.y;
      dx = 0;
      axis = 'pending';
      return true;
    },
    move(e) {
      if (id === null || e.pointerId !== id) return false;
      const mx = e.x - x0;
      if (axis === 'pending') {
        axis = lockAxis(mx, e.y - y0);
        if (axis === 'pending') return false;
        if (axis === 'x') swallow = true;
      }
      if (axis === 'y') return false;
      dx = mx;
      opts.onFrame(swipeVisual(dx, opts.width(), opts.allowed(), opts.reducedMotion()));
      return true;
    },
    up(e) {
      if (id === null || e.pointerId !== id) return;
      const side = axis === 'x' ? releaseDecision(dx, opts.width(), opts.allowed()) : null;
      reset();
      if (side) opts.onCommit(side);
    },
    cancel() {
      if (id === null) return;
      reset();
    },
    consumeClick() {
      const s = swallow;
      swallow = false;
      return s;
    },
  };
}
