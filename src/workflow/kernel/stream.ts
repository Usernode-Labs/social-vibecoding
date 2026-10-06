// The event stream: producers append; routes may wait for the outcome.

import { WorkflowInputError, assertJson } from './machine.ts';
import type { Machine } from './machine.ts';
import type { EventOutcome, Logger, Pool, PoolClient, Queryable, Source } from './types.ts';

export interface AppendOptions {
  requestKey: string;
  source: Source;
  actor?: string | null;
  causedBy?: number | null;
  appId?: number | null;
  db?: Queryable;          // append inside the caller's transaction
}

export async function append(
  db: Queryable,
  machine: Machine<any, any> | string,
  key: string,
  event: { type: string; payload?: unknown },
  opts: AppendOptions,
): Promise<number> {
  const name = typeof machine === 'string' ? machine : machine.name;
  const payload = event.payload === undefined ? {} : event.payload;
  if (typeof key !== 'string' || !key || key.length > 256) throw new WorkflowInputError('invalid_key', 'instance key is required');
  if (typeof opts.requestKey !== 'string' || !opts.requestKey || opts.requestKey.length > 512) {
    throw new WorkflowInputError('invalid_request_key', 'request key is required');
  }
  assertJson(payload);
  if (typeof machine !== 'string') {
    // Decode at the boundary so a producer hears about a bad payload now.
    const decoder = machine.decoders[event.type];
    if (!decoder) throw new WorkflowInputError('unknown_event', `${name} has no event ${event.type}`);
    try { decoder(payload); } catch (err) {
      throw new WorkflowInputError('invalid_payload', (err as Error).message);
    }
  }
  const { rows } = await (opts.db || db).query<{ id: string }>(
    `WITH ins AS (
       INSERT INTO wf_events (machine, key, app_id, type, payload, source, actor, request_key, caused_by)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9) RETURNING id)
     SELECT id, pg_notify('wf_events', $1) FROM ins`,
    [name, key, opts.appId ?? null, event.type, JSON.stringify(payload), JSON.stringify(opts.source),
      opts.actor ?? null, opts.requestKey, opts.causedBy ?? null],
  );
  return Number(rows[0]!.id);
}

export async function readOutcome(db: Queryable, eventId: number): Promise<EventOutcome | null> {
  const { rows } = await db.query(
    `SELECT id, status, result, reason, state_after, version_after, request_key
       FROM wf_events WHERE id = $1`, [eventId]);
  const row = rows[0];
  if (!row) return null;
  return {
    status: row.status === 'processed' ? row.result : 'pending',
    eventId: Number(row.id),
    requestKey: row.request_key,
    reason: row.reason,
    state: row.state_after,
    version: row.version_after == null ? null : Number(row.version_after),
  };
}

// One LISTEN connection per process wakes sleepers early. Everything also
// works without it: every wait is bounded and re-reads the database.
export class Signals {
  #pool: Pool;
  #log: Logger;
  #client: PoolClient | null = null;
  #sleepers = new Map<string, Set<() => void>>();
  #stopped = false;

  constructor(pool: Pool, log: Logger) { this.#pool = pool; this.#log = log; }

  async start(): Promise<void> {
    if (this.#client || this.#stopped) return;
    try {
      const client = await this.#pool.connect();
      client.on?.('notification', (msg) => this.wake(msg.channel, msg.payload));
      client.on?.('error', (err) => {
        this.#log.warn('workflow', 'signal connection lost', { message: err.message });
        this.#client = null;
        client.release(err);
        if (!this.#stopped) setTimeout(() => { this.start(); }, 1000).unref?.();
      });
      await client.query('LISTEN wf_events');
      await client.query('LISTEN wf_outcome');
      await client.query('LISTEN wf_work');
      this.#client = client;
    } catch (err) {
      this.#log.warn('workflow', 'signal connection unavailable; polling only', { message: (err as Error).message });
    }
  }

  async stop(): Promise<void> {
    this.#stopped = true;
    const client = this.#client;
    this.#client = null;
    for (const set of this.#sleepers.values()) for (const fn of set) fn();
    if (client) {
      await client.query('UNLISTEN *').catch(() => {});
      client.release();
    }
  }

  wake(channel: string, payload?: string): void {
    for (const name of [channel, `${channel}:${payload ?? ''}`]) {
      const set = this.#sleepers.get(name);
      if (set) for (const fn of set) fn();
    }
  }

  // Resolves on a notification on `channel` (or `channel:payload`), or after ms.
  sleep(channel: string, ms: number): Promise<void> {
    if (this.#stopped) return new Promise((resolve) => { setTimeout(resolve, ms); });
    return new Promise((resolve) => {
      let set = this.#sleepers.get(channel);
      if (!set) this.#sleepers.set(channel, set = new Set());
      const done = () => {
        clearTimeout(timer);
        set!.delete(done);
        if (!set!.size) this.#sleepers.delete(channel);
        resolve();
      };
      const timer = setTimeout(done, ms);
      set.add(done);
    });
  }
}

// Wait up to waitMs for the event's outcome; 'pending' means the caller
// answers 202 with the request key, and a retry with that key replays.
export async function waitForOutcome(
  db: Queryable, signals: Signals | null, eventId: number, waitMs: number,
): Promise<EventOutcome> {
  const deadline = Date.now() + waitMs;
  for (;;) {
    const outcome = await readOutcome(db, eventId);
    if (!outcome) throw new Error(`workflow event ${eventId} does not exist`);
    const left = deadline - Date.now();
    if (outcome.status !== 'pending' || left <= 0) return outcome;
    const nap = Math.min(left, 250);
    if (signals) await signals.sleep(`wf_outcome:${eventId}`, nap);
    else await new Promise((r) => setTimeout(r, nap));
  }
}
