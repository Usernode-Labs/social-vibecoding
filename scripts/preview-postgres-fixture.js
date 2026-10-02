#!/usr/bin/env node
'use strict';

// Dedicated PostgreSQL-only fixture. No ambient Docker context, persistent data,
// default PostgreSQL destination or Kubernetes credentials are used.
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { randomUUID, randomBytes } = require('node:crypto');
const { execFileSync, spawnSync } = require('node:child_process');
const { LABEL, readManifest, inspectOwnedDatabase, verifyDisposablePostgres, verifiedTestEnvironment } = require('../tests/lib/disposable-postgres');

function docker(host, args, directory) {
  return execFileSync('docker', ['--host', host, '--config', path.join(directory, 'docker-config'), ...args], {
    env: { PATH: process.env.PATH }, encoding: 'utf8', timeout: 120000,
    stdio: ['ignore', 'pipe', 'pipe'], maxBuffer: 4 * 1024 * 1024,
  }).trim();
}

function save(manifest) {
  const filename = path.join(manifest.directory, 'fixture.json');
  fs.writeFileSync(filename, JSON.stringify(manifest, null, 2), { mode: 0o600 });
  return filename;
}

async function create(dockerHost, manifestPointer) {
  if (!dockerHost?.startsWith('unix:///') || !fs.statSync(dockerHost.slice(7)).isSocket()) {
    throw new Error('An explicit local Docker socket is required');
  }
  const fixtureId = randomUUID();
  const directory = path.join(fs.realpathSync(os.tmpdir()), `preview-postgres-test-${fixtureId}`);
  fs.mkdirSync(directory, { mode: 0o700 });
  fs.mkdirSync(path.join(directory, 'docker-config'), { mode: 0o700 });
  const info = JSON.parse(docker(dockerHost, ['info', '--format', '{{json .}}'], directory));
  if (!info.ID || info.OSType !== 'linux') throw new Error('A local Linux container daemon is required');
  const imageTag = 'postgres:15.15';
  docker(dockerHost, ['pull', imageTag], directory);
  const [image] = JSON.parse(docker(dockerHost, ['image', 'inspect', imageTag], directory));
  const imageRef = image.RepoDigests.find(value => /^(docker.io\/library\/)?postgres@sha256:[a-f0-9]{64}$/.test(value));
  if (!imageRef) throw new Error('Pinned PostgreSQL image identity is unavailable');
  const name = `preview_contract_${fixtureId.replaceAll('-', '')}`;
  const password = randomBytes(24).toString('hex');
  const environmentFile = path.join(directory, 'postgres.env');
  fs.writeFileSync(environmentFile, `POSTGRES_USER=recovery_test\nPOSTGRES_PASSWORD=${password}\nPOSTGRES_DB=${name}\n`, { mode: 0o600 });
  const manifest = {
    version: 1, fixtureId, createdAt: new Date().toISOString(), directory,
    dockerHost, dockerDaemonId: info.ID,
  };
  const containerId = docker(dockerHost, ['run', '-d', '--name', `preview-postgres-test-${fixtureId}`,
    '--label', `${LABEL}=${fixtureId}`, '--tmpfs', '/var/lib/postgresql/data:rw',
    '-p', '127.0.0.1::5432', '--env-file', environmentFile, imageRef,
    'postgres', '-c', 'max_prepared_transactions=10'], directory);
  const [container] = JSON.parse(docker(dockerHost, ['inspect', containerId], directory));
  const port = container.NetworkSettings.Ports['5432/tcp'][0].HostPort;
  manifest.database = {
    url: `postgresql://recovery_test:${password}@127.0.0.1:${port}/${name}`,
    containerId, image: imageRef, systemIdentifier: '0',
  };
  const filename = save(manifest);
  if (manifestPointer) fs.writeFileSync(manifestPointer, filename, { mode: 0o600 });
  // Save the exact creation identity before waiting, so an unready fixture can
  // still be retired by verified container identity rather than a guessed name.
  for (let attempt = 0; attempt < 30; attempt++) {
    try {
      manifest.database.systemIdentifier = docker(dockerHost, ['exec', containerId,
        'psql', '-U', 'recovery_test', '-d', name, '-Atc', 'SELECT system_identifier FROM pg_control_system()'], directory);
      save(manifest);
      await verifyDisposablePostgres(manifest.database.url, { env: { PREVIEW_POSTGRES_TEST_CONFIG: filename } });
      return filename;
    } catch {
      await new Promise(resolve => setTimeout(resolve, 500));
    }
  }
  throw new Error(`Disposable PostgreSQL did not pass preflight; owned fixture: ${filename}`);
}

async function main() {
  const [mode, filename, ...args] = process.argv.slice(2);
  if (mode === 'create') {
    console.log(await create(filename, args[0]));
    return;
  }
  const manifest = readManifest(filename);
  if (mode === 'teardown') {
    const info = JSON.parse(docker(manifest.dockerHost, ['info', '--format', '{{json .}}'], manifest.directory));
    if (info.ID !== manifest.dockerDaemonId || info.OSType !== 'linux') throw new Error('Docker daemon identity changed');
    const present = docker(manifest.dockerHost, ['ps', '-a', '--no-trunc', '--format', '{{json .}}'], manifest.directory)
      .split('\n').filter(Boolean).map(line => JSON.parse(line))
      .some(value => value.ID === manifest.database.containerId);
    if (present) {
      inspectOwnedDatabase(manifest, undefined, { requireRunning: false });
      docker(manifest.dockerHost, ['rm', '-f', '-v', manifest.database.containerId], manifest.directory);
    }
    console.log('Owned disposable PostgreSQL container retired; evidence retained.');
    return;
  }
  const verified = await verifyDisposablePostgres(manifest.database.url, { env: { PREVIEW_POSTGRES_TEST_CONFIG: filename } });
  const environment = verifiedTestEnvironment({
    PATH: process.env.PATH,
    TMPDIR: process.env.TMPDIR,
    PREVIEW_POSTGRES_TEST_CONFIG: filename,
  }, verified.databaseUrl);
  if (mode === 'run' && args.length) {
    const result = spawnSync(args[0], args.slice(1), {
      env: environment,
      stdio: 'inherit',
    });
    if (result.error) throw new Error('Fixture test command could not start');
    process.exitCode = result.status ?? 1;
    return;
  }
  if (mode === 'github-env' && process.env.GITHUB_ENV) {
    console.log(`::add-mask::${verified.databaseUrl}`);
    fs.appendFileSync(process.env.GITHUB_ENV, Object.entries(environment)
      .filter(([key]) => !['PATH', 'TMPDIR', 'LANG', 'LC_ALL'].includes(key))
      .map(([key, value]) => `${key}=${value}`).join('\n') + '\n');
    return;
  }
  throw new Error('Use create <local-socket>, run <manifest> <command...>, github-env <manifest> or teardown <manifest>');
}

if (require.main === module) main().catch(() => {
  // Driver errors may contain credentials or command environment details.
  console.error('Disposable PostgreSQL fixture operation failed; inspect the private fixture configuration.');
  process.exitCode = 1;
});
