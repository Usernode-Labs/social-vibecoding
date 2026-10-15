'use strict';

// An app image that names no USER runs as root, and app Pods run with
// runAsNonRoot, so Kubernetes refuses it before it starts. Goalio sat like that
// from 17 Sep to 15 Oct 2026: every automatic path retried the same commit
// (~1,200 attempts a day), its merges read as done, and its September version
// kept serving. deploy-failure.js names the refusal and what to change;
// deployProduction does not build or roll out that commit again unless a
// person asks (app delivery passes retrySameCommit for a request that is a
// Redeploy, a "Check for updates" or a demo reset); the automatic paths wait
// for a commit that changes it.
//
// Functional, against the real deployProduction with its collaborators
// stubbed (the harness of tests/rebuild-deploy-failed-notify-once.test.js),
// plus deploy-failure.js on its own.

const test = require('node:test');
const assert = require('node:assert/strict');

function stub(id, exports) {
  require.cache[id] = { id, filename: id, loaded: true, exports, paths: [] };
}

const ids = {
  logger: require.resolve('../src/services/logger'),
  pool: require.resolve('../src/db/pool'),
  docker: require.resolve('../src/services/docker'),
  github: require.resolve('../src/services/github'),
  appManifest: require.resolve('../src/services/app-manifest'),
  notifications: require.resolve('../src/services/notifications'),
  caddy: require.resolve('../src/services/caddy'),
  dbManager: require.resolve('../src/services/db-manager'),
  applicationRuntime: require.resolve('../src/services/application-runtime'),
  appSecrets: require.resolve('../src/services/app-secrets'),
  appLlmEnv: require.resolve('../src/services/app-llm-env'),
  appStorageEnv: require.resolve('../src/services/app-storage-env'),
  appIdentityEnv: require.resolve('../src/services/app-identity-env'),
  stagingEnv: require.resolve('../src/services/staging-env'),
  events: require.resolve('../src/services/events'),
  buildRetentionGuard: require.resolve('../src/services/build-retention-guard'),
};

const logged = [];
stub(ids.logger, {
  info: (...a) => logged.push(['info', ...a]),
  warn: (...a) => logged.push(['warn', ...a]),
  error: (...a) => logged.push(['error', ...a]),
  debug: (...a) => logged.push(['debug', ...a]),
});

let headSha = null;
stub(ids.docker, {
  execFileAsync: async (cmd, args) => {
    if (cmd === 'git' && args.includes('rev-parse')) return { stdout: `${headSha}\n`, stderr: '' };
    return { stdout: '', stderr: '' };
  },
});
stub(ids.github, { getCloneUrl: async () => 'https://github.com/example/falling-sands.git' });

let buildError = null;
stub(ids.appManifest, {
  read: () => { if (buildError) throw buildError; return { secrets: [] }; },
  reconcileAppName: async () => {},
  reconcileAppVisibility: async () => {},
  reconcileAppGovernance: async () => {},
  reconcileAppAdmins: async () => {},
  reconcileAppTopics: async () => null,
  reconcileAppScreenshot: async () => {},
  reconcileAppIcon: async () => {},
  MAX_APP_NAME_LENGTH: 64,
});

const notified = [];
const pushed = [];
stub(ids.notifications, {
  createAppHealthNotification: async (pool, args) => {
    notified.push(args);
    return [{ id: notified.length, kind: 'app_health', detail: args.detail }];
  },
  hydrateAndPush: async (pool, row) => { pushed.push(row); },
});

stub(ids.caddy, {});
stub(ids.dbManager, { appDbName: slug => `app_${slug}`, connectionUrl: () => 'postgres://app' });
let deployedOptions = null;
let deploys = 0;
let builds = 0;
let deployError = null;
let observedLive = null;
stub(ids.applicationRuntime, {
  productionRef: () => ({ runtimeKind: 'docker', runtimeName: 'usernode-app-falling-sands' }),
  inspect: async () => observedLive || { status: 'not_found', labels: {} },
  probeHealth: async () => true,
  build: async () => { builds += 1; return { imageRef: 'image@sha256:abc', buildRef: 'build-1' }; },
  deploy: async (_config, options) => {
    deployedOptions = options;
    deploys += 1;
    if (deployError) throw deployError();
    return { runtimeKind: 'docker', runtimeName: 'usernode-app-falling-sands' };
  },
});
stub(ids.appSecrets, {
  getRawValues: async () => ({}),
  platformDefaultsFromEnv: () => ({}),
  mergeForDeploy: () => ({ missingRequired: [], env: {} }),
});
stub(ids.appLlmEnv, { productionLlmEnv: async () => ({}) });
stub(ids.appStorageEnv, { productionStorageEnv: async () => ({}) });
stub(ids.appIdentityEnv, { appIdentityEnv: () => ({}) });
stub(ids.stagingEnv, {});
stub(ids.events, { emit: () => {} });
stub(ids.buildRetentionGuard, { withResourceUse: (config, classifier, resource, fn) => fn() });

// One apps row, with a real last_failure that the UPDATE ... RETURNING
// reads before it writes, the way Postgres does.
const appRow = { id: 8, slug: 'falling-sands', last_failure: null };
const queries = [];
const pool = {
  query: async (sql, params) => {
    const s = String(sql);
    queries.push({ sql: s, params });
    if (/SELECT db_password FROM apps/.test(s)) return { rows: [{ db_password: 'secret' }] };
    if (/^SELECT last_failure FROM apps WHERE id = \$1$/.test(s)) return { rows: [{ last_failure: appRow.last_failure }] };
    if (/UPDATE apps SET last_failure = \$1/.test(s)) {
      assert.equal(params[1], appRow.id);
      const previous = appRow.last_failure;
      appRow.last_failure = JSON.parse(params[0]);
      if (!s.includes('WITH before')) return { rows: [], rowCount: 1 };
      assert.match(s, /WITH before AS \(SELECT last_failure FROM apps WHERE id = \$2\)/);
      assert.match(s, /RETURNING \(SELECT last_failure FROM before\) AS previous_failure/);
      return { rows: [{ previous_failure: previous }], rowCount: 1 };
    }
    if (/UPDATE apps SET last_failure = NULL/.test(s)) {
      appRow.last_failure = null;
      return { rows: [], rowCount: 1 };
    }
    return { rows: [], rowCount: 0 };
  },
};
stub(ids.pool, { getPool: () => pool });

const staging = require('../src/services/staging');
const deployFailure = require('../src/services/deploy-failure');

const RED = 'e7ab4060ee62bea30536db98af7a06aff33554e9';
const FIXED = 'f1d0000000000000000000000000000000000000';
const app = { id: 8, slug: 'falling-sands', repo_url: 'https://github.com/example/falling-sands', main_sha: 'de34dda' };
const config = {};

function rootRefusal() {
  const err = new Error('Deployment social-apps/sv-app-8-falling-sands cannot start: app: CreateContainerConfigError: '
    + 'container has runAsNonRoot and image will run as root (pod: "sv-app-8-x", container: app)');
  err.healthcheckFailed = true;
  err.containerStatus = 'not_ready';
  err.terminalPodDetails = 'app: CreateContainerConfigError: container has runAsNonRoot and image will run as root';
  err.containerLogs = err.terminalPodDetails;
  return err;
}

function reset() {
  appRow.last_failure = null;
  queries.length = 0;
  notified.length = 0;
  pushed.length = 0;
  logged.length = 0;
  headSha = RED;
  deployedOptions = null;
  observedLive = null;
  buildError = null;
  deployError = rootRefusal;
  deploys = 0;
  builds = 0;
}

test('a root-image refusal is named, with what to change, and marked to wait for a new commit', () => {
  const record = deployFailure.record(rootRefusal(), { sha: RED });
  assert.equal(record.kind, deployFailure.ROOT_IMAGE);
  assert.equal(record.stage, 'healthcheck');
  assert.match(record.reason, /^\[not_ready\] /);
  assert.match(record.reason, /runAsNonRoot/);
  assert.match(record.reason, /USER 1000:1000/);
  assert.ok(record.reason.length <= 280);
  assert.equal(deployFailure.waitsForNewCommit(record, RED), true);
  assert.equal(deployFailure.waitsForNewCommit(record, RED.toUpperCase()), true, 'case does not matter');
  assert.equal(deployFailure.waitsForNewCommit(JSON.stringify(record), RED), true, 'the stored JSON form too');
  assert.equal(deployFailure.waitsForNewCommit(record, FIXED), false, 'a new commit goes ahead');
  assert.equal(deployFailure.waitsForNewCommit({ ...record, sha: null }, RED), false);
  assert.equal(deployFailure.waitsForNewCommit(null, RED), false);

  const other = new Error('Deployment x cannot start: app: CrashLoopBackOff');
  other.healthcheckFailed = true;
  const otherRecord = deployFailure.record(other, { sha: RED });
  assert.equal(otherRecord.kind, undefined, 'any other failure keeps being retried');
  assert.equal(deployFailure.waitsForNewCommit(otherRecord, RED), false);
  assert.equal(deployFailure.isRootImageRefusal(other), false);
});

test('the first refusal is recorded and its people are told once', async () => {
  reset();
  await assert.rejects(staging.deployProduction(config, app), /runAsNonRoot/);
  assert.equal(appRow.last_failure.kind, 'root_image');
  assert.equal(appRow.last_failure.sha, RED);
  assert.match(appRow.last_failure.reason, /USER 1000:1000/);
  assert.equal(notified.length, 1);
  assert.equal(builds, 1);
});

test('an automatic retry of the refused commit stops after the clone: no build, no rollout, no new record', async () => {
  reset();
  await assert.rejects(staging.deployProduction(config, app), /runAsNonRoot/);
  const recorded = appRow.last_failure;
  notified.length = 0;
  logged.length = 0;

  await assert.rejects(staging.deployProduction(config, app), (err) => err instanceof staging.WaitsForNewCommitError && err.sha === RED);
  assert.equal(builds, 1, 'no second build');
  assert.equal(deploys, 1, 'no second rollout');
  assert.deepEqual(appRow.last_failure, recorded, 'the original failure stays as it was');
  assert.equal(notified.length, 0);
  assert.ok(logged.some(([level, , msg]) => level === 'info' && /Production rebuild skipped/.test(msg)));
  assert.ok(!logged.some(([level]) => level === 'error'), 'nothing logged as an error for a skip');
});

test('a deploy asked for by hand retries the refused commit', async () => {
  reset();
  await assert.rejects(staging.deployProduction(config, app), /runAsNonRoot/);
  await assert.rejects(staging.deployProduction(config, app, { retrySameCommit: true }), /runAsNonRoot/);
  assert.equal(builds, 2);
  assert.equal(deploys, 2);
});

test('a commit that fixes the Dockerfile goes ahead and clears the failure', async () => {
  reset();
  await assert.rejects(staging.deployProduction(config, app), /runAsNonRoot/);
  headSha = FIXED;
  deployError = null;
  const result = await staging.deployProduction(config, app);
  assert.equal(result.sha, FIXED);
  assert.equal(builds, 2);
  assert.equal(appRow.last_failure, null);
});
