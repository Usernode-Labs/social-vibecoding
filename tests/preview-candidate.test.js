'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { randomUUID } = require('node:crypto');
const fs = require('node:fs');
const { Pool } = require('pg');
const { createPreviewFlow } = require('../src/services/preview-flow/store');
const { reduceCandidate } = require('../src/services/preview-flow/candidate-reducer');
const { parseAction } = require('../src/services/preview-flow/actions');
const { replayDecision } = require('../src/services/preview-flow/reducer');
const { prepareCandidatePreview } = require('../src/services/preview-flow/candidate-native');
const { candidateResources } = require('../src/services/preview-flow/candidate-resources');
const { createActivation } = require('../src/services/preview-flow/activation');
const { createCleanup, FLOW_LABEL } = require('../src/services/preview-flow/cleanup');
const bindingAdapters = require('../src/services/preview-flow/binding-adapters');
const { createGuard } = require('../src/services/build-retention-guard');
const { STAGING_BUILD_LOCK } = require('../src/services/advisory-locks');
const docker = require('../src/services/docker');
const kubernetes = require('../src/services/kubernetes');
const runtime = require('../src/services/application-runtime');

const HEAD = 'a'.repeat(40);
const databaseUrl = process.env.PREVIEW_FLOW_TEST_DATABASE_URL || process.env.SQL_CHECK_CONNECTION_URL;

function request(type, fields = {}) {
  return { type, actionId: randomUUID(), sessionId: 1, ...fields };
}

function identity(flow) {
  return { flowId: flow.id, generation: flow.generation, headSha: flow.headSha };
}

// Inject one transport error before a statement or after its server-side commit.
function failOnce(pool, predicate, after = false) {
  let failed = false;
  async function query(client, sql, params) {
    const shouldFail = !failed && predicate(String(sql), params);
    if (shouldFail) failed = true;
    if (shouldFail && !after) throw new Error('Injected persistence failure');
    const result = await client.query(sql, params);
    if (shouldFail) throw new Error('Injected lost acknowledgment');
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

test('candidate guards keep preparation, activation permission and serving observation separate', () => {
  const state = {
    session: { id: 1, source: 'cli_handoff', status: 'active', checksCommitSha: HEAD },
    flow: null,
    binding: null,
    preview: { runtimeName: 'old-serving' },
    retainedPublishedAttempts: 0,
  };
  const prepare = parseAction(request('RequestCandidatePreview', { headSha: HEAD, startedStatus: 'active' }));
  const requested = reduceCandidate(state, prepare, { newFlowId: randomUUID(), newAttemptId: randomUUID() });
  const receipt = {
    commitSha: HEAD,
    stagingUrl: 'http://candidate:3000',
    runtimeKind: 'docker',
    runtimeName: 'candidate',
    containerId: 'candidate',
    imageRef: 'image:exact',
    buildRef: null,
    attemptId: requested.flow.attemptId,
    physicalId: 'physical-container',
  };
  const preparing = { ...state, flow: requested.flow, resource: { receipt, clonePrepared: false } };
  const prepared = parseAction(request('PreviewCandidatePrepared', { ...identity(requested.flow), receipt }));
  assert.equal(reduceCandidate(preparing, prepared, {}).reason, 'clone_not_prepared');
  preparing.resource.clonePrepared = true;
  const before = structuredClone(preparing);
  const candidate = reduceCandidate(preparing, prepared, {});
  assert.deepEqual(preparing, before, 'decisions cannot mutate their captured inputs');
  assert.equal(candidate.projection, 'unchanged');
  assert.equal(candidate.effects.length, 0);

  const ready = { ...preparing, flow: candidate.flow };
  const activation = parseAction(request('RequestPreviewActivation', {
    ...identity(candidate.flow), expected: { target: 'old-serving', token: '1', uid: null },
    stagingUrl: 'https://stable.example.test',
  }));
  assert.equal(reduceCandidate({ ...ready, resource: { ...ready.resource, cleanupStarted: true } }, activation, {}).reason,
    'resource_retiring');
  const accepted = reduceCandidate(ready, activation, { newActivationId: randomUUID() });
  assert.equal(accepted.projection, 'unchanged');
  assert.equal(accepted.effects[0].type, 'ActivatePreview');
  const pending = { ...ready, flow: accepted.flow, binding: accepted.bindingChange };
  assert.equal(reduceCandidate(pending, prepare, {}).reason, 'activation_pending');
  const observation = parseAction(request('PreviewActivationObserved', {
    ...identity(candidate.flow), activationId: accepted.bindingChange.desired.activationId,
    observation: { target: 'candidate', token: '2', uid: null },
  }));
  assert.equal(reduceCandidate(pending, { ...observation, activationId: randomUUID() }, {}).reason, 'superseded_activation');
  assert.equal(reduceCandidate(pending, { ...observation, observation: { ...observation.observation, token: null } }, {}).reason,
    'binding_identity_missing');
  assert.equal(reduceCandidate(pending, observation, {}).projection, 'publish_candidate');
  assert.equal(reduceCandidate({ ...state, retainedPublishedAttempts: 2 }, prepare, {}).reason, 'consumer_retirement_required');
});

test('completed isolated cleanup authorizes another observation while frozen B1 traces keep their original result', () => {
  const flowId = randomUUID();
  const intent = candidateResources({ appRuntime: 'docker' }, 1, randomUUID());
  const state = {
    session: null,
    flow: null,
    preview: null,
    binding: null,
    resource: {
      flowId,
      sessionId: 1,
      intent,
      receipt: null,
      published: false,
      cleanupStarted: true,
      cleanupCompleted: true,
      disposition: 'removed',
    },
  };
  const action = parseAction(request('RequestPreviewCleanup', { flowId }));
  const before = structuredClone(state);
  const decision = reduceCandidate(state, action, {});
  assert.deepEqual(state, before);
  assert.equal(decision.reason, 'cleanup_reconciliation_requested');
  assert.deepEqual(decision.resourceChange, { flowId, cleanup: 'reconcile' });
  assert.equal(decision.effects[0].type, 'CleanupPreview');
  assert.equal(decision.effects[0].effectKey, `${flowId}:cleanup:${action.actionId}`);
  assert.deepEqual(reduceCandidate(state, action, {}), decision, 'replaying a request retains its effect identity');
  const next = reduceCandidate(state, { ...action, actionId: randomUUID() }, {});
  assert.notEqual(next.effects[0].effectKey, decision.effects[0].effectKey, 'a later observation is new work');

  assert.deepEqual(replayDecision({ reducer_version: 3, pre_state: state, action, facts: {} }), {
    accepted: true,
    reason: 'cleanup_already_completed',
    flow: null,
    projection: 'unchanged',
    disposition: 'removed',
    effects: [],
  });
  assert.deepEqual(replayDecision({ reducer_version: 4, pre_state: state, action, facts: {} }), decision,
    'the frozen delayed-creation policy keeps its original reconciliation decision');
  assert.equal(reduceCandidate(state, { ...action, flowId: randomUUID() }, {}).reason, 'resource_missing');
  assert.equal(reduceCandidate({ ...state, binding: { desired: { attemptId: intent.attemptId } } }, action, {}).reason,
    'resource_bound');
  assert.equal(reduceCandidate({ ...state, resource: { ...state.resource, published: true } }, action, {}).reason,
    'consumer_retirement_required');
  const legacy = { ...state, resource: { ...state.resource, intent: { ...intent, attemptId: undefined } } };
  assert.equal(reduceCandidate(legacy, action, {}).reason, 'cleanup_already_completed');
});

test('native isolated candidates and activation recovery on real PostgreSQL', { skip: !databaseUrl }, async t => {
  const root = new Pool({ connectionString: databaseUrl });
  const schema = `preview_candidate_test_${process.pid}`;
  await root.query(`CREATE SCHEMA ${schema}`);
  const scoped = new URL(databaseUrl);
  scoped.searchParams.set('options', `-c search_path=${schema}`);
  const pool = new Pool({ connectionString: scoped.toString(), max: 8 });
  try {
    await pool.query(`CREATE TABLE apps (id INTEGER PRIMARY KEY, slug TEXT);
      INSERT INTO apps VALUES (1, 'demo');
      CREATE TABLE chat_sessions (id INTEGER PRIMARY KEY, app_id INTEGER, status TEXT,
        source TEXT, checks_commit_sha TEXT, reviewed_head_sha TEXT, staging_url TEXT,
        staging_container_id TEXT, staging_runtime_kind TEXT, staging_runtime_name TEXT,
        staging_image_ref TEXT, staging_build_ref TEXT, staging_commit_sha TEXT, last_activity_at TIMESTAMPTZ)`);
    const source = fs.readFileSync(require.resolve('../src/db/schema.sql'), 'utf8');
    const tables = ['preview_flows', 'preview_bindings', 'preview_flow_heads', 'preview_flow_resources',
      'preview_action_receipts', 'preview_flow_decisions', 'execution_work_requests', 'cli_preview_handoffs'];
    for (const table of tables) {
      await pool.query(source.match(new RegExp(`CREATE TABLE IF NOT EXISTS ${table} \\([\\s\\S]*?\\n\\);`))[0]);
    }

    const migration = source.match(/ALTER TABLE preview_flows ADD COLUMN IF NOT EXISTS attempt_id UUID;[\s\S]*?CHECK \(state IN \([^;]*;/)[0];
    await pool.query(migration);
    await pool.query(migration);

    // Upgrade the earlier pending-only queue index, then replay boot migration.
    await pool.query(`CREATE INDEX preview_flow_resources_pending_queue_idx
      ON preview_flow_resources (cleanup_queue_position)
      WHERE cleanup_completed_at IS NULL AND intent IS NOT NULL`);
    const recoveryIndexMigration = source.match(/DROP INDEX IF EXISTS preview_flow_resources_pending_queue_idx;[\s\S]*?CREATE INDEX IF NOT EXISTS preview_flow_resources_recovery_queue_idx[\s\S]*?;/)[0];
    await pool.query(recoveryIndexMigration);
    await pool.query(recoveryIndexMigration);

    for (const runtimeKind of ['docker', 'kubernetes']) {
      await t.test(runtimeKind, async t => {
        const config = {
          nativePreviewAttempts: true,
          appRuntime: runtimeKind,
          dataEncryptionKey: '1'.repeat(64),
          databaseUrl: scoped.toString(),
          kubernetes: { appNamespace: 'apps', appDomain: 'preview.example.test' },
        };
        const app = { id: 1, slug: 'demo' };
        const session = { id: 1, app_id: 1, status: 'active', source: 'cli_handoff' };
        const owner = createPreviewFlow(pool);
        const guard = createGuard();
        // Advisory locks are database-wide, whereas fixture tables are scoped
        // by schema. Give this fixture's resources the same scope so concurrent
        // test files cannot make a sweep skip their unrelated session 1.
        const withResourceUse = (runtimeConfig, kind, sessionId, run, options) =>
          guard.withResourceUse(runtimeConfig, kind, `${schema}:${sessionId}`, run, options);
        const resources = new Map();
        const clones = new Set();
        const imageTags = new Set();
        const checkouts = new Set();
        let serving;
        let mutations;
        let routeError;
        let beforeConsumer;
        let duringPreparation;

        const routes = {
          inspect: async () => ({ ...serving }),
          activate: async (_config, _ref, expected, receipt) => {
            assert.deepEqual(serving, expected, 'conditional route update checks its captured predecessor');
            mutations++;
            serving = { target: receipt.runtimeName, token: String(mutations), uid: runtimeKind === 'docker' ? null : 'ingress-uid' };
            if (routeError) throw routeError;
          },
        };
        const activation = createActivation({ routes, lock: withResourceUse, verify: async (_config, intent, flowId, receipt) => {
          assert.equal(resources.get(intent.runtimeName)?.uid, receipt.physicalId);
          assert.equal(resources.get(intent.runtimeName)?.flowId, flowId);
        } });
        t.mock.method(require('../src/services/preview-flow/activation'), 'recover', activation.recover);
        t.mock.method(bindingAdapters, 'inspect', routes.inspect);
        t.mock.method(docker, 'execFileAsync', async (command, args) => {
          if (command === 'rm') {
            checkouts.delete(args.at(-1));
            return { stdout: '' };
          }
          if (args[0] === 'image') {
            imageTags.delete(args.at(-1));
            return { stdout: '' };
          }
          const object = resources.get(args.at(-1));
          if (!object) throw new Error('No such container');
          return { stdout: JSON.stringify({ Id: object.uid, Config: { Labels: { [FLOW_LABEL]: object.flowId } } }) };
        });
        t.mock.method(docker, 'stopAndRemove', async uid => {
          const entry = [...resources].find(([, value]) => value.uid === uid);
          assert.ok(entry, 'Docker removal uses an immutable physical identity');
          resources.delete(entry[0]);
          return { removed: true };
        });
        const core = {};
        const apps = {};
        for (const [api, kind] of [[apps, 'Deployment'], [core, 'Service'], [core, 'Secret']]) {
          api[`readNamespaced${kind}`] = async ({ name }) => {
            const object = resources.get(name.replace(/-env$/, ''));
            if (!object) throw Object.assign(new Error('Not found'), { code: 404 });
            return { metadata: { uid: `${object.uid}${kind === 'Deployment' ? '' : kind}`, labels: { [FLOW_LABEL]: object.flowId } } };
          };
          api[`deleteNamespaced${kind}`] = async ({ name, body }) => {
            const object = await api[`readNamespaced${kind}`]({ name });
            assert.equal(body.preconditions.uid, object.metadata.uid);
            if (kind === 'Deployment') resources.delete(name);
          };
        }
        core.listNamespacedPod = async () => ({ items: [] });
        t.mock.method(kubernetes, '_getClients', () => ({ core, apps }));
        const cleanup = createCleanup({
          lock: withResourceUse,
          db: { dropDatabase: async (name, options) => {
            assert.equal(options.strict, true);
            clones.delete(name);
          } },
        });

        async function reset() {
          await pool.query(`TRUNCATE chat_sessions, ${tables.join(', ')} CASCADE`);
          await pool.query(`INSERT INTO chat_sessions (id, app_id, status, source, checks_commit_sha,
            staging_url, staging_runtime_name, staging_commit_sha)
            VALUES (1, 1, 'active', 'cli_handoff', $1, 'https://old.example.test', 'old-serving', $1)`, [HEAD]);
          resources.clear();
          clones.clear();
          imageTags.clear();
          checkouts.clear();
          resources.set('old-serving', { uid: 'old-physical', flowId: 'old-owner' });
          clones.add('old-clone');
          serving = { target: 'old-serving', token: '0', uid: runtimeKind === 'docker' ? null : 'ingress-uid' };
          mutations = 0;
          routeError = null;
          beforeConsumer = null;
          duringPreparation = null;
        }

        async function build(_config, _session, _app, head, options) {
          return withResourceUse(config, STAGING_BUILD_LOCK, 1, async () => {
            const intent = options.candidate.intent;
            await options.beforeBuild(intent);
            assert.equal((await owner.read(1)).preview.runtimeName, serving.target);
            clones.add(intent.dbName);
            if (duringPreparation) await duringPreparation(options);
            await options.candidate.onClonePrepared();
            const uid = randomUUID();
            resources.set(intent.runtimeName, { uid, flowId: options.previewFlow.flowId });
            if (beforeConsumer) await beforeConsumer(options);
            await options.consumePrepared({
              commitSha: head,
              stagingUrl: `http://${intent.runtimeName}:3000`,
              runtimeKind,
              runtimeName: intent.runtimeName,
              containerId: runtimeKind === 'docker' ? intent.runtimeName : null,
              imageRef: `image:${intent.attemptId}`,
              buildRef: runtimeKind === 'docker' ? null : `build/${intent.attemptId}`,
              physicalId: uid,
            });
          }, { allRuntimes: true });
        }

        function prepare(flowPool = pool, activate = activation.underBuildLock) {
          return prepareCandidatePreview({ pool: flowPool, config, session, app, headSha: HEAD,
            build, cleanup: cleanup.underBuildLock, activate });
        }

        await t.test('attempt identity is unique after replayed boot migration', async () => {
          await reset();
          const admission = await owner.apply(request('RequestCandidatePreview', { headSha: HEAD, startedStatus: 'active' }));
          await assert.rejects(pool.query(`INSERT INTO preview_flows
            (id, session_id, generation, head_sha, started_status, state, attempt_id)
            VALUES ($1, 1, 2, $2, 'active', 'preparing', $3)`,
          [randomUUID(), HEAD, admission.decision.flow.attemptId]), { code: '23505' });
        });

        await t.test('same-SHA attempts isolate preparation, authorize activation and preserve old consumers', async () => {
          await reset();
          const first = await prepare();
          assert.equal(first.accepted, true);
          const firstState = await owner.read(1);
          const firstResource = firstState.resource.intent;
          duringPreparation = async () => {
            assert.equal(serving.target, first.result.runtimeName);
            assert.equal((await owner.read(1)).preview.runtimeName, first.result.runtimeName);
            assert.ok(resources.has(first.result.runtimeName));
            assert.ok(clones.has(firstResource.dbName));
          };
          const second = await prepare();
          const secondState = await owner.read(1);
          assert.notEqual(secondState.flow.attemptId, firstState.flow.attemptId);
          for (const field of ['runtimeName', 'dbName', 'checkoutDir', 'imageName']) {
            assert.notEqual(secondState.resource.intent[field], firstResource[field]);
          }
          assert.equal((await owner.apply(request('RetryPreview', { headSha: HEAD, startedStatus: 'active' }))).decision.reason,
            'isolated_activation_required');
          assert.equal(serving.target, second.result.runtimeName);
          assert.equal(secondState.preview.runtimeName, serving.target);
          assert.equal((await cleanup.underBuildLock({ pool, config, sessionId: 1, flowId: first.identity.flowId })).protected, true);
          assert.ok(resources.has(first.result.runtimeName), 'untracked consumers retain their prior attempt');
          const stale = await owner.apply(request('PreviewActivationObserved', {
            ...first.identity,
            activationId: firstState.binding.desired.activationId,
            observation: firstState.binding.observed.route,
          }));
          assert.equal(stale.decision.reason, 'superseded_activation');
          assert.equal((await owner.read(1)).preview.runtimeName, second.result.runtimeName);
          const bounded = await prepare();
          assert.equal(bounded.reason, 'consumer_retirement_required');
          assert.equal(resources.size, 3, 'only original, predecessor and serving runtime exist');
          assert.equal((await owner.read(1)).preview.runtimeName, second.result.runtimeName);
          for (const entry of await owner.trace(1)) assert.deepEqual(replayDecision(entry), entry.decision);
          assert.ok(!(JSON.stringify(await owner.trace(1))).includes('clone_credential_enc'));
          assert.ok((await pool.query('SELECT clone_credential_enc FROM preview_flow_resources')).rows.every(row => row.clone_credential_enc));
        });

        for (const after of [false, true]) {
          await t.test(`runtime receipt ${after ? 'lost acknowledgment' : 'persistence failure'} cleans only candidate`, async () => {
            await reset();
            const faulty = failOnce(pool, sql => sql.startsWith('INSERT INTO preview_flow_resources') && sql.includes('receipt)'), after);
            await assert.rejects(prepare(faulty), /Injected/);
            assert.deepEqual([...resources.keys()], ['old-serving']);
            assert.deepEqual([...clones], ['old-clone']);
            assert.equal((await owner.read(1)).preview.runtimeName, 'old-serving');
            assert.equal(mutations, 0);
            assert.ok((await pool.query('SELECT cleanup_completed_at FROM preview_flow_resources')).rows[0].cleanup_completed_at);
          });
        }

        await t.test('reported preparation failure retains the accepted serving tuple', async () => {
          await reset();
          const admission = await owner.apply(request('RequestCandidatePreview', { headSha: HEAD, startedStatus: 'active' }));
          const failureOwner = createPreviewFlow(pool, { persistFailure: async () => true });
          const failed = await failureOwner.apply(request('PreparationFailed', {
            ...identity(admission.decision.flow), detail: 'Candidate build failed',
          }));
          assert.equal(failed.decision.accepted, true);
          assert.equal(failed.current.flow.state, 'failed');
          assert.equal(failed.current.preview.runtimeName, 'old-serving');
          assert.equal(serving.target, 'old-serving');
        });

        await t.test('publication rejected after head change removes the unused candidate', async () => {
          await reset();
          beforeConsumer = () => pool.query("UPDATE chat_sessions SET checks_commit_sha = $1 WHERE id = 1", ['b'.repeat(40)]);
          const result = await prepare();
          assert.equal(result.accepted, false);
          assert.equal(mutations, 0);
          assert.deepEqual([...resources.keys()], ['old-serving']);
          assert.deepEqual([...clones], ['old-clone']);
          assert.equal((await owner.read(1)).preview.runtimeName, 'old-serving');
        });

        await t.test('activation intent transaction failure cleans candidate and leaves serving state unchanged', async () => {
          await reset();
          const faulty = failOnce(pool, sql => sql.startsWith('INSERT INTO preview_bindings'));
          const faultyActivation = createActivation({ routes, verify: async () => {} });
          await assert.rejects(prepare(pool, args => faultyActivation.underBuildLock({ ...args, pool: faulty })), /Injected/);
          assert.deepEqual([...resources.keys()], ['old-serving']);
          assert.equal(mutations, 0);
          assert.equal((await owner.read(1)).binding, null);
        });

        for (const boundary of ['intent-commit', 'route-ack', 'observation-commit']) {
          await t.test(`recover ${boundary} loss without overwriting serving resources`, async () => {
            await reset();
            let intentInserted = false;
            let observedInserted = false;
            const faulty = failOnce(pool, (sql, params) => {
              if (sql.startsWith('INSERT INTO preview_bindings')) {
                intentInserted = true;
                observedInserted = JSON.parse(params[2]) !== null;
              }
              return sql === 'COMMIT' && (boundary === 'intent-commit'
                ? intentInserted && !observedInserted
                : boundary === 'observation-commit' && observedInserted);
            }, true);
            if (boundary === 'route-ack') routeError = new Error('Injected route acknowledgment loss');
            const faultyActivation = createActivation({ routes, verify: async () => {} });
            await assert.rejects(prepare(pool, args => faultyActivation.underBuildLock({ ...args, pool: faulty })), /Injected/);
            const unresolved = await owner.read(1);
            assert.ok(resources.has(unresolved.resource.intent.runtimeName));
            assert.ok(resources.has('old-serving'));
            routeError = null;
            await cleanup.sweep({ pool, config: { ...config, nativePreviewAttempts: false } });
            const settled = await owner.read(1);
            assert.equal(settled.preview.runtimeName, settled.resource.intent.runtimeName);
            assert.equal(settled.binding.observed.activationId, settled.binding.desired.activationId);
            assert.equal(mutations, 1, 'a recovered acknowledgment never repeats the route mutation');
          });
        }

        await t.test('ambiguous activation stays pending, blocks successors, and remains retryable', async () => {
          await reset();
          const blockedRoutes = { ...routes, activate: async () => { throw new Error('Route transport unavailable'); } };
          const blocked = createActivation({ routes: blockedRoutes, verify: async () => {} });
          await assert.rejects(prepare(pool, blocked.underBuildLock), /transport/);
          const pending = await owner.read(1);
          assert.equal((await prepare()).reason, 'activation_pending');
          assert.equal((await cleanup.underBuildLock({ pool, config, sessionId: 1, flowId: pending.flow.id })).protected, true);
          serving = { ...serving, token: 'changed-outside-flow' };
          assert.equal((await activation.recover({ pool, config }))[0].pending, true);
          assert.equal(mutations, 0);
          serving = pending.binding.desired.expected;
          await activation.recover({ pool, config });
          assert.equal(mutations, 1);
        });

        await t.test('historical candidate cleanup consumes its own receipt after a successor publishes', async () => {
          await reset();
          const candidate = await prepare(pool, async () => ({ accepted: true, reason: 'test-candidate-only' }));
          const historical = await owner.read(1);
          const successor = await prepare();
          assert.equal(successor.accepted, true);
          await cleanup.underBuildLock({ pool, config, sessionId: 1, flowId: candidate.identity.flowId });
          assert.equal(resources.has(candidate.result.runtimeName), false);
          assert.equal(clones.has(historical.resource.intent.dbName), false);
          assert.equal(serving.target, successor.result.runtimeName);
          assert.ok(resources.has(successor.result.runtimeName));
        });

        if (runtimeKind === 'kubernetes') {
          await t.test('clone cleanup waits for confirmed Pod termination and retries interrupted observation', async () => {
            await reset();
            const candidate = await prepare(pool, async () => ({ accepted: true, reason: 'test-candidate-only' }));
            const historical = await owner.read(1);
            const originalList = core.listNamespacedPod;
            core.listNamespacedPod = async () => { throw new Error('Pod termination is unconfirmed'); };
            await assert.rejects(cleanup.underBuildLock({ pool, config, sessionId: 1, flowId: candidate.identity.flowId }), /unconfirmed/);
            assert.ok(clones.has(historical.resource.intent.dbName));
            assert.equal((await owner.read(1)).resource.cleanupCompleted, false);
            core.listNamespacedPod = originalList;
            await cleanup.underBuildLock({ pool, config, sessionId: 1, flowId: candidate.identity.flowId });
            assert.equal(clones.has(historical.resource.intent.dbName), false);
            assert.equal((await owner.read(1)).resource.cleanupCompleted, true);
          });
        }

        await t.test('activation recovery rotates a busy oldest batch and retains interrupted attempts', async () => {
          await reset();
          await pool.query(`TRUNCATE chat_sessions, ${tables.join(', ')} CASCADE`);
          for (let sessionId = 1; sessionId <= 31; sessionId++) {
            await pool.query(`INSERT INTO chat_sessions (id, app_id, status, source, checks_commit_sha)
              VALUES ($1, 1, 'active', 'cli_handoff', $2)`, [sessionId, HEAD]);
            const admission = await owner.apply({ ...request('RequestCandidatePreview', {
              headSha: HEAD, startedStatus: 'active',
            }), sessionId });
            const flow = admission.decision.flow;
            const intent = candidateResources(config, sessionId, flow.attemptId);
            await owner.recordIntent(sessionId, flow.id, intent, { credentialEnc: 'encrypted' });
            await owner.markClonePrepared(sessionId, flow.id);
            const receipt = await owner.recordRuntime(sessionId, flow.id, {
              runtimeKind,
              runtimeName: intent.runtimeName,
              attemptId: intent.attemptId,
              commitSha: HEAD,
              stagingUrl: `http://${intent.runtimeName}:3000`,
              containerId: runtimeKind === 'docker' ? intent.runtimeName : null,
              imageRef: 'image:exact',
              buildRef: null,
              physicalId: randomUUID(),
            });
            await owner.apply({ ...request('PreviewCandidatePrepared', { ...identity(flow), receipt }), sessionId });
            await owner.apply({ ...request('RequestPreviewActivation', {
              ...identity(flow),
              expected: { target: 'old-serving', token: '0', uid: null },
              stagingUrl: `https://${bindingAdapters.bindingRef(config, app, sessionId).hostname}`,
            }), sessionId });
          }
          const attempted = [];
          const recovery = createActivation({
            verify: async () => {},
            routes: { inspect: async () => { throw new Error('Transport failure remains retryable'); } },
            lock: async (_config, _kind, sessionId, run) => {
              attempted.push(sessionId);
              if (sessionId <= 25) return { skipped: true, busy: true };
              return run();
            },
          });
          await recovery.recover({ pool, config, limit: 25 });
          assert.ok(attempted.every(id => id <= 25));
          attempted.length = 0;
          await recovery.recover({ pool, config, limit: 25 });
          assert.ok([26, 27, 28, 29, 30, 31].every(id => attempted.includes(id)));
          await recovery.recover({ pool, config, limit: 25 });
          assert.ok(attempted.includes(1), 'the first batch remains eligible for later retries');
          const pending = await pool.query(`SELECT COUNT(*) FROM preview_bindings
            WHERE desired->>'activationId' IS DISTINCT FROM observed->>'activationId'`);
          assert.equal(Number(pending.rows[0].count), 31);
        });

        for (const protection of ['external-binding', 'flow-owner', 'physical-identity']) {
          await t.test(`reconciliation rechecks ${protection} before removing a reappeared runtime or clone`, async () => {
            await reset();
            const candidate = await prepare(pool, async () => ({ accepted: true, reason: 'test-candidate-only' }));
            const historical = await owner.read(1);
            const intent = historical.resource.intent;
            const receipt = historical.resource.receipt;
            await cleanup.sweep({ pool, config });
            assert.equal(resources.has(intent.runtimeName), false);

            resources.set(intent.runtimeName, {
              uid: protection === 'physical-identity' ? 'replacement-physical-id' : receipt.physicalId,
              flowId: protection === 'flow-owner' ? randomUUID() : candidate.identity.flowId,
            });
            clones.add(intent.dbName);
            if (protection === 'external-binding') serving = { ...serving, target: intent.runtimeName };
            assert.deepEqual(await cleanup.sweep({ pool, config }), [{ pending: true }]);
            assert.ok(resources.has(intent.runtimeName), 'changed ownership cannot authorize deletion');
            assert.ok(clones.has(intent.dbName), 'a potentially live consumer protects the clone too');
            assert.equal((await owner.read(1)).resource.cleanupCompleted, false);

            serving = { ...serving, target: 'old-serving' };
            resources.set(intent.runtimeName, { uid: receipt.physicalId, flowId: candidate.identity.flowId });
            await cleanup.sweep({ pool, config });
            assert.equal(resources.has(intent.runtimeName), false);
            assert.equal(clones.has(intent.dbName), false);
            assert.ok(resources.has('old-serving'));
          });
        }

        for (const boundary of ['authorization', 'authorization-commit-ack', 'completion']) {
          await t.test(`retired attempt reconciliation survives ${boundary} failure`, async () => {
            await reset();
            const admission = await owner.apply(request('RequestCandidatePreview', {
              headSha: HEAD,
              startedStatus: 'active',
            }));
            const flow = admission.decision.flow;
            const intent = candidateResources(config, 1, flow.attemptId);
            await owner.recordIntent(1, flow.id, intent, { credentialEnc: 'encrypted-reservation' });
            await cleanup.sweep({ pool, config });
            resources.set(intent.runtimeName, { uid: randomUUID(), flowId: flow.id });
            clones.add(intent.dbName);

            const actionType = boundary === 'completion' ? 'PreviewCleanupCompleted' : 'RequestPreviewCleanup';
            let authorizationInserted = false;
            const faulty = failOnce(pool, (sql, params) => {
              const matchingTrace = sql.startsWith('INSERT INTO preview_flow_decisions')
                && JSON.parse(params[4]).type === actionType;
              if (matchingTrace) authorizationInserted = true;
              return boundary === 'authorization-commit-ack'
                ? sql === 'COMMIT' && authorizationInserted
                : matchingTrace;
            }, boundary === 'authorization-commit-ack');
            const result = await cleanup.sweep({ pool: faulty, config });
            assert.deepEqual(result, [{ pending: true }]);
            const resource = (await pool.query('SELECT * FROM preview_flow_resources WHERE flow_id = $1', [flow.id])).rows[0];
            assert.equal(!!resource.cleanup_completed_at, boundary === 'authorization',
              'a committed reconciliation stays pending after acknowledgment loss');
            assert.equal(resources.has(intent.runtimeName), boundary !== 'completion');
            assert.equal(clones.has(intent.dbName), boundary !== 'completion');

            await cleanup.sweep({ pool, config });
            assert.equal(resources.has(intent.runtimeName), false);
            assert.equal(clones.has(intent.dbName), false);
            assert.ok((await pool.query('SELECT cleanup_completed_at FROM preview_flow_resources WHERE flow_id = $1', [flow.id]))
              .rows[0].cleanup_completed_at);
            assert.equal(serving.target, 'old-serving');
          });
        }

        for (const blockage of ['busy', 'failing']) {
          await t.test(`completed tombstones rotate fairly while the oldest batch stays ${blockage}`, async () => {
            await reset();
            const entries = [];
            for (let sessionId = 2; sessionId <= 32; sessionId++) {
              await pool.query(`INSERT INTO chat_sessions (id, app_id, status, source, checks_commit_sha)
                VALUES ($1, 1, 'active', 'cli_handoff', $2)`, [sessionId, HEAD]);
              const admission = await owner.apply({ ...request('RequestCandidatePreview', {
                headSha: HEAD,
                startedStatus: 'active',
              }), sessionId });
              const flow = admission.decision.flow;
              const intent = candidateResources(config, sessionId, flow.attemptId);
              entries.push({ sessionId, flowId: flow.id, intent });
              await owner.recordIntent(sessionId, flow.id, intent, { credentialEnc: 'encrypted-reservation' });
            }
            await cleanup.sweep({ pool, config, limit: 100 });
            const completed = (await pool.query(`SELECT session_id, cleanup_completed_at FROM preview_flow_resources
              ORDER BY cleanup_queue_position`)).rows;
            assert.equal(completed.length, 31);
            assert.ok(completed.every(row => row.cleanup_completed_at));
            const oldest = new Set(completed.slice(0, 25).map(row => row.session_id));
            const oldClones = new Set(entries.filter(entry => oldest.has(entry.sessionId)).map(entry => entry.intent.dbName));
            for (const entry of entries) {
              resources.set(entry.intent.runtimeName, { uid: randomUUID(), flowId: entry.flowId });
              clones.add(entry.intent.dbName);
            }

            let blocked = true;
            const attempted = [];
            const fairCleanup = createCleanup({
              lock: async (runtimeConfig, kind, sessionId, run, options) => {
                attempted.push(sessionId);
                if (blocked && blockage === 'busy' && oldest.has(sessionId)) return { skipped: true, busy: true };
                return withResourceUse(runtimeConfig, kind, sessionId, run, options);
              },
              db: { dropDatabase: async name => {
                if (blocked && blockage === 'failing' && oldClones.has(name)) throw new Error('Clone drop remains unavailable');
                clones.delete(name);
              } },
            });
            const first = await fairCleanup.sweep({ pool, config });
            assert.equal(first.length, 25);
            assert.ok(first.every(result => blockage === 'busy' ? result.busy : result.pending));
            attempted.length = 0;
            await fairCleanup.sweep({ pool, config });
            const later = entries.filter(entry => !oldest.has(entry.sessionId));
            assert.equal(later.length, 6);
            assert.ok(later.every(entry => attempted.includes(entry.sessionId)));
            assert.ok(later.every(entry => !resources.has(entry.intent.runtimeName) && !clones.has(entry.intent.dbName)));
            assert.ok(entries.filter(entry => oldest.has(entry.sessionId)).every(entry => clones.has(entry.intent.dbName)),
              'older obligations remain recoverable');

            blocked = false;
            await fairCleanup.sweep({ pool, config, limit: 100 });
            assert.deepEqual([...clones], ['old-clone']);
            assert.deepEqual([...resources.keys()], ['old-serving']);
          });
        }

        if (runtimeKind === 'kubernetes') {
          await t.test('successive delayed Secret, Service and Deployment creation reopens the same tombstone', async t => {
            await reset();
            const admission = await owner.apply(request('RequestCandidatePreview', {
              headSha: HEAD,
              startedStatus: 'active',
            }));
            const flow = admission.decision.flow;
            const intent = candidateResources(config, 1, flow.attemptId);
            await owner.recordIntent(1, flow.id, intent, { credentialEnc: 'encrypted-reservation' });
            const objects = new Map();
            const deleted = [];
            for (const [api, kind] of [[apps, 'Deployment'], [core, 'Service'], [core, 'Secret']]) {
              t.mock.method(api, `readNamespaced${kind}`, async () => {
                if (!objects.has(kind)) throw Object.assign(new Error('Not found'), { code: 404 });
                return objects.get(kind);
              });
              t.mock.method(api, `deleteNamespaced${kind}`, async ({ body }) => {
                assert.equal(body.preconditions.uid, objects.get(kind).metadata.uid);
                objects.delete(kind);
                deleted.push(kind);
              });
            }
            await cleanup.sweep({ pool, config });
            for (const kind of ['Secret', 'Service', 'Deployment']) {
              // Each API create finishes after a different successful absence
              // observation. A single extra scan or grace period is insufficient.
              objects.set(kind, { metadata: { uid: randomUUID(), labels: { [FLOW_LABEL]: flow.id } } });
              clones.add(intent.dbName);
              await cleanup.sweep({ pool, config });
              assert.equal(objects.size, 0);
              assert.equal(clones.has(intent.dbName), false);
              assert.equal(deleted.at(-1), kind);
            }
            assert.deepEqual(deleted, ['Secret', 'Service', 'Deployment']);
            assert.ok(resources.has('old-serving'));
          });
        }

        for (const deleteSession of [false, true]) {
          await t.test(`late external creation is reconciled after absence${deleteSession ? ' and session deletion' : ' and successor activation'}`, async () => {
            await reset();
            const admission = await owner.apply(request('RequestCandidatePreview', {
              headSha: HEAD,
              startedStatus: 'active',
            }));
            const flow = admission.decision.flow;
            const intent = candidateResources(config, 1, flow.attemptId);
            await owner.recordIntent(1, flow.id, intent, { credentialEnc: 'encrypted-reservation' });

            // The external system accepted creation, but the requesting process
            // died before acknowledgment. Its resource lock no longer proves
            // that the external operation ended. Control completion explicitly.
            let finishCreation;
            const externalCreation = new Promise(resolve => { finishCreation = resolve; }).then(() => {
              clones.add(intent.dbName);
              checkouts.add(intent.checkoutDir);
              if (runtimeKind === 'docker') imageTags.add(intent.imageName);
              resources.set(intent.runtimeName, { uid: randomUUID(), flowId: flow.id });
            });

            if (deleteSession) await pool.query('DELETE FROM chat_sessions WHERE id = 1');
            await cleanup.sweep({ pool, config });
            const absent = (await pool.query('SELECT * FROM preview_flow_resources WHERE flow_id = $1', [flow.id])).rows[0];
            assert.ok(absent.cleanup_completed_at, 'first pass reports observed absence');
            assert.equal(resources.has(intent.runtimeName), false);

            const successor = deleteSession ? null : await prepare();
            finishCreation();
            await externalCreation;
            assert.ok(resources.has(intent.runtimeName), 'external creation completes after cleanup settled');
            assert.ok(clones.has(intent.dbName));

            await cleanup.sweep({ pool, config: { ...config, nativePreviewAttempts: false } });
            assert.equal(resources.has(intent.runtimeName), false, 'retired attempt remains discoverable');
            assert.equal(clones.has(intent.dbName), false, 'late clone belongs to the same cleanup tombstone');
            assert.equal(checkouts.has(intent.checkoutDir), false);
            assert.equal(imageTags.has(intent.imageName), false);
            assert.ok(resources.has('old-serving'));
            if (successor) {
              assert.equal(serving.target, successor.result.runtimeName);
              assert.ok(resources.has(successor.result.runtimeName));
              assert.equal((await owner.read(1)).preview.runtimeName, successor.result.runtimeName);
            }
            const decisions = await owner.trace(1);
            assert.ok(decisions.some(entry => entry.decision.reason === 'cleanup_reconciliation_requested'));
            for (const entry of decisions) assert.deepEqual(replayDecision(entry), entry.decision);
          });
        }

        await t.test('interrupted preparation is abandoned rather than adopted from clone existence', async () => {
          await reset();
          const admission = await owner.apply(request('RequestCandidatePreview', { headSha: HEAD, startedStatus: 'active' }));
          const flow = admission.decision.flow;
          const intent = candidateResources(config, 1, flow.attemptId);
          await owner.recordIntent(1, flow.id, intent, { credentialEnc: 'encrypted-reservation' });
          clones.add(intent.dbName);
          await cleanup.sweep({ pool, config });
          assert.equal(clones.has(intent.dbName), false);
          assert.equal((await owner.read(1)).resource.clonePrepared, false);
          assert.equal((await owner.read(1)).preview.runtimeName, 'old-serving');
          const next = await prepare();
          assert.equal(next.accepted, true);
          assert.notEqual((await owner.read(1)).resource.intent.dbName, intent.dbName);
        });
      });
    }
  } finally {
    await pool.end();
    await root.query(`DROP SCHEMA ${schema} CASCADE`);
    await root.end();
  }
});
