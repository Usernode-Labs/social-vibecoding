'use strict';

// Background work the shutdown drain did not see (14 Oct 2026, the first
// release after #5141 replaced a pod running it). The drain waits for what
// services/inflight-work.js holds, and leader timers register their ticks
// there; two pieces of work that are not leader timers did not, and ran on
// after the pool closed ("Cannot use a pool after calling end on the pool"):
// a Workshop board-change reconcile and the session sweeper's proposal
// measurement. And app-heal held the drain 40 s waiting on a rollout that
// could never finish (its own test is in tests/app-heal.test.js).

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

test('the session sweeper is held for the drain, and its long loops stop at their next row on shutdown', () => {
  assert.match(SERVER, /sessionSweeperHandle = setInterval\(\(\) => inflightWork\.track\('timer:session-sweeper', async \(\) => \{\s+if \(lifecycle\.isShuttingDown\(\)\) return;/);
  assert.match(SERVER, /\}\), config\.sessionSweepIntervalMs\)\.unref\(\);/);
  assert.match(SERVER, /if \(healed >= MAX_HEALS_PER_SWEEP \|\| lifecycle\.isShuttingDown\(\)\) break;/, 'the staging heal starts no rebuild during shutdown');
  assert.match(SERVER, /for \(const session of rows\) \{\s+if \(lifecycle\.isShuttingDown\(\)\) break;\s+\/\/ A session mid-turn is about to move its own head/,
    'the proposal measurement stops before its next write');
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
