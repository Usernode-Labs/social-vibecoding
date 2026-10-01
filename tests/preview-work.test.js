'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { randomUUID } = require('node:crypto');
const { createExecutionDatabase } = require('./lib/execution-database');
const { createPreviewWork, PREPARE, RETIRE } = require('../src/services/preview-flow/work');
const { createPreviewFlow } = require('../src/services/preview-flow/store');
const { createGuard } = require('../src/services/build-retention-guard');
const { replayDecision } = require('../src/services/preview-flow/reducer');

const databaseUrl = process.env.PREVIEW_FLOW_TEST_DATABASE_URL || process.env.SQL_CHECK_CONNECTION_URL;
const HEAD = 'a'.repeat(40);

function request() {
  return { type: 'RequestCandidatePreview', actionId: randomUUID(), sessionId: 1, headSha: HEAD, startedStatus: 'active' };
}

function failOnce(pool, matches, after = false) {
  let failed = false;
  async function query(client, sql, params) {
    const fail = !failed && matches(String(sql));
    if (fail) failed = true;
    if (fail && !after) throw new Error('Injected write failure');
    const result = await client.query(sql, params);
    if (fail) throw new Error('Injected acknowledgment loss');
    return result;
  }
  return {
    query: (sql, params) => query(pool, sql, params),
    connect: async () => {
      const client = await pool.connect();
      return { query: (sql, params) => query(client, sql, params), release: () => client.release() };
    },
  };
}

async function fixture(t, kind = 'docker') {
  const db = await createExecutionDatabase(databaseUrl);
  t.after(() => db.close());
  await db.pool.query('INSERT INTO chat_sessions (id, checks_commit_sha) VALUES (1, $1)', [HEAD]);
  await db.pool.query('CREATE TABLE objects (name TEXT PRIMARY KEY, receipt JSONB)');
  const config = { databaseUrl: db.url, appRuntime: kind, kubernetes: { appNamespace: 'apps' },
    dataEncryptionKey: 'test-encryption-key', nativePreviewWorkerEnabled: true, nativePreviewAttempts: true };
  const guard = createGuard({ onLockLost: () => { throw new Error('Unexpected guard loss'); } });
  let creates = 0;
  const adapters = {
    lock: guard.withResourceUse,
    async inspect(_config, intent) {
      const object = (await db.pool.query('SELECT receipt FROM objects WHERE name = $1', [intent.runtimeName])).rows[0];
      return { present: !!object, receipt: object?.receipt || null };
    },
    async prepare(_config, session, app, head, candidate) {
      creates++;
      await candidate.onClonePrepared();
      const receipt = {
        commitSha: head, stagingUrl: `http://${candidate.intent.runtimeName}:3000`,
        runtimeKind: kind, runtimeName: candidate.intent.runtimeName,
        containerId: kind === 'docker' ? candidate.intent.runtimeName : null,
        imageRef: `image:${candidate.intent.attemptId}`, buildRef: null,
        physicalId: randomUUID(), attemptId: candidate.intent.attemptId,
      };
      await db.pool.query('INSERT INTO objects VALUES ($1, $2)', [receipt.runtimeName, JSON.stringify(receipt)]);
      return receipt;
    },
    async cleanup({ sessionId, flowId }) {
      const owner = createPreviewFlow(db.pool);
      const allowed = await owner.apply({ type: 'RequestPreviewCleanup', actionId: randomUUID(), sessionId, flowId });
      if (!allowed.decision.accepted) return { protected: true };
      await db.pool.query('DELETE FROM objects WHERE name = $1', [allowed.current.resource.intent.runtimeName]);
      await owner.apply({ type: 'PreviewCleanupCompleted', actionId: randomUUID(), sessionId, flowId, disposition: 'removed' });
    },
  };
  const work = createPreviewWork(db.pool, config, adapters);
  async function execute(workflow = PREPARE, executor = work) {
    await db.pool.query("UPDATE execution_work_requests SET due_at = clock_timestamp() WHERE workflow = $1", [workflow]);
    const [attempt] = await executor.store.claim(randomUUID(), [workflow], 1);
    const handler = executor.handlers[workflow];
    const proposed = await handler.run({ attempt, signal: new AbortController().signal,
      checkpoint: value => executor.store.checkpoint(attempt, value) });
    return executor.store.settle(attempt, proposed, handler.commit);
  }
  return { ...db, config, adapters, work, execute, creates: () => creates };
}

test('real PostgreSQL: admission atomically reserves resources, decision, work and original receipt', { skip: !databaseUrl }, async t => {
  const { pool, config, adapters, work } = await fixture(t);
  const broken = createPreviewWork(failOnce(pool, sql => sql.includes('INSERT INTO execution_work_events')), config, adapters);
  const action = request();
  await assert.rejects(broken.request(action));
  for (const table of ['preview_flows', 'preview_action_receipts', 'preview_flow_decisions', 'preview_flow_resources', 'execution_work_requests']) {
    assert.equal((await pool.query(`SELECT * FROM ${table}`)).rowCount, 0, table);
  }
  const lost = createPreviewWork(failOnce(pool, sql => sql === 'COMMIT', true), config, adapters);
  await assert.rejects(lost.request(action));
  const retried = await work.request(action);
  assert.equal(retried.replayed, true);
  assert.equal((await pool.query('SELECT * FROM execution_work_requests')).rowCount, 1);
  assert.equal((await pool.query('SELECT * FROM preview_flow_resources')).rowCount, 1);
  assert.equal(JSON.stringify(retried.work.input).includes('password'), false);
  for (const row of await createPreviewFlow(pool).trace(1)) assert.deepEqual(replayDecision(row), row.decision);
});

for (const kind of ['docker', 'kubernetes']) {
  test(`real PostgreSQL ${kind}: preparation preserves serving state and candidate ownership between claims`, { skip: !databaseUrl }, async t => {
    const { pool, work, execute, creates } = await fixture(t, kind);
    const admitted = await work.request(request());
    await work.census();
    assert.equal((await pool.query('SELECT * FROM execution_work_requests WHERE workflow = $1', [RETIRE])).rowCount, 0);
    const prepared = await execute();
    assert.equal(prepared.result.accepted, true);
    assert.equal(creates(), 1);
    const state = await createPreviewFlow(pool).read(1);
    assert.equal(state.flow.state, 'candidate');
    assert.equal(state.preview.runtimeName, 'serving');
    assert.equal(state.binding, null);
    assert.equal((await createPreviewFlow(pool).apply({ type: 'RequestPreviewCleanup', actionId: randomUUID(),
      sessionId: 1, flowId: admitted.decision.flow.id })).decision.reason, 'preparation_owned');
    await work.census();
    assert.equal((await pool.query('SELECT * FROM execution_work_requests WHERE workflow = $1', [RETIRE])).rowCount, 0);
  });

  test(`real PostgreSQL ${kind}: lost runtime receipt acknowledgment is adopted without another creation`, { skip: !databaseUrl }, async t => {
    const { pool, config, adapters, work, execute, creates } = await fixture(t, kind);
    const broken = createPreviewWork(failOnce(pool, sql => sql.includes('INSERT INTO preview_flow_resources (flow_id, session_id, receipt)')), config, adapters);
    await broken.request(request());
    await assert.rejects(execute(PREPARE, broken));
    await pool.query("UPDATE execution_work_requests SET lease_until = clock_timestamp() - INTERVAL '1 second'");
    const result = await execute();
    assert.equal(result.result.accepted, true);
    assert.equal(creates(), 1);
    assert.equal((await work.store.read((await pool.query('SELECT id FROM execution_work_requests')).rows[0].id)).status, 'succeeded');
  });

  test(`real PostgreSQL ${kind}: interrupted creation is retired; completed absence still catches late resources`, { skip: !databaseUrl }, async t => {
    const { pool, work, execute } = await fixture(t, kind);
    const admission = await work.request(request());
    const [interrupted] = await work.store.claim(randomUUID(), [PREPARE]);
    await work.store.checkpoint(interrupted, { creationStarted: true });
    await pool.query("UPDATE execution_work_requests SET lease_until = clock_timestamp() - INTERVAL '1 second'");
    const retired = await execute();
    assert.equal(retired.result.prepared, false);
    await execute(RETIRE);
    assert.ok((await pool.query('SELECT cleanup_completed_at FROM preview_flow_resources')).rows[0].cleanup_completed_at);
    // A remote create accepted before the crash finishes after absence was observed.
    await pool.query('INSERT INTO objects VALUES ($1, $2)', [admission.work.input.intent.runtimeName, JSON.stringify({ late: true })]);
    await execute(RETIRE);
    assert.equal((await pool.query('SELECT * FROM objects')).rowCount, 0);
    assert.equal((await pool.query('SELECT status FROM execution_work_requests WHERE workflow = $1', [RETIRE])).rows[0].status, 'queued');
    assert.equal((await createPreviewFlow(pool).read(1)).preview.runtimeName, 'serving');
  });

  test(`real PostgreSQL ${kind}: stale preparation result schedules retirement and cannot damage successor`, { skip: !databaseUrl }, async t => {
    const { pool, work, execute } = await fixture(t, kind);
    const old = await work.request(request());
    const [attempt] = await work.store.claim(randomUUID(), [PREPARE]);
    const proposed = await work.handlers[PREPARE].run({ attempt, signal: new AbortController().signal,
      checkpoint: value => work.store.checkpoint(attempt, value) });
    const next = await work.request(request());
    const stale = await work.store.settle(attempt, proposed, work.handlers[PREPARE].commit);
    assert.equal(stale.result.accepted, false);
    assert.equal(stale.result.reason, 'superseded_flow');
    await execute();
    await execute(RETIRE);
    assert.deepEqual((await pool.query('SELECT name FROM objects')).rows.map(row => row.name), [next.work.input.intent.runtimeName]);
    assert.notEqual(old.work.input.intent.runtimeName, next.work.input.intent.runtimeName);
    for (const row of await createPreviewFlow(pool).trace(1)) assert.deepEqual(replayDecision(row), row.decision);
  });
}

test('real PostgreSQL: dedicated worker death after creation recovers in a different OS process', { skip: !databaseUrl }, async t => {
  const { fork } = require('node:child_process');
  const { once } = require('node:events');
  const { pool, work, url } = await fixture(t);
  const admission = await work.request(request());
  const children = [];
  t.after(() => { for (const child of children) if (child.exitCode === null) child.kill('SIGKILL'); });
  function launch(stopAfterCreate) {
    const child = fork(require.resolve('./lib/preview-worker-child'), [], { stdio: ['ignore', 'ignore', 'pipe', 'ipc'] });
    children.push(child);
    child.send({ databaseUrl: url, stopAfterCreate });
    return child;
  }
  const first = launch(true);
  assert.deepEqual((await once(first, 'message'))[0], { created: true });
  first.kill('SIGKILL');
  await once(first, 'exit');
  await pool.query("UPDATE execution_work_requests SET lease_until = clock_timestamp() - INTERVAL '1 second'");
  const restarted = launch(false);
  assert.deepEqual((await once(restarted, 'message'))[0], { completed: true });
  await once(restarted, 'exit');
  assert.equal((await work.store.read(admission.work.id)).status, 'succeeded');
  assert.equal((await pool.query('SELECT * FROM objects')).rowCount, 1);
  assert.equal((await createPreviewFlow(pool).read(1)).flow.state, 'candidate');
});

test('real PostgreSQL: expiry cannot release a live creator resource lock or authorize another creation', { skip: !databaseUrl }, async t => {
  const { pool, config, adapters, work } = await fixture(t);
  let finish;
  let entered;
  const pending = new Promise(resolve => { finish = resolve; });
  const started = new Promise(resolve => { entered = resolve; });
  const held = createPreviewWork(pool, config, { ...adapters,
    async prepare(...args) { entered(); await pending; return adapters.prepare(...args); },
  });
  await work.request(request());
  const [old] = await work.store.claim(randomUUID(), [PREPARE]);
  const preparation = held.handlers[PREPARE].run({ attempt: old, signal: new AbortController().signal,
    checkpoint: value => work.store.checkpoint(old, value) });
  await started;
  await pool.query("UPDATE execution_work_requests SET lease_until = clock_timestamp() - INTERVAL '1 second'");
  const [next] = await work.store.claim(randomUUID(), [PREPARE]);
  const busy = await work.handlers[PREPARE].run({ attempt: next, signal: new AbortController().signal,
    checkpoint: value => work.store.checkpoint(next, value) });
  assert.equal(busy.code, 'resource_busy');
  await work.store.settle(next, busy, work.handlers[PREPARE].commit);
  finish();
  const oldResult = await preparation;
  assert.deepEqual(await work.store.settle(old, oldResult, held.handlers[PREPARE].commit), { lostClaim: true });
  await pool.query("UPDATE execution_work_requests SET due_at = clock_timestamp()");
  const [retry] = await work.store.claim(randomUUID(), [PREPARE]);
  const adopted = await work.handlers[PREPARE].run({ attempt: retry, signal: new AbortController().signal,
    checkpoint: value => work.store.checkpoint(retry, value) });
  assert.equal((await work.store.settle(retry, adopted, work.handlers[PREPARE].commit)).result.accepted, true);
});

test('candidate observation checks physical owner, built head and health; errors never imply absence', async t => {
  const adapter = require('../src/services/preview-flow/candidate-runtime');
  const { FLOW_LABEL } = require('../src/services/preview-flow/cleanup');
  const docker = require('../src/services/docker');
  const kubernetes = require('../src/services/kubernetes');
  const runtime = require('../src/services/application-runtime');
  const flowId = randomUUID();
  const labels = { [FLOW_LABEL]: flowId, [adapter.HEAD_LABEL]: HEAD };
  let object = { uid: 'physical', labels, imageRef: 'image:exact' };
  let error;
  let healthy = true;
  t.mock.method(runtime, 'probeHealth', async () => healthy);
  t.mock.method(docker, 'execFileAsync', async () => {
    if (error) throw error;
    if (!object) throw new Error('No such container');
    return { stdout: JSON.stringify({ Id: object.uid, Config: { Labels: object.labels, Image: object.imageRef } }) };
  });
  t.mock.method(kubernetes, '_getClients', () => ({ apps: { async readNamespacedDeployment() {
    if (error) throw error;
    if (!object) throw Object.assign(new Error('Absent'), { code: 404 });
    return { metadata: { uid: object.uid, labels: object.labels }, spec: { template: { spec: { containers: [{ name: 'app', image: object.imageRef }] } } } };
  } } }));
  for (const runtimeKind of ['docker', 'kubernetes']) {
    const intent = { runtimeKind, runtimeName: 'candidate', namespace: runtimeKind === 'docker' ? null : 'apps', attemptId: randomUUID() };
    const config = { appRuntime: runtimeKind, kubernetes: { appNamespace: 'apps' } };
    object = { uid: 'physical', labels, imageRef: 'image:exact' };
    healthy = true;
    assert.equal((await adapter.observePreparedCandidate(config, intent, flowId, HEAD)).receipt.physicalId, 'physical');
    object = { ...object, labels: { ...labels, [adapter.HEAD_LABEL]: 'b'.repeat(40) } };
    await assert.rejects(adapter.observePreparedCandidate(config, intent, flowId, HEAD), /ownership/);
    object = { ...object, labels };
    healthy = false;
    assert.deepEqual(await adapter.observePreparedCandidate(config, intent, flowId, HEAD), { present: true, receipt: null });
    error = new Error('Transport unavailable');
    await assert.rejects(adapter.observePreparedCandidate(config, intent, flowId, HEAD), /Transport/);
    error = null;
    object = null;
    assert.deepEqual(await adapter.observePreparedCandidate(config, intent, flowId, HEAD), { present: false, receipt: null });
  }
});

for (const afterCommit of [false, true]) {
  test(`real PostgreSQL: preparation settlement ${afterCommit ? 'loses commit acknowledgment' : 'rolls back after mapping failure'} without duplicate decisions`, { skip: !databaseUrl }, async t => {
    const { pool, config, adapters, work, execute, creates } = await fixture(t);
    const admission = await work.request(request());
    const broken = createPreviewWork(failOnce(pool, sql => afterCommit ? sql === 'COMMIT'
      : sql.includes('INSERT INTO preview_flow_decisions'), afterCommit), config, adapters);
    // Work is already claimed before injecting completion failure. Its clone
    // checkpoint and runtime receipt remain outside the settlement transaction.
    const [attempt] = await work.store.claim(randomUUID(), [PREPARE]);
    const result = await work.handlers[PREPARE].run({ attempt, signal: new AbortController().signal,
      checkpoint: value => work.store.checkpoint(attempt, value) });
    await assert.rejects(broken.store.settle(attempt, result, broken.handlers[PREPARE].commit));
    if (!afterCommit) {
      assert.equal((await createPreviewFlow(pool).read(1)).flow.state, 'preparing');
      await pool.query("UPDATE execution_work_requests SET lease_until = clock_timestamp() - INTERVAL '1 second'");
      assert.equal((await execute()).result.accepted, true);
    }
    assert.equal((await work.store.read(admission.work.id)).status, 'succeeded');
    assert.equal((await createPreviewFlow(pool).read(1)).flow.state, 'candidate');
    assert.equal(creates(), 1);
    assert.equal((await pool.query("SELECT * FROM preview_flow_decisions WHERE action->>'type' = 'PreviewCandidatePrepared'")).rowCount, 1);
  });
}

test('real PostgreSQL: busy discovery rolls back without blocking polling or later cleanup discovery', { skip: !databaseUrl }, async t => {
  const { runWorker } = require('../scripts/preview-preparation-worker');
  const { pool, config, adapters, work } = await fixture(t);
  await pool.query('INSERT INTO chat_sessions (id, checks_commit_sha) VALUES (2, $1), (3, $1)', [HEAD]);
  const oldest = await work.request(request());
  const later = await work.request({ ...request(), sessionId: 3 });
  // Retire domain permission before holding the oldest aggregate lock.
  await pool.query("UPDATE chat_sessions SET status = 'archived' WHERE id IN (1, 3)");
  const unrelated = await work.request({ ...request(), sessionId: 2 });
  // Remove preparation from discovery assertions: these obligations already
  // have stable resources and only their cleanup must now be discovered.
  await pool.query("UPDATE execution_work_requests SET status = 'succeeded' WHERE session_id IN (1, 3)");
  const holder = await pool.connect();
  await holder.query('BEGIN');
  await holder.query('SELECT id FROM chat_sessions WHERE id = 1 FOR UPDATE');
  let released = false;
  let running;
  try {
    running = await runWorker({ pool, config, pollMs: 10, censusMs: 20,
      discoveryOptions: { lockTimeoutMs: 40, statementTimeoutMs: 200 }, previewOptions: adapters });
    async function until(check) {
      const deadline = Date.now() + 5000;
      while (!await check()) {
        assert.ok(Date.now() < deadline, 'progress must occur while the aggregate lock remains held');
        await new Promise(resolve => setTimeout(resolve, 10));
      }
    }
    await until(async () => (await work.store.read(unrelated.work.id)).status === 'succeeded');
    await until(async () => (await pool.query('SELECT cleanup_completed_at FROM preview_flow_resources WHERE flow_id = $1',
      [later.decision.flow.id])).rows[0].cleanup_completed_at);
    assert.equal(released, false);
    assert.equal((await pool.query('SELECT * FROM execution_work_requests WHERE session_id = 1 AND workflow = $1', [RETIRE])).rowCount, 0);
    assert.equal((await pool.query("SELECT * FROM preview_flow_decisions WHERE session_id = 1 AND action->>'type' = 'RequestPreviewCleanup'")).rowCount, 0,
      'timed-out discovery did not commit partial admission');
    assert.equal((await pool.query("SELECT count(*)::int AS count FROM pg_stat_activity WHERE application_name = 'bounded-work-discovery' AND state = 'idle in transaction (aborted)'")).rows[0].count, 0);
    await holder.query('ROLLBACK');
    released = true;
    await until(async () => (await pool.query('SELECT cleanup_completed_at FROM preview_flow_resources WHERE flow_id = $1',
      [oldest.decision.flow.id])).rows[0].cleanup_completed_at);
  } finally {
    if (!released) await holder.query('ROLLBACK');
    holder.release();
    if (running) await running.stop();
  }
});
