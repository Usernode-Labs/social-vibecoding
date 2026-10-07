// The transition pipeline: the only writer of machine state. One event per
// transaction, under its instance's row lock; concurrent across instances.
//
// Round trips are what a waiting producer pays for, so the common path is
// kept to a fixed few: one batch opens the transaction, one statement picks
// and locks the event and its instance (with the receipt and the clock),
// the machine's own queries run, and one statement records the outcome
// before COMMIT. Failures take a slower path in a transaction of their own.

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
// How many picked events a slot may pass over (taken by a newer version or
// faulted between the pick and the lock) before it reports nothing ready.
const MAX_PASSES = 16;

const millis = (v: number) => {
  const n = Math.floor(Number(v));
  if (!Number.isFinite(n) || n < 0) throw new Error(`workflow: invalid timeout ${v}`);
  return `'${n}ms'`;
};

// A pipeline transaction opens with the writer marker and the timeouts, in
// one simple-protocol batch.
const opening = (opts: Pick<PipelineOptions, 'lockTimeoutMs' | 'statementTimeoutMs'>) =>
  `BEGIN; SET LOCAL app.wf_writer = 'transition'; SET LOCAL lock_timeout = ${millis(opts.lockTimeoutMs)};`
  + ` SET LOCAL statement_timeout = ${millis(opts.statementTimeoutMs)}`;

export async function enterPipeline(client: PoolClient, opts: Pick<PipelineOptions, 'lockTimeoutMs' | 'statementTimeoutMs'>): Promise<void> {
  await client.query(opening(opts));
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

// The picked event row, with its instance (null when it does not exist yet),
// the stored receipt for its request key, and the transaction's clock.
interface Picked {
  id: string; machine: string; key: string; app_id: number | null; type: string; payload: any; source: any;
  actor: string | null; request_key: string; caused_by: string | null; attempts: number;
  now: Date;
  instance: Instance | null;
  receipt: { payload_hash: string; outcome: any; event_id: number } | null;
}
interface Instance { state: string; data: unknown; version: number; machine_version: number; app_id: number | null; flag: string | null }

// The oldest pending event of any instance, locked with SKIP LOCKED so a
// slot never waits for another slot's event. Only an instance's head event
// is ever picked, so holding it is holding the instance's turn; the instance
// row is then locked too (it may be held for a moment by the timer loop or a
// release, never by another slot). Both locks are rechecked against the
// latest row versions, so an event processed meanwhile is not picked again.
//
// It travels in the batch that opens the transaction, so its arguments are
// literals: machine names are kebab-case (defineMachine checks), versions
// and event ids are integers.
function pickSql(names: string[], versions: number[], passed: number[]): string {
  const machines = `ARRAY[${names.map((n) => `'${n}'`).join(',')}]::text[]`;
  const ints = (xs: number[]) => xs.map((x) => { if (!Number.isSafeInteger(x)) throw new Error(`workflow: not an integer ${x}`); return String(x); });
  return `
  WITH pick AS (
    SELECT e.*
      FROM (SELECT DISTINCT ON (machine, key) id FROM wf_events
             WHERE status = 'pending' AND machine = ANY(${machines})
             ORDER BY machine, key, id) h
      JOIN wf_events e ON e.id = h.id
      JOIN unnest(${machines}, ARRAY[${ints(versions).join(',')}]::int[]) AS m(machine, version) ON m.machine = e.machine
      LEFT JOIN wf_instances i ON i.machine = e.machine AND i.key = e.key
     WHERE e.status = 'pending'
       AND (e.retry_at IS NULL OR e.retry_at <= now())
       AND i.flag IS DISTINCT FROM 'faulted'
       AND (i.machine_version IS NULL OR i.machine_version <= m.version)
       AND NOT (e.id = ANY(ARRAY[${ints(passed).join(',')}]::bigint[]))
     ORDER BY e.id
     LIMIT 1
     FOR UPDATE OF e SKIP LOCKED)
  SELECT p.id, p.machine, p.key, p.app_id, p.type, p.payload, p.source, p.actor, p.request_key,
         p.caused_by, p.attempts, now() AS now,
         CASE WHEN i.machine IS NULL THEN NULL ELSE json_build_object(
           'state', i.state, 'data', i.data, 'version', i.version, 'machine_version', i.machine_version,
           'app_id', i.app_id, 'flag', i.flag) END AS instance,
         CASE WHEN r.request_key IS NULL THEN NULL ELSE json_build_object(
           'payload_hash', r.payload_hash, 'outcome', r.outcome, 'event_id', r.event_id) END AS receipt
    FROM pick p
    LEFT JOIN LATERAL (SELECT * FROM wf_instances
                        WHERE machine = p.machine AND key = p.key FOR UPDATE) i ON TRUE
    LEFT JOIN wf_receipts r ON r.machine = p.machine AND r.key = p.key AND r.request_key = p.request_key;
  SELECT (EXTRACT(EPOCH FROM min(retry_at) - now()) * 1000)::float8 AS ms
    FROM wf_events WHERE status = 'pending' AND retry_at > now() AND machine = ANY(${machines})`;
}

type Step = { kind: 'done'; id: number } | { kind: 'none'; retryInMs: number | null } | { kind: 'pass'; id: number };

// Process at most one event. Returns its id, or null when nothing was ready;
// then `idle.retryInMs` says when an event in backoff is next due (or null).
export async function processNext(opts: PipelineOptions, idle: { retryInMs: number | null } = { retryInMs: null }): Promise<number | null> {
  if (!opts.machines.size) return null;
  const names = [...opts.machines.keys()];
  const versions = names.map((n) => opts.machines.get(n)!.version);
  const passed: number[] = [];
  for (let i = 0; i < MAX_PASSES; i++) {
    const step = await processOne(opts, names, versions, passed);
    if (step.kind === 'done') return step.id;
    if (step.kind === 'none') { idle.retryInMs = step.retryInMs; return null; }
    passed.push(step.id);
  }
  return null;
}

async function processOne(opts: PipelineOptions, names: string[], versions: number[], passed: number[]): Promise<Step> {
  const client = await opts.pool.connect();
  let broken: Error | undefined;
  let picked: Picked | undefined;
  try {
    // One round trip: open the transaction, pick, and when nothing is
    // ready, when the next event in backoff is due.
    let row: Picked | undefined;
    let retryInMs: number | null = null;
    try {
      const results = await client.query(`${opening(opts)}; ${pickSql(names, versions, passed)}`) as unknown as { rows: any[] }[];
      row = results[results.length - 2]!.rows[0];
      const ms = results[results.length - 1]!.rows[0]?.ms;
      retryInMs = ms == null ? null : Number(ms);
    } catch (err) {
      if (!RETRYABLE.has((err as { code?: string }).code || '')) throw err;
      row = undefined;  // the instance row stayed locked past the lock timeout
    }
    const machine = row && opts.machines.get(row.machine)!;
    if (!row || !machine) {
      await client.query('ROLLBACK');
      return { kind: 'none', retryInMs };
    }
    picked = row;
    const instance = row.instance;
    // Faulted or written by a newer version between the pick and the lock.
    if (instance && (instance.flag === 'faulted' || instance.machine_version > machine.version)) {
      await client.query('ROLLBACK');
      return { kind: 'pass', id: Number(row.id) };
    }
    let notifications: Notification[];
    try {
      notifications = await applyEvent(client, machine, row);
      await client.query('COMMIT');
    } catch (err) {
      // Nothing of the event's transaction survives, the machine's writes
      // included; the failure is recorded in a transaction of its own.
      await client.query('ROLLBACK').catch(() => {});
      notifications = [];
      await recordFailure(client, opts, machine, row, err);
    }
    for (const n of notifications) {
      Promise.resolve()
        .then(() => machine.notifiers.get(n.type)!(n))
        .catch((err) => opts.log.warn('workflow', 'notification failed', { machine: row!.machine, type: n.type, message: err?.message }));
    }
    return { kind: 'done', id: Number(row.id) };
  } catch (err) {
    broken = err as Error;
    await client.query('ROLLBACK').catch(() => {});
    opts.log.error('workflow', 'pipeline transaction failed', { machine: picked?.machine, key: picked?.key, message: broken.message });
    return { kind: 'none', retryInMs: null };
  } finally {
    // A database error leaves the connection usable; anything else may not.
    client.release(broken && !(broken as { code?: string }).code ? broken : undefined);
  }
}

// Builds one statement from data-modifying CTEs, numbering parameters as
// they are added.
class Statement {
  values: unknown[] = [];
  parts: string[] = [];
  p(v: unknown): string { this.values.push(v); return `$${this.values.length}`; }
  with(name: string, sql: string): this { this.parts.push(`${name} AS (${sql})`); return this; }
  text(main: string): string { return `${this.parts.length ? `WITH ${this.parts.join(',\n')}\n` : ''}${main}`; }
}

interface Fields {
  result: 'accepted' | 'rejected' | 'replayed'; reason?: string | null; version: number; stateBefore: string;
  stateAfter: string; versionAfter: number | null; emitted?: Json; reply?: Json | null;
}

// The event's own result and the outcome notification; `s` may already hold
// the instance's and receipt's CTEs, which commit with it.
async function finishEvent(client: PoolClient, s: Statement, eventId: number, f: Fields): Promise<void> {
  const id = s.p(eventId);
  s.with('finished', `UPDATE wf_events SET status = 'processed', result = ${s.p(f.result)}, reason = ${s.p(f.reason ?? null)},
            machine_version = ${s.p(f.version)}, state_before = ${s.p(f.stateBefore)}, state_after = ${s.p(f.stateAfter)},
            version_after = ${s.p(f.versionAfter)}, emitted = ${s.p(f.emitted === undefined ? null : JSON.stringify(f.emitted))},
            reply = ${s.p(f.reply == null ? null : JSON.stringify(f.reply))}, retry_at = NULL, processed_at = clock_timestamp()
      WHERE id = ${id} RETURNING id`);
  await client.query({ text: s.text(`SELECT pg_notify('wf_outcome', id::text) FROM finished`), values: s.values });
}

async function applyEvent(client: PoolClient, machine: Machine<any, any>, row: Picked): Promise<Notification[]> {
  const eventId = Number(row.id);
  const inst = row.instance;
  // A '(none)' row is left by a creating event that timed out or faulted.
  const isNew = !inst || inst.state === NONE;
  const state: State = deepFreeze(isNew ? { name: NONE, data: null } : machine.decode({ state: inst!.state, data: inst!.data }));
  const version = inst ? Number(inst.version) : 0;
  const ctx: TransitionContext = Object.freeze({
    machine: machine.name, key: row.key, appId: inst?.app_id ?? row.app_id ?? null, version, now: new Date(row.now),
  });
  const base = { version: machine.version, stateBefore: state.name, stateAfter: state.name, versionAfter: version };

  // Anything but an accepted event leaves no instance behind that was not
  // there, and clears a stall (the event got through).
  const unchanged = () => {
    const s = new Statement();
    if (inst && isNew && version === 0) {
      s.with('dropped', `DELETE FROM wf_instances WHERE machine = ${s.p(machine.name)} AND key = ${s.p(row.key)}`);
    } else if (inst?.flag === 'stalled') {
      s.with('unflagged', `UPDATE wf_instances SET flag = NULL, flag_detail = NULL
        WHERE machine = ${s.p(machine.name)} AND key = ${s.p(row.key)}`);
    }
    return s;
  };
  const rejectWith = async (reason: string) => {
    await finishEvent(client, unchanged(), eventId, { ...base, result: 'rejected', reason });
    return [];
  };

  // 1. Replay before anything else: no facts, flags, authority or guard.
  const hash = canonicalHash({ type: row.type, payload: row.payload, actor: row.actor });
  const receipt = row.receipt;
  if (receipt) {
    if (receipt.payload_hash !== hash) return rejectWith('request_key_conflict');
    await settleWork(client, machine, row.key, row);
    await finishEvent(client, unchanged(), eventId, {
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
    if (!await settleWork(client, machine, row.key, row)) return rejectWith('unknown_work');
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
  const timer = outcome.timer;
  if (timer) assertJson(timer.event.payload ?? {});

  // 4. Persist: the machine's writes, projection and reply (which may read
  // what the writes did), then work and messages, then the instance row,
  // receipt and the event's result in one statement. All in one transaction.
  const next = version + 1;
  const after = { ...ctx, version: next };
  for (const write of outcome.writes || []) {
    const handler = machine.writes.get(write.type);
    if (!handler) throw new Error(`${machine.name}: no write handler ${write.type}`);
    await handler(tx, write, after);
  }
  if (machine.project) await machine.project(tx, state, outcome.next, after);
  const reply = (machine.reply ? await machine.reply(tx, event, outcome.next, after, facts) : undefined) ?? null;
  if (tx.poisoned) throw tx.poisoned;
  assertJson(reply);
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
      [machine.name, row.key, w.kind, w.key, JSON.stringify(w.input), w.notBefore ?? null, eventId, w.continues ?? null]);
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
        JSON.stringify({ kind: 'message', from: { machine: machine.name, key: row.key, eventId } }),
        `msg:${eventId}:${i}`, eventId]);
    messages.push({ machine: m.to.machine, key: m.to.key, type: m.event.type, eventId: Number(sent.id) });
  }

  // The instance row is inserted by its creating event (no placeholder is
  // written first: holding the head event is holding the instance's turn).
  const s = new Statement();
  const setTimer = s.p(timer !== undefined);
  const at = s.p(timer ? timer.at : null);
  const nextVersion = s.p(next);
  s.with('instance', `
    INSERT INTO wf_instances AS i (machine, key, app_id, state, data, version, machine_version,
                                   deadline_at, deadline_event, deadline_version)
    VALUES (${s.p(machine.name)}, ${s.p(row.key)}, ${s.p(ctx.appId)}::int, ${s.p(outcome.next.name)}, ${s.p(JSON.stringify(data))}::jsonb,
            ${nextVersion}::bigint, ${s.p(machine.version)}::int, ${at}::timestamptz,
            ${s.p(timer ? JSON.stringify({ type: timer.event.type, payload: timer.event.payload ?? {} }) : null)}::jsonb,
            CASE WHEN ${at}::timestamptz IS NULL THEN NULL ELSE ${nextVersion}::bigint END)
    ON CONFLICT (machine, key) DO UPDATE
       SET state = EXCLUDED.state, data = EXCLUDED.data, version = EXCLUDED.version,
           machine_version = EXCLUDED.machine_version, app_id = COALESCE(i.app_id, EXCLUDED.app_id),
           deadline_at = CASE WHEN ${setTimer}::boolean THEN EXCLUDED.deadline_at ELSE i.deadline_at END,
           deadline_event = CASE WHEN ${setTimer}::boolean THEN EXCLUDED.deadline_event ELSE i.deadline_event END,
           deadline_version = CASE WHEN ${setTimer}::boolean THEN EXCLUDED.deadline_version ELSE i.deadline_version END,
           flag = NULL, flag_detail = NULL, updated_at = now()`);
  s.with('receipt', `INSERT INTO wf_receipts (machine, key, request_key, payload_hash, outcome, event_id)
    VALUES (${s.p(machine.name)}, ${s.p(row.key)}, ${s.p(row.request_key)}, ${s.p(hash)},
            ${s.p(JSON.stringify({ state: outcome.next.name, version: next, reply }))}, ${s.p(eventId)})`);
  await finishEvent(client, s, eventId, {
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
async function settleWork(client: PoolClient, machine: Machine<any, any>, key: string, row: Picked): Promise<boolean> {
  if (!WORK_EVENTS.has(row.type) || !UUID.test(String(row.payload?.workId))) return true;
  const { rowCount } = await client.query(
    `UPDATE wf_work SET status = 'settled', settled_at = COALESCE(settled_at, now())
      WHERE id = $1 AND machine = $2 AND key = $3 AND status IN ('reported', 'settled')`,
    [row.payload.workId, machine.name, key]);
  return Boolean(rowCount);
}

// Record a failed event in a fresh transaction. The event is locked again
// and must still be pending with the attempts this slot saw; otherwise
// another slot has dealt with it meanwhile and there is nothing to record.
async function recordFailure(client: PoolClient, opts: PipelineOptions, machine: Machine<any, any>, row: Picked, err: unknown): Promise<void> {
  const code = (err as { code?: string })?.code || null;
  const message = String((err as Error)?.message || err).slice(0, 2000);
  const eventId = Number(row.id);
  const where = { machine: row.machine, key: row.key, eventId };
  await enterPipeline(client, opts);
  try {
    const { rows: [current] } = await client.query(
      `SELECT e.attempts, i.state FROM wf_events e
         LEFT JOIN wf_instances i ON i.machine = e.machine AND i.key = e.key
        WHERE e.id = $1 AND e.status = 'pending' AND e.attempts = $2
          FOR UPDATE OF e`, [eventId, row.attempts]);
    if (!current) {
      await client.query('ROLLBACK');
      return;
    }
    // Flag the instance; an instance that does not exist yet gets a '(none)'
    // row to carry the flag, deleted again when an event gets through.
    const s = new Statement();
    const flagInstance = (flag: string, detail: object, onlyIfUnflagged: boolean) => s.with('flagged', `
      INSERT INTO wf_instances AS i (machine, key, app_id, state, machine_version, flag, flag_detail)
      VALUES (${s.p(row.machine)}, ${s.p(row.key)}, ${s.p(row.instance?.app_id ?? row.app_id)}::int, ${s.p(NONE)},
              ${s.p(machine.version)}::int, ${s.p(flag)}, ${s.p(JSON.stringify(detail))}::jsonb)
      ON CONFLICT (machine, key) DO UPDATE SET flag = EXCLUDED.flag, flag_detail = EXCLUDED.flag_detail
        ${onlyIfUnflagged ? 'WHERE i.flag IS NULL' : ''}`);
    if (code && RETRYABLE.has(code)) {
      const attempts = Number(row.attempts) + 1;
      const backoffMs = Math.min(30000, 500 * 2 ** (attempts - 1));
      if (attempts >= opts.stallAfter) flagInstance('stalled', { eventId, attempts, code }, true);
      s.with('retried', `UPDATE wf_events SET attempts = ${s.p(attempts)},
          retry_at = now() + make_interval(secs => ${s.p(backoffMs)}::float8 / 1000),
          error = ${s.p(JSON.stringify({ code, message, kind: 'timeout' }))} WHERE id = ${s.p(eventId)}`);
      await client.query({ text: s.text('SELECT 1'), values: s.values });
      await client.query('COMMIT');
      opts.log.warn('workflow', 'event timed out; retrying', { ...where, attempts, code });
      return;
    }
    // A transition that throws is a bug or a broken invariant: hold this
    // instance (and only this instance) until an admin releases it.
    const id = s.p(eventId);
    const stateBefore = s.p(current.state ?? NONE);
    flagInstance('faulted', { eventId, code, message }, false);
    s.with('faulted', `UPDATE wf_events SET status = 'processed', result = 'faulted', reason = 'transition_threw',
            error = ${s.p(JSON.stringify({ code, message, stack: String((err as Error)?.stack || '').slice(0, 4000) }))},
            state_before = ${stateBefore}, state_after = ${stateBefore}, processed_at = clock_timestamp()
      WHERE id = ${id}`);
    s.with('held', `UPDATE wf_events SET status = 'held'
      WHERE machine = ${s.p(row.machine)} AND key = ${s.p(row.key)} AND status = 'pending' AND id > ${id}`);
    await client.query({ text: s.text(`SELECT pg_notify('wf_outcome', ${id}::text)`), values: s.values });
    await client.query('COMMIT');
    opts.log.error('workflow', 'transition faulted; instance held', { ...where, message });
  } catch (failure) {
    await client.query('ROLLBACK').catch(() => {});
    throw failure;
  }
}
