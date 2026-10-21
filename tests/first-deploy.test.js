// A project's FIRST deploy is app delivery's like every other
// (src/workflow/app-creation/ asks it; staging.deployProduction runs it),
// with what creation needs (design-step3-app-fleet.md, Q1 (b)):
//
//   - the made screen's steps (build, deploy) and where the time went;
//   - no app-health notification for a failure (the made screen shows it);
//   - without GitHub, no repository: the project's starter files are built;
//   - the starter commit its setup made, cloned back exactly: its build may
//     write the starter's shared layer cache, and a ready-made app's image
//     built ahead under its key is deployed instead of a build.
//
// Functional, against the real deployProduction with its collaborators
// stubbed, as tests/rebuild-deploy-failed-notify-once.test.js does.
//
// Run with: node --test tests/first-deploy.test.js

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');

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
  ws: require.resolve('../src/services/ws'),
  appCreator: require.resolve('../src/services/app-creator'),
  appSketch: require.resolve('../src/services/app-sketch'),
  starterImages: require.resolve('../src/services/starter-images'),
};

stub(ids.logger, { info() {}, warn() {}, error() {}, debug() {} });

let fx;
const fresh = () => ({ head: 'a'.repeat(40), execs: [], builds: [], phases: [], notified: [], buildError: null, prebuilt: null, imageForCalls: [] });

stub(ids.docker, {
  execFileAsync: async (cmd, args) => {
    fx.execs.push([cmd, ...args]);
    if (cmd === 'git' && args.includes('rev-parse')) return { stdout: `${fx.head}\n`, stderr: '' };
    return { stdout: '', stderr: '' };
  },
});
stub(ids.github, { getCloneUrl: async () => 'https://github.com/bot/made.git' });
stub(ids.appManifest, {
  read: () => ({ secrets: [] }),
  reconcileAppName: async () => {}, reconcileAppVisibility: async () => {}, reconcileAppGovernance: async () => {},
  reconcileAppAdmins: async () => {}, reconcileAppTopics: async () => null, reconcileAppScreenshot: async () => {},
  reconcileAppIcon: async () => {}, MAX_APP_NAME_LENGTH: 64,
});
stub(ids.notifications, {
  createAppHealthNotification: async (pool, args) => { fx.notified.push(args); return []; },
  hydrateAndPush: async () => {},
});
stub(ids.caddy, {});
stub(ids.dbManager, { appDbName: (slug) => `app_${slug}`, connectionUrl: () => 'postgres://app' });
stub(ids.applicationRuntime, {
  mode: () => 'docker',
  productionRef: () => ({ runtimeKind: 'docker', runtimeName: 'usernode-app-made' }),
  build: async (config, params) => {
    fx.builds.push({ ...params, files: fs.existsSync(params.sourceDir) ? fs.readdirSync(params.sourceDir).sort() : [] });
    if (fx.buildError) throw fx.buildError;
    return { imageRef: 'usernode-app-made:latest', buildRef: null };
  },
  deploy: async (config, options) => {
    options.onRollout?.();
    return { runtimeKind: 'docker', runtimeName: 'usernode-app-made', url: 'https://made.example' };
  },
});
stub(ids.appSecrets, { getRawValues: async () => ({}), platformDefaultsFromEnv: () => ({}), mergeForDeploy: () => ({ missingRequired: [], env: {} }) });
stub(ids.appLlmEnv, { productionLlmEnv: async () => ({}) });
stub(ids.appStorageEnv, { productionStorageEnv: async () => ({}) });
stub(ids.appIdentityEnv, { appIdentityEnv: () => ({}) });
stub(ids.stagingEnv, {});
stub(ids.events, { emit: () => {} });
stub(ids.buildRetentionGuard, { withResourceUse: (config, classifier, resource, fn) => fn(), withBuildUse: (c, fn) => fn() });
stub(ids.ws, { pushAppCreationPhase: (p) => fx.phases.push(p.phase) });
stub(ids.appCreator, { starterFiles: () => [{ path: 'Dockerfile', content: 'FROM node:22-alpine\n' }, { path: 'dapp.json', content: '{}\n' }] });
stub(ids.appSketch, { readSketch: async () => null });
stub(ids.starterImages, {
  imageFor: async (config, pool, args) => { fx.imageForCalls.push(args); return fx.prebuilt; },
});

const pool = {
  query: async (sql) => {
    if (/SELECT db_password FROM apps/.test(String(sql))) return { rows: [{ db_password: 'secret' }] };
    if (/WITH before AS/.test(String(sql))) return { rows: [{ previous_failure: null }], rowCount: 1 };
    return { rows: [], rowCount: 1 };
  },
};
stub(ids.pool, { getPool: () => pool });

const staging = require('../src/services/staging');
const config = {};
const project = (over = {}) => ({ id: 8, slug: 'made', name: 'Made', status: 'creating', repo_url: 'https://github.com/bot/made', template: 'grocery-list', ...over });

test.beforeEach(() => { fx = fresh(); });

test('a project\'s first deploy says its steps, where its time went, and where it runs', async () => {
  const result = await staging.deployProduction(config, project());
  assert.deepEqual(fx.phases, ['build', 'deploy']);
  assert.equal(result.url, 'https://made.example');
  assert.deepEqual(Object.keys(result.timing.stages), ['checkout', 'lock', 'manifest', 'build', 'deploy', 'rollout']);
  assert.deepEqual(result.timing.build, { engine: 'docker' });
});

test('a running app\'s deploy says none of that', async () => {
  const result = await staging.deployProduction(config, project({ status: 'running' }));
  assert.deepEqual(fx.phases, []);
  assert.equal(result.timing, undefined);
});

test('a first deploy that fails tells nobody: the made screen shows it', async () => {
  fx.buildError = new Error('npm ERR! missing script: build');
  await assert.rejects(staging.deployProduction(config, project()), /missing script/);
  assert.deepEqual(fx.notified, []);
  await assert.rejects(staging.deployProduction(config, project({ status: 'running' })), /missing script/);
  assert.equal(fx.notified.length, 1, 'a running app\'s failure is told, as before');
});

test('without a repository (GitHub off) the project\'s starter files are what is built', async () => {
  await staging.deployProduction(config, project({ repo_url: null }));
  assert.ok(!fx.execs.some(([cmd, sub]) => cmd === 'git' && sub === 'clone'), 'nothing to clone');
  assert.equal(fx.builds.length, 1);
  assert.equal(fx.builds[0].revision, null);
  assert.deepEqual(fx.builds[0].files, ['Dockerfile', 'dapp.json', 'public'], 'the starter, written out');
});

test('the starter commit cloned back exactly: its build writes the starter\'s cache; any other commit does not', async () => {
  await staging.deployProduction(config, project(), { starter: { sha: 'A'.repeat(40), template: 'grocery-list' } });
  assert.equal(fx.builds[0].starterTree, true);
  fx = fresh();
  fx.head = 'b'.repeat(40);
  await staging.deployProduction(config, project(), { starter: { sha: 'a'.repeat(40), template: 'grocery-list' } });
  assert.equal(fx.builds[0].starterTree, undefined, 'main moved past it: not the starter\'s tree');
});

test('a ready-made app\'s image built ahead under its key is deployed, and nothing is built', async () => {
  fx.prebuilt = { imageRef: 'registry/homeroom-starter-grocery@sha256:1', buildRef: null, reused: true, prebuilt: { template: 'grocery-list', key: 'k'.repeat(12) } };
  const result = await staging.deployProduction(config, project(), { starter: { sha: 'a'.repeat(40), template: 'grocery-list', key: 'k'.repeat(64) } });
  assert.deepEqual(fx.imageForCalls, [{ key: 'k'.repeat(64), slug: 'made' }]);
  assert.equal(fx.builds.length, 0);
  assert.equal(result.imageRef, 'registry/homeroom-starter-grocery@sha256:1');
  assert.equal(result.timing.build.engine, 'prebuilt');
  // Not the starter's commit any more: no image is asked for.
  fx = fresh();
  fx.head = 'c'.repeat(40);
  await staging.deployProduction(config, project(), { starter: { sha: 'a'.repeat(40), template: 'grocery-list', key: 'k'.repeat(64) } });
  assert.deepEqual(fx.imageForCalls, []);
  assert.equal(fx.builds.length, 1);
});
