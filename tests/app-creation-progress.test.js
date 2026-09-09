// Creation progress: app-creator must report which phase it is in, so
// the create dialog can tick its four steps off as they actually happen
// rather than guessing on a timer.
//
// The row itself cannot carry this — apps.status goes straight from
// 'creating' to a terminal value — so the phase rides on the in-memory
// services/app-creation-phase.js store plus a scoped
// ws.pushAppCreationPhase broadcast on the SAME app_status channel the
// terminal transitions already use. No new socket, no new connection.
//
// Same require.cache stubbing pattern as app-creator-failure.test.js:
// nothing real (docker, GitHub, WS) spins up. app-creation-phase.js runs
// for real, since what it records is exactly what's under test.
//
// Run with: node --test tests/app-creation-progress.test.js

const test = require('node:test');
const assert = require('node:assert/strict');

function stub(id, exports) {
  require.cache[id] = { id, filename: id, loaded: true, exports, paths: [] };
}

function makeRecordingPool() {
  const queries = [];
  return {
    queries,
    async query(sql, params) {
      queries.push({ sql: String(sql), params });
      return { rows: [], rowCount: 1 };
    },
  };
}

function loadAppCreator({ dockerStubs = {}, secretsStubs = {}, wsStubs = {} } = {}) {
  const ids = {
    logger: require.resolve('../src/services/logger'),
    github: require.resolve('../src/services/github'),
    docker: require.resolve('../src/services/docker'),
    // Not stubbed, but MUST be cache-busted: it is the module that
    // actually calls docker, so a copy cached against the real docker
    // would sail past the stubs above.
    applicationRuntime: require.resolve('../src/services/application-runtime'),
    appStorageEnv: require.resolve('../src/services/app-storage-env'),
    deployFailure: require.resolve('../src/services/deploy-failure'),
    caddy: require.resolve('../src/services/caddy'),
    dbManager: require.resolve('../src/services/db-manager'),
    appManifest: require.resolve('../src/services/app-manifest'),
    appSecrets: require.resolve('../src/services/app-secrets'),
    appLlmEnv: require.resolve('../src/services/app-llm-env'),
    template: require.resolve('../src/services/template'),
    pool: require.resolve('../src/db/pool'),
    ws: require.resolve('../src/services/ws'),
    creationPhase: require.resolve('../src/services/app-creation-phase'),
    appCreator: require.resolve('../src/services/app-creator'),
  };
  for (const id of Object.values(ids)) delete require.cache[id];

  const pool = makeRecordingPool();
  const statusPushes = [];
  const phasePushes = [];

  stub(ids.logger, { info: () => {}, warn: () => {}, error: () => {}, debug: () => {} });
  stub(ids.github, {
    isEnabled: () => false,
    parseGithubUrl: () => null,
    getBotUsername: async () => 'usernode-bot',
    createRepo: async () => ({ html_url: 'https://github.com/usernode-bot/test-app' }),
    pushFiles: async () => {},
    getCloneUrl: async () => 'https://github.com/usernode-bot/test-app.git',
  });
  stub(ids.docker, {
    execFileAsync: async () => ({ stdout: '', stderr: '' }),
    buildImage: async () => {},
    stopAndRemove: async () => {},
    runContainer: async () => 'container-id-123',
    waitForHealthy: async () => {},
    getHostPort: async () => null,
    ...dockerStubs,
  });
  stub(ids.caddy, { productionHostname: (slug) => `${slug}.example.test` });
  stub(ids.dbManager, {
    appDbName: (slug) => `app_${slug}`,
    createDatabase: async () => ({ password: 'pw' }),
    connectionUrl: () => 'postgres://x',
  });
  stub(ids.appManifest, {
    read: () => ({ secrets: [] }),
    reconcileAppName: async () => {},
    reconcileAppVisibility: async () => {},
    reconcileAppGovernance: async () => {},
    reconcileAppScreenshot: async () => {},
    reconcileAppIcon: async () => {},
    reconcileAppAdmins: async () => {},
  });
  stub(ids.appSecrets, {
    getRawValues: async () => ({}),
    mergeForDeploy: () => ({ missingRequired: [], env: {} }),
    platformDefaultsFromEnv: () => ({}),
    ...secretsStubs,
  });
  stub(ids.appLlmEnv, { productionLlmEnv: async () => ({}) });
  stub(ids.template, { getTemplateFiles: () => [] });
  stub(ids.pool, { getPool: () => pool });
  stub(ids.ws, {
    pushAppStatusUpdate: (payload) => statusPushes.push(payload),
    pushAppCreationPhase: (payload) => phasePushes.push(payload),
    ...wsStubs,
  });

  const creationPhase = require(ids.creationPhase);
  const appCreator = require(ids.appCreator);
  return { appCreator, creationPhase, pool, statusPushes, phasePushes };
}

const APP_ROW = { id: 42, name: 'Test App', slug: 'test-app' };

test('createApp walks the four phases in order and broadcasts each one', async () => {
  const { appCreator, phasePushes } = loadAppCreator();

  await appCreator.createApp({}, APP_ROW);

  assert.deepEqual(
    phasePushes.map((p) => p.phase),
    ['database', 'repository', 'build', 'deploy'],
    'every step of createApp reports itself, in order'
  );
  for (const push of phasePushes) {
    assert.equal(push.slug, 'test-app', 'slug scopes the broadcast');
    assert.equal(push.id, 42, 'appId scopes the broadcast for a view-private app');
  }
});

test('a finished creation reports no phase — the store is cleared on running', async () => {
  const { appCreator, creationPhase, statusPushes } = loadAppCreator();

  await appCreator.createApp({}, APP_ROW);

  assert.ok(statusPushes.some((p) => p.status === 'running'), 'reached the terminal status');
  assert.equal(
    creationPhase.read('test-app'), null,
    'a live app must not keep claiming a creation phase'
  );
});

test('the store tracks the current phase while creation is in flight', async () => {
  // Sample the store from inside the build step — the one moment we can
  // observe mid-flight without reaching into module internals. The
  // holder is filled by loadAppCreator below, before createApp runs.
  const observed = { phase: undefined };
  const loaded = {};
  const { appCreator, creationPhase } = loadAppCreator({
    dockerStubs: {
      buildImage: async () => { observed.phase = loaded.creationPhase.read('test-app'); },
    },
  });
  loaded.creationPhase = creationPhase;

  await appCreator.createApp({}, APP_ROW);

  assert.ok(observed.phase, 'the build step ran and found a live phase entry');
  assert.equal(observed.phase.phase, 'build',
    'the store reports the step that is actually running');
});

test('a failed creation clears the phase so the dialog can show the error', async () => {
  const buildErr = new Error('Command failed: docker build');
  buildErr.buildFailed = true;
  buildErr.buildLog = 'ERROR: no Dockerfile';

  const { appCreator, creationPhase, statusPushes } = loadAppCreator({
    dockerStubs: { buildImage: async () => { throw buildErr; } },
  });

  await appCreator.createApp({}, APP_ROW);

  assert.ok(statusPushes.some((p) => p.status === 'error'), 'reached the error status');
  assert.equal(creationPhase.read('test-app'), null, 'no phase survives the failure');
});

test('awaiting_secrets clears the phase too — creation stopped, it did not fail', async () => {
  const { appCreator, creationPhase, statusPushes } = loadAppCreator({
    secretsStubs: {
      mergeForDeploy: () => ({ missingRequired: ['API_KEY'], env: {} }),
    },
  });

  await appCreator.createApp({}, APP_ROW);

  const push = statusPushes.find((p) => p.status === 'awaiting_secrets');
  assert.ok(push, 'reached awaiting_secrets');
  assert.deepEqual(push.missingSecrets, ['API_KEY']);
  assert.equal(creationPhase.read('test-app'), null);
});

// Progress reporting is DISPLAY state. It is called from inside
// createApp's try block, so a throw there would be caught by the outer
// handler and flip a perfectly good app to status='error' — a cosmetic
// detail sinking the whole creation. It must not be able to.
test('a broken phase broadcast does not fail the creation', async () => {
  const { appCreator, statusPushes } = loadAppCreator({
    wsStubs: {
      pushAppCreationPhase: () => { throw new Error('socket exploded'); },
    },
  });

  await appCreator.createApp({}, APP_ROW);

  assert.ok(statusPushes.some((p) => p.status === 'running'),
    'creation still reached running');
  assert.ok(!statusPushes.some((p) => p.status === 'error'),
    'no error flip from a cosmetic failure');
});
