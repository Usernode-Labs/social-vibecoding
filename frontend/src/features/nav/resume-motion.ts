/**
 * Closing an app collapses it into its Resume control, and pressing Resume
 * grows it back out of the same place.
 *
 * ── One control, two directions ──────────────────────────────────────
 *
 * The desktop rail's Active rows and the phone's Resume strip are the same
 * offer (#3074, #2762): an app whose page is still loaded, and one press to
 * go back into it. The spec that added the desktop button (#3618) makes the
 * offer VISIBLE as a movement: the app's own card shrinks into the button
 * that brings it back, and the app grows out of that button when it is
 * pressed.
 *
 * State lives here, in memory, because it is a gesture and not a setting:
 *
 * - `noteResumeOrigin(slug, element)` is called by the press handler BEFORE
 *   `App.openAppTab`, so the router can ask for it a tick later, once it is
 *   about to animate. It is per-slug, on-screen only, and ignored after
 *   RESUME_ORIGIN_TTL_MS, because a stale rectangle is worse than none.
 * - `takeResumeOrigin(slug)` answers once. A press that turns into a
 *   navigation the viewer abandoned must not animate the next one.
 * - `collapseIntoResume(slug, rect)` draws the one stand-in the close uses.
 *   Closing to Home needs none: the live app view itself is the shrinking
 *   card (App.navigateHome's zoom-out), so only a close to another screen,
 *   where the app view is already hidden, draws a stand-in.
 *
 * ── It never writes into React- or legacy-owned DOM ──────────────────
 *
 * The stand-in is appended to <body> and removed on finish, cancel, or a
 * timer. It carries no id and no `data-*` the shell declares; `resume-ghost`
 * is a class of its own (public/css/app.css). Nothing is parsed as markup:
 * an image is set through `src`, an emoji or letter through `textContent`,
 * which is the same rule the ownership audit enforces everywhere else.
 */

import { appFrameStore } from '../app-frame/app-frame-store.js';
import { appIconKind } from '../apps/app-card-view';
import { parkedStore } from './parked-store.js';
import { recentAppsStore } from './recent-apps-store.js';

/** One motion, used for both directions and by the router's zoom calls. */
export const RESUME_MOTION_MS = 250;
/** The platform's app zoom, shortened (native.js's spring curve). */
export const RESUME_EASE = 'cubic-bezier(0.2, 0.8, 0.2, 1)';
/** The last stretch of the collapse, where the card lets go of its face. */
export const RESUME_FADE_MS = 90;
/** How long a noted press waits for the router to take it. */
export const RESUME_ORIGIN_TTL_MS = 1500;
/** The shortest safety timer after which a stand-in is gone, motion or not. */
const GHOST_CLEANUP_MS = RESUME_MOTION_MS + 150;

export interface ResumeRect {
  left: number;
  top: number;
  width: number;
  height: number;
}

interface ResumeOrigin {
  slug: string;
  element: Element;
  at: number;
}

let origin: ResumeOrigin | null = null;
let ghost: HTMLElement | null = null;
let ghostTimer: number | null = null;

function prefersReducedMotion(): boolean {
  if (typeof window === 'undefined' || !window.matchMedia) return false;
  return window.matchMedia('(prefers-reduced-motion: reduce)').matches;
}

/** A rect with area, at least partly in the viewport. */
export function rectOnScreen(rect: ResumeRect | null | undefined): rect is ResumeRect {
  if (!rect) return false;
  if (!(rect.width > 0 && rect.height > 0)) return false;
  if (typeof window === 'undefined') return true;
  return rect.left < window.innerWidth && rect.top < window.innerHeight
    && rect.left + rect.width > 0 && rect.top + rect.height > 0;
}

function elementOnScreen(element: Element | null): element is HTMLElement {
  if (!element || typeof element.getBoundingClientRect !== 'function') return false;
  return rectOnScreen(element.getBoundingClientRect());
}

/**
 * The control that resumes `slug`: the desktop Active row's Resume pill, the
 * row itself when that row is the current one (it has no pill), or the
 * phone's Resume strip root. Null when none of them is on screen, which is
 * every folded rail, a keyboard-up phone, chromeless and the signed-out shell.
 */
export function resumeHandleFor(slug: string): HTMLElement | null {
  if (!slug || typeof document === 'undefined') return null;
  const key = `app:${slug}`;
  try {
    const rows = document.querySelectorAll(
      '#platform-recents .platform-active a.platform-recent[data-recent-key]',
    );
    for (const row of Array.from(rows)) {
      if (row.getAttribute('data-recent-key') !== key) continue;
      const pill = row.querySelector('.platform-recent-resume');
      if (elementOnScreen(pill)) return pill;
      if (elementOnScreen(row)) return row;
    }
  } catch { /* a selector that cannot run has no target */ }
  // The phone's strip. Its ROOT is the origin, not the pill: its children
  // slide while it arrives, so a pill's rect is moving during the expand.
  const root = document.getElementById('platform-parked');
  const link = document.getElementById('platform-parked-resume');
  if (root && link && !root.classList.contains('hidden')
      && link.getAttribute('href') === `/app/${encodeURIComponent(slug)}`
      && elementOnScreen(root)) {
    return root;
  }
  return null;
}

/**
 * Remember the control a Resume press came from, for `takeResumeOrigin`.
 * Called from the press handler, before the router navigates.
 */
export function noteResumeOrigin(slug: string, element: Element | null): void {
  if (!slug || !elementOnScreen(element)) return;
  origin = { slug, element, at: Date.now() };
}

/**
 * The control that press came from, once. Another slug, an expired note and
 * a control that has since gone off screen all answer null.
 */
export function takeResumeOrigin(slug: string): HTMLElement | null {
  const held = origin;
  // Another app's press is IGNORED, not consumed: the note is per-slug, and
  // its 1.5s life is what stops an abandoned one from ever being used.
  if (!held || held.slug !== slug) return null;
  origin = null;
  if (Date.now() - held.at > RESUME_ORIGIN_TTL_MS) return null;
  if (!elementOnScreen(held.element)) return null;
  return held.element;
}

/** Drop the stand-in now, wherever it is in its life. */
function finishGhost(): void {
  if (ghostTimer !== null) {
    window.clearTimeout(ghostTimer);
    ghostTimer = null;
  }
  if (!ghost) return;
  const el = ghost;
  ghost = null;
  try { el.remove(); } catch { /* already gone */ }
}

function iconRecord(slug: string) {
  const parked = parkedStore.get().app;
  if (parked && parked.slug === slug) {
    return { name: parked.name, icon_url: parked.iconUrl, icon_emoji: parked.iconEmoji };
  }
  const recent = recentAppsStore.get().apps.find((app) => app.slug === slug);
  if (recent) {
    return { name: recent.name, icon_url: recent.iconUrl, icon_emoji: recent.iconEmoji };
  }
  return { name: slug, icon_url: null, icon_emoji: null };
}

/** The page colour the app's own bridge reported, or the shell's ground. */
function pageColour(slug: string): string {
  const state = appFrameStore.get();
  if (state.slug === slug && state.background) return state.background;
  const kept = (state.kept || []).find((frame) => frame.slug === slug);
  return (kept && kept.background) || '';
}

function buildGhost(slug: string): HTMLElement {
  const record = iconRecord(slug);
  const el = document.createElement('div');
  el.className = 'resume-ghost';
  el.setAttribute('aria-hidden', 'true');
  const tile = document.createElement('span');
  tile.className = 'app-icon-tile resume-ghost-tile';
  tile.setAttribute('data-icon', appIconKind(record));
  if (record.icon_url) {
    const img = document.createElement('img');
    img.src = record.icon_url;
    img.alt = '';
    img.setAttribute('draggable', 'false');
    img.className = 'w-full h-full rounded-xl object-cover';
    tile.appendChild(img);
  } else if (record.icon_emoji) {
    const span = document.createElement('span');
    span.className = 'text-3xl leading-none';
    span.textContent = record.icon_emoji;
    tile.appendChild(span);
  } else {
    tile.textContent = (record.name || '?').charAt(0).toUpperCase();
  }
  el.appendChild(tile);
  const background = pageColour(slug);
  if (background) el.style.background = background;
  return el;
}

/** Where a stand-in starts when no app rect was measured: the header's lower
 *  edge down to the floor, since that is the area the app covered. */
function fallbackRect(): ResumeRect | null {
  if (typeof document === 'undefined' || typeof window === 'undefined') return null;
  let top = 0;
  const header = document.getElementById('platform-header');
  if (header && typeof header.getBoundingClientRect === 'function') {
    const rect = header.getBoundingClientRect();
    if (rect.height > 0) top = Math.max(0, rect.bottom);
  }
  return { left: 0, top, width: window.innerWidth, height: Math.max(0, window.innerHeight - top) };
}

/**
 * Collapse `slug` into its Resume control from `from`, the app view's rect as
 * it was just before the screen was hidden. Without a measured rect the
 * stand-in starts at the header's lower edge, which is where the app was.
 *
 * Silent and empty when there is nowhere to land: no control on screen,
 * reduced motion, or a View Transition drawing snapshots
 * (`html[data-un-vt]`). In each case the close is the plain swap it was.
 */
export function collapseIntoResume(slug: string, from: ResumeRect | null | undefined): void {
  if (!slug || typeof document === 'undefined') return;
  if (prefersReducedMotion()) return;
  if (document.documentElement?.hasAttribute('data-un-vt')) return;
  const start = rectOnScreen(from) ? from : fallbackRect();
  if (!rectOnScreen(start)) return;
  const handle = resumeHandleFor(slug);
  if (!handle) return;
  const to = handle.getBoundingClientRect();
  if (!rectOnScreen(to)) return;

  finishGhost();
  const el = buildGhost(slug);
  el.style.left = `${start.left}px`;
  el.style.top = `${start.top}px`;
  el.style.width = `${start.width}px`;
  el.style.height = `${start.height}px`;
  el.style.transformOrigin = '0 0';
  el.style.transition = 'none';
  const scaleX = to.width / start.width;
  const scaleY = to.height / start.height;
  const tx = to.left - start.left;
  const ty = to.top - start.top;
  document.body.appendChild(el);
  ghost = el;
  // Flush the start pose, or the transition below has nothing to move from.
  void el.offsetWidth;
  el.style.transition = `transform ${RESUME_MOTION_MS}ms ${RESUME_EASE}, `
    + `opacity ${RESUME_FADE_MS}ms linear ${RESUME_MOTION_MS - RESUME_FADE_MS}ms`;
  el.style.transform = `translate(${tx}px, ${ty}px) scale(${scaleX}, ${scaleY})`;
  el.style.opacity = '0';
  const done = () => { if (ghost === el) finishGhost(); };
  el.addEventListener('transitionend', done, { once: true });
  el.addEventListener('transitioncancel', done, { once: true });
  ghostTimer = window.setTimeout(done, GHOST_CLEANUP_MS);
}
