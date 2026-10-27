'use strict';

// How busy each process was, per minute, and what it was doing when its
// event loop stalled (services/process-health.js): the stall watcher and
// its warning, the minute's sample, the flush and prune against a stub
// pool, the in-flight snapshot's route (middleware/inflight-requests.js),
// and where server.js and the clock run them.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const health = require('../src/services/process-health');

const root = path.join(__dirname, '..');
const read = (p) => fs.readFileSync(path.join(root, p), 'utf8');

const MIN = 60 * 1000;
const T0 = Date.parse('2026-10-27T12:20:00Z');
const MB = 1024 * 1024;

function stubPool({ fail = () => null } = {}) {
  const calls = [];
  return {
    calls,
    async query(sql, params) {
      calls.push({ sql, params });
      const err = fail(sql, calls.length);
      if (err) throw err;
      return { rows: [], rowCount: 3 };
    },
  };
}

// A process whose clocks, CPU, loop and memory the test moves by hand.
function fakeProcess({ inflight = () => [] } = {}) {
  const p = {
    wall: T0 + 10_000, mono: 0, cpu: 0, active: 0, idle: 0, rss: 200 * MB, heapUsed: 120 * MB,
    delay: { p99: 0, max: 0, resets: 0 }, warnings: [],
  };
  p.health = health.createHealth({
    pod: 'web-1',
    role: 'web',
    now: () => p.wall,
    clock: () => p.mono,
    cpuUsage: (prev) => (prev ? { user: (p.cpu - prev.user / 1000) * 1000, system: 0 } : { user: p.cpu * 1000, system: 0 }),
    loopUtilization: () => ({ active: p.active, idle: p.idle }),
    delay: {
      percentile: () => p.delay.p99 * 1e6,
      get max() { return p.delay.max * 1e6; },
      reset: () => { p.delay.resets += 1; },
    },
    memory: () => ({ rss: p.rss, heapUsed: p.heapUsed }),
    inflight,
    logger: { warn: (scope, message, data) => p.warnings.push({ scope, message, data }) },
  });
  // Time passes: the wall and monotonic clocks together.
  p.pass = (ms) => { p.wall += ms; p.mono += ms; };
  return p;
}

test('the first sample waits for the next minute to start', () => {
  assert.equal(health.msToNextMinute(T0, 50), MIN + 50);
  assert.equal(health.msToNextMinute(T0 + 59_000, 50), 1050);
});

test('a wake-up a second late or more is a stall; it counts and is said once, with what was going on', () => {
  const p = fakeProcess({ inflight: () => [{ surface: 'GET /api/apps', route: '/api/apps', ageMs: 3100 }] });
  p.pass(health.TICK_MS);
  assert.equal(p.health.tick(), 0, 'on time');
  // A slow request and a collection inside the stall that is coming, and a
  // slow request that finished long before it.
  p.health.noteFinished({ method: 'GET', route: '/api/old', status: 200, startedAt: p.wall - 20_000, durationMs: 900 });
  p.health.noteFinished({ method: 'GET', route: '/api/quick', status: 200, startedAt: p.wall, durationMs: 20 });
  p.health.noteFinished({ method: 'GET', route: '/api/workshop/needs-feed', status: 200, startedAt: p.wall, durationMs: 2500 });
  p.health.noteGc({ startedAt: p.wall + 1000, durationMs: 300 });
  p.pass(2600);
  assert.equal(p.health.tick(), 2600, 'held 2.6 s');
  assert.equal(p.warnings.length, 1);
  const [w] = p.warnings;
  assert.equal(w.scope, 'process-health');
  assert.equal(w.message, 'The event loop stalled');
  assert.deepEqual(w.data, {
    stallMs: 2600,
    inflight: [{ surface: 'GET /api/apps', route: '/api/apps', ageMs: 3100 }],
    finishedDuring: [{ method: 'GET', route: '/api/workshop/needs-feed', status: 200, durationMs: 2500 }],
    gcMs: 300,
    heapUsedMb: 120,
    rssMb: 200,
  }, 'the requests in flight, the slow one that finished across it (not the quick one, not the old one), and its collections');

  // Again within ten seconds: counted, not said; the next warning says how
  // many went unsaid.
  p.pass(1500);
  assert.equal(p.health.tick(), 1500);
  assert.equal(p.warnings.length, 1);
  p.pass(health.LOG_EVERY_MS);
  p.health.tick();
  assert.equal(p.warnings.length, 2);
  assert.equal(p.warnings[1].data.stallsNotLogged, 1);
  const { current } = p.health.snapshot();
  assert.equal(current.stalls, 3);
  assert.equal(current.stallMaxMs, health.LOG_EVERY_MS);
});

test('a warning goes out even when the in-flight list cannot be read', () => {
  const p = fakeProcess({ inflight: () => { throw new Error('gone'); } });
  p.pass(5000);
  p.health.tick();
  assert.deepEqual(p.warnings[0].data.inflight, []);
});

test('a minute\'s sample: CPU, how busy the loop was, its delays, collections and memory peaks', () => {
  const p = fakeProcess();
  p.pass(50_000);
  p.cpu += 30_000; p.active += 40_000; p.idle += 10_000;
  p.delay.p99 = 120; p.delay.max = 2600;
  p.health.noteGc({ startedAt: p.wall, durationMs: 40 });
  p.health.noteGc({ startedAt: p.wall, durationMs: 60 });
  p.rss = 520 * MB;
  for (let i = 0; i < 5; i += 1) { p.pass(health.TICK_MS); p.health.tick(); }
  p.rss = 300 * MB;
  assert.equal(p.health.sample(), T0, 'under the minute its window began in');
  assert.equal(p.delay.resets, 1);
  const [m] = p.health.snapshot().minutes;
  assert.equal(m.minute, T0);
  assert.equal(m.cpuMs, 30_000);
  assert.deepEqual([m.activeMs, m.windowMs], [40_000, 50_000]);
  assert.deepEqual([m.delayP99Ms, m.delayMaxMs], [120, 2600]);
  assert.deepEqual([m.gcMs, m.gcCount, m.gcMaxMs], [100, 2, 60]);
  assert.equal(m.rssMb, 520, 'the peak read while the minute went, not the last');
  assert.deepEqual(p.health.snapshot().current.cpuMs, 0, 'the next window starts empty');
  p.pass(30_000);
  assert.equal(p.health.sample(), T0 + MIN, 'the next window began in the next minute');
});

test('two windows of one minute merge: sums add, peaks stay', () => {
  const a = { cpuMs: 1, activeMs: 2, windowMs: 4, delayP99Ms: 5, delayMaxMs: 50, stalls: 1, stallMaxMs: 1200, gcMs: 3, gcCount: 1, gcMaxMs: 3, rssMb: 300, heapUsedMb: 100 };
  const b = { cpuMs: 2, activeMs: 1, windowMs: 4, delayP99Ms: 9, delayMaxMs: 20, stalls: 2, stallMaxMs: 1000, gcMs: 4, gcCount: 2, gcMaxMs: 2, rssMb: 200, heapUsedMb: 150 };
  assert.deepEqual(health.mergeWindow(a, b), {
    cpuMs: 3, activeMs: 3, windowMs: 8, delayP99Ms: 9, delayMaxMs: 50, stalls: 3, stallMaxMs: 1200,
    gcMs: 7, gcCount: 3, gcMaxMs: 3, rssMb: 300, heapUsedMb: 150,
  });
  assert.deepEqual(health.deltaElu({ active: 10, idle: 5 }, { active: 4, idle: 1 }), { active: 6, idle: 4 });
  assert.equal(health.deltaElu({ active: 1, idle: 1 }, { active: 4, idle: 1 }), null, 'a reading that went back is no window');
  assert.equal(health.deltaElu(null, { active: 1, idle: 1 }), null);
});

test('flush upserts the minutes held, keeps them when refused, and samples the minute going when stopping', async () => {
  const p = fakeProcess();
  p.pass(50_000);
  p.cpu += 30_000; p.active += 45_000; p.idle += 5_000; p.delay.p99 = 120; p.delay.max = 2600;
  p.health.sample();
  const down = stubPool({ fail: () => new Error('connection refused') });
  assert.deepEqual(await p.health.flush(down), { minutes: 0 });
  assert.equal(p.health.snapshot().minutes.length, 1, 'kept for the next flush');

  const pool = stubPool();
  assert.deepEqual(await p.health.flush(pool), { minutes: 1 });
  const [{ sql, params }] = pool.calls;
  assert.equal(sql, health.PROCESS_UPSERT_SQL);
  assert.deepEqual(params, [
    ['2026-10-27T12:20:00.000Z'], 'web-1', 'web',
    [30_000], [0.9], [120], [2600], [0], [0], [0], [0], [0], [200], [120],
  ]);
  assert.deepEqual(p.health.snapshot().minutes, []);
  const idle = stubPool();
  assert.deepEqual(await p.health.flush(idle), { minutes: 0 });
  assert.equal(idle.calls.length, 0, 'nothing held: no query');

  // Stopping: the minute still going is sampled and sent.
  p.pass(5000);
  p.cpu += 100;
  const last = stubPool();
  assert.deepEqual(await p.health.flush(last, { all: true }), { minutes: 1 });
  assert.equal(last.calls[0].params[3][0], 100);
  assert.deepEqual(await p.health.flush(null), { minutes: 0 });
});

test('the upsert adds sums and keeps peaks; prune removes rows past 14 days and never throws', async () => {
  const sql = health.PROCESS_UPSERT_SQL;
  assert.match(sql, /INSERT INTO server_process_minutes \(minute, pod, role, cpu_ms, loop_utilization, loop_delay_p99_ms,/);
  assert.match(sql, /ON CONFLICT \(minute, pod\) DO UPDATE/);
  assert.match(sql, /cpu_ms = server_process_minutes\.cpu_ms \+ EXCLUDED\.cpu_ms/);
  assert.match(sql, /stall_max_ms = GREATEST\(server_process_minutes\.stall_max_ms, EXCLUDED\.stall_max_ms\)/);
  assert.match(sql, /rss_mb = GREATEST\(server_process_minutes\.rss_mb, EXCLUDED\.rss_mb\)/);
  const pool = stubPool();
  assert.deepEqual(await health.prune(pool), { processes: 3 });
  assert.match(pool.calls[0].sql, /^DELETE FROM server_process_minutes WHERE minute < NOW\(\) - make_interval\(days => \$1\)$/);
  assert.deepEqual(pool.calls[0].params, [14]);
  assert.equal(await health.prune(stubPool({ fail: () => new Error('x') })), null);
  assert.equal(await health.prune(null), null);
  assert.match(read('src/db/schema.sql'), /CREATE TABLE IF NOT EXISTS server_process_minutes \([\s\S]*?PRIMARY KEY \(minute, pod\)\n\);/);
});

test('the module is quiet until it starts, and its timers never hold the process open', async () => {
  assert.equal(health.noteFinished({ method: 'GET', route: '/x', status: 200, startedAt: 1, durationMs: 5000 }), undefined);
  assert.deepEqual(await health.flush(stubPool()), { minutes: 0 });
  const realInterval = global.setInterval;
  const realTimeout = global.setTimeout;
  const made = [];
  const fake = (kind) => (fn, ms) => {
    const h = { kind, fn, ms, unrefed: false, unref() { this.unrefed = true; return this; } };
    made.push(h);
    return h;
  };
  global.setInterval = fake('interval');
  global.setTimeout = fake('timeout');
  try {
    health.start({ pool: stubPool(), role: 'web' });
    health.start({ pool: stubPool(), role: 'web' });
  } finally {
    global.setInterval = realInterval;
    global.setTimeout = realTimeout;
    health.stop();
  }
  assert.deepEqual(made.map((h) => [h.kind, h.ms === health.TICK_MS || h.ms === health.FLUSH_INTERVAL_MS || h.kind === 'timeout']),
    [['interval', true], ['timeout', true], ['interval', true]], 'once: the watcher, the first sample, the flush');
  assert.ok(made.every((h) => h.unrefed));
});

test('the in-flight snapshot names a routed request by its template', async () => {
  const express = require('express');
  const inflight = require('../src/middleware/inflight-requests');
  const { requestCounts } = require('../src/middleware/request-counts');
  const app = express();
  app.use(inflight.inflightRequests());
  app.use(requestCounts());
  let release;
  const held = new Promise((r) => { release = r; });
  app.get('/api/apps/:slug/slow', async (_req, res) => { await held; res.json({ ok: true }); });
  const server = await new Promise((r) => { const s = app.listen(0, '127.0.0.1', () => r(s)); });
  try {
    const answer = fetch(`http://127.0.0.1:${server.address().port}/api/apps/my-app/slow`);
    let snap = [];
    for (let i = 0; i < 50 && !snap.length; i += 1) {
      await new Promise((r) => setTimeout(r, 10));
      snap = inflight.snapshot();
    }
    assert.equal(snap.length, 1);
    assert.equal(snap[0].surface, 'GET /api/apps');
    assert.equal(snap[0].route, '/api/apps/:slug/slow');
    assert.ok(!JSON.stringify(snap).includes('my-app'), 'never the path requested');
    release();
    await (await answer).json();
  } finally {
    server.close();
  }
});

// ── Where the platform runs it ──────────────────────────────────────────

test('every process starts it beside the server counts, says its in-flight requests and flushes it when stopping', () => {
  const src = read('server.js');
  const counts = src.indexOf("require('./src/services/server-error-counts').start({ pool: getPool(config) });");
  const start = src.indexOf("require('./src/services/process-health').start({ pool: getPool(config), role: ownRole });");
  assert.ok(counts > 0 && start > counts, 'started on every process, beside the server counts');
  assert.match(src, /log\.info\('server', 'Draining in-flight requests and background work', \{\n\s+requests: startingRequests,\n\s+\.\.\.\(startingRequests \? \{ inflight: inflightRequests\.snapshot\(\)\.slice\(0, 20\) \} : \{\}\),/,
    'a stopping process says which requests it was answering');
  const flushCounts = src.indexOf('await boundedStep(serverErrorCounts.flush(shutdownPool, { all: true }), BUILD_SHUTDOWN_MARK_TIMEOUT_MS)');
  const flushHealth = src.indexOf('await boundedStep(processHealth.flush(shutdownPool, { all: true }), BUILD_SHUTDOWN_MARK_TIMEOUT_MS)');
  const poolEnd = src.indexOf('// Close the pg pool so in-flight queries settle');
  assert.ok(flushCounts > 0 && flushHealth > flushCounts && flushHealth < poolEnd, 'flushed with the counts, before the pool closes');
  const clock = read('src/workflow/clock/services.ts');
  assert.match(clock, /const h = await legacy\('services\/process-health'\)\.prune\(pool\);/, 'pruned by the server counts\' daily job');
});
