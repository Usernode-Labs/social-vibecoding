/**
 * The arithmetic of the photo positioning step (#3525), and nothing else.
 *
 * ── Why there is a positioning step at all ────────────────────────────
 *
 * Choosing a profile photo used to stage it at once: Profile._prepareAvatar
 * cut the largest centred square out of whatever was picked and the circle on
 * the card showed the result. A person in the left third of a landscape shot,
 * or a face near the top of a tall one, came out as a shoulder, and the only
 * remedy was to crop the file somewhere else and pick it again. The request
 * asked for the step every phone's contact editor has: the photo lands in a
 * frame, you drag it to choose the part that shows, zoom if you like, and
 * accept or cancel before anything is staged.
 *
 * ── The one representation ────────────────────────────────────────────
 *
 * The state is the square the upload will be cut from, in the SOURCE image's
 * own pixels: `{ x, y, size }`. Everything else is derived from it — the zoom
 * (the cover square's side over `size`), where the photo sits in the frame
 * (percentages of the frame, so drawing it needs no measurement), and what a
 * drag of so many screen pixels means (`size / frame` source pixels each).
 * Keeping the rectangle rather than an offset and a scale is what lets
 * `sourceRect` be the literal argument to `drawImage`, with nothing converted
 * on the way to the canvas.
 *
 * Three rules hold after every step, and `clampCrop` is where they live:
 *
 *   * the square never leaves the image — no blank edge is ever uploaded,
 *     so there is no fill colour to choose and nothing transparent to encode;
 *   * `size` is at most the image's short side (zoom 1, the photo just
 *     covers the frame) and at least that over CROP_MAX_ZOOM;
 *   * a value that is not a finite number is treated as zero rather than
 *     propagated, so one bad event cannot put NaN into the upload.
 *
 * Untouched, the step hands over exactly the square the old automatic crop
 * cut (`initialCrop`, whose floor matches the one it replaced), so accepting
 * without dragging changes nothing about what gets uploaded.
 *
 * Pure: no DOM, no React, no clock. The dialog (./avatar-crop-dialog.tsx)
 * turns pointer and key events into calls here, and tests/avatar-crop.test.js
 * executes it.
 */

/** The square to cut, in source-image pixels. */
export interface CropRect {
  x: number;
  y: number;
  size: number;
}

/**
 * How far in the slider goes: the upload is then cut from a quarter of the
 * short side. Past that a phone photo's face is a few hundred pixels across
 * and the 512px avatar starts to look soft.
 */
export const CROP_MAX_ZOOM = 4;

/** One arrow press moves the photo this share of what the frame shows. */
export const CROP_NUDGE_SHARE = 0.05;

/** Shift with an arrow moves it this many presses' worth at once. */
export const CROP_NUDGE_BIG = 5;

/** One press of + or − zooms by this factor. */
export const CROP_ZOOM_STEP = 1.1;

const finite = (n: number): number => (Number.isFinite(n) ? n : 0);

/** The side of the largest square the image holds: zoom 1. */
export function coverSide(width: number, height: number): number {
  const side = Math.min(finite(width), finite(height));
  return side > 0 ? side : 0;
}

/**
 * The same square, moved and sized back inside the rules above. An image with
 * no area has no square at all, and gets `size: 0` for the caller to refuse.
 */
export function clampCrop(crop: CropRect, width: number, height: number): CropRect {
  const side = coverSide(width, height);
  if (!side) return { x: 0, y: 0, size: 0 };
  const wanted = finite(crop.size);
  const size = Math.min(side, Math.max(side / CROP_MAX_ZOOM, wanted > 0 ? wanted : side));
  const x = Math.min(width - size, Math.max(0, finite(crop.x)));
  const y = Math.min(height - size, Math.max(0, finite(crop.y)));
  return { x, y, size };
}

/**
 * Where the step opens: the largest centred square, which is the crop every
 * photo got before there was a step. The floor is the one that code used.
 */
export function initialCrop(width: number, height: number): CropRect {
  const side = coverSide(width, height);
  if (!side) return { x: 0, y: 0, size: 0 };
  return {
    x: Math.floor((width - side) / 2),
    y: Math.floor((height - side) / 2),
    size: side,
  };
}

/** 1 when the photo just covers the frame, CROP_MAX_ZOOM at the far end. */
export function zoomOf(crop: CropRect, width: number, height: number): number {
  const side = coverSide(width, height);
  return side && crop.size > 0 ? side / crop.size : 1;
}

/**
 * The photo dragged by (dx, dy) screen pixels in a frame `frame` pixels
 * across. The photo follows the finger, so the square moves the other way:
 * dragging left shows more of the right of the picture.
 */
export function panCrop(
  crop: CropRect, dx: number, dy: number, frame: number, width: number, height: number,
): CropRect {
  if (!(frame > 0)) return clampCrop(crop, width, height);
  const perPixel = crop.size / frame;
  return clampCrop(
    { x: crop.x - finite(dx) * perPixel, y: crop.y - finite(dy) * perPixel, size: crop.size },
    width, height,
  );
}

/**
 * Zoom to `zoom`, keeping the point of the photo under (fx, fy) where it is.
 * `fx` and `fy` are fractions of the frame: the centre for the slider and the
 * keys, the pinch's midpoint or the wheel's pointer for those. Near an edge
 * the clamp wins, so zooming out beside one slides the photo back in rather
 * than opening a gap.
 */
export function zoomCrop(
  crop: CropRect, zoom: number, width: number, height: number, fx = 0.5, fy = 0.5,
): CropRect {
  const side = coverSide(width, height);
  if (!side) return { x: 0, y: 0, size: 0 };
  const z = Math.min(CROP_MAX_ZOOM, Math.max(1, finite(zoom) || 1));
  const size = side / z;
  const px = crop.x + finite(fx) * crop.size;
  const py = crop.y + finite(fy) * crop.size;
  return clampCrop({ x: px - finite(fx) * size, y: py - finite(fy) * size, size }, width, height);
}

/**
 * The keyboard's version of the drag and the pinch. The arrows move the photo
 * the way they point, as the finger does; `+`/`=` and `-`/`_` zoom about the
 * centre. Null for any other key, so the caller leaves it alone (Tab, Enter
 * and Escape keep their meaning).
 */
export function nudgeCrop(
  crop: CropRect, key: string, width: number, height: number, big = false,
): CropRect | null {
  const step = crop.size * CROP_NUDGE_SHARE * (big ? CROP_NUDGE_BIG : 1);
  switch (key) {
    case 'ArrowLeft': return clampCrop({ ...crop, x: crop.x + step }, width, height);
    case 'ArrowRight': return clampCrop({ ...crop, x: crop.x - step }, width, height);
    case 'ArrowUp': return clampCrop({ ...crop, y: crop.y + step }, width, height);
    case 'ArrowDown': return clampCrop({ ...crop, y: crop.y - step }, width, height);
    case '+':
    case '=':
      return zoomCrop(crop, zoomOf(crop, width, height) * CROP_ZOOM_STEP, width, height);
    case '-':
    case '_':
      return zoomCrop(crop, zoomOf(crop, width, height) / CROP_ZOOM_STEP, width, height);
    default:
      return null;
  }
}

/**
 * What Profile._prepareAvatar draws: whole pixels, still inside the image.
 * Rounded AFTER clamping and clamped again after rounding, so a square that
 * sat flush with the right edge at a fractional x cannot round one pixel past
 * it.
 */
export function sourceRect(crop: CropRect, width: number, height: number): CropRect {
  const side = coverSide(width, height);
  if (!side) return { x: 0, y: 0, size: 0 };
  const c = clampCrop(crop, width, height);
  const size = Math.max(1, Math.min(Math.floor(side), Math.round(c.size)));
  return {
    x: Math.min(Math.floor(width) - size, Math.max(0, Math.round(c.x))),
    y: Math.min(Math.floor(height) - size, Math.max(0, Math.round(c.y))),
    size,
  };
}

const pct = (n: number): string => `${(n * 100).toFixed(4)}%`;

/**
 * Where the photo sits in the frame, as CSS lengths relative to the frame:
 * the whole picture drawn so that exactly the square fills the frame. Being
 * percentages, it needs no measurement and survives the frame resizing under
 * it (a phone turned sideways, the keyboard coming up).
 */
export function photoPlacement(crop: CropRect, width: number, height: number): {
  left: string; top: string; width: string; height: string;
} {
  const s = crop.size > 0 ? crop.size : 1;
  return {
    left: pct(-crop.x / s),
    top: pct(-crop.y / s),
    width: pct(finite(width) / s),
    height: pct(finite(height) / s),
  };
}
