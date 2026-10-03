'use strict';

// Actual ownership-verified disposable PostgreSQL and HTTP routes. GitHub,
// Kubernetes preparation/activation and capture are injected service facts.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { randomUUID } = require('node:crypto');
const { enabled } = require('./lib/preview-postgres-fixture');
const { fixture, candidate, tick, manualServer } = require('./lib/manual-preview-fixture');
const { createCliHandoffWork, CONTINUE } = require('../src/services/cli-preview-handoff/work');
const { PREPARE_RUNTIME } = require('../src/services/preview-flow/work');
const { reduce } = require('../src/services/cli-preview-handoff/reducer');
const HEAD = 'a'.repeat(40);
const NEXT = 'b'.repeat(40);
const headers = id => ({ 'Idempotency-Key': id });

async function admit(f, work, extra = {}) {
  return work.admitManual({ session: await f.session(), headSha: HEAD, kind: 'deploy',
    requestId: randomUUID(), userId: 1, ...extra });
}

for (const kind of ['deploy-staging', 'ensure-staging', 'recheck']) {
  test(`native ${kind}: concurrent HTTP admission, restart, lost reply after completion`, { skip: !enabled }, async t => {
    const f = await fixture(t, { native: true });
    let branch = HEAD;
    const work = f.make();
    const request = await manualServer(t, f, work, { branchHead: () => branch });
    const id = randomUUID();
    const responses = await Promise.all(Array.from({ length: 6 }, () => request(kind, headers(id))));
    assert.ok(responses.every(response => response.status === 200), JSON.stringify(responses));
    const workId = responses[0].body.workId;
    assert.equal(new Set(responses.map(response => response.body.workId)).size, 1);
    assert.equal((await f.session()).source, 'native');
    assert.equal((await f.session()).handoff_head_sha, null);
    assert.equal((await f.session()).handoff_uploaded_sha, null);
    assert.equal((await f.session()).staging_runtime_name, 'serving');
    assert.equal(Number((await f.pool.query('SELECT COUNT(*) FROM execution_work_requests WHERE workflow = $1', [PREPARE_RUNTIME])).rows[0].count), 1);
    assert.equal(Number((await f.pool.query('SELECT COUNT(*) FROM native_preview_manual_requests')).rows[0].count), 1);
    const restarted = f.make();
    const prepared = { work: await restarted.store.read(workId) };
    await candidate(f, restarted, prepared);
    const continuation = await restarted.recover(1);
    assert.equal(continuation.workflow, CONTINUE);
    await tick(restarted);
    assert.equal((await f.session()).check_state, 'passing');
    branch = NEXT;
    const retry = await request(kind, headers(id));
    assert.equal(retry.status, 200);
    assert.equal(retry.body.workId, workId, 'Completed retry must retain its original preparation identity');
    assert.equal((await f.session()).checks_commit_sha, HEAD);
    assert.equal(Number((await f.pool.query('SELECT COUNT(*) FROM execution_work_requests WHERE workflow = $1', [PREPARE_RUNTIME])).rows[0].count), 1);
    for (const record of await restarted.owner.trace(1)) {
      assert.deepEqual(reduce(record.pre_state, record.action), record.decision);
    }
  });
}

test('native admission rolls back partial head/preparation and request receipts; lost commit reply returns persisted work', { skip: !enabled }, async t => {
  const f = await fixture(t, { native: true });
  const work = f.make();
  const original = work.store.enqueue;
  work.store.enqueue = async (...args) => {
    await original(...args);
    throw new Error('Injected failure after work persistence');
  };
  const id = randomUUID();
  await assert.rejects(admit(f, work, { requestId: id, headSha: NEXT }), /Injected/);
  assert.equal((await f.session()).checks_commit_sha, HEAD);
  assert.equal((await f.session()).check_state, null);
  for (const table of ['native_preview_manual_requests', 'cli_preview_handoffs', 'cli_preview_receipts', 'cli_preview_decisions', 'preview_flows', 'execution_work_requests']) {
    assert.equal(Number((await f.pool.query(`SELECT COUNT(*) FROM ${table}`)).rows[0].count), 0);
  }
  work.store.enqueue = original;
  const result = await admit(f, work, { requestId: id, headSha: NEXT });
  const restarted = f.make();
  const replay = await restarted.manualReceipt({ sessionId: 1, requestId: id, userId: 1, kind: 'deploy' });
  assert.equal(replay.work.id, result.work.id);
  assert.equal(replay.headSha, NEXT);
  assert.equal((await restarted.manualReceipt({ sessionId: 1, requestId: id, userId: 2, kind: 'deploy' })).reason, 'manual_request_identity_conflict');
  assert.equal((await restarted.manualReceipt({ sessionId: 1, requestId: id, userId: 1, kind: 'recheck' })).reason, 'manual_request_identity_conflict');
});

test('native recheck uses durable continuation, joins concurrent intents and does not repeat completed request', { skip: !enabled }, async t => {
  const f = await fixture(t, { native: true });
  const work = f.make();
  const first = await admit(f, work);
  await candidate(f, work, first);
  await tick(work);
  const request = await manualServer(t, f, work);
  const ids = Array.from({ length: 7 }, () => randomUUID());
  const responses = await Promise.all(ids.map(id => request('recheck', headers(id))));
  assert.ok(responses.every(response => response.status === 200));
  assert.equal(new Set(responses.map(response => response.body.workId)).size, 1);
  const workId = responses[0].body.workId;
  assert.equal((await f.session()).check_state, 'pending');
  await tick(f.make());
  assert.equal((await f.session()).check_state, 'passing');
  assert.equal((await request('recheck', headers(ids[0]))).body.workId, workId);
  assert.equal((await f.session()).check_state, 'passing');
  assert.notEqual((await request('recheck', headers(randomUUID()))).body.workId, workId);
});

test('native supersession rejects stale request snapshot and candidate; retired request identity survives', { skip: !enabled }, async t => {
  const f = await fixture(t, { native: true });
  const work = f.make();
  const snapshot = await f.session();
  const id = randomUUID();
  const first = await admit(f, work, { requestId: id });
  const next = await admit(f, work, { headSha: NEXT });
  assert.notEqual(next.work.id, first.work.id);
  assert.equal((await f.session()).staging_runtime_name, 'serving');
  const rejected = await work.admitManual({ session: snapshot, headSha: HEAD,
    kind: 'deploy', requestId: randomUUID(), userId: 1 });
  assert.equal(rejected.reason, 'session_state_changed');
  await candidate(f, work, first, null, false);
  assert.equal((await work.store.read(first.work.id)).result.accepted, false);
  assert.equal((await f.session()).checks_commit_sha, NEXT);
  assert.equal((await f.session()).staging_runtime_name, 'serving');
  assert.equal((await work.manualReceipt({ sessionId: 1, requestId: id, userId: 1, kind: 'deploy' })).work.id, first.work.id);
});

test('native ordinary authorization is rechecked under aggregate lock and preserves reviewed policy', { skip: !enabled }, async t => {
  const f = await fixture(t, { native: true });
  const work = f.make();
  assert.equal((await admit(f, work, { userId: 2 })).reason, 'manual_request_forbidden');
  assert.equal((await admit(f, work, { userId: 2, kind: 'recheck', canAdminWrite: false })).reason, 'manual_request_forbidden');
  assert.equal((await admit(f, work, { userId: 2, kind: 'ensure' })).reason, 'manual_request_forbidden');
  await f.pool.query("UPDATE chat_sessions SET status = 'promoted', reviewed_head_sha = $1, approval_epoch = 7 WHERE id = 1", [HEAD]);
  assert.equal((await admit(f, work, { headSha: NEXT })).reason, 'reviewed_head_changed');
  const accepted = await admit(f, work, { userId: 2, kind: 'ensure' });
  assert.equal(accepted.accepted, true);
  assert.equal((await f.session()).approval_epoch, 7);
  assert.equal((await f.session()).reviewed_head_sha, HEAD);
  await candidate(f, work, accepted);
  await tick(work);
  assert.equal((await work.owner.read(1)).handoff.phase, 'complete');
});

test('native admitted work recovers with admission off; fresh head has explicit disabled result and no builder', { skip: !enabled }, async t => {
  const f = await fixture(t, { native: true });
  const work = f.make();
  const first = await admit(f, work);
  f.config.nativeManualPreviewEnabled = false;
  const off = f.make();
  assert.equal((await off.recover(1)).id, first.work.id);
  assert.equal((await admit(f, off)).work.id, first.work.id);
  const rejected = await admit(f, off, { headSha: NEXT });
  assert.equal(rejected.reason, 'native_admission_disabled');
  assert.equal((await f.session()).checks_commit_sha, HEAD);
  await candidate(f, off, first);
  await tick(off);
  assert.equal((await f.session()).check_state, 'passing');
  const request = await manualServer(t, f, off, { branchHead: NEXT });
  assert.equal((await request('deploy-staging', headers(randomUUID()))).body.error, 'native_admission_disabled');
});

test('native HTTP requires a request identity, refuses unavailable source, and keeps ordinary sessions outside CLI uploads', { skip: !enabled }, async t => {
  const f = await fixture(t, { native: true });
  const work = f.make();
  const request = await manualServer(t, f, work, { branchHead: HEAD });
  assert.equal((await request('deploy-staging')).body.error, 'manual_request_id_required');
  assert.equal((await request('recheck', { ...headers(randomUUID()), 'x-test-user': '2' })).status, 403);
  assert.equal((await request('recheck', { ...headers(randomUUID()), 'x-test-user': '2', 'x-test-admin': 'true' })).status, 200);
  f.config.nativeCliPreviewHandoffEnabled = true;
  const cli = await work.admit({ session: await f.session(), headSha: HEAD });
  // A same-head join is a lookup, not CLI upload acceptance. A different head
  // must never grant ordinary native callers the upload action's authority.
  assert.equal((await work.admit({ session: await f.session(), headSha: NEXT })).reason, 'native_cli_required');
  assert.ok(cli.accepted);
});

test('native loss after candidate, activation and checks commits resumes durable continuation without repeating them', { skip: !enabled }, async t => {
  const f = await fixture(t, { native: true });
  const work = f.make({
    async capture(_config, session, _app, head, _runtime, options) {
      assert.equal(options.previewFlowId, (await work.owner.read(1)).handoff.flow_id);
      assert.equal(options.cliFlowId, undefined);
      await require('../src/services/visuals').storeChecks(f.pool, session.id, head, { state: 'passing', results: [] });
      throw new Error('Lost verdict reply');
    },
  });
  const admitted = await admit(f, work);
  const settle = work.store.settle;
  let loseCandidate = true;
  work.store.settle = async (...args) => {
    const result = await settle(...args);
    if (args[0].workflow === PREPARE_RUNTIME && loseCandidate) {
      loseCandidate = false;
      throw new Error('Lost candidate commit reply');
    }
    return result;
  };
  await assert.rejects(candidate(f, work, admitted), /Lost candidate/);
  assert.equal((await f.make().recover(1)).workflow, CONTINUE);
  const apply = f.owner.apply;
  let loseActivation = true;
  f.owner.apply = async action => {
    const result = await apply(action);
    if (action.type === 'PreviewActivationObserved' && loseActivation) {
      loseActivation = false;
      throw new Error('Lost activation reply');
    }
    return result;
  };
  await tick(work);
  assert.equal((await f.owner.read(1)).flow.state, 'ready');
  const runtimeName = (await f.session()).staging_runtime_name;
  await f.pool.query('UPDATE execution_work_requests SET due_at = NOW()');
  await tick(work);
  assert.equal((await f.session()).check_state, 'passing');
  await f.pool.query('UPDATE execution_work_requests SET due_at = NOW()');
  await tick(f.make({ capture: async () => assert.fail('Recovery must adopt the committed verdict') }));
  assert.equal((await work.owner.read(1)).handoff.phase, 'complete');
  assert.equal((await f.session()).staging_runtime_name, runtimeName);
  assert.equal(f.creates(), 1, 'Recovery adopts activation instead of publishing again');
});

test('native enrollment fences alternate web builders and capture; recovery entry points join with admission off', { skip: !enabled }, async t => {
  const f = await fixture(t, { native: true });
  const work = f.make();
  const admitted = await admit(f, work);
  f.config.nativeManualPreviewEnabled = false;
  t.mock.method(require('../src/db/pool'), 'getPool', () => f.pool);
  t.mock.method(require('../src/services/cli-preview-handoff/work'), 'createCliHandoffWork', () => f.make());
  const session = await f.session();
  const app = (await f.pool.query('SELECT * FROM apps WHERE id = 1')).rows[0];
  await assert.rejects(require('../src/services/staging').buildAndDeployStaging(f.config, session, app, HEAD),
    { code: 'NATIVE_PREVIEW_DURABLE_OWNER' });
  await assert.rejects(require('../src/services/visuals').captureForSession(f.config, session, app, HEAD, null),
    { code: 'NATIVE_PREVIEW_DURABLE_OWNER' });
  const recovery = require('../src/services/staging-recovery');
  assert.equal(await recovery.rebuildSessionStaging({ config: f.config, pool: f.pool, session, reason: 'preview-click' }), 'durable');
  assert.equal((await recovery.recheckSessionChecks({ config: f.config, pool: f.pool, session, reason: 'manual-recheck', requestId: randomUUID() })).status, 'waiting');
  assert.equal((await require('../src/services/handoff-pipeline').runStaging(f.config, f.pool, session, app, HEAD)).workId, admitted.work.id);
  assert.equal(Number((await f.pool.query('SELECT COUNT(*) FROM execution_work_requests WHERE workflow = $1', [PREPARE_RUNTIME])).rows[0].count), 1);
});

test('native manifests reserve and release the same preview consumer through existing retirement', { skip: !enabled }, async t => {
  const f = await fixture(t, { native: true });
  const work = f.make();
  const admitted = await admit(f, work);
  await candidate(f, work, admitted);
  await tick(work);
  const flowId = (await work.owner.read(1)).handoff.flow_id;
  const runId = randomUUID();
  const runs = require('../src/services/check-runs');
  assert.equal(await runs.record(f.pool, { runId, sessionId: 1, commitSha: HEAD, manifest: {
    durableNative: true, previewFlowId: flowId, launched: true,
    unitSuite: { version: 1, state: 'not-required' },
  } }), true);
  const resource = async () => (await f.pool.query('SELECT consumer_releases FROM preview_flow_resources WHERE flow_id = $1', [flowId])).rows[0];
  assert.equal((await resource()).consumer_releases[runId].retirement, null);
  const original = (await runs.read(f.pool, runId, 1)).manifest;
  await f.pool.query('UPDATE check_runs SET manifest = $2 WHERE run_id = $1',
    [runId, JSON.stringify({ ...original, cliFlowId: randomUUID() })]);
  t.mock.method(require('../src/services/kubernetes'), 'retireCheckResources', async () => assert.fail('Conflicting identity cannot authorize deletion'));
  await assert.rejects(require('../src/services/check-retirement').retire(f.config, f.pool, 1, runId), /Conflicting preview flow/);
  assert.equal((await resource()).consumer_releases[runId].retirement, null);
  await f.pool.query('UPDATE check_runs SET manifest = $2 WHERE run_id = $1', [runId, JSON.stringify(original)]);
  // External deletion is injected. The manifest/progress and dependency-release
  // writes, same-owner comparisons and preview consumer receipt are actual SQL.
  t.mock.method(require('../src/services/kubernetes'), 'retireCheckResources', async (_config, id, run, options) => {
    assert.equal(id, 1);
    assert.equal(run, runId);
    const result = { version: 1, jobs: [{ kind: 'capture', stage: 'released',
      job: { name: 'original', uid: 'original-job' }, input: { name: 'original-input', uid: 'original-input' } }] };
    await options.persist(result);
    return result;
  });
  assert.deepEqual(await require('../src/services/check-retirement').retire(f.config, f.pool, 1, runId), { complete: true, why: null });
  assert.equal((await resource()).consumer_releases[runId].retirement.jobs[0].job.uid, 'original-job');
  assert.equal(await runs.finish(f.pool, runId), true);
  assert.equal((await f.session()).staging_commit_sha, HEAD, 'Checks retirement preserves serving publication');
});

test('implicit native source is supported; inaccessible source admits nothing; unmigrated head writers expose reconciliation', { skip: !enabled }, async t => {
  const f = await fixture(t, { native: true });
  await f.pool.query('UPDATE chat_sessions SET source = NULL WHERE id = 1');
  const work = f.make();
  const request = await manualServer(t, f, work, { branchHead: HEAD });
  t.mock.method(require('../src/services/github'), 'getInstallationOctokit', async () => ({
    request: async () => { throw Object.assign(new Error('Inaccessible source'), { status: 404 }); },
  }));
  assert.equal((await request('deploy-staging', headers(randomUUID()))).status, 503);
  assert.equal(Number((await f.pool.query('SELECT COUNT(*) FROM execution_work_requests')).rows[0].count), 0);
  const admitted = await admit(f, work);
  await f.pool.query('UPDATE chat_sessions SET checks_commit_sha = $1 WHERE id = 1', [NEXT]);
  assert.equal((await work.recover(1)).code, 'native_head_admission_required', 'Outstanding old work cannot represent a new pin');
  await f.pool.query('UPDATE chat_sessions SET checks_commit_sha = $1 WHERE id = 1', [HEAD]);
  await candidate(f, work, admitted);
  await tick(work);
  // Remaining hosted/promotion head writers are a separate migration row. Their
  // persisted mismatch cannot grant an alternate recovery tail a new builder.
  await f.pool.query('UPDATE chat_sessions SET checks_commit_sha = $1 WHERE id = 1', [NEXT]);
  const blocked = await work.recover(1);
  assert.equal(blocked.code, 'native_head_admission_required');
  assert.equal(blocked.reconciliation.owner, 'native-preview-requests');
  assert.equal(blocked.reconciliation.headSha, NEXT);
  const serving = (await f.session()).staging_runtime_name;
  const next = await admit(f, work, { headSha: NEXT });
  assert.equal(next.accepted, true);
  assert.equal((await f.session()).staging_runtime_name, serving);
  assert.notEqual(next.work.id, admitted.work.id);
});

test('native ensure supports the exact merging review pin and rejects closed missing previews cleanly', { skip: !enabled }, async t => {
  const f = await fixture(t, { native: true });
  const work = f.make();
  await f.pool.query("UPDATE chat_sessions SET status = 'merging', reviewed_head_sha = $1 WHERE id = 1", [HEAD]);
  const accepted = await admit(f, work, { kind: 'ensure', userId: 2 });
  assert.equal(accepted.accepted, true);
  await candidate(f, work, accepted);
  await tick(work);
  assert.equal((await work.owner.read(1)).handoff.phase, 'complete');
  await f.pool.query("UPDATE chat_sessions SET status = 'archived' WHERE id = 1");
  const rejected = await admit(f, work, { kind: 'ensure' });
  assert.equal(rejected.reason, 'session_closed');
});

test('native unresolved activation returns waiting and rolls back new head/work instead of logging build failure', { skip: !enabled }, async t => {
  const f = await fixture(t, { native: true });
  const work = f.make();
  const admitted = await admit(f, work);
  await candidate(f, work, admitted);
  const state = await f.owner.read(1);
  const desired = await f.owner.apply({ type: 'RequestPreviewActivation', actionId: randomUUID(), sessionId: 1,
    flowId: state.flow.id, generation: state.flow.generation, headSha: HEAD,
    expected: { target: null, uid: null, token: null }, stagingUrl: 'https://preview.fixture.invalid' });
  assert.equal(desired.decision.accepted, true);
  const before = await work.owner.trace(1);
  const request = await manualServer(t, f, work, { branchHead: NEXT });
  const errors = [];
  t.mock.method(require('../src/services/logger'), 'error', (...args) => { errors.push(args); });
  const result = await request('deploy-staging', headers(randomUUID()));
  assert.equal(result.status, 409);
  assert.equal(result.body.error, 'native_preparation_waiting');
  assert.equal((await f.session()).checks_commit_sha, HEAD);
  assert.equal((await f.session()).staging_runtime_name, 'serving');
  assert.deepEqual(await work.owner.trace(1), before, 'Rejected composition leaves no partial accepted head');
  assert.equal(Number((await f.pool.query('SELECT COUNT(*) FROM execution_work_requests WHERE workflow = $1', [PREPARE_RUNTIME])).rows[0].count), 1);
  assert.equal(Number((await f.pool.query('SELECT COUNT(*) FROM native_preview_manual_requests')).rows[0].count), 1);
  assert.equal(errors.length, 0);
});

test('native same-head manual recheck waits with admission off and retries the same intent after enabling', { skip: !enabled }, async t => {
  const f = await fixture(t, { native: true });
  const work = f.make();
  const first = await admit(f, work);
  await candidate(f, work, first);
  await tick(work);
  const request = await manualServer(t, f, work);
  const id = randomUUID();
  const traces = (await work.owner.trace(1)).length;
  f.config.nativeManualPreviewEnabled = false;
  const waiting = await request('recheck', headers(id));
  assert.equal(waiting.status, 409);
  assert.equal(waiting.body.error, 'native_admission_disabled');
  assert.equal((await f.session()).check_state, 'passing');
  assert.equal((await work.owner.trace(1)).length, traces, 'Waiting admission must not consume its stable action ID');
  f.config.nativeManualPreviewEnabled = true;
  const accepted = await request('recheck', headers(id));
  assert.equal(accepted.status, 200);
  assert.equal((await f.session()).check_state, 'pending');
  await tick(f.make());
  assert.equal((await request('recheck', headers(id))).body.workId, accepted.body.workId);
  assert.equal((await f.session()).check_state, 'passing');
});
