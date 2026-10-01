'use strict';

const { z } = require('zod');
const { createSessionDecisionRuntime, hashJson } = require('../decision-runtime');

const workRequest = z.object({
  id: z.string().uuid(),
  effectKey: z.string().min(1).max(255),
  sessionId: z.number().int().positive().max(2147483647),
  workflow: z.string().min(1).max(100),
  version: z.number().int().positive(),
  causedBy: z.string().uuid(),
  input: z.record(z.any()),
}).strict();

const settlement = z.object({
  outcome: z.enum(['succeeded', 'waiting', 'retry', 'blocked']),
  checkpoint: z.record(z.any()).default({}),
  result: z.record(z.any()).nullable().default(null),
  code: z.string().min(1).max(100).nullable().default(null),
  delayMs: z.number().int().min(100).max(3600000).default(1000),
}).strict();

function createExecutionStore(pool, { leaseMs = 30000 } = {}) {
  z.number().int().min(100).max(300000).parse(leaseMs);
  const runtime = createSessionDecisionRuntime(pool);

  async function find(transaction, sessionId, effectKey) {
    return transaction.withSession(sessionId, async client => {
      const { rows } = await client.query(`SELECT * FROM execution_work_requests
        WHERE session_id = $1 AND effect_key = $2`, [sessionId, effectKey]);
      return rows[0] || null;
    });
  }

  async function enqueue(transaction, input) {
    return transaction.withSession(input.sessionId, async client => {
      const work = workRequest.parse(input);
      const fingerprint = hashJson({
        effectKey: work.effectKey,
        sessionId: work.sessionId,
        workflow: work.workflow,
        version: work.version,
        causedBy: work.causedBy,
        input: work.input,
      });
      const inserted = await client.query(`INSERT INTO execution_work_requests
        (id, effect_key, session_id, workflow, contract_version, caused_by, input, input_hash)
        VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
        ON CONFLICT (effect_key) DO NOTHING RETURNING *`, [
        work.id, work.effectKey, work.sessionId, work.workflow, work.version,
        work.causedBy, JSON.stringify(work.input), fingerprint,
      ]);
      if (inserted.rowCount) {
        await client.query(`INSERT INTO execution_work_events (work_id, kind, detail)
          VALUES ($1, 'admitted', $2)`, [work.id, JSON.stringify({ causedBy: work.causedBy })]);
        return inserted.rows[0];
      }

      const existing = (await client.query(`SELECT * FROM execution_work_requests
        WHERE effect_key = $1`, [work.effectKey])).rows[0];
      if (existing?.session_id !== work.sessionId || existing?.input_hash !== fingerprint) {
        throw new Error('Execution effect key reused with different input');
      }
      return existing;
    });
  }

  async function claim(workerId, workflows, limit = 4) {
    z.string().uuid().parse(workerId);
    z.array(z.string().min(1)).min(1).parse(workflows);
    z.number().int().min(1).max(32).parse(limit);

    // No aggregate is locked after these queue rows. Claim, old-attempt
    // interruption, new attempt and journal are one atomic PostgreSQL statement.
    const { rows } = await pool.query(`WITH selected AS (
      SELECT id FROM execution_work_requests
      WHERE workflow = ANY($1::text[]) AND status IN ('queued', 'running')
        AND due_at <= clock_timestamp()
        AND (claim_id IS NULL OR lease_until <= clock_timestamp())
      ORDER BY queue_position LIMIT $2 FOR UPDATE SKIP LOCKED
    ), claimed AS (
      UPDATE execution_work_requests w SET status = 'running', claim_id = gen_random_uuid(),
        lease_until = clock_timestamp() + $3 * INTERVAL '1 millisecond',
        queue_position = DEFAULT, attempt_count = attempt_count + 1
      FROM selected s WHERE w.id = s.id RETURNING w.*
    ), interrupted AS (
      UPDATE execution_work_attempts a SET outcome = 'interrupted', finished_at = clock_timestamp()
      FROM claimed c WHERE a.work_id = c.id AND a.outcome = 'running' RETURNING a.id
    ), attempts AS (
      INSERT INTO execution_work_attempts (id, work_id, worker_id, number)
      SELECT claim_id, id, $4, attempt_count FROM claimed RETURNING id
    ), journal AS (
      INSERT INTO execution_work_events (work_id, attempt_id, kind, detail)
      SELECT id, claim_id, 'claimed', jsonb_build_object('workerId', $4::text, 'number', attempt_count)
      FROM claimed RETURNING id
    ) SELECT * FROM claimed`, [workflows, limit, leaseMs, workerId]);
    return rows;
  }

  async function renew(attempt) {
    const result = await pool.query(`WITH renewed AS (
      UPDATE execution_work_requests SET lease_until = clock_timestamp() + $3 * INTERVAL '1 millisecond'
      WHERE id = $1 AND claim_id = $2 AND status = 'running'
        AND lease_until > clock_timestamp() RETURNING claim_id
    ) UPDATE execution_work_attempts SET heartbeat_at = clock_timestamp()
      WHERE id IN (SELECT claim_id FROM renewed) RETURNING id`, [attempt.id, attempt.claim_id, leaseMs]);
    return result.rowCount === 1;
  }

  async function underClaim(attempt, run) {
    return runtime.transact(transaction => transaction.withSession(attempt.session_id, async client => {
      // The B2 aggregate precedes the work row, for every checkpoint and domain
      // settlement. Claim selection never takes the reverse lock order.
      const current = await client.query(`SELECT * FROM execution_work_requests
        WHERE id = $1 AND claim_id = $2 AND status = 'running'
          AND lease_until > clock_timestamp() FOR UPDATE`, [attempt.id, attempt.claim_id]);
      if (!current.rowCount) return { lostClaim: true };
      return run(transaction, client, current.rows[0]);
    }));
  }

  async function checkpoint(attempt, value) {
    return underClaim(attempt, async (_transaction, client) => {
      const checkpointJson = JSON.stringify(value);
      hashJson(value);
      await client.query(`UPDATE execution_work_requests SET checkpoint = $3
        WHERE id = $1 AND claim_id = $2`, [attempt.id, attempt.claim_id, checkpointJson]);
      await client.query(`INSERT INTO execution_work_events (work_id, attempt_id, kind, detail)
        VALUES ($1, $2, 'checkpoint', $3)`, [attempt.id, attempt.claim_id, checkpointJson]);
      return { saved: true };
    });
  }

  async function settle(attempt, proposed, commit = null) {
    return underClaim(attempt, async (transaction, client) => {
      // The handler owns domain actions/mappings. A caught mapping failure still
      // poisons B2 and rolls back actions, work state, attempt and journal together.
      const adjusted = commit ? await commit(transaction, attempt, proposed) : proposed;
      const result = settlement.parse(adjusted);
      hashJson(result);
      const status = ['waiting', 'retry'].includes(result.outcome) ? 'queued' : result.outcome;
      await client.query(`UPDATE execution_work_requests SET status = $3, checkpoint = $4,
        result = $5, last_code = $6, due_at = clock_timestamp() + $7 * INTERVAL '1 millisecond',
        queue_position = DEFAULT, claim_id = NULL, lease_until = NULL
        WHERE id = $1 AND claim_id = $2`, [
        attempt.id, attempt.claim_id, status, JSON.stringify(result.checkpoint),
        JSON.stringify(result.result), result.code, result.delayMs,
      ]);
      await client.query(`UPDATE execution_work_attempts SET outcome = $2,
        finished_at = clock_timestamp(), code = $3 WHERE id = $1`,
      [attempt.claim_id, result.outcome, result.code]);
      await client.query(`INSERT INTO execution_work_events (work_id, attempt_id, kind, detail)
        VALUES ($1, $2, 'settled', $3)`, [attempt.id, attempt.claim_id, JSON.stringify(result)]);
      return result;
    });
  }

  async function read(id) {
    return (await pool.query('SELECT * FROM execution_work_requests WHERE id = $1', [id])).rows[0] || null;
  }

  async function trace(id) {
    return (await pool.query(`SELECT * FROM execution_work_events WHERE work_id = $1 ORDER BY id`, [id])).rows;
  }

  return { enqueue, find, claim, renew, checkpoint, settle, read, trace, leaseMs };
}

module.exports = { createExecutionStore };
