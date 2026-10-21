// Tests for limits.settleTurnSpend (#664) — the turn-end settlement that
// splits a CC turn's self-reported cost across the capped platform bucket
// and the display-only BYOK bucket when the worker Anthropic proxy
// switched the payer mid-turn.
//
// Covers the bucket math the settlement sites rely on (splitTurnSpend, which
// the durable settlement applies under its receipt; tests/turn-effects.test.js
// and tests/turn-spend-postgres.test.js drive the whole settlement):
//   1. Whole-turn BYOK (dispatch-time key) → everything in the byok bucket.
//   2. Platform turn, no observed spillover → everything in the capped bucket.
//   3. Platform turn with observed spillover → split across both buckets.
//   4. Observed spillover exceeding the turn total → clamped to the total
//      (the proxy's SSE-tee tally is an estimate; CC's costUsd is
//      authoritative).
//   5. Zero / missing total → no debit at all.
//   6. Negative / NaN observed values degrade to "no spillover".
//   7. A settlement that names no turn debits nothing: its kept calls are
//      the turn-spend-settle clock's.
//
// Run with: node --test tests/settle-turn-spend.test.js

const test = require('node:test');
const assert = require('node:assert/strict');

const limits = require('../src/services/limits');

// Minimal pool capturing any llm_usage upsert. The bucket is visible in the
// SQL's column list.
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

const { splitTurnSpend } = limits;

test('whole-turn BYOK → all in the byok bucket', () => {
  assert.deepEqual(splitTurnSpend(123, { turnByok: true, byokObservedCents: 50 }),
    { platformCents: 0, byokCents: 123 });
});

test('platform turn, no spillover → all in the capped bucket', () => {
  assert.deepEqual(splitTurnSpend(123, { turnByok: false, byokObservedCents: 0 }),
    { platformCents: 123, byokCents: 0 });
});

test('platform turn with observed spillover → split across both buckets', () => {
  assert.deepEqual(splitTurnSpend(123, { byokObservedCents: 23 }), { platformCents: 100, byokCents: 23 });
});

test('observed spillover above the turn total is clamped to the total', () => {
  assert.deepEqual(splitTurnSpend(100, { byokObservedCents: 250 }), { platformCents: 0, byokCents: 100 });
});

test('zero / missing total → nothing in either bucket', async () => {
  assert.deepEqual(splitTurnSpend(0, { byokObservedCents: 10 }), { platformCents: 0, byokCents: 0 });
  assert.deepEqual(splitTurnSpend(undefined, {}), { platformCents: 0, byokCents: 0 });
  const pool = makePool();
  assert.deepEqual(await limits.settleTurnSpend(pool, null, 100, { turnId: 't' }),
    { platformCents: 0, byokCents: 0 });
  assert.equal(pool.debits.length, 0);
});

test('negative or NaN observed spillover degrades to the capped bucket', () => {
  assert.deepEqual(splitTurnSpend(100, { byokObservedCents: -5 }), { platformCents: 100, byokCents: 0 });
  assert.deepEqual(splitTurnSpend(100, { byokObservedCents: NaN }), { platformCents: 100, byokCents: 0 });
});

test('a settlement that names no turn debits nothing: its kept calls are the clock\'s', async () => {
  const pool = makePool();
  assert.deepEqual(await limits.settleTurnSpend(pool, 7, 123, { byokObservedCents: 23 }),
    { platformCents: 0, byokCents: 0 });
  assert.deepEqual(await limits.settleTurnSpend(pool, 7, 123, { turnByok: true, turnId: null }),
    { platformCents: 0, byokCents: 0 });
  assert.equal(pool.debits.length, 0);
});
