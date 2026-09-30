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
const action = (type, fields = {}) => ({ type, actionId: randomUUID(), sessionId: 1, ...fields });
const request = type => action(type, { headSha: HEAD, startedStatus: 'active' });
const resource = (head = HEAD, kind = 'docker') => ({ commitSha: head,
  stagingUrl: 'https://preview.example.test', runtimeKind: kind, runtimeName: 'runtime-1',
  containerId: kind === 'docker' ? 'runtime-1' : null, imageRef: 'image:exact', buildRef: null });
const initial = () => ({ session: { id: 1, status: 'active', source: 'cli_handoff',
  checksCommitSha: HEAD, reviewedHeadSha: null }, flow: null, preview: null });
const identity = flow => ({ flowId: flow.id, generation: flow.generation, headSha: flow.headSha });

test('preview actions validate exact SHA, identity, runtime tuple and reject raw patches', () => {
  assert.throws(() => parseAction({ ...request('RequestPreview'), headSha: 'latest' }));
  assert.throws(() => parseAction({ ...request('RequestPreview'), capability: 'admin' }));
  assert.throws(() => parseAction({ ...request('RequestPreview'), patch: { staging_url: 'x' } }));
  const ready = action('PreviewReady', { flowId: randomUUID(), generation: 1, headSha: HEAD,
    receipt: resource() });
  assert.equal(parseAction(ready).receipt.commitSha, HEAD);
  assert.throws(() => parseAction({ ...ready, generation: 0 }));
  assert.throws(() => parseAction({ ...ready, receipt: { ...resource(), containerId: null } }));
  assert.throws(() => parseAction({ ...ready, receipt: { ...resource(), env: { SECRET: 'no' } } }));
  assert.equal(parseAction({ ...ready, receipt: resource(HEAD, 'kubernetes') }).receipt.containerId, null);
});

test('pure reducer joins eligible requests; explicit same-SHA retry advances identity', () => {
  const state = initial();
  const before = structuredClone(state);
  const requestAction = parseAction(request('RequestPreview'));
  const requested = reduce(state, requestAction, { newFlowId: randomUUID() });
  assert.deepEqual(state, before, 'input state is immutable');
  assert.equal(requested.flow.generation, 1);
  assert.deepEqual(requested.effects, [{ type: 'BuildPreview', effectKey: `${requested.flow.id}:build`,
    causedBy: requestAction.actionId, sessionId: 1,
    ...identity(requested.flow) }]);
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
  const stale = reduce({ ...state, flow: retried.flow }, parseAction(action('PreviewReady', {
    ...identity(requested.flow), receipt: resource(),
  })), {});
  assert.equal(stale.reason, 'superseded_flow');
  assert.equal(stale.projection, 'unchanged');
});

test('native policy preserves paused submission and promotion only on the reviewed commit', () => {
  for (const [status, reviewedHeadSha, startedStatus, accepted] of [
    ['active', null, 'active', true], ['paused', null, 'paused', true],
    ['paused', null, 'active', false], ['active', null, 'paused', false],
    ['promoted', HEAD, 'active', true], ['promoted', NEXT, 'active', false],
    ['promoted', null, 'active', false], ['merging', HEAD, 'active', false],
    ['archived', HEAD, 'active', false], ['merged', HEAD, 'active', false],
  ]) {
    const state = initial();
    Object.assign(state.session, { status, reviewedHeadSha });
    assert.equal(reduce(state, parseAction(action('RetryPreview', { headSha: HEAD, startedStatus })),
      { newFlowId: randomUUID() }).accepted, accepted, `${status}/${startedStatus}/${reviewedHeadSha}`);
  }
  const imported = initial();
  imported.session.source = 'imported';
  assert.equal(reduce(imported, parseAction(request('RequestPreview')), {}).reason, 'imported_session');
});

const url = process.env.PREVIEW_FLOW_TEST_DATABASE_URL || process.env.SQL_CHECK_CONNECTION_URL;
test('preview flow transactions across independent PostgreSQL connections', { skip: !url }, async t => {
  // Isolated schema on an explicitly supplied disposable DB, never DATABASE_URL.
  const root = new Pool({ connectionString: url });
  const schema = `preview_flow_test_${process.pid}`;
  await root.query(`CREATE SCHEMA ${schema}`);
  const scoped = new URL(url);
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
    const persistFailure = async (client, a) => {
      await client.query(`UPDATE chat_sessions SET check_state = 'error', failure_count = failure_count + 1 WHERE id = $1`, [a.sessionId]);
      return true;
    };
    const owner = createPreviewFlow(db, { persistFailure });
    const other = createPreviewFlow(db, { persistFailure });
    const reset = async () => {
      await db.query('TRUNCATE chat_sessions, preview_flow_resources CASCADE');
      await db.query(`INSERT INTO chat_sessions (id, status, source, checks_commit_sha)
        VALUES (1, 'active', 'cli_handoff', $1)`, [HEAD]);
    };
    const start = async (api = owner) => (await api.apply(request('RetryPreview'))).decision.flow;
    const ready = async (f, api = owner) => {
      const receipt = await api.recordRuntime(1, f.id, resource());
      return api.apply(action('PreviewReady', { ...identity(f), receipt }));
    };

    await t.test('duplicate admission delivers one decision, one trace and one build description', async () => {
      await reset();
      const a = request('RequestPreview');
      const [first, second] = await Promise.all([owner.apply(a), other.apply(a)]);
      assert.deepEqual(first.decision, second.decision);
      assert.equal([first, second].filter(r => r.replayed).length, 1);
      assert.equal((await owner.trace(1)).length, 1);
      const conflict = { ...a, type: 'RetryPreview' };
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
      await ready(current, other);
      assert.equal((await ready(old)).decision.reason, 'superseded_flow');
      const failure = await owner.apply(action('PreparationFailed', { ...identity(old), detail: 'old boot failure' }));
      assert.equal(failure.decision.accepted, false);
      const { rows } = await db.query('SELECT * FROM chat_sessions WHERE id = 1');
      assert.equal(rows[0].staging_url, resource().stagingUrl);
      assert.equal(rows[0].failure_count, 0);
      assert.equal((await db.query('SELECT * FROM preview_flow_resources')).rows.length, 2,
        'rejected resource observation remains discoverable');
    });

    await t.test('publication locks the aggregate and rejects a head changed by another owner', async () => {
      await reset();
      const f = await start();
      await owner.recordRuntime(1, f.id, resource());
      const client = await db.connect();
      await client.query('BEGIN');
      await client.query('UPDATE chat_sessions SET checks_commit_sha = $1 WHERE id = 1', [NEXT]);
      const publication = owner.apply(action('PreviewReady', { ...identity(f), receipt: resource() }));
      await client.query('COMMIT');
      client.release();
      assert.equal((await publication).decision.reason, 'head_changed');
      assert.equal((await owner.read(1)).preview.stagingUrl, null);
    });

    await t.test('all seven projection fields publish atomically', async () => {
      await reset();
      const f = await start();
      const r = await ready(f);
      assert.equal(r.decision.accepted, true);
      assert.deepEqual(r.current.preview, resource());
      await assert.rejects(owner.recordRuntime(1, f.id, { ...resource(), imageRef: 'conflict' }));
      await assert.rejects(owner.recordRuntime(1, f.id, resource(NEXT)));
    });

    await t.test('failure bookkeeping, retirement, receipt and trace roll back together', async () => {
      await reset();
      const f = await start();
      await db.query(`UPDATE chat_sessions SET staging_url = 'https://old.example.test', staging_image_ref = 'old' WHERE id = 1`);
      const broken = createPreviewFlow(db, { persistFailure: async (client, a) => {
        await persistFailure(client, a);
        throw new Error('forced write failure');
      } });
      const failed = action('PreparationFailed', { ...identity(f), detail: 'boot failed' });
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
      const f = await start();
      await owner.recordRuntime(1, f.id, resource());
      await db.query(`ALTER TABLE chat_sessions ADD CONSTRAINT reject_projection CHECK (staging_url IS NULL)`);
      try {
        await assert.rejects(ready(f), /reject_projection/);
        assert.equal((await owner.read(1)).flow.state, 'preparing');
        assert.equal((await owner.trace(1)).length, 1);
        assert.equal((await db.query('SELECT * FROM preview_flow_resources')).rows.length, 1);
      } finally { await db.query('ALTER TABLE chat_sessions DROP CONSTRAINT reject_projection'); }
    });

    await t.test('production check-error helper settles only the admitted native flow', async () => {
      await reset();
      const f = await start();
      const productionOwner = createPreviewFlow(db);
      const failure = action('PreparationFailed', { ...identity(f), detail: 'fixture boot failure' });
      const decision = await productionOwner.apply(failure);
      assert.equal(decision.decision.accepted, true);
      const { rows } = await db.query('SELECT * FROM chat_sessions WHERE id = 1');
      assert.equal(rows[0].check_state, 'error');
      assert.equal(rows[0].check_error_detail, failure.detail);
      assert.equal(rows[0].consecutive_check_failures, 1);
      assert.ok(rows[0].check_next_retry_at > rows[0].checks_checked_at);
      assert.equal(rows[0].staging_url, null);
      const successor = await start();
      await productionOwner.apply(action('PreparationFailed', { ...identity(f), detail: 'late failure' }));
      assert.equal((await productionOwner.read(1)).flow.id, successor.id);
      assert.equal((await db.query('SELECT consecutive_check_failures FROM chat_sessions')).rows[0].consecutive_check_failures, 1);
    });

    await t.test('a replay reports original decision separately from current state', async () => {
      await reset();
      const a = request('RetryPreview');
      const original = await owner.apply(a);
      const successor = await start(other);
      const replay = await owner.apply(a);
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
      assert.equal((await owner.apply(action('ClearPreview', identity(old)))).decision.reason, 'superseded_flow');
      await db.query(`UPDATE chat_sessions SET status = 'archived' WHERE id = 1`);
      const cleared = await owner.apply(action('ClearPreview', identity(current)));
      assert.equal(cleared.decision.accepted, true);
      assert.ok(Object.values(cleared.current.preview).every(v => v === null));
    });

    await t.test('legacy native executor receives identity and publishes its complete observation', async () => {
      await reset();
      let options;
      const result = await prepareNativePreview({ pool: db, session: { id: 1, status: 'active' },
        headSha: HEAD, build: async (_config, _session, _app, head, supplied) => {
          assert.equal(head, HEAD);
          options = supplied;
          await supplied.beforeBuild({ runtimeKind: 'docker', runtimeName: 'runtime-1',
            dbName: 'app_demo_staging_s1_aaaaaa', namespace: null });
          const result = { ...resource(), hostname: 'preview.example.test', timings: {} };
          await supplied.consumePrepared(result);
          return result;
        } });
      assert.equal(result.accepted, true);
      assert.deepEqual(options.previewFlow, result.identity);
      assert.deepEqual((await owner.read(1)).preview, resource());
    });

    await t.test('a build completing after retry produces no accepted publication', async () => {
      await reset();
      const result = await prepareNativePreview({ pool: db, session: { id: 1, status: 'active' },
        headSha: HEAD, cleanup: async () => ({ disposition: 'removed' }),
        build: async (_config, _session, _app, _head, supplied) => {
          await supplied.beforeBuild({ runtimeKind: 'docker', runtimeName: 'runtime-1',
            dbName: 'app_demo_staging_s1_aaaaaa', namespace: null });
          await start(other);
          await supplied.consumePrepared(resource());
          return resource();
        } });
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
