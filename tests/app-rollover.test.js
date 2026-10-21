// Tests for the bulk container rollover orchestrator
// (src/services/app-rollover.js). All docker / staging / respawn / ws work
// is stubbed via require.cache (same pattern as tests/app-heal.test.js), so
// no real docker, DB or socket is touched. Each test drives the
// container-rollover clock's run (runJob) with a fake pool + app rows and
// asserts which path ran per app; tests/workflow-clock-postgres.test.js runs
// the on-demand clock itself.
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
  deployStatus: require.resolve('../src/services/app-deploy-status'),
  events: require.resolve('../src/services/events'),
  ws: require.resolve('../src/services/ws'),
  pool: require.resolve('../src/db/pool'),
  rollover: require.resolve('../src/services/app-rollover'),
  guard: require.resolve('../src/services/build-retention-guard'),
  platform: require.resolve('../src/workflow/platform.ts'),
};
const { PRODUCTION_BUILD_LOCK } = require('../src/services/advisory-locks');
const { fleetJobRun } = require('./lib/fleet-job-run');

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
    respawnResult: 'container-id',
    respawnError: null,
    respawnDelayMs: 0,
    concurrentNow: 0,
    concurrentMax: 0,
    // staging
    serializeCalls: [],
    lockCalls: [],
    // What a row reads under its locks, when a deploy changed it meanwhile.
    current: new Map(),
    // The deploys asked of app delivery.
    requested: [],
    // app-deploy-status
    deploying: false,
    markStarts: [],
    markEnds: [],
    // ws / events
    adminBroadcasts: [],
    globalBroadcasts: [],
    eventRecords: [],
    // the clock's run (fleetJobRun) and the runs asked of it
    run: null,
    asked: [],
    // pool
    queries: [],
    updateRowCount: 1,
  };
}

const fakePool = {
  async query(sql, params = []) {
    fx.queries.push({ sql, params });
    if (/count\(\*\)/.test(sql)) return { rows: [{ n: fx.apps.length }] };
    // One app's row again, read under its locks: as it is now (fx.current).
    if (/FROM apps/.test(sql) && /WHERE id = \$1/.test(sql)) {
      const row = fx.apps.find((a) => a.id === params[0]);
      return { rows: row ? [{ ...row, ...(fx.current.get(row.id) || {}) }] : [] };
    }
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
  stub(ids.staging, {
    // Real serializeRebuild is a per-slug promise chain; for these tests
    // pass-through plus a call log is enough (the chaining itself is
    // covered by staging's own behaviour).
    serializeRebuild(slug, fn) {
      fx.serializeCalls.push(slug);
      return fn();
    },
  });
  stub(ids.guard, {
    async withResourceUse(_config, lock, key, fn) { fx.lockCalls.push([lock, key]); return fn(); },
  });
  stub(ids.platform, {
    requestDeploy: async (appId, reason) => { fx.requested.push([appId, reason]); return 1; },
    clockRunOf: async (_db, job) => { assert.equal(job, 'container-rollover'); return fx.run ? fx.run.run : null; },
    // The clock refuses a run asked while one runs (machine.ts); here the
    // caller's own check answers first.
    askClockRun: async (job, admin) => {
      fx.asked.push([job, admin.username]);
      fx.run = fleetJobRun({ n: (fx.run ? fx.run.run.n : 0) + 1, by: admin.username, userId: admin.id });
      return 'asked';
    },
  });
  stub(ids.deployStatus, {
    // A deploy in this process (the map), or one app delivery runs (the row).
    read(slug, row) { return fx.deploying || row?.deploy_state === 'deploying' ? { deploying: true } : null; },
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

// Ask for one sweep, run it to its end, and resolve with the finished job
// as the console reads it.
async function runSweep(rollover, config = {}) {
  const { started } = await rollover.start(fakePool, { id: 7, username: 'admin-user' });
  assert.equal(started, true);
  await fx.run.go(rollover.runJob, { config, pool: fakePool });
  return rollover.read(fakePool);
}

function setup() {
  fx = freshFixtures();
  installStubs();
  return loadRollover();
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
  assert.equal(fx.requested.length, 0, 'no rebuild asked for when the image exists');
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

test('a missing image with no repo is a failure, not a rebuild', async () => {
  const rollover = setup();
  fx.imageExists = false;
  fx.apps = [appRow(10, 'orphan', { repo_url: null })];
  const job = await runSweep(rollover);

  assert.deepEqual(outcomes(job), { orphan: 'failed' });
  assert.equal(fx.requested.length, 0);
  assert.equal(job.failed, 1);
});

test('missing required secrets skip the app and never fall back to a rebuild', async () => {
  const rollover = setup();
  fx.respawnResult = null; // runExistingImage's "cannot run" signal
  fx.apps = [appRow(11, 'needs-secrets')];
  const job = await runSweep(rollover);

  assert.deepEqual(outcomes(job), { 'needs-secrets': 'skipped_missing_secrets' });
  assert.equal(fx.requested.length, 0,
    'a deploy would raise MissingSecretsError for the same reason');
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

test('the respawn path also takes the cross-process build lock, as a rebuild does', async () => {
  const rollover = setup();
  fx.apps = [appRow(14, 'locked-across')];
  await runSweep(rollover);
  assert.deepEqual(fx.lockCalls, [[PRODUCTION_BUILD_LOCK, 'locked-across']],
    'a rebuild in another process (Kubernetes) waits for it, and it for the rebuild');
});

test('on Kubernetes an app with an image is respawned from it, not rebuilt (its image_ref is read)', async () => {
  const rollover = setup();
  fx.apps = [appRow(15, 'kube-app', { image_ref: 'registry/kube-app@sha256:abc' })];
  const job = await runSweep(rollover, { appRuntime: 'kubernetes' });
  assert.match(fx.queries.find((q) => /SELECT id, slug/.test(q.sql)).sql, /image_ref/);
  assert.deepEqual(outcomes(job), { 'kube-app': 'rolled' });
  assert.equal(fx.requested.length, 0);
});

test('a deploy that ran while the job waited is not undone: the respawn runs the image the row has now', async () => {
  const rollover = setup();
  fx.apps = [appRow(18, 'redeployed', { image_ref: 'registry/redeployed@sha256:old' })];
  fx.current.set(18, { image_ref: 'registry/redeployed@sha256:new', main_sha: 'newsha' });
  const ran = [];
  require.cache[ids.respawn].exports.runExistingImage = async (_config, app) => { ran.push(app.image_ref); return 'cid'; };
  await runSweep(rollover, { appRuntime: 'kubernetes' });
  assert.deepEqual(ran, ['registry/redeployed@sha256:new'], 'not the one the job saw when it started');
});

test('an app that started deploying while the job waited is skipped', async () => {
  const rollover = setup();
  fx.apps = [appRow(19, 'late-deploy')];
  fx.current.set(19, { deploy_state: 'deploying' });
  const job = await runSweep(rollover);
  assert.deepEqual(outcomes(job), { 'late-deploy': 'skipped_deploying' });
  assert.equal(fx.respawnCalls.length, 0);
});

test('a missing image asks app delivery for the rebuild, outside the per-slug lock', async () => {
  const rollover = setup();
  fx.imageExists = false;
  fx.apps = [appRow(16, 'gone-image')];
  const job = await runSweep(rollover);
  assert.deepEqual(outcomes(job), { 'gone-image': 'rebuild_requested' });
  assert.deepEqual(fx.requested, [[16, 'rollover']]);
  assert.equal(fx.respawnCalls.length, 0, 'no point re-running an image that is gone');
  assert.equal(fx.serializeCalls.length, 0, 'app delivery orders its own deploys');
  assert.ok(!fx.queries.some((q) => /^UPDATE apps SET container_id/.test(q.sql)),
    'the machine writes what it deploys');
  assert.equal(fx.eventRecords[0].metadata.rebuildRequested, 1);
});

test('an app app delivery is deploying, in any process, is skipped', async () => {
  const rollover = setup();
  fx.apps = [appRow(17, 'delivering', { deploy_state: 'deploying' })];
  const job = await runSweep(rollover);
  assert.deepEqual(outcomes(job), { delivering: 'skipped_deploying' });
  assert.equal(fx.respawnCalls.length, 0);
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

test('a start while a job runs, on any process, returns the job under way', async () => {
  const rollover = setup();
  fx.apps = [appRow(1, 'a'), appRow(2, 'b')];
  fx.respawnDelayMs = 40;

  const first = await rollover.start(fakePool, { id: 7, username: 'admin-user' });
  assert.equal(first.started, true);
  const running = fx.run.go(rollover.runJob, { config: {}, pool: fakePool });
  await sleep(5);
  const second = await rollover.start(fakePool, { id: 8, username: 'someone-else' });
  assert.equal(second.started, false, 'one sweep at a time');
  assert.equal(second.job.id, first.job.id);
  assert.equal(second.job.startedBy, 'admin-user');
  assert.equal(fx.asked.length, 1, 'the clock was asked once');

  await running;
  // Two apps, one sweep: each app respawned exactly once.
  assert.deepEqual(fx.respawnCalls.sort(), ['a', 'b']);
});

test('a finished job does not block the next one', async () => {
  const rollover = setup();
  fx.apps = [appRow(1, 'a')];
  await runSweep(rollover);
  const again = await rollover.start(fakePool, { id: 7, username: 'admin-user' });
  assert.equal(again.started, true, 'press it again after fixing failures');
});

test('a run carried on after a restart rolls only the apps it had not finished', async (t) => {
  const rollover = setup();
  process.env.ROLLOVER_CONCURRENCY = '1';
  t.after(() => { delete process.env.ROLLOVER_CONCURRENCY; });
  fx.apps = [appRow(1, 'a'), appRow(2, 'b'), appRow(3, 'c')];
  const first = fleetJobRun();
  fx.run = first;
  // The first process goes away while it rolls 'b'.
  fx.respawnResult = (app) => { if (app.slug === 'b') first.stop(); return 'cid'; };
  await assert.rejects(first.go(rollover.runJob, { config: {}, pool: fakePool }));
  assert.deepEqual(fx.respawnCalls, ['a', 'b']);
  assert.equal(fx.eventRecords.length, 0, 'not finished');

  fx.respawnCalls = [];
  // It was first started an hour ago: the audit counts from then.
  const resumeFrom = { ...first.run.checkpoint, started: new Date(Date.now() - 60 * 60 * 1000).toISOString() };
  const again = fleetJobRun({ resumeFrom });
  fx.run = again;
  await again.go(rollover.runJob, { config: {}, pool: fakePool });
  assert.deepEqual(fx.respawnCalls, ['c'], 'only the app not yet rolled');
  assert.ok(fx.eventRecords[0].metadata.durationMs >= 60 * 60 * 1000, 'the duration spans every claim of the run');
  const job = await rollover.read(fakePool);
  assert.deepEqual(outcomes(job), { a: 'rolled', b: 'rolled', c: 'rolled' });
  assert.ok(job.finishedAt);
  assert.equal(fx.eventRecords.length, 1, 'one audit row for the job');
});

test('a run that stops keeps every app under way at the time, so the next claim rolls none twice', async () => {
  const rollover = setup();
  fx.apps = [appRow(1, 'a'), appRow(2, 'b'), appRow(3, 'c'), appRow(4, 'd')];
  fx.respawnDelayMs = 30;
  const first = fleetJobRun();
  fx.run = first;
  // The process starts stopping while 'a', 'b' and 'c' are being rolled.
  fx.respawnResult = (app) => { if (app.slug === 'a') first.stop(); return 'cid'; };
  await assert.rejects(first.go(rollover.runJob, { config: {}, pool: fakePool }));
  assert.deepEqual(fx.respawnCalls.sort(), ['a', 'b', 'c']);

  fx.respawnCalls = [];
  fx.respawnResult = 'cid';
  const again = fleetJobRun({ resumeFrom: first.run.checkpoint });
  fx.run = again;
  await again.go(rollover.runJob, { config: {}, pool: fakePool });
  assert.deepEqual(fx.respawnCalls, ['d'], 'only the app nobody had started');
});

test('a run asked for hours ago is not carried on (a claim left over a rollback)', async () => {
  const rollover = setup();
  fx.apps = [appRow(1, 'a'), appRow(2, 'b')];
  const old = fleetJobRun({ resumeFrom: { started: new Date(Date.now() - 7 * 60 * 60 * 1000).toISOString(), items: [{ id: 1, slug: 'a' }, { id: 2, slug: 'b' }] } });
  fx.run = old;
  const out = await old.go(rollover.runJob, { config: {}, pool: fakePool });
  assert.equal(out.abandoned, true);
  assert.deepEqual(fx.respawnCalls, [], 'nothing rolled');
  assert.equal(fx.eventRecords.length, 0);
});

test('progress too big for one bus frame goes as a nudge, and a read from any process shows the units under way', async () => {
  const rollover = setup();
  fx.apps = Array.from({ length: 200 }, (_, i) => appRow(i + 1, `a-much-longer-app-slug-${i + 1}`));
  fx.respawnDelayMs = 20;
  const run = fleetJobRun();
  fx.run = run;
  let seen = null;
  fx.respawnResult = () => 'cid';
  const going = run.go(rollover.runJob, { config: {}, pool: fakePool });
  // Mid-run, as another process reads it (the run's checkpoint).
  await sleep(10);
  seen = await rollover.read(fakePool);
  await going;
  assert.ok(seen.apps.some((a) => a.state === 'running'), 'the units under way read as running');
  const frames = fx.adminBroadcasts.map((b) => Buffer.byteLength(JSON.stringify(b)));
  assert.ok(Math.max(...frames) <= 8000, `every frame fits a NOTIFY: ${Math.max(...frames)}`);
  assert.ok(fx.adminBroadcasts.some((b) => b.changed === true && b.job === undefined), 'the big job came as a nudge');
  // A small job goes whole.
  const small = setup();
  fx.apps = [appRow(1, 'a')];
  fx.run = fleetJobRun();
  await fx.run.go(small.runJob, { config: {}, pool: fakePool });
  assert.ok(fx.adminBroadcasts.every((b) => b.job), 'a small job is sent whole');
});

test('a run nobody asked for (an older build armed the job on an interval) is no job on the console', async () => {
  const rollover = setup();
  fx.run = fleetJobRun();
  fx.run.run.input = { n: 1, previous: null };
  fx.run.run.running = false;
  assert.equal(await rollover.read(fakePool), null);
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
  assert.equal((await rollover.read(fakePool)).apps[0].state, 'rolled',
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
  assert.ok(states.includes('rebuild_requested'));
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
