/**
 * An app you close goes INTO its Resume button, and comes back OUT of it
 * (#3618).
 *
 * ── What it is for ───────────────────────────────────────────────────
 *
 * Closing an app keeps it: its frame stays loaded (../app-frame/app-frame-store.js,
 * `kept`) and the desktop strip's recent apps show it with the "still open"
 * dot (./strip-apps.tsx, #4417; it was the rail's Active section with
 * Resume), or the strip above the tab bar offers it (#platform-parked, the
 * phone). Before
 * this, the app simply vanished when you closed it, and nothing on screen
 * said where it went. Every desktop OS answers that with motion — the window
 * shrinks into its dock or taskbar button, and grows back out of it — so the
 * eye follows the app to the one control that brings it back.
 *
 * ── Two motions, one target ──────────────────────────────────────────
 *
 * The TARGET is the same in both directions and is decided here
 * (resumeHandleFor): the app's tile on the desktop strip, or the phone's
 * whole resume strip, whichever is actually on screen. A handle
 * that is hidden (the rail folded, the keyboard up, chromeless, signed out)
 * has no rect and answers null, and then nothing moves: the close or resume
 * is the plain cut it always was. That is the whole of "robust if the button
 * is missing".
 *
 * - Leaving for HOME is the kit's own 'zoom-out' (App.navigateHome), which
 *   shrinks the LIVE app view; app.js asks this module for the handle first
 *   and falls back to the app's Home tile, as before.
 * - Leaving for ANY OTHER screen swaps the screens with no motion (the rail
 *   and the phone both cut between pages), and the app view is already hidden
 *   by the time the router parks the app — so there is nothing live left to
 *   shrink. collapseIntoResume draws a stand-in for it instead: a card in the
 *   app's own page colour with its icon, pinned where the app was, that
 *   shrinks into the handle and goes. It belongs to nobody but itself (a
 *   child of <body>, like the kit's sheets), never touches a node React or a
 *   legacy module owns, and removes itself however the animation ends.
 * - RESUMING is the kit's 'zoom-in' out of the handle that was pressed: the
 *   click notes it (noteResumeOrigin) and App.navigateToApp takes it
 *   (takeResumeOrigin) as the rect to grow out of, in place of a Home tile.
 *
 * ── Quick, and never for reduced motion ──────────────────────────────
 *
 * RESUME_MOTION_MS, ease-out. A close is something you asked for and are
 * already past; the motion only has to show where the app went. The kit
 * honours `prefers-reduced-motion` for both zooms, and the stand-in checks it
 * itself, so with it set every one of these is the instant cut.
 */

import { appFrameStore } from '../app-frame/app-frame-store.js';

/** How long either motion takes. */
export const RESUME_MOTION_MS = 250;

/** Ease-out: quick to leave, gentle as it lands on the button. */
export const RESUME_EASE = 'cubic-bezier(0.2, 0.8, 0.2, 1)';

/** The stand-in's fade, at the end of the move. */
export const RESUME_FADE_MS = 90;

/** How long a pressed Resume stays the zoom's origin before it is stale. */
export const RESUME_ORIGIN_TTL_MS = 1500;

type RectLike = { left: number; top: number; width: number; height: number };
type GhostApp = { slug: string; name?: string; iconUrl?: string | null; iconEmoji?: string | null };

/** A rect the eye can follow: non-degenerate and at least partly on screen. */
export function rectUsable(rect: RectLike | null | undefined, viewportHeight?: number): boolean {
  if (!rect) return false;
  if (!(rect.width > 0) || !(rect.height > 0)) return false;
  if (rect.top + rect.height < 0) return false;
  if (viewportHeight != null && rect.top > viewportHeight) return false;
  return true;
}

/**
 * The transform that takes `from` onto `to`, applied with transform-origin
 * 0 0: translate(tx, ty) scale(sx, sy). The kit's zoomPose, for the stand-in.
 */
export function poseBetween(from: RectLike, to: RectLike) {
  if (!rectUsable(from) || !rectUsable(to)) return null;
  return {
    tx: to.left - from.left,
    ty: to.top - from.top,
    sx: to.width / from.width,
    sy: to.height / from.height,
  };
}

function viewportHeight(doc: Document): number | undefined {
  const h = doc.defaultView?.innerHeight;
  return typeof h === 'number' && h > 0 ? h : undefined;
}

function usableElement(el: Element | null | undefined, doc: Document): HTMLElement | null {
  if (!el || !(el as HTMLElement).isConnected) return null;
  try {
    return rectUsable(el.getBoundingClientRect(), viewportHeight(doc)) ? el as HTMLElement : null;
  } catch {
    return null;
  }
}

/**
 * The Resume control for `slug` that is on screen now, or null.
 *
 * The desktop strip's tile for the app first (#4417: the strip's five recent
 * apps, ./strip-apps.tsx), then the phone's strip.
 * The strip is the target as a whole, not its pill: the whole strip resumes
 * the app (./parked-strip.tsx), and its children slide while it arrives, so
 * only the root's rect is where it will rest.
 */
export function resumeHandleFor(slug: string, doc: Document = document): HTMLElement | null {
  if (!slug || !doc) return null;
  const rows = doc.querySelectorAll('#platform-strip-apps a.platform-strip-app[data-strip-app]');
  for (const row of Array.from(rows)) {
    if (row.getAttribute('data-strip-app') !== slug) continue;
    const hit = usableElement(row.querySelector('.platform-strip-tile'), doc)
      || usableElement(row, doc);
    if (hit) return hit;
  }
  const open = doc.getElementById('platform-parked-resume');
  if (open && open.getAttribute('href') === `/app/${encodeURIComponent(slug)}`) {
    const strip = usableElement(doc.getElementById('platform-parked'), doc);
    if (strip && !strip.classList.contains('hidden')) return strip;
  }
  return null;
}

// ── Resume: the pressed control, for the zoom to grow out of ──────────

let origin: { slug: string; el: HTMLElement; at: number } | null = null;

/** Remember that `el` was pressed to resume `slug`. */
export function noteResumeOrigin(slug: string, el: Element | null | undefined): void {
  origin = slug && el ? { slug, el: el as HTMLElement, at: Date.now() } : null;
}

/**
 * The control pressed to resume `slug`, once, while it is fresh and still on
 * screen; null otherwise. Taking it clears it, so a later open of the same
 * app from anywhere else grows out of its own place.
 */
export function takeResumeOrigin(slug: string, doc: Document = document): HTMLElement | null {
  const noted = origin;
  origin = null;
  if (!noted || noted.slug !== slug) return null;
  if (Date.now() - noted.at > RESUME_ORIGIN_TTL_MS) return null;
  return usableElement(noted.el, doc);
}

// ── Close: the stand-in that shrinks into the handle ──────────────────

function reducedMotion(win: Window | null | undefined): boolean {
  try {
    return !!win?.matchMedia?.('(prefers-reduced-motion: reduce)').matches;
  } catch {
    return false;
  }
}

/** The app's own page colour, as its frame last reported it, or ''. */
function appBackground(slug: string): string {
  const state = appFrameStore.get() as {
    slug: string; background: string; kept: Array<{ slug: string; background?: string }>;
  };
  if (state.slug === slug) return state.background || '';
  return state.kept.find((k) => k.slug === slug)?.background || '';
}

/**
 * Where the app was drawn when the caller could not measure it: everything
 * under the header, edge to edge. That is the running app's box on both the
 * phone and the desktop (the rail and the tab bar are down inside an app).
 */
function fallbackRect(doc: Document): RectLike | null {
  const win = doc.defaultView;
  if (!win) return null;
  let top = 0;
  try {
    const header = doc.getElementById('platform-header');
    if (header && !header.classList.contains('hidden')) top = Math.max(0, header.getBoundingClientRect().bottom);
  } catch { /* the whole window, then */ }
  const rect = { left: 0, top, width: win.innerWidth, height: win.innerHeight - top };
  return rectUsable(rect) ? rect : null;
}

let active: { finish: () => void } | null = null;

/**
 * Shrink a stand-in for `app` from `from` (where the app was) into its
 * Resume control. Returns whether anything moved: false for reduced motion,
 * no handle on screen, a page transition already animating the document, or
 * no browser support — each of which is the plain cut.
 */
export function collapseIntoResume(
  app: GhostApp | null | undefined,
  from?: RectLike | null,
  doc: Document = document,
): boolean {
  if (!app || !app.slug || !doc || !doc.body) return false;
  const win = doc.defaultView;
  if (reducedMotion(win)) return false;
  // A View Transition is drawing the document as snapshots; anything added
  // now would be frozen into the incoming one.
  if (doc.documentElement.hasAttribute('data-un-vt')) return false;
  const handle = resumeHandleFor(app.slug, doc);
  if (!handle) return false;
  const start = rectUsable(from) ? from as RectLike : fallbackRect(doc);
  if (!start) return false;
  const end = handle.getBoundingClientRect();
  const pose = poseBetween(start, end);
  if (!pose) return false;

  const ghost = doc.createElement('div');
  if (typeof ghost.animate !== 'function') return false;
  if (active) active.finish();
  ghost.className = 'resume-ghost';
  ghost.setAttribute('aria-hidden', 'true');
  ghost.style.left = `${start.left}px`;
  ghost.style.top = `${start.top}px`;
  ghost.style.width = `${start.width}px`;
  ghost.style.height = `${start.height}px`;
  const ground = appBackground(app.slug);
  if (ground) ghost.style.background = ground;
  // The app's face, as its launch cover draws it: the image, the emoji, or
  // its initial. Text through textContent and the image through `src`, so
  // nothing here is parsed as markup.
  const tile = doc.createElement('span');
  tile.className = 'app-icon-tile resume-ghost-tile';
  if (app.iconUrl) {
    tile.setAttribute('data-icon', 'image');
    const img = doc.createElement('img');
    img.alt = '';
    img.src = app.iconUrl;
    tile.appendChild(img);
  } else {
    tile.setAttribute('data-icon', app.iconEmoji ? 'emoji' : 'letter');
    tile.textContent = app.iconEmoji || (app.name || app.slug).trim().charAt(0).toUpperCase();
  }
  ghost.appendChild(tile);
  doc.body.appendChild(ghost);

  const to = `translate(${pose.tx}px, ${pose.ty}px) scale(${pose.sx}, ${pose.sy})`;
  let done = false;
  let timer = 0;
  const finish = () => {
    if (done) return;
    done = true;
    if (active && active.finish === finish) active = null;
    if (timer) win?.clearTimeout(timer);
    ghost.remove();
  };
  active = { finish };
  // The corner it lands with is the handle's own (a pill, or the strip's
  // square edge), drawn before the scale, so each axis is divided by its own.
  const corner = Math.min(end.height / 2, 16);
  const radius = `${corner / pose.sx}px / ${corner / pose.sy}px`;
  try {
    // The shape moves for the whole length, eased out; it fades only over
    // the last stretch IN TIME, as it lands, so the button is what is left.
    // Two animations, because one effect's easing would put the fade's start
    // on the eased clock — a third of the way in — and the card would be
    // gone before it had gone anywhere.
    const anim = ghost.animate([
      { transform: 'none', borderRadius: '0px' },
      { transform: to, borderRadius: radius },
    ], { duration: RESUME_MOTION_MS, easing: RESUME_EASE, fill: 'forwards' });
    ghost.animate([{ opacity: 1 }, { opacity: 0 }], {
      duration: RESUME_FADE_MS,
      delay: RESUME_MOTION_MS - RESUME_FADE_MS,
      easing: 'linear',
      fill: 'forwards',
    });
    anim.onfinish = finish;
    anim.oncancel = finish;
  } catch {
    finish();
    return false;
  }
  // However the animation ends — or fails to — the stand-in goes.
  timer = win ? win.setTimeout(finish, RESUME_MOTION_MS + 150) : 0;
  return true;
}
