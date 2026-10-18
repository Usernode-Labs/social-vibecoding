/**
 * The app card shrinking into its Resume control, and the note that says
 * which control a resumed app should grow out of (#3618).
 *
 * ── One promise, two directions ───────────────────────────────────────
 *
 * `App._syncParkedApp` parks an app as it leaves the screen; the rail's
 * Active row (./recents-list.tsx) and the phone's strip (./parked-strip.tsx)
 * are the two controls that bring it back. This module is the seam between
 * them that neither side can own alone:
 *
 * - `noteResumeOrigin` / `takeResumeOrigin` carry "the button that was
 *   pressed" across the router's transition, so the app's zoom-in starts
 *   from THAT element rather than from a Home tile that may not be on screen.
 * - `resumeHandleFor` is the same lookup the router makes when it leaves an
 *   app: the row's Resume pill first, the row itself next, and the phone's
 *   strip last.
 * - `collapseIntoResume` draws the app as a shrinking stand-in when the app
 *   view is already hidden by the time the router could animate it.
 *
 * ── Decoration, never a delay ─────────────────────────────────────────
 *
 * Every entry point answers "no" quickly for reduced motion, a hidden or
 * folded control, a browser without `Element.animate`, or a View Transition
 * that is already snapshotting the document. A "no" leaves the caller with
 * the instant cut it had before, which is the whole of the fallback.
 *
 * ── The origin is module state with a short life ──────────────────────
 *
 * A note lives for 1500ms and is consumed exactly once, by the app whose
 * slug it names. Nothing is stored and nothing is persisted: a stale note
 * (another app, another route, a removed row) simply misses, and the caller
 * falls back to the Home tile as it always did.
 */

import { appFrameStore } from '../app-frame/app-frame-store.js';

/** The close and the grow both take this long. */
export const RESUME_MOTION_MS = 250;
export const RESUME_EASE = 'cubic-bezier(0.2, 0.8, 0.2, 1)';
export const RESUME_FADE_MS = 90;
/** How long a pressed Resume control can claim the grow-out. */
export const RESUME_ORIGIN_TTL_MS = 1500;

export interface ResumeApp {
  slug?: string | null;
  name?: string | null;
  iconUrl?: string | null;
  iconEmoji?: string | null;
}

export interface ResumeOrigin {
  slug: string;
  el: Element;
  at: number;
}

let origin: ResumeOrigin | null = null;
let standIn: HTMLElement | null = null;
let standInTimer: ReturnType<typeof setTimeout> | null = null;

/**
 * A rect we can animate from or to. Zero sized is a hidden element; a
 * rect entirely above the viewport is one scrolled away. `viewportHeight`
 * is optional because `poseBetween` does not need it.
 */
export function rectUsable(
  rect: { width: number; height: number; top: number; bottom: number } | null | undefined,
  viewportHeight = 0,
): boolean {
  if (!rect) return false;
  if (!(rect.width > 0) || !(rect.height > 0)) return false;
  if (rect.bottom <= 0) return false;
  if (viewportHeight > 0 && rect.top >= viewportHeight) return false;
  return true;
}

/**
 * The transform that takes a box at `from` to a box at `to`, with
 * `transform-origin: 0 0`. Null when either box has no size.
 */
export function poseBetween(
  from: { left: number; top: number; width: number; height: number } | null | undefined,
  to: { left: number; top: number; width: number; height: number } | null | undefined,
): string | null {
  if (!from || !to) return null;
  if (!(from.width > 0) || !(from.height > 0)) return null;
  if (!(to.width > 0) || !(to.height > 0)) return null;
  const tx = to.left - from.left;
  const ty = to.top - from.top;
  const sx = to.width / from.width;
  const sy = to.height / from.height;
  return `translate(${tx}px, ${ty}px) scale(${sx}, ${sy})`;
}

function viewportHeight(doc: Document): number {
  const height = Number(doc.defaultView?.innerHeight);
  return Number.isFinite(height) && height > 0 ? height : 0;
}

function isUsable(el: Element | null, doc: Document): el is Element {
  if (!el || !el.isConnected) return false;
  return rectUsable(el.getBoundingClientRect(), viewportHeight(doc));
}

/**
 * The control Resume was pressed on for `slug`, or null. The rail's Active
 * row first — its pill when it has one, otherwise the row — then the phone's
 * strip, which is only offered while it is actually drawn.
 */
export function resumeHandleFor(slug: string, doc: Document | null): Element | null {
  if (!slug || !doc) return null;
  const rows = doc.querySelectorAll('#platform-recents .platform-active a[data-recent-key]');
  for (let i = 0; i < rows.length; i += 1) {
    const row = rows[i];
    if (row.getAttribute('data-recent-key') !== `app:${slug}`) continue;
    const pill = row.querySelector(':scope > .platform-recent-resume');
    if (pill && isUsable(pill, doc)) return pill;
    if (isUsable(row, doc)) return row;
  }
  const strip = doc.getElementById?.('platform-parked');
  const resume = doc.getElementById?.('platform-parked-resume');
  if (strip && resume && !strip.classList.contains('hidden')) {
    const href = resume.getAttribute('href');
    if (href === `/app/${encodeURIComponent(slug)}` && isUsable(strip, doc)) return strip;
  }
  return null;
}

/** Remember which control was pressed, for `takeResumeOrigin`. */
export function noteResumeOrigin(slug: string, el: Element | null | undefined): void {
  if (!slug || !el) return;
  origin = { slug, el, at: Date.now() };
}

/**
 * The control noted for `slug`, if it is still fresh and still on screen.
 * Clears the note on every call, so one press is one grow-out.
 */
export function takeResumeOrigin(slug: string, doc: Document | null): Element | null {
  const noted = origin;
  origin = null;
  if (!noted || !slug || noted.slug !== slug) return null;
  if (Date.now() - noted.at >= RESUME_ORIGIN_TTL_MS) return null;
  if (!doc || !isUsable(noted.el, doc)) return null;
  return noted.el;
}

function prefersReducedMotion(doc: Document): boolean {
  return !!doc.defaultView?.matchMedia?.('(prefers-reduced-motion: reduce)').matches;
}

/** The app's last reported page colour, else the shell's page ground. */
function pageColour(slug: string, doc: Document): string {
  const state = appFrameStore.get();
  if (state.slug === slug && state.background) return state.background;
  const kept = (state.kept || []).find((entry) => entry.slug === slug);
  if (kept && kept.background) return kept.background;
  const css = doc.defaultView?.getComputedStyle?.(doc.documentElement);
  return css?.getPropertyValue?.('--bg-primary')?.trim() || '#ffffff';
}

/** The whole area under the header, edge to edge, when the caller measured nothing. */
function fallbackRect(doc: Document): { left: number; top: number; width: number; height: number } {
  const header = doc.getElementById?.('platform-header');
  const top = header ? header.getBoundingClientRect().bottom : 0;
  return {
    left: 0,
    top,
    width: Number(doc.defaultView?.innerWidth) || 0,
    height: Math.max(0, viewportHeight(doc) - top),
  };
}

function iconTile(app: ResumeApp, doc: Document): HTMLElement {
  const tile = doc.createElement('span');
  tile.className = 'app-icon-tile resume-ghost-tile';
  if (app.iconUrl) {
    const img = doc.createElement('img');
    img.src = app.iconUrl;
    img.alt = '';
    tile.appendChild(img);
  } else if (app.iconEmoji) {
    const face = doc.createElement('span');
    face.textContent = app.iconEmoji;
    tile.appendChild(face);
  } else {
    tile.textContent = (app.name || app.slug || '?').trim().charAt(0).toUpperCase() || '?';
  }
  return tile;
}

function finishStandIn(): void {
  if (standInTimer) {
    clearTimeout(standInTimer);
    standInTimer = null;
  }
  if (standIn) {
    standIn.remove();
    standIn = null;
  }
}

/**
 * Draw the app as a card shrinking into its Resume control, or answer false
 * and leave the caller's instant cut alone.
 *
 * `from` is the app view's rect, measured BEFORE the router hid it. A null
 * measurement (the app was never painted, or the view was already gone) uses
 * the area under the header instead.
 */
export function collapseIntoResume(
  app: ResumeApp | null | undefined,
  from: { left: number; top: number; width: number; height: number } | null | undefined,
  doc: Document | null,
): boolean {
  if (!app || !app.slug || !doc) return false;
  const slug = app.slug;
  if (!doc.body || !doc.documentElement) return false;
  if (prefersReducedMotion(doc)) return false;
  if (doc.documentElement.hasAttribute('data-un-vt')) return false;
  const handle = resumeHandleFor(slug, doc);
  if (!handle) return false;
  const start = from && rectUsable(
    { width: from.width, height: from.height, top: from.top, bottom: from.top + from.height },
    viewportHeight(doc),
  ) ? from : fallbackRect(doc);
  if (!start || !(start.width > 0) || !(start.height > 0)) return false;
  const pose = poseBetween(start, handle.getBoundingClientRect());
  if (!pose) return false;
  if (typeof Element === 'undefined' || typeof Element.prototype.animate !== 'function') return false;
  if (typeof doc.createElement !== 'function') return false;

  finishStandIn();

  const ghost = doc.createElement('div');
  ghost.className = 'resume-ghost';
  ghost.setAttribute('aria-hidden', 'true');
  ghost.style.position = 'fixed';
  ghost.style.left = `${start.left}px`;
  ghost.style.top = `${start.top}px`;
  ghost.style.width = `${start.width}px`;
  ghost.style.height = `${start.height}px`;
  ghost.style.pointerEvents = 'none';
  ghost.style.transformOrigin = '0 0';
  ghost.style.overflow = 'hidden';
  ghost.style.background = pageColour(slug, doc);
  ghost.appendChild(iconTile(app, doc));
  doc.body.appendChild(ghost);
  if (typeof ghost.animate !== 'function') {
    ghost.remove();
    return false;
  }

  const css = doc.defaultView?.getComputedStyle?.(handle);
  const endRadius = css?.borderRadius || '12px';
  const move = ghost.animate(
    [
      { transform: 'none', borderRadius: '0px' },
      { transform: pose, borderRadius: endRadius },
    ],
    { duration: RESUME_MOTION_MS, easing: RESUME_EASE, fill: 'forwards' },
  );
  ghost.animate(
    [{ opacity: 1 }, { opacity: 0 }],
    {
      duration: RESUME_FADE_MS,
      delay: RESUME_MOTION_MS - RESUME_FADE_MS,
      easing: 'linear',
      fill: 'forwards',
    },
  );

  standIn = ghost;
  const done = () => {
    if (standIn === ghost) {
      finishStandIn();
      return;
    }
    ghost.remove();
  };
  move.addEventListener?.('finish', done);
  move.addEventListener?.('cancel', done);
  move.finished?.then?.(done, done);
  standInTimer = setTimeout(done, RESUME_MOTION_MS + 150);
  return true;
}
