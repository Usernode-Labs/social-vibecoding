/**
 * Closing an app into its Resume control, and growing it back out.
 *
 * The visible change is small: a closed app shrinks into the Resume button
 * that offers it again. `App.navigateHome` grows the LIVE app view out of
 * that control with the kit's own 'zoom-out'; every other way out has already
 * hidden `#app-view` by the time the router parks the app, so there is
 * nothing left to shrink. This module draws a short stand-in for that case:
 * a `.resume-ghost` card carrying the app's page colour and icon, animated
 * into the control the router found.
 *
 * ── The control is the target ────────────────────────────────────────
 *
 * On the desktop rail it is the Active row's `.platform-recent-resume` pill,
 * or the row itself when the pill is not drawn (the app on screen keeps no
 * pill). On the phone it is `#platform-parked`, whose whole strip is one
 * target. A hidden control, one with no area, or one fully off screen is no
 * target: closing is then the instant switch it has always been.
 *
 * ── The other direction is one recorded element ─────────────────────
 *
 * Pressing Resume records the element pressed as the origin for a later open
 * (noteResumeOrigin). `App.navigateToApp` takes it once, within
 * RESUME_ORIGIN_TTL_MS, and hands it to the kit as `fromEl`; the Home tile is
 * used only when no fresh origin exists. It is taken (not read), so a later
 * open of the same app grows out of its own place rather than out of a button
 * pressed earlier.
 *
 * Everything here is DOM-only and defensive: a shell without Web Animations,
 * a reduced-motion viewer, or a page transition already running draws
 * nothing, and the router's switch is exactly what it was.
 */

import { appFrameStore } from '../app-frame/app-frame-store.js';

/** The shrink and the grow. Short: this is a dismissal, not a scene. */
export const RESUME_MOTION_MS = 250;
/** The platform's arrive/leave easing (app.css's parked keyframes). */
export const RESUME_EASE = 'cubic-bezier(0.2, 0.8, 0.2, 1)';
/** The last stretch is a fade, so the card is gone as it lands. */
export const RESUME_FADE_MS = 90;
/** How long a press on Resume stays the next open's origin. */
export const RESUME_ORIGIN_TTL_MS = 1500;
/** Slack after the motion for a browser that never fires `finish`. */
const REMOVE_SLACK_MS = 120;

/** One press's origin, by app slug, until App.navigateToApp takes it. */
const origins = new Map<string, { el: Element; at: number }>();

/** Whether a rect can be drawn from: it has area and is not fully off screen. */
export function rectUsable(
  rect: DOMRect | { left: number; top: number; width: number; height: number; right?: number; bottom?: number } | null | undefined,
  viewportHeight?: number,
  viewportWidth?: number,
): boolean {
  if (!rect) return false;
  if (!(rect.width > 0) || !(rect.height > 0)) return false;
  const bottom = rect.bottom != null ? rect.bottom : rect.top + rect.height;
  const right = rect.right != null ? rect.right : rect.left + rect.width;
  if (bottom < 0) return false;
  if (viewportHeight != null && rect.top > viewportHeight) return false;
  if (right < 0) return false;
  if (viewportWidth != null && rect.left > viewportWidth) return false;
  return true;
}

/** The transform pose that maps `target` onto `from` (transform-origin 0 0). */
export function poseBetween(
  from: { left: number; top: number; width: number; height: number },
  target: { left: number; top: number; width: number; height: number },
): { tx: number; ty: number; sx: number; sy: number } | null {
  if (!from || !target) return null;
  if (!(from.width > 0) || !(from.height > 0)) return null;
  if (!(target.width > 0) || !(target.height > 0)) return null;
  return {
    tx: target.left - from.left,
    ty: target.top - from.top,
    sx: target.width / from.width,
    sy: target.height / from.height,
  };
}

function reducedMotion(): boolean {
  try {
    return !!(window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches);
  } catch (_) {
    return false;
  }
}

/** A View Transition (or another kit transition) is already moving the page. */
function pageTransitionRunning(): boolean {
  try {
    return !!document.documentElement?.hasAttribute?.('data-un-vt');
  } catch (_) {
    return false;
  }
}

function viewportHeight(): number {
  try { return Number(window.innerHeight) || 0; } catch (_) { return 0; }
}

function viewportWidth(): number {
  try { return Number(window.innerWidth) || 0; } catch (_) { return 0; }
}

function rectOf(el: Element | null | undefined): DOMRect | null {
  try {
    return el && typeof (el as Element).getBoundingClientRect === 'function'
      ? (el as Element).getBoundingClientRect()
      : null;
  } catch (_) {
    return null;
  }
}

function visible(el: Element | null | undefined): boolean {
  if (!el) return false;
  try {
    if (el.classList?.contains?.('hidden')) return false;
  } catch (_) { /* no classList to ask */ }
  return rectUsable(rectOf(el), viewportHeight(), viewportWidth());
}

/** The Active row for `slug`, or null while it is not drawn. */
function activeRow(slug: string): Element | null {
  try {
    const selector = `.platform-active .platform-recent[data-recent-key="app:${slug.replace(/"/g, '\\"')}"]`;
    return document.querySelector?.(selector) || null;
  } catch (_) {
    return null;
  }
}

/**
 * The control a closed app lands in, in the order the screen offers it:
 * the desktop Active row's Resume pill, the row when no pill is drawn, then
 * the phone's parked strip. Null when none is visible.
 */
export function resumeHandleFor(slug?: string | null): Element | null {
  if (typeof document === 'undefined') return null;
  if (slug) {
    const row = activeRow(slug);
    if (row) {
      let pill: Element | null = null;
      try { pill = row.querySelector?.('.platform-recent-resume') || null; } catch (_) { /* none */ }
      const target = pill || row;
      if (visible(target)) return target;
    }
  }
  let strip: Element | null = null;
  try { strip = document.getElementById?.('platform-parked') || null; } catch (_) { /* none */ }
  return visible(strip) ? strip : null;
}

/**
 * Remember the Resume control just pressed as where the app should grow from
 * when it opens. One press, one recorded element, for RESUME_ORIGIN_TTL_MS.
 */
export function noteResumeOrigin(slug: string, el: Element | null | undefined): void {
  if (!slug || !el) return;
  origins.set(slug, { el, at: Date.now() });
}

/**
 * The recorded origin for `slug`, if it is still fresh AND still on screen.
 * Taken: the next call for the same app answers null, so the app grows out of
 * its own place rather than out of a button pressed earlier.
 */
export function takeResumeOrigin(slug: string): Element | null {
  const found = origins.get(slug);
  origins.delete(slug);
  if (!found) return null;
  if (Date.now() - found.at > RESUME_ORIGIN_TTL_MS) return null;
  return visible(found.el) ? found.el : null;
}

/** The whole viewport, as the stand-in's source when there is no app rect. */
function viewportRect(): { left: number; top: number; width: number; height: number; right: number; bottom: number } | null {
  const width = viewportWidth();
  const height = viewportHeight();
  if (!(width > 0) || !(height > 0)) return null;
  return { left: 0, top: 0, width, height, right: width, bottom: height };
}

function iconKind(app: { iconUrl?: string | null; iconEmoji?: string | null }): string {
  if (app.iconUrl) return 'image';
  if (app.iconEmoji) return 'emoji';
  return 'letter';
}

function buildIcon(app: {
  name?: string | null; slug: string; iconUrl?: string | null; iconEmoji?: string | null;
}): HTMLElement {
  const tile = document.createElement('span');
  tile.className = 'app-icon-tile resume-ghost-tile';
  tile.setAttribute('data-icon', iconKind(app));
  if (app.iconUrl) {
    const img = document.createElement('img');
    img.src = app.iconUrl;
    img.alt = '';
    img.draggable = false;
    tile.appendChild(img);
  } else if (app.iconEmoji) {
    const emoji = document.createElement('span');
    emoji.textContent = app.iconEmoji;
    tile.appendChild(emoji);
  } else {
    const name = (app.name || app.slug || '?').trim();
    tile.textContent = name.charAt(0).toUpperCase();
  }
  return tile;
}

/**
 * Shrink a stand-in for `app` into its Resume control, from `from` (the rect
 * `#app-view` occupied before it was hidden).
 *
 * Returns false — and draws nothing — for reduced motion, a page transition
 * already running, no visible control, no usable source or target rect, or a
 * browser without Web Animations. The card removes itself on finish, on
 * cancel, and on a timer, so no path can leave it behind.
 */
export function collapseIntoResume(
  app: { slug: string; name?: string | null; iconUrl?: string | null; iconEmoji?: string | null } | null | undefined,
  from?: { left: number; top: number; width: number; height: number; right?: number; bottom?: number } | null,
): boolean {
  if (typeof document === 'undefined' || typeof window === 'undefined') return false;
  if (!app || !app.slug) return false;
  if (reducedMotion() || pageTransitionRunning()) return false;
  const handle = resumeHandleFor(app.slug);
  if (!handle) return false;
  const to = rectOf(handle);
  if (!rectUsable(to, viewportHeight(), viewportWidth())) return false;
  const start = rectUsable(from, viewportHeight(), viewportWidth())
    ? from!
    : viewportRect();
  if (!start) return false;

  const ghost = document.createElement('div');
  // A browser without Web Animations draws nothing; the switch is instant.
  if (!ghost || typeof ghost.animate !== 'function') return false;

  let background = '';
  try {
    const state = appFrameStore.get();
    if (state && state.slug === app.slug && state.background) background = state.background;
  } catch (_) { /* no frame store: the page ground */ }

  ghost.className = 'resume-ghost';
  ghost.setAttribute('aria-hidden', 'true');
  ghost.style.left = `${start.left}px`;
  ghost.style.top = `${start.top}px`;
  ghost.style.width = `${start.width}px`;
  ghost.style.height = `${start.height}px`;
  // The app's own page colour when its bridge reported one; the page ground
  // otherwise, so the card is visible over anything.
  ghost.style.background = background || 'var(--bg-primary)';
  ghost.appendChild(buildIcon(app));

  const pose = poseBetween(start, to!);
  if (!pose) return false;

  try {
    document.body.appendChild(ghost);
  } catch (_) {
    return false;
  }

  let removed = false;
  let timer: ReturnType<typeof setTimeout> | null = null;
  const cleanup = () => {
    if (removed) return;
    removed = true;
    if (timer != null) clearTimeout(timer);
    try { ghost.remove(); } catch (_) { /* already gone */ }
  };
  timer = setTimeout(cleanup, RESUME_MOTION_MS + REMOVE_SLACK_MS);

  const landed = `translate(${pose.tx}px, ${pose.ty}px) scale(${pose.sx}, ${pose.sy})`;
  const fadeAt = Math.max(0, (RESUME_MOTION_MS - RESUME_FADE_MS) / RESUME_MOTION_MS);
  let animation: Animation;
  try {
    animation = ghost.animate([
      { transform: 'none', opacity: 1, borderRadius: '18px' },
      { transform: landed, opacity: 1, borderRadius: '999px', offset: fadeAt },
      { transform: landed, opacity: 0, borderRadius: '999px' },
    ], { duration: RESUME_MOTION_MS, easing: RESUME_EASE, fill: 'both' });
  } catch (_) {
    cleanup();
    return false;
  }
  animation.onfinish = cleanup;
  animation.oncancel = cleanup;
  try { animation.finished?.then(cleanup, cleanup); } catch (_) { /* no promise */ }
  return true;
}
