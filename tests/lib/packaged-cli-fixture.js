'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { execFile } = require('node:child_process');
const { promisify } = require('node:util');
const { randomBytes, randomUUID, generateKeyPairSync, createHash } = require('node:crypto');
const { setTimeout: delay } = require('node:timers/promises');
const yaml = require('js-yaml');
const { bech32m } = require('bech32');
const { Pool } = require('pg');
const { verifyIsolatedBuildFixture, LABEL } = require('./isolated-kpack-fixture');

const PACKAGED_BUILD_LABEL = 'social.usernode.io/packaged-fixture-build';
const PACKAGED_LABEL = 'social.usernode.io/packaged-fixture-request';
const execute = promisify(execFile);
const ROOT = path.resolve(__dirname, '../..');

async function retirePackagedResources(state, docker) {
  const filename = path.join(state.directory, 'packaged/resources.json');
  if (!fs.existsSync(filename)) return;
  const journal = JSON.parse(fs.readFileSync(filename, 'utf8'));
  assert.equal(journal.fixtureId, state.fixtureId);
  const ids = (await docker(['ps', '-aq', '--no-trunc', '--filter', `label=${LABEL}=${state.fixtureId}`]))
    .split('\n').filter(Boolean);
  for (const id of ids) {
    const [container] = JSON.parse(await docker(['inspect', id]));
    const requestId = container.Config.Labels?.[PACKAGED_LABEL];
    if (!requestId) continue;
    const request = journal.requests.find(value => value.requestId === requestId);
    assert.ok(request, 'Unknown packaged resource must not be deleted');
    assert.equal(container.Name, `/${request.name}`);
    assert.equal(container.Image, journal.imageId);
    assert.equal(container.Config.Labels[LABEL], state.fixtureId);
    if (request.id) assert.equal(container.Id, request.id, 'Do not delete a successor container');
    assert.ok(Date.parse(container.Created) >= Date.parse(request.createdAt));
    await docker(['rm', '-f', container.Id]);
  }
  const tag = `preview-packaged-${state.fixtureId}:local`;
  if (await docker(['image', 'ls', '--quiet', tag])) {
    const [image] = JSON.parse(await docker(['image', 'inspect', tag]));
    assert.equal(image.Config.Labels[LABEL], state.fixtureId);
    assert.equal(image.Config.Labels[PACKAGED_BUILD_LABEL], journal.buildId);
    assert.ok(image.Config.Env.includes(`GIT_SHA=${journal.revision}`));
    if (journal.imageId) assert.equal(image.Id, journal.imageId, 'Do not delete a successor image');
    await docker(['image', 'rm', tag]);
  }
}

async function packagedFixture(t, { httpsCapture = false } = {}) {
  const verified = await verifyIsolatedBuildFixture({ requireUnitSuite: true });
  require('../../src/services/kubernetes')._setClientsForTest(verified.clients);
  const fixture = verified.fixture;
  if (httpsCapture) require('./https-private-fixture').verifyTls(fixture);
  const isolation = fixture.isolation;
  const directory = path.join(isolation.directory, 'packaged');
  const evidence = path.join(directory, 'evidence');
  fs.mkdirSync(evidence, { recursive: true, mode: 0o777 });
  fs.chmodSync(evidence, 0o777); // Disposable evidence shared with uid 1000.
  const revision = (await execute('git', ['rev-parse', 'HEAD'], { cwd: ROOT })).stdout.trim();
  const proofSources = [
    'Dockerfile.kubernetes', 'package-lock.json', 'capture/capture.js',
    'src/routes/internal.js', 'src/middleware/auth.js', 'src/middleware/admin.js',
    'src/services/platform-jwt.js', 'src/services/visuals.js',
    'tests/lib/packaged-cli-fixture.js', 'tests/lib/packaged-cli-preload.js',
    'tests/lib/https-private-edge.js', 'tests/lib/https-private-fixture.js',
    'tests/packaged-cli-entrypoints-integration.test.js', 'scripts/kpack-local-fixture.js',
  ];
  fs.writeFileSync(path.join(directory, 'source-sha256.json'), JSON.stringify(
    Object.fromEntries(proofSources.map(filename => [filename,
      createHash('sha256').update(fs.readFileSync(path.join(ROOT, filename))).digest('hex')])), null, 2),
  { mode: 0o600 });
  const tag = `preview-packaged-${isolation.fixtureId}:local`;
  const containers = new Map();
  const journal = {
    fixtureId: isolation.fixtureId,
    revision,
    buildId: randomUUID(),
    imageId: null,
    requests: [],
  };

  function saveJournal() {
    const filename = path.join(directory, 'resources.json');
    fs.writeFileSync(`${filename}.next`, JSON.stringify(journal, null, 2), { mode: 0o600 });
    fs.renameSync(`${filename}.next`, filename);
  }

  assert.ok(!fs.existsSync(path.join(directory, 'resources.json')), 'Use a fresh fixture store for each packaged proof');
  saveJournal();
  const pool = new Pool({ connectionString: isolation.database.url });
  const pluginDirectory = path.join(isolation.directory, 'docker-config/cli-plugins');
  fs.mkdirSync(pluginDirectory, { recursive: true });
  const buildx = path.join(pluginDirectory, 'docker-buildx');
  if (!fs.existsSync(buildx)) {
    const installed = '/Applications/Docker.app/Contents/Resources/cli-plugins/docker-buildx';
    assert.ok(fs.existsSync(installed), 'Installed BuildKit client required; no ambient configuration fallback');
    fs.copyFileSync(installed, buildx);
    fs.chmodSync(buildx, 0o700);
  }

  async function docker(args, options = {}) {
    return (await execute('docker', ['--host', isolation.dockerHost,
      '--config', path.join(isolation.directory, 'docker-config'), ...args], {
      env: { PATH: process.env.PATH, HOME: path.join(isolation.directory, 'home') },
      cwd: ROOT, timeout: 120000, maxBuffer: 32 * 1024 * 1024, ...options,
    })).stdout.trim();
  }

  async function ownedContainer(id) {
    const [value] = JSON.parse(await docker(['inspect', id]));
    assert.equal(value.Config.Labels[LABEL], isolation.fixtureId);
    assert.equal(value.Id, id);
    return value;
  }

  async function remove(id) {
    if (!containers.has(id)) return;
    await ownedContainer(id);
    await docker(['rm', '-f', id]);
    containers.delete(id);
  }

  t.after(async () => {
    for (const id of [...containers.keys()]) await remove(id);
    await pool.end();
    await retirePackagedResources({ fixtureId: isolation.fixtureId, directory: isolation.directory }, docker);
  });

  await verifyIsolatedBuildFixture({ requireUnitSuite: true });
  const built = await execute('docker', ['--host', isolation.dockerHost,
    '--config', path.join(isolation.directory, 'docker-config'), 'build',
    '--label', `${LABEL}=${isolation.fixtureId}`, '--label', `${PACKAGED_BUILD_LABEL}=${journal.buildId}`, '--build-arg', `GIT_SHA=${revision}`,
    '-f', 'Dockerfile.kubernetes', '-t', tag, '.'], {
    cwd: ROOT, env: { PATH: process.env.PATH, HOME: path.join(isolation.directory, 'home'), DOCKER_BUILDKIT: '1' },
    timeout: 900000, maxBuffer: 64 * 1024 * 1024,
  });
  fs.writeFileSync(path.join(directory, 'build.log'), built.stdout + built.stderr, { mode: 0o600 });
  const [image] = JSON.parse(await docker(['image', 'inspect', tag]));
  assert.equal(image.Config.User, '1000:1000');
  assert.deepEqual(image.Config.Cmd, ['node', 'server.js']);
  journal.imageId = image.Id;
  saveJournal();

  const [node] = JSON.parse(await docker(['inspect', isolation.cluster.nodeContainerIds[0]]));
  const network = Object.keys(node.NetworkSettings.Networks).find(name => name === `c4-preview-${isolation.fixtureId}-network`);
  assert.ok(network);
  const apiServer = `https://${node.NetworkSettings.Networks[network].IPAddress}:6443`;
  const kubeconfig = yaml.load(fs.readFileSync(isolation.kubeconfigPath, 'utf8'));
  kubeconfig.clusters[0].cluster.server = apiServer;
  kubeconfig.clusters[0].cluster['tls-server-name'] = '127.0.0.1';
  const database = new URL(isolation.database.url);
  database.hostname = verified.databaseAddress;
  database.port = '5432';
  const signing = generateKeyPairSync('rsa', { modulusLength: 2048,
    publicKeyEncoding: { type: 'spki', format: 'pem' },
    privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
  });
  const runtime = fixture.config.kubernetes;
  const environment = {
    DATABASE_URL: database.toString(), DB_ADMIN_URL: database.toString(),
    SESSION_SECRET: randomBytes(32).toString('hex'), DATA_ENCRYPTION_KEY: randomBytes(32).toString('hex'),
    ADMIN_USERNAME: 'packaged-admin', ADMIN_PASSWORD: randomBytes(24).toString('hex'),
    IFRAME_JWT_PRIVATE_KEY: signing.privateKey, IFRAME_JWT_PUBLIC_KEY: signing.publicKey,
    WORKER_JWT_SECRET: randomBytes(32).toString('hex'), EDGE_JWT_SECRET: randomBytes(32).toString('hex'),
    GITHUB_APP_ID: '42', GITHUB_PRIVATE_KEY: signing.privateKey,
    NODE_RPC_URL: 'http://127.0.0.1:9', TOPOCHAIN_PARTNER_API_KEY: 'disposable-fixture-only',
    NATIVE_SESSION_V2_TESTNET_CHAIN_ID: bech32m.encode('utc', bech32m.toWords(Buffer.alloc(32, 1)), 1023),
    USERNODE_LOCAL_DEV: '1', CLI_CANONICAL_ORIGIN: 'http://localhost:3000',
    APP_RUNTIME: 'kubernetes', WORKER_RUNTIME: 'kubernetes', CAPTURE_RUNTIME: 'kubernetes',
    PREVIEW_CLI_HANDOFF_ENABLED: 'true', PREVIEW_PREPARATION_WORKER_ENABLED: 'true',
    PREVIEW_LIFECYCLE_ENABLED: 'true', RUN_MIGRATIONS_ON_STARTUP: 'false',
    KUBECONFIG: '/fixture/kubeconfig', HOME: '/tmp', GIT_CONFIG_NOSYSTEM: '1',
    GIT_CONFIG_GLOBAL: '/dev/null', GIT_TERMINAL_PROMPT: '0',
    PLATFORM_NAMESPACE: isolation.namespace.name, APP_NAMESPACE: runtime.appNamespace,
    BUILD_NAMESPACE: runtime.buildNamespace, WORKER_NAMESPACE: isolation.namespace.name,
    BUILD_SERVICE_ACCOUNT: runtime.buildServiceAccount, GENERATED_APP_SERVICE_ACCOUNT: runtime.generatedAppServiceAccount,
    WORKER_SERVICE_ACCOUNT: runtime.workerServiceAccount,
    REGISTRY_REPOSITORY_PREFIX: runtime.repositoryPrefix, CACHE_REPOSITORY_PREFIX: runtime.cacheRepositoryPrefix,
    BUILDER_IMAGE: runtime.builderImage, BUILD_ENGINE: 'kpack',
    KUBERNETES_CAPTURE_IMAGE: runtime.captureImage, KUBERNETES_WORKER_IMAGE: runtime.workerImage,
    USERNODE_APPS_DOMAIN: 'fixture.invalid', USERNODE_DOMAIN: 'fixture.invalid',
    PLATFORM_INTERNAL_URL: 'http://127.0.0.1:3000',
  };

  async function start(role, { pause = null, admission = true, privateCapture = null } = {}) {
    await verifyIsolatedBuildFixture({ requireUnitSuite: true });
    let tlsDestination = null;
    const destinationFile = path.join(evidence, 'tls-destination.json');
    if (httpsCapture && role === 'worker' && fs.existsSync(destinationFile)) {
      tlsDestination = JSON.parse(fs.readFileSync(destinationFile));
      assert.equal(tlsDestination.fixtureId, isolation.fixtureId);
      assert.equal(tlsDestination.hostname, `demo--s${tlsDestination.sessionId}.fixture.invalid`);
      const edge = await ownedContainer(tlsDestination.containerId);
      assert.equal(edge.NetworkSettings.Networks[network].IPAddress, tlsDestination.address);
      assert.equal(containers.get(edge.Id), 'edge', 'TLS destination must be the owned edge process');
      require('./https-private-fixture').verifyTls(fixture);
    }
    const processDirectory = fs.mkdtempSync(path.join(directory, `${role}-`));
    fs.chmodSync(processDirectory, 0o755);
    fs.writeFileSync(path.join(processDirectory, 'kubeconfig'), yaml.dump(kubeconfig), { mode: 0o644 });
    fs.writeFileSync(path.join(processDirectory, 'process.json'), JSON.stringify({
      version: 1, fixtureId: isolation.fixtureId, revision, databaseAddress: verified.databaseAddress,
      apiServer,
      databaseIdentity: isolation.database.systemIdentifier,
      clusterIdentity: isolation.cluster.uid,
      namespace: isolation.namespace.name,
      source: fixture.preparationSource,
      unitSuite: fixture.checks.unitSuite,
      role, privateCapture, httpsCapture, tlsDestination,
      pause,
      environment: { ...environment, PREVIEW_CLI_HANDOFF_ENABLED: String(admission),
        ...(role === 'edge' ? { USERNODE_ENV: 'staging', USERNODE_APP_ID: String(privateCapture.appId),
          DATABASE_URL: privateCapture.cloneUrl, IFRAME_JWT_PRIVATE_KEY: '', EDGE_JWT_SECRET: '' } : {}) },
    }), { mode: 0o644 });
    if (role === 'edge') {
      require('./https-private-fixture').verifyTls(fixture);
      for (const name of ['cert.pem', 'key.pem']) {
        fs.copyFileSync(path.join(isolation.directory, 'tls', name), path.join(processDirectory, name));
        fs.chmodSync(path.join(processDirectory, name), 0o644);
      }
    }
    const request = {
      requestId: randomUUID(), role, name: `packaged-${randomUUID()}`,
      createdAt: new Date(Math.floor(Date.now() / 1000) * 1000).toISOString(), id: null,
    };
    journal.requests.push(request);
    saveJournal();
    const args = ['run', '-d', '--name', request.name,
      '--label', `${LABEL}=${isolation.fixtureId}`, '--label', `${PACKAGED_LABEL}=${request.requestId}`, '--network', network,
      '--mount', `type=bind,src=${processDirectory},dst=/fixture,readonly`,
      '--mount', `type=bind,src=${evidence},dst=/evidence`,
      '--mount', `type=bind,src=${path.join(ROOT, 'tests')},dst=/app/tests,readonly`,
      '-e', `PACKAGED_CLI_FIXTURE_ID=${isolation.fixtureId}`,
      '-e', `PACKAGED_CLI_DATABASE_HOST=${verified.databaseAddress}`,
      '-e', `PACKAGED_CLI_API_SERVER=${apiServer}`,
      '-e', `PACKAGED_CLI_DATABASE_IDENTITY=${isolation.database.systemIdentifier}`,
      '-e', `PACKAGED_CLI_CLUSTER_IDENTITY=${isolation.cluster.uid}`,
      '-e', 'NODE_OPTIONS=--require=/app/tests/lib/packaged-cli-preload.js'];
    if (role === 'web') args.push('-p', '127.0.0.1::3000');
    if (role === 'edge') args.push('-p', '127.0.0.1::8443');
    args.push(tag);
    if (role === 'edge') args.push('node', '-e', 'setInterval(() => {}, 1000)');
    if (role === 'worker') args.push('node', 'scripts/preview-preparation-worker.js');
    if (role === 'migration') args.push('node', 'scripts/migrate-kubernetes.js');
    const id = await docker(args);
    request.id = id;
    saveJournal();
    containers.set(id, role);
    await ownedContainer(id);
    return id;
  }

  async function logs(id) {
    const result = await execute('docker', ['--host', isolation.dockerHost,
      '--config', path.join(isolation.directory, 'docker-config'), 'logs', id], {
      env: { PATH: process.env.PATH }, maxBuffer: 8 * 1024 * 1024,
    });
    const text = result.stdout + result.stderr;
    fs.writeFileSync(path.join(directory, `${containers.get(id)}-${id.slice(0, 8)}.log`), text, { mode: 0o600 });
    return text;
  }

  async function stop(id) {
    await ownedContainer(id);
    await docker(['kill', '--signal', 'KILL', id]);
    await logs(id);
    await remove(id);
    // Accelerate retry eligibility for this fixture's existing claims only.
    await pool.query(`UPDATE execution_work_requests SET lease_until = clock_timestamp() - INTERVAL '1 second',
      due_at = clock_timestamp() WHERE status = 'running'`);
  }

  async function waitFor(condition, description, timeoutMs = 300000) {
    const deadline = Date.now() + timeoutMs;
    while (!await condition()) {
      if (Date.now() >= deadline) {
        for (const id of containers.keys()) await logs(id);
        throw new Error(`Packaged fixture timed out: ${description}; see ${directory}`);
      }
      await delay(500);
    }
  }

  async function origin(id) {
    const value = await ownedContainer(id);
    return `http://127.0.0.1:${value.NetworkSettings.Ports['3000/tcp'][0].HostPort}`;
  }

  async function healthy(id) {
    const url = await origin(id);
    await waitFor(async () => {
      try { return (await fetch(`${url}/health`)).ok; } catch { return false; }
    }, 'web HTTP health', 60000);
    return url;
  }

  return {
    ...verified,
    pool,
    environment,
    directory,
    evidence,
    revision,
    backendImageId: image.Id,
    start,
    stop,
    logs,
    docker,
    waitFor,
    healthy,
    ownedContainer,
  };
}

module.exports = { packagedFixture, retirePackagedResources };
