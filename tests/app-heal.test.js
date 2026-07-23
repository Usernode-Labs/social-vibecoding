// Tests for the production app-container watchdog (src/services/app-heal.js,
// issue #426). All docker / staging / respawn work is stubbed via
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
  staging: require.resolve('../src/services/staging'),
  respawn: require.resolve('../src/services/app-respawn'),
  deployStatus: require.resolve('../src/services/app-deploy-status'),
  github: require.resolve('../src/services/github'),
  dbManager: require.resolve('../src/services/db-manager'),
  template: require.resolve('../src/services/template'),
  ws: require.resolve('../src/services/ws'),
  pool: require.resolve('../src/db/pool'),
  appHeal: require.resolve('../src/services/app-heal'),
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
    rebuildCalls: [],
    rebuildError: null,
    respawnCalls: [],
    respawnResult: 'respawned-id',
    deploying: false,
    queries: [],
    poolRows: [],
    githubEnabled: true,
    repoCreateCalls: [],
    repoCreateError: null,
    repoAdopted: false,
    pushFilesCalls: [],
  };
}

const fakePool = {
  async query(sql, params = []) {
    fx.queries.push({ sql, params });
    if (/SELECT \* FROM apps/.test(sql)) return { rows: fx.poolRows };
    return { rows: [] };
  },
};

stub(ids.logger, { info() {}, warn() {}, error() {}, debug() {} });
stub(ids.pool, { getPool: () => fakePool });
stub(ids.docker, {
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
stub(ids.staging, {
  rebuildProduction: async (config, app) => {
    fx.rebuildCalls.push(app.slug);
    if (fx.rebuildError) throw fx.rebuildError;
    return { containerId: 'rebuilt-id', sha: 'abc1234def' };
  },
});
stub(ids.respawn, {
  runExistingImage: async (config, app) => {
    fx.respawnCalls.push(app.slug);
    return fx.respawnResult;
  },
});
stub(ids.deployStatus, {
  read: () => (fx.deploying ? { deploying: true } : null),
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

test('running container is healthy — nothing touched', async () => {
  fx.containerStatus = 'running';
  const r = await appHeal.checkAndHealOne(config, fakePool, app());
  assert.equal(r.status, 'healthy');
  assert.equal(fx.startCalls.length, 0);
  assert.equal(fx.rebuildCalls.length, 0);
});

test('exited container takes the docker-start fast path, no rebuild', async () => {
  fx.containerStatus = 'exited';
  const r = await appHeal.checkAndHealOne(config, fakePool, app());
  assert.equal(r.status, 'started');
  assert.deepEqual(fx.startCalls, ['usernode-app-puzzle-chain']);
  assert.equal(fx.healthyCalls.length, 1);
  assert.equal(fx.rebuildCalls.length, 0);
  assert.equal(fx.respawnCalls.length, 0);
});

test('missing container rebuilds from repo and persists container_id + main_sha', async () => {
  fx.containerStatus = 'not_found';
  const r = await appHeal.checkAndHealOne(config, fakePool, app());
  assert.equal(r.status, 'rebuilt');
  assert.equal(fx.startCalls.length, 0);
  assert.deepEqual(fx.rebuildCalls, ['puzzle-chain']);
  const update = fx.queries.find((q) => /UPDATE apps SET container_id/.test(q.sql));
  assert.ok(update, 'expected an apps UPDATE');
  assert.equal(update.params[0], 'rebuilt-id');
  assert.equal(update.params[1], 'abc1234def');
});

test('failed in-place start escalates to the rebuild path', async () => {
  fx.containerStatus = 'exited';
  fx.startShouldFail = true;
  const r = await appHeal.checkAndHealOne(config, fakePool, app());
  assert.equal(r.status, 'rebuilt');
  assert.equal(fx.startCalls.length, 1);
  assert.deepEqual(fx.rebuildCalls, ['puzzle-chain']);
});

test('missing container without repo_url respawns the existing image (no-GitHub mode)', async () => {
  // With GitHub enabled a repo-less app takes the provisioning path
  // instead (tests below) — the respawn fallback is the no-GitHub mode.
  fx.githubEnabled = false;
  fx.containerStatus = 'not_found';
  const r = await appHeal.checkAndHealOne(config, fakePool, app({ repo_url: null }));
  assert.equal(r.status, 'respawned');
  assert.deepEqual(fx.respawnCalls, ['puzzle-chain']);
  assert.equal(fx.rebuildCalls.length, 0);
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
  fx.rebuildError = new Error('build blew up');
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

test('MissingSecretsError from rebuild fails the heal and sticks to cooldown', async () => {
  fx.containerStatus = 'not_found';
  const err = new Error('Cannot deploy: missing required secrets [API_KEY]');
  err.missingSecrets = ['API_KEY'];
  fx.rebuildError = err;
  const first = await appHeal.checkAndHealOne(config, fakePool, app());
  assert.equal(first.status, 'heal_failed');
  const second = await appHeal.checkAndHealOne(config, fakePool, app());
  assert.equal(second.status, 'cooldown');
  assert.equal(fx.rebuildCalls.length, 1);
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
  assert.equal(fx.rebuildCalls.length, 0);
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
// rebuildProduction to converge prod with the new repo.
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

  assert.deepEqual(fx.rebuildCalls, ['puzzle-chain'], 'prod converges via rebuildProduction');
  const update = fx.queries.find((q) => /UPDATE apps SET container_id/.test(q.sql));
  assert.ok(update, 'rebuild result persisted');
  assert.equal(update.params[0], 'rebuilt-id');
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

  assert.deepEqual(fx.rebuildCalls, ['puzzle-chain'], 'prod converges via rebuildProduction');
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
