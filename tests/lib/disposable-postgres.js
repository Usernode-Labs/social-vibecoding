'use strict';

// Read-only ownership preflight. A URL, environment flag or database name is
// never proof that a destination is disposable. Verify the local container first,
// then compare PostgreSQL's physical identity before allowing test mutations.
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const { verifyDatabase, verifyIsolatedBuildFixture } = require('./isolated-kpack-fixture');

const LABEL = 'social.usernode.io/preview-postgres-fixture';
const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/;

function requireOwnership(condition, message) {
  if (!condition) throw new Error(`Disposable PostgreSQL preflight: ${message}`);
}

function readManifest(filename, now = Date.now()) {
  requireOwnership(filename && path.isAbsolute(filename), 'dedicated ownership manifest required');
  const manifest = JSON.parse(fs.readFileSync(filename, 'utf8'));
  requireOwnership(manifest.version === 1 && UUID.test(manifest.fixtureId), 'fresh fixture identity required');
  const created = Date.parse(manifest.createdAt);
  requireOwnership(Number.isFinite(created) && created <= now && now - created < 24 * 3600000,
    'fixture must have been created within the last 24 hours');
  const directory = fs.realpathSync(manifest.directory);
  requireOwnership(directory.startsWith(`${fs.realpathSync(os.tmpdir())}${path.sep}`)
    && path.basename(directory) === `preview-postgres-test-${manifest.fixtureId}`
    && fs.realpathSync(filename) === path.join(directory, 'fixture.json'), 'dedicated temporary manifest required');
  for (const file of [directory, filename]) {
    const stat = fs.statSync(file);
    requireOwnership(stat.uid === process.getuid() && (stat.mode & 0o077) === 0,
      'fixture configuration must be private and owned by the current user');
  }
  requireOwnership(manifest.dockerHost?.startsWith('unix:///') && manifest.dockerDaemonId,
    'explicit local Docker socket and daemon identity required');
  const database = manifest.database;
  requireOwnership(database && /^[a-f0-9]{64}$/.test(database.containerId)
    && /^(docker.io\/library\/)?postgres@sha256:[a-f0-9]{64}$/.test(database.image)
    && /^[0-9]+$/.test(database.systemIdentifier), 'dedicated container/image/storage identity required');
  const url = new URL(database.url);
  requireOwnership(url.protocol === 'postgresql:' && url.hostname === '127.0.0.1' && url.port
    && url.username === 'recovery_test' && url.password && !url.search && !url.hash
    && url.pathname === `/preview_contract_${manifest.fixtureId.replaceAll('-', '')}`,
  'database must use the dedicated loopback destination and credentials');
  return manifest;
}

function matchDestination(databaseUrl, expectedUrl, { maintenanceDatabase = false } = {}) {
  requireOwnership(databaseUrl, 'explicit database destination required');
  const selected = new URL(databaseUrl);
  const expected = new URL(expectedUrl);
  requireOwnership([...selected.searchParams.keys()].every(key => key === 'options')
    && selected.searchParams.size <= 1
    && (!selected.searchParams.has('options') || /^-c search_path=execution_[0-9_]+$/.test(selected.searchParams.get('options'))),
  'unverified database connection options');
  selected.search = '';
  if (maintenanceDatabase && selected.pathname === '/postgres') selected.pathname = expected.pathname;
  requireOwnership(selected.href === expected.href, 'database destination differs from its owned fixture');
}

function dockerReader(manifest) {
  const socket = fs.realpathSync(manifest.dockerHost.slice('unix://'.length));
  requireOwnership(fs.statSync(socket).isSocket(), 'local Docker socket required');
  const env = { PATH: process.env.PATH };
  return args => JSON.parse(execFileSync('docker', ['--host', `unix://${socket}`, '--config', path.join(manifest.directory, 'docker-config'), ...args], {
    env, encoding: 'utf8', timeout: 10000, maxBuffer: 4 * 1024 * 1024,
  }));
}

function inspectOwnedDatabase(manifest, readDocker = dockerReader(manifest), { requireRunning = true } = {}) {
  const info = readDocker(['info', '--format', '{{json .}}']);
  requireOwnership(info.ID === manifest.dockerDaemonId && info.OSType === 'linux', 'local Docker daemon identity mismatch');
  const values = readDocker(['inspect', '--type', 'container', manifest.database.containerId]);
  requireOwnership(values.length === 1, 'one owned database container required');
  const container = values[0];
  const bindings = container.NetworkSettings.Ports?.['5432/tcp'];
  requireOwnership(container.Id === manifest.database.containerId
    && container.Name === `/preview-postgres-test-${manifest.fixtureId}`
    && container.Config.Labels?.[LABEL] === manifest.fixtureId
    && container.Config.Image === manifest.database.image
    && new Date(container.Created).getTime() >= Date.parse(manifest.createdAt)
    && (!requireRunning || container.State.Running === true), 'database container ownership mismatch');
  requireOwnership(bindings?.length === 1 && bindings[0].HostIp === '127.0.0.1'
    && bindings[0].HostPort === new URL(manifest.database.url).port, 'database port is not exclusively owned on loopback');
  const tmpfs = container.HostConfig.Tmpfs;
  // Docker versions may omit tmpfs from Mounts. HostConfig must still declare
  // exactly this ephemeral data mount; every reported mount must agree.
  requireOwnership(tmpfs && Object.keys(tmpfs).length === 1 && tmpfs['/var/lib/postgresql/data']
    && Array.isArray(container.Mounts) && container.Mounts.every(mount =>
      mount.Type === 'tmpfs' && mount.Destination === '/var/lib/postgresql/data'),
  'database must use only new disposable tmpfs storage');
  return container;
}

async function verifyDisposablePostgres(databaseUrl, {
  env = process.env, dependencies = {}, maintenanceDatabase = false,
} = {}) {
  if (env.RUN_ISOLATED_KPACK_TEST === '1' || env.KPACK_RECOVERY_TEST_CONFIG) {
    // Actual-resource mode still proves the entire cluster/database/registry.
    // A maintenance connection is permitted only after proving its base fixture.
    matchDestination(databaseUrl, env.PREVIEW_FLOW_TEST_DATABASE_URL, { maintenanceDatabase });
    const verified = await verifyIsolatedBuildFixture({ env: { ...env, RUN_ISOLATED_KPACK_TEST: '1' } });
    return { databaseUrl: verified.fixture.isolation.database.url };
  }

  const manifest = readManifest(env.PREVIEW_POSTGRES_TEST_CONFIG);
  matchDestination(databaseUrl, manifest.database.url, { maintenanceDatabase });
  const container = inspectOwnedDatabase(manifest, dependencies.readDocker);
  await (dependencies.verifyDatabase || verifyDatabase)(manifest, container, manifest.database.url);
  return { databaseUrl: manifest.database.url, manifest };
}

function verifiedTestEnvironment(env, databaseUrl) {
  const selected = {};
  for (const key of ['PATH', 'TMPDIR', 'LANG', 'LC_ALL', 'PREVIEW_POSTGRES_TEST_CONFIG',
    'RUN_ISOLATED_KPACK_TEST', 'KPACK_RECOVERY_TEST_CONFIG']) {
    if (env[key]) selected[key] = env[key];
  }
  return {
    ...selected,
    PREVIEW_CONTRACT_POSTGRES_ONLY: '1',
    PREVIEW_FLOW_TEST_DATABASE_URL: databaseUrl,
    PREVIEW_LIFECYCLE_TEST_DATABASE_URL: databaseUrl,
    TEST_DATABASE_URL: databaseUrl,
    SQL_CHECK_CONNECTION_URL: databaseUrl,
    DB_ADMIN_URL: databaseUrl,
  };
}

module.exports = {
  LABEL, readManifest, matchDestination, inspectOwnedDatabase,
  verifyDisposablePostgres, verifiedTestEnvironment,
};
