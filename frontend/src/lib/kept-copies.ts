/**
 * What this device kept of one person's private reads, so a screen can draw
 * them when the server cannot be reached (offline test, 2 Nov 2026).
 *
 * ── The gap this closes ────────────────────────────────────────────────
 *
 * With the internet off, Messages, a conversation opened minutes earlier and
 * the Homeroom bot tab had nothing to draw: Messages showed the browser's own
 * exception ("FetchEvent.respondWith received an error: TypeError: Load
 * failed") and the bot tab an empty Needs you card. The service worker keeps
 * an offline copy of most reads (public/sw.js networkFirstApi), but never of
 * these: GET /api/conversations* and GET /api/ai/work answer
 * `Cache-Control: private, no-store` (src/routes/conversations.js
 * privateJson, src/routes/ai-work.js), and the worker honours that, so the
 * browser's HTTP cache and the worker's Cache Storage hold no message bytes.
 * That policy stays. The copies here are the app's own, small and bounded,
 * and cleared on the same events as every other piece of per-viewer state.
 *
 * ── Whose they are ─────────────────────────────────────────────────────
 *
 * Every copy carries the session's API cache partition
 * (`usernode_api_scope`, ./api-cache-identity.ts), and is read back only
 * under that same partition: another account on this device, or nobody
 * signed in, reads nothing. The first use under a new partition forgets
 * everything kept for the previous one, and a sign-out forgets it all at
 * once (App._dropCachedSession calls `UsernodeReact.keptCopies.clear`). A
 * staging demo (`?demo=1`) reads made-up rows: they are kept apart.
 *
 * ── What they are for ──────────────────────────────────────────────────
 *
 * A screen draws a kept copy only when its own read had no answer it could
 * use, never in place of one: an open on a healthy network still waits for
 * the server (#4243). A copy older than KEPT_MAX_AGE_MS is not drawn, and
 * one larger than KEPT_MAX_CHARS is not kept. localStorage, not IndexedDB:
 * the copies are small, they are read on the same tick a read fails, and
 * losing them under storage pressure costs only the offline view.
 *
 * ── A cache never crowds out boot state ────────────────────────────────
 *
 * WebKit gives an origin about 5 MB of localStorage, some 2.5M UTF-16
 * characters, and the session snapshot (`usernode.session.v1`), the header's
 * (`usernode.shell.v1`) and the drafts live there too: a full origin fails
 * their writes, not just this one's. So all copies together stay under
 * KEPT_TOTAL_CHARS (keys and values). A copy that would pass it first
 * forgets the copies of the conversations opened longest ago (the
 * `<family>:recent` order keepRecent keeps), never those of the one being
 * kept; if it still does not fit, it is not kept, and its older copy goes.
 */

import { readApiCacheScope } from './api-cache-identity';

const PREFIX = 'usernode:kept:';
/** Which partition the copies belong to. Starts with PREFIX, so a clear takes it too. */
const OWNER_KEY = `${PREFIX}owner`;

/** Two weeks, the service worker's own limit for its offline copies. */
export const KEPT_MAX_AGE_MS = 14 * 24 * 60 * 60 * 1000;
/**
 * A copy longer than this (in UTF-16 units, as localStorage counts) is not
 * kept. A page of 50 messages drawn from the server's shape
 * (services/conversations.js hydrateMessages) is about 22k characters of
 * people's messages, about 117k of the bot's with a question and two
 * shared cards each.
 */
export const KEPT_MAX_CHARS = 150_000;
/** All copies together, keys and values: about a quarter of WebKit's quota for the origin. */
export const KEPT_TOTAL_CHARS = 600_000;

function storage(): Storage | null {
  try {
    return typeof localStorage === 'undefined' ? null : localStorage;
  } catch {
    return null;
  }
}

function demo(): boolean {
  try {
    return typeof window !== 'undefined' && new URLSearchParams(window.location.search).get('demo') === '1';
  } catch {
    return false;
  }
}

function keyOf(name: string): string {
  return `${PREFIX}${demo() ? 'demo:' : ''}${name}`;
}

function removeStarting(store: Storage, start: string): void {
  try {
    for (let i = store.length - 1; i >= 0; i -= 1) {
      const key = store.key(i);
      if (key && key.startsWith(start)) store.removeItem(key);
    }
  } catch {
    /* nothing kept, or nothing to remove it from */
  }
}

/** The store and the partition to keep for, or null when nobody is signed in to keep anything for. */
function forViewer(): { store: Storage; scope: string } | null {
  const store = storage();
  const scope = typeof document === 'undefined' ? null : readApiCacheScope(document);
  if (!store || !scope) return null;
  try {
    if (store.getItem(OWNER_KEY) !== scope) {
      removeStarting(store, PREFIX);
      store.setItem(OWNER_KEY, scope);
    }
  } catch {
    return null;
  }
  return { store, scope };
}

/** Every copy's size, keys and values, by key. */
function sizes(store: Storage): Map<string, number> {
  const out = new Map<string, number>();
  for (let i = 0; i < store.length; i += 1) {
    const key = store.key(i);
    if (key && key.startsWith(PREFIX)) out.set(key, key.length + (store.getItem(key) || '').length);
  }
  return out;
}

/**
 * Make room for `need` characters at `key` within KEPT_TOTAL_CHARS (see the
 * header): the copy at `key` is about to be replaced, so it does not count;
 * past the budget, the families' least recent members go, oldest first,
 * never the one `key` belongs to. True when it fits.
 */
function makeRoom(store: Storage, key: string, need: number): boolean {
  const kept = sizes(store);
  kept.delete(key);
  let total = need;
  for (const size of kept.values()) total += size;
  if (total <= KEPT_TOTAL_CHARS) return true;
  const recentSuffix = ':recent';
  for (const indexKey of [...kept.keys()].filter((item) => item.endsWith(recentSuffix))) {
    const family = indexKey.slice(0, -recentSuffix.length);
    let ids: string[] = [];
    try {
      const saved = JSON.parse(store.getItem(indexKey) || 'null');
      ids = Array.isArray(saved) ? saved.map(String) : [];
    } catch { /* an unreadable index evicts nothing */ }
    const current = key.startsWith(`${family}:`) ? key.slice(family.length + 1).split(':')[0] : null;
    for (let i = ids.length - 1; i >= 0 && total > KEPT_TOTAL_CHARS; i -= 1) {
      if (ids[i] === current) continue;
      const start = `${family}:${ids[i]}:`;
      for (const [item, size] of kept) {
        if (!item.startsWith(start)) continue;
        store.removeItem(item);
        kept.delete(item);
        total -= size;
      }
      ids.splice(i, 1);
    }
    store.setItem(indexKey, JSON.stringify(ids));
    if (total <= KEPT_TOTAL_CHARS) return true;
  }
  return total <= KEPT_TOTAL_CHARS;
}

/** Keep `data` as the copy called `name`, for the person signed in. */
export function keepCopy(name: string, data: unknown): void {
  const viewer = forViewer();
  if (!viewer || data == null) return;
  const key = keyOf(name);
  try {
    const entry = JSON.stringify({ scope: viewer.scope, at: Date.now(), data });
    // Too large to keep, or no room for it: the older copy goes too, so it
    // is not drawn as current.
    if (entry.length > KEPT_MAX_CHARS || !makeRoom(viewer.store, key, key.length + entry.length)) {
      viewer.store.removeItem(key);
    } else {
      viewer.store.setItem(key, entry);
    }
  } catch {
    // Storage full or refused: the older copy goes, and the screen reads as it did before.
    try { viewer.store.removeItem(key); } catch { /* nothing to remove */ }
  }
}

/** The copy called `name`, kept for the person signed in and recent enough to draw; else null. */
export function keptCopy<T = unknown>(name: string, now: number = Date.now()): T | null {
  const viewer = forViewer();
  if (!viewer) return null;
  const key = keyOf(name);
  try {
    const raw = viewer.store.getItem(key);
    if (!raw) return null;
    const entry = JSON.parse(raw);
    if (entry && entry.scope === viewer.scope && typeof entry.at === 'number'
      && entry.at <= now && now - entry.at < KEPT_MAX_AGE_MS && entry.data != null) {
      return entry.data as T;
    }
    viewer.store.removeItem(key);
  } catch {
    // A corrupt entry is no copy.
  }
  return null;
}

/** Forget every copy whose name starts with `start` (a conversation's, `conversation:42:`). */
export function forgetKept(start: string): void {
  const store = storage();
  if (store) removeStarting(store, keyOf(start));
}

/**
 * Note `id` as the most recent of a family of copies (the conversations),
 * keeping the `max` most recent: every copy of the others, named
 * `<family>:<id>:…`, is forgotten.
 */
export function keepRecent(family: string, id: string | number, max: number): void {
  const viewer = forViewer();
  if (!viewer) return;
  const indexKey = keyOf(`${family}:recent`);
  try {
    const saved = JSON.parse(viewer.store.getItem(indexKey) || 'null');
    const ids = Array.isArray(saved) ? saved.map(String) : [];
    const next = [String(id), ...ids.filter((item) => item !== String(id))];
    for (const gone of next.slice(max)) removeStarting(viewer.store, keyOf(`${family}:${gone}:`));
    viewer.store.setItem(indexKey, JSON.stringify(next.slice(0, max)));
  } catch {
    /* the copies stay as they were */
  }
}

/** Forget everything kept, for everyone: a session that is over (App._dropCachedSession). */
export function forgetKeptCopies(): void {
  const store = storage();
  if (store) removeStarting(store, PREFIX);
}

if (typeof window !== 'undefined') {
  const host = window as unknown as { UsernodeReact?: Record<string, unknown> };
  const bridge = (host.UsernodeReact ||= {});
  bridge.keptCopies = { clear: forgetKeptCopies };
}
