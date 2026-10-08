// The per-app run-time estimate (src/services/run-estimate.js): the median
// cost of a project's recent settled runs, in the shape the routes attach to
// in-flight rows (`run_eta`) and the card's progress bar words as "about
// 4 min".
//
// The pool is stubbed at its one seam (`query`), because what this service
// IS is two reads plus a median; the SQL itself runs against the real schema
// on the platform. A stub returns rows per call, counted, so the cache is
// observable: a second call inside the TTL must not requery.
//
// Run with: node --test tests/run-estimate.test.js

const test = require('node:test');
const assert = require('node:assert/strict');
const estimate = require('../src/services/run-estimate');

function stubPool(pages) {
  // `pages`: an array of result sets, one per query, in call order. Each is
  // `{ rows }` or a function(call) -> { rows }.
  let n = 0;
  const calls = [];
  return {
    calls,
    async query(sql, params) {
      const page = pages[Math.min(n, pages.length - 1)];
      n += 1;
      calls.push({ n, sql, params });
      return typeof page === 'function' ? page({ n, sql, params }) : page;
    },
  };
}

test('medians: build totalMs plus checksMs per row, shots added when the app has them', async () => {
  estimate.clearCacheForTests();
  const pool = stubPool([
    // Run-cost rows: 60s, 100s, 200s build+checks → median 100s
    { rows: [
      { checks_ms: '50000', build_ms: '50000' },
      { checks_ms: '100000', build_ms: null },  // legacy row: checksMs alone
      { checks_ms: '150000', build_ms: '50000' },
    ] },
    // Shot rows: 20s, 40s → median 30s
    { rows: [{ took_ms: '20000' }, { took_ms: '40000' }] },
  ]);
  const out = await estimate.estimate(pool, 1);
  assert.deepEqual(out, { ms: 130000, samples: 3 });
  assert.match(pool.calls[0].sql, /chat_sessions/);
  assert.match(pool.calls[1].sql, /shot_runs/);
  assert.equal(pool.calls[0].params[0], 1, 'the app scopes both reads');
});

test('an even sample set medians between its middle two', async () => {
  estimate.clearCacheForTests();
  const pool = stubPool([
    { rows: [
      { checks_ms: '10000', build_ms: '10000' },
      { checks_ms: '30000', build_ms: '10000' },
    ] },
    { rows: [] },
  ]);
  const out = await estimate.estimate(pool, 2);
  assert.equal(out.ms, 30000, '(20s + 40s) / 2');
  assert.equal(out.samples, 2);
});

test('honest nulls when no run has settled yet', async () => {
  estimate.clearCacheForTests();
  const pool = stubPool([{ rows: [] }, { rows: [] }]);
  assert.equal(await estimate.estimate(pool, 3), null);
});

test('junk values do not count: non-numeric and negative costs are skipped', async () => {
  estimate.clearCacheForTests();
  const pool = stubPool([
    { rows: [
      { checks_ms: 'abc', build_ms: '5000' },
      { checks_ms: '-5', build_ms: '5000' },
      { checks_ms: '40000', build_ms: '5000' },
    ] },
    { rows: [] },
  ]);
  const out = await estimate.estimate(pool, 4);
  assert.deepEqual(out, { ms: 45000, samples: 1 });
});

test('the cache: a second call inside the TTL requeries nothing', async () => {
  estimate.clearCacheForTests();
  const pool = stubPool([
    { rows: [{ checks_ms: '60000', build_ms: '0' }] },
    { rows: [] },
  ]);
  const first = await estimate.estimate(pool, 5);
  const second = await estimate.estimate(pool, 5);
  assert.equal(first.ms, 60000);
  assert.deepEqual(second, first);
  assert.equal(pool.calls.length, 2, 'one run read + one shots read, once');
  estimate.clearCacheForTests();
  const fresh = await estimate.estimate(stubPool([
    { rows: [{ checks_ms: '120000', build_ms: '0' }] },
    { rows: [] },
  ]), 5);
  assert.equal(fresh.ms, 120000, 'a cleared cache reads again');
});

test('runInFlight: pending non-deferred checks, or the shots in flight', () => {
  assert.equal(estimate.runInFlight({ check_state: 'pending', check_phase: 'building' }), true);
  assert.equal(estimate.runInFlight({ check_state: 'pending', check_phase: 'testing' }), true);
  assert.equal(estimate.runInFlight({ check_state: 'pending', check_phase: 'deferred' }), false,
    'a deferred run tests nothing');
  assert.equal(estimate.runInFlight({ check_state: 'passing' }), false);
  assert.equal(estimate.runInFlight({ status: 'merged', check_state: 'pending' }), false);
  assert.equal(estimate.runInFlight({}), false);
  assert.equal(estimate.runInFlight(null), false);

  const fresh = new Date(Date.now() - 60 * 1000).toISOString();
  assert.equal(estimate.runInFlight({ check_state: 'passing', shots: { state: 'exploring', updatedAt: fresh } }), true);
  assert.equal(estimate.runInFlight({ check_state: 'passing', shots: { state: 'planned', updatedAt: fresh } }), true);
  assert.equal(estimate.runInFlight({
    check_state: 'passing',
    shots: { state: 'planned', updatedAt: new Date(Date.now() - 90 * 60 * 1000).toISOString() },
  }), false, 'a planned run past the idle threshold has not started');
  assert.equal(estimate.runInFlight({
    check_state: 'passing',
    shots: { state: 'failed', automaticRetryPending: true, updatedAt: fresh },
  }), true, 'an interrupted run the sweep restarts is under way');
  assert.equal(estimate.runInFlight({
    check_state: 'passing',
    shots: { state: 'failed', automaticRetryPending: false, updatedAt: fresh },
  }), false);
  assert.equal(estimate.runInFlight({ check_state: 'passing', shots: { state: 'verified' } }), false);
});
