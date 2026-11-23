'use strict';

// Homeroom bot's "GitHub and X, both older than a minimum age" signal
// (github_x_age) against the full schema: the creation dates a link and a
// re-verify record (services/social-identity.js), the backfill writing the
// ones linked before (services/social-account-age.js), and readSignals
// counting both accounts only when both dates are known and old enough.
//
// Run with: TEST_DATABASE_URL=postgres://... node --test tests/social-account-age-postgres.test.js

const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const { Pool } = require('pg');

const DSN = process.env.TEST_DATABASE_URL || process.env.DATABASE_URL
  || 'postgres://postgres:postgres@127.0.0.1:5432/postgres';

const identity = require('../src/services/social-identity');
const age = require('../src/services/social-account-age');
const rule = require('../src/services/homeroom-bot-verified');

const DAY = 24 * 60 * 60 * 1000;
const daysAgo = (n) => new Date(Date.now() - n * DAY).toISOString();

test('account ages against the full PostgreSQL schema', { timeout: 180000 }, async (t) => {
  const admin = new Pool({ connectionString: DSN, connectionTimeoutMillis: 2000 });
  try { await admin.query('SELECT 1'); } catch (err) {
    await admin.end();
    if (process.env.TEST_DATABASE_URL) throw err;
    t.skip('PostgreSQL unavailable; set TEST_DATABASE_URL to require this check');
    return;
  }
  const name = `account_age_${crypto.randomBytes(6).toString('hex')}`;
  await admin.query(`CREATE DATABASE ${name}`);
  const url = new URL(DSN); url.pathname = `/${name}`;
  const pool = new Pool({ connectionString: String(url), max: 4 });
  t.after(async () => {
    await pool.end();
    await admin.query(`DROP DATABASE ${name}`);
    await admin.end();
  });
  await require('../src/db/schema-migrations').applySchemaWithLockRetry(pool);

  let seq = 0;
  async function user(prefix) {
    const { rows: [row] } = await pool.query(
      "INSERT INTO users (username, password, has_platform_access) VALUES ($1, 'x', TRUE) RETURNING id",
      [`${prefix}_${++seq}`]);
    return row.id;
  }
  let subject = 1000;
  async function link(userId, provider, createdAt, source = 'provider') {
    await pool.query(
      `INSERT INTO user_social_identities (user_id, provider, provider_subject, handle, account_created_at, account_created_source)
       VALUES ($1, $2, $3, $4, $5, $6)`,
      [userId, provider, String(++subject), `${provider}_${subject}`, createdAt, createdAt ? source : null]);
  }
  const row = async (userId, provider) => (await pool.query(
    `SELECT account_created_at, account_created_source FROM user_social_identities WHERE user_id = $1 AND provider = $2`,
    [userId, provider])).rows[0];
  const aged = async (userId, minAccountAgeDays) => (await rule.readSignals(pool, userId, { minAccountAgeDays })).github_x_age;

  await t.test('both linked and both old enough count; one too new, one missing or one unknown does not', async () => {
    const both = await user('both');
    await link(both, 'github', daysAgo(400));
    await link(both, 'x', daysAgo(800), 'derived');
    const newGithub = await user('new_gh');
    await link(newGithub, 'github', daysAgo(30));
    await link(newGithub, 'x', daysAgo(800));
    const newX = await user('new_x');
    await link(newX, 'github', daysAgo(800));
    await link(newX, 'x', daysAgo(364));
    const onlyGithub = await user('only_gh');
    await link(onlyGithub, 'github', daysAgo(4000));
    const unknown = await user('unknown');
    await link(unknown, 'github', daysAgo(4000));
    await link(unknown, 'x', null);
    const nothing = await user('nothing');

    const atDefault = rule.DEFAULT_MIN_ACCOUNT_AGE_DAYS;
    assert.equal(atDefault, 365);
    assert.deepEqual(
      await Promise.all([both, newGithub, newX, onlyGithub, unknown, nothing].map((id) => aged(id, atDefault))),
      [true, false, false, false, false, false],
      'at the default year: both old enough only',
    );
    const flags = await rule.readSignals(pool, newGithub);
    assert.deepEqual([flags.github, flags.x, flags.github_x_age], [true, true, false], 'the separate signals are as before');
    assert.deepEqual(
      await Promise.all([both, newGithub, newX, onlyGithub, unknown, nothing].map((id) => aged(id, 0))),
      [true, true, true, false, false, false],
      'at 0 days: both linked with known dates, and an unknown date still never counts',
    );
    assert.equal(await aged(both, 500), false, 'GitHub at 400 days is under 500');
    assert.equal(await aged(both, 400), true);
    // The setting reaches the read through the rule.
    const s = { worksFor: 'verified', verifiedSignals: ['github_x_age'], verifiedGrandfather: false };
    assert.equal(await rule.verifyRequired(pool, { ...s, verifiedMinAccountAgeDays: 30 }, { id: newGithub }), false);
    assert.equal(await rule.verifyRequired(pool, { ...s, verifiedMinAccountAgeDays: 365 }, { id: newGithub }), true);
    assert.equal(await rule.verifyRequired(pool, s, { id: newGithub }), true, 'unset is the default year');
  });

  await t.test('a link records the provider\'s date; a re-verify keeps or corrects it; a replacement brings its own', async () => {
    const id = await user('linker');
    await identity.finishIdentityVerification(pool, id, {
      provider: 'github', subject: '583231', handle: 'octocat', accountCreatedAt: '2011-01-25T18:44:36Z',
    }, 'connect');
    let gh = await row(id, 'github');
    assert.deepEqual([gh.account_created_at.toISOString(), gh.account_created_source], ['2011-01-25T18:44:36.000Z', 'provider']);
    await identity.finishIdentityVerification(pool, id, { provider: 'github', subject: '583231', handle: 'octocat2' }, 'refresh');
    gh = await row(id, 'github');
    assert.equal(gh.account_created_at.toISOString(), '2011-01-25T18:44:36.000Z', 'a re-verify that reports none keeps it');

    await identity.finishIdentityVerification(pool, id, { provider: 'x', subject: '1212092628029698048', handle: 'x_one' }, 'connect');
    assert.equal((await row(id, 'x')).account_created_at, null, 'none reported: unknown until the backfill');
    await age.backfillX(pool);
    let x = await row(id, 'x');
    assert.deepEqual([x.account_created_at.toISOString(), x.account_created_source], ['2019-12-31T19:26:16.771Z', 'derived']);
    await identity.finishIdentityVerification(pool, id, {
      provider: 'x', subject: '1212092628029698048', handle: 'x_one', accountCreatedAt: '2019-12-31T19:26:16.000Z',
    }, 'refresh');
    x = await row(id, 'x');
    assert.deepEqual([x.account_created_at.toISOString(), x.account_created_source], ['2019-12-31T19:26:16.000Z', 'provider'],
      'X\'s own date replaces the derived one');

    const staged = await identity.finishIdentityVerification(pool, id, {
      provider: 'x', subject: '2244994945', handle: 'x_two', accountCreatedAt: '2013-12-14T04:35:55.000Z',
    }, 'replace');
    assert.equal(staged.outcome, 'pending_replacement');
    await identity.confirmIdentityReplacement(pool, id, 'x', true);
    x = await row(id, 'x');
    assert.deepEqual([x.account_created_at.toISOString(), x.account_created_source], ['2013-12-14T04:35:55.000Z', 'provider'],
      'the replacement account\'s own date, not the old one\'s');
  });

  await t.test('the backfill: X from snowflake ids, sequential ones left unknown, GitHub from its user API', async () => {
    const id = await user('older');
    await pool.query(
      `INSERT INTO user_social_identities (user_id, provider, provider_subject, handle)
       VALUES ($1, 'x', '1228393702244134912', 'x_older'), ($1, 'github', '9919', 'gh-older')`, [id]);
    const seqId = await user('seq');
    await pool.query("INSERT INTO user_social_identities (user_id, provider, provider_subject, handle) VALUES ($1, 'x', '12', 'jack_like')", [seqId]);
    const reader = { allows: () => true, createdAt: async (s) => (s === '9919' ? '2008-04-03T21:23:35Z' : null) };
    const out = await age.backfill(pool, { reader, githubLimit: 20 });
    assert.ok(out.x.unknown >= 1);
    assert.equal((await row(id, 'x')).account_created_source, 'derived');
    assert.equal((await row(seqId, 'x')).account_created_at, null, 'a sequential id stays unknown');
    const gh = await row(id, 'github');
    assert.deepEqual([gh.account_created_at.toISOString(), gh.account_created_source], ['2008-04-03T21:23:35.000Z', 'provider']);
    assert.equal(await aged(id, 365), true, 'and now both count');
    assert.deepEqual((await pool.query(
      "SELECT obj_description('user_social_identities'::regclass) AS c")).rows[0].c, 'staging:private');
  });
});
