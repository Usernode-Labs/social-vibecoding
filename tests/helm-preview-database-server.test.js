'use strict';

// The chart's side of a separate server for preview databases
// (previewPostgresql in values.yaml; STAGING_DB_ADMIN_URL in
// src/services/db-manager.js). Pinned here:
//   - off by default: no key in the Secret, no extra egress, and an explicit
//     empty STAGING_DB_ADMIN_URL on the platform, which overrides a key left
//     in an imported Secret;
//   - on: the URL is in the Secret (never in the Deployment), the platform
//     may reach that server's Pods and port, and the drain flag reaches it;
//   - a half-filled configuration fails the render.
//
// Run with: node --test tests/helm-preview-database-server.test.js

const test = require('node:test');
const assert = require('node:assert/strict');
const { execFileSync, spawnSync } = require('node:child_process');

const helmAvailable = spawnSync('helm', ['version', '--short'], { stdio: 'ignore' }).status === 0;
const skip = !helmAvailable && 'helm is not installed';

const base = ['template', 'two-servers-test', 'deploy/helm/social-vibecoding-platform',
  '--namespace', 'platform-ns', '--set', 'enabled=true',
  '--set-string', `release.sourceRevision=${'a'.repeat(40)}`,
  ...['image', 'workerImage', 'captureImage'].flatMap((image) => ['--set-string', `platform.${image}.digest=sha256:${'a'.repeat(64)}`]),
  '--set', 'postgresql.enabled=false,postgresql.host=writer.example.test',
  '--set-string', 'postgresql.podSelector.cnpg\\.io/cluster=writer-cluster'];
const created = ['--set', 'secrets.create=true,secrets.databasePassword=main-pw',
  '--set', 'secrets.githubAppId=1,secrets.githubPrivateKey=k,secrets.topochainPartnerApiKey=p'];
const on = ['--set', 'previewPostgresql.enabled=true,previewPostgresql.host=previewcopies-rw.previews-ns.svc,previewPostgresql.username=previews',
  '--set', 'previewPostgresql.namespace=previews-ns', '--set-string', 'previewPostgresql.podSelector.cnpg\\.io/cluster=previewcopies'];

const render = (file, extra) => execFileSync('helm', [...base, '--show-only', `templates/${file}`, ...extra],
  { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
const envOf = (rendered) => Object.fromEntries([...rendered.matchAll(/\{name: ([A-Z0-9_]+), value: "([^"]*)"\}/g)]
  .map(([, key, value]) => [key, value]));

test('off by default: nothing about a preview database server is rendered, and a leftover key is overridden', { skip }, () => {
  const platform = render('platform.yaml', ['--set', 'secrets.create=false']);
  assert.equal(envOf(platform).STAGING_DB_ADMIN_URL, '', 'an explicit empty value, which wins over envFrom');
  assert.equal('STAGING_DB_SERVER_DRAIN' in envOf(platform), false);
  assert.doesNotMatch(render('secret.yaml', created), /STAGING_DB_ADMIN_URL/);
  assert.doesNotMatch(render('networkpolicy.yaml', ['--set', 'secrets.create=false']), /previews-ns|previewcopies/);
});

test('on: the URL is a Secret, the platform may reach the server, and drain reaches the platform', { skip }, () => {
  const secret = render('secret.yaml', [...created, ...on, '--set', 'secrets.previewDatabasePassword=preview-pw']);
  assert.match(secret, /STAGING_DB_ADMIN_URL: "postgres:\/\/previews:preview-pw@previewcopies-rw\.previews-ns\.svc:5432\/postgres"/);

  const platform = render('platform.yaml', ['--set', 'secrets.create=false', ...on]);
  assert.equal('STAGING_DB_ADMIN_URL' in envOf(platform), false, 'the password-bearing URL is never written into the Deployment');
  assert.equal(envOf(platform).STAGING_DB_SERVER_DRAIN, '');
  assert.equal(envOf(render('platform.yaml', ['--set', 'secrets.create=false', ...on, '--set', 'previewPostgresql.drain=true'])).STAGING_DB_SERVER_DRAIN, '1');

  const policy = render('networkpolicy.yaml', ['--set', 'secrets.create=false', ...on, '--set', 'previewPostgresql.port=6432']);
  const rule = policy.slice(policy.indexOf('# The preview database server'));
  assert.match(rule, /kubernetes\.io\/metadata\.name: "previews-ns"/);
  assert.match(rule, /cnpg\.io\/cluster: previewcopies/);
  assert.match(rule, /ports: \[\{protocol: TCP, port: 6432\}\]/);
  const migration = policy.slice(policy.indexOf('-migration\n'));
  assert.doesNotMatch(migration.slice(0, migration.indexOf('\n---')), /previews-ns/, 'the migration Job has no business there');
});

test('a half-filled configuration fails the render', { skip }, () => {
  const fails = (extra, message) => {
    const run = spawnSync('helm', [...base, ...extra], { encoding: 'utf8' });
    assert.notEqual(run.status, 0);
    assert.match(run.stderr, message);
  };
  fails(['--set', 'secrets.create=false', '--set', 'previewPostgresql.enabled=true'], /previewPostgresql\.podSelector is required/);
  fails([...created, ...on], /secrets\.previewDatabasePassword must be non-empty and URL-safe/);
  fails([...created, '--set', 'secrets.previewDatabasePassword=x', '--set', 'previewPostgresql.enabled=true',
    '--set-string', 'previewPostgresql.podSelector.app=pg'], /previewPostgresql\.host, username and database are required/);
});
