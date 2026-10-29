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
function fakeProcess({ inflight = () => [], delayResolutionMs = 0 } = {}) {
  const p = {
    wall: T0 + 10_000, mono: 0, cpu: 0, active: 0, idle: 0, rss: 200 * MB, heapUsed: 120 * MB,
    delay: { p99: 0, max: 0, resets: 0 }, warnings: [], deferred: [],
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
    delayResolutionMs,
    memory: () => ({ rss: p.rss, heapUsed: p.heapUsed }),
    inflight,
    logger: { warn: (scope, message, data) => p.warnings.push({ scope, message, data }) },
    later: (fn, ms) => p.deferred.push({ fn, ms }),
  });
  // Time passes: the wall and monotonic clocks together.
  p.pass = (ms) => { p.wall += ms; p.mono += ms; };
  // The deferred warnings run, as the timer would SETTLE_MS later.
  p.settle = () => { for (const d of p.deferred.splice(0)) d.fn(); };
  return p;
}

test('the first sample waits for the next minute to start', () => {
  assert.equal(health.msToNextMinute(T0, 50), MIN + 50);
  assert.equal(health.msToNextMinute(T0 + 59_000, 50), 1050);
});

test('a wake-up a second or more after the last is a stall; it counts and is said once, with what was going on', () => {
  const p = fakeProcess({ inflight: () => [{ surface: 'GET /api/apps', route: '/api/apps', ageMs: 3100 }] });
  p.pass(health.TICK_MS);
  assert.equal(p.health.tick(), 0, 'on time');
  // A slow request and a collection inside the stall that is coming, and a
  // slow request that finished long before it.
  p.health.noteFinished({ method: 'GET', route: '/api/old', status: 200, startedAt: p.wall - 20_000, durationMs: 900 });
  p.health.noteFinished({ method: 'GET', route: '/api/quick', status: 200, startedAt: p.wall, durationMs: 20 });
  p.health.noteFinished({ method: 'GET', route: '/api/workshop/needs-feed', status: 200, startedAt: p.wall, durationMs: 2500 });
  p.health.noteFinished({ method: 'GET', route: '/api/apps', status: 200, startedAt: p.wall, durationMs: 1800, aborted: true });
  p.health.noteGc({ durationMs: 300 });
  p.pass(2600);
  assert.equal(p.health.tick(), 2600, 'the gap: 2.6 s');
  assert.equal(p.warnings.length, 0, 'said once what the stall left behind has been delivered');
  assert.equal(p.deferred[0].ms, health.SETTLE_MS);
  p.settle();
  assert.equal(p.warnings.length, 1);
  const [w] = p.warnings;
  assert.equal(w.scope, 'process-health');
  assert.equal(w.message, 'The event loop stalled');
  assert.deepEqual(w.data, {
    stallMs: 2600,
    blockedAtLeastMs: 2400,
    inflight: [{ surface: 'GET /api/apps', route: '/api/apps', ageMs: 3100 }],
    finishedDuring: [
      { method: 'GET', route: '/api/workshop/needs-feed', status: 200, durationMs: 2500 },
      { method: 'GET', route: '/api/apps', status: 200, durationMs: 1800, aborted: true },
    ],
    gcMs: 300,
    heapUsedMb: 120,
    rssMb: 200,
  }, 'the requests in flight, the slow ones that finished or were given up across it (not the quick one, not the old one), and its collections');

  // Again within ten seconds: counted, not said; the next warning says how
  // many went unsaid.
  p.pass(1500);
  assert.equal(p.health.tick(), 1500);
  p.settle();
  assert.equal(p.warnings.length, 1);
  p.pass(health.LOG_EVERY_MS);
  p.health.tick();
  p.settle();
  assert.equal(p.warnings.length, 2);
  assert.equal(p.warnings[1].data.stallsNotLogged, 1);
  const { current } = p.health.snapshot();
  assert.equal(current.stalls, 3);
  assert.equal(current.stallMaxMs, health.LOG_EVERY_MS);
});

test('a stall of a second is caught from one tick to the next, and said with both bounds', () => {
  // The loop held for a second starting just after a wake-up: the next
  // wake-up comes a second after it, only 800 ms past due.
  const p = fakeProcess();
  p.pass(999);
  assert.equal(p.health.tick(), 0, 'just under: not a stall');
  p.pass(1000);
  assert.equal(p.health.tick(), 1000);
  p.settle();
  assert.deepEqual([p.warnings[0].data.stallMs, p.warnings[0].data.blockedAtLeastMs], [1000, 800]);
});

test('the stall\'s collections count when Node delivers them after the stall, however many small ones there were', () => {
  const p = fakeProcess();
  p.pass(health.TICK_MS);
  p.health.tick();
  p.health.noteGc({ durationMs: 40 }); // before the stall: in the tick before, counted with it
  p.pass(1500);
  p.health.tick();
  // Delivered after the watcher woke: one long major collection and three
  // hundred quick scavenges, as a busy allocating handler leaves behind.
  p.health.noteGc({ durationMs: 900 });
  for (let i = 0; i < 300; i += 1) p.health.noteGc({ durationMs: 0.1 });
  p.settle();
  assert.equal(p.warnings[0].data.gcMs, 970);
  assert.equal(Math.round(p.health.snapshot().current.gcMs), 970, 'the minute counts them all too');
});

test('a warning goes out even when the in-flight list cannot be read', () => {
  const p = fakeProcess({ inflight: () => { throw new Error('gone'); } });
  p.pass(5000);
  p.health.tick();
  p.settle();
  assert.deepEqual(p.warnings[0].data.inflight, []);
});

test('the loop\'s delays are what is left after the histogram\'s sampling interval', () => {
  // An idle process: Node records the 20 ms between samples, plus ~1 ms.
  const p = fakeProcess({ delayResolutionMs: health.DELAY_RESOLUTION_MS });
  p.delay.p99 = 21.07; p.delay.max = 21.2;
  p.pass(50_000);
  p.health.sample();
  const [idle] = p.health.snapshot().minutes;
  assert.deepEqual([Math.round(idle.delayP99Ms * 100) / 100, Math.round(idle.delayMaxMs * 100) / 100], [1.07, 1.2]);
  // Never below zero.
  p.delay.p99 = 15; p.delay.max = 2620;
  p.pass(60_000);
  p.health.sample();
  const second = p.health.snapshot().minutes[1];
  assert.deepEqual([second.delayP99Ms, second.delayMaxMs], [0, 2600]);
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

// Ten seconds into a minute, so a clock read can never straddle a boundary.
const FROZEN = T0 + 10_000;

test('started once: a minute is sampled and flushed just after it ends, re-armed from the clock, and no timer holds the process open', async () => {
  assert.equal(health.noteFinished({ method: 'GET', route: '/x', status: 200, startedAt: 1, durationMs: 5000 }), undefined);
  assert.deepEqual(await health.flush(stubPool()), { minutes: 0 });
  const realInterval = global.setInterval;
  const realTimeout = global.setTimeout;
  const realNow = Date.now;
  const made = [];
  const fake = (kind) => (fn, ms) => {
    const h = { kind, fn, ms, unrefed: false, unref() { this.unrefed = true; return this; } };
    made.push(h);
    return h;
  };
  global.setInterval = fake('interval');
  global.setTimeout = fake('timeout');
  const pool = stubPool();
  // One frozen instant for the first arm, the sample, the flush and the
  // re-arm, so no assertion here depends on when in the minute it runs.
  Date.now = () => FROZEN;
  try {
    health.start({ pool, role: 'web' });
    health.start({ pool: stubPool(), role: 'web' });
    assert.deepEqual(made.map((h) => [h.kind, h.ms === health.TICK_MS || h.ms <= MIN + 50]), [['interval', true], ['timeout', true]],
      'once: the watcher, and the first sample just after the minute ends');
    // The sample runs (late, say): the minute is flushed at once, not up to
    // a minute later, and the next sample is set from the clock, not from
    // when this one ran.
    made[1].fn();
    await new Promise((r) => realTimeout(r, 0));
    assert.equal(pool.calls[0]?.sql, health.PROCESS_UPSERT_SQL);
    assert.equal(made.length, 3);
    assert.equal(made[2].kind, 'timeout');
    assert.equal(made[2].ms, health.msToNextMinute(FROZEN), 'set to just after the next minute starts');
  } finally {
    global.setInterval = realInterval;
    global.setTimeout = realTimeout;
    Date.now = realNow;
    health.stop();
  }
  made[2].fn();
  assert.equal(made.length, 3, 'stopped, a sample already scheduled does nothing and arms nothing');
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
  // A path whose second segment is the secret, and one no route declared.
  app.get('/invite/:token', async (_req, res) => { await held; res.send('ok'); });
  app.use(async (_req, res) => { await held; res.status(404).send('no'); });
  const server = await new Promise((r) => { const s = app.listen(0, '127.0.0.1', () => r(s)); });
  try {
    const base = `http://127.0.0.1:${server.address().port}`;
    const answers = ['/api/apps/my-app/slow', '/invite/SECRETINVITETOKEN123', '/reports/0123456789abcdef0123456789abcdef']
      .map((p) => fetch(`${base}${p}`));
    let snap = [];
    for (let i = 0; i < 50 && snap.length < 3; i += 1) {
      await new Promise((r) => setTimeout(r, 10));
      snap = inflight.snapshot();
    }
    assert.equal(snap.length, 3);
    const bySurface = new Map(snap.map((e) => [e.surface, e]));
    assert.equal(bySurface.get('GET /api/apps').route, '/api/apps/:slug/slow');
    assert.equal(bySurface.get('GET /invite').route, '/invite/:token');
    assert.equal(bySurface.get('GET /reports').route, null, 'no route declared: only its first segment');
    const text = JSON.stringify(snap);
    for (const secret of ['my-app', 'SECRETINVITETOKEN123', '0123456789abcdef']) {
      assert.ok(!text.includes(secret), `never the path requested (${secret})`);
    }
    release();
    for (const a of answers) await (await a).text();
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
