// Tests for the app-LLM proxy billing pieces (issue #34) —
// resolveAppPayer (the grant-scoped limit-first payer matrix) and
// recordAppSpend (the per-app ledger upsert), exported from
// src/routes/app-llm-proxy.js. Extends the patterns in
// limits-resolve-billing-path.test.js / limits-record-spend.test.js.
//
// Run with: node --test tests/app-llm-billing.test.js

const { test, beforeEach } = require('node:test');
const assert = require('node:assert/strict');

const limits = require('../src/services/limits');
const secrets = require('../src/services/secrets');
const { resolveAppPayer, recordAppSpend } = require('../src/routes/app-llm-proxy');

const JWT_SECRET = 'test-jwt-secret';
const USER_KEY = 'sk-ant-test-123';
const GOOD_KEY_ENC = secrets.encrypt(USER_KEY, JWT_SECRET);

// Same mock-pool shape as limits-resolve-billing-path.test.js, plus
// app_llm_usage capture for the settlement tests.
function makePool({
  userLimit = 2500,
  userSpent = 0,
  globalLimit = 20000,
  globalSpent = 0,
  keyEnc = null,
} = {}) {
  const calls = [];
  return {
    calls,
    async query(sql, params) {
      calls.push({ sql, params });
      if (/SELECT daily_limit_cents FROM users/.test(sql)) {
        return { rows: [{ daily_limit_cents: userLimit }] };
      }
      if (/SELECT value FROM platform_settings/.test(sql)) {
        const value = params[0] === limits.KEY_GLOBAL ? globalLimit : 2500;
        return { rows: [{ value: String(value) }] };
      }
      if (/SELECT total_cost_cents FROM llm_usage/.test(sql)) {
        return { rows: [{ total_cost_cents: userSpent }] };
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
  const r = await resolveAppPayer(pool, JWT_SECRET, 7, GRANT_BYOK);
  assert.deepEqual(r, { byok: false });
  assert.equal(pool.issued(/anthropic_key_enc/), false);
});

test('budget exhausted + allow_byok + key → BYOK path with the decrypted key', async () => {
  const pool = makePool({ userSpent: 2500, keyEnc: GOOD_KEY_ENC });
  const r = await resolveAppPayer(pool, JWT_SECRET, 7, GRANT_BYOK);
  assert.deepEqual(r, { byok: true, apiKey: USER_KEY });
});

test('budget exhausted + allow_byok=false → 429-shaped error, key never looked up', async () => {
  const pool = makePool({ userSpent: 2500, keyEnc: GOOD_KEY_ENC });
  const r = await resolveAppPayer(pool, JWT_SECRET, 7, GRANT_NO_BYOK);
  assert.match(r.error, /Daily limit reached/);
  assert.equal(pool.issued(/anthropic_key_enc/), false,
    'an app the user did not opt into BYOK must never trigger a key lookup');
});

test('budget exhausted + allow_byok but no key on file → error', async () => {
  const pool = makePool({ userSpent: 2500 });
  const r = await resolveAppPayer(pool, JWT_SECRET, 7, GRANT_BYOK);
  assert.match(r.error, /Daily limit reached/);
});

test('global cap hit + allow_byok + key → BYOK path', async () => {
  const pool = makePool({ userSpent: 0, globalSpent: 20000, keyEnc: GOOD_KEY_ENC });
  const r = await resolveAppPayer(pool, JWT_SECRET, 7, GRANT_BYOK);
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
