'use strict';

const { replayHistorical } = require('./lib/historical-replay');

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

const { fixture, candidate, tick, manualServer } = require('./lib/manual-preview-fixture');

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
  assert.deepEqual(replayHistorical('preview-flow', historical), original.decision, 'Retained v9 traces keep their original decision contract');
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
  assert.equal(replayHistorical('cli-preview-handoff', historical).accepted, true, 'C8 traces preserve their original completion policy');
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
  assert.equal(replayHistorical('cli-preview-handoff', historical).accepted, true, 'Retained v2 does not acquire the new v3 guard');
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

test('unavailable unit inspection retains a provisional run and cannot settle or launch replacement checks', { skip: !postgresEnabled }, async t => {
  const f = await pendingChecks(t);
  await f.pool.query('DELETE FROM preview_operations WHERE session_id = 1');
  await f.runs.finish(f.pool, f.runId);
  t.mock.method(require('../src/services/github'), 'isEnabled', () => false);
  const kubernetes = require('../src/services/kubernetes');
  t.mock.method(kubernetes, 'runCaptureJob', async () => assert.fail('No capture dispatch before inspection'));
  t.mock.method(kubernetes, 'runUnitSuiteJob', async () => assert.fail('No unit dispatch before inspection'));
  const lifecycle = require('../src/services/preview-lifecycle').createLifecycle({
    poolFor: () => f.pool,
    lock: async (_config, _classifier, _sessionId, run) => run(),
    checks: () => ({ cancelPreviewChecks: async () => {} }),
  });
  const serving = (await f.session()).staging_runtime_name;
  const result = await lifecycle.run(f.config, await f.session(), HEAD, 'capture', async operation => {
    operation.durableChecks = true;
    f.runId = operation.runId;
    assert.equal(await f.runs.record(f.pool, {
      sessionId: 1,
      runId: operation.runId,
      commitSha: HEAD,
      manifest: { launched: false, durableCli: true },
    }), true);
    await require('../src/services/unit-suite').inspectRequirement({
      repoOwner: 'fixture', repoName: 'app', ref: HEAD,
    });
    assert.fail('Unavailable inspection must not authorize dispatch or a verdict');
  }, { onError: async () => assert.fail('Unknown requirement cannot publish an error verdict') });

  assert.equal(result.checksBlocked.reason, 'launch_manifest_incomplete');
  assert.equal((await f.session()).check_state, 'pending');
  assert.equal((await f.session()).staging_runtime_name, serving);
  const previous = (await f.pool.query('SELECT * FROM preview_operations WHERE session_id = 1')).rows[0];
  assert.equal(previous.state, 'running');
  assert.equal(previous.run_id, f.runId);
  const recovery = await require('../src/services/cli-preview-handoff/checks').recoverCaptureRun(f.config, {
    pool: f.pool, session: await f.session(), previous, force: true,
  });
  assert.equal(recovery.handled, true);
  assert.ok(await f.runs.read(f.pool, f.runId, 1), 'Unknown admission retains its reconciliation locator');
});

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

// Real HTTP handlers and PostgreSQL. Authentication/collaboration identity and
// external services are injected; these tests cannot contact GitHub or a cluster.
test('manual enrolled deploy/ensure/recheck join one durable preparation with admission disabled', { skip: !postgresEnabled }, async t => {
  const f = await fixture(t);
  const work = f.make();
  const admitted = await work.admit({ session: await f.session(), headSha: HEAD });
  f.config.nativeCliPreviewHandoffEnabled = false;
  const request = await manualServer(t, f, f.make());
  const paths = ['deploy-staging', 'ensure-staging', 'recheck'];
  const responses = await Promise.all(Array.from({ length: 9 }, (_, index) => request(paths[index % paths.length])));
  assert.ok(responses.every(result => result.status === 200));
  assert.deepEqual(new Set(responses.map(result => result.body.workId)), new Set([admitted.work.id]));
  assert.equal((await f.session()).checks_commit_sha, HEAD);
  assert.equal((await f.session()).staging_url, 'https://serving.test');
  assert.equal((await work.owner.trace(1)).length, 1);
});

test('manual enrolled recheck rolls back pending reset and joins after web loss/lost response', { skip: !postgresEnabled }, async t => {
  const f = await fixture(t);
  const work = f.make();
  const admitted = await work.admit({ session: await f.session(), headSha: HEAD });
  await candidate(f, work, admitted);
  await tick(work);
  assert.equal((await f.session()).check_state, 'passing');
  const tracesBefore = (await work.owner.trace(1)).length;
  const enqueue = work.store.enqueue;
  let failEnqueue = true;
  work.store.enqueue = async (...args) => {
    const queued = await enqueue(...args);
    if (failEnqueue) throw new Error('Injected continuation write failure');
    return queued;
  };
  const request = await manualServer(t, f, work);
  assert.equal((await request('recheck')).status, 500);
  assert.equal((await f.session()).check_state, 'passing', 'No route-local reset survives failed admission');
  assert.equal((await work.owner.trace(1)).length, tracesBefore);
  failEnqueue = false;

  const recover = work.recover;
  let loseReply = true;
  t.mock.method(work, 'recover', async (...args) => {
    const result = await recover(...args);
    if (loseReply) {
      loseReply = false;
      throw new Error('Injected lost reply after commit');
    }
    return result;
  });
  assert.equal((await request('recheck')).status, 500);
  const pending = await f.make().recover(1);
  assert.equal(pending.workflow, CONTINUE);
  const retry = await request('recheck');
  assert.equal(retry.status, 200);
  assert.equal(retry.body.workId, pending.id);
  await tick(f.make());
  assert.equal((await f.session()).check_state, 'passing');
  assert.equal((await f.make().recover(1)).status, 'succeeded');
  assert.equal(Number((await f.pool.query('SELECT COUNT(*) FROM execution_work_requests WHERE workflow = $1', [PREPARE_RUNTIME])).rows[0].count), 1);
});

test('manual enrolled deployment requests one isolated repair and preserves serving until activation', { skip: !postgresEnabled }, async t => {
  const f = await fixture(t);
  const work = f.make();
  const original = await work.admit({ session: await f.session(), headSha: HEAD });
  await candidate(f, work, original);
  await tick(work);
  const serving = await f.session();
  const request = await manualServer(t, f, work);
  const responses = await Promise.all(Array.from({ length: 6 }, () => request('deploy-staging')));
  assert.ok(responses.every(result => result.status === 200));
  assert.equal(new Set(responses.map(result => result.body.workId)).size, 1);
  const repair = await work.store.read(responses[0].body.workId);
  assert.notEqual(repair.input.intent.runtimeName, serving.staging_runtime_name);
  assert.equal((await f.session()).staging_runtime_name, serving.staging_runtime_name);
  assert.equal((await f.session()).staging_url, serving.staging_url);
  await candidate(f, f.make(), { work: repair });
  await tick(f.make());
  assert.equal((await f.session()).staging_runtime_name, repair.input.intent.runtimeName);
});

test('manual enrolled requests expose blocked work and cannot create fresh preparation with admission off', { skip: !postgresEnabled }, async t => {
  const f = await fixture(t);
  const work = f.make();
  const admitted = await work.admit({ session: await f.session(), headSha: HEAD });
  await f.pool.query("UPDATE execution_work_requests SET status = 'blocked' WHERE id = $1", [admitted.work.id]);
  const request = await manualServer(t, f, work);
  for (const path of ['deploy-staging', 'recheck']) {
    const result = await request(path);
    assert.equal(result.status, 409);
    assert.equal(result.body.error, 'durable_work_blocked');
  }
  await f.pool.query("UPDATE execution_work_requests SET status = 'succeeded', result = '{\"prepared\":false}' WHERE id = $1", [admitted.work.id]);
  f.config.nativeCliPreviewHandoffEnabled = false;
  assert.equal((await request('deploy-staging')).status, 409);
  assert.equal(Number((await f.pool.query('SELECT COUNT(*) FROM execution_work_requests')).rows[0].count), 1);
});

test('manual enrolled route keeps author/admin/status/headless and browser-origin guards', { skip: !postgresEnabled }, async t => {
  const f = await fixture(t);
  const work = f.make();
  await work.admit({ session: await f.session(), headSha: HEAD });
  const request = await manualServer(t, f, work);
  assert.equal((await request('deploy-staging', { 'x-test-user': '2' })).status, 404);
  assert.equal((await request('recheck', { 'x-test-user': '2' })).status, 403);
  assert.equal((await request('recheck', { 'x-test-user': '2', 'x-test-admin': 'true' })).status, 200);
  assert.equal((await request('recheck', { 'sec-fetch-site': 'same-site' })).status, 403);
  await f.pool.query('UPDATE chat_sessions SET is_headless = TRUE WHERE id = 1');
  assert.equal((await request('deploy-staging')).status, 404);
  await f.pool.query("UPDATE chat_sessions SET status = 'archived' WHERE id = 1");
  assert.equal((await request('recheck')).status, 409);
});

test('stale manual repair/recheck cannot initiate work on a completed successor', { skip: !postgresEnabled }, async t => {
  const f = await fixture(t);
  const work = f.make();
  const first = await work.admit({ session: await f.session(), headSha: HEAD });
  await candidate(f, work, first);
  await tick(work);
  const old = await f.session();
  await f.pool.query('UPDATE chat_sessions SET handoff_uploaded_sha = $1 WHERE id = 1', [NEXT]);
  const successor = await work.admit({ session: await f.session(), headSha: NEXT });
  await candidate(f, work, successor);
  await tick(work);
  const current = await f.session();
  const traceCount = (await work.owner.trace(1)).length;
  const obligations = Number((await f.pool.query('SELECT COUNT(*) FROM execution_work_requests')).rows[0].count);
  for (const options of [
    { force: true, expectedHeadSha: old.checks_commit_sha },
    { repair: true, expectedHeadSha: old.checks_commit_sha, expectedRuntimeName: old.staging_runtime_name },
  ]) assert.equal((await f.make().recover(1, options)).status, 'succeeded');
  const rejected = (await work.owner.trace(1)).slice(traceCount);
  assert.deepEqual(rejected.map(entry => entry.decision.reason), ['superseded_handoff', 'preview_changed']);
  assert.ok(rejected.every(entry => !entry.decision.accepted));
  assert.equal(Number((await f.pool.query('SELECT COUNT(*) FROM execution_work_requests')).rows[0].count), obligations);
  assert.equal((await f.session()).check_state, 'passing');
  assert.equal((await f.session()).staging_runtime_name, current.staging_runtime_name);
});

test('manual enrolled requests cannot substitute a fresh head for an unconfirmed request revision', { skip: !postgresEnabled }, async t => {
  const f = await fixture(t);
  const work = f.make();
  await work.admit({ session: await f.session(), headSha: HEAD });
  const request = await manualServer(t, f, work);
  const traceCount = (await work.owner.trace(1)).length;
  await f.pool.query('UPDATE chat_sessions SET checks_commit_sha = NULL WHERE id = 1');
  for (const path of ['deploy-staging', 'ensure-staging', 'recheck']) {
    const result = await request(path);
    assert.equal(result.status, 409);
    assert.equal(result.body.error, 'durable_revision_unconfirmed');
  }
  assert.equal((await work.owner.trace(1)).length, traceCount);
  assert.equal((await f.session()).checks_commit_sha, null);
  assert.equal(Number((await f.pool.query('SELECT COUNT(*) FROM execution_work_requests')).rows[0].count), 1);
});

// Real sync-to-handoff integration. Git facts, preparation resources, activation
// I/O and checks are substituted; admission, policy persistence and work are real.
async function syncFixture(t, { promoted = false, moveKind = 'mechanical' } = {}) {
  const f = await fixture(t);
  await f.pool.query(`ALTER TABLE chat_sessions ADD COLUMN pr_summary_input_version INTEGER DEFAULT 0,
    ADD COLUMN pr_summary_md TEXT, ADD COLUMN pr_summary_previous_md TEXT,
    ADD COLUMN pr_summary_stale BOOLEAN DEFAULT FALSE, ADD COLUMN pr_summary_source TEXT,
    ADD COLUMN pr_summary_source_head_sha TEXT, ADD COLUMN shots_state TEXT,
    ADD COLUMN shots_run_id TEXT, ADD COLUMN shots_detail JSONB, ADD COLUMN shots_updated_at TIMESTAMPTZ;
    CREATE TABLE users (id INTEGER PRIMARY KEY)`);
  const schema = require('node:fs').readFileSync(require.resolve('../src/db/schema.sql'), 'utf8');
  await f.pool.query(schema.match(/CREATE TABLE IF NOT EXISTS shot_runs \([\s\S]*?\n\);/)[0]);
  const work = f.make();
  const original = await work.admit({ session: await f.session(), headSha: HEAD });
  await f.pool.query(`UPDATE chat_sessions SET status = $1, reviewed_head_sha = $2,
    approval_epoch = 7, pr_summary_md = 'Existing explanation', shots_state = 'reviewing',
    shots_run_id = $3, shots_detail = $4 WHERE id = 1`, [
    promoted ? 'promoted' : 'active', promoted ? HEAD : null,
    '1'.repeat(32), JSON.stringify({ headSha: HEAD, required: true }),
  ]);
  await f.pool.query(`INSERT INTO shot_runs (id, session_id, base_sha, head_sha, intent, state)
    VALUES ($1,1,$2,$2,'{}','reviewing')`, ['1'.repeat(32), HEAD]);
  const snapshot = async () => ({ ...(await f.session()), repo_url: 'https://github.com/example/demo', app_slug: 'demo' });
  const deps = {
    work,
    github: { async getBranchSha() { return NEXT; } },
    mirror: {
      async ensureMirror() { return '/injected/git-mirror'; },
      async defaultBranchSha() { return 'c'.repeat(40); },
      async resolveBranch() { return NEXT; },
    },
    integration: { async classifyHeadMove() { return { kind: moveKind }; } },
    votes: { async announceNativeHeadMove() {} },
    pipeline: { beginHandoffPipeline() { throw new Error('Legacy staging tail forbidden'); } },
    prImportSync: { rerunChecksForNewHead() { throw new Error('Legacy promoted tail forbidden'); } },
  };
  const reconcile = (session, overrides = {}, selectedDeps = deps) => require('../src/services/cli-handoff-sync')
    .reconcileCliHandoffSync({
      config: f.config, pool: f.pool, session, newHead: NEXT,
      workerResult: { syncResult: 'clean', pushOk: true, sha: NEXT }, ...overrides,
    }, selectedDeps);
  return { ...f, original, work, deps, snapshot, reconcile };
}

for (const promoted of [false, true]) {
  test(`enrolled sync atomically admits ${promoted ? 'promoted' : 'active'} revision and durable continuation`,
    { skip: !postgresEnabled }, async t => {
      const f = await syncFixture(t, { promoted });
      const session = await f.snapshot();
      const serving = Object.fromEntries(Object.entries(session).filter(([key]) => key.startsWith('staging_')));
      const results = await Promise.all(Array.from({ length: 6 }, () => f.reconcile(session)));
      assert.ok(results.every(result => result.ok));
      assert.equal(new Set(results.map(result => result.workId)).size, 1);
      assert.equal(results.filter(result => result.applied).length, 1);
      const current = await f.session();
      assert.equal(current.handoff_head_sha, NEXT);
      assert.equal(current.checks_commit_sha, NEXT);
      assert.equal(current.approval_epoch, 7, 'Mechanical sync preserves approvals');
      assert.equal(current.pr_summary_stale, true);
      assert.equal(current.pr_summary_previous_md, 'Existing explanation');
      assert.equal((await f.pool.query('SELECT state FROM shot_runs')).rows[0].state, 'cancelled');
      for (const [key, value] of Object.entries(serving)) assert.equal(current[key], value);
      assert.equal(Number((await f.pool.query(`SELECT COUNT(*) FROM execution_work_requests
        WHERE workflow = $1 AND input->'identity'->>'headSha' = $2`, [PREPARE_RUNTIME, NEXT])).rows[0].count), 1);
      const restart = f.make();
      const preparation = await restart.recover(1);
      assert.equal(preparation.id, results[0].workId);
      // Claim only the accepted revision; old queued work must not publish.
      await f.pool.query("UPDATE execution_work_requests SET status = 'succeeded' WHERE id = $1", [f.original.work.id]);
      await candidate(f, restart, { work: preparation });
      const continuation = await f.make().recover(1);
      assert.equal(continuation.workflow, CONTINUE);
      await tick(f.make());
      assert.equal((await f.session()).check_state, 'passing');
      assert.equal((await f.session()).staging_commit_sha, NEXT);
      assert.equal((await f.make().recover(1)).status, 'succeeded');
      const { replayDecision } = require('../src/services/cli-preview-handoff/reducer');
      for (const entry of await restart.owner.trace(1)) assert.deepEqual(replayDecision(entry), entry.decision);
    });
}

for (const promoted of [false, true]) {
  test(`enrolled ${promoted ? 'promoted' : 'active'} sync rolls back partial writes and adopts a lost commit reply`,
    { skip: !postgresEnabled }, async t => {
      const f = await syncFixture(t, { promoted, moveKind: 'authored' });
      const before = await f.snapshot();
      const request = f.work.preview.requestInTransaction;
      f.work.preview.requestInTransaction = async (...args) => {
        await request(...args);
        throw new Error('Injected interruption after preparation write');
      };
      await assert.rejects(f.reconcile(before), /Injected interruption/);
      assert.deepEqual(await f.snapshot(), before);
      assert.equal((await f.pool.query('SELECT state FROM shot_runs')).rows[0].state, 'reviewing');
      assert.equal(Number((await f.pool.query('SELECT COUNT(*) FROM execution_work_requests')).rows[0].count), 1);
      f.work.preview.requestInTransaction = request;

      let lost = false;
      const losingPool = {
        query: (...args) => f.pool.query(...args),
        async connect() {
          const client = await f.pool.connect();
          return {
            async query(...args) {
              const result = await client.query(...args);
              if (!lost && args[0] === 'COMMIT') {
                lost = true;
                throw new Error('Injected lost COMMIT reply');
              }
              return result;
            },
            release: () => client.release(),
          };
        },
      };
      const losing = createCliHandoffWork(losingPool, f.config);
      await assert.rejects(f.reconcile(before, {}, { ...f.deps, work: losing }), /lost COMMIT/);
      const replay = await f.reconcile(before);
      assert.equal(replay.ok, true);
      assert.equal(replay.applied, false);
      assert.equal((await f.session()).approval_epoch, promoted ? 8 : 7, 'Only promoted authored changes retire approvals');
      assert.equal((await f.session()).pr_summary_input_version, 1);
      assert.equal(Number((await f.pool.query(`SELECT COUNT(*) FROM execution_work_requests
        WHERE workflow = $1 AND input->'identity'->>'headSha' = $2`, [PREPARE_RUNTIME, NEXT])).rows[0].count), 1);
      assert.equal((await f.make().recover(1)).id, replay.workId);
    });
}

test('disabled enrolled sync persists an explicit obligation; recovery admits once after enabling',
  { skip: !postgresEnabled }, async t => {
    const f = await syncFixture(t);
    const session = await f.snapshot();
    const offConfig = { ...f.config, nativeCliPreviewHandoffEnabled: false };
    const off = createCliHandoffWork(f.pool, offConfig);
    const result = await f.reconcile(session, { config: offConfig }, { ...f.deps, work: off });
    assert.equal(result.ok, true);
    assert.equal(result.blocked, true);
    assert.equal(result.checksStarted, false);
    assert.equal(result.preparationQueued, false);
    assert.equal(result.reconciliation.owner, 'cli-preview-handoff');
    assert.equal((await f.session()).check_phase, 'reconciling');
    assert.equal((await f.session()).staging_url, session.staging_url);
    assert.equal((await off.recover(1)).status, 'blocked');
    assert.equal(Number((await f.pool.query('SELECT COUNT(*) FROM execution_work_requests')).rows[0].count), 1);
    await Promise.all([f.make().reconcileSyncs(), f.make().recover(1), f.reconcile(await f.snapshot())]);
    assert.equal(Number((await f.pool.query(`SELECT COUNT(*) FROM execution_work_requests
      WHERE workflow = $1 AND input->'identity'->>'headSha' = $2`, [PREPARE_RUNTIME, NEXT])).rows[0].count), 1);
    assert.equal((await f.pool.query('SELECT sync_reconciliation FROM cli_preview_handoffs')).rows[0].sync_reconciliation, null);
    assert.equal((await f.session()).check_phase, 'building');
    assert.equal((await off.recover(1)).status, 'queued', 'Previously admitted work recovers with admission disabled');
    const { replayDecision } = require('../src/services/cli-preview-handoff/reducer');
    for (const entry of await f.work.owner.trace(1)) assert.deepEqual(replayDecision(entry), entry.decision);
  });

test('enrolled sync rejects pending local upload and stale acceptance after a newer head',
  { skip: !postgresEnabled }, async t => {
    const f = await syncFixture(t);
    const old = await f.snapshot();
    await f.pool.query(`UPDATE chat_sessions SET handoff_uploaded_sha = $1,
      handoff_local_commit_sha = $1, handoff_upload_checked_sha = $2 WHERE id = 1`, [NEXT, HEAD]);
    const local = await f.reconcile(await f.snapshot(), {
      workerResult: { syncResult: 'already_synced', pushOk: false, sha: NEXT },
    });
    assert.equal(local.reason, 'local_upload_awaiting_submission');
    assert.equal((await f.session()).handoff_head_sha, HEAD);
    // A separate explicit local submission may accept a successor. An older
    // sync, even after a successful branch read, cannot regress it.
    const newer = 'd'.repeat(40);
    await f.pool.query('UPDATE chat_sessions SET handoff_uploaded_sha = $1 WHERE id = 1', [newer]);
    let branchRead;
    const readStarted = new Promise(resolve => { branchRead = resolve; });
    let finishRead;
    const delayedRead = new Promise(resolve => { finishRead = resolve; });
    const pendingSync = f.reconcile(old, {}, {
      ...f.deps,
      github: { async getBranchSha() { branchRead(); return delayedRead; } },
    });
    await readStarted;
    const successor = await f.work.admit({ session: await f.session(), headSha: newer });
    finishRead(NEXT);
    const stale = await pendingSync;
    assert.equal(stale.ok, false);
    assert.equal(stale.reason, 'session_state_changed');
    assert.equal((await f.session()).checks_commit_sha, newer);
    assert.equal((await f.make().recover(1)).id, successor.work.id);
    assert.equal(await require('../src/services/visuals').storeChecks(f.pool, 1, NEXT, { state: 'passing', results: [] }), false);
    assert.equal(Number((await f.pool.query(`SELECT COUNT(*) FROM execution_work_requests
      WHERE workflow = $1 AND input->'identity'->>'headSha' = $2`, [PREPARE_RUNTIME, NEXT])).rows[0].count), 0);
  });

test('enrolled sync preserves author summary for the exact new head and rejects missing worker provenance',
  { skip: !postgresEnabled }, async t => {
    const f = await syncFixture(t, { promoted: true, moveKind: 'resolved' });
    await f.pool.query(`UPDATE chat_sessions SET pr_summary_source = 'author',
      pr_summary_source_head_sha = $1, pr_summary_stale = FALSE WHERE id = 1`, [NEXT]);
    const session = await f.snapshot();
    const untrusted = await f.reconcile(session, { workerResult: undefined });
    assert.equal(untrusted.reason, 'sync_revision_unverified');
    assert.equal((await f.session()).handoff_head_sha, HEAD);
    const accepted = await f.reconcile(session);
    assert.equal(accepted.ok, true);
    assert.equal((await f.session()).approval_epoch, 7);
    assert.equal((await f.session()).pr_summary_stale, false);
    assert.equal((await f.session()).pr_summary_input_version, 0);
  });

test('supersession after synced candidate completion cannot activate or settle obsolete checks',
  { skip: !postgresEnabled }, async t => {
    const f = await syncFixture(t);
    const accepted = await f.reconcile(await f.snapshot());
    await f.pool.query("UPDATE execution_work_requests SET status = 'succeeded' WHERE id = $1", [f.original.work.id]);
    const preparation = await f.work.store.read(accepted.workId);
    await candidate(f, f.work, { work: preparation });
    const obsoleteContinuation = await f.make().recover(1);
    const successorHead = 'e'.repeat(40);
    await f.pool.query('UPDATE chat_sessions SET handoff_uploaded_sha = $1 WHERE id = 1', [successorHead]);
    const successor = await f.work.admit({ session: await f.session(), headSha: successorHead });
    await tick(f.make());
    assert.equal(f.creates(), 0);
    assert.equal((await f.session()).staging_runtime_name, 'serving');
    assert.equal((await f.work.store.read(obsoleteContinuation.id)).status, 'succeeded');
    assert.equal(await require('../src/services/visuals').storeChecks(f.pool, 1, NEXT, { state: 'passing', results: [] }), false);
    await candidate(f, f.work, successor);
    await tick(f.make());
    assert.equal((await f.session()).staging_commit_sha, successorHead);
    assert.equal((await f.session()).check_state, 'passing');
    assert.equal(f.creates(), 1);
  });

test('actual sync-main worker result reaches durable admission without the legacy staging tail',
  { skip: !postgresEnabled }, async t => {
    const f = await syncFixture(t);
    await f.pool.query(`ALTER TABLE chat_sessions ADD COLUMN behind_main INTEGER DEFAULT 0,
      ADD COLUMN merge_conflict_state TEXT, ADD COLUMN conflict_files JSONB,
      ADD COLUMN conflict_checked_at TIMESTAMPTZ`);
    const worker = require('../src/services/worker');
    for (const name of ['ensureWorkerImage', 'ensureWorker', 'clearPendingStop']) t.mock.method(worker, name, async () => {});
    t.mock.method(worker, 'execInWorker', async (_id, options) => {
      assert.equal(options.mode, 'sync');
      return { syncResult: 'clean', pushOk: true, sha: NEXT, exitCode: 0, behind: 0 };
    });
    const limits = require('../src/services/limits');
    t.mock.method(limits, 'checkSystemBudget', async () => ({}));
    t.mock.method(limits, 'recordSystemSpend', async () => {});
    t.mock.method(require('../src/services/github'), 'getBranchSha', f.deps.github.getBranchSha);
    t.mock.method(require('../src/services/cli-preview-handoff/work'), 'createCliHandoffWork', () => f.work);
    t.mock.method(require('../src/services/handoff-pipeline'), 'beginHandoffPipeline', () => {
      throw new Error('Detached tail forbidden for enrollment');
    });
    const result = await require('../src/services/sync-main').runSyncMain(f.config, f.pool, 1, {
      sessionRow: await f.snapshot(),
    });
    assert.equal(result.ok, true);
    assert.equal(result.managedRevision.durable, true);
    assert.equal(result.managedRevision.checksStarted, false);
    assert.equal((await f.make().recover(1)).id, result.managedRevision.workId);
    assert.equal((await f.session()).checks_commit_sha, NEXT);
    t.mock.method(worker, 'execInWorker', async () => ({ syncResult: 'already_synced', sha: null, pushOk: false }));
    const retry = await require('../src/services/sync-main').runSyncMain(f.config, f.pool, 1, {
      sessionRow: await f.snapshot(),
    });
    assert.equal(retry.managedRevision.workId, result.managedRevision.workId);
    assert.equal(retry.managedRevision.applied, false);
  });

test('sync reconciliation discovery rotates a locked aggregate and retries it after unrelated admission',
  { skip: !postgresEnabled }, async t => {
    const f = await syncFixture(t);
    const second = (await f.pool.query(`INSERT INTO chat_sessions (id, handoff_uploaded_sha, checks_commit_sha)
      VALUES (2,$1,$1) RETURNING *`, [HEAD])).rows[0];
    await f.work.admit({ session: second, headSha: HEAD });
    const offConfig = { ...f.config, nativeCliPreviewHandoffEnabled: false };
    const off = createCliHandoffWork(f.pool, offConfig);
    const secondSnapshot = { ...(await f.pool.query('SELECT * FROM chat_sessions WHERE id = 2')).rows[0],
      repo_url: 'https://github.com/example/demo' };
    await f.reconcile(await f.snapshot(), { config: offConfig }, { ...f.deps, work: off });
    await f.reconcile(secondSnapshot, { config: offConfig }, { ...f.deps, work: off });

    const discoveryPool = require('../src/services/execution/discovery-pool').createDiscoveryPool(f.url, {
      lockTimeoutMs: 20, statementTimeoutMs: 1000,
    });
    const discovery = createCliHandoffWork(discoveryPool, f.config);
    const blocker = await f.pool.connect();
    try {
      await blocker.query('BEGIN');
      await blocker.query('SELECT id FROM chat_sessions WHERE id = 1 FOR UPDATE');
      await discovery.reconcileSyncs(1);
      await discovery.reconcileSyncs(1);
      assert.ok((await f.pool.query('SELECT sync_reconciliation FROM cli_preview_handoffs WHERE session_id = 1')).rows[0].sync_reconciliation);
      assert.equal((await f.work.recover(2)).status, 'queued', 'Later obligation progresses before the first aggregate unlocks');
      assert.equal((await discoveryPool.query("SELECT count(*)::int AS count FROM pg_stat_activity WHERE application_name = 'bounded-work-discovery' AND state LIKE 'idle in transaction%'")).rows[0].count, 0);
      await blocker.query('ROLLBACK');
      await discovery.reconcileSyncs(1);
      assert.equal((await f.work.recover(1)).status, 'queued', 'Timed-out obligation remains retryable');
    } finally {
      await blocker.query('ROLLBACK');
      blocker.release();
      await discoveryPool.end();
    }
  });
