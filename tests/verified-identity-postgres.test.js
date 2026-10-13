'use strict';

// The VERIFIED-IDENTITY rule against the full schema (schema.sql
// identity_verified, identity_rule_since, identity_rule_exempt,
// public_vote_needs_identity): switched on, a vote on a public app counts
// only from a verified account (a phone, GitHub AND X, or zkPassport) or one
// let in before the switch, and the AI budget's phone tier covers the same
// accounts, the first-run ask's identity_needed, and the production
// rollout (services/identity-rollout.js). Skipped when no server is
// reachable, and required when TEST_DATABASE_URL is set.

const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const { Pool } = require('pg');

const DSN = process.env.TEST_DATABASE_URL || process.env.DATABASE_URL || 'postgres://postgres:postgres@127.0.0.1:5432/postgres';

test('verified identity for public votes and the AI budget, against the full schema', { timeout: 180000 }, async (t) => {
  const admin = new Pool({ connectionString: DSN, connectionTimeoutMillis: 2000 });
  try { await admin.query('SELECT 1'); } catch (err) {
    await admin.end();
    if (process.env.TEST_DATABASE_URL) throw err;
    t.skip('PostgreSQL unavailable; set TEST_DATABASE_URL to require this check'); return;
  }
  const name = 'verified_identity_' + crypto.randomBytes(6).toString('hex');
  await admin.query(`CREATE DATABASE ${name}`);
  const url = new URL(DSN); url.pathname = '/' + name;
  const pool = new Pool({ connectionString: String(url), max: 6 });
  t.after(async () => {
    await pool.end();
    await admin.query(`DROP DATABASE ${name}`);
    await admin.end();
  });
  await pool.query(fs.readFileSync(require.resolve('../src/db/schema.sql'), 'utf8'));

  const communities = require('../src/services/communities');
  const limits = require('../src/services/limits');

  let seq = 0;
  async function account({ grantedAt = 'NOW()', admin: isAdmin = false } = {}) {
    const n = ++seq;
    const { rows } = await pool.query(
      `INSERT INTO users (username, password, has_platform_access, platform_access_granted_at, is_admin)
       VALUES ($1, 'x', TRUE, ${grantedAt}, $2) RETURNING id`,
      [`voter_${n}`, isAdmin]
    );
    return rows[0].id;
  }
  const owner = await account();
  async function app(slug, visibility) {
    await pool.query(
      `INSERT INTO apps (name, slug, created_by, view_visibility, collab_visibility)
       VALUES ($1, $1, $2, $3, $3)`,
      [slug, owner, visibility]
    );
    return (await pool.query('SELECT id FROM apps WHERE slug = $1', [slug])).rows[0].id;
  }
  const square = await app('town-square', 'public');
  const club = await app('book-club', 'private');
  const needs = async (voter, appId) => (await pool.query(
    'SELECT public_vote_needs_identity($1, $2) AS v', [voter, appId])).rows[0].v;
  const counts = async (voter, appId) => (await pool.query(
    'SELECT counts_toward_outcome($1, $2) AS v', [voter, appId])).rows[0].v;
  const verified = async (id) => (await pool.query('SELECT identity_verified($1) AS v', [id])).rows[0].v;
  const ruleOn = (at = new Date()) => pool.query(
    `INSERT INTO platform_settings (key, value) VALUES ('identity_rule_since', $1)
     ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value`, [at.toISOString()]);
  const ruleOff = () => pool.query("DELETE FROM platform_settings WHERE key = 'identity_rule_since'");

  await t.test('verified: a phone, GitHub AND X, or zkPassport; GitHub or X alone is not', async () => {
    const phone = await account();
    await pool.query("INSERT INTO user_phone_identities (user_id, firebase_uid, phone_e164) VALUES ($1, 'uid-a', '+15550100001')", [phone]);
    const gh = await account();
    await pool.query("INSERT INTO user_social_identities (user_id, provider, provider_subject, handle) VALUES ($1, 'github', '101', 'gh-only')", [gh]);
    const both = await account();
    await pool.query("INSERT INTO user_social_identities (user_id, provider, provider_subject, handle) VALUES ($1, 'github', '102', 'gh-both'), ($1, 'x', '202', 'x_both')", [both]);
    const zk = await account();
    // A zkPassport proof is a challenge completion the mobile flow records.
    const { rows: [season] } = await pool.query(
      `INSERT INTO seasons (name, starts_at, ends_at, is_active)
       VALUES ('Fixture', NOW(), NOW() + INTERVAL '1 day', TRUE) RETURNING id`);
    const { rows: [event] } = await pool.query(
      `INSERT INTO season_events (name, starts_at, ends_at, is_active, scoring_formula, season_id, type)
       VALUES ('Fixture', NOW(), NOW() + INTERVAL '1 day', TRUE, '{}'::jsonb, $1, 'season') RETURNING id`, [season.id]);
    const { rows: [template] } = await pool.query(
      `INSERT INTO challenge_templates (category, goal, task, reward)
       VALUES ('ONBOARDING', 'Prove you are a person', 'zkPassport', '0 pts') RETURNING id`);
    const { rows: [challenge] } = await pool.query(
      'INSERT INTO challenges (season_event_id, challenge_template_id, display_order) VALUES ($1, $2, 1) RETURNING id',
      [event.id, template.id]);
    await pool.query(
      `INSERT INTO user_activities (user_id, season_event_id, activity_type, activity_at, source, challenge_id)
       VALUES ($1, $2, 'challenge', NOW(), 'zkpassport', $3)`, [zk, event.id, challenge.id]);
    assert.deepEqual(
      [await verified(phone), await verified(gh), await verified(both), await verified(zk), await verified(owner)],
      [true, false, true, true, false]
    );
  });

  await t.test('off: nobody is held to it', async () => {
    await ruleOff();
    const fresh = await account();
    assert.equal(await needs(fresh, square), false);
    assert.equal(await counts(fresh, square), true);
    assert.equal(await communities.identityVoteRefusal(pool, square, fresh), null);
  });

  await t.test('on: a public app counts verified or earlier members; private groups are untouched', async () => {
    const earlier = await account({ grantedAt: "NOW() - INTERVAL '30 days'" });
    await ruleOn();
    const later = await account({ grantedAt: "NOW() + INTERVAL '1 second'" });
    // An earlier member keeps their vote.
    assert.equal(await needs(earlier, square), false);
    assert.equal(await counts(earlier, square), true);
    // Somebody let in afterwards, unverified: refused, and would not count.
    assert.equal(await needs(later, square), true);
    assert.equal(await counts(later, square), false);
    const refusal = await communities.identityVoteRefusal(pool, square, later);
    assert.equal(refusal.code, 'identity_required');
    assert.match(refusal.error, /Verify your phone number, or link both GitHub and X/);
    // Their own private group: unchanged.
    assert.equal(await needs(later, club), false);
    assert.equal(await counts(later, club), true);
    // A phone, and they count.
    await pool.query("INSERT INTO user_phone_identities (user_id, firebase_uid, phone_e164) VALUES ($1, 'uid-later', '+15550100002')", [later]);
    assert.equal(await needs(later, square), false);
    assert.equal(await counts(later, square), true);
    // Admins are never held to it.
    const staff = await account({ grantedAt: "NOW() + INTERVAL '1 second'", admin: true });
    assert.equal(await needs(staff, square), false);
  });

  await t.test('a malformed switch value reads as off, never an error in a tally', async () => {
    await pool.query("UPDATE platform_settings SET value = 'yes please' WHERE key = 'identity_rule_since'");
    const someone = await account();
    assert.equal(await needs(someone, square), false);
    assert.equal(await counts(someone, square), true);
    assert.equal(await limits.identityRuleSince(pool), null);
    await ruleOn();
  });

  await t.test('the AI budget: a phone is a tier, and earlier members sit in it too', async () => {
    const earlier = await account({ grantedAt: "NOW() - INTERVAL '30 days'" });
    const fresh = await account({ grantedAt: "NOW() + INTERVAL '1 second'" });
    const phoned = await account({ grantedAt: "NOW() + INTERVAL '1 second'" });
    await pool.query("INSERT INTO user_phone_identities (user_id, firebase_uid, phone_e164) VALUES ($1, 'uid-tier', '+15550100003')", [phoned]);
    const tierOf = async (id) => (await limits.getIdentityTier(pool, id));
    assert.equal((await tierOf(fresh)).tier, 'unverified');
    assert.deepEqual([(await tierOf(phoned)).tier, (await tierOf(phoned)).exempt], ['phone', false]);
    assert.deepEqual([(await tierOf(earlier)).tier, (await tierOf(earlier)).exempt], ['phone', true]);
    // An admin gives unverified accounts less: the base drops, the phone tier keeps the full amount.
    await pool.query(
      `INSERT INTO platform_settings (key, value) VALUES ('user_weekly_limit_cents', '500'), ('user_weekly_limit_phone_cents', '5000')
       ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value`);
    limits.invalidate('user_weekly_limit_cents', 'user_weekly_limit_phone_cents');
    assert.equal(await limits.getEffectiveUserWeeklyLimitCents(pool, fresh), 500);
    assert.equal(await limits.getEffectiveUserWeeklyLimitCents(pool, phoned), 5000);
    assert.equal(await limits.getEffectiveUserWeeklyLimitCents(pool, earlier), 5000, 'an earlier member keeps the full amount');
    // Switched off, nobody is exempt any more: the tiers are the proofs alone.
    await ruleOff();
    assert.equal((await tierOf(earlier)).tier, 'unverified');
  });

  await t.test('identity_needed (the first-run ask and Home\'s card): held to the rule until a proof, or the rule goes', async () => {
    await ruleOn();
    const fresh = await account({ grantedAt: "NOW() + INTERVAL '1 second'" });
    const needed = async (id) => (await pool.query('SELECT identity_needed($1) AS v', [id])).rows[0].v;
    assert.equal(await needed(fresh), true);
    assert.equal(await needed(owner), false, 'let in before the switch');
    await pool.query(
      "INSERT INTO user_social_identities (user_id, provider, provider_subject, handle) VALUES ($1, 'github', '301', 'gh_n'), ($1, 'x', '401', 'x_n')",
      [fresh]);
    assert.equal(await needed(fresh), false, 'GitHub and X both');
    // "Not now" is a column of its own; answering twice keeps the first time.
    await pool.query('UPDATE users SET phone_ask_answered_at = COALESCE(phone_ask_answered_at, NOW()) WHERE id = $1', [fresh]);
    await ruleOff();
    const later = await account({ grantedAt: "NOW() + INTERVAL '1 second'" });
    assert.equal(await needed(later), false, 'off, nobody is held to it');
  });

  await t.test('the rollout: once, in production; verified tiers keep today\'s cap, new unverified members get $20', async () => {
    const rollout = require('../src/services/identity-rollout');
    await pool.query(
      `DELETE FROM platform_settings WHERE key IN ('identity_rule_since', 'identity_rule_rollout',
        'user_weekly_limit_phone_cents', 'user_weekly_limit_social_cents', 'user_weekly_limit_zk_cents')`);
    await pool.query(
      `INSERT INTO platform_settings (key, value) VALUES ('user_weekly_limit_cents', '5000'), ('user_weekly_limit_zk_cents', '9000')
       ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value`);
    assert.deepEqual(await rollout.applyIdentityRollout(pool, { env: { NODE_ENV: 'test' } }),
      { applied: false, reason: 'not_production' });
    assert.deepEqual(await rollout.applyIdentityRollout(pool, { env: { NODE_ENV: 'production', USERNODE_ENV: 'staging' } }),
      { applied: false, reason: 'not_production' });
    const earlier = await account({ grantedAt: "NOW() - INTERVAL '30 days'" });
    assert.deepEqual(await rollout.applyIdentityRollout(pool, { env: { NODE_ENV: 'production' } }),
      { applied: true, verifiedCents: 5000, unverifiedCents: 2000 });
    const settings = Object.fromEntries((await pool.query(
      "SELECT key, value FROM platform_settings WHERE key LIKE 'user_weekly_limit%' OR key LIKE 'identity_rule%'")).rows
      .map((r) => [r.key, r.value]));
    assert.equal(settings.user_weekly_limit_cents, '2000');
    assert.equal(settings.user_weekly_limit_phone_cents, '5000');
    assert.equal(settings.user_weekly_limit_social_cents, '5000');
    assert.equal(settings.user_weekly_limit_zk_cents, '9000', 'a tier an admin set keeps its figure');
    assert.ok(settings.identity_rule_since && settings.identity_rule_rollout);
    // Who gets what: an earlier member the full amount, a new unverified one $20.
    const fresh = await account({ grantedAt: "NOW() + INTERVAL '1 second'" });
    assert.equal(await limits.getEffectiveUserWeeklyLimitCents(pool, earlier), 5000);
    assert.equal(await limits.getEffectiveUserWeeklyLimitCents(pool, fresh), 2000);
    assert.equal(await needs(fresh, square), true);
    // Once: an admin's later change is never put back.
    await pool.query("UPDATE platform_settings SET value = '3000' WHERE key = 'user_weekly_limit_cents'");
    assert.deepEqual(await rollout.applyIdentityRollout(pool, { env: { NODE_ENV: 'production' } }),
      { applied: false, reason: 'done_before' });
    assert.equal((await pool.query("SELECT value FROM platform_settings WHERE key = 'user_weekly_limit_cents'")).rows[0].value, '3000');
    // Never raised: a deployment already under $20 keeps its own figure.
    await pool.query("DELETE FROM platform_settings WHERE key IN ('identity_rule_rollout', 'identity_rule_since')");
    await pool.query("UPDATE platform_settings SET value = '1500' WHERE key = 'user_weekly_limit_cents'");
    assert.equal((await rollout.applyIdentityRollout(pool, { env: { NODE_ENV: 'production' } })).unverifiedCents, 1500);
  });
});
