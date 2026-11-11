/**
 * A project's card picture comes in two shapes.
 *
 *   square   a picture the card CROPS to its 16:10 (`object-cover`), framed
 *            by the editor's zoom and offsets: every picture before stills;
 *   still    a card still (src/services/card-still.js): the project being
 *            used, made from its real screen at the card's own 16:10, which
 *            every card draws WHOLE and never frames.
 *
 * The server decides which from the image's own size
 * (src/services/illustration-proposals.js shapeOf) and stores it on the
 * record as `shape: 'still'`; the public directory says it as
 * `illustration_shape`. `isStillSize` is the same rule, for the editor's
 * preview of a picture not yet sent.
 */

export type IllustrationShape = 'still' | 'square';

/** The card's own aspect. */
export const STILL_ASPECT = 16 / 10;
/** How far from 16:10 a still may be (card-still.js ASPECT_TOLERANCE). */
export const STILL_TOLERANCE = 0.005;
/** The narrowest still (card-still.js MIN_STILL_WIDTH). */
export const MIN_STILL_WIDTH = 640;

/** Whether a stored picture record, or a directory shape, is a still. */
export function isStill(art: { shape?: unknown } | IllustrationShape | null | undefined): boolean {
  if (!art) return false;
  return typeof art === 'string' ? art === 'still' : art.shape === 'still';
}

/** Whether a picture this size is a still (16:10, wide enough for 2×). */
export function isStillSize(width: number, height: number): boolean {
  if (!Number.isFinite(width) || !Number.isFinite(height) || width < MIN_STILL_WIDTH || height <= 0) return false;
  return Math.abs(width / height / STILL_ASPECT - 1) <= STILL_TOLERANCE;
}
