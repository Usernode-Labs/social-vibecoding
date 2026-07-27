// Tests for limits.resolveBillingPath (#212) — the shared limit-first
// payer decision every billable unit (chat turn, headless phase, sync
// run) routes through.
//
// Covers the contract the call sites rely on:
//   1. Budget headroom → platform path ({ apiKey: null, byok: false }),
//      and the BYOK key is never even looked up.
//   2. User cap hit + key on file → BYOK path with the decrypted key.
//   3. User cap hit + no key → the same 429 error message as today.
//   4. Global cap hit + key on file → BYOK path (key-holders fall back
//      to their key instead of being blocked by the global cap).
//   5. Key-decrypt failure → treated as "no key" → error at the cap.
//
// Run with: node --test tests/limits-resolve-billing-path.test.js

const test = require('node:test');
const assert = require('node:assert/strict');

const limits = require('../src/services/limits');
const secrets = require('../src/services/secrets');

// At-rest encryption key (services/secrets.js KDF input) — not a
// signing key. Same value the old shared JWT_SECRET held; the split was
// a rename, so existing ciphertext keeps decrypting.
const DATA_KEY = 'test-jwt-secret';
const USER_KEY = 'sk-ant-test-123';
const GOOD_KEY_ENC = secrets.encrypt(USER_KEY, DATA_KEY);

// ── Mock pool ───────────────────────────────────────────────────────────
// Answers the SQL shapes checkBudget + the key lookup issue. The user's
// limit is supplied via the per-user override column so platform_settings
// only matters for the global cap.
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
  };
}

// platform_settings reads are cached module-wide for 10s — clear between
// tests so each one's globalLimit takes effect.
test.beforeEach(() => limits.invalidate());

test('budget headroom → platform path; the key is never looked up', async () => {
  const pool = makePool({ userSpent: 100, keyEnc: GOOD_KEY_ENC });
  const r = await limits.resolveBillingPath(pool, DATA_KEY, 7);
  assert.deepEqual(r, { apiKey: null, byok: false });
  assert.equal(pool.issued(/anthropic_key_enc/), false,
    'no key lookup while the allowance has headroom');
});

test('user cap hit + key on file → BYOK path with the decrypted key', async () => {
  const pool = makePool({ userSpent: 2500, keyEnc: GOOD_KEY_ENC });
  const r = await limits.resolveBillingPath(pool, DATA_KEY, 7);
  assert.deepEqual(r, { apiKey: USER_KEY, byok: true });
});

test('user cap hit + no key → the daily-limit error message with the BYOK hint (#463)', async () => {
  const pool = makePool({ userSpent: 2500 });
  const r = await limits.resolveBillingPath(pool, DATA_KEY, 7);
  assert.equal(r.apiKey, undefined);
  assert.match(r.error, /Daily limit reached/);
  assert.match(r.error, /Add your own Anthropic API key in Settings to keep going\.$/,
    'the no-key error carries the Settings hint');
});

test('global cap hit + key on file → BYOK path', async () => {
  const pool = makePool({ userSpent: 0, globalSpent: 20000, keyEnc: GOOD_KEY_ENC });
  const r = await limits.resolveBillingPath(pool, DATA_KEY, 7);
  assert.deepEqual(r, { apiKey: USER_KEY, byok: true });
});

test('global cap hit + no key → the global-limit error message with the BYOK hint (#463)', async () => {
  const pool = makePool({ userSpent: 0, globalSpent: 20000 });
  const r = await limits.resolveBillingPath(pool, DATA_KEY, 7);
  assert.match(r.error, /Global daily limit reached/);
  assert.match(r.error, /Add your own Anthropic API key in Settings to keep going\.$/,
    'the global-cap error carries the same hint — BYOK bypasses the global cap too');
});

test('key-decrypt failure is treated as no key → error at the cap', async () => {
  // A ciphertext encrypted under a DIFFERENT secret: decrypt returns
  // null (auth-tag mismatch), which must degrade to the no-key path.
  const wrongSecretEnc = secrets.encrypt(USER_KEY, 'some-other-secret');
  const pool = makePool({ userSpent: 2500, keyEnc: wrongSecretEnc });
  const r = await limits.resolveBillingPath(pool, DATA_KEY, 7);
  assert.match(r.error, /Daily limit reached/);
});
