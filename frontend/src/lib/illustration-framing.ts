/**
 * Framing math for a featured illustration — the card's crop, expressed the
 * way the API stores it.
 *
 * The stored shape is unchanged: `{ zoom, x, y }`, rendered on the Discover
 * card as `transform: translate(x%, y%) scale(zoom)` over an image that
 * `object-fit: cover`s the art block. Because the translate sits OUTSIDE the
 * scale in that list, its percentages resolve against the art block's own
 * box and are not multiplied by the zoom — which is what makes the cover
 * constraint a one-liner:
 *
 *   the scaled art spans ±zoom/2 of the block and is shifted by x/100,
 *   so it still covers the block exactly while |x| <= 50 * (zoom - 1).
 *
 * Hence zoom bottoms out at 1 (the exact cover fit, where the only legal
 * offset is 0) rather than at the API's permissive 0.5. The editor drives
 * every gesture through these helpers, and the card re-clamps on render, so
 * no combination of input or stored value can open a gutter.
 */

export type Frame = { zoom: number; x: number; y: number };

export const MIN_ZOOM = 1;
export const MAX_ZOOM = 3;
export const DEFAULT_FRAME: Frame = { zoom: MIN_ZOOM, x: 0, y: 0 };

const round = (n: number, places: number) => {
  const factor = 10 ** places;
  const rounded = Math.round(n * factor) / factor;
  return rounded === 0 ? 0 : rounded; // never -0, which reads back as "-0" in a query string
};
const finite = (n: number, fallback: number) => (Number.isFinite(n) ? n : fallback);

/** Clamp a frame — from a gesture, a keypress or the server — so the art
 *  covers the card with no empty gutter on any edge. */
export function clampFrame(frame: Frame): Frame {
  const zoom = Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, finite(frame?.zoom, MIN_ZOOM)));
  const limit = (zoom - 1) * 50;
  const axis = (n: number) => round(Math.min(limit, Math.max(-limit, finite(n, 0))), 2);
  return { zoom: round(zoom, 3), x: axis(frame?.x), y: axis(frame?.y) };
}

/** Pan by a drag, measured as a fraction of the card's art block. */
export function panFrame(frame: Frame, dxFraction: number, dyFraction: number): Frame {
  return clampFrame({
    zoom: frame.zoom,
    x: frame.x + finite(dxFraction, 0) * 100,
    y: frame.y + finite(dyFraction, 0) * 100,
  });
}

/**
 * Zoom by `factor`, holding whatever sits under (`anchorX`, `anchorY`) — each
 * a 0..1 fraction of the art block from its top-left — under that same point.
 * That is what makes a wheel zoom track the cursor and a pinch track the
 * midpoint of the two fingers, instead of always pulling toward the centre.
 */
export function zoomFrame(frame: Frame, factor: number, anchorX = 0.5, anchorY = 0.5): Frame {
  const from = clampFrame(frame);
  const scale = finite(factor, 1) > 0 ? finite(factor, 1) : 1;
  const to = clampFrame({ ...from, zoom: from.zoom * scale });
  const ratio = to.zoom / from.zoom;
  // Solve `anchor = ratio * (anchor - offset') + offset'` for the new offset,
  // in percent-of-block units measured from the centre.
  const hold = (anchor: number, offset: number) => {
    const point = (finite(anchor, 0.5) - 0.5) * 100;
    return point - ratio * (point - offset);
  };
  return clampFrame({ zoom: to.zoom, x: hold(anchorX, from.x), y: hold(anchorY, from.y) });
}

/** A wheel / trackpad notch as a multiplicative zoom factor. Exponential so
 *  the step feels the same at 1× and at 3×, and capped so one flung wheel
 *  event cannot jump the whole range. */
export function wheelZoomFactor(deltaY: number, deltaMode = 0): number {
  const perUnit = deltaMode === 1 ? 16 : deltaMode === 2 ? 400 : 1;
  const pixels = Math.max(-240, Math.min(240, finite(deltaY, 0) * perUnit));
  return Math.exp(-pixels / 320);
}

/** The distance between the first two live pointers, for a pinch. */
export function spreadOf(points: { x: number; y: number }[]): number {
  if (points.length < 2) return 0;
  return Math.hypot(points[0].x - points[1].x, points[0].y - points[1].y);
}

/** The midpoint of the live pointers — the drag reference for one finger, the
 *  pinch anchor for two. */
export function centreOf(points: { x: number; y: number }[]): { x: number; y: number } {
  const n = Math.min(points.length, 2) || 1;
  const used = points.slice(0, n);
  return {
    x: used.reduce((sum, p) => sum + p.x, 0) / n,
    y: used.reduce((sum, p) => sum + p.y, 0) / n,
  };
}
