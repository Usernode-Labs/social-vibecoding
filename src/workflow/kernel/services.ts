// Services: claim work items, run their handler under a lease, and report
// the result as an event. A service never settles a work item; the
// pipeline does when it applies the result event.

import { assertJson } from './machine.ts';
import { append } from './stream.ts';
import { checkout } from './pipeline.ts';
import type { Json, Logger, Pool, WorkHandler } from './types.ts';

export class LeaseLost extends Error {
  constructor() { super('work lease lost'); }
}

export interface ServiceOptions {
  pool: Pool;
  handlers: ReadonlyMap<string, WorkHandler>;
  serviceId: string;
  log: Logger;
  // The version of each machine this process runs: work of an instance a
  // newer version last wrote is left to a process that runs that version,
  // as its events are (the mixed-version rule, pipeline.ts pickSql).
  versions: ReadonlyMap<string, number>;
}

const DEFAULTS = { maxAttempts: 5, leaseMs: 60000 };
const RESULT_EVENTS = new Map([['succeeded', 'WorkSucceeded'], ['failed', 'WorkFailed'], ['exhausted', 'WorkExhausted']]);
const defaultBackoff = (attempt: number) => Math.min(10 * 60000, 5000 * 2 ** (attempt - 1));

function errorJson(err: unknown): { message: string; code: string | null } {
  const e = err as { message?: string; code?: unknown };
  return { message: String(e?.message ?? err).slice(0, 2000), code: e?.code == null ? null : String(e.code) };
}

interface Claimed { id: string; machine: string; key: string; kind: string;
  work_key: string; input: Json; checkpoint: Json | null; attempt_count: number; claim_id: string }

// Claim up to `room` due items of one kind: queued and due, or running on
// an expired lease. `room` is this process's free capacity for the kind;
// services run in one process for now, so that is also the global limit.
// An item whose instance a newer machine version last wrote is not claimed
// here: during a rollout the older process would run it with older code.
export async function claim(opts: ServiceOptions, kind: string, room: number): Promise<Claimed[]> {
  const leaseMs = opts.handlers.get(kind)!.leaseMs ?? DEFAULTS.leaseMs;
  const client = await checkout(opts.pool);
  try {
    await client.query('BEGIN');
    const { rows } = await client.query<Claimed & { previous_claim: string | null }>(
      `WITH due AS (
         SELECT w.id, w.claim_id FROM wf_work w
           LEFT JOIN wf_instances i ON i.machine = w.machine AND i.key = w.key
           LEFT JOIN unnest($4::text[], $5::int[]) AS m(machine, version) ON m.machine = w.machine
          WHERE w.kind = $1
            AND ((w.status = 'queued' AND w.due_at <= now()) OR (w.status = 'running' AND w.lease_until <= now()))
            AND (i.machine_version IS NULL OR m.version IS NULL OR i.machine_version <= m.version)
          ORDER BY w.due_at, w.created_at
          LIMIT $2
          FOR UPDATE OF w SKIP LOCKED)
       UPDATE wf_work w SET status = 'running', claim_id = gen_random_uuid(),
              lease_until = now() + make_interval(secs => $3::float8 / 1000),
              attempt_count = w.attempt_count + 1
         FROM due WHERE w.id = due.id
       RETURNING w.id, w.machine, w.key, w.kind, w.work_key, w.input, w.checkpoint,
                 w.attempt_count, w.claim_id, due.claim_id AS previous_claim`,
      [kind, room, leaseMs, [...opts.versions.keys()], [...opts.versions.values()]]);
    for (const r of rows) {
      if (r.previous_claim) {
        await client.query(`UPDATE wf_work_attempts SET outcome = 'lost', finished_at = now() WHERE id = $1`, [r.previous_claim]);
      }
      await client.query(
        `INSERT INTO wf_work_attempts (id, work_id, service_id, number) VALUES ($1, $2, $3, $4)`,
        [r.claim_id, r.id, opts.serviceId, r.attempt_count]);
    }
    await client.query('COMMIT');
    return rows;
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    throw err;
  } finally {
    client.release();
  }
}

// Milliseconds until the next item of these kinds is due (queued, or a
// lease that runs out), or null when there is none. New work notifies.
export async function nextDueMs(pool: Pool, kinds: string[]): Promise<number | null> {
  if (!kinds.length) return null;
  const { rows: [r] } = await pool.query(
    `SELECT (EXTRACT(EPOCH FROM min(CASE WHEN status = 'queued' THEN due_at ELSE lease_until END) - now()) * 1000)::float8 AS ms
       FROM wf_work WHERE kind = ANY($1::text[]) AND status IN ('queued', 'running')`, [kinds]);
  return r?.ms == null ? null : Number(r.ms);
}

type Report =
  | { outcome: 'succeeded'; result: Json }
  | { outcome: 'failed' | 'exhausted'; error: { message: string; code: string | null } }
  | { outcome: 'retry'; error: { message: string; code: string | null }; delayMs: number };

// Finish an attempt under its claim. Returns false when the claim is gone,
// in which case nothing was written.
async function finish(opts: ServiceOptions, w: Claimed, report: Report): Promise<boolean> {
  const client = await checkout(opts.pool);
  try {
    await client.query('BEGIN');
    const live = `id = $1 AND claim_id = $2 AND status = 'running' AND lease_until > now()`;
    const { rowCount } = report.outcome === 'retry'
      ? await client.query(
        `UPDATE wf_work SET status = 'queued', claim_id = NULL, lease_until = NULL, last_error = $3,
                due_at = now() + make_interval(secs => $4::float8 / 1000) WHERE ${live}`,
        [w.id, w.claim_id, JSON.stringify(report.error), report.delayMs])
      : await client.query(
        `UPDATE wf_work SET status = 'reported', claim_id = NULL, lease_until = NULL,
                result = $3, last_error = $4 WHERE ${live}`,
        [w.id, w.claim_id, JSON.stringify({ outcome: report.outcome, ...('result' in report ? { value: report.result } : {}) }),
          'error' in report ? JSON.stringify(report.error) : null]);
    if (!rowCount) { await client.query('ROLLBACK'); return false; }
    await client.query(
      `UPDATE wf_work_attempts SET outcome = $2, error = $3, finished_at = now() WHERE id = $1`,
      [w.claim_id, report.outcome, 'error' in report ? JSON.stringify(report.error) : null]);
    if (report.outcome !== 'retry') {
      const type = RESULT_EVENTS.get(report.outcome)!;
      await append(client, w.machine, w.key, {
        type,
        payload: { workId: w.id, kind: w.kind, workKey: w.work_key, attempt: w.attempt_count,
          ...(report.outcome === 'succeeded' ? { result: report.result } : { error: report.error }) },
      }, {
        requestKey: `work:${w.id}:${w.attempt_count}`,
        source: { kind: 'service', workId: w.id, workKind: w.kind, attempt: w.attempt_count },
        actor: `service:${w.kind}`,
      });
    }
    await client.query('COMMIT');
    return true;
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    throw err;
  } finally {
    client.release();
  }
}

// Run one claimed item to completion. A lost lease aborts the handler's
// signal and nothing is reported; the next claim resumes from the checkpoint.
// A process stopping aborts it too, and a handler that ended on that signal
// (it threw) reports nothing either; one that finished its work anyway
// reports it, rather than have it run again after the lease lapses.
export async function execute(opts: ServiceOptions, w: Claimed, stopping?: AbortSignal): Promise<void> {
  const h = opts.handlers.get(w.kind)!;
  const maxAttempts = h.maxAttempts ?? DEFAULTS.maxAttempts;
  const leaseMs = h.leaseMs ?? DEFAULTS.leaseMs;
  if (w.attempt_count > maxAttempts) {
    // Only a lease that kept expiring gets here: the process running it died.
    await finish(opts, w, { outcome: 'exhausted', error: { message: 'lease lost on every attempt', code: 'lease_lost' } });
    return;
  }
  const abort = new AbortController();
  const onStop = () => abort.abort(new LeaseLost());
  stopping?.addEventListener('abort', onStop, { once: true });
  const live = `id = $1 AND claim_id = $2 AND status = 'running' AND lease_until > now()`;
  let leaseLost = false;
  const renew = async (sql: string, values: unknown[]) => {
    const { rowCount } = await opts.pool.query(sql, values);
    if (!rowCount) { leaseLost = true; abort.abort(new LeaseLost()); throw new LeaseLost(); }
  };
  const heartbeat = setInterval(() => {
    renew(`UPDATE wf_work SET lease_until = now() + make_interval(secs => $3::float8 / 1000) WHERE ${live}`,
      [w.id, w.claim_id, leaseMs]).catch(() => {});
  }, Math.max(50, Math.floor(leaseMs / 3)));
  let report: Report | null;
  try {
    const value = await h.run({
      workId: w.id, kind: w.kind, key: w.work_key, input: w.input, attempt: w.attempt_count,
      resumeFrom: w.checkpoint ?? null,
      checkpoint: async (v: Json) => {
        assertJson(v);
        if (abort.signal.aborted) throw new LeaseLost();
        await renew(`UPDATE wf_work SET checkpoint = $3 WHERE ${live}`, [w.id, w.claim_id, JSON.stringify(v)]);
      },
      signal: abort.signal,
    });
    const result = value === undefined ? null : value;
    assertJson(result);
    report = { outcome: 'succeeded', result };
  } catch (err) {
    if (abort.signal.aborted) report = null;
    else if ((err as { permanent?: boolean })?.permanent) report = { outcome: 'failed', error: errorJson(err) };
    else if (w.attempt_count >= maxAttempts) report = { outcome: 'exhausted', error: errorJson(err) };
    else report = { outcome: 'retry', error: errorJson(err), delayMs: (h.backoffMs || defaultBackoff)(w.attempt_count) };
  } finally {
    clearInterval(heartbeat);
    stopping?.removeEventListener('abort', onStop);
  }
  if (leaseLost || !report) return;
  if (!await finish(opts, w, report)) {
    opts.log.warn('workflow', 'work lease lost before reporting', { kind: w.kind, workId: w.id });
  }
}
