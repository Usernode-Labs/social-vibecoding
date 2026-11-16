'use strict';

// Admin › Onboarding flows, against the real schema in a throwaway database:
// required when TEST_DATABASE_URL is set, skipped when no server is
// reachable. The join's rules are pinned in tests/onboarding-flows.test.js;
// this is the reading end to end: everyone over all time by the door they
// came through, real people only, when each last did something, the people
// still waiting counted, and the first season naming the early members.

const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const { Pool } = require('pg');

const journey = require('../src/services/journey');
const flows = require('../src/services/onboarding-flows');

const DSN = process.env.TEST_DATABASE_URL || process.env.DATABASE_URL || 'postgres://postgres:postgres@127.0.0.1:5432/postgres';

test('onboarding flows: one row per real person over all time, with their door, their lane and when they last did something',
  { timeout: 120000 }, async (t) => {
    const admin = new Pool({ connectionString: DSN, connectionTimeoutMillis: 2000 });
    try { await admin.query('SELECT 1'); } catch (err) {
      await admin.end();
      if (process.env.TEST_DATABASE_URL) throw err;
      t.skip('PostgreSQL unavailable; set TEST_DATABASE_URL to require this check'); return;
    }
    const name = 'onboarding_flows_' + crypto.randomBytes(6).toString('hex');
    await admin.query(`CREATE DATABASE ${name}`);
    const url = new URL(DSN); url.pathname = '/' + name;
    const pool = new Pool({ connectionString: String(url), max: 8 });
    t.after(async () => {
      await pool.end();
      await admin.query(`DROP DATABASE IF EXISTS ${name}`);
      await admin.end();
    });
    await pool.query(fs.readFileSync(require.resolve('../src/db/schema.sql'), 'utf8'));

    const now = new Date('2026-11-13T12:00:00Z');
    const user = async (username, cols = {}) => {
      const base = { has_platform_access: true, password_set: true, ...cols };
      const keys = Object.keys(base);
      const { rows } = await pool.query(
        `INSERT INTO users (username, password, ${keys.join(', ')})
         VALUES ($1, 'x', ${keys.map((_, i) => `$${i + 2}`).join(', ')}) RETURNING id`,
        [username, ...keys.map((k) => base[k])]
      );
      return Number(rows[0].id);
    };
    const signup = async (email, cols = {}) => {
      const base = { email, ...cols };
      const keys = Object.keys(base);
      const { rows } = await pool.query(
        `INSERT INTO waitlist_signups (${keys.join(', ')})
         VALUES (${keys.map((_, i) => `$${i + 1}`).join(', ')}) RETURNING id`,
        keys.map((k) => base[k])
      );
      return Number(rows[0].id);
    };
    const project = async (slug, title, by, visibility, at) => {
      const { rows } = await pool.query(
        `INSERT INTO apps (name, slug, created_by, status, view_visibility, collab_visibility, created_at)
         VALUES ($1, $2, $3, 'running', $4, $4, $5) RETURNING id`,
        [title, slug, by, visibility, at]
      );
      const made = await pool.query('SELECT community_id FROM apps WHERE id = $1', [rows[0].id]);
      return { id: Number(rows[0].id), community: Number(made.rows[0].community_id) };
    };
    const used = (app, who, date, seconds = 90) => pool.query(
      'INSERT INTO app_activity (app_id, user_id, seconds_spent, date) VALUES ($1, $2, $3, $4)', [app, who, seconds, date]);

    // The first season is over: whoever had an account by its end was here
    // before the waitlist. An internal season does not name anybody.
    await pool.query(
      `INSERT INTO seasons (name, starts_at, ends_at, internal) VALUES
         ('Dry run', '2026-01-01', '2026-02-01', TRUE),
         ('Season 1', '2026-04-01', '2026-06-30', FALSE),
         ('Season 2', '2026-10-01', '2026-12-31', FALSE)`);

    // Old: here since Season 1, let in directly, makes a public project and
    // still contributes. Ana: off the waitlist, joins Old's private project
    // by his link and votes. Gone: off the waitlist, active once, nothing in
    // two months. Nia: off the waitlist three days ago, no account. Sam: off
    // the waitlist a month ago, no account. Wes: still waiting.
    const old = await user('old_hand', { created_at: '2026-05-01T10:00:00Z', platform_access_granted_at: '2026-05-01T10:00:00Z' });
    const ana = await user('ana', { created_at: '2026-10-02T10:00:00Z', platform_access_granted_at: '2026-10-02T10:00:00Z' });
    const gone = await user('gone', { created_at: '2026-08-21T10:00:00Z', platform_access_granted_at: '2026-08-21T10:00:00Z' });
    const lead = await user('lead', { is_admin: true, created_at: '2026-01-01T10:00:00Z' });
    const skipped = await user('left_out', { created_at: '2026-09-01T10:00:00Z', platform_access_granted_at: '2026-09-01T10:00:00Z' });
    await signup('ana@example.com', {
      submitted_at: '2026-09-01T09:00:00Z', released_at: '2026-10-01T09:00:00Z', linked_user_id: ana,
      answers: JSON.stringify({ discovery: { source: 'friend' } }), referrer_host: 't.co',
    });
    await signup('gone@example.com', { submitted_at: '2026-08-01T09:00:00Z', released_at: '2026-08-20T09:00:00Z', linked_user_id: gone });
    const nia = await signup('nia@example.com', { submitted_at: '2026-10-20T09:00:00Z', released_at: '2026-11-10T09:00:00Z' });
    const sam = await signup('sam@example.com', { submitted_at: '2026-09-10T09:00:00Z', released_at: '2026-10-10T09:00:00Z' });
    await signup('wes@example.com', { submitted_at: '2026-10-14T09:00:00Z', confirmed_at: '2026-10-14T09:05:00Z' });
    await signup('lead@example.com', { submitted_at: '2026-01-01T09:00:00Z', released_at: '2026-01-02T09:00:00Z', linked_user_id: lead });

    const atlas = await project('atlas', 'Atlas', old, 'public', '2026-09-02T10:00:00Z');
    const garden = await project('garden', 'Garden', old, 'private', '2026-09-03T10:00:00Z');

    // Old's link into Garden, which Ana follows once she is in.
    const link = Number((await pool.query(
      `INSERT INTO community_invites (token, community_id, app_id, created_by, created_at)
       VALUES ($1, $2, $3, $4, '2026-10-03T10:00:00Z') RETURNING id`,
      [crypto.randomBytes(8).toString('hex'), garden.community, garden.id, old])).rows[0].id);
    await pool.query(
      `INSERT INTO community_invite_redemptions (invite_id, user_id, status, created_at, applied_at)
       VALUES ($1, $2, 'joined', '2026-10-04T09:00:00Z', '2026-10-04T09:00:00Z')`, [link, ana]);
    await pool.query(
      `INSERT INTO app_collaborators (app_id, user_id, status, invited_by, created_at, accepted_at, accepted_via)
       VALUES ($1, $2, 'member', $3, '2026-10-04T09:00:00Z', '2026-10-04T09:00:00Z', 'link')`, [garden.id, ana, old]);
    await pool.query(
      `INSERT INTO community_members (community_id, user_id, source, joined_at)
       VALUES ($1, $2, 'joined', '2026-10-04T09:00:00Z') ON CONFLICT DO NOTHING`, [garden.community, ana]);

    // What they did.
    const change = async (app, who, at, mergedAt) => Number((await pool.query(
      `INSERT INTO chat_sessions (app_id, user_id, status, pr_number, created_at, merged_at)
       VALUES ($1, $2, $3, 7, $4, $5) RETURNING id`, [app, who, mergedAt ? 'merged' : 'active', at, mergedAt])).rows[0].id);
    const live = await change(atlas.id, old, '2026-11-05T10:00:00Z', '2026-11-06T10:00:00Z');
    await pool.query("INSERT INTO pr_votes (session_id, user_id, vote, created_at) VALUES ($1, $2, 'yes', '2026-11-05T12:00:00Z')", [live, ana]);
    await used(garden.id, ana, '2026-10-05');
    await used(garden.id, ana, '2026-11-11');
    await used(atlas.id, ana, '2026-11-11', 10); // under 30 seconds is not a day
    await pool.query(
      "INSERT INTO feedback_reports (user_id, target, app_id, description, created_at) VALUES ($1, 'app', $2, 'slow', '2026-09-01T10:00:00Z')",
      [gone, atlas.id]);
    await used(atlas.id, gone, '2026-08-30');
    await used(atlas.id, gone, '2026-09-02');
    await used(atlas.id, skipped, '2026-11-01');

    const ctx = { now, leftOutIds: [skipped] };

    // Everyone, once each, in the order they arrived.
    const mile = await journey.everyoneMile(pool, ctx);
    assert.deepEqual(mile.people.map((p) => (p.hasAccount ? p.name : `#${p.signupId}`)), ['old_hand', 'gone', 'ana', `#${sam}`, `#${nia}`],
      'staff, the left-out list and people still waiting are nobody\'s row');
    assert.equal(mile.cut, false);
    const m = (n) => mile.people.find((p) => p.name === n);
    assert.equal(m('old_hand').releasedAt, null, 'never on the waitlist');
    assert.equal(new Date(m('ana').releasedAt).toISOString(), '2026-10-01T09:00:00.000Z');
    assert.equal(m('ana').invite.by, 'old_hand');
    assert.equal(m('ana').cameFrom.waitlist.referrerHost, 't.co');

    // When each person last contributed, and last spent a day in an app.
    const last = await journey.lastActs(pool, ctx);
    assert.equal(new Date(last.get(old).lastContribAt).toISOString(), '2026-11-06T10:00:00.000Z', 'their change going live');
    assert.equal(new Date(last.get(ana).lastContribAt).toISOString(), '2026-11-05T12:00:00.000Z', 'a vote');
    assert.equal(last.get(ana).lastAppDay, '2026-11-11');
    assert.equal(last.get(gone).lastAppDay, '2026-09-02');
    assert.equal(last.has(skipped), false);

    // The people still waiting, counted.
    const waiting = await journey.waitingSummary(pool, ctx);
    assert.equal(waiting.people, 1);
    assert.deepEqual(waiting.waited, [['2_to_5_weeks', 1]]);
    assert.deepEqual(waiting.months, [['2026-10', 1]]);

    const early = await flows.earlySeason(pool, now);
    assert.equal(early.label, 'Season 1', 'the first season that is not internal');
    assert.equal(new Date(early.until).toISOString().slice(0, 10), '2026-06-30');
    assert.equal(await flows.earlySeason(pool, new Date('2026-05-01T00:00:00Z')), null, 'a season still running names nobody');

    // The reading itself.
    const read = await flows.reading(pool, ctx);
    const p = (n) => read.people.find((x) => x.n === n);
    assert.deepEqual(read.people.map((x) => x.n), ['old_hand', 'gone', 'ana', `Signup #${sam}`, `Signup #${nia}`]);
    assert.deepEqual(read.early, { label: 'Season 1', until: '2026-06-30' });

    assert.deepEqual([p('old_hand').door, p('old_hand').src, p('old_hand').s1], ['direct', 'season1', true]);
    assert.deepEqual(p('old_hand').made.map((x) => [x.n, x.aud]), [['Atlas', 'public'], ['Garden', 'private']]);
    assert.deepEqual(p('old_hand').shared, [{ n: 'Garden', aud: 'private', own: true, inv: [ana] }]);
    assert.deepEqual([p('old_hand').lane, p('old_hand').accepted, p('old_hand').recent], ['both', 1, true],
      'his link brought someone into a private project, and his change is live on a public one');

    assert.deepEqual([p('ana').door, p('ana').src, p('ana').linkJoin, p('ana').wait], ['waitlist', 'friend', true, 30],
      'she was in before she followed the link, so her door is the waitlist');
    assert.deepEqual(p('ana').arr, { t: 'rec', l: 'X' });
    assert.deepEqual([p('ana').inv.by, p('ana').inv.n, p('ana').inv.aud, p('ana').inv.status], ['old_hand', 'Garden', 'private', 'joined']);
    assert.deepEqual([p('ana').pubContrib, p('ana').lane, p('ana').lastC, p('ana').lastA], [true, 'both', 8, 2]);

    assert.deepEqual([p('gone').lane, p('gone').out, p('gone').recent, p('gone').pubApp], ['none', 'lapsed', false, 'Atlas'],
      'contributed and came back, and nothing in the last four weeks');

    assert.deepEqual([p(`Signup #${sam}`).got, p(`Signup #${sam}`).noAccount, p(`Signup #${sam}`).lane], ['mail_none', true, 'none']);
    assert.deepEqual([p(`Signup #${nia}`).got, p(`Signup #${nia}`).tooNew, p(`Signup #${nia}`).k], ['new', true, `s${nia}`],
      'let off three days ago: too early to say');

    assert.deepEqual(read.pubApps.map((a) => [a.n, a.back]), [['Atlas', 1]]);
    assert.equal(read.waiting.people, 1);
    assert.equal(read.cut, false);
  });
