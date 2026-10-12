'use strict';

// Platform shutdown waits for the Homeroom bot's builds to reach a saved
// point (src/services/homeroom-bot-drain.js): nothing new starts once
// shutdown has begun, the wait ends once every pipeline is finished or
// parked in a saved turn, a pipeline does not go on past a turn that ends
// during shutdown, and the deadline is honoured, logged and recorded.
//
// Run with: node --test tests/homeroom-bot-drain.test.js

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

const root = path.join(__dirname, '..');
const drain = require('../src/services/homeroom-bot-drain');
const lifecycle = require('../src/services/lifecycle');

// lifecycle's flag only ever goes one way; the tests that need it set run
// last (the gate) or stub it per test.
function withShutdown(on, fn) {
  const real = lifecycle.isShuttingDown;
  lifecycle.isShuttingDown = () => on;
  return Promise.resolve().then(fn).finally(() => { lifecycle.isShuttingDown = real; });
}

function deferred() {
  let resolve;
  const promise = new Promise((r) => { resolve = r; });
  return { promise, resolve };
}

test.beforeEach(() => drain.__resetForTests());

test('the wait resolves at once with nothing under way', async () => {
  const out = await drain.waitForSafePoint({ timeoutMs: 1000, intervalMs: 5 });
  assert.equal(out.safe, true);
  assert.deepEqual(out.midStep, []);
  assert.ok(out.waitedMs < 100);
});

test('a pipeline between steps holds the wait until it parks in a saved turn', async () => {
  const parkNow = deferred();
  const finish = deferred();
  const pipeline = drain.run({ kind: 'live_build', runId: 7, appId: 3, issueNumber: 12 }, async () => {
    await parkNow.promise;
    // What worker.execInWorker does once the turn's record is saved and its
    // process dispatched.
    drain.noteTurnDispatched(99, { mode: 'build' });
    await finish.promise;
    drain.noteTurnEnded(99, { mode: 'build' });
  });
  assert.equal(drain.snapshot().length, 1);
  assert.equal(drain.snapshot()[0].parked, false);

  let settled = null;
  const waiting = drain.waitForSafePoint({ timeoutMs: 5000, intervalMs: 5 }).then((o) => { settled = o; });
  await new Promise((r) => setTimeout(r, 30));
  assert.equal(settled, null, 'a pipeline mid-step must keep shutdown waiting');

  parkNow.resolve();
  await waiting;
  assert.equal(settled.safe, true);
  assert.equal(settled.parked.length, 1);
  assert.equal(settled.parked[0].runId, 7);
  assert.equal(settled.parked[0].step, 'its build turn');

  finish.resolve();
  await pipeline;
  assert.equal(drain.snapshot().length, 0, 'a finished pipeline is no longer tracked');
});

test('a pipeline that finishes ends the wait too', async () => {
  const finish = deferred();
  const pipeline = drain.run({ kind: 'read', appId: 1 }, () => finish.promise);
  const waiting = drain.waitForSafePoint({ timeoutMs: 5000, intervalMs: 5 });
  setTimeout(() => finish.resolve('done'), 20);
  assert.equal(await pipeline, 'done');
  assert.equal((await waiting).safe, true);
});

test('the deadline is honoured: what is still mid-step is listed with its step', async () => {
  const never = new Promise(() => {});
  drain.run({ kind: 'live_build', runId: 41, appId: 2, issueNumber: 5 }, async () => {
    drain.noteTurnDispatched(5, { mode: 'build' });
    drain.noteTurnEnded(5, { mode: 'build' });
    await never;
  });
  const startedMs = Date.now();
  const out = await drain.waitForSafePoint({ timeoutMs: 60, intervalMs: 5 });
  const elapsed = Date.now() - startedMs;
  assert.equal(out.safe, false);
  assert.ok(elapsed >= 55 && elapsed < 1000, `waited ${elapsed}ms for a 60ms deadline`);
  assert.equal(out.midStep.length, 1);
  assert.equal(out.midStep[0].runId, 41);
  assert.equal(out.midStep[0].step, 'the step after its build turn');
});

test('a deadline records one build_interrupted incident per build mid-step', async () => {
  const rows = [];
  const pool = { query: async (sql, params) => { rows.push({ sql, params }); return { rows: [] }; } };
  const written = await drain.recordMidStep(pool, [
    { kind: 'live_build', runId: 41, trialId: null, appId: 2, issueNumber: 5, step: 'the step after its build turn' },
    // Not a build (a read with no run yet): logged, never an incident.
    { kind: 'read', runId: null, trialId: null, appId: 2, issueNumber: 6, step: 'its first step' },
  ]);
  assert.equal(written, 1);
  assert.equal(rows.length, 1);
  assert.match(rows[0].sql, /INSERT INTO events/);
  assert.equal(rows[0].params[1], 2, 'the app');
  const meta = JSON.parse(rows[0].params[4]);
  assert.equal(meta.kind, 'build_interrupted');
  assert.equal(meta.runId, 41);
  assert.equal(meta.why, 'shutdown deadline passed during the step after its build turn');
  assert.equal(meta.outcome, 'exited_mid_step');
});

test('a turn that ends during shutdown holds its pipeline, which counts as safe', async () => {
  await withShutdown(true, async () => {
    let held = null;
    drain.run({ kind: 'live_build', runId: 8 }, async () => {
      drain.noteTurnDispatched(1, { mode: 'build' });
      held = drain.holdAfterTurn();
      await new Promise(() => {});
    });
    await new Promise((r) => setImmediate(r));
    assert.equal(held, true);
    const out = await drain.waitForSafePoint({ timeoutMs: 50, intervalMs: 5 });
    assert.equal(out.safe, true);
  });
});

test('no hold outside shutdown, outside a pipeline, or in a pipeline that has ended', async () => {
  let inside = null;
  await drain.run({ kind: 'read' }, () => { inside = drain.holdAfterTurn(); });
  assert.equal(inside, false, 'not shutting down');
  await withShutdown(true, async () => {
    assert.equal(drain.holdAfterTurn(), false, 'a person\'s turn is never held');
    // A timer a pipeline set runs in its context after it ended.
    let later = null;
    const fired = deferred();
    await drain.run({ kind: 'read' }, () => {
      setTimeout(() => { later = drain.holdAfterTurn(); fired.resolve(); }, 10);
    });
    await fired.promise;
    assert.equal(later, false);
  });
});

test('a pipeline started from another one\'s context is tracked on its own', async () => {
  const inner = deferred();
  let innerPromise = null;
  await drain.run({ kind: 'live_build', runId: 1 }, () => {
    innerPromise = drain.run({ kind: 'shadow_build', runId: 2 }, () => inner.promise);
  });
  assert.deepEqual(drain.snapshot().map((p) => p.runId), [2]);
  inner.resolve();
  await innerPromise;
});

test('the deadline: 75s on Kubernetes, the handler drain elsewhere, an override clamped', () => {
  assert.equal(drain.deadlineMs({ KUBERNETES_SERVICE_HOST: '10.0.0.1' }), 75000);
  assert.equal(drain.deadlineMs({}, { fallbackMs: 5000 }), 5000);
  assert.equal(drain.deadlineMs({ HOMEROOM_BOT_DRAIN_TIMEOUT_MS: '20000' }), 20000);
  assert.equal(drain.deadlineMs({ HOMEROOM_BOT_DRAIN_TIMEOUT_MS: '600000', KUBERNETES_SERVICE_HOST: 'x' }), drain.MAX_DEADLINE_MS);
  assert.equal(drain.deadlineMs({ HOMEROOM_BOT_DRAIN_TIMEOUT_MS: '-3' }), 0);
  assert.equal(drain.deadlineMs({ HOMEROOM_BOT_DRAIN_TIMEOUT_MS: 'soon', KUBERNETES_SERVICE_HOST: 'x' }), 75000);
});

test('guard: the bot drain and the rest of cleanup fit inside the Pod\'s termination grace', () => {
  const yaml = fs.readFileSync(path.join(root, 'deploy', 'helm', 'social-vibecoding-platform', 'templates', 'platform.yaml'), 'utf8');
  const grace = yaml.match(/terminationGracePeriodSeconds:\s*(\d+)/);
  assert.ok(grace, 'terminationGracePeriodSeconds not found in platform.yaml');
  const preStop = yaml.match(/preStop:[^\n]*sleep (\d+)/);
  assert.ok(preStop, 'the preStop sleep not found in platform.yaml');
  const budgetMs = (Number(grace[1]) - Number(preStop[1])) * 1000;

  const serverJs = fs.readFileSync(path.join(root, 'server.js'), 'utf8');
  const constant = (name) => {
    const m = serverJs.match(new RegExp(`const ${name} = (\\d+);`));
    assert.ok(m, `${name} not found in server.js`);
    return Number(m[1]);
  };
  // After the wait: the incident mark, the shots mark, the build mark, the
  // checks release (each bounded by its own timer) and the pool close.
  const after = constant('BUILD_SHUTDOWN_MARK_TIMEOUT_MS') * 3
    + constant('SHOTS_SHUTDOWN_MARK_TIMEOUT_MS') + constant('POOL_CLOSE_TIMEOUT_MS');
  const deadline = Math.max(drain.K8S_DEADLINE_MS, drain.MAX_DEADLINE_MS);
  assert.ok(deadline + after < budgetMs,
    `the bot drain (${deadline}ms) plus the rest of cleanup (${after}ms) must stay below ` +
    `terminationGracePeriodSeconds minus the preStop sleep (${budgetMs}ms)`);
  // And the bounded wait is what cleanup uses.
  assert.match(serverJs, /botDrain\.waitForSafePoint\(\{ timeoutMs: botDeadlineMs \}\)/);
  assert.match(serverJs, /botDrain\.deadlineMs\(process\.env, \{ fallbackMs: DRAIN_TIMEOUT_MS \}\)/,
    'off Kubernetes the wait must run no longer than the handler drain the compose grace is sized for');
});

test('the worker marks a bot turn parked once its record is saved, and holds it past its end on shutdown', () => {
  const src = fs.readFileSync(path.join(root, 'src', 'services', 'worker.js'), 'utf8');
  const persisted = src.indexOf('const activeTurnPersist = await _persistActiveTurn(');
  const dispatched = src.indexOf('providerDispatched = true;', persisted);
  const parked = src.indexOf('botDrain.noteTurnDispatched(sessionId', dispatched);
  const consumed = src.indexOf('await _consumeJournal(containerName, journal', parked);
  const hold = src.indexOf('if (botDrain.holdAfterTurn()) {', consumed);
  const journalRm = src.indexOf("execWorkerCommand(containerName, ['rm', '-f', journal])", hold);
  const cleared = src.indexOf('await finishTurn(sessionId, { turnId: durableTurnId, journal });', hold);
  assert.ok(persisted > 0 && dispatched > persisted && parked > dispatched,
    'a turn is parked only after its record is saved and its process dispatched');
  assert.ok(consumed > parked && hold > consumed, 'the hold comes once the journal has ended');
  assert.ok(journalRm > hold && cleared > hold, 'and before the journal is removed or the record cleared');
  assert.match(src.slice(hold, hold + 600), /await new Promise\(\(\) => \{\}\);/,
    'a held turn never returns (a `return` would run the finally that clears its record)');
});

test('the bench lane starts no trial once shutdown has begun, and tracks the ones it starts', () => {
  const src = fs.readFileSync(path.join(root, 'src', 'services', 'bench', 'lane.js'), 'utf8');
  assert.match(src, /if \(drain\.refusing\(\)\) \{ out\.paused = 'stopped'; break; \}/);
  assert.match(src, /drain\.run\(\s*\{ kind: 'bench_trial', trialId: claim\.id \},\s*\(\) => executeTrial\(/);
});

// Last: lifecycle's flag cannot be unset.
test('the gate: once shutdown has begun the bot dispatches nothing and its build lane starts nothing', async () => {
  const bot = require('../src/services/homeroom-bot');
  const touched = [];
  const pool = { query: async (sql) => { touched.push(sql); return { rows: [] }; } };
  lifecycle.setShuttingDown();
  const started = await bot.dispatch(pool, {}, { settings: { mode: 'live' }, bot: { id: 1 } });
  assert.deepEqual(started, []);
  const lane = await bot.drainBuilds(pool, {});
  assert.equal(lane.paused, 'stopped');
  assert.equal(lane.started, 0);
  assert.deepEqual(touched, [], 'nothing is read or claimed');
  assert.equal(drain.refusing(), true);
});
