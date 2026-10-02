'use strict';

// #3703, executed against the FULL PostgreSQL schema: the widened status
// filters the proposal-reply path reads — the bot's own proposal lookup
// and the thread-activity wake — with real rows in every state, and the
// closed-issue queue rule through refreshApp's real INSERT. GitHub is
// stubbed.
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

test('a proposal past the vote is still the bot\'s own: wake and queue against real rows', { timeout: 180000 }, async (t) => {
  const admin = new Pool({ connectionString: DSN, connectionTimeoutMillis: 2000 });
  try { await admin.query('SELECT 1'); } catch (err) {
    await admin.end();
    if (process.env.TEST_DATABASE_URL) throw err;
    t.skip('PostgreSQL unavailable; set TEST_DATABASE_URL to require this check');
    return;
  }
  const name = `hbot_reply_${crypto.randomBytes(6).toString('hex')}`;
  await admin.query(`CREATE DATABASE ${name}`);
  const url = new URL(DSN); url.pathname = `/${name}`;
  const pool = new Pool({ connectionString: String(url), max: 4 });
  t.after(async () => {
    bot._resetForTests();
    await pool.end();
    await admin.query(`DROP DATABASE ${name}`);
    await admin.end();
  });
  await pool.query(fs.readFileSync(require.resolve('../src/db/schema.sql'), 'utf8'));

  const botUser = (await pool.query(
    `INSERT INTO users (username, password, is_synthetic) VALUES ('homeroom_bot', 'x', TRUE) RETURNING id, username`,
  )).rows[0];
  const evan = (await pool.query(
    `INSERT INTO users (username, password, is_synthetic) VALUES ('evan', 'x', FALSE) RETURNING id`,
  )).rows[0];
  const app = (await pool.query(
    `INSERT INTO apps (name, slug, status, repo_url) VALUES ('Todo', 'todo', 'running', 'https://github.com/usernode-bot/todo')
     RETURNING id, slug, repo_url, self_hosted`,
  )).rows[0];

  async function proposal(status, issueNumber = 24) {
    const { rows: [s] } = await pool.query(
      `INSERT INTO chat_sessions (app_id, user_id, branch_name, status, is_headless, linked_issues)
       VALUES ($1, $2, $3, $4, FALSE, ARRAY[$5::int]) RETURNING id`,
      [app.id, botUser.id, `dev/homeroom_bot-${status}`, status, issueNumber],
    );
    return s.id;
  }
  const merging = await proposal('merging');
  const merged = await proposal('merged', 25);
  const other = await proposal('promoted');
  await pool.query(`UPDATE chat_sessions SET user_id = $1 WHERE id = $2`, [evan.id, other]);

  async function say(sessionId, userId) {
    await pool.query(
      `INSERT INTO chat_messages (app_id, user_id, content, thread_type, thread_ref, created_at)
       VALUES ($1, $2, 'why zinc-950?', 'session', $3, $4)`,
      [app.id, userId, sessionId, '2026-09-02T00:00:00Z'],
    );
  }
  await say(merging, evan.id);
  await say(merged, evan.id);
  await say(other, evan.id);

  // openBotProposal finds the bot's own proposal in every state, newest
  // first, and never a person's session.
  for (const st of ['promoted', 'merging']) {
    await pool.query('UPDATE chat_sessions SET status = $1 WHERE id = $2', [st, merging]);
    const open = await live.openBotProposal(pool, botUser.id, app.id, 24);
    assert.equal(open.status, st, `the ${st} proposal is found`);
  }
  await pool.query('UPDATE chat_sessions SET status = $1 WHERE id = $2', ['promoted', merging]);
  const mergedOpen = await live.openBotProposal(pool, botUser.id, app.id, 25);
  assert.equal(mergedOpen.status, 'merged', 'the merged proposal on its own issue is found');

  // A message on a merging or merged proposal's thread wakes the issue it
  // answers; a thread on another author's session does not.
  assert.equal(await bot.noteProposalActivity(pool, { appId: app.id, sessionId: merging }), true, 'merging wakes');
  assert.equal(await bot.noteProposalActivity(pool, { appId: app.id, sessionId: merged }), true, 'merged wakes');
  assert.equal(await bot.noteProposalActivity(pool, { appId: app.id, sessionId: other }), false, 'another author\'s session does not');

  // refreshApp through the REAL pool: closed issue #25, whose merged
  // proposal's thread saw a person reply, is queued as proposal_reply with
  // that reply's time, and the row survives the NEXT refresh (the issue is
  // quiet for the row it queued for itself, because the reply is still
  // unanswered). #24 stays closed-quiet here on purpose: its proposal is
  // still promoted, so the issue is busy and nothing queues.
  await pool.query(
    `INSERT INTO homeroom_bot_runs (app_id, issue_number, mode, verdict, thread_seen_at)
     VALUES ($1, 25, 'shadow', 'failed', $2)`,
    [app.id, '2026-09-01T00:00:00Z'],
  );
  const github = { async fetchPublicIssues() { return { issues: [{ number: 25, state: 'closed', updatedAt: '2026-09-01T00:00:00Z' }] }; } };
  const capRoom = { proposals_per_app: 1, question_tripwire: 5 };
  const first = await bot.refreshApp(pool, app, { github, bot: botUser, capRoom });
  assert.equal(first.queued, 1, 'the closed issue is queued for the reply');
  let row = (await pool.query(
    `SELECT priority, reason, thread_seen_at FROM homeroom_bot_queue WHERE app_id = $1 AND issue_number = 25`, [app.id],
  )).rows;
  assert.equal(row.length, 1);
  assert.equal(row[0].reason, bot.PROPOSAL_REPLY_REASON);
  assert.equal(row[0].priority, 2);
  assert.ok(row[0].thread_seen_at);

  // The next refresh, same unanswered reply: the row stays, and the queue
  // row's thread_seen_at catches up to the activity.
  const second = await bot.refreshApp(pool, app, { github, bot: botUser, capRoom });
  assert.equal(second.removed, 0, 'the proposal_reply row survives the next refresh');
  row = (await pool.query(
    `SELECT reason, thread_seen_at FROM homeroom_bot_queue WHERE app_id = $1 AND issue_number = 25`, [app.id],
  )).rows;
  assert.equal(row.length, 1, 'still queued, still the same row');
  assert.equal(row[0].reason, bot.PROPOSAL_REPLY_REASON);

  // The follow-up answers: the run row's thread_seen_at catches up to the
  // reply, and the same activity queues nothing the next time.
  await pool.query(
    `INSERT INTO homeroom_bot_runs (app_id, issue_number, mode, verdict, proposal_session_id, thread_seen_at)
     VALUES ($1, 25, 'shadow', 'answer', $2, $3)`,
    [app.id, merged, '2026-09-02T00:00:00Z'],
  );
  const third = await bot.refreshApp(pool, app, { github, bot: botUser, capRoom });
  assert.equal(third.removed, 1, 'answered, so the refresh drops the row');
  row = (await pool.query(
    `SELECT reason FROM homeroom_bot_queue WHERE app_id = $1 AND issue_number = 25`, [app.id],
  )).rows;
  assert.deepEqual(row, [], 'the same reply does not loop');
});
