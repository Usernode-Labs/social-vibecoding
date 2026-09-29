/**
 * "Somebody asked for the tour again" — the seam between Settings and Home.
 *
 * Settings' Replay control (../../settings/sections/tour.tsx) and the tour
 * overlay (./index.tsx) are in two different bundle chunks: the settings
 * panes are lazy (frontend/src/lib/mount-on-reveal.ts) and the overlay rides
 * the shell. A module-level counter would be one instance today and two the
 * day the chunk graph moves, so the state lives on `window` under a single
 * key, created by whichever side touches it first. That is the same shape,
 * and the same reasoning, as ../../../lib/visibility-store.ts.
 *
 * It carries a COUNTER rather than a boolean: pressing Replay twice has to
 * restart the tour twice, and a flag that is already true says nothing the
 * second time.
 */

import { useSyncExternalStore } from 'react';

export const TOUR_REQUEST_KEY = '__usernodeTourRequest';

export interface TourRequestStore {
  /** Bumped once per Replay press. Never reset. */
  count: number;
  listeners: Set<() => void>;
}

type StoreHost = typeof globalThis & { [TOUR_REQUEST_KEY]?: TourRequestStore };

export function getTourRequestStore(): TourRequestStore {
  const host = globalThis as StoreHost;
  let store = host[TOUR_REQUEST_KEY];
  if (!store) {
    store = { count: 0, listeners: new Set() };
    host[TOUR_REQUEST_KEY] = store;
  }
  return store;
}

/** Ask for the tour to run again. Notifies synchronously. */
export function requestTour(): void {
  const store = getTourRequestStore();
  store.count += 1;
  // Copy first: a listener that unsubscribes during notification would
  // otherwise mutate the set being iterated.
  for (const listener of [...store.listeners]) {
    try {
      listener();
    } catch (err) {
      console.error('[tour] listener failed', err);
    }
  }
}

export function readTourRequest(): number {
  return getTourRequestStore().count;
}

function subscribe(onChange: () => void): () => void {
  const store = getTourRequestStore();
  store.listeners.add(onChange);
  return () => {
    store.listeners.delete(onChange);
  };
}

/**
 * The request count, as React state.
 *
 * The prerender pass and the first client render both read 0, because nothing
 * can have pressed Replay before hydration -- so this cannot move the first
 * render away from the prerendered markup.
 */
export function useTourRequest(): number {
  return useSyncExternalStore(subscribe, readTourRequest, () => 0);
}
