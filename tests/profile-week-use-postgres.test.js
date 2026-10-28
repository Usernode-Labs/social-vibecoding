// The profile's "This week" read (#5966) against a real database.
//
// WEEK_USE_SQL is what turns app_activity into the This week card's numbers:
// the viewer's own seconds for one Monday-to-Sunday week, summed per app,
// with the apps they made themselves left out — the same rule and the same
// week the 10 minute app challenge scores by. Pinned here rather than on the
// text of the statement, because what matters is the numbers it returns: a
// row outside the week, another person's activity and the viewer's own app
// must all stay out of it, and two apps must stay apart.
//
// Run with: node --test tests/profile-week-use-postgres.test.js
'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const { Pool } = require('pg');

const profile = require('../src/routes/profile');

const DSN = process.env.TEST_DATABASE_URL
  || process.env.DATABASE_URL
  || 'postgres://postgres:postgres@127.0.0.1:5432/postgres';

test('one person\'s week of app use: their apps only, this week only (PostgreSQL)',
  { timeout: 180000 }, async (t) => {
    const admin = new Pool({ connectionString: DSN, connectionTimeoutMillis: 2_000 });
    try { await admin.query('SELECT 1'); } catch (error) {
      await admin.end();
      if (process.env.TEST_DATABASE_URL) throw error;
      t.skip('PostgreSQL unavailable; set TEST_DATABASE_URL to require this check');
      return;
    }
    const name = `profile_week_${crypto.randomBytes(6).toString('hex')}`;
    await admin.query(`CREATE DATABASE ${name}`);
    const url = new URL(DSN);
    url.pathname = `/${name}`;
    const pool = new Pool({ connectionString: String(url), max: 4 });
    t.after(async () => {
      await pool.end();
      await admin.query(`DROP DATABASE ${name}`);
      await admin.end();
    });
    const schema = fs.readFileSync(require.resolve('../src/db/schema.sql'), 'utf8');
    await pool.query(schema);

    const viewer = (await pool.query(
      `INSERT INTO users (username, password) VALUES ('week_viewer', 'unused') RETURNING id`
    )).rows[0];
    const other = (await pool.query(
      `INSERT INTO users (username, password) VALUES ('week_other', 'unused') RETURNING id`
    )).rows[0];
    const app = async (slug, createdBy) => (await pool.query(
      `INSERT INTO apps (slug, name, created_by, view_visibility, collab_visibility)
       VALUES ($1, $2, $3, 'public', 'public') RETURNING id`,
      [slug, slug === 'book-club' ? 'Book Club' : 'Garden Swap', createdBy]
    )).rows[0];
    const bookClub = await app('book-club', other.id);
    const garden = await app('garden-swap', other.id);
    const mine = await app('my-own-app', viewer.id);

    // Two days in the week for one app, another app once, an app the viewer
    // made, an app whose creator is unknown (NULL counts, as for the
    // challenge), another person's activity, and a day either side of it.
    const orphan = await app('orphan-app', null);
    const activity = (appId, userId, date, seconds) => pool.query(
      `INSERT INTO app_activity (app_id, user_id, date, seconds_spent) VALUES ($1, $2, $3::date, $4)`,
      [appId, userId, date, seconds]
    );
    await activity(bookClub.id, viewer.id, '2026-10-26', 400);
    await activity(bookClub.id, viewer.id, '2026-10-28', 145);
    await activity(garden.id, viewer.id, '2026-10-27', 300);
    await activity(mine.id, viewer.id, '2026-10-27', 900);
    await activity(orphan.id, viewer.id, '2026-10-29', 40);
    await activity(bookClub.id, other.id, '2026-10-27', 1200);
    await activity(garden.id, viewer.id, '2026-10-25', 700); // the Sunday before
    await activity(garden.id, viewer.id, '2026-11-02', 700); // the Monday after

    const { rows } = await pool.query(profile.WEEK_USE_SQL, [viewer.id, '2026-10-26', '2026-11-01']);
    assert.deepEqual(rows.map((r) => [r.slug, Number(r.seconds)]), [
      ['book-club', 545],
      ['garden-swap', 300],
      ['orphan-app', 40],
    ], 'this person, this week, apps they did not make, most used first');

    // The shape the client reads, from the very rows the query returned.
    const week = profile.shapeWeek(rows, { start: '2026-10-26', end: '2026-11-01' });
    assert.equal(week.minutes, 14);
    assert.equal(week.appCount, 3);
    assert.equal(week.apps[0].name, 'Book Club');
    assert.equal(week.apps[0].minutes, 9);
    assert.equal(week.apps[1].minutes, 5);
    assert.equal(week.apps[2].minutes, 0, 'under a minute is listed, as 0 whole minutes');

    // A week with nothing in it is zeros, not a failure.
    const quiet = await pool.query(profile.WEEK_USE_SQL, [viewer.id, '2026-11-09', '2026-11-15']);
    assert.deepEqual(quiet.rows, []);
    assert.equal(profile.shapeWeek(quiet.rows, {}).minutes, 0);

    // The index the read needs: their dates are found without scanning every
    // app's activity.
    const plan = await pool.query(
      `EXPLAIN SELECT sum(seconds_spent) FROM app_activity WHERE user_id = $1 AND date >= $2::date AND date <= $3::date`,
      [viewer.id, '2026-10-26', '2026-11-01']
    );
    assert.ok(plan.rows.some((r) => /idx_app_activity_user_date/.test(r['QUERY PLAN'])),
      'the (user_id, date) index answers one person\'s week');
  });
