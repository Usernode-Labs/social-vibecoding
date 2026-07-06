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

// ── #361: system-token budget helpers ──────────────────────────────────

// A pool whose query routes by SQL so the cap read (platform_settings)
// and the spend read (system_token_usage) can return distinct values.
function makeRoutingPool({ settingValue, sysSpent } = {}) {
  const calls = [];
  return {
    calls,
    async query(sql, params) {
      calls.push({ sql, params });
      if (/platform_settings/.test(sql)) {
        return { rows: settingValue == null ? [] : [{ value: String(settingValue) }] };
      }
      if (/system_token_usage/.test(sql)) {
        // SELECT path returns the day's spend; INSERT path returns nothing.
        if (/^\s*SELECT/i.test(sql)) {
          return { rows: sysSpent == null ? [] : [{ cost_cents: sysSpent }] };
        }
        return { rows: [] };
      }
      return { rows: [] };
    },
  };
}

test('getSystemTokensLimitCents defaults to 2500 when unset', async () => {
  limits.invalidate(limits.KEY_SYSTEM);
  const pool = makeRoutingPool({ settingValue: null });
  assert.equal(await limits.getSystemTokensLimitCents(pool), 2500);
  limits.invalidate(limits.KEY_SYSTEM);
});

test('getSystemTokensLimitCents honors a stored override', async () => {
  limits.invalidate(limits.KEY_SYSTEM);
  const pool = makeRoutingPool({ settingValue: 5000 });
  assert.equal(await limits.getSystemTokensLimitCents(pool), 5000);
  limits.invalidate(limits.KEY_SYSTEM);
});

test('checkSystemBudget ok under cap with remaining', async () => {
  limits.invalidate(limits.KEY_SYSTEM);
  const pool = makeRoutingPool({ settingValue: 2500, sysSpent: 1000 });
  const r = await limits.checkSystemBudget(pool);
  assert.equal(r.error, undefined);
  assert.equal(r.ok, true);
  assert.equal(r.remaining, 1500);
  limits.invalidate(limits.KEY_SYSTEM);
});

test('checkSystemBudget errors when at/over cap', async () => {
  limits.invalidate(limits.KEY_SYSTEM);
  const pool = makeRoutingPool({ settingValue: 2500, sysSpent: 2500 });
  const r = await limits.checkSystemBudget(pool);
  assert.match(r.error, /System token budget reached \(\$25\.00\)/);
  limits.invalidate(limits.KEY_SYSTEM);
});

test('recordSystemSpend upserts accumulating cost on the date key', async () => {
  const pool = makePool();
  await limits.recordSystemSpend(pool, 42);
  assert.equal(pool.calls.length, 1);
  const { sql, params } = pool.calls[0];
  assert.match(sql, /INSERT INTO system_token_usage/);
  assert.match(sql, /ON CONFLICT \(date\)/);
  assert.match(sql, /system_token_usage\.cost_cents \+ EXCLUDED\.cost_cents/);
  assert.deepEqual(params, [42]);
});

test('recordSystemSpend no-ops on non-positive cost', async () => {
  const pool = makePool();
  await limits.recordSystemSpend(pool, 0);
  await limits.recordSystemSpend(pool, -5);
  assert.equal(pool.calls.length, 0);
});

test('recordSystemSpend swallows DB errors', async () => {
  const pool = makePool({ fail: true });
  await assert.doesNotReject(() => limits.recordSystemSpend(pool, 10));
});
