/**
 * The viewer's friend ids, for putting friends FIRST in a picker the page
 * already has (#2386) — the Messages composer's @ list is the one caller.
 *
 * The server orders the pickers it answers (the Messages user search, an
 * app's mention suggestions). The composer's list is different: it filters
 * the open conversation's members in memory, so the order has to be applied
 * here, from the viewer's own friends.
 *
 * Loaded lazily, from an effect — never in a render, so an island that uses
 * it prerenders exactly as before — and at most once a minute. Any friend
 * change the page makes announces itself (FRIENDS_CHANGED_EVENT) and the next
 * reader loads afresh. A failed load leaves the order alphabetical, which is
 * what it was before friends existed: this is an ordering hint, never a gate.
 */

import { useEffect } from 'react';

import { createStore } from '../../lib/plain-store.js';
import { useStoreState } from '../../lib/use-store-state';
import { FRIENDS_CHANGED_EVENT, listFriends } from './api';

const TTL_MS = 60_000;

type FriendIdsState = { ids: ReadonlySet<number>; loadedAt: number };

const EMPTY: ReadonlySet<number> = new Set();

export const friendIdsStore = createStore<FriendIdsState>({ ids: EMPTY, loadedAt: 0 });

let inflight: Promise<void> | null = null;
let listening = false;

function listen(): void {
  if (listening || typeof window === 'undefined') return;
  listening = true;
  window.addEventListener(FRIENDS_CHANGED_EVENT, () => {
    friendIdsStore.set({ loadedAt: 0 });
  });
}

export function loadFriendIds(now: number = Date.now()): Promise<void> {
  listen();
  const { loadedAt } = friendIdsStore.get();
  if (loadedAt && now - loadedAt < TTL_MS) return Promise.resolve();
  if (inflight) return inflight;
  inflight = (async () => {
    try {
      const lists = await listFriends();
      friendIdsStore.set({ ids: new Set(lists.friends.map((f) => f.id)), loadedAt: Date.now() });
    } catch {
      // An ordering hint: keep whatever we had, and try again next time.
    } finally {
      inflight = null;
    }
  })();
  return inflight;
}

/** The friend ids, loading them after mount (and after any change). */
export function useFriendIds(): ReadonlySet<number> {
  const state = useStoreState(friendIdsStore);
  useEffect(() => { void loadFriendIds(); }, [state.loadedAt]);
  return state.ids;
}

/**
 * Friends first, everyone else after, each group in the order it arrived.
 * Pure, and stable — it never reorders within a group — so an alphabetical
 * list stays alphabetical on both sides of the split.
 */
export function orderFriendsFirst<T extends { id: number }>(items: readonly T[], friendIds: ReadonlySet<number>): T[] {
  if (!friendIds.size) return [...items];
  const friends: T[] = [];
  const others: T[] = [];
  for (const item of items) (friendIds.has(item.id) ? friends : others).push(item);
  return [...friends, ...others];
}
