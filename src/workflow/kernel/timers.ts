// Timers: an instance's single deadline becomes an event when it passes.
// The row is locked with SKIP LOCKED and the deadline cleared in the same
// transaction, so concurrent loops in several processes fire it once; the
// request key `timer:<version that set it>` makes a duplicate a replay.

import { enterPipeline } from './pipeline.ts';
import type { Machine } from './machine.ts';
import type { Pool } from './types.ts';

export async function fireDueTimers(pool: Pool, opts: { lockTimeoutMs: number; statementTimeoutMs: number; limit?: number }): Promise<number> {
  const client = await pool.connect();
  let broken: Error | undefined;
  try {
    await enterPipeline(client, opts);
    const { rows } = await client.query(
      `SELECT machine, key, app_id, deadline_event, deadline_version
         FROM wf_instances
        WHERE deadline_at <= now() AND flag IS DISTINCT FROM 'faulted'
        ORDER BY deadline_at
        LIMIT $1
        FOR UPDATE SKIP LOCKED`, [opts.limit ?? 100]);
    for (const row of rows) {
      const setAt = Number(row.deadline_version);
      await client.query(
        `INSERT INTO wf_events (machine, key, app_id, type, payload, source, actor, request_key)
         VALUES ($1, $2, $3, $4, $5, $6, 'timer', $7)`,
        [row.machine, row.key, row.app_id, row.deadline_event.type, JSON.stringify(row.deadline_event.payload ?? {}),
          JSON.stringify({ kind: 'timer', setAtVersion: setAt }), `timer:${setAt}`]);
      await client.query(
        `UPDATE wf_instances SET deadline_at = NULL, deadline_event = NULL, deadline_version = NULL
          WHERE machine = $1 AND key = $2`, [row.machine, row.key]);
    }
    if (rows.length) await client.query(`SELECT pg_notify('wf_events', 'timer')`);
    await client.query('COMMIT');
    return rows.length;
  } catch (err) {
    broken = err as Error;
    await client.query('ROLLBACK').catch(() => {});
    throw err;
  } finally {
    client.release(broken && !(broken as { code?: string }).code ? broken : undefined);
  }
}

// Retention: processed events and settled work after `eventsDays` /
// `workDays`, receipts `receiptsDays` after their instance went terminal
// (approximated by its last update). Instances themselves are kept.
export async function purge(pool: Pool, opts: {
  lockTimeoutMs: number; statementTimeoutMs: number;
  machines: ReadonlyMap<string, Machine<any, any>>; eventsDays?: number; receiptsDays?: number; workDays?: number;
}): Promise<void> {
  const client = await pool.connect();
  try {
    await enterPipeline(client, { ...opts, statementTimeoutMs: Math.max(opts.statementTimeoutMs, 60000) });
    await client.query(
      `DELETE FROM wf_events WHERE status = 'processed' AND processed_at < now() - make_interval(days => $1)`,
      [opts.eventsDays ?? 90]);
    await client.query(
      `DELETE FROM wf_work WHERE status = 'settled' AND settled_at < now() - make_interval(days => $1)`,
      [opts.workDays ?? 90]);
    for (const [machine, { terminal }] of opts.machines) {
      if (!terminal.size) continue;
      await client.query(
        `DELETE FROM wf_receipts r USING wf_instances i
          WHERE r.machine = $1 AND i.machine = r.machine AND i.key = r.key
            AND i.state = ANY($2::text[]) AND i.updated_at < now() - make_interval(days => $3)`,
        [machine, [...terminal], opts.receiptsDays ?? 30]);
    }
    await client.query('COMMIT');
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    throw err;
  } finally {
    client.release();
  }
}
