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
 * A screen draws a kept copy when its own read had no answer it could use,
 * and, with nothing on screen yet, once that read has gone KEPT_DRAW_MS
 * unanswered, never in place of an answer: the read carries on, and its
 * answer replaces the copy when it lands. A copy older than KEPT_MAX_AGE_MS is not drawn, and
 * one larger than the budget's per-copy limit is not kept. Drawing one tells
 * the screen's freshness when it was saved (./freshness.ts), so the header
 * can say "Updated 12:41"; keeping a new one says it is current again.
 *
 * ── Where they live: IndexedDB, read through a mirror ─────────────────
 *
 * In IndexedDB (the native-offline proposal, 18 Nov 2026). They were in
 * localStorage, which WebKit caps at about 5 MB an origin and shares with
 * the session snapshot (`usernode.session.v1`), the header's
 * (`usernode.shell.v1`) and the drafts, so the copies had to stay under a
 * quarter of it: KEPT_TOTAL_CHARS in all, KEPT_MAX_CHARS each. A Messages
 * list of 76 conversations is 176k characters, so it was never kept and a
 * cold launch offline had none to draw. An app's web view may use up to 15%
 * of the disk per origin in IndexedDB since iOS 17, so there the budget is
 * KEPT_DB_TOTAL_CHARS in all and KEPT_DB_MAX_CHARS each.
 *
 * A screen reads a copy on the same tick its read fails, so reads stay
 * synchronous: every copy is mirrored in memory once loaded (at module
 * evaluation, well before a read can fail), and a write goes to the mirror
 * at once and to the database behind it. Copies left in localStorage by an
 * older build move across on that first load. `keptLoaded()` resolves once
 * the mirror holds the database, for a caller that failed before it did.
 * Where there is no IndexedDB (a browser that refuses it, the tests), the
 * copies stay in localStorage under the old, smaller budget.
 *
 * ── A cache never crowds out the rest ──────────────────────────────────
 *
 * All copies together stay under the budget (keys and values). A copy that
 * would pass it first forgets the copies of the conversations opened
 * longest ago (the `<family>:recent` order keepRecent keeps), never those of
 * the one being kept; if it still does not fit, it is not kept, and its
 * older copy goes. Losing them all under storage pressure costs only the
 * offline view.
 */

import { readApiCacheScope } from './api-cache-identity';
import { noteFresh, noteSaved } from './freshness';

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
/** Each copy, in IndexedDB: a long Messages list with its previews fits many times over. */
export const KEPT_DB_MAX_CHARS = 2_000_000;
/**
 * All copies together, in IndexedDB. Far under what the origin may use, and
 * the mirror holds them in memory too, so it is kept to a size a phone does
 * not notice.
 */
export const KEPT_DB_TOTAL_CHARS = 8_000_000;
/**
 * How long a screen with nothing on it waits for its read before it draws
 * the kept copy, the read still going (offline follow-up, 2 Nov 2026). On a
 * network that carries nothing a read neither answers nor fails until
 * ./read-timeout.ts gives up at 15 s, and a phone app that has the page on
 * the phone shows it. Longer than the service worker's second (#4243: a
 * conversation drawn from an older copy on a merely slow read, with the
 * newest messages snapping in under the reader a moment later), short
 * enough not to read as a hang.
 */
export const KEPT_DRAW_MS = 2000;

/** What the copies are kept in: localStorage, or the IndexedDB mirror shaped like it. */
interface KeptStore {
  readonly length: number;
  key(index: number): string | null;
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
}

function local(): Storage | null {
  try {
    return typeof localStorage === 'undefined' ? null : localStorage;
  } catch {
    return null;
  }
}

const DB_NAME = 'usernode-kept';
const DB_STORE = 'copies';

/**
 * The copies in IndexedDB, mirrored in memory (see the header). Reads and
 * writes are the mirror's, at once; the database follows, a write at a time
 * in the order they were made. Until it has loaded, a read falls through to
 * whatever an older build left in localStorage.
 */
class MirrorStore implements KeptStore {
  private readonly copies = new Map<string, string>();
  private order: string[] | null = null;
  loaded = false;
  private db: Promise<IDBDatabase | null>;
  private chain: Promise<unknown> = Promise.resolve();
  readonly ready: Promise<void>;

  constructor(private readonly idb: IDBFactory) {
    this.db = this.open();
    this.ready = this.load();
  }

  private open(): Promise<IDBDatabase | null> {
    return new Promise((resolve) => {
      try {
        const req = this.idb.open(DB_NAME, 1);
        req.onupgradeneeded = () => {
          try { req.result.createObjectStore(DB_STORE); } catch { /* already there */ }
        };
        req.onsuccess = () => resolve(req.result);
        req.onerror = () => resolve(null);
        req.onblocked = () => resolve(null);
      } catch {
        resolve(null);
      }
    });
  }

  private async load(): Promise<void> {
    const db = await this.db;
    const saved = new Map<string, string>();
    if (db) {
      await new Promise<void>((resolve) => {
        try {
          const tx = db.transaction(DB_STORE, 'readonly');
          const store = tx.objectStore(DB_STORE);
          const keys = store.getAllKeys();
          const values = store.getAll();
          tx.oncomplete = () => {
            const ks = keys.result || [];
            const vs = values.result || [];
            for (let i = 0; i < ks.length; i += 1) {
              if (typeof ks[i] === 'string' && typeof vs[i] === 'string') saved.set(ks[i] as string, vs[i] as string);
            }
            resolve();
          };
          tx.onerror = () => resolve();
          tx.onabort = () => resolve();
        } catch {
          resolve();
        }
      });
    }
    // Written while loading: newer than what the database had.
    for (const [key, value] of saved) if (!this.copies.has(key) && !this.removedWhileLoading.has(key)) this.copies.set(key, value);
    this.removedWhileLoading.clear();
    // An older build's copies, in localStorage: move them across, once.
    const ls = local();
    if (ls && db) {
      try {
        for (let i = ls.length - 1; i >= 0; i -= 1) {
          const key = ls.key(i);
          if (!key || !key.startsWith(PREFIX) || key === OWNER_KEY) continue;
          const value = ls.getItem(key);
          if (value != null && !this.copies.has(key)) this.setItem(key, value);
          ls.removeItem(key);
        }
      } catch { /* they stay where they are, and are read from there */ }
    }
    this.order = null;
    this.loaded = true;
    // Ask WebKit to spare them under storage pressure. A hint it may refuse.
    try { void navigator.storage?.persist?.(); } catch { /* best effort */ }
  }

  private readonly removedWhileLoading = new Set<string>();

  private write(run: (store: IDBObjectStore) => void): void {
    this.chain = this.chain.then(async () => {
      const db = await this.db;
      if (!db) return;
      await new Promise<void>((resolve) => {
        try {
          const tx = db.transaction(DB_STORE, 'readwrite');
          run(tx.objectStore(DB_STORE));
          tx.oncomplete = () => resolve();
          tx.onerror = () => resolve();
          tx.onabort = () => resolve();
        } catch {
          resolve();
        }
      });
    });
  }

  private keys(): string[] {
    if (!this.order) this.order = [...this.copies.keys()];
    return this.order;
  }

  get length(): number {
    return this.keys().length;
  }

  key(index: number): string | null {
    return this.keys()[index] ?? null;
  }

  getItem(key: string): string | null {
    const value = this.copies.get(key);
    if (value !== undefined) return value;
    if (this.loaded || this.removedWhileLoading.has(key)) return null;
    try { return local()?.getItem(key) ?? null; } catch { return null; }
  }

  setItem(key: string, value: string): void {
    if (!this.copies.has(key)) this.order = null;
    this.copies.set(key, value);
    this.removedWhileLoading.delete(key);
    this.write((store) => { store.put(value, key); });
  }

  removeItem(key: string): void {
    if (this.copies.delete(key)) this.order = null;
    if (!this.loaded) this.removedWhileLoading.add(key);
    this.write((store) => { store.delete(key); });
  }
}

let mirror: MirrorStore | null | undefined;

function storage(): KeptStore | null {
  if (mirror === undefined) {
    let idb: IDBFactory | null = null;
    try { idb = typeof indexedDB === 'undefined' ? null : indexedDB; } catch { idb = null; }
    mirror = idb ? new MirrorStore(idb) : null;
  }
  return mirror || local();
}

/** The budget of the store in use (see the header). */
function limits(store: KeptStore): { each: number; total: number } {
  return store instanceof MirrorStore
    ? { each: KEPT_DB_MAX_CHARS, total: KEPT_DB_TOTAL_CHARS }
    : { each: KEPT_MAX_CHARS, total: KEPT_TOTAL_CHARS };
}

/** Resolves once the copies this device has are readable (at once without IndexedDB). */
export function keptLoaded(): Promise<void> {
  const store = storage();
  return store instanceof MirrorStore ? store.ready : Promise.resolve();
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

function removeStarting(store: KeptStore, start: string): void {
  try {
    for (let i = store.length - 1; i >= 0; i -= 1) {
      const key = store.key(i);
      if (key && key.startsWith(start)) store.removeItem(key);
    }
  } catch {
    /* nothing kept, or nothing to remove it from */
  }
}

/**
 * The store and the partition to keep for, or null when nobody is signed in
 * to keep anything for. Whose the copies are is noted in localStorage either
 * way (one short value, read before the database has loaded).
 */
function forViewer(): { store: KeptStore; scope: string } | null {
  const store = storage();
  const owner = local() || store;
  const scope = typeof document === 'undefined' ? null : readApiCacheScope(document);
  if (!store || !owner || !scope) return null;
  try {
    if (owner.getItem(OWNER_KEY) !== scope) {
      removeStarting(store, PREFIX);
      if (owner !== store) removeStarting(owner, PREFIX);
      owner.setItem(OWNER_KEY, scope);
    }
  } catch {
    return null;
  }
  return { store, scope };
}

/** Every copy's size, keys and values, by key. */
function sizes(store: KeptStore): Map<string, number> {
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
function makeRoom(store: KeptStore, key: string, need: number): boolean {
  const budget = limits(store).total;
  const kept = sizes(store);
  kept.delete(key);
  // Whose the copies are is not a copy, and lives apart where there is a database.
  kept.delete(OWNER_KEY);
  let total = need;
  for (const size of kept.values()) total += size;
  if (total <= budget) return true;
  const recentSuffix = ':recent';
  for (const indexKey of [...kept.keys()].filter((item) => item.endsWith(recentSuffix))) {
    const family = indexKey.slice(0, -recentSuffix.length);
    let ids: string[] = [];
    try {
      const saved = JSON.parse(store.getItem(indexKey) || 'null');
      ids = Array.isArray(saved) ? saved.map(String) : [];
    } catch { /* an unreadable index evicts nothing */ }
    const current = key.startsWith(`${family}:`) ? key.slice(family.length + 1).split(':')[0] : null;
    for (let i = ids.length - 1; i >= 0 && total > budget; i -= 1) {
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
    if (total <= budget) return true;
  }
  return total <= budget;
}

/** Keep `data` as the copy called `name`, for the person signed in. */
export function keepCopy(name: string, data: unknown): void {
  const viewer = forViewer();
  if (!viewer || data == null) return;
  const key = keyOf(name);
  try {
    const entry = JSON.stringify({ scope: viewer.scope, at: Date.now(), data });
    // What the screen draws now is the server's answer.
    noteFresh(`kept:${name}`);
    // Too large to keep, or no room for it: the older copy goes too, so it
    // is not drawn as current.
    if (entry.length > limits(viewer.store).each || !makeRoom(viewer.store, key, key.length + entry.length)) {
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
      noteSaved(`kept:${name}`, entry.at);
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
  const ls = local();
  if (ls && ls !== store) removeStarting(ls, PREFIX);
}

if (typeof window !== 'undefined') {
  const host = window as unknown as { UsernodeReact?: Record<string, unknown> };
  const bridge = (host.UsernodeReact ||= {});
  // `keep` and `read` for the classic scripts (app-view.js keeps the session
  // a change number names, so a change opens offline).
  bridge.keptCopies = { clear: forgetKeptCopies, keep: keepCopy, read: keptCopy };
  // Load the mirror now, well before a read can fail.
  storage();
}
