'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const runs = require('../src/services/security-bot/runs');
const settings = require('../src/services/security-bot/settings');
const { database, reset } = require('./lib/security-bot-postgres');

test('security campaigns: durable claims, fencing, cancellation and cleanup on real Postgres', { timeout: 120000 }, async (t) => {
  const db = await database(t, 'security_runs');
  if (!db) return;
  const { pool, schema } = db;
  t.beforeEach(() => reset(pool));
  const create = (options) => runs.createRun(pool, options);
  const claim = (id, owner = 'worker-a') => runs.claimRun(pool, { runId: id, owner });
  const expire = (id) => pool.query(
    "UPDATE security_bot_runs SET lease_expires_at = clock_timestamp() - interval '1 second' WHERE id = $1", [id],
  );
  const clean = () => runs.runCleanup(pool, { owner: 'cleanup',
    revokeCapabilities: async () => {}, stopJobs: async () => {}, destroyArena: async () => {} });

  await t.test('schema replays, disabled reads/startup create no run, identity, key or budget', async () => {
    await pool.query(schema);
    await settings.write(pool, { enabled: false });
    const users = (await pool.query('SELECT COUNT(*) FROM users')).rows[0].count;
    await assert.rejects(create(), { code: 'service_disabled' });
    assert.equal(await runs.getRun(pool, 999999), null);
    assert.equal((await pool.query('SELECT COUNT(*) FROM security_bot_runs')).rows[0].count, '0');
    assert.equal((await pool.query('SELECT COUNT(*) FROM security_bot_daily_budgets')).rows[0].count, '0');
    assert.equal((await pool.query('SELECT COUNT(*) FROM users')).rows[0].count, users);
  });

  await t.test('manual keys are idempotent; scheduler ticks claim one UTC day through the unique index', async () => {
    const [a, b] = await Promise.all([create({ idempotencyKey: 'manual:click' }), create({ idempotencyKey: 'manual:click' })]);
    assert.equal(a.id, b.id);
    const manual = await create();
    assert.notEqual(a.idempotency_key, manual.idempotency_key);
    await assert.rejects(create({ idempotencyKey: '' }), { code: 'invalid_identifier' });
    const [scheduled, repeated] = await Promise.all([create({ trigger: 'scheduled' }), create({ trigger: 'scheduled' })]);
    assert.equal(scheduled.id, repeated.id);
    await assert.rejects(create({ trigger: 'scheduled', idempotencyKey: 'other-daily-claim' }), { code: 'scheduled_day_claimed' });
    await assert.rejects(pool.query(
      "INSERT INTO security_bot_runs (trigger, scheduled_day) VALUES ('scheduled', $1)", [scheduled.scheduled_day],
    ), { code: '23505' });
    await assert.rejects(create({ trigger: 'scheduled', scheduledDay: '2000-01-01' }), { code: 'only_current_utc_day' });
    await assert.rejects(create({ trigger: 'scheduled', idempotencyKey: a.idempotency_key }), { code: 'idempotency_conflict' });
  });

  await t.test('separate connections cannot claim two campaigns, or claim the same run twice', async () => {
    const [a, b] = await Promise.all([create(), create()]);
    const claims = await Promise.allSettled([claim(a.id), claim(b.id, 'worker-b')]);
    assert.equal(claims.filter((r) => r.status === 'fulfilled').length, 1);
    assert.equal(claims.find((r) => r.status === 'rejected').reason.code, 'campaign_busy');
    const held = claims.find((r) => r.status === 'fulfilled').value;
    assert.equal(held.lease_generation, 1);
    await assert.rejects(claim(held.id), { code: 'not_claimable' });
    const heartbeat = await runs.heartbeat(pool, runs.leaseFor(held));
    assert.equal(heartbeat.lease_generation, 1);
    assert.equal(heartbeat.started_at.getTime(), held.started_at.getTime());
  });

  await t.test('all worker mutations fail after expiry; a callback crossing expiry rolls back', async () => {
    const run = await claim((await create()).id);
    const lease = runs.leaseFor(run);
    await pool.query("UPDATE security_bot_runs SET lease_expires_at = clock_timestamp() + interval '50 milliseconds' WHERE id = $1", [run.id]);
    await assert.rejects(runs.withLease(pool, lease, async (client) => {
      await client.query('UPDATE security_bot_runs SET target_requests = 99 WHERE id = $1', [run.id]);
      await client.query('SELECT pg_sleep(0.1)');
    }), { code: 'lease_lost' });
    assert.equal((await runs.getRun(pool, run.id)).target_requests, 0);
    for (const operation of [
      () => runs.heartbeat(pool, lease), () => runs.setPhase(pool, lease, 'probing'),
      () => runs.admitTargetRequest(pool, lease), () => runs.finishRun(pool, lease),
      () => runs.assertCanDispatch(pool, lease),
    ]) await assert.rejects(operation(), { code: 'lease_lost' });
  });

  await t.test('preparing/probing/verifying map onto valid statuses; request limits persist', async () => {
    await settings.write(pool, { max_target_requests: 2 });
    const run = await claim((await create()).id);
    const lease = runs.leaseFor(run);
    assert.equal(run.status, 'claimed');
    assert.equal(run.phase, 'preparing');
    await assert.rejects(runs.setPhase(pool, lease, 'verifying'), { code: 'invalid_transition' });
    assert.equal((await runs.setPhase(pool, lease, 'probing', { arenaRef: 'arena/test' })).status, 'running');
    await assert.rejects(runs.setPhase(pool, lease, 'preparing'), { code: 'invalid_transition' });
    await assert.rejects(runs.finishRun(pool, lease), { code: 'verification_required' });
    await Promise.all([runs.admitTargetRequest(pool, lease), runs.admitTargetRequest(pool, lease)]);
    await assert.rejects(runs.admitTargetRequest(pool, lease), { code: 'request_exhausted' });
    await runs.setPhase(pool, lease, 'verifying');
    await assert.rejects(runs.finishRun(pool, lease), { code: 'coverage_incomplete' });
    await runs.withLease(pool, lease, async (client) => {
      for (const category of runs.CATEGORIES) await client.query(
        "INSERT INTO security_bot_probes (run_id, category, probe_key, outcome) VALUES ($1, $2, 'baseline', 'passed')",
        [run.id, category],
      );
    });
    const done = await runs.finishRun(pool, lease);
    assert.equal(done.status, 'completed');
    assert.equal(done.cleanup_status, 'pending');
    assert.equal(Object.keys(done.coverage_counts).length, 6);
    assert.ok(done.capabilities_revoked_at);
    await assert.rejects(runs.heartbeat(pool, lease), { code: 'lease_lost' });
    await assert.rejects(claim((await create()).id), { code: 'campaign_busy' });
    await clean();
    assert.equal((await claim((await create()).id)).status, 'claimed');
  });

  await t.test('cancellation fences inference/requests immediately and durably retries teardown', async () => {
    const run = await claim((await create()).id);
    const lease = runs.leaseFor(run);
    const cancelled = await runs.cancelRun(pool, { runId: run.id, generation: run.lease_generation });
    assert.equal(cancelled.status, 'cancelling');
    assert.equal(cancelled.cleanup_target_generation, lease.generation);
    assert.ok(cancelled.capabilities_revoked_at);
    for (const op of [() => runs.assertCanDispatch(pool, lease), () => runs.admitTargetRequest(pool, lease)]) {
      await assert.rejects(op(), { code: 'lease_lost' });
    }
    const calls = [];
    const adapter = { owner: 'cleanup', revokeCapabilities: async (r) => { calls.push(['revoke', r.cleanup_target_generation]); },
      stopJobs: async () => { calls.push(['stop']); }, destroyArena: async () => { throw new Error('private secret-shaped provider error'); } };
    const retry = await runs.runCleanup(pool, adapter);
    assert.equal(retry.status, 'cancelling');
    assert.equal(retry.cleanup_status, 'retry');
    assert.equal(retry.error_message, null, 'never persist adapter exception text');
    await pool.query('UPDATE security_bot_runs SET cleanup_next_at = clock_timestamp() WHERE id = $1', [run.id]);
    adapter.destroyArena = async () => { calls.push(['destroy']); };
    const done = await runs.runCleanup(pool, adapter);
    assert.equal(done.status, 'cancelled');
    assert.equal(done.cleanup_status, 'completed');
    assert.equal(done.cleanup_attempts, 2);
    assert.deepEqual(calls, [['revoke', 1], ['stop'], ['revoke', 1], ['stop'], ['destroy']]);
  });

  await t.test('cancelling a pending run never makes it claimable', async () => {
    const run = await create();
    await runs.cancelRun(pool, { runId: run.id, generation: 0 });
    await assert.rejects(claim(run.id), { code: 'not_claimable' });
    assert.equal((await clean()).status, 'cancelled');
  });

  await t.test('restart fences expired attempts only; recovery needs cleanup, preserves limits/time/counts, and is bounded', async () => {
    const run = await claim((await create()).id);
    const lease = runs.leaseFor(run);
    await runs.admitTargetRequest(pool, lease);
    assert.deepEqual(await runs.reconcileRestart(pool), [], 'another process with a live lease survives restart');
    await expire(run.id);
    const [interrupted] = await runs.reconcileRestart(pool);
    assert.equal(interrupted.status, 'interrupted');
    assert.ok(interrupted.lease_generation > lease.generation);
    await assert.rejects(claim(run.id), { code: 'cleanup_required' });
    await clean();
    const recovered = await claim(run.id, 'worker-after-restart');
    assert.equal(recovered.recovery_count, 1);
    assert.equal(recovered.target_requests, 1);
    assert.equal(recovered.deadline_at.getTime(), run.deadline_at.getTime());
    assert.deepEqual(recovered.limits_snapshot, run.limits_snapshot);
    await assert.rejects(runs.withLease(pool, lease, async () => {}), { code: 'lease_lost' });
    await expire(run.id);
    const [failed] = await runs.reconcileExpired(pool);
    assert.equal(failed.status, 'failed');
    assert.equal(failed.error_message, 'recovery_exhausted');
    await assert.rejects(claim(run.id), { code: 'not_claimable' });
  });

  await t.test('deadline expiry cannot be extended by heartbeat or recovery', async () => {
    const run = await claim((await create()).id);
    await pool.query("UPDATE security_bot_runs SET deadline_at = clock_timestamp() - interval '1 second' WHERE id = $1", [run.id]);
    await assert.rejects(runs.heartbeat(pool, runs.leaseFor(run)), { code: 'time_exhausted' });
    const [failed] = await runs.reconcileExpired(pool);
    assert.equal(failed.status, 'failed');
    assert.equal(failed.error_message, 'time_exhausted');
    assert.equal(failed.cleanup_status, 'pending');
  });

  await t.test('cleanup workers are fenced independently, including crashed workers and finite retry exhaustion', async () => {
    const run = await claim((await create()).id);
    await runs.cancelRun(pool, { runId: run.id, generation: run.lease_generation });
    const first = await runs.claimCleanup(pool, { owner: 'old-cleaner' });
    assert.equal(await runs.claimCleanup(pool, { owner: 'other-cleaner' }), null);
    await pool.query("UPDATE security_bot_runs SET cleanup_expires_at = clock_timestamp() - interval '1 second' WHERE id = $1", [run.id]);
    const next = await runs.claimCleanup(pool, { owner: 'new-cleaner' });
    assert.ok(next.cleanup_generation > first.cleanup_generation);
    await assert.rejects(runs.finishCleanup(pool, first, { success: true }), { code: 'cleanup_lease_lost' });
    await runs.finishCleanup(pool, next, { success: false });
    await pool.query('UPDATE security_bot_runs SET cleanup_next_at = clock_timestamp() WHERE id = $1', [run.id]);
    const last = await runs.claimCleanup(pool, { owner: 'last-cleaner' });
    const failed = await runs.finishCleanup(pool, last, { success: false });
    assert.equal(failed.cleanup_status, 'failed');
    assert.equal(await runs.claimCleanup(pool, { owner: 'too-many' }), null);
    await assert.rejects(claim((await create()).id), { code: 'campaign_busy' });
  });
});
