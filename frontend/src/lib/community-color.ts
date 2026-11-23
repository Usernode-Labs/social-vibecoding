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
 * A colour READ off an icon, an emoji or a name is fitted tighter (#3523,
 * `SOFT`): chroma at most 0.07 and lightness at most 0.50, a dusky version of
 * the hue that flavours the header rather than flooding it. The icon's own
 * brightest hue at 0.15 made a header as loud as the icon, which is right for
 * a 40px tile and too much for a band across the screen. A colour a project
 * SETS keeps the looser fit (`SET`): the group voted for that colour, and the
 * fit's only job there is that white text stays readable on it.
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

/** How far a fitted colour may go: its chroma and its lightness, at most. */
export interface FitCaps { C: number; L: number }

/** A colour dapp.json sets: readable behind white, otherwise as voted. */
export const SET: FitCaps = { C: 0.15, L: 0.62 };

/**
 * A colour read off an icon, an emoji or a name (#3523): a flavour of the hue
 * rather than the hue at full strength. Chosen side by side against the
 * looser caps over the swatches and a spread of saturated icon colours: the
 * hues stay told apart, and none of them reads as neon.
 */
export const SOFT: FitCaps = { C: 0.07, L: 0.50 };

/**
 * The colour a page can wear behind white text: the same hue, chroma and
 * lightness capped (`SET` unless told otherwise), then lowered until white
 * passes 4.5:1 (4.6, for rounding's sake), pulling chroma in wherever the
 * colour leaves sRGB.
 */
export function fitLch(L0: number, C0: number, h: number, caps: FitCaps = SET): string {
  let L = Math.min(L0, caps.L);
  const C = Math.min(C0, caps.C);
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
export function fitForWhiteText(hex: string | null | undefined, caps: FitCaps = SET): string | null {
  const rgb = parseHex(hex);
  if (!rgb) return null;
  const [L, a, b] = rgbToLab(rgb[0], rgb[1], rgb[2]);
  return fitLch(L, Math.hypot(a, b), Math.atan2(b, a), caps);
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
  const lab = dominantLab(data);
  return lab ? fitLch(lab[0], Math.hypot(lab[1], lab[2]), Math.atan2(lab[2], lab[1]), SOFT) : null;
}

/**
 * The same reading as `deriveFromPixels`, unfitted: the icon's main colour
 * as it is drawn, for a card's band (`useIconMainColor`), which is washed
 * out over the card's own ground rather than carrying white text. Null when
 * the icon has little colour.
 */
export function mainColorFromPixels(data: ArrayLike<number>): string | null {
  const lab = dominantLab(data);
  if (!lab) return null;
  let [L, a, b] = lab;
  let lin = labToLin(L, a, b);
  // A rounding step outside sRGB: pull the chroma in until it fits.
  for (let i = 0; i < 40 && !inGamut(lin); i += 1) { a *= 0.95; b *= 0.95; lin = labToLin(L, a, b); }
  return toHex(lin);
}

/** The OKLab average of an icon's heaviest hue and its two neighbours (see `deriveFromPixels`), or null. */
function dominantLab(data: ArrayLike<number>): [number, number, number] | null {
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
  return [sL / sw, sa / sw, sb / sw];
}

/* ── the answer for a project ──────────────────────────────────────── */

/* v2 (#3523): a reading is stored FITTED, and the fit for a read colour got
   softer, so a v1 reading would keep the old, louder colour on every device
   that had one. */
const CACHE_PREFIX = 'communityColor:v2:';
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
  if (!key) return fitForWhiteText(swatchFor(src.key), SOFT) || GRAPHITE;
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

/* ── an icon's main colour, for a card with no picture ─────────────── */

/**
 * A COMMUNITY CARD WITH NO PICTURE (decided 23 Nov 2026) draws its icon as
 * the picture, on a soft wash of the icon's MAIN colour: the colour itself,
 * not a blur of the icon (a two-tone icon blurred into a blotch) and not the
 * header's darkened fit. Where it comes from, in turn:
 *
 *   1. the colour dapp.json sets beside the icon, as it is;
 *   2. the icon's own pixels, read once from a 64px canvas copy of the
 *      same-origin image and kept under the icon's address
 *      (`mainColorFromPixels`);
 *   3. nothing, `'none'`, for an icon with little colour (black, white,
 *      grey), an emoji, an initial or no icon: the card then wears one of the
 *      brand's tints, chosen from the slug (`bandTint`).
 *
 * `null` means an image is still being read.
 */
export type MainColor = string | 'none' | null;

const MAIN_PREFIX = 'communityMain:v1:';
const mainMemo = new Map<string, string>();
const mainInflight = new Map<string, Promise<string>>();

/** A hex colour with enough colour in it to wash a band with, or null. */
function colourful(hex: string | null | undefined): string | null {
  const rgb = parseHex(hex);
  if (!rgb) return null;
  const [, a, b] = rgbToLab(rgb[0], rgb[1], rgb[2]);
  return Math.hypot(a, b) >= 0.045 ? String(hex).trim().toLowerCase() : null;
}

function readMain(key: string): string | null {
  if (mainMemo.has(key)) return mainMemo.get(key) || null;
  try {
    const v = window.localStorage.getItem(MAIN_PREFIX + key);
    if (v && (v === 'none' || parseHex(v))) { mainMemo.set(key, v); return v; }
  } catch { /* storage blocked: read it again */ }
  return null;
}

function writeMain(key: string, value: string): void {
  mainMemo.set(key, value);
  try { window.localStorage.setItem(MAIN_PREFIX + key, value); } catch { /* best effort */ }
}

/** What can be said at once: the set colour, a kept reading, `'none'` without an image, or null while one has to be read. */
export function iconMainColorNow(src: ColorSource): MainColor {
  const set = colourful(src.color);
  if (set) return set;
  if (!src.iconUrl) return 'none';
  return typeof window === 'undefined' ? null : readMain(src.iconUrl);
}

/** Read an icon's main colour once, and remember it. */
export function deriveIconMainColor(src: ColorSource): Promise<string> {
  const now = iconMainColorNow(src);
  if (now) return Promise.resolve(now);
  const key = src.iconUrl as string;
  const running = mainInflight.get(key);
  if (running) return running;
  const job = new Promise<string>((resolve) => {
    const img = new Image();
    img.decoding = 'async';
    img.onload = () => {
      const data = pixelsOf((ctx) => ctx.drawImage(img, 0, 0, 64, 64));
      const value = (data && mainColorFromPixels(data)) || 'none';
      writeMain(key, value);
      mainInflight.delete(key);
      resolve(value);
    };
    // Not kept: an icon that failed now may load next time.
    img.onerror = () => { mainInflight.delete(key); resolve('none'); };
    img.src = key;
  });
  mainInflight.set(key, job);
  return job;
}

/** An icon's main colour as a hook: `null` while it is read, then a hex colour or `'none'`. A null source answers null. */
export function useIconMainColor(src: ColorSource | null): MainColor {
  const [main, setMain] = useState<MainColor>(() => (src ? iconMainColorNow(src) : null));
  const sig = src ? `${src.color || ''}|${src.iconUrl || ''}` : '';
  useEffect(() => {
    if (!src) { setMain(null); return undefined; }
    let live = true;
    const now = iconMainColorNow(src);
    setMain(now);
    if (!now) void deriveIconMainColor(src).then((c) => { if (live) setMain(c); });
    return () => { live = false; };
  }, [sig]); // eslint-disable-line react-hooks/exhaustive-deps
  return main;
}

/** How many brand tints a card with no colour of its own picks from (app.css `--cm-tint-1` to `-5`). */
export const BAND_TINTS = 5;

/** The brand tint a community wears, 1 to BAND_TINTS: always the same one for the same slug. */
export function bandTint(slug: string): number {
  // FNV-1a, then mixed, so slugs a letter apart land apart.
  let h = 0x811c9dc5;
  for (let i = 0; i < slug.length; i += 1) h = Math.imul(h ^ slug.charCodeAt(i), 0x01000193);
  h ^= h >>> 15; h = Math.imul(h, 0x2c1b3c6d); h ^= h >>> 12;
  return ((h >>> 0) % BAND_TINTS) + 1;
}

/**
 * What a band with no picture is washed with, as the attributes and style
 * app.css reads: `--cm-wash` for an icon's own colour, `data-cm-tint` for a
 * brand tint, and `data-cm-band="wait"` (the plain ground) while an image is
 * read. `main` is `useIconMainColor`'s answer.
 */
export function bandWash(slug: string, main: MainColor): { attrs: Record<string, string>; style?: Record<string, string> } {
  if (main === null) return { attrs: { 'data-cm-band': 'wait' } };
  if (main === 'none') return { attrs: { 'data-cm-band': 'tint', 'data-cm-tint': String(bandTint(slug)) } };
  return { attrs: { 'data-cm-band': 'wash' }, style: { '--cm-wash': main } };
}
