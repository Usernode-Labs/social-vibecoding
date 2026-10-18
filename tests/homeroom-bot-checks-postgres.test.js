// noteProposalChecks against the real schema: the failing verdict, its head
// and the one-look-per-head rule, read with the query the bot actually runs.
//
// Like the repository's other postgres tests it skips when no database is
// reachable, unless TEST_DATABASE_URL insists on one.

const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const { Pool } = require('pg');

const bot = require('../src/services/homeroom-bot');

const DSN = process.env.TEST_DATABASE_URL || process.env.DATABASE_URL
  || 'postgres://postgres:postgres@127.0.0.1:5432/postgres';
const HEAD = 'c'.repeat(40);

test('a failing verdict on the bot\'s own live proposal queues one checks fix, once per head', { timeout: 180000 }, async (t) => {
  const admin = new Pool({ connectionString: DSN, connectionTimeoutMillis: 2000 });
  try { await admin.query('SELECT 1'); } catch (err) {
    await admin.end();
    if (process.env.TEST_DATABASE_URL) throw err;
    t.skip('PostgreSQL unavailable; set TEST_DATABASE_URL to require this check');
    return;
  }
  const name = `hbot_checks_${crypto.randomBytes(6).toString('hex')}`;
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
    `INSERT INTO users (username, password, is_synthetic) VALUES ('homeroom_bot', 'x', TRUE) RETURNING id`,
  );
  const { rows: [app] } = await pool.query(
    `INSERT INTO apps (name, slug, status, repo_url)
     VALUES ('Recipe bot', 'recipebot-82', 'running', 'https://github.com/usernode-bot/recipebot-82') RETURNING id`,
  );
  const { rows: [session] } = await pool.query(
    `INSERT INTO chat_sessions (app_id, user_id, branch_name, status, is_headless, linked_issues,
                                check_state, checks_commit_sha, reviewed_head_sha, test_results)
     VALUES ($1, $2, 'dev/homeroom_bot-5001', 'promoted', FALSE, ARRAY[82], 'failing', $3, $3, $4)
     RETURNING id`,
    [app.id, botUser.id, HEAD, JSON.stringify([
      { name: 'Text size', path: '/recipes', status: 'fail', failureReason: 'expected "Text size", saw "Aa"' },
      { name: 'Loads', path: '/', status: 'pass' },
    ])],
  );
  await pool.query(
    `INSERT INTO platform_settings (key, value) VALUES ('homeroom_bot_mode', 'shadow'), ('homeroom_bot_live_apps', '["recipebot-82"]')
     ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value`,
  );

  assert.equal(await bot.noteProposalChecks(pool, { id: session.id }), true);
  assert.equal(await bot.noteProposalChecks(pool, { id: session.id }), true, 'the upsert is idempotent');
  const { rows: queued } = await pool.query(
    'SELECT app_id, issue_number, priority, reason, started_at FROM homeroom_bot_queue WHERE app_id = $1', [app.id],
  );
  assert.equal(queued.length, 1, 'two failing verdicts on one head queue one row');
  assert.deepEqual(
    [queued[0].app_id, queued[0].issue_number, queued[0].priority, queued[0].reason, queued[0].started_at],
    [app.id, 82, 1, 'checks_failing', null],
  );

  // A run that looked at this head means it is no longer due.
  await pool.query(
    `INSERT INTO homeroom_bot_runs (app_id, issue_number, mode, verdict, proposal_session_id, checks_head_sha)
     VALUES ($1, 82, 'live', 'revise', $2, $3)`,
    [app.id, session.id, HEAD],
  );
  assert.equal(await bot.noteProposalChecks(pool, { id: session.id }), false, 'each failing head gets one look');

  // And a verdict on an older head is not a verdict on this one.
  await pool.query('DELETE FROM homeroom_bot_runs WHERE proposal_session_id = $1', [session.id]);
  await pool.query("UPDATE chat_sessions SET checks_commit_sha = $2 WHERE id = $1", [session.id, 'e'.repeat(40)]);
  assert.equal(await bot.noteProposalChecks(pool, { id: session.id }), false, 'stale against the reviewed head');
  await pool.query("UPDATE chat_sessions SET reviewed_head_sha = $2, check_state = 'error' WHERE id = $1", [session.id, 'e'.repeat(40)]);
  assert.equal(await bot.noteProposalChecks(pool, { id: session.id }), false, 'an error is never acted on');
});
