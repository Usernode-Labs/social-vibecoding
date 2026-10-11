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

type TourRunningStore = { running: boolean; listeners: Set<() => void> };

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
