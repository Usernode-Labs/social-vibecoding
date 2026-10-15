// Read APIs for the admin view, and the one admin operation that is not an
// event: releasing a faulted instance's held events.

import { randomUUID } from 'node:crypto';
import { checkout, enterPipeline } from './pipeline.ts';
import type { Pool, Queryable } from './types.ts';

const num = (v: unknown) => (v == null ? null : Number(v));

function instanceRow(r: any) {
  return {
    machine: r.machine, key: r.key, appId: r.app_id, state: r.state, data: r.data,
    version: Number(r.version), machineVersion: r.machine_version,
    deadlineAt: r.deadline_at, deadlineEvent: r.deadline_event,
    flag: r.flag, flagDetail: r.flag_detail, createdAt: r.created_at, updatedAt: r.updated_at,
  };
}

function eventRow(r: any) {
  return {
    id: Number(r.id), machine: r.machine, key: r.key, appId: r.app_id, type: r.type, payload: r.payload,
    source: r.source, actor: r.actor, requestKey: r.request_key, causedBy: num(r.caused_by),
    status: r.status, attempts: r.attempts, retryAt: r.retry_at, result: r.result, reason: r.reason,
    error: r.error, machineVersion: r.machine_version, stateBefore: r.state_before,
    stateAfter: r.state_after, versionAfter: num(r.version_after), emitted: r.emitted,
    createdAt: r.created_at, processedAt: r.processed_at,
    cause: r.caused_by == null ? null : { machine: r.cause_machine, key: r.cause_key, type: r.cause_type },
  };
}

export interface ProblemOptions { overdueMs?: number; longRunningMs?: number; limit?: number }

// Everything that needs a person: faulted or stalled instances, held events,
// deadlines that did not fire, exhausted or long-running work, and
// ownership violations recorded in log mode: counted per column, and the
// latest rows (which row, which application wrote it, when).
export async function problems(db: Queryable, opts: ProblemOptions = {}) {
  const limit = opts.limit ?? 100;
  const [flagged, overdue, work, violations, latest] = await Promise.all([
    db.query(
      `SELECT i.*, (SELECT count(*) FROM wf_events e
                     WHERE e.machine = i.machine AND e.key = i.key AND e.status = 'held') AS held
         FROM wf_instances i WHERE i.flag IS NOT NULL ORDER BY i.updated_at DESC LIMIT $1`, [limit]),
    db.query(
      `SELECT * FROM wf_instances
        WHERE deadline_at < now() - make_interval(secs => $1::float8 / 1000)
        ORDER BY deadline_at LIMIT $2`, [opts.overdueMs ?? 60000, limit]),
    db.query(
      `SELECT w.id, w.machine, w.key, w.kind, w.work_key, w.status, w.attempt_count,
              w.last_error, w.result, w.created_at, a.started_at, a.service_id
         FROM wf_work w
         LEFT JOIN wf_work_attempts a ON a.id = w.claim_id
        WHERE (w.status IN ('reported', 'settled') AND w.result->>'outcome' = 'exhausted'
               AND w.created_at > now() - interval '30 days')
           OR (w.status = 'running' AND a.started_at < now() - make_interval(secs => $1::float8 / 1000))
        ORDER BY w.created_at DESC LIMIT $2`, [opts.longRunningMs ?? 15 * 60000, limit]),
    db.query(
      `SELECT table_name, column_path, count(*)::int AS count, max(created_at) AS last_at
         FROM wf_ownership_violations GROUP BY table_name, column_path ORDER BY last_at DESC LIMIT $1`, [limit]),
    db.query(
      `SELECT id, table_name, column_path, row_ref, application, left(query, 300) AS query, created_at
         FROM wf_ownership_violations ORDER BY created_at DESC, id DESC LIMIT $1`, [Math.min(limit, 20)]),
  ]);
  return {
    flagged: flagged.rows.map((r) => ({ ...instanceRow(r), heldEvents: Number(r.held) })),
    overdueDeadlines: overdue.rows.map(instanceRow),
    work: work.rows.map((r) => ({
      id: r.id, machine: r.machine, key: r.key, kind: r.kind, workKey: r.work_key,
      status: r.status, attempts: r.attempt_count, lastError: r.last_error, result: r.result,
      createdAt: r.created_at, startedAt: r.started_at, serviceId: r.service_id,
    })),
    ownershipViolations: violations.rows,
    ownershipViolationRows: latest.rows.map((r) => ({
      id: Number(r.id), table: r.table_name, column: r.column_path, row: r.row_ref,
      application: r.application, query: r.query, createdAt: r.created_at,
    })),
  };
}

export async function stateCounts(db: Queryable, machine?: string) {
  const { rows } = await db.query(
    `SELECT machine, state, count(*)::int AS count FROM wf_instances
      WHERE ($1::text IS NULL OR machine = $1) GROUP BY machine, state ORDER BY machine, state`,
    [machine ?? null]);
  return rows;
}

export async function listInstances(db: Queryable, f: {
  machine?: string; appId?: number; state?: string; flag?: string; limit?: number; before?: string;
} = {}) {
  const { rows } = await db.query(
    `SELECT * FROM wf_instances
      WHERE ($1::text IS NULL OR machine = $1) AND ($2::int IS NULL OR app_id = $2)
        AND ($3::text IS NULL OR state = $3) AND ($4::text IS NULL OR flag = $4)
        AND ($5::timestamptz IS NULL OR updated_at < $5)
      ORDER BY updated_at DESC LIMIT $6`,
    [f.machine ?? null, f.appId ?? null, f.state ?? null, f.flag ?? null, f.before ?? null, Math.min(f.limit ?? 50, 500)]);
  return rows.map(instanceRow);
}

// One instance: its row, its timeline (newest first) and its work. Each
// event names its cause's instance; what an event caused is in `emitted`.
export async function instance(db: Queryable, machine: string, key: string, opts: { limit?: number; beforeId?: number } = {}) {
  const [inst, events, work] = await Promise.all([
    db.query('SELECT * FROM wf_instances WHERE machine = $1 AND key = $2', [machine, key]),
    db.query(
      `SELECT e.*, c.machine AS cause_machine, c.key AS cause_key, c.type AS cause_type
         FROM wf_events e LEFT JOIN wf_events c ON c.id = e.caused_by
        WHERE e.machine = $1 AND e.key = $2 AND ($3::bigint IS NULL OR e.id < $3)
        ORDER BY e.id DESC LIMIT $4`, [machine, key, opts.beforeId ?? null, Math.min(opts.limit ?? 100, 500)]),
    db.query(
      `SELECT w.*, COALESCE(json_agg(a ORDER BY a.number) FILTER (WHERE a.id IS NOT NULL), '[]') AS attempts
         FROM wf_work w LEFT JOIN wf_work_attempts a ON a.work_id = w.id
        WHERE w.machine = $1 AND w.key = $2 GROUP BY w.id ORDER BY w.created_at DESC LIMIT 200`, [machine, key]),
  ]);
  return {
    instance: inst.rows[0] ? instanceRow(inst.rows[0]) : null,
    events: events.rows.map(eventRow),
    work: work.rows.map((r) => ({
      id: r.id, kind: r.kind, workKey: r.work_key, input: r.input, checkpoint: r.checkpoint, status: r.status,
      attempts: r.attempts, attemptCount: r.attempt_count, leaseUntil: r.lease_until, dueAt: r.due_at,
      lastError: r.last_error, result: r.result, causedBy: num(r.caused_by), createdAt: r.created_at,
      settledAt: r.settled_at,
    })),
  };
}

// Release a faulted instance. 'retry' puts the faulted event back at the
// head of its stream; 'skip' leaves it faulted and resumes with the next.
// Either way the held events become pending, and the release itself is
// recorded on the timeline.
export async function release(pool: Pool, machine: string, key: string, opts: {
  mode: 'retry' | 'skip'; actor: string; lockTimeoutMs?: number; statementTimeoutMs?: number;
}) {
  const client = await checkout(pool);
  try {
    await enterPipeline(client, { lockTimeoutMs: opts.lockTimeoutMs ?? 2000, statementTimeoutMs: opts.statementTimeoutMs ?? 5000 });
    const { rows: [inst] } = await client.query(
      'SELECT * FROM wf_instances WHERE machine = $1 AND key = $2 FOR UPDATE', [machine, key]);
    if (!inst || inst.flag !== 'faulted') {
      await client.query('ROLLBACK');
      return { released: false, reason: inst ? 'not_faulted' : 'no_instance' };
    }
    const faultedId = Number(inst.flag_detail?.eventId);
    if (opts.mode === 'retry') {
      await client.query(
        `UPDATE wf_events SET status = 'pending', result = NULL, reason = NULL, processed_at = NULL,
                state_before = NULL, state_after = NULL, retry_at = NULL
          WHERE id = $1 AND result = 'faulted'`, [faultedId]);
    }
    const { rowCount } = await client.query(
      `UPDATE wf_events SET status = 'pending' WHERE machine = $1 AND key = $2 AND status = 'held'`, [machine, key]);
    await client.query(
      'UPDATE wf_instances SET flag = NULL, flag_detail = NULL, updated_at = now() WHERE machine = $1 AND key = $2',
      [machine, key]);
    await client.query(
      `INSERT INTO wf_events (machine, key, app_id, type, payload, source, actor, request_key, caused_by,
                              status, result, state_before, state_after, version_after, processed_at)
       VALUES ($1, $2, $3, '@Released', $4, '{"kind":"admin"}', $5, $6, $7,
               'processed', 'accepted', $8, $8, $9, clock_timestamp())`,
      [machine, key, inst.app_id, JSON.stringify({ mode: opts.mode, faultedEventId: faultedId, released: rowCount }),
        opts.actor, `release:${randomUUID()}`, faultedId || null, inst.state, inst.version]);
    await client.query(`SELECT pg_notify('wf_events', $1)`, [machine]);
    await client.query('COMMIT');
    return { released: true, heldEvents: rowCount ?? 0 };
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    throw err;
  } finally {
    client.release();
  }
}
