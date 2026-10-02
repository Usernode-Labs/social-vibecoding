'use strict';

const { verifyDisposablePostgres } = require('./lib/disposable-postgres');
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { randomUUID } = require('node:crypto');
const fs = require('node:fs');
const { Pool } = require('pg');
const { createSessionDecisionRuntime } = require('../src/services/decision-runtime');
const { createPreviewFlow } = require('../src/services/preview-flow');
const { createProposalReview } = require('../src/services/proposal-review/store');
const previewReducer = require('../src/services/preview-flow/reducer');
const reviewReducer = require('../src/services/proposal-review/reducer');
const { candidateResources } = require('../src/services/preview-flow/candidate-resources');
const { parseAction } = require('../src/services/proposal-review/actions');

const HEAD = 'a'.repeat(40);
const NEXT_HEAD = 'b'.repeat(40);
const SESSION = 810000 + process.pid;
const databaseUrl = process.env.PREVIEW_FLOW_TEST_DATABASE_URL || process.env.SQL_CHECK_CONNECTION_URL;

function action(type, fields = {}) {
  return { type, actionId: randomUUID(), sessionId: SESSION, ...fields };
}

function returnAction(fields = {}) {
  return action('RequestReturnToDevelopment', { userId: 1, actorUsername: 'alice', ...fields });
}

function identity(flow) {
  return { flowId: flow.id, generation: flow.generation, headSha: flow.headSha };
}

function deferred() {
  let resolve;
  const promise = new Promise(done => { resolve = done; });
  return { promise, resolve };
}

// Inject a transport boundary on real connections, not a simulated transaction.
function interceptPool(pool, intercept) {
  return {
    query: (...args) => pool.query(...args),
    connect: async () => {
      const client = await pool.connect();
      return {
        query: (sql, params) => intercept(client, String(sql), params),
        release: () => client.release(),
      };
    },
  };
}

function pauseAfter(pool, matches) {
  const entered = deferred();
  const release = deferred();
  let paused = false;
  return {
    entered: entered.promise,
    release: release.resolve,
    pool: interceptPool(pool, async (client, sql, params) => {
      const result = await client.query(sql, params);
      if (!paused && matches(sql, params)) {
        paused = true;
        entered.resolve();
        await release.promise;
      }
      return result;
    }),
  };
}

function failOnce(pool, matches, { afterCommit = false } = {}) {
  let matched = false;
  let failed = false;
  return interceptPool(pool, async (client, sql, params) => {
    if (matches(sql, params)) matched = true;
    const fail = !failed && (afterCommit ? matched && sql === 'COMMIT' : matches(sql, params));
    if (fail) failed = true;
    if (fail && !afterCommit) throw new Error('Injected decision persistence failure');
    const result = await client.query(sql, params);
    if (fail) throw new Error('Injected decision commit acknowledgment loss');
    return result;
  });
}

test('review actions and reducer make ownership, status and vote invalidation explicit', () => {
  const request = parseAction(returnAction());
  assert.throws(() => parseAction({ ...request, patch: { status: 'paused' } }));
  assert.equal(parseAction({ ...request, actorUsername: 'a'.repeat(255) }).actorUsername.length, 255,
    'the action accepts the existing users.username database limit');
  const state = {
    session: { id: SESSION, userId: 1, appId: 1, status: 'promoted', source: 'cli_handoff',
      headless: false, turnRunning: false, approvalEpoch: 4, prNumber: 7, prTitle: 'Change' },
    appSlug: 'demo',
    pendingSecret: false,
  };
  const before = structuredClone(state);
  const decision = reviewReducer.reduce(state, request, { busyNow: false });
  assert.deepEqual(state, before);
  assert.deepEqual(decision.change, { status: 'paused', approvalEpoch: 5 });
  assert.deepEqual(decision.effects.map(effect => effect.type), ['StopDevelopmentWorker', 'AnnounceReturnToDevelopment']);
  assert.equal(reviewReducer.reduce(state, { ...request, userId: 2 }, {}).reason, 'forbidden');
  assert.equal(reviewReducer.reduce({ ...state, pendingSecret: true }, request, {}).reason, 'pending_secret');
  assert.equal(reviewReducer.reduce(state, request, { busyNow: true }).reason, 'busy');
  assert.equal(reviewReducer.reduce({ ...state, session: { ...state.session, status: 'merging' } }, request, {}).reason, 'merging');
});

test('preview and review share one decision runtime over real PostgreSQL', { skip: !databaseUrl }, async t => {
  await verifyDisposablePostgres(databaseUrl);

  const schema = `decision_runtime_test_${process.pid}`;
  const root = new Pool({ connectionString: databaseUrl });
  await root.query(`CREATE SCHEMA ${schema}`);
  const scoped = new URL(databaseUrl);
  scoped.searchParams.set('options', `-c search_path=${schema}`);
  const peerName = `decision-runtime-peer-${process.pid}`;
  const pool = new Pool({ connectionString: scoped.toString(), max: 8 });
  const peerPool = new Pool({ connectionString: scoped.toString(), max: 8, application_name: peerName });
  const preview = createPreviewFlow(pool);
  const peerPreview = createPreviewFlow(peerPool);
  const review = createProposalReview(pool, { isBusy: () => false });
  const peerReview = createProposalReview(peerPool, { isBusy: () => false });
  const config = { appRuntime: 'docker' };
  const tables = ['preview_flows', 'preview_bindings', 'preview_flow_heads', 'preview_flow_resources',
    'preview_action_receipts', 'preview_flow_decisions', 'proposal_review_receipts', 'proposal_review_decisions', 'execution_work_requests', 'cli_preview_handoffs'];

  try {
    await pool.query(`CREATE TABLE apps (id INTEGER PRIMARY KEY, slug TEXT);
      INSERT INTO apps VALUES (1, 'demo');
      CREATE TABLE pending_secret_declarations (session_id INTEGER, status TEXT);
      CREATE TABLE chat_sessions (id INTEGER PRIMARY KEY, user_id INTEGER, app_id INTEGER, status TEXT,
        source TEXT, is_headless BOOLEAN DEFAULT FALSE, active_turn JSONB, approval_epoch INTEGER DEFAULT 0,
        stale_notified_at TIMESTAMPTZ, integration_block_reasons JSONB, pr_number INTEGER, pr_title TEXT,
        checks_commit_sha TEXT, reviewed_head_sha TEXT, staging_url TEXT,
        staging_container_id TEXT, staging_runtime_kind TEXT, staging_runtime_name TEXT,
        staging_image_ref TEXT, staging_build_ref TEXT, staging_commit_sha TEXT, last_activity_at TIMESTAMPTZ)`);
    const source = fs.readFileSync(require.resolve('../src/db/schema.sql'), 'utf8');
    for (const table of tables) {
      const definition = source.match(new RegExp(String.raw`CREATE TABLE IF NOT EXISTS ${table} \([\s\S]*?\n\);`));
      assert.ok(definition, table);
      await pool.query(definition[0]);
    }

    async function reset() {
      await pool.query(`TRUNCATE chat_sessions, pending_secret_declarations, ${tables.join(', ')} CASCADE`);
      await pool.query(`INSERT INTO chat_sessions (id, user_id, app_id, status, source,
        checks_commit_sha, reviewed_head_sha, integration_block_reasons, staging_url,
        staging_runtime_kind, staging_runtime_name, staging_commit_sha, pr_number, pr_title)
        VALUES ($1, 1, 1, 'promoted', 'cli_handoff', $2, $2, '["checks"]',
          'https://old.example.test', 'docker', 'old-serving', $2, 7, 'Change')`, [SESSION, HEAD]);
    }

    async function candidate({ reserve = true, prepare = true } = {}) {
      const requested = await preview.apply(action('RequestCandidatePreview', { headSha: HEAD, startedStatus: 'active' }));
      const flow = requested.decision.flow;
      const intent = candidateResources(config, SESSION, flow.attemptId);
      const receipt = {
        commitSha: HEAD,
        stagingUrl: `http://${intent.runtimeName}:3000`,
        runtimeKind: 'docker',
        runtimeName: intent.runtimeName,
        containerId: intent.runtimeName,
        imageRef: 'image:exact',
        buildRef: null,
        attemptId: flow.attemptId,
        physicalId: randomUUID(),
      };
      if (reserve) {
        await preview.recordIntent(SESSION, flow.id, intent, { credentialEnc: 'encrypted' });
        await preview.markClonePrepared(SESSION, flow.id);
        await preview.recordRuntime(SESSION, flow.id, receipt);
      }
      if (prepare) await preview.apply(action('PreviewCandidatePrepared', { ...identity(flow), receipt }));
      return { flow, intent, receipt };
    }

    function activationRequest(flow) {
      return action('RequestPreviewActivation', {
        ...identity(flow),
        expected: { target: 'old-serving', token: 'old-token', uid: null },
        stagingUrl: 'https://stable.example.test',
      });
    }

    async function assertPeerWaitsForAggregate() {
      for (let pass = 0; pass < 100; pass++) {
        const { rows } = await root.query(`SELECT wait_event_type, query FROM pg_stat_activity WHERE application_name = $1`, [peerName]);
        if (rows.some(row => row.wait_event_type === 'Lock' && /FROM chat_sessions.*FOR UPDATE/.test(row.query))) return;
        await new Promise(resolve => setTimeout(resolve, 10));
      }
      assert.fail('the independent machine must wait on the shared session aggregate lock');
    }

    await t.test('return and preview retirement commit together and old facts cannot regain authority', async () => {
      await reset();
      const first = await candidate();
      const result = await review.apply(returnAction());
      assert.equal(result.decision.change.status, 'paused');
      assert.equal(result.related.decision.reason, 'preparation_retired');
      const current = await preview.read(SESSION);
      assert.equal(current.flow.state, 'superseded');
      assert.equal(current.resource.cleanupStarted, true);
      assert.equal(current.preview.runtimeName, 'old-serving');
      assert.equal((await peerPreview.apply(activationRequest(first.flow))).decision.reason, 'resource_retiring');
      const stalePrepared = await peerPreview.apply(action('PreviewCandidatePrepared', { ...identity(first.flow), receipt: first.receipt }));
      assert.equal(stalePrepared.decision.reason, 'resource_retiring');
      assert.equal((await review.read(SESSION)).session.approvalEpoch, 1);
      for (const entry of await preview.trace(SESSION)) assert.deepEqual(previewReducer.replayDecision(entry), entry.decision);
      for (const entry of await review.trace(SESSION)) assert.deepEqual(reviewReducer.replayDecision(entry), entry.decision);

      await pool.query('UPDATE chat_sessions SET checks_commit_sha = $2 WHERE id = $1', [SESSION, NEXT_HEAD]);
      const next = await peerPreview.apply(action('RequestCandidatePreview', { headSha: NEXT_HEAD, startedStatus: 'paused' }));
      assert.equal(next.decision.accepted, true);
      assert.notEqual(next.decision.flow.attemptId, first.flow.attemptId);
      assert.equal((await peerPreview.apply(activationRequest(first.flow))).decision.reason, 'superseded_flow');
    });

    await t.test('cancellation before resource reservation prevents late locators and external preparation', async () => {
      await reset();
      const first = await candidate({ reserve: false, prepare: false });
      await review.apply(returnAction());
      await assert.rejects(peerPreview.recordIntent(SESSION, first.flow.id, first.intent, { credentialEnc: 'encrypted' }),
        /already reserved or no longer belongs/);
      assert.equal((await preview.read(SESSION)).resource, null);
      assert.equal((await preview.read(SESSION)).preview.runtimeName, 'old-serving');
    });

    await t.test('resource reservation cannot insert locators after a racing review cancellation', async () => {
      await reset();
      const first = await candidate({ reserve: false, prepare: false });
      const gate = pauseAfter(pool, sql => sql.startsWith('UPDATE chat_sessions SET status = $2'));
      const returning = createProposalReview(gate.pool, { isBusy: () => false }).apply(returnAction());
      await gate.entered;
      const reserving = peerPreview.recordIntent(SESSION, first.flow.id, first.intent, { credentialEnc: 'encrypted' });
      // Attach the expected rejection before releasing the blocked peer.
      const rejected = assert.rejects(reserving, /already reserved or no longer belongs/);
      try { await assertPeerWaitsForAggregate(); }
      finally { gate.release(); }
      await Promise.all([returning, rejected]);
      assert.equal((await preview.read(SESSION)).resource, null);
      assert.equal((await preview.read(SESSION)).flow.state, 'superseded');
    });

    await t.test('preview activation waits for review cancellation on the same aggregate', async () => {
      await reset();
      const first = await candidate();
      const gate = pauseAfter(pool, sql => sql.startsWith('UPDATE chat_sessions SET status = $2'));
      const returning = createProposalReview(gate.pool, { isBusy: () => false }).apply(returnAction());
      await gate.entered;
      const activating = peerPreview.apply(activationRequest(first.flow));
      try {
        await assertPeerWaitsForAggregate();
        assert.equal((await preview.read(SESSION)).flow.state, 'candidate', 'uncommitted cross-machine changes stay invisible');
      } finally { gate.release(); }
      const [returned, activation] = await Promise.all([returning, activating]);
      assert.equal(returned.related.decision.reason, 'preparation_retired');
      assert.equal(activation.decision.reason, 'resource_retiring');
      assert.equal((await preview.read(SESSION)).binding, null);
    });

    await t.test('review waits for authorized activation and preserves its lost-acknowledgment recovery owner', async () => {
      await reset();
      const first = await candidate();
      const gate = pauseAfter(pool, sql => sql.startsWith('INSERT INTO preview_bindings'));
      const activating = createPreviewFlow(gate.pool).apply(activationRequest(first.flow));
      await gate.entered;
      const returning = peerReview.apply(returnAction());
      try {
        await assertPeerWaitsForAggregate();
        assert.equal((await review.read(SESSION)).session.status, 'promoted');
      } finally { gate.release(); }
      const [activation, returned] = await Promise.all([activating, returning]);
      assert.equal(returned.related.decision.reason, 'preview_owner_preserved');
      const pending = await preview.read(SESSION);
      assert.equal(pending.resource.cleanupStarted, false);
      assert.equal(pending.binding.desired.activationId, activation.decision.bindingChange.desired.activationId);
      const observation = action('PreviewActivationObserved', {
        ...identity(first.flow),
        activationId: pending.binding.desired.activationId,
        observation: { target: first.intent.runtimeName, token: 'new-token', uid: null },
      });
      assert.equal((await peerPreview.apply({ ...observation, actionId: randomUUID(), activationId: randomUUID() })).decision.reason, 'superseded_activation');
      assert.equal((await peerPreview.apply(observation)).decision.accepted, true);
      assert.equal((await preview.read(SESSION)).preview.runtimeName, first.intent.runtimeName);
      assert.equal((await review.read(SESSION)).session.status, 'paused');
    });

    for (const table of ['proposal_review_receipts', 'proposal_review_decisions', 'preview_flow_decisions']) {
      await t.test(`failure writing ${table} rolls back both machines and their receipts`, async () => {
        await reset();
        await candidate();
        const before = await preview.read(SESSION);
        const faulty = failOnce(pool, sql => sql.startsWith(`INSERT INTO ${table}`));
        await assert.rejects(createProposalReview(faulty, { isBusy: () => false }).apply(returnAction()), /persistence failure/);
        assert.deepEqual(await preview.read(SESSION), before);
        const returned = await review.read(SESSION);
        assert.equal(returned.session.status, 'promoted');
        assert.equal(returned.session.approvalEpoch, 0);
        assert.equal((await review.trace(SESSION)).length, 0);
        assert.ok(!(await preview.trace(SESSION)).some(entry => entry.action.type === 'RetirePreviewPreparation'));
      });
    }

    for (const operation of ['apply', 'withSession']) {
      await t.test(`a caught ${operation} write failure rolls back the entire composition`, async () => {
        await reset();
        const before = (await pool.query('SELECT * FROM chat_sessions WHERE id = $1', [SESSION])).rows[0];
        const runtime = createSessionDecisionRuntime(pool);
        const failure = new Error(`Injected ${operation} mapping failure after writing`);
        const { journal } = require('../src/services/proposal-review/journal');
        let wroteBeforeThrowing = false;

        async function writeThenThrow(client) {
          await client.query(`UPDATE chat_sessions SET status = 'paused',
            approval_epoch = approval_epoch + 1 WHERE id = $1`, [SESSION]);
          wroteBeforeThrowing = true;
          throw failure;
        }

        const machine = {
          name: 'test-partial-write',
          version: 1,
          parseAction,
          load: (_client, session) => ({ status: session.status }),
          facts: () => ({}),
          reduce: () => ({ accepted: true, reason: 'test_write', effects: [] }),
          persist: writeThenThrow,
          actionConflict: () => new Error('conflicting test action'),
          journal,
        };

        await assert.rejects(runtime.transact(async transaction => {
          const earlier = await preview.applyInTransaction(transaction, action('RequestCandidatePreview', {
            headSha: HEAD,
            startedStatus: 'active',
          }));
          assert.equal(earlier.decision.accepted, true);

          try {
            if (operation === 'apply') await transaction.apply(machine, returnAction());
            else await transaction.withSession(SESSION, writeThenThrow);
            assert.fail('the mapping must throw after its SQL write');
          } catch (error) {
            assert.equal(error, failure);
          }
          return 'the composition caught the error and returned normally';
        }), error => error === failure);

        assert.equal(wroteBeforeThrowing, true);
        const after = (await pool.query('SELECT * FROM chat_sessions WHERE id = $1', [SESSION])).rows[0];
        assert.deepEqual(after, before);
        const current = await preview.read(SESSION);
        assert.equal(current.flow, null, 'the earlier successful decision must roll back too');
        assert.equal((await preview.trace(SESSION)).length, 0);
        assert.equal((await review.trace(SESSION)).length, 0);
        const { rows } = await pool.query(`SELECT
          (SELECT COUNT(*) FROM preview_flows) AS preview_flows,
          (SELECT COUNT(*) FROM preview_action_receipts) AS preview_receipts,
          (SELECT COUNT(*) FROM proposal_review_receipts) AS review_receipts`);
        assert.equal(Number(rows[0].preview_flows), 0);
        assert.equal(Number(rows[0].preview_receipts), 0);
        assert.equal(Number(rows[0].review_receipts), 0);
      });
    }

    await t.test('a caught operation failure refuses every further transaction operation', async () => {
      await reset();
      const runtime = createSessionDecisionRuntime(pool);
      const failure = new Error('Injected write callback failure');
      let calledAgain = false;

      await assert.rejects(runtime.transact(async transaction => {
        await assert.rejects(transaction.withSession(SESSION, async () => { throw failure; }),
          error => error === failure);

        const checkFailure = error => {
          assert.equal(error.code, 'DECISION_TRANSACTION_FAILED');
          assert.equal(error.cause, failure);
          return true;
        };
        await assert.rejects(preview.applyInTransaction(transaction, action('RequestCandidatePreview', {
          headSha: HEAD,
          startedStatus: 'active',
        })), checkFailure);
        await assert.rejects(preview.readInTransaction(transaction, SESSION), checkFailure);
        await assert.rejects(transaction.withSession(SESSION, () => { calledAgain = true; }), checkFailure);
      }), error => error === failure);

      assert.equal(calledAgain, false);
      assert.equal((await preview.trace(SESSION)).length, 0);
    });

    await t.test('caught action validation failure also invalidates an earlier successful decision', async () => {
      await reset();
      const runtime = createSessionDecisionRuntime(pool);
      let caught;

      await assert.rejects(runtime.transact(async transaction => {
        await preview.applyInTransaction(transaction, action('RequestCandidatePreview', {
          headSha: HEAD,
          startedStatus: 'active',
        }));
        try {
          await preview.applyInTransaction(transaction, { type: 'UnknownAction' });
        } catch (error) {
          caught = error;
        }
        assert.ok(caught, 'action validation must fail inside the operation boundary');
      }), error => error === caught);

      assert.equal((await preview.read(SESSION)).flow, null);
      assert.equal((await preview.trace(SESSION)).length, 0);
    });

    await t.test('a rejected domain decision does not invalidate the composition', async () => {
      await reset();
      const runtime = createSessionDecisionRuntime(pool);
      const rejectedInput = action('RequestCandidatePreview', { headSha: NEXT_HEAD, startedStatus: 'active' });
      const acceptedInput = action('RequestCandidatePreview', { headSha: HEAD, startedStatus: 'active' });

      const accepted = await runtime.transact(async transaction => {
        const rejected = await preview.applyInTransaction(transaction, rejectedInput);
        assert.equal(rejected.decision.accepted, false);
        assert.equal(rejected.decision.reason, 'head_changed');
        const next = await preview.applyInTransaction(transaction, acceptedInput);
        await transaction.withSession(SESSION, client => client.query(
          "UPDATE chat_sessions SET integration_block_reasons = '[]'::jsonb WHERE id = $1", [SESSION]));
        return next;
      });

      assert.equal(accepted.decision.accepted, true);
      assert.equal((await preview.read(SESSION)).flow.id, accepted.decision.flow.id);
      assert.equal((await preview.trace(SESSION)).length, 2);
      assert.equal((await preview.apply(rejectedInput)).replayed, true);
      assert.equal((await preview.apply(acceptedInput)).replayed, true);
      const { rows } = await pool.query('SELECT integration_block_reasons FROM chat_sessions WHERE id = $1', [SESSION]);
      assert.deepEqual(rows[0].integration_block_reasons, []);
    });

    await t.test('lost composition commit acknowledgment replays both committed decisions without repeating the move', async () => {
      await reset();
      await candidate();
      const input = returnAction();
      const faulty = failOnce(pool, sql => sql.startsWith('INSERT INTO proposal_review_decisions'), { afterCommit: true });
      await assert.rejects(createProposalReview(faulty, { isBusy: () => false }).apply(input), /commit acknowledgment loss/);
      assert.equal((await preview.read(SESSION)).flow.state, 'superseded');
      const retry = await peerReview.apply(input);
      assert.equal(retry.replayed, true);
      assert.equal(retry.current.session.approvalEpoch, 1);
      assert.equal((await review.trace(SESSION)).length, 1);
      assert.equal((await preview.trace(SESSION)).filter(entry => entry.action.type === 'RetirePreviewPreparation').length, 1);
    });

    await t.test('duplicate and conflicting requests share receipt semantics while machine namespaces remain distinct', async () => {
      await reset();
      const sharedId = randomUUID();
      await preview.apply(action('RequestCandidatePreview', { actionId: sharedId, headSha: HEAD, startedStatus: 'active' }));
      const input = returnAction({ actionId: sharedId });
      const results = await Promise.all([review.apply(input), peerReview.apply(input)]);
      assert.equal(results.filter(result => result.replayed).length, 1);
      assert.deepEqual(results[0].decision, results[1].decision);
      assert.equal((await review.read(SESSION)).session.approvalEpoch, 1);
      await assert.rejects(peerReview.apply({ ...input, actorUsername: 'changed' }), { code: 'REVIEW_ACTION_CONFLICT' });
      await assert.rejects(peerPreview.apply(action('RequestCandidatePreview', {
        actionId: sharedId, headSha: NEXT_HEAD, startedStatus: 'active',
      })), { code: 'PREVIEW_ACTION_CONFLICT' });
    });

    await t.test('unrelated or stale review receipts cannot grant preview retirement', async () => {
      await reset();
      const first = await candidate();
      const input = action('RetirePreviewPreparation', { ...identity(first.flow), reviewActionId: randomUUID() });
      assert.equal((await peerPreview.apply(input)).decision.reason, 'review_return_changed');
      const returned = returnAction();
      await review.apply(returned);
      await pool.query('UPDATE chat_sessions SET approval_epoch = approval_epoch + 1 WHERE id = $1', [SESSION]);
      assert.equal((await peerPreview.apply({ ...input, actionId: randomUUID(), reviewActionId: returned.actionId })).decision.reason,
        'review_return_changed');
    });

    await t.test('both journals and original receipts survive aggregate deletion and share the missing-row lock', async () => {
      await reset();
      const first = await candidate();
      const input = returnAction();
      const accepted = await review.apply(input);
      await pool.query('DELETE FROM chat_sessions WHERE id = $1', [SESSION]);
      const pair = await Promise.all([review.apply(input), peerReview.apply(input)]);
      assert.ok(pair.every(result => result.replayed));
      assert.deepEqual(pair[0].decision, accepted.decision);
      assert.equal(pair[0].current.session, null);
      const cleanup = await peerPreview.apply(action('RequestPreviewCleanup', { flowId: first.flow.id }));
      assert.equal(cleanup.decision.accepted, true);
      assert.equal((await review.trace(SESSION)).length, 1);
      for (const entry of await preview.trace(SESSION)) assert.deepEqual(previewReducer.replayDecision(entry), entry.decision);
    });

    await t.test('the shared boundary rejects reducer mutation and executable effects before persistence', async () => {
      await reset();
      const runtime = createSessionDecisionRuntime(pool);
      const { journal } = require('../src/services/proposal-review/journal');
      const machine = {
        name: 'test-boundary',
        version: 1,
        parseAction,
        load: (_client, session) => ({ session: { status: session.status } }),
        facts: () => ({}),
        actionConflict: () => new Error('conflict'),
        journal,
        persist: () => assert.fail('invalid decisions must not reach persistence'),
      };
      const mutating = { ...machine, reduce: state => {
        state.session.status = 'paused';
        return { accepted: true, reason: 'changed', effects: [] };
      } };
      await assert.rejects(runtime.apply(mutating, returnAction()), /read only|readonly|not extensible/i);
      const executable = { ...machine, reduce: () => ({
        accepted: true,
        reason: 'changed',
        effects: [{ type: 'Run', run: () => {} }],
      }) };
      await assert.rejects(runtime.apply(executable, returnAction()), /only JSON data/);
      assert.equal((await review.trace(SESSION)).length, 0);
      assert.equal((await review.read(SESSION)).session.status, 'promoted');
    });

    await t.test('a committed transaction handle cannot perform later work on a released client', async () => {
      await reset();
      const runtime = createSessionDecisionRuntime(pool);
      let saved;
      await runtime.transact(async transaction => {
        saved = transaction;
        await preview.readInTransaction(transaction, SESSION);
      });
      await assert.rejects(preview.readInTransaction(saved, SESSION), /no longer open/);
      assert.equal((await review.read(SESSION)).session.status, 'promoted');
    });

    await t.test('a composition cannot quietly acquire an unordered second aggregate', async () => {
      await reset();
      const runtime = createSessionDecisionRuntime(pool);
      await assert.rejects(runtime.transact(async transaction => {
        await preview.readInTransaction(transaction, SESSION);
        await preview.readInTransaction(transaction, SESSION + 1);
      }), /one session aggregate/);
      assert.equal((await review.read(SESSION)).session.status, 'promoted');
    });
  } finally {
    await peerPool.end();
    await pool.end();
    await root.query(`DROP SCHEMA ${schema} CASCADE`);
    await root.end();
  }
});
