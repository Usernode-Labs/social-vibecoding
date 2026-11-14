'use strict';

// The Journey page's waiting cohort, against the real schema in a throwaway
// database: required when TEST_DATABASE_URL is set, skipped when no server is
// reachable. The step rules are pure and pinned in
// tests/journey-waiting-cohort.test.js; this is the query itself: who counts
// as still on the waitlist, and who does not.

const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const { Pool } = require('pg');

const journey = require('../src/services/journey');

const DSN = process.env.TEST_DATABASE_URL || process.env.DATABASE_URL || 'postgres://postgres:postgres@127.0.0.1:5432/postgres';

test('still on the waitlist: everyone not let off, once each, longest wait first, and nobody who is not waiting',
  { timeout: 120000 }, async (t) => {
    const admin = new Pool({ connectionString: DSN, connectionTimeoutMillis: 2000 });
    try { await admin.query('SELECT 1'); } catch (err) {
      await admin.end();
      if (process.env.TEST_DATABASE_URL) throw err;
      t.skip('PostgreSQL unavailable; set TEST_DATABASE_URL to require this check'); return;
    }
    const name = 'journey_waiting_' + crypto.randomBytes(6).toString('hex');
    await admin.query(`CREATE DATABASE ${name}`);
    const url = new URL(DSN); url.pathname = '/' + name;
    const pool = new Pool({ connectionString: String(url), max: 4 });
    t.after(async () => {
      await pool.end();
      await admin.query(`DROP DATABASE IF EXISTS ${name}`);
      await admin.end();
    });
    await pool.query(fs.readFileSync(require.resolve('../src/db/schema.sql'), 'utf8'));

    const now = new Date('2026-11-12T12:00:00Z');
    const user = async (username, cols = {}) => {
      const base = { has_platform_access: false, password_set: true, needs_username_choice: false, ...cols };
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

    // Waiting, in the order they joined.
    const oldest = await signup('oldest@example.com', {
      submitted_at: '2026-08-01T09:00:00Z', confirmed_at: '2026-08-01T09:10:00Z', source: 'form',
      answers: JSON.stringify({ discovery: { source: 'friend' }, made_note: 'a thing I made' }),
      referrer_host: 't.co', utm_source: 'x', utm_campaign: 'launch',
    });
    const middle = await signup('middle@example.com', {
      submitted_at: '2026-09-15T09:00:00Z', source: 'partner:acme', answers: JSON.stringify({ discovery: { source: 'x' } }),
    });
    const roomId = await user('waiting_room', { email: 'room@example.com' });
    const room = await signup('room@example.com', {
      submitted_at: '2026-10-20T09:00:00Z', source: 'account', linked_user_id: roomId,
    });
    // The same person twice (two sign-ups linked to one account) is one row.
    await signup('room.again@example.com', { submitted_at: '2026-10-25T09:00:00Z', source: 'app', linked_user_id: roomId });

    // Not waiting, each for its own reason.
    await signup('released@example.com', { submitted_at: '2026-08-02T09:00:00Z', released_at: '2026-10-01T09:00:00Z' });
    await signup('later@example.com', { submitted_at: '2026-11-20T09:00:00Z' }); // joined after "now"
    await signup('tester@example.com', { submitted_at: '2026-09-01T09:00:00Z', source: 'test' });
    await signup('someone@onhomeroom.com', { submitted_at: '2026-09-02T09:00:00Z' }); // a team address
    const inId = await user('got_in_another_way', { has_platform_access: true, platform_access_granted_at: '2026-10-05T09:00:00Z' });
    await signup('in@example.com', { submitted_at: '2026-09-03T09:00:00Z', linked_user_id: inId });
    const staffId = await user('staffer', { is_admin: true, email: 'boss@example.com' });
    await signup('staff.signup@example.com', { submitted_at: '2026-09-04T09:00:00Z', linked_user_id: staffId });
    await signup('boss+wl1@example.com', { submitted_at: '2026-09-05T09:00:00Z' }); // an admin's +tag address
    const leftOutId = await user('left_out');
    await signup('leftout@example.com', { submitted_at: '2026-09-06T09:00:00Z', linked_user_id: leftOutId });

    const read = await journey.cohorts(pool, { now, leftOutIds: [leftOutId] });
    assert.deepEqual(read.waiting, { people: 3 }, 'three people are waiting');

    const mile = await journey.firstMile(pool, { day: 'waiting', now, leftOutIds: [leftOutId] });
    assert.equal(mile.cohort, 'waiting');
    assert.equal(mile.total, 3);
    assert.deepEqual(mile.people.map((p) => p.signupId), [oldest, middle, room], 'the longest wait first, nobody twice');
    assert.deepEqual(mile.people.map((p) => p.name), ['oldest@example.com', 'middle@example.com', 'waiting_room']);
    assert.ok(mile.people.every((p) => p.stuckAt === 'wl_released' && p.door === 'waitlist'));

    const [a, b, c] = mile.people;
    assert.deepEqual(a.steps.map((s) => s.state), ['done', 'done', 'done', 'not_yet', 'stuck'], 'confirmed and answered, no account');
    assert.equal(a.daysSince, 103);
    assert.equal(a.waitlist.waitedDays, 103);
    assert.equal(a.waitlist.source, 'form');
    assert.equal(a.waitlist.discovery, 'friend');
    assert.equal(a.waitlist.answeredFollowUp, true);
    assert.equal(a.cameFrom.waitlist.referrerHost, 't.co');
    assert.equal(a.cameFrom.waitlist.utmSource, 'x');
    assert.equal(a.cameFrom.waitlist.utmCampaign, 'launch');

    assert.deepEqual(b.steps.map((s) => s.state), ['done', 'not_yet', 'not_yet', 'not_yet', 'stuck']);
    assert.equal(b.waitlist.source, 'partner:acme');
    assert.equal(b.waitlist.discovery, 'x');
    assert.equal(b.cameFrom.waitlist.referrerHost, null, 'nothing recorded for a sign-up that sent no source');

    assert.equal(c.userId, roomId);
    assert.equal(c.hasAccount, true);
    assert.deepEqual(c.steps.map((s) => s.state), ['done', 'not_yet', 'not_yet', 'done', 'stuck'], 'an account in the waiting room');
    assert.deepEqual(c.onboard, { shown: false, done: null, total: null, complete: false });

    // The counts over the cohort.
    assert.deepEqual(mile.steps.map((s) => [s.key, s.passed, s.stuck.length]), [
      ['wl_joined', 3, 0], ['wl_confirmed', 1, 0], ['wl_answered', 1, 0], ['wl_account', 1, 0], ['wl_released', 0, 3],
    ]);

    // The cap cuts the rows, never the count.
    const { rows: capped } = await pool.query(journey.FIRST_MILE_WAITING_SQL,
      [2, now, ['usernode%', 'staging%', 'homeroom%'], [leftOutId]]);
    assert.equal(capped.length, 2);
    assert.equal(capped[0].total, 3);
  });
