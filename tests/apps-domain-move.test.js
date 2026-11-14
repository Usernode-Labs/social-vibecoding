'use strict';

// Moving apps and previews to another domain (services/apps-domain-move.js):
// production app Ingresses move on release, previews keep serving at the old
// domain until their next build, the gate and the waking page still know
// them there, and custom domains whose CNAME points at an app's old address
// keep passing.
//
// Run with: node --test tests/apps-domain-move.test.js

// Each node:test file runs in its own process: these are read once at load.
process.env.USERNODE_DOMAIN = 'app.example.com';
process.env.USERNODE_APPS_DOMAIN = 'example.app';
process.env.USERNODE_LEGACY_APPS_DOMAIN = 'example.com';

const test = require('node:test');
const assert = require('node:assert/strict');
const { execFileSync, spawnSync } = require('node:child_process');
const move = require('../src/services/apps-domain-move');
const kubernetes = require('../src/services/kubernetes');
const caddy = require('../src/services/caddy');
const access = require('../src/services/app-access');
const domains = require('../src/services/app-domains');

const MANAGED = 'social-vibecoding-runtime';

function ingress(name, host, labels = {}) {
  return {
    metadata: { name, labels: { 'app.kubernetes.io/managed-by': MANAGED, ...labels } },
    spec: {
      rules: [{ host, http: { paths: [{ path: '/', pathType: 'Prefix', backend: { service: { name: 'usernode-app-gate', port: { number: 3000 } } } }] } }],
      tls: [{ hosts: [host], secretName: 'social-apps-wildcard-tls' }],
    },
  };
}

test('the setting is empty unless it names another domain, and startup refuses a bad one', () => {
  const env = { USERNODE_DOMAIN: 'app.example.com', USERNODE_APPS_DOMAIN: 'example.app' };
  assert.equal(move.legacyAppsDomain(env), '');
  assert.equal(move.legacyAppsDomain({ ...env, USERNODE_LEGACY_APPS_DOMAIN: 'Example.COM.' }), 'example.com');
  assert.equal(move.legacyAppsDomain({ ...env, USERNODE_LEGACY_APPS_DOMAIN: 'example.app' }), '');
  assert.equal(move.validateLegacyAppsDomain(env), '');
  assert.equal(move.validateLegacyAppsDomain({ ...env, USERNODE_LEGACY_APPS_DOMAIN: 'example.com' }), 'example.com');
  for (const [value, message] of [
    ['https://example.com', /domain name/], ['example.com:443', /domain name/], ['*.example.com', /domain name/],
    ['example.app', /differ from USERNODE_APPS_DOMAIN/], ['app.example.com', /platform host/],
  ]) {
    assert.throws(() => move.validateLegacyAppsDomain({ ...env, USERNODE_LEGACY_APPS_DOMAIN: value }), message, value);
  }
});

test('an Ingress on the old domain moves its rules and its TLS hosts, one label at a time', () => {
  const moved = kubernetes.ingressOnAppsDomain(ingress('sv-app-1-notes', 'notes-1.example.com'), 'example.com', 'example.app');
  assert.equal(moved.spec.rules[0].host, 'notes-1.example.app');
  assert.deepEqual(moved.spec.tls[0].hosts, ['notes-1.example.app']);
  assert.equal(moved.spec.rules[0].http.paths[0].backend.service.name, 'usernode-app-gate', 'routing is kept');
  for (const host of ['notes-1.example.app', 'a.b.example.com', 'notes-1.other.com', 'example.com']) {
    assert.equal(kubernetes.ingressOnAppsDomain(ingress('x', host), 'example.com', 'example.app'), null, host);
  }
  assert.equal(kubernetes.ingressOnAppsDomain(ingress('x', 'notes-1.example.com'), 'example.app', 'example.app'), null);
});

test('the release moves production apps only: previews move on their next build, custom domains never', async (t) => {
  t.after(() => kubernetes._setClientsForTest(null));
  const replaced = [];
  kubernetes._setClientsForTest({ networking: {
    listNamespacedIngress: async () => ({ items: [
      ingress('sv-app-1-notes', 'notes-1.example.com', { 'social.usernode.io/environment': 'production' }),
      ingress('sv-app-2-done', 'done-2.example.app', { 'social.usernode.io/environment': 'production' }),
      ingress('sv-preview-1-s42', 'notes-1--s42.example.com', { 'social.usernode.io/environment': 'staging' }),
      ingress('sv-domain-7', 'shop.customer.test', { 'social.usernode.io/environment': 'production', 'social.usernode.io/domain-id': '7' }),
      { ...ingress('other', 'x.example.com'), metadata: { name: 'other', labels: {} } },
    ] }),
    replaceNamespacedIngress: async ({ name, body }) => { replaced.push({ name, host: body.spec.rules[0].host }); return body; },
  } });
  const result = await kubernetes.reconcileAppsDomainIngresses({ kubernetes: { appNamespace: 'social-apps' } },
    { from: 'example.com', to: 'example.app' });
  assert.deepEqual(result, { updated: 1 });
  assert.deepEqual(replaced, [{ name: 'sv-app-1-notes', host: 'notes-1.example.app' }]);
});

test('the clock job does nothing while nothing is moving, or off Kubernetes', async () => {
  assert.deepEqual(await move.run({ config: { appRuntime: 'kubernetes' } }, {}), { off: true });
  assert.deepEqual(await move.run({ config: { appRuntime: 'docker' } }, process.env), { off: true, runtime: 'docker' });
  const { JOBS } = require('../src/workflow/clock/services.ts');
  const job = JOBS.find((j) => j.name === 'apps-domain-move');
  assert.ok(job, 'the release runs it');
  assert.equal(job.newestOnly, true, 'only the newest build decides, as for the gate');
});

test('the gate still knows apps and previews at the old domain while they move', () => {
  assert.equal(caddy.USERNODE_LEGACY_APPS_DOMAIN, 'example.com');
  assert.equal(caddy.productionHostname('notes-1'), 'notes-1.example.app', 'new addresses are on the new domain');
  assert.equal(caddy.legacyProductionHostname('notes-1'), 'notes-1.example.com');
  assert.deepEqual(access.parseAppHost('notes-1.example.app'), { slug: 'notes-1', label: 'notes-1', host: 'notes-1.example.app' });
  assert.deepEqual(access.parseAppHost('notes-1--s42.example.com'), { slug: 'notes-1', label: 'notes-1--s42', host: 'notes-1--s42.example.com' });
  assert.equal(access.parseAppHost('notes-1.example.com')?.slug, 'notes-1');
  for (const host of ['app.example.com', 'a.b.example.com', 'notes-1.other.com']) {
    assert.equal(access.parseAppHost(host), null, host);
  }
  const waking = require('../src/services/preview-waking-page');
  assert.equal(waking.previewHost('notes-1--s42.example.com', caddy.USERNODE_LEGACY_APPS_DOMAIN), 'notes-1--s42.example.com');
  // The asset server's waking page gets the old domain only while apps move.
  const assetEnv = (legacyAppDomain) => Object.fromEntries(kubernetes._platformAssetEnvForTest({
    kubernetes: { platformDomain: 'app.example.com', appDomain: 'example.app', legacyAppDomain },
  }).map(({ name, value }) => [name, value]));
  assert.equal(assetEnv('example.com').USERNODE_LEGACY_APPS_DOMAIN, 'example.com');
  assert.equal('USERNODE_LEGACY_APPS_DOMAIN' in assetEnv(''), false, 'absent when nothing moves');
});

test('a custom domain may point at the app\'s old address, and may not sit under the old domain', async () => {
  const app = { slug: 'notes-1' };
  const row = { hostname: 'www.shop.test', verification_token: 'fake-token' };
  const resolverFor = (cname) => ({
    resolveCname: async () => [cname],
    resolveTxt: async () => [[`${domains.TXT_VALUE_PREFIX}fake-token`]],
  });
  assert.equal(domains.expectedRecords(app, row)[0].value, 'notes-1.example.app', 'new claims are shown the new address');
  assert.deepEqual(await domains.checkDns(app, row, resolverFor('notes-1.example.app.')), { ok: true });
  assert.deepEqual(await domains.checkDns(app, row, resolverFor('notes-1.example.com.')), { ok: true });
  const other = await domains.checkDns(app, row, resolverFor('elsewhere.example.net.'));
  assert.equal(other.ok, false);
  assert.match(other.error, /not notes-1\.example\.app/);
  assert.throws(() => domains.normalizeHostname('shop.example.com'), { code: 'platform_domain' });
});

const helmAvailable = spawnSync('helm', ['version', '--short'], { stdio: 'ignore' }).status === 0;

test('Helm passes config.legacyAppsDomain to the platform and its migration job', {
  skip: !helmAvailable && 'helm is not installed',
}, () => {
  const base = ['template', 'apps-domain-move-test', 'deploy/helm/social-vibecoding-platform', '--set', 'enabled=true',
    '--set', 'secrets.create=false', '--set-string', `release.sourceRevision=${'a'.repeat(40)}`];
  for (const image of ['image', 'workerImage', 'captureImage']) {
    base.push('--set-string', `platform.${image}.digest=sha256:${'a'.repeat(64)}`);
  }
  const envOf = (template, extra = []) => Object.fromEntries([...execFileSync('helm',
    [...base, '--show-only', template, ...extra], { encoding: 'utf8' })
    .matchAll(/\{name: ([A-Z0-9_]+), value: "([^"]*)"\}/g)].map(([, key, value]) => [key, value]));
  for (const template of ['templates/platform.yaml', 'templates/migration-job.yaml']) {
    assert.equal(envOf(template).USERNODE_LEGACY_APPS_DOMAIN, '', `${template}: empty by default`);
    const env = envOf(template, ['--set-string', 'config.appsDomain=example.app,config.legacyAppsDomain=example.com']);
    assert.equal(env.USERNODE_APPS_DOMAIN, 'example.app', template);
    assert.equal(env.USERNODE_LEGACY_APPS_DOMAIN, 'example.com', template);
  }
});
