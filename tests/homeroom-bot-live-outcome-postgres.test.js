'use strict';

// Run 613: a live build the platform's restart lost always records an
// outcome, and the backstop says so when nothing else did.
//
// Session 5658 (recipebot #48) was active when a redeploy happened. Restart
// recovery took its requeue branch, archived the session and sent the issue
// back to be triaged again, but recorded nothing on the run, and the wake's
// refresh could remove the restart's queue row before it ran. Both paths are
// exercised here against the FULL PostgreSQL schema, as a boot applies it.
//
// Like the repository's other postgres tests it skips when no database is
// reachable, unless TEST_DATABASE_URL insists on one.

const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const { Pool } = require('pg');

const bot = require('../src/services/homeroom-bot');
const live = require('../src/services/homeroom-bot-live');

const DSN = process.env.TEST_DATABASE_URL || process.env.DATABASE_URL
  || 'postgres://postgres:postgres@127.0.0.1:5432/postgres';

test('a lost live build records an outcome and is announced once', { timeout: 180000 }, async (t) => {
  const admin = new Pool({ connectionString: DSN, connectionTimeoutMillis: 2000 });
  try { await admin.query('SELECT 1'); } catch (err) {
    await admin.end();
    if (process.env.TEST_DATABASE_URL) throw err;
    t.skip('PostgreSQL unavailable; set TEST_DATABASE_URL to require this check');
    return;
  }
  const name = `hbot_lost_${crypto.randomBytes(6).toString('hex')}`;
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
  await pool.query(schema); // boot-idempotent, checks_head_sha included

  const setting = (key, value) => pool.query(
    `INSERT INTO platform_settings (key, value) VALUES ($1, $2)
     ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value`, [key, value],
  );
  await setting(bot.KEY_MODE, 'live');

  const app = (await pool.query(
    `INSERT INTO apps (name, slug, status, repo_url)
     VALUES ('Recipes', 'recipebot', 'running', 'https://github.com/usernode-bot/recipebot') RETURNING id, slug`,
  )).rows[0];
  await setting(bot.KEY_LIVE_APPS, JSON.stringify([app.slug]));
  const user = (await pool.query(
    `INSERT INTO users (username, password, is_synthetic) VALUES ('homeroom_bot', 'x', TRUE) RETURNING id`,
  )).rows[0];
  const session = async (status = 'active') => (await pool.query(
    `INSERT INTO chat_sessions (app_id, user_id, branch_name, status, is_headless, linked_issues)
     VALUES ($1, $2, 'dev/homeroom_bot-1', $3, FALSE, ARRAY[48]) RETURNING id, app_id, status`,
    [app.id, user.id, status],
  )).rows[0];
  const run = async (sessionId, { mode = 'live', proposalSessionId = null, createdAgo = 60 } = {}) => (await pool.query(
    `INSERT INTO homeroom_bot_runs (app_id, issue_number, mode, verdict, build_session_id,
                                    proposal_session_id, created_at)
     VALUES ($1, 48, $2, 'ready', $3, $4, NOW() - make_interval(secs => $5)) RETURNING id`,
    [app.id, mode, sessionId, proposalSessionId, createdAgo],
  )).rows[0].id;
  const runRow = async (id) => (await pool.query(
    'SELECT build_ok, build_error, proposal_session_id FROM homeroom_bot_runs WHERE id = $1', [id],
  )).rows[0];

  // ── Run 613's restart path ─────────────────────────────────────────────
  const s1 = await session('active');
  const r1 = await run(s1.id, { createdAgo: 30 });
  assert.equal(await bot.abandonRecoveredTurn({ pool, session: s1, why: 'the worker was lost' }), 'live_pending');
  await bot.completeRecoveredLive({ pool, config: {}, sessionId: s1.id, deps: {} });
  const afterRestart = await runRow(r1);
  assert.equal(afterRestart.build_ok, false, 'recovery records the interruption');
  assert.match(afterRestart.build_error, /interrupted: the build was interrupted by a restart; the issue was sent back to be triaged again/);
  assert.equal((await pool.query('SELECT status FROM chat_sessions WHERE id = $1', [s1.id])).rows[0].status, 'archived');
  const queued = (await pool.query(
    'SELECT reason FROM homeroom_bot_queue WHERE app_id = $1 AND issue_number = 48', [app.id],
  )).rows[0];
  assert.equal(queued.reason, 'restart', 'the issue goes back to be looked at again');

  // A refresh after the wake must keep that row while the issue is open.
  const github = {
    async fetchPublicIssues() {
      return { issues: [{ number: 48, title: 'Remember my last step', state: 'open', updated_at: new Date().toISOString() }] };
    },
  };
  await bot.refreshApp(pool, { id: app.id, slug: app.slug, repo_url: 'https://github.com/usernode-bot/recipebot' }, { github });
  const kept = (await pool.query(
    'SELECT reason FROM homeroom_bot_queue WHERE app_id = $1 AND issue_number = 48', [app.id],
  )).rows[0];
  assert.equal(kept?.reason, 'restart', 'the refresh does not remove the bot\'s own row');

  // ── The backstop ──────────────────────────────────────────────────────
  // A live build nothing ever finished: old enough, no proposal, no outcome.
  const s2 = await session('active');
  const r2 = await run(s2.id, { createdAgo: 2 * 60 * 60 });
  const comments = [];
  const deps = {
    github: {
      async fetchPublicIssue(_o, _r, n) { return { issue: { number: n, title: 'Remember my last step', state: 'open' } }; },
      async fetchIssueComments() { return { comments: [] }; },
      async createIssueComment(_o, _r, n, body) { comments.push({ n, body }); return { id: 1, created_at: new Date().toISOString() }; },
      async getBotUsername() { return 'usernode-bot'; },
    },
    ws: { async sendBotMessage() { return { id: 2 }; } },
    notifications: { async createMentionNotifications() { return []; }, async hydrateAndPush() {} },
  };
  const out = await bot.settleAbandonedLiveBuilds(pool, {}, deps);
  assert.equal(out.settled, 1);
  assert.equal(out.said, 1);
  const swept = await runRow(r2);
  assert.equal(swept.build_ok, false);
  assert.match(swept.build_error, /interrupted: the build never finished/);
  assert.equal((await pool.query('SELECT status FROM chat_sessions WHERE id = $1', [s2.id])).rows[0].status, 'archived');
  assert.equal(comments.length, 1, 'the note goes on the issue once');
  assert.match(comments[0].body, /tried to build this but couldn't finish/);
  assert.match(comments[0].body, /the platform restarted while it was building, and the build was lost/);
  assert.equal((await pool.query(
    "SELECT COUNT(*)::int AS n FROM homeroom_bot_posts WHERE kind = 'build_failed' AND run_id = $1", [r2.id],
  )).rows[0].n, 1);

  // A second pass finds nothing: the outcome is recorded.
  const again = await bot.settleAbandonedLiveBuilds(pool, {}, deps);
  assert.equal(again.settled, 0);
  assert.equal(comments.length, 1, 'and nothing is said twice');
});
