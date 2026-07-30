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
  reap: require.resolve('../src/services/staging-reap'),
};

let fx;

function freshFixtures() {
  return {
    // docker ps output lines: [name, state, image]
    psLines: [],
    psError: null,
    exists: () => true,
    existsCalls: [],
    stopCalls: [],
    stopError: null,
    // staging
    teardownCalls: [],
    teardownError: null,
    // db-manager
    dropCalls: [],
    dropError: null,
    // pool
    sessions: [],
    queries: [],
    // ws / events
    adminBroadcasts: [],
    eventRecords: [],
    // concurrency observation
    concurrentNow: 0,
    concurrentMax: 0,
    unitDelayMs: 0,
  };
}

const fakePool = {
  async query(sql, params = []) {
    fx.queries.push({ sql, params });
    if (/FROM chat_sessions/.test(sql)) {
      const ids_ = params[0] || [];
      return { rows: fx.sessions.filter((s) => ids_.includes(s.id)) };
    }
    return { rows: [], rowCount: 1 };
  },
};

function sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }

function installStubs() {
  stub(ids.logger, { info() {}, warn() {}, error() {}, debug() {} });
  stub(ids.docker, {
    STAGING_STOP_GRACE_SEC: 2,
    async execFileAsync(_bin, args) {
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
    async stopAndRemove(name, opts) {
      fx.stopCalls.push({ name, opts });
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
      fx.concurrentNow += 1;
      fx.concurrentMax = Math.max(fx.concurrentMax, fx.concurrentNow);
      try {
        if (fx.unitDelayMs) await sleep(fx.unitDelayMs);
        if (fx.teardownError) throw fx.teardownError;
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
}

function loadReap() {
  delete require.cache[ids.reap];
  return require(ids.reap);
}

function setup() {
  fx = freshFixtures();
  installStubs();
  const reap = loadReap();
  reap._reset();
  return reap;
}

// Drive one full sweep and resolve with the finished job snapshot.
async function runSweep(reap, opts = {}) {
  const res = reap.start({}, { userId: 7, username: 'admin-user', ...opts });
  assert.equal(res.started, true, 'the sweep must start');
  for (let i = 0; i < 400; i++) {
    const job = reap.read();
    if (job && job.finishedAt) return job;
    await sleep(5);
  }
  throw new Error('sweep did not finish');
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
  const job = await runSweep(reap);

  assert.equal(job.total, 5, 'all five groups must be picked up, not just the linked ones');
  assert.deepEqual(classifications(job), {
    'usernode-staging-community-tier-lists-57ce6a--2549': 'merged',
    'usernode-staging-whiteboard-0d337f--2458': 'merged_unlinked',
    'usernode-staging-guardian-2-99eba3--2472': 'archived',
    'usernode-staging-usernode-2d5619--2795': 'promoted',
    'usernode-staging-veya-afaeaa--1212': 'no_session_row',
  });
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

  // Chokepoint path: the three sessions whose row still names the container.
  assert.deepEqual(
    fx.teardownCalls.map((c) => c.sessionId).sort((a, b) => a - b),
    [2472, 2549, 2795]
  );
  // teardownStaging derives the staging DB name from staging_url itself, so
  // the sweep must NOT also drop a database for those.
  assert.deepEqual(
    fx.teardownCalls.map((c) => c.slug).sort(),
    ['community-tier-lists-57ce6a', 'guardian-2-99eba3', 'usernode-2d5619']
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

  assert.equal(job.total, 5);
  assert.equal(job.done, 5, 'every unit is still attempted');
  assert.equal(job.failed, 3, 'the three chokepoint units fail');
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

test('a second start while a sweep is live returns the in-flight job', async () => {
  const reap = setup();
  fleet();
  fx.unitDelayMs = 30;
  const first = reap.start({}, { username: 'admin-user' });
  assert.equal(first.started, true);
  const second = reap.start({}, { username: 'someone-else' });
  assert.equal(second.started, false, 'the route turns this into a 409');
  assert.equal(second.job.id, first.job.id);
  for (let i = 0; i < 400 && !(reap.read() || {}).finishedAt; i++) await sleep(5);
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
  assert.equal(ev.metadata.total, 5);
  assert.equal(ev.metadata.tornDown, 5);
  assert.equal(ev.metadata.dbsDropped, 5);
  assert.equal(ev.metadata.failed, 0);
  assert.deepEqual(ev.metadata.byClassification, {
    merged: 1, merged_unlinked: 1, archived: 1, promoted: 1, no_session_row: 1,
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
  // One row per classification the console can label, plus a failure so the
  // red styling is screenshot-covered.
  const seen = new Set(job.previews.map((p) => p.classification));
  for (const c of ['merged', 'merged_unlinked', 'archived', 'promoted', 'no_session_row']) {
    assert.ok(seen.has(c), `demo job must cover the ${c} classification`);
  }
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
