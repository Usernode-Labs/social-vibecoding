// The transition pipeline: the only writer of machine state. One event per
// transaction, under its instance's row lock; concurrent across instances.

import { NONE, WORK_EVENTS, assertJson, canonicalHash, isIgnored, isRejection } from './machine.ts';
import type { Machine, WorkResultPayload } from './machine.ts';
import type {
  Event, Json, Logger, Notification, Outcome, Pool, PoolClient, State, TransitionContext, Tx,
} from './types.ts';

export interface PipelineOptions {
  pool: Pool;
  machines: Map<string, Machine<any, any>>;
  log: Logger;
  lockTimeoutMs: number;
  statementTimeoutMs: number;
  stallAfter: number;     // consecutive timeouts before the instance is flagged stalled
}

// Lock and statement timeouts, serialisation failures and deadlocks are
// waits, not bugs: the event goes back to pending with a backoff.
const RETRYABLE = new Set(['55P03', '57014', '40001', '40P01']);
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const TX_CONTROL = /^\s*(begin|commit|rollback|end|abort|start|savepoint|release|prepare|set\s+(session\s+)?(transaction|session|role|local\s+app\.wf_writer|app\.wf_writer)|reset|discard)\b/i;

export async function enterPipeline(client: PoolClient, opts: Pick<PipelineOptions, 'lockTimeoutMs' | 'statementTimeoutMs'>): Promise<void> {
  await client.query('BEGIN');
  await client.query(
    `SELECT set_config('app.wf_writer', 'transition', true) AS writer,
            set_config('lock_timeout', $1, true) AS lock_timeout,
            set_config('statement_timeout', $2, true) AS statement_timeout`,
    [`${opts.lockTimeoutMs}ms`, `${opts.statementTimeoutMs}ms`],
  );
}

// Machine code gets queries only: no transaction control, one statement per
// call, and the first failure poisons the handle so a swallowed error still
// fails the event.
function machineTx(client: PoolClient): Tx & { poisoned: unknown } {
  const tx = {
    poisoned: null as unknown,
    async query(text: string, values: unknown[] = []) {
      if (tx.poisoned) throw tx.poisoned;
      if (TX_CONTROL.test(text)) throw (tx.poisoned = new Error('workflow machines cannot control the transaction'));
      try {
        return await client.query({ text, values, queryMode: 'extended' });
      } catch (err) {
        tx.poisoned = err;
        throw err;
      }
    },
  };
  return tx;
}

function deepFreeze<T>(value: T): T {
  if (value && typeof value === 'object' && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const v of Object.values(value)) deepFreeze(v);
  }
  return value;
}

interface Candidate { id: string; machine: string; key: string; app_id: number | null }

// Process at most one event. Returns its id, or null when nothing was ready.
export async function processNext(opts: PipelineOptions): Promise<number | null> {
  const names = [...opts.machines.keys()];
  if (!names.length) return null;
  const versions = names.map((n) => opts.machines.get(n)!.version);
  const { rows: candidates } = await opts.pool.query<Candidate>(
    `WITH heads AS (
       SELECT DISTINCT ON (e.machine, e.key) e.id, e.machine, e.key, e.app_id, e.retry_at
         FROM wf_events e
        WHERE e.status = 'pending' AND e.machine = ANY($1::text[])
        ORDER BY e.machine, e.key, e.id)
     SELECT h.id, h.machine, h.key, h.app_id
       FROM heads h
       JOIN unnest($1::text[], $2::int[]) AS m(machine, version) ON m.machine = h.machine
       LEFT JOIN wf_instances i ON i.machine = h.machine AND i.key = h.key
      WHERE (h.retry_at IS NULL OR h.retry_at <= now())
        AND i.flag IS DISTINCT FROM 'faulted'
        AND (i.machine_version IS NULL OR i.machine_version <= m.version)
      ORDER BY h.id
      LIMIT 16`,
    [names, versions],
  );
  for (const candidate of candidates) {
    const id = await tryInstance(opts, candidate);
    if (id !== null) return id;
  }
  return null;
}

async function tryInstance(opts: PipelineOptions, c: Candidate): Promise<number | null> {
  const machine = opts.machines.get(c.machine)!;
  const client = await opts.pool.connect();
  let notifications: Notification[] = [];
  let broken: Error | undefined;
  try {
    await enterPipeline(client, opts);
    let instance;
    try {
      await client.query(
        `INSERT INTO wf_instances (machine, key, app_id, state, machine_version)
         SELECT $1, $2, $3, $4, $5
          WHERE NOT EXISTS (SELECT 1 FROM wf_instances WHERE machine = $1 AND key = $2)
         ON CONFLICT DO NOTHING`,
        [c.machine, c.key, c.app_id, NONE, machine.version]);
      ({ rows: [instance] } = await client.query(
        'SELECT * FROM wf_instances WHERE machine = $1 AND key = $2 FOR UPDATE SKIP LOCKED',
        [c.machine, c.key]));
    } catch (err) {
      if (!RETRYABLE.has((err as { code?: string }).code || '')) throw err;
      instance = undefined;  // another slot is creating it; try another instance
    }
    if (!instance || instance.flag === 'faulted' || instance.machine_version > machine.version) {
      await client.query('ROLLBACK');
      return null;
    }
    const { rows: [row] } = await client.query(
      `SELECT * FROM wf_events
        WHERE machine = $1 AND key = $2 AND status = 'pending'
        ORDER BY id LIMIT 1 FOR UPDATE`, [c.machine, c.key]);
    if (!row || (row.retry_at && new Date(row.retry_at) > new Date())) {
      await client.query('ROLLBACK');
      return null;
    }
    await client.query('SAVEPOINT wf_event');
    try {
      notifications = await applyEvent(client, machine, instance, row);
    } catch (err) {
      await client.query('ROLLBACK TO SAVEPOINT wf_event');
      notifications = [];
      await recordFailure(client, opts, instance, row, err);
    }
    await client.query('COMMIT');
    for (const n of notifications) {
      Promise.resolve()
        .then(() => machine.notifiers.get(n.type)!(n))
        .catch((err) => opts.log.warn('workflow', 'notification failed', { machine: c.machine, type: n.type, message: err?.message }));
    }
    return Number(row.id);
  } catch (err) {
    broken = err as Error;
    await client.query('ROLLBACK').catch(() => {});
    opts.log.error('workflow', 'pipeline transaction failed', { machine: c.machine, key: c.key, message: broken.message });
    return null;
  } finally {
    // A database error leaves the connection usable; anything else may not.
    client.release(broken && !(broken as { code?: string }).code ? broken : undefined);
  }
}

async function finishEvent(client: PoolClient, eventId: number, fields: {
  result: string; reason?: string | null; version: number; stateBefore: string; stateAfter: string;
  versionAfter: number | null; emitted?: Json; reply?: Json | null;
}): Promise<void> {
  await client.query(
    `UPDATE wf_events SET status = 'processed', result = $2, reason = $3, machine_version = $4,
            state_before = $5, state_after = $6, version_after = $7, emitted = $8, reply = $9,
            retry_at = NULL, processed_at = clock_timestamp()
      WHERE id = $1`,
    [eventId, fields.result, fields.reason ?? null, fields.version, fields.stateBefore, fields.stateAfter,
      fields.versionAfter, fields.emitted === undefined ? null : JSON.stringify(fields.emitted),
      fields.reply == null ? null : JSON.stringify(fields.reply)]);
  await client.query(`SELECT pg_notify('wf_outcome', $1)`, [String(eventId)]);
}

async function applyEvent(client: PoolClient, machine: Machine<any, any>, instance: any, row: any): Promise<Notification[]> {
  const eventId = Number(row.id);
  const { rows: [{ now }] } = await client.query('SELECT now() AS now');
  const isNew = instance.state === NONE;
  const state: State = deepFreeze(isNew ? { name: NONE, data: null } : machine.decode({ state: instance.state, data: instance.data }));
  const version = Number(instance.version);
  const ctx: TransitionContext = Object.freeze({
    machine: machine.name, key: instance.key, appId: instance.app_id ?? row.app_id ?? null, version, now,
  });
  const base = { version: machine.version, stateBefore: state.name, stateAfter: state.name, versionAfter: version };

  const dropPlaceholder = async () => {
    if (isNew && version === 0) {
      await client.query('DELETE FROM wf_instances WHERE machine = $1 AND key = $2', [machine.name, instance.key]);
    } else if (instance.flag === 'stalled') {
      await client.query(`UPDATE wf_instances SET flag = NULL, flag_detail = NULL WHERE machine = $1 AND key = $2`,
        [machine.name, instance.key]);
    }
  };
  const rejectWith = async (reason: string) => {
    await dropPlaceholder();
    await finishEvent(client, eventId, { ...base, result: 'rejected', reason });
    return [];
  };

  // 1. Replay before anything else: no facts, flags, authority or guard.
  const hash = canonicalHash({ type: row.type, payload: row.payload, actor: row.actor });
  const { rows: [receipt] } = await client.query(
    'SELECT payload_hash, outcome, event_id FROM wf_receipts WHERE machine = $1 AND key = $2 AND request_key = $3',
    [machine.name, instance.key, row.request_key]);
  if (receipt) {
    if (receipt.payload_hash !== hash) return rejectWith('request_key_conflict');
    await settleWork(client, machine, instance.key, row);
    await dropPlaceholder();
    await finishEvent(client, eventId, {
      ...base, result: 'replayed', stateAfter: receipt.outcome.state, versionAfter: receipt.outcome.version,
      emitted: { replayOf: Number(receipt.event_id) }, reply: receipt.outcome.reply ?? null,
    });
    return [];
  }

  // 2. Decode once, at the boundary.
  let payload: unknown;
  const decoder = machine.events.get(row.type);
  if (!decoder) return rejectWith('unknown_event');
  try { payload = decoder(row.payload); } catch { return rejectWith('invalid_payload'); }
  const event: Event = deepFreeze({
    id: eventId, type: row.type, payload, source: row.source, actor: row.actor,
    requestKey: row.request_key, appId: row.app_id, causedBy: row.caused_by == null ? null : Number(row.caused_by),
  });
  if (WORK_EVENTS.has(event.type)) {
    const work = event.payload as WorkResultPayload;
    if (!UUID.test(work.workId)) return rejectWith('unknown_work');
    if (!await settleWork(client, machine, instance.key, row)) return rejectWith('unknown_work');
  }

  // 3. Facts, authority, guard, transition: machine code, on a guarded handle.
  const tx = machineTx(client);
  const facts = deepFreeze(machine.facts ? await machine.facts(tx, state, event, ctx) : undefined);
  const authority = machine.check(event, facts, state);
  if (tx.poisoned) throw tx.poisoned;
  if (isRejection(authority)) return rejectWith(authority.reject);
  const entry = machine.entryFor(state.name, event.type);
  if (isIgnored(entry)) return rejectWith(entry.ignore);
  const guard = entry.guard ? entry.guard(state, event, facts, ctx) : true;
  if (isRejection(guard)) return rejectWith(guard.reject);
  const outcome: Outcome = entry.to(state, event, facts, ctx);
  if (!outcome?.next || !machine.states.has(outcome.next.name)) {
    throw new Error(`${machine.name}: transition ${state.name}.${event.type} produced undeclared state ${outcome?.next?.name}`);
  }
  for (const n of outcome.notify || []) {
    if (!machine.notifiers.has(n.type)) throw new Error(`${machine.name}: no notifier ${n.type}`);
  }
  const data = outcome.next.data ?? null;
  assertJson(data);

  // 4. Persist, in order.
  const next = version + 1;
  const timer = outcome.timer;
  if (timer) assertJson(timer.event.payload ?? {});
  await client.query(
    `UPDATE wf_instances
        SET state = $3, data = $4::jsonb, version = $5::bigint, machine_version = $6::int,
            app_id = COALESCE(app_id, $7::int),
            deadline_at = CASE WHEN $8::boolean THEN $9::timestamptz ELSE deadline_at END,
            deadline_event = CASE WHEN $8::boolean THEN $10::jsonb ELSE deadline_event END,
            deadline_version = CASE WHEN $8::boolean
              THEN (CASE WHEN $9::timestamptz IS NULL THEN NULL ELSE $5::bigint END)
              ELSE deadline_version END,
            flag = NULL, flag_detail = NULL, updated_at = now()
      WHERE machine = $1 AND key = $2`,
    [machine.name, instance.key, outcome.next.name, JSON.stringify(data), next, machine.version, ctx.appId,
      timer !== undefined, timer ? timer.at : null,
      timer ? JSON.stringify({ type: timer.event.type, payload: timer.event.payload ?? {} }) : null]);
  const after = { ...ctx, version: next };
  for (const write of outcome.writes || []) {
    const handler = machine.writes.get(write.type);
    if (!handler) throw new Error(`${machine.name}: no write handler ${write.type}`);
    await handler(tx, write, after);
  }
  if (machine.project) await machine.project(tx, state, outcome.next, after);
  const reply = (machine.reply ? await machine.reply(tx, event, outcome.next, after) : undefined) ?? null;
  if (tx.poisoned) throw tx.poisoned;
  assertJson(reply);
  await client.query(
    `INSERT INTO wf_receipts (machine, key, request_key, payload_hash, outcome, event_id)
     VALUES ($1, $2, $3, $4, $5, $6)`,
    [machine.name, instance.key, row.request_key, hash,
      JSON.stringify({ state: outcome.next.name, version: next, reply }), eventId]);
  const work = [];
  for (const w of outcome.work || []) {
    assertJson(w.input);
    const { rows: [created] } = await client.query(
      `WITH ins AS (
         INSERT INTO wf_work (machine, key, kind, work_key, input, due_at, caused_by, checkpoint)
         VALUES ($1, $2, $3, $4, $5, COALESCE($6::timestamptz, now()), $7,
                 (SELECT checkpoint FROM wf_work WHERE machine = $1 AND key = $2 AND kind = $3 AND work_key = $8))
         ON CONFLICT (machine, key, kind, work_key) DO NOTHING
         RETURNING id)
       SELECT id, pg_notify('wf_work', $3) FROM ins`,
      [machine.name, instance.key, w.kind, w.key, JSON.stringify(w.input), w.notBefore ?? null, eventId, w.continues ?? null]);
    work.push({ kind: w.kind, key: w.key, id: created?.id ?? null });
  }
  const messages = [];
  for (const [i, m] of (outcome.messages || []).entries()) {
    assertJson(m.event.payload);
    const { rows: [sent] } = await client.query(
      `WITH ins AS (
         INSERT INTO wf_events (machine, key, app_id, type, payload, source, actor, request_key, caused_by)
         VALUES ($1, $2, $3, $4, $5, $6, NULL, $7, $8) RETURNING id)
       SELECT id, pg_notify('wf_events', $1) FROM ins`,
      [m.to.machine, m.to.key, m.appId ?? ctx.appId, m.event.type, JSON.stringify(m.event.payload),
        JSON.stringify({ kind: 'message', from: { machine: machine.name, key: instance.key, eventId } }),
        `msg:${eventId}:${i}`, eventId]);
    messages.push({ machine: m.to.machine, key: m.to.key, type: m.event.type, eventId: Number(sent.id) });
  }
  await finishEvent(client, eventId, {
    ...base, result: 'accepted', stateAfter: outcome.next.name, versionAfter: next, reply,
    emitted: {
      writes: (outcome.writes || []).map((w) => w.type),
      work, messages,
      timer: timer === undefined ? undefined : timer && { at: timer.at.toISOString(), type: timer.event.type },
      notify: (outcome.notify || []).map((n) => n.type),
    } as Json,
  });
  return outcome.notify || [];
}

// The pipeline settles a work item when it applies that item's result,
// accepted or not. Returns false when the item is not this instance's.
async function settleWork(client: PoolClient, machine: Machine<any, any>, key: string, row: any): Promise<boolean> {
  if (!WORK_EVENTS.has(row.type) || !UUID.test(String(row.payload?.workId))) return true;
  const { rowCount } = await client.query(
    `UPDATE wf_work SET status = 'settled', settled_at = COALESCE(settled_at, now())
      WHERE id = $1 AND machine = $2 AND key = $3 AND status IN ('reported', 'settled')`,
    [row.payload.workId, machine.name, key]);
  return Boolean(rowCount);
}

async function recordFailure(client: PoolClient, opts: PipelineOptions, instance: any, row: any, err: unknown): Promise<void> {
  const e = err;
  const code = (e as { code?: string })?.code || null;
  const message = String((e as Error)?.message || e).slice(0, 2000);
  const where = [instance.machine, instance.key];
  if (code && RETRYABLE.has(code)) {
    const attempts = Number(row.attempts) + 1;
    const backoffMs = Math.min(30000, 500 * 2 ** (attempts - 1));
    await client.query(
      `UPDATE wf_events SET attempts = $2, retry_at = now() + make_interval(secs => $3::float8 / 1000),
              error = $4 WHERE id = $1`,
      [row.id, attempts, backoffMs, JSON.stringify({ code, message, kind: 'timeout' })]);
    if (attempts >= opts.stallAfter) {
      await client.query(
        `UPDATE wf_instances SET flag = 'stalled', flag_detail = $3
          WHERE machine = $1 AND key = $2 AND flag IS NULL`,
        [...where, JSON.stringify({ eventId: Number(row.id), attempts, code })]);
    } else if (instance.state === NONE && Number(instance.version) === 0 && !instance.flag) {
      await client.query('DELETE FROM wf_instances WHERE machine = $1 AND key = $2', where);
    }
    opts.log.warn('workflow', 'event timed out; retrying', { machine: instance.machine, key: instance.key, eventId: Number(row.id), attempts, code });
    return;
  }
  // A transition that throws is a bug or a broken invariant: hold this
  // instance (and only this instance) until an admin releases it.
  await client.query(
    `UPDATE wf_events SET status = 'processed', result = 'faulted', reason = 'transition_threw',
            error = $2, state_before = $3, state_after = $3, processed_at = clock_timestamp()
      WHERE id = $1`,
    [row.id, JSON.stringify({ code, message, stack: String((e as Error)?.stack || '').slice(0, 4000) }), instance.state]);
  await client.query(
    `UPDATE wf_events SET status = 'held' WHERE machine = $1 AND key = $2 AND status = 'pending' AND id > $3`,
    [...where, row.id]);
  await client.query(
    `UPDATE wf_instances SET flag = 'faulted', flag_detail = $3 WHERE machine = $1 AND key = $2`,
    [...where, JSON.stringify({ eventId: Number(row.id), code, message })]);
  await client.query(`SELECT pg_notify('wf_outcome', $1)`, [String(row.id)]);
  opts.log.error('workflow', 'transition faulted; instance held', { machine: instance.machine, key: instance.key, eventId: Number(row.id), message });
}
