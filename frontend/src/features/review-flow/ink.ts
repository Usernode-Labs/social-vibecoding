/**
 * A still's ink (model.ts `Ink`): its after side read once, at one sample per
 * screen point, so the sheet and the strip can end their crops on blank rows
 * instead of through a line of text. The stills are the platform's own
 * same-origin shots, so a canvas may read them. Each still is read once per
 * page load; a still that cannot be read leaves its crops as computed.
 */

import { useEffect, useState } from 'react';

import type { Ink, ReviewScreen } from './model';

const read = new Map<string, Promise<Ink | null>>();
// The inks already read, so a change drawn again (the copy Next leaves
// behind) has them on its first frame.
const done = new Map<string, Ink>();

/** A still's ink if it has been read already. */
export function inkNow(url: string): Ink | null {
  return done.get(url) || null;
}

/** How long a change waits for its inks before it lands without them. */
const PATIENCE = 700;

export function loadInk(url: string, width: number, height: number): Promise<Ink | null> {
  const known = read.get(url);
  if (known) return known;
  const p = new Promise<Ink | null>((resolve) => {
    const img = new Image();
    img.decoding = 'async';
    img.onload = () => {
      try {
        const w = Math.max(1, Math.round(width));
        const h = Math.max(1, Math.round(height));
        const canvas = document.createElement('canvas');
        canvas.width = w;
        canvas.height = h;
        const ctx = canvas.getContext('2d', { willReadFrequently: true });
        if (!ctx) { resolve(null); return; }
        ctx.drawImage(img, 0, 0, w, h);
        const px = ctx.getImageData(0, 0, w, h).data;
        const lum = new Uint8Array(w * h);
        for (let i = 0; i < lum.length; i++) lum[i] = (px[i * 4] * 54 + px[i * 4 + 1] * 183 + px[i * 4 + 2] * 19) >> 8;
        const ink = { w, h, lum };
        done.set(url, ink);
        resolve(ink);
      } catch { resolve(null); }
    };
    img.onerror = () => resolve(null);
    img.src = url;
  });
  read.set(url, p);
  return p;
}

/** Read every screen's after still ahead of time (the next change's, say). */
export function readInks(screens: ReviewScreen[]): void {
  screens.forEach((s) => { void loadInk(s.after.url, s.width, s.after.height); });
}

/**
 * The inks of `screens`, by still url, and whether the change may land:
 * once they are all read, or after a short wait without the slow ones.
 */
export function useInks(screens: ReviewScreen[]): { inks: Record<string, Ink>; settled: boolean } {
  const [inks, setInks] = useState<Record<string, Ink>>(() => {
    const now: Record<string, Ink> = {};
    screens.forEach((s) => { const ink = done.get(s.after.url); if (ink) now[s.after.url] = ink; });
    return now;
  });
  const [settled, setSettled] = useState(() => screens.every((s) => done.has(s.after.url)));
  useEffect(() => {
    if (!screens.length || screens.every((s) => done.has(s.after.url))) { setSettled(true); return undefined; }
    let live = true;
    const timer = window.setTimeout(() => { if (live) setSettled(true); }, PATIENCE);
    Promise.all(screens.map((s) => loadInk(s.after.url, s.width, s.after.height).then((ink) => {
      if (live && ink) setInks((cur) => ({ ...cur, [s.after.url]: ink }));
    }))).then(() => { if (live) setSettled(true); });
    return () => { live = false; clearTimeout(timer); };
  }, [screens]);
  return { inks, settled };
}
