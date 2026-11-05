'use strict';

// The "This week" card's two reads (#5626) against the full PostgreSQL schema
// (src/routes/profile.js): seven UTC days whether or not a row exists, one
// person's rows alone, apps opened or used, and an index under the read that
// runs on every open of the profile.
//
// Skipped when no server is reachable, and required when TEST_DATABASE_URL
// is set.

const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const { Pool } = require('pg');
const profile = require('../src/routes/profile');

const DSN = process.env.TEST_DATABASE_URL || process.env.DATABASE_URL || 'postgres://postgres:postgres@127.0.0.1:5432/postgres';

test('the week against the full PostgreSQL schema', { timeout: 180000 }, async (t) => {
  const admin = new Pool({ connectionString: DSN, connectionTimeoutMillis: 2000 });
  try { await admin.query('SELECT 1'); } catch (err) {
    await admin.end();
    if (process.env.TEST_DATABASE_URL) throw err;
    t.skip('PostgreSQL unavailable; set TEST_DATABASE_URL to require this check'); return;
  }
  const name = 'profile_activity_' + crypto.randomBytes(6).toString('hex');
  await admin.query(`CREATE DATABASE ${name}`);
  const url = new URL(DSN); url.pathname = '/' + name;
  const pool = new Pool({ connectionString: String(url), max: 4 });
  t.after(async () => {
    await pool.end();
    await admin.query(`DROP DATABASE ${name}`);
    await admin.end();
  });
  await require('../src/db/schema-migrations').applySchemaWithLockRetry(pool);
  await require('../src/db/reference-data').seedReferenceData(pool);

  const user = async (username) => (await pool.query(
    `INSERT INTO users (username, password) VALUES ($1, 'x') RETURNING id`, [username])).rows[0].id;
  const app = async (slug) => (await pool.query(
    `INSERT INTO apps (name, slug, repo_url) VALUES ($1, $1, 'https://github.com/acme/' || $1) RETURNING id`, [slug])).rows[0].id;
  const me = await user('activity_me');
  const someone = await user('activity_someone');
  const [notes, runs, chess, old] = await Promise.all(['notes', 'runs', 'chess', 'old'].map(app));

  const { rows: [{ today }] } = await pool.query(
    `SELECT (CURRENT_TIMESTAMP AT TIME ZONE 'UTC')::date::text AS today`);
  const dayAgo = (n) => {
    const at = new Date(`${today}T00:00:00Z`);
    at.setUTCDate(at.getUTCDate() - n);
    return at.toISOString().slice(0, 10);
  };
  const time = (appId, by, n, seconds) => pool.query(
    `INSERT INTO app_activity (app_id, user_id, seconds_spent, date) VALUES ($1, $2, $3, $4)`,
    [appId, by, seconds, dayAgo(n)]);
  await time(notes, me, 0, 600);
  await time(runs, me, 0, 30);
  await time(notes, me, 6, 120); // the week's first day
  await time(old, me, 7, 9000); // a day too old
  await time(chess, someone, 0, 5000); // somebody else
  const opened = (appId, by, at) => pool.query(
    `INSERT INTO events (user_id, app_id, event_type, metadata, created_at)
     VALUES ($1, $2, 'dapp_opened', '{}'::jsonb, $3::timestamptz)`, [by, appId, at]);
  await opened(chess, me, `${dayAgo(6)}T00:00:00Z`); // opened, never used
  await opened(notes, me, `${dayAgo(1)}T12:00:00Z`); // counted once with its time
  await opened(old, me, `${dayAgo(7)}T23:59:59Z`); // a second too old
  await opened(old, someone, `${today}T00:00:00Z`); // somebody else
  await pool.query(
    `INSERT INTO events (user_id, app_id, event_type, metadata) VALUES ($1, $2, 'not_an_open', '{}'::jsonb)`,
    [me, old]).catch(() => {}); // the type may be constrained; either way it does not count

  const read = async (id) => profile.shapeActivity(
    (await pool.query(profile.SUMMARY_ACTIVITY_DAYS_SQL, [id])).rows,
    (await pool.query(profile.SUMMARY_ACTIVITY_APPS_SQL, [id])).rows[0]);

  const week = await read(me);
  assert.deepEqual(week.days.map((d) => d.date), [6, 5, 4, 3, 2, 1, 0].map(dayAgo), 'seven days, today last');
  assert.deepEqual(week.days.map((d) => d.seconds), [120, 0, 0, 0, 0, 0, 630]);
  assert.equal(week.totalSeconds, 750);
  assert.equal(week.appsOpened, 3, 'notes and runs by their time, chess by its open');

  const nobody = await read(await user('activity_new'));
  assert.equal(nobody.days.length, 7);
  assert.equal(nobody.totalSeconds, 0);
  assert.equal(nobody.appsOpened, 0);

  // A tiny table prefers a scan, so ask whether the index CAN serve the read.
  const client = await pool.connect();
  try {
    await client.query('SET enable_seqscan = off');
    const plan = (await client.query(
      `EXPLAIN ${profile.SUMMARY_ACTIVITY_DAYS_SQL.replace('$1', String(me))}`)).rows
      .map((row) => row['QUERY PLAN']).join('\n');
    assert.match(plan, /idx_app_activity_user_date/);
  } finally {
    await client.query('RESET enable_seqscan');
    client.release();
  }
});
