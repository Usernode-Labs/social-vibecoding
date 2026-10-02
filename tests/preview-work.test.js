'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { randomUUID } = require('node:crypto');
const { createExecutionDatabase } = require('./lib/execution-database');
const { completePreviewConfig, createCompletePreviewWork } = require('./lib/complete-preview-work');
const { createInjectedRuntimeApi } = require('./lib/injected-preview-runtime');
const { createRuntimeOperations } = require('../src/services/preview-flow/runtime-operation');
const { PREPARE_RUNTIME, RETIRE } = require('../src/services/preview-flow/work');
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

async function fixture(t) {
  const db = await createExecutionDatabase(databaseUrl);
  t.after(() => db.close());
  await db.pool.query('INSERT INTO chat_sessions (id, checks_commit_sha) VALUES (1, $1)', [HEAD]);
  const config = completePreviewConfig({ databaseUrl: db.url });
  const api = createInjectedRuntimeApi();
  const guard = createGuard({ onLockLost: () => { throw new Error('Unexpected guard loss'); } });
  const runtimes = createRuntimeOperations({ clients: () => api.clients, dataKey: config.dataEncryptionKey,
    probe: async () => true });
  const adapters = {
    lock: guard.withResourceUse,
    runtimes,
    clones: {
      prepare: async () => ({ status: 'complete', databaseOid: '123' }),
      inspect: async () => ({ status: 'complete' }),
    },
    images: {
      prepare: async () => ({ status: 'succeeded', uid: 'injected-build', imageRef: `example.test/images/demo@sha256:${'c'.repeat(64)}` }),
      inspect: async () => ({ status: 'succeeded', uid: 'injected-build', imageRef: `example.test/images/demo@sha256:${'c'.repeat(64)}` }),
    },
    async prepare(_config, _session, _app, head, candidate) {
      await candidate.prepareClone();
      const built = await candidate.prepareImage(null);
      const deployed = await candidate.prepareRuntime({ imageRef: built.imageRef, env: {} });
      return { ...deployed, commitSha: head, stagingUrl: deployed.url };
    },
    async cleanup({ sessionId, flowId }) {
      const owner = createPreviewFlow(db.pool);
      const allowed = await owner.apply({ type: 'RequestPreviewCleanup', actionId: randomUUID(), sessionId, flowId });
      if (!allowed.decision.accepted) return { protected: true };
      await owner.apply({ type: 'PreviewCleanupCompleted', actionId: randomUUID(), sessionId, flowId, disposition: 'removed' });
    },
  };
  const work = createCompletePreviewWork(db.pool, config, adapters);
  async function execute(workflow = PREPARE_RUNTIME, executor = work) {
    await db.pool.query('UPDATE execution_work_requests SET due_at = clock_timestamp() WHERE workflow = $1', [workflow]);
    const [attempt] = await executor.store.claim(randomUUID(), [workflow], 1);
    const handler = executor.handlers[workflow];
    const proposed = await handler.run({ attempt, signal: new AbortController().signal,
      checkpoint: value => executor.store.checkpoint(attempt, value) });
    return executor.store.settle(attempt, proposed, handler.commit);
  }
  return { ...db, config, adapters, work, execute, creates: () => api.creates.filter(kind => kind === 'deployment').length };
}

test('real PostgreSQL: complete admission is atomic and a lost commit reply joins the same work', { skip: !databaseUrl }, async t => {
  const { pool, config, adapters, work } = await fixture(t);
  const broken = createCompletePreviewWork(failOnce(pool, sql => sql.includes('INSERT INTO execution_work_events')), config, adapters);
  const action = request();
  await assert.rejects(broken.request(action));
  for (const table of ['preview_flows', 'preview_action_receipts', 'preview_flow_decisions', 'preview_flow_resources', 'execution_work_requests']) {
    assert.equal((await pool.query(`SELECT * FROM ${table}`)).rowCount, 0, table);
  }
  const lost = createCompletePreviewWork(failOnce(pool, sql => sql === 'COMMIT', true), config, adapters);
  await assert.rejects(lost.request(action));
  const retried = await work.request(action);
  assert.equal(retried.replayed, true);
  assert.equal((await pool.query('SELECT * FROM execution_work_requests')).rowCount, 1);
  assert.equal((await pool.query('SELECT * FROM preview_flow_resources')).rowCount, 1);
  assert.equal(JSON.stringify(retried.work.input).includes('password'), false);
  for (const row of await createPreviewFlow(pool).trace(1)) assert.deepEqual(replayDecision(row), row.decision);
});

test('real PostgreSQL: complete preparation preserves serving and recovery with admission disabled adopts the candidate', { skip: !databaseUrl }, async t => {
  const { pool, config, adapters, work, execute, creates } = await fixture(t);
  const admitted = await work.request(request());
  const [attempt] = await work.store.claim(randomUUID(), [PREPARE_RUNTIME]);
  const result = await work.handlers[PREPARE_RUNTIME].run({ attempt, signal: new AbortController().signal,
    checkpoint: value => work.store.checkpoint(attempt, value) });
  const receipt = result.result.receipt;
  config.nativeCliPreviewHandoffEnabled = false;
  const recovery = createCompletePreviewWork(pool, config, adapters);
  await assert.rejects(recovery.request(request()), /experimentally disabled/);
  await pool.query("UPDATE execution_work_requests SET lease_until = clock_timestamp() - INTERVAL '1 second'");
  assert.equal((await execute(PREPARE_RUNTIME, recovery)).result.accepted, true);
  assert.deepEqual((await createPreviewFlow(pool).read(1)).resource.receipt, receipt);
  assert.equal((await work.store.read(admitted.work.id)).status, 'succeeded');
  assert.equal((await createPreviewFlow(pool).read(1)).preview.runtimeName, 'serving');
  assert.equal(creates(), 1);
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
    const broken = createCompletePreviewWork(failOnce(pool, sql => afterCommit ? sql === 'COMMIT'
      : sql.includes('INSERT INTO preview_flow_decisions'), afterCommit), config, adapters);
    // Work is already claimed before injecting completion failure. Its clone
    // checkpoint and runtime receipt remain outside the settlement transaction.
    const [attempt] = await work.store.claim(randomUUID(), [PREPARE_RUNTIME]);
    const result = await work.handlers[PREPARE_RUNTIME].run({ attempt, signal: new AbortController().signal,
      checkpoint: value => work.store.checkpoint(attempt, value) });
    await assert.rejects(broken.store.settle(attempt, result, broken.handlers[PREPARE_RUNTIME].commit));
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
