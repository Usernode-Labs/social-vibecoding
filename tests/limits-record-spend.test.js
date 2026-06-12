// Tests for limits.recordSpend (#119) — the shared daily-ledger upsert
// every spend site routes through.
//
// Covers the three guarantees the call sites rely on:
//   1. Bucket routing: platform spend → total_cost_cents (the capped
//      column), BYOK spend → byok_cost_cents (display only).
//   2. The no-op guard: missing user / non-positive cost issues no
//      query at all (the "fallback template fired" path).
//   3. Error swallowing: a DB failure is logged, never thrown — billing
//      bookkeeping must not fail the request that incurred the spend.
//
// Run with: node --test tests/limits-record-spend.test.js

const test = require('node:test');
const assert = require('node:assert/strict');

const limits = require('../src/services/limits');

// ── Mock pool ───────────────────────────────────────────────────────────
function makePool({ fail } = {}) {
  const calls = [];
  return {
    calls,
    async query(sql, params) {
      calls.push({ sql, params });
      if (fail) throw new Error('connection refused');
      return { rows: [] };
    },
  };
}

test('platform spend upserts into total_cost_cents only', async () => {
  const pool = makePool();
  await limits.recordSpend(pool, 7, 12.5);
  assert.equal(pool.calls.length, 1);
  const { sql, params } = pool.calls[0];
  assert.match(sql, /INSERT INTO llm_usage/);
  assert.match(sql, /total_cost_cents/);
  assert.doesNotMatch(sql, /byok_cost_cents/);
  assert.match(sql, /ON CONFLICT \(user_id, date\)/);
  assert.deepEqual(params, [7, 12.5]);
});

test('BYOK spend upserts into byok_cost_cents only', async () => {
  const pool = makePool();
  await limits.recordSpend(pool, 7, 3, { byok: true });
  assert.equal(pool.calls.length, 1);
  const { sql, params } = pool.calls[0];
  assert.match(sql, /INSERT INTO llm_usage/);
  assert.match(sql, /byok_cost_cents/);
  assert.doesNotMatch(sql, /total_cost_cents/);
  assert.match(sql, /ON CONFLICT \(user_id, date\)/);
  assert.deepEqual(params, [7, 3]);
});

test('explicit byok:false routes to the capped column', async () => {
  const pool = makePool();
  await limits.recordSpend(pool, 9, 1, { byok: false });
  assert.equal(pool.calls.length, 1);
  assert.match(pool.calls[0].sql, /total_cost_cents/);
});

test('no-ops on zero, negative, NaN, and missing cost', async () => {
  const pool = makePool();
  await limits.recordSpend(pool, 7, 0);
  await limits.recordSpend(pool, 7, -1, { byok: true });
  await limits.recordSpend(pool, 7, NaN);
  await limits.recordSpend(pool, 7, undefined);
  assert.equal(pool.calls.length, 0);
});

test('no-ops on a missing user id', async () => {
  const pool = makePool();
  await limits.recordSpend(pool, null, 5);
  await limits.recordSpend(pool, undefined, 5, { byok: true });
  assert.equal(pool.calls.length, 0);
});

test('swallows DB errors instead of throwing', async () => {
  const pool = makePool({ fail: true });
  await assert.doesNotReject(() => limits.recordSpend(pool, 7, 5, { byok: true }));
  assert.equal(pool.calls.length, 1);
});
