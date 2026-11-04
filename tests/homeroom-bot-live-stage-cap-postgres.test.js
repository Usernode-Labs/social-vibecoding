'use strict';

// #6280 (4 Nov 2026, request #6251): the bot page's lists said a request
// being built was "Not moving · Nobody on it", while the request's own page
// said Building. requestRows read only the person's 25 most recently run
// requests (MAX_REQUESTS), and a request under way drops out of that window
// on a busy day once 25 newer runs exist. The bot page's rows and a
// request's track now also read every request whose records look live, and
// both read its newest LIVE run (a shadow trial's newer run is not the
// request's stage), through one shared fragment.
//
// Against the full PostgreSQL schema; skips when no database is reachable,
// unless TEST_DATABASE_URL insists on one.

const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const { Pool } = require('pg');

const progress = require('../src/services/homeroom-bot-progress');
const track = require('../src/services/homeroom-bot-track');

const DSN = process.env.TEST_DATABASE_URL || process.env.DATABASE_URL
  || 'postgres://postgres:postgres@127.0.0.1:5432/postgres';

test('#6280: a request being built is read past the 25-request cap, with the stage its page shows', { timeout: 120000 }, async (t) => {
  const admin = new Pool({ connectionString: DSN, connectionTimeoutMillis: 2000 });
  try { await admin.query('SELECT 1'); } catch (err) {
    await admin.end();
    if (process.env.TEST_DATABASE_URL) throw err;
    t.skip('PostgreSQL unavailable; set TEST_DATABASE_URL to require this check');
    return;
  }
  const name = `hbot_live_cap_${crypto.randomBytes(6).toString('hex')}`;
  await admin.query(`CREATE DATABASE ${name}`);
  const url = new URL(DSN); url.pathname = `/${name}`;
  const pool = new Pool({ connectionString: String(url), max: 4 });
  t.after(async () => {
    await pool.end();
    await admin.query(`DROP DATABASE ${name}`);
    await admin.end();
  });
  await pool.query(fs.readFileSync(require.resolve('../src/db/schema.sql'), 'utf8'));

  const { rows: [botUser] } = await pool.query(
    "INSERT INTO users (username, password, is_synthetic) VALUES ('homeroom_bot', 'x', TRUE) RETURNING id",
  );
  const { rows: [evan] } = await pool.query("INSERT INTO users (username, password) VALUES ('evan', 'x') RETURNING id");
  const { rows: [app] } = await pool.query(
    `INSERT INTO apps (name, slug, status, repo_url, created_by)
     VALUES ('homeroom', 'homeroom', 'running', 'https://github.com/usernode-bot/homeroom', $1) RETURNING id`,
    [evan.id],
  );
  const { rows: [session] } = await pool.query(
    `INSERT INTO chat_sessions (app_id, user_id, branch_name, status, session_title)
     VALUES ($1, $2, 'dev/build-6251', 'active', 'Build it') RETURNING id`,
    [app.id, botUser.id],
  );
  // #6251: being built, two days ago, so every newer run outranks it.
  const { rows: [building] } = await pool.query(
    `INSERT INTO homeroom_bot_runs (app_id, issue_number, mode, verdict, created_at, build_session_id)
     VALUES ($1, 6251, 'live', 'ready', NOW() - INTERVAL '2 days', $2) RETURNING id`,
    [app.id, session.id],
  );
  await pool.query(
    `INSERT INTO homeroom_bot_posts (app_id, issue_number, run_id, kind, created_at)
     VALUES ($1, 6251, $2, 'spec', NOW() - INTERVAL '2 days')`,
    [app.id, building.id],
  );
  // A shadow trial of a newer look: not this request's stage.
  await pool.query(
    `INSERT INTO homeroom_bot_runs (app_id, issue_number, mode, verdict, created_at)
     VALUES ($1, 6251, 'shadow', 'ready', NOW() - INTERVAL '1 minute')`,
    [app.id],
  );
  await pool.query(
    `INSERT INTO homeroom_bot_requesters (app_id, issue_number, user_id, issue_title)
     VALUES ($1, 6251, $2, 'A building request')`,
    [app.id, evan.id],
  );
  // 26 finished requests, all newer than #6251.
  await pool.query(
    `INSERT INTO homeroom_bot_requesters (app_id, issue_number, user_id, issue_title)
     SELECT $1, n, $2, 'Finished ' || n FROM generate_series(1, 26) n`,
    [app.id, evan.id],
  );
  await pool.query(
    `INSERT INTO homeroom_bot_runs (app_id, issue_number, mode, verdict, created_at)
     SELECT $1, n, 'live', 'empty', NOW() - make_interval(mins => n) FROM generate_series(1, 26) n`,
    [app.id],
  );

  await t.test('the bot page reads #6251\'s stage however old it is, and the cap still holds finished work', async () => {
    const states = await progress.requestStates(pool, { userId: evan.id });
    const byNumber = new Map(states.map((s) => [Number(s.row.issue_number), s.state]));
    assert.equal(byNumber.get(6251)?.stage, 'building', 'a request under way is never "Nobody on it"');
    // The 25 newest finished requests (1 to 25) and #6251: the oldest
    // finished one (request 26) is past the cap and left out.
    assert.equal(states.length, 26);
    assert.equal(byNumber.has(26), false, 'a finished request past the newest 25 is not read');
    for (let n = 1; n <= 25; n += 1) assert.ok(byNumber.has(n), `request ${n} is inside the cap`);
  });

  await t.test('the request page\'s track reads the same records and says the same stage', async () => {
    const { rows: [row] } = await pool.query(track.REQUEST_ROWS_SQL, [app.id, [6251]]);
    assert.ok(row, 'the track has a row for the request');
    const state = progress.stageOf(row, { now: new Date() });
    assert.equal(state.stage, 'building');
    assert.equal(track.jobOfRow(row, { stageOf: progress.stageOf, outcomeOf: () => null }).stage, 'building');
  });
});
