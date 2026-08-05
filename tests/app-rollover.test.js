// Tests for the bulk container rollover orchestrator
// (src/services/app-rollover.js). All docker / staging / respawn / ws work
// is stubbed via require.cache (same pattern as tests/app-heal.test.js), so
// no real docker, DB or socket is touched. Each test drives start() with a
// fake pool + app rows and asserts which path ran per app.
//
// Run with: node --test tests/app-rollover.test.js

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
  blueGreen: require.resolve('../src/services/app-blue-green'),
  caddy: require.resolve('../src/services/caddy'),
  deployStatus: require.resolve('../src/services/app-deploy-status'),
  events: require.resolve('../src/services/events'),
  ws: require.resolve('../src/services/ws'),
  pool: require.resolve('../src/db/pool'),
  rollover: require.resolve('../src/services/app-rollover'),
};

let fx;

function freshFixtures() {
  return {
    apps: [],
    // docker
    imageExists: true,
    imageExistsCalls: [],
    buildCalls: [],
    healthyCalls: [],
    healthyShouldFail: false,
    // app-respawn
    respawnCalls: [],
    blueGreenCalls: [],
    respawnResult: 'container-id',
    respawnError: null,
    respawnDelayMs: 0,
    concurrentNow: 0,
    concurrentMax: 0,
    // staging
    rebuildCalls: [],
    rebuildResult: { containerId: 'rebuilt-id', sha: 'abc1234' },
    rebuildError: null,
    serializeCalls: [],
    // app-deploy-status
    deploying: false,
    markStarts: [],
    markEnds: [],
    // ws / events
    adminBroadcasts: [],
    globalBroadcasts: [],
    eventRecords: [],
    // pool
    queries: [],
    updateRowCount: 1,
  };
}

const fakePool = {
  async query(sql, params = []) {
    fx.queries.push({ sql, params });
    if (/count\(\*\)/.test(sql)) return { rows: [{ n: fx.apps.length }] };
    if (/FROM apps/.test(sql) && /^\s*SELECT/.test(sql)) return { rows: fx.apps };
    return { rows: [], rowCount: fx.updateRowCount };
  },
};

function sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }

function installStubs() {
  stub(ids.logger, {
    info() {}, warn() {}, error() {}, debug() {},
  });
  stub(ids.docker, {
    async imageExists(tag) {
      fx.imageExistsCalls.push(tag);
      return fx.imageExists;
    },
    async buildImage(...a) { fx.buildCalls.push(a); },
    async waitForHealthy(...a) {
      fx.healthyCalls.push(a);
      if (fx.healthyShouldFail) throw new Error('health check failed');
    },
  });
  stub(ids.respawn, {
    async existingImageRunSpec(_config, app) {
      return { image: `usernode-app-${app.slug}:latest`, env: { FRESH: '1' }, port: 3000 };
    },
    async runExistingImage(_config, app) {
      fx.respawnCalls.push(app.slug);
      fx.concurrentNow += 1;
      fx.concurrentMax = Math.max(fx.concurrentMax, fx.concurrentNow);
      try {
        if (fx.respawnDelayMs) await sleep(fx.respawnDelayMs);
        if (fx.respawnError) throw fx.respawnError;
        return typeof fx.respawnResult === 'function'
          ? fx.respawnResult(app) : fx.respawnResult;
      } finally {
        fx.concurrentNow -= 1;
      }
    },
  });
  stub(ids.blueGreen, {
    isEligible(d) {
      return d?.strategy === 'blue-green'
        && d.databaseCompatibility === 'expand-contract'
        && d.backgroundWork === 'none';
    },
    async deploy(opts) {
      fx.blueGreenCalls.push(opts);
      return { containerId: `bg-${opts.slug}`, strategy: 'blue-green' };
    },
  });
  stub(ids.caddy, { productionHostname: (slug) => `${slug}.example.test` });
  stub(ids.staging, {
    // Real serializeRebuild is a per-slug promise chain; for these tests
    // pass-through plus a call log is enough (the chaining itself is
    // covered by staging's own behaviour).
    serializeRebuild(slug, fn) {
      fx.serializeCalls.push(slug);
      return fn();
    },
    async rebuildProduction(_config, app) {
      fx.rebuildCalls.push(app.slug);
      if (fx.rebuildError) throw fx.rebuildError;
      return fx.rebuildResult;
    },
  });
  stub(ids.deployStatus, {
    read() { return fx.deploying ? { deploying: true } : null; },
    markStart(slug, opts) { fx.markStarts.push({ slug, opts }); },
    markEnd(slug, opts) { fx.markEnds.push({ slug, opts }); },
  });
  stub(ids.events, {
    EVENT_TYPES: { CONTAINERS_ROLLED_OVER: 'containers_rolled_over' },
    record(_pool, payload) { fx.eventRecords.push(payload); return Promise.resolve(); },
  });
  stub(ids.ws, {
    broadcastToAdmins(payload) { fx.adminBroadcasts.push(payload); return 1; },
    broadcastGlobal(payload) { fx.globalBroadcasts.push(payload); },
  });
  stub(ids.pool, { getPool: () => fakePool });
}

function loadRollover() {
  delete require.cache[ids.rollover];
  return require(ids.rollover);
}

function appRow(id, slug, extra = {}) {
  return {
    id,
    slug,
    name: slug,
    db_password: 'pw',
    manifest_snapshot: { secrets: [] },
    repo_url: `https://github.com/usernode-bot/${slug}`,
    self_hosted: false,
    main_sha: 'deadbee',
    ...extra,
  };
}

// Drive one full sweep and resolve with the finished job snapshot.
async function runSweep(rollover, opts = {}) {
  const res = rollover.start({}, { userId: 7, username: 'admin-user', ...opts });
  for (let i = 0; i < 400; i++) {
    const job = rollover.read();
    if (job && job.finishedAt) return job;
    await sleep(5);
  }
  throw new Error('rollover did not finish');
}

function setup() {
  fx = freshFixtures();
  installStubs();
  const rollover = loadRollover();
  rollover._reset();
  return rollover;
}

function outcomes(job) {
  return job.apps.reduce((acc, a) => { acc[a.slug] = a.state; return acc; }, {});
}

test('selection is scoped to running, non-self-hosted apps', async () => {
  const rollover = setup();
  fx.apps = [appRow(1, 'alpha')];
  await runSweep(rollover);

  const select = fx.queries.find((q) => /^\s*\n?\s*SELECT id, slug/.test(q.sql)
    || (/SELECT id, slug/.test(q.sql)));
  assert.ok(select, 'the sweep runs a SELECT over apps');
  assert.match(select.sql, /status = 'running'/,
    'only running apps are rolled over');
  assert.match(select.sql, /self_hosted IS NOT TRUE/,
    'the platform self-app is excluded in SQL — it cannot restart itself from inside');
});

test('the self-app never reaches runExistingImage even if a row slips through', async () => {
  const rollover = setup();
  // Belt-and-braces: the predicate is in SQL, but the fake pool ignores it,
  // so this also documents that the sweep does not special-case anything
  // else about the self row — the exported query is the contract.
  assert.match(rollover.SELECT_ELIGIBLE, /self_hosted IS NOT TRUE/);
  fx.apps = [appRow(1, 'alpha')];
  await runSweep(rollover);
  assert.deepEqual(fx.respawnCalls, ['alpha']);
});

test('happy path re-runs the existing image, health-checks, and persists', async () => {
  const rollover = setup();
  fx.apps = [appRow(4, 'echo-dapp')];
  const job = await runSweep(rollover);

  assert.deepEqual(outcomes(job), { 'echo-dapp': 'rolled' });
  assert.deepEqual(fx.respawnCalls, ['echo-dapp'], 'the cheap respawn path ran');
  assert.equal(fx.buildCalls.length, 0, 'no docker build — a rollover is env-only');
  assert.equal(fx.rebuildCalls.length, 0, 'no full rebuild when the image exists');
  assert.equal(fx.healthyCalls.length, 1, 'the new container is health-checked');
  assert.equal(fx.healthyCalls[0][0], 'usernode-app-echo-dapp');
  assert.equal(fx.healthyCalls[0][2], '/health');

  const update = fx.queries.find((q) => /^UPDATE apps SET container_id/.test(q.sql));
  assert.ok(update, 'container_id is persisted');
  assert.match(update.sql, /last_deploy_at = NOW\(\)/,
    'last_deploy_at moves — it is the durable proof the container was recreated');
  assert.ok(!/status\s*=/.test(update.sql),
    'apps.status is never touched (that would drop the app URL from the home tile)');
  assert.ok(!/main_sha/.test(update.sql),
    'main_sha is never touched — nothing was rebuilt');
  assert.deepEqual(update.params, ['container-id', 4]);
});

test('compatible env-only rollover uses the blue-green lifecycle', async () => {
  const rollover = setup();
  fx.apps = [appRow(40, 'rolling', {
    manifest_snapshot: {
      secrets: [],
      deployment: {
        strategy: 'blue-green',
        databaseCompatibility: 'expand-contract',
        backgroundWork: 'none',
      },
    },
  })];
  const job = await runSweep(rollover);

  assert.deepEqual(outcomes(job), { rolling: 'rolled' });
  assert.equal(fx.respawnCalls.length, 0, 'the destructive respawn path is not used');
  assert.deepEqual(fx.blueGreenCalls, [{
    slug: 'rolling', image: 'usernode-app-rolling:latest',
    env: { FRESH: '1' }, port: 3000, hostname: 'rolling.example.test',
  }]);
  const update = fx.queries.find((q) => /^UPDATE apps SET container_id/.test(q.sql));
  assert.deepEqual(update.params, ['bg-rolling', 40]);
});

test('a missing image falls back to a full rebuild, outside the per-slug lock', async () => {
  const rollover = setup();
  fx.imageExists = false;
  fx.apps = [appRow(9, 'no-image')];
  const job = await runSweep(rollover);

  assert.deepEqual(outcomes(job), { 'no-image': 'rebuilt' });
  assert.deepEqual(fx.rebuildCalls, ['no-image']);
  assert.equal(fx.respawnCalls.length, 0, 'no point re-running an image that is gone');
  assert.equal(fx.serializeCalls.length, 0,
    'rebuildProduction takes the per-slug lock itself — nesting would deadlock');
  const update = fx.queries.find((q) => /^UPDATE apps SET container_id/.test(q.sql));
  assert.match(update.sql, /main_sha = \$2/, 'the rebuild path does record the built sha');
});

test('a missing image with no repo is a failure, not a rebuild', async () => {
  const rollover = setup();
  fx.imageExists = false;
  fx.apps = [appRow(10, 'orphan', { repo_url: null })];
  const job = await runSweep(rollover);

  assert.deepEqual(outcomes(job), { orphan: 'failed' });
  assert.equal(fx.rebuildCalls.length, 0);
  assert.equal(job.failed, 1);
});

test('missing required secrets skip the app and never fall back to a rebuild', async () => {
  const rollover = setup();
  fx.respawnResult = null; // runExistingImage's "cannot run" signal
  fx.apps = [appRow(11, 'needs-secrets')];
  const job = await runSweep(rollover);

  assert.deepEqual(outcomes(job), { 'needs-secrets': 'skipped_missing_secrets' });
  assert.equal(fx.rebuildCalls.length, 0,
    'rebuildProduction would raise MissingSecretsError for the same reason');
  assert.equal(job.failed, 0, 'a skip is not a failure');
  assert.equal(fx.markEnds[0].opts.failed, false, 'the version pill settles clean');
});

test('an app already mid-deploy is skipped rather than fought over', async () => {
  const rollover = setup();
  fx.deploying = true;
  fx.apps = [appRow(12, 'busy')];
  const job = await runSweep(rollover);

  assert.deepEqual(outcomes(job), { busy: 'skipped_deploying' });
  assert.equal(fx.respawnCalls.length, 0);
  assert.equal(fx.markStarts.length, 0, 'we never claim a slug someone else owns');
});

test('the respawn path takes the per-slug rebuild lock', async () => {
  const rollover = setup();
  fx.apps = [appRow(13, 'locked')];
  await runSweep(rollover);
  assert.deepEqual(fx.serializeCalls, ['locked'],
    'runExistingImage does not serialize itself — the rollover must');
});

test('one app failing leaves the others intact and still finishes the job', async () => {
  const rollover = setup();
  fx.apps = [appRow(1, 'a'), appRow(2, 'boom'), appRow(3, 'c')];
  fx.respawnResult = (app) => {
    if (app.slug === 'boom') throw new Error('docker run exploded');
    return `cid-${app.slug}`;
  };
  const job = await runSweep(rollover);

  assert.deepEqual(outcomes(job), { a: 'rolled', boom: 'failed', c: 'rolled' });
  assert.equal(job.failed, 1);
  assert.equal(job.done, 3);
  assert.ok(job.finishedAt, 'the job completes despite the failure');
});

test('a failed app records apps.last_failure and a failed pill', async () => {
  const rollover = setup();
  fx.apps = [appRow(5, 'sad')];
  fx.respawnError = new Error('docker run exploded');
  const job = await runSweep(rollover);

  assert.equal(job.apps[0].state, 'failed');
  const failWrite = fx.queries.find((q) => /last_failure = \$1/.test(q.sql));
  assert.ok(failWrite, 'the failure is persisted for the View build log panel');
  const record = JSON.parse(failWrite.params[0]);
  assert.equal(record.stage, 'start');
  assert.match(record.reason, /exploded/);
  assert.equal(record.sha, null, 'nothing was built, so there is no sha');
  assert.deepEqual(fx.markEnds, [{ slug: 'sad', opts: { failed: true } }]);
});

test('a container that never becomes healthy is a healthcheck failure', async () => {
  const rollover = setup();
  fx.apps = [appRow(6, 'unhealthy')];
  fx.healthyShouldFail = true;
  const job = await runSweep(rollover);

  assert.equal(job.apps[0].state, 'failed');
  const failWrite = fx.queries.find((q) => /last_failure = \$1/.test(q.sql));
  assert.equal(JSON.parse(failWrite.params[0]).stage, 'healthcheck');
});

test('an app deleted mid-job is a skip, not a failure', async () => {
  const rollover = setup();
  fx.apps = [appRow(7, 'vanished')];
  fx.updateRowCount = 0;
  const job = await runSweep(rollover);

  assert.deepEqual(outcomes(job), { vanished: 'skipped_deleted' });
  assert.equal(job.failed, 0);
});

test('markStart/markEnd are balanced on every path, including throws', async () => {
  const rollover = setup();
  fx.apps = [appRow(1, 'ok'), appRow(2, 'bad')];
  fx.respawnResult = (app) => {
    if (app.slug === 'bad') throw new Error('nope');
    return 'cid';
  };
  await runSweep(rollover);

  assert.equal(fx.markStarts.length, 2);
  assert.equal(fx.markEnds.length, 2, 'no slug is left with a permanently spinning pill');
  assert.deepEqual(fx.markStarts.map((m) => m.slug), fx.markEnds.map((m) => m.slug));
});

test('a second start() while a job is live returns the in-flight job', async () => {
  const rollover = setup();
  fx.apps = [appRow(1, 'a'), appRow(2, 'b')];
  fx.respawnDelayMs = 40;

  const first = rollover.start({}, { username: 'admin-user' });
  assert.equal(first.started, true);
  const second = rollover.start({}, { username: 'someone-else' });
  assert.equal(second.started, false, 'the singleton refuses a competing sweep');
  assert.equal(second.job.id, first.job.id);
  assert.equal(second.job.startedBy, 'admin-user');

  for (let i = 0; i < 400 && !(rollover.read() || {}).finishedAt; i++) await sleep(5);
  // Two apps, one sweep: each app respawned exactly once.
  assert.deepEqual(fx.respawnCalls.sort(), ['a', 'b']);
});

test('a finished job does not block the next one', async () => {
  const rollover = setup();
  fx.apps = [appRow(1, 'a')];
  await runSweep(rollover);
  const again = rollover.start({}, { username: 'admin-user' });
  assert.equal(again.started, true, 'press it again after fixing failures');
});

test('concurrency never exceeds the cap', async () => {
  const rollover = setup();
  fx.apps = [1, 2, 3, 4, 5, 6, 7].map((n) => appRow(n, `app-${n}`));
  fx.respawnDelayMs = 20;
  const job = await runSweep(rollover);

  assert.equal(job.total, 7);
  assert.equal(job.concurrency, rollover.DEFAULT_CONCURRENCY);
  assert.ok(fx.concurrentMax <= rollover.DEFAULT_CONCURRENCY,
    `max concurrent respawns was ${fx.concurrentMax}, cap is ${rollover.DEFAULT_CONCURRENCY}`);
  assert.ok(fx.concurrentMax > 1, 'the sweep is actually parallel, not serial');
  assert.equal(fx.respawnCalls.length, 7);
});

test('zero eligible apps completes immediately', async () => {
  const rollover = setup();
  fx.apps = [];
  const job = await runSweep(rollover);
  assert.equal(job.total, 0);
  assert.equal(job.done, 0);
  assert.ok(job.finishedAt);
});

test('progress goes to admins only, never over broadcastGlobal', async () => {
  const rollover = setup();
  fx.apps = [appRow(1, 'a')];
  await runSweep(rollover);

  assert.ok(fx.adminBroadcasts.length >= 3,
    'start, per-unit transitions and completion each broadcast');
  assert.equal(fx.globalBroadcasts.length, 0,
    'the payload is a fleet inventory — it must not reach every client');
  for (const p of fx.adminBroadcasts) {
    assert.equal(p.type, 'admin_rollover_status');
    assert.ok(p.job, 'each broadcast carries the job snapshot');
  }
  const last = fx.adminBroadcasts[fx.adminBroadcasts.length - 1];
  assert.ok(last.job.finishedAt, 'the final broadcast reports completion');
});

test('the job end writes one audit event with the tally', async () => {
  const rollover = setup();
  fx.apps = [appRow(1, 'a'), appRow(2, 'b')];
  fx.respawnResult = (app) => (app.slug === 'b' ? null : 'cid');
  await runSweep(rollover);

  assert.equal(fx.eventRecords.length, 1, 'one aggregate row, at job end');
  const rec = fx.eventRecords[0];
  assert.equal(rec.type, 'containers_rolled_over');
  assert.equal(rec.userId, 7);
  assert.equal(rec.metadata.total, 2);
  assert.equal(rec.metadata.rolled, 1);
  assert.equal(rec.metadata.skipped, 1);
  assert.equal(rec.metadata.failed, 0);
  assert.deepEqual(rec.metadata.failedSlugs, []);
  assert.equal(typeof rec.metadata.durationMs, 'number');
});

test('read() exposes a snapshot, not the live job object', async () => {
  const rollover = setup();
  fx.apps = [appRow(1, 'a')];
  const job = await runSweep(rollover);
  job.apps[0].state = 'tampered';
  assert.equal(rollover.read().apps[0].state, 'rolled',
    'a caller mutating the response cannot corrupt the job record');
});

test('the staging demo job is obviously fake and covers every chip', () => {
  const rollover = setup();
  const demo = rollover.demoJob();
  assert.equal(demo.demo, true);
  assert.ok(demo.finishedAt, 'the demo job reads as completed');
  assert.equal(demo.apps.length, demo.total);
  for (const app of demo.apps) {
    assert.match(app.slug, /^staging-demo-/, 'seeded rows can never be mistaken for real apps');
  }
  const states = demo.apps.map((a) => a.state);
  assert.ok(states.includes('rolled'));
  assert.ok(states.includes('rebuilt'));
  assert.ok(states.includes('skipped_missing_secrets'));
  assert.ok(states.includes('failed'));
  assert.equal(demo.failed, 1);
});

test('isStagingEnv tracks USERNODE_ENV', () => {
  const rollover = setup();
  const prev = process.env.USERNODE_ENV;
  try {
    process.env.USERNODE_ENV = 'staging';
    assert.equal(rollover.isStagingEnv(), true);
    process.env.USERNODE_ENV = 'production';
    assert.equal(rollover.isStagingEnv(), false);
  } finally {
    if (prev === undefined) delete process.env.USERNODE_ENV;
    else process.env.USERNODE_ENV = prev;
  }
});

test('concurrency honors the env override and is clamped', () => {
  const rollover = setup();
  const prev = process.env.ROLLOVER_CONCURRENCY;
  try {
    delete process.env.ROLLOVER_CONCURRENCY;
    assert.equal(rollover.concurrency(), rollover.DEFAULT_CONCURRENCY);
    process.env.ROLLOVER_CONCURRENCY = '5';
    assert.equal(rollover.concurrency(), 5);
    process.env.ROLLOVER_CONCURRENCY = '999';
    assert.ok(rollover.concurrency() <= 10, 'a typo cannot melt the host');
    process.env.ROLLOVER_CONCURRENCY = 'nonsense';
    assert.equal(rollover.concurrency(), rollover.DEFAULT_CONCURRENCY);
  } finally {
    if (prev === undefined) delete process.env.ROLLOVER_CONCURRENCY;
    else process.env.ROLLOVER_CONCURRENCY = prev;
  }
});
