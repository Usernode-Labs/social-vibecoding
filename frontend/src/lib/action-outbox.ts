/**
 * VOTES AND REACTIONS A PERSON MADE THAT NEVER REACHED THE SERVER, KEPT ON
 * THE DEVICE AND SENT WHEN THE CONNECTION IS BACK (offline follow-up,
 * 2 Nov 2026).
 *
 * Offline, or on a network that connects but passes nothing, a vote went
 * back with "Your vote did not go through" and a reaction with the
 * browser's own error text: the person had to remember to do it again
 * later. Messages already wait for the connection (../features/messages/
 * outbox.ts); this does the same for the two other things a person does in
 * one tap. The screen keeps showing what they did, and the record here is
 * sent once the shell says the network is back.
 *
 * ── What a record is ───────────────────────────────────────────────────
 *
 * One POST to a same-origin /api/ path, under a key naming what it is about
 * (`vote:<session>`, `reaction:<message>:<emoji>`). A newer record under the
 * same key replaces the older one: a Yes and then a No while offline sends
 * the No. Every record is safe to send twice, which is what lets a send whose
 * answer was lost be sent again: a vote on the same side at the same
 * revision is answered `unchanged` (src/routes/votes.js), and a reaction
 * record names the state it wants (`on`), not a toggle
 * (services/conversations.js toggleReaction).
 *
 * ── Who hears how it went ─────────────────────────────────────────────
 *
 * Each send that is answered fires ACTION_OUTBOX_EVENT on `window` with
 * `{ outcome: 'sent' | 'refused', record, status, data }`: AppView for votes
 * (public/js/app-view.js _actionSent), the messages store for reactions.
 * When a page starts with records still waiting (the app was closed before
 * the connection came back), each is announced once as `queued`, so a Vote
 * button can say its vote is on its way rather than ask for it again. A
 * refusal (a 4xx other than 401 and 429: the change moved on to a new
 * revision, the person left the project) drops the record; its owner says
 * so on screen. No answer, a 401 (a session being renewed), a 429 or a 5xx
 * keeps it, and stops the pass: records go in the order they were made.
 *
 * ── When it sends ──────────────────────────────────────────────────────
 *
 * When the connectivity probe says the network is back
 * (`usernode:offline-change`), on the browser's `online`, when the phone
 * changes network (`usernode:network-changed`), when the shell says who is
 * signed in (`sv:session` on document), and again on a slow loop while a
 * pass stopped with records left. Never while the shell is offline, before
 * the session is confirmed, or for another account: each record names the
 * account that made it, and only that account's are sent; the rest are
 * deleted the first time anyone else's are read. Everything goes on
 * sign-out (App._dropCachedSession calls `UsernodeReact.actionOutbox.clear`).
 *
 * Best effort, like the messages outbox: with no IndexedDB nothing is kept,
 * and a failed tap says so as it did before (`queue` resolves false).
 */

import { fetchWithin } from './read-timeout';

export type ActionKind = 'vote' | 'reaction';

export interface ActionRecord {
  /** What it is about; a newer record under the same key replaces it. */
  key: string;
  kind: ActionKind;
  /** The account that made it. */
  viewer: number;
  /** A same-origin /api/ path, POSTed with `body` as JSON. */
  url: string;
  body: Record<string, unknown>;
  savedAt: number;
}

export interface ActionOutcome {
  outcome: 'sent' | 'refused' | 'queued';
  record: ActionRecord;
  status: number;
  data: unknown;
}

/** Fired on `window` for every record the server answered. */
export const ACTION_OUTBOX_EVENT = 'usernode:action-outbox';
/** The most records kept for one account; the oldest go first. */
export const MAX_ACTIONS = 100;
/** A record not sent in a week is not sent. */
export const MAX_ACTION_AGE_MS = 7 * 24 * 60 * 60 * 1000;
/** How long one send may wait for its answer before it counts as none. */
export const ACTION_SEND_TIMEOUT_MS = 15_000;
/** While a pass stopped with records left, how often it is tried again. */
export const ACTION_RETRY_MS = 30_000;

const DB_NAME = 'homeroom-action-outbox';
const STORE = 'actions';
const KINDS: ReadonlyArray<ActionKind> = ['vote', 'reaction'];

function positiveInt(value: unknown): value is number {
  return Number.isSafeInteger(value) && Number(value) > 0;
}

/** Pure: a stored value as a record, or null when it is not one this version wrote. */
export function actionRecord(raw: unknown): ActionRecord | null {
  if (!raw || typeof raw !== 'object') return null;
  const value = raw as Partial<ActionRecord>;
  if (typeof value.key !== 'string' || !value.key) return null;
  if (!KINDS.includes(value.kind as ActionKind) || !value.key.startsWith(`${value.kind}:`)) return null;
  if (!positiveInt(value.viewer) || !Number.isFinite(value.savedAt)) return null;
  if (typeof value.url !== 'string' || !value.url.startsWith('/api/')) return null;
  if (!value.body || typeof value.body !== 'object' || Array.isArray(value.body)) return null;
  return {
    key: value.key,
    kind: value.kind as ActionKind,
    viewer: value.viewer,
    url: value.url,
    body: value.body,
    savedAt: Number(value.savedAt),
  };
}

/**
 * Pure: `viewer`'s records to send, oldest first, and the keys of every
 * other one, to delete: another account's, one older than a week, one that
 * is not a record, and the oldest past MAX_ACTIONS.
 */
export function sendable(stored: unknown[], viewer: number, now: number): { keep: ActionRecord[]; drop: string[] } {
  const keep: ActionRecord[] = [];
  const drop: string[] = [];
  for (const raw of stored) {
    const record = actionRecord(raw);
    if (!record) {
      const key = raw && typeof raw === 'object' ? (raw as { key?: unknown }).key : null;
      if (typeof key === 'string') drop.push(key);
      continue;
    }
    if (record.viewer !== viewer || now - record.savedAt > MAX_ACTION_AGE_MS) { drop.push(record.key); continue; }
    keep.push(record);
  }
  keep.sort((a, b) => a.savedAt - b.savedAt);
  while (keep.length > MAX_ACTIONS) drop.push((keep.shift() as ActionRecord).key);
  return { keep, drop };
}

/** Pure: whether an answer with this status is the server's no (dropped) rather than no answer (kept). */
export function refusal(status: number): boolean {
  return status >= 400 && status < 500 && status !== 401 && status !== 408 && status !== 429;
}

interface Store {
  load(viewer: number): Promise<ActionRecord[]>;
  save(record: ActionRecord): Promise<boolean>;
  drop(key: string): void;
  clear(): void;
}

/** The records over an IndexedDB factory, writes in the order asked (as ../features/messages/outbox.ts). */
function createStore(idb: IDBFactory | null | undefined): Store {
  let opening: Promise<IDBDatabase | null> | null = null;
  function open(): Promise<IDBDatabase | null> {
    if (!idb) return Promise.resolve(null);
    if (!opening) {
      opening = new Promise((resolve) => {
        let request: IDBOpenDBRequest;
        try { request = idb.open(DB_NAME, 1); } catch { resolve(null); return; }
        request.onupgradeneeded = () => {
          if (!request.result.objectStoreNames.contains(STORE)) request.result.createObjectStore(STORE, { keyPath: 'key' });
        };
        request.onsuccess = () => {
          const db = request.result;
          db.onversionchange = () => { db.close(); opening = null; };
          resolve(db);
        };
        request.onerror = () => { opening = null; resolve(null); };
        request.onblocked = () => { opening = null; resolve(null); };
      });
    }
    return opening;
  }
  function write(apply: (store: IDBObjectStore) => void): Promise<boolean> {
    return open().then((db) => {
      if (!db) return false;
      return new Promise<boolean>((resolve) => {
        try {
          const tx = db.transaction(STORE, 'readwrite');
          tx.oncomplete = () => resolve(true);
          tx.onerror = () => resolve(false);
          tx.onabort = () => resolve(false);
          apply(tx.objectStore(STORE));
        } catch { resolve(false); }
      });
    });
  }
  return {
    async load(viewer) {
      const db = await open();
      if (!db) return [];
      const stored = await new Promise<unknown[]>((resolve) => {
        try {
          const request = db.transaction(STORE, 'readonly').objectStore(STORE).getAll();
          request.onsuccess = () => resolve(Array.isArray(request.result) ? request.result : []);
          request.onerror = () => resolve([]);
        } catch { resolve([]); }
      });
      const { keep, drop } = sendable(stored, viewer, Date.now());
      if (drop.length) void write((store) => { for (const key of drop) store.delete(key); });
      return keep;
    },
    save(record) { return write((store) => { store.put(record); }); },
    drop(key) { void write((store) => { store.delete(key); }); },
    clear() { void write((store) => { store.clear(); }); },
  };
}

interface Win {
  fetch: typeof fetch;
  addEventListener(type: string, fn: (event: Event) => void): void;
  dispatchEvent(event: Event): boolean;
  setTimeout: typeof setTimeout;
  clearTimeout: typeof clearTimeout;
  App?: { user?: { id?: unknown } | null; _sessionFromSnapshot?: boolean };
  Offline?: { isOffline(): boolean };
  UsernodeReact?: Record<string, unknown>;
}

export interface ActionOutbox {
  /**
   * Keep `record` (its viewer and time filled in) to send when the
   * connection is back. Resolves true once it is on disk; false when it
   * could not be kept (nobody signed in, no storage), and the caller says
   * the action was not sent, as before.
   */
  queue(record: Pick<ActionRecord, 'key' | 'kind' | 'url' | 'body'>): Promise<boolean>;
  /** Forget a record: the same action reached the server another way. */
  drop(key: string): void;
  /** Send what is kept, if the shell is online with a confirmed session. */
  flush(): Promise<void>;
  /**
   * Announce the signed-in viewer's waiting records as `queued`, once per
   * page: what a page that starts with records still kept is told.
   */
  announceKept(): Promise<void>;
  /** Every record, whoever made it (sign-out). */
  clear(): void;
}

function viewerOf(win: Win): number | null {
  const id = Number(win.App?.user?.id);
  return positiveInt(id) ? id : null;
}

/** The outbox over a window and an IndexedDB factory. Exported for tests. */
export function createActionOutbox(win: Win, idb: IDBFactory | null | undefined, sendMs = ACTION_SEND_TIMEOUT_MS): ActionOutbox {
  const store = createStore(idb);
  let running: Promise<void> | null = null;
  let again = false;
  let announcedFor: number | null = null;
  let retry: ReturnType<typeof setTimeout> | null = null;

  function ready(): number | null {
    const viewer = viewerOf(win);
    if (!viewer || win.App?._sessionFromSnapshot) return null;
    try { if (win.Offline && win.Offline.isOffline()) return null; } catch { /* no probe: try */ }
    return viewer;
  }

  function announce(detail: ActionOutcome): void {
    try { win.dispatchEvent(new CustomEvent(ACTION_OUTBOX_EVENT, { detail })); } catch { /* nobody to tell */ }
  }

  // One record: true to go on to the next, false to stop the pass (no answer).
  async function send(record: ActionRecord): Promise<boolean> {
    let res: Response;
    try {
      res = await fetchWithin(win.fetch, record.url, {
        method: 'POST',
        credentials: 'same-origin',
        headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
        body: JSON.stringify(record.body),
      }, sendMs);
    } catch {
      return false;
    }
    let data: unknown = null;
    try { data = await res.json(); } catch { data = null; }
    if (res.ok) {
      store.drop(record.key);
      announce({ outcome: 'sent', record, status: res.status, data });
      return true;
    }
    if (!refusal(res.status)) return false;
    store.drop(record.key);
    announce({ outcome: 'refused', record, status: res.status, data });
    return true;
  }

  async function pass(): Promise<void> {
    const viewer = ready();
    if (!viewer) return;
    const records = await store.load(viewer);
    for (const record of records) {
      if (ready() !== viewer) return;
      if (!(await send(record))) {
        if (!retry) retry = win.setTimeout(() => { retry = null; void flush(); }, ACTION_RETRY_MS);
        return;
      }
    }
  }

  function flush(): Promise<void> {
    if (running) { again = true; return running; }
    running = pass().catch(() => {}).finally(() => {
      running = null;
      if (again) { again = false; void flush(); }
    });
    return running;
  }

  return {
    async queue(partial) {
      const viewer = viewerOf(win);
      if (!viewer) return false;
      const record = actionRecord({ ...partial, viewer, savedAt: Date.now() });
      if (!record) return false;
      return store.save(record);
    },
    drop(key) { store.drop(key); },
    flush,
    async announceKept() {
      const viewer = viewerOf(win);
      if (!viewer || announcedFor === viewer) return;
      announcedFor = viewer;
      for (const record of await store.load(viewer)) {
        announce({ outcome: 'queued', record, status: 0, data: null });
      }
    },
    clear() {
      if (retry) { win.clearTimeout(retry); retry = null; }
      store.clear();
    },
  };
}

let shared: ActionOutbox | null = null;

/** This document's outbox, opened on first use. */
export function actionOutbox(): ActionOutbox {
  if (!shared) {
    shared = createActionOutbox(window as unknown as Win, typeof indexedDB !== 'undefined' ? indexedDB : null);
  }
  return shared;
}

let installed = false;

/**
 * Send on the triggers in the header, and publish the bridge the classic
 * scripts use (`window.UsernodeReact.actionOutbox`). Idempotent.
 */
export function installActionOutbox(): void {
  if (installed || typeof window === 'undefined') return;
  installed = true;
  const outbox = actionOutbox();
  const flush = () => { void outbox.flush(); };
  window.addEventListener('online', flush);
  window.addEventListener('usernode:network-changed', flush);
  window.addEventListener('usernode:offline-change', (event) => {
    if ((event as CustomEvent<{ offline?: boolean }>).detail?.offline === false) flush();
  });
  // Who is signed in is known: say what is still waiting, then try to send it.
  if (typeof document !== 'undefined') {
    document.addEventListener('sv:session', () => { void outbox.announceKept().then(flush, flush); });
  }
  const bridge = ((window as unknown as Win).UsernodeReact ||= {});
  bridge.actionOutbox = outbox;
}
