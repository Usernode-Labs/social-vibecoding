'use strict';

// Previews on a domain of their own (services/previews-domain.js): preview
// addresses are built there, the gate and the waking page know them there
// (and only previews), a preview not rebuilt yet still answers on the apps
// domain, and startup refuses a previews domain that shares a site with the
// platform or the apps.
//
// Run with: node --test tests/previews-domain.test.js

// Each node:test file runs in its own process: these are read once at load.
process.env.USERNODE_DOMAIN = 'app.example.com';
process.env.USERNODE_APPS_DOMAIN = 'example.app';
process.env.USERNODE_PREVIEWS_DOMAIN = 'example.dev';

const test = require('node:test');
const assert = require('node:assert/strict');
const { execFileSync, spawnSync } = require('node:child_process');
const previews = require('../src/services/previews-domain');
const caddy = require('../src/services/caddy');
const access = require('../src/services/app-access');
const domains = require('../src/services/app-domains');
const kubernetes = require('../src/services/kubernetes');

const env = { USERNODE_DOMAIN: 'app.example.com', USERNODE_APPS_DOMAIN: 'example.app' };

test('the setting is empty unless it names another domain, and startup refuses one on a shared site', () => {
  assert.equal(previews.previewsDomain(env), '');
  assert.equal(previews.previewsDomain({ ...env, USERNODE_PREVIEWS_DOMAIN: 'Example.DEV.' }), 'example.dev');
  assert.equal(previews.previewsDomain({ ...env, USERNODE_PREVIEWS_DOMAIN: 'example.app' }), '');
  assert.equal(previews.validatePreviewsDomain(env), '');
  assert.equal(previews.validatePreviewsDomain({ ...env, USERNODE_PREVIEWS_DOMAIN: 'example.dev' }), 'example.dev');
  const moving = { ...env, USERNODE_LEGACY_APPS_DOMAIN: 'example.com' };
  for (const [value, message, base = env] of [
    ['https://example.dev', /domain name/], ['example.dev:443', /domain name/], ['*.example.dev', /domain name/],
    ['example.app', /not be USERNODE_APPS_DOMAIN/], ['previews.example.app', /not be USERNODE_APPS_DOMAIN/],
    ['app.example.com', /not be USERNODE_DOMAIN/], ['example.com', /not be USERNODE_DOMAIN/],
    ['previews.example.com', /different registrable site from USERNODE_DOMAIN/],
    ['example.com', /not be USERNODE_DOMAIN/, moving],
  ]) {
    assert.throws(() => previews.validatePreviewsDomain({ ...base, USERNODE_PREVIEWS_DOMAIN: value }), message, value);
  }
  // The apps on the platform's own site (the historical layout): a previews
  // domain must still leave it.
  const shared = { USERNODE_DOMAIN: 'app.example.com', USERNODE_APPS_DOMAIN: 'example.com' };
  assert.throws(() => previews.validatePreviewsDomain({ ...shared, USERNODE_PREVIEWS_DOMAIN: 'example.com' }), /not be USERNODE_DOMAIN/);
  assert.equal(previews.validatePreviewsDomain({ ...shared, USERNODE_PREVIEWS_DOMAIN: 'example.dev' }), 'example.dev');
});

test('previews are built on the previews domain, production apps stay on the apps domain', () => {
  assert.equal(caddy.USERNODE_PREVIEWS_DOMAIN, 'example.dev');
  assert.equal(caddy.stagingHostname('notes-1', 's42'), 'notes-1--s42.example.dev');
  assert.equal(caddy.productionHostname('notes-1'), 'notes-1.example.app');
  const { generatedHosts, validateBrowserSiteIsolation } = require('../src/services/browser-site-isolation');
  const hosts = generatedHosts(process.env);
  assert.equal(hosts.preview, caddy.stagingHostname('probe', 's1'), 'strict mode probes the hosts caddy.js builds');
  assert.equal(hosts.app, caddy.productionHostname('probe'));
  assert.equal(validateBrowserSiteIsolation({ ...process.env, NODE_ENV: 'production', APP_RUNTIME: 'kubernetes',
    BROWSER_SITE_ISOLATION: 'strict' }), 'strict');
});

test('the gate knows previews on the previews domain, and production apps never there', () => {
  assert.deepEqual(access.parseAppHost('notes-1--s42.example.dev'), { slug: 'notes-1', label: 'notes-1--s42', host: 'notes-1--s42.example.dev' });
  assert.equal(access.parseAppHost('notes-1.example.dev'), null, 'a production label on the previews domain');
  assert.equal(access.parseAppHost('a.notes-1--s42.example.dev'), null);
  // A preview not rebuilt since previews got their domain still answers.
  assert.equal(access.parseAppHost('notes-1--s42.example.app')?.slug, 'notes-1');
  assert.equal(access.parseAppHost('notes-1.example.app')?.slug, 'notes-1');
  const waking = require('../src/services/preview-waking-page');
  assert.equal(waking.previewHost('notes-1--s42.example.dev', caddy.USERNODE_PREVIEWS_DOMAIN), 'notes-1--s42.example.dev');
  assert.equal(waking.previewHost('notes-1.example.dev', caddy.USERNODE_PREVIEWS_DOMAIN), null);
  assert.throws(() => domains.normalizeHostname('shop.example.dev'), { code: 'platform_domain' });
});

test('Kubernetes routes, captures and heals previews on the previews domain', () => {
  const cfg = { platformDomain: 'app.example.com', appDomain: 'example.app', previewDomain: 'example.dev' };
  const assetEnv = (kube) => Object.fromEntries(kubernetes._platformAssetEnvForTest({ kubernetes: kube })
    .map(({ name, value }) => [name, value]));
  assert.equal(assetEnv(cfg).USERNODE_PREVIEWS_DOMAIN, 'example.dev', 'the waking page knows it');
  assert.equal('USERNODE_PREVIEWS_DOMAIN' in assetEnv({ ...cfg, previewDomain: '' }), false, 'absent when unset');

  const visuals = require('../src/services/visuals');
  const config = { selfAppSlug: 'platform', kubernetes: cfg };
  assert.equal(visuals.kubernetesCaptureOrigin(config, { slug: 'demo' }, 7), 'https://demo--s7.example.dev');
  assert.equal(visuals.kubernetesCaptureOrigin(config, { slug: 'demo' }), 'https://demo.example.app');

  // Homeroom's own preview serves its own assets, wherever it is: the
  // healer never gives it production's.
  const ingress = (host) => ({ spec: { rules: [{ host, http: { paths: [
    { path: '/', pathType: 'Prefix', backend: { service: { name: 'x', port: { number: 3000 } } } },
  ] } }] } });
  const heal = (host) => kubernetes._ingressWithPlatformAssetRoutesForTest(ingress(host), config);
  const assetPaths = (healed, host) => (healed ? healed.spec.rules : ingress(host).spec.rules)[0].http.paths.length - 1;
  for (const host of ['platform--s9.example.dev', 'platform--s9.example.app', 'platform.example.app']) {
    assert.equal(assetPaths(heal(host), host), 0, host);
  }
  for (const host of ['demo--s9.example.dev', 'demo.example.app']) {
    assert.ok(assetPaths(heal(host), host) > 0, host);
  }
});

test('a self-preview inherits the previews domain, to build its projects\' preview addresses', () => {
  const stagingEnv = require('../src/services/staging-env');
  assert.ok(stagingEnv.INHERITED_KEYS.includes('USERNODE_PREVIEWS_DOMAIN'));
});

const helmAvailable = spawnSync('helm', ['version', '--short'], { stdio: 'ignore' }).status === 0;

test('Helm passes config.previewsDomain to the platform and its migration job', {
  skip: !helmAvailable && 'helm is not installed',
}, () => {
  const base = ['template', 'previews-domain-test', 'deploy/helm/social-vibecoding-platform', '--set', 'enabled=true',
    '--set', 'secrets.create=false', '--set-string', `release.sourceRevision=${'a'.repeat(40)}`];
  for (const image of ['image', 'workerImage', 'captureImage']) {
    base.push('--set-string', `platform.${image}.digest=sha256:${'a'.repeat(64)}`);
  }
  const envOf = (template, extra = []) => Object.fromEntries([...execFileSync('helm',
    [...base, '--show-only', template, ...extra], { encoding: 'utf8' })
    .matchAll(/\{name: ([A-Z0-9_]+), value: "([^"]*)"\}/g)].map(([, key, value]) => [key, value]));
  for (const template of ['templates/platform.yaml', 'templates/migration-job.yaml']) {
    assert.equal(envOf(template).USERNODE_PREVIEWS_DOMAIN, '', `${template}: empty by default`);
    const set = envOf(template, ['--set-string', 'config.appsDomain=example.app,config.previewsDomain=example.dev']);
    assert.equal(set.USERNODE_PREVIEWS_DOMAIN, 'example.dev', template);
  }
});
