// Services: claim work items, run their handler under a lease, and report
// the result as an event. A service never settles a work item; the
// pipeline does when it applies the result event.

import { steps } from './steps.ts';
import { assertJson } from './machine.ts';
import { append } from './stream.ts';
import { checkout } from './pipeline.ts';
import type { Json, Logger, Pool, WorkHandler } from './types.ts';
import { millis } from './pipeline.ts';

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
  // A claim's lock and statement timeouts: it never waits long on a lock.
  lockTimeoutMs: number;
  statementTimeoutMs: number;
}

const DEFAULTS = { maxAttempts: 5, leaseMs: 60000, maxLostAttempts: 100, concurrency: 4 };
// The kernel's own advisory locks, in the two-key form (which never meets
// the one-key locks: the leader's, the migration's, the checks queue's).
// Claims of one kind take (CLAIM_LOCKS, hashtext(kind)); the retention purge
// takes (PURGE_LOCK, 0).
export const CLAIM_LOCKS = 0x57464b43;
export const PURGE_LOCK = 0x57465055;
// An item whose process died on each of its last this many attempts is
// taken off: it is ended exhausted (`lost_repeatedly`) and its machine
// decides, rather than have it take every process that claims it down.
const DEATHS_TO_QUARANTINE = 3;

export function concurrencyOf(h: WorkHandler): number {
  return h.concurrency ?? DEFAULTS.concurrency;
}
const RESULT_EVENTS = new Map([['succeeded', 'WorkSucceeded'], ['failed', 'WorkFailed'], ['exhausted', 'WorkExhausted']]);
const defaultBackoff = (attempt: number) => Math.min(10 * 60000, 5000 * 2 ** (attempt - 1));

function errorJson(err: unknown): { message: string; code: string | null } {
  const e = err as { message?: string; code?: unknown };
  return { message: String(e?.message ?? err).slice(0, 2000), code: e?.code == null ? null : String(e.code) };
}

interface Claimed { id: string; machine: string; key: string; kind: string;
  work_key: string; input: Json; checkpoint: Json | null; attempt_count: number; lost_attempts: number; claim_id: string;
  // How many of its last attempts, in a row, ended with their process dead
  // (claimed again on a lapsed lease), up to DEATHS_TO_QUARANTINE.
  deaths: number }

export interface ClaimResult {
  items: Claimed[];
  // The kind is at its limit across every process: nothing more is claimed
  // until an item of it ends (`wf_work` notifies) or, at the latest, until
  // `freeInMs` (its earliest lease end).
  full: boolean;
  freeInMs: number | null;
  // Another process is claiming this kind right now; look again later.
  busy: boolean;
}

// Claim due items of one kind: queued and due, or running on an expired
// lease (an attempt lost: its process died, or stopped and gave the lease
// up, which `lost_attempts` counts). A kind's `concurrency` holds across
// every process: under the kind's claim lock, the items running on a live
// lease anywhere (a draining process's included) are counted, and at most
// `concurrency` minus that are claimed, and no more than `room`, this
// process's own free capacity. A process that finds the lock taken skips
// the kind (another one is claiming it now) rather than wait. An item whose
// instance a newer machine version last wrote is not claimed here: during a
// rollout the older process would run it with older code.
export async function claim(opts: ServiceOptions, kind: string, room: number): Promise<ClaimResult> {
  const handler = opts.handlers.get(kind)!;
  const leaseMs = handler.leaseMs ?? DEFAULTS.leaseMs;
  const client = await checkout(opts.pool);
  try {
    await client.query(`BEGIN; SET LOCAL lock_timeout = ${millis(opts.lockTimeoutMs)};`
      + ` SET LOCAL statement_timeout = ${millis(opts.statementTimeoutMs)}`);
    const { rows: [lock] } = await client.query<{ got: boolean }>(
      'SELECT pg_try_advisory_xact_lock($1, hashtext($2)) AS got', [CLAIM_LOCKS, kind]);
    if (!lock!.got) {
      await client.query('COMMIT');
      return { items: [], full: false, freeInMs: null, busy: true };
    }
    const { rows: [live] } = await client.query<{ n: number; ms: number | null }>(
      `SELECT count(*)::int AS n, (EXTRACT(EPOCH FROM min(lease_until) - now()) * 1000)::float8 AS ms
         FROM wf_work WHERE kind = $1 AND status = 'running' AND lease_until > now()`, [kind]);
    const limit = concurrencyOf(handler);
    const take = Math.min(room, limit - live!.n);
    if (take <= 0) {
      await client.query('COMMIT');
      return { items: [], full: live!.n >= limit, freeInMs: live!.ms == null ? null : Number(live!.ms), busy: false };
    }
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
              attempt_count = w.attempt_count + 1,
              lost_attempts = w.lost_attempts + CASE WHEN w.status = 'running' THEN 1 ELSE 0 END
         FROM due WHERE w.id = due.id
       RETURNING w.id, w.machine, w.key, w.kind, w.work_key, w.input, w.checkpoint,
                 w.attempt_count, w.lost_attempts, w.claim_id, due.claim_id AS previous_claim`,
      [kind, take, leaseMs, [...opts.versions.keys()], [...opts.versions.values()]]);
    for (const r of rows) {
      r.deaths = 0;
      if (r.previous_claim) {
        // An attempt still 'running' when its item is claimed again ended
        // with its process: a death. One that stopped gracefully, or was
        // cancelled, already says so.
        await client.query(
          `UPDATE wf_work_attempts SET outcome = 'lost', finished_at = now() WHERE id = $1 AND outcome = 'running'`,
          [r.previous_claim]);
        const { rows: [d] } = await client.query<{ deaths: number }>(
          `SELECT count(*) FILTER (WHERE outcome = 'lost' AND error IS NULL)::int AS deaths
             FROM (SELECT outcome, error FROM wf_work_attempts WHERE work_id = $1 ORDER BY number DESC LIMIT $2) t`,
          [r.id, DEATHS_TO_QUARANTINE]);
        r.deaths = d!.deaths;
      }
      await client.query(
        `INSERT INTO wf_work_attempts (id, work_id, service_id, number) VALUES ($1, $2, $3, $4)`,
        [r.claim_id, r.id, opts.serviceId, r.attempt_count]);
    }
    await client.query('COMMIT');
    return { items: rows, full: live!.n + rows.length >= limit, freeInMs: live!.ms == null ? null : Number(live!.ms), busy: false };
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    throw err;
  } finally {
    client.release();
  }
}

// Which of these kinds have an item this process may claim now (the
// mixed-version rule as in claim()): one query for a pass of the services
// loop, which then claims only those kinds.
export async function dueKinds(opts: Pick<ServiceOptions, 'pool' | 'versions'>, kinds: string[]): Promise<string[]> {
  if (!kinds.length) return [];
  const { rows } = await opts.pool.query(
    `SELECT DISTINCT w.kind FROM wf_work w
       LEFT JOIN wf_instances i ON i.machine = w.machine AND i.key = w.key
       LEFT JOIN unnest($2::text[], $3::int[]) AS m(machine, version) ON m.machine = w.machine
      WHERE w.kind = ANY($1::text[])
        AND ((w.status = 'queued' AND w.due_at <= now()) OR (w.status = 'running' AND w.lease_until <= now()))
        AND (i.machine_version IS NULL OR m.version IS NULL OR i.machine_version <= m.version)`,
    [kinds, [...opts.versions.keys()], [...opts.versions.values()]]);
  return rows.map((r: { kind: string }) => r.kind);
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
    // The item no longer counts against its kind's limit: every process
    // with room hears it, a draining one's included.
    await client.query(`SELECT pg_notify('wf_work', $1)`, [w.kind]);
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
// reports it, rather than have it run again after the lease lapses. Until
// the handler returns its process still holds the lease, so it may still
// checkpoint: a step whose effect had happened when the stop came is kept,
// and the next process does not do it again. A process that stops gives up
// the lease of an item it reports nothing for, so the next process claims it
// at once rather than when the lease lapses.
//
// A `resumable` handler carries its work on from its checkpoint, so an
// attempt that ended because its process went (a release restarts the
// platform many times a day) is not one of its tries: only attempts that
// ended in an error count against `maxAttempts`, and lost ones against
// `maxLostAttempts`, which bounds a handler that keeps taking its process
// down with it.
export async function execute(opts: ServiceOptions, w: Claimed, stopping?: AbortSignal): Promise<void> {
  const h = opts.handlers.get(w.kind)!;
  const maxAttempts = h.maxAttempts ?? DEFAULTS.maxAttempts;
  const leaseMs = h.leaseMs ?? DEFAULTS.leaseMs;
  const lost = Number(w.lost_attempts) || 0;
  const tries = h.resumable ? w.attempt_count - lost : w.attempt_count;
  if (w.deaths >= DEATHS_TO_QUARANTINE) {
    // Its process died on each of its last attempts: whatever it does takes
    // the process with it, so no process runs it again.
    await finish(opts, w, { outcome: 'exhausted', error: {
      message: `its process died on each of its last ${DEATHS_TO_QUARANTINE} attempts`, code: 'lost_repeatedly' } });
    return;
  }
  if (h.resumable ? lost > (h.maxLostAttempts ?? DEFAULTS.maxLostAttempts) : w.attempt_count > maxAttempts) {
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
    const checkpoint = async (v: Json) => {
      assertJson(v);
      if (leaseLost) throw new LeaseLost();
      await renew(`UPDATE wf_work SET checkpoint = $3 WHERE ${live}`, [w.id, w.claim_id, JSON.stringify(v)]);
    };
    const value = await h.run({
      workId: w.id, kind: w.kind, key: w.work_key, input: w.input, attempt: w.attempt_count, lostAttempts: lost,
      resumeFrom: w.checkpoint ?? null,
      checkpoint,
      signal: abort.signal,
      steps: (o = {}) => steps({
        resumeFrom: w.checkpoint ?? null, checkpoint, signal: abort.signal, attempt: w.attempt_count, lostAttempts: lost,
        owner: o.owner ?? null, triesLeft: o.triesLeft ?? 0, log: opts.log,
      }),
    });
    const result = value === undefined ? null : value;
    assertJson(result);
    report = { outcome: 'succeeded', result };
  } catch (err) {
    if (abort.signal.aborted) report = null;
    else if ((err as { permanent?: boolean })?.permanent) report = { outcome: 'failed', error: errorJson(err) };
    else if (tries >= maxAttempts) report = { outcome: 'exhausted', error: errorJson(err) };
    else report = { outcome: 'retry', error: errorJson(err), delayMs: (h.backoffMs || defaultBackoff)(tries) };
  } finally {
    clearInterval(heartbeat);
    stopping?.removeEventListener('abort', onStop);
  }
  if (!leaseLost && !report && stopping?.aborted) {
    // Stopping, with nothing to report: the claim is given up now, under it,
    // and the attempt says it stopped (not a death: claim()).
    await opts.pool.query(
      `WITH given AS (UPDATE wf_work SET lease_until = now() WHERE ${live} RETURNING kind)
       UPDATE wf_work_attempts SET outcome = 'lost', finished_at = now(),
              error = '{"message": "its process stopped", "code": "stopped"}'::jsonb
        WHERE id = $2 AND outcome = 'running' AND EXISTS (SELECT 1 FROM given)
       RETURNING pg_notify('wf_work', (SELECT kind FROM given))`, [w.id, w.claim_id])
      .catch((err) => opts.log.warn('workflow', 'could not give up a stopped work item\'s lease', { kind: w.kind, workId: w.id, message: err?.message }));
    return;
  }
  if (leaseLost || !report) return;
  if (!await finish(opts, w, report)) {
    opts.log.warn('workflow', 'work claim gone before reporting (lease lost or cancelled)', { kind: w.kind, workId: w.id });
  }
}
