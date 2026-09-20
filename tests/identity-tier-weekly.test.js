// #838: the weekly credit cap follows the account's identity tier.
//
// Three tiers, each with an admin-set weekly default in platform_settings:
// unverified (the base `user_weekly_limit_cents`), GitHub AND X verified
// (`user_weekly_limit_social_cents`) and zkPassport verified
// (`user_weekly_limit_zk_cents`). The two higher keys inherit the base while
// unset. A per-user override still wins, tiers replace rather than stack,
// and the daily cap is untouched. This drives src/services/limits.js over a
// stubbed pool, the same way tests/identity-credit-tier.test.js does.
//
// Run with: node --test tests/identity-tier-weekly.test.js

'use strict';

const { test, beforeEach } = require('node:test');
const assert = require('node:assert/strict');

const limits = require('../src/services/limits');

beforeEach(() => {
  limits.invalidate();
  delete process.env.IDENTITY_CREDIT_POLICY;
});

// A pool whose platform_settings and identity proofs are dialled in.
function poolFor({
  settings = {}, github = false, x = false, zk = false,
  weeklyOverride = null, dailyOverride = null, tierError = null,
} = {}) {
  const calls = [];
  return {
    calls,
    query: async (sql, params = []) => {
      const text = String(sql);
      calls.push({ text, params });
      if (/has_zkpassport/.test(text)) {
        if (tierError) throw tierError;
        return { rows: [{ has_github: github, has_x: x, has_zkpassport: zk }] };
      }
      if (/SELECT daily_limit_cents, weekly_limit_cents FROM users/.test(text)) {
        return { rows: [{ daily_limit_cents: dailyOverride, weekly_limit_cents: weeklyOverride }] };
      }
      if (/SELECT value FROM platform_settings/.test(text)) {
        const v = settings[params[0]];
        return { rows: v == null ? [] : [{ value: String(v) }] };
      }
      if (/SELECT total_cost_cents FROM llm_usage/.test(text)) return { rows: [{ total_cost_cents: 0 }] };
      if (/COALESCE\(SUM\(total_cost_cents\), 0\) AS total/.test(text)) return { rows: [{ total: 0 }] };
      if (/SELECT SUM\(total_cost_cents\)/.test(text)) return { rows: [{ total: 0 }] };
      return { rows: [] };
    },
  };
}

const BASE = { user_weekly_limit_cents: '1000', user_daily_limit_cents: '2500', global_daily_limit_cents: '20000' };
const TIERED = { ...BASE, user_weekly_limit_social_cents: '5000', user_weekly_limit_zk_cents: '20000' };

// ── the tier itself ──────────────────────────────────────────────────────

test('the tier is read from the three proofs: both socials, or zkPassport, and zkPassport wins', () => {
  const t = limits.identityTierFromFlags;
  assert.equal(t(null).tier, 'unverified');
  assert.equal(t({}).tier, 'unverified');
  assert.equal(t({ has_github: true }).tier, 'unverified', 'one social link is not the social tier');
  assert.equal(t({ has_x: true }).tier, 'unverified');
  assert.equal(t({ has_github: true, has_x: true }).tier, 'social');
  assert.equal(t({ has_zkpassport: true }).tier, 'zkpassport');
  assert.equal(t({ has_github: true, has_x: true, has_zkpassport: true }).tier, 'zkpassport',
    'tiers replace, they do not stack');
  assert.deepEqual(t({ has_github: true, has_x: false }), {
    tier: 'unverified', hasGithub: true, hasX: false, hasZkpassport: false,
  });
  assert.deepEqual(limits.IDENTITY_TIERS, ['unverified', 'social', 'zkpassport']);
});

test('getIdentityTier asks one query with the three EXISTS, and fails toward unverified', async () => {
  const pool = poolFor({ github: true, x: true });
  const r = await limits.getIdentityTier(pool, 7);
  assert.equal(r.tier, 'social');
  const q = pool.calls.find((c) => /has_zkpassport/.test(c.text));
  assert.deepEqual(q.params, [7]);
  assert.match(q.text, /usi\.provider = 'github'/);
  assert.match(q.text, /usi\.provider = 'x'/);
  assert.match(q.text, /user_activities ua[\s\S]*ua\.source = 'zkpassport'/);
  assert.equal((q.text.match(/EXISTS \(/g) || []).length, 3);

  const broken = poolFor({ tierError: new Error('identity store down') });
  assert.equal((await limits.getIdentityTier(broken, 7)).tier, 'unverified');
});

// ── the weekly cap each tier gets ────────────────────────────────────────

test('each tier resolves to its own weekly cap, and the daily cap is untouched', async () => {
  for (const [proofs, cents, source] of [
    [{}, 1000, 'default'],
    [{ github: true }, 1000, 'default'],
    [{ github: true, x: true }, 5000, 'tier'],
    [{ zk: true }, 20000, 'tier'],
    [{ github: true, x: true, zk: true }, 20000, 'tier'],
  ]) {
    limits.invalidate();
    const e = await limits.getUserCreditEntitlement(poolFor({ settings: TIERED, ...proofs }), 7);
    assert.equal(e.weeklyLimitCents, cents, JSON.stringify(proofs));
    assert.equal(e.weeklySource, source, JSON.stringify(proofs));
    assert.equal(e.limitCents, 2500, 'the daily cap does not follow the tier');
    assert.equal(e.policy, 'legacy');
    assert.equal(e.verificationRequired, false);
  }
});

test('a tier with no stored value inherits the unverified cap', async () => {
  const onlyZk = { ...BASE, user_weekly_limit_zk_cents: '20000' };
  let e = await limits.getUserCreditEntitlement(poolFor({ settings: onlyZk, github: true, x: true }), 7);
  assert.equal(e.weeklyLimitCents, 1000);
  assert.equal(e.weeklySource, 'default', 'social inherits when its key is absent');
  assert.equal(e.identityTier, 'social', 'but the tier is still named');
  limits.invalidate();
  e = await limits.getUserCreditEntitlement(poolFor({ settings: onlyZk, zk: true }), 7);
  assert.equal(e.weeklyLimitCents, 20000);
  assert.equal(e.weeklySource, 'tier');
  assert.equal(e.identityTier, 'zkpassport');
  // The admin-facing reader says null for an inherited tier.
  limits.invalidate();
  const pool = poolFor({ settings: onlyZk });
  assert.equal(await limits.getTierWeeklyLimitCents(pool, 'social'), null);
  assert.equal(await limits.getTierWeeklyLimitCents(pool, 'zkpassport'), 20000);
  assert.equal(await limits.getTierWeeklyLimitCents(pool, 'unverified'), null,
    'the unverified tier IS the base cap, so it has no key of its own');
  assert.equal(limits.tierWeeklyKey('social'), limits.KEY_WEEKLY_SOCIAL);
  assert.equal(limits.tierWeeklyKey('zkpassport'), limits.KEY_WEEKLY_ZK);
  assert.equal(limits.tierWeeklyKey('unverified'), null);
});

test('an unset tier key is cached as unset, not re-queried on every turn', async () => {
  const pool = poolFor({ settings: BASE, github: true, x: true });
  await limits.getUserCreditEntitlement(pool, 7);
  await limits.getUserCreditEntitlement(pool, 7);
  const reads = pool.calls.filter((c) => /platform_settings/.test(c.text)
    && c.params[0] === limits.KEY_WEEKLY_SOCIAL);
  assert.equal(reads.length, 1, 'the second turn served the unset answer from the cache');
});

test('a per-user weekly override wins over the tier, and still names the tier', async () => {
  const e = await limits.getUserCreditEntitlement(
    poolFor({ settings: TIERED, zk: true, weeklyOverride: 300 }), 7
  );
  assert.equal(e.weeklyLimitCents, 300);
  assert.equal(e.weeklySource, 'admin_override');
  assert.equal(e.identityTier, 'zkpassport');
});

test('a tier cap of 0 switches the weekly window off, like the base cap', async () => {
  const settings = { ...BASE, user_weekly_limit_social_cents: '0' };
  const e = await limits.getUserCreditEntitlement(poolFor({ settings, github: true, x: true }), 7);
  const caps = limits.resolveCaps(e);
  assert.equal(e.weeklySource, 'tier');
  assert.equal(caps.weeklyApplies, false);
  // #2571: nothing governs after that. The per-user daily cap is switched
  // off platform-wide, so a tier cap of 0 leaves the account with no
  // allowance at all — which is what checkBudget answers (no_allowance).
  assert.equal(caps.dailyApplies, false, 'the daily window no longer exists');
});

test('the gate and the snapshot enforce the tier cap', async () => {
  const pool = poolFor({ settings: TIERED, github: true, x: true });
  const budget = await limits.checkBudget(pool, 7);
  assert.equal(budget.ok, true);
  assert.equal(budget.weeklyLimit, 5000);
  assert.equal(budget.identityTier, 'social');
  limits.invalidate();
  const snap = await limits.getBudgetSnapshot(poolFor({ settings: TIERED, zk: true }), 7);
  assert.equal(snap.weeklyLimitCents, 20000);
  assert.equal(snap.identityTier, 'zkpassport');
  assert.equal(snap.weeklySource, 'tier');
  limits.invalidate();
  assert.equal(await limits.getEffectiveUserWeeklyLimitCents(poolFor({ settings: TIERED, zk: true }), 7), 20000,
    'the proxies’ cached gate reads the same number');
});

test('with no tier keys stored at all, nothing changes for anyone', async () => {
  for (const proofs of [{}, { github: true, x: true }, { zk: true }]) {
    limits.invalidate();
    const e = await limits.getUserCreditEntitlement(poolFor({ settings: BASE, ...proofs }), 7);
    assert.equal(e.weeklyLimitCents, 1000, JSON.stringify(proofs));
    assert.equal(e.weeklySource, 'default');
  }
});

test('the tiered credit policy keeps its daily rule and gains the weekly tiers', async () => {
  process.env.IDENTITY_CREDIT_POLICY = 'tiered';
  const pool = poolFor({ settings: TIERED, github: true, x: true });
  // The tiered branch's own entitlement query answers the old social flag.
  const inner = pool.query;
  pool.query = async (sql, params) => {
    if (/has_social_identity/.test(String(sql))) {
      pool.calls.push({ text: String(sql), params });
      return { rows: [{ daily_limit_cents: null, weekly_limit_cents: null, has_social_identity: true }] };
    }
    return inner(sql, params);
  };
  const e = await limits.getUserCreditEntitlement(pool, 7);
  assert.equal(e.tier, 'social');
  assert.equal(e.limitCents, limits.TIER_ONE_LIMIT_CENTS, 'the daily rule is the old one');
  assert.equal(e.weeklyLimitCents, 5000, 'the weekly cap follows the new tier');
  assert.equal(e.identityTier, 'social');
});
