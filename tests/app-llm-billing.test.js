// Tests for the app-LLM proxy billing pieces (issue #34) —
// resolveAppPayer (the grant-scoped limit-first payer matrix),
// recordAppSpend (the per-app ledger upsert), and the spend-meter
// header serialization (issue #655), exported from
// src/routes/app-llm-proxy.js. Extends the patterns in
// limits-resolve-billing-path.test.js / limits-record-spend.test.js.
//
// Run with: node --test tests/app-llm-billing.test.js

const { test, beforeEach } = require('node:test');
const assert = require('node:assert/strict');

const limits = require('../src/services/limits');
const secrets = require('../src/services/secrets');
const {
  resolveAppPayer,
  recordAppSpend,
  spentCentsHeaderValue,
} = require('../src/routes/app-llm-proxy');

// At-rest encryption key (services/secrets.js KDF input) — not a
// signing key. Same value the old shared JWT_SECRET held; the split was
// a rename, so existing ciphertext keeps decrypting.
const DATA_KEY = 'test-jwt-secret';
const USER_KEY = 'sk-ant-test-123';
const GOOD_KEY_ENC = secrets.encrypt(USER_KEY, DATA_KEY);

// Same mock-pool shape as limits-resolve-billing-path.test.js, plus
// app_llm_usage capture for the settlement tests.
function makePool({
  userLimit = 2500,
  userSpent = 0,
  // #1788: the weekly layer, defaulted OFF (0 = "this cap does not
  // apply", per limits.resolveCaps) so every pre-existing case below
  // still describes a daily-only account.
  weeklyLimit = 0,
  weeklySpent = 0,
  weeklyOverride = null,
  globalLimit = 20000,
  globalSpent = 0,
  keyEnc = null,
} = {}) {
  const calls = [];
  return {
    calls,
    async query(sql, params) {
      calls.push({ sql, params });
      if (/SELECT daily_limit_cents(?:, weekly_limit_cents)? FROM users/.test(sql)) {
        return { rows: [{ daily_limit_cents: userLimit, weekly_limit_cents: weeklyOverride }] };
      }
      if (/SELECT value FROM platform_settings/.test(sql)) {
        const value = params[0] === limits.KEY_GLOBAL ? globalLimit
          : params[0] === limits.KEY_WEEKLY ? weeklyLimit : 2500;
        return { rows: [{ value: String(value) }] };
      }
      if (/SELECT total_cost_cents FROM llm_usage/.test(sql)) {
        return { rows: [{ total_cost_cents: userSpent }] };
      }
      // Week-to-date for one user. Matched BEFORE the global sum below,
      // which is the same aggregate without the user predicate.
      if (/COALESCE\(SUM\(total_cost_cents\), 0\) AS total/.test(sql)) {
        return { rows: [{ total: weeklySpent }] };
      }
      if (/SELECT SUM\(total_cost_cents\)/.test(sql)) {
        return { rows: [{ total: globalSpent }] };
      }
      if (/SELECT anthropic_key_enc FROM users/.test(sql)) {
        return { rows: keyEnc ? [{ anthropic_key_enc: keyEnc }] : [] };
      }
      return { rows: [] };
    },
    issued(re) { return calls.some((c) => re.test(c.sql)); },
    find(re) { return calls.find((c) => re.test(c.sql)) || null; },
  };
}

const GRANT_NO_BYOK = { dailyCapCents: 100, allowByok: false };
const GRANT_BYOK = { dailyCapCents: 100, allowByok: true };

test.beforeEach(() => limits.invalidate());

test('budget headroom → platform path, key never looked up', async () => {
  const pool = makePool({ userSpent: 100, keyEnc: GOOD_KEY_ENC });
  const r = await resolveAppPayer(pool, DATA_KEY, 7, GRANT_BYOK);
  assert.deepEqual(r, { byok: false });
  assert.equal(pool.issued(/anthropic_key_enc/), false);
});

test('budget exhausted + allow_byok + key → BYOK path with the decrypted key', async () => {
  const pool = makePool({ userSpent: 2500, keyEnc: GOOD_KEY_ENC });
  const r = await resolveAppPayer(pool, DATA_KEY, 7, GRANT_BYOK);
  assert.deepEqual(r, { byok: true, apiKey: USER_KEY });
});

test('budget exhausted + allow_byok=false → 429-shaped error, key never looked up', async () => {
  const pool = makePool({ userSpent: 2500, keyEnc: GOOD_KEY_ENC });
  const r = await resolveAppPayer(pool, DATA_KEY, 7, GRANT_NO_BYOK);
  assert.match(r.error, /Daily limit reached/);
  assert.equal(pool.issued(/anthropic_key_enc/), false,
    'an app the user did not opt into BYOK must never trigger a key lookup');
});

test('budget exhausted + allow_byok but no key on file → error', async () => {
  const pool = makePool({ userSpent: 2500 });
  const r = await resolveAppPayer(pool, DATA_KEY, 7, GRANT_BYOK);
  assert.match(r.error, /Daily limit reached/);
});

test('global cap hit + allow_byok + key → BYOK path', async () => {
  const pool = makePool({ userSpent: 0, globalSpent: 20000, keyEnc: GOOD_KEY_ENC });
  const r = await resolveAppPayer(pool, DATA_KEY, 7, GRANT_BYOK);
  assert.deepEqual(r, { byok: true, apiKey: USER_KEY });
});

test('recordAppSpend writes the platform bucket by default', async () => {
  const pool = makePool();
  await recordAppSpend(pool, 11, 7, 12.5);
  const call = pool.find(/INSERT INTO app_llm_usage/);
  assert.ok(call, 'expected an app_llm_usage upsert');
  assert.match(call.sql, /total_cost_cents/);
  assert.doesNotMatch(call.sql, /byok_cost_cents/);
  assert.deepEqual(call.params, [11, 7, 12.5]);
});

test('recordAppSpend routes BYOK spend to the byok bucket', async () => {
  const pool = makePool();
  await recordAppSpend(pool, 11, 7, 3, { byok: true });
  const call = pool.find(/INSERT INTO app_llm_usage/);
  assert.match(call.sql, /byok_cost_cents/);
});

test('recordAppSpend no-ops on zero/negative cost or missing ids', async () => {
  const pool = makePool();
  await recordAppSpend(pool, 11, 7, 0);
  await recordAppSpend(pool, 11, 7, -1);
  await recordAppSpend(pool, null, 7, 5);
  await recordAppSpend(pool, 11, null, 5);
  assert.equal(pool.issued(/INSERT INTO app_llm_usage/), false);
});

test('recordAppSpend swallows DB errors (bookkeeping never fails the request)', async () => {
  const pool = { async query() { throw new Error('boom'); } };
  await assert.doesNotReject(() => recordAppSpend(pool, 11, 7, 5));
});

test('spentCentsHeaderValue keeps fractional cents to 4 decimal places', () => {
  assert.equal(spentCentsHeaderValue(4.7914), '4.7914');
  assert.equal(spentCentsHeaderValue(0.0372), '0.0372');
  assert.equal(spentCentsHeaderValue(37), '37');
  // Float noise from summed liveDelta increments is trimmed.
  assert.equal(spentCentsHeaderValue(0.1 + 0.2), '0.3');
  assert.equal(spentCentsHeaderValue(0.00004), '0');
});

test('spentCentsHeaderValue clamps zero, negative, and garbage to "0"', () => {
  assert.equal(spentCentsHeaderValue(0), '0');
  assert.equal(spentCentsHeaderValue(-1), '0');
  assert.equal(spentCentsHeaderValue(NaN), '0');
  assert.equal(spentCentsHeaderValue(Infinity), '0');
  assert.equal(spentCentsHeaderValue(undefined), '0');
  assert.equal(spentCentsHeaderValue('not-a-number'), '0');
});

// ── #1788: the app proxy inherits the weekly cap through checkBudget ────
//
// resolveAppPayer asks limits.checkBudget for the whole per-user
// allowance question, so the weekly axis reaches app calls without the
// app proxy re-deriving it. What is worth pinning is that the answer
// travels: the user-facing refusal names the week, and the BYOK spill
// path works from a weekly exhaustion exactly as from a daily one.

test('weekly cap exhausted → the app-facing refusal names the week', async () => {
  // Nothing spent today: only the week-to-date sum refuses this call.
  const pool = makePool({ userSpent: 0, weeklyLimit: 17500, weeklySpent: 17500 });
  const payer = await resolveAppPayer(pool, DATA_KEY, 7, GRANT_NO_BYOK);
  assert.match(payer.error, /Weekly limit reached \(\$175\.00\)\. Resets Monday 00:00 UTC\./);
  assert.equal(payer.byok, undefined);
  assert.ok(pool.issued(/COALESCE\(SUM\(total_cost_cents\), 0\) AS total/),
    'the week was actually read, not inferred from today');
});

test('weekly cap exhausted + allow_byok + key → BYOK path', async () => {
  const pool = makePool({
    userSpent: 0, weeklyLimit: 17500, weeklySpent: 17500, keyEnc: GOOD_KEY_ENC,
  });
  const payer = await resolveAppPayer(pool, DATA_KEY, 7, GRANT_BYOK);
  assert.deepEqual(payer, { byok: true, apiKey: USER_KEY });
});

test('weekly headroom left → platform path, and the ledger read is the only extra cost', async () => {
  const pool = makePool({ userSpent: 100, weeklyLimit: 17500, weeklySpent: 900 });
  const payer = await resolveAppPayer(pool, DATA_KEY, 7, GRANT_NO_BYOK);
  assert.deepEqual(payer, { byok: false });
});

test('no weekly cap → the app proxy never queries the weekly ledger', async () => {
  const pool = makePool({ userSpent: 100 });
  await resolveAppPayer(pool, DATA_KEY, 7, GRANT_NO_BYOK);
  assert.equal(pool.issued(/COALESCE\(SUM\(total_cost_cents\), 0\) AS total/), false);
});

test('both caps switched off → refused, pointing at the admin console', async () => {
  const pool = makePool({ userLimit: 0, weeklyLimit: 0, weeklyOverride: 0 });
  const payer = await resolveAppPayer(pool, DATA_KEY, 7, GRANT_NO_BYOK);
  assert.match(payer.error, /No AI allowance is configured for this account/);
  assert.match(payer.error, /admin can set a daily or weekly cap/);
});

// The mid-stream kill is what stops a single long streamed response from
// running past a cap it was under when it started. #1788 added the weekly
// bucket to it; both crossings report the same reason, because the caller
// (anthropic-stream) treats 'over_budget' as one terminal state.
test('the weekly mid-stream kill reports the same over_budget reason as the daily one', () => {
  const src = require('node:fs').readFileSync(
    require('node:path').join(__dirname, '..', 'src', 'routes', 'app-llm-proxy.js'), 'utf8');
  assert.match(src, /Mid-stream kill — over weekly budget/);
  const weeklyBlock = src.slice(src.indexOf('Mid-stream kill — over weekly budget'));
  assert.match(weeklyBlock.slice(0, 400), /return 'over_budget';/,
    'a new kill reason here would be an unhandled state downstream');
  assert.match(src, /const weeklyCapCents = userCaps && userCaps\.weeklyApplies/);
  assert.match(src, /weeklyCapCents != null\s*\n\s*\? await refreshUserWeeklySpend/,
    'and the weekly ledger is only read when a weekly cap applies');
});
