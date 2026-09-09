'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

// Each node:test file runs in its own process, so these do not affect the
// existing single-domain compatibility tests.
process.env.USERNODE_DOMAIN = 'my.onhomeroom.com';
process.env.USERNODE_APPS_DOMAIN = 'onhomeroom.com';
const caddy = require('../src/services/caddy');
const access = require('../src/services/app-access');
const { isKnownHost } = require('../src/routes/internal');
const kubernetes = require('../src/services/kubernetes');

test('loaded Kubernetes config uses the app suffix independently of the platform', () => {
  const { execFileSync } = require('node:child_process');
  // No production secrets or network calls are needed to load a staging config.
  execFileSync(process.execPath, ['-e', `
    const assert = require('node:assert/strict');
    const { load } = require('./src/config');
    let cfg = load().kubernetes;
    assert.equal(cfg.appDomain, 'onhomeroom.com');
    assert.equal(cfg.platformDomain, 'my.onhomeroom.com');
    delete process.env.USERNODE_APPS_DOMAIN;
    cfg = load().kubernetes;
    assert.equal(cfg.appDomain, 'my.onhomeroom.com');
  `], { cwd: require('node:path').resolve(__dirname, '..'), env: {
    ...process.env, USERNODE_ENV: 'staging', DATABASE_URL: 'postgres://test:test@localhost/test',
    SESSION_SECRET: 'test-session-secret', ADMIN_USERNAME: 'test', ADMIN_PASSWORD: 'test',
  }, stdio: 'pipe' });
});

test('platform URLs remain separate from production and preview app hosts', () => {
  assert.equal(caddy.USERNODE_DOMAIN, 'my.onhomeroom.com');
  assert.equal(caddy.productionHostname('notes-123456'), 'notes-123456.onhomeroom.com');
  assert.equal(caddy.stagingHostname('notes-123456', 's42'), 'notes-123456--s42.onhomeroom.com');
});

test('app access accepts sibling app hosts but excludes the platform and unrelated domains', () => {
  assert.equal(access.parseAppHost('notes-123456.onhomeroom.com')?.slug, 'notes-123456');
  assert.equal(access.parseAppHost('NOTES-123456--s42.onhomeroom.com:443')?.slug, 'notes-123456');
  for (const host of ['my.onhomeroom.com', 'onhomeroom.com', 'notes.my.onhomeroom.com', 'notes.onhomeroom.com.evil.test']) {
    assert.equal(access.parseAppHost(host), null, host);
  }
});

test('known-host checks query app slugs on the app domain and retain the platform host', async () => {
  const queries = [];
  const pool = { async query(sql, params) {
    queries.push(params);
    return { rowCount: params[0] === 'notes-123456' ? 1 : 0 };
  } };
  assert.equal(await isKnownHost(pool, 'my.onhomeroom.com'), true);
  assert.equal(queries.length, 0);
  assert.equal(await isKnownHost(pool, 'notes-123456.onhomeroom.com'), true);
  assert.deepEqual(queries, [['notes-123456']]);
  assert.equal(await isKnownHost(pool, 'notes-123456.my.onhomeroom.com'), false);
});

test('platform hostname is reserved before app resource creation', async () => {
  assert.throws(() => caddy.productionHostname('my'), /conflicts with the platform/);
  // No clients are configured: the reservation must fail before API access.
  await assert.rejects(kubernetes.deployApplication({ kubernetes: {
    appDomain: 'onhomeroom.com', platformDomain: 'my.onhomeroom.com', appNamespace: 'social-apps',
  } }, {
    app: { id: 1, slug: 'my' }, environment: 'production', imageRef: 'example/app@sha256:abc', env: {},
  }), /conflicts with the platform/);
});

test('Kubernetes app and preview ingresses use sibling hosts with matching TLS', async (t) => {
  const ingresses = [];
  const missing = async () => { const err = new Error('not found'); err.code = 404; throw err; };
  kubernetes._setClientsForTest({
    core: {
      readNamespacedSecret: missing, readNamespacedService: missing,
      async createNamespacedSecret() {}, async createNamespacedService() {},
    },
    apps: {
      async readNamespacedDeployment() {
        return { metadata: { generation: 1, resourceVersion: '1' }, status: { observedGeneration: 1, availableReplicas: 1 } };
      },
      async replaceNamespacedDeployment() {},
    },
    networking: {
      readNamespacedIngress: missing,
      async createNamespacedIngress({ body }) { ingresses.push(body); },
    },
  });
  t.after(() => kubernetes._setClientsForTest(null));
  const cfg = { kubernetes: {
    appDomain: 'onhomeroom.com', platformDomain: 'my.onhomeroom.com', appNamespace: 'social-apps',
    ingressClassName: 'cilium', clusterIssuer: 'letsencrypt-public',
  } };
  for (const [environment, host] of [
    ['production', 'notes-123456.onhomeroom.com'],
    ['staging', 'notes-123456--s42.onhomeroom.com'],
  ]) {
    const deployed = await kubernetes.deployApplication(cfg, {
      app: { id: 1, slug: 'notes-123456' }, environment, sessionId: 42,
      imageRef: 'example/app@sha256:abc', env: {},
    });
    assert.equal(deployed.url, `https://${host}`);
    assert.equal(ingresses.at(-1).spec.rules[0].host, host);
    assert.deepEqual(ingresses.at(-1).spec.tls[0].hosts, [host]);
  }
});
