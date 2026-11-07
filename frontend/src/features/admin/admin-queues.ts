/**
 * The admin console's queues (#6455, "Inbox"): every duty is a list you work
 * through one item at a time.
 *
 * Pure helpers, shared by the chassis (./admin-console.js, which paints the
 * sidebar's and the phone menu's counts) and the Overview section
 * (./admin-overview.tsx, which draws the queue view). Both read the ONE
 * /api/admin/overview payload; nothing here fetches or writes to the server.
 *
 * "Mark done for now" is this browser session's alone: the ids live in
 * sessionStorage, every access wrapped, so a private window or blocked
 * storage degrades to "nothing marked done" rather than a throw mid-render.
 */

export type QueueKey = 'all' | 'stuck' | 'orphans' | 'spenders';

export const QUEUES: ReadonlyArray<{ key: QueueKey; label: string }> = Object.freeze([
  { key: 'all', label: 'Needs you' },
  { key: 'stuck', label: 'Stuck apps' },
  { key: 'orphans', label: 'Orphan workers' },
  { key: 'spenders', label: 'Top spenders today' },
]);

export const QUEUE_KEYS: ReadonlyArray<QueueKey> = Object.freeze(QUEUES.map((q) => q.key));

/** How many of today's spenders the queue carries, most expensive first. */
export const SPENDER_LIMIT = 10;

export const DONE_KEY = 'admin_queue_done_v1';

export interface OverviewData {
  stuckApps?: Array<{ id?: number; name?: string; slug: string; dbStatus: string; createdBy?: string; createdAt: string }>;
  orphanWorkers?: Array<{ name: string; sessionId?: number | string; appSlug?: string; uptimeSeconds?: number; sessionArchived?: boolean }>;
  llmToday?: { totalSpendCents: number; users?: Array<{ username: string; costCents: number }> };
}

export type QueueItem =
  | { id: string; kind: 'stuck'; severity: 'broken'; slug: string; name?: string; dbStatus: string; createdBy?: string; createdAt: string }
  | { id: string; kind: 'orphan'; severity: 'broken'; name: string; appSlug?: string; uptimeSeconds: number; sessionArchived: boolean; sessionId?: number | string }
  | { id: string; kind: 'spender'; severity: 'info'; username: string; costCents: number };

/** The queue an address names: #admin/overview/<queue>, else Needs you. */
export function queueFromHash(hash: string | null | undefined): QueueKey {
  const m = /^#admin\/overview\/([a-z]+)/.exec(String(hash || ''));
  const key = m ? m[1] : '';
  return (QUEUE_KEYS as ReadonlyArray<string>).includes(key) ? (key as QueueKey) : 'all';
}

/** Every item the payload holds, per queue, before anything is marked done. */
export function buildItems(data: OverviewData | null | undefined): { stuck: QueueItem[]; orphans: QueueItem[]; spenders: QueueItem[] } {
  const stuck: QueueItem[] = (data?.stuckApps || []).map((a): QueueItem => ({
    id: `app:${a.slug}`, kind: 'stuck', severity: 'broken',
    slug: a.slug, name: a.name, dbStatus: a.dbStatus, createdBy: a.createdBy, createdAt: a.createdAt,
  }));
  const orphans: QueueItem[] = (data?.orphanWorkers || []).map((w): QueueItem => ({
    id: `worker:${w.name}`, kind: 'orphan', severity: 'broken',
    name: w.name, appSlug: w.appSlug, uptimeSeconds: Number(w.uptimeSeconds) || 0,
    sessionArchived: !!w.sessionArchived, sessionId: w.sessionId,
  }));
  const spenders: QueueItem[] = (data?.llmToday?.users || [])
    .filter((u) => u && Number(u.costCents) > 0)
    .slice()
    .sort((a, b) => Number(b.costCents) - Number(a.costCents))
    .slice(0, SPENDER_LIMIT)
    .map((u): QueueItem => ({ id: `spend:${u.username}`, kind: 'spender', severity: 'info', username: u.username, costCents: Number(u.costCents) }));
  return { stuck, orphans, spenders };
}

/** One queue's items, without the ones marked done. Needs you is broken first. */
export function queueItems(data: OverviewData | null | undefined, queue: QueueKey, done: Set<string>): QueueItem[] {
  const all = buildItems(data);
  const list = queue === 'stuck' ? all.stuck
    : queue === 'orphans' ? all.orphans
      : queue === 'spenders' ? all.spenders
        : [...all.stuck, ...all.orphans, ...all.spenders];
  return list.filter((item) => !done.has(item.id));
}

/** Each queue's count, or null while nothing has loaded. */
export function queueCounts(data: OverviewData | null | undefined, done: Set<string>): Record<QueueKey, number> | null {
  if (!data || typeof data !== 'object') return null;
  const out = {} as Record<QueueKey, number>;
  for (const key of QUEUE_KEYS) out[key] = queueItems(data, key, done).length;
  return out;
}

function storage(): Storage | null {
  try {
    return typeof window !== 'undefined' && window.sessionStorage ? window.sessionStorage : null;
  } catch {
    return null;
  }
}

export function loadDone(): Set<string> {
  try {
    const raw = storage()?.getItem(DONE_KEY);
    const arr = raw ? JSON.parse(raw) : [];
    return new Set(Array.isArray(arr) ? arr.map(String) : []);
  } catch {
    return new Set();
  }
}

export function saveDone(done: Set<string>): void {
  try {
    storage()?.setItem(DONE_KEY, JSON.stringify([...done]));
  } catch { /* storage unavailable: the mark lasts until the view goes */ }
}

/** The index to select after the item at `index` leaves a list of `length` (now one shorter). */
export function nextIndex(index: number, length: number): number {
  if (length <= 0) return -1;
  return Math.min(Math.max(index, 0), length - 1);
}

/** Dollars from cents, two places. */
export function dollars(cents: number): string {
  return `$${(Number(cents || 0) / 100).toFixed(2)}`;
}
