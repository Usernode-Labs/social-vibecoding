'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { execFileSync } = require('node:child_process');
const runs = require('../src/services/security-bot/runs');
const settings = require('../src/services/security-bot/settings');
const accounting = require('../src/services/security-bot/accounting');
const { SECURITY_BOT_BUDGET_LOCK } = require('../src/services/advisory-locks');
const { database, reset } = require('./lib/security-bot-postgres');

const request = (key, cost = '2', role = 'attacker') => ({
  idempotencyKey: key, logicalCallKey: key, role,
  promptTokens: 100, outputTokens: 100, credentialRevision: '0123456789abcdef',
  quote: { model: 'z-ai/glm-5.3-flash', provider: 'fixture-provider', upperBound: true,
    validUntil: new Date(Date.now() + 240000).toISOString(),
    pricing: { prompt: '0', completion: '0', request: cost } },
});

test('security accounting: combined reservations and settlement on real Postgres', { timeout: 120000 }, async (t) => {
  const db = await database(t, 'security_accounting');
  if (!db) return;
  const { pool } = db;
  t.beforeEach(() => reset(pool));
  const start = async (options) => runs.claimRun(pool, {
    runId: (await runs.createRun(pool, options)).id, owner: 'controller',
  });
  const reserve = (lease, key, cost, role) => accounting.reserveInvocation(pool, lease, request(key, cost, role));
  const dispatch = (lease, call) => accounting.markDispatched(pool, lease, call.id);
  const ledger = async () => (await pool.query('SELECT * FROM security_bot_daily_budgets ORDER BY day DESC LIMIT 1')).rows[0];
  const cleanup = () => runs.runCleanup(pool, { owner: 'cleanup',
    revokeCapabilities: async () => {}, stopJobs: async () => {}, destroyArena: async () => {} });

  await t.test('read while disabled does not provision a budget; finite provider pricing includes all billable token classes', async () => {
    await settings.write(pool, { enabled: false });
    assert.equal((await accounting.getBudget(pool)).daily_usd, '0');
    assert.equal((await pool.query('SELECT COUNT(*) FROM security_bot_daily_budgets')).rows[0].count, '0');
    const q = request('estimate');
    q.promptTokens = 1000;
    q.outputTokens = 500; // reasoning is within this maximum
    q.quote.pricing = { prompt: '0.000001', completion: '0.000002', internal_reasoning: '0.000003',
      input_cache_write: '0.000001', input_cache_read: '0.0000001', request: '0.001', image: '0' };
    assert.equal(accounting.estimateInvocation(q).reservedUsd, '0.0045');
    q.quote.pricing = { prompt: '1e-9', completion: '1e-9', request: '0' };
    assert.equal(accounting.estimateInvocation(q).reservedUsd, '0.0001', 'round an upper bound up, never down');
    for (const pricing of [
      { prompt: null, completion: '1', request: '0' }, { prompt: '-1', completion: '1', request: '0' },
      { prompt: '0', completion: Infinity, request: '0' }, { prompt: '0', completion: '0' },
      { prompt: '0', completion: '0', request: '0', web_search: '1' },
      { prompt: '0', completion: '0', request: '0', overrides: [{}] },
    ]) {
      q.quote.pricing = pricing;
      assert.throws(() => accounting.estimateInvocation(q), { code: 'pricing_unbounded' });
    }
    q.quote = { ...request('x').quote, upperBound: false };
    assert.throws(() => accounting.estimateInvocation(q), { code: 'pricing_unbounded' });
  });

  await t.test('attacker and defender concurrent reservations share the $5 daily cap under the budget lock', async () => {
    const run = await start();
    const lease = runs.leaseFor(run);
    const results = await Promise.all([
      reserve(lease, 'parallel-a', '2', 'attacker'), reserve(lease, 'parallel-b', '2', 'defender'),
      reserve(lease, 'parallel-c', '2', 'defender'),
    ]);
    assert.equal(results.filter((r) => r.admitted).length, 2);
    assert.equal(results.find((r) => !r.admitted).reason, 'daily_budget_exhausted');
    assert.equal((await ledger()).reserved_usd, '4.0000');
    assert.equal((await ledger()).spent_usd, '0.0000');
    for (const { call, admitted } of results) {
      assert.equal(call.cost_usd, null);
      assert.equal(call.outcome, admitted ? 'unreconciled' : 'skipped-budget');
    }
    const committed = (await accounting.getBudget(pool)).daily_usd;
    assert.equal(committed, '4.0000');
  });

  await t.test('admission waits for SECURITY_BOT_BUDGET_LOCK held by another database connection', async () => {
    const lease = runs.leaseFor(await start());
    const holder = await pool.connect();
    await holder.query('BEGIN');
    await holder.query('SELECT pg_advisory_xact_lock($1)', [SECURITY_BOT_BUDGET_LOCK]);
    let finished = false;
    const pending = reserve(lease, 'locked').then((r) => { finished = true; return r; });
    try {
      let waiting = false;
      for (let i = 0; i < 100 && !waiting; i += 1) {
        waiting = (await pool.query("SELECT EXISTS (SELECT 1 FROM pg_stat_activity WHERE datname = current_database() AND wait_event = 'advisory') AS waiting")).rows[0].waiting;
        if (!waiting) await new Promise((resolve) => setTimeout(resolve, 5));
      }
      assert.equal(waiting, true);
      assert.equal(finished, false);
      assert.equal((await pool.query('SELECT COUNT(*) FROM security_bot_model_calls')).rows[0].count, '0');
    } finally {
      await holder.query('ROLLBACK');
      holder.release();
    }
    assert.equal((await pending).admitted, true);
  });

  await t.test('reservation and dispatch are both idempotent, with unique physical attempts', async () => {
    const lease = runs.leaseFor(await start());
    const a = await reserve(lease, 'single');
    const b = await reserve(lease, 'single');
    assert.equal(b.admitted, false);
    assert.equal(b.call.id, a.call.id);
    assert.equal((await ledger()).reserved_usd, '2.0000');
    await dispatch(lease, a.call);
    await assert.rejects(dispatch(lease, a.call), { code: 'dispatch_not_admitted' });
    const conflict = request('different');
    conflict.logicalCallKey = 'single';
    await assert.rejects(accounting.reserveInvocation(pool, lease, conflict), { code: 'idempotency_conflict' });
    await assert.rejects(accounting.reserveInvocation(pool, lease, { ...request('retry'), attempt: 2 }), { code: 'invalid_retry' });
  });

  await t.test('known usage releases only the unused bound; repeated settlement cannot lower the daily total', async () => {
    const lease = runs.leaseFor(await start());
    const { call } = await reserve(lease, 'settle');
    await dispatch(lease, call);
    const result = { costUsd: '0.40001', usage: { promptTokens: 90, outputTokens: 80, reasoningTokens: 60 }, generationId: 'gen-known' };
    await accounting.settleInvocation(pool, lease, call.id, result);
    await accounting.settleInvocation(pool, lease, call.id, result);
    const row = await ledger();
    assert.equal(row.spent_usd, '0.4001');
    assert.equal(row.reserved_usd, '0.0000');
    assert.equal(row.released_usd, '1.5999');
    assert.equal((await runs.getRun(pool, lease.runId)).spend_usd, '0.4001');
    await assert.rejects(accounting.settleInvocation(pool, lease, call.id, { costUsd: '0.1' }), { code: 'settlement_conflict' });
    assert.equal((await ledger()).spent_usd, '0.4001');
    const persisted = (await pool.query('SELECT * FROM security_bot_model_calls WHERE id = $1', [call.id])).rows[0];
    assert.equal(persisted.output_tokens, 80, 'reasoning counted within output, rather than added twice');
    assert.equal(persisted.reasoning_tokens, 60);
  });

  await t.test('timeouts and unknown usage preserve their full reservation until explicit provider reconciliation', async () => {
    const lease = runs.leaseFor(await start());
    const { call } = await reserve(lease, 'timeout', '3', 'defender');
    await dispatch(lease, call);
    const unknown = await accounting.settleInvocation(pool, lease, call.id, {
      costUsd: null, outcome: 'cancelled', generationId: 'gen-timeout', errorCode: 'provider_timeout',
    });
    assert.equal(unknown.outcome, 'unreconciled');
    assert.equal(unknown.cost_usd, null);
    assert.equal((await ledger()).reserved_usd, '3.0000');
    assert.equal((await reserve(lease, 'too-large', '3')).reason, 'daily_budget_exhausted');
    await assert.rejects(accounting.reconcileInvocation(pool, lease, call.id, { costUsd: '1', generationId: 'wrong-generation' }), { code: 'generation_conflict' });
    await accounting.reconcileInvocation(pool, lease, call.id, { costUsd: '1.5', generationId: 'gen-timeout' });
    assert.equal((await ledger()).reserved_usd, '0.0000');
    assert.equal((await ledger()).spent_usd, '1.5000');
  });

  await t.test('every physical retry has its own bound and attempt record; at most two retries', async () => {
    const lease = runs.leaseFor(await start());
    const base = request('retry-1', '1');
    base.logicalCallKey = 'logical-request';
    let first;
    for (let attempt = 1; attempt <= 3; attempt += 1) {
      const admission = await accounting.reserveInvocation(pool, lease, {
        ...base, idempotencyKey: `retry-${attempt}`, attempt,
      });
      assert.equal(admission.admitted, true);
      await dispatch(lease, admission.call);
      first ||= admission.call;
      await accounting.settleInvocation(pool, lease, admission.call.id, { costUsd: null, errorCode: 'provider_timeout' });
    }
    assert.equal((await ledger()).reserved_usd, '3.0000');
    await assert.rejects(accounting.reserveInvocation(pool, lease, { ...base, idempotencyKey: 'retry-4', attempt: 4 }), { code: 'retry_exhausted' });
    await accounting.reconcileInvocation(pool, lease, first.id, { costUsd: '0.2', outcome: 'error' });
    assert.equal((await ledger()).reserved_usd, '2.0000');
    assert.equal((await ledger()).spent_usd, '0.2000');
  });

  await t.test('stale leases cannot reserve, dispatch or settle; current recovery reconciles the old attempt without resetting spend', async () => {
    const run = await start();
    const old = runs.leaseFor(run);
    const { call } = await reserve(old, 'before-restart', '3');
    await dispatch(old, call);
    await pool.query("UPDATE security_bot_runs SET lease_expires_at = clock_timestamp() - interval '1 second' WHERE id = $1", [run.id]);
    for (const op of [
      () => reserve(old, 'after-expiry'), () => dispatch(old, call),
      () => accounting.settleInvocation(pool, old, call.id, { costUsd: '0.1' }),
    ]) await assert.rejects(op(), { code: 'lease_lost' });
    await runs.reconcileRestart(pool);
    assert.equal((await ledger()).reserved_usd, '3.0000');
    await cleanup();
    const current = runs.leaseFor(await runs.claimRun(pool, { runId: run.id, owner: 'restarted' }));
    await assert.rejects(accounting.reconcileInvocation(pool, old, call.id, { costUsd: '0.1' }), { code: 'lease_lost' });
    await assert.rejects(accounting.settleInvocation(pool, current, call.id, { costUsd: '0.1' }), { code: 'call_attempt_fenced' });
    assert.equal((await reserve(current, 'before-restart', '3')).admitted, false);
    assert.equal((await reserve(current, 'restart-new-call', '3')).reason, 'daily_budget_exhausted');
    await accounting.reconcileInvocation(pool, current, call.id, { costUsd: '1.2' });
    assert.equal((await ledger()).spent_usd, '1.2000');
    assert.equal((await ledger()).reserved_usd, '0.0000');
    const freshProcess = execFileSync(process.execPath, ['-e', `
      const {Pool}=require('pg');
      const p=new Pool({connectionString:process.env.SECURITY_TEST_DSN});
      require('./src/services/security-bot/accounting').getBudget(p)
        .then(r=>process.stdout.write(JSON.stringify(r))).finally(()=>p.end());
    `], { cwd: require('node:path').resolve(__dirname, '..'), env: { ...process.env, SECURITY_TEST_DSN: db.url }, encoding: 'utf8' });
    assert.equal(JSON.parse(freshProcess).daily_usd, '1.2000');
  });

  await t.test('manual reruns and scheduled runs share the day; cancellation never releases a potentially dispatched charge', async () => {
    const run = await start({ trigger: 'scheduled' });
    const lease = runs.leaseFor(run);
    const { call } = await reserve(lease, 'scheduled-cost', '4');
    await dispatch(lease, call);
    await accounting.settleInvocation(pool, lease, call.id, { costUsd: '4' });
    const held = await reserve(lease, 'cancel-during-call', '1', 'defender');
    await dispatch(lease, held.call);
    const cancelling = await runs.cancelRun(pool, { runId: run.id, generation: lease.generation });
    await assert.rejects(reserve(lease, 'after-cancel', '0.1'), { code: 'lease_lost' });
    await assert.rejects(accounting.settleInvocation(pool, lease, held.call.id, { costUsd: '0' }), { code: 'lease_lost' });
    await cleanup();
    const manual = runs.leaseFor(await start());
    assert.equal((await reserve(manual, 'manual-rerun', '0.1')).reason, 'daily_budget_exhausted');
    await accounting.reconcileInvocation(pool, { runId: run.id, generation: cancelling.lease_generation }, held.call.id, { costUsd: '0.2', outcome: 'cancelled' });
    assert.equal((await ledger()).spent_usd, '4.2000');
    assert.equal((await reserve(manual, 'manual-allowed', '0.8')).admitted, true);
    assert.equal((await reserve(manual, 'manual-over', '0.0001')).reason, 'daily_budget_exhausted');
  });

  await t.test('weekly backstop includes outstanding uncertainty from older weeks', async () => {
    const lease = runs.leaseFor(await start());
    await pool.query("INSERT INTO security_bot_daily_budgets (day, reserved_usd) VALUES ((clock_timestamp() AT TIME ZONE 'UTC')::date - 15, 34)");
    const denied = await reserve(lease, 'weekly-over', '2');
    assert.equal(denied.reason, 'weekly_budget_exhausted');
    assert.equal((await accounting.getBudget(pool)).weekly_usd, '34.0000');
    assert.equal((await reserve(lease, 'weekly-fits', '1')).admitted, true);
  });

  await t.test('UTC rollover assigns new reservations to today and settles older calls on their original day', async () => {
    const lease = runs.leaseFor(await start());
    const { call } = await reserve(lease, 'old-day', '4');
    await dispatch(lease, call);
    // Move a fixture invocation and its matching ledger to yesterday. No
    // injectable application clock can let a real caller choose its day.
    await pool.query("UPDATE security_bot_model_calls SET budget_day = budget_day - 1 WHERE id = $1", [call.id]);
    await pool.query('UPDATE security_bot_daily_budgets SET day = day - 1');
    const today = await reserve(lease, 'new-day', '4');
    assert.equal(today.admitted, true);
    await accounting.settleInvocation(pool, lease, call.id, { costUsd: '2' });
    const rows = (await pool.query('SELECT * FROM security_bot_daily_budgets ORDER BY day')).rows;
    assert.equal(rows[0].spent_usd, '2.0000');
    assert.equal(rows[0].reserved_usd, '0.0000');
    assert.equal(rows[1].reserved_usd, '4.0000');
    assert.equal(rows[1].spent_usd, '0.0000');
  });

  await t.test('stale pricing, token/call ceilings, disabled service and malformed metadata refuse admission', async () => {
    const lease = runs.leaseFor(await start());
    const stale = request('stale');
    stale.quote.validUntil = new Date(Date.now() - 10000).toISOString();
    await assert.rejects(accounting.reserveInvocation(pool, lease, stale), { code: 'pricing_expired' });
    const tooLong = { ...request('output-too-large'), outputTokens: 4097 };
    await assert.rejects(accounting.reserveInvocation(pool, lease, tooLong), { code: 'output_limit_exceeded' });
    await assert.rejects(accounting.reserveInvocation(pool, lease, { ...request('secret'), credentialRevision: 'sk-real-key-do-not-store' }), { code: 'invalid_credential_revision' });
    await pool.query('UPDATE security_bot_runs SET defender_calls = 60 WHERE id = $1', [lease.runId]);
    assert.equal((await reserve(lease, 'defender-ceiling', '0.01', 'defender')).reason, 'calls_exhausted');
    await settings.write(pool, { enabled: false });
    await assert.rejects(reserve(lease, 'disabled'), { code: 'service_disabled' });
    assert.equal((await pool.query('SELECT COUNT(*) FROM security_bot_daily_budgets')).rows[0].count, '0');
  });

  await t.test('actual provider overruns are recorded truthfully and stop further admissions', async () => {
    const lease = runs.leaseFor(await start());
    const { call } = await reserve(lease, 'overrun', '1');
    await dispatch(lease, call);
    const settled = await accounting.settleInvocation(pool, lease, call.id, { costUsd: '1.1' });
    assert.equal(settled.error_code, 'pricing_bound_exceeded');
    assert.equal((await ledger()).spent_usd, '1.1000');
    await assert.rejects(reserve(lease, 'after-overrun', '0.1'), { code: 'accounting_uncertain' });
  });

  await t.test('reserved total tokens and attacker invocations are finite independent of the dollar budget', async () => {
    await settings.write(pool, { max_attacker_calls: 1 });
    const lease = runs.leaseFor(await start());
    const large = { ...request('bounded-tokens', '0.01'), promptTokens: 999000, outputTokens: 1000 };
    assert.equal((await accounting.reserveInvocation(pool, lease, large)).admitted, true);
    assert.equal((await reserve(lease, 'over-tokens', '0.01', 'defender')).reason, 'tokens_exhausted');
    // A known, small provider charge frees unused token bounds, while the
    // physical attacker invocation still counts against its own ceiling.
    const call = (await pool.query("SELECT * FROM security_bot_model_calls WHERE idempotency_key = 'bounded-tokens'")).rows[0];
    await dispatch(lease, call);
    await accounting.settleInvocation(pool, lease, call.id, { costUsd: '0.001', usage: { promptTokens: 1, outputTokens: 1 } });
    assert.equal((await reserve(lease, 'over-attacker-calls', '0.01')).reason, 'calls_exhausted');
    assert.equal((await reserve(lease, 'defender-room', '0.01', 'defender')).admitted, true);
  });

  await t.test('already reserved calls are stopped if settings shrink before dispatch', async () => {
    const lease = runs.leaseFor(await start());
    const { call } = await reserve(lease, 'admitted-before-lower-cap', '2');
    await settings.write(pool, { daily_budget_usd: '1.00' });
    await assert.rejects(dispatch(lease, call), { code: 'budget_changed' });
    await accounting.reconcileInvocation(pool, lease, call.id, { costUsd: '0', outcome: 'cancelled' });
    assert.equal((await ledger()).spent_usd, '0.0000');
    assert.equal((await ledger()).reserved_usd, '0.0000');
  });

  await t.test('the invocation wrapper calls a scripted transport once, reserves first and keeps ambiguous errors', async () => {
    const lease = runs.leaseFor(await start());
    let calls = 0;
    const transport = async () => {
      calls += 1;
      assert.equal((await ledger()).reserved_usd, '2.0000');
      return { costUsd: '0.25', usage: { promptTokens: 50, outputTokens: 50 }, result: 'scripted' };
    };
    const result = await accounting.invokeAccounted(pool, lease, request('wrapped'), transport);
    assert.equal(result.result, 'scripted');
    await accounting.invokeAccounted(pool, lease, request('wrapped'), transport);
    assert.equal(calls, 1);
    await assert.rejects(accounting.invokeAccounted(pool, lease, request('ambiguous'), async () => {
      throw new Error('test transport timed out; do not persist raw payloads');
    }));
    assert.equal((await ledger()).reserved_usd, '2.0000');
    assert.equal((await ledger()).spent_usd, '0.2500');
    const cancelled = new AbortController(); cancelled.abort();
    await accounting.invokeAccounted(pool, lease, request('never-dispatched'), transport, { signal: cancelled.signal });
    assert.equal(calls, 1);
    assert.equal((await ledger()).reserved_usd, '2.0000');
  });

  await t.test('cancellation during a scripted inference aborts its capability and preserves the unknown bill', async () => {
    const run = await start();
    const lease = runs.leaseFor(run);
    await assert.rejects(accounting.invokeAccounted(pool, lease, request('in-flight'), async ({ signal }) => {
      await runs.cancelRun(pool, { runId: run.id, generation: lease.generation });
      await new Promise((resolve, reject) => {
        signal.addEventListener('abort', () => reject(new Error('cancelled')), { once: true });
      });
    }));
    assert.equal((await ledger()).reserved_usd, '2.0000');
    assert.equal((await pool.query('SELECT outcome FROM security_bot_model_calls')).rows[0].outcome, 'unreconciled');
  });
});
