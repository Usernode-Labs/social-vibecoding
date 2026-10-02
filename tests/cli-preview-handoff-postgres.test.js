'use strict';

// Real isolated PostgreSQL; external preparation/activation/checks are injected.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { randomUUID } = require('node:crypto');
const { enabled: postgresEnabled, readPreviewPostgresFixture } = require('./lib/preview-postgres-fixture');
const { createExecutionDatabase } = require('./lib/execution-database');
const { addHandoffColumns } = require('./lib/cli-handoff-fixture');
const { createCliHandoffWork, CONTINUE, enrolled } = require('../src/services/cli-preview-handoff/work');
const { PREPARE_RUNTIME } = require('../src/services/preview-flow/work');
const { selectRuntime } = require('../src/services/preview-flow/runtime-intent');
const { createExecutionWorker } = require('../src/services/execution/worker');
const { createPreviewFlow } = require('../src/services/preview-flow/store');

const HEAD = 'a'.repeat(40);
const NEXT = 'b'.repeat(40);

async function fixture(t) {
  const selected = await readPreviewPostgresFixture();
  const db = await createExecutionDatabase(selected.databaseUrl);
  await addHandoffColumns(db.pool);
  await db.pool.query(`INSERT INTO chat_sessions (id, handoff_uploaded_sha, checks_commit_sha)
    VALUES (1,$1,$1)`, [HEAD]);
  const oldLifecycle = process.env.PREVIEW_LIFECYCLE_ENABLED;
  process.env.PREVIEW_LIFECYCLE_ENABLED = 'true';
  t.after(async () => {
    if (oldLifecycle === undefined) delete process.env.PREVIEW_LIFECYCLE_ENABLED;
    else process.env.PREVIEW_LIFECYCLE_ENABLED = oldLifecycle;
    await db.close();
  });
  const config = {
    ...selected.config,
    databaseUrl: db.url,
    nativeCliPreviewHandoffEnabled: true,
    nativePreviewAttempts: true,
    dataEncryptionKey: 'c8-isolated',
  };
  const owner = createPreviewFlow(db.pool);
  let creates = 0;
  const make = extra => createCliHandoffWork(db.pool, config, {
    previewOptions: { lock: async (_c, _k, _id, run) => run(), owner },
    async activate({ flowId }) {
      creates++;
      const state = await owner.read(1);
      const desired = await owner.apply({
        type: 'RequestPreviewActivation', actionId: randomUUID(), sessionId: 1,
        flowId, headSha: state.flow.headSha, generation: state.flow.generation,
        expected: { target: null, uid: null, token: null }, stagingUrl: 'https://preview.fixture.invalid',
      });
      if (!desired.decision.accepted) return { accepted: false, reason: desired.decision.reason };
      const observed = await owner.apply({
        type: 'PreviewActivationObserved', actionId: randomUUID(), sessionId: 1,
        flowId, headSha: state.flow.headSha, generation: state.flow.generation,
        activationId: desired.current.binding.desired.activationId,
        observation: { target: state.resource.intent.runtimeName, token: 'rv', uid: 'ingress' },
      });
      return { accepted: observed.decision.accepted };
    },
    async capture(_c, session, _app, head) {
      await require('../src/services/visuals').storeChecks(db.pool, session.id, head, { state: 'passing', results: [] });
    },
    warm: async () => {}, notify: () => {}, ...extra,
  });
  const session = async () => (await db.pool.query('SELECT * FROM chat_sessions WHERE id = 1')).rows[0];
  return { ...db, owner, config, make, session, creates: () => creates };
}

async function candidate(f, work, admitted, beforeCommit = null) {
  // Injected service facts, with actual reducer/provenance/persistence checks.
  const [attempt] = await work.store.claim(randomUUID(), [PREPARE_RUNTIME], 1);
  assert.ok(attempt);
  const intent = await f.owner.readResourceIntent(1, attempt.input.identity.flowId);
  const imageRef = `${intent.buildOperation.repository}@sha256:${'1'.repeat(64)}`;
  intent.buildOperation.runScript = null;
  intent.buildOperation.receipt = { uid: 'build-uid', imageRef };
  intent.runtimeOperation.desired = selectRuntime(f.config, attempt.input.identity, { imageRef, env: {} });
  intent.runtimeOperation.resources = Object.fromEntries(['secret', 'service', 'deployment']
    .map(kind => [kind, { submitted: true, uid: `${kind}-uid` }]));
  await f.pool.query('UPDATE preview_flow_resources SET clone_prepared = TRUE, intent = $2 WHERE flow_id = $1',
    [intent.runtimeOperation.desired.flowId, JSON.stringify(intent)]);
  const receipt = {
    commitSha: attempt.input.identity.headSha,
    stagingUrl: 'http://candidate.fixture.invalid:3000',
    runtimeKind: 'kubernetes', runtimeName: intent.runtimeName, containerId: null,
    imageRef, buildRef: `${intent.buildOperation.namespace}/sv-p-${intent.attemptId.replace(/-/g, '')}`,
    physicalId: 'deployment-uid', attemptId: intent.attemptId,
  };
  await f.owner.recordRuntime(1, intent.runtimeOperation.desired.flowId, receipt);
  const proposed = { outcome: 'succeeded', result: { prepared: true, receipt } };
  await beforeCommit?.(attempt);
  await work.store.settle(attempt, proposed, work.handlers[PREPARE_RUNTIME].commit);
  assert.equal((await work.store.read(admitted.work.id)).result.accepted, true);
}

async function tick(work) {
  const worker = createExecutionWorker({ store: work.store, handlers: { [CONTINUE]: work.handlers[CONTINUE] }, concurrency: 1 });
  await worker.tick();
  await worker.drain();
}

test('C8 atomic head/work rollback, duplicate admission and web restart', { skip: !postgresEnabled }, async t => {
  const f = await fixture(t);
  const work = f.make();
  const session = await f.session();
  const oldPreview = session.staging_url;
  await assert.rejects(work.admit({ session, headSha: HEAD, async persistDetails(client) {
    await client.query("UPDATE chat_sessions SET pr_title = 'partial' WHERE id = 1");
    throw new Error('Injected admission error');
  } }), /Injected/);
  assert.equal((await f.session()).handoff_head_sha, null);
  assert.equal((await f.session()).pr_title, null);
  for (const table of ['execution_work_requests', 'cli_preview_receipts', 'cli_preview_decisions', 'preview_flows']) {
    assert.equal(Number((await f.pool.query(`SELECT COUNT(*) FROM ${table}`)).rows[0].count), 0);
  }
  const results = await Promise.all(Array.from({ length: 8 }, () => work.admit({ session, headSha: HEAD })));
  assert.equal(new Set(results.map(result => result.work.id)).size, 1);
  const retry = await f.make().admit({ session: await f.session(), headSha: HEAD });
  assert.equal(retry.work.id, results[0].work.id);
  assert.equal((await f.session()).staging_url, oldPreview);
  assert.equal(await enrolled(f.pool, 1), true);
});

test('C8 candidate/continuation atomicity, lost candidate reply and no stranded continuation', { skip: !postgresEnabled }, async t => {
  const f = await fixture(t);
  const work = f.make();
  const admitted = await work.admit({ session: await f.session(), headSha: HEAD });
  const enqueue = work.store.enqueue;
  work.store.enqueue = async (transaction, request) => {
    const result = await enqueue(transaction, request);
    if (request.workflow === CONTINUE) throw new Error('Injected continuation mapping failure');
    return result;
  };
  await assert.rejects(candidate(f, work, admitted), /Injected/);
  assert.equal((await f.owner.read(1)).flow.state, 'preparing');
  assert.equal(Number((await f.pool.query('SELECT COUNT(*) FROM execution_work_requests WHERE workflow = $1', [CONTINUE])).rows[0].count), 0);
  await f.pool.query('UPDATE execution_work_requests SET lease_until = clock_timestamp() - INTERVAL \'1 second\'');
  work.store.enqueue = enqueue;
  await candidate(f, work, admitted);
  const recovered = f.make();
  const continuation = await recovered.recover(1);
  assert.equal(continuation.workflow, CONTINUE);
  await tick(recovered);
  assert.equal((await recovered.recover(1)).status, 'succeeded');
  assert.equal((await recovered.owner.read(1)).handoff.phase, 'complete');
});

test('C8 lost activation/check replies adopt stored facts; concurrent forced rechecks join', { skip: !postgresEnabled }, async t => {
  const f = await fixture(t);
  const admittedWork = f.make();
  const admitted = await admittedWork.admit({ session: await f.session(), headSha: HEAD });
  await candidate(f, admittedWork, admitted);
  let lost = true;
  let checks = 0;
  const restart = f.make({ async capture(_c, session, _app, head) {
    checks++;
    await require('../src/services/visuals').storeChecks(f.pool, session.id, head, { state: 'failing', results: [] });
    if (lost) { lost = false; throw new Error('Injected lost verdict reply'); }
  } });
  await tick(restart);
  const continuation = await restart.recover(1);
  assert.equal(continuation.status, 'queued');
  await f.pool.query('UPDATE execution_work_requests SET due_at = clock_timestamp() WHERE id = $1', [continuation.id]);
  await tick(restart);
  assert.equal(checks, 1, 'Adopt failing as well as passing verdicts');
  assert.equal(f.creates(), 1);
  const rechecks = await Promise.all(Array.from({ length: 6 }, () => restart.recover(1, { force: true })));
  assert.equal(new Set(rechecks.map(work => work.id)).size, 1);
  await tick(restart);
  assert.equal(checks, 2);
  assert.equal(Number((await f.pool.query('SELECT COUNT(*) FROM execution_work_requests WHERE workflow = $1', [PREPARE_RUNTIME])).rows[0].count), 1);
});

test('C8 supersession at handoff never activates obsolete candidate or publishes old checks', { skip: !postgresEnabled }, async t => {
  const f = await fixture(t);
  const work = f.make();
  const old = await work.admit({ session: await f.session(), headSha: HEAD });
  await candidate(f, work, old);
  await f.pool.query('UPDATE chat_sessions SET handoff_uploaded_sha = $1 WHERE id = 1', [NEXT]);
  const successor = await work.admit({ session: await f.session(), headSha: NEXT });
  await tick(work);
  assert.equal(f.creates(), 0);
  assert.equal((await f.owner.read(1)).flow.id, successor.work.input.identity.flowId);
  assert.equal(await require('../src/services/visuals').storeChecks(f.pool, 1, HEAD, { state: 'passing', results: [] }), false);
  assert.equal((await f.session()).staging_url, 'https://serving.test');
  const off = createCliHandoffWork(f.pool, { ...f.config, nativeCliPreviewHandoffEnabled: false });
  const recovered = await Promise.all(Array.from({ length: 6 }, () => off.recover(1)));
  assert.equal(new Set(recovered.map(work => work.id)).size, 1);
  assert.equal(recovered[0].id, successor.work.id);
});

test('C8 completed preparation failure and missing-preview repair admit one fresh isolated attempt', { skip: !postgresEnabled }, async t => {
  const f = await fixture(t);
  const work = f.make();
  const first = await work.admit({ session: await f.session(), headSha: HEAD });
  const [attempt] = await work.store.claim(randomUUID(), [PREPARE_RUNTIME], 1);
  await work.store.settle(attempt, { outcome: 'succeeded', result: { prepared: false } }, work.handlers[PREPARE_RUNTIME].commit);
  assert.equal((await f.session()).check_state, 'error');
  const retries = await Promise.all(Array.from({ length: 6 }, () => work.recover(1, { force: true })));
  assert.equal(new Set(retries.map(work => work.id)).size, 1);
  assert.notEqual(retries[0].id, first.work.id);
  assert.notEqual(retries[0].input.intent.runtimeName, first.work.input.intent.runtimeName);
  await candidate(f, work, { work: retries[0] });
  await tick(work);
  const repairs = await Promise.all(Array.from({ length: 6 }, () => work.recover(1, { repair: true, expectedRuntimeName: retries[0].input.intent.runtimeName })));
  assert.equal(new Set(repairs.map(work => work.id)).size, 1);
  assert.notEqual(repairs[0].id, retries[0].id);
  assert.equal((await f.session()).staging_runtime_name, retries[0].input.intent.runtimeName,
    'Repair preserves the currently serving runtime until separate activation');
});

test('C8 promoted managed head requires the exact reviewed pin and shares preview guards', { skip: !postgresEnabled }, async t => {
  const f = await fixture(t);
  const work = f.make();
  await f.pool.query("UPDATE chat_sessions SET status = 'promoted', reviewed_head_sha = $1 WHERE id = 1", [NEXT]);
  const rejected = await work.admit({ session: await f.session(), headSha: HEAD });
  assert.equal(rejected.accepted, false);
  assert.equal(rejected.reason, 'reviewed_head_changed');
  assert.equal((await f.session()).handoff_head_sha, null);
  await f.pool.query('UPDATE chat_sessions SET reviewed_head_sha = $1 WHERE id = 1', [HEAD]);
  const admitted = await work.admit({ session: await f.session(), headSha: HEAD });
  await candidate(f, work, admitted);
  await tick(work);
  assert.equal((await work.owner.read(1)).handoff.phase, 'complete');
  assert.equal((await f.session()).status, 'promoted');
  const { reduce } = require('../src/services/cli-preview-handoff/reducer');
  for (const record of await work.owner.trace(1)) {
    assert.deepEqual(reduce(record.pre_state, record.action, record.facts), record.decision);
  }
});

test('C8 legacy activation recovery excludes the enrolled owner', { skip: !postgresEnabled }, async t => {
  const f = await fixture(t);
  const work = f.make();
  const admitted = await work.admit({ session: await f.session(), headSha: HEAD });
  await candidate(f, work, admitted);
  const state = await f.owner.read(1);
  await f.owner.apply({ type: 'RequestPreviewActivation', actionId: randomUUID(), sessionId: 1,
    flowId: state.flow.id, generation: state.flow.generation, headSha: HEAD,
    expected: { target: null, uid: null, token: null }, stagingUrl: 'https://preview.fixture.invalid' });
  const legacy = require('../src/services/preview-flow/activation').createActivation({
    lock: async () => assert.fail('Legacy activation timer must not claim enrolled intent'),
  });
  assert.deepEqual(await legacy.recover({ pool: f.pool, config: f.config }), []);
  assert.equal((await work.recover(1)).workflow, CONTINUE);
});

test('C8 unresolved activation rejects head acceptance and required work atomically', { skip: !postgresEnabled }, async t => {
  const f = await fixture(t);
  const work = f.make();
  const admitted = await work.admit({ session: await f.session(), headSha: HEAD });
  await candidate(f, work, admitted);
  const state = await f.owner.read(1);
  await f.owner.apply({ type: 'RequestPreviewActivation', actionId: randomUUID(), sessionId: 1,
    flowId: state.flow.id, generation: state.flow.generation, headSha: HEAD,
    expected: { target: null, uid: null, token: null }, stagingUrl: 'https://preview.fixture.invalid' });
  await f.pool.query('UPDATE chat_sessions SET handoff_uploaded_sha = $1 WHERE id = 1', [NEXT]);
  await assert.rejects(work.admit({ session: await f.session(), headSha: NEXT }), /activation_pending/);
  assert.equal((await f.session()).handoff_head_sha, HEAD);
  assert.equal((await f.session()).checks_commit_sha, HEAD);
  assert.equal((await f.owner.read(1)).flow.id, state.flow.id);
  assert.equal(Number((await f.pool.query('SELECT COUNT(*) FROM cli_preview_handoffs WHERE head_sha = $1', [NEXT])).rows[0].count), 0);
  assert.equal(Number((await f.pool.query('SELECT COUNT(*) FROM execution_work_requests WHERE workflow = $1', [PREPARE_RUNTIME])).rows[0].count), 1);
});

test('C8 enrolled aggregate rejects competing synchronous and durable preparation actions', { skip: !postgresEnabled }, async t => {
  const f = await fixture(t);
  const work = f.make();
  const admitted = await work.admit({ session: await f.session(), headSha: HEAD });
  for (const type of ['RequestPreview', 'RetryPreview', 'RequestCandidatePreview']) {
    const rejected = await f.owner.apply({ type, actionId: randomUUID(), sessionId: 1, headSha: HEAD, startedStatus: 'active' });
    assert.equal(rejected.decision.accepted, false);
    assert.equal(rejected.decision.reason, 'durable_owner_required');
    assert.equal(rejected.current.flow.id, admitted.work.input.identity.flowId);
  }
  const { replayDecision } = require('../src/services/preview-flow/reducer');
  for (const record of await f.owner.trace(1)) assert.deepEqual(replayDecision(record), record.decision);
  const original = (await f.owner.trace(1))[0];
  const historical = { ...original, reducer_version: 9, pre_state: { ...original.pre_state } };
  delete historical.pre_state.cliAdmission;
  assert.deepEqual(replayDecision(historical), original.decision, 'Retained v9 traces keep their original decision contract');
});

test('CLI admission uses the complete contract without enabling legacy Dev attempts', { skip: !postgresEnabled }, async t => {
  const f = await fixture(t);
  f.config.nativePreviewAttempts = false;
  const work = f.make();
  const result = await work.admit({ session: await f.session(), headSha: HEAD });
  assert.equal(result.accepted, true);
  assert.equal(require('../src/services/preview-flow/activation').enabled(f.config), false);
  assert.equal(require('../src/services/cli-preview-handoff/work').selected(f.config, { source: 'anthropic' }), false);
  assert.equal(f.config.nativePreviewAttempts, false, 'Legacy caller configuration stays unchanged');
});

test('C9 completion requires the verdict and release of manifest/lifecycle ownership', { skip: !postgresEnabled }, async t => {
  const f = await fixture(t);
  const runId = randomUUID();
  let captures = 0;
  const work = f.make({ async capture(_config, session, _app, headSha) {
    captures++;
    await f.pool.query(`INSERT INTO preview_operations (session_id, desired_revision, run_id, revision, state)
      VALUES ($1,$2,$3,$2,'running')`, [session.id, headSha, runId]);
    await require('../src/services/check-runs').record(f.pool, {
      runId, sessionId: session.id, commitSha: headSha, manifest: { launched: true, durableCli: true },
    });
    await require('../src/services/visuals').storeChecks(f.pool, session.id, headSha, { state: 'passing', results: [] });
  } });
  const admitted = await work.admit({ session: await f.session(), headSha: HEAD });
  await candidate(f, work, admitted);
  await tick(work);
  const identity = { sessionId: 1, flowId: admitted.work.input.identity.flowId, headSha: HEAD };
  const observed = () => work.owner.apply({ type: 'CliPreviewChecksObserved', actionId: randomUUID(), ...identity });
  assert.equal((await observed()).decision.accepted, false);
  await f.pool.query('DELETE FROM check_runs WHERE run_id = $1', [runId]);
  assert.equal((await observed()).decision.accepted, false, 'Lost manifest is not lifecycle release');
  await f.pool.query("UPDATE preview_operations SET state = 'completed' WHERE run_id = $1", [runId]);
  await f.pool.query('UPDATE execution_work_requests SET due_at = clock_timestamp() WHERE workflow = $1', [CONTINUE]);
  await tick(work);
  assert.equal((await work.recover(1)).status, 'succeeded');
  assert.equal(captures, 1);
  const { replayDecision } = require('../src/services/cli-preview-handoff/reducer');
  for (const entry of await work.owner.trace(1)) assert.deepEqual(replayDecision(entry), entry.decision);
  const historical = { reducer_version: 1, pre_state: (await work.owner.read(1)), action: {
    type: 'CliPreviewChecksObserved', actionId: randomUUID(), ...identity,
  } };
  historical.pre_state.checksOutstanding = true;
  assert.equal(replayDecision(historical).accepted, true, 'C8 traces preserve their original completion policy');
});

test('C10 unit resource receipt remains scoped to its admitted run after supersession', { skip: !postgresEnabled }, async t => {
  const f = await fixture(t);
  const checkRuns = require('../src/services/check-runs');
  const old = randomUUID();
  const next = randomUUID();
  for (const runId of [old, next]) {
    assert.equal(await checkRuns.record(f.pool, { runId, sessionId: 1, commitSha: runId === old ? HEAD : NEXT,
      manifest: { durableCli: true, launched: true, unitSuite: { version: 1, state: 'submitted' } } }), true);
  }
  await f.pool.query('UPDATE chat_sessions SET checks_commit_sha = $1 WHERE id = 1', [NEXT]);
  await checkRuns.observeUnitJob(f.pool, old, 1, { name: 'old-unit', uid: 'original-uid' });
  const read = async runId => (await f.pool.query('SELECT manifest FROM check_runs WHERE run_id = $1', [runId])).rows[0].manifest;
  assert.deepEqual((await read(old)).unitSuite, { version: 1, state: 'observed', job: { name: 'old-unit', uid: 'original-uid' } });
  assert.equal((await read(next)).unitSuite.state, 'submitted');
  await assert.rejects(checkRuns.observeUnitJob(f.pool, old, 1, { name: 'old-unit', uid: 'successor-uid' }), /lost its recovery manifest/);
  assert.equal((await read(old)).unitSuite.job.uid, 'original-uid');
  await assert.rejects(checkRuns.observeUnitJob(f.pool, next, 2, { name: 'next-unit', uid: 'next-uid' }), /lost its recovery manifest/);
});

test('C11 retirement journal requires the claimed owner and prior progress', { skip: !postgresEnabled }, async t => {
  const f = await fixture(t);
  const runs = require('../src/services/check-runs');
  const runId = randomUUID();
  const manifest = { durableCli: true, launched: true, unitSuite: { version: 1, state: 'submitted' } };
  assert.equal(await runs.record(f.pool, { runId, sessionId: 1, commitSha: HEAD, manifest }), true);
  const identified = { version: 1, namespace: f.config.kubernetes.workerNamespace,
    jobs: [{ kind: 'unit-suite', job: { name: 'job', uid: 'job-uid' },
      input: { name: 'input', uid: 'input-uid' }, stage: 'identified' }] };
  await runs.recordRetirement(f.pool, runId, 1, null, identified);
  const stopping = structuredClone(identified);
  stopping.jobs[0].stage = 'deleting-job';
  await runs.recordRetirement(f.pool, runId, 1, identified, stopping);
  await assert.rejects(runs.recordRetirement(f.pool, runId, 1, identified, identified), /ownership/);
  assert.deepEqual((await runs.read(f.pool, runId, 1)).manifest.retirement, stopping);
  await f.pool.query('UPDATE check_runs SET owner = $2 WHERE run_id = $1', [runId, 'successor-owner']);
  await assert.rejects(runs.recordRetirement(f.pool, runId, 1, stopping, identified), /ownership/);
  await assert.rejects(runs.recordRetirement(f.pool, runId, 999, stopping, identified), /ownership/);
  const stored = (await runs.read(f.pool, runId, 1)).manifest;
  assert.deepEqual(stored.retirement, stopping);
  assert.deepEqual(stored.unitSuite, manifest.unitSuite, 'Journal updates retain admission/provenance');
});

test('C11 retirement failure preserves a settled live verdict and recovery locator', { skip: !postgresEnabled }, async t => {
  const f = await fixture(t);
  await f.pool.query('ALTER TABLE chat_sessions ADD COLUMN imported_pr_head_sha TEXT');
  const runs = require('../src/services/check-runs');
  const retirement = require('../src/services/check-retirement');
  const { createLifecycle } = require('../src/services/preview-lifecycle');
  let runId;
  t.mock.method(retirement, 'retire', async (_config, pool, sessionId, id) => {
    runId = id;
    await runs.recordRetirement(pool, id, sessionId, null, { version: 1,
      namespace: f.config.kubernetes.workerNamespace, jobs: [] });
    throw new Error('Injected cleanup acknowledgment loss');
  });
  const lifecycle = createLifecycle({ poolFor: () => f.pool,
    checks: () => ({ cancelPreviewChecks: async () => {} }) });
  await assert.rejects(lifecycle.run(f.config, await f.session(), HEAD, 'capture', async operation => {
    operation.durableChecks = true;
    await runs.record(f.pool, { runId: operation.runId, sessionId: 1, commitSha: HEAD,
      manifest: { durableCli: true, launched: true, unitSuite: { version: 1, state: 'not-required' } } });
    await operation.pool.query("UPDATE chat_sessions SET check_state = 'passing' WHERE id = 1");
    return { state: 'passing' };
  }, { onError: async () => assert.fail('Cleanup cannot rewrite a persisted verdict') }), /acknowledgment loss/);
  assert.equal((await f.session()).check_state, 'passing');
  assert.equal((await runs.read(f.pool, runId, 1)).manifest.retirement.version, 1);
  assert.equal((await f.pool.query('SELECT state FROM preview_operations WHERE session_id = 1')).rows[0].state, 'running');
});
