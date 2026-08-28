/**
 * Per-row discussion state for the Activity feed's inline threads.
 *
 * ── One store, keyed by thread, and not one store per row ──────────────
 *
 * A feed row is not a stable thing to key on: the stream re-sorts as work
 * happens, "Show more" grows it, and a filter can drop a row out and bring it
 * back. The THREAD is stable — `${type}:${ref}` is the same conversation
 * wherever its row currently sits — so that is the key, and a row that comes
 * back finds its messages already loaded rather than re-fetching them.
 *
 * It also means the board and the feed cannot disagree: both address the same
 * entry, so a comment posted from the feed is in hand if the same thread is
 * opened as a topic in the same session.
 */

import { createStore } from '../../../lib/plain-store.js';

export interface FeedThreadMessage {
  id: number;
  author: string;
  content: string;
  createdAt: string;
}

export interface FeedThreadState {
  /** Loaded messages, oldest first, capped to the preview length. */
  messages: FeedThreadMessage[];
  /** Total the server reported, so the row can say how many it is not showing. */
  total: number;
  loading: boolean;
  /** A post is in flight; the composer refuses a second one. */
  posting: boolean;
  /** Set when a load or post failed, so the row can say so rather than sit blank. */
  error: string | null;
  /** True once a load has completed, so "no comments yet" is not said too early. */
  loaded: boolean;
}

export const EMPTY_FEED_THREAD: FeedThreadState = {
  messages: [],
  total: 0,
  loading: false,
  posting: false,
  error: null,
  loaded: false,
};

/**
 * `{ [threadKey]: FeedThreadState }`.
 *
 * A plain map rather than a Map, because plain-store's subscribers diff by
 * reference and every write here replaces the entry it touches.
 */
export const feedThreadStore = createStore<Record<string, FeedThreadState>>({});

export function threadKey(type: string, ref: number | string): string {
  return `${type}:${ref}`;
}

export function readThread(key: string): FeedThreadState {
  return feedThreadStore.get()[key] || EMPTY_FEED_THREAD;
}

/** Merge a patch into one thread's entry, leaving every other entry alone. */
export function patchThread(key: string, patch: Partial<FeedThreadState>): void {
  const all = feedThreadStore.get();
  feedThreadStore.set({ ...all, [key]: { ...(all[key] || EMPTY_FEED_THREAD), ...patch } });
}
