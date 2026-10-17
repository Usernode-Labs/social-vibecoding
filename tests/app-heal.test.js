// Tests for the production app-container watchdog (src/services/app-heal.js,
// issue #426). All docker / respawn / workflow work is stubbed via
// require.cache (same pattern as tests/docker.test.js), so no real docker
// or DB is touched. Each test drives checkAndHealOne / requestHeal directly
// with a fake pool + app row and asserts which recovery path ran.
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
  deployStatus: require.resolve('../src/services/app-deploy-status'),
  github: require.resolve('../src/services/github'),
  dbManager: require.resolve('../src/services/db-manager'),
  template: require.resolve('../src/services/template'),
  appForker: require.resolve('../src/services/app-forker'),
  ws: require.resolve('../src/services/ws'),
  pool: require.resolve('../src/db/pool'),
  appHeal: require.resolve('../src/services/app-heal'),
  platform: require.resolve('../src/workflow/platform.ts'),
};

// Mutable behavior knobs each test tweaks; the stubs close over `fx`.
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
    deploying: false,
    // The deploys asked of app delivery, and a failure to ask.
    requested: [],
    requestError: null,
    appDeleted: false,
    queries: [],
    poolRows: [],
    githubEnabled: true,
    repoCreateCalls: [],
    repoCreateError: null,
    repoAdopted: false,
    pushFilesCalls: [],
    forkCopyCalls: [],
    forkSource: {
      id: 7,
      slug: 'source-app',
      repo_url: 'https://github.com/acme/source-app',
      status: 'running',
    },
  };
}

const fakePool = {
  async query(sql, params = []) {
    fx.queries.push({ sql, params });
    if (/SELECT \* FROM apps/.test(sql)) return { rows: fx.poolRows };
    if (/SELECT teardown_started_at FROM apps WHERE id/.test(sql)) return { rows: fx.appDeleted ? [] : [{ teardown_started_at: null }] };
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
stub(ids.deployStatus, {
  // A deploy in this process (the map), or one app delivery runs (the row).
  read: (slug, row) => (fx.deploying || row?.deploy_state === 'deploying' ? { deploying: true } : null),
});
stub(ids.platform, {
  requestDeploy: async (appId, reason) => {
    fx.requested.push([appId, reason]);
    if (fx.requestError) throw fx.requestError;
    return 1;
  },
});
stub(ids.github, {
  isEnabled: () => fx.githubEnabled,
  getBotUsername: async () => 'usernode-bot',
  createRepo: async (owner, slug, opts = {}) => {
    fx.repoCreateCalls.push({ owner, slug, adoptExisting: !!opts.adoptExisting });
    if (fx.repoCreateError) {
      // Mirror the real createRepo's adopt-existing semantics: a 422
      // "name already exists" resolves to the existing repo when the
      // caller opted in; every other error propagates.
      const isNameExists = fx.repoCreateError.status === 422
        && /already exists/i.test(fx.repoCreateError.message || '');
      if (!(opts.adoptExisting && isNameExists)) throw fx.repoCreateError;
      fx.repoAdopted = true;
    }
    return { html_url: `https://github.com/${owner}/${slug}` };
  },
  pushFiles: async (owner, slug) => { fx.pushFilesCalls.push({ owner, slug }); },
});
stub(ids.dbManager, {
  appDbName: (slug) => `app_${slug}`,
  connectionUrl: () => 'postgres://x',
});
stub(ids.template, { getTemplateFiles: () => [] });
stub(ids.appForker, {
  findForkSource: async () => fx.forkSource,
  copyRepoTree: async (args) => {
    fx.forkCopyCalls.push(args);
    return {
      repoUrl: `https://github.com/${args.botUsername}/${args.forkSlug}`,
      mainSha: 'forkcopy123',
    };
  },
});
stub(ids.ws, { broadcastGlobal() {} });

delete require.cache[ids.appHeal];
const appHeal = require(ids.appHeal);

const config = { jwtSecret: 's', appHealIntervalMs: 60000, appHealCooldownMs: 10 * 60 * 1000 };

function app(overrides = {}) {
  return {
    id: 1, slug: 'puzzle-chain', name: 'Puzzle Chain',
    repo_url: 'https://github.com/x/puzzle-chain',
    main_sha: 'oldsha', self_hosted: false, status: 'running',
    db_password: 'pw', manifest_snapshot: { secrets: [] },
    ...overrides,
  };
}

test.beforeEach(() => {
  fx = freshFixtures();
  appHeal._resetForTests();
});

for (const scenario of ['respawn', 'rebuild', 'restart-fallback', 'probe-running', 'missing-repo']) {
  test(`Kubernetes app heal: ${scenario} preserves runtime identity without Docker`, async (t) => {
    const kube = require('../src/services/kubernetes');
    const runtime = require('../src/services/application-runtime');
    fx.respawnResult = 'sv-app-1-puzzle-chain';
    if (scenario === 'respawn') fx.githubEnabled = false;
    const statusCalls = [];
    t.mock.method(kube, 'getApplicationStatus', async (cfg, name) => {
      statusCalls.push(name);
      assert.equal(cfg.appRuntime, 'kubernetes');
      return scenario === 'probe-running' ? 'running' : scenario === 'restart-fallback' ? 'created' : 'not_found';
    });
    let restarts = 0;
    t.mock.method(kube, 'restartApplication', async () => {
      restarts++;
      if (scenario === 'restart-fallback') throw new Error('replacement failed');
    });
    t.mock.method(runtime, 'probeHealth', async () => false);
    for (const method of ['getContainerStatus', 'restartContainer', 'startContainer', 'waitForHealthy']) {
      t.mock.method(require('../src/services/docker'), method, () => assert.fail(`Docker ${method} called`));
    }
    const result = await appHeal.checkAndHealOne({ ...config, appRuntime: 'kubernetes' }, fakePool,
      app({ repo_url: ['respawn', 'missing-repo'].includes(scenario) ? null : 'https://github.com/x/puzzle-chain' }),
      { probeRunning: scenario === 'probe-running' });
    assert.equal(result.status, { respawn: 'respawned', rebuild: 'deploy_requested', 'restart-fallback': 'deploy_requested',
      'probe-running': 'restarted', 'missing-repo': 'repo_provisioned' }[scenario]);
    if (scenario !== 'missing-repo') assert.deepEqual(statusCalls, ['sv-app-1-puzzle-chain']);
    assert.equal(restarts, ['restart-fallback', 'probe-running'].includes(scenario) ? 1 : 0);
    // A rebuild is asked of app delivery, which writes the runtime it
    // deploys; only a respawn writes the runtime here.
    assert.deepEqual(fx.requested,
      ['rebuild', 'restart-fallback', 'missing-repo'].includes(scenario) ? [[1, 'heal']] : []);
    const update = fx.queries.find(q => /UPDATE apps SET container_id/.test(q.sql));
    if (scenario === 'respawn') {
      assert.match(update.sql, /runtime_kind = \$\d+, runtime_name = \$\d+/);
      assert.equal(update.params[0], null);
      assert.deepEqual(update.params.slice(-2), ['kubernetes', 'sv-app-1-puzzle-chain']);
    } else {
      assert.equal(update, undefined);
    }
  });
}

// 14 Oct 2026: shutdown began while a heal waited on a rollout that could
// never finish (the app's container cannot start). The drain waited 40 s for
// it, and then it escalated to a rebuild mid-shutdown. Shutdown ends the wait
// and the heal, and the next leader's sweep heals the app again.
test('a Kubernetes heal stops waiting on the rollout when shutdown begins, and never escalates to a rebuild then', async (t) => {
  const kube = require('../src/services/kubernetes');
  const lifecycle = require('../src/services/lifecycle');
  t.mock.method(kube, 'getApplicationStatus', async () => 'created');
  let begin;
  const begins = new Promise((resolve) => { begin = resolve; });
  let shutting = false;
  t.mock.method(lifecycle, 'whenShuttingDown', () => begins);
  t.mock.method(lifecycle, 'isShuttingDown', () => shutting);
  t.mock.method(kube, 'restartApplication', () => new Promise(() => {}));
  const healing = appHeal.checkAndHealOne({ ...config, appRuntime: 'kubernetes' }, fakePool, app());
  await new Promise((r) => setImmediate(r));
  shutting = true;
  begin();
  assert.equal((await healing).status, 'shutting_down');
  assert.deepEqual(fx.requested, [], 'no rebuild asked for during shutdown');

  // A restart that failed outright during shutdown is not escalated either.
  appHeal._resetForTests();
  t.mock.method(kube, 'restartApplication', async () => { throw new Error('replacement failed'); });
  assert.equal((await appHeal.checkAndHealOne({ ...config, appRuntime: 'kubernetes' }, fakePool, app())).status, 'shutting_down');
  assert.deepEqual(fx.requested, []);
});

test('failed Kubernetes recovery retains cooldown and does not persist success', async (t) => {
  t.mock.method(require('../src/services/kubernetes'), 'getApplicationStatus', async () => 'not_found');
  fx.requestError = new Error('database unavailable');
  const cfg = { ...config, appRuntime: 'kubernetes' };
  assert.equal((await appHeal.checkAndHealOne(cfg, fakePool, app())).status, 'heal_failed');
  assert.equal((await appHeal.checkAndHealOne(cfg, fakePool, app())).status, 'cooldown');
  assert.equal(fx.queries.some(q => /UPDATE apps SET container_id/.test(q.sql)), false);
});

// 2026-10-05, flat-4b-chores-e98ecd: a test account was retired, the teardown
// removed the Deployment and spent 30 seconds dropping the database, and the
// sweep saw a running app with no runtime and rebuilt it. The row was deleted
// under the rebuild, and the Deployment crash-looped for a week.
test('an app being taken down is not healed', async (t) => {
  const kube = require('../src/services/kubernetes');
  t.mock.method(kube, 'getApplicationStatus', async () => 'not_found');
  // Marked on its row, which every process reads (services/app-teardown.js).
  const result = await appHeal.checkAndHealOne({ ...config, appRuntime: 'kubernetes' }, fakePool,
    app({ teardown_started_at: new Date() }));
  assert.equal(result.status, 'deleting');
  assert.deepEqual(fx.requested, []);
  assert.deepEqual(fx.respawnCalls, []);
});

for (const outcome of ['deploy_requested', 'heal_failed']) {
  test(`an app deleted during a recovery keeps no runtime (${outcome})`, async (t) => {
    const kube = require('../src/services/kubernetes');
    t.mock.method(kube, 'getApplicationStatus', async () => 'not_found');
    const removed = [];
    t.mock.method(kube, 'deleteApplication', async (cfg, name) => { removed.push(name); });
    const buildsRemoved = [];
    t.mock.method(kube, 'deleteBuilds', async (cfg, appId) => { buildsRemoved.push(appId); });
    fx.appDeleted = true;
    if (outcome === 'heal_failed') fx.requestError = new Error('database unavailable');
    const result = await appHeal.checkAndHealOne({ ...config, appRuntime: 'kubernetes' }, fakePool, app());
    assert.equal(result.status, outcome);
    assert.deepEqual(removed, ['sv-app-1-puzzle-chain']);
    assert.deepEqual(buildsRemoved, [1]);
  });
}

test('a recovery leaves the runtime of an app that still exists', async (t) => {
  const kube = require('../src/services/kubernetes');
  t.mock.method(kube, 'getApplicationStatus', async () => 'not_found');
  t.mock.method(kube, 'deleteApplication', () => assert.fail('runtime removed'));
  const result = await appHeal.checkAndHealOne({ ...config, appRuntime: 'kubernetes' }, fakePool, app());
  assert.equal(result.status, 'deploy_requested');
});

test('running container is healthy — nothing touched', async () => {
  fx.containerStatus = 'running';
  const r = await appHeal.checkAndHealOne(config, fakePool, app());
  assert.equal(r.status, 'healthy');
  assert.equal(fx.startCalls.length, 0);
  assert.equal(fx.requested.length, 0);
});

test('exited container takes the docker-start fast path, no rebuild', async () => {
  fx.containerStatus = 'exited';
  const r = await appHeal.checkAndHealOne(config, fakePool, app());
  assert.equal(r.status, 'started');
  assert.deepEqual(fx.startCalls, ['usernode-app-puzzle-chain']);
  assert.equal(fx.healthyCalls.length, 1);
  assert.equal(fx.requested.length, 0);
  assert.equal(fx.respawnCalls.length, 0);
});

test('a missing container with a repo is rebuilt by asking app delivery, and the cooldown stays until its outcome', async () => {
  fx.containerStatus = 'not_found';
  const r = await appHeal.checkAndHealOne(config, fakePool, app());
  assert.equal(r.status, 'deploy_requested');
  assert.equal(fx.startCalls.length, 0);
  assert.deepEqual(fx.requested, [[1, 'heal']]);
  assert.ok(!fx.queries.some((q) => /UPDATE apps SET container_id/.test(q.sql)), 'the machine writes the result');
  const again = await appHeal.checkAndHealOne(config, fakePool, app());
  assert.equal(again.status, 'cooldown', 'a failed deploy is not asked for again every tick');
});

test('an app app delivery is deploying, in any process, is left alone', async () => {
  fx.containerStatus = 'not_found';
  const r = await appHeal.checkAndHealOne(config, fakePool, app({ deploy_state: 'deploying' }));
  assert.equal(r.status, 'deploying');
  assert.equal(fx.requested.length + fx.startCalls.length, 0);
});

test('failed in-place start escalates to the rebuild path', async () => {
  fx.containerStatus = 'exited';
  fx.startShouldFail = true;
  const r = await appHeal.checkAndHealOne(config, fakePool, app());
  assert.equal(r.status, 'deploy_requested');
  assert.equal(fx.startCalls.length, 1);
  assert.deepEqual(fx.requested, [[1, 'heal']]);
});

test('missing container without repo_url respawns the existing image (no-GitHub mode)', async () => {
  // With GitHub enabled a repo-less app takes the provisioning path
  // instead (tests below) — the respawn fallback is the no-GitHub mode.
  fx.githubEnabled = false;
  fx.containerStatus = 'not_found';
  const r = await appHeal.checkAndHealOne(config, fakePool, app({ repo_url: null }));
  assert.equal(r.status, 'respawned');
  assert.deepEqual(fx.respawnCalls, ['puzzle-chain']);
  assert.equal(fx.requested.length, 0);
});

test('restarting container gets one tick of grace, then heals', async () => {
  fx.containerStatus = 'restarting';
  const first = await appHeal.checkAndHealOne(config, fakePool, app());
  assert.equal(first.status, 'restart_grace');
  assert.equal(fx.startCalls.length, 0);

  const second = await appHeal.checkAndHealOne(config, fakePool, app());
  assert.equal(second.status, 'started');
  assert.equal(fx.startCalls.length, 1);
});

test('cooldown suppresses a retry after a failed heal', async () => {
  fx.containerStatus = 'exited';
  fx.startShouldFail = true;
  fx.requestError = new Error('database unavailable');
  const first = await appHeal.checkAndHealOne(config, fakePool, app());
  assert.equal(first.status, 'heal_failed');

  const second = await appHeal.checkAndHealOne(config, fakePool, app());
  assert.equal(second.status, 'cooldown');
  assert.equal(fx.startCalls.length, 1, 'no second attempt within cooldown');
});

test('successful heal clears the cooldown for the next incident', async () => {
  fx.containerStatus = 'exited';
  const first = await appHeal.checkAndHealOne(config, fakePool, app());
  assert.equal(first.status, 'started');
  const second = await appHeal.checkAndHealOne(config, fakePool, app());
  assert.equal(second.status, 'started', 'a fresh outage heals immediately');
});

test('self-hosted apps are skipped', async () => {
  fx.containerStatus = 'exited';
  const r = await appHeal.checkAndHealOne(config, fakePool, app({ self_hosted: true }));
  assert.equal(r.status, 'skipped');
  assert.equal(fx.startCalls.length, 0);
});

test('apps mid-deploy are skipped', async () => {
  fx.containerStatus = 'not_found';
  fx.deploying = true;
  const r = await appHeal.checkAndHealOne(config, fakePool, app());
  assert.equal(r.status, 'deploying');
  assert.equal(fx.requested.length, 0);
});

test('poll only selects running, non-self-hosted apps', async () => {
  fx.poolRows = [];
  await appHeal.poll(config);
  const sel = fx.queries.find((q) => /SELECT \* FROM apps/.test(q.sql));
  assert.ok(sel);
  assert.match(sel.sql, /status = 'running'/);
  assert.match(sel.sql, /self_hosted IS NOT TRUE/);
});

test('requestHeal probes a hung-but-running container and restarts it', async () => {
  fx.containerStatus = 'running';
  fx.poolRows = [app()];
  // Probe fails once (hung), then the post-restart health wait succeeds.
  let probes = 0;
  fx.healthyShouldFail = true;
  const origWait = require(ids.docker).waitForHealthy;
  require(ids.docker).waitForHealthy = async (name) => {
    probes++;
    if (probes === 1) throw new Error('probe timed out');
    fx.healthyCalls.push(name);
  };
  try {
    appHeal.requestHeal('puzzle-chain', config);
    // fire-and-forget: give the async body a few ticks to finish
    await new Promise((r) => setTimeout(r, 50));
    assert.deepEqual(fx.restartCalls, ['usernode-app-puzzle-chain']);
  } finally {
    require(ids.docker).waitForHealthy = origWait;
  }
});

test('requestHeal debounces repeat calls for the same slug', async () => {
  fx.containerStatus = 'exited';
  fx.poolRows = [app()];
  appHeal.requestHeal('puzzle-chain', config);
  appHeal.requestHeal('puzzle-chain', config);
  await new Promise((r) => setTimeout(r, 50));
  const selects = fx.queries.filter((q) => /SELECT \* FROM apps/.test(q.sql));
  assert.equal(selects.length, 1, 'second call within the debounce is a no-op');
});

// Session-2585 fix: a 'running' app with repo_url NULL (GitHub repo
// creation failed at create time, pre-fix) gets its repo provisioned by
// the sweep — createRepo + pushFiles(template) + repo_url persisted +
// a deploy asked of app delivery to converge prod with the new repo.
test('running app with repo_url NULL gets its repo provisioned and prod rebuilt', async () => {
  fx.containerStatus = 'running';
  const r = await appHeal.checkAndHealOne(config, fakePool, app({ repo_url: null }));
  assert.equal(r.status, 'repo_provisioned');

  assert.deepEqual(fx.repoCreateCalls,
    [{ owner: 'usernode-bot', slug: 'puzzle-chain', adoptExisting: true }]);
  assert.deepEqual(fx.pushFilesCalls, [{ owner: 'usernode-bot', slug: 'puzzle-chain' }]);

  const repoWrite = fx.queries.find((q) => /UPDATE apps SET repo_url/.test(q.sql));
  assert.ok(repoWrite, 'expected the repo_url persist');
  assert.equal(repoWrite.params[0], 'https://github.com/usernode-bot/puzzle-chain');

  assert.deepEqual(fx.requested, [[1, 'heal']], 'prod converges via a deploy asked of app delivery');
});

test('repo-less fork recovery copies its source and never pushes starter-template files', async () => {
  fx.containerStatus = 'running';
  const fork = app({
    name: 'Puzzle Chain Fork',
    repo_url: null,
    forked_from: { appId: 7, slug: 'source-app' },
  });

  const r = await appHeal.checkAndHealOne(config, fakePool, fork);
  assert.equal(r.status, 'repo_provisioned');
  assert.equal(fx.forkCopyCalls.length, 1);
  assert.equal(fx.forkCopyCalls[0].sourceApp, fx.forkSource);
  assert.equal(fx.forkCopyCalls[0].forkSlug, fork.slug);
  assert.equal(fx.forkCopyCalls[0].forkName, fork.name);
  assert.equal(fx.repoCreateCalls.length, 0,
    'generic repo provisioning is not allowed to create a template fork');
  assert.equal(fx.pushFilesCalls.length, 0,
    'starter-template files are never written for a fork');

  const repoWrite = fx.queries.find((q) => /UPDATE apps SET repo_url/.test(q.sql));
  assert.ok(repoWrite);
  assert.equal(repoWrite.params[0], 'https://github.com/usernode-bot/puzzle-chain');
  assert.deepEqual(fx.requested, [[1, 'heal']]);
});

// The mypage-777ed2 incident: the repo already exists on the bot account
// (the original create died between the GitHub create call and the
// repo_url persist), so a plain create 422s "name already exists" on
// every sweep forever. With adoptExisting the sweep adopts the orphan
// and completes the provisioning normally.
test('repo provisioning adopts a repo that already exists on the bot account', async () => {
  fx.containerStatus = 'running';
  const err = new Error(
    'Repository creation failed.: {"resource":"Repository","code":"custom","field":"name","message":"name already exists on this account"}'
  );
  err.status = 422;
  fx.repoCreateError = err;

  const r = await appHeal.checkAndHealOne(config, fakePool, app({ repo_url: null }));
  assert.equal(r.status, 'repo_provisioned');
  assert.equal(fx.repoAdopted, true, 'expected the adopt path, not a fresh create');
  assert.deepEqual(fx.pushFilesCalls, [{ owner: 'usernode-bot', slug: 'puzzle-chain' }]);

  const repoWrite = fx.queries.find((q) => /UPDATE apps SET repo_url/.test(q.sql));
  assert.ok(repoWrite, 'expected the repo_url persist');
  assert.equal(repoWrite.params[0], 'https://github.com/usernode-bot/puzzle-chain');

  assert.deepEqual(fx.requested, [[1, 'heal']], 'prod converges via a deploy asked of app delivery');
});

test('non-422 provisioning error still fails the heal and stamps the cooldown', async () => {
  fx.containerStatus = 'running';
  const err = new Error('GitHub is down');
  err.status = 503;
  fx.repoCreateError = err;

  const first = await appHeal.checkAndHealOne(config, fakePool, app({ repo_url: null }));
  assert.equal(first.status, 'heal_failed');
  assert.equal(fx.repoAdopted, false);

  const second = await appHeal.checkAndHealOne(config, fakePool, app({ repo_url: null }));
  assert.equal(second.status, 'cooldown');
  assert.equal(fx.repoCreateCalls.length, 1, 'no second GitHub attempt within cooldown');
});

test('repo provisioning failure warns and sticks to cooldown, then retries after it lapses', async () => {
  fx.containerStatus = 'running';
  fx.repoCreateError = new Error('API rate limit exceeded');
  const first = await appHeal.checkAndHealOne(config, fakePool, app({ repo_url: null }));
  assert.equal(first.status, 'heal_failed');
  assert.match(first.error, /rate limit/);
  assert.equal(fx.queries.filter((q) => /UPDATE apps SET repo_url/.test(q.sql)).length, 0,
    'repo_url must not be persisted on failure');

  const second = await appHeal.checkAndHealOne(config, fakePool, app({ repo_url: null }));
  assert.equal(second.status, 'cooldown');
  assert.equal(fx.repoCreateCalls.length, 1, 'no second GitHub attempt within cooldown');
});

test('repo provisioning is skipped when GitHub is disabled', async () => {
  fx.githubEnabled = false;
  fx.containerStatus = 'running';
  const r = await appHeal.checkAndHealOne(config, fakePool, app({ repo_url: null }));
  assert.equal(r.status, 'healthy');
  assert.equal(fx.repoCreateCalls.length, 0);
});

// The Deployment's template is an image refused for running as root, and the
// previous ReplicaSet keeps serving (Goalio, 17 Sep to 15 Oct 2026): a restart
// rolls out the same refusal and a rebuild of the same commit makes the same
// image, so the heal waits for a commit that changes the Dockerfile.
test('an app whose newer commit was refused for running as root is not restarted or rebuilt', async (t) => {
  const kube = require('../src/services/kubernetes');
  t.mock.method(kube, 'getApplicationStatus', async () => 'restarting');
  let restarts = 0;
  t.mock.method(kube, 'restartApplication', async () => { restarts += 1; });
  const refused = { stage: 'healthcheck', kind: 'root_image', sha: 'newsha', reason: 'runs as root' };
  const result = await appHeal.checkAndHealOne({ ...config, appRuntime: 'kubernetes' }, fakePool, app({ last_failure: refused }));
  assert.equal(result.status, 'waits_for_new_commit');
  assert.equal(restarts, 0);
  assert.deepEqual(fx.requested, []);

  // A record of the commit that is live is stale, not a reason to stop healing.
  appHeal._resetForTests();
  const stale = await appHeal.checkAndHealOne({ ...config, appRuntime: 'kubernetes' }, fakePool,
    app({ last_failure: { ...refused, sha: 'oldsha' } }));
  assert.notEqual(stale.status, 'waits_for_new_commit');
  assert.equal(restarts, 1);
});
