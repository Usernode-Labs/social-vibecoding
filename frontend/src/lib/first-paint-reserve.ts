/**
 * The first paint's boxes, held at the height this device last drew them
 * (#10 and #1, the polish board of 19 Oct 2026).
 *
 * ── The jumps this removes ─────────────────────────────────────────────
 *
 * The prerendered document paints before the bundle hydrates, and it is
 * skeletons: eight tile placeholders in Home's grid, a card placeholder under
 * Discover, three under Challenges, and a desktop sidebar with no community
 * rows at all. Then the reads land and the real page takes their place at
 * different heights: the grid shows as many rows as the screen has room for
 * plus "Show all 21 apps", Discover is a rail of cards or one card,
 * Challenges is one to five cards, and five community rows (185px) appear in
 * the sidebar above "All 31 communities". On a desktop that was one layout
 * shift of 0.0585 on every cold load (Discover 54 → 121px, Challenges pushed
 * from y 392 to 523), and on a phone the "Show all" row pushing the page
 * down.
 *
 * No skeleton can know those heights; this device can, because it drew them
 * last time. So once they are drawn in their resting shape they are kept
 * here, per window size and text size, and the next load's skeletons are
 * held at them: an inline script in frontend/src/head.html puts them on
 * <html> before the first paint (the `first-paint-reserved` class and one
 * `--reserve-*` property per box), and public/css/app.css applies each one
 * only while its box is still a skeleton. The page then lands in boxes of
 * its own size.
 *
 * ── It is display-only ─────────────────────────────────────────────────
 *
 * A few numbers, read for nothing but a box's height while it is empty, and
 * overwritten by the next paint. A device with none (a first visit, a new
 * window size) draws the skeletons at their own shape, as before.
 *
 * The storage key, the key of a size and the property names are spelled in
 * two places, here and in the head script, and the two must agree:
 * tests/home-first-paint.test.js holds them to each other.
 */

import { gridStore } from '../features/home/grid-store';
import { panelsStore } from '../features/home/panels-store';

export const RESERVE_KEY = 'usernode.first-paint.v1';

/** How many window sizes are remembered; the oldest goes first. */
const MAX_SIZES = 4;

/** What is kept for one size: each box's height in px, when known. */
export interface Reserve {
  /** #home-apps-section: My apps, the grid and "Show all N apps". */
  homeApps?: number;
  /** #home-discover-section. */
  homeDiscover?: number;
  /** #home-challenges-section. */
  homeChallenges?: number;
  /** #platform-rail-communities: the desktop sidebar's community rows. */
  railCommunities?: number;
}

/** `<width>x<height>|<text size>`: what decides how tall these draw. */
export function reserveKey(win: { innerWidth: number; innerHeight: number }, textSize: string | null): string {
  return `${win.innerWidth}x${win.innerHeight}|${textSize || 'normal'}`;
}

type Stored = { sizes: Record<string, Reserve & { at: number }> };

function read(): Stored {
  try {
    const raw = JSON.parse(window.localStorage.getItem(RESERVE_KEY) || 'null');
    if (raw && raw.sizes && typeof raw.sizes === 'object') return raw as Stored;
  } catch { /* nothing kept */ }
  return { sizes: {} };
}

/** Merge `patch` into what is kept for `key`, dropping the oldest sizes past MAX_SIZES. Never throws. */
export function saveReserve(key: string, patch: Reserve, now = Date.now()): void {
  try {
    const stored = read();
    const prev = stored.sizes[key] || { at: 0 };
    const changed = (Object.keys(patch) as (keyof Reserve)[]).some((k) => prev[k] !== patch[k]);
    if (!changed) return;
    stored.sizes[key] = { ...prev, ...patch, at: now };
    const keys = Object.keys(stored.sizes).sort((a, b) => stored.sizes[b].at - stored.sizes[a].at);
    for (const old of keys.slice(MAX_SIZES)) delete stored.sizes[old];
    window.localStorage.setItem(RESERVE_KEY, JSON.stringify(stored));
  } catch { /* the next load draws the skeletons at their own shape */ }
}

function heightOf(el: Element | null): number {
  // Exact to the hundredth, not rounded to the pixel: a box half a pixel out
  // is still a shift.
  return el ? Math.round(el.getBoundingClientRect().height * 100) / 100 : 0;
}

function shown(el: Element | null): boolean {
  return !!el && !el.classList.contains('hidden') && el.getClientRects().length > 0;
}

/**
 * What is on screen now, for the boxes that are in their resting shape: Home
 * when the launcher is at rest (not a search, not edit mode, not "Show all"
 * pressed, no load notice) and both sections are painted; the sidebar's
 * community rows when they are drawn beside Home (a community's page nests
 * its places under its row, which a cold load of Home does not).
 */
export function measure(doc: Document = document): Reserve {
  const out: Reserve = {};
  const screen = doc.getElementById('home-screen');
  if (!shown(screen)) return out;
  const grid = gridStore.get();
  const home = (window as unknown as { Home?: { _appsExpanded?: boolean; _query?: string } }).Home;
  if (grid.ready && grid.view === 'grid' && !grid.notice && !grid.editing && panelsStore.get().painted
      && !home?._appsExpanded && !(home?._query || '').trim()) {
    out.homeApps = heightOf(doc.getElementById('home-apps-section'));
    out.homeDiscover = heightOf(doc.getElementById('home-discover-section'));
    out.homeChallenges = heightOf(doc.getElementById('home-challenges-section'));
  }
  const rail = doc.getElementById('platform-rail-communities');
  if (shown(rail) && rail!.childElementCount > 1) out.railCommunities = heightOf(rail);
  return out;
}

let installed = false;
/**
 * Keep the heights whenever one of the boxes changes size in its resting
 * shape. Installed once, by the browser entry after hydration (main.tsx).
 */
export function installFirstPaintReserve(): void {
  if (installed || typeof window === 'undefined' || typeof window.ResizeObserver !== 'function') return;
  installed = true;
  let frame = 0;
  const record = () => {
    frame = 0;
    const r = measure();
    if (!Object.keys(r).length) return;
    saveReserve(reserveKey(window, document.documentElement.getAttribute('data-text-size')), r);
  };
  const schedule = () => {
    if (!frame) frame = window.requestAnimationFrame(record);
  };
  const observer = new window.ResizeObserver(schedule);
  for (const id of ['home-apps-section', 'home-discover-section', 'home-challenges-section', 'platform-rail-communities']) {
    const el = document.getElementById(id);
    if (el) observer.observe(el);
  }
  gridStore.subscribe(schedule);
  panelsStore.subscribe(schedule);
}
