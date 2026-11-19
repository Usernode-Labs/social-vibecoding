/**
 * How old what the screen shows is, when it came from the phone rather than
 * from the server (the native-offline proposal, 18 Nov 2026).
 *
 * A screen drawn from a saved copy says so once, in the header's connection
 * status ("No internet · Updated 12:41", features/header/connection-status),
 * the way native apps say it: once per screen and as a time, never a badge on
 * every row. Two kinds of saved copy reach a screen:
 *
 *   - the service worker's: an API read it answered from Cache Storage
 *     carries `sw-cached-at` (public/sw.js CACHED_AT_HEADER), the time it was
 *     saved. lib/offline.ts watches every same-origin read and notes it here,
 *     and a later answer for the same address from the network forgets it;
 *   - the app's own (./kept-copies.ts): drawing one notes its time under the
 *     copy's name, and keeping a new one forgets it.
 *
 * What is noted belongs to the screen on show: moving to another screen
 * starts again, and so does coming back online (every screen re-reads then).
 * The oldest time still noted is the screen's.
 */

import { createStore } from './plain-store.js';

/** A copy younger than this reads as current: no time is shown for it. */
export const FRESH_FOR_MS = 2 * 60 * 1000;

export interface FreshnessState {
  /** The oldest saved copy drawn on this screen (epoch ms), or null. */
  savedAt: number | null;
}

export const freshnessStore = createStore<FreshnessState>({ savedAt: null });

const noted = new Map<string, number>();

function publish(): void {
  let oldest: number | null = null;
  for (const at of noted.values()) if (oldest === null || at < oldest) oldest = at;
  if (freshnessStore.get().savedAt !== oldest) freshnessStore.set({ savedAt: oldest });
}

/** `key` (an address or a kept copy's name) was drawn from a copy saved at `at`. */
export function noteSaved(key: string, at: number): void {
  if (!key || !Number.isFinite(at) || at <= 0) return;
  noted.set(key, at);
  publish();
}

/** `key` has a current answer now. */
export function noteFresh(key: string): void {
  if (!noted.delete(key)) return;
  publish();
}

/** A new screen, or everything read again: nothing saved is on show. */
export function resetFreshness(): void {
  if (!noted.size) return;
  noted.clear();
  publish();
}

/** Whether `savedAt` is old enough to say so, at `now`. */
export function showsAge(savedAt: number | null, now: number = Date.now()): boolean {
  return savedAt !== null && now - savedAt >= FRESH_FOR_MS;
}

/**
 * The time a copy was saved, as the status line says it: the time of day for
 * today ("12:41"), the date for an earlier day ("Nov 17"), in the person's
 * own locale.
 */
export function savedAtLabel(savedAt: number, now: number = Date.now(), locale?: string): string {
  const saved = new Date(savedAt);
  const today = new Date(now);
  const sameDay = saved.getFullYear() === today.getFullYear()
    && saved.getMonth() === today.getMonth() && saved.getDate() === today.getDate();
  try {
    return sameDay
      ? saved.toLocaleTimeString(locale, { hour: 'numeric', minute: '2-digit' })
      : saved.toLocaleDateString(locale, { month: 'short', day: 'numeric' });
  } catch {
    return sameDay
      ? `${saved.getHours()}:${String(saved.getMinutes()).padStart(2, '0')}`
      : saved.toDateString();
  }
}

let watching = false;

/** Start over on every screen change (the router's address moves). Idempotent. */
export function initFreshness(): void {
  if (watching || typeof window === 'undefined' || !window.location) return;
  watching = true;
  const here = () => `${window.location.pathname}${window.location.hash}`;
  let where = here();
  const moved = () => {
    const now = here();
    if (now === where) return;
    where = now;
    resetFreshness();
  };
  window.addEventListener('hashchange', moved);
  window.addEventListener('popstate', moved);
  // pushState/replaceState fire no event: the router's navigations are
  // caught by checking on the next frame after any click.
  const later = typeof requestAnimationFrame === 'function' ? requestAnimationFrame : (run: () => void) => setTimeout(run, 16);
  if (typeof document !== 'undefined') document.addEventListener('click', () => { later(moved); }, true);
}
