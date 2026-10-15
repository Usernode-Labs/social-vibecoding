// #767: the platform's own graceful shutdown.
//
// cleanup() already drained in-flight worker handlers, but it never closed
// the HTTP listener and never closed the pg pool — so for the whole 5s
// drain the process kept ACCEPTING new requests, then exited from under
// them and severed any in-flight query at process.exit(0).
//
// Closing the listener first is safe (and better) specifically because
// Caddy's apex proxy and wildcard forward_auth gate both hold-and-retry a
// refused dial for 30s: a connection refused during the drain is re-dialled
// into the new container rather than 502'd.
//
// The Homeroom bot's builds and the bench's trials are not waited for: they
// are durable builds, which the workflow runtime gives up as it stops, for
// the next leader to carry on (the bot's own drain is gone). Once shutdown
// has begun, nothing new of the bot's or the bench's starts.
//
// Everything here is modelled — stubbed listener, stubbed pool, stubbed
// process.exit — so the ordering assertions never depend on wall clock.
//
// Run with: node --test tests/server-graceful-shutdown.test.js

const test = require('node:test');
const assert = require('node:assert/strict');

// loadConfig() (module level in server.js) hard-exits when these are
// missing — provide dummies before the require below. Same preamble as
// tests/recovery-headless-guard.test.js.
process.env.DATABASE_URL = process.env.DATABASE_URL || 'postgres://test:test@localhost:5/test';
process.env.SESSION_SECRET = process.env.SESSION_SECRET || 'test-session';
process.env.ADMIN_USERNAME = process.env.ADMIN_USERNAME || 'admin';
process.env.ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || 'admin';
process.env.JWT_SECRET = process.env.JWT_SECRET || 'test-jwt';
// config.load() requires the four separated platform keys (REQUIRED_PROD).
require('./platform-keys').setPlatformKeys();

// Capture log lines by swapping the logger's sinks in place — server.js's
// require graph binds `log` deep in the route tree, so replacing the module
// wholesale isn't reliable this late.
const log = require('../src/services/logger');
const logs = [];
for (const level of ['info', 'warn', 'error', 'debug']) {
  log[level] = (cat, msg, data) => { logs.push({ level, cat, msg, data }); };
}

// Module-level code in server.js's require graph schedules housekeeping
// timers without unref — harmless in production, but they'd keep this test
// process alive forever. Auto-unref anything scheduled during the require.
const origSetInterval = global.setInterval;
const origSetTimeout = global.setTimeout;
global.setInterval = (...args) => { const t = origSetInterval(...args); if (t && t.unref) t.unref(); return t; };
global.setTimeout = (...args) => { const t = origSetTimeout(...args); if (t && t.unref) t.unref(); return t; };
let serverModule;
try {
  serverModule = require('../server');
} finally {
  global.setInterval = origSetInterval;
  global.setTimeout = origSetTimeout;
}

// One shared module instance; each test resets the shutdown targets (which
// also clears the cleanupStarted latch) via __setShutdownTargets.
function loadServer() {
  logs.length = 0;
  return { server: serverModule, logs, restore: () => {} };
}

// A stand-in for the node http.Server, recording which teardown calls the
// shutdown path makes.
function fakeListener() {
  const events = [];
  return {
    events,
    close(cb) { events.push('close'); if (cb) cb(); },
    closeIdleConnections() { events.push('closeIdle'); },
    closeAllConnections() { events.push('closeAll'); },
  };
}

function fakePool({ endImpl } = {}) {
  const events = [];
  return {
    events,
    end: endImpl || (async () => { events.push('end'); }),
  };
}

async function runCleanup(server, { listener, pool, ...drainOptions }) {
  const order = [];
  const realExit = process.exit;
  process.exit = (code) => { order.push(`exit:${code}`); };
  server.__setShutdownTargets({ server: listener, pool, ...drainOptions });
  try {
    await server.cleanup();
  } finally {
    process.exit = realExit;
    if (drainOptions.leadership !== undefined) server.__setShutdownTargets({ leadership: null });
  }
  return order;
}

async function until(check, ms = 3000) {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    if (check()) return true;
    await new Promise((r) => setTimeout(r, 5));
  }
  return check();
}

// FIRST in the file, deliberately: once any cleanup() below has run the
// process is shutting down for good, and a leader timer refuses to start.
//
// Through the whole drain the leader's timers used to keep firing — the
// eligible-merge sweep, the drift poller, main-watch, app-heal — because
// cleanup() cleared only the handles server.js kept, so a merge or a
// rebuild could start moments before the exit cut it. Every one of them is
// a leader timer now (src/services/leader-timers.js): cleanup() stops them
// all as it begins, and the tick already running is drained, not cut.
test('leader timers stop as shutdown begins, and the tick under way finishes before the pool closes', async () => {
  const { server, logs } = loadServer();
  const leaderTimers = require('../src/services/leader-timers');
  const seq = [];
  let started = 0;
  leaderTimers.every('test-eligible-merge-sweep', async () => {
    started += 1;
    const n = started;
    seq.push(`tick ${n} started`);
    await new Promise((r) => setTimeout(r, 250));
    seq.push(`tick ${n} finished`);
  }, 40);
  assert.ok(await until(() => started > 0), 'the timer runs while this process leads');
  const startedBeforeShutdown = started;

  const startedAt = Date.now();
  const pool = fakePool({ endImpl: async () => { seq.push('poolEnd'); } });
  const order = await runCleanup(server, { listener: fakeListener(), pool });
  const elapsed = Date.now() - startedAt;

  assert.deepEqual(order, ['exit:0']);
  assert.equal(started, startedBeforeShutdown, 'no tick starts once shutdown has begun (the interval is 40ms)');
  assert.equal(leaderTimers.has('test-eligible-merge-sweep'), false, 'cleared');
  assert.deepEqual(leaderTimers.snapshot(), []);
  assert.equal(seq[seq.length - 1], 'poolEnd', 'every tick under way finished before the pool closed');
  assert.equal(seq.filter((e) => / finished$/.test(e)).length, startedBeforeShutdown);
  assert.ok(elapsed >= 150, `cleanup waited for the tick (${elapsed}ms)`);
  const draining = logs.find((l) => l.msg === 'Draining in-flight requests and background work');
  assert.ok(draining.data.timersStopped >= 1);
  assert.ok(draining.data.background.some((e) => e.name === 'timer:test-eligible-merge-sweep'));
  assert.ok(logs.some((l) => l.msg === 'In-flight requests and background work drained'));
});

test('cleanup closes the listener, then the pool, then exits', async () => {
  const { server, restore } = loadServer();
  try {
    const listener = fakeListener();
    const seq = [];
    const pool = fakePool({ endImpl: async () => { seq.push('poolEnd'); } });

    const order = await runCleanup(server, { listener, pool });

    assert.ok(listener.events.includes('close'), 'the listener must stop accepting');
    assert.ok(listener.events.includes('closeIdle'), 'idle keep-alives are dropped at once');
    assert.equal(listener.events[0], 'close');
    assert.deepEqual(seq, ['poolEnd'], 'the pool must be closed before exit');
    assert.deepEqual(order, ['exit:0']);
  } finally {
    restore();
  }
});

test('the listener is closed BEFORE the pool — new work must not arrive mid-drain', async () => {
  const { server, restore } = loadServer();
  try {
    const seq = [];
    const listener = {
      close(cb) { seq.push('listenerClose'); if (cb) cb(); },
      closeIdleConnections() {},
      closeAllConnections() {},
    };
    const pool = fakePool({ endImpl: async () => { seq.push('poolEnd'); } });

    await runCleanup(server, { listener, pool });

    assert.deepEqual(seq, ['listenerClose', 'poolEnd']);
  } finally {
    restore();
  }
});

test('a hanging pool.end() still reaches exit inside the bounded budget', async () => {
  const { server, restore } = loadServer();
  try {
    const listener = fakeListener();
    // A pool that never settles: the race against POOL_CLOSE_TIMEOUT_MS is
    // what stops it holding the process past the SIGKILL deadline.
    const pool = fakePool({ endImpl: () => new Promise(() => {}) });

    const startedAt = Date.now();
    const order = await runCleanup(server, { listener, pool });
    const elapsed = Date.now() - startedAt;

    assert.deepEqual(order, ['exit:0'], 'a stuck pool must not prevent exit');
    assert.ok(elapsed < server.POOL_CLOSE_TIMEOUT_MS + 2000,
      `cleanup took ${elapsed}ms; the pool close must be bounded`);
  } finally {
    restore();
  }
});

test('a rejecting pool.end() is logged and does not block exit', async () => {
  const { server, logs, restore } = loadServer();
  try {
    const listener = fakeListener();
    const pool = fakePool({ endImpl: async () => { throw new Error('pool is on fire'); } });

    const order = await runCleanup(server, { listener, pool });

    assert.deepEqual(order, ['exit:0']);
    assert.ok(logs.some((l) => l.msg === 'Pool close failed' && /on fire/.test(l.data.err)));
  } finally {
    restore();
  }
});

test('cleanup is idempotent — SIGTERM then SIGINT must not tear down twice', async () => {
  const { server, restore } = loadServer();
  try {
    const listener = fakeListener();
    let ends = 0;
    const pool = fakePool({ endImpl: async () => { ends += 1; } });

    const realExit = process.exit;
    const exits = [];
    process.exit = (code) => { exits.push(code); };
    server.__setShutdownTargets({ server: listener, pool });
    try {
      await Promise.all([server.cleanup(), server.cleanup()]);
      await server.cleanup();
    } finally {
      process.exit = realExit;
    }

    assert.equal(ends, 1, 'the pool must be closed exactly once');
    assert.equal(listener.events.filter((e) => e === 'close').length, 1);
    assert.equal(exits.length, 1);
  } finally {
    restore();
  }
});

test('shutdown marks an unfinished visual replay with its actual interruption reason before closing the pool', async () => {
  const { server, restore } = loadServer();
  const orchestrator = require('../src/services/shots-orchestrator');
  const shotsState = require('../src/services/shots-state');
  const lifecycle = require('../src/services/lifecycle');
  const saved = {
    keys: orchestrator.inFlightSnapshot, ids: orchestrator.inFlightRunSnapshot,
    transition: shotsState.transitionRun, waitFor: lifecycle.waitFor,
  };
  const runId = 'a'.repeat(32);
  const order = [];
  const marks = [];
  orchestrator.inFlightSnapshot = () => ['42:head'];
  orchestrator.inFlightRunSnapshot = () => [runId];
  lifecycle.waitFor = async () => false;
  // Recorded, not asserted, in here: the shutdown handler settles every mark
  // with Promise.allSettled, so an assertion thrown inside this stub would be
  // swallowed and could never fail the test.
  shotsState.transitionRun = async (_pool, id, next, patch) => {
    order.push('marked');
    marks.push({ id, next, patch });
  };
  try {
    const pool = fakePool({ endImpl: async () => { order.push('poolEnd'); } });
    await runCleanup(server, { listener: fakeListener(), pool });
    assert.deepEqual(order, ['marked', 'poolEnd']);
    assert.equal(marks.length, 1);
    const [{ id, next, patch }] = marks;
    assert.equal(id, runId);
    assert.equal(next, 'failed');
    assert.equal(patch.failureCode, 'shots_run_interrupted');
    assert.equal(patch.failureReason, shotsState.SHUTDOWN_INTERRUPTED_REASON);
    assert.match(patch.failureReason, /Homeroom restarted/);
    // Tagged as a rollout, merged into the trace rather than replacing the
    // run's diagnostics, so the retry sweep spends only the ceiling on it.
    assert.deepEqual(patch.traceMerge, { interruptedBy: shotsState.SHUTDOWN_INTERRUPTION });
    assert.equal(patch.traceSummary, undefined);
  } finally {
    orchestrator.inFlightSnapshot = saved.keys;
    orchestrator.inFlightRunSnapshot = saved.ids;
    shotsState.transitionRun = saved.transition;
    lifecycle.waitFor = saved.waitFor;
    restore();
  }
});

test('shutdown hands its checks runs to the next leader before closing the pool', async () => {
  // 7 Oct 2026: the new leader's boot harvest ran while the rows the old
  // Pod had been harvesting still carried its heartbeat, so it seated
  // neither, and the stale sweep started both runs over. The runs left to
  // hand over are main-watch's (main-watch.adoptRun); a preview machine's
  // run is its work item's, collected by that item's retry.
  const { server, restore } = loadServer();
  const checkRuns = require('../src/services/check-runs');
  const lifecycle = require('../src/services/lifecycle');
  const saved = { release: checkRuns.release, waitFor: lifecycle.waitFor };
  const order = [];
  lifecycle.waitFor = async () => true;
  checkRuns.release = async (pool) => {
    order.push('released');
    assert.ok(pool, 'through the shutdown pool');
    return 2;
  };
  try {
    const pool = fakePool({ endImpl: async () => { order.push('poolEnd'); } });
    await runCleanup(server, { listener: fakeListener(), pool });
    assert.deepEqual(order, ['released', 'poolEnd']);
    const line = logs.find((l) => l.msg === 'Handed this process\'s checks runs to the next leader on shutdown');
    assert.deepEqual(line.data, { runs: 2, timedOut: false });

    order.length = 0;
    await runCleanup(server, { listener: fakeListener(), pool: null });
    assert.deepEqual(order, [], 'no pool, nothing to hand over through');
  } finally {
    checkRuns.release = saved.release;
    lifecycle.waitFor = saved.waitFor;
    restore();
  }
});

// The Homeroom bot's builds and the bench's trials under way are durable
// builds (services/build-runs.js, docs/plans/bot-build-workflow.md), and
// nothing in cleanup() waits for them. With the workflow runtime, stopping
// it stops each at its next step, its turn left running in its worker, and
// gives its work item up, so the next leader claims it at once and carries
// it on from the step it saved. Without one, a build runs in this process,
// unkept, and the restart loses it, as builds always were lost before.
test('a bot build under way does not hold the shutdown, and nothing is recorded for it', async () => {
  const { server, restore } = loadServer();
  const bot = require('../src/services/homeroom-bot');
  const buildRuns = require('../src/services/build-runs');
  const realRun = bot.runShadowBuild;
  let started = false;
  let release;
  bot.runShadowBuild = () => { started = true; return new Promise((resolve) => { release = resolve; }); };
  // No workflow runtime here: the build runs in this process (started before
  // the shutdown, which an earlier test of this file began: a stopping process
  // starts none).
  const build = buildRuns.start({ pool: null, config: {}, target: 'shadow', id: 78, deps: { inProcess: true } });
  let ended = false;
  build.then(() => { ended = true; }, () => { ended = true; });
  try {
    assert.ok(await until(() => started), 'the build is under way');
    const listener = fakeListener();
    const writes = [];
    const pool = { ...fakePool(), query: async (sql, params) => { writes.push({ sql, params }); return { rows: [] }; } };

    const startedAt = Date.now();
    const order = await runCleanup(server, { listener, pool });
    const elapsed = Date.now() - startedAt;

    assert.deepEqual(order, ['exit:0']);
    assert.ok(elapsed < 2000, `cleanup took ${elapsed}ms; it must not wait for the bot`);
    assert.equal(ended, false, 'the build was still running when the exit came');
    // The shutdown's own hand-over of main-watch's checks runs
    // (check-runs.release) is not about the build.
    assert.deepEqual(writes.filter((w) => !/UPDATE check_runs SET owner/.test(w.sql)), [],
      'nothing is recorded for it: no incident, no run written');
    assert.deepEqual(pool.events, ['end']);
  } finally {
    release({ acted: 'shadow_built' });
    await build;
    bot.runShadowBuild = realRun;
    restore();
  }
});

test('the workflow runtime stops its loops as shutdown begins, its work only after the drain, and the pool closes only once it has', () => {
  const fs = require('node:fs');
  const path = require('node:path');
  const src = fs.readFileSync(path.join(__dirname, '..', 'server.js'), 'utf8');
  const body = src.slice(src.indexOf('async function cleanup()'), src.indexOf("process.on('SIGTERM', cleanup);"));
  // docs/plans/draining-releases.md: a process finishing its work quiesces
  // the runtime (no slot, timer or claim) with the bot's loops, and stops
  // its running work only once drainUntilIdle has let it finish; one with the
  // short drain stops it at once, before its listener closes.
  const chosen = body.indexOf('let workflowStop = finishesWork');
  const quiesce = body.indexOf("require('./src/workflow/platform.ts').quiesceWorkflow()");
  const stopNow = body.indexOf(': stopWorkflowNow();');
  const shortClose = body.indexOf('if (!finishesWork) closeListener(drainMs);');
  const drained = body.indexOf('await drainUntilIdle(');
  const stoppedAfter = body.indexOf('workflowStop = stopWorkflowNow();');
  const longClose = body.indexOf('closeListener(DRAIN_TIMEOUT_MS);');
  assert.ok(chosen > 0 && quiesce > chosen && stopNow > quiesce && shortClose > stopNow,
    'chosen with the bot\'s loops, before the short drain\'s listener closes');
  assert.ok(drained > shortClose && longClose > drained && stoppedAfter > drained,
    'a process finishing its work closes its listener and stops its workflow work after the drain');
  assert.match(body, /await Promise\.race\(\[\n\s+Promise\.all\(\[[^\]]*\bworkflowStop\b[^\]]*\]\)\.then\(\(\) => shutdownPool\.end\(\)\),/,
    'its stop (each build\'s lease given up) is awaited before the pool ends, inside the pool close\'s bound');
  assert.doesNotMatch(body, /homeroom-bot-drain|waitForSafePoint|botDeadlineMs/, 'and nothing waits for the bot\'s builds');
});

test('cleanup survives a listener that throws on close', async () => {
  const { server, logs, restore } = loadServer();
  try {
    const listener = { close() { throw new Error('already closed'); } };
    const pool = fakePool();

    const order = await runCleanup(server, { listener, pool });

    assert.deepEqual(order, ['exit:0']);
    assert.ok(logs.some((l) => l.msg === 'Listener close failed'));
  } finally {
    restore();
  }
});

test('cleanup works with no listener or pool registered (boot failed early)', async () => {
  const { server, restore } = loadServer();
  try {
    const order = await runCleanup(server, { listener: null, pool: null });
    assert.deepEqual(order, ['exit:0']);
  } finally {
    restore();
  }
});

test('SIGTERM and SIGINT are both wired to cleanup', () => {
  const { server, restore } = loadServer();
  try {
    assert.ok(process.listeners('SIGTERM').length > 0, 'SIGTERM must have a handler');
    assert.ok(process.listeners('SIGINT').length > 0, 'SIGINT must have a handler');
    assert.equal(typeof server.cleanup, 'function');
  } finally {
    restore();
  }
});

// ── #2545: the process being replaced tells its tabs where traffic went ──
//
// At SIGTERM during a rollout, the build this deployment is moving to is
// already on record (deploy-status reads it for the version row), and the
// listener has just closed — so nothing a tab fetches on hearing this can be
// answered by the build being retired. cleanup() reads the target and, if it
// is another build, pushes `platform_version` to every open events socket.
// Modelled through the same seam as the rest of this file: deploy-status
// and ws are the shared module instances server.js holds, stubbed in place.

const deployStatus = require('../src/services/deploy-status');
const wsService = require('../src/services/ws');
const OWN = 'a'.repeat(40);
const NEXT = 'b'.repeat(40);

/** `gitSha: null` runs with GIT_SHA unset. */
function withRollout({ gitSha = OWN, read } = {}, run) {
  const savedSha = process.env.GIT_SHA;
  const savedRead = deployStatus.read;
  const savedPush = wsService.pushPlatformVersion;
  const pushes = [];
  if (gitSha === null) delete process.env.GIT_SHA;
  else process.env.GIT_SHA = gitSha;
  deployStatus.read = read;
  wsService.pushPlatformVersion = (payload) => { pushes.push(payload); return 2; };
  return Promise.resolve()
    .then(() => run(pushes))
    .finally(() => {
      if (savedSha === undefined) delete process.env.GIT_SHA;
      else process.env.GIT_SHA = savedSha;
      deployStatus.read = savedRead;
      wsService.pushPlatformVersion = savedPush;
    });
}

test('a rollout SIGTERM announces the successor build to open sockets, after the listener closes', async () => {
  const { server, logs, restore } = loadServer();
  try {
    const seq = [];
    const listener = {
      close(cb) { seq.push('listenerClose'); if (cb) cb(); },
      closeIdleConnections() {},
      closeAllConnections() {},
    };
    await withRollout({ read: async () => ({ deploying: true, sha: NEXT }) }, async (pushes) => {
      wsService.pushPlatformVersion = (payload) => { seq.push('push'); pushes.push(payload); return 2; };
      const order = await runCleanup(server, { listener, pool: fakePool() });
      assert.deepEqual(order, ['exit:0']);
      assert.deepEqual(pushes, [{ sha: NEXT, reason: 'rollout' }],
        'the tabs are told the build their requests land on now');
      assert.deepEqual(seq, ['listenerClose', 'push'],
        'told only once nothing they fetch next can reach this process');
      assert.ok(logs.some((l) => l.msg === 'Announced successor build to open sockets'
        && l.data.sha === NEXT && l.data.sockets === 2));
    });
  } finally {
    restore();
  }
});

test('a SIGTERM that is not a rollout says nothing', async () => {
  // Node drain, eviction, crash restart: the deployment still targets the
  // build this process is. Announcing it would only make every tab re-ask
  // for a build it already has.
  const { server, restore } = loadServer();
  try {
    await withRollout({ read: async () => ({ deploying: false, sha: OWN }) }, async (pushes) => {
      await runCleanup(server, { listener: fakeListener(), pool: fakePool() });
      assert.deepEqual(pushes, []);
    });
  } finally {
    restore();
  }
});

test('a process with no build of its own does not look', async () => {
  // Local dev, and the staging previews: GIT_SHA unset or `dev`. There is
  // no successor to name, and nothing must be read on the way out.
  const { server, restore } = loadServer();
  try {
    for (const gitSha of [null, 'dev']) {
      let reads = 0;
      await withRollout({ gitSha, read: async () => { reads += 1; return { sha: NEXT }; } }, async (pushes) => {
        await runCleanup(server, { listener: fakeListener(), pool: fakePool() });
        assert.deepEqual(pushes, []);
        assert.equal(reads, 0);
      });
    }
  } finally {
    restore();
  }
});

test('a target that cannot be read — unreachable, hung or failed — costs nothing but a log line', async () => {
  const { server, logs, restore } = loadServer();
  try {
    // No answer: the docker path with no marker, or a staging preview.
    await withRollout({ read: async () => null }, async (pushes) => {
      await runCleanup(server, { listener: fakeListener(), pool: fakePool() });
      assert.deepEqual(pushes, []);
    });
    // A rejection.
    await withRollout({ read: async () => { throw new Error('apiserver away'); } }, async (pushes) => {
      const order = await runCleanup(server, { listener: fakeListener(), pool: fakePool() });
      assert.deepEqual(order, ['exit:0']);
      assert.deepEqual(pushes, []);
      assert.ok(logs.some((l) => l.msg === 'Successor build announcement failed' && /apiserver away/.test(l.data.err)));
    });
    // A read that never settles is raced against SUCCESSOR_ANNOUNCE_TIMEOUT_MS,
    // which sits inside the drain window: the announcement is awaited
    // alongside the drain, so it can never push exit past the budget the
    // grace test pins.
    assert.ok(server.SUCCESSOR_ANNOUNCE_TIMEOUT_MS <= server.DRAIN_TIMEOUT_MS);
    await withRollout({ read: () => new Promise(() => {}) }, async (pushes) => {
      const startedAt = Date.now();
      const order = await runCleanup(server, { listener: fakeListener(), pool: fakePool() });
      assert.deepEqual(order, ['exit:0']);
      assert.deepEqual(pushes, []);
      assert.ok(Date.now() - startedAt < server.DRAIN_TIMEOUT_MS,
        'a hung read is abandoned inside the drain window, not waited on');
    });
  } finally {
    restore();
  }
});

// ── The drain waits for what is in flight (requests, background work) ──
//
// It used to wait for busy workers and shots runs alone, so a pod with
// neither exited the moment SIGTERM arrived: every handler mid-write and
// every merge a vote had set off after answering was cut, with some eighty
// seconds of the Kubernetes grace period unspent. The request count is
// src/middleware/inflight-requests.js (mounted first in server.js; this file
// shares its module instance), the registry src/services/inflight-work.js.

const http = require('node:http');
const express = require('express');
const inflightRequests = require('../src/middleware/inflight-requests');
const inflightWork = require('../src/services/inflight-work');
const lifecycleModule = require('../src/services/lifecycle');

async function withMiniApp(mount, fn) {
  const mini = express();
  mini.use(inflightRequests.inflightRequests());
  mount(mini);
  const srv = http.createServer(mini);
  await new Promise((resolve) => srv.listen(0, '127.0.0.1', resolve));
  try {
    return await fn(srv.address().port);
  } finally {
    srv.closeAllConnections?.();
    await new Promise((resolve) => srv.close(resolve));
  }
}

function withDrainEnv(value, fn) {
  const saved = process.env.PLATFORM_DRAIN_TIMEOUT_MS;
  if (value === undefined) delete process.env.PLATFORM_DRAIN_TIMEOUT_MS;
  else process.env.PLATFORM_DRAIN_TIMEOUT_MS = value;
  return Promise.resolve().then(fn).finally(() => {
    if (saved === undefined) delete process.env.PLATFORM_DRAIN_TIMEOUT_MS;
    else process.env.PLATFORM_DRAIN_TIMEOUT_MS = saved;
  });
}

test('server.js counts every request, ahead of every other middleware', () => {
  const layers = serverModule.app._router.stack
    .map((layer) => layer.name)
    .filter((name) => name !== 'query' && name !== 'expressInit');
  assert.equal(layers[0], 'trackInflightRequest');
});

test('the drain waits for a handler still answering, and closes the pool only after it has', async () => {
  const { server, logs } = loadServer();
  const seq = [];
  await withMiniApp((mini) => {
    mini.post('/api/sessions/:id/votes', async (_req, res) => {
      await new Promise((r) => setTimeout(r, 300));
      res.json({ ok: true });
      seq.push('answered');
    });
  }, async (port) => {
    const req = http.request({ host: '127.0.0.1', port, method: 'POST', path: '/api/sessions/7/votes', agent: false });
    req.on('response', (res) => res.resume());
    req.on('error', () => {});
    req.end();
    assert.ok(await until(() => inflightRequests.pending() === 1));

    const startedAt = Date.now();
    const pool = fakePool({ endImpl: async () => { seq.push('poolEnd'); } });
    const order = await runCleanup(server, { listener: fakeListener(), pool });
    const elapsed = Date.now() - startedAt;

    assert.deepEqual(order, ['exit:0']);
    assert.deepEqual(seq, ['answered', 'poolEnd']);
    assert.ok(elapsed >= 200, `cleanup waited for the handler (${elapsed}ms)`);
    const draining = logs.find((l) => l.msg === 'Draining in-flight requests and background work');
    assert.equal(draining.data.requests, 1);
    assert.equal(draining.data.deadlineMs, server.DRAIN_TIMEOUT_MS, 'the short drain outside Kubernetes');
    assert.ok(logs.some((l) => l.msg === 'In-flight requests and background work drained'));
  });
});

test('the drain waits for registered background work, such as a merge a vote set off after answering', async () => {
  const { server } = loadServer();
  const seq = [];
  inflightWork.track('merge-queue', new Promise((r) => setTimeout(r, 250)).then(() => { seq.push('merged'); }));
  const pool = fakePool({ endImpl: async () => { seq.push('poolEnd'); } });
  await runCleanup(server, { listener: fakeListener(), pool });
  assert.deepEqual(seq, ['merged', 'poolEnd']);
});

test('the deadline bounds the wait: work still running is logged by name and the exit goes on', async () => {
  const { server, logs } = loadServer();
  let release;
  inflightWork.track('timer:main-drift-poller', new Promise((r) => { release = r; }));
  try {
    await withDrainEnv('300', async () => {
      const startedAt = Date.now();
      const order = await runCleanup(server, { listener: fakeListener(), pool: fakePool() });
      const elapsed = Date.now() - startedAt;
      assert.deepEqual(order, ['exit:0']);
      assert.ok(elapsed >= 280 && elapsed < 3000, `bounded by PLATFORM_DRAIN_TIMEOUT_MS (${elapsed}ms)`);
      const warned = logs.find((l) => l.msg === 'Drain deadline passed with requests or background work in flight');
      assert.ok(warned, 'the cut is logged');
      assert.equal(warned.data.deadlineMs, 300);
      assert.deepEqual(warned.data.background.map((e) => e.name), ['timer:main-drift-poller']);
    });
  } finally {
    release();
    await new Promise((r) => setImmediate(r));
  }
});

test('an open event stream does not hold the drain', async () => {
  const { server, logs } = loadServer();
  await withMiniApp((mini) => {
    mini.get('/api/sessions/:id/stream', (_req, res) => {
      res.writeHead(200, { 'Content-Type': 'text/event-stream' });
      res.write(': open\n\n');
    });
  }, async (port) => {
    await new Promise((resolve) => {
      http.get({ host: '127.0.0.1', port, path: '/api/sessions/7/stream', agent: false }, (res) => { res.resume(); resolve(); })
        .on('error', () => {});
    });
    const startedAt = Date.now();
    await runCleanup(server, { listener: fakeListener(), pool: fakePool() });
    assert.ok(Date.now() - startedAt < 1000, 'a stream open for as long as its client likes is not waited on');
    assert.equal(logs.some((l) => l.msg === 'Drain deadline passed with requests or background work in flight'), false);
  });
});

test('the drain deadline is long only on the platform\'s Kubernetes Pods, and clamped', () => {
  const d = lifecycleModule.drainDeadlineMs;
  const short = serverModule.DRAIN_TIMEOUT_MS;
  assert.equal(d({ kubernetes: false, shortMs: short, env: {} }), short, 'docker-compose keeps the short drain');
  assert.equal(d({ kubernetes: true, shortMs: short, env: {} }), lifecycleModule.KUBERNETES_DRAIN_DEFAULT_MS);
  assert.ok(lifecycleModule.KUBERNETES_DRAIN_DEFAULT_MS >= 30000, 'a real window for a merge or a sweep to finish');
  assert.equal(d({ kubernetes: true, shortMs: short, env: { PLATFORM_DRAIN_TIMEOUT_MS: '20000' } }), 20000);
  assert.equal(d({ kubernetes: true, shortMs: short, env: { PLATFORM_DRAIN_TIMEOUT_MS: '2400000' } }), 2400000,
    'the chart\'s drainMinutes, unclamped (docs/plans/draining-releases.md)');
  assert.equal(d({ kubernetes: true, shortMs: short, env: { PLATFORM_DRAIN_TIMEOUT_MS: String(10 * 60 * 60 * 1000) } }),
    lifecycleModule.KUBERNETES_DRAIN_MAX_MS, 'never past the ceiling the chart allows');
  assert.equal(d({ kubernetes: true, shortMs: short, env: { PLATFORM_DRAIN_TIMEOUT_MS: '-5' } }), 0);
  assert.equal(d({ kubernetes: true, shortMs: short, env: { PLATFORM_DRAIN_TIMEOUT_MS: 'soon' } }),
    lifecycleModule.KUBERNETES_DRAIN_DEFAULT_MS, 'a value that is not a number is ignored');
  assert.equal(d({ kubernetes: false, shortMs: short, env: { PLATFORM_DRAIN_TIMEOUT_MS: '60000' } }), short,
    'under compose the variable can only shorten it: there is no grace above it to spend');
  assert.equal(d({ kubernetes: false, shortMs: short, env: { PLATFORM_DRAIN_TIMEOUT_MS: '1000' } }), 1000);
  // This process is configured as every test is (no APP_RUNTIME): docker.
  return withDrainEnv(undefined, () => {
    assert.equal(serverModule.shutdownDrainMs(), short);
  });
});

test('preStop, the drain and the rest of cleanup fit inside the platform Pod\'s grace period', () => {
  const fs = require('node:fs');
  const path = require('node:path');
  const chartDir = path.join(__dirname, '..', 'deploy', 'helm', 'social-vibecoding-platform');
  const chart = fs.readFileSync(path.join(chartDir, 'templates', 'platform.yaml'), 'utf8');
  const values = fs.readFileSync(path.join(chartDir, 'values.yaml'), 'utf8');
  const helpers = fs.readFileSync(path.join(chartDir, 'templates', '_helpers.tpl'), 'utf8');
  // docs/plans/draining-releases.md: one value, platform.drainMinutes, sets
  // both the drain (PLATFORM_DRAIN_TIMEOUT_MS) and the grace (that plus a
  // margin), so they cannot drift apart.
  const grace = chart.match(/terminationGracePeriodSeconds: \{\{ add \(mul \(int \.Values\.platform\.drainMinutes\) 60\) (\d+) \}\}/);
  const drainEnv = chart.match(/\{name: PLATFORM_DRAIN_TIMEOUT_MS, value: \{\{ mul \(int \.Values\.platform\.drainMinutes\) 60000 \| quote \}\}\}/);
  const preStop = chart.match(/preStop: \{exec: \{command: \["sh", "-c", "sleep (\d+)"\]\}\}/);
  const minutes = values.match(/^  drainMinutes: (\d+)$/m);
  const cap = helpers.match(/\(gt \$drain (\d+)\.0\)/);
  const floor = helpers.match(/\(lt \$drain (\d+)\.0\)/);
  assert.ok(grace && drainEnv && preStop && minutes && cap && floor, 'the chart sets the grace and the drain from drainMinutes, and bounds it');
  const marginMs = Number(grace[1]) * 1000;
  const preStopMs = Number(preStop[1]) * 1000;
  assert.ok(Number(minutes[1]) >= 10, 'a real window for a turn and what follows it to finish');
  assert.ok(Number(cap[1]) * 60 * 1000 <= lifecycleModule.KUBERNETES_DRAIN_MAX_MS,
    'the largest drain the chart allows is not clamped by the process');
  // Kubernetes counts the grace from the start of termination, preStop
  // included. After the drain, cleanup takes each of its bounded steps in
  // turn: the handler drain and the worker wait (together), the Mayor's
  // turns ended, the shots mark, the build marks, the checks hand-over and
  // this process's row, the pool close; then the leader lock: a second is
  // allowed for that.
  const afterDrainMs = serverModule.DRAIN_TIMEOUT_MS
    + 3000
    + serverModule.SHOTS_SHUTDOWN_MARK_TIMEOUT_MS
    + 3 * serverModule.BUILD_SHUTDOWN_MARK_TIMEOUT_MS
    + serverModule.POOL_CLOSE_TIMEOUT_MS
    + 1000;
  assert.ok(preStopMs + afterDrainMs < marginMs,
    `preStop ${preStopMs} + the rest ${afterDrainMs} = ${preStopMs + afterDrainMs}ms must stay below the grace's margin `
    + `over the drain (${marginMs}ms), or the kubelet SIGKILLs mid-cleanup`);
  // With no successor that registers what it holds (a rollback across the
  // registry, an eviction whose replacement never came up), the old cutover:
  // the wait for one, a minute's drain and the same steps, inside the
  // shortest grace the chart allows.
  const shortestGraceMs = Number(floor[1]) * 60 * 1000 + marginMs;
  const fallbackMs = preStopMs + serverModule.SUCCESSOR_WAIT_MS + lifecycleModule.KUBERNETES_DRAIN_DEFAULT_MS + afterDrainMs;
  assert.ok(fallbackMs < shortestGraceMs, `the fallback cutover (${fallbackMs}ms) fits the shortest grace (${shortestGraceMs}ms)`);
});

// Last, though every cleanup() above has already set it: lifecycle's flag
// cannot be unset. Once shutdown has begun nothing new starts on a process
// whose pool is about to close, whether or not the bot's loops were stopped
// (lifecycle is set first thing in cleanup()). A build already under way is
// its work item's, which the next leader carries on.
test('the gate: once shutdown has begun the bot dispatches nothing, its build lane starts nothing, and the bench lane starts no trial', async () => {
  const fs = require('node:fs');
  const path = require('node:path');
  const bot = require('../src/services/homeroom-bot');
  // Not stopped (cleanup's stop() is undone): the gate is shutdown's own.
  bot._resetForTests();
  lifecycleModule.setShuttingDown();
  const touched = [];
  const pool = { query: async (sql) => { touched.push(sql); return { rows: [] }; } };
  try {
    const started = await bot.dispatch(pool, {}, { settings: { mode: 'live' }, bot: { id: 1 } });
    assert.deepEqual(started, []);
    const lane = await bot.drainBuilds(pool, {});
    assert.equal(lane.paused, 'stopped');
    assert.equal(lane.started, 0);
    assert.deepEqual(touched, [], 'nothing is read or claimed');
  } finally {
    bot._resetForTests();
  }
  const bench = fs.readFileSync(path.join(__dirname, '..', 'src', 'services', 'bench', 'lane.js'), 'utf8');
  assert.match(bench, /function shuttingDown\(\) \{\n\s+try \{ return !!require\('\.\.\/lifecycle'\)\.isShuttingDown\(\); \} catch \{ return false; \}\n\}/);
  assert.match(bench, /if \(shuttingDown\(\)\) \{ out\.paused = 'stopped'; break; \}/, 'checked before each trial the lane would start');
});

// docs/plans/draining-releases.md: on the platform's own Kubernetes Pods a
// release no longer cuts the work the Pod started. It stops leading at once,
// keeps its listener open (a shots worker calls it by its own address) and
// finishes what it holds; only then does it close, hand over what is left and
// exit.
test('a Pod a release replaced resigns at once, keeps listening while it finishes what it holds, then exits', async () => {
  const { server, logs } = loadServer();
  const processes = require('../src/services/processes');
  const seq = [];
  const listener = fakeListener();
  const leadership = {
    identity: 'test', isLeader: true,
    resign: async () => { seq.push('resign'); },
    stop: async () => { seq.push('lock released'); },
  };
  const release = processes.hold('session', 4242);
  setTimeout(() => {
    seq.push(`turn finished (listener ${listener.events.includes('close') ? 'closed' : 'open'})`);
    release();
  }, 300);
  const startedAt = Date.now();
  const order = await runCleanup(server, {
    listener, pool: fakePool(), finishesWork: true, drainMs: 20000, successor: async () => true, leadership,
  });
  assert.deepEqual(order, ['exit:0']);
  assert.deepEqual(seq, ['resign', 'turn finished (listener open)', 'lock released'],
    'leadership goes first, the work finishes with the listener open, and the exit follows');
  assert.ok(Date.now() - startedAt >= 300, 'it waited for the turn');
  assert.ok(listener.events.includes('close'), 'the listener closes once the work is done');
  assert.ok(logs.some((l) => l.msg === "Finished this process's work"), 'and says so');
});

test('a Pod a release replaced hands over what it still holds at its drain deadline', async () => {
  const { server, logs } = loadServer();
  const processes = require('../src/services/processes');
  const release = processes.hold('sync', 5151);
  try {
    const startedAt = Date.now();
    const order = await runCleanup(server, {
      listener: fakeListener(), pool: fakePool(), finishesWork: true, drainMs: 400, successor: async () => true,
      leadership: { identity: 'test', resign: async () => {}, stop: async () => {} },
    });
    assert.deepEqual(order, ['exit:0']);
    assert.ok(Date.now() - startedAt < 15000, 'bounded by the deadline, not by the work');
    const handed = logs.find((l) => l.msg === "Drain deadline passed; handing the rest of this process's work over");
    assert.ok(handed, 'it says it is handing the work over');
    assert.deepEqual(handed.data.holds, [{ kind: 'sync', ref: '5151' }], 'and what it held');
  } finally {
    release();
  }
});

test('with no successor that registers what it holds, a Pod keeps the cutover it always had', async () => {
  const { server, logs } = loadServer();
  const processes = require('../src/services/processes');
  const seq = [];
  const listener = fakeListener();
  const release = processes.hold('session', 6161);
  try {
    const order = await runCleanup(server, {
      listener, pool: fakePool(), finishesWork: true, drainMs: 20000, successor: async () => false,
      leadership: { identity: 'test', resign: async () => { seq.push('resign'); }, stop: async () => { seq.push('lock released'); } },
    });
    assert.deepEqual(order, ['exit:0']);
    assert.deepEqual(seq, ['lock released'], 'it leads until it exits, as before');
    assert.ok(listener.events.includes('close'));
    assert.ok(logs.some((l) => l.msg === 'No process that knows what this one holds is serving; cutting over without finishing the work'));
    assert.ok(!logs.some((l) => l.msg === "Finishing this process's work before exiting"), 'and does not wait for its work');
  } finally {
    release();
  }
});
