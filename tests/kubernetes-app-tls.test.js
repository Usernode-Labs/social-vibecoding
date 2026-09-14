const test = require('node:test');
const assert = require('node:assert/strict');
const kubernetes = require('../src/services/kubernetes');

test.afterEach(() => kubernetes._setClientsForTest(null));

function cluster() {
  const objects = new Map();
  const mutations = [];
  const api = (kinds) => Object.fromEntries(kinds.flatMap(kind => {
    const key = (name) => `${kind}/${name}`;
    const write = async ({ body }) => {
      const saved = structuredClone(body);
      saved.metadata.resourceVersion = '1';
      if (kind === 'Deployment') {
        saved.metadata.generation = 1;
        saved.status = { observedGeneration: 1, replicas: 1, updatedReplicas: 1, readyReplicas: 1, availableReplicas: 1 };
      }
      objects.set(key(body.metadata.name), saved);
      mutations.push(key(body.metadata.name));
      return saved;
    };
    return [
      [`readNamespaced${kind}`, async ({ name }) => {
        if (!objects.has(key(name))) throw Object.assign(new Error('missing'), { code: 404 });
        return structuredClone(objects.get(key(name)));
      }],
      [`createNamespaced${kind}`, write], [`replaceNamespaced${kind}`, write],
      [`deleteNamespaced${kind}`, async ({ name }) => { objects.delete(key(name)); mutations.push(key(name)); }],
    ];
  }));
  kubernetes._setClientsForTest({ core: api(['Secret', 'Service']), apps: api(['Deployment']), networking: api(['Ingress']) });
  return { objects, mutations };
}

for (const secretName of ['social-apps-wildcard-tls', 'custom-domain-tls']) {
  test(`apps and rebuilt previews reuse ${secretName} without touching TLS material`, async () => {
    const { objects, mutations } = cluster();
    const config = { kubernetes: { appNamespace: 'apps', appDomain: 'onhomeroom.com', appTlsSecretName: secretName } };
    const app = { id: 10, slug: 'usernode-2d5619' };
    const deploy = (environment, sessionId) => kubernetes.deployApplication(config, {
      app, environment, sessionId, imageRef: 'registry/app@sha256:deadbeef', env: {},
    });
    objects.set(`Secret/${secretName}`, { retained: 'shared certificate' });
    objects.set('Secret/sv-preview-10-s4017-tls', { retained: 'legacy certificate' });
    await deploy('production');
    const preview = await deploy('staging', 4017);
    await kubernetes.deleteApplication(config, preview.runtimeName);
    await deploy('staging', 4017);
    await deploy('staging', 4018);
    const ingresses = [...objects.entries()].filter(([key]) => key.startsWith('Ingress/')).map(([, value]) => value);
    assert.equal(ingresses.length, 3);
    for (const ingress of ingresses) {
      assert.deepEqual(ingress.metadata.annotations, {});
      assert.deepEqual(ingress.spec.tls, [{ hosts: [ingress.spec.rules[0].host], secretName }]);
    }
    assert.deepEqual(objects.get(`Secret/${secretName}`), { retained: 'shared certificate' });
    assert.deepEqual(objects.get('Secret/sv-preview-10-s4017-tls'), { retained: 'legacy certificate' });
    assert.ok(mutations.filter(key => key.startsWith('Secret/')).every(key => key.endsWith('-env')));
  });
}

test('reconciling a legacy Ingress removes issuance annotations and preserves its route', async () => {
  const { objects } = cluster();
  objects.set('Ingress/sv-app-10-demo', {
    metadata: { name: 'sv-app-10-demo', resourceVersion: '1', annotations: {
      'cert-manager.io/cluster-issuer': 'letsencrypt-public', 'kubernetes.io/tls-acme': 'true',
    } },
    spec: { tls: [{ hosts: ['demo.onhomeroom.com'], secretName: 'sv-app-10-demo-tls' }] },
  });
  await kubernetes.deployApplication({ kubernetes: { appNamespace: 'apps', appDomain: 'onhomeroom.com' } }, {
    app: { id: 10, slug: 'demo' }, environment: 'production', imageRef: 'registry/app@sha256:deadbeef', env: {},
  });
  const ingress = objects.get('Ingress/sv-app-10-demo');
  assert.deepEqual(ingress.metadata.annotations, {});
  assert.equal(ingress.spec.rules[0].host, 'demo.onhomeroom.com');
  assert.equal(ingress.spec.tls[0].secretName, 'social-apps-wildcard-tls');
});
