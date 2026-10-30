'use strict';
// test:changed: when deploy/helm/social-vibecoding-platform (database identities)
const test = require('node:test');
const assert = require('node:assert/strict');
const { spawnSync } = require('node:child_process');
const yaml = require('yaml');
const skip = spawnSync('helm', ['version', '--short'], { stdio: 'ignore' }).status !== 0 && 'helm is not installed';
const keys = ['webDatabasePassword', 'conductorDatabasePassword', 'migratorDatabasePassword',
  'provisionerDatabasePassword', 'previewReadDatabasePassword', 'previewProvisionerDatabasePassword'];
const values = {
  enabled: true, databaseRoles: { enabled: true },
  release: { sourceRevision: 'a'.repeat(40) },
  platform: Object.fromEntries(['image', 'workerImage', 'captureImage'].map(k => [k, { digest: 'sha256:' + 'a'.repeat(64) }])),
  postgresql: { enabled: false, host: 'main.test', podSelector: { app: 'main-db' } },
  previewPostgresql: { enabled: true, host: 'preview.test', username: 'postgres', podSelector: { app: 'preview-db' } },
  secrets: { create: true, databasePassword: 'synthetic-main-admin', previewDatabasePassword: 'synthetic-preview-admin',
    githubAppId: '1', githubPrivateKey: 'synthetic-writer', topochainPartnerApiKey: 'synthetic-partner',
    ...Object.fromEntries(keys.map((k,i) => [k, String(i + 1).repeat(48)])) },
};
function render(change = () => {}) {
  const config = structuredClone(values); change(config);
  const run = spawnSync('helm', ['template', 'roles-test', 'deploy/helm/social-vibecoding-platform',
    '-n', 'platform-ns', '-f', '-'], { input: JSON.stringify(config), encoding: 'utf8' });
  return { ...run, docs: run.status === 0 ? yaml.parseAllDocuments(run.stdout).map(d => d.toJSON()).filter(Boolean) : [] };
}
const named = (docs, kind, suffix) => docs.find(d => d.kind === kind && d.metadata.name.endsWith(suffix));
const container = doc => doc.spec.template.spec.containers[0];
const env = doc => Object.fromEntries(container(doc).env.map(e => [e.name, e.value ?? '']));
const refs = doc => container(doc).envFrom.filter(e => e.secretRef).map(e => e.secretRef.name);
function effective(doc, docs, existing = {}) {
  return Object.assign({}, ...refs(doc).map(name =>
    docs.find(d => d.kind === 'Secret' && d.metadata.name === name)?.stringData || existing[name]), env(doc));
}

test('rendered serving and migration configurations isolate the bootstrap credentials', { skip }, () => {
  const {status, stderr, docs} = render(); assert.equal(status, 0, stderr);
  const web = named(docs, 'Deployment', 'social-vibecoding');
  const conductor = named(docs, 'Deployment', '-conductor');
  const migrate = named(docs, 'Job', '-migrate');
  const bootstrap = named(docs, 'Job', '-database-bootstrap');
  for (const [doc, role] of [[web, 'web'], [conductor, 'conductor'], [migrate, 'migrator']]) {
    const actual = effective(doc, docs);
    assert.equal(new URL(actual.DATABASE_URL).username, 'homeroom_' + role);
    for (const key of ['POSTGRES_PASSWORD', 'DATABASE_BOOTSTRAP_URL', 'STAGING_DATABASE_BOOTSTRAP_URL']) assert.equal(actual[key], '');
    assert.equal(actual.DATABASE_ROLE_SPLIT, 'true');
    if (role === 'web') {
      assert.equal(actual.DB_ADMIN_URL, ''); assert.equal(actual.STAGING_DB_ADMIN_URL, '');
      assert.equal(new URL(actual.STAGING_DB_READ_URL).username, 'homeroom_web');
    } else assert.equal(new URL(actual.DB_ADMIN_URL).username, 'homeroom_provisioner');
    assert.ok(!refs(doc).includes(refs(bootstrap)[0]));
  }
  assert.deepEqual(refs(bootstrap), ['social-vibecoding-database-bootstrap']);
  const bootstrapPolicy = named(docs, 'NetworkPolicy', '-database-bootstrap');
  const migrationPolicy = named(docs, 'NetworkPolicy', '-migration');
  assert.equal(bootstrapPolicy.spec.podSelector.matchLabels['app.kubernetes.io/component'], 'database-bootstrap');
  assert.match(JSON.stringify(bootstrapPolicy.spec.egress), /preview-db/);
  assert.doesNotMatch(JSON.stringify(migrationPolicy.spec.egress), /preview-db/);

  assert.equal(effective(bootstrap, docs).DATABASE_BOOTSTRAP_URL.includes('synthetic-main-admin'), true);
  assert.equal(bootstrap.spec.template.spec.automountServiceAccountToken, false);
  assert.ok(Number(bootstrap.metadata.annotations['argocd.argoproj.io/sync-wave']) < Number(migrate.metadata.annotations['argocd.argoproj.io/sync-wave']));
  const wave = doc => Number(doc.metadata.annotations?.['argocd.argoproj.io/sync-wave'] || 0);
  for (const doc of [web, conductor]) {
    for (const name of refs(doc)) {
      const secret = docs.find(d => d.kind === 'Secret' && d.metadata.name === name);
      assert.ok(wave(bootstrap) < wave(secret), 'a failed bootstrap must leave old serving credentials usable');
      assert.ok(wave(secret) <= wave(migrate), 'Secrets precede the migration Job by wave/kind');
      assert.ok(wave(migrate) < wave(doc), 'serving rollout waits for migration');
    }
  }
  for (const name of [...refs(bootstrap), refs(migrate).at(-1)]) {
    assert.ok(wave(docs.find(d => d.kind === 'Secret' && d.metadata.name === name)) < wave(bootstrap));
  }

  for (const d of [web, conductor, migrate, bootstrap]) {
    const entries = container(d).env;
    assert.equal(new Set(entries.map(e => e.name)).size, entries.length, d.metadata.name);
  }
});

test('the chart refuses incomplete or overlapping identities and incompatible modes', { skip }, () => {
  for (const key of keys) {
    const result = render(v => { v.secrets[key] = ''; });
    assert.notEqual(result.status, 0); assert.match(result.stderr, new RegExp(key));
  }
  for (const change of [
    v => { v.databaseRoles.web = 'homeroom_conductor'; },
    v => { v.platform.conductor = { enabled: false }; },
    v => { v.migration = { enabled: false }; },
    v => { v.postgresql.enabled = true; },
  ]) assert.notEqual(render(change).status, 0);
});

test('preview-disabled and external-Secret modes keep explicit masks and distinct imports', { skip }, () => {
  const off = render(v => { v.previewPostgresql.enabled = false; }); assert.equal(off.status, 0, off.stderr);
  const web = named(off.docs, 'Deployment', 'social-vibecoding');
  assert.equal(effective(web, off.docs).STAGING_DB_READ_URL, '');
  assert.equal(effective(web, off.docs).STAGING_DB_ADMIN_URL, '');
  assert.equal(new Set(container(web).env.map(e => e.name)).size, container(web).env.length);
  const external = render(v => {
    v.secrets.create = false;
    Object.assign(v.databaseRoles, { existingConductorSecret: 'own-conductor', existingMigrationSecret: 'own-migrator', existingBootstrapSecret: 'own-bootstrap' });
  });
  assert.equal(external.status, 0, external.stderr);
  assert.deepEqual(refs(named(external.docs, 'Deployment', '-conductor')), ['social-vibecoding', 'own-conductor']);
  assert.deepEqual(refs(named(external.docs, 'Job', '-migrate')), ['social-vibecoding', 'own-migrator']);
  assert.deepEqual(refs(named(external.docs, 'Job', '-database-bootstrap')), ['own-bootstrap']);
  const retained = {
    'social-vibecoding': { DATABASE_URL: 'postgres://homeroom_web:fixture@main.test/platform',
      DB_ADMIN_URL: 'postgres://legacy_admin:fixture@main.test/postgres',
      STAGING_DB_ADMIN_URL: 'postgres://legacy_admin:fixture@preview.test/postgres',
      POSTGRES_PASSWORD: 'legacy-fixture', DATABASE_BOOTSTRAP_URL: 'legacy-fixture', STAGING_DATABASE_BOOTSTRAP_URL: 'legacy-fixture' },
    'own-migrator': { DATABASE_URL: 'postgres://homeroom_migrator:fixture@main.test/platform', DB_ADMIN_URL: 'postgres://homeroom_provisioner:fixture@main.test/postgres' },
  };
  const migrationEnv = effective(named(external.docs, 'Job', '-migrate'), external.docs, retained);
  for (const key of ['POSTGRES_PASSWORD', 'DATABASE_BOOTSTRAP_URL', 'STAGING_DATABASE_BOOTSTRAP_URL', 'STAGING_DB_ADMIN_URL']) assert.equal(migrationEnv[key], '', key);
  assert.equal(new URL(migrationEnv.DATABASE_URL).username, 'homeroom_migrator');
  assert.equal(new URL(migrationEnv.DB_ADMIN_URL).username, 'homeroom_provisioner');

  const bad = render(v => { v.secrets.create = false; }); assert.notEqual(bad.status, 0);
  for (const duplicate of ['social-vibecoding', 'own-conductor', 'own-migrator']) {
    const collision = render(v => {
      v.secrets.create = false;
      Object.assign(v.databaseRoles, { existingConductorSecret: 'own-conductor', existingMigrationSecret: 'own-migrator', existingBootstrapSecret: duplicate });
    });
    assert.notEqual(collision.status, 0); assert.match(collision.stderr, /distinct.*Secrets/);
  }

});

test('disabling the split explicitly replaces retained conductor URLs with legacy URLs', { skip }, () => {
  const result = render(v => { v.databaseRoles.enabled = false; }); assert.equal(result.status, 0, result.stderr);
  const actual = effective(named(result.docs, 'Deployment', '-conductor'), result.docs);
  assert.equal(new URL(actual.DATABASE_URL).username, 'usernode');
  assert.equal(new URL(actual.DB_ADMIN_URL).username, 'usernode');
  assert.equal(new URL(actual.STAGING_DB_ADMIN_URL).username, 'postgres');
  assert.ok(!named(result.docs, 'Job', '-database-bootstrap'));
});
