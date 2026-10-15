/**
 * The first look's DRAWN screen, shown until its picture is saved (15 Oct
 * 2026).
 *
 * Newcomer run nine: the early first look's screen (services/first-version-
 * early-look.js) was drawn well inside 20 seconds of Make it, but the worker
 * its picture is drawn in took 30 seconds longer than usual to start, so the
 * picture came 48 seconds in and the made screen showed an empty phone for
 * 11 seconds after Submit. The picture is 20 seconds at best. So while there
 * is only the drawn screen (GET /api/apps/:slug `first_version.screens.drawn`)
 * every place the first look shows draws that screen itself, and the picture
 * takes its place, at the same size, once it is in:
 *
 *   the made screen's first look card   ./made.tsx FirstLookPhone
 *   the hub's first look card           ../dev-board/workshop/hub-cards.tsx
 *   the App tab's band and Live         ../app-frame/first-version-screens.tsx,
 *                                       ../app-frame/live-band.tsx
 *
 * The screen is model-written HTML, so it is shown the way the spec's
 * screens are (../../lib/spec-html.ts): in a frame with `sandbox=""` (no
 * scripts, no forms, no navigation, an origin of its own), drawn at the
 * phone's size, 390 × 844, and scaled to its box, which crops it to the
 * top 844 pixels as the picture is. Its document comes from the server
 * (routes/apps.js GET /api/apps/:slug/first-version/first-look/drawn) under a
 * CSP that sandboxes it and lets nothing load but its inline styles and data:
 * images and fonts. Nothing in it can be tapped or focused: the box takes
 * no pointer, and the frame is out of the tab order and named by its box.
 */

import { useEffect, useRef, useState, type ReactNode } from 'react';

/** The phone the screen is drawn at: the picture's own size (services/first-version-screens.js PHONE). */
export const DRAWN_LOOK_WIDTH = 390;
export const DRAWN_LOOK_HEIGHT = 844;

const DRAWN_RE = /^\/api\/apps\/[^/?#]+\/first-version\/first-look\/drawn(?:\?|$)/;

/** The drawn screen's document, at its version `v` (as public/js/app-view.js _firstVersionScreens spells it). Pure. */
export function drawnLookUrl(slug: string, v: unknown): string {
  return `/api/apps/${encodeURIComponent(slug)}/first-version/first-look/drawn?v=${encodeURIComponent(String(v ?? '0'))}`;
}

/** Whether a first look's URL is its drawn screen's document rather than its picture. Pure. */
export function isDrawnLook(src: string | null | undefined): boolean {
  return typeof src === 'string' && DRAWN_RE.test(src);
}

/**
 * The drawn screen in a box of the phone's shape: the frame fills it,
 * scaled from 390px wide to the box's `width` (measured when it is not
 * given). `label` names it, as the picture's alt does; `hidden` when the
 * box it is in names it already. `onLoad` once its document is in.
 */
export function DrawnLook({ src, label, width, hidden = false, onLoad, className = '' }: {
  src: string;
  label: string;
  /** The box's width in pixels, when it is fixed. */
  width?: number;
  hidden?: boolean;
  onLoad?: () => void;
  className?: string;
}): ReactNode {
  const box = useRef<HTMLDivElement | null>(null);
  const [measured, setMeasured] = useState(0);
  useEffect(() => {
    const el = box.current;
    if (width || !el) return undefined;
    const fit = () => { if (el.clientWidth > 0) setMeasured(el.clientWidth); };
    fit();
    const observer = typeof ResizeObserver === 'function' ? new ResizeObserver(fit) : null;
    observer?.observe(el);
    return () => observer?.disconnect();
  }, [width]);
  const scale = (width || measured) / DRAWN_LOOK_WIDTH;
  return (
    <div
      ref={box}
      role={hidden ? undefined : 'img'}
      aria-label={hidden ? undefined : label}
      aria-hidden={hidden ? 'true' : undefined}
      data-first-look-drawn=""
      className={`pointer-events-none absolute inset-0 overflow-hidden ${className}`}
    >
      <iframe
        src={src}
        title={label}
        sandbox=""
        loading="lazy"
        referrerPolicy="no-referrer"
        scrolling="no"
        tabIndex={-1}
        aria-hidden="true"
        onLoad={onLoad}
        className={`absolute left-0 top-0 h-[844px] w-[390px] origin-top-left border-0 [color-scheme:light] ${scale > 0 ? '' : 'opacity-0'}`}
        style={scale > 0 ? { transform: `scale(${scale})` } : undefined}
      />
    </div>
  );
}

/** Whether the drawn screen shown (`shownSrc`) stays until the picture after it (`nextSrc`) is in. Pure. */
export function holdsDrawn(shownSrc: string | null, nextSrc: string | null): boolean {
  return !!nextSrc && !!shownSrc && nextSrc !== shownSrc && isDrawnLook(shownSrc) && !isDrawnLook(nextSrc);
}

/**
 * The look to draw for `next`: `next` itself, except that a picture coming
 * after a drawn screen is fetched and decoded first, and the drawn screen
 * stays until it is (or has failed to be), so the box never empties
 * between the two (holdsDrawn). `srcOf` reads a look's URL.
 */
export function useLookSwap<T>(next: T | null, srcOf: (look: T) => string | null): T | null {
  const nextSrc = next == null ? null : srcOf(next);
  const [shown, setShown] = useState<T | null>(next);
  const shownSrc = shown == null ? null : srcOf(shown);
  const waits = holdsDrawn(shownSrc, nextSrc);
  // `next` as of the last render, for the moment its picture is in.
  const latest = useRef(next);
  useEffect(() => { latest.current = next; });
  useEffect(() => {
    if (nextSrc === shownSrc) return undefined;
    let live = true;
    const done = () => { if (live) setShown(latest.current); };
    if (!waits || !nextSrc || typeof Image === 'undefined') {
      done();
      return () => { live = false; };
    }
    const img = new Image();
    img.src = nextSrc;
    const ready = typeof img.decode === 'function'
      ? img.decode()
      : new Promise<void>((resolve, reject) => { img.onload = () => resolve(); img.onerror = reject; });
    ready.then(done, done);
    return () => { live = false; };
  }, [nextSrc, shownSrc, waits]);
  return waits ? shown : next;
}

/** A look that is its own URL, for useLookSwap. */
export const ownSrc = (src: string): string => src;
