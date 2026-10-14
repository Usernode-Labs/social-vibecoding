'use strict';

// src/services/leader-timers.js: the leader's timers stop at shutdown, and a
// long-interval sweep keeps its clock across elections.
//
// Two production faults, one per half of the file:
//
//   - Through the whole shutdown drain the eligible-merge sweep, the drift
//     poller, app-heal, main-watch and the rest kept firing, because
//     cleanup() cleared only the few handles server.js held. A leader timer
//     skips every tick once shutdown has begun, stopAll() clears it, and a
//     tick already running is held where the drain waits for it.
//   - An hourly setInterval restarts its clock at every election, and the
//     leader changes with every release (every twenty minutes or so on a
//     busy day), so the stale-proposal sweep, the Workshop theme sweep and
//     the grant prune almost never ran. A durable timer reads its last
//     completed run from leader_sweeps and runs when that says it is due.
//
// The clock is node:test's mock (setTimeout, setInterval and Date), and the
// pool is a stand-in that answers the module's two statements the way
// Postgres would against that clock; tests/leader-sweeps-postgres.test.js
// runs the same SQL against a real database.
//
// Run with: node --test tests/leader-timers.test.js

const test = require('node:test');
const assert = require('node:assert/strict');

const timers = require('../src/services/leader-timers');
const inflight = require('../src/services/inflight-work');
const lifecycle = require('../src/services/lifecycle');
const log = require('../src/services/logger');

const logs = [];
for (const level of ['info', 'warn', 'error', 'debug']) {
  log[level] = (cat, msg, data) => { logs.push({ level, cat, msg, data }); };
}

const MIN = 60 * 1000;
const HOUR = 60 * MIN;
const realSetImmediate = setImmediate;
const flush = async () => { for (let i = 0; i < 5; i += 1) await new Promise((r) => realSetImmediate(r)); };

// The leader_sweeps table, kept in memory, on the mocked Date.
function fakeSweepsPool({ failRead = false } = {}) {
  const rows = new Map();
  const writes = [];
  return {
    rows,
    writes,
    async query(sql, params) {
      if (/^\s*SELECT/.test(sql)) {
        if (failRead) throw new Error('relation "leader_sweeps" does not exist');
        const [name, intervalMs] = params;
        if (!rows.has(name)) return { rows: [] };
        const due = Math.max(0, rows.get(name) + Number(intervalMs) - Date.now());
        return { rows: [{ due_in_ms: String(due) }] };
      }
      if (/INSERT INTO leader_sweeps/.test(sql)) {
        rows.set(params[0], Date.now());
        writes.push({ name: params[0], at: Date.now() });
        return { rows: [] };
      }
      throw new Error(`unexpected SQL: ${sql}`);
    },
  };
}

function useClock(t, now = Date.UTC(2026, 9, 14, 9, 0, 0)) {
  t.mock.timers.enable({ apis: ['setTimeout', 'setInterval', 'Date'], now });
  t.after(() => timers.stopAll());
}

async function advance(t, ms, step = MIN) {
  for (let left = ms; left > 0; left -= step) {
    t.mock.timers.tick(Math.min(step, left));
    await flush();
  }
}

test('a plain timer runs after its first delay, then every interval, and is unique by name', async (t) => {
  useClock(t);
  let runs = 0;
  timers.every('title-heal', () => { runs += 1; }, 10 * MIN, { firstDelayMs: 90 * 1000 });
  // A second start of the same name is the old `if (timer) return` guard.
  timers.every('title-heal', () => { runs += 100; }, MIN);
  await advance(t, 89 * 1000, 1000);
  assert.equal(runs, 0);
  await advance(t, 1000, 1000);
  assert.equal(runs, 1, 'the early first pass');
  await advance(t, 10 * MIN);
  assert.equal(runs, 2, 'then the interval');
  assert.deepEqual(timers.snapshot().map((e) => e.name), ['title-heal']);
});

test('no first delay means no first run, exactly like setInterval', async (t) => {
  useClock(t);
  let runs = 0;
  timers.every('eligible-merge-sweep', () => { runs += 1; }, 4 * MIN);
  await advance(t, 4 * MIN - 1000, 1000);
  assert.equal(runs, 0);
  await advance(t, 1000, 1000);
  assert.equal(runs, 1);
});

test('a tick under way is held in the in-flight registry until it settles', async (t) => {
  useClock(t);
  let finish;
  timers.every('merge-followups', () => new Promise((resolve) => { finish = resolve; }), MIN);
  await advance(t, MIN);
  assert.deepEqual(inflight.snapshot().map((e) => e.name), ['timer:merge-followups']);
  finish();
  await flush();
  assert.equal(inflight.size(), 0);
});

test('a tick that throws is logged and the timer carries on', async (t) => {
  useClock(t);
  logs.length = 0;
  let runs = 0;
  timers.every('app-heal', async () => { runs += 1; throw new Error('docker away'); }, MIN);
  await advance(t, 2 * MIN);
  assert.equal(runs, 2);
  assert.equal(logs.filter((l) => l.msg === 'Timer tick failed' && l.data.name === 'app-heal').length, 2);
});

test('a non-positive interval is logged, not thrown: one bad knob must not cost becomeLeader the rest', () => {
  logs.length = 0;
  const stop = timers.every('stale-pr-sweep', () => {}, 0);
  assert.equal(typeof stop, 'function');
  assert.equal(timers.has('stale-pr-sweep'), false);
  assert.ok(logs.some((l) => l.msg === 'Timer not started: its interval is not a positive number'));
});

// ── durable timers ────────────────────────────────────────────────────

test('a durable sweep that never ran is due at once, after the settle delay and its jitter', async (t) => {
  useClock(t);
  const pool = fakeSweepsPool();
  let runs = 0;
  timers.every('delegation-prune', () => { runs += 1; }, HOUR, { durable: pool, random: () => 0.5 });
  const delay = await timers.ready('delegation-prune');
  assert.equal(delay, timers.DURABLE_SETTLE_MS + Math.floor(0.5 * timers.DURABLE_JITTER_MS));
  await advance(t, delay - 1000, 1000);
  assert.equal(runs, 0);
  await advance(t, 1000, 1000);
  assert.equal(runs, 1);
  assert.deepEqual(pool.writes.map((w) => w.name), ['delegation-prune'], 'the completed run is recorded');
  await advance(t, HOUR);
  assert.equal(runs, 2, 'then hourly');
});

test('a durable sweep that ran recently waits out the rest of its interval', async (t) => {
  useClock(t);
  const pool = fakeSweepsPool();
  pool.rows.set('stale-pr-sweep', Date.now() - 50 * MIN);
  let runs = 0;
  timers.every('stale-pr-sweep', () => { runs += 1; }, HOUR, { durable: pool, random: () => 0 });
  assert.equal(await timers.ready('stale-pr-sweep'), 10 * MIN);
  await advance(t, 10 * MIN - MIN);
  assert.equal(runs, 0);
  await advance(t, MIN);
  assert.equal(runs, 1);
});

test('the jitter is capped at a tenth of the interval', async (t) => {
  useClock(t);
  timers.every('local', () => {}, 2 * MIN, { durable: fakeSweepsPool(), random: () => 0.999 });
  const delay = await timers.ready('local');
  assert.equal(delay, timers.DURABLE_SETTLE_MS + Math.floor(0.999 * (2 * MIN) / 10));
});

test('an hourly sweep runs hourly across leaders that each last twenty minutes', async (t) => {
  // The production pattern: a release every twenty minutes, each one a new
  // leader. As a bare setInterval the sweep never fired once. Each leader is
  // a fresh process here: its timers start at election and stop with it.
  useClock(t);
  const pool = fakeSweepsPool();
  const ran = [];
  const startedAt = Date.now();
  for (let leader = 0; leader < 9; leader += 1) {
    timers.every('workshop-theme-sweep', () => { ran.push(Date.now() - startedAt); }, HOUR, {
      durable: pool, random: () => 0,
    });
    await timers.ready('workshop-theme-sweep');
    await advance(t, 20 * MIN);
    timers.stopAll();
  }
  // Three hours of twenty-minute leaders: the first run comes 30s into the
  // first one; every later one comes an hour after the one before it,
  // whichever leader holds it then.
  assert.deepEqual(ran.map((ms) => Math.round(ms / MIN)), [1, 61, 121]);
  assert.equal(pool.writes.length, 3);
});

test('a skipped tick (its own single-flight found a pass under way) records nothing', async (t) => {
  useClock(t);
  const pool = fakeSweepsPool();
  timers.every('shots-gc', () => timers.SKIPPED, 6 * HOUR, { durable: pool, random: () => 0 });
  await timers.ready('shots-gc');
  await advance(t, MIN);
  assert.equal(pool.writes.length, 0, 'not recorded, so the next election runs it again');
});

test('a durable sweep that throws records nothing', async (t) => {
  useClock(t);
  const pool = fakeSweepsPool();
  timers.every('cli-auth-cleanup', async () => { throw new Error('pool exhausted'); }, 6 * HOUR, { durable: pool, random: () => 0 });
  await timers.ready('cli-auth-cleanup');
  await advance(t, MIN);
  assert.equal(pool.writes.length, 0);
});

test('a table that cannot be read runs the sweep as if it never ran', async (t) => {
  useClock(t);
  logs.length = 0;
  let runs = 0;
  timers.every('merge-debug-prune', () => { runs += 1; }, 6 * HOUR, {
    durable: fakeSweepsPool({ failRead: true }), random: () => 0,
  });
  assert.equal(await timers.ready('merge-debug-prune'), timers.DURABLE_SETTLE_MS);
  await advance(t, MIN);
  assert.equal(runs, 1);
  assert.ok(logs.some((l) => /running it as if it never ran/.test(l.msg)));
});

test('a timer stopped before its durable read returns never schedules', async (t) => {
  useClock(t);
  let runs = 0;
  timers.every('conversation-attachment-gc', () => { runs += 1; }, HOUR, { durable: fakeSweepsPool(), random: () => 0 });
  const ready = timers.ready('conversation-attachment-gc');
  timers.clear('conversation-attachment-gc');
  assert.equal(await ready, null);
  await advance(t, 2 * HOUR, 10 * MIN);
  assert.equal(runs, 0);
});

// ── shutdown (last: lifecycle's shutdown flag never resets) ───────────

test('once shutdown begins no tick runs and no timer starts; stopAll clears them all', async (t) => {
  useClock(t);
  let runs = 0;
  timers.every('main-watch', () => { runs += 1; }, MIN);
  timers.every('check-harvest', () => { runs += 1; }, MIN, { firstDelayMs: 1000 });
  await advance(t, MIN);
  assert.equal(runs, 3, 'main-watch once; check-harvest at its first delay and its interval');

  lifecycle.setShuttingDown();
  await advance(t, 3 * MIN);
  assert.equal(runs, 3, 'ticks are skipped while the drain runs');
  assert.deepEqual(timers.stopAll().sort(), ['check-harvest', 'main-watch']);
  assert.deepEqual(timers.snapshot(), []);

  timers.every('vote-digest', () => { runs += 1; }, MIN, { firstDelayMs: 0 });
  assert.equal(timers.has('vote-digest'), false, 'a follower promoted mid-shutdown starts nothing');
  await advance(t, 2 * MIN);
  assert.equal(runs, 3);
});
