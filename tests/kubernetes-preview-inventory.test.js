// kubernetes.listPreviews: the Kubernetes side of the stale-preview sweep's
// inventory (src/services/staging-reap.js). The sweep tears down what this
// returns, so what it must NOT return matters as much as what it does:
// evidence replays share the staging label and a session id, and production
// app Deployments live in the same namespace.

const test = require('node:test');
const assert = require('node:assert/strict');
const kubernetes = require('../src/services/kubernetes');

const config = { kubernetes: { appNamespace: 'social-apps' } };

function deployment(name, labels, { ready = 1, image = `ghcr.io/example/app@sha256:${'b'.repeat(64)}` } = {}) {
  return {
    metadata: {
      name,
      generation: 1,
      labels: {
        'app.kubernetes.io/managed-by': 'social-vibecoding-runtime',
        'app.kubernetes.io/part-of': 'social-vibecoding',
        ...labels,
      },
    },
    spec: { replicas: 1, template: { spec: { containers: [{ name: 'app', image }] } } },
    status: {
      observedGeneration: 1, replicas: 1, updatedReplicas: 1, readyReplicas: ready, availableReplicas: ready,
      ...(ready ? {} : { unavailableReplicas: 1 }),
    },
  };
}

test('lists preview Deployments by name and session label, and nothing else', async (t) => {
  t.after(() => kubernetes._setClientsForTest(null));
  const calls = [];
  kubernetes._setClientsForTest({ apps: {
    listNamespacedDeployment: async (args) => {
      calls.push(args);
      return { items: [
        deployment('sv-preview-320-s3711', {
          'social.usernode.io/environment': 'staging', 'social.usernode.io/app-id': '320',
          'social.usernode.io/session-id': '3711', 'usernode.env.fp': '95534986733ce179',
        }),
        deployment('sv-preview-10-s5179', {
          'social.usernode.io/environment': 'staging', 'social.usernode.io/app-id': '10',
          'social.usernode.io/session-id': '5179',
        }, { ready: 0 }),
        // An evidence replay: same environment label and a session id, but it
        // belongs to the evidence runner.
        deployment('sv-evidence-c0b61036b089bd4b-h', {
          'social.usernode.io/environment': 'staging', 'social.usernode.io/session-id': '4716',
          'social.usernode.io/evidence-run': 'c0b61036b089bd4b',
        }),
        // A name that looks right with a label that disagrees is not trusted.
        deployment('sv-preview-1-s2', {
          'social.usernode.io/environment': 'staging', 'social.usernode.io/session-id': '3',
        }),
      ] };
    },
  } });

  const previews = await kubernetes.listPreviews(config);

  assert.equal(calls.length, 1);
  assert.equal(calls[0].namespace, 'social-apps');
  assert.equal(calls[0].labelSelector,
    'app.kubernetes.io/managed-by=social-vibecoding-runtime,social.usernode.io/environment=staging');
  assert.deepEqual(previews.map((p) => [p.name, p.appId, p.sessionId, p.state]), [
    ['sv-preview-320-s3711', 320, 3711, 'running'],
    ['sv-preview-10-s5179', 10, 5179, 'restarting'],
  ]);
  assert.equal(previews[0].labels['usernode.env.fp'], '95534986733ce179');
  assert.match(previews[0].image, /@sha256:/);
});

test('the name pattern is the one appResourceName builds for a preview', () => {
  const name = kubernetes.appResourceName({ id: 1959, slug: 'whatever-abc123' }, 'staging', 6021);
  assert.equal(name, 'sv-preview-1959-s6021');
});

test('an empty or malformed list is an empty inventory', async (t) => {
  t.after(() => kubernetes._setClientsForTest(null));
  kubernetes._setClientsForTest({ apps: { listNamespacedDeployment: async () => ({}) } });
  assert.deepEqual(await kubernetes.listPreviews(config), []);
});

function routing(name, extra = {}) {
  const match = /^sv-preview-(\d+)-s(\d+)$/.exec(name);
  return { metadata: { name, uid: `uid-${name}`, resourceVersion: '7', labels: {
    'app.kubernetes.io/managed-by': 'social-vibecoding-runtime',
    'social.usernode.io/environment': 'staging',
    'social.usernode.io/app-id': match?.[1], 'social.usernode.io/session-id': match?.[2], ...extra,
  } } };
}

function cleanupClients({ deployments = [], services = [], ingresses = [] } = {}) {
  return {
    apps: { listNamespacedDeployment: async () => ({ items: deployments }) },
    core: { listNamespacedService: async () => ({ items: services }) },
    networking: { listNamespacedIngress: async () => ({ items: ingresses }) },
  };
}

test('cleanup finds routing pairs and single-resource remnants, once per preview, without changing runtime inventory', async (t) => {
  t.after(() => kubernetes._setClientsForTest(null));
  const live = deployment('sv-preview-1-s2', routing('sv-preview-1-s2').metadata.labels);
  kubernetes._setClientsForTest(cleanupClients({ deployments: [live],
    services: [routing('sv-preview-1-s2'), routing('sv-preview-3-s4'), routing('sv-preview-5-s6')],
    ingresses: [routing('sv-preview-1-s2'), routing('sv-preview-3-s4'), routing('sv-preview-7-s8')],
  }));

  const previews = await kubernetes.listPreviewResources(config);

  assert.deepEqual(previews.map((p) => [p.name, p.state]), [
    ['sv-preview-1-s2', 'running'], ['sv-preview-3-s4', 'not_found'],
    ['sv-preview-5-s6', 'not_found'], ['sv-preview-7-s8', 'not_found'],
  ]);
  assert.equal(previews[0].routingResources, undefined, 'a Deployment keeps its existing retirement path');
  assert.deepEqual(previews[1].routingResources.map((r) => r.kind), ['service', 'ingress']);
  assert.equal(previews[1].routingResources[0].metadata.resourceVersion, '7');
  assert.deepEqual([previews[1].appId, previews[1].sessionId], [3, 4]);
  assert.deepEqual((await kubernetes.listPreviews(config)).map((p) => p.name), ['sv-preview-1-s2'],
    'a leftover Service is not reported as a running or recoverable Deployment');
});

test('cleanup rejects unrelated routing objects and mismatched ownership labels', async (t) => {
  t.after(() => kubernetes._setClientsForTest(null));
  const services = [
    routing('sv-app-1-demo'), routing('sv-evidence-a-h'), routing('sv-preview-1-s2', { 'social.usernode.io/session-id': '3' }),
    routing('sv-preview-1-s2', { 'social.usernode.io/app-id': '99' }),
    routing('sv-preview-1-s2', { 'social.usernode.io/environment': 'production' }),
    routing('sv-preview-1-s2', { 'app.kubernetes.io/managed-by': 'somebody-else' }),
    routing('sv-preview-1-s2', { 'social.usernode.io/evidence-run': 'evidence' }),
    routing('sv-preview-1-s2', { 'social.usernode.io/shots-run': 'shots' }),
    routing('sv-preview-0-s2'), routing('sv-preview-1-s0'),
  ];
  kubernetes._setClientsForTest(cleanupClients({ services, ingresses: services }));
  assert.deepEqual(await kubernetes.listPreviewResources(config), []);
});

test('cleanup follows routing-list continuation tokens with the managed-preview selector', async (t) => {
  t.after(() => kubernetes._setClientsForTest(null));
  const clients = cleanupClients();
  const calls = [];
  clients.core.listNamespacedService = async (args) => {
    calls.push(args);
    return args._continue ? { items: [routing('sv-preview-3-s4')] }
      : { items: [routing('sv-preview-1-s2')], metadata: { continue: 'next-page' } };
  };
  kubernetes._setClientsForTest(clients);
  assert.equal((await kubernetes.listPreviewResources(config)).length, 2);
  assert.equal(calls[1]._continue, 'next-page');
  assert.ok(calls.every((c) => c.namespace === 'social-apps' && c.limit === 500
    && c.labelSelector === 'app.kubernetes.io/managed-by=social-vibecoding-runtime,social.usernode.io/environment=staging'));
});

test('an unreadable or malformed cleanup list aborts inventory instead of returning a partial fleet', async (t) => {
  t.after(() => kubernetes._setClientsForTest(null));
  for (const [api, method] of [['apps', 'listNamespacedDeployment'], ['core', 'listNamespacedService'], ['networking', 'listNamespacedIngress']]) {
    const clients = cleanupClients({ services: [routing('sv-preview-1-s2')] });
    clients[api][method] = async () => { throw new Error('forbidden'); };
    kubernetes._setClientsForTest(clients);
    await assert.rejects(kubernetes.listPreviewResources(config), /forbidden/);
    clients[api][method] = async () => ({});
    await assert.rejects(kubernetes.listPreviewResources(config), /Invalid .* preview inventory/);
  }
});

test('routing deletion is fenced by the inventoried UID and resourceVersion and tolerates an already absent object', async (t) => {
  t.after(() => kubernetes._setClientsForTest(null));
  const metadata = routing('sv-preview-1-s2').metadata;
  const calls = [];
  const remove = async (args) => { calls.push(args); };
  kubernetes._setClientsForTest({ core: { deleteNamespacedService: remove }, networking: { deleteNamespacedIngress: remove } });
  await kubernetes.deletePreviewRoutingResource(config, 'service', metadata);
  await kubernetes.deletePreviewRoutingResource(config, 'ingress', metadata);
  assert.deepEqual(calls, [0, 1].map(() => ({ name: metadata.name, namespace: 'social-apps',
    body: { preconditions: { uid: metadata.uid, resourceVersion: '7' } } })));
  kubernetes._setClientsForTest({ core: { deleteNamespacedService: async () => { throw Object.assign(new Error('gone'), { code: 404 }); } } });
  await kubernetes.deletePreviewRoutingResource(config, 'service', metadata);
});

test('routing replaced or updated after inventory survives cleanup', async (t) => {
  t.after(() => kubernetes._setClientsForTest(null));
  for (const change of [{ uid: 'successor' }, { resourceVersion: '8' }]) {
    const metadata = routing('sv-preview-1-s2').metadata;
    const current = { ...metadata, ...change };
    let deleted = false;
    const remove = async ({ body }) => {
      if (body.preconditions.uid !== current.uid || body.preconditions.resourceVersion !== current.resourceVersion) {
        throw Object.assign(new Error('precondition'), { code: 409 });
      }
      deleted = true;
    };
    kubernetes._setClientsForTest({ core: { deleteNamespacedService: remove } });
    await assert.rejects(kubernetes.deletePreviewRoutingResource(config, 'service', metadata), /precondition/);
    assert.equal(deleted, false);
  }
});

test('routing deletion refuses missing identities, foreign objects and unsupported resource kinds', async (t) => {
  t.after(() => kubernetes._setClientsForTest(null));
  let deleted = false;
  kubernetes._setClientsForTest({ core: { deleteNamespacedService: async () => { deleted = true; } }, networking: {} });
  const metadata = routing('sv-preview-1-s2').metadata;
  await assert.rejects(kubernetes.deletePreviewRoutingResource(config, 'service', { ...metadata, uid: null }), /requires matching/);
  await assert.rejects(kubernetes.deletePreviewRoutingResource(config, 'service', routing('sv-preview-1-s2', { 'social.usernode.io/session-id': '3' }).metadata), /requires matching/);
  await assert.rejects(kubernetes.deletePreviewRoutingResource(config, 'deployment', metadata), /Unknown preview routing kind/);
  assert.equal(deleted, false);
});
