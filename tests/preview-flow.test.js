'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { randomUUID } = require('node:crypto');
const fs = require('node:fs');
const { Pool } = require('pg');
const { parseAction } = require('../src/services/preview-flow/actions');
const { reduce, replayDecision, REDUCER_VERSION } = require('../src/services/preview-flow/reducer');
const { createPreviewFlow } = require('../src/services/preview-flow/store');
const { prepareNativePreview } = require('../src/services/preview-flow/native');

const HEAD = 'a'.repeat(40);
const NEXT = 'b'.repeat(40);

function action(type, fields = {}) {
  return { type, actionId: randomUUID(), sessionId: 1, ...fields };
}

function request(type) {
  return action(type, { headSha: HEAD, startedStatus: 'active' });
}

function runtimeReceipt(head = HEAD, runtimeKind = 'docker') {
  return {
    commitSha: head,
    stagingUrl: 'https://preview.example.test',
    runtimeKind,
    runtimeName: 'runtime-1',
    containerId: runtimeKind === 'docker' ? 'runtime-1' : null,
    imageRef: 'image:exact',
    buildRef: null,
  };
}

function initialState() {
  return {
    session: {
      id: 1,
      status: 'active',
      source: 'cli_handoff',
      checksCommitSha: HEAD,
      reviewedHeadSha: null,
    },
    flow: null,
    preview: null,
  };
}

function flowIdentity(flow) {
  return { flowId: flow.id, generation: flow.generation, headSha: flow.headSha };
}

test('preview actions validate exact SHA, identity, runtime tuple and reject raw patches', () => {
  assert.throws(() => parseAction({ ...request('RequestPreview'), headSha: 'latest' }));
  assert.throws(() => parseAction({ ...request('RequestPreview'), capability: 'admin' }));
  assert.throws(() => parseAction({ ...request('RequestPreview'), patch: { staging_url: 'x' } }));
  const ready = action('PreviewReady', {
    flowId: randomUUID(),
    generation: 1,
    headSha: HEAD,
    receipt: runtimeReceipt(),
  });
  assert.equal(parseAction(ready).receipt.commitSha, HEAD);
  assert.throws(() => parseAction({ ...ready, generation: 0 }));
  assert.throws(() => parseAction({ ...ready, receipt: { ...runtimeReceipt(), containerId: null } }));
  assert.throws(() => parseAction({ ...ready, receipt: { ...runtimeReceipt(), env: { SECRET: 'no' } } }));
  assert.equal(parseAction({ ...ready, receipt: runtimeReceipt(HEAD, 'kubernetes') }).receipt.containerId, null);
  const cleanup = action('RequestPreviewCleanup', { flowId: randomUUID() });
  assert.equal(parseAction(cleanup).type, 'RequestPreviewCleanup');
  assert.throws(() => parseAction({ ...cleanup, intent: { runtimeName: 'another-owner' } }));
  assert.throws(() => parseAction({ ...cleanup, type: 'PreviewCleanupCompleted', disposition: 'unknown' }));
});

test('pure reducer joins eligible requests; explicit same-SHA retry advances identity', () => {
  const state = initialState();
  const before = structuredClone(state);
  const requestAction = parseAction(request('RequestPreview'));
  const requested = reduce(state, requestAction, { newFlowId: randomUUID() });
  assert.deepEqual(state, before, 'input state is immutable');
  assert.equal(requested.flow.generation, 1);
  assert.deepEqual(requested.effects, [{
    type: 'BuildPreview',
    effectKey: `${requested.flow.id}:build`,
    causedBy: requestAction.actionId,
    sessionId: 1,
    ...flowIdentity(requested.flow),
  }]);

  const joined = reduce({ ...state, flow: requested.flow }, parseAction(request('RequestPreview')), { newFlowId: randomUUID() });
  assert.equal(joined.reason, 'joined_existing_flow');
  assert.deepEqual(joined.effects, []);

  const afterCleanup = reduce({ ...state, flow: requested.flow, resource: { cleanupStarted: true } },
    parseAction(request('RequestPreview')), { newFlowId: randomUUID() });
  assert.equal(afterCleanup.flow.generation, 2, 'a cleanup-claimed flow cannot be joined as reusable work');
  assert.equal(afterCleanup.effects.length, 1);

  const retried = reduce({ ...state, flow: requested.flow }, parseAction(request('RetryPreview')), { newFlowId: randomUUID() });
  assert.equal(retried.flow.generation, 2);
  assert.notEqual(retried.flow.id, requested.flow.id);
  assert.deepEqual(retried.supersededFlow, { ...requested.flow, state: 'superseded' },
    'supersession is part of the captured decision, not an invented persistence side effect');

  const stale = reduce({ ...state, flow: retried.flow }, parseAction(action('PreviewReady', {
    ...flowIdentity(requested.flow),
    receipt: runtimeReceipt(),
  })), {});
  assert.equal(stale.reason, 'superseded_flow');
  assert.equal(stale.projection, 'unchanged');
});

test('checkpoint version-one traces retain their original policy and decision shape', () => {
  const flowId = '00000000-0000-4000-8000-000000000001';
  const nextId = '00000000-0000-4000-8000-000000000002';
  const actionInput = {
    type: 'RetryPreview',
    actionId: '00000000-0000-4000-8000-000000000003',
    sessionId: 1,
    headSha: HEAD,
    startedStatus: 'active',
  };
  const preState = {
    ...initialState(),
    resource: { cleanupStarted: false },
    flow: {
      id: flowId,
      generation: 1,
      headSha: HEAD,
      startedStatus: 'active',
      state: 'preparing',
    },
  };
  const facts = { newFlowId: nextId };
  const expected = {
    accepted: true,
    reason: 'preparation_requested',
    flow: { ...preState.flow, id: nextId, generation: 2 },
    projection: 'unchanged',
    effects: [{
      type: 'BuildPreview',
      effectKey: `${nextId}:build`,
      causedBy: actionInput.actionId,
      sessionId: 1,
      flowId: nextId,
      generation: 2,
      headSha: HEAD,
    }],
  };
  assert.deepEqual(replayDecision({ reducer_version: 1, pre_state: preState, action: actionInput, facts }), expected);
  assert.deepEqual(reduce(preState, actionInput, facts), { ...expected, supersededFlow: { ...preState.flow, state: 'superseded' } });

  const ready = { ...actionInput, type: 'PreviewReady', ...flowIdentity(preState.flow), receipt: runtimeReceipt() };
  delete ready.startedStatus;
  assert.deepEqual(replayDecision({ reducer_version: 1, pre_state: preState, action: ready, facts: {} }),
    {
      accepted: true,
      reason: 'runtime_published',
      flow: { ...preState.flow, state: 'ready' },
      projection: 'publish',
      receipt: runtimeReceipt(),
      effects: [],
    });

  const retiring = { ...preState, resource: { cleanupStarted: true } };
  assert.deepEqual(replayDecision({ reducer_version: 1, pre_state: retiring, action: ready, facts: {} }),
    {
      accepted: false,
      reason: 'resource_retiring',
      flow: preState.flow,
      projection: 'unchanged',
      effects: [],
    });
});

test('native policy preserves paused submission and promotion only on the reviewed commit', () => {
  for (const [status, reviewedHeadSha, startedStatus, accepted] of [
    ['active', null, 'active', true], ['paused', null, 'paused', true],
    ['paused', null, 'active', false], ['active', null, 'paused', false],
    ['promoted', HEAD, 'active', true], ['promoted', NEXT, 'active', false],
    ['promoted', null, 'active', false], ['merging', HEAD, 'active', false],
    ['archived', HEAD, 'active', false], ['merged', HEAD, 'active', false],
  ]) {
    const state = initialState();
    Object.assign(state.session, { status, reviewedHeadSha });
    assert.equal(reduce(state, parseAction(action('RetryPreview', { headSha: HEAD, startedStatus })),
      { newFlowId: randomUUID() }).accepted, accepted, `${status}/${startedStatus}/${reviewedHeadSha}`);
  }
  const imported = initialState();
  imported.session.source = 'imported';
  assert.equal(reduce(imported, parseAction(request('RequestPreview')), {}).reason, 'imported_session');
});

const databaseUrl = process.env.PREVIEW_FLOW_TEST_DATABASE_URL || process.env.SQL_CHECK_CONNECTION_URL;

test('preview flow transactions across independent PostgreSQL connections', { skip: !databaseUrl }, async t => {
  // Isolated schema on an explicitly supplied disposable DB, never DATABASE_URL.
  const root = new Pool({ connectionString: databaseUrl });
  const schema = `preview_flow_test_${process.pid}`;
  await root.query(`CREATE SCHEMA ${schema}`);
  const scoped = new URL(databaseUrl);
  scoped.searchParams.set('options', `-c search_path=${schema}`);
  const db = new Pool({ connectionString: scoped.toString(), max: 8 });
  try {
    await db.query(`CREATE TABLE chat_sessions (id INTEGER PRIMARY KEY, status TEXT,
      source TEXT, checks_commit_sha TEXT, reviewed_head_sha TEXT, staging_url TEXT,
      staging_container_id TEXT, staging_runtime_kind TEXT, staging_runtime_name TEXT,
      staging_image_ref TEXT, staging_build_ref TEXT, staging_commit_sha TEXT,
      last_activity_at TIMESTAMPTZ, check_state TEXT, failure_count INTEGER DEFAULT 0,
      checks_progress JSONB, test_results JSONB, checks_checked_at TIMESTAMPTZ,
      check_phase TEXT, check_error_detail TEXT, consecutive_check_failures INTEGER DEFAULT 0,
      first_check_failure_at TIMESTAMPTZ, last_check_failure_at TIMESTAMPTZ,
      check_next_retry_at TIMESTAMPTZ, check_error_notified_at TIMESTAMPTZ);`);
    const source = fs.readFileSync(require.resolve('../src/db/schema.sql'), 'utf8');
    for (const table of ['preview_flows', 'preview_flow_heads', 'preview_flow_resources',
      'preview_action_receipts', 'preview_flow_decisions']) {
      const sql = source.match(new RegExp(`CREATE TABLE IF NOT EXISTS ${table} \\([\\s\\S]*?\\n\\);`));
      assert.ok(sql, table);
      await db.query(sql[0]);
    }
    async function persistFailure(client, actionInput) {
      await client.query(`UPDATE chat_sessions SET check_state = 'error', failure_count = failure_count + 1 WHERE id = $1`, [actionInput.sessionId]);
      return true;
    }

    const owner = createPreviewFlow(db, { persistFailure });
    const other = createPreviewFlow(db, { persistFailure });

    async function reset() {
      await db.query('TRUNCATE chat_sessions, preview_flow_resources CASCADE');
      await db.query('TRUNCATE preview_action_receipts CASCADE');
      await db.query(`INSERT INTO chat_sessions (id, status, source, checks_commit_sha)
        VALUES (1, 'active', 'cli_handoff', $1)`, [HEAD]);
    }

    async function start(flowOwner = owner) {
      const admission = await flowOwner.apply(request('RetryPreview'));
      return admission.decision.flow;
    }

    async function ready(flow, flowOwner = owner) {
      const receipt = await flowOwner.recordRuntime(1, flow.id, runtimeReceipt());
      return flowOwner.apply(action('PreviewReady', { ...flowIdentity(flow), receipt }));
    }

    const intent = {
      runtimeKind: 'docker',
      runtimeName: 'runtime-1',
      dbName: 'app_demo_staging_s1_aaaaaa',
      namespace: null,
    };

    async function reserve() {
      const flow = await start();
      await owner.recordIntent(1, flow.id, intent);
      return flow;
    }

    function cleanup(flow) {
      return action('RequestPreviewCleanup', { flowId: flow.id });
    }

    function completed(flow, disposition = 'removed') {
      return action('PreviewCleanupCompleted', { flowId: flow.id, disposition });
    }

    await t.test('boot migration removes the checkpoint receipt cascade and is safe to replay', async () => {
      await reset();
      const flow = await reserve();
      await db.query(`ALTER TABLE preview_action_receipts ADD CONSTRAINT preview_action_receipts_session_id_fkey
        FOREIGN KEY (session_id) REFERENCES chat_sessions(id) ON DELETE CASCADE`);
      const migration = source.match(/ALTER TABLE preview_action_receipts DROP CONSTRAINT IF EXISTS preview_action_receipts_session_id_fkey;/);
      assert.ok(migration, 'checkpoint schema must migrate as well as fresh installs');
      await db.query(migration[0]);
      await db.query(migration[0]);
      await db.query('DELETE FROM chat_sessions WHERE id = 1');
      assert.equal((await owner.trace(1)).length, 1);
      assert.equal((await owner.apply(cleanup(flow))).decision.accepted, true);
    });

    await t.test('duplicate admission delivers one decision, one trace and one build description', async () => {
      await reset();
      const actionInput = request('RequestPreview');
      const [first, second] = await Promise.all([owner.apply(actionInput), other.apply(actionInput)]);
      assert.deepEqual(first.decision, second.decision);
      assert.equal([first, second].filter(result => result.replayed).length, 1);
      assert.equal((await owner.trace(1)).length, 1);
      const conflict = { ...actionInput, type: 'RetryPreview' };
      await assert.rejects(owner.apply(conflict), { code: 'PREVIEW_ACTION_CONFLICT' });
    });

    await t.test('concurrent independent requests join one in-flight flow', async () => {
      await reset();
      const decisions = await Promise.all([owner.apply(request('RequestPreview')), other.apply(request('RequestPreview'))]);
      assert.equal(decisions[0].decision.flow.id, decisions[1].decision.flow.id);
      assert.equal(decisions.reduce((n, d) => n + d.decision.effects.length, 0), 1);
    });

    await t.test('a same-SHA retry fences both late success and late failure', async () => {
      await reset();
      const old = await start();
      const current = await start(other);
      const retryTrace = (await owner.trace(1)).at(-1);
      assert.deepEqual(retryTrace.decision.supersededFlow, { ...old, state: 'superseded' });
      assert.equal((await db.query('SELECT state FROM preview_flows WHERE id = $1', [old.id])).rows[0].state,
        retryTrace.decision.supersededFlow.state);
      await ready(current, other);
      assert.equal((await ready(old)).decision.reason, 'superseded_flow');
      const failure = await owner.apply(action('PreparationFailed', { ...flowIdentity(old), detail: 'old boot failure' }));
      assert.equal(failure.decision.accepted, false);
      const { rows } = await db.query('SELECT * FROM chat_sessions WHERE id = 1');
      assert.equal(rows[0].staging_url, runtimeReceipt().stagingUrl);
      assert.equal(rows[0].failure_count, 0);
      assert.equal((await db.query('SELECT * FROM preview_flow_resources')).rows.length, 2,
        'rejected resource observation remains discoverable');
    });

    await t.test('retirement refuses caller-selected resources and completion without accepted work', async () => {
      await reset();
      const flow = await reserve();
      assert.equal((await owner.apply(completed(flow))).decision.reason, 'cleanup_not_requested');
      assert.equal((await owner.apply({ ...cleanup(flow), sessionId: 2 })).decision.reason, 'resource_missing');
      assert.equal((await owner.apply(cleanup({ id: randomUUID() }))).decision.reason, 'resource_missing');
      assert.equal((await owner.read(1)).resource.cleanupStarted, false);
      for (const entry of await owner.trace(1)) assert.deepEqual(replayDecision(entry), entry.decision);
    });

    await t.test('cleanup authorization, receipt and trace roll back together before any effect is returned', async () => {
      await reset();
      const flow = await reserve();
      const actionInput = cleanup(flow);
      await db.query(`ALTER TABLE preview_flow_decisions ADD CONSTRAINT reject_cleanup_trace
        CHECK (action->>'type' != 'RequestPreviewCleanup')`);
      try {
        await assert.rejects(owner.apply(actionInput), /reject_cleanup_trace/);
        assert.equal((await owner.read(1)).resource.cleanupStarted, false);
        assert.equal((await db.query('SELECT * FROM preview_action_receipts WHERE action_id = $1', [actionInput.actionId])).rows.length, 0);
      } finally {
        await db.query('ALTER TABLE preview_flow_decisions DROP CONSTRAINT reject_cleanup_trace');
      }
      const [first, duplicate] = await Promise.all([owner.apply(actionInput), other.apply(actionInput)]);
      assert.deepEqual(first.decision, duplicate.decision);
      assert.equal([first, duplicate].filter(result => result.replayed).length, 1);
      assert.equal(first.decision.effects[0].effectKey, `${flow.id}:cleanup`);
      assert.equal((await owner.read(1)).resource.cleanupStarted, true);
      assert.equal((await ready(flow)).decision.reason, 'resource_retiring');
      const resumed = await other.apply(cleanup(flow));
      assert.equal(resumed.decision.reason, 'cleanup_resumed');
      assert.equal(resumed.decision.resourceChange, undefined, 'a retry does not invent a new retirement claim');
      assert.equal(resumed.decision.effects[0].effectKey, first.decision.effects[0].effectKey);
    });

    await t.test('a published predecessor stays protected after a newer flow is admitted', async () => {
      await reset();
      const flow = await reserve();
      await ready(flow);
      const successor = await start(other);
      const rejected = await owner.apply(cleanup(flow));
      assert.equal(rejected.decision.reason, 'resource_published');
      assert.equal(rejected.current.flow.id, successor.id);
      assert.equal(rejected.current.resource.cleanupStarted, false);
      assert.equal(rejected.current.preview.stagingUrl, runtimeReceipt().stagingUrl);
      for (const entry of await owner.trace(1)) assert.deepEqual(replayDecision(entry), entry.decision);
    });

    await t.test('concurrent publication and retirement cannot both receive permission', async () => {
      await reset();
      const flow = await reserve();
      await owner.recordRuntime(1, flow.id, runtimeReceipt());
      const [published, retired] = await Promise.all([
        owner.apply(action('PreviewReady', { ...flowIdentity(flow), receipt: runtimeReceipt() })), other.apply(cleanup(flow)),
      ]);
      assert.equal(Number(published.decision.accepted) + Number(retired.decision.accepted), 1);
      const current = await owner.read(1);
      if (published.decision.accepted) {
        assert.equal(retired.decision.reason, 'resource_published');
        assert.equal(current.resource.cleanupStarted, false);
        assert.deepEqual(current.preview, runtimeReceipt());
      } else {
        assert.equal(published.decision.reason, 'resource_retiring');
        assert.equal(current.resource.cleanupStarted, true);
        assert.equal(current.preview.stagingUrl, null);
      }
    });

    await t.test('historical retirement leaves the successor alone and completion is idempotent, immutable and replayable', async () => {
      await reset();
      const old = await reserve();
      const successor = await start(other);
      await ready(successor, other);
      const retired = await owner.apply(cleanup(old));
      assert.equal(retired.decision.accepted, true);
      assert.equal(retired.current.flow.id, successor.id);
      assert.equal(retired.current.flow.state, 'ready');
      assert.deepEqual(retired.current.preview, runtimeReceipt());
      const done = completed(old, 'replaced');
      await owner.apply(done);
      assert.equal((await other.apply(done)).replayed, true);
      assert.equal((await other.apply(completed(old, 'replaced'))).decision.reason, 'cleanup_already_completed');
      assert.equal((await other.apply(completed(old, 'removed'))).decision.reason, 'cleanup_result_conflict');
      const retried = await other.apply(cleanup(old));
      assert.equal(retried.decision.disposition, 'replaced');
      assert.deepEqual(retried.decision.effects, []);
      assert.equal(retried.current.resource.cleanupCompleted, true);
      assert.deepEqual(retried.current.preview, runtimeReceipt());
      for (const entry of await owner.trace(1)) assert.deepEqual(replayDecision(entry), entry.decision);
    });

    await t.test('deleted aggregates retain original decisions and serialize concurrent orphan actions', async () => {
      await reset();
      const oldRequest = request('RetryPreview');
      const flow = (await owner.apply(oldRequest)).decision.flow;
      await owner.recordIntent(1, flow.id, intent);
      const second = await reserve();
      const tracesBefore = await owner.trace(1);
      await db.query('DELETE FROM chat_sessions WHERE id = 1');
      assert.deepEqual(await owner.trace(1), tracesBefore, 'deletion does not erase historical decisions');
      assert.equal((await owner.apply(oldRequest)).replayed, true, 'original request still has its receipt');
      await assert.rejects(owner.apply(request('RequestPreview')), { code: 'PREVIEW_SESSION_MISSING' });
      const actionInput = cleanup(flow);
      const pair = await Promise.all([owner.apply(actionInput), other.apply(actionInput)]);
      assert.equal(pair.filter(result => result.replayed).length, 1);
      assert.deepEqual(pair[0].decision, pair[1].decision);
      assert.equal(pair[0].current.session, null);
      await owner.apply(completed(flow));
      for (const entry of await owner.trace(1)) assert.deepEqual(replayDecision(entry), entry.decision);
      // Same receipt key, different resource input: the orphan aggregate lock
      // serializes this even though no session or second resource row exists.
      await assert.rejects(other.apply({ ...actionInput, flowId: randomUUID() }), { code: 'PREVIEW_ACTION_CONFLICT' });
      const sharedId = randomUUID();
      const conflicting = await Promise.allSettled([
        owner.apply({ ...cleanup(flow), actionId: sharedId }),
        other.apply({ ...cleanup(second), actionId: sharedId }),
      ]);
      assert.equal(conflicting.filter(result => result.status === 'fulfilled').length, 1);
      assert.equal(conflicting.find(result => result.status === 'rejected').reason.code, 'PREVIEW_ACTION_CONFLICT');
      assert.equal((await db.query('SELECT * FROM preview_action_receipts WHERE action_id = $1', [sharedId])).rows.length, 1);
      for (const entry of await owner.trace(1)) assert.deepEqual(replayDecision(entry), entry.decision);
    });

    await t.test('publication locks the aggregate and rejects a head changed by another owner', async () => {
      await reset();
      const flow = await start();
      await owner.recordRuntime(1, flow.id, runtimeReceipt());
      const client = await db.connect();
      await client.query('BEGIN');
      await client.query('UPDATE chat_sessions SET checks_commit_sha = $1 WHERE id = 1', [NEXT]);
      const publication = owner.apply(action('PreviewReady', { ...flowIdentity(flow), receipt: runtimeReceipt() }));
      await client.query('COMMIT');
      client.release();
      assert.equal((await publication).decision.reason, 'head_changed');
      assert.equal((await owner.read(1)).preview.stagingUrl, null);
    });

    await t.test('all seven projection fields publish atomically', async () => {
      await reset();
      const flow = await start();
      const result = await ready(flow);
      assert.equal(result.decision.accepted, true);
      assert.deepEqual(result.current.preview, runtimeReceipt());
      await assert.rejects(owner.recordRuntime(1, flow.id, { ...runtimeReceipt(), imageRef: 'conflict' }));
      await assert.rejects(owner.recordRuntime(1, flow.id, runtimeReceipt(NEXT)));
    });

    await t.test('failure bookkeeping, retirement, receipt and trace roll back together', async () => {
      await reset();
      const flow = await start();
      await db.query(`UPDATE chat_sessions SET staging_url = 'https://old.example.test', staging_image_ref = 'old' WHERE id = 1`);
      const broken = createPreviewFlow(db, {
        persistFailure: async (client, actionInput) => {
          await persistFailure(client, actionInput);
          throw new Error('forced write failure');
        },
      });
      const failed = action('PreparationFailed', { ...flowIdentity(flow), detail: 'boot failed' });
      await assert.rejects(broken.apply(failed), /forced write failure/);
      assert.equal((await owner.trace(1)).length, 1);
      assert.equal((await db.query('SELECT failure_count FROM chat_sessions')).rows[0].failure_count, 0);
      assert.equal((await owner.read(1)).preview.stagingUrl, 'https://old.example.test');
      const accepted = await owner.apply(failed);
      assert.equal(accepted.decision.accepted, true);
      assert.equal(accepted.current.flow.state, 'failed');
      assert.ok(Object.values(accepted.current.preview).every(v => v === null));
      await other.apply(failed);
      assert.equal((await db.query('SELECT failure_count FROM chat_sessions')).rows[0].failure_count, 1);
    });

    await t.test('resource inventory survives a failed projection transaction', async () => {
      await reset();
      const flow = await start();
      await owner.recordRuntime(1, flow.id, runtimeReceipt());
      await db.query(`ALTER TABLE chat_sessions ADD CONSTRAINT reject_projection CHECK (staging_url IS NULL)`);
      try {
        await assert.rejects(ready(flow), /reject_projection/);
        assert.equal((await owner.read(1)).flow.state, 'preparing');
        assert.equal((await owner.trace(1)).length, 1);
        assert.equal((await db.query('SELECT * FROM preview_flow_resources')).rows.length, 1);
      } finally {
        await db.query('ALTER TABLE chat_sessions DROP CONSTRAINT reject_projection');
      }
    });

    await t.test('production check-error helper settles only the admitted native flow', async () => {
      await reset();
      const flow = await start();
      const productionOwner = createPreviewFlow(db);
      const failure = action('PreparationFailed', { ...flowIdentity(flow), detail: 'fixture boot failure' });
      const decision = await productionOwner.apply(failure);
      assert.equal(decision.decision.accepted, true);
      const { rows } = await db.query('SELECT * FROM chat_sessions WHERE id = 1');
      assert.equal(rows[0].check_state, 'error');
      assert.equal(rows[0].check_error_detail, failure.detail);
      assert.equal(rows[0].consecutive_check_failures, 1);
      assert.ok(rows[0].check_next_retry_at > rows[0].checks_checked_at);
      assert.equal(rows[0].staging_url, null);
      const successor = await start();
      await productionOwner.apply(action('PreparationFailed', { ...flowIdentity(flow), detail: 'late failure' }));
      assert.equal((await productionOwner.read(1)).flow.id, successor.id);
      assert.equal((await db.query('SELECT consecutive_check_failures FROM chat_sessions')).rows[0].consecutive_check_failures, 1);
    });

    await t.test('a replay reports original decision separately from current state', async () => {
      await reset();
      const actionInput = request('RetryPreview');
      const original = await owner.apply(actionInput);
      const successor = await start(other);
      const replay = await owner.apply(actionInput);
      assert.deepEqual(replay.decision, original.decision);
      assert.equal(replay.current.flow.id, successor.id);
      assert.equal(replay.replayed, true);
    });

    await t.test('decision traces replay after mutable state has moved', async () => {
      await reset();
      const first = await start();
      await ready(first);
      await start(other);
      await ready(first);
      for (const entry of await owner.trace(1)) {
        assert.equal(entry.reducer_version, REDUCER_VERSION);
        assert.deepEqual(replayDecision(entry), entry.decision);
        assert.throws(() => replayDecision({ ...entry, reducer_version: 999 }), /Unsupported/);
      }
    });

    await t.test('late clear cannot retire a successor; terminal cleanup of current identity is allowed', async () => {
      await reset();
      const old = await start();
      const current = await start();
      await ready(current);
      assert.equal((await owner.apply(action('ClearPreview', flowIdentity(old)))).decision.reason, 'superseded_flow');
      await db.query(`UPDATE chat_sessions SET status = 'archived' WHERE id = 1`);
      const cleared = await owner.apply(action('ClearPreview', flowIdentity(current)));
      assert.equal(cleared.decision.accepted, true);
      assert.ok(Object.values(cleared.current.preview).every(v => v === null));
    });

    await t.test('legacy native executor receives identity and publishes its complete observation', async () => {
      await reset();
      let options;
      const result = await prepareNativePreview({
        pool: db,
        session: { id: 1, status: 'active' },
        headSha: HEAD,
        build: async (_config, _session, _app, head, supplied) => {
          assert.equal(head, HEAD);
          options = supplied;
          await supplied.beforeBuild({
            runtimeKind: 'docker',
            runtimeName: 'runtime-1',
            dbName: 'app_demo_staging_s1_aaaaaa',
            namespace: null,
          });
          const result = { ...runtimeReceipt(), hostname: 'preview.example.test', timings: {} };
          await supplied.consumePrepared(result);
          return result;
        },
      });
      assert.equal(result.accepted, true);
      assert.deepEqual(options.previewFlow, result.identity);
      assert.deepEqual((await owner.read(1)).preview, runtimeReceipt());
    });

    await t.test('a build completing after retry produces no accepted publication', async () => {
      await reset();
      const result = await prepareNativePreview({
        pool: db,
        session: { id: 1, status: 'active' },
        headSha: HEAD,
        cleanup: async () => ({ disposition: 'removed' }),
        build: async (_config, _session, _app, _head, supplied) => {
          await supplied.beforeBuild({
            runtimeKind: 'docker',
            runtimeName: 'runtime-1',
            dbName: 'app_demo_staging_s1_aaaaaa',
            namespace: null,
          });
          await start(other);
          await supplied.consumePrepared(runtimeReceipt());
          return runtimeReceipt();
        },
      });
      assert.equal(result.accepted, false);
      assert.equal(result.reason, 'superseded_flow');
      assert.equal((await owner.read(1)).preview.stagingUrl, null);
    });
  } finally {
    await db.end();
    await root.query(`DROP SCHEMA ${schema} CASCADE`);
    await root.end();
  }
});
