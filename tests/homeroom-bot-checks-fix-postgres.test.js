'use strict';

// #3646, executed against the FULL PostgreSQL schema: the checks-fix pickup
// (noteProposalChecks) reads the proposal and the failing set, gates on the
// runs' stamped heads, and queues the issue; the fix turn records its run
// with the head it looked at and posts once in the proposal's thread. The
// turn and GitHub are stubbed; the queries the change adds run for real.
//
// Like the repository's other postgres tests it skips when no database is
// reachable, unless TEST_DATABASE_URL insists on one.
//
// Run with: node --test tests/homeroom-bot-checks-fix-postgres.test.js

const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const { Pool } = require('pg');

const bot = require('../src/services/homeroom-bot');
const live = require('../src/services/homeroom-bot-live');
const followup = require('../src/services/homeroom-bot-followup');

const DSN = process.env.TEST_DATABASE_URL || process.env.DATABASE_URL
  || 'postgres://postgres:postgres@127.0.0.1:5432/postgres';

const HEAD = 'a'.repeat(40);

test('a failing verdict on the current head queues one fix look, and the run stamps the head it looked at', { timeout: 180000 }, async (t) => {
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

  const botUser = (await pool.query(
    `INSERT INTO users (username, password, is_synthetic) VALUES ('homeroom_bot', 'x', TRUE) RETURNING id`,
  )).rows[0];
  const app = (await pool.query(
    `INSERT INTO apps (name, slug, status, repo_url) VALUES ('Recipebot', 'recipebot', 'running', 'https://github.com/usernode-bot/recipebot')
     RETURNING id, slug, name, repo_url`,
  )).rows[0];
  // noteProposalChecks reads settings through the real readSettings.
  await pool.query(
    `INSERT INTO platform_settings (key, value) VALUES ('homeroom_bot_mode', 'live'), ('homeroom_bot_live_apps', '["recipebot"]')
     ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value`,
  );
  const session = (await pool.query(
    `INSERT INTO chat_sessions (app_id, user_id, branch_name, status, is_headless, linked_issues,
                                check_state, checks_commit_sha, reviewed_head_sha, test_results)
     VALUES ($1, $2, $3, 'promoted', FALSE, ARRAY[48::int], 'failing', $4, $4, $5)
     RETURNING id`,
    [app.id, botUser.id, 'dev/homeroom_bot-48', HEAD, JSON.stringify([
      { name: 'snooze label', status: 'fail', failureReason: 'expected "Text size" but found "Aa"' },
      { name: 'snooze renders', status: 'pass' },
      { name: 'timer rings', status: 'pass' },
    ])],
  )).rows[0];

  // ── The pickup ─────────────────────────────────────────────────────────
  assert.equal(await bot.noteProposalChecks(pool, { id: session.id }, 'failing'), true);
  const { rows: [queued] } = await pool.query(
    `SELECT app_id, issue_number, priority, reason, started_at FROM homeroom_bot_queue WHERE app_id = $1`,
    [app.id],
  );
  assert.equal(queued.issue_number, 48);
  assert.equal(queued.priority, 1);
  assert.equal(queued.reason, 'checks_failing');

  // A second pickup finds the head still unstamped, so it re-arms the same
  // row through the ON CONFLICT path rather than queueing a second look.
  assert.equal(await bot.noteProposalChecks(pool, { id: session.id }, 'failing'), true);
  const { rows: [rearmed] } = await pool.query(
    `SELECT started_at, enqueued_at FROM homeroom_bot_queue WHERE app_id = $1`,
    [app.id],
  );
  assert.equal(rearmed.started_at, null);

  // Once a run has looked at this head, the same verdict grants no second look.
  await pool.query(
    `INSERT INTO homeroom_bot_runs (app_id, issue_number, mode, verdict, proposal_session_id, checks_head_sha)
     VALUES ($1, 48, 'live', 'revise', $2, $3)`,
    [app.id, session.id, HEAD],
  );
  assert.equal(await bot.noteProposalChecks(pool, { id: session.id }, 'failing'), false);
  const { rows: [unchanged] } = await pool.query(
    `SELECT started_at FROM homeroom_bot_queue WHERE app_id = $1`,
    [app.id],
  );
  assert.equal(unchanged.started_at, null, 'the queue row was left as the last pickup left it');

  // ── The fix turn, against the real tables ──────────────────────────────
  const posted = [];
  const realTurn = followup.runFollowUpTurn;
  followup.runFollowUpTurn = async ({ session: fixSession }) => {
    posted.push(['turn', fixSession.id]);
    return {
      routed: { estimatedCostUsd: 0 },
      result: {
        lastResultText: '```json\n{"action":"revise","reply":"The check now matches the button.","summary":"The check now matches the button."}\n```',
        pushOk: true, sha: 'b'.repeat(40),
      },
      stopped: false, costUsd: 0, pricing: null,
    };
  };
  const realTargets = live.mentionTargets;
  live.mentionTargets = async () => ['evan'];
  t.after(() => { followup.runFollowUpTurn = realTurn; live.mentionTargets = realTargets; });

  const { rows: [fresh] } = await pool.query('SELECT cs.* FROM chat_sessions cs WHERE cs.id = $1', [session.id]);
  const queueRow = (await pool.query(
    `SELECT id FROM homeroom_bot_queue WHERE app_id = $1 AND issue_number = 48`, [app.id],
  )).rows[0];
  const outs = [];
  const recordFailure = async (error, extra = {}, { infra = false } = {}) => {
    const id = await bot.insertRun(pool, {
      appId: app.id, issueNumber: 48, mode: 'live', verdict: 'failed', error,
      proposalSessionId: session.id, ...extra,
    });
    if (infra) await pool.query('UPDATE homeroom_bot_queue SET started_at = NULL WHERE id = $1', [queueRow.id]);
    else await pool.query('DELETE FROM homeroom_bot_queue WHERE id = $1', [queueRow.id]);
    outs.push({ infra, id });
    return { ran: !infra, runId: id };
  };
  const out = await bot.runChecksFix(pool, {}, {
    bot: { id: botUser.id, username: 'homeroom_bot' }, app, repo: { owner: 'usernode-bot', repo: 'recipebot' },
    item: { id: queueRow.id, issue_number: 48, thread_seen_at: null }, issue: { number: 48, title: 'Snooze' },
    proposal: { id: session.id }, session: fresh, botLogin: 'usernode-bot',
    runMode: 'live', model: 'm', turnBudgetMs: 60_000, startedMs: Date.now() - 1000,
    recordFailure,
    deps: {
      github: { async fetchPublicIssue() { return { issue: { number: 48, state: 'open' } }; }, async fetchIssueComments() { return { comments: [] }; } },
      ws: { async sendBotMessage(_pool, _appId, msg) { posted.push(['thread', msg.thread.type, msg.content]); return { id: 551 }; } },
      agentTurn: {}, limits: { async recordSpend() {} }, managedOpenRouter: { async usesIncludedKey() { return false; } },
      sessions: { buildHeadlessSeed: () => 'SEED' },
      votes: { async reconcileNativeReviewedHead() { posted.push(['reconcile']); return {}; } },
      notifications: null, domain: 'app.onhomeroom.com',
    },
  });
  assert.equal(out.verdict, 'revise');
  assert.deepEqual(posted.slice(0, 2), [['turn', session.id], ['reconcile']], 'the moved head is reconciled');
  const { rows: [run] } = await pool.query(
    `SELECT verdict, checks_head_sha, proposal_session_id FROM homeroom_bot_runs ORDER BY id DESC LIMIT 1`,
  );
  assert.equal(run.verdict, 'revise');
  assert.equal(run.checks_head_sha, HEAD, 'the run records the head it looked at');
  assert.equal(run.proposal_session_id, session.id);
  const { rows: [note] } = await pool.query(
    `SELECT kind, issue_number, thread_message_id FROM homeroom_bot_posts ORDER BY id DESC LIMIT 1`,
  );
  assert.equal(note.kind, 'checks_revise', 'the note is recorded');
  assert.equal(note.issue_number, 48);
  assert.equal(note.thread_message_id, 551, 'and posted into the proposal\'s thread');
  const threadPosts = posted.filter((p) => p[0] === 'thread');
  assert.equal(threadPosts.length, 1, 'one thread post');
  assert.equal(threadPosts[0][1], 'session', 'in the proposal\'s own thread, not an issue thread or a DM');
  const { rows: [afterQueue] } = await pool.query(
    `SELECT id FROM homeroom_bot_queue WHERE app_id = $1`, [app.id],
  );
  assert.equal(afterQueue, undefined, 'the queue row is spent');
});