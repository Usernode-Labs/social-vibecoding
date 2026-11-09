'use strict';

// #6409: Homeroom bot says it is fixing a failing check once per failing
// version, from the fix turn's start callback. Two reads keep that true
// across retries and restarts, and they are SQL, so they run here against
// the real PostgreSQL schema: claimChecksStart records the start line for a
// head and attempt, and botFixLanded says whether the bot's own fix already
// landed on an earlier head.
//
// Run with: TEST_DATABASE_URL=postgres://… node --test tests/homeroom-bot-checks-start-postgres.test.js

const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const { Pool } = require('pg');

const bot = require('../src/services/homeroom-bot');

const DSN = process.env.TEST_DATABASE_URL || process.env.DATABASE_URL
  || 'postgres://postgres:postgres@127.0.0.1:5432/postgres';

const HEAD = 'a'.repeat(40);
const NEW_HEAD = 'b'.repeat(40);

test('the start line is claimed once per failing head and attempt, and the bot\'s own earlier fix is seen', { timeout: 180000 }, async (t) => {
  const root = new Pool({ connectionString: DSN, connectionTimeoutMillis: 2000 });
  try { await root.query('SELECT 1'); } catch (err) {
    await root.end();
    if (process.env.TEST_DATABASE_URL) throw err;
    t.skip('PostgreSQL unavailable; set TEST_DATABASE_URL to require this check');
    return;
  }
  const name = `bot_checks_start_${crypto.randomBytes(6).toString('hex')}`;
  await root.query(`CREATE DATABASE ${name}`);
  const url = new URL(DSN); url.pathname = `/${name}`;
  const pool = new Pool({ connectionString: String(url), max: 4 });
  t.after(async () => {
    await pool.end();
    await root.query(`DROP DATABASE ${name}`);
    await root.end();
  });
  await pool.query(fs.readFileSync(require.resolve('../src/db/schema.sql'), 'utf8'));

  const { rows: [ada] } = await pool.query(
    "INSERT INTO users (username, password, has_platform_access) VALUES ('ada', 'x', TRUE) RETURNING id");
  const { rows: [app] } = await pool.query(
    `INSERT INTO apps (name, slug, status, repo_url)
     VALUES ('Homeroom', 'usernode-2d5619', 'running', 'https://github.com/Usernode-Labs/social-vibecoding')
     RETURNING id`);
  const { rows: [session] } = await pool.query(
    `INSERT INTO chat_sessions (app_id, user_id, status, branch_name)
     VALUES ($1, $2, 'promoted', 'dev/homeroom_bot-5001') RETURNING id`, [app.id, ada.id]);
  const { rows: [other] } = await pool.query(
    `INSERT INTO chat_sessions (app_id, user_id, status, branch_name)
     VALUES ($1, $2, 'promoted', 'dev/homeroom_bot-5002') RETURNING id`, [app.id, ada.id]);

  // The first start is this attempt's: the line goes out.
  assert.equal(await bot.claimChecksStart(pool, { app, session, head: HEAD, attempt: 'start' }), true);
  // A retry or a restart on the same head and attempt claims nothing.
  assert.equal(await bot.claimChecksStart(pool, { app, session, head: HEAD, attempt: 'start' }), false);
  // A SHA is a SHA in any case: the head is stored lowercased.
  assert.equal(await bot.claimChecksStart(pool, { app, session, head: HEAD.toUpperCase(), attempt: 'start' }), false);
  // A second try on the same head after running out of time is its own attempt.
  assert.equal(await bot.claimChecksStart(pool, { app, session, head: HEAD, attempt: 'again' }), true);
  // A new failing head gets its own start line.
  assert.equal(await bot.claimChecksStart(pool, { app, session, head: NEW_HEAD, attempt: 'also' }), true);
  // Another change's claim does not count as this one's.
  assert.equal(await bot.claimChecksStart(pool, { app, session: other, head: HEAD, attempt: 'start' }), true);
  const { rows: events } = await pool.query(
    `SELECT metadata FROM events
      WHERE session_id = $1 AND event_type = 'homeroom_bot_checks_fix_started'
      ORDER BY id`, [session.id]);
  assert.deepEqual(events.map((e) => e.metadata), [
    { head: HEAD, attempt: 'start' },
    { head: HEAD, attempt: 'again' },
    { head: NEW_HEAD, attempt: 'also' },
  ], 'the head, lowercased, and the attempt');

  // No revise run yet: this is a first start.
  assert.equal(await bot.botFixLanded(pool, session.id, NEW_HEAD), false);
  // A run that did not revise says nothing about a fix landing.
  await pool.query(
    `INSERT INTO homeroom_bot_runs (app_id, issue_number, mode, verdict, proposal_session_id, checks_head_sha)
     VALUES ($1, 50, 'build', 'failed', $2, $3)`, [app.id, session.id, HEAD]);
  assert.equal(await bot.botFixLanded(pool, session.id, NEW_HEAD), false);
  // Another change's revise run does not count.
  await pool.query(
    `INSERT INTO homeroom_bot_runs (app_id, issue_number, mode, verdict, proposal_session_id, checks_head_sha)
     VALUES ($1, 51, 'build', 'revise', $2, $3)`, [app.id, other.id, HEAD]);
  assert.equal(await bot.botFixLanded(pool, session.id, NEW_HEAD), false);
  // The bot's own fix landed on an earlier head, and this new head still fails.
  await pool.query(
    `INSERT INTO homeroom_bot_runs (app_id, issue_number, mode, verdict, proposal_session_id, checks_head_sha)
     VALUES ($1, 50, 'build', 'revise', $2, $3)`, [app.id, session.id, HEAD]);
  assert.equal(await bot.botFixLanded(pool, session.id, NEW_HEAD), true);
  // Same head as the revise run: not a new attempt.
  assert.equal(await bot.botFixLanded(pool, session.id, HEAD), false);
  assert.equal(await bot.botFixLanded(pool, session.id, HEAD.toUpperCase()), false);
});
