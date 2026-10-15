'use strict';

// Custom domains on Kubernetes (#4405, services/kubernetes.js): a project's
// own hostname gets a SECOND Ingress, `sv-domain-<id>`, beside the app's
// own. It routes the custom host the way the app's Ingress routes the
// Homeroom one (asset prefixes to the shared asset backend, the catch-all
// through the gate or to the app's Service) and, unlike the app's, asks
// cert-manager for a certificate of its own in a Secret that goes with it.
// The app's Ingress and the shared wildcard Secret are never touched.
//
// Run with: node --test tests/kubernetes-custom-domain.test.js

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
      [`listNamespaced${kind}`, async () => ({ items: [...objects.entries()].filter(([k]) => k.startsWith(`${kind}/`)).map(([, v]) => structuredClone(v)) })],
    ];
  }));
  kubernetes._setClientsForTest({ core: api(['Secret', 'Service']), apps: api(['Deployment']), networking: api(['Ingress']) });
  return { objects, mutations };
}

const CFG = { appNamespace: 'apps', appDomain: 'onhomeroom.com', platformDomain: 'app.onhomeroom.com', ingressClassName: 'cilium', clusterIssuer: 'letsencrypt-public' };
const APP = { id: 10, slug: 'bread-bot-3e3f5c', runtime_name: 'sv-app-10-bread-bot-3e3f5c' };
const DOMAIN = { id: 7, hostname: 'app.example.com' };

test('the manifest: the custom host, the asset prefixes, the app’s Service, and a certificate of its own', () => {
  const ingress = kubernetes.customDomainIngressManifest({
    domain: DOMAIN, app: APP, namespace: 'apps', cfg: CFG, assetBackend: { name: 'usernode-platform-assets' },
  });
  assert.equal(ingress.metadata.name, 'sv-domain-7');
  assert.equal(ingress.metadata.labels['app.kubernetes.io/managed-by'], 'social-vibecoding-runtime', 'managed, so the gate and asset reconciles include it');
  assert.equal(ingress.metadata.labels['social.usernode.io/app-id'], '10');
  assert.equal(ingress.metadata.labels['social.usernode.io/domain-id'], '7');
  assert.deepEqual(ingress.metadata.annotations, {
    'cert-manager.io/cluster-issuer': 'letsencrypt-public',
    [kubernetes.CUSTOM_DOMAIN_SERVICE_ANNOTATION]: 'sv-app-10-bread-bot-3e3f5c',
  });
  assert.equal(ingress.spec.ingressClassName, 'cilium');
  assert.deepEqual(ingress.spec.rules.map((r) => r.host), ['app.example.com']);
  const paths = ingress.spec.rules[0].http.paths;
  assert.deepEqual(paths.map((p) => p.path), ['/usernode-bridge/', '/usernode-native/', '/usernode-tailwind/', '/']);
  assert.ok(paths.slice(0, 3).every((p) => p.backend.service.name === 'usernode-platform-assets'));
  assert.equal(paths[3].backend.service.name, 'sv-app-10-bread-bot-3e3f5c');
  assert.deepEqual(ingress.spec.tls, [{ hosts: ['app.example.com'], secretName: 'sv-domain-7-tls' }]);
});

test('with the gate on, the catch-all goes through it; the Service name stays in the annotation', () => {
  const ingress = kubernetes.customDomainIngressManifest({
    domain: DOMAIN, app: APP, namespace: 'apps', cfg: CFG, assetBackend: null, gateBackend: kubernetes.APP_GATE_NAME,
  });
  assert.deepEqual(ingress.spec.rules[0].http.paths.map((p) => [p.path, p.backend.service.name]),
    [['/', kubernetes.APP_GATE_NAME]]);
  assert.equal(ingress.metadata.annotations[kubernetes.CUSTOM_DOMAIN_SERVICE_ANNOTATION], 'sv-app-10-bread-bot-3e3f5c');
  // The gate switch repoints it the way it repoints an app's own Ingress.
  const off = kubernetes._ingressWithGateRouteForTest(ingress, 'off');
  assert.equal(off.spec.rules[0].http.paths[0].backend.service.name, 'sv-app-10-bread-bot-3e3f5c');
  const on = kubernetes._ingressWithGateRouteForTest(off, 'on');
  assert.equal(on.spec.rules[0].http.paths[0].backend.service.name, kubernetes.APP_GATE_NAME);
  assert.equal(kubernetes._ingressWithGateRouteForTest(on, 'on'), null, 'nothing to change');
});

test('an app without a stored runtime name is routed to the name it would be given', () => {
  const ingress = kubernetes.customDomainIngressManifest({
    domain: DOMAIN, app: { id: 10, slug: 'bread-bot-3e3f5c' }, namespace: 'apps', cfg: CFG, assetBackend: null,
  });
  assert.equal(ingress.spec.rules[0].http.paths[0].backend.service.name, 'sv-app-10-bread-bot-3e3f5c');
});

test('deploying a domain writes its Ingress and leaves the app’s Ingress and the wildcard Secret alone', async () => {
  const { objects, mutations } = cluster();
  const config = { kubernetes: { ...CFG, appTlsSecretName: 'social-apps-wildcard-tls' } };
  objects.set('Secret/social-apps-wildcard-tls', { retained: 'shared certificate' });
  await kubernetes.deployApplication(config, {
    app: APP, environment: 'production', imageRef: 'registry/app@sha256:deadbeef', env: {},
  });
  mutations.length = 0;
  await kubernetes.deployCustomDomain(config, { app: APP, domain: DOMAIN });
  const ingress = objects.get('Ingress/sv-domain-7');
  assert.ok(ingress, 'the domain Ingress');
  assert.equal(ingress.spec.rules[0].host, 'app.example.com');
  assert.equal(ingress.metadata.annotations['cert-manager.io/cluster-issuer'], 'letsencrypt-public');
  const own = objects.get('Ingress/sv-app-10-bread-bot-3e3f5c');
  assert.deepEqual(own.metadata.annotations, {}, 'the app’s own Ingress still asks for no certificate');
  assert.deepEqual(own.spec.tls, [{ hosts: ['bread-bot-3e3f5c.onhomeroom.com'], secretName: 'social-apps-wildcard-tls' }]);
  assert.deepEqual(objects.get('Secret/social-apps-wildcard-tls'), { retained: 'shared certificate' });
  assert.ok(mutations.every((k) => k === 'Ingress/sv-domain-7' || k.startsWith('Deployment/usernode-platform-assets') || k.includes('usernode-platform-assets')),
    `only the domain Ingress (and the shared asset backend) moved: ${mutations.join(', ')}`);
  // Upserting again replaces rather than duplicating.
  await kubernetes.deployCustomDomain(config, { app: APP, domain: DOMAIN });
  assert.equal([...objects.keys()].filter((k) => k.startsWith('Ingress/sv-domain-')).length, 1);
});

test('removing a domain deletes its Ingress and its certificate Secret, and nothing else', async () => {
  const { objects } = cluster();
  const config = { kubernetes: CFG };
  await kubernetes.deployCustomDomain(config, { app: APP, domain: DOMAIN });
  objects.set('Secret/sv-domain-7-tls', { issued: 'by cert-manager' });
  objects.set('Secret/social-apps-wildcard-tls', { retained: 'shared certificate' });
  objects.set('Ingress/sv-app-10-bread-bot-3e3f5c', { metadata: { name: 'sv-app-10-bread-bot-3e3f5c' } });
  await kubernetes.deleteCustomDomain(config, { domain: DOMAIN });
  assert.ok(!objects.has('Ingress/sv-domain-7'));
  assert.ok(!objects.has('Secret/sv-domain-7-tls'));
  assert.ok(objects.has('Secret/social-apps-wildcard-tls'));
  assert.ok(objects.has('Ingress/sv-app-10-bread-bot-3e3f5c'));
  // Gone already is fine.
  await kubernetes.deleteCustomDomain(config, { domain: DOMAIN });
});

test('a hostname that is the platform’s own, or not a hostname, is refused before anything is written', async () => {
  const { objects } = cluster();
  const config = { kubernetes: CFG };
  await assert.rejects(kubernetes.deployCustomDomain(config, { app: APP, domain: { id: 8, hostname: 'app.onhomeroom.com' } }), /conflicts/);
  await assert.rejects(kubernetes.deployCustomDomain(config, { app: APP, domain: { id: 9, hostname: 'bad host' } }), /Invalid/);
  assert.equal([...objects.keys()].filter((k) => k.startsWith('Ingress/')).length, 0);
});
