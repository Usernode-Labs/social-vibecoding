'use strict';

// #4895: a new project took ~45 s from Make it to ready, and nothing said
// where. services/app-creation-timing.js keeps one stopwatch per creation
// attempt and writes an `app_creation_timed` event for it; app-creator.js
// makes the database and the repository side by side, and writes the
// starter it just committed out as the build's tree instead of cloning it
// back. Same require.cache stubbing as app-creator-failure.test.js: nothing
// real (docker, GitHub, WS) spins up.
//
// Run with: node --test tests/app-creation-timing.test.js

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const timingModule = require('../src/services/app-creation-timing');

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

function loadAppCreator({ dockerStubs = {}, githubStubs = {}, dbStubs = {}, templateFiles = [] } = {}) {
  const ids = {
    logger: require.resolve('../src/services/logger'),
    github: require.resolve('../src/services/github'),
    docker: require.resolve('../src/services/docker'),
    applicationRuntime: require.resolve('../src/services/application-runtime'),
    caddy: require.resolve('../src/services/caddy'),
    dbManager: require.resolve('../src/services/db-manager'),
    appManifest: require.resolve('../src/services/app-manifest'),
    appSecrets: require.resolve('../src/services/app-secrets'),
    appLlmEnv: require.resolve('../src/services/app-llm-env'),
    template: require.resolve('../src/services/template'),
    pool: require.resolve('../src/db/pool'),
    ws: require.resolve('../src/services/ws'),
    events: require.resolve('../src/services/events'),
    timing: require.resolve('../src/services/app-creation-timing'),
    appCreator: require.resolve('../src/services/app-creator'),
  };
  for (const id of Object.values(ids)) delete require.cache[id];

  const pool = makeRecordingPool();
  const phases = [];
  const execs = [];
  let runOptions = null;

  stub(ids.logger, { info: () => {}, warn: () => {}, error: () => {}, debug: () => {} });
  stub(ids.github, {
    isEnabled: () => true,
    parseGithubUrl: () => ({ owner: 'usernode-bot', repo: 'timed-app' }),
    getBotUsername: async () => 'usernode-bot',
    createRepo: async (owner, slug) => ({ html_url: `https://github.com/${owner}/${slug}` }),
    pushFiles: async () => ({ sha: 'ABCDEF0123456789ABCDEF0123456789ABCDEF01' }),
    getCloneUrl: async () => 'https://github.com/usernode-bot/timed-app.git',
    ...githubStubs,
  });
  stub(ids.docker, {
    execFileAsync: async (cmd, args) => { execs.push([cmd, ...args]); return { stdout: 'f'.repeat(40), stderr: '' }; },
    buildImage: async () => {},
    stopAndRemove: async () => {},
    runContainer: async (_name, opts) => { runOptions = opts; return 'container-id'; },
    waitForHealthy: async () => {},
    getHostPort: async () => null,
    ...dockerStubs,
  });
  stub(ids.caddy, { productionHostname: (slug) => `${slug}.example.test` });
  stub(ids.dbManager, {
    appDbName: (slug) => `app_${slug}`,
    createDatabase: async () => ({ password: 'pw' }),
    connectionUrl: () => 'postgres://x',
    ...dbStubs,
  });
  stub(ids.appManifest, {
    read: () => ({ secrets: [] }),
    reconcileAppName: async () => {},
    reconcileAppVisibility: async () => {},
    reconcileAppGovernance: async () => {},
    reconcileAppScreenshot: async () => {},
    reconcileAppIcon: async () => {},
    reconcileAppAdmins: async () => {},
    reconcileAppTopics: async () => null,
  });
  stub(ids.appSecrets, {
    getRawValues: async () => ({}),
    mergeForDeploy: () => ({ missingRequired: [], env: {} }),
    platformDefaultsFromEnv: () => ({}),
  });
  stub(ids.appLlmEnv, { productionLlmEnv: async () => ({}) });
  stub(ids.template, {
    getTemplateFiles: () => templateFiles,
    getConnectorScaffoldFiles: () => [],
    getCanonicalRepoFile: () => null,
  });
  stub(ids.pool, { getPool: () => pool });
  stub(ids.ws, {
    pushAppStatusUpdate: () => {},
    pushAppCreationPhase: (payload) => phases.push(payload.phase),
  });

  const appCreator = require(ids.appCreator);
  const timed = () => pool.queries
    .filter((q) => /INSERT INTO events/.test(q.sql) && q.params[3] === 'app_creation_timed')
    .map((q) => ({ userId: q.params[0], appId: q.params[1], metadata: JSON.parse(q.params[4]) }));
  return { appCreator, pool, phases, execs, timed, runOptions: () => runOptions };
}

const STARTER = [
  { path: 'Dockerfile', content: 'FROM node:22-alpine\n' },
  { path: 'public/index.html', content: '<h1>Timed</h1>\n' },
  { path: 'dapp.json', content: '{ "secrets": [] }\n' },
];

function appRow(slug, extra = {}) {
  return { id: 77, name: 'Timed App', slug, created_by: 5, self_hosted: false, ...extra };
}

function cleanup(slug) {
  fs.rmSync(`/tmp/usernode-build-${slug}`, { recursive: true, force: true });
}

test('the database and the repository are made side by side', async (t) => {
  const slug = 'timed-overlap';
  t.after(() => cleanup(slug));
  let repoAsked;
  const asked = new Promise((resolve) => { repoAsked = resolve; });
  const { appCreator, timed, phases } = loadAppCreator({
    templateFiles: STARTER,
    githubStubs: {
      createRepo: async (owner, s) => { repoAsked(); return { html_url: `https://github.com/${owner}/${s}` }; },
    },
    dbStubs: {
      // Finishes only once the repository has been asked for: made one
      // after the other, this would fail instead.
      createDatabase: async () => {
        const serial = new Promise((_, reject) => setTimeout(() => reject(new Error('made one after the other')), 2000).unref());
        await Promise.race([asked, serial]);
        return { password: 'pw' };
      },
    },
  });

  await appCreator.createApp({}, appRow(slug));

  const [record] = timed();
  assert.equal(record.metadata.outcome, 'running', JSON.stringify(record.metadata));
  assert.deepEqual(phases, ['database', 'repository', 'build', 'deploy'],
    'the dialog still walks its four steps in order');
});

test('a database failure is thrown once the repository has settled, and names where it failed', async (t) => {
  const slug = 'timed-db-fail';
  t.after(() => cleanup(slug));
  let pushed = false;
  const { appCreator, pool, timed, phases } = loadAppCreator({
    templateFiles: STARTER,
    githubStubs: {
      pushFiles: async () => {
        await new Promise((r) => setTimeout(r, 30));
        pushed = true;
        return { sha: 'a'.repeat(40) };
      },
    },
    dbStubs: { createDatabase: async () => { throw new Error('too many connections'); } },
  });

  await appCreator.createApp({}, appRow(slug));

  assert.equal(pushed, true, 'the repository work finished before the failure was recorded');
  const failure = JSON.parse(pool.queries.find((q) => /SET last_failure = \$1/.test(q.sql)).params[0]);
  assert.match(failure.reason, /too many connections/);
  assert.deepEqual(phases, ['database'], 'the dialog fails on the database step');
  const [record] = timed();
  assert.equal(record.metadata.outcome, 'error');
  assert.deepEqual(record.metadata.failedIn, ['database']);
});

test('the starter just committed is written out as the build tree, not cloned back', async (t) => {
  const slug = 'timed-seeded';
  t.after(() => cleanup(slug));
  const { appCreator, execs, timed, runOptions } = loadAppCreator({ templateFiles: STARTER });

  await appCreator.createApp({}, appRow(slug));

  assert.ok(!execs.some(([cmd]) => cmd === 'git'), `no clone and no rev-parse: ${JSON.stringify(execs)}`);
  const dir = `/tmp/usernode-build-${slug}`;
  for (const f of STARTER) {
    assert.equal(fs.readFileSync(path.join(dir, f.path), 'utf8'), f.content, f.path);
  }
  assert.deepEqual(runOptions().labels, { 'social.usernode.io/source-revision': 'abcdef0123456789abcdef0123456789abcdef01' },
    'the container says it serves the commit just pushed');
  const [record] = timed();
  assert.equal(record.userId, 5, 'the event is the creator\'s');
  assert.equal(record.appId, 77);
  const m = record.metadata;
  assert.equal(m.outcome, 'running');
  assert.equal(m.kind, 'new_repo');
  assert.equal(m.starter, 'empty');
  assert.deepEqual(Object.keys(m.stages),
    ['database', 'repository', 'card', 'checkout', 'lock', 'manifest', 'build', 'deploy', 'rollout'],
    'every stage it reached, in order');
  for (const ms of Object.values(m.stages)) assert.ok(Number.isInteger(ms) && ms >= 0);
  assert.ok(Number.isInteger(m.totalMs) && m.totalMs >= 0);
  assert.deepEqual(m.build, { engine: 'docker' });
  assert.equal(m.failedIn, undefined);
});

// The starter's shared layer cache (services/kubernetes-buildkit.js): the
// build is told the starter the app was made from, and whether its tree is
// that starter exactly as this attempt committed it. Only that build writes
// the starter's cache.
function recordBuilds(t) {
  const runtime = require('../src/services/application-runtime');
  const real = runtime.build;
  const calls = [];
  runtime.build = async (config, params) => { calls.push(params); return real(config, params); };
  t.after(() => { runtime.build = real; });
  return calls;
}

test('the build of the starter just committed is told so, with the starter the app was made from', async (t) => {
  const slug = 'timed-starter-tree';
  t.after(() => cleanup(slug));
  const { appCreator, timed } = loadAppCreator({ templateFiles: STARTER });
  const calls = recordBuilds(t);

  await appCreator.createApp({}, appRow(slug, { template: 'grocery-list' }));

  assert.equal(calls.length, 1);
  assert.deepEqual(calls[0].app, { id: 77, slug, repo_url: `https://github.com/usernode-bot/${slug}`, template: 'grocery-list' });
  assert.equal(calls[0].starterTree, true);
  assert.equal(timed()[0].metadata.starter, 'grocery-list');
});

test('a build of anything but the starter just committed is not the starter\'s tree', async (t) => {
  for (const [label, githubStubs] of [
    ['adopted', { createRepo: async (owner, s) => ({ html_url: `https://github.com/${owner}/${s}`, adopted: true }) }],
    ['no sha', { pushFiles: async () => undefined }],
  ]) {
    const slug = `timed-not-tree-${label.replace(/\W/g, '')}`;
    t.after(() => cleanup(slug));
    const { appCreator } = loadAppCreator({ templateFiles: STARTER, githubStubs });
    const calls = recordBuilds(t);
    await appCreator.createApp({}, appRow(slug, { template: 'grocery-list' }));
    assert.equal(calls.length, 1, label);
    assert.equal(calls[0].app.template, 'grocery-list', `${label}: it still reads the starter's cache`);
    assert.equal(calls[0].starterTree, false, `${label}: cloned back, so it does not write it`);
  }
  // An import has no starter at all.
  const slug = 'timed-not-tree-import';
  t.after(() => cleanup(slug));
  const { appCreator } = loadAppCreator({ githubStubs: { getFileContent: async () => '{}' } });
  const calls = recordBuilds(t);
  await appCreator.createApp({}, appRow(slug, { repo_url: 'https://github.com/someone/thing' }));
  assert.equal(calls[0].app.template, null);
  assert.equal(calls[0].starterTree, false);
  // Nor has a fork, which deploys through the same tail with neither.
  const forkDir = fs.mkdtempSync(path.join(require('node:os').tmpdir(), 'timed-fork-'));
  t.after(() => fs.rmSync(forkDir, { recursive: true, force: true }));
  await appCreator.finalizeDeploy({}, {
    appId: 9, name: 'Fork', slug: 'timed-fork-tree', tempDir: forkDir, dbUrl: 'postgres://x',
    repoUrl: 'https://github.com/x/y', mainSha: null,
  });
  assert.equal(calls.length, 2);
  assert.equal(calls[1].app.template, null);
  assert.equal(calls[1].starterTree, false);
});

test('an adopted repository, or a push without a commit sha, is cloned as before', async (t) => {
  for (const [label, githubStubs] of [
    ['adopted', { createRepo: async (owner, s) => ({ html_url: `https://github.com/${owner}/${s}`, adopted: true }) }],
    ['no sha', { pushFiles: async () => undefined }],
  ]) {
    const slug = `timed-clone-${label.replace(/\W/g, '')}`;
    t.after(() => cleanup(slug));
    const { appCreator, execs, timed } = loadAppCreator({ templateFiles: STARTER, githubStubs });
    await appCreator.createApp({}, appRow(slug));
    assert.ok(execs.some(([cmd, sub]) => cmd === 'git' && sub === 'clone'), `${label}: cloned`);
    assert.ok(execs.some(([cmd, , , sub]) => cmd === 'git' && sub === 'rev-parse'), `${label}: its sha read back`);
    assert.equal(timed()[0].metadata.outcome, 'running', label);
  }
});

test('a failed build is timed too, with where it failed', async (t) => {
  const slug = 'timed-build-fail';
  t.after(() => cleanup(slug));
  const err = new Error('Command failed: docker build');
  err.buildFailed = true;
  err.buildLog = 'npm ERR! missing script: build';
  const { appCreator, timed } = loadAppCreator({
    templateFiles: STARTER,
    dockerStubs: { buildImage: async () => { throw err; } },
  });

  await appCreator.createApp({}, appRow(slug));

  const [record] = timed();
  assert.equal(record.metadata.outcome, 'error');
  assert.deepEqual(record.metadata.failedIn, ['build']);
  assert.ok(!('build' in record.metadata.stages), 'an unfinished stage has no duration');
  assert.ok('manifest' in record.metadata.stages);
});

test('an import is timed as an existing repository', async (t) => {
  const slug = 'timed-import';
  t.after(() => cleanup(slug));
  const { appCreator, timed } = loadAppCreator({
    githubStubs: { getFileContent: async () => '{}' },
  });
  await appCreator.createApp({}, appRow(slug, { repo_url: 'https://github.com/someone/timed-app' }));
  const [record] = timed();
  assert.equal(record.metadata.kind, 'existing_repo');
  assert.equal(record.metadata.outcome, 'running');
  assert.ok(!('card' in record.metadata.stages), 'an import waits for no card');
});

test('the fork path uses the shared deploy tail without a stopwatch and writes no timing', async () => {
  const { appCreator, timed } = loadAppCreator();
  await appCreator.finalizeDeploy({}, {
    appId: 9, name: 'Fork', slug: 'timed-fork', tempDir: '/tmp/x', dbUrl: 'postgres://x',
    repoUrl: 'https://github.com/x/y', mainSha: null,
  });
  assert.deepEqual(timed(), []);
});

// The stopwatch itself.

test('the stopwatch: stages on their own clocks, in pipeline order, the first outcome wins', async () => {
  let clock = 1000;
  const watch = timingModule.stopwatch({ now: () => clock });
  watch.note('kind', 'new_repo');
  watch.note('ignored', null);
  watch.start('repository');
  watch.start('database');
  clock += 800;
  watch.end('database');
  clock += 3200;
  watch.end('repository');
  watch.start('not-a-stage');
  watch.end('not-a-stage');
  await watch.time('build', async () => { clock += 25000; });
  watch.start('rollout');
  clock += 1000;
  watch.settle('running');
  watch.settle('error');
  clock += 5000;
  const snap = watch.snapshot();
  assert.deepEqual(snap, {
    outcome: 'running', totalMs: 30000, kind: 'new_repo',
    stages: { database: 800, repository: 4000, build: 25000 },
  });
  assert.equal(watch.outcome, 'running');
});

test('the stopwatch: a stage that threw is where it failed', async () => {
  const watch = timingModule.stopwatch();
  await assert.rejects(watch.time('repository', async () => { throw new Error('rate limited'); }));
  watch.start('checkout');
  watch.settle('error');
  assert.deepEqual(watch.snapshot().failedIn, ['repository', 'checkout']);
  assert.equal(timingModule.stopwatch().snapshot().outcome, 'error', 'an attempt never settled is not a success');
  assert.equal(timingModule.IDLE.snapshot(), null);
});

test('buildNote keeps the engine, reuse and the slowest steps or phases, bounded', () => {
  const steps = Array.from({ length: 9 }, (_, i) => ({ name: `#${i} ${'x'.repeat(80)}`, ms: 1000 - i }));
  const note = timingModule.buildNote({
    engine: 'buildkit', solveStartMs: 4321.4,
    result: { steps, cachedSteps: 2, phases: null, reused: false },
  });
  assert.equal(note.engine, 'buildkit');
  assert.equal(note.steps.length, timingModule.KEPT_BUILD_STEPS);
  assert.ok(note.steps.every((s) => s.name.length <= 60));
  assert.equal(note.cachedSteps, 2);
  assert.equal(note.solveStartMs, 4321);
  assert.equal(note.reused, undefined);
  assert.deepEqual(timingModule.buildNote({ engine: 'kpack', result: { reused: true, phases: [{ name: 'build', ms: 9000 }, { name: 'bad' }] } }),
    { engine: 'kpack', reused: true, phases: [{ name: 'build', ms: 9000 }] });
});

test('buildNote says what happened to the layer cache, and which starter\'s shared cache the build read or wrote', () => {
  assert.deepEqual(timingModule.buildNote({
    engine: 'buildkit',
    result: { cachedSteps: 9, cacheUpload: 'done', starterCache: { starter: 'grocery-list', export: true } },
  }), { engine: 'buildkit', cachedSteps: 9, cacheUpload: 'done', starterCache: { starter: 'grocery-list', export: true } });
  assert.deepEqual(timingModule.buildNote({
    engine: 'buildkit', result: { cacheUpload: 'skipped', starterCache: { starter: 'chore-list', export: false } },
  }), { engine: 'buildkit', cacheUpload: 'skipped', starterCache: { starter: 'chore-list', export: false } });
  assert.deepEqual(timingModule.buildNote({ engine: 'buildkit', result: { cacheUpload: null, starterCache: null } }), { engine: 'buildkit' },
    'no starter, and a build that said nothing about its cache');
});

test('record writes the event and never throws', async () => {
  const pool = makeRecordingPool();
  const watch = timingModule.stopwatch();
  watch.settle('awaiting_secrets');
  await timingModule.record(pool, { appId: 3, userId: 4, slug: 's', watch });
  assert.equal(pool.queries.length, 1);
  assert.equal(pool.queries[0].params[3], 'app_creation_timed');
  assert.equal(JSON.parse(pool.queries[0].params[4]).outcome, 'awaiting_secrets');
  await timingModule.record({ query() { throw new Error('down'); } }, { appId: 3, watch });
  await timingModule.record(pool, { appId: 3, watch: { snapshot() { throw new Error('bad'); } } });
  await timingModule.record(pool, { appId: 3 });
});
