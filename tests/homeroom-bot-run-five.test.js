'use strict';

// Newcomer test "run five" (13 Oct 2026, app Club Votes): Submit to spec took
// 46 s. Submit published its wake (goAhead), but a live build was started
// only inside a pass's dispatch, after the pass's refresh, and every
// REFRESH_INTERVAL_MS that refresh is the full sweep of every app; a wake
// cannot cut into a pass that is running. These pin what changed:
//
//   - a pass starts the builds waiting their turn before its refresh and
//     sweeps (dispatchLiveBuilds at the top of runOnce);
//   - Build it's wake starts its build on the leader at once, even while a
//     pass runs (goAhead publishes { appId, buildRunId }; onBusMessage);
//   - the two paths never start one run twice;
//   - get_homeroom_bot carries the live loop's own last pass, beside the
//     shadow lane's that run five first read as it.
//
// Run with: node --test tests/homeroom-bot-run-five.test.js

const test = require('node:test');
const assert = require('node:assert/strict');

const bot = require('../src/services/homeroom-bot');
const connectorData = require('../src/services/bench/connector-data');

const SETTINGS = [
  { key: bot.KEY_MODE, value: 'shadow' },
  { key: bot.KEY_PER_PERSON, value: '3' },
  { key: bot.KEY_LIVE_AT_ONCE, value: '8' },
];
const APPS = [{ id: 101, slug: 'club-votes', name: 'Club Votes', repo_url: 'https://github.com/o/club-votes', self_hosted: false }];
const waitingBuild = (id, appId, issueNumber, personId) => ({
  id, app_id: appId, issue_number: issueNumber, build_note: 'build it', person_id: personId,
  live_build_waiting_at: new Date(Date.now() - 1000).toISOString(),
});

/** A pool that answers the loop's queries, with live builds waiting. */
function loopPool({ waiting = [], candidatesGate = null } = {}) {
  const log = [];
  const client = {
    async query(sql) {
      if (/pg_try_advisory_lock/.test(sql)) return { rows: [{ acquired: true }] };
      return { rows: [] };
    },
    release() {},
  };
  return {
    log,
    async connect() { return client; },
    async query(sql, params) {
      const s = String(sql);
      log.push({ s, params });
      if (/SELECT key, value FROM platform_settings/.test(s)) return { rows: SETTINGS };
      if (/FROM users WHERE username = \$1/.test(s)) return { rows: [{ id: 77, username: 'homeroom_bot', weekly_limit_cents: 15000 }] };
      if (/SELECT is_synthetic FROM users/.test(s)) return { rows: [{ is_synthetic: true }] };
      if (/WHERE r\.live_build_waiting_at IS NOT NULL AND r\.mode = 'live'/.test(s)) {
        if (candidatesGate) await candidatesGate();
        return { rows: waiting };
      }
      if (/FROM apps WHERE id = ANY\(\$1::int\[\]\)/.test(s)) return { rows: APPS.filter((a) => params[0].includes(a.id)) };
      return { rows: [] };
    },
  };
}

/** The deps a build needs to reach its first GitHub read, held there. */
function buildDeps({ gate, reads, sweep = null }) {
  return {
    drain: false,
    github: {
      isEnabled: () => true,
      async fetchPublicIssues() { return { issues: [] }; },
      // Where a build is once it has its slot: reading its request, which it
      // then finds closed.
      async fetchPublicIssue(_o, _r, n) { reads.push(n); await gate; return { issue: { state: 'closed' } }; },
    },
    limits: { async checkBudget() { return { ok: true }; } },
    worker: { async listWorkerVolumes() { return []; } },
    dm: {
      async overWeeklyAllowance() { return false; },
      async requesterOf() { return null; },
      ...(sweep ? { sweepFirstVersions: sweep } : {}),
    },
  };
}

const settle = (ms = 10) => new Promise((r) => setTimeout(r, ms));

test('a waiting live build takes its slot even while the pass\'s sweep never ends', async () => {
  bot._resetForTests();
  let release;
  const gate = new Promise((r) => { release = r; });
  const reads = [];
  const pool = loopPool({ waiting: [waitingBuild(900, 101, 3, 7)] });
  // The full sweep every REFRESH_INTERVAL_MS starts with the first-version
  // sweep; here it never resolves, as a slow refresh of every app might not
  // for a long time.
  let swept = false;
  const deps = buildDeps({ gate, reads, sweep: () => { swept = true; return new Promise(() => {}); } });
  const pass = bot.runOnce(pool, {}, deps);
  let passEnded = false;
  pass.then(() => { passEnded = true; });
  await settle();
  assert.equal(swept, true, 'the pass is in its sweep');
  assert.equal(passEnded, false, 'and the sweep has not ended');
  assert.deepEqual(bot._inFlightForTests().map((e) => [e.runId, e.build, e.lane]), [[900, true, 'live']],
    'the build waiting its turn already has its slot');
  assert.deepEqual(reads, [3], 'and has started');
  release();
  await settle(20);
  bot._resetForTests();
});

test('Build it\'s bus message starts its build on the leader while a pass is in flight', async () => {
  bot._resetForTests();
  let release;
  const gate = new Promise((r) => { release = r; });
  const reads = [];
  const pool = loopPool({ waiting: [waitingBuild(900, 101, 3, 7)] });
  bot._armForTests({}, { pool, deps: buildDeps({ gate, reads }) });
  // A pass is running (its sweep, say): a plain wake only queues the next.
  bot._setPassInFlightForTests(true);
  try {
    assert.equal(bot.onBusMessage({ appId: 101, buildRunId: 900 }), true);
    const started = await bot._awaitLiveKickForTests();
    assert.equal(started.length, 1);
    assert.deepEqual(bot._inFlightForTests().map((e) => [e.runId, e.build]), [[900, true]]);
    await settle();
    assert.deepEqual(reads, [3], 'the build started without waiting for the pass');
    assert.deepEqual(bot._pendingForTests().apps, [101], 'and its app is still read on the next pass');
  } finally {
    release();
    await settle(20);
    bot._resetForTests();
  }
});

test('a Pod that does not run the loop starts nothing on Build it\'s bus message', () => {
  bot._resetForTests();
  assert.equal(bot.onBusMessage({ appId: 101, buildRunId: 900 }), false);
  assert.equal(bot.wakeLiveBuilds(), false);
  assert.deepEqual(bot._inFlightForTests(), []);
});

test('goAhead on the leader starts the build itself, and tells the other Pods which run', async () => {
  bot._resetForTests();
  const wsBus = require('../src/services/ws-bus');
  const published = [];
  const realPublish = wsBus.publish;
  wsBus.publish = (kind, routing, data) => { published.push({ kind, routing, data }); };
  let release;
  const gate = new Promise((r) => { release = r; });
  const reads = [];
  const loop = loopPool({ waiting: [waitingBuild(1746, 101, 3, 7)] });
  bot._armForTests({}, { pool: loop, deps: buildDeps({ gate, reads }) });
  const pool = {
    async query(sql) {
      if (/^\s*SELECT plan FROM homeroom_bot_runs/.test(String(sql))) return { rows: [{ plan: { bullets: ['Polls'], questions: [] } }] };
      if (/UPDATE homeroom_bot_runs/.test(String(sql))) return { rows: [{ app_id: 101, issue_number: 3 }] };
      throw new Error(`unexpected query: ${sql}`);
    },
  };
  try {
    assert.equal((await bot.goAhead(pool, { runId: 1746 })).ok, true);
    assert.deepEqual(published.map((p) => p.data), [{ appId: 101, buildRunId: 1746 }]);
    await bot._awaitLiveKickForTests();
    assert.deepEqual(bot._inFlightForTests().map((e) => e.runId), [1746]);
  } finally {
    wsBus.publish = realPublish;
    release();
    await settle(20);
    bot._resetForTests();
  }
});

test('the pass and Build it\'s wake dispatching at the same moment start the run once', async () => {
  bot._resetForTests();
  let release;
  const gate = new Promise((r) => { release = r; });
  const reads = [];
  // Every read of the waiting builds waits a moment, so the two dispatches
  // overlap: both would read run 900 as waiting.
  const pool = loopPool({ waiting: [waitingBuild(900, 101, 31, 7)], candidatesGate: () => settle(5) });
  const deps = buildDeps({ gate, reads });
  bot._armForTests({}, { pool, deps });
  try {
    const pass = bot.runOnce(pool, {}, deps);
    assert.equal(bot.wakeLiveBuilds(), true);
    const [out, kicked] = await Promise.all([pass, bot._awaitLiveKickForTests()]);
    assert.equal(out.dispatched + kicked.length, 1, 'one build between them');
    await settle();
    assert.deepEqual(reads, [31], 'one build of the run, not two');
    assert.deepEqual(bot._inFlightForTests().map((e) => e.runId), [900]);
    // And two dispatches called together: the second waits for the first
    // and starts nothing of its own.
    const [a, b] = await Promise.all([
      bot.dispatchLiveBuilds(pool, {}, { deps }), bot.dispatchLiveBuilds(pool, {}, { deps }),
    ]);
    assert.deepEqual([a.length, b.length], [0, 0], 'its slot is taken until that build ends');
  } finally {
    release();
    await settle(20);
    bot._resetForTests();
  }
  // Once it ends, a run still waiting is picked again: nothing is held for good.
  const again = bot.dispatchLiveBuilds(loopPool({ waiting: [waitingBuild(901, 101, 32, 7)] }), {}, {
    deps: buildDeps({ gate: Promise.resolve(), reads }),
  });
  assert.equal((await again).length, 1);
  await settle(20);
  bot._resetForTests();
});

test('a pass records when it began and how long it took', async () => {
  bot._resetForTests();
  const reads = [];
  const pool = loopPool({ waiting: [] });
  const out = await bot.runOnce(pool, {}, buildDeps({ gate: Promise.resolve(), reads }));
  assert.equal(out.liveBuilds, 0);
  const src = require('node:fs').readFileSync(require.resolve('../src/services/homeroom-bot'), 'utf8');
  assert.match(src, /lastPass = \{ at: new Date\(\)\.toISOString\(\), startedAt: new Date\(startedAt\)\.toISOString\(\), ms: Date\.now\(\) - startedAt, \.\.\.out \};/);
  // The go-ahead's time survives the build starting: live_build_waiting_at
  // is cleared then, so "Live build started" says how long it waited.
  assert.match(src, /log\.info\('homeroom-bot', 'Live build started', \{[\s\S]{0,200}waitedMs:/);
  bot._resetForTests();
});

test('get_homeroom_bot carries the live loop\'s own last pass beside the shadow lane\'s', async () => {
  const payload = {
    settings: {}, bot: null, totals: {}, queue: { depth: 0, items: [] },
    loop: {
      at: '2026-10-13T13:46:09Z', startedAt: '2026-10-13T13:45:15Z', ms: 54000, refreshed: true,
      liveBuilds: 1, dispatched: 2, paused: null, runningSince: '2026-10-13T13:50:15Z', processed: 0,
    },
    builds: {
      queued: 0, building: 0, live: { building: 1, waiting: 0 },
      lane: { at: '2026-10-13T13:46:00Z', started: 0, inFlight: 0, paused: 'off' },
    },
    runs: [],
  };
  const out = await connectorData.botOverview(null, {}, {}, { bot: { async adminPayload() { return payload; } } });
  assert.deepEqual(out.buildLane.live, {
    building: 1, waiting: 0,
    lastPass: {
      startedAt: '2026-10-13T13:45:15Z', at: '2026-10-13T13:46:09Z', ms: 54000,
      refreshed: true, liveBuilds: 1, dispatched: 2, paused: null,
    },
    passRunningSince: '2026-10-13T13:50:15Z',
  });
  assert.equal(out.buildLane.lastPass.at, '2026-10-13T13:46:00Z', 'the shadow lane\'s pass is still its own');
});
