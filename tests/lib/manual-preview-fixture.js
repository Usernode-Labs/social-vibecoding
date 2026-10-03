'use strict';

const assert = require('node:assert/strict');
const { randomUUID } = require('node:crypto');
const { readPreviewPostgresFixture } = require('./preview-postgres-fixture');
const { createExecutionDatabase } = require('./execution-database');
const { addHandoffColumns } = require('./cli-handoff-fixture');
const { createCliHandoffWork, CONTINUE } = require('../../src/services/cli-preview-handoff/work');
const { PREPARE_RUNTIME } = require('../../src/services/preview-flow/work');
const { selectRuntime } = require('../../src/services/preview-flow/runtime-intent');
const { createExecutionWorker } = require('../../src/services/execution/worker');
const { createPreviewFlow } = require('../../src/services/preview-flow/store');
const HEAD = 'a'.repeat(40);

async function fixture(t, { native = false } = {}) {
  const selected = await readPreviewPostgresFixture();
  const db = await createExecutionDatabase(selected.databaseUrl);
  await addHandoffColumns(db.pool);
  await db.pool.query(`ALTER TABLE apps ADD COLUMN name TEXT,
      ADD COLUMN runtime_name TEXT, ADD COLUMN runtime_kind TEXT;
    ALTER TABLE chat_sessions ADD COLUMN imported_pr_head_sha TEXT, ADD COLUMN shared_at TIMESTAMPTZ`);
  await db.pool.query(`INSERT INTO chat_sessions (id, handoff_uploaded_sha, checks_commit_sha)
    VALUES (1,$1,$1)`, [HEAD]);
  if (native) await db.pool.query("UPDATE chat_sessions SET source = 'native', handoff_uploaded_sha = NULL WHERE id = 1");
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
    nativeCliPreviewHandoffEnabled: !native,
    nativeManualPreviewEnabled: native,
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
        expected: state.binding?.observed?.route || { target: null, uid: null, token: null },
        stagingUrl: 'https://preview.fixture.invalid',
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
      await require('../../src/services/visuals').storeChecks(db.pool, session.id, head, { state: 'passing', results: [] });
    },
    warm: async () => {}, notify: () => {}, ...extra,
  });
  const session = async () => (await db.pool.query('SELECT * FROM chat_sessions WHERE id = 1')).rows[0];
  return { ...db, owner, config, make, session, creates: () => creates };
}

async function candidate(f, work, admitted, beforeCommit = null, expectedAccepted = true) {
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
  assert.equal((await work.store.read(admitted.work.id)).result.accepted, expectedAccepted);
}

async function tick(work) {
  const worker = createExecutionWorker({ store: work.store, handlers: { [CONTINUE]: work.handlers[CONTINUE] }, concurrency: 1 });
  await worker.tick();
  await worker.drain();
}

async function manualServer(t, f, work, { branchHead = null, rebuildMissing = true } = {}) {
  const express = require('express');
  t.mock.method(require('../../src/services/application-runtime'), 'probeHealth', async () => true);
  t.mock.method(require('../../src/services/staging'), 'verifyStagingEdge', async () => ({ ok: true, code: 200 }));
  const poolModule = require('../../src/db/pool');
  const handoff = require('../../src/services/cli-preview-handoff/work');
  const visuals = require('../../src/services/visuals');
  const staging = require('../../src/services/staging');
  const routePath = require.resolve('../../src/routes/sessions');
  const cachedRoute = require.cache[routePath];

  t.mock.method(poolModule, 'getPool', () => f.pool);
  t.mock.method(require('../../src/services/app-access'), 'sessionCollabGuard', () => (_req, _res, next) => next());
  t.mock.method(handoff, 'createCliHandoffWork', () => work);
  const github = require('../../src/services/github');
  t.mock.method(github, 'isEnabled', () => branchHead ? true : assert.fail('Enrolled manual requests must use the accepted head'));
  if (branchHead) t.mock.method(github, 'getInstallationOctokit', async () => ({
    request: async () => ({ data: { object: { sha: typeof branchHead === 'function' ? branchHead() : branchHead } } }),
  }));
  t.mock.method(staging, 'buildAndDeployStaging', async () => assert.fail('Competing web builder'));
  t.mock.method(staging, 'hasInFlightBuild', () => false);
  t.mock.method(visuals, 'captureForSession', async () => assert.fail('Competing web capture'));
  t.mock.method(visuals, 'hasInFlightCapture', () => false);
  t.mock.method(require('../../src/services/staging-recovery'), 'recheckSessionChecks', async () => assert.fail('Detached web recheck'));
  t.mock.method(require('../../src/services/staging-recovery'), 'stagingNeedsRebuild', async () => rebuildMissing);
  const setPending = visuals.setChecksPending;
  t.mock.method(visuals, 'setChecksPending', async (client, ...args) => {
    assert.notEqual(client, f.pool, 'Required pending state belongs to the decision transaction');
    return setPending(client, ...args);
  });

  delete require.cache[routePath];
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    req.user = { id: Number(req.headers['x-test-user'] || 1), canAdminWrite: req.headers['x-test-admin'] === 'true' };
    next();
  });
  app.use(require(routePath).sessionRoutes(f.config));
  const server = app.listen(0, '127.0.0.1');
  await new Promise((resolve, reject) => {
    server.once('listening', resolve);
    server.once('error', reject);
  });
  t.after(async () => {
    await new Promise(resolve => server.close(resolve));
    require('../../src/services/session-state').setPool(null);
    if (cachedRoute) require.cache[routePath] = cachedRoute;
    else delete require.cache[routePath];
  });
  return async (path, headers = {}) => {
    const response = await fetch(`http://127.0.0.1:${server.address().port}/api/sessions/1/${path}`, {
      method: 'POST', headers,
    });
    return { status: response.status, body: await response.json() };
  };
}


module.exports = { fixture, candidate, tick, manualServer };
