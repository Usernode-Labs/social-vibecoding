/**
 * The new Needs you review flow's data, as plain functions (no React, no DOM),
 * so the pictures' crops and the feed's order can be tested on their own.
 *
 * Its rows are the Communities tab's own feed (GET /api/workshop/needs-feed,
 * ../workshop/needs-reel.tsx `NeedsFeedItem`), and its pictures are the
 * change's before & after shots shaped the way every other feed shapes them
 * (`AppView._workshopVisuals`): screens, each a before and an after still of
 * the same viewport with the areas that differ.
 */

import type { NeedsFeedItem } from '../workshop/needs-reel';
import { plainSummary } from '../workshop/needs-reel';

export type Box = { x: number; y: number; w: number; h: number };
export type Region = {
  n: number;
  b: number[] | null;
  a: number[] | null;
  bMark?: number[] | null;
  aMark?: number[] | null;
};
export type ReviewScreen = {
  viewport: string;
  width: number;
  before: { url: string; height: number };
  after: { url: string; height: number };
  regions: Region[];
};
export type ReviewItem = {
  key: string;
  kind: 'proposal' | 'governance';
  id: number;
  title: string;
  summary: string;
  epoch: number | null;
  author: string | null;
  at: string | null;
  number: number | null;
  app: NeedsFeedItem['app'];
  stagingUrl: string | null;
  /** The screens to compare, phone screens first when there are any. */
  screens: ReviewScreen[];
  /** An older change's single capture pair, with no regions. */
  pair: { before: string | null; after: string | null } | null;
  ground: string;
  approve: boolean;
  advisory: boolean;
  uncounted: boolean;
};

/**
 * The ground under a change's picture: how much it changes, said in colour.
 * Calm cream for one spot, warm yellow for a few, coral for a lot. The same
 * three grounds the title shots were designed with.
 */
export const GROUNDS = { quiet: '#ECE6CE', notable: '#F7E07A', loud: '#F2958A' } as const;

export function groundFor(screens: ReviewScreen[]): string {
  const spots = screens.reduce((n, s) => n + s.regions.length, 0);
  if (screens.length > 1 || spots >= 4) return GROUNDS.loud;
  if (spots >= 2) return GROUNDS.notable;
  return GROUNDS.quiet;
}

/** A phone screen when there is one: this flow is drawn for the phone first. */
export function pickScreens(screens: ReviewScreen[]): ReviewScreen[] {
  const phone = screens.filter((s) => s.viewport === 'mobile' || s.width < 500);
  return phone.length ? phone : screens;
}

type Visuals = {
  screens?: ReviewScreen[];
  before?: string | null;
  after?: string | null;
  protected?: boolean;
} | null;

/** A legacy pair's id is served from /visuals/<id>; a shots url is already a path. */
function pairUrl(value: string | null | undefined, isProtected: boolean): string | null {
  if (!value) return null;
  return isProtected || value.startsWith('/') ? value : `/visuals/${value}`;
}

/**
 * The feed's items as the flow draws them. `shape` is
 * `AppView._workshopVisuals` (passed in so this stays testable).
 */
export function toReviewItems(
  items: NeedsFeedItem[],
  shape: (visuals: unknown, shots: unknown) => Visuals,
): ReviewItem[] {
  return items.map((item) => {
    const change = item.kind !== 'governance';
    const v = change && (item.shots || item.visuals) ? shape(item.visuals || null, item.shots || null) : null;
    const screens = pickScreens(Array.isArray(v?.screens) ? v!.screens! : []);
    const pair = !screens.length && v && (v.before || v.after)
      ? { before: pairUrl(v.before, !!v.protected), after: pairUrl(v.after, !!v.protected) }
      : null;
    const raw = item as NeedsFeedItem & { staging_url?: string | null };
    return {
      key: `${change ? 'proposal' : 'governance'}:${item.id}`,
      kind: change ? 'proposal' : 'governance',
      id: item.id,
      title: item.title || '',
      summary: plainSummary(item.summary),
      epoch: item.epoch ?? null,
      author: item.author || null,
      at: item.at || null,
      number: item.number ?? null,
      app: item.app,
      stagingUrl: typeof raw.staging_url === 'string' && raw.staging_url ? raw.staging_url : null,
      screens,
      pair,
      ground: groundFor(screens),
      approve: !!item.approve,
      advisory: !!item.advisory,
      uncounted: !!item.uncounted,
    };
  });
}

/** A region's box on one side, or a mark line's box (zero height). */
export function regionBox(r: Region, side: 'before' | 'after'): Box | null {
  const box = side === 'before' ? r.b : r.a;
  if (box && box.length === 4) return { x: box[0], y: box[1], w: box[2], h: box[3] };
  const mark = side === 'before' ? r.bMark : r.aMark;
  if (mark && mark.length === 3) return { x: mark[0], y: mark[1], w: mark[2], h: 0 };
  return null;
}

/** Everything that differs, on the given sides, with room around it, kept on the screen. */
export function focusBox(screen: ReviewScreen, sides: Array<'before' | 'after'>, pad: number): Box {
  const W = screen.width;
  const H = Math.max(screen.before.height, screen.after.height);
  const boxes = screen.regions.flatMap((r) => sides.map((s) => regionBox(r, s))).filter((b): b is Box => !!b);
  if (!boxes.length) return { x: 0, y: 0, w: W, h: Math.min(H, W * 0.75) };
  const x0 = Math.max(0, Math.min(...boxes.map((b) => b.x)) - pad);
  const y0 = Math.max(0, Math.min(...boxes.map((b) => b.y)) - pad);
  const x1 = Math.min(W, Math.max(...boxes.map((b) => b.x + b.w)) + pad);
  const y1 = Math.min(H, Math.max(...boxes.map((b) => b.y + Math.max(b.h, 2))) + pad);
  return { x: x0, y: y0, w: Math.max(1, x1 - x0), h: Math.max(1, y1 - y0) };
}

export type Placement = { scale: number; tx: number; ty: number };

/**
 * Where the whole screen goes so `box` sits in the middle of a `view`, as
 * large as fits but never past `maxScale`, without showing past the screen's
 * edges when the screen is larger than the view. ONE placement for both
 * sides, so a seam between them never moves what it compares.
 */
export function placeBox(
  screen: ReviewScreen, box: Box, view: { w: number; h: number }, maxScale = 1,
): Placement {
  const W = screen.width;
  const H = Math.max(screen.before.height, screen.after.height);
  const scale = Math.max(0.05, Math.min(maxScale, view.w / box.w, view.h / box.h));
  const sw = W * scale;
  const sh = H * scale;
  const centre = (size: number, scaled: number, mid: number) => (scaled <= size
    ? (size - scaled) / 2
    : Math.max(size - scaled, Math.min(0, size / 2 - mid * scale)));
  return { scale, tx: centre(view.w, sw, box.x + box.w / 2), ty: centre(view.h, sh, box.y + box.h / 2) };
}

/**
 * The title shot: the after side's changed area, as a plate sized to its own
 * proportions inside the card's room (at most `room.w` by `room.h`).
 * Returns the plate's size and where the screen sits inside it.
 */
export function titleCrop(screen: ReviewScreen, room: { w: number; h: number }): { w: number; h: number; place: Placement } {
  const box = focusBox(screen, ['after'], 20);
  const k = Math.min(2, room.w / box.w, room.h / box.h);
  const w = Math.round(box.w * k);
  const h = Math.round(box.h * k);
  return { w, h, place: { scale: k, tx: -box.x * k, ty: -box.y * k } };
}

/* ── The seam's feel ───────────────────────────────────────────────────── */

/**
 * iOS-style resistance past an edge: the further the finger goes, the less
 * the seam follows. `c` is the rubber band's stiffness (0.55 feels like iOS).
 */
export function rubberBand(overshoot: number, width: number, c = 0.55): number {
  const d = Math.abs(overshoot);
  const out = (1 - 1 / ((d * c) / width + 1)) * width;
  return overshoot < 0 ? -out : out;
}

/**
 * Soft stops: near a stop the seam is pulled onto it, strongest at the stop
 * and gone by `radius`. Stops are the left and right edges of each changed
 * area (with a little room) and its middle.
 */
export function seamStops(screen: ReviewScreen, place: Placement, width: number): number[] {
  const stops: number[] = [];
  for (const r of screen.regions) {
    for (const side of ['before', 'after'] as const) {
      const b = regionBox(r, side);
      if (!b || b.w <= 0) continue;
      const x0 = b.x * place.scale + place.tx;
      const x1 = (b.x + b.w) * place.scale + place.tx;
      [x0 - 14, (x0 + x1) / 2, x1 + 14].forEach((x) => { if (x > 8 && x < width - 8) stops.push(x); });
    }
  }
  return stops.sort((a, b) => a - b);
}

export function magnet(x: number, stops: number[], radius = 18, strength = 0.8): number {
  let out = x;
  for (const p of stops) {
    const d = x - p;
    const u = Math.abs(d) / radius;
    if (u < 1) {
      const w = (1 - u * u) * (1 - u * u);
      out -= d * strength * w;
    }
  }
  return out;
}

/** The next change after `index`, wrapping round; -1 when there is only this one. */
export function nextIndex(items: ReviewItem[], index: number): number {
  if (items.length < 2) return -1;
  return (index + 1) % items.length;
}
