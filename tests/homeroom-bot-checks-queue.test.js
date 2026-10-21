'use strict';

// #3603: the failing-checks verdict becomes a queue row, and the queue
// refresh keeps it. Both run against the full PostgreSQL schema: the due
// read (a proposal still promoted on a running, live app, a failing verdict
// on the head under review, a head no run has looked at), the insert, and
// refreshApp's DELETE, which must not drop a checks row the very wake it
// asks for would otherwise delete.
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

const HEAD = 'a'.repeat(40);
const OLD_HEAD = 'b'.repeat(40);
const SEEN = '2026-10-20T10:00:00Z';
const FAILING = [{
  name: 'the text size control', path: '/?shot=text-size', status: 'fail', advisory: false,
  failureReason: 'Expected text "Text size" was not found',
}];

test('the checks-fix queue row against the full PostgreSQL schema', { timeout: 120000 }, async (t) => {
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
  const pool = new Pool({ connectionString: String(url), max: 8 });
  t.after(async () => {
    bot._resetForTests();
    await pool.end();
    await admin.query(`DROP DATABASE ${name}`);
    await admin.end();
  });
  const schema = fs.readFileSync(require.resolve('../src/db/schema.sql'), 'utf8');
  await pool.query(schema);

  const setting = (key, value) => pool.query(
    `INSERT INTO platform_settings (key, value) VALUES ($1, $2)
     ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value`, [key, value],
  );
  await setting('homeroom_bot_mode', 'shadow');
  await setting('homeroom_bot_live_apps', JSON.stringify(['recipebot']));

  const { rows: [who] } = await pool.query(
    "INSERT INTO users (username, password) VALUES ('homeroom_bot', 'x') RETURNING id",
  );
  const { rows: [other] } = await pool.query(
    "INSERT INTO users (username, password) VALUES ('evan', 'x') RETURNING id",
  );
  const { rows: [app] } = await pool.query(
    `INSERT INTO apps (name, slug, status, repo_url)
     VALUES ('Recipebot', 'recipebot', 'running', 'https://github.com/usernode-bot/recipebot') RETURNING id, slug, name, repo_url, status`,
  );

  const proposal = async ({
    userId = who.id, status = 'promoted', linked = [82], appStatus = 'running',
    checksHead = HEAD, reviewedHead = HEAD, checkState = 'failing', results = FAILING,
  } = {}) => {
    if (appStatus !== 'running') await pool.query("UPDATE apps SET status = $2 WHERE id = $1", [app.id, appStatus]);
    const { rows: [s] } = await pool.query(
      `INSERT INTO chat_sessions (app_id, user_id, branch_name, status, is_headless, linked_issues,
                                  check_state, checks_commit_sha, reviewed_head_sha, test_results)
       VALUES ($1, $2, $3, $4, FALSE, $5::int[], $6, $7, $8, $9::jsonb) RETURNING id`,
      [app.id, userId, `dev/homeroom_bot-${crypto.randomBytes(4).toString('hex')}`, status, linked,
        checkState, checksHead, reviewedHead, JSON.stringify(results)],
    );
    return s.id;
  };
  const queueRow = async (issue) => (await pool.query(
    'SELECT priority, reason FROM homeroom_bot_queue WHERE app_id = $1 AND issue_number = $2', [app.id, issue],
  )).rows[0] || null;

  await t.test('it reads the proposal once and queues checks_failing at priority 1', async () => {
    const id = await proposal();
    assert.equal(await bot.noteProposalChecks(pool, { id }, 'failing'), true);
    assert.deepEqual(await queueRow(82), { priority: 1, reason: 'checks_failing' });
    await pool.query('DELETE FROM homeroom_bot_queue WHERE app_id = $1', [app.id]);
    await pool.query('DELETE FROM chat_sessions WHERE id = $1', [id]);
  });

  await t.test('a head a run has already looked at is not queued again', async () => {
    const id = await proposal();
    await pool.query(
      `INSERT INTO homeroom_bot_runs (app_id, issue_number, mode, verdict, proposal_session_id, checks_head_sha)
       VALUES ($1, 82, 'shadow', 'person', $2, $3)`,
      [app.id, id, HEAD],
    );
    assert.equal(await bot.noteProposalChecks(pool, { id }, 'failing'), false);
    assert.equal(await queueRow(82), null);
    await pool.query('DELETE FROM homeroom_bot_runs WHERE proposal_session_id = $1', [id]);
    await pool.query('DELETE FROM chat_sessions WHERE id = $1', [id]);
  });

  await t.test('a verdict on an older head is not acted on', async () => {
    const id = await proposal({ checksHead: HEAD, reviewedHead: OLD_HEAD });
    assert.equal(await bot.noteProposalChecks(pool, { id }, 'failing'), false);
    assert.equal(await queueRow(82), null);
    await pool.query('DELETE FROM chat_sessions WHERE id = $1', [id]);
  });

  await t.test('not the bot\'s session, not promoted, not running, not live, not failing: none is looked at', async () => {
    const someoneElses = await proposal({ userId: other.id });
    assert.equal(await bot.noteProposalChecks(pool, { id: someoneElses }, 'failing'), false);
    await pool.query('DELETE FROM chat_sessions WHERE id = $1', [someoneElses]);

    const merging = await proposal({ status: 'merging' });
    assert.equal(await bot.noteProposalChecks(pool, { id: merging }, 'failing'), false);
    await pool.query('DELETE FROM chat_sessions WHERE id = $1', [merging]);

    const stopped = await proposal({ appStatus: 'paused' });
    assert.equal(await bot.noteProposalChecks(pool, { id: stopped }, 'failing'), false);
    await pool.query('DELETE FROM chat_sessions WHERE id = $1', [stopped]);
    await pool.query("UPDATE apps SET status = 'running' WHERE id = $1", [app.id]);

    const errorState = await proposal({ checkState: 'error' });
    assert.equal(await bot.noteProposalChecks(pool, { id: errorState }, 'failing'), false,
      'the checks could not run: never acted on');
    await pool.query('DELETE FROM chat_sessions WHERE id = $1', [errorState]);

    const unlinked = await proposal({ linked: [] });
    assert.equal(await bot.noteProposalChecks(pool, { id: unlinked }, 'failing'), false);
    await pool.query('DELETE FROM chat_sessions WHERE id = $1', [unlinked]);

    const id = await proposal();
    assert.equal(await bot.noteProposalChecks(pool, { id }, 'passing'), false);
    await setting('homeroom_bot_live_apps', '[]');
    assert.equal(await bot.noteProposalChecks(pool, { id }, 'failing'), false, 'a shadow app never acts');
    await setting('homeroom_bot_live_apps', JSON.stringify(['recipebot']));
    assert.equal(await queueRow(82), null);
    await pool.query('DELETE FROM chat_sessions WHERE id = $1', [id]);
  });

  await t.test('the refresh keeps a checks_failing row and still removes a stale unchanged one', async () => {
    await pool.query(
      `INSERT INTO homeroom_bot_queue (app_id, issue_number, priority, reason)
       VALUES ($1, 82, 1, 'checks_failing'), ($1, 90, 2, 'changed')`,
      [app.id],
    );
    // #82 is unchanged since its last run, so nothing would keep it; #90 is
    // not in the fetched list at all.
    await pool.query(
      `INSERT INTO homeroom_bot_runs (app_id, issue_number, mode, verdict, thread_seen_at, created_at)
       VALUES ($1, 82, 'shadow', 'ready', $2, $2)`, [app.id, SEEN],
    );
    const github = {
      async fetchPublicIssues() {
        return { issues: [{ number: 82, state: 'open', createdAt: SEEN, updatedAt: SEEN }] };
      },
    };
    const out = await bot.refreshApp(pool, app, { github, bot: { id: who.id } });
    assert.equal(out.removed, 1, 'the stale unchanged one leaves');
    assert.deepEqual(await queueRow(82), { priority: 1, reason: 'checks_failing' },
      'a checks row lives until a pass claims it');
    assert.equal(await queueRow(90), null);
  });
});
