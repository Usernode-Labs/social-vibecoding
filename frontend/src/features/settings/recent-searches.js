/**
 * The Settings search box's recent searches (#5996).
 *
 * What a person typed is remembered when they CHOOSE a result (a click or
 * Enter in ./settings-nav.tsx), never on every keystroke: five at most,
 * newest first, one entry per query whatever its capitals.
 *
 * ── Whose they are ────────────────────────────────────────────────────
 *
 * They belong to the signed-in ACCOUNT on this device: the localStorage key
 * carries the account's id (`currentUserId`, the same id the tour's
 * per-account storage reads), so after one person signs out, whoever signs
 * in next on the same browser sees their own list, not the last one's.
 * Nobody signed in has none and stores none. The list in memory remembers
 * whose it is, and is dropped the moment the account changes.
 *
 * ── Memory first, storage second ──────────────────────────────────────
 *
 * The list in memory is the source of truth for the page's life; storage
 * only carries it to the next visit. Every touch of storage is wrapped in
 * try/catch, so a private window or blocked site data still keeps this
 * visit's searches (a write that fails is dropped, not the list), and
 * garbage in the key reads as none.
 *
 * Plain JS with no React import, like the other settings stores; the two
 * nav hosts read the store with useStoreState, so recording on one updates
 * the other.
 */

import { createStore } from '../../lib/plain-store.js';
import { currentUserId } from '../home/tour/tour-storage';

export const RECENT_SEARCHES_PREFIX = 'usernode.settings.recentSearches.';
export const MAX_RECENT = 5;
/** A recent row shows exactly what was typed; this only bounds a paste. */
export const MAX_QUERY_LENGTH = 80;

/** The key for one account, or null when nobody is signed in. */
export function recentSearchesKey(owner) {
  return owner == null || owner === '' ? null : `${RECENT_SEARCHES_PREFIX}${owner}`;
}

/** The stored list, cleaned: strings only, trimmed, non-empty, at most five. */
export function readRecent(storage, owner) {
  const key = recentSearchesKey(owner);
  if (!key) return [];
  try {
    const raw = storage && storage.getItem(key);
    if (!raw) return [];
    const list = JSON.parse(raw);
    if (!Array.isArray(list)) return [];
    return list
      .filter((q) => typeof q === 'string')
      .map((q) => q.trim())
      .filter(Boolean)
      .slice(0, MAX_RECENT);
  } catch {
    return [];
  }
}

/**
 * `list` with `query` at the top (moved there if it is already in it,
 * whatever its capitals), five kept. A blank query changes nothing. Pure.
 */
export function addRecent(list, query) {
  const q = String(query == null ? '' : query).trim().slice(0, MAX_QUERY_LENGTH);
  if (!q) return list;
  const lower = q.toLowerCase();
  return [q, ...list.filter((r) => r.toLowerCase() !== lower)].slice(0, MAX_RECENT);
}

function persist(storage, owner, list) {
  const key = recentSearchesKey(owner);
  if (!key || !storage) return;
  try {
    if (list.length) storage.setItem(key, JSON.stringify(list));
    else storage.removeItem(key);
  } catch { /* storage full or blocked: the list lives in memory for this visit */ }
}

/**
 * The recent searches of whoever `owner()` names, kept in `store`. Built
 * with its storage and owner injected, so the suite can switch accounts and
 * break storage; the app uses the one below.
 */
export function createRecentSearches({ storage, owner }) {
  const store = createStore({ owner: null, items: [] });
  // `undefined` until the first read, so the first call always reads.
  let held = undefined;
  let items = [];

  const getStorage = () => {
    try { return storage(); } catch { return null; }
  };

  /** Drop the list the moment the account changes, and read the new one's. */
  const whoNow = () => {
    try {
      const who = owner();
      return who === undefined ? null : who;
    } catch {
      return null;
    }
  };
  const sync = () => {
    const who = whoNow();
    if (who === held) return who;
    held = who;
    items = readRecent(getStorage(), who);
    store.set({ owner: who, items });
    return who;
  };

  return {
    store,
    /**
     * What to draw from the store's state: its items only while they are
     * the signed-in account's. Between a sign-out or a switch and the next
     * load() the store still holds the last account's list; this keeps it
     * off the screen in that gap.
     */
    visible(state) {
      return state && state.owner != null && state.owner === whoNow() ? state.items : [];
    },
    /** Read the device's list for the signed-in account (from an effect, never a render). */
    load() { sync(); },
    /** Remember a chosen search. Nobody signed in remembers nothing. */
    remember(query) {
      const who = sync();
      if (who == null) return;
      const next = addRecent(items, query);
      if (next === items) return;
      items = next;
      store.set({ owner: who, items });
      persist(getStorage(), who, items);
    },
    /** The Clear button. */
    forget() {
      const who = sync();
      items = [];
      store.set({ owner: who, items });
      persist(getStorage(), who, items);
    },
  };
}

const recent = createRecentSearches({
  storage: () => (typeof window !== 'undefined' ? window.localStorage : null),
  owner: () => (typeof window !== 'undefined' ? currentUserId() : null),
});

/** What both nav hosts render from. Starts empty, so the prerender is unchanged. */
export const recentSearchesStore = recent.store;
export const visibleRecent = recent.visible;
export const loadRecent = recent.load;
export const rememberSearch = recent.remember;
export const forgetSearches = recent.forget;
