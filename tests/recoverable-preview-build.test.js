'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { randomUUID } = require('node:crypto');
const { createServer } = require('node:http');
const { once } = require('node:events');
const { createImageBuildOperations } = require('../src/services/preview-flow/image-build-operation');
const { reserveImageBuild, buildManifest } = require('../src/services/preview-flow/image-build-intent');
const { candidateResources } = require('../src/services/preview-flow/candidate-resources');
const { createPreviewWork, PREPARE, PREPARE_CLONE, PREPARE_IMAGE } = require('../src/services/preview-flow/work');
const { createPreviewFlow } = require('../src/services/preview-flow/store');
const { replayDecision } = require('../src/services/preview-flow/reducer');
const { createExecutionDatabase } = require('./lib/execution-database');

const HEAD = 'a'.repeat(40);
const databaseUrl = process.env.PREVIEW_FLOW_TEST_DATABASE_URL || process.env.SQL_CHECK_CONNECTION_URL;

function config() {
  return {
    appRuntime: 'kubernetes',
    nativePreviewWorkerEnabled: true,
    nativePreviewAttempts: true,
    nativePreviewRecoverableClone: true,
    nativePreviewRecoverableBuild: true,
    dataEncryptionKey: 'isolated-build-test',
    kubernetes: {
      appNamespace: 'isolated-apps',
      buildNamespace: 'isolated-builds',
      buildEngine: 'kpack',
      buildServiceAccount: 'builder',
      builderImage: `registry/builder@sha256:${'b'.repeat(64)}`,
      repositoryPrefix: 'registry/apps',
      cacheRepositoryPrefix: 'registry/cache',
      nodeVersion: '22.*',
      activeDeadlineSeconds: 30,
    },
  };
}

function intent() {
  const settings = config();
  return {
    ...candidateResources(settings, 1, randomUUID()),
    buildOperation: {
      ...reserveImageBuild(settings, { slug: 'demo', repo_url: 'https://github.com/example/demo' }, HEAD),
      runScript: null,
    },
  };
}

function externalApi() {
  const objects = new Map();
  const pods = new Map();
  const deployments = new Map();
  let creates = 0;
  const clients = {
    custom: {
      async getNamespacedCustomObject({ namespace, name }) {
        const object = objects.get(`${namespace}/${name}`);
        if (!object) throw Object.assign(new Error('Not found'), { code: 404 });
        return structuredClone(object);
      },
      async createNamespacedCustomObject({ namespace, body }) {
        creates++;
        const key = `${namespace}/${body.metadata.name}`;
        if (objects.has(key)) throw Object.assign(new Error('Already exists'), { code: 409 });
        objects.set(key, {
          ...structuredClone(body),
          metadata: { ...body.metadata, uid: randomUUID(), generation: 1 },
        });
      },
    },
    core: {
      async readNamespacedPod({ name }) {
        if (!pods.has(name)) throw Object.assign(new Error('Pod not found'), { code: 404 });
        return pods.get(name);
      },
    },
    apps: {
      async readNamespacedDeployment({ namespace, name }) {
        const deployment = deployments.get(`${namespace}/${name}`);
        if (!deployment) throw Object.assign(new Error('Deployment not found'), { code: 404 });
        return structuredClone(deployment);
      },
    },
  };
  function object(resource) {
    const body = buildManifest(resource);
    return objects.get(`${body.metadata.namespace}/${body.metadata.name}`);
  }
  function succeed(resource) {
    const build = object(resource);
    build.status = {
      observedGeneration: 1,
      conditions: [{ type: 'Succeeded', status: 'True' }],
      latestImage: `${resource.buildOperation.repository}@sha256:${'c'.repeat(64)}`,
    };
  }
  return { clients, objects, pods, deployments, object, succeed, creates: () => creates };
}

async function preparation(service, resource, checkpoint = {}) {
  let saved = { ...checkpoint };
  const result = await service.prepare(resource, {
    ...saved,
    checkpoint: async value => { saved = { ...value }; return { saved: true }; },
  });
  return { result, checkpoint: saved };
}

test('injected kpack: running and succeeded work is adopted under one stable identity', async () => {
  const api = externalApi();
  const service = createImageBuildOperations({ clients: () => api.clients });
  const resource = intent();
  assert.equal((await service.inspect(resource)).status, 'absent');
  const first = await preparation(service, resource);
  assert.equal(first.result.status, 'running');
  assert.equal(first.checkpoint.uid, api.object(resource).metadata.uid);
  assert.equal((await preparation(service, resource, first.checkpoint)).result.status, 'running');
  assert.equal(api.creates(), 1);
  api.succeed(resource);
  const recovered = await preparation(service, resource, first.checkpoint);
  assert.equal(recovered.result.status, 'succeeded');
  assert.equal(recovered.result.uid, first.checkpoint.uid);
  assert.equal(api.creates(), 1);
});

test('injected kpack: a lost create acknowledgment is inspected before any retry', async () => {
  const api = externalApi();
  const create = api.clients.custom.createNamespacedCustomObject;
  api.clients.custom.createNamespacedCustomObject = async request => {
    await create(request);
    throw new Error('Injected reply loss after server acceptance');
  };
  const resource = intent();
  const service = createImageBuildOperations({ clients: () => api.clients });
  let checkpoint;
  await assert.rejects(service.prepare(resource, {
    checkpoint: async value => { checkpoint = value; return { saved: true }; },
  }), /reply loss/);
  assert.deepEqual(checkpoint, { submitted: true });
  assert.equal((await preparation(service, resource, checkpoint)).result.status, 'running');
  assert.equal(api.creates(), 1);
});

test('injected kpack: interrupted submission with absent resource is uncertain, never another create', async () => {
  const api = externalApi();
  const service = createImageBuildOperations({ clients: () => api.clients });
  const result = await preparation(service, intent(), { submitted: true });
  assert.deepEqual(result.result, { status: 'uncertain', reason: 'submitted_resource_missing' });
  assert.equal(api.creates(), 0);
});

for (const changed of ['uid', 'revision', 'builder', 'cache', 'env', 'extraRecipe', 'owner', 'deleting', 'output', 'generation', 'receipt']) {
  test(`injected kpack: ${changed} cannot establish verified output or ownership`, async () => {
    const api = externalApi();
    const service = createImageBuildOperations({ clients: () => api.clients });
    const resource = intent();
    const first = await preparation(service, resource);
    api.succeed(resource);
    const build = api.object(resource);
    if (changed === 'uid') build.metadata.uid = randomUUID();
    if (changed === 'revision') build.spec.source.git.revision = 'd'.repeat(40);
    if (changed === 'builder') build.spec.builder.image = `other@sha256:${'b'.repeat(64)}`;
    if (changed === 'cache') build.spec.cache.registry.tag = 'shared:cache';
    if (changed === 'env') build.spec.env.push({ name: 'UNDECLARED', value: 'yes' });
    if (changed === 'extraRecipe') build.spec.projectDescriptorPath = 'other.toml';
    if (changed === 'owner') build.metadata.labels['app.kubernetes.io/managed-by'] = 'other';
    if (changed === 'deleting') build.metadata.deletionTimestamp = new Date().toISOString();
    if (changed === 'output') build.status.latestImage = `${resource.buildOperation.repository}:mutable`;
    if (changed === 'generation') build.status.observedGeneration = 0;
    if (changed === 'receipt') resource.buildOperation.receipt = {
      uid: first.checkpoint.uid,
      imageRef: `${resource.buildOperation.repository}@sha256:${'e'.repeat(64)}`,
    };
    assert.equal((await service.inspect(resource, { uid: first.checkpoint.uid })).status, 'uncertain');
    if (changed === 'uid') resource.buildOperation.receipt = {
      uid: first.checkpoint.uid,
      imageRef: build.status.latestImage,
    };
    assert.equal((await service.retire(resource)).status, 'pending');
    assert.equal(api.creates(), 1);
  });
}

for (const kind of ['build', 'infrastructure', 'unknown']) {
  test(`injected kpack: terminal ${kind} failure is classified without relaunching`, async () => {
    const api = externalApi();
    const service = createImageBuildOperations({ clients: () => api.clients });
    const resource = intent();
    await preparation(service, resource);
    const build = api.object(resource);
    build.status = { observedGeneration: 1, podName: 'failed-pod', conditions: [{ type: 'Succeeded', status: 'False' }] };
    api.pods.set('failed-pod', {
      metadata: { ownerReferences: [{ uid: build.metadata.uid, controller: true }] },
      status: kind === 'build' ? {
        initContainerStatuses: [{ name: 'build', state: { terminated: { reason: 'Error', exitCode: 1 } } }],
      } : kind === 'infrastructure' ? { reason: 'Evicted' } : {},
    });
    const result = (await preparation(service, resource, { submitted: true })).result;
    assert.equal(result.status, 'failed');
    assert.equal(result.failureKind, kind);
    assert.equal((await service.retire(resource)).status, 'retained');
    assert.equal(api.creates(), 1);
  });
}

test('injected kpack: absent retirement remains discoverable when delayed creation later completes', async () => {
  const api = externalApi();
  const service = createImageBuildOperations({ clients: () => api.clients });
  const resource = intent();
  const successor = intent();
  assert.equal((await service.retire(resource)).status, 'retained');
  await preparation(service, successor);
  await api.clients.custom.createNamespacedCustomObject({ namespace: resource.buildOperation.namespace, body: buildManifest(resource) });
  assert.equal((await service.retire(resource)).status, 'pending');
  api.succeed(resource);
  assert.equal((await service.retire(resource)).status, 'retained');
  assert.equal((await service.inspect(successor)).status, 'running');
  assert.equal(api.objects.size, 2, 'both Build records are retained; neither Pod is canceled');
});

test('real HTTP client: API timeout aborts its pending request rather than detaching it', async t => {
  const server = createServer(() => {});
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  t.after(() => { server.closeAllConnections(); server.close(); });
  const k8s = require('@kubernetes/client-node');
  const kc = new k8s.KubeConfig();
  kc.loadFromOptions({ clusters: [{ name: 'isolated', skipTLSVerify: true, server: `http://127.0.0.1:${server.address().port}` }],
    users: [{ name: 'test' }], contexts: [{ name: 'test', cluster: 'isolated', user: 'test' }], currentContext: 'test' });
  const custom = kc.makeApiClient(k8s.CustomObjectsApi);
  const service = createImageBuildOperations({ clients: () => ({ custom }), requestTimeoutMs: 100 });
  const started = Date.now();
  await assert.rejects(service.inspect(intent()), error => error.name === 'AbortError');
  assert.ok(Date.now() - started < 2000);
});

async function fixture(t, settings = config(), {
  replyLoss = false,
  decisionLoss = false,
  runtimeReceiptLoss = null,
} = {}) {
  const db = await createExecutionDatabase(databaseUrl);
  t.after(() => db.close());
  const sessionId = 2000000 + process.pid;
  settings = { ...settings, databaseUrl: db.url };
  await db.pool.query('INSERT INTO chat_sessions (id, checks_commit_sha) VALUES ($1, $2)', [sessionId, HEAD]);
  const api = externalApi();
  const create = api.clients.custom.createNamespacedCustomObject;
  let lost = false;
  if (replyLoss) api.clients.custom.createNamespacedCustomObject = async request => {
    await create(request);
    if (!lost) { lost = true; throw new Error('Injected acknowledgment loss'); }
  };
  const images = createImageBuildOperations({ clients: () => api.clients });
  const owner = createPreviewFlow(db.pool);
  if (runtimeReceiptLoss) {
    const kubernetes = require('../src/services/kubernetes');
    kubernetes._setClientsForTest(api.clients);
    t.after(() => kubernetes._setClientsForTest(null));
    t.mock.method(require('../src/services/application-runtime'), 'probeHealth', async () => true);
    const recordRuntime = owner.recordRuntime;
    let lostRuntimeReceipt = false;
    owner.recordRuntime = async (...args) => {
      if (!lostRuntimeReceipt && runtimeReceiptLoss === 'before') {
        lostRuntimeReceipt = true;
        throw new Error('Injected failure before runtime receipt persistence');
      }
      const receipt = await recordRuntime(...args);
      if (!lostRuntimeReceipt && runtimeReceiptLoss === 'after') {
        lostRuntimeReceipt = true;
        throw new Error('Injected reply loss after runtime receipt persistence');
      }
      return receipt;
    };
  }
  let lostDecision = false;
  const apply = owner.apply;
  if (decisionLoss) owner.apply = async action => {
    const result = await apply(action);
    if (action.type === 'CandidateImageBuilt' && !lostDecision) {
      lostDecision = true;
      throw new Error('Injected image fact acknowledgment loss');
    }
    return result;
  };
  let deploys = 0;
  const work = createPreviewWork(db.pool, settings, {
    owner,
    images,
    clones: { prepare: async () => ({ status: 'complete', databaseOid: '123' }), inspect: async () => ({ status: 'complete' }) },
    inspect: runtimeReceiptLoss ? require('../src/services/preview-flow/candidate-runtime').observePreparedCandidate
      : async () => ({ present: false, receipt: null }),
    async prepare(_config, _session, _app, head, candidate, identity) {
      if (!candidate.prepareImage) return assert.fail('legacy preparation not expected');
      const build = await candidate.prepareImage(null);
      await candidate.onRuntimeStarting();
      deploys++;
      const physicalId = randomUUID();
      if (runtimeReceiptLoss) {
        api.deployments.set(`${candidate.intent.namespace}/${candidate.intent.runtimeName}`, {
          metadata: {
            uid: physicalId,
            labels: {
              'social.usernode.io/preview-flow': identity.flowId,
              'social.usernode.io/preview-head': head,
            },
          },
          spec: { template: { spec: { containers: [{ name: 'app', image: build.imageRef }] } } },
        });
      }
      return {
        commitSha: head,
        stagingUrl: runtimeReceiptLoss ? require('../src/services/application-runtime').appOrigin(settings, candidate.intent)
          : `http://${candidate.intent.runtimeName}:3000`,
        runtimeKind: 'kubernetes', runtimeName: candidate.intent.runtimeName, containerId: null,
        imageRef: build.imageRef, buildRef: build.buildRef, physicalId,
      };
    },
  });
  async function run() {
    await db.pool.query('UPDATE execution_work_requests SET due_at = clock_timestamp()');
    const [attempt] = await work.store.claim(randomUUID(), [PREPARE_IMAGE], 1);
    assert.ok(attempt);
    const handler = work.handlers[PREPARE_IMAGE];
    try {
      const proposed = await handler.run({ attempt, signal: new AbortController().signal,
        checkpoint: value => work.store.checkpoint(attempt, value) });
      return await work.store.settle(attempt, proposed, handler.commit);
    } catch (error) {
      await work.store.settle(attempt, { outcome: 'retry', checkpoint: (await work.store.read(attempt.id)).checkpoint });
      throw error;
    }
  }
  const action = { type: 'RequestCandidatePreview', actionId: randomUUID(), sessionId, headSha: HEAD, startedStatus: 'active' };
  return { ...db, api, work, run, owner, action, settings, deploys: () => deploys };
}

for (const loss of ['interruption', 'create acknowledgment', 'decision acknowledgment']) {
  test(`real PostgreSQL / injected kpack: recovery after ${loss} keeps serving state and journals`, { skip: !databaseUrl }, async t => {
    const f = await fixture(t, config(), { replyLoss: loss === 'create acknowledgment', decisionLoss: loss === 'decision acknowledgment' });
    const admitted = await f.work.request(f.action);
    assert.equal(admitted.work.workflow, PREPARE_IMAGE);
    if (loss === 'create acknowledgment') await assert.rejects(f.run(), /acknowledgment loss/);
    else assert.equal((await f.run()).outcome, 'waiting');
    let state = await f.owner.read(f.action.sessionId);
    const resource = state.resource.intent;
    assert.equal(state.preview.runtimeName, 'serving');
    assert.equal(f.deploys(), 0);
    assert.equal(state.binding, null);
    assert.ok(Object.hasOwn(resource.buildOperation, 'runScript'));
    f.api.succeed(resource);
    if (loss === 'decision acknowledgment') await assert.rejects(f.run(), /acknowledgment loss/);
    const finished = await f.run();
    assert.equal(finished.result.accepted, true);
    assert.equal(f.api.creates(), 1);
    assert.equal(f.deploys(), 1);
    state = await f.owner.read(f.action.sessionId);
    assert.equal(state.flow.state, 'candidate');
    assert.equal(state.preview.runtimeName, 'serving');
    assert.equal(state.binding, null);
    assert.ok(state.resource.intent.buildOperation.receipt.uid);
    const trace = await f.owner.trace(f.action.sessionId);
    assert.equal(trace.filter(entry => entry.action.type === 'CandidateImageBuilt').length, 1);
    for (const entry of trace) assert.deepEqual(replayDecision(entry), entry.decision);
  });
}

test('real PostgreSQL / injected kpack: stale image completion and runtime permission are rejected', { skip: !databaseUrl }, async t => {
  const f = await fixture(t);
  await f.work.request(f.action);
  await f.run();
  const state = await f.owner.read(f.action.sessionId);
  const identity = { flowId: state.flow.id, generation: state.flow.generation, headSha: HEAD,
    sessionId: f.action.sessionId, operationId: state.flow.attemptId };
  const runtime = await f.owner.apply({ type: 'RequestCandidateRuntime', actionId: randomUUID(), ...identity });
  assert.equal(runtime.decision.reason, 'image_not_complete');
  const change = await f.owner.apply({ type: 'RequestCandidateImageBuild', actionId: randomUUID(), ...identity, runScript: 'build' });
  assert.equal(change.decision.reason, 'image_recipe_changed');
  await f.pool.query('UPDATE chat_sessions SET checks_commit_sha = $2 WHERE id = $1', [f.action.sessionId, 'd'.repeat(40)]);
  const stale = await f.owner.apply({ type: 'CandidateImageBuilt', actionId: randomUUID(), ...identity,
    uid: f.api.object(state.resource.intent).metadata.uid, imageRef: `registry/apps/demo@sha256:${'c'.repeat(64)}` });
  assert.equal(stale.decision.reason, 'head_changed');
  const retired = await f.run();
  assert.equal(retired.result.prepared, false);
  assert.equal(f.deploys(), 0);
  assert.equal((await f.owner.read(f.action.sessionId)).preview.runtimeName, 'serving');
});

test('real PostgreSQL: admission freezes recipe configuration and preserves already admitted work', { skip: !databaseUrl }, async t => {
  for (const [recoverClone, workflow] of [[false, PREPARE], [true, PREPARE_CLONE]]) {
    const f = await fixture(t, { ...config(), nativePreviewRecoverableClone: recoverClone, nativePreviewRecoverableBuild: false });
    const before = await f.work.request(f.action);
    const changed = createPreviewWork(f.pool, { ...f.settings, nativePreviewRecoverableClone: true, nativePreviewRecoverableBuild: true });
    const replayed = await changed.request(f.action);
    assert.equal(replayed.work.workflow, workflow);
    assert.deepEqual(replayed.work.input, before.work.input);
  }
  const f = await fixture(t);
  const admitted = await f.work.request(f.action);
  f.settings.kubernetes.builderImage = `changed/builder@sha256:${'d'.repeat(64)}`;
  assert.notEqual(admitted.work.input.intent.buildOperation.builderImage, f.settings.kubernetes.builderImage);
  assert.ok(f.work.handlers[PREPARE] && f.work.handlers[PREPARE_CLONE] && f.work.handlers[PREPARE_IMAGE]);
});

for (const invalid of ['docker', 'auto', 'mutable builder', 'missing clone']) {
  test(`real PostgreSQL: ${invalid} admission rolls back decisions, resources and work`, { skip: !databaseUrl }, async t => {
    const settings = config();
    if (invalid === 'docker') settings.appRuntime = 'docker';
    if (invalid === 'auto') settings.kubernetes.buildEngine = 'auto';
    if (invalid === 'mutable builder') settings.kubernetes.builderImage = 'builder:latest';
    if (invalid === 'missing clone') settings.nativePreviewRecoverableClone = false;
    const f = await fixture(t, settings);
    await assert.rejects(f.work.request(f.action));
    for (const table of ['preview_flows', 'preview_flow_resources', 'preview_flow_decisions', 'execution_work_requests']) {
      assert.equal((await f.pool.query(`SELECT * FROM ${table}`)).rowCount, 0);
    }
  });
}

test('real PostgreSQL + HTTP / injected Build: SIGKILL of the actual worker recovers its original claim and Build', { skip: !databaseUrl }, async t => {
  const { fork } = require('node:child_process');
  const f = await fixture(t);
  const admitted = await f.work.request(f.action);
  const server = createServer(async (request, response) => {
    try {
      let value;
      const namespace = admitted.work.input.intent.buildOperation.namespace;
      const name = buildManifest({ ...admitted.work.input.intent,
        buildOperation: { ...admitted.work.input.intent.buildOperation, runScript: null } }).metadata.name;
      if (request.method === 'POST') {
        const chunks = [];
        for await (const chunk of request) chunks.push(chunk);
        await f.api.clients.custom.createNamespacedCustomObject({ namespace, body: JSON.parse(Buffer.concat(chunks)) });
      }
      value = await f.api.clients.custom.getNamespacedCustomObject({ namespace, name });
      response.statusCode = request.method === 'POST' ? 201 : 200;
      response.setHeader('Content-Type', 'application/json');
      response.end(JSON.stringify(value));
    } catch (error) {
      response.writeHead(error.code || 500, { 'Content-Type': 'application/json' });
      response.end(JSON.stringify({ kind: 'Status', apiVersion: 'v1', status: 'Failure', code: error.code || 500 }));
    }
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  t.after(() => { server.closeAllConnections(); server.close(); });
  const child = fork(require.resolve('./lib/recoverable-build-child'), [], {
    execArgv: [], stdio: ['ignore', 'ignore', 'inherit', 'ipc'],
    env: { PATH: process.env.PATH, TMPDIR: process.env.TMPDIR, RUN_INJECTED_BUILD_TEST: '1' },
  });
  t.after(() => { if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL'); });
  const message = new Promise((resolve, reject) => {
    child.once('message', value => resolve([value]));
    child.once('exit', (code, signal) => reject(new Error(`Worker exited before interruption: ${code}/${signal}`)));
  });
  child.send({ databaseUrl: f.url, config: f.settings, apiUrl: `http://127.0.0.1:${server.address().port}` });
  const [phase] = await message;
  assert.deepEqual(phase, { phase: 'created' });
  const exited = once(child, 'exit');
  child.kill('SIGKILL');
  await exited;
  const interrupted = await f.work.store.read(admitted.work.id);
  assert.equal(interrupted.checkpoint.imageSubmitted, true);
  assert.equal(interrupted.status, 'running');
  const resource = (await f.owner.read(f.action.sessionId)).resource.intent;
  const uid = f.api.object(resource).metadata.uid;
  f.api.succeed(resource);
  await f.pool.query('UPDATE execution_work_requests SET lease_until = clock_timestamp() - INTERVAL \'1 second\' WHERE id = $1', [admitted.work.id]);
  const result = await f.run();
  assert.equal(result.result.accepted, true);
  assert.equal(f.api.creates(), 1);
  assert.equal((await f.owner.read(f.action.sessionId)).resource.intent.buildOperation.receipt.uid, uid);
  assert.equal((await f.owner.read(f.action.sessionId)).preview.runtimeName, 'serving');
  const events = await f.work.store.trace(admitted.work.id);
  assert.equal(events.filter(event => event.kind === 'claimed').length, 2);
  const attempts = await f.pool.query('SELECT outcome FROM execution_work_attempts WHERE work_id = $1', [admitted.work.id]);
  assert.ok(attempts.rows.some(attempt => attempt.outcome === 'interrupted'));
});

for (const kind of ['build', 'infrastructure', 'unknown']) {
  test(`real PostgreSQL / injected kpack: ${kind} failure settles the domain with an explicit cause`, { skip: !databaseUrl }, async t => {
    const f = await fixture(t);
    await f.work.request(f.action);
    await f.run();
    const resource = (await f.owner.read(f.action.sessionId)).resource.intent;
    const build = f.api.object(resource);
    build.status = { observedGeneration: 1, podName: 'failed', conditions: [{ type: 'Succeeded', status: 'False' }] };
    f.api.pods.set('failed', {
      metadata: { ownerReferences: [{ uid: build.metadata.uid, controller: true }] },
      status: kind === 'build' ? { initContainerStatuses: [{ name: 'build', state: { terminated: { reason: 'Error', exitCode: 1 } } }] }
        : kind === 'infrastructure' ? { reason: 'Evicted' } : {},
    });
    const outcome = await f.run();
    assert.equal(outcome.code, `image_failed_${kind}`);
    assert.equal(outcome.result.prepared, false);
    assert.equal((await f.owner.read(f.action.sessionId)).flow.state, 'failed');
    assert.equal((await f.owner.read(f.action.sessionId)).preview.runtimeName, 'serving');
    assert.equal(f.deploys(), 0);
    assert.equal(f.api.creates(), 1);
  });
}

test('real PostgreSQL / injected runtimes: cleanup defers for a live Build and preserves its successor after completion', { skip: !databaseUrl }, async t => {
  const f = await fixture(t);
  await f.work.request(f.action);
  await f.run();
  const old = await f.owner.read(f.action.sessionId);
  await f.owner.apply({ type: 'PreparationFailed', actionId: randomUUID(), sessionId: f.action.sessionId,
    flowId: old.flow.id, generation: old.flow.generation, headSha: HEAD, detail: 'Retired isolated test attempt' });
  await f.work.request({ ...f.action, actionId: randomUUID() });
  const successor = await f.owner.read(f.action.sessionId);
  const removals = [];
  t.mock.method(require('../src/services/preview-flow/binding-adapters'), 'inspect', async () => ({ target: 'serving', token: null, uid: null }));
  t.mock.method(require('../src/services/preview-flow/candidate-runtime'), 'removeCandidate', async (_config, resource) => removals.push(resource.runtimeName));
  t.mock.method(require('../src/services/preview-flow/candidate-runtime'), 'removeCandidateImage', async () => {});
  t.mock.method(require('../src/services/docker'), 'execFileAsync', async () => {});
  const cleanup = require('../src/services/preview-flow/cleanup').createCleanup({
    images: createImageBuildOperations({ clients: () => f.api.clients }),
    clones: { remove: async resource => { assert.equal(resource.dbName, old.resource.intent.dbName); return { status: 'removed' }; } },
  });
  const cleanupRequest = { pool: f.pool, config: f.settings, sessionId: f.action.sessionId, flowId: old.flow.id };
  await assert.rejects(cleanup.underBuildLock(cleanupRequest), /build may still be running/);
  assert.deepEqual(removals, []);
  assert.equal((await f.pool.query('SELECT cleanup_completed_at FROM preview_flow_resources WHERE flow_id = $1', [old.flow.id])).rows[0].cleanup_completed_at, null);
  f.api.succeed(old.resource.intent);
  await cleanup.underBuildLock(cleanupRequest);
  assert.deepEqual(removals, [old.resource.intent.runtimeName]);
  const current = await f.owner.read(f.action.sessionId);
  assert.equal(current.flow.id, successor.flow.id);
  assert.equal(current.resource.intent.runtimeName, successor.resource.intent.runtimeName);
  assert.equal(current.resource.cleanupStarted, false);
  assert.equal(current.preview.runtimeName, 'serving');
  assert.equal(f.api.objects.size, 1, 'retired Build record is retained as a tombstone');
  await f.work.census();
  assert.equal((await f.pool.query('SELECT * FROM execution_work_requests WHERE workflow = $1', ['native-preview-retire'])).rowCount, 1);
});

test('injected Kubernetes inventory: legacy failed/app deletion and success retention exclude experimental Builds', async t => {
  const kubernetes = require('../src/services/kubernetes');
  const resource = intent();
  const expected = buildManifest(resource);
  const build = { ...expected, metadata: { ...expected.metadata, uid: randomUUID(), resourceVersion: '1' },
    status: { latestImage: `${resource.buildOperation.repository}@sha256:${'c'.repeat(64)}`,
      conditions: [{ type: 'Succeeded', status: 'True', lastTransitionTime: '2020-01-01T00:00:00Z' }] } };
  const requests = [];
  const clients = { custom: {
    async listNamespacedCustomObject(request) {
      requests.push(request);
      assert.match(request.labelSelector, /managed-by=social-vibecoding-runtime/);
      return { items: [] };
    },
    async deleteCollectionNamespacedCustomObject(request) {
      requests.push(request);
      assert.equal(request.labelSelector, 'social.usernode.io/app-id=1');
      assert.equal(build.metadata.labels['social.usernode.io/app-id'], undefined);
    },
  } };
  t.mock.method(kubernetes, '_getClients', () => clients);
  kubernetes._setClientsForTest(clients);
  t.after(() => kubernetes._setClientsForTest(null));
  const settings = config();
  await kubernetes.deleteFailedBuilds(settings);
  await kubernetes.deleteBuilds(settings, 1);
  assert.ok(requests.length >= 2);
  const retention = await require('../src/services/build-retention').sweep(settings, {
    dryRun: false,
    pool: { query: async () => ({ rows: [] }) },
    runtime: {
      listManagedBuilds: async () => [build],
      deleteBuildSnapshot: async () => assert.fail('Experimental tombstone must not be pruned'),
    },
  });
  assert.deepEqual(retention.deleted, []);
});

test('real PostgreSQL: recipe writes and decision journal roll back together after a persistence error', { skip: !databaseUrl }, async t => {
  const f = await fixture(t);
  await f.work.request(f.action);
  const initial = await f.owner.read(f.action.sessionId);
  await f.owner.markClonePrepared(f.action.sessionId, initial.flow.id);
  const action = { type: 'RequestCandidateImageBuild', actionId: randomUUID(), sessionId: f.action.sessionId,
    flowId: initial.flow.id, generation: initial.flow.generation, headSha: HEAD, operationId: initial.flow.attemptId, runScript: null };
  let failed = false;
  const brokenPool = {
    query: (...args) => f.pool.query(...args),
    async connect() {
      const client = await f.pool.connect();
      return {
        release: error => client.release(error),
        async query(sql, values) {
          const result = await client.query(sql, values);
          if (!failed && String(sql).includes('SET intent = jsonb_set')) {
            failed = true;
            throw new Error('Injected mapping failure after recipe write');
          }
          return result;
        },
      };
    },
  };
  await assert.rejects(createPreviewFlow(brokenPool).apply(action), /mapping failure/);
  assert.equal(Object.hasOwn((await f.owner.read(f.action.sessionId)).resource.intent.buildOperation, 'runScript'), false);
  assert.equal((await f.owner.trace(f.action.sessionId)).some(entry => entry.action.actionId === action.actionId), false);
  assert.equal((await f.owner.apply(action)).decision.accepted, true);
});

test('real PostgreSQL: candidate completion cannot bypass its reserved image receipt', { skip: !databaseUrl }, async t => {
  const f = await fixture(t);
  await f.work.request(f.action);
  await f.run();
  const state = await f.owner.read(f.action.sessionId);
  const receipt = {
    commitSha: HEAD, stagingUrl: `http://${state.resource.intent.runtimeName}:3000`,
    runtimeKind: 'kubernetes', runtimeName: state.resource.intent.runtimeName, containerId: null,
    imageRef: `registry/apps/demo@sha256:${'c'.repeat(64)}`, buildRef: 'unverified/other-build',
    physicalId: randomUUID(), attemptId: state.flow.attemptId,
  };
  const result = await f.owner.apply({ type: 'PreviewCandidatePrepared', actionId: randomUUID(), sessionId: f.action.sessionId,
    flowId: state.flow.id, generation: state.flow.generation, headSha: HEAD, receipt });
  assert.equal(result.decision.reason, 'candidate_image_unconfirmed');
  assert.equal((await f.owner.read(f.action.sessionId)).flow.state, 'preparing');
});

test('injected kpack: failed or rejected submission checkpoint prevents external creation', async () => {
  const api = externalApi();
  const service = createImageBuildOperations({ clients: () => api.clients });
  const resource = intent();
  const lost = await service.prepare(resource, { checkpoint: async () => ({ lostClaim: true }) });
  assert.equal(lost.reason, 'claim_lost');
  await assert.rejects(service.prepare(resource, { checkpoint: async () => { throw new Error('Database checkpoint failed'); } }), /checkpoint failed/);
  assert.equal(api.creates(), 0);
});

for (const loss of ['before', 'after']) {
  test(`real PostgreSQL / production observer: healthy runtime adoption repairs ${loss}-persistence receipt loss`, { skip: !databaseUrl }, async t => {
    const f = await fixture(t, config(), { runtimeReceiptLoss: loss });
    await f.work.request(f.action);
    const servingPreview = (await f.owner.read(f.action.sessionId)).preview;
    await f.run();
    const resource = (await f.owner.read(f.action.sessionId)).resource.intent;
    f.api.succeed(resource);
    await assert.rejects(f.run(), loss === 'before' ? /before runtime receipt persistence/ : /after runtime receipt persistence/);
    const interrupted = await f.owner.read(f.action.sessionId);
    assert.equal(interrupted.flow.state, 'preparing');
    assert.equal(interrupted.resource.receipt === null, loss === 'before');
    const deployment = f.api.deployments.get(`${resource.namespace}/${resource.runtimeName}`);
    const build = f.api.object(resource);
    const observed = await require('../src/services/preview-flow/candidate-runtime').observePreparedCandidate(
      f.settings, resource, interrupted.flow.id, HEAD);
    assert.equal(observed.receipt.buildRef, null, 'the real observer cannot establish build provenance by itself');
    const recovered = await f.run();
    assert.equal(recovered.result.accepted, true);
    assert.equal(recovered.result.prepared, true);
    const current = await f.owner.read(f.action.sessionId);
    assert.equal(current.flow.state, 'candidate');
    assert.equal(current.resource.receipt.buildRef, `${build.metadata.namespace}/${build.metadata.name}`);
    assert.equal(current.resource.receipt.imageRef, build.status.latestImage);
    assert.equal(current.resource.receipt.physicalId, deployment.metadata.uid);
    assert.equal(current.resource.intent.buildOperation.receipt.uid, build.metadata.uid);
    assert.equal(f.api.creates(), 1);
    assert.equal(f.deploys(), 1);
    assert.deepEqual(current.preview, servingPreview);
    assert.equal(current.binding, null);
    const completions = (await f.owner.trace(f.action.sessionId)).filter(entry => entry.action.type === 'PreviewCandidatePrepared');
    assert.equal(completions.length, 1);
    assert.equal(completions[0].decision.accepted, true);
  });
}

const adoptionConflicts = [
  'build UID', 'build recipe', 'build generation', 'build digest',
  'runtime image', 'runtime owner', 'runtime head', 'runtime UID',
  'stored Build reference', 'health', 'lifecycle',
];

for (const conflict of adoptionConflicts) {
  test(`real PostgreSQL / production observer: recovery rejects conflicting ${conflict}`, { skip: !databaseUrl }, async t => {
    const persistedReceipt = conflict === 'runtime UID' || conflict === 'stored Build reference';
    const f = await fixture(t, config(), { runtimeReceiptLoss: persistedReceipt ? 'after' : 'before' });
    await f.work.request(f.action);
    await f.run();
    const resource = (await f.owner.read(f.action.sessionId)).resource.intent;
    f.api.succeed(resource);
    await assert.rejects(f.run(), /runtime receipt persistence/);

    const build = f.api.object(resource);
    const deployment = f.api.deployments.get(`${resource.namespace}/${resource.runtimeName}`);
    switch (conflict) {
      case 'build UID':
        build.metadata.uid = randomUUID();
        break;
      case 'build recipe':
        build.spec.source.git.revision = 'd'.repeat(40);
        break;
      case 'build generation':
        build.status.observedGeneration = 0;
        break;
      case 'build digest':
        build.status.latestImage = `${resource.buildOperation.repository}@sha256:${'d'.repeat(64)}`;
        break;
      case 'runtime image':
        deployment.spec.template.spec.containers[0].image = `other/image@sha256:${'c'.repeat(64)}`;
        break;
      case 'runtime owner':
        deployment.metadata.labels['social.usernode.io/preview-flow'] = randomUUID();
        break;
      case 'runtime head':
        deployment.metadata.labels['social.usernode.io/preview-head'] = 'd'.repeat(40);
        break;
      case 'runtime UID':
        deployment.metadata.uid = randomUUID();
        break;
      case 'stored Build reference':
        await f.pool.query(`UPDATE preview_flow_resources
          SET receipt = jsonb_set(receipt, '{buildRef}', '"conflicting/other-build"'::jsonb)`);
        break;
      case 'health':
        t.mock.method(require('../src/services/application-runtime'), 'probeHealth', async () => false);
        break;
      case 'lifecycle':
        await f.pool.query('UPDATE chat_sessions SET checks_commit_sha = $2 WHERE id = $1', [f.action.sessionId, 'd'.repeat(40)]);
        break;
    }

    const observationError = ['runtime owner', 'runtime head', 'runtime UID', 'stored Build reference'].includes(conflict);
    if (observationError) {
      await assert.rejects(f.run(), error => error.permanent === true);
    } else {
      const result = await f.run();
      assert.notEqual(result.result?.prepared, true);
    }
    const current = await f.owner.read(f.action.sessionId);
    assert.notEqual(current.flow.state, 'candidate');
    assert.equal(current.resource.receipt === null, !persistedReceipt);
    assert.equal(f.api.creates(), 1);
    assert.equal(f.deploys(), 1);
    assert.equal(current.preview.runtimeName, 'serving');
    assert.equal(current.binding, null);
    assert.equal((await f.owner.trace(f.action.sessionId)).filter(entry =>
      entry.action.type === 'PreviewCandidatePrepared' && entry.decision.accepted).length, 0);
  });
}
