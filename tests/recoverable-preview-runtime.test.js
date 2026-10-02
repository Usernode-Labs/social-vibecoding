'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { randomUUID } = require('node:crypto');
const { createExecutionDatabase } = require('./lib/execution-database');
const { createPreviewFlow } = require('../src/services/preview-flow/store');
const { createPreviewWork, PREPARE_RUNTIME } = require('../src/services/preview-flow/work');
const { selectRuntime, runtimeManifests, RESOURCE_KINDS } = require('../src/services/preview-flow/runtime-intent');
const { createRuntimeOperations } = require('../src/services/preview-flow/runtime-operation');
const { parseAction } = require('../src/services/preview-flow/actions');
const { reduce, replayDecision } = require('../src/services/preview-flow/reducer');
const { reduceRuntime } = require('../src/services/preview-flow/runtime-reducer');
const { replayHistorical } = require('./lib/historical-replay');
const { createInjectedRuntimeApi: externalApi } = require('./lib/injected-preview-runtime');

const databaseUrl = process.env.PREVIEW_FLOW_TEST_DATABASE_URL;
const HEAD = 'a'.repeat(40);
const IMAGE = `example.test/images/demo@sha256:${'b'.repeat(64)}`;
const KEY = 'injected-runtime-only';

function settings() {
  return {
    appRuntime: 'kubernetes', dataEncryptionKey: KEY,
    nativeCliPreviewHandoffEnabled: true,
    kubernetes: {
      appNamespace: 'isolated', buildNamespace: 'isolated', buildEngine: 'kpack',
      builderImage: `example.test/builder@sha256:${'c'.repeat(64)}`, buildServiceAccount: 'builder',
      generatedAppServiceAccount: 'candidate', repositoryPrefix: 'example.test/images', cacheRepositoryPrefix: 'example.test/cache',
      nodeVersion: '22.*', activeDeadlineSeconds: 900,
    },
  };
}

function stateFixture() {
  const attemptId = randomUUID();
  const flowId = randomUUID();
  const identity = { flowId, generation: 1, headSha: HEAD };
  const desired = selectRuntime(settings(), identity, { imageRef: IMAGE, env: { TOKEN: 'confidential-value' } });
  const state = {
    session: { source: 'cli_handoff', status: 'active', checksCommitSha: HEAD },
    flow: { id: flowId, generation: 1, headSha: HEAD, startedStatus: 'active', state: 'preparing', attemptId },
    resource: {
      sessionId: 1, flowId, preparationOwner: 'bounded', clonePrepared: true,
      intent: {
        runtimeKind: 'kubernetes', runtimeName: `sv-p-${attemptId.replaceAll('-', '')}`, namespace: 'isolated', dbName: 'candidate_db', attemptId,
        buildOperation: { receipt: { uid: 'verified-build', imageRef: IMAGE } },
        runtimeOperation: { kind: 'kubernetes-v1', resources: {} },
      },
    },
  };
  function apply(type, input = {}) {
    const action = { type, actionId: randomUUID(), sessionId: 1, ...identity, operationId: attemptId, ...input };
    const decision = reduce(state, action, {});
    if (decision.runtimeChange) state.resource.intent.runtimeOperation = decision.runtimeChange.operation;
    return decision;
  }
  assert.equal(apply('RequestCandidateRuntimePreparation', { desired }).accepted, true);
  return { state, desired, apply };
}


function context(f) {
  return {
    signal: new AbortController().signal,
    read: async () => f.state.resource.intent,
    async authorize(resource) {
      const decision = f.apply('RequestCandidateRuntimeResourceCreation', { resource });
      return decision.effects[0]?.intent || null;
    },
    observe: async (resource, uid) => f.apply('CandidateRuntimeResourceObserved', { resource, uid }).accepted,
  };
}

test('runtime action boundary, immutable selection, predecessor guards and historical UID facts are explicit', () => {
  const f = stateFixture();
  assert.equal(f.apply('RequestCandidateRuntimeResourceCreation', { resource: 'deployment' }).reason, 'runtime_predecessor_unconfirmed');
  assert.equal(f.apply('RequestCandidateRuntimePreparation', { desired: { ...f.desired, cpuLimit: '2' } }).reason, 'runtime_specification_changed');
  assert.equal(JSON.stringify(f.desired).includes('confidential-value'), false);
  assert.throws(() => parseAction({ type: 'RequestCandidateRuntimeResourceCreation', actionId: randomUUID(), sessionId: 1, flowId: f.state.flow.id, generation: 1, headSha: HEAD, operationId: f.state.flow.attemptId, resource: 'secret', patch: {} }));
  const first = f.apply('RequestCandidateRuntimeResourceCreation', { resource: 'secret' });
  assert.equal(first.effects.length, 1);
  assert.equal(f.apply('RequestCandidateRuntimeResourceCreation', { resource: 'secret' }).effects.length, 0);
  f.state.flow = { ...f.state.flow, id: randomUUID(), generation: 2 };
  assert.equal(f.apply('RequestCandidateRuntimeResourceCreation', { resource: 'service' }).reason, 'superseded_flow');
  assert.equal(f.apply('CandidateRuntimeResourceObserved', { resource: 'secret', uid: 'late' }).accepted, true);
  assert.equal(f.apply('CandidateRuntimeResourceObserved', { resource: 'secret', uid: 'successor' }).reason, 'runtime_uid_conflict');
});

test('C5 runtime guards are pure and historical v8 completion remains replayable', () => {
  const f = stateFixture();
  const state = structuredClone(f.state);
  state.resource.intent.buildOperation.namespace = 'isolated';
  const action = {
    type: 'PreviewCandidatePrepared', actionId: randomUUID(), sessionId: 1,
    flowId: state.flow.id, generation: 1, headSha: HEAD,
    receipt: {
      runtimeKind: 'kubernetes', runtimeName: state.resource.intent.runtimeName,
      containerId: null, physicalId: 'deployment', attemptId: state.flow.attemptId,
      commitSha: HEAD, imageRef: IMAGE, stagingUrl: 'http://candidate.test',
      buildRef: `isolated/sv-p-${state.flow.attemptId.replaceAll('-', '')}`,
    },
  };
  const before = structuredClone(state);
  assert.equal(reduceRuntime(state, action), null);
  assert.equal(reduce(state, action, {}).reason, 'candidate_runtime_unconfirmed');
  // Existing v8 work has no runtime operation. Its frozen policy must remain
  // independent of future guards, even if a supplied trace includes new fields.
  const old = replayHistorical('preview-flow', { reducer_version: 8, pre_state: state, action, facts: {} });
  assert.equal(old.accepted, true);
  assert.throws(() => replayDecision({ reducer_version: 8, pre_state: state, action, facts: {} }), /Unsupported/);
  assert.deepEqual(state, before);
});

test('saved desired spec preserves self-app environment and diagnostic labels on recovery', () => {
  const f = stateFixture();
  const desired = selectRuntime({ ...settings(), selfAppSlug: 'homeroom' }, {
    flowId: f.state.flow.id, generation: 1, headSha: HEAD,
  }, {
    app: { id: 1, slug: 'homeroom' }, sessionId: 2, imageRef: IMAGE,
    env: { USERNODE_SHELL_ASSETS_PREBUILT: '0' },
  });
  const intent = { ...f.state.resource.intent, runtimeOperation: { kind: 'kubernetes-v1', desired, resources: {} } };
  const manifests = runtimeManifests(intent, KEY);
  assert.equal(manifests.secret.data.USERNODE_SHELL_ASSETS_PREBUILT, Buffer.from('1').toString('base64'));
  assert.equal(manifests.deployment.metadata.labels['social.usernode.io/session-id'], '2');
  assert.equal(manifests.deployment.metadata.labels['social.usernode.io/app-id'], '1');
});

test('new placement follows canonical policy; retained specs adopt their original host-only resources', async () => {
  const f = stateFixture();
  const config = settings();
  config.kubernetes.previewDatabaseNamespace = 'database-fixture';
  config.kubernetes.previewDatabaseCluster = 'primary-fixture';
  const desired = selectRuntime(config, {
    flowId: f.state.flow.id,
    generation: 1,
    headSha: HEAD,
  }, { imageRef: IMAGE, env: {} });
  const intent = f.state.resource.intent;
  intent.runtimeOperation.desired = desired;
  const preferences = () => runtimeManifests(intent, KEY).deployment.spec.template.spec
    .affinity.podAffinity.preferredDuringSchedulingIgnoredDuringExecution;
  assert.deepEqual(preferences().map(value => [value.weight, value.podAffinityTerm.topologyKey]), [
    [100, 'topology.kubernetes.io/zone'],
    [50, 'kubernetes.io/hostname'],
  ]);

  // A retained spec predates the placement field. Do not default it while
  // parsing: its manifest and spec label must still match existing resources.
  delete desired.databaseAffinity.placement;
  assert.deepEqual(preferences().map(value => [value.weight, value.podAffinityTerm.topologyKey]), [
    [100, 'kubernetes.io/hostname'],
  ]);
  const api = externalApi();
  const service = createRuntimeOperations({ clients: () => api.clients, dataKey: KEY, probe: async () => true });
  assert.equal((await service.prepare(config, intent, context(f))).status, 'healthy');
  const original = structuredClone([...api.objects]);
  config.kubernetes.previewDatabaseCluster = 'changed-after-admission';
  assert.equal((await service.prepare(config, intent, context(f))).status, 'healthy');
  assert.deepEqual([...api.objects], original);
  assert.deepEqual(api.creates, RESOURCE_KINDS);
  assert.equal(desired.databaseAffinity.cluster, 'primary-fixture');
});

test('injected Kubernetes: pre-Deployment retirement can release dependencies while reconciling a late Secret', async () => {
  const f = stateFixture();
  const api = externalApi();
  const service = createRuntimeOperations({ clients: () => api.clients, dataKey: KEY });
  f.apply('RequestCandidateRuntimeResourceCreation', { resource: 'secret' });
  f.state.flow.state = 'failed';
  assert.equal((await service.retire(f.state.resource.intent, context(f))).status, 'absent');
  await api.clients.core.createNamespacedSecret({ body: runtimeManifests(f.state.resource.intent, KEY).secret });
  assert.equal((await service.retire(f.state.resource.intent, context(f))).status, 'absent');
  assert.deepEqual(api.deletes, ['secret']);
  assert.equal(api.objects.size, 0);
  assert.ok(f.state.resource.intent.runtimeOperation.resources.secret.uid);
  assert.equal(f.apply('RequestCandidateRuntimeResourceCreation', { resource: 'service' }).accepted, false);
});

for (const resource of RESOURCE_KINDS) {
  test(`injected Kubernetes: lost ${resource} create acknowledgment adopts without another POST`, async () => {
    const f = stateFixture();
    const api = externalApi();
    const lane = resource === 'deployment' ? api.clients.apps : api.clients.core;
    const method = { secret: 'createNamespacedSecret', service: 'createNamespacedService', deployment: 'createNamespacedDeployment' }[resource];
    const create = lane[method];
    let lost = false;
    lane[method] = async request => {
      const object = await create(request);
      if (!lost) { lost = true; throw new Error('Injected creation reply loss'); }
      return object;
    };
    const service = createRuntimeOperations({ clients: () => api.clients, dataKey: KEY, probe: async () => true });
    await assert.rejects(service.prepare(settings(), f.state.resource.intent, context(f)), /reply loss/);
    assert.equal((await service.prepare(settings(), f.state.resource.intent, context(f))).status, 'healthy');
    assert.deepEqual(api.creates, RESOURCE_KINDS);
    assert.ok(RESOURCE_KINDS.every(kind => f.state.resource.intent.runtimeOperation.resources[kind].uid));
  });
}

for (const conflict of ['uid', 'secret data', 'service selector', 'deployment image', 'missing deployment spec', 'pod owner']) {
  test(`injected Kubernetes: recovery blocks conflicting ${conflict}`, async () => {
    const f = stateFixture();
    const api = externalApi();
    const service = createRuntimeOperations({ clients: () => api.clients, dataKey: KEY, probe: async () => true });
    assert.equal((await service.prepare(settings(), f.state.resource.intent, context(f))).status, 'healthy');
    const manifests = runtimeManifests(f.state.resource.intent, KEY);
    if (conflict === 'uid') api.objects.get(`secret/${manifests.secret.metadata.name}`).metadata.uid = randomUUID();
    if (conflict === 'secret data') api.objects.get(`secret/${manifests.secret.metadata.name}`).data.TOKEN = 'changed';
    if (conflict === 'service selector') api.objects.get(`service/${manifests.service.metadata.name}`).spec.selector.other = 'another';
    if (conflict === 'deployment image') api.objects.get(`deployment/${manifests.deployment.metadata.name}`).spec.template.spec.containers[0].image = 'another';
    if (conflict === 'missing deployment spec') delete api.objects.get(`deployment/${manifests.deployment.metadata.name}`).spec;
    if (conflict === 'pod owner') api.clients.apps.listNamespacedReplicaSet = async () => ({ items: [] });
    const outcome = await service.prepare(settings(), f.state.resource.intent, context(f));
    assert.equal(outcome.reason, 'ownership_conflict');
    assert.deepEqual(api.creates, RESOURCE_KINDS);
    assert.equal(api.deletes.length, 0);
  });
}

test('injected Kubernetes: durable submission without visible resource never recreates it', async () => {
  const f = stateFixture();
  f.apply('RequestCandidateRuntimeResourceCreation', { resource: 'secret' });
  const api = externalApi();
  const service = createRuntimeOperations({ clients: () => api.clients, dataKey: KEY });
  assert.equal((await service.prepare(settings(), f.state.resource.intent, context(f))).reason, 'submitted_resource_missing');
  assert.deepEqual(api.creates, []);
});

test('injected Kubernetes: cleanup reports current absence independently of creator closure and rejects successor UIDs', async () => {
  const f = stateFixture();
  const api = externalApi();
  const service = createRuntimeOperations({ clients: () => api.clients, dataKey: KEY, probe: async () => true });
  await service.prepare(settings(), f.state.resource.intent, context(f));
  f.state.flow.state = 'failed';
  assert.equal((await service.retire(f.state.resource.intent, context(f))).reason, 'consumers_terminating');
  assert.deepEqual(await service.retire(f.state.resource.intent, context(f)), { status: 'absent', creationEnded: false });
  assert.deepEqual(api.deletes, ['deployment', 'service', 'secret']);
  const successor = runtimeManifests(f.state.resource.intent, KEY).secret;
  await api.clients.core.createNamespacedSecret({ body: successor });
  assert.equal((await service.retire(f.state.resource.intent, context(f))).reason, 'ownership_conflict');
  assert.equal(api.objects.size, 1);
});

for (const loss of ['partial creation', 'runtime receipt', 'completion reply']) {
  test(`real PostgreSQL / injected Kubernetes: recovery after ${loss} uses the shared worker and preserves serving`, { skip: !databaseUrl }, async t => {
    const db = await createExecutionDatabase(databaseUrl);
    t.after(() => db.close());
    const sessionId = 5000000 + process.pid;
    await db.pool.query('INSERT INTO chat_sessions (id, checks_commit_sha) VALUES ($1,$2)', [sessionId, HEAD]);
    const config = { ...settings(), databaseUrl: db.url };
    const api = externalApi();
    let injected = false;
    const runtimes = createRuntimeOperations({
      clients: () => api.clients, dataKey: KEY, probe: async () => true,
      async onObservation(phase) {
        if (loss === 'partial creation' && phase === 'created_service' && !injected) {
          injected = true;
          throw new Error('Injected partial interruption');
        }
      },
    });
    const owner = createPreviewFlow(db.pool);
    const record = owner.recordRuntime;
    owner.recordRuntime = async (...args) => {
      if (loss === 'runtime receipt' && !injected) { injected = true; throw new Error('Injected receipt failure'); }
      return record(...args);
    };
    const images = {
      prepare: async () => ({ status: 'succeeded', uid: 'verified-build', imageRef: IMAGE }),
      inspect: async () => ({ status: 'succeeded', uid: 'verified-build', imageRef: IMAGE }),
    };
    const work = createPreviewWork(db.pool, config, {
      owner, runtimes, images,
      clones: { prepare: async () => ({ status: 'complete', databaseOid: '123' }), inspect: async () => ({ status: 'complete' }) },
      async prepare(_config, _session, _app, _head, candidate) {
        await candidate.prepareClone();
        await candidate.prepareImage(null);
        return candidate.prepareRuntime({ imageRef: IMAGE, env: { TOKEN: 'confidential-value' } });
      },
    });
    const admitted = await work.request({ type: 'RequestCandidatePreview', actionId: randomUUID(), sessionId, headSha: HEAD, startedStatus: 'active' });
    assert.equal(admitted.work.workflow, PREPARE_RUNTIME);
    const handler = work.handlers[PREPARE_RUNTIME];
    async function run() {
      await db.pool.query('UPDATE execution_work_requests SET due_at = clock_timestamp()');
      const [attempt] = await work.store.claim(randomUUID(), [PREPARE_RUNTIME], 1);
      try {
        const result = await handler.run({ attempt, signal: new AbortController().signal, checkpoint: value => work.store.checkpoint(attempt, value) });
        const settled = await work.store.settle(attempt, result, handler.commit);
        if (loss === 'completion reply' && !injected) { injected = true; throw new Error('Injected committed completion reply loss'); }
        return settled;
      } catch (error) {
        if (loss !== 'completion reply') await work.store.settle(attempt, { outcome: 'retry' });
        throw error;
      }
    }
    await assert.rejects(run(), /Injected/);
    if (loss !== 'completion reply') assert.equal((await run()).result.accepted, true);
    const state = await owner.read(sessionId);
    assert.equal(state.flow.state, 'candidate');
    assert.equal(state.preview.runtimeName, 'serving');
    assert.equal(state.binding, null);
    assert.deepEqual(api.creates, RESOURCE_KINDS);
    const traces = await owner.trace(sessionId);
    assert.equal(JSON.stringify(traces).includes('confidential-value'), false);
    for (const trace of traces) assert.deepEqual(replayDecision(trace), trace.decision);
  });
}
