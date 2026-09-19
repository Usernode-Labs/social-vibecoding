// Tests for limits.resolveBillingPath (#212) — the shared limit-first
// payer decision every billable unit (chat turn, headless phase, sync
// run) routes through.
//
// Covers the contract the call sites rely on:
//   1. Budget headroom → platform path ({ apiKey: null, byok: false }),
//      and the BYOK key is never even looked up.
//   2. Cap hit + key on file → BYOK path with the decrypted key.
//   3. Cap hit + no key → the same 429 error message as today.
//   4. Global cap hit + key on file → BYOK path (key-holders fall back
//      to their key instead of being blocked by the global cap).
//   5. Key-decrypt failure → treated as "no key" → error at the cap.
//
// #2571: the cap in every one of those sentences is the WEEKLY one. The
// per-user daily cap is switched off platform-wide, so a spent daily
// figure refuses nothing and the week is the only window.
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
// allowance is supplied via the per-user override columns so
// platform_settings only matters for the global cap.
// #2571: `weeklyLimit` is the account's only ceiling and defaults to the
// platform default of $50; `userLimit` is the retained-but-unenforced
// daily column.
function makePool({
  userLimit = 2500,
  userSpent = 0,
  weeklyLimit = 5000,
  weeklySpent = 0,
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
        return { rows: [{ daily_limit_cents: userLimit, weekly_limit_cents: weeklyLimit }] };
      }
      if (/SELECT value FROM platform_settings/.test(sql)) {
        const value = params[0] === limits.KEY_GLOBAL ? globalLimit : 2500;
        return { rows: [{ value: String(value) }] };
      }
      if (/SELECT total_cost_cents FROM llm_usage/.test(sql)) {
        return { rows: [{ total_cost_cents: userSpent }] };
      }
      // Week-to-date: COALESCE(SUM(...)) over date >= the Monday. Matched
      // BEFORE the global sum below, which is the same aggregate without
      // the user predicate.
      if (/COALESCE\(SUM\(total_cost_cents\), 0\) AS total/.test(sql)) {
        return { rows: [{ total: weeklySpent, byok: 0 }] };
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
  const pool = makePool({ weeklySpent: 100, keyEnc: GOOD_KEY_ENC });
  const r = await limits.resolveBillingPath(pool, DATA_KEY, 7);
  assert.deepEqual(r, { apiKey: null, byok: false });
  assert.equal(pool.issued(/anthropic_key_enc/), false,
    'no key lookup while the allowance has headroom');
});

test('weekly cap hit + key on file → BYOK path with the decrypted key', async () => {
  const pool = makePool({ weeklySpent: 5000, keyEnc: GOOD_KEY_ENC });
  const r = await limits.resolveBillingPath(pool, DATA_KEY, 7);
  assert.deepEqual(r, { apiKey: USER_KEY, byok: true });
});

test('weekly cap hit + no key → the weekly-limit error with the BYOK hint (#463)', async () => {
  const pool = makePool({ weeklySpent: 5000 });
  const r = await limits.resolveBillingPath(pool, DATA_KEY, 7);
  assert.equal(r.apiKey, undefined);
  assert.match(r.error, /Weekly limit reached \(\$50\.00\)\. Resets Monday 00:00 UTC\./);
  assert.match(r.error, /Add your own Anthropic API key in Settings to keep going\.$/,
    'the no-key error carries the Settings hint');
});

test('global cap hit + key on file → BYOK path', async () => {
  const pool = makePool({ globalSpent: 20000, keyEnc: GOOD_KEY_ENC });
  const r = await limits.resolveBillingPath(pool, DATA_KEY, 7);
  assert.deepEqual(r, { apiKey: USER_KEY, byok: true });
});

test('global cap hit + no key → the global-limit error message with the BYOK hint (#463)', async () => {
  const pool = makePool({ globalSpent: 20000 });
  const r = await limits.resolveBillingPath(pool, DATA_KEY, 7);
  assert.match(r.error, /Global daily limit reached/);
  assert.match(r.error, /Add your own Anthropic API key in Settings to keep going\.$/,
    'the global-cap error carries the same hint — BYOK bypasses the global cap too');
});

test('key-decrypt failure is treated as no key → error at the cap', async () => {
  // A ciphertext encrypted under a DIFFERENT secret: decrypt returns
  // null (auth-tag mismatch), which must degrade to the no-key path.
  const wrongSecretEnc = secrets.encrypt(USER_KEY, 'some-other-secret');
  const pool = makePool({ weeklySpent: 5000, keyEnc: wrongSecretEnc });
  const r = await limits.resolveBillingPath(pool, DATA_KEY, 7);
  assert.match(r.error, /Weekly limit reached/);
});

// ── #2571: one cap, and it is the weekly one ───────────────────────────
//
// #1788 layered a weekly ceiling on top of a daily one; this issue turns
// the daily one off for everybody. The two tests below are the whole of
// what that means for this gate.

test('a spent DAILY cap refuses nothing — the daily window is switched off', async () => {
  // Today's spend is well past the per-user daily cap that is still
  // stored on the row, and the week still has room. The turn proceeds.
  const pool = makePool({
    userLimit: 2000, userSpent: 4500, weeklyLimit: 5000, weeklySpent: 4500,
  });
  assert.deepEqual(
    await limits.resolveBillingPath(pool, DATA_KEY, 7),
    { apiKey: null, byok: false }
  );

  limits.invalidate();
  // …and the week is what finally stops it.
  const spent = makePool({
    userLimit: 2000, userSpent: 5000, weeklyLimit: 5000, weeklySpent: 5000,
  });
  const r = await limits.resolveBillingPath(spent, DATA_KEY, 7);
  assert.equal(r.reason, 'weekly_limit');
  assert.match(r.error, /Weekly limit reached/);
});

test('weekly cap 0 → no allowance at all, and it fails CLOSED', async () => {
  const pool = makePool({ userLimit: 2500, userSpent: 0, weeklyLimit: 0 });
  const r = await limits.resolveBillingPath(pool, DATA_KEY, 7);
  assert.equal(r.reason, 'no_allowance');
  assert.match(r.error, /No AI allowance is configured for this account\./);
  assert.match(r.error, /An admin can set a weekly cap in the admin console\./);
  // …but BYOK still works: this gate is about platform-funded credits.
  limits.invalidate();
  const withKey = makePool({
    userLimit: 2500, userSpent: 0, weeklyLimit: 0, keyEnc: GOOD_KEY_ENC,
  });
  assert.deepEqual(
    await limits.resolveBillingPath(withKey, DATA_KEY, 7),
    { apiKey: USER_KEY, byok: true }
  );
});

test('a weekly cap cannot unlock what identity verification gates', async () => {
  // Tiered policy, unverified account: the entitlement is an
  // identity-derived 0, which is NOT the admin's "switch this cap off" 0.
  // Weekly headroom must not turn into credits here.
  const prev = process.env.IDENTITY_CREDIT_POLICY;
  process.env.IDENTITY_CREDIT_POLICY = 'tiered';
  limits.invalidate();
  try {
    const pool = {
      async query(sql, params) {
        if (/has_social_identity/.test(sql)) {
          return { rows: [{ daily_limit_cents: null, weekly_limit_cents: 5000, has_social_identity: false }] };
        }
        if (/SELECT value FROM platform_settings/.test(sql)) {
          return { rows: [{ value: '20000' }] };
        }
        if (/SELECT total_cost_cents FROM llm_usage/.test(sql)) {
          return { rows: [{ total_cost_cents: 0 }] };
        }
        if (/COALESCE\(SUM\(total_cost_cents\), 0\) AS total/.test(sql)) {
          return { rows: [{ total: 0, byok: 0 }] };
        }
        return { rows: [] };
      },
    };
    const r = await limits.resolveBillingPath(pool, DATA_KEY, 7);
    assert.equal(r.reason, 'verification_required');
    assert.equal(r.verificationRequired, true);
  } finally {
    if (prev == null) delete process.env.IDENTITY_CREDIT_POLICY;
    else process.env.IDENTITY_CREDIT_POLICY = prev;
    limits.invalidate();
  }
});
