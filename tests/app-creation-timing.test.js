'use strict';

// #4895: a new project took ~45 s from Make it to ready, and nothing said
// where. services/app-creation-timing.js keeps one stopwatch per attempt's
// half (the setup, app-creator.js setUp, and its first deploy,
// staging.deployProduction), and the app-creation machine writes one
// `app_creation_timed` event from both (combine). The setup makes the
// database and the repository side by side. Same require.cache stubbing as
// before: nothing real (docker, GitHub, WS) spins up.
//
// Run with: node --test tests/app-creation-timing.test.js

const test = require('node:test');
const assert = require('node:assert/strict');

const timingModule = require('../src/services/app-creation-timing');
const { combine } = require('../src/workflow/app-creation/timing.ts');
const { steps: makeSteps } = require('../src/workflow/kernel/steps.ts');

function stub(id, exports) {
  require.cache[id] = { id, filename: id, loaded: true, exports, paths: [] };
}

function makeRecordingPool(rows = {}) {
  const queries = [];
  return {
    queries,
    async query(sql, params) {
      queries.push({ sql: String(sql), params });
      if (/SELECT \* FROM apps WHERE id = \$1/.test(sql)) return { rows: [rows.app] };
      return { rows: [], rowCount: 1 };
    },
  };
}

// The work's context: its steps kept in memory, as the kernel keeps them
// in its checkpoint (a second run with the same `kept` resumes).
function workContext(kept = { value: null }) {
  return {
    kept,
    signal: new AbortController().signal,
    steps: (o = {}) => makeSteps({ resumeFrom: kept.value, checkpoint: async (v) => { kept.value = v; }, ...o }),
  };
}

function loadAppCreator({ githubStubs = {}, dbStubs = {}, templateFiles = [], app } = {}) {
  const ids = {
    logger: require.resolve('../src/services/logger'),
    github: require.resolve('../src/services/github'),
    dbManager: require.resolve('../src/services/db-manager'),
    template: require.resolve('../src/services/template'),
    sketch: require.resolve('../src/services/app-sketch'),
    ws: require.resolve('../src/services/ws'),
    appCreator: require.resolve('../src/services/app-creator'),
  };
  for (const id of Object.values(ids)) delete require.cache[id];
  const pool = makeRecordingPool({ app });
  const phases = [];
  const calls = { createDatabase: 0, pushFiles: [], createRepo: 0 };
  stub(ids.logger, { info: () => {}, warn: () => {}, error: () => {}, debug: () => {} });
  stub(ids.github, {
    isEnabled: () => true,
    parseGithubUrl: () => ({ owner: 'someone', repo: 'thing' }),
    getBotUsername: async () => 'usernode-bot',
    createRepo: async (owner, slug) => { calls.createRepo += 1; return { html_url: `https://github.com/${owner}/${slug}` }; },
    pushFiles: async (owner, repo, files, opts) => { calls.pushFiles.push(opts.message); return { sha: 'ABCDEF0123456789ABCDEF0123456789ABCDEF01' }; },
    headCommit: async () => null,
    getFileContent: async () => '{}',
    ...githubStubs,
  });
  stub(ids.dbManager, {
    appDbName: (slug) => `app_${slug}`,
    createDatabase: async () => { calls.createDatabase += 1; return { password: 'pw' }; },
    connectionUrl: () => 'postgres://x',
    ...dbStubs,
  });
  stub(ids.template, {
    getTemplateFiles: () => templateFiles,
    getConnectorScaffoldFiles: () => [],
    getCanonicalRepoFile: () => null,
  });
  stub(ids.sketch, { drawFor: async () => null, markCommitted: async () => {}, taglineOf: () => null });
  stub(ids.ws, { pushAppCreationPhase: (payload) => phases.push(payload.phase) });
  const appCreator = require(ids.appCreator);
  return { appCreator, pool, phases, calls };
}

const STARTER = [
  { path: 'Dockerfile', content: 'FROM node:22-alpine\n' },
  { path: 'public/index.html', content: '<h1>Timed</h1>\n' },
  { path: 'dapp.json', content: '{ "secrets": [] }\n' },
];

function appRow(slug, extra = {}) {
  return { id: 77, name: 'Timed App', slug, created_by: 5, self_hosted: false, status: 'creating', ...extra };
}

test('the database and the repository are made side by side', async () => {
  let repoAsked;
  const asked = new Promise((resolve) => { repoAsked = resolve; });
  const { appCreator, pool, phases } = loadAppCreator({
    app: appRow('timed-overlap'),
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
  const out = await appCreator.setUp({}, pool, 77, workContext());
  assert.equal(out.failed, undefined, JSON.stringify(out.failed));
  assert.deepEqual(phases, ['database', 'repository'], 'the made screen walks its first two steps in order');
  assert.deepEqual(Object.keys(out.timing.stages).sort(), ['card', 'database', 'repository']);
  assert.equal(out.timing.kind, 'new_repo');
});

test('a database failure is reported once the repository has settled, and names where it failed', async () => {
  let pushed = false;
  const { appCreator, pool, phases } = loadAppCreator({
    app: appRow('timed-db-fail'),
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
  const out = await appCreator.setUp({}, pool, 77, workContext());
  assert.equal(pushed, true, 'the repository work finished before the failure was reported');
  assert.match(out.failed.reason, /too many connections/);
  assert.equal(out.failed.stage, 'database');
  assert.deepEqual(phases, ['database'], 'the made screen fails on the database step');
  assert.equal(out.timing.outcome, 'error');
  assert.deepEqual(out.timing.failedIn, ['database']);
});

test('a fresh project\'s first commit is the starter, and the first deploy is offered exactly that commit', async () => {
  const { appCreator, pool, calls } = loadAppCreator({ app: appRow('timed-seeded', { template: 'grocery-list' }), templateFiles: STARTER });
  const out = await appCreator.setUp({}, pool, 77, workContext());
  assert.deepEqual(calls.pushFiles, ['Initialize Timed App from Homeroom template']);
  assert.equal(out.sha, 'abcdef0123456789abcdef0123456789abcdef01');
  assert.equal(out.offer.starter.sha, out.sha);
  assert.equal(out.offer.starter.template, 'grocery-list');
  assert.ok(pool.queries.some((q) => /UPDATE apps SET repo_url/.test(q.sql)));
});

test('a setup that resumes runs no step it kept, and never pushes its first commit twice', async () => {
  const kept = { value: null };
  const first = loadAppCreator({ app: appRow('timed-resume'), templateFiles: STARTER,
    githubStubs: { pushFiles: async () => { throw new Error('GitHub stopped answering'); } } });
  const out = await first.appCreator.setUp({}, first.pool, 77, workContext(kept));
  assert.ok(out.failed, 'the push failed');
  assert.ok('database' in kept.value, 'the database step was kept');
  // Resumed: the repository is there (adopted) and its head is the first
  // commit an earlier try pushed before it stopped.
  const again = loadAppCreator({ app: appRow('timed-resume'), templateFiles: STARTER, githubStubs: {
    createRepo: async (owner, s) => ({ html_url: `https://github.com/${owner}/${s}`, adopted: true }),
    headCommit: async () => ({ sha: 'c'.repeat(40), message: 'Initialize Timed App from Homeroom template' }),
  } });
  const done = await again.appCreator.setUp({}, again.pool, 77, workContext(kept));
  assert.equal(again.calls.createDatabase, 0, 'its database is not made again (its password would change under it)');
  assert.deepEqual(again.calls.pushFiles, [], 'its first commit is not pushed again');
  assert.equal(done.sha, 'c'.repeat(40));
});

test('an import is timed as an existing repository, and waits for no card', async () => {
  const { appCreator, pool } = loadAppCreator({ app: appRow('timed-import', { repo_url: 'https://github.com/someone/thing' }) });
  const out = await appCreator.setUp({}, pool, 77, workContext());
  assert.equal(out.timing.kind, 'existing_repo');
  assert.ok(!('card' in out.timing.stages));
  assert.equal(out.offer, null, 'nothing of a starter to offer');
});

test('without GitHub there is no repository: the first deploy builds the starter\'s files', async () => {
  const { appCreator, pool, calls } = loadAppCreator({ app: appRow('timed-local'), templateFiles: STARTER,
    githubStubs: { isEnabled: () => false } });
  const out = await appCreator.setUp({}, pool, 77, workContext());
  assert.equal(out.failed, undefined);
  assert.equal(out.sha, null);
  assert.equal(calls.createRepo, 0);
});

test('one record from the two halves: stages in pipeline order, notes, the outcome and the whole time', () => {
  const metadata = combine({
    setup: { outcome: 'error', totalMs: 9, stages: { repository: 300, database: 200, card: 50 }, kind: 'new_repo', starter: 'empty' },
    deploy: { outcome: 'error', totalMs: 9, stages: { rollout: 900, build: 4000, lock: 1, manifest: 20, checkout: 30, deploy: 70 }, build: { engine: 'docker' } },
    outcome: 'running', totalMs: 6000,
  });
  assert.deepEqual(Object.keys(metadata.stages),
    ['database', 'repository', 'card', 'checkout', 'lock', 'manifest', 'build', 'deploy', 'rollout']);
  assert.equal(metadata.outcome, 'running');
  assert.equal(metadata.totalMs, 6000);
  assert.equal(metadata.kind, 'new_repo');
  assert.deepEqual(metadata.build, { engine: 'docker' });
  assert.equal(metadata.failedIn, undefined);
  assert.equal(combine({}), null);
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
  assert.deepEqual(timingModule.buildNote({
    engine: 'buildkit', result: { starterCache: { starter: 'tier-list-cities', key: 'afc94f505564', export: true } },
  }), { engine: 'buildkit', starterCache: { starter: 'tier-list-cities', key: 'afc94f505564', export: true } },
  'the shared cache is named by its package key');
  // Handed over before the Job had uploaded it: the upload is not the
  // build's time any more, and the note says so.
  assert.deepEqual(timingModule.buildNote({ engine: 'buildkit', result: { cacheUpload: 'background' } }),
    { engine: 'buildkit', cacheUpload: 'background' });
});

test('buildNote keeps the base image time, which a busy node\'s pull can make the slowest step nobody sees', () => {
  assert.deepEqual(timingModule.buildNote({ engine: 'buildkit', result: { baseImageMs: 16700.4 } }),
    { engine: 'buildkit', baseImageMs: 16700 });
  assert.equal(timingModule.buildNote({ engine: 'buildkit', result: { baseImageMs: null } }).baseImageMs, undefined,
    'no FROM timed (all cached, or kpack)');
  assert.equal(timingModule.buildNote({ engine: 'kpack', result: { phases: [] } }).baseImageMs, undefined);
});
