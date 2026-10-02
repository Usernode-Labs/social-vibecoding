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
  await db.pool.query(`ALTER TABLE apps ADD COLUMN name TEXT,
      ADD COLUMN runtime_name TEXT, ADD COLUMN runtime_kind TEXT;
    ALTER TABLE chat_sessions ADD COLUMN imported_pr_head_sha TEXT`);
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


async function pendingChecks(t, manifest = { launched: true, durableCli: true,
  unitSuite: { version: 1, state: 'not-required' } }) {
  const f = await fixture(t);
  const work = f.make({ capture: async () => {} });
  const admitted = await work.admit({ session: await f.session(), headSha: HEAD });
  await candidate(f, work, admitted);
  await tick(work);
  const runId = randomUUID();
  await f.pool.query(`INSERT INTO preview_operations
    (session_id, desired_revision, run_id, revision, phase, state)
    VALUES (1,$1,$2,$1,'capture','running')`, [HEAD, runId]);
  const runs = require('../src/services/check-runs');
  if (manifest) assert.equal(await runs.record(f.pool, {
    runId, sessionId: 1, commitSha: HEAD, manifest,
  }), true);
  return { ...f, work, admitted, runId, runs };
}

function useChecksLifecycle(t, f) {
  const lifecycle = require('../src/services/preview-lifecycle');
  const local = lifecycle.createLifecycle({ poolFor: () => f.pool, lock: async (_c, _k, _id, run) => run() });
  t.mock.method(lifecycle, 'adopt', local.adopt);
  t.mock.method(lifecycle, 'settleAdopted', local.settleAdopted);
  return lifecycle;
}

async function blockChecks(f, reason = 'capture_creation_unconfirmed') {
  return require('../src/services/cli-preview-handoff/checks-outcome').blockOutcome(f.pool, {
    sessionId: 1, runId: f.runId, headSha: HEAD, reason, observedOwner: f.runs.selfOwner(),
  });
}

test('unknown checks: blocked outcome survives reply loss, restart and admission pause', { skip: !postgresEnabled }, async t => {
  const f = await pendingChecks(t);
  const first = await blockChecks(f);
  assert.equal(first.accepted, true);
  assert.equal(first.recovery.owner, 'check-harvest');
  const before = await f.work.owner.trace(1);
  const retry = await blockChecks(f);
  assert.deepEqual(retry.recovery, first.recovery, 'Adopt a commit whose reply was lost');
  assert.equal((await f.work.owner.trace(1)).length, before.length);
  const { readRecovery } = require('../src/services/cli-preview-handoff/checks-outcome');
  assert.deepEqual(await readRecovery(f.pool, await f.session()), first.recovery);
  const serving = (await f.session()).staging_runtime_name;
  f.config.nativeCliPreviewHandoffEnabled = false;
  const restart = f.make({ capture: async () => {} });
  const original = await restart.recover(1);
  const retries = await Promise.all(Array.from({ length: 6 }, () => restart.recover(1, { force: true })));
  assert.ok(retries.every(item => item.id === original.id));
  await f.pool.query('UPDATE execution_work_requests SET due_at = clock_timestamp() WHERE id = $1', [original.id]);
  await tick(restart);
  const waiting = await restart.recover(1);
  assert.equal(waiting.status, 'queued');
  assert.equal(waiting.result.checksBlocked.runId, f.runId);
  assert.equal((await f.session()).check_state, 'pending');
  assert.equal((await f.session()).staging_runtime_name, serving);
  assert.equal(f.creates(), 1);
  const { replayDecision } = require('../src/services/cli-preview-handoff/reducer');
  for (const entry of await restart.owner.trace(1)) assert.deepEqual(replayDecision(entry), entry.decision);
  const historical = { reducer_version: 2, pre_state: await restart.owner.read(1), action: {
    type: 'RequestCliPreviewChecks', actionId: randomUUID(), sessionId: 1,
    flowId: f.admitted.work.input.identity.flowId, headSha: HEAD, force: true,
  } };
  assert.equal(replayDecision(historical).accepted, true, 'Retained v2 does not acquire the new v3 guard');
});

test('unknown checks: persistence error rolls back block, manifest and journals', { skip: !postgresEnabled }, async t => {
  const f = await pendingChecks(t, null);
  const connect = f.pool.connect.bind(f.pool);
  let fail = true;
  const faulty = {
    query: f.pool.query.bind(f.pool),
    async connect() {
      const client = await connect();
      return {
        release: () => client.release(),
        async query(sql, values) {
          const result = await client.query(sql, values);
          if (fail && sql.startsWith('UPDATE cli_preview_handoffs SET checks_recovery')) {
            throw new Error('Injected mapping error after writes');
          }
          return result;
        },
      };
    },
  };
  const outcome = require('../src/services/cli-preview-handoff/checks-outcome');
  const report = () => outcome.blockOutcome(faulty, {
    sessionId: 1, runId: f.runId, headSha: HEAD, reason: 'manifest_missing', observedOwner: null,
  });
  const traces = (await f.work.owner.trace(1)).length;
  await assert.rejects(report(), /Injected mapping/);
  assert.equal((await f.work.owner.read(1)).handoff.checks_recovery, null);
  assert.equal(await f.runs.read(f.pool, f.runId, 1), null);
  assert.equal((await f.work.owner.trace(1)).length, traces);
  fail = false;
  assert.equal((await report()).accepted, true);
  assert.equal((await f.runs.read(f.pool, f.runId, 1)).manifest.reconstruction, 'unknown-launch');
});

test('unknown checks: current lifecycle, owner, head and flow fence reports', { skip: !postgresEnabled }, async t => {
  const f = await pendingChecks(t);
  const action = {
    type: 'CliChecksOutcomeBlocked', actionId: randomUUID(), sessionId: 1,
    flowId: f.admitted.work.input.identity.flowId, headSha: HEAD, runId: f.runId,
    reason: 'capture_creation_unconfirmed', observedOwner: 'other-owner',
  };
  assert.equal((await f.work.owner.apply(action)).decision.reason, 'checks_owner_changed');
  action.observedOwner = f.runs.selfOwner();
  action.actionId = randomUUID();
  await f.pool.query('UPDATE preview_operations SET desired_revision = $1 WHERE session_id = 1', [NEXT]);
  assert.equal((await f.work.owner.apply(action)).decision.reason, 'checks_run_changed');
  await f.pool.query('UPDATE preview_operations SET desired_revision = $1 WHERE session_id = 1', [HEAD]);
  action.actionId = randomUUID();
  action.flowId = randomUUID();
  assert.equal((await f.work.owner.apply(action)).decision.reason, 'superseded_handoff');
  assert.equal((await f.work.owner.read(1)).handoff.checks_recovery, null);
});

for (const kind of ['capture', 'unit']) {
  test(`unknown checks: delayed ${kind} is adopted, not re-created`, { skip: !postgresEnabled }, async t => {
    const f = await pendingChecks(t, { launched: true, durableCli: true,
      unitSuite: { version: 1, state: kind === 'unit' ? 'submitted' : 'not-required' } });
    useChecksLifecycle(t, f);
    const kubernetes = require('../src/services/kubernetes');
    const visuals = require('../src/services/visuals');
    const harvest = require('../src/services/check-harvest');
    let arrived = false;
    let collections = 0;
    t.mock.method(kubernetes, 'findCheckJobs', async () => ({
      capture: kind === 'unit' || arrived ? { name: 'capture', uid: 'capture-uid' } : null,
      unitSuite: kind === 'unit' && arrived ? { name: 'unit', uid: 'unit-uid' } : null,
    }));
    t.mock.method(kubernetes, 'collectCheckJob', async () => {
      collections++;
      return { state: 'succeeded', stdout: 'verified fixture output', stderr: '', exitCode: 0 };
    });
    t.mock.method(kubernetes, 'runCaptureJob', async () => assert.fail('No competing capture'));
    t.mock.method(kubernetes, 'runUnitSuiteJob', async () => assert.fail('No competing unit suite'));
    t.mock.method(require('../src/services/check-retirement'), 'retire', async () => {
      assert.equal(arrived, true);
      return { complete: true };
    });
    t.mock.method(visuals, 'scheduleShots', () => {});
    t.mock.method(visuals, 'maybeAutoMergeAfterChecks', () => {});
    t.mock.method(visuals, 'noteBotChecksAfterChecks', () => {});
    t.mock.method(visuals, 'settleCaptureRun', async (_c, pool, run) => {
      assert.equal(run.commitHash, HEAD);
      if (kind === 'unit') assert.ok(run.unitOutcome.row);
      await visuals.storeChecks(pool, 1, HEAD, { state: 'passing', results: [] });
      return { traceStatus: 'passing', result: { state: 'passing' } };
    });
    const adopt = async () => harvest.adopt(f.config, f.pool, await f.runs.read(f.pool, f.runId, 1));
    assert.equal((await adopt()).outcome, 'blocked');
    assert.equal(collections, 0);
    assert.equal((await f.work.owner.read(1)).handoff.checks_recovery.reason, `${kind}_creation_unconfirmed`);
    const binding = (await f.session()).staging_runtime_name;
    arrived = true;
    assert.equal((await adopt()).outcome, 'settled');
    assert.equal(await f.runs.read(f.pool, f.runId, 1), null);
    assert.equal((await f.session()).staging_runtime_name, binding);
    const continuation = await f.work.recover(1);
    await f.pool.query('UPDATE execution_work_requests SET due_at = clock_timestamp() WHERE id = $1', [continuation.id]);
    await tick(f.work);
    assert.equal((await f.work.recover(1)).status, 'succeeded');
    assert.equal((await f.work.owner.read(1)).handoff.checks_recovery, null);
    assert.equal(f.creates(), 1);
  });
}

for (const manifest of [null, { launched: false, durableCli: true }]) {
  test(`unknown checks: ${manifest ? 'provisional' : 'missing'} manifest cannot authorize fresh execution`, { skip: !postgresEnabled }, async t => {
    const f = await pendingChecks(t, manifest);
    const recovery = require('../src/services/cli-preview-handoff/checks');
    const result = await recovery.recoverCaptureRun(f.config, {
      pool: f.pool, session: await f.session(),
      previous: (await f.pool.query('SELECT * FROM preview_operations WHERE session_id = 1')).rows[0], force: true,
    });
    assert.equal(result.handled, true);
    const blocked = (await f.work.owner.read(1)).handoff.checks_recovery;
    assert.equal(blocked.reason, manifest ? 'launch_manifest_incomplete' : 'manifest_missing');
    await f.pool.query('UPDATE chat_sessions SET handoff_uploaded_sha = $1 WHERE id = 1', [NEXT]);
    const successor = await f.work.admit({ session: await f.session(), headSha: NEXT });
    assert.equal(successor.accepted, true);
    const old = await f.runs.read(f.pool, f.runId, 1);
    assert.ok(old, 'Supersession keeps the original cleanup locator');
    t.mock.method(require('../src/services/kubernetes'), 'retireCheckResources', async () => ({ jobs: [
      { kind: 'capture', stage: 'released' }, { kind: 'unit-suite', stage: 'released' },
    ] }));
    const retired = await require('../src/services/check-retirement').retire(f.config, f.pool, 1, f.runId);
    assert.equal(retired.complete, false, 'Visible retirement cannot reconstruct unknown original creation');
    assert.equal((await f.work.owner.read(1)).handoff.checks_recovery, null);
    assert.equal((await f.session()).checks_commit_sha, NEXT);
    assert.ok(await f.runs.read(f.pool, f.runId, 1));
  });
}

test('unknown checks: launching process exposes lost external acknowledgment without retiring the run', { skip: !postgresEnabled }, async t => {
  const f = await pendingChecks(t);
  await f.pool.query('DELETE FROM preview_operations WHERE session_id = 1');
  await f.runs.finish(f.pool, f.runId);
  const lifecycle = require('../src/services/preview-lifecycle').createLifecycle({
    poolFor: () => f.pool, lock: async (_c, _k, _id, run) => run(),
    checks: () => ({ cancelPreviewChecks: async () => {} }),
  });
  const result = await lifecycle.run(f.config, await f.session(), HEAD, 'capture', async operation => {
    operation.durableChecks = true;
    f.runId = operation.runId;
    assert.equal(await f.runs.record(f.pool, {
      sessionId: 1, runId: operation.runId, commitSha: HEAD,
      manifest: { launched: true, durableCli: true, unitSuite: { version: 1, state: 'submitted' } },
    }), true);
    throw Object.assign(new Error('Injected unit POST reply loss'), { code: 'UNIT_SUITE_EXECUTION_UNCONFIRMED' });
  }, { onError: async () => assert.fail('Unknown is not a confirmed failure verdict') });
  assert.equal(result.checksBlocked.reason, 'unit_outcome_unconfirmed');
  assert.equal((await f.pool.query('SELECT state FROM preview_operations WHERE session_id = 1')).rows[0].state, 'running');
  assert.equal((await f.session()).check_state, 'pending');
  assert.ok(await f.runs.read(f.pool, f.runId, 1));
});

test('unknown checks: vanished/deadline/lost output stays adoptable, transport errors retry, later output settles', { skip: !postgresEnabled }, async t => {
  const f = await pendingChecks(t);
  useChecksLifecycle(t, f);
  const kubernetes = require('../src/services/kubernetes');
  const visuals = require('../src/services/visuals');
  const harvest = require('../src/services/check-harvest');
  let observation = { state: 'gone', stdout: '' };
  let unavailable = false;
  t.mock.method(kubernetes, 'findCheckJobs', async () => {
    if (unavailable) throw new Error('Injected temporary inspection error');
    return { capture: { name: 'same-capture', uid: 'same-uid' }, unitSuite: null };
  });
  t.mock.method(kubernetes, 'collectCheckJob', async () => observation);
  t.mock.method(require('../src/services/check-retirement'), 'retire', async () => {
    assert.equal(observation.state, 'succeeded');
    assert.equal(observation.partialReason, undefined);
    return { complete: true };
  });
  t.mock.method(visuals, 'scheduleShots', () => {});
  t.mock.method(visuals, 'maybeAutoMergeAfterChecks', () => {});
  t.mock.method(visuals, 'noteBotChecksAfterChecks', () => {});
  t.mock.method(visuals, 'settleCaptureRun', async (_config, pool) => {
    await visuals.storeChecks(pool, 1, HEAD, { state: 'failing', results: [] });
    return { traceStatus: 'failing', result: { state: 'failing' } };
  });
  const adopt = async () => harvest.adopt(f.config, f.pool, await f.runs.read(f.pool, f.runId, 1));
  for (const [outcome, reason] of [
    [{ state: 'gone', stdout: '' }, 'capture_outcome_unconfirmed'],
    [{ state: 'timeout', stdout: 'partial' }, 'capture_deadline_unconfirmed'],
    [{ state: 'succeeded', stdout: 'partial', partialReason: 'capture log unavailable' }, 'capture_output_unavailable'],
  ]) {
    observation = outcome;
    assert.equal((await adopt()).outcome, 'blocked');
    assert.equal((await f.work.owner.read(1)).handoff.checks_recovery.reason, reason);
    assert.equal((await f.session()).check_state, 'pending');
    assert.equal((await f.pool.query('SELECT state FROM preview_operations WHERE session_id = 1')).rows[0].state, 'running');
  }
  unavailable = true;
  assert.equal((await adopt()).outcome, 'failed');
  assert.equal((await f.pool.query('SELECT state FROM preview_operations WHERE session_id = 1')).rows[0].state, 'running',
    'An inspection exception must not close the lifecycle and strand the original run');
  unavailable = false;
  observation = { state: 'succeeded', stdout: 'recovered frames' };
  assert.equal((await adopt()).outcome, 'settled');
  assert.equal((await f.session()).check_state, 'failing', 'Adopt the actual failing verdict without re-running it');
});

test('unknown checks: conflicting unit UID blocks adoption and keeps successor untouched', { skip: !postgresEnabled }, async t => {
  const f = await pendingChecks(t, { launched: true, durableCli: true, unitSuite: {
    version: 1, state: 'observed', job: { name: 'unit', uid: 'original' },
  } });
  useChecksLifecycle(t, f);
  const kubernetes = require('../src/services/kubernetes');
  const harvest = require('../src/services/check-harvest');
  t.mock.method(kubernetes, 'findCheckJobs', async () => ({
    capture: { name: 'capture', uid: 'original-capture' }, unitSuite: { name: 'unit', uid: 'successor' },
  }));
  t.mock.method(kubernetes, 'collectCheckJob', async () => assert.fail('Conflicting output cannot be consumed'));
  t.mock.method(require('../src/services/check-retirement'), 'retire', async () => assert.fail('Current uncertain outcome cannot retire successor'));
  const result = await harvest.adopt(f.config, f.pool, await f.runs.read(f.pool, f.runId, 1));
  assert.equal(result.outcome, 'blocked');
  assert.equal(result.recovery.reason, 'unit_ownership_conflict');
  assert.equal((await f.runs.read(f.pool, f.runId, 1)).manifest.unitSuite.job.uid, 'original');
});

test('unknown checks: retained predecessors cannot hide the enrolled current run from reconciliation', { skip: !postgresEnabled }, async t => {
  const f = await pendingChecks(t);
  useChecksLifecycle(t, f);
  t.mock.method(require('../src/services/kubernetes'), 'findCheckJobs', async () => ({ capture: null, unitSuite: null }));
  for (let index = 0; index < 55; index++) {
    await f.pool.query(`INSERT INTO check_runs (run_id, session_id, commit_sha, owner, manifest, started_at)
      VALUES ($1,1,$2,$3,$4,NOW() - INTERVAL '1 hour')`, [
      randomUUID(), NEXT, f.runs.selfOwner(), JSON.stringify({ launched: true, durableCli: true }),
    ]);
  }
  const outcome = await require('../src/services/cli-preview-handoff/checks').recoverCaptureRun(f.config, {
    pool: f.pool, session: await f.session(),
    previous: (await f.pool.query('SELECT * FROM preview_operations WHERE session_id = 1')).rows[0],
  });
  // Only external Job discovery is injected; selection/admission/state are SQL.
  // No cluster endpoint belongs to this PostgreSQL-only fixture.
  assert.equal(outcome.handled, true);
  assert.equal(outcome.result.checksBlocked.runId, f.runId);
  assert.equal((await f.pool.query('SELECT COUNT(*) FROM check_runs')).rows[0].count, '56',
    'Earlier obligations remain discoverable');
});
