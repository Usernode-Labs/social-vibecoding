'use strict';

// Call only after parent/child isolation preflight. All phase services are real.
const assert = require('node:assert/strict');
const path = require('node:path');
const { createPreviewFlow } = require('../../src/services/preview-flow/store');
const { createPreviewWork } = require('../../src/services/preview-flow/work');
const { createCloneOperations } = require('../../src/services/preview-flow/clone-operation');
const { createImageBuildOperations } = require('../../src/services/preview-flow/image-build-operation');
const { createRuntimeOperations } = require('../../src/services/preview-flow/runtime-operation');
const { createCleanup } = require('../../src/services/preview-flow/cleanup');

function completePreparationWorker(pool, verified, {
  owner = createPreviewFlow(pool),
  onPhase = async () => {},
  loseReplies = false,
} = {}) {
  const { fixture, clients, databaseAddress } = verified;
  assert.ok(fixture.preparationSource && databaseAddress, 'Verified complete preparation fixture required');
  const config = {
    ...fixture.config,
    databaseUrl: pool.options.connectionString,
    dataEncryptionKey: 'c7-disposable-only',
    nativePreviewWorkerEnabled: true,
    nativePreviewAttempts: true,
    nativePreviewRecoverableClone: true,
    nativePreviewRecoverableBuild: true,
    nativePreviewRecoverableRuntime: true,
  };
  assert.ok(config.databaseUrl, 'Explicit fixture database required');
  const environment = {
    DB_ADMIN_URL: fixture.isolation.database.url,
    HOME: path.join(fixture.isolation.directory, 'home'),
    GIT_CONFIG_NOSYSTEM: '1',
    GIT_CONFIG_GLOBAL: '/dev/null',
    GIT_TERMINAL_PROMPT: '0',
    PLATFORM_INTERNAL_URL: 'http://fixture.invalid',
  };
  const originalEnvironment = Object.fromEntries(Object.keys(environment).map(key => [key, process.env[key]]));
  Object.assign(process.env, environment);
  const restores = [];
  const events = [];
  const lost = new Set();
  const counts = {
    cloneCopies: 0,
    build: 0,
    secret: 0,
    service: 0,
    deployment: 0,
  };
  const cloneOids = new Set();

  async function phase(name, identity) {
    events.push(name);
    await onPhase(name, identity);
    if (loseReplies && ['clone_complete', 'build_created', 'created_service', 'runtime_receipt', 'accepted'].includes(name)
        && !lost.has(name)) {
      lost.add(name);
      throw new Error(`Injected lost reply after actual ${name}`);
    }
  }

  function replace(object, key, replacement) {
    const previous = object[key];
    object[key] = replacement(previous);
    restores.push(() => { object[key] = previous; });
  }

  const docker = require('../../src/services/docker');
  replace(docker, 'execFileAsync', original => async (command, args, options) => {
    const result = await original(command, args, options);
    if (command === 'git' && args.includes('rev-parse') && args.includes('HEAD')) {
      assert.equal(result.stdout.trim(), fixture.preparationSource.revision);
      await phase('source_prepared', result.stdout.trim());
    }
    return result;
  });
  const dbManager = require('../../src/services/db-manager');
  replace(dbManager, 'connectionUrl', original => (name, password) => {
    const url = new URL(original(name, password));
    // Network translation only: credentials/name come from the real adapter.
    assert.equal(url.hostname, '127.0.0.1');
    url.hostname = databaseAddress;
    url.port = '5432';
    return url.toString();
  });
  const clones = createCloneOperations({
    databaseUrl: fixture.isolation.database.url,
    maintenanceDatabase: new URL(fixture.isolation.database.url).pathname.slice(1),
    ensureTemplate: async source => ({ template: `${source}_stgtmpl` }),
    async onPhase(name) {
      if (name === 'copy_committed') counts.cloneCopies++;
      if (name === 'finalize_committed') await phase('clone_complete');
    },
  });
  replace(clones, 'prepare', original => async (intent, password) => {
    try {
      return await original(intent, password);
    } finally {
      const observed = await clones.inspect(intent);
      if (observed.databaseOid) cloneOids.add(observed.databaseOid);
    }
  });
  const wrapped = {};
  for (const lane of ['core', 'apps', 'custom']) {
    wrapped[lane] = new Proxy(clients[lane], {
      get(target, key) {
        const kind = {
          createNamespacedCustomObject: 'build',
          createNamespacedSecret: 'secret',
          createNamespacedService: 'service',
          createNamespacedDeployment: 'deployment',
        }[key];
        if (kind) return async (...args) => {
          counts[kind]++;
          return target[key](...args);
        };
        const value = target[key];
        return typeof value === 'function' ? value.bind(target) : value;
      },
    });
  }
  const images = createImageBuildOperations({
    clients: () => wrapped,
    onObservation: (name, intent) => phase(`build_${name}`, intent),
  });
  const probe = async (_config, intent) => {
    try {
      const body = await clients.core.connectGetNamespacedServiceProxyWithPath({
        namespace: intent.namespace,
        name: `${intent.runtimeName}:3000`,
        path: 'health',
      });
      return body === 'Ok\n' || body === 'serving';
    } catch { return false; }
  };
  const runtimes = createRuntimeOperations({
    clients: () => wrapped,
    dataKey: config.dataEncryptionKey,
    probe,
    onObservation: phase,
  });
  replace(owner, 'recordRuntime', original => async (...args) => {
    const result = await original(...args);
    await phase('runtime_receipt');
    return result;
  });
  const work = createPreviewWork(pool, config, {
    owner, clones, images, runtimes,
    cleanup: createCleanup({ clones, images, runtimes }).underBuildLock,
    // No prepare override: exercise staging.prepareCandidateUnderBuildLock.
  });
  replace(work.store, 'settle', original => async (...args) => {
    const result = await original(...args);
    const record = await work.store.read(args[0].id);
    if (record.status === 'succeeded' && record.result?.accepted) await phase('accepted');
    return result;
  });

  let restored = false;

  function restore() {
    if (restored) return;
    restored = true;
    for (const undo of restores.reverse()) undo();
    for (const [key, value] of Object.entries(originalEnvironment)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }

  return {
    config,
    work,
    owner,
    clones,
    images,
    runtimes,
    probe,
    counts,
    cloneOids,
    events,
    lost,
    restore,
  };
}

module.exports = { completePreparationWorker };
