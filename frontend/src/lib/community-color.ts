/**
 * A project's colour: the band its page, its switcher row and its tab wear.
 *
 * ── Where it comes from ────────────────────────────────────────────────
 *
 *   1. Its dapp.json can set one beside its icon,
 *      `"icon": { "image": "brand/icon.png", "color": "#2e6660" }`. It is a
 *      line like any other, so changing it is a proposal members vote on. The
 *      server stores it as `apps.icon_color` and every app payload carries it
 *      as `icon_color` (src/services/app-manifest.js readIcon).
 *   2. Otherwise it comes from the icon, read here in the browser: the hue
 *      most of the icon's coloured pixels share, averaged (`deriveFromPixels`).
 *      An emoji icon is drawn and read the same way. An icon with no colour in
 *      it (black and white) gives graphite, and a project with no icon at all
 *      picks from its name, from the same six swatches people get.
 *
 * Either way the colour is FITTED (`fitForWhiteText`): its hue kept, its
 * chroma capped so a neon icon does not make a neon page, and its lightness
 * lowered until white text on it passes 4.5:1. That is also what keeps a
 * colour a project sets from making its own page unreadable.
 *
 * ── Why the browser, and what it costs ─────────────────────────────────
 *
 * The icon is already on the page (the tile draws it), from the same origin,
 * so reading it is a canvas draw of a 64px copy, once per icon: the answer is
 * kept in localStorage under the icon's own address, which changes whenever
 * its bytes do (`/app-icons/:id` is immutable). Emoji apps and apps with no
 * icon need no image at all. Nothing is fetched and nothing is stored on the
 * server, so the apps that exist today get a colour without a backfill.
 *
 * The maths is OKLab/OKLCH (Björn Ottosson's, the same the CSS `oklch()`
 * function uses), because "the same colour, darker" is only true there: in
 * sRGB, darkening a yellow turns it olive.
 */

import { useEffect, useState } from 'react';

export interface ColorSource {
  /** What dapp.json set, or null. */
  color?: string | null;
  iconUrl?: string | null;
  iconEmoji?: string | null;
  /** Picks the swatch when there is no icon. The slug is steadier than a name. */
  key: string;
}

/** The colour of a project whose icon has none of its own. */
export const GRAPHITE = '#2a2e34';

/** The swatches a name picks from: the people's own (messages/format.tsx). */
const SWATCHES = ['#5b7553', '#c0532f', '#6fb3a8', '#4a6fa5', '#8a5a83', '#b08344'];

/* ── colour maths ──────────────────────────────────────────────────── */

type Lin = [number, number, number];

const toLin = (c: number): number => {
  const v = c / 255;
  return v <= 0.04045 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4);
};
const toByte = (c: number): number => {
  const v = c <= 0.0031308 ? 12.92 * c : 1.055 * Math.pow(c, 1 / 2.4) - 0.055;
  return Math.round(Math.max(0, Math.min(1, v)) * 255);
};

/** sRGB bytes to OKLab. */
export function rgbToLab(r: number, g: number, b: number): [number, number, number] {
  const lr = toLin(r); const lg = toLin(g); const lb = toLin(b);
  const l = Math.cbrt(0.4122214708 * lr + 0.5363325363 * lg + 0.0514459929 * lb);
  const m = Math.cbrt(0.2119034982 * lr + 0.6806995451 * lg + 0.1073969566 * lb);
  const s = Math.cbrt(0.0883024619 * lr + 0.2817188376 * lg + 0.6299787005 * lb);
  return [
    0.2104542553 * l + 0.793617785 * m - 0.0040720468 * s,
    1.9779984951 * l - 2.428592205 * m + 0.4505937099 * s,
    0.0259040371 * l + 0.7827717662 * m - 0.808675766 * s,
  ];
}

function labToLin(L: number, a: number, b: number): Lin {
  const l = Math.pow(L + 0.3963377774 * a + 0.2158037573 * b, 3);
  const m = Math.pow(L - 0.1055613458 * a - 0.0638541728 * b, 3);
  const s = Math.pow(L - 0.0894841775 * a - 1.291485548 * b, 3);
  return [
    4.0767416621 * l - 3.3077115913 * m + 0.2309699292 * s,
    -1.2684380046 * l + 2.6097574011 * m - 0.3413193965 * s,
    -0.0041960863 * l - 0.7034186147 * m + 1.707614701 * s,
  ];
}

const fromLch = (L: number, C: number, h: number): Lin => labToLin(L, C * Math.cos(h), C * Math.sin(h));
const inGamut = (lin: Lin): boolean => lin.every((v) => v >= -0.0005 && v <= 1.0005);
const luminance = (lin: Lin): number => 0.2126 * Math.max(0, lin[0]) + 0.7152 * Math.max(0, lin[1]) + 0.0722 * Math.max(0, lin[2]);
const toHex = (lin: Lin): string => `#${lin.map((v) => toByte(v).toString(16).padStart(2, '0')).join('')}`;

/** A hex colour (#rgb or #rrggbb) as bytes, or null. */
export function parseHex(hex: string | null | undefined): [number, number, number] | null {
  const m = String(hex || '').trim().toLowerCase().match(/^#([0-9a-f]{3}|[0-9a-f]{6})$/);
  if (!m) return null;
  const h = m[1].length === 3 ? m[1].split('').map((c) => c + c).join('') : m[1];
  return [parseInt(h.slice(0, 2), 16), parseInt(h.slice(2, 4), 16), parseInt(h.slice(4, 6), 16)];
}

/** White text's contrast on a hex colour. */
export function contrastWithWhite(hex: string): number {
  const rgb = parseHex(hex);
  if (!rgb) return 0;
  const lin: Lin = [toLin(rgb[0]), toLin(rgb[1]), toLin(rgb[2])];
  return 1.05 / (luminance(lin) + 0.05);
}

/**
 * The colour a page can wear behind white text: the same hue, chroma capped
 * at 0.15 and lightness at 0.62, then lowered until white passes 4.5:1 (4.6,
 * for rounding's sake), pulling chroma in wherever the colour leaves sRGB.
 */
export function fitLch(L0: number, C0: number, h: number): string {
  let L = Math.min(L0, 0.62);
  const C = Math.min(C0, 0.15);
  for (let i = 0; i < 240; i += 1) {
    let c = C;
    let lin = fromLch(L, c, h);
    while (!inGamut(lin) && c > 0) { c -= 0.004; lin = fromLch(L, c, h); }
    if (1.05 / (luminance(lin) + 0.05) >= 4.6 || L <= 0.2) return toHex(lin);
    L -= 0.005;
  }
  return GRAPHITE;
}

/** `fitLch` for a hex colour; null for anything that is not one. */
export function fitForWhiteText(hex: string | null | undefined): string | null {
  const rgb = parseHex(hex);
  if (!rgb) return null;
  const [L, a, b] = rgbToLab(rgb[0], rgb[1], rgb[2]);
  return fitLch(L, Math.hypot(a, b), Math.atan2(b, a));
}

/** A swatch for a key, the way a person's is picked (FNV-1a, then mixed). */
export function swatchFor(key: string): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < key.length; i += 1) h = Math.imul(h ^ key.charCodeAt(i), 0x01000193);
  h ^= h >>> 16; h = Math.imul(h, 0x45d9f3b); h ^= h >>> 16;
  return SWATCHES[(h >>> 0) % SWATCHES.length];
}

/**
 * An icon's colour from its pixels (RGBA bytes, any size): drop the
 * transparent ones and the near-greys, file the rest by hue in 24 bins
 * weighted by how coloured each is, take the heaviest bin with its two
 * neighbours, and average those pixels in OKLab. Null when under 3% of the
 * icon is coloured at all: a black-and-white icon has no hue to lend.
 */
export function deriveFromPixels(data: ArrayLike<number>): string | null {
  const BINS = 24;
  const weight = new Array<number>(BINS).fill(0);
  const px: Array<[number, number, number, number, number]> = [];
  let opaque = 0;
  for (let i = 0; i + 3 < data.length; i += 4) {
    if (data[i + 3] < 128) continue;
    opaque += 1;
    const [L, a, b] = rgbToLab(data[i], data[i + 1], data[i + 2]);
    const C = Math.hypot(a, b);
    if (C < 0.045 || L < 0.22 || L > 0.95) continue;
    let h = Math.atan2(b, a);
    if (h < 0) h += 2 * Math.PI;
    const bin = Math.floor((h / (2 * Math.PI)) * BINS) % BINS;
    weight[bin] += C;
    px.push([bin, L, a, b, C]);
  }
  if (!px.length || px.length / Math.max(1, opaque) < 0.03) return null;
  let best = 0;
  let bestW = -1;
  for (let k = 0; k < BINS; k += 1) {
    const w = weight[k] + 0.5 * (weight[(k + 1) % BINS] + weight[(k + BINS - 1) % BINS]);
    if (w > bestW) { bestW = w; best = k; }
  }
  let sw = 0; let sL = 0; let sa = 0; let sb = 0;
  for (const [bin, L, a, b, C] of px) {
    const d = Math.min((bin - best + BINS) % BINS, (best - bin + BINS) % BINS);
    if (d > 1) continue;
    sw += C; sL += L * C; sa += a * C; sb += b * C;
  }
  const a = sa / sw; const b = sb / sw;
  return fitLch(sL / sw, Math.hypot(a, b), Math.atan2(b, a));
}

/* ── the answer for a project ──────────────────────────────────────── */

const CACHE_PREFIX = 'communityColor:v1:';
const memo = new Map<string, string>();

function cacheKey(src: ColorSource): string | null {
  if (src.iconUrl) return `img:${src.iconUrl}`;
  if (src.iconEmoji) return `emoji:${src.iconEmoji}`;
  return null;
}

function readCache(key: string): string | null {
  if (memo.has(key)) return memo.get(key) || null;
  try {
    const v = window.localStorage.getItem(CACHE_PREFIX + key);
    if (v && parseHex(v)) { memo.set(key, v); return v; }
  } catch { /* storage blocked: derive again */ }
  return null;
}

function writeCache(key: string, value: string): void {
  memo.set(key, value);
  try { window.localStorage.setItem(CACHE_PREFIX + key, value); } catch { /* best effort */ }
}

/**
 * What can be said without reading an icon: the set colour, a cached reading,
 * the name's swatch when there is no icon at all, or null while an icon still
 * has to be read.
 */
export function communityColorNow(src: ColorSource): string | null {
  const set = fitForWhiteText(src.color);
  if (set) return set;
  const key = cacheKey(src);
  if (!key) return fitForWhiteText(swatchFor(src.key)) || GRAPHITE;
  return typeof window === 'undefined' ? null : readCache(key);
}

function pixelsOf(draw: (ctx: CanvasRenderingContext2D) => void): Uint8ClampedArray | null {
  try {
    const canvas = document.createElement('canvas');
    canvas.width = 64;
    canvas.height = 64;
    const ctx = canvas.getContext('2d', { willReadFrequently: true } as CanvasRenderingContext2DSettings);
    if (!ctx) return null;
    draw(ctx);
    return ctx.getImageData(0, 0, 64, 64).data;
  } catch {
    // A tainted canvas (an icon served from elsewhere) or no canvas at all.
    return null;
  }
}

const inflight = new Map<string, Promise<string>>();

/** Read an icon (or emoji) once, and remember the answer. */
export function deriveCommunityColor(src: ColorSource): Promise<string> {
  const now = communityColorNow(src);
  if (now) return Promise.resolve(now);
  const key = cacheKey(src) as string;
  const running = inflight.get(key);
  if (running) return running;
  const job = new Promise<string>((resolve) => {
    const finish = (data: Uint8ClampedArray | null) => {
      const color = (data && deriveFromPixels(data)) || GRAPHITE;
      writeCache(key, color);
      inflight.delete(key);
      resolve(color);
    };
    if (src.iconUrl) {
      const img = new Image();
      img.decoding = 'async';
      img.onload = () => finish(pixelsOf((ctx) => ctx.drawImage(img, 0, 0, 64, 64)));
      img.onerror = () => { inflight.delete(key); resolve(GRAPHITE); };
      img.src = src.iconUrl;
    } else {
      finish(pixelsOf((ctx) => {
        ctx.font = '52px "Apple Color Emoji", "Segoe UI Emoji", "Noto Color Emoji", sans-serif';
        ctx.textAlign = 'center';
        ctx.textBaseline = 'middle';
        ctx.fillText(src.iconEmoji || '', 32, 36);
      }));
    }
  });
  inflight.set(key, job);
  return job;
}

/**
 * The colour for a project, as a hook: whatever can be said at once, then the
 * icon's reading when it lands. `fallback` stands in until then (graphite
 * unless the caller has something better), so a first visit settles once and
 * every later one paints its colour on the first frame.
 */
export function useCommunityColor(src: ColorSource | null, fallback: string = GRAPHITE): string {
  return useResolvedCommunityColor(src) || fallback;
}

/**
 * The colour once it is known: null while there is no source, or while an
 * icon is still being read, so a caller can keep what it showed before (the
 * header does, between one community and the next).
 */
export function useResolvedCommunityColor(src: ColorSource | null): string | null {
  const [color, setColor] = useState<string | null>(() => (src ? communityColorNow(src) : null));
  const sig = src ? `${src.color || ''}|${src.iconUrl || ''}|${src.iconEmoji || ''}|${src.key}` : '';
  useEffect(() => {
    if (!src) { setColor(null); return undefined; }
    let live = true;
    const now = communityColorNow(src);
    setColor(now);
    if (!now) void deriveCommunityColor(src).then((c) => { if (live) setColor(c); });
    return () => { live = false; };
  }, [sig]); // eslint-disable-line react-hooks/exhaustive-deps
  return color;
}
