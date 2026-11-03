'use strict';

// #6234: what the change's Testing card reads about Homeroom bot's own fix
// of the check that failed, from the records that drive the bot page's
// "Fixing" stage. The reads are not derived: a started queue row, one still
// waiting, or a hand-off run at this head, each against the real schema.

const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const { Pool } = require('pg');

const progress = require('../src/services/homeroom-bot-progress');

const DSN = process.env.TEST_DATABASE_URL || process.env.DATABASE_URL
  || 'postgres://postgres:postgres@127.0.0.1:5432/postgres';
const HEAD = 'a'.repeat(40);
// The marker `checksRetried` looks for, written as homeroom-bot.js writes it
// (checksRetryError): `checks: ran out of time on <head>, trying once more`.
const retryError = (head) => `checks: ran out of time on ${String(head || '').toLowerCase()}, trying once more`;

test('changeBotFix reads fixing, queued and handed off from the real records', { timeout: 120000 }, async (t) => {
  const admin = new Pool({ connectionString: DSN, connectionTimeoutMillis: 2000 });
  try { await admin.query('SELECT 1'); } catch (err) {
    await admin.end();
    if (process.env.TEST_DATABASE_URL) throw err;
    t.skip('PostgreSQL unavailable; set TEST_DATABASE_URL to require this check');
    return;
  }
  const name = `hrbot_fix_${crypto.randomBytes(6).toString('hex')}`;
  await admin.query(`CREATE DATABASE ${name}`);
  const url = new URL(DSN); url.pathname = `/${name}`;
  const pool = new Pool({ connectionString: String(url), max: 4 });
  t.after(async () => {
    await pool.end();
    await admin.query(`DROP DATABASE ${name}`);
    await admin.end();
  });
  await pool.query(fs.readFileSync(require.resolve('../src/db/schema.sql'), 'utf8'));

  const user = async (username, synthetic) => (await pool.query(
    `INSERT INTO users (username, password, has_platform_access, is_synthetic)
     VALUES ($1, 'x', TRUE, $2) RETURNING id`, [username, synthetic],
  )).rows[0];
  const bot = await user('homeroom_bot', true);
  const person = await user('ada', false);
  const app = (await pool.query(
    `INSERT INTO apps (name, slug, status, created_by, repo_url, view_visibility, collab_visibility)
     VALUES ('Fix Board', $1, 'running', $2, $3, 'public', 'public') RETURNING id`,
    [`fix-board-${crypto.randomBytes(3).toString('hex')}`, person.id, 'https://github.com/usernode-bot/fix-board'],
  )).rows[0];

  let seq = 0;
  const session = async ({ author = bot.id, status = 'promoted', checkState = 'failing', issues = [50] }) => (await pool.query(
    `INSERT INTO chat_sessions (app_id, user_id, branch_name, status, session_title, promoted_at, check_state, linked_issues, reviewed_head_sha)
     VALUES ($1, $2, $3, $4, 'A change', NOW(), $5, $6, $7) RETURNING id`,
    [app.id, author, `dev/bot-${++seq}`, status, checkState, issues, HEAD],
  )).rows[0].id;
  const queue = (issueNumber, startedAt, enqueuedAt) => pool.query(
    `INSERT INTO homeroom_bot_queue (app_id, issue_number, reason, started_at, enqueued_at)
     VALUES ($1, $2, 'checks_failing', $3, $4)`,
    [app.id, issueNumber, startedAt, enqueuedAt],
  );
  const run = (sessionId, verdict, head, error = null) => pool.query(
    `INSERT INTO homeroom_bot_runs (app_id, issue_number, mode, verdict, proposal_session_id, checks_head_sha, error)
     VALUES ($1, 50, 'live', $2, $3, $4, $5)`,
    [app.id, verdict, sessionId, head, error],
  );

  await t.test('a started queue row is the fix running, with its start time', async () => {
    const id = await session({});
    const started = new Date(Date.now() - 10 * 60000);
    await queue(50, started, new Date(Date.now() - 12 * 60000));
    const read = await progress.changeBotFix(pool, id);
    assert.equal(read.state, 'fixing');
    assert.equal(new Date(read.since).getTime(), started.getTime());
    assert.equal(read.reason, null);
    await pool.query('DELETE FROM homeroom_bot_queue WHERE app_id = $1', [app.id]);
    await pool.query('DELETE FROM chat_sessions WHERE id = $1', [id]);
  });

  await t.test('a second try after running out of time says so', async () => {
    const id = await session({});
    await queue(50, new Date(), new Date());
    await run(id, 'failed', null, retryError(HEAD));
    assert.equal((await progress.changeBotFix(pool, id)).reason, 'retry');
    await pool.query('DELETE FROM homeroom_bot_queue WHERE app_id = $1', [app.id]);
    await pool.query('DELETE FROM homeroom_bot_runs WHERE proposal_session_id = $1', [id]);
    await pool.query('DELETE FROM chat_sessions WHERE id = $1', [id]);
  });

  await t.test('a queue row not started is the fix waiting for a builder', async () => {
    const id = await session({});
    const enqueued = new Date(Date.now() - 60000);
    await queue(50, null, enqueued);
    const read = await progress.changeBotFix(pool, id);
    assert.equal(read.state, 'queued');
    assert.equal(new Date(read.since).getTime(), enqueued.getTime());
    await pool.query('DELETE FROM homeroom_bot_queue WHERE app_id = $1', [app.id]);
    await pool.query('DELETE FROM chat_sessions WHERE id = $1', [id]);
  });

  await t.test('no queue row and a hand-off at this head is handed off', async () => {
    const id = await session({});
    await run(id, 'person', HEAD);
    assert.deepEqual(await progress.changeBotFix(pool, id), { state: 'handed_off' });
    await pool.query('DELETE FROM homeroom_bot_runs WHERE proposal_session_id = $1', [id]);
    await pool.query('DELETE FROM chat_sessions WHERE id = $1', [id]);
  });

  await t.test('a change a person built, or one whose checks are not failing, says nothing', async () => {
    const theirs = await session({ author: person.id });
    assert.equal(await progress.changeBotFix(pool, theirs), null);
    const passing = await session({ checkState: 'passing' });
    assert.equal(await progress.changeBotFix(pool, passing), null);
    const active = await session({ status: 'active' });
    assert.equal(await progress.changeBotFix(pool, active), null);
    await pool.query('DELETE FROM chat_sessions WHERE id = ANY($1::int[])', [[theirs, passing, active]]);
  });

  await t.test('a read that fails says nothing', async () => {
    assert.equal(await progress.changeBotFix({ query: async () => { throw new Error('down'); } }, 1), null);
  });
});
