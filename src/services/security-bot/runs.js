'use strict';

// Durable campaign control only. No startup hook, route, identity/key setup,
// model transport or runtime provisioning lives here. Brokers/verifiers must
// use withLease for writes and assertCanDispatch before each external action.
const crypto = require('node:crypto');
const settings = require('./settings');
const { SECURITY_BOT_RUN_LOCK } = require('../advisory-locks');

const LEASE_SECONDS = 60;
const MAX_RECOVERIES = 1;
const MAX_CLEANUP_ATTEMPTS = 3;
const EXTRA_LIMITS = Object.freeze({
  max_defender_calls: 60,
  max_total_tokens: 1_000_000,
  max_provider_retries: 2,
  max_recoveries: MAX_RECOVERIES,
});
const ACTIVE = new Set(['claimed', 'running']);
const TERMINAL = new Set(['completed', 'cancelled', 'failed', 'orphaned']);
const CATEGORIES = Object.freeze(['private-data', 'admin-infra', 'secret-exposure',
  'governance', 'rate-caps', 'prompt-injection']);

class RunError extends Error {
  constructor(code) {
    super(`Security bot: ${code}`);
    this.name = 'SecurityBotRunError';
    this.code = code;
  }
}

// Persist identifiers and registered codes, never free-form exception text.
function identifier(value) {
  if (typeof value !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9_.:/-]{0,179}$/.test(value)) {
    throw new RunError('invalid_identifier');
  }
  return value;
}

function generation(value) {
  if (!Number.isSafeInteger(value) || value < 0) throw new RunError('invalid_generation');
  return value;
}

async function transaction(pool, work) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const value = await work(client);
    await client.query('COMMIT');
    return value;
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    throw err;
  } finally {
    client.release();
  }
}

async function controlLock(client) {
  await client.query('SELECT pg_advisory_xact_lock($1)', [SECURITY_BOT_RUN_LOCK]);
}

async function getRun(pool, runId) {
  const { rows } = await pool.query('SELECT * FROM security_bot_runs WHERE id = $1', [runId]);
  return rows[0] || null;
}

function leaseFor(run) {
  return { runId: run.id, owner: run.lease_owner, generation: run.lease_generation };
}

// Called on the SAME client/transaction as the protected writes. Lock ordering:
// accounting takes BUDGET then this row; run control takes RUN then this row.
// Never acquire BUDGET from a withLease callback or perform network work in it.
async function lockLease(client, lease, { allowStopped = false } = {}) {
  generation(lease?.generation);
  const { rows } = await client.query(
    `SELECT *, lease_expires_at > clock_timestamp() AS lease_live,
               deadline_at > clock_timestamp() AS within_deadline
       FROM security_bot_runs WHERE id = $1 FOR UPDATE`, [lease.runId],
  );
  const run = rows[0];
  if (!run || run.lease_generation !== lease.generation) throw new RunError('lease_lost');
  if (allowStopped && !ACTIVE.has(run.status)) return run;
  if (!ACTIVE.has(run.status) || !run.lease_live || run.lease_owner !== lease.owner) {
    throw new RunError('lease_lost');
  }
  if (run.cancel_requested_at || run.capabilities_revoked_at) throw new RunError('run_cancelled');
  if (!run.within_deadline) throw new RunError('time_exhausted');
  return run;
}

async function withLease(pool, lease, work) {
  return transaction(pool, async (client) => {
    const run = await lockLease(client, lease);
    const result = await work(client, run);
    // clock_timestamp, unlike NOW(), advances while a callback holds the row.
    // A callback that outlives its lease cannot commit its protected writes.
    await lockLease(client, lease);
    return result;
  });
}

async function assertCanDispatch(pool, lease) {
  return withLease(pool, lease, async (client, run) => {
    const s = await settings.read(client);
    if (!s.enabled) throw new RunError('service_disabled');
    return run;
  });
}

async function createRun(pool, { trigger = 'manual', idempotencyKey, scheduledDay } = {}) {
  if (!['manual', 'scheduled'].includes(trigger)) throw new RunError('invalid_trigger');
  return transaction(pool, async (client) => {
    await controlLock(client);
    const { rows: [clock] } = await client.query(
      "SELECT (clock_timestamp() AT TIME ZONE 'UTC')::date::text AS day",
    );
    if (scheduledDay !== undefined && (trigger !== 'scheduled' || scheduledDay !== clock.day)) {
      throw new RunError('only_current_utc_day');
    }
    const key = identifier(idempotencyKey === undefined ? (trigger === 'scheduled'
      ? `scheduled:${clock.day}` : `manual:${crypto.randomUUID()}`) : idempotencyKey);
    const { rows: existing } = await client.query(
      'SELECT * FROM security_bot_runs WHERE idempotency_key = $1', [key],
    );
    if (existing.length) {
      if (existing[0].trigger !== trigger
          || (trigger === 'scheduled' && new Date(existing[0].scheduled_day).toISOString().slice(0, 10) !== clock.day)) {
        throw new RunError('idempotency_conflict');
      }
      return existing[0];
    }
    const s = await settings.read(client);
    if (!s.enabled) throw new RunError('service_disabled');
    const result = await client.query(
      `INSERT INTO security_bot_runs
         (trigger, scheduled_day, idempotency_key, limits_snapshot)
       VALUES ($1, $2, $3, $4::jsonb) ON CONFLICT DO NOTHING RETURNING *`,
      [trigger, trigger === 'scheduled' ? clock.day : null, key,
        JSON.stringify({ ...settings.limitsSnapshot(s), ...EXTRA_LIMITS })],
    );
    if (!result.rowCount) throw new RunError('scheduled_day_claimed');
    return result.rows[0];
  });
}

async function claimRun(pool, { runId, owner }) {
  identifier(owner);
  return transaction(pool, async (client) => {
    await controlLock(client);
    const run = (await client.query(
      'SELECT * FROM security_bot_runs WHERE id = $1 FOR UPDATE', [runId],
    )).rows[0];
    if (!run || !['pending', 'interrupted'].includes(run.status)) throw new RunError('not_claimable');
    if (!(await settings.read(client)).enabled) throw new RunError('service_disabled');
    const { rows: others } = await client.query(
      `SELECT id FROM security_bot_runs WHERE id <> $1
         AND (status IN ('claimed','running','cancelling','interrupted')
           OR cleanup_status IN ('pending','running','retry','failed')) LIMIT 1`, [runId],
    );
    if (others.length) throw new RunError('campaign_busy');
    if (run.status === 'interrupted' && run.cleanup_status !== 'completed') {
      throw new RunError('cleanup_required');
    }
    const { rows } = await client.query(
      `UPDATE security_bot_runs SET
         status = 'claimed', phase = 'preparing', lease_owner = $2,
         lease_generation = lease_generation + 1, heartbeat_at = clock_timestamp(),
         started_at = COALESCE(started_at, clock_timestamp()),
         deadline_at = COALESCE(deadline_at,
           clock_timestamp() + (limits_snapshot->>'max_run_minutes')::int * interval '1 minute'),
         lease_expires_at = clock_timestamp() + $4 * interval '1 second',
         recovery_count = recovery_count + CASE WHEN status = 'interrupted' THEN 1 ELSE 0 END,
         capabilities_revoked_at = NULL, cleanup_status = 'none',
         cleanup_attempts = 0, cleanup_next_at = NULL
       WHERE id = $1 AND lease_generation = $3
         AND cancel_requested_at IS NULL
         AND (deadline_at IS NULL OR deadline_at > clock_timestamp())
         AND (status <> 'interrupted' OR recovery_count < $5) RETURNING *`,
      [runId, owner, run.lease_generation, LEASE_SECONDS, MAX_RECOVERIES],
    );
    if (rows.length) return rows[0];
    // Commit the failed recovery and its cleanup intent, rather than throw
    // inside the transaction and undo the terminal state.
    return fence(client, run, 'failed', 'recovery_exhausted');
  });
}

async function heartbeat(pool, lease) {
  return withLease(pool, lease, async (client) => (await client.query(
    `UPDATE security_bot_runs SET heartbeat_at = clock_timestamp(),
       lease_expires_at = LEAST(deadline_at, clock_timestamp() + $4 * interval '1 second')
     WHERE id = $1 AND lease_generation = $2 AND lease_owner = $3 RETURNING *`,
    [lease.runId, lease.generation, lease.owner, LEASE_SECONDS],
  )).rows[0]);
}

async function setPhase(pool, lease, phase, { arenaRef } = {}) {
  if (!['preparing', 'probing', 'verifying'].includes(phase)) throw new RunError('invalid_phase');
  if (arenaRef !== undefined) identifier(arenaRef);
  return withLease(pool, lease, async (client, run) => {
    const order = ['preparing', 'probing', 'verifying'];
    if (order.indexOf(phase) < order.indexOf(run.phase)
        || order.indexOf(phase) > order.indexOf(run.phase) + 1) throw new RunError('invalid_transition');
    return (await client.query(
      `UPDATE security_bot_runs SET phase = $3,
         status = CASE WHEN $3 = 'preparing' THEN 'claimed' ELSE 'running' END,
         arena_ref = COALESCE($4, arena_ref)
       WHERE id = $1 AND lease_generation = $2 RETURNING *`,
      [run.id, lease.generation, phase, arenaRef || null],
    )).rows[0];
  });
}

async function admitTargetRequest(pool, lease) {
  return withLease(pool, lease, async (client, run) => {
    if (!(await settings.read(client)).enabled) throw new RunError('service_disabled');
    const { rows } = await client.query(
      `UPDATE security_bot_runs SET target_requests = target_requests + 1
       WHERE id = $1 AND lease_generation = $2
         AND target_requests < (limits_snapshot->>'max_target_requests')::int RETURNING *`,
      [run.id, lease.generation],
    );
    if (!rows.length) throw new RunError('request_exhausted');
    return rows[0];
  });
}

// All control mutations lock the current row and CAS the generation. Revoking
// it invalidates both broker capabilities and every outstanding worker token.
async function fence(client, run, status, errorCode = null, actorId = null, outcome = null) {
  return (await client.query(
    `UPDATE security_bot_runs SET status = $3,
       phase = CASE WHEN $3 IN ('interrupted','cancelling') THEN phase ELSE 'finished' END,
       lease_generation = lease_generation + 1, lease_owner = NULL, lease_expires_at = NULL,
       capabilities_revoked_at = clock_timestamp(),
       cancel_requested_at = CASE WHEN $3 = 'cancelling' THEN COALESCE(cancel_requested_at, clock_timestamp()) ELSE cancel_requested_at END,
       cancel_requested_by = CASE WHEN $3 = 'cancelling' THEN $5 ELSE cancel_requested_by END,
       finished_at = CASE WHEN $3 IN ('interrupted','cancelling') THEN NULL ELSE clock_timestamp() END,
       cleanup_status = CASE WHEN cleanup_status = 'completed' THEN 'completed' ELSE 'pending' END,
       cleanup_target_generation = CASE WHEN cleanup_status IN ('none','completed') THEN lease_generation ELSE cleanup_target_generation END,
       cleanup_next_at = clock_timestamp(), outcome = $6, error_message = $4
     WHERE id = $1 AND lease_generation = $2 RETURNING *`,
    [run.id, run.lease_generation, status, errorCode, actorId, outcome],
  )).rows[0];
}

async function cancelRun(pool, { runId, generation: expectedGeneration, actorId = null }) {
  generation(expectedGeneration);
  return transaction(pool, async (client) => {
    await controlLock(client);
    const run = (await client.query(
      'SELECT * FROM security_bot_runs WHERE id = $1 FOR UPDATE', [runId],
    )).rows[0];
    if (!run || run.lease_generation !== expectedGeneration) throw new RunError('lease_lost');
    if (TERMINAL.has(run.status) || run.status === 'cancelling') return run;
    const cancelled = await fence(client, run, 'cancelling', null, actorId, 'cancelled');
    // A previous interrupted attempt may already have been cleaned up.
    if (cancelled.cleanup_status === 'completed') {
      return (await client.query(
        `UPDATE security_bot_runs SET status = 'cancelled', phase = 'finished', finished_at = clock_timestamp()
         WHERE id = $1 AND lease_generation = $2 RETURNING *`,
        [runId, cancelled.lease_generation],
      )).rows[0];
    }
    return cancelled;
  });
}

async function finishRun(pool, lease, { outcome = 'completed' } = {}) {
  if (!['completed', 'failed', 'budget_exhausted', 'time_exhausted', 'request_exhausted', 'calls_exhausted'].includes(outcome)) {
    throw new RunError('invalid_outcome');
  }
  return transaction(pool, async (client) => {
    const run = await lockLease(client, lease);
    if (outcome === 'completed' && run.phase !== 'verifying') throw new RunError('verification_required');
    const { rows: probes } = await client.query(
      'SELECT category, outcome, COUNT(*)::int AS count FROM security_bot_probes WHERE run_id = $1 GROUP BY category, outcome',
      [run.id],
    );
    const coverage = {};
    for (const probe of probes) {
      if (!CATEGORIES.includes(probe.category)) throw new RunError('invalid_category');
      coverage[probe.category] ||= {};
      coverage[probe.category][probe.outcome] = probe.count;
    }
    if (outcome === 'completed' && (CATEGORIES.some((c) => !coverage[c])
        || probes.some((p) => ['skipped', 'unsupported'].includes(p.outcome)))) throw new RunError('coverage_incomplete');
    await client.query(
      'UPDATE security_bot_runs SET coverage_counts = $3::jsonb WHERE id = $1 AND lease_generation = $2',
      [run.id, lease.generation, JSON.stringify(coverage)],
    );
    return fence(client, run, outcome === 'failed' ? 'failed' : 'completed', null, null, outcome);
  });
}

// Restart reconciliation trusts only persisted expiries. An unexpired owner
// in another process is never fenced merely because this process restarted.
async function reconcileExpired(pool) {
  return transaction(pool, async (client) => {
    await controlLock(client);
    const { rows } = await client.query(
      `SELECT * FROM security_bot_runs WHERE status IN ('claimed','running','interrupted')
         AND (lease_expires_at <= clock_timestamp() OR deadline_at <= clock_timestamp()) FOR UPDATE`,
    );
    const changed = [];
    for (const run of rows) {
      const expired = (await client.query(
        'SELECT deadline_at <= clock_timestamp() AS expired FROM security_bot_runs WHERE id = $1', [run.id],
      )).rows[0].expired;
      const failed = expired || run.recovery_count >= MAX_RECOVERIES;
      changed.push(await fence(client, run, failed ? 'failed' : 'interrupted',
        expired ? 'time_exhausted' : failed ? 'recovery_exhausted' : 'lease_expired', null,
        failed ? 'failed' : null));
    }
    return changed;
  });
}

// Cleanup has a separate lease: a cancelled/expired campaign cannot retain
// its execution capability just to tear its environment down.
async function claimCleanup(pool, { owner }) {
  identifier(owner);
  return transaction(pool, async (client) => {
    await controlLock(client);
    await client.query(
      `UPDATE security_bot_runs SET cleanup_status = 'failed', cleanup_owner = NULL,
         cleanup_generation = cleanup_generation + 1, cleanup_expires_at = NULL
       WHERE cleanup_status = 'running' AND cleanup_expires_at <= clock_timestamp()
         AND cleanup_attempts >= $1 RETURNING id`, [MAX_CLEANUP_ATTEMPTS],
    );
    const next = (await client.query(
      `SELECT * FROM security_bot_runs WHERE cleanup_attempts < $1
         AND ((cleanup_status IN ('pending','retry') AND cleanup_next_at <= clock_timestamp())
           OR (cleanup_status = 'running' AND cleanup_expires_at <= clock_timestamp()))
       ORDER BY cleanup_next_at, id LIMIT 1 FOR UPDATE`, [MAX_CLEANUP_ATTEMPTS],
    )).rows[0];
    if (!next) return null;
    return (await client.query(
      `UPDATE security_bot_runs SET cleanup_status = 'running', cleanup_owner = $3,
         cleanup_generation = cleanup_generation + 1, cleanup_attempts = cleanup_attempts + 1,
         cleanup_expires_at = clock_timestamp() + $4 * interval '1 second'
       WHERE id = $1 AND lease_generation = $2 RETURNING *`,
      [next.id, next.lease_generation, owner, LEASE_SECONDS],
    )).rows[0];
  });
}

async function finishCleanup(pool, claim, { success }) {
  if (typeof success !== 'boolean') throw new RunError('invalid_cleanup_result');
  return transaction(pool, async (client) => {
    const { rows } = await client.query(
      `UPDATE security_bot_runs SET
         cleanup_status = CASE WHEN $6 THEN 'completed' WHEN cleanup_attempts >= $7 THEN 'failed' ELSE 'retry' END,
         cleanup_next_at = CASE WHEN $6 THEN NULL ELSE clock_timestamp() + cleanup_attempts * interval '10 seconds' END,
         cleanup_owner = NULL, cleanup_expires_at = NULL,
         status = CASE WHEN $6 AND status = 'cancelling' THEN 'cancelled' ELSE status END,
         phase = CASE WHEN $6 AND status = 'cancelling' THEN 'finished' ELSE phase END,
         finished_at = CASE WHEN $6 AND status = 'cancelling' THEN clock_timestamp() ELSE finished_at END
       WHERE id = $1 AND lease_generation = $2 AND cleanup_generation = $3
         AND cleanup_owner = $4 AND cleanup_status = 'running' AND $5 = 'running'
         AND cleanup_expires_at > clock_timestamp() RETURNING *`,
      [claim.id, claim.lease_generation, claim.cleanup_generation, claim.cleanup_owner,
        claim.cleanup_status, success, MAX_CLEANUP_ATTEMPTS],
    );
    if (!rows.length) throw new RunError('cleanup_lease_lost');
    return rows[0];
  });
}

async function runCleanup(pool, { owner, revokeCapabilities, stopJobs, destroyArena }) {
  if (![revokeCapabilities, stopJobs, destroyArena].every((f) => typeof f === 'function')) {
    throw new RunError('cleanup_adapter_required');
  }
  const claim = await claimCleanup(pool, { owner });
  if (!claim) return null;
  try {
    // Adapters must be idempotent and scope to this run AND the fenced
    // generation, including jobs not yet represented by an arena_ref.
    await revokeCapabilities(claim);
    await stopJobs(claim);
    await destroyArena(claim);
  } catch {
    return finishCleanup(pool, claim, { success: false });
  }
  return finishCleanup(pool, claim, { success: true });
}

module.exports = {
  LEASE_SECONDS, MAX_RECOVERIES, MAX_CLEANUP_ATTEMPTS, EXTRA_LIMITS, CATEGORIES, RunError,
  identifier, transaction, getRun, leaseFor, lockLease, withLease, assertCanDispatch,
  createRun, claimRun, heartbeat, setPhase, admitTargetRequest, cancelRun, finishRun,
  reconcileExpired, reconcileRestart: reconcileExpired, claimCleanup, finishCleanup, runCleanup,
};
