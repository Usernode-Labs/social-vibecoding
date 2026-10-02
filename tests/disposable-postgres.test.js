'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { randomUUID } = require('node:crypto');
const { spawnSync } = require('node:child_process');
const { LABEL, readManifest, verifyDisposablePostgres, verifiedTestEnvironment } = require('./lib/disposable-postgres');
const { verifyDatabase } = require('./lib/isolated-kpack-fixture');

function fixture(t) {
  const fixtureId = randomUUID();
  const directory = path.join(fs.realpathSync(os.tmpdir()), `preview-postgres-test-${fixtureId}`);
  fs.mkdirSync(directory, { mode: 0o700 });
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const manifest = {
    version: 1, fixtureId, directory, createdAt: new Date(Date.now() - 1000).toISOString(),
    dockerHost: 'unix:///unused-test-socket', dockerDaemonId: 'owned-daemon',
    database: {
      url: `postgresql://recovery_test:fixture-password@127.0.0.1:15432/preview_contract_${fixtureId.replaceAll('-', '')}`,
      containerId: 'a'.repeat(64), image: `postgres@sha256:${'b'.repeat(64)}`, systemIdentifier: '12345',
    },
  };
  const filename = path.join(directory, 'fixture.json');
  const save = () => fs.writeFileSync(filename, JSON.stringify(manifest), { mode: 0o600 });
  save();
  const container = {
    Id: manifest.database.containerId, Name: `/preview-postgres-test-${fixtureId}`,
    Created: new Date().toISOString(), State: { Running: true },
    Config: { Image: manifest.database.image, Labels: { [LABEL]: fixtureId } },
    HostConfig: { Tmpfs: { '/var/lib/postgresql/data': 'rw' } },
    Mounts: [{ Type: 'tmpfs', Destination: '/var/lib/postgresql/data' }],
    NetworkSettings: {
      Ports: { '5432/tcp': [{ HostIp: '127.0.0.1', HostPort: '15432' }] },
      Networks: { bridge: { IPAddress: '172.17.0.2' } },
    },
  };
  let databaseReads = 0;
  const dependencies = {
    readDocker(args) {
      return args[0] === 'info' ? { ID: manifest.dockerDaemonId, OSType: 'linux' } : [container];
    },
    async verifyDatabase() { databaseReads++; },
  };
  return {
    manifest, container, save, dependencies, env: { PREVIEW_POSTGRES_TEST_CONFIG: filename },
    databaseReads: () => databaseReads,
  };
}

test('owned PostgreSQL preflight rejects URLs/flags without a private ownership manifest', async () => {
  for (const env of [{}, { PREVIEW_CONTRACT_POSTGRES_ONLY: '1' }]) {
    await assert.rejects(verifyDisposablePostgres('postgresql://unused@127.0.0.1:15432/production', { env }),
      /dedicated ownership manifest required/);
  }
});

test('owned PostgreSQL preflight rejects destination, age and container mismatches before connecting', async t => {
  const cases = [
    ['remote host', f => { f.manifest.database.url = f.manifest.database.url.replace('127.0.0.1', 'example.invalid'); }],
    ['stale fixture', f => { f.manifest.createdAt = new Date(Date.now() - 25 * 3600000).toISOString(); }],
    ['shared permissions', f => { fs.chmodSync(f.env.PREVIEW_POSTGRES_TEST_CONFIG, 0o644); }],
    ['wrong label', f => { f.container.Config.Labels[LABEL] = randomUUID(); }],
    ['wrong physical container', f => { f.container.Id = 'c'.repeat(64); }],
    ['wrong image', f => { f.container.Config.Image = 'postgres:latest'; }],
    ['stopped container', f => { f.container.State.Running = false; }],
    ['public port', f => { f.container.NetworkSettings.Ports['5432/tcp'][0].HostIp = '0.0.0.0'; }],
    ['other port', f => { f.container.NetworkSettings.Ports['5432/tcp'][0].HostPort = '15433'; }],
    ['missing tmpfs', f => { f.container.HostConfig.Tmpfs = {}; }],
    ['extra tmpfs', f => { f.container.HostConfig.Tmpfs['/other'] = 'rw'; }],
    ['reused disk', f => { f.container.Mounts[0].Type = 'volume'; }],
    ['wrong daemon', f => { f.dependencies.readDocker = args => args[0] === 'info'
      ? { ID: 'other-daemon', OSType: 'linux' } : [f.container]; }],
  ];
  for (const [name, change] of cases) {
    await t.test(name, async t => {
      const f = fixture(t);
      change(f);
      f.save();
      await assert.rejects(verifyDisposablePostgres(f.manifest.database.url, f), /Disposable PostgreSQL preflight:/);
      assert.equal(f.databaseReads(), 0, 'Unowned destination must not receive even a verification connection');
    });
  }
});

test('owned PostgreSQL preflight admits only the base, generated execution schema or explicit maintenance connection', async t => {
  const f = fixture(t);
  const url = new URL(f.manifest.database.url);
  url.searchParams.set('options', '-c search_path=execution_123_456');
  await verifyDisposablePostgres(url.toString(), f);
  assert.equal(f.databaseReads(), 1);
  url.searchParams.set('options', '-c search_path=public');
  await assert.rejects(verifyDisposablePostgres(url.toString(), f), /connection options/);
  url.search = '';
  url.pathname = '/other';
  await assert.rejects(verifyDisposablePostgres(url.toString(), f), /differs from/);
  url.pathname = '/postgres';
  await assert.rejects(verifyDisposablePostgres(url.toString(), f), /differs from/);
  await verifyDisposablePostgres(url.toString(), { ...f, maintenanceDatabase: true });
  assert.equal(f.databaseReads(), 2);
});

test('PostgreSQL identity verification is read-only and rejects wrong server identity', async t => {
  const f = fixture(t);
  let identifier = f.manifest.database.systemIdentifier;
  let ended = 0;
  class ReadOnlyClient {
    async connect() {}
    async query(sql) {
      assert.match(sql, /^SELECT /);
      return { rows: [{ name: new URL(f.manifest.database.url).pathname.slice(1),
        address: '172.17.0.2', port: 5432, started: new Date(), identifier }] };
    }
    async end() { ended++; }
  }
  await verifyDatabase(f.manifest, f.container, f.manifest.database.url, ReadOnlyClient);
  identifier = 'different-storage';
  await assert.rejects(verifyDatabase(f.manifest, f.container, f.manifest.database.url, ReadOnlyClient), /identity mismatch/);
  assert.equal(ended, 2, 'Verification connections close after success and rejection');
});

test('owned database selection does not bypass actual-resource preflight or inherit ambient destinations', async t => {
  const f = fixture(t);
  await assert.rejects(verifyDisposablePostgres(f.manifest.database.url, {
    env: { ...f.env, RUN_ISOLATED_KPACK_TEST: '1', PREVIEW_FLOW_TEST_DATABASE_URL: f.manifest.database.url },
  }), /KPACK_RECOVERY_TEST_CONFIG required/);
  assert.equal(f.databaseReads(), 0);
  const selected = verifiedTestEnvironment({ PATH: 'test-path', DATABASE_URL: 'unowned', PGHOST: 'unowned',
    DB_ADMIN_URL: 'unowned', KUBECONFIG: 'ambient', AWS_ACCESS_KEY_ID: 'ambient', ...f.env }, f.manifest.database.url);
  for (const key of ['DATABASE_URL', 'PGHOST', 'KUBECONFIG', 'AWS_ACCESS_KEY_ID']) assert.equal(selected[key], undefined);
  assert.equal(selected.DB_ADMIN_URL, f.manifest.database.url);
  assert.equal(selected.PREVIEW_POSTGRES_TEST_CONFIG, f.env.PREVIEW_POSTGRES_TEST_CONFIG);
});

test('runner and directly invoked PostgreSQL suites fail closed without ownership proof', () => {
  const url = 'postgresql://unused:unused@127.0.0.1:15432/unowned';
  const env = {
    PATH: process.env.PATH, TMPDIR: process.env.TMPDIR,
    PREVIEW_CONTRACT_POSTGRES_ONLY: '1', PREVIEW_FLOW_TEST_DATABASE_URL: url,
    PREVIEW_LIFECYCLE_TEST_DATABASE_URL: url, TEST_DATABASE_URL: url, SQL_CHECK_CONNECTION_URL: url,
  };
  const commands = [
    ['scripts/test-preview-flow.js'],
    ...[
      'decision-runtime', 'execution-worker', 'preview-admission', 'cli-preview-handoff-postgres',
      'preview-flow', 'preview-candidate', 'preview-cleanup', 'preview-lifecycle',
      'recoverable-preview-clone', 'unpromote-proposal-postgres', 'proposal-description-postgres',
    ].map(name => ['--test', '--test-force-exit', `tests/${name}.test.js`]),
  ];
  for (const args of commands) {
    const result = spawnSync(process.execPath, args, { env, encoding: 'utf8', timeout: 30000, maxBuffer: 4 * 1024 * 1024 });
    assert.equal(result.error, undefined, args.join(' '));
    assert.notEqual(result.status, 0, args.join(' '));
    assert.match(result.stdout + result.stderr, /dedicated ownership manifest required/, args.join(' '));
  }
});

test('real disposable PostgreSQL: verified destination accepts schema mutations and rejects a forged server identity', {
  skip: !process.env.PREVIEW_POSTGRES_TEST_CONFIG,
}, async t => {
  const filename = process.env.PREVIEW_POSTGRES_TEST_CONFIG;
  const manifest = readManifest(filename);
  await verifyDisposablePostgres(manifest.database.url);
  const { createExecutionDatabase } = require('./lib/execution-database');
  const db = await createExecutionDatabase(manifest.database.url);
  t.after(() => db.close());
  assert.equal((await db.pool.query('SELECT COUNT(*)::int AS count FROM apps')).rows[0].count, 1);

  // This forged manifest points only to the same verified disposable container.
  // It cannot redirect traffic; server identity must fail before schema creation.
  const before = (await db.pool.query('SELECT COUNT(*)::int AS count FROM pg_namespace')).rows[0].count;
  const original = fs.readFileSync(filename);
  t.after(() => fs.writeFileSync(filename, original));
  manifest.database.systemIdentifier = String(BigInt(manifest.database.systemIdentifier) + 1n);
  fs.writeFileSync(filename, JSON.stringify(manifest));
  await assert.rejects(createExecutionDatabase(manifest.database.url), /identity mismatch/);
  assert.equal((await db.pool.query('SELECT COUNT(*)::int AS count FROM pg_namespace')).rows[0].count, before);
  fs.writeFileSync(filename, original);
});
