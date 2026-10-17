/**
 * Closing an app shrinks it into its Resume button; pressing Resume grows it
 * back out of the same control.
 *
 * ── The control ──────────────────────────────────────────────────────
 *
 * A running app you are not in has a filled Resume pill on its Active row in
 * the desktop rail (./recents-list.tsx), and the phone's strip is one whole
 * Resume target (./parked-strip.tsx). Those are the two places the router can
 * land a collapse, so `resumeHandleFor` looks for them in that order: the
 * pill, then the row it sits in, then the phone strip. The row is a fallback
 * because the pill is a label INSIDE the row's single link — the row is the
 * real target, and a row whose pill has been filtered away is still a way
 * back to the app.
 *
 * ── The pressed control, for the way back ────────────────────────────
 *
 * `navigateToApp` resolves its zoom source before the app view is revealed,
 * which is after React has already re-rendered the rail for the screen
 * change. The pill that was pressed may have become the lit row (or gone)
 * by then, so both callers note the element they were pressed on with
 * `noteResumeOrigin`, and `takeResumeOrigin` hands it back once, for the same
 * slug, while it is fresh and still on screen. A stale origin is not an
 * origin: it falls through to whatever the rail says now.
 *
 * ── The stand-in, when the app view is already gone ──────────────────
 *
 * A close to Home is the kit's own zoom-out: #app-view is still on screen
 * while the kit animates it into the control, and `collapseIntoResume`
 * deliberately does nothing (the app view is visible). A close to any other
 * screen has already hidden #app-view by the time the router parks the app,
 * so the router passes the rect it measured a moment earlier and this draws
 * one decorative card in its place, shrinking it into the control. That is
 * the same 250ms as a Resume press, so the two directions read as one
 * gesture.
 *
 * Nothing here is a control: the stand-in is aria-hidden, never focusable
 * and takes no pointer events, and the Resume pill itself is aria-hidden
 * inside the row's one link. Reduced motion, a View Transition drawing
 * snapshots, a missing control or no measurable rect all mean no motion —
 * the close is the plain cut it was before.
 */

/** The collapse/expand motion, shared by the kit and the stand-in. */
export const RESUME_MOTION_MS = 250;

/** How long a pressed control stays usable as a zoom origin. */
export const RESUME_ORIGIN_MS = 1500;

/** The stand-in's own fade at the landing end of the motion. */
const RESUME_FADE_MS = 90;

/** Slack after the motion, for when `transitionend` never comes. */
const RESUME_SLACK_MS = 150;

/** A rect as the router measures it, or a DOMRect. */
export interface RectLike {
  top: number;
  left: number;
  width: number;
  height: number;
  bottom?: number;
  right?: number;
}

/** The transform that maps `from` onto `to`, with origin 0 0. */
export interface Pose {
  tx: number;
  ty: number;
  sx: number;
  sy: number;
}

let origin: { slug: string; el: Element; at: number } | null = null;
let activeGhost: { el: HTMLElement; finish: () => void } | null = null;

/** Whether a rect can seed the motion: real size and at least partly on screen. */
export function rectUsable(rect: RectLike | null | undefined): boolean {
  if (!rect) return false;
  if (!(rect.width > 0) || !(rect.height > 0)) return false;
  const bottom = rect.bottom != null ? rect.bottom : rect.top + rect.height;
  if (bottom < 0) return false;
  if (typeof window !== 'undefined' && rect.top > window.innerHeight) return false;
  return true;
}

/** The pose that shrinks `from` onto `to`. Null on degenerate input. */
export function poseBetween(from: RectLike, to: RectLike): Pose | null {
  if (!rectUsable(from) || !rectUsable(to)) return null;
  return {
    tx: to.left - from.left,
    ty: to.top - from.top,
    sx: to.width / from.width,
    sy: to.height / from.height,
  };
}

function reducedMotion(): boolean {
  try {
    return typeof window !== 'undefined' && !!window.matchMedia
      && window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  } catch {
    return false;
  }
}

function slugHref(slug: string): string {
  return `/app/${encodeURIComponent(slug)}`;
}

/** The Active row for `slug`, or null. */
function activeRowFor(slug: string): HTMLElement | null {
  if (typeof document === 'undefined') return null;
  const list = document.getElementById('platform-recents');
  if (!list) return null;
  const key = `app:${slug}`;
  const rows = list.querySelectorAll<HTMLElement>('.platform-active > a[data-recent-key]');
  for (const row of Array.from(rows)) {
    if (row.dataset?.recentKey === key) return row;
  }
  return null;
}

/** The phone strip's Resume target, when it is up and showing `slug`. */
function parkedTargetFor(slug: string): HTMLElement | null {
  if (typeof document === 'undefined') return null;
  const strip = document.getElementById('platform-parked');
  const open = document.getElementById('platform-parked-resume');
  if (!strip || !open) return null;
  if (strip.classList.contains('hidden')) return null;
  if (strip.hasAttribute('inert') || strip.getAttribute('aria-hidden') === 'true') return null;
  if (open.getAttribute('href') !== slugHref(slug)) return null;
  return open;
}

/**
 * The on-screen Resume control for `slug`: the Active row's pill, then the
 * row, then the phone strip. Null when none is drawn or all are off screen.
 */
export function resumeHandleFor(slug: string): HTMLElement | null {
  if (!slug || typeof document === 'undefined') return null;
  const row = activeRowFor(slug);
  if (row) {
    const pill = row.querySelector<HTMLElement>(':scope > .platform-recent-resume');
    if (pill && rectUsable(pill.getBoundingClientRect())) return pill;
    if (rectUsable(row.getBoundingClientRect())) return row;
  }
  const parked = parkedTargetFor(slug);
  if (parked && rectUsable(parked.getBoundingClientRect())) return parked;
  return null;
}

/** Remember the control a Resume press came from, for the zoom back in. */
export function noteResumeOrigin(slug: string, el: Element | null): void {
  if (!slug || !el) return;
  origin = { slug, el, at: Date.now() };
}

/**
 * The pressed control, once: only for the same slug, only while fresh and
 * still on screen. Anything else falls through to the rail's current state.
 */
export function takeResumeOrigin(slug: string): Element | null {
  const held = origin;
  if (!held || held.slug !== slug) return null;
  origin = null;
  if (Date.now() - held.at > RESUME_ORIGIN_MS) return null;
  if (!held.el.isConnected) return null;
  if (!rectUsable(held.el.getBoundingClientRect())) return null;
  return held.el;
}

/** The app's icon tile, for the stand-in's face, from wherever it is drawn. */
function appTileFor(slug: string): HTMLElement | null {
  const row = activeRowFor(slug);
  const fromRow = row?.querySelector<HTMLElement>('.platform-recent-tile');
  if (fromRow) return fromRow;
  const parked = parkedTargetFor(slug);
  return parked?.querySelector<HTMLElement>('.platform-parked-tile') || null;
}

function cancelGhost(): void {
  const ghost = activeGhost;
  if (!ghost) return;
  activeGhost = null;
  ghost.finish();
}

/**
 * Draw a decorative copy of the app where it was and shrink it into its
 * Resume control. Returns false — and draws nothing — when the app view is
 * still on screen (the kit is animating it), under reduced motion, during a
 * View Transition, when no control is on screen, or for an unusable rect.
 */
export function collapseIntoResume(slug: string, from: RectLike | null | undefined): boolean {
  if (typeof document === 'undefined' || !slug || !from) return false;
  if (!rectUsable(from)) return false;
  if (reducedMotion()) return false;
  if (document.documentElement?.hasAttribute?.('data-un-vt')) return false;
  // The kit's zoom-out owns this motion while #app-view is still painted.
  const appView = document.getElementById('app-view');
  if (appView && !appView.classList.contains('hidden')) return false;
  const handle = resumeHandleFor(slug);
  if (!handle) return false;
  const pose = poseBetween(from, handle.getBoundingClientRect());
  if (!pose) return false;

  cancelGhost();
  const ghost = document.createElement('div');
  ghost.className = 'resume-ghost';
  ghost.setAttribute('aria-hidden', 'true');
  ghost.style.top = `${from.top}px`;
  ghost.style.left = `${from.left}px`;
  ghost.style.width = `${from.width}px`;
  ghost.style.height = `${from.height}px`;
  const tile = appTileFor(slug);
  if (tile) {
    const face = tile.cloneNode(true) as HTMLElement;
    face.className = 'app-icon-tile resume-ghost-tile';
    ghost.appendChild(face);
  }
  document.body.appendChild(ghost);

  let done = false;
  let timer = 0;
  const finish = () => {
    if (done) return;
    done = true;
    if (timer) window.clearTimeout(timer);
    ghost.removeEventListener('transitionend', onEnd);
    ghost.remove();
    if (activeGhost?.el === ghost) activeGhost = null;
  };
  const onEnd = (event: Event) => {
    const end = event as TransitionEvent;
    if (end.target === ghost && end.propertyName === 'transform') finish();
  };
  ghost.addEventListener('transitionend', onEnd);

  // Force the start pose before enabling the transition, then land it on
  // the control with a short fade at the end so the pill is not covered.
  void ghost.offsetWidth;
  ghost.style.transition = `transform ${RESUME_MOTION_MS}ms ease-out, `
    + `opacity ${RESUME_FADE_MS}ms ease-in ${RESUME_MOTION_MS - RESUME_FADE_MS}ms`;
  ghost.style.transform = `translate(${pose.tx}px, ${pose.ty}px) scale(${pose.sx}, ${pose.sy})`;
  ghost.style.opacity = '0';

  timer = window.setTimeout(finish, RESUME_MOTION_MS + RESUME_SLACK_MS);
  activeGhost = { el: ghost, finish };
  return true;
}
