'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { randomUUID } = require('node:crypto');
const { createExecutionDatabase } = require('./lib/execution-database');
const { readPreviewPostgresFixture, enabled } = require('./lib/preview-postgres-fixture');
const { createPreviewFlow } = require('../src/services/preview-flow/store');
const checkRuns = require('../src/services/check-runs');
const { reduce } = require('../src/services/preview-flow/reducer');

const HEAD = 'a'.repeat(40);
const flowId = randomUUID();
const attemptId = randomUUID();
const cleanupAction = { type: 'RequestPreviewCleanup', sessionId: 1, flowId, actionId: randomUUID() };

function predecessor() {
  return {
    flow: { id: randomUUID(), state: 'ready' },
    resource: {
      flowId, sessionId: 1, published: true, preparationOwner: 'bounded',
      intent: { attemptId, runtimeOperation: { desired: {} } },
      receipt: { commitSha: HEAD, runtimeName: 'old' },
      consumerReleases: {},
    },
    retirementEvidence: {
      pendingRunIds: [],
      work: [
        { id: randomUUID(), workflow: 'native-preview-kubernetes-prepare', version: 1, status: 'succeeded',
          input: { identity: { flowId, headSha: HEAD }, intent: { attemptId } } },
        { id: randomUUID(), workflow: 'native-cli-preview-continuation', version: 1, status: 'succeeded', input: { flowId, headSha: HEAD } },
      ],
    },
  };
}

test('published retirement requires cohort, continuation, consumer and binding evidence independently', () => {
  assert.equal(reduce(predecessor(), cleanupAction, {}).accepted, true);
  const cases = [
    state => { state.resource.preparationOwner = null; },
    state => { state.retirementEvidence.pendingRunIds.push(randomUUID()); },
    state => { state.retirementEvidence.work[1].status = 'running'; },
    state => { state.retirementEvidence.work[0].input.intent.attemptId = randomUUID(); },
    state => { state.resource.consumerReleases.run = { retirement: null }; },
    state => { state.resource.consumerReleases.run = { retirement: { version: 1, jobs: [{ stage: 'deleting-input' }] } }; },
  ];
  for (const alter of cases) {
    const state = predecessor();
    alter(state);
    assert.equal(reduce(state, cleanupAction, {}).reason, 'consumer_retirement_required');
  }
  const bound = predecessor();
  bound.binding = { observed: { attemptId } };
  assert.equal(reduce(bound, cleanupAction, {}).reason, 'resource_bound');
  const serving = predecessor();
  serving.preview = { runtimeName: 'old', commitSha: HEAD };
  assert.equal(reduce(serving, cleanupAction, {}).reason, 'resource_published');
});

test('PostgreSQL consumer reservation and release survive manifest removal; unknown creation blocks release',
  { skip: !enabled }, async t => {
    const selected = await readPreviewPostgresFixture();
    const f = await createExecutionDatabase(selected.databaseUrl);
    t.after(() => f.close());
    await f.pool.query("INSERT INTO chat_sessions (id, checks_commit_sha) VALUES (1,$1)", [HEAD]);
    const state = predecessor();
    await f.pool.query(`INSERT INTO preview_flow_resources (flow_id,session_id,intent,receipt,preparation_owner,published_at)
      VALUES ($1,1,$2,$3,'bounded',NOW())`, [flowId, state.resource.intent, state.resource.receipt]);
    for (const work of state.retirementEvidence.work) {
      await f.pool.query(`INSERT INTO execution_work_requests (id,effect_key,session_id,workflow,contract_version,caused_by,input,input_hash,status)
        VALUES ($1,$2,1,$3,1,$4,$5,'fixture-hash','succeeded')`, [work.id, work.id, work.workflow, randomUUID(), work.input]);
    }
    const owner = createPreviewFlow(f.pool);
    assert.equal((await owner.apply({ ...cleanupAction, actionId: randomUUID() })).decision.accepted, true);
    const runId = randomUUID();
    const manifest = { durableCli: true, cliFlowId: flowId, launched: false };
    assert.equal(await checkRuns.record(f.pool, { runId, sessionId: 1, commitSha: HEAD, manifest }), true);
    assert.equal((await owner.apply({ ...cleanupAction, actionId: randomUUID() })).decision.reason, 'consumer_retirement_required');
    // Absence alone cannot erase the separately reserved consumer obligation.
    await checkRuns.finish(f.pool, runId);
    assert.equal((await owner.apply({ ...cleanupAction, actionId: randomUUID() })).decision.reason, 'consumer_retirement_required');
    await checkRuns.record(f.pool, { runId, sessionId: 1, commitSha: HEAD, manifest });
    const retirement = { version: 1, namespace: 'fixture', jobs: [{ kind: 'capture', stage: 'released', job: { name: 'capture', uid: 'uid' } }] };
    await checkRuns.recordRetirement(f.pool, runId, 1, null, retirement);
    const row = await checkRuns.read(f.pool, runId, 1);
    const requirements = { captureRequired: true, unitRequired: false };
    // Ownership loss cannot manufacture a release receipt.
    const wrongOwner = { query: (sql, args) => f.pool.query(sql, args.map((value, index) => index === 5 ? 'other-owner' : value)) };
    await assert.rejects(checkRuns.recordPreviewRelease(wrongOwner, row, retirement, requirements), /retirement owner/);
    const loseReply = { async query(sql, args) {
      await f.pool.query(sql, args);
      throw new Error('Injected lost release acknowledgment');
    } };
    await assert.rejects(checkRuns.recordPreviewRelease(loseReply, row, retirement, requirements), /lost release/);
    await checkRuns.recordPreviewRelease(f.pool, row, retirement, requirements);
    await checkRuns.finish(f.pool, runId);
    assert.equal((await owner.apply({ ...cleanupAction, actionId: randomUUID() })).decision.accepted, true);
    assert.equal((await owner.apply({ type: 'PreviewDependenciesReleased', actionId: randomUUID(), sessionId: 1, flowId })).decision.accepted, true);
    assert.ok((await f.pool.query('SELECT dependencies_released_at FROM preview_flow_resources')).rows[0].dependencies_released_at);
    assert.equal((await owner.read(1)).retainedPublishedAttempts, 0);
    // A lost dependency-release reply is recovered with the same action receipt.
    const trace = await owner.trace(1);
    assert.ok(trace.some(entry => entry.action.type === 'PreviewDependenciesReleased'));
    for (const entry of trace) assert.deepEqual(require('../src/services/preview-flow/reducer').replayDecision(entry), entry.decision);
    // Discoverable tombstone is preserved; a fresh consumer cannot reacquire it.
    assert.equal(await checkRuns.record(f.pool, { runId: randomUUID(), sessionId: 1, commitSha: HEAD, manifest }), false);
    assert.equal((await f.pool.query('SELECT count(*)::int AS n FROM preview_flow_resources')).rows[0].n, 1);
  });


test('PostgreSQL consumer reservation rolls back manifest insertion when resource persistence fails',
  { skip: !enabled }, async t => {
    const selected = await readPreviewPostgresFixture();
    const f = await createExecutionDatabase(selected.databaseUrl);
    t.after(() => f.close());
    await f.pool.query(`INSERT INTO preview_flow_resources (flow_id,session_id,intent,receipt,preparation_owner)
      VALUES ($1,1,$2,$3,'bounded')`, [flowId, predecessor().resource.intent, predecessor().resource.receipt]);
    await f.pool.query(`CREATE FUNCTION reject_consumer() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN RAISE EXCEPTION 'Injected consumer receipt failure'; END $$;
      CREATE TRIGGER reject_consumer BEFORE UPDATE ON preview_flow_resources
        FOR EACH ROW EXECUTE FUNCTION reject_consumer()`);
    const runId = randomUUID();
    assert.equal(await checkRuns.record(f.pool, { runId, sessionId: 1, commitSha: HEAD,
      manifest: { durableCli: true, cliFlowId: flowId, launched: false } }), false);
    assert.equal((await f.pool.query('SELECT count(*)::int AS n FROM check_runs')).rows[0].n, 0);
    assert.deepEqual((await f.pool.query('SELECT consumer_releases FROM preview_flow_resources')).rows[0].consumer_releases, {});
  });
