'use strict';

// Background work the shutdown drain did not see (14 Oct 2026, the first
// release after #5141 replaced a pod running it). The drain waits for what
// services/inflight-work.js holds, and leader timers register their ticks
// there; two pieces of work that are not leader timers did not, and ran on
// after the pool closed ("Cannot use a pool after calling end on the pool"):
// a Workshop board-change reconcile and the session sweeper's proposal
// measurement (a clock of the workflow now, services/proposal-scans.js).
// And app-heal held the drain 40 s waiting on a rollout that could never
// finish (its own test is in tests/app-heal.test.js).

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const lifecycle = require('../src/services/lifecycle');
const inflightWork = require('../src/services/inflight-work');
const llm = require('../src/services/llm');
const themes = require('../src/services/workshop-themes');

const SERVER = fs.readFileSync(path.join(__dirname, '..', 'server.js'), 'utf8');

function holdingPool() {
  const pool = { queries: 0, async query() { pool.queries += 1; return new Promise(() => {}); } };
  return pool;
}

test('a board-change reconcile under way is held for the drain; none starts once shutdown has begun', async (t) => {
  t.mock.method(llm, 'isEnabled', () => true);
  t.mock.timers.enable({ apis: ['setTimeout'] });
  let shutting = false;
  t.mock.method(lifecycle, 'isShuttingDown', () => shutting);

  const running = holdingPool();
  assert.equal(themes.noteBoardChange(running, { appId: 41 }), true);
  t.mock.timers.tick(10 * 60 * 1000);
  await new Promise((r) => setImmediate(r));
  assert.equal(running.queries, 1, 'the reconcile started');
  assert.ok(inflightWork.snapshot().some((w) => w.name === 'workshop-themes:change'), 'and the drain can see it');

  const late = holdingPool();
  assert.equal(themes.noteBoardChange(late, { appId: 42 }), true);
  shutting = true;
  t.mock.timers.tick(10 * 60 * 1000);
  await new Promise((r) => setImmediate(r));
  assert.equal(late.queries, 0, 'a change due after shutdown began starts nothing');
});

// 14 Oct 2026, 16:39: holding the whole sweeper tick held the drain to its
// 60s deadline while one pass was minutes into a staging rebuild, which a
// shutdown leaves to be re-driven anyway. The session sweeper is gone: what
// is left of it is the turn watchdog, a leader timer (held for the drain
// while a tick runs, none started once shutdown has begun), and the
// measurement is a clock of the workflow, whose run stops at its next row
// when the workflow runtime is stopped.
test('the turn watchdog starts nothing on shutdown, and the measurement stops at its next row', () => {
  assert.doesNotMatch(SERVER, /sessionSweeperHandle|singleFlight\('session-sweeper'/, 'the session sweeper is gone');
  assert.match(SERVER, /leaderTimers\.every\('turn-watchdog', singleFlight\('turn-watchdog', async \(\) => \{\s+if \(lifecycle\.isShuttingDown\(\)\) return;/);
  assert.doesNotMatch(SERVER, /inflightWork\.track\('proposal-measure'/, 'the measurement is not the drain\'s to wait for');

  const scans = fs.readFileSync(path.join(__dirname, '..', 'src/services/proposal-scans.js'), 'utf8');
  const measure = scans.slice(scans.indexOf('async function measurePromoted('), scans.indexOf('// ── A check main has fixed'));
  assert.match(measure, /for \(const sessions of byApp\.values\(\)\) \{\s+if \(shouldStop\(\)\) break;/,
    'the proposal measurement stops before its next app');
  assert.match(measure, /for \(const session of ready\) \{\s+if \(shouldStop\(\)\) break;/,
    'and before its next write');
  const clocks = fs.readFileSync(path.join(__dirname, '..', 'src/workflow/clock/services.ts'), 'utf8');
  assert.match(clocks, /measurePromoted\(pool, \{ shouldStop: stopped\(ctx\) \}\)/, 'its stop is the run\'s signal');
  // Which stopping the runtime aborts (cleanup() stops it at once without a
  // drain, or at the drain's deadline).
  const kernel = fs.readFileSync(path.join(__dirname, '..', 'src/workflow/kernel/index.ts'), 'utf8');
  assert.match(kernel, /execute\(service, w, stopping\.signal\)/);
  assert.match(kernel, /async stop\(\) \{\n\s+stopping\.abort\(\);/);
  const work = fs.readFileSync(path.join(__dirname, '..', 'src/workflow/kernel/services.ts'), 'utf8');
  assert.match(work, /stopping\?\.addEventListener\('abort', onStop, \{ once: true \}\);/);
});

// Last: shutting down cannot be undone in this process.
test('whenShuttingDown settles once shutdown begins, and not before', async () => {
  let settled = false;
  lifecycle.whenShuttingDown().then(() => { settled = true; });
  await new Promise((r) => setImmediate(r));
  assert.equal(settled, false);
  lifecycle.setShuttingDown();
  await lifecycle.whenShuttingDown();
  assert.equal(settled, true);
  assert.equal(lifecycle.isShuttingDown(), true);
});
