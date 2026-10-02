'use strict';

// Actual disposable PostgreSQL. Captured facts and gate services are injected;
// actual browser/unit Job evidence remains in the dedicated Kubernetes suites.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { randomUUID } = require('node:crypto');
const { setTimeout: delay } = require('node:timers/promises');
const { enabled, readPreviewPostgresFixture } = require('./lib/preview-postgres-fixture');
const { createExecutionDatabase } = require('./lib/execution-database');
const { addHandoffColumns } = require('./lib/cli-handoff-fixture');
const { addChecksTables } = require('./lib/cli-checks-fixture');
const { createChecksSettlement, GATE } = require('../src/services/cli-preview-handoff/settlement');
const { createExecutionStore } = require('../src/services/execution/store');
const { createExecutionWorker } = require('../src/services/execution/worker');
const { createSessionDecisionRuntime } = require('../src/services/decision-runtime');
const history = require('../src/services/check-history');
const { checkKey } = require('../src/services/app-manifest');

const HEAD = 'a'.repeat(40);
const NEXT = 'b'.repeat(40);
const ROW = { checkKey: checkKey('Health', '/health'), name: 'Health', path: '/health', passes: 3, fails: 0 };

async function fixture(t) {
  const verified = await readPreviewPostgresFixture();
  const db = await createExecutionDatabase(verified.databaseUrl);
  t.after(() => db.close());
  await addHandoffColumns(db.pool);
  await addChecksTables(db.pool);

  async function admit(sessionId = 1) {
    const runId = randomUUID();
    const flowId = randomUUID();
    await db.pool.query(`INSERT INTO chat_sessions (id, handoff_head_sha, handoff_uploaded_sha,
      checks_commit_sha, staging_commit_sha, check_state, check_phase)
      VALUES ($1,$2,$2,$2,$2,'pending','testing')`, [sessionId, HEAD]);
    await db.pool.query(`INSERT INTO cli_preview_handoffs
      (session_id, head_sha, started_status, admission_id, flow_id, phase)
      VALUES ($1,$2,'active',$3,$4,'checking')`, [sessionId, HEAD, randomUUID(), flowId]);
    await db.pool.query(`INSERT INTO preview_flows (id, session_id, generation, head_sha, started_status, state)
      VALUES ($1,$2,1,$3,'active','ready')`, [flowId, sessionId, HEAD]);
    await db.pool.query('INSERT INTO preview_flow_heads (session_id, flow_id) VALUES ($1,$2)', [sessionId, flowId]);
    await db.pool.query('INSERT INTO preview_bindings (session_id, observed) VALUES ($1,$2)',
      [sessionId, JSON.stringify({ flowId, receipt: { runtimeName: 'serving' } })]);
    await db.pool.query(`INSERT INTO preview_operations
      (session_id, run_id, revision, desired_revision, phase, state)
      VALUES ($1,$2,$3,$3,'capture','running')`, [sessionId, runId, HEAD]);
    await db.pool.query(`INSERT INTO check_runs (run_id, session_id, commit_sha, owner, manifest)
      VALUES ($1,$2,$3,$5,$4)`, [runId, sessionId, HEAD,
      JSON.stringify({ durableCli: true, launched: true, cliFlowId: flowId }),
      require('../src/services/check-runs').selfOwner()]);
    return {
      sessionId, runId, headSha: HEAD,
      result: { state: 'passing', results: [{ index: 0, status: 'pass' }] }, history: [ROW],
    };
  }

  async function counts() {
    return {
      history: (await db.pool.query('SELECT * FROM app_check_history')).rows,
      receipts: (await db.pool.query('SELECT * FROM cli_check_settlement_receipts')).rows,
      traces: (await db.pool.query('SELECT * FROM cli_check_settlement_decisions')).rows,
      work: (await db.pool.query('SELECT * FROM execution_work_requests ORDER BY queue_position')).rows,
      sessions: (await db.pool.query('SELECT * FROM chat_sessions ORDER BY id')).rows,
    };
  }
  return { ...db, admit, counts };
}

function loseCommitReply(pool) {
  let lost = false;
  return {
    query: (...args) => pool.query(...args),
    async connect() {
      const client = await pool.connect();
      return {
        async query(...args) {
          const result = await client.query(...args);
          if (!lost && args[0] === 'COMMIT') {
            lost = true;
            throw new Error('Injected lost COMMIT acknowledgment');
          }
          return result;
        },
        release: () => client.release(),
      };
    },
  };
}

test('merge delivery remains retryable until GitHub initialization recovers and policy is invoked', { skip: !enabled }, async t => {
  const f = await fixture(t);
  const github = require('../src/services/github');
  assert.equal(github.getInitializationStatus(), 'uninitialized');
  t.after(() => github.init({}));
  const input = await f.admit();
  await f.pool.query("UPDATE chat_sessions SET status = 'promoted', reviewed_head_sha = $1 WHERE id = 1", [HEAD]);
  await createChecksSettlement(f.pool, {}).settle(input);
  const store = createExecutionStore(f.pool);
  let calls = 0;

  async function deliver() {
    // A new execution owner represents worker restart. Only the policy call is
    // substituted; SDK initialization, permission and delivery persistence are real.
    const owner = createChecksSettlement(f.pool, {}, {
      store,
      async merge(appId) {
        assert.equal(github.isEnabled(), true);
        assert.equal(appId, 1);
        calls++;
      },
    });
    const worker = createExecutionWorker({ store, handlers: owner.handlers, concurrency: 1 });
    await worker.tick();
    await worker.drain();
    return (await f.counts()).work[0];
  }

  const uninitialized = await deliver();
  assert.equal(uninitialized.status, 'queued');
  assert.equal(uninitialized.last_code, 'github_uninitialized');
  assert.equal(calls, 0);

  await github.init({});
  await f.pool.query('UPDATE execution_work_requests SET due_at = NOW() WHERE id = $1', [uninitialized.id]);
  const unavailable = await deliver();
  assert.equal(unavailable.id, uninitialized.id);
  assert.equal(unavailable.status, 'queued');
  assert.equal(unavailable.last_code, 'github_unavailable');
  assert.equal(calls, 0);
  const retryMs = unavailable.due_at.getTime() - Date.now();
  assert.ok(retryMs > 0 && retryMs <= 60000, 'Unavailable dependencies retain bounded retry scheduling');

  // A local key initializes the real Octokit App without contacting GitHub.
  const { privateKey } = require('node:crypto').generateKeyPairSync('rsa', {
    modulusLength: 2048,
    privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
    publicKeyEncoding: { type: 'spki', format: 'pem' },
  });
  await github.init({ githubAppId: '123', githubPrivateKey: privateKey });
  await f.pool.query('UPDATE execution_work_requests SET due_at = NOW() WHERE id = $1', [uninitialized.id]);
  const delivered = await deliver();
  assert.equal(delivered.id, uninitialized.id);
  assert.equal(delivered.status, 'succeeded');
  assert.equal(delivered.last_code, 'gate_delivered');
  assert.equal(calls, 1);
  await deliver();
  assert.equal(calls, 1, 'Completed work is not redelivered on restart');
  const state = await f.counts();
  assert.equal(state.sessions[0].check_state, 'passing');
  assert.equal(state.history[0].pass_count, 3);
  assert.equal(state.receipts.filter(row => row.run_id === input.runId).length, 1);
  const attempts = (await f.pool.query('SELECT outcome, code FROM execution_work_attempts ORDER BY started_at')).rows;
  assert.deepEqual(attempts, [
    { outcome: 'retry', code: 'github_uninitialized' },
    { outcome: 'retry', code: 'github_unavailable' },
    { outcome: 'succeeded', code: 'gate_delivered' },
  ]);
});

test('not-yet-in-review delivery remains an intentional domain no-op with GitHub unavailable', { skip: !enabled }, async t => {
  const f = await fixture(t);
  const input = await f.admit();
  let calls = 0;
  const owner = createChecksSettlement(f.pool, {}, {
    github: {
      isEnabled() { throw new Error('Domain no-op must precede dependency inspection'); },
    },
    async merge() { calls++; },
  });
  await owner.settle(input);
  const store = createExecutionStore(f.pool);
  const [attempt] = await store.claim(randomUUID(), [GATE], 1);
  const outcome = await owner.handlers[GATE].run({ attempt });
  assert.deepEqual(outcome, { outcome: 'succeeded', code: 'gate_not_in_review' });
  await store.settle(attempt, outcome);
  assert.equal(calls, 0);
  assert.equal((await store.read(attempt.id)).last_code, 'gate_not_in_review');
});

test('dependency recovery rechecks supersession before invoking merge policy', { skip: !enabled }, async t => {
  const f = await fixture(t);
  const input = await f.admit();
  await f.pool.query("UPDATE chat_sessions SET status = 'promoted', reviewed_head_sha = $1 WHERE id = 1", [HEAD]);
  let ready = false;
  let calls = 0;
  const owner = createChecksSettlement(f.pool, {}, {
    github: {
      isEnabled() { return ready; },
      getInitializationStatus() { return 'failed'; },
    },
    async merge() { calls++; },
  });
  await owner.settle(input);
  const store = createExecutionStore(f.pool);
  const [first] = await store.claim(randomUUID(), [GATE], 1);
  const deferred = await owner.handlers[GATE].run({ attempt: first });
  assert.equal(deferred.outcome, 'retry');
  assert.equal(deferred.code, 'github_failed');
  await store.settle(first, deferred);

  await f.pool.query('UPDATE cli_preview_handoffs SET head_sha = $1 WHERE session_id = 1', [NEXT]);
  await f.pool.query('UPDATE chat_sessions SET handoff_head_sha = $1, staging_commit_sha = $1 WHERE id = 1', [NEXT]);
  await f.pool.query('UPDATE execution_work_requests SET due_at = NOW() WHERE id = $1', [first.id]);
  ready = true;
  const [restarted] = await store.claim(randomUUID(), [GATE], 1);
  const obsolete = await owner.handlers[GATE].run({ attempt: restarted });
  assert.equal(obsolete.outcome, 'succeeded');
  assert.equal(obsolete.code, 'checks_superseded');
  await store.settle(restarted, obsolete);
  assert.equal(calls, 0);
  assert.equal((await f.counts()).sessions[0].staging_commit_sha, NEXT);
});

test('partial history writes and caught mapping errors roll back the entire composition', { skip: !enabled }, async t => {
  const f = await fixture(t);
  const input = await f.admit();
  const owner = createChecksSettlement(f.pool, {}, {
    async recordHistory(client, appId, rows) {
      await history.recordRunStrict(client, appId, rows);
      throw new Error('Injected after history write');
    },
  });
  const runtime = createSessionDecisionRuntime(f.pool);
  await assert.rejects(runtime.transact(async transaction => {
    await transaction.withSession(1, client => client.query("UPDATE chat_sessions SET pr_title = 'earlier write' WHERE id = 1"));
    await owner.settleInTransaction(transaction, input).catch(() => {});
  }), /Injected after history write/);
  const state = await f.counts();
  assert.equal(state.sessions[0].check_state, 'pending');
  assert.equal(state.sessions[0].pr_title, null);
  for (const key of ['history', 'receipts', 'traces', 'work']) assert.equal(state[key].length, 0);
  assert.equal((await createChecksSettlement(f.pool, {}).settle(input)).decision.accepted, true);
});

test('failure after gate admission rolls back verdict, history, journals and work', { skip: !enabled }, async t => {
  const f = await fixture(t);
  const input = await f.admit();
  const store = createExecutionStore(f.pool);
  const owner = createChecksSettlement(f.pool, {}, {
    store: {
      async enqueue(...args) {
        await store.enqueue(...args);
        throw new Error('Injected after work write');
      },
    },
  });
  const runtime = createSessionDecisionRuntime(f.pool);
  await assert.rejects(runtime.transact(async transaction => {
    await owner.settleInTransaction(transaction, input).catch(() => {});
  }), /after work write/);
  const state = await f.counts();
  assert.equal(state.sessions[0].check_state, 'pending');
  for (const key of ['history', 'receipts', 'traces', 'work']) assert.equal(state[key].length, 0);
});

test('restart and lost COMMIT reply adopt the immutable verdict; an error cannot overwrite it', { skip: !enabled }, async t => {
  const f = await fixture(t);
  const input = await f.admit();
  await assert.rejects(createChecksSettlement(loseCommitReply(f.pool), {}).settle(input), /lost COMMIT/);
  const restarted = createChecksSettlement(f.pool, {});
  const replay = await restarted.settle({ ...input, result: { state: 'error', results: [] }, errorDetail: 'lost reply' });
  assert.equal(replay.replayed, true);
  assert.equal(replay.decision.result.state, 'passing');
  await Promise.all([restarted.settle(input), restarted.settle(input)]);
  const state = await f.counts();
  assert.equal(state.sessions[0].check_state, 'passing');
  assert.equal(state.sessions[0].consecutive_check_failures, 0);
  assert.equal(state.history[0].pass_count, 3);
  assert.equal(state.history[0].consecutive_passes, 3);
  assert.equal(state.receipts.length, 1);
  assert.equal(state.traces.length, 1);
  const trace = state.traces[0];
  assert.equal(trace.reducer_version, 1);
  assert.deepEqual(require('../src/services/cli-preview-handoff/settlement-reducer').reduce(trace.pre_state, trace.action), trace.decision);
  assert.equal(state.work.length, 1);
  await assert.rejects(restarted.settle({ ...input, headSha: NEXT }), /different revision/);
  // Exercise the real live-error publication boundary, not only the owner.
  await require('../src/services/visuals').publishCaptureError(f.pool, 1, HEAD, new Error('artifact failed'), null,
    { durableChecks: true, cleanupPool: f.pool, runId: input.runId });
  assert.equal((await f.counts()).sessions[0].check_state, 'passing');
});

test('app-wide history is coordinated across session locks and preserves graduation policy', { skip: !enabled }, async t => {
  const f = await fixture(t);
  const first = await f.admit(1);
  const second = await f.admit(2);
  let enter;
  let release;
  const entered = new Promise(resolve => { enter = resolve; });
  const released = new Promise(resolve => { release = resolve; });
  const owner = createChecksSettlement(f.pool, {}, {
    async recordHistory(client, appId, rows) {
      enter();
      await released;
      return history.recordRunStrict(client, appId, rows);
    },
  });
  const firstWrite = owner.settle(first);
  await entered;
  let secondFinished = false;
  const secondWrite = createChecksSettlement(f.pool, {}).settle({
    ...second, result: { state: 'failing', results: [] }, history: [{ ...ROW, passes: 0, fails: 1 }],
  }).then(value => { secondFinished = true; return value; });
  try {
    await delay(40);
    assert.equal(secondFinished, false, 'another session must wait for the shared app boundary');
  } finally { release(); }
  await Promise.all([firstWrite, secondWrite]);
  const state = await f.counts();
  assert.equal(state.history.length, 1);
  assert.equal(state.history[0].pass_count, 3);
  assert.equal(state.history[0].fail_count, 1);
  assert.equal(state.history[0].consecutive_passes, 0);
  assert.ok(state.history[0].first_passed_at, 'a later failure cannot demote the graduated check');
  assert.equal(state.work.length, 2);
});

test('supersession rejects first settlement and retires durable gate delivery without touching the successor', { skip: !enabled }, async t => {
  const f = await fixture(t);
  const input = await f.admit();
  const owner = createChecksSettlement(f.pool, {});
  await owner.settle(input);
  await f.pool.query(`UPDATE chat_sessions SET handoff_head_sha = $1, checks_commit_sha = $1,
    staging_commit_sha = $1, check_state = 'pending' WHERE id = 1`, [NEXT]);
  const store = createExecutionStore(f.pool);
  const [attempt] = await store.claim(randomUUID(), [GATE], 1);
  const outcome = await owner.handlers[GATE].run({ attempt });
  assert.equal(outcome.code, 'checks_superseded');
  await store.settle(attempt, outcome);
  const other = await f.admit(2);
  await f.pool.query('UPDATE chat_sessions SET checks_commit_sha = $1 WHERE id = 2', [NEXT]);
  assert.equal((await owner.settle(other)).decision.accepted, false);
  const state = await f.counts();
  assert.equal(state.history[0].pass_count, 3);
  assert.equal(state.sessions[0].check_state, 'pending');
  assert.equal(state.sessions[0].staging_commit_sha, NEXT);
  assert.equal(state.work.length, 1);
});

test('required gate delivery survives service failure, worker restart and a lost execution commit reply', { skip: !enabled }, async t => {
  const f = await fixture(t);
  const input = await f.admit();
  await f.pool.query("UPDATE chat_sessions SET status = 'promoted', reviewed_head_sha = $1 WHERE id = 1", [HEAD]);
  const store = createExecutionStore(f.pool, { leaseMs: 100 });
  await createChecksSettlement(f.pool, {}).settle({ ...input, result: { state: 'failing', results: [] } });
  let calls = 0;
  const delivered = new Set();
  const make = () => createChecksSettlement(f.pool, {}, {
    async bot(sessionId) {
      calls++;
      if (calls === 1) throw new Error('Injected policy service outage');
      delivered.add(sessionId); // Represents existing service-side idempotent queue admission.
    },
  });
  const [first] = await store.claim(randomUUID(), [GATE], 1);
  await assert.rejects(make().handlers[GATE].run({ attempt: first }), /service outage/);
  await store.settle(first, { outcome: 'retry', delayMs: 100 });
  await f.pool.query("UPDATE execution_work_requests SET due_at = NOW() WHERE id = $1", [first.id]);
  const [second] = await store.claim(randomUUID(), [GATE], 1);
  const result = await make().handlers[GATE].run({ attempt: second });
  // A process can disappear after invoking the policy but before work completion.
  await f.pool.query('UPDATE execution_work_requests SET lease_until = NOW(), due_at = NOW() WHERE id = $1', [first.id]);
  const [third] = await store.claim(randomUUID(), [GATE], 1);
  await make().handlers[GATE].run({ attempt: third });
  const losingStore = createExecutionStore(loseCommitReply(f.pool));
  await assert.rejects(losingStore.settle(third, result), /lost COMMIT/);
  assert.equal((await store.read(first.id)).status, 'succeeded');
  assert.equal((await store.claim(randomUUID(), [GATE], 1)).length, 0);
  assert.equal(calls, 3, 'delivery may repeat after interruption');
  assert.equal(delivered.size, 1);
  assert.equal((await f.counts()).history[0].pass_count, 3, 'delivery cannot replay graduation writes');
});

test('error and deferred settlement never count history or request gate work', { skip: !enabled }, async t => {
  const f = await fixture(t);
  const error = await f.admit(1);
  const deferred = await f.admit(2);
  const owner = createChecksSettlement(f.pool, {});
  await owner.settle({ ...error, result: { state: 'error', results: [] } });
  await owner.settle({ ...deferred, result: { state: 'deferred', results: [] } });
  const state = await f.counts();
  assert.equal(state.history.length, 0);
  assert.equal(state.work.length, 0);
  assert.equal(state.sessions[0].consecutive_check_failures, 1);
  assert.equal(state.sessions[1].check_phase, 'deferred');
});

test('stale manifest ownership rejects a report without consuming the current owner’s settlement', { skip: !enabled }, async t => {
  const f = await fixture(t);
  const input = await f.admit();
  const owner = createChecksSettlement(f.pool, {});
  await f.pool.query("UPDATE check_runs SET owner = 'successor-harvester' WHERE run_id = $1", [input.runId]);
  const rejected = await owner.settle(input);
  assert.equal(rejected.decision.reason, 'checks_owner_changed');
  assert.equal(await owner.settled(1, input.runId), null);
  assert.equal((await f.counts()).history.length, 0);
  const accepted = await owner.settle({ ...input, observedOwner: 'successor-harvester' });
  assert.equal(accepted.decision.accepted, true);
  const state = await f.counts();
  assert.equal(state.receipts.filter(receipt => receipt.run_id === input.runId).length, 1);
  assert.equal(state.history[0].pass_count, 3);
});

test('a same-revision recheck supersedes the previous run’s gate delivery', { skip: !enabled }, async t => {
  const f = await fixture(t);
  const input = await f.admit();
  await f.pool.query("UPDATE chat_sessions SET status = 'promoted', reviewed_head_sha = $1 WHERE id = 1", [HEAD]);
  let calls = 0;
  const owner = createChecksSettlement(f.pool, {}, { async bot() { calls++; } });
  await owner.settle({ ...input, result: { state: 'failing', results: [] } });
  await f.pool.query("UPDATE chat_sessions SET check_state = 'pending', check_phase = 'testing' WHERE id = 1");
  await f.pool.query("UPDATE preview_operations SET run_id = $1, state = 'running' WHERE session_id = 1", [randomUUID()]);
  const store = createExecutionStore(f.pool);
  const [attempt] = await store.claim(randomUUID(), [GATE], 1);
  const outcome = await owner.handlers[GATE].run({ attempt });
  assert.equal(outcome.code, 'settlement_changed');
  await store.settle(attempt, outcome);
  assert.equal(calls, 0);
  assert.equal((await f.counts()).sessions[0].check_state, 'pending');
});

test('first live error keeps capture diagnostics optional and repeated publication does not count again', { skip: !enabled }, async t => {
  const f = await fixture(t);
  const input = await f.admit();
  const operation = { durableChecks: true, cleanupPool: f.pool, runId: input.runId };
  const visuals = require('../src/services/visuals');
  await visuals.publishCaptureError(f.pool, 1, HEAD, new Error('Injected terminal capture failure'), null, operation);
  await visuals.publishCaptureError(f.pool, 1, HEAD, new Error('Lost reply'), null, operation);
  const state = await f.counts();
  assert.equal(state.sessions[0].check_state, 'error');
  assert.equal(state.sessions[0].consecutive_check_failures, 1);
  assert.equal(state.sessions[0].capture_state, 'failed');
  assert.match(state.sessions[0].capture_detail.reason, /terminal capture failure/);
  assert.equal(state.history.length, 0);
  assert.equal(state.work.length, 0);
});

test('atomic settlement preserves stale-history pruning without resetting another session’s current history', { skip: !enabled }, async t => {
  const f = await fixture(t);
  const input = await f.admit();
  const oldKey = checkKey('Removed check', '/removed');
  const otherKey = checkKey('Another session check', '/other');
  await f.pool.query(`INSERT INTO app_check_history
    (app_id, check_key, check_name, check_path, pass_count, first_passed_at, last_seen_at)
    VALUES (1,$1,'Removed check','/removed',2,NOW(),NOW() - INTERVAL '91 days'),
      (1,$2,'Another session check','/other',4,NOW(),NOW())`, [oldKey, otherKey]);
  await createChecksSettlement(f.pool, {}).settle(input);
  const state = await f.counts();
  assert.equal(state.history.some(row => row.check_key === oldKey), false);
  assert.equal(state.history.find(row => row.check_key === otherKey).pass_count, 4);
  assert.equal(state.history.find(row => row.check_key === ROW.checkKey).pass_count, 3);
});
