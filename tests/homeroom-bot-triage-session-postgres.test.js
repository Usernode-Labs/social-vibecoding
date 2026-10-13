'use strict';

// #1006, executed against the FULL PostgreSQL schema: which of the bot's
// sessions its triage pass runs in, and when it may put one to rest.
//
// The bot owns two kinds of session on an app: its one triage session, on
// `main`, and a build session per build, on a `dev/homeroom_bot-*` branch.
// ensureBotSession used to take the bot's newest active or paused session,
// which was any running build's. The triage turn was refused session_busy,
// its `finally` paused the build's session under the build, and the next
// deploy's recovery threw a paused session's worker away: six platform
// builds lost on 10-02. With no build running, triage ran inside the newest
// of those paused build sessions, on that build's stale branch.
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

test('triage runs in its own session on main, never a build\'s, and rests only an idle one', { timeout: 180000 }, async (t) => {
  const admin = new Pool({ connectionString: DSN, connectionTimeoutMillis: 2000 });
  try { await admin.query('SELECT 1'); } catch (err) {
    await admin.end();
    if (process.env.TEST_DATABASE_URL) throw err;
    t.skip('PostgreSQL unavailable; set TEST_DATABASE_URL to require this check');
    return;
  }
  const name = `hbot_triage_session_${crypto.randomBytes(6).toString('hex')}`;
  await admin.query(`CREATE DATABASE ${name}`);
  const url = new URL(DSN); url.pathname = `/${name}`;
  const pool = new Pool({ connectionString: String(url), max: 4 });
  t.after(async () => {
    await pool.end();
    await admin.query(`DROP DATABASE ${name}`);
    await admin.end();
  });
  await pool.query(fs.readFileSync(require.resolve('../src/db/schema.sql'), 'utf8'));

  const botUser = (await pool.query(
    `INSERT INTO users (username, password, is_synthetic) VALUES ('homeroom_bot', 'x', TRUE) RETURNING id, username`,
  )).rows[0];
  const app = (await pool.query(
    `INSERT INTO apps (name, slug, status, repo_url) VALUES ('Homeroom', 'homeroom', 'running', 'https://github.com/usernode-bot/homeroom')
     RETURNING id, slug, name, repo_url, self_hosted`,
  )).rows[0];
  const config = { openrouterDefaultCodexModel: 'z-ai/glm-5.3-flash' };

  async function session(branch, status, { turn = false } = {}) {
    const { rows: [s] } = await pool.query(
      `INSERT INTO chat_sessions (app_id, user_id, branch_name, status, is_headless, linked_issues,
                                  session_title, agent_backend, agent_provider, active_turn)
       VALUES ($1, $2, $3, $4, FALSE, '{}', 'Homeroom bot', 'codex_openrouter', 'openrouter', $5)
       RETURNING id`,
      [app.id, botUser.id, branch, status, turn ? JSON.stringify({ turnId: 't', mode: 'build', startedAt: new Date().toISOString() }) : null],
    );
    return s.id;
  }
  async function buildRun(sessionId) {
    await pool.query(
      `INSERT INTO homeroom_bot_runs (app_id, issue_number, mode, verdict, build_queued_at, build_at, build_session_id)
       VALUES ($1, 3701, 'shadow', 'ready', NOW(), NOW(), $2)`,
      [app.id, sessionId],
    );
  }

  // No triage session yet, only a build running: one is made, on main.
  const building = await session('dev/homeroom_bot-1790974129998', 'active', { turn: true });
  await buildRun(building);
  const made = await bot.ensureBotSession(pool, config, botUser, app);
  assert.notEqual(made.id, building, 'the running build is not the triage session');
  assert.equal(made.branch_name, 'main');
  assert.equal(made.status, 'paused');

  // A newer build starts, and an older one was left paused (10-02's lost
  // builds): triage still finds its own.
  const lost = await session('dev/homeroom_bot-1790975031589', 'paused');
  await buildRun(lost);
  const newer = await session('dev/homeroom_bot-1790976541971', 'active', { turn: true });
  await buildRun(newer);
  assert.equal((await bot.ensureBotSession(pool, config, botUser, app)).id, made.id);

  // A bot session on a dev branch that no run names any more (handBackRun
  // clears the link) is not taken either: its branch says it is a build's.
  const unlinked = await session('dev/homeroom_bot-1790978641725', 'paused');
  assert.equal((await bot.ensureBotSession(pool, config, botUser, app)).id, made.id);
  void unlinked;

  // Resting: an idle active session is paused; one a turn still holds is
  // left as it is, and so is a session that was not active.
  const status = async (id) => (await pool.query('SELECT status FROM chat_sessions WHERE id = $1', [id])).rows[0].status;
  await pool.query("UPDATE chat_sessions SET status = 'active' WHERE id = $1", [made.id]);
  await bot.pauseIdleSession(pool, made.id);
  assert.equal(await status(made.id), 'paused', 'the triage session rests after its turn');
  await bot.pauseIdleSession(pool, newer);
  assert.equal(await status(newer), 'active', 'a build in flight is never paused under its turn');
  const archived = await session('dev/homeroom_bot-1', 'archived');
  await bot.pauseIdleSession(pool, archived);
  assert.equal(await status(archived), 'archived');
});

test('a failed read counts the failures that saw the same thread (#1080)', { timeout: 180000 }, async (t) => {
  const admin = new Pool({ connectionString: DSN, connectionTimeoutMillis: 2000 });
  try { await admin.query('SELECT 1'); } catch (err) {
    await admin.end();
    if (process.env.TEST_DATABASE_URL) throw err;
    t.skip('PostgreSQL unavailable; set TEST_DATABASE_URL to require this check');
    return;
  }
  const name = `hbot_failed_reads_${crypto.randomBytes(6).toString('hex')}`;
  await admin.query(`CREATE DATABASE ${name}`);
  const url = new URL(DSN); url.pathname = `/${name}`;
  const pool = new Pool({ connectionString: String(url), max: 4 });
  t.after(async () => {
    await pool.end();
    await admin.query(`DROP DATABASE ${name}`);
    await admin.end();
  });
  await pool.query(fs.readFileSync(require.resolve('../src/db/schema.sql'), 'utf8'));
  const app = (await pool.query(
    `INSERT INTO apps (name, slug, status, repo_url) VALUES ('Gas', 'gas', 'running', 'https://github.com/usernode-bot/gas') RETURNING id`,
  )).rows[0];
  const run = (issue, verdict, seen, error = null) => pool.query(
    `INSERT INTO homeroom_bot_runs (app_id, issue_number, mode, verdict, thread_seen_at, error) VALUES ($1, $2, 'shadow', $3, $4, $5)`,
    [app.id, issue, verdict, seen, error],
  );
  // #2: failed once on this thread. #3: failed twice on it. #4: failed on
  // an older thread, then read fine, then failed on the new one.
  await run(2, 'failed', '2026-10-04T04:00:00Z', 'unparseable: API Error: 400');
  await run(3, 'failed', '2026-10-04T04:00:00Z', 'unparseable: one');
  await run(3, 'failed', '2026-10-04T04:00:00Z', 'unparseable: two');
  await run(4, 'failed', '2026-10-01T00:00:00Z', 'unparseable: old');
  await run(4, 'ready', '2026-10-02T00:00:00Z');
  await run(4, 'failed', '2026-10-03T00:00:00Z', 'unparseable: new');
  const last = await bot.lastRunsByIssue(pool, app.id);
  assert.equal(last.get(2).failed_tries, 1);
  assert.equal(last.get(3).failed_tries, 2);
  assert.equal(last.get(4).failed_tries, 1, 'only the failures that read this thread');
  assert.equal(last.get(4).verdict, 'failed');
});
