/**
 * Read a lib/plain-store.js store from a component (#1085 chunk H).
 *
 * `useSyncExternalStore` with the same snapshot for client and server: the
 * prerender pass has no writer, so both sides start from the store's initial
 * value, which is by construction the markup the hand-written shell shipped.
 */

import { useSyncExternalStore } from 'react';

export interface PlainStore<T> {
  get(): T;
  subscribe(listener: () => void): () => void;
}

export function useStoreState<T>(store: PlainStore<T>): T {
  return useSyncExternalStore(
    (listener) => store.subscribe(listener),
    () => store.get(),
    () => store.get(),
  );
}
