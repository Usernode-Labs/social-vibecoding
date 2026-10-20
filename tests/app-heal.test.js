// Tests for production apps' health (src/services/app-heal.js, issue #426):
// the app-health clock's scan, the error page's report, and app delivery's
// heal work (src/workflow/app-delivery/ decides when; this is what it does).
// All docker / Kubernetes / respawn / workflow work is stubbed, so no real
// runtime or database is touched.
//
// Run with: node --test tests/app-heal.test.js

const test = require('node:test');
const assert = require('node:assert/strict');

function stub(id, exports) {
  require.cache[id] = { id, filename: id, loaded: true, exports, paths: [] };
}

const ids = {
  logger: require.resolve('../src/services/logger'),
  docker: require.resolve('../src/services/docker'),
  respawn: require.resolve('../src/services/app-respawn'),
  outages: require.resolve('../src/services/app-outages'),
  pool: require.resolve('../src/db/pool'),
  appHeal: require.resolve('../src/services/app-heal'),
  platform: require.resolve('../src/workflow/platform.ts'),
};

let fx;
function freshFixtures() {
  return {
    containerStatus: 'running',
    startCalls: [],
    restartCalls: [],
    startShouldFail: false,
    healthyShouldFail: false,
    healthyCalls: [],
    respawnCalls: [],
    respawnResult: 'respawned-id',
    appDeleted: false,
    tearingDown: false,
    queries: [],
    row: null,
    rows: [],
    reported: [],
    healed: [],
  };
}

const fakePool = {
  async query(sql, params = []) {
    fx.queries.push({ sql, params });
    if (/SELECT \* FROM apps WHERE id = \$1/.test(sql)) return { rows: fx.row ? [fx.row] : [] };
    if (/SELECT id, slug, runtime_kind, runtime_name FROM apps/.test(sql)) return { rows: fx.rows };
    if (/SELECT id FROM apps WHERE slug = \$1/.test(sql)) return { rows: fx.rows.filter((r) => r.slug === params[0]) };
    if (/SELECT teardown_started_at FROM apps WHERE id/.test(sql)) return { rows: fx.appDeleted ? [] : [{ teardown_started_at: fx.tearingDown ? new Date() : null }] };
    return { rows: [] };
  },
};

stub(ids.logger, { info() {}, warn() {}, error() {}, debug() {} });
stub(ids.pool, { getPool: () => fakePool });
stub(ids.docker, {
  execFileAsync: async () => ({ stdout: '', stderr: '' }),
  getContainerStatus: async () => fx.containerStatus,
  startContainer: async (name) => {
    fx.startCalls.push(name);
    if (fx.startShouldFail) throw new Error('docker start failed');
  },
  restartContainer: async (name) => { fx.restartCalls.push(name); },
  waitForHealthy: async (name) => {
    fx.healthyCalls.push(name);
    if (fx.healthyShouldFail) throw new Error('healthcheck failed');
  },
});
stub(ids.respawn, {
  runExistingImage: async (config, app) => {
    fx.respawnCalls.push(app.slug);
    return fx.respawnResult;
  },
});
stub(ids.outages, { recordHealed: (pool, app, result, via) => { fx.healed.push([app.slug, result.status, via]); } });
stub(ids.platform, {
  reportUnhealthy: async (appId, state, key) => { fx.reported.push(['Unhealthy', appId, state, key]); },
  reportUnreachable: async (appId, key) => { fx.reported.push(['Unreachable', appId, key]); },
});

delete require.cache[ids.appHeal];
const appHeal = require(ids.appHeal);

const config = { jwtSecret: 's', appHealIntervalMs: 60000 };
const kubeConfig = { ...config, appRuntime: 'kubernetes' };

function app(overrides = {}) {
  return {
    id: 1, slug: 'puzzle-chain', name: 'Puzzle Chain',
    repo_url: 'https://github.com/x/puzzle-chain',
    main_sha: 'oldsha', self_hosted: false, status: 'running',
    db_password: 'pw', manifest_snapshot: { secrets: [] },
    ...overrides,
  };
}

test.beforeEach(() => { fx = freshFixtures(); });

// ── The heal: Kubernetes ─────────────────────────────────────────────────

const kube = () => require('../src/services/kubernetes');
const runtime = () => require('../src/services/application-runtime');
function noDocker(t) {
  for (const method of ['getContainerStatus', 'restartContainer', 'startContainer', 'waitForHealthy']) {
    t.mock.method(require('../src/services/docker'), method, () => assert.fail(`Docker ${method} called`));
  }
}

for (const [scenario, state, repo, want, restarts] of [
  ['gone, with a repository: a deploy', 'not_found', true, 'needs_deploy', 0],
  ['gone, without one (GitHub off): its image again', 'not_found', false, 'respawned', 0],
  ['there but not running: a restart', 'created', true, 'restarted', 1],
]) {
  test(`Kubernetes heal: ${scenario}`, async (t) => {
    noDocker(t);
    fx.respawnResult = 'sv-app-1-puzzle-chain';
    fx.row = app({ repo_url: repo ? 'https://github.com/x/puzzle-chain' : null });
    t.mock.method(kube(), 'getApplicationStatus', async () => state);
    let n = 0;
    t.mock.method(kube(), 'restartApplication', async () => { n += 1; });
    const result = await appHeal.heal(kubeConfig, fakePool, 1);
    assert.equal(result.status, want);
    assert.equal(n, restarts);
    const update = fx.queries.find((q) => /UPDATE apps SET container_id/.test(q.sql));
    if (want === 'respawned') {
      assert.deepEqual(update.params.slice(-2), ['kubernetes', 'sv-app-1-puzzle-chain'], 'a respawn keeps its runtime identity');
    } else {
      assert.equal(update, undefined, 'a deploy writes the runtime it deploys, not the heal');
    }
  });
}

test('Kubernetes heal: a restart that fails needs a new runtime, never retried here', async (t) => {
  noDocker(t);
  fx.row = app();
  t.mock.method(kube(), 'getApplicationStatus', async () => 'created');
  t.mock.method(kube(), 'restartApplication', async () => { throw new Error('rollout timed out'); });
  assert.equal((await appHeal.heal(kubeConfig, fakePool, 1)).status, 'needs_deploy');
});

test('Kubernetes heal: a person could not reach a running app: probed, and restarted only when it does not answer', async (t) => {
  noDocker(t);
  fx.row = app();
  t.mock.method(kube(), 'getApplicationStatus', async () => 'running');
  let n = 0;
  t.mock.method(kube(), 'restartApplication', async () => { n += 1; });
  t.mock.method(runtime(), 'probeHealth', async () => true);
  assert.equal((await appHeal.heal(kubeConfig, fakePool, 1, { probe: true })).status, 'healthy');
  t.mock.method(runtime(), 'probeHealth', async () => false);
  assert.equal((await appHeal.heal(kubeConfig, fakePool, 1, { probe: true })).status, 'restarted');
  assert.equal(n, 1);
  assert.equal((await appHeal.heal(kubeConfig, fakePool, 1)).status, 'healthy', 'the clock does not probe');
});

test('Kubernetes heal: a stopped heal (its process going) throws, and asks for nothing', async (t) => {
  noDocker(t);
  fx.row = app();
  t.mock.method(kube(), 'getApplicationStatus', async () => 'created');
  t.mock.method(kube(), 'restartApplication', () => new Promise(() => {}));
  const stop = new AbortController();
  const healing = appHeal.heal(kubeConfig, fakePool, 1, { signal: stop.signal });
  await new Promise((r) => setImmediate(r));
  stop.abort();
  await assert.rejects(healing, /stopped/);
});

test('an app whose newer commit was refused for running as root is not restarted or rebuilt', async (t) => {
  noDocker(t);
  fx.row = app({ main_sha: 'live', last_failure: { kind: 'root_image', sha: 'newer' } });
  t.mock.method(kube(), 'getApplicationStatus', async () => 'restarting');
  t.mock.method(kube(), 'restartApplication', () => assert.fail('restarted'));
  assert.equal((await appHeal.heal(kubeConfig, fakePool, 1)).status, 'waits_for_new_commit');
});

// 2026-10-05, flat-4b-chores-e98ecd: a test account was retired, the teardown
// removed the Deployment and spent 30 seconds dropping the database, and the
// sweep saw a running app with no runtime and rebuilt it.
test('an app being taken down is not healed', async (t) => {
  noDocker(t);
  fx.row = app();
  fx.tearingDown = true;
  t.mock.method(kube(), 'getApplicationStatus', async () => 'not_found');
  assert.equal((await appHeal.heal(kubeConfig, fakePool, 1)).status, 'deleting');
  assert.deepEqual(fx.respawnCalls, []);
});

test('an app deleted during a respawn keeps no runtime', async (t) => {
  noDocker(t);
  fx.row = app({ repo_url: null });
  t.mock.method(kube(), 'getApplicationStatus', async () => 'not_found');
  const removed = [];
  t.mock.method(kube(), 'deleteApplication', async (cfg, name) => { removed.push(name); });
  t.mock.method(kube(), 'deleteBuilds', async () => {});
  fx.appDeleted = true;
  assert.equal((await appHeal.heal(kubeConfig, fakePool, 1)).status, 'respawned');
  assert.deepEqual(removed, ['sv-app-1-puzzle-chain']);
});

test('an app that is no longer running, or the platform itself, is not healed', async () => {
  fx.row = app({ status: 'creating' });
  assert.equal((await appHeal.heal(config, fakePool, 1)).status, 'skipped');
  fx.row = app({ self_hosted: true });
  assert.equal((await appHeal.heal(config, fakePool, 1)).status, 'skipped');
  fx.row = null;
  assert.equal((await appHeal.heal(config, fakePool, 1)).status, 'skipped');
});

// ── The heal: Docker ─────────────────────────────────────────────────────

test('Docker: a running container is healthy, nothing touched', async () => {
  fx.row = app();
  assert.equal((await appHeal.heal(config, fakePool, 1)).status, 'healthy');
  assert.deepEqual(fx.startCalls, []);
});

test('Docker: a person could not reach a running one that does not answer: restarted', async () => {
  fx.row = app();
  fx.healthyShouldFail = true;
  await assert.rejects(appHeal.heal(config, fakePool, 1, { probe: true }), /healthcheck failed/,
    'a restart that does not come back throws: app delivery backs off');
  assert.deepEqual(fx.restartCalls, ['usernode-app-puzzle-chain']);
  fx.healthyShouldFail = false;
  fx.restartCalls = [];
});

test('Docker: an exited container is started in place, no deploy', async () => {
  fx.row = app();
  fx.containerStatus = 'exited';
  assert.equal((await appHeal.heal(config, fakePool, 1)).status, 'started');
  assert.deepEqual(fx.startCalls, ['usernode-app-puzzle-chain']);
});

test('Docker: a start that fails needs a deploy; without a repository its image is run again', async () => {
  fx.row = app();
  fx.containerStatus = 'exited';
  fx.startShouldFail = true;
  assert.equal((await appHeal.heal(config, fakePool, 1)).status, 'needs_deploy');
  fx.row = app({ repo_url: null });
  assert.equal((await appHeal.heal(config, fakePool, 1)).status, 'respawned');
  assert.deepEqual(fx.respawnCalls, ['puzzle-chain']);
});

test('Docker: an image that cannot run without its keys is not a cure', async () => {
  fx.row = app({ repo_url: null });
  fx.containerStatus = 'not_found';
  fx.respawnResult = null;
  await assert.rejects(appHeal.heal(config, fakePool, 1), /missing required secrets/);
});

test('the minute it brought an app back is recorded; a deploy counts as one', async () => {
  fx.row = app();
  fx.containerStatus = 'exited';
  await appHeal.heal(config, fakePool, 1, { via: 'visit' });
  fx.containerStatus = 'not_found';
  await appHeal.heal(config, fakePool, 1);
  assert.deepEqual(fx.healed, [['puzzle-chain', 'started', 'visit'], ['puzzle-chain', 'deploy_requested', 'sweep']]);
});

// ── The app-health clock's scan, and the error page ──────────────────────

test('the scan reports each running app whose runtime is not running, keyed by the run', async () => {
  fx.rows = [
    { id: 1, slug: 'up', runtime_kind: 'docker', runtime_name: null },
    { id: 2, slug: 'down', runtime_kind: 'docker', runtime_name: null },
  ];
  const states = new Map([['usernode-app-up', 'running'], ['usernode-app-down', 'exited']]);
  require.cache[ids.docker].exports.getContainerStatus = async (name) => states.get(name);
  const out = await appHeal.scan(config, fakePool, { n: 7 });
  assert.deepEqual(out, { checked: 2, down: ['down'] });
  assert.deepEqual(fx.reported, [['Unhealthy', 2, 'exited', 'health:2:7']]);
  assert.match(fx.queries.find((q) => /FROM apps/.test(q.sql)).sql, /status = 'running' AND self_hosted IS NOT TRUE/);
});

test('the scan stops when its run is asked to', async () => {
  fx.rows = [{ id: 1, slug: 'a', runtime_kind: 'docker' }, { id: 2, slug: 'b', runtime_kind: 'docker' }];
  fx.containerStatus = 'exited';
  const out = await appHeal.scan(config, fakePool, { n: 1, shouldStop: () => true });
  assert.equal(out.checked, 0);
  assert.deepEqual(fx.reported, []);
});

test('the error page reports a running app it could not reach, keyed by the minute; nothing for another', async () => {
  fx.rows = [{ id: 4, slug: 'live' }];
  appHeal.reportVisit(fakePool, 'live');
  appHeal.reportVisit(fakePool, 'unknown');
  await new Promise((r) => setTimeout(r, 10));
  assert.equal(fx.reported.length, 1);
  const [type, appId, key] = fx.reported[0];
  assert.equal(type, 'Unreachable');
  assert.equal(appId, 4);
  assert.match(key, /^visit:4:\d+$/);
});

test('APP_HEAL_INTERVAL_MS=0 switches the clock off', () => {
  assert.equal(appHeal.intervalMs({ appHealIntervalMs: 0 }), 0);
  assert.equal(appHeal.intervalMs({ appHealIntervalMs: 60000 }), 60000);
});
