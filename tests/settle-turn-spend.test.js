// Tests for limits.settleTurnSpend (#664) — the turn-end settlement that
// splits a CC turn's self-reported cost across the capped platform bucket
// and the display-only BYOK bucket when the worker Anthropic proxy
// switched the payer mid-turn.
//
// Covers the bucket math the settlement sites rely on:
//   1. Whole-turn BYOK (dispatch-time key) → everything in the byok bucket.
//   2. Platform turn, no observed spillover → everything in the capped bucket.
//   3. Platform turn with observed spillover → split across both buckets.
//   4. Observed spillover exceeding the turn total → clamped to the total
//      (the proxy's SSE-tee tally is an estimate; CC's costUsd is
//      authoritative).
//   5. Zero / missing total → no debit at all.
//   6. Negative / NaN observed values degrade to "no spillover".
//
// Run with: node --test tests/settle-turn-spend.test.js

const test = require('node:test');
const assert = require('node:assert/strict');

const limits = require('../src/services/limits');

// Minimal pool capturing the recordSpend upserts settleTurnSpend issues.
// The bucket is visible in the SQL's column list.
function makePool() {
  const debits = [];
  return {
    debits,
    async query(sql, params) {
      const m = /INSERT INTO llm_usage \(user_id, date, (\w+)\)/.exec(sql);
      if (m) debits.push({ column: m[1], userId: params[0], costCents: params[1] });
      return { rows: [] };
    },
  };
}

test('whole-turn BYOK → single debit in the byok bucket', async () => {
  const pool = makePool();
  const r = await limits.settleTurnSpend(pool, 7, 123, { turnByok: true, byokObservedCents: 50 });
  assert.deepEqual(r, { platformCents: 0, byokCents: 123 });
  assert.deepEqual(pool.debits, [{ column: 'byok_cost_cents', userId: 7, costCents: 123 }]);
});

test('platform turn, no spillover → single debit in the capped bucket', async () => {
  const pool = makePool();
  const r = await limits.settleTurnSpend(pool, 7, 123, { turnByok: false, byokObservedCents: 0 });
  assert.deepEqual(r, { platformCents: 123, byokCents: 0 });
  assert.deepEqual(pool.debits, [{ column: 'total_cost_cents', userId: 7, costCents: 123 }]);
});

test('platform turn with observed spillover → split across both buckets', async () => {
  const pool = makePool();
  const r = await limits.settleTurnSpend(pool, 7, 123, { byokObservedCents: 23 });
  assert.deepEqual(r, { platformCents: 100, byokCents: 23 });
  assert.deepEqual(pool.debits, [
    { column: 'total_cost_cents', userId: 7, costCents: 100 },
    { column: 'byok_cost_cents', userId: 7, costCents: 23 },
  ]);
});

test('observed spillover above the turn total is clamped to the total', async () => {
  const pool = makePool();
  const r = await limits.settleTurnSpend(pool, 7, 100, { byokObservedCents: 250 });
  assert.deepEqual(r, { platformCents: 0, byokCents: 100 });
  assert.deepEqual(pool.debits, [{ column: 'byok_cost_cents', userId: 7, costCents: 100 }]);
});

test('zero / missing total → no debit', async () => {
  const pool = makePool();
  assert.deepEqual(await limits.settleTurnSpend(pool, 7, 0, { byokObservedCents: 10 }),
    { platformCents: 0, byokCents: 0 });
  assert.deepEqual(await limits.settleTurnSpend(pool, 7, undefined, {}),
    { platformCents: 0, byokCents: 0 });
  assert.deepEqual(await limits.settleTurnSpend(pool, null, 100, {}),
    { platformCents: 0, byokCents: 0 });
  assert.equal(pool.debits.length, 0);
});

test('negative or NaN observed spillover degrades to the capped bucket', async () => {
  const pool = makePool();
  const r1 = await limits.settleTurnSpend(pool, 7, 100, { byokObservedCents: -5 });
  assert.deepEqual(r1, { platformCents: 100, byokCents: 0 });
  const r2 = await limits.settleTurnSpend(pool, 7, 100, { byokObservedCents: NaN });
  assert.deepEqual(r2, { platformCents: 100, byokCents: 0 });
  assert.ok(pool.debits.every((d) => d.column === 'total_cost_cents'));
});
