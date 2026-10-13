/**
 * Whether a first-session tour is on screen (./index.tsx Tour sets it while
 * it is mounted). While the tour runs it asks for nothing but its own
 * cards, the plan included (requests #4391, #4393): the maker's ends on the
 * hub with Open app, and the app it opens offers the plan once the tour is
 * over. So the hub's first-version card (../dev-board/workshop/
 * hub-cards.tsx) draws no "Review the plan" while this is true, only its
 * build line, "Homeroom bot is working on it", and the App tab
 * (../app-frame/app-status.tsx) holds its "Review the plan" back the same
 * way. Once the tour ends both draw what they always did.
 *
 * Kept on `globalThis`, as ../dev-board/view-mode-store.ts is, so a lazily
 * loaded chunk that bundles its own copy of this module reads the same flag.
 * Only React reads it; nothing in `public/js/**` writes into the regions it
 * changes.
 */

import { useSyncExternalStore } from 'react';

export const TOUR_RUNNING_KEY = '__usernodeFirstSessionTourRunning';

type TourRunningStore = { running: boolean; visit?: boolean; listeners: Set<() => void> };

function store(): TourRunningStore {
  const g = globalThis as unknown as Record<string, TourRunningStore | undefined>;
  let s = g[TOUR_RUNNING_KEY];
  if (!s) {
    s = { running: false, listeners: new Set() };
    g[TOUR_RUNNING_KEY] = s;
  }
  return s;
}

export function tourRunning(): boolean {
  return store().running;
}

export function setTourRunning(running: boolean): void {
  const s = store();
  if (s.running === running) return;
  s.running = running;
  for (const listener of Array.from(s.listeners)) listener();
}

export function subscribeTourRunning(listener: () => void): () => void {
  const s = store();
  s.listeners.add(listener);
  return () => { s.listeners.delete(listener); };
}

/**
 * The flag, re-rendering when the tour starts or ends. Its readers mount
 * client-side with no server render to match, and the prerender never runs
 * a tour, so the server's answer is the same read (false there).
 */
export function useTourRunning(): boolean {
  return useSyncExternalStore(subscribeTourRunning, tourRunning, tourRunning);
}

/**
 * A FIRST VISIT STAYS ONE (onboarding run two, 12 Oct 2026, iPhone 17
 * Safari). The home-screen strip was held while the tour was up (#4899) and
 * came in 15ms after the tour opened the new app, pushing the whole page
 * down 44pt, then stayed on every screen. A visit that showed any of the
 * first session's own screens (welcome, make, made, the tour; never
 * Create's) is a first visit to its end: noted here and kept in the tab's
 * sessionStorage, so a reload in that visit keeps it, and a new visit offers
 * the strip as before. Separate from `running`, which the hub and the App
 * tab need cleared once the tour ends.
 */
export const FIRST_VISIT_KEY = 'usernode:first-session:visit';

function storedVisit(): boolean {
  try { return typeof sessionStorage !== 'undefined' && sessionStorage.getItem(FIRST_VISIT_KEY) === '1'; } catch { return false; }
}

export function firstSessionVisit(): boolean {
  const s = store();
  if (s.visit === undefined) s.visit = storedVisit();
  return s.visit;
}

export function noteFirstSessionVisit(): void {
  const s = store();
  if (s.visit === true) return;
  s.visit = true;
  try { sessionStorage.setItem(FIRST_VISIT_KEY, '1'); } catch { /* this page's flag still holds */ }
  for (const listener of Array.from(s.listeners)) listener();
}

/** The first-visit flag, re-rendering when it is noted (false on the server, as `useTourRunning`). */
export function useFirstSessionVisit(): boolean {
  return useSyncExternalStore(subscribeTourRunning, firstSessionVisit, () => false);
}
