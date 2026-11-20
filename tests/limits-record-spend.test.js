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
//   4. #2598: a successful write announces the new weekly figure to the
//      spender's own sockets, so the live credit meter ticks during a turn
//      rather than only once it ends. A failed write announces nothing.
//
// Run with: node --test tests/limits-record-spend.test.js

const test = require('node:test');
const assert = require('node:assert/strict');

const limits = require('../src/services/limits');
const budgetLive = require('../src/services/budget-live');

// #2598: recordSpend now fires a coalesced budget push, and that push reads a
// snapshot through the SAME pool. So a bare `pool.calls.length` no longer
// counts what these tests are about — filter to the spend upsert itself.
const upserts = (pool) => pool.calls.filter((c) => /INSERT INTO llm_usage/.test(c.sql)
  && /(total|byok)_cost_cents/.test(c.sql));

// …and the push coalesces per user for a window, so a leading edge in one
// test would be swallowed by the previous test's window. Start each one quiet.
test.beforeEach(() => budgetLive._reset());

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
  assert.equal(upserts(pool).length, 1);
  const { sql, params } = upserts(pool)[0];
  assert.match(sql, /INSERT INTO llm_usage/);
  assert.match(sql, /total_cost_cents/);
  assert.doesNotMatch(sql, /byok_cost_cents/);
  assert.match(sql, /ON CONFLICT \(user_id, date\)/);
  assert.deepEqual(params, [7, 12.5]);
});

test('BYOK spend upserts into byok_cost_cents only', async () => {
  const pool = makePool();
  await limits.recordSpend(pool, 7, 3, { byok: true });
  assert.equal(upserts(pool).length, 1);
  const { sql, params } = upserts(pool)[0];
  assert.match(sql, /INSERT INTO llm_usage/);
  assert.match(sql, /byok_cost_cents/);
  assert.doesNotMatch(sql, /total_cost_cents/);
  assert.match(sql, /ON CONFLICT \(user_id, date\)/);
  assert.deepEqual(params, [7, 3]);
});

test('explicit byok:false routes to the capped column', async () => {
  const pool = makePool();
  await limits.recordSpend(pool, 9, 1, { byok: false });
  assert.equal(upserts(pool).length, 1);
  assert.match(upserts(pool)[0].sql, /total_cost_cents/);
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

// ── #2598: the live credit meter's recording point ─────────────────────
//
// This is where the included OpenRouter key's spend lands too
// (routes/sessions.js sharedPoolCodexSpend debits through recordSpend), so
// it is the hook that makes "$x left this week" move for that venue at all.
// The push's own behaviour — coalescing, the mid-turn overlay, tolerance —
// lives in tests/budget-live-push.test.js.

function captureNotify() {
  const calls = [];
  const original = budgetLive.notifySpend;
  budgetLive.notifySpend = (pool, userId) => { calls.push(userId); return null; };
  return { calls, restore: () => { budgetLive.notifySpend = original; } };
}

test('a recorded debit announces the new weekly figure to that user', async () => {
  const cap = captureNotify();
  try {
    await limits.recordSpend(makePool(), 7, 12.5);
    await limits.recordSpend(makePool(), 8, 3, { byok: true });
    assert.deepEqual(cap.calls, [7, 8],
      'both buckets move a meter — the BYOK figure is rendered beside the capped one');
  } finally { cap.restore(); }
});

test('a debit that did not land announces nothing', async () => {
  const cap = captureNotify();
  try {
    await limits.recordSpend(makePool({ fail: true }), 7, 12.5);
    await limits.recordSpend(makePool(), 7, 0);
    await limits.recordSpend(makePool(), null, 5);
    assert.deepEqual(cap.calls, []);
  } finally { cap.restore(); }
});

// ── #1088: the own-key switch notice is gone ────────────────────────────
// claimByokSwitchNotice stamped llm_usage.byok_notice_at the first time a
// person was told their own Anthropic key had taken over. People's own
// Anthropic keys went in task 2275, so nothing switches and nothing is told.
test('the own-key switch notice went with people\'s own Anthropic keys', () => {
  assert.equal('claimByokSwitchNotice' in limits, false);
  assert.equal('loadUserApiKey' in limits, false);
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

// ── #1788: the weekly window reads the same rows recordSpend writes ──────
//
// There is deliberately NO second ledger and no change to recordSpend: the
// day rows above ARE the week, summed from the Monday. What that buys is
// that a spend recorded once counts against both caps, and it is worth
// pinning because the alternative (a `llm_usage_weekly` table, or a
// running counter) is the obvious design and would drift.

test('a recorded spend needs no weekly counterpart — the day row is the unit', async () => {
  const pool = makePool();
  await limits.recordSpend(pool, 7, 12.5);
  assert.equal(upserts(pool).length, 1, 'one WRITE, exactly as before');
  assert.doesNotMatch(upserts(pool)[0].sql, /week/i,
    'nothing weekly is written; the week is derived at read time');
  // #2598 added a READ after it — the snapshot the live meter is pushed —
  // and that one does ask for the week. Everything it issues is a SELECT.
  for (const call of pool.calls) {
    if (upserts(pool).includes(call)) continue;
    assert.match(call.sql.trim(), /^SELECT/i, 'the push reads; it must never write');
  }
});

test('the weekly read sums the capped column of the day rows, from the Monday', async () => {
  const calls = [];
  const pool = {
    async query(sql, params) {
      calls.push({ sql, params });
      return { rows: [{ total: '412.75' }] };
    },
  };
  const spent = await limits.getWeeklySpentCents(
    pool, 7, { now: new Date('2026-09-10T09:00:00.000Z') }
  );
  assert.equal(spent, 412.75, 'fractional cents survive, same as the day read');
  assert.equal(calls.length, 1);
  const { sql, params } = calls[0];
  assert.match(sql, /SELECT SUM\(total_cost_cents\) FROM llm_usage WHERE user_id = \$1 AND date >= \$2\), 0\)\s*\+ COALESCE\(\(SELECT SUM\(cents\) FROM turn_spend\s+WHERE user_id = \$1 AND settled_at IS NULL AND NOT byok AND created_at >= \$2::date\), 0\) AS total/,
    'the capped column, with what running turns spent and no turn settled yet (turn_spend) — BYOK spend is display-only and must not consume a cap');
  // #2571: the same statement also sums the BYOK column, under its own
  // alias, because the drawer's own-key figure moved to this window too.
  // getWeeklySpentCents returns only the capped half, which is what this
  // test just asserted.
  assert.match(sql, /SELECT SUM\(byok_cost_cents\) FROM llm_usage[\s\S]*AND byok AND created_at >= \$2::date\), 0\) AS byok/,
    'the display figure rides along rather than costing a second round trip');
  assert.match(sql, /user_id = \$1/, 'one user, not the platform pool');
  assert.deepEqual(params, [7, '2026-09-07'], 'the Monday of that Thursday, inclusive');
});

test('BYOK spend never lands in the column the weekly cap reads', async () => {
  const pool = makePool();
  await limits.recordSpend(pool, 7, 50, { byok: true });
  assert.match(pool.calls[0].sql, /byok_cost_cents/);
  assert.doesNotMatch(pool.calls[0].sql, /total_cost_cents/,
    'so a user on their own key can spend all week without touching the allowance');
});

test('an empty week reads as zero rather than NULL', async () => {
  // COALESCE, not a bare SUM: a user with no rows since Monday would
  // otherwise come back NULL and compare falsely against the cap.
  const pool = { async query() { return { rows: [{ total: 0 }] }; } };
  assert.equal(await limits.getWeeklySpentCents(pool, 7), 0);
  const empty = { async query() { return { rows: [] }; } };
  assert.equal(await limits.getWeeklySpentCents(empty, 7), 0,
    'and a missing row is zero too, not NaN');
});
