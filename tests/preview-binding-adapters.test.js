'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { randomUUID } = require('node:crypto');
const { createBindingAdapters } = require('../src/services/preview-flow/binding-adapters');
const { removeCandidate, verifyCandidate, removeCandidateImage } = require('../src/services/preview-flow/candidate-runtime');
const { candidateResources } = require('../src/services/preview-flow/candidate-resources');
const { FLOW_LABEL } = require('../src/services/preview-flow/cleanup');
const runtime = require('../src/services/application-runtime');
const docker = require('../src/services/docker');
const kubernetes = require('../src/services/kubernetes');

function deferred() {
  let resolve;
  const promise = new Promise(r => { resolve = r; });
  return { promise, resolve };
}

function notFound() {
  return Object.assign(new Error('Not found'), { code: 404 });
}

test('Docker: conditional route updates reject delayed activation after a successor and preserve other routes', async () => {
  let version = 1;
  const previewMap = {
    handler: 'map',
    source: '{http.request.host}',
    destinations: ['{upstream}', '{applink}'],
    mappings: [
      { input: 'other.example.test', outputs: ['other-serving', 'other-link'] },
      { input_regexp: '^demo\\.example\\.test$', outputs: ['old-serving', ''] },
    ],
  };
  let config = { handle: [previewMap] };
  const writeEntered = deferred();
  const releaseWrite = deferred();
  let delayFirstWrite = true;
  const routes = createBindingAdapters({ admin: async (_config, body, expected) => {
    if (!body) return { body: structuredClone(config), token: String(version) };
    if (delayFirstWrite) {
      delayFirstWrite = false;
      writeEntered.resolve();
      await releaseWrite.promise;
    }
    if (expected !== String(version)) throw new Error('412 precondition failed');
    config = structuredClone(body);
    version++;
  } });
  const ref = { runtimeKind: 'docker', hostname: 'demo.example.test', legacyTarget: 'old-serving' };
  const expected = await routes.inspect({}, ref);
  const stale = routes.activate({}, ref, expected, { runtimeName: 'candidate-a' });
  await writeEntered.promise;
  await routes.activate({}, ref, expected, { runtimeName: 'candidate-b' });
  releaseWrite.resolve();
  await assert.rejects(stale, /412/);
  assert.equal((await routes.inspect({}, ref)).target, 'candidate-b');
  const mappings = config.handle[0].mappings;
  assert.deepEqual(mappings[1], { input: 'other.example.test', outputs: ['other-serving', 'other-link'] });
  assert.equal(mappings[2].input_regexp, '^demo\\.example\\.test$');
});

test('Kubernetes: resource-version CAS rejects delayed activation and preserves asset routes, annotations and TLS', async () => {
  let ingress = kubernetes.appIngressManifest({
    name: 'stable', namespace: 'apps', hostname: 'demo.example.test', resourceLabels: {},
    cfg: { appTlsSecretName: 'shared-certificate' }, assetBackend: true,
  });
  ingress.metadata.uid = 'ingress-physical';
  ingress.metadata.resourceVersion = '1';
  ingress.metadata.annotations = { 'installation-owned': 'retained' };
  const original = structuredClone(ingress);
  const writeEntered = deferred();
  const releaseWrite = deferred();
  let delayFirstWrite = true;
  const networking = {
    readNamespacedIngress: async () => structuredClone(ingress),
    replaceNamespacedIngress: async ({ body }) => {
      if (delayFirstWrite) {
        delayFirstWrite = false;
        writeEntered.resolve();
        await releaseWrite.promise;
      }
      if (body.metadata.resourceVersion !== ingress.metadata.resourceVersion || body.metadata.uid !== ingress.metadata.uid) {
        throw new Error('409 conflict');
      }
      ingress = structuredClone(body);
      ingress.metadata.resourceVersion = String(Number(ingress.metadata.resourceVersion) + 1);
    },
  };
  const routes = createBindingAdapters({ clients: () => ({ networking }) });
  const ref = { runtimeKind: 'kubernetes', runtimeName: 'stable', namespace: 'apps', hostname: 'demo.example.test' };
  const expected = await routes.inspect({}, ref);
  const stale = routes.activate({}, ref, expected, { runtimeName: 'candidate-a' });
  await writeEntered.promise;
  await routes.activate({}, ref, expected, { runtimeName: 'candidate-b' });
  releaseWrite.resolve();
  await assert.rejects(stale, /409/);
  assert.equal((await routes.inspect({}, ref)).target, 'candidate-b');
  assert.deepEqual(ingress.spec.tls, original.spec.tls);
  assert.deepEqual(ingress.metadata.annotations, original.metadata.annotations);
  assert.deepEqual(ingress.spec.rules[0].http.paths.slice(0, -1), original.spec.rules[0].http.paths.slice(0, -1));
  ingress.metadata.uid = 'replacement-physical';
  await assert.rejects(routes.activate({}, ref, expected, { runtimeName: 'candidate-a' }), /changed/);
});

test('Kubernetes: first activation is create-on-absence, retains shared assets and does not overwrite a competing route', async t => {
  let current;
  t.mock.method(kubernetes, 'ensurePlatformAssetBackend', async () => ({ name: 'platform-assets' }));
  const networking = {
    readNamespacedIngress: async () => { if (!current) throw notFound(); return structuredClone(current); },
    createNamespacedIngress: async ({ body }) => {
      if (current) throw new Error('409 already exists');
      current = { ...structuredClone(body), metadata: { ...body.metadata, uid: 'uid', resourceVersion: '1' } };
    },
  };
  const routes = createBindingAdapters({ clients: () => ({ networking }) });
  const ref = { runtimeKind: 'kubernetes', runtimeName: 'stable', appSlug: 'demo', appId: 1, sessionId: 1,
    namespace: 'apps', hostname: 'demo.example.test' };
  const config = { selfAppSlug: 'homeroom', kubernetes: { appTlsSecretName: 'shared-tls' } };
  const expected = await routes.inspect(config, ref);
  await routes.activate(config, ref, expected, { runtimeName: 'candidate-a' });
  assert.equal(current.spec.rules[0].http.paths.at(-1).backend.service.name, 'candidate-a');
  assert.ok(current.spec.rules[0].http.paths.length > 1);
  assert.equal(current.spec.tls[0].secretName, 'shared-tls');
  await assert.rejects(routes.activate(config, ref, expected, { runtimeName: 'candidate-b' }), /409/);
  assert.equal((await routes.inspect(config, ref)).target, 'candidate-a');
});

for (const runtimeKind of ['docker', 'kubernetes']) {
  test(`${runtimeKind}: create-only preparation does not remove or replace an existing candidate`, async t => {
    const config = { appRuntime: runtimeKind, kubernetes: { appNamespace: 'apps', appDomain: 'example.test' } };
    const options = {
      app: { id: 1, slug: 'demo' }, environment: 'staging', sessionId: 1,
      imageRef: 'registry/image@sha256:deadbeef', env: {}, runtimeName: 'candidate',
      internalOnly: true, createOnly: true,
    };
    let writes = 0;
    let deletes = 0;
    t.mock.method(docker, 'stopAndRemove', async () => { deletes++; });
    t.mock.method(docker, 'runContainer', async (_name, options) => {
      assert.equal(options.replaceExisting, false);
      writes++;
      throw new Error('409 already exists');
    });
    t.mock.method(kubernetes, '_getClients', () => ({}));
    kubernetes._setClientsForTest({
      core: { createNamespacedSecret: async () => { writes++; throw new Error('409 already exists'); } },
      apps: {}, networking: {},
    });
    try {
      await assert.rejects(runtime.deploy(config, options), /409/);
      assert.equal(writes, 1);
      assert.equal(deletes, 0);
    } finally {
      kubernetes._setClientsForTest(null);
    }
  });

  test(`${runtimeKind}: activation verifies physical identity and health; cleanup protects a replacement`, async t => {
    const config = { appRuntime: runtimeKind, kubernetes: { appNamespace: 'apps' } };
    const intent = candidateResources(config, 1, randomUUID());
    const flowId = randomUUID();
    const receipt = { attemptId: intent.attemptId, runtimeName: intent.runtimeName, physicalId: 'original' };
    let uid = 'original';
    let healthy = true;
    let deletes = 0;
    t.mock.method(runtime, 'probeHealth', async () => healthy);
    t.mock.method(docker, 'execFileAsync', async () => ({ stdout: JSON.stringify({
      Id: uid, Config: { Labels: { [FLOW_LABEL]: flowId } },
    }) }));
    t.mock.method(docker, 'stopAndRemove', async () => { deletes++; return { removed: true }; });
    t.mock.method(kubernetes, '_getClients', () => ({
      apps: { readNamespacedDeployment: async () => ({ metadata: { uid, labels: { [FLOW_LABEL]: flowId } } }) },
      core: {},
    }));
    await verifyCandidate(config, intent, flowId, receipt);
    healthy = false;
    await assert.rejects(verifyCandidate(config, intent, flowId, receipt), /healthy/);
    healthy = true;
    uid = 'successor';
    await assert.rejects(verifyCandidate(config, intent, flowId, receipt), /identity/);
    await assert.rejects(removeCandidate(config, intent, flowId, receipt), /identity|ownership/);
    assert.equal(deletes, 0);
  });
}

test('Docker: delayed removal by physical ID cannot delete a successor that reused the name', async t => {
  const flowId = randomUUID();
  let named = 'old-id';
  t.mock.method(docker, 'execFileAsync', async () => ({ stdout: JSON.stringify({
    Id: named, Config: { Labels: { [FLOW_LABEL]: flowId } },
  }) }));
  t.mock.method(docker, 'stopAndRemove', async uid => {
    named = 'new-id';
    assert.equal(uid, 'old-id');
    return { removed: true };
  });
  await removeCandidate({}, { runtimeKind: 'docker', runtimeName: 'candidate' }, flowId, { physicalId: 'old-id' });
  assert.equal(named, 'new-id');
});

test('Kubernetes: UID preconditions contain a replacement between cleanup observation and deletion', async t => {
  const flowId = randomUUID();
  let uid = 'old-uid';
  const core = {};
  const apps = {};
  for (const [api, kind] of [[apps, 'Deployment'], [core, 'Service'], [core, 'Secret']]) {
    api[`readNamespaced${kind}`] = async () => ({ metadata: { uid, labels: { [FLOW_LABEL]: flowId } } });
    api[`deleteNamespaced${kind}`] = async ({ body }) => {
      uid = 'successor-uid';
      if (body.preconditions.uid !== uid) throw new Error('409 UID precondition failed');
      assert.fail('A stale delete must never be accepted');
    };
  }
  t.mock.method(kubernetes, '_getClients', () => ({ core, apps }));
  await assert.rejects(removeCandidate({}, { runtimeKind: 'kubernetes', runtimeName: 'candidate', namespace: 'apps' },
    flowId, { physicalId: 'old-uid' }), /409/);
  assert.equal(uid, 'successor-uid');
});

test('Docker: image cleanup removes only the reserved attempt tag without force; uncertain removal retries', async t => {
  const commands = [];
  let failure;
  t.mock.method(docker, 'execFileAsync', async (_command, args) => {
    commands.push(args);
    if (failure) throw failure;
    return { stdout: '' };
  });
  const intent = { runtimeKind: 'docker', imageName: 'usernode-preview-attempt:unique' };
  await removeCandidateImage(intent);
  assert.deepEqual(commands[0], ['image', 'rm', intent.imageName]);
  failure = new Error('Image still referenced');
  await assert.rejects(removeCandidateImage(intent), /referenced/);
  failure = new Error('No such image');
  await removeCandidateImage(intent);
});

test('Docker: inspect expands the existing numbered staging capture and blocks unrecognized routing', async () => {
  const { caddyTarget } = require('../src/services/preview-flow/binding-adapters');
  const map = {
    destinations: ['{upstream}', '{applink}'],
    mappings: [{
      input_regexp: '^([a-z0-9-]+?)--s(\\d+)(?:--[a-z0-9]+)?\\.',
      outputs: ['usernode-staging-s${2}', ''],
    }],
  };
  assert.equal(caddyTarget(map, 'demo--s42.example.test'), 'usernode-staging-s42');
  assert.throws(() => caddyTarget(map, 'unrecognized.example.test'), /no recognized route/);
  map.mappings[0].outputs[0] = '{unsupported-placeholder}';
  assert.throws(() => caddyTarget(map, 'demo--s42.example.test'), /unrecognized/);
});

test('runtime build adapter forwards both progress reporting and attempt identity to Kubernetes', async t => {
  const attemptId = randomUUID();
  const onProgress = () => {};
  let forwarded;
  t.mock.method(kubernetes, 'createBuild', async (_config, params) => {
    forwarded = params;
    return { imageRef: 'image:exact' };
  });
  await runtime.build({ appRuntime: 'kubernetes' }, {
    app: { id: 1 }, revision: 'a'.repeat(40), environment: 'staging',
    sessionId: 1, sourceDir: '/tmp/test-tree', attemptId, onProgress,
  });
  assert.equal(forwarded.attemptId, attemptId);
  assert.equal(forwarded.onProgress, onProgress);
});

test('candidate names retain the full attempt identity within database and role limits', () => {
  const attemptId = randomUUID();
  const intent = candidateResources({}, 2147483647, attemptId);
  assert.ok(intent.dbName.endsWith(attemptId.replace(/-/g, '')));
  assert.ok(intent.dbName.length <= 63);
  assert.ok(require('../src/services/db-manager').ownerRoleName(intent.dbName).length <= 63);
  assert.throws(() => candidateResources({}, 0, attemptId));
});
