// Tests for the stale-staging-preview sweep (src/services/staging-reap.js).
//
// All docker / staging / db-manager / ws work is stubbed via require.cache
// (same pattern as tests/app-rollover.test.js), so no real docker, DB or
// socket is touched. The fixture reproduces the FIVE groups the production
// fleet actually contained when this module landed, because they are what
// makes DB-only enumeration wrong:
//
//   linked-merged      85  session row still names the container
//   unlinked-merged    10  staging_container_id nulled, container survived
//   archived            6  abandoned proposal
//   promoted            3  backs a live merge vote
//   no session row      5  app deleted, chat_sessions row cascaded away
//
// `SELECT … WHERE staging_container_id IS NOT NULL` finds only the first,
// third and fourth groups — 94 of 109 in production. So the sweep enumerates
// docker and joins BACK to the DB, and the two teardown paths (chokepoint vs
// by-name) are chosen by what the DB says, not by what the container is.
//
// Run with: node --test tests/staging-reap.test.js

const test = require('node:test');
const assert = require('node:assert/strict');

function stub(id, exports) {
  require.cache[id] = { id, filename: id, loaded: true, exports, paths: [] };
}

const ids = {
  logger: require.resolve('../src/services/logger'),
  docker: require.resolve('../src/services/docker'),
  staging: require.resolve('../src/services/staging'),
  dbManager: require.resolve('../src/services/db-manager'),
  events: require.resolve('../src/services/events'),
  ws: require.resolve('../src/services/ws'),
  pool: require.resolve('../src/db/pool'),
  kubernetes: require.resolve('../src/services/kubernetes'),
  applicationRuntime: require.resolve('../src/services/application-runtime'),
  previewWorkflow: require.resolve('../src/services/preview-workflow'),
  platform: require.resolve('../src/workflow/platform.ts'),
  reap: require.resolve('../src/services/staging-reap'),
};
const { fleetJobRun } = require('./lib/fleet-job-run');

let fx;

function freshFixtures() {
  return {
    // docker ps output lines: [name, state, image]
    psLines: [],
    psError: null,
    dockerExecCalls: 0,
    exists: () => true,
    existsCalls: [],
    // #851: inspect probe (null = "no label there either")
    inspect: null,
    inspectCalls: [],
    stopCalls: [],
    stopError: null,
    // staging
    teardownCalls: [],
    teardownError: null,
    // session ids whose teardown reports a surviving container (#851)
    teardownLeaks: [],
    // db-manager
    dropCalls: [],
    dropError: null,
    // pool
    sessions: [],
    queries: [],
    // session ids the preview machine holds (wf_instances, and its held())
    held: [],
    // the preview-reap clock's run (fleetJobRun) and the runs asked of it
    run: null,
    asked: [],
    // ws / events
    adminBroadcasts: [],
    eventRecords: [],
    // concurrency observation
    concurrentNow: 0,
    concurrentMax: 0,
    unitDelayMs: 0,
    // kubernetes: preview Deployments as kubernetes.listPreviews returns them
    kubePreviews: [],
    kubeListError: null,
    kubeListCalls: [],
    kubeExists: () => true,
    kubeInspectCalls: [],
    kubeRemoveCalls: [],
    kubeRemoveError: null,
  };
}

const fakePool = {
  async query(sql, params = []) {
    fx.queries.push({ sql, params });
    // What works on the sessions on any process (active-workers
    // busySessionsAnywhere): the fixtures' `working` ids.
    if (/cs\.id = ANY\(\$1::int\[\]\) AND \(cs\.active_turn IS NOT NULL/.test(sql)) {
      return { rows: (fx.working || []).filter((id) => (params[0] || []).includes(id)).map((id) => ({ id })) };
    }
    // Whether one session is worked on now (isSessionBusyAnywhere).
    if (/AS busy FROM chat_sessions cs WHERE cs\.id = \$1/.test(sql)) {
      return { rows: [{ busy: (fx.working || []).includes(params[0]) }] };
    }
    if (/FROM chat_sessions/.test(sql)) {
      const ids_ = params[0] || [];
      return { rows: fx.sessions.filter((s) => ids_.includes(s.id)) };
    }
    if (/FROM wf_instances/.test(sql)) return { rows: fx.held.map((id) => ({ id })) };
    return { rows: [], rowCount: 1 };
  },
};

function sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }

function installStubs() {
  stub(ids.logger, { info() {}, warn() {}, error() {}, debug() {} });
  stub(ids.docker, {
    STAGING_STOP_GRACE_SEC: 2,
    async execFileAsync(_bin, args) {
      fx.dockerExecCalls += 1;
      if (fx.psError) throw fx.psError;
      // Pin that the sweep asks docker for ALL staging containers, exited
      // ones included — a stopped preview still holds its name, image and
      // database, so it is exactly as much of a leak as a running one.
      assert.ok(args.includes('-a'), 'must list stopped containers too');
      assert.ok(args.includes('name=^/usernode-staging-'), 'must filter by the staging prefix');
      return { stdout: `${fx.psLines.map((l) => l.join('\t')).join('\n')}\n` };
    },
    async containerExists(name) {
      fx.existsCalls.push(name);
      return fx.exists(name);
    },
    // #851: the automatic pass probes one container with a real inspect when
    // `docker ps` reported no labels at all, to tell "this fleet predates the
    // fingerprint" from "this docker cannot answer {{.Label}}". Default null =
    // the probe finds nothing either, so unlabelled genuinely means stale.
    async inspectContainer(name) {
      fx.inspectCalls.push(name);
      return fx.inspect ? fx.inspect(name) : null;
    },
    async stopAndRemove(name, opts) {
      fx.stopCalls.push({ name, opts });
      if (fx.stopHook) fx.stopHook();
      fx.concurrentNow += 1;
      fx.concurrentMax = Math.max(fx.concurrentMax, fx.concurrentNow);
      try {
        if (fx.unitDelayMs) await sleep(fx.unitDelayMs);
        if (fx.stopError) throw fx.stopError;
      } finally {
        fx.concurrentNow -= 1;
      }
    },
  });
  stub(ids.staging, {
    async teardownStaging(session, app) {
      fx.teardownCalls.push({ sessionId: session.id, slug: app && app.slug });
      if (fx.stopHook) fx.stopHook();
      fx.concurrentNow += 1;
      fx.concurrentMax = Math.max(fx.concurrentMax, fx.concurrentNow);
      try {
        if (fx.unitDelayMs) await sleep(fx.unitDelayMs);
        if (fx.teardownError) throw fx.teardownError;
        // #851: the real chokepoint reports whether the container actually
        // went away. `teardownLeaks` makes a session return the leak shape.
        if (fx.teardownLeaks.includes(session.id)) return { removed: false, leaked: true };
        return { removed: true, leaked: false };
      } finally {
        fx.concurrentNow -= 1;
      }
    },
  });
  stub(ids.dbManager, {
    stagingDbName(slug, username, commitHash) {
      return `app_${slug.replace(/[^a-z0-9_]/g, '_')}_staging_${username}_${commitHash.slice(0, 6)}`;
    },
    async dropDatabase(name) {
      fx.dropCalls.push(name);
      if (fx.dropError) throw fx.dropError;
    },
  });
  stub(ids.events, {
    EVENT_TYPES: { STALE_PREVIEWS_REAPED: 'stale_previews_reaped' },
    record(_pool, payload) { fx.eventRecords.push(payload); return Promise.resolve(); },
  });
  stub(ids.ws, {
    broadcastToAdmins(payload) { fx.adminBroadcasts.push(payload); return 1; },
  });
  stub(ids.pool, { getPool: () => fakePool });
  stub(ids.kubernetes, {
    async listPreviews(config) {
      fx.kubeListCalls.push(config);
      if (fx.kubeListError) throw fx.kubeListError;
      return fx.kubePreviews;
    },
  });
  stub(ids.previewWorkflow, {
    async held(sessionId) { return fx.held.includes(Number(sessionId)); },
  });
  stub(ids.platform, {
    clockRunOf: async (_db, job) => { assert.equal(job, 'preview-reap'); return fx.run ? fx.run.run : null; },
    askClockRun: async (job, admin) => {
      fx.asked.push([job, admin.username]);
      fx.run = fleetJobRun({ n: (fx.run ? fx.run.run.n : 0) + 1, by: admin.username, userId: admin.id });
      return 'asked';
    },
  });
  stub(ids.applicationRuntime, {
    mode: (config) => config?.appRuntime || process.env.APP_RUNTIME || 'docker',
    async inspect(_config, ref) {
      fx.kubeInspectCalls.push(ref.runtimeName);
      return { status: fx.kubeExists(ref.runtimeName) ? 'running' : 'not_found' };
    },
    async remove(config, ref) {
      fx.kubeRemoveCalls.push({
        name: ref.runtimeName, kind: ref.runtimeKind, namespace: config.kubernetes.appNamespace,
      });
      if (fx.kubeRemoveError) throw fx.kubeRemoveError;
    },
  });
}

function loadReap() {
  delete require.cache[ids.reap];
  return require(ids.reap);
}

function setup() {
  fx = freshFixtures();
  installStubs();
  return loadReap();
}

// Ask for one sweep, run the preview-reap clock's run to its end, and
// resolve with the finished job as the console reads it.
async function runSweep(reap, config = {}) {
  const res = await reap.start(fakePool, { id: 7, username: 'admin-user' });
  assert.equal(res.started, true, 'the sweep must start');
  await fx.run.go(reap.runJob, { config, pool: fakePool });
  return reap.read(fakePool);
}

function states(job) {
  return job.previews.reduce((acc, p) => { acc[p.name] = p.state; return acc; }, {});
}

function classifications(job) {
  return job.previews.reduce((acc, p) => { acc[p.name] = p.classification; return acc; }, {});
}

// The production fleet's five groups, one container each.
function fleet() {
  fx.psLines = [
    ['usernode-staging-community-tier-lists-57ce6a--2549', 'running', 'usernode-staging-community-tier-lists-57ce6a-2549:672ecf'],
    ['usernode-staging-whiteboard-0d337f--2458', 'running', 'usernode-staging-whiteboard-0d337f-2458:ce25fb'],
    ['usernode-staging-guardian-2-99eba3--2472', 'running', 'usernode-staging-guardian-2-99eba3-2472:1b3ff2'],
    ['usernode-staging-usernode-2d5619--2795', 'running', 'usernode-staging-usernode-2d5619-2795:5ebf65'],
    ['usernode-staging-veya-afaeaa--1212', 'exited', 'usernode-staging-veya-afaeaa-1212:d49e87'],
  ];
  fx.sessions = [
    { id: 2549, status: 'merged', pr_number: 164, staging_container_id: 'cid-2549', staging_url: 'https://x--s2549--672ecf.example', app_slug: 'community-tier-lists-57ce6a' },
    // Leaked past a prior teardown: the row was nulled, the container wasn't.
    { id: 2458, status: 'merged', pr_number: 691, staging_container_id: null, staging_url: null, app_slug: 'whiteboard-0d337f' },
    { id: 2472, status: 'archived', pr_number: 384, staging_container_id: 'cid-2472', staging_url: 'https://x--s2472--1b3ff2.example', app_slug: 'guardian-2-99eba3' },
    { id: 2795, status: 'promoted', pr_number: 840, staging_container_id: 'cid-2795', staging_url: 'https://x--s2795--5ebf65.example', app_slug: 'usernode-2d5619' },
    // 1212 deliberately absent: its app was deleted and the row cascaded.
  ];
}

// ── Enumeration and name parsing ────────────────────────────────────────

test('every container in the fleet is enumerated and classified', async () => {
  const reap = setup();
  fleet();
  const items = await reap.classify(fakePool, await reap.listStagingContainers());

  assert.equal(items.length, 5, 'all five groups must be picked up, not just the linked ones');
  assert.deepEqual(Object.fromEntries(items.map((i) => [i.name, i.classification])), {
    'usernode-staging-community-tier-lists-57ce6a--2549': 'merged',
    'usernode-staging-whiteboard-0d337f--2458': 'merged_unlinked',
    'usernode-staging-guardian-2-99eba3--2472': 'archived',
    'usernode-staging-usernode-2d5619--2795': 'promoted',
    'usernode-staging-veya-afaeaa--1212': 'no_session_row',
  });
});

// The admin sweep used to take every preview it enumerated, a leftover of the
// one-off RSA cutover cleanup (#850). A preview backing a live vote is rebuilt
// in place by the heal pass when it goes out of date, so taking it down only
// costs the voters their preview and re-runs the proposal's checks.
test('the admin sweep never takes a preview backing a live vote', async () => {
  const reap = setup();
  fleet();
  const job = await runSweep(reap);

  assert.equal(job.total, 4);
  assert.deepEqual(classifications(job), {
    'usernode-staging-community-tier-lists-57ce6a--2549': 'merged',
    'usernode-staging-whiteboard-0d337f--2458': 'merged_unlinked',
    'usernode-staging-guardian-2-99eba3--2472': 'archived',
    'usernode-staging-veya-afaeaa--1212': 'no_session_row',
  });
  assert.equal(fx.teardownCalls.some((c) => c.sessionId === 2795), false);
});

// The slug contains hyphens, and for the self-app it STARTS with
// `usernode-` — so the pattern has to anchor on the double hyphen before a
// trailing all-digits session id rather than splitting on the first hyphen.
test('the name parser handles hyphenated and usernode-prefixed slugs', async () => {
  const reap = setup();
  fx.psLines = [
    ['usernode-staging-usernode-2d5619--2795', 'running', 'img:aaaaaa'],
    ['usernode-staging-guardian-2-99eba3--2472', 'running', 'img:bbbbbb'],
    ['usernode-staging-a--7', 'running', 'img:cccccc'],
  ];
  const parsed = await reap.listStagingContainers();
  assert.deepEqual(parsed.map((p) => [p.slug, p.sessionId]), [
    ['usernode-2d5619', 2795],
    ['guardian-2-99eba3', 2472],
    ['a', 7],
  ]);
});

// A name we cannot identify is left strictly alone — better to under-reap
// than to stop a container we did not recognise.
test('an unrecognised container name is skipped, not guessed at', async () => {
  const reap = setup();
  fx.psLines = [
    ['usernode-staging-good--12', 'running', 'img:aaaaaa'],
    ['usernode-staging-no-session-suffix', 'running', 'img:bbbbbb'],
    ['usernode-staging-trailing--notanumber', 'running', 'img:cccccc'],
  ];
  const parsed = await reap.listStagingContainers();
  assert.deepEqual(parsed.map((p) => p.name), ['usernode-staging-good--12']);
});

test('a docker failure yields an empty inventory, not a crash', async () => {
  const reap = setup();
  fx.psError = new Error('docker daemon unreachable');
  const job = await runSweep(reap);
  assert.equal(job.total, 0);
  assert.equal(job.failed, 0);
  assert.equal(fx.stopCalls.length, 0, 'nothing may be torn down blind');
});

// ── The two teardown paths ──────────────────────────────────────────────

test('a linked session routes through teardownStaging, unlinked ones by name', async () => {
  const reap = setup();
  fleet();
  const job = await runSweep(reap);

  // Chokepoint path: the two taken sessions whose row still names the
  // container (the promoted one backs a vote and is not taken at all).
  assert.deepEqual(
    fx.teardownCalls.map((c) => c.sessionId).sort((a, b) => a - b),
    [2472, 2549]
  );
  // teardownStaging derives the staging DB name from staging_url itself, so
  // the sweep must NOT also drop a database for those.
  assert.deepEqual(
    fx.teardownCalls.map((c) => c.slug).sort(),
    ['community-tier-lists-57ce6a', 'guardian-2-99eba3']
  );

  // By-name path: the leaked container and the session-less one.
  assert.deepEqual(fx.stopCalls.map((c) => c.name).sort(), [
    'usernode-staging-veya-afaeaa--1212',
    'usernode-staging-whiteboard-0d337f--2458',
  ]);
  for (const call of fx.stopCalls) {
    assert.equal(call.opts.stopTimeoutSec, 2, 'must use the staging stop grace');
  }

  // Their databases come from the IMAGE TAG's commit hash — the only place
  // it survives once staging_url is null.
  assert.deepEqual(fx.dropCalls.sort(), [
    'app_veya_afaeaa_staging_s1212_d49e87',
    'app_whiteboard_0d337f_staging_s2458_ce25fb',
  ]);

  assert.equal(job.failed, 0);
  for (const state of Object.values(states(job))) {
    assert.equal(state, 'torn_down');
  }
});

// The whole point of deriving from the image tag: an unparseable one must
// leave the database alone rather than guess a name. teardownStaging's own
// fallback is the literal '000000', which would name someone else's DB.
test('an unparseable image tag skips the DB drop instead of guessing', async () => {
  const reap = setup();
  fx.psLines = [
    ['usernode-staging-orphan-abc123--55', 'running', 'usernode-staging-orphan-abc123-55:latest'],
  ];
  fx.sessions = [];
  const job = await runSweep(reap);

  assert.deepEqual(fx.stopCalls.map((c) => c.name), ['usernode-staging-orphan-abc123--55'],
    'the container still goes away — that is the part that matters');
  assert.deepEqual(fx.dropCalls, [], 'but no database is dropped on a guess');
  assert.equal(job.previews[0].state, 'torn_down_no_db');
  assert.equal(job.failed, 0, 'a kept database is not a failed unit');
});

// A database that refuses to drop is a leak to chase separately: the
// container is already gone, so the unit is not a failure.
test('a failed DB drop still counts as torn down', async () => {
  const reap = setup();
  fx.psLines = [['usernode-staging-orphan-abc123--55', 'running', 'img:abc123']];
  fx.sessions = [];
  fx.dropError = new Error('database is being accessed by other users');
  const job = await runSweep(reap);

  assert.equal(job.previews[0].state, 'torn_down_no_db');
  assert.equal(job.failed, 0);
});

test('a container that vanished mid-sweep is skipped', async () => {
  const reap = setup();
  fleet();
  fx.exists = (name) => name !== 'usernode-staging-veya-afaeaa--1212';
  const job = await runSweep(reap);

  assert.equal(states(job)['usernode-staging-veya-afaeaa--1212'], 'skipped_gone');
  assert.equal(fx.dropCalls.length, 1, 'a vanished container drops no database');
  assert.equal(job.failed, 0);
});

// ── Failure isolation ───────────────────────────────────────────────────

test('one stuck container does not take the sweep down', async () => {
  const reap = setup();
  fleet();
  fx.teardownError = new Error('stop timeout exceeded');
  const job = await runSweep(reap);

  assert.equal(job.total, 4);
  assert.equal(job.done, 4, 'every unit is still attempted');
  assert.equal(job.failed, 2, 'the two chokepoint units fail');
  const s = states(job);
  assert.equal(s['usernode-staging-community-tier-lists-57ce6a--2549'], 'failed');
  assert.equal(s['usernode-staging-whiteboard-0d337f--2458'], 'torn_down',
    'the by-name path is unaffected');
  assert.ok(job.previews.find((p) => p.state === 'failed').error,
    'a failed unit carries its reason for the console');
});

test('a failed stopAndRemove is isolated to its own unit', async () => {
  const reap = setup();
  fleet();
  fx.stopError = new Error('permission denied');
  const job = await runSweep(reap);

  assert.equal(job.failed, 2, 'only the two by-name units');
  assert.deepEqual(fx.dropCalls, [], 'a container that would not stop keeps its database');
});

// ── Job shape, singleton, progress and tally ────────────────────────────

test('a start while a sweep runs, on any process, returns the job under way', async () => {
  const reap = setup();
  fleet();
  fx.unitDelayMs = 30;
  const first = await reap.start(fakePool, { id: 7, username: 'admin-user' });
  assert.equal(first.started, true);
  const running = fx.run.go(reap.runJob, { config: {}, pool: fakePool });
  await sleep(5);
  const second = await reap.start(fakePool, { id: 8, username: 'someone-else' });
  assert.equal(second.started, false, 'the route turns this into a 409');
  assert.equal(second.job.id, first.job.id);
  assert.equal(second.job.startedBy, 'admin-user');
  assert.equal(fx.asked.length, 1);
  await running;
});

test('a session somebody started working on since the sweep listed it keeps its preview', async () => {
  const reap = setup();
  kubeFleet(currentFp());
  // 5806 is a live session's out-of-date preview: listed, then a turn starts.
  const real = fakePool.query;
  let listed = false;
  fakePool.query = async (sql, params) => {
    if (/cs\.id = ANY\(\$1::int\[\]\) AND \(cs\.active_turn IS NOT NULL/.test(sql)) listed = true;
    else if (listed) fx.working = [5806];
    return real(sql, params);
  };
  try {
    const job = await runSweep(reap, KUBE);
    assert.equal(states(job)[job.previews.find((p) => p.sessionId === 5806).name], 'skipped_busy');
    assert.ok(!fx.kubeRemoveCalls.some((c) => /s5806$/.test(c.name)) && !fx.teardownCalls.some((c) => c.sessionId === 5806));
  } finally {
    fakePool.query = real;
  }
});

test('a preview whose session was put up for a vote, or started a checks run, since the sweep listed it is kept', async () => {
  const reap = setup();
  kubeFleet(currentFp());
  // 5806 is a live session's out-of-date preview: listed, then changed.
  for (const [change, outcome] of [[{ status: 'promoted' }, 'skipped_vote'], [{ check_run_open: true }, 'skipped_checks']]) {
    fx.kubeRemoveCalls = []; fx.teardownCalls = [];
    const real = fakePool.query;
    let listed = false;
    fakePool.query = async (sql, params) => {
      if (/cs\.id = ANY\(\$1::int\[\]\) AND \(cs\.active_turn IS NOT NULL/.test(sql)) listed = true;
      const out = await real(sql, params);
      if (listed && /FROM chat_sessions/.test(sql) && !/AS busy/.test(sql)) {
        return { ...out, rows: out.rows.map((r) => (r.id === 5806 ? { ...r, ...change } : r)) };
      }
      return out;
    };
    try {
      const job = await runSweep(reap, KUBE);
      assert.equal(job.previews.find((p) => p.sessionId === 5806).state, outcome);
      assert.ok(!fx.teardownCalls.some((c) => c.sessionId === 5806) && !fx.kubeRemoveCalls.some((c) => /s5806$/.test(c.name)));
    } finally {
      fakePool.query = real;
    }
  }
});

test('a preview rebuilt with the current environment since the sweep listed it is kept, a stopped sweep resumed included', async () => {
  const reap = setup();
  kubeFleet(currentFp());
  // 5806 is a live session's out-of-date preview. The sweep lists it, then
  // stops; the preview machine rebuilds it with today's environment (same
  // Deployment, its new label); the sweep is carried on.
  const first = fleetJobRun();
  fx.run = first;
  fx.kubeExists = () => { first.stop(); return true; };
  await assert.rejects(first.go(reap.runJob, { config: KUBE, pool: fakePool }));
  fx.kubeExists = () => true;
  const listed = first.run.checkpoint.items.find((i) => i.sessionId === 5806);
  assert.ok(listed, 'listed as out of date');
  for (const p of fx.kubePreviews) if (p.sessionId === 5806) p.labels = { ...p.labels, [require('../src/services/staging-env').LABEL_ENV_FP]: currentFp() };
  fx.kubeRemoveCalls = []; fx.teardownCalls = [];
  const again = fleetJobRun({ resumeFrom: first.run.checkpoint });
  fx.run = again;
  await again.go(reap.runJob, { config: KUBE, pool: fakePool });
  const job = await reap.read(fakePool);
  assert.equal(job.previews.find((p) => p.sessionId === 5806).state, 'skipped_current');
  assert.ok(!fx.teardownCalls.some((c) => c.sessionId === 5806) && !fx.kubeRemoveCalls.some((c) => /s5806$/.test(c.name)),
    'the healthy preview stays');
  // One the runtime no longer lists is not torn down blind.
  fx.kubePreviews = [];
  const third = fleetJobRun({ resumeFrom: { started: new Date().toISOString(), items: [listed] } });
  fx.run = third;
  await third.go(reap.runJob, { config: KUBE, pool: fakePool });
  assert.equal((await reap.read(fakePool)).previews[0].state, 'skipped_unseen');
});

test('a sweep carried on after a restart tears down only what it had not', async (t) => {
  const reap = setup();
  process.env.STAGING_REAP_CONCURRENCY = '1';
  t.after(() => { delete process.env.STAGING_REAP_CONCURRENCY; });
  fleet();
  const first = fleetJobRun();
  fx.run = first;
  // The process goes away during the first teardown.
  fx.stopHook = () => first.stop();
  await assert.rejects(first.go(reap.runJob, { config: {}, pool: fakePool }));
  const before = fx.teardownCalls.length + fx.stopCalls.length;
  assert.equal(before, 1, 'one preview torn down before the process went away');
  assert.equal(fx.eventRecords.length, 0);

  fx.stopHook = null;
  const again = fleetJobRun({ resumeFrom: first.run.checkpoint });
  fx.run = again;
  await again.go(reap.runJob, { config: {}, pool: fakePool });
  assert.equal(fx.teardownCalls.length + fx.stopCalls.length, 4, 'each of the four torn down once');
  const job = await reap.read(fakePool);
  assert.equal(job.done, 4);
  assert.ok(job.finishedAt);
  assert.equal(fx.eventRecords.length, 1);
});

test('teardown concurrency is bounded by the drain width', async () => {
  const reap = setup();
  fleet();
  fx.unitDelayMs = 20;
  const job = await runSweep(reap);
  assert.ok(fx.concurrentMax > 1, 'the drain must actually run in parallel');
  assert.ok(fx.concurrentMax <= job.concurrency,
    `at most ${job.concurrency} teardowns in flight, saw ${fx.concurrentMax}`);
});

test('progress is broadcast to admins only, and the tally is emitted once', async () => {
  const reap = setup();
  fleet();
  const job = await runSweep(reap);

  assert.ok(fx.adminBroadcasts.length > 5, 'per-unit progress must reach admin sockets');
  for (const b of fx.adminBroadcasts) {
    assert.equal(b.type, 'admin_staging_reap_status');
  }
  const last = fx.adminBroadcasts[fx.adminBroadcasts.length - 1];
  assert.ok(last.job.finishedAt, 'the final broadcast carries the finished job');

  assert.equal(fx.eventRecords.length, 1, 'exactly one durable trace');
  const ev = fx.eventRecords[0];
  assert.equal(ev.type, 'stale_previews_reaped');
  assert.equal(ev.userId, 7);
  assert.equal(ev.metadata.total, 4);
  assert.equal(ev.metadata.tornDown, 4);
  assert.equal(ev.metadata.dbsDropped, 4);
  assert.equal(ev.metadata.failed, 0);
  assert.deepEqual(ev.metadata.byClassification, {
    merged: 1, merged_unlinked: 1, archived: 1, no_session_row: 1,
  });
  assert.ok(typeof ev.metadata.durationMs === 'number');
});

test('an empty host is a clean no-op sweep', async () => {
  const reap = setup();
  const job = await runSweep(reap);
  assert.equal(job.total, 0);
  assert.equal(job.done, 0);
  assert.equal(fx.eventRecords.length, 1, 'still records the (empty) run');
  assert.equal(fx.eventRecords[0].metadata.total, 0);
});

test('staleCount reports the parsed container count', async () => {
  const reap = setup();
  fleet();
  assert.equal(await reap.staleCount(), 5);
});

// ── Staging demo job (request-time demo injection) ───────────────────────

test('the demo job is obviously fake and covers every chip', () => {
  const reap = setup();
  const job = reap.demoJob();
  assert.equal(job.demo, true);
  assert.ok(job.finishedAt, 'a finished job so the section renders a result');
  assert.equal(job.previews.length, job.total);
  for (const p of job.previews) {
    assert.match(p.slug, /^staging-demo-/, 'seeded rows must be unmistakably fake');
    assert.match(p.name, /^usernode-staging-staging-demo-/);
  }
  // One row per kind a sweep takes, plus a failure so the red styling is
  // screenshot-covered. Never a vote-backed one: no sweep takes those.
  const seen = new Set(job.previews.map((p) => p.classification));
  for (const c of ['merged', 'merged_unlinked', 'archived', 'paused', 'no_session_row']) {
    assert.ok(seen.has(c), `demo job must cover the ${c} classification`);
  }
  assert.ok(!job.previews.some((p) => ['promoted', 'merging'].includes(p.classification)));
  assert.ok(job.previews.some((p) => p.outOfDate), 'the "out of date" reason is screenshot-covered');
  const failed = job.previews.filter((p) => p.state === 'failed');
  assert.equal(failed.length, 1);
  assert.ok(failed[0].error, 'the failed row must carry an error string');
  assert.equal(job.failed, 1);
});

test('isStagingEnv gates the demo injection on USERNODE_ENV', () => {
  const reap = setup();
  const saved = process.env.USERNODE_ENV;
  try {
    process.env.USERNODE_ENV = 'staging';
    assert.equal(reap.isStagingEnv(), true);
    process.env.USERNODE_ENV = 'production';
    assert.equal(reap.isStagingEnv(), false);
    delete process.env.USERNODE_ENV;
    assert.equal(reap.isStagingEnv(), false);
  } finally {
    if (saved === undefined) delete process.env.USERNODE_ENV;
    else process.env.USERNODE_ENV = saved;
  }
});

// ── #851: previews built with another platform environment ─────────────
//
// The admin sweep takes one selection (selectReapable): only previews whose
// env fingerprint label does not match the platform's current one, or whose
// session finished, never a preview backing a live vote, never a session
// mid-turn. The automatic passes split it in two: the preview-env clock,
// acting only in the newest build, tells the preview machine about every
// out-of-date preview its row names (staleEnvTargets, tellStaleEnv), and the
// preview-gc clock takes the leftovers whatever their env (leftovers,
// reapLeftover, src/workflow/clock/services.ts).

const realStagingEnv = require('../src/services/staging-env');

// The label a preview built by the platform running these tests would carry.
// Config is `{}` throughout, matching what the sweep passes.
function currentFp() {
  realStagingEnv._resetExpected();
  return realStagingEnv.expectedStagingFingerprint({});
}

// A fleet where each container's label is given explicitly (4th ps column).
function labelledFleet(fp) {
  fx.psLines = [
    // current env, live session — must be left alone
    ['usernode-staging-fresh-aaa111--3001', 'running', 'usernode-staging-fresh-aaa111-3001:aaa111', fp],
    // stale, merged proposal — the bulk of the real fleet
    ['usernode-staging-oldmerged-bbb222--3002', 'running', 'usernode-staging-oldmerged-bbb222-3002:bbb222', 'stale000stale000'],
    // stale and UNLABELLED — every preview built before #851
    ['usernode-staging-prelabel-ccc333--3003', 'running', 'usernode-staging-prelabel-ccc333-3003:ccc333'],
    // stale but backs a live vote — the preview machine rebuilds it
    ['usernode-staging-voting-ddd444--3004', 'running', 'usernode-staging-voting-ddd444-3004:ddd444', 'stale000stale000'],
    // stale, no session row at all
    ['usernode-staging-orphan-eee555--3005', 'running', 'usernode-staging-orphan-eee555-3005:eee555', 'stale000stale000'],
  ];
  fx.sessions = [
    { id: 3001, app_id: 31, status: 'paused', staging_container_id: 'cid-3001', staging_url: 'https://x--s3001--aaa111.example', app_slug: 'fresh-aaa111' },
    { id: 3002, app_id: 32, status: 'merged', staging_container_id: 'cid-3002', staging_url: 'https://x--s3002--bbb222.example', app_slug: 'oldmerged-bbb222' },
    { id: 3003, app_id: 33, status: 'archived', staging_container_id: 'cid-3003', staging_url: 'https://x--s3003--ccc333.example', app_slug: 'prelabel-ccc333' },
    { id: 3004, app_id: 34, status: 'promoted', staging_container_id: 'cid-3004', staging_url: 'https://x--s3004--ddd444.example', app_slug: 'voting-ddd444' },
  ];
}

test('listStagingContainers: parses the fingerprint label column', async () => {
  const reap = setup();
  const fp = currentFp();
  labelledFleet(fp);
  const items = await reap.listStagingContainers();

  assert.equal(items.length, 5);
  assert.equal(items[0].fingerprint, fp, 'a labelled container reports its digest');
  assert.equal(items[2].fingerprint, null, 'a missing label reads as null, not ""');
});

test('selectStale: keeps mismatched + unlabelled, drops current-env previews', async () => {
  const reap = setup();
  const fp = currentFp();
  labelledFleet(fp);
  const items = await reap.classify(fakePool, await reap.listStagingContainers());
  const stale = reap.selectStale(items, fp);
  const names = stale.map((s) => s.slug);

  assert.equal(names.includes('fresh-aaa111'), false, 'current env is not stale');
  assert.ok(names.includes('oldmerged-bbb222'), 'a mismatched digest is stale');
  assert.ok(names.includes('prelabel-ccc333'), 'an unlabelled pre-#851 preview is stale');
  assert.ok(names.includes('orphan-eee555'), 'no session row does not exempt it');
});

test('selectStale: never selects a preview backing a live vote', async () => {
  const reap = setup();
  const fp = currentFp();
  labelledFleet(fp);
  const items = await reap.classify(fakePool, await reap.listStagingContainers());

  for (const status of ['promoted', 'merging']) {
    const patched = items.map((i) => (i.sessionId === 3004
      ? { ...i, session: { ...i.session, status } } : i));
    const names = reap.selectStale(patched, fp).map((s) => s.slug);
    assert.equal(names.includes('voting-ddd444'), false,
      `${status} previews are rebuilt by the preview machine, not torn down here`);
  }
});

test('selectStale: skips a session with a coding turn in flight', async () => {
  const reap = setup();
  const fp = currentFp();
  labelledFleet(fp);
  const items = await reap.classify(fakePool, await reap.listStagingContainers());

  const names = reap.selectStale(items, fp, { isInFlight: (id) => id === 3002 })
    .map((s) => s.slug);
  assert.equal(names.includes('oldmerged-bbb222'), false, 'a live turn is about to replace it anyway');
  assert.ok(names.includes('prelabel-ccc333'), 'other stale previews are unaffected');
});

// A boot runs while the harvest seats the old leader's checks runs
// (services/check-harvest.js), whose capture Jobs run against the session's
// preview. An out-of-date preview of a live session with a run on the
// cluster (a check_runs row: running, waiting for its slot, or left for the
// harvest) was torn down under it.
test('selectStale: skips a preview a checks run on the cluster still uses', async () => {
  const reap = setup();
  const fp = currentFp();
  labelledFleet(fp);
  fx.sessions = fx.sessions.map((s) => (s.id === 3002 ? { ...s, status: 'active', check_run_open: true } : s));
  const items = await reap.classify(fakePool, await reap.listStagingContainers());
  const classified = fx.queries.find((q) => /FROM chat_sessions cs/.test(q.sql));
  assert.match(classified.sql, /EXISTS \(SELECT 1 FROM check_runs cr WHERE cr\.session_id = cs\.id\) AS check_run_open/);

  const names = reap.selectStale(items, fp).map((s) => s.slug);
  assert.equal(names.includes('oldmerged-bbb222'), false, 'its run reads from it');
  assert.ok(names.includes('prelabel-ccc333'), 'other stale previews are unaffected');
  const freed = items.map((i) => (i.sessionId === 3002 ? { ...i, session: { ...i.session, check_run_open: false } } : i));
  assert.ok(reap.selectStale(freed, fp).map((s) => s.slug).includes('oldmerged-bbb222'),
    'once the run has settled, the next pass takes it');

  // The button takes the same selection, so it leaves it too.
  const job = await runSweep(reap);
  assert.equal(fx.teardownCalls.some((c) => c.sessionId === 3002), false, 'the admin sweep leaves it');
  assert.equal(job.total, 2);
});

// ── The preview-env clock: what another environment built ──────────────
//
// staleEnvTargets decides nothing: each preview its row names that another
// env built goes to the preview machine, which rebuilds one under review and
// gives back the rest (and refuses one it is building or checking). Only the
// new build runs it, so an older Pod never judges previews by its own
// fingerprint.

test('staleEnvTargets: every preview its row names that another env built, vote-backed included', async () => {
  const reap = setup();
  const fp = currentFp();
  labelledFleet(fp);

  const out = await reap.staleEnvTargets({});

  assert.equal(out.examined, 5);
  assert.deepEqual(out.stale, [
    { sessionId: 3002, appId: 32, name: 'usernode-staging-oldmerged-bbb222--3002' },
    // Unlabelled: every preview built before #851.
    { sessionId: 3003, appId: 33, name: 'usernode-staging-prelabel-ccc333--3003' },
    // Backs a live vote: the machine rebuilds it in place.
    { sessionId: 3004, appId: 34, name: 'usernode-staging-voting-ddd444--3004' },
  ], 'not the current-env 3001, nor the session-less 3005 (a leftover)');
  // Nothing is torn down from here.
  assert.deepEqual(fx.teardownCalls, []);
  assert.deepEqual(fx.stopCalls, []);
});

test('staleEnvTargets: a preview its row no longer names is not the machine\'s to rebuild', async () => {
  const reap = setup();
  labelledFleet(currentFp());
  fx.sessions = fx.sessions.map((s) => (s.id === 3002 ? { ...s, staging_container_id: null, staging_url: null } : s));

  const out = await reap.staleEnvTargets({});

  assert.deepEqual(out.stale.map((t) => t.sessionId), [3003, 3004]);
});

test('staleEnvTargets: never throws when docker ps fails, and names nothing', async () => {
  const reap = setup();
  fx.psError = new Error('Cannot connect to the Docker daemon');

  assert.deepEqual(await reap.staleEnvTargets({}), { examined: 0, stale: [] });
});

// ── Abandoned previews: the session finished, whatever the env ─────────
//
// Merge and archive tear their own preview down, and the idle reclaim skips
// merged rows because of that, so a merge whose teardown came back busy (or
// never ran) left a preview nothing else would ever look at. In production
// 42 of 98 previews were exactly that, and 20 of those carried the CURRENT
// env, which a fingerprint-only selection never picks.

test('selectAbandoned: takes merged, archived and session-less previews only', async () => {
  const reap = setup();
  const fp = currentFp();
  fx.psLines = ['merged', 'archived', 'active', 'paused', 'promoted', 'merging', 'gone']
    .map((status, i) => [`usernode-staging-${status}-aaa111--${5000 + i}`, 'running', `img:aaa111`, fp]);
  fx.sessions = ['merged', 'archived', 'active', 'paused', 'promoted', 'merging']
    .map((status, i) => ({ id: 5000 + i, status, staging_container_id: `cid-${5000 + i}`, app_slug: status }));
  const items = await reap.classify(fakePool, await reap.listStagingContainers());

  assert.deepEqual(reap.selectAbandoned(items).map((i) => i.sessionId), [5000, 5001, 5006]);
  assert.deepEqual(reap.selectAbandoned(items, { isInFlight: (id) => id === 5000 })
    .map((i) => i.sessionId), [5001, 5006], 'a session mid-turn is left alone here too');
});

// ── The preview-gc clock: previews that serve nobody ────────────────────
//
// leftovers lists them (abandoned, or unlinked and held by no preview
// instance), each a target of its own; reapLeftover reads its row again and
// takes it through reapOne. The env does not matter, so an older build
// running it during a rollout decides nothing differently.

// Drive one preview-gc run the way the clock does: the run, then each
// target as an item of its own. Resolves the run's result and the outcomes.
async function runLeftovers(reap, config = {}) {
  const found = await reap.leftovers(config);
  const outcomes = {};
  for (const item of found.items) outcomes[item.target] = (await reap.reapLeftover(item.input, config)).outcome;
  return { found, outcomes };
}

test('leftovers: abandoned whatever the env, plus what no row names and no instance holds', async () => {
  const reap = setup();
  const fp = currentFp();
  fx.psLines = [
    ['usernode-staging-merged-aaa111--6001', 'running', 'usernode-staging-merged-aaa111-6001:aaa111', fp],
    ['usernode-staging-live-bbb222--6002', 'running', 'usernode-staging-live-bbb222-6002:bbb222', fp],
    ['usernode-staging-oldenv-ccc333--6003', 'running', 'usernode-staging-oldenv-ccc333-6003:ccc333', 'stale000stale000'],
    ['usernode-staging-moved-ddd444--6004', 'running', 'usernode-staging-moved-ddd444-6004:ddd444', fp],
    ['usernode-staging-building-eee555--6005', 'running', 'usernode-staging-building-eee555-6005:eee555', fp],
    ['usernode-staging-voting-fff666--6006', 'running', 'usernode-staging-voting-fff666-6006:fff666', 'stale000stale000'],
  ];
  fx.sessions = [
    { id: 6001, status: 'merged', staging_container_id: 'cid-6001', app_slug: 'merged-aaa111' },
    { id: 6002, status: 'paused', staging_container_id: 'cid-6002', app_slug: 'live-bbb222' },
    // Out of date but serving: the preview-env clock's, not this one.
    { id: 6003, status: 'paused', staging_container_id: 'cid-6003', app_slug: 'oldenv-ccc333' },
    // Its row moved on (a rebuild that replaced it), and nothing holds it.
    { id: 6004, status: 'paused', staging_container_id: null, app_slug: 'moved-ddd444' },
    // Its row does not name it yet: the machine is building this attempt.
    { id: 6005, status: 'active', staging_container_id: null, app_slug: 'building-eee555' },
    { id: 6006, status: 'promoted', staging_container_id: 'cid-6006', app_slug: 'voting-fff666' },
  ];
  fx.held = [6005];

  const { found, outcomes } = await runLeftovers(reap);

  assert.equal(found.examined, 6);
  assert.equal(found.abandoned, 1);
  assert.equal(found.unlinked, 1);
  assert.deepEqual(found.items, [
    { target: 'usernode-staging-merged-aaa111--6001', input: {
      name: 'usernode-staging-merged-aaa111--6001', sessionId: 6001, slug: 'merged-aaa111',
      image: 'usernode-staging-merged-aaa111-6001:aaa111', runtimeKind: 'docker',
    } },
    { target: 'usernode-staging-moved-ddd444--6004', input: {
      name: 'usernode-staging-moved-ddd444--6004', sessionId: 6004, slug: 'moved-ddd444',
      image: 'usernode-staging-moved-ddd444-6004:ddd444', runtimeKind: 'docker',
    } },
  ]);
  assert.deepEqual(outcomes, {
    'usernode-staging-merged-aaa111--6001': 'torn_down',
    'usernode-staging-moved-ddd444--6004': 'torn_down',
  });
  // The merged row still names its preview: the chokepoint. The moved one
  // goes by name, its database read off its image tag.
  assert.deepEqual(fx.teardownCalls.map((c) => c.sessionId), [6001]);
  assert.deepEqual(fx.stopCalls.map((c) => c.name), ['usernode-staging-moved-ddd444--6004']);
  assert.deepEqual(fx.dropCalls, ['app_moved_ddd444_staging_s6004_ddd444']);
});

test('reapLeftover: a session whose row names its preview again is left; a finished one still goes', async () => {
  const reap = setup();
  fx.psLines = [
    ['usernode-staging-moved-ddd444--6004', 'running', 'usernode-staging-moved-ddd444-6004:ddd444'],
    ['usernode-staging-merged-aaa111--6001', 'running', 'usernode-staging-merged-aaa111-6001:aaa111'],
  ];
  fx.sessions = [
    { id: 6004, status: 'paused', staging_container_id: null, app_slug: 'moved-ddd444' },
    { id: 6001, status: 'merged', staging_container_id: 'cid-6001', app_slug: 'merged-aaa111' },
  ];
  const found = await reap.leftovers({});
  assert.deepEqual(found.items.map((i) => i.input.sessionId), [6001, 6004]);

  // Minutes pass between the run and its targets: the session opened again
  // and its row points at the preview once more.
  fx.sessions = fx.sessions.map((s) => (s.id === 6004 ? { ...s, staging_container_id: 'cid-6004' } : s));
  const outcomes = [];
  for (const item of found.items) outcomes.push((await reap.reapLeftover(item.input, {})).outcome);

  assert.deepEqual(outcomes, ['torn_down', 'skipped_linked'], 'it serves again');
  assert.deepEqual(fx.stopCalls, []);
  assert.deepEqual(fx.teardownCalls.map((c) => c.sessionId), [6001]);
});

test('leftovers: a page at a time, by name, so a list longer than a run takes is gone through', async () => {
  const reap = setup();
  fx.psLines = [
    ['usernode-staging-c-ccc333--7003', 'running', 'usernode-staging-c-ccc333-7003:ccc333'],
    ['usernode-staging-a-aaa111--7001', 'running', 'usernode-staging-a-aaa111-7001:aaa111'],
    ['usernode-staging-b-bbb222--7002', 'running', 'usernode-staging-b-bbb222-7002:bbb222'],
  ];
  fx.sessions = [7001, 7002, 7003].map((id) => ({ id, status: 'merged', staging_container_id: `cid-${id}`, app_slug: 'x' }));
  const first = await reap.leftovers({}, { after: null, limit: 2 });
  assert.deepEqual(first.items.map((i) => i.input.sessionId), [7001, 7002]);
  assert.equal(first.after, 'usernode-staging-b-bbb222--7002');
  const second = await reap.leftovers({}, { after: first.after, limit: 2 });
  assert.deepEqual(second.items.map((i) => i.input.sessionId), [7003]);
  assert.equal(second.after, null, 'gone through: the next run starts over');
});

test('reapLeftover: an unlinked preview the machine took up since is the machine\'s', async () => {
  const reap = setup();
  fx.psLines = [['usernode-staging-moved-ddd444--6004', 'running', 'usernode-staging-moved-ddd444-6004:ddd444']];
  fx.sessions = [{ id: 6004, status: 'paused', staging_container_id: null, app_slug: 'moved-ddd444' }];
  const found = await reap.leftovers({});
  assert.equal(found.unlinked, 1);

  fx.held = [6004];
  assert.equal((await reap.reapLeftover(found.items[0].input, {})).outcome, 'skipped_workflow');
  assert.deepEqual(fx.stopCalls, []);
  assert.deepEqual(fx.dropCalls, []);
});

test('reapLeftover: a leaked teardown is a failed target, not a torn-down one', async () => {
  const reap = setup();
  labelledFleet(currentFp());
  fx.teardownLeaks = [3002];

  const { found, outcomes } = await runLeftovers(reap);

  assert.equal(found.abandoned, 3, 'merged 3002, archived 3003, session-less 3005');
  assert.equal(outcomes['usernode-staging-oldmerged-bbb222--3002'], 'failed',
    'a surviving container must not be reported as removed');
  assert.equal(outcomes['usernode-staging-prelabel-ccc333--3003'], 'torn_down');
  assert.equal(outcomes['usernode-staging-orphan-eee555--3005'], 'torn_down');
  // Nothing touched the current-env or vote-backed previews.
  const touched = [...fx.teardownCalls.map((c) => c.sessionId), ...fx.stopCalls.map((c) => c.name)];
  assert.equal(touched.includes(3001), false);
  assert.equal(touched.includes(3004), false);
});

test('leftovers: never throws when docker ps fails, and lists nothing', async () => {
  const reap = setup();
  fx.psError = new Error('Cannot connect to the Docker daemon');

  const found = await reap.leftovers({});

  assert.deepEqual(found, { examined: 0, abandoned: 0, unlinked: 0, items: [], after: null });
  assert.deepEqual(fx.stopCalls, [], 'an unreadable host is a no-op sweep, not a blind one');
  assert.deepEqual(fx.teardownCalls, []);
});

test('the preview-gc clock takes the leftovers, each a target of its own, and 0 switches it off', async () => {
  const reap = setup();
  labelledFleet(currentFp());
  const { JOBS } = require('../src/workflow/clock/services.ts');
  const job = JOBS.find((j) => j.name === 'preview-gc');
  assert.ok(job, 'the preview-gc clock exists');
  assert.equal(job.everyMs, reap.staleSweepIntervalMs(), 'it runs on the stale-sweep interval');
  assert.equal(job.item.concurrency, 3, 'a few teardowns at a time, each failing on its own');

  const found = await job.run({ input: {} }, { config: {}, pool: fakePool });
  assert.deepEqual(found.items.map((i) => i.target), [
    'usernode-staging-oldmerged-bbb222--3002',
    'usernode-staging-orphan-eee555--3005',
    'usernode-staging-prelabel-ccc333--3003',
  ], 'by name: the order the clock pages them in');
  assert.equal(found.after, null, 'one page holds them all');
  // The clock hands each item its target's input as `ctx.input.input`.
  const outcomes = [];
  for (const item of found.items) {
    outcomes.push((await job.item.run({ input: { job: 'preview-gc', target: item.target, input: item.input } },
      { config: {}, pool: fakePool })).outcome);
  }
  assert.deepEqual(outcomes, ['torn_down', 'torn_down', 'torn_down']);

  const saved = process.env.STAGING_STALE_SWEEP_INTERVAL_MS;
  try {
    process.env.STAGING_STALE_SWEEP_INTERVAL_MS = '0';
    fx.dockerExecCalls = 0;
    assert.deepEqual(await job.run({ input: {} }, { config: {}, pool: fakePool }), { off: true });
    assert.equal(fx.dockerExecCalls, 0, 'switched off, it lists nothing');
    assert.equal(job.everyMs, 24 * 60 * 60 * 1000, 'and looks again only to see whether it is still off');
  } finally {
    if (saved === undefined) delete process.env.STAGING_STALE_SWEEP_INTERVAL_MS;
    else process.env.STAGING_STALE_SWEEP_INTERVAL_MS = saved;
  }
});

// ── Kubernetes: the preview Deployments are the inventory ───────────────

const KUBE = Object.freeze({ appRuntime: 'kubernetes', kubernetes: { appNamespace: 'social-apps' } });

function kubeFleet(fp) {
  const preview = (appId, sessionId, fingerprint) => ({
    name: `sv-preview-${appId}-s${sessionId}`,
    appId,
    sessionId,
    state: 'running',
    image: `ghcr.io/example/app@sha256:${'a'.repeat(64)}`,
    labels: fingerprint ? { [realStagingEnv.LABEL_ENV_FP]: fingerprint } : {},
  });
  fx.kubePreviews = [
    preview(320, 3711, fp),            // merged, row still names it
    preview(1559, 4658, fp),           // merged, row nulled by a busy teardown
    preview(10, 4001, fp),             // session row gone
    preview(424, 5806, 'stale000stale000'), // paused, out-of-date env
    preview(409, 5161, fp),            // promoted: backs a live vote
    preview(1967, 5775, fp),           // active, current
    preview(847, 5080, fp),            // archived, but a turn is in flight
  ];
  const linked = (id, status, appSlug) => ({
    id, status, app_slug: appSlug, staging_container_id: null,
    staging_runtime_kind: 'kubernetes', staging_runtime_name: fx.kubePreviews.find((p) => p.sessionId === id).name,
    staging_url: `https://${appSlug}--s${id}.example`, staging_commit_sha: 'abc123',
  });
  fx.sessions = [
    linked(3711, 'merged', 'puzzlechain-6cf8ff'),
    { id: 4658, status: 'merged', app_slug: 'patch-741877', staging_container_id: null,
      staging_runtime_kind: null, staging_runtime_name: null, staging_url: null },
    linked(5806, 'paused', 'recipebot-33b169'),
    linked(5161, 'promoted', 'gym-tracker-9de81f'),
    linked(5775, 'active', 'trading-journal-13ee34'),
    linked(5080, 'archived', 'my-cool-app-460fe8'),
  ];
}

test('Kubernetes: a row names its preview by runtime name, and the slug comes from the app', async () => {
  const reap = setup();
  kubeFleet(currentFp());
  const items = await reap.classify(fakePool, await reap.listPreviews(KUBE));
  const byName = Object.fromEntries(items.map((i) => [i.name, i]));

  assert.equal(byName['sv-preview-320-s3711'].classification, 'merged',
    'staging_container_id is null on Kubernetes; the runtime name is the link');
  assert.equal(byName['sv-preview-1559-s4658'].classification, 'merged_unlinked');
  assert.equal(byName['sv-preview-10-s4001'].classification, 'no_session_row');
  assert.equal(byName['sv-preview-320-s3711'].slug, 'puzzlechain-6cf8ff');
  assert.equal(byName['sv-preview-10-s4001'].slug, null, 'nothing to read it from');
  assert.equal(byName['sv-preview-424-s5806'].fingerprint, 'stale000stale000');
  assert.equal(fx.dockerExecCalls, 0, 'Kubernetes never probes the Docker socket');
  assert.equal(fx.kubeListCalls[0].kubernetes.appNamespace, 'social-apps');
});

test('Kubernetes: the preview-gc clock takes abandoned previews, whatever their env', async () => {
  const reap = setup();
  kubeFleet(currentFp());

  const { found, outcomes } = await runLeftovers(reap, KUBE);

  // The out-of-date 5806 serves a paused session: the preview-env clock
  // hands it to the machine. A turn in flight on the archived 5080 is
  // the machine's to refuse (staging.teardownStaging reports it busy), so it
  // is a target here like any other leftover.
  assert.deepEqual({ examined: found.examined, abandoned: found.abandoned, unlinked: found.unlinked },
    { examined: 7, abandoned: 4, unlinked: 0 });
  assert.deepEqual(Object.values(outcomes).sort(), ['torn_down', 'torn_down', 'torn_down_no_db', 'torn_down_no_db']);
  // Rows that still name their Deployment go through the shared chokepoint,
  // which also drops the staging database and nulls the row.
  assert.deepEqual(fx.teardownCalls.map((c) => c.sessionId).sort((a, b) => a - b), [3711, 5080]);
  // The rest are removed by name, in the app namespace.
  assert.deepEqual(fx.kubeRemoveCalls.map((c) => c.name).sort(), ['sv-preview-10-s4001', 'sv-preview-1559-s4658']);
  for (const call of fx.kubeRemoveCalls) {
    assert.equal(call.kind, 'kubernetes');
    assert.equal(call.namespace, 'social-apps');
  }
  // A digest-addressed image names no commit, so no database name is guessed;
  // the orphan-database pass takes those clones.
  assert.deepEqual(fx.dropCalls, []);
  assert.equal(fx.dockerExecCalls, 0);
  assert.deepEqual(fx.stopCalls, []);
});

test('Kubernetes: the release names the out-of-date previews its rows name, with their apps', async () => {
  const reap = setup();
  kubeFleet(currentFp());

  const out = await reap.staleEnvTargets(KUBE);

  assert.deepEqual(out.stale, [{ sessionId: 5806, appId: null, name: 'sv-preview-424-s5806' }]);
  fx.sessions = fx.sessions.map((s) => (s.id === 5806 ? { ...s, app_id: 424 } : s));
  assert.deepEqual((await reap.staleEnvTargets(KUBE)).stale, [{ sessionId: 5806, appId: 424, name: 'sv-preview-424-s5806' }],
    'the machine instance is keyed by its app');
});

test('Kubernetes: a Deployment already gone is skipped, not removed', async () => {
  const reap = setup();
  kubeFleet(currentFp());
  fx.kubeExists = (name) => name !== 'sv-preview-10-s4001';

  const { outcomes } = await runLeftovers(reap, KUBE);

  assert.equal(outcomes['sv-preview-10-s4001'], 'skipped_gone');
  assert.equal(fx.kubeRemoveCalls.some((c) => c.name === 'sv-preview-10-s4001'), false);
});

test('Kubernetes: a failed removal is isolated to its own target', async () => {
  const reap = setup();
  kubeFleet(currentFp());
  fx.kubeRemoveError = new Error('deployments.apps "sv-preview-10-s4001" is forbidden');

  const { outcomes } = await runLeftovers(reap, KUBE);

  assert.equal(outcomes['sv-preview-10-s4001'], 'failed', 'both by-name removals failed');
  assert.equal(outcomes['sv-preview-1559-s4658'], 'failed');
  assert.equal(outcomes['sv-preview-320-s3711'], 'torn_down', 'the chokepoint teardowns still ran');
  assert.equal(outcomes['sv-preview-847-s5080'], 'torn_down');
});

test('Kubernetes: an unreadable API is a no-op sweep, not a blind one', async () => {
  const reap = setup();
  fx.kubeListError = new Error('connect ECONNREFUSED');

  assert.deepEqual(await reap.leftovers(KUBE), { examined: 0, abandoned: 0, unlinked: 0, items: [], after: null });
  assert.deepEqual(await reap.staleEnvTargets(KUBE), { examined: 0, stale: [] });
  assert.deepEqual(fx.kubeRemoveCalls, []);
  assert.deepEqual(fx.teardownCalls, []);
});

test('Kubernetes: the admin sweep takes everything due at once, nothing more', async () => {
  const reap = setup();
  kubeFleet(currentFp());
  fx.working = [5080];
  const job = await runSweep(reap, KUBE);

  assert.equal(job.total, 4, 'abandoned + out of date, uncapped');
  assert.equal(job.failed, 0);
  const taken = job.previews.map((p) => p.sessionId).sort((a, b) => a - b);
  assert.deepEqual(taken, [3711, 4001, 4658, 5806],
    'not the vote-backed 5161, the live current 5775, or the in-flight 5080');
  assert.deepEqual(job.previews.filter((p) => p.outOfDate).map((p) => p.sessionId), [5806],
    'a live session\'s row says why it was taken');
  assert.equal(fx.dockerExecCalls, 0);
});

test('Kubernetes: the admin sweep leaves a session another process works on, as its durable records say', async () => {
  const reap = setup();
  kubeFleet(currentFp());
  // Not in this process's memory: a turn or an operation elsewhere
  // (session-work.ts workedOnSql), read once for the pass.
  fx.working = [5080];
  const job = await runSweep(reap, KUBE);
  const taken = job.previews.map((p) => p.sessionId).sort((a, b) => a - b);
  assert.deepEqual(taken, [3711, 4001, 4658, 5806], 'not the session worked on elsewhere');
  const busyRead = fx.queries.find((q) => /cs\.id = ANY\(\$1::int\[\]\) AND \(cs\.active_turn IS NOT NULL/.test(q.sql));
  assert.ok(busyRead && busyRead.params[0].includes(5080));
});

test('Kubernetes: the console counts come from the Deployments', async () => {
  const reap = setup();
  kubeFleet(currentFp());

  const counts = await reap.previewCounts(KUBE);

  assert.deepEqual(counts, { open: 7, stale: 1, abandoned: 4 });
});

test('inventory: an all-unlabelled fleet is verified by inspect before it is used', async () => {
  // The dangerous false positive: a docker that cannot answer {{.Label}} makes
  // EVERY container look out of date, which would have the release rebuild or
  // give back the whole fleet. When an inspect proves the labels are really
  // there, the inventory reads them with inspect instead.
  const reap = setup();
  const fp = currentFp();
  fx.psLines = [
    ['usernode-staging-a-aaa111--4001', 'running', 'img:aaa111'],
    ['usernode-staging-b-bbb222--4002', 'running', 'img:bbb222'],
  ];
  fx.sessions = [
    // Live sessions, so only the env decides (a merged one would go anyway).
    { id: 4001, status: 'paused', staging_container_id: 'cid-4001', staging_url: 'https://x--s4001--aaa111.example', app_slug: 'a-aaa111' },
    { id: 4002, status: 'paused', staging_container_id: 'cid-4002', staging_url: 'https://x--s4002--bbb222.example', app_slug: 'b-bbb222' },
  ];
  // Inspect can see the labels the ps format verb could not: 4001 is current.
  fx.inspect = (name) => ({
    status: 'running',
    labels: { [realStagingEnv.LABEL_ENV_FP]: name.includes('-a-') ? fp : 'stale000stale000' },
  });

  const items = await reap.inventory({});
  assert.ok(fx.inspectCalls.length >= 1, 'the all-null reading is probed, not trusted');
  assert.deepEqual(items.map((i) => i.fingerprint), [fp, 'stale000stale000']);
  assert.deepEqual((await reap.staleEnvTargets({})).stale.map((t) => t.sessionId), [4002],
    'only the genuinely stale one is named');
});

test('inventory: an all-unlabelled fleet with no labels anywhere IS out of date', async () => {
  // The other side of the guard: when the probe agrees there is no label, the
  // containers really do predate the fingerprint.
  const reap = setup();
  fx.psLines = [['usernode-staging-old-aaa111--4101', 'running', 'img:aaa111']];
  fx.sessions = [{ id: 4101, status: 'paused', staging_container_id: 'cid-4101', app_slug: 'old-aaa111' }];
  fx.inspect = () => ({ status: 'running', labels: {} });

  assert.deepEqual((await reap.inventory({})).map((i) => i.fingerprint), [null]);
  assert.deepEqual((await reap.staleEnvTargets({})).stale.map((t) => t.sessionId), [4101]);
});

test('the automatic passes refuse to run inside a staging preview', async () => {
  const reap = setup();
  labelledFleet(currentFp());
  const saved = process.env.USERNODE_ENV;
  try {
    process.env.USERNODE_ENV = 'staging';
    assert.deepEqual(await reap.leftovers({}), { examined: 0, abandoned: 0, unlinked: 0, items: [], after: null },
      'a preview has no docker socket to sweep with');
    assert.deepEqual(await reap.staleEnvTargets({}), { examined: 0, stale: [] });
    assert.equal(fx.dockerExecCalls, 0);
    assert.deepEqual(fx.stopCalls, []);
  } finally {
    if (saved === undefined) delete process.env.USERNODE_ENV;
    else process.env.USERNODE_ENV = saved;
  }
});

test('staleSweepIntervalMs: 0 disables, junk falls back to the default', () => {
  const reap = setup();
  const saved = process.env.STAGING_STALE_SWEEP_INTERVAL_MS;
  try {
    process.env.STAGING_STALE_SWEEP_INTERVAL_MS = '0';
    assert.equal(reap.staleSweepIntervalMs(), 0, 'an explicit 0 is a kill switch, not junk');
    process.env.STAGING_STALE_SWEEP_INTERVAL_MS = 'banana';
    assert.equal(reap.staleSweepIntervalMs(), 15 * 60 * 1000);
    process.env.STAGING_STALE_SWEEP_INTERVAL_MS = '60000';
    assert.equal(reap.staleSweepIntervalMs(), 60000);
  } finally {
    if (saved === undefined) delete process.env.STAGING_STALE_SWEEP_INTERVAL_MS;
    else process.env.STAGING_STALE_SWEEP_INTERVAL_MS = saved;
  }
});

test('previewCounts: open counts everything, stale counts the out-of-date subset', async () => {
  const reap = setup();
  const fp = currentFp();
  labelledFleet(fp);

  const counts = await reap.previewCounts({});
  assert.equal(counts.open, 5, 'what the admin button would shut down');
  assert.equal(counts.stale, 3, 'what the automatic pass would shut down');
});

test('previewCounts: nulls (not zeros) when docker cannot be read', async () => {
  const reap = setup();
  fx.psError = new Error('daemon unreachable');
  const counts = await reap.previewCounts({});
  // A bogus 0 would read as "all clear" on the console; "—" is honest.
  assert.deepEqual(counts, { open: 0, stale: 0, abandoned: 0 });
});

test('demoCounts: fake-but-complete numbers for the staging screenshot', () => {
  const reap = setup();
  const demo = reap.demoCounts();
  assert.equal(demo.open, 9);
  assert.equal(demo.stale, 4);
  assert.equal(demo.abandoned, 2);
  assert.equal(demo.stale + demo.abandoned, reap.demoJob().total, 'the tile matches the demo job');
  assert.ok(demo.automatic.lastRunAt, 'the "last ran" line needs a timestamp to render');
  assert.ok(demo.automatic.intervalMs > 0);
  assert.match(demo.expectedFingerprint, /^stagingdemo/, 'obviously fake, per the seed rules');
});

test('previewCounts: open counts everything, stale counts the out-of-date subset', async () => {
  const reap = setup();
  const fp = currentFp();
  labelledFleet(fp);

  const counts = await reap.previewCounts({});
  assert.equal(counts.open, 5, 'what the admin button would shut down');
  assert.equal(counts.stale, 3, 'what the automatic pass would shut down');
});

test('previewCounts: nulls (not zeros) when docker cannot be read', async () => {
  const reap = setup();
  fx.psError = new Error('daemon unreachable');
  const counts = await reap.previewCounts({});
  // A bogus 0 would read as "all clear" on the console; "—" is honest.
  assert.deepEqual(counts, { open: 0, stale: 0, abandoned: 0 });
});

test('demoCounts: fake-but-complete numbers for the staging screenshot', () => {
  const reap = setup();
  const demo = reap.demoCounts();
  assert.equal(demo.open, 9);
  assert.equal(demo.stale, 4);
  assert.equal(demo.abandoned, 2);
  assert.equal(demo.stale + demo.abandoned, reap.demoJob().total, 'the tile matches the demo job');
  assert.ok(demo.automatic.lastRunAt, 'the "last ran" line needs a timestamp to render');
  assert.ok(demo.automatic.intervalMs > 0);
  assert.match(demo.expectedFingerprint, /^stagingdemo/, 'obviously fake, per the seed rules');
});
