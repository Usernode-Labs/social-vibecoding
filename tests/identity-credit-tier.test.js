'use strict';

const { test, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const fs = require('node:fs');
const { spawnSync } = require('node:child_process');

const limits = require('../src/services/limits');
const secrets = require('../src/services/secrets');

const previousPolicy = process.env.IDENTITY_CREDIT_POLICY;

beforeEach(() => {
  limits.invalidate();
  process.env.IDENTITY_CREDIT_POLICY = 'tiered';
});

afterEach(() => {
  limits.invalidate();
  if (previousPolicy == null) delete process.env.IDENTITY_CREDIT_POLICY;
  else process.env.IDENTITY_CREDIT_POLICY = previousPolicy;
});

function poolFor({ override = null, hasIdentity = false, spent = 0, globalSpent = 0,
  key = null, entitlementError = null } = {}) {
  const calls = [];
  return {
    calls,
    query: async (sql) => {
      const text = String(sql);
      calls.push(text);
      if (/EXISTS \([\s\S]*user_social_identities/.test(text)) {
        if (entitlementError) throw entitlementError;
        return { rows: [{ daily_limit_cents: override, has_social_identity: hasIdentity }] };
      }
      if (/SELECT value FROM platform_settings/.test(text)) return { rows: [{ value: '20000' }] };
      if (/SELECT total_cost_cents FROM llm_usage/.test(text)) {
        return { rows: [{ total_cost_cents: spent }] };
      }
      if (/SELECT SUM\(total_cost_cents\)/.test(text)) return { rows: [{ total: globalSpent }] };
      if (/SELECT anthropic_key_enc FROM users/.test(text)) {
        return { rows: [{ anthropic_key_enc: key }] };
      }
      if (/LEFT JOIN llm_usage/.test(text)) {
        return { rows: [{
          total_cost_cents: spent,
          byok_cost_cents: 0,
          has_byok_key: !!key,
        }] };
      }
      return { rows: [] };
    },
  };
}

test('unverified tier is exactly $0 and returns an actionable refusal', async () => {
  const pool = poolFor();
  const e = await limits.getUserCreditEntitlement(pool, 7);
  assert.deepEqual(e, {
    policy: 'tiered', tier: 'unverified', source: 'identity', limitCents: 0,
    verificationRequired: true, entitlementAvailable: true,
  });
  const budget = await limits.checkBudget(pool, 7);
  assert.equal(budget.reason, 'verification_required');
  assert.equal(budget.verificationRequired, true);
  assert.match(budget.error, /Connect GitHub or X/);
  assert.equal(pool.calls.some((sql) => /SUM\(total_cost_cents\)/.test(sql)), false,
    'a zero user tier refuses before consulting the shared platform pool');

  const billing = await limits.resolveBillingPath(pool, 'unused-key', 7);
  assert.equal(billing.reason, 'verification_required');
  assert.equal(billing.verificationRequired, true,
    'browser-facing billing refusals retain the unlock signal');
});

test('either one or both provider proofs resolve to the same non-stacking $10 tier', async () => {
  const pool = poolFor({ hasIdentity: true, spent: 125 });
  const e = await limits.getUserCreditEntitlement(pool, 7);
  assert.equal(e.tier, 'social');
  assert.equal(e.limitCents, 1000);
  assert.equal(e.verificationRequired, false);
  const budget = await limits.checkBudget(pool, 7);
  assert.equal(budget.ok, true);
  assert.equal(budget.userRemaining, 875);
  const entitlementSql = pool.calls.find((sql) => /user_social_identities/.test(sql));
  assert.match(entitlementSql, /EXISTS/);
  assert.doesNotMatch(entitlementSql, /COUNT|SUM/, 'providers prove eligibility; they never stack');
});

test('an explicit administrator override wins, including intentional zero', async () => {
  let e = await limits.getUserCreditEntitlement(
    poolFor({ override: 4321, hasIdentity: false }), 7
  );
  assert.equal(e.tier, 'override');
  assert.equal(e.limitCents, 4321);

  const pool = poolFor({ override: 0, hasIdentity: true });
  e = await limits.getUserCreditEntitlement(pool, 7);
  assert.equal(e.limitCents, 0);
  assert.equal(e.verificationRequired, false);
  const budget = await limits.checkBudget(pool, 7);
  assert.equal(budget.reason, 'user_limit');
  assert.doesNotMatch(budget.error, /Connect GitHub or X/);
});

test('tier lookup failures refuse platform spend instead of falling back to legacy credits', async () => {
  const pool = poolFor({ entitlementError: new Error('database unavailable') });
  const e = await limits.getUserCreditEntitlement(pool, 7);
  assert.equal(e.entitlementAvailable, false);
  assert.equal(e.limitCents, 0);
  assert.equal(e.source, 'unavailable');
  const budget = await limits.checkBudget(pool, 7);
  assert.equal(budget.reason, 'entitlement_unavailable');
  assert.match(budget.error, /could not be verified/i);
  assert.equal(pool.calls.some((sql) => /llm_usage/.test(sql)), false);
});

test('BYOK remains available when the platform tier is zero', async () => {
  const dataKey = 'test-data-encryption-key';
  const encrypted = secrets.encrypt('sk-ant-user-key', dataKey);
  const pool = poolFor({ key: encrypted });
  const billing = await limits.resolveBillingPath(pool, dataKey, 7);
  assert.deepEqual(billing, { apiKey: 'sk-ant-user-key', byok: true });
});

test('legacy remains the default and preserves the existing platform allowance', async () => {
  delete process.env.IDENTITY_CREDIT_POLICY;
  const pool = {
    query: async (sql) => {
      if (/SELECT daily_limit_cents FROM users/.test(String(sql))) {
        return { rows: [{ daily_limit_cents: null }] };
      }
      if (/SELECT value FROM platform_settings/.test(String(sql))) {
        return { rows: [{ value: '2500' }] };
      }
      return { rows: [] };
    },
  };
  const e = await limits.getUserCreditEntitlement(pool, 7);
  assert.equal(e.policy, 'legacy');
  assert.equal(e.limitCents, 2500);
  assert.equal(e.verificationRequired, false);
});

test('an unknown credit policy fails boot instead of silently choosing a payer', () => {
  const result = spawnSync(
    process.execPath,
    ['-e', "require('./src/config').load()"],
    {
      cwd: path.join(__dirname, '..'),
      encoding: 'utf8',
      env: {
        ...process.env,
        USERNODE_ENV: 'staging',
        DATABASE_URL: 'postgres://unused',
        SESSION_SECRET: 'unused-session-secret',
        ADMIN_USERNAME: 'admin',
        ADMIN_PASSWORD: 'unused-password',
        IDENTITY_CREDIT_POLICY: 'typo',
      },
    }
  );
  assert.equal(result.status, 1);
  assert.match(result.stderr, /IDENTITY_CREDIT_POLICY must be either legacy or tiered/);
});

test('post-turn helper calls cannot deliberately continue on stale platform billing', () => {
  const sessionsSource = fs.readFileSync(
    path.join(__dirname, '..', 'src', 'routes', 'sessions.js'),
    'utf8',
  );
  assert.doesNotMatch(sessionsSource, /continuing platform-billed|proceeds platform-billed/);
  assert.match(sessionsSource,
    /async function runHeadlessMayorEffect\(\{[\s\S]*allowInvoke = true/);
  assert.match(sessionsSource,
    /Quick-reply model rung skipped: no payer available/);
  assert.match(sessionsSource,
    /allowModelGeneration: prMetadataGenerationAllowed/);
});
