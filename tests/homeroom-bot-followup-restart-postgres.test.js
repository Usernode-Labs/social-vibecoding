'use strict';

// #4533: a checks fix a deploy caught is its look's to carry on, against the
// FULL PostgreSQL schema and through server.js's own restart recovery.
//
// PR #4533 (change 7428, request #4524), 9 Oct 2026: the bot's checks fix
// on its own PROMOTED proposal ran 38 minutes against its 20. Its clock was
// a timer in the process the deploy replaced, and recovery followed the turn
// through the person's tail (a promoted proposal was not
// isRecoveredBotSession's), which re-arms no clock. Its push
// landed, and the ledger had no run for it: no checks_revise post, no cost,
// and nothing for MAX_REVISIONS or "already looked at this head" to count.
//
// A follow-up's turn is now a durable step of its look (bot-request's
// bot.look work, services/durable-turn.js), its record naming that work
// item. Restart recovery leaves such a turn to its item, which the next
// claim carries on from its saved step, on its saved deadline, and records
// as a live turn. So these pin that recovery neither follows nor stops it,
// that a person's turn on the bot's proposal is still the person's tail's,
// and the wait shown on the console's queue and the connector.
//
// The worker is stubbed; the session, its turn record, the work item, the
// ledger rows and the queue are real.
//
// Like the repository's other postgres tests it skips when no database is
// reachable, unless TEST_DATABASE_URL insists on one.

const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const { Pool } = require('pg');

const DSN = process.env.TEST_DATABASE_URL || process.env.DATABASE_URL
  || 'postgres://postgres:postgres@127.0.0.1:5432/postgres';
process.env.DATABASE_URL = process.env.DATABASE_URL || DSN;
process.env.SESSION_SECRET = process.env.SESSION_SECRET || 'test-session';
process.env.ADMIN_USERNAME = process.env.ADMIN_USERNAME || 'admin';
process.env.ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || 'admin';
process.env.JWT_SECRET = process.env.JWT_SECRET || 'test-jwt';
require('./platform-keys').setPlatformKeys();

// ── worker stub: the fix's agent, still running in its worker ───────────
let journalTail = async () => ({});
const followed = [];
const stops = [];
const workerPath = require.resolve('../src/services/worker');
const realWorker = require(workerPath);
require.cache[workerPath].exports = {
  ...realWorker,
  usesKubernetesWorkers: () => false,
  resumeTurnFromJournal: async (sessionId, opts) => { followed.push(sessionId); return journalTail(sessionId, opts); },
  stopTurn: async (sessionId) => { stops.push(sessionId); return true; },
  stopTurnByJournal: async (sessionId) => { stops.push(sessionId); return 'stopped'; },
  stopOwnedTurn: async (_pool, { sessionId }) => { stops.push(sessionId); return { stopped: true }; },
  finishTurn: async () => true,
  markTurnTail: async () => true,
  noteTailMilestone: async () => true,
  clearActiveTurn: async () => true,
  adoptWarmWorker: () => {},
  destroyWorker: async () => {},
  isWorkerExecuting: async () => true,
  getTurnByokCents: () => 0,
};
const wsPath = require.resolve('../src/services/ws');
const realWs = require(wsPath);
require.cache[wsPath].exports = {
  ...realWs,
  broadcastGlobal: () => {},
  pushNotificationToUser: () => 0,
  pushToUser: () => 0,
};

const origSetInterval = global.setInterval;
const origSetTimeout = global.setTimeout;
global.setInterval = (...a) => { const t = origSetInterval(...a); if (t && t.unref) t.unref(); return t; };
global.setTimeout = (...a) => { const t = origSetTimeout(...a); if (t && t.unref) t.unref(); return t; };
let adoptOrphanWorker;
try {
  ({ adoptOrphanWorker } = require('../server'));
} finally {
  global.setInterval = origSetInterval;
  global.setTimeout = origSetTimeout;
}

const bot = require('../src/services/homeroom-bot');
const live = require('../src/services/homeroom-bot-live');
const github = require('../src/services/github');
const agentTurn = require('../src/services/agent-turn');
const sessionsRoutes = require('../src/routes/sessions');
const managedKeys = require('../src/services/openrouter-managed-keys');

// The ledger attempt and the agent thread are settled as for any recovered
// turn, and the Mayor's wrap-up is the person's tail's: covered elsewhere.
agentTurn.persistRecoveredAgentThread = async () => {};
agentTurn.settleRecoveredAgentAttempt = async () => null;
sessionsRoutes.resumeRecoveredCodexFreshRetry = async () => null;
const wrapUps = [];
sessionsRoutes.runRecoveredWrapUp = async (args) => { wrapUps.push(args.sessionId); };
managedKeys.usesIncludedKey = async () => false;

const HEAD = 'a'.repeat(40);

test('a checks fix a restart caught is its look\'s, and a person\'s turn the person\'s tail\'s', { timeout: 180000 }, async (t) => {
  const admin = new Pool({ connectionString: DSN, connectionTimeoutMillis: 2000 });
  try { await admin.query('SELECT 1'); } catch (err) {
    await admin.end();
    if (process.env.TEST_DATABASE_URL) throw err;
    t.skip('PostgreSQL unavailable; set TEST_DATABASE_URL to require this check');
    return;
  }
  const name = `hbot_followup_${crypto.randomBytes(6).toString('hex')}`;
  await admin.query(`CREATE DATABASE ${name}`);
  const url = new URL(DSN); url.pathname = `/${name}`;
  const pool = new Pool({ connectionString: String(url), max: 8 });
  const real = {
    post: live.post, postOnProposal: live.postOnProposal, mentionTargets: live.mentionTargets,
    botUsernameOf: live.botUsernameOf, advanceSeen: live.advanceSeen, fetchPublicIssue: github.fetchPublicIssue,
  };
  t.after(async () => {
    Object.assign(live, {
      post: real.post, postOnProposal: real.postOnProposal, mentionTargets: real.mentionTargets,
      botUsernameOf: real.botUsernameOf, advanceSeen: real.advanceSeen,
    });
    github.fetchPublicIssue = real.fetchPublicIssue;
    bot._resetForTests();
    await pool.end();
    await admin.query(`DROP DATABASE ${name}`);
    await admin.end();
  });
  const schema = fs.readFileSync(require.resolve('../src/db/schema.sql'), 'utf8');
  await pool.query(schema);

  const posts = [];
  const onProposal = [];
  live.post = async (args) => { posts.push(args); return { postId: posts.length }; };
  live.postOnProposal = async (args) => { onProposal.push(args); return { postId: onProposal.length }; };
  live.mentionTargets = async () => [];
  live.botUsernameOf = async () => 'usernode-bot';
  live.advanceSeen = async () => ({ advanced: true });
  github.fetchPublicIssue = async (_o, _r, n) => ({ issue: { number: n, title: `Request ${n}`, state: 'open' } });

  const { rows: [botUser] } = await pool.query(
    `INSERT INTO users (username, password, is_synthetic) VALUES ('homeroom_bot', 'x', TRUE) RETURNING id`,
  );
  const { rows: [app] } = await pool.query(
    `INSERT INTO apps (name, slug, status, repo_url) VALUES ('Homeroom', 'homeroom-4533', 'running', $1)
     RETURNING id, slug, name, repo_url`,
    ['https://github.com/usernode-bot/homeroom-4533'],
  );
  const failing = [{ name: 'Proposal page shows the vote card', path: '/#p', status: 'fail', failureReason: 'expected "Vote"' }]
    .concat(Array.from({ length: 40 }, (_, i) => ({ name: `check ${i}`, path: '/', status: 'pass' })));

  // The bot's promoted proposal, its checks failing on HEAD, its queue row,
  // and a turn in flight. `look: true` is a fix turn its request's look runs:
  // its record names that work item (turn-lifecycle.turnOwner), still
  // outstanding. Without it the turn names nobody: a person's, as far as
  // recovery can tell.
  const proposal = async (issueNumber, { look = false, startedAt = new Date(Date.now() - 19 * 60_000) } = {}) => {
    const turnId = crypto.randomUUID();
    const key = `request:${app.id}:${issueNumber}`;
    let owner = null;
    if (look) {
      const { rows: [w] } = await pool.query(
        `INSERT INTO wf_work (machine, key, kind, work_key, input) VALUES ('bot-request', $1, 'bot.look', 'look:1', $2) RETURNING id`,
        [key, JSON.stringify({ appId: app.id, issueNumber, n: 1, kind: 'followUp' })],
      );
      owner = { machine: 'bot-request', key, kind: 'bot.look', workKey: 'look:1', workId: w.id };
    }
    const activeTurn = {
      turnId, logicalTurnId: turnId, turnUuid: crypto.randomUUID(), journal: `/journals/${turnId}.log`, phase: 'executing',
      mode: 'build', backend: 'codex_openrouter', model: 'z-ai/glm-5.3', startedAt: startedAt.toISOString(), attemptNumber: 1,
      ...(owner ? { owner } : {}),
    };
    const { rows: [s] } = await pool.query(
      `INSERT INTO chat_sessions (app_id, user_id, branch_name, status, is_headless, linked_issues, pr_number,
                                  reviewed_head_sha, checks_commit_sha, check_state, test_results, active_turn)
       VALUES ($1, $2, $3, 'promoted', FALSE, $4, $5, $6, $6, 'failing', $7, $8) RETURNING id`,
      [app.id, botUser.id, `dev/homeroom_bot-${issueNumber}`, [issueNumber], 4500 + issueNumber, HEAD,
        JSON.stringify(failing), JSON.stringify(activeTurn)],
    );
    await pool.query(
      `INSERT INTO homeroom_bot_queue (app_id, issue_number, priority, reason, started_at)
       VALUES ($1, $2, 1, $3, NOW())`,
      [app.id, issueNumber, bot.CHECKS_REASON],
    );
    return { sessionId: s.id, turnId, owner };
  };
  const recover = (sessionId) => adoptOrphanWorker(
    { name: `usernode-worker-${sessionId}`, sessionId, state: 'running' },
    { config: {}, pool, staging: {}, ghub: {}, broadcastGlobal: () => {} },
  );
  const runsOf = async (sessionId) => (await pool.query(
    `SELECT verdict, error, budget_stop, checks_head_sha, cost_usd::float8 AS cost_usd, input_tokens, session_id, proposal_session_id
       FROM homeroom_bot_runs WHERE proposal_session_id = $1 ORDER BY id`,
    [sessionId],
  )).rows;

  await t.test('PR #4533: a fix turn its look still holds is left to its look: not followed, not stopped, nothing recorded', async () => {
    const { sessionId, turnId, owner } = await proposal(4524, { look: true });
    followed.length = 0; stops.length = 0; posts.length = 0; onProposal.length = 0; wrapUps.length = 0;
    await recover(sessionId);
    assert.deepEqual(followed, [], 'its journal is its look\'s to follow (durable-turn), on its own saved deadline');
    assert.deepEqual(stops, [], 'and no clock of recovery\'s stops it');
    assert.deepEqual(wrapUps, [], 'the person\'s tail does not run for it');
    assert.deepEqual(await runsOf(sessionId), [], 'what it did is recorded by its look, as a live turn\'s is');
    assert.equal(posts.length + onProposal.length, 0);
    const { rows: [after] } = await pool.query('SELECT active_turn FROM chat_sessions WHERE id = $1', [sessionId]);
    assert.equal(after.active_turn?.turnId, turnId, 'its record stays for its look');
    assert.deepEqual(after.active_turn.owner, owner);
    assert.ok(await bot.checksToFix(pool, sessionId), 'and its failing head is still due until the look says otherwise');
  });

  await t.test('a turn naming no work item on the same kind of proposal is the person\'s tail\'s, never stopped on a bot clock', async () => {
    // Started two hours ago: any bot clock would have ended it long since.
    const { sessionId } = await proposal(4600, { startedAt: new Date(Date.now() - 2 * 3600_000) });
    journalTail = () => new Promise((resolve) => setTimeout(() => resolve({ exitCode: 0, pushOk: false, ahead: 0 }), 1500));
    followed.length = 0; stops.length = 0; posts.length = 0;
    await recover(sessionId);
    assert.deepEqual(followed, [sessionId], 'recovery follows it');
    assert.deepEqual(stops, [], 'to its own end');
    assert.deepEqual(await runsOf(sessionId), [], 'and nothing of the bot\'s recorded for it');
    assert.equal(posts.length, 0);
  });

  await t.test('the console and the connector show a queued row waiting on its busy session, and until when', async (t) => {
    await pool.query('DELETE FROM homeroom_bot_queue');
    const until = new Date(Date.now() + 40 * 60_000);
    await pool.query(
      `INSERT INTO homeroom_bot_queue (app_id, issue_number, priority, reason, wait_reason, wait_until)
       VALUES ($1, 4602, 1, $2, 'session_busy', $3), ($1, 4603, 2, 'new', 'session_busy', NOW() - INTERVAL '1 minute')`,
      [app.id, bot.CHECKS_REASON, until],
    );
    // On: with the bot off, every waiting row says so (bot_paused).
    const { rows: [mode] } = await pool.query(`SELECT value FROM platform_settings WHERE key = 'homeroom_bot_mode'`);
    await pool.query(`UPDATE platform_settings SET value = 'shadow' WHERE key = 'homeroom_bot_mode'`);
    t.after(() => pool.query('UPDATE platform_settings SET value = $1 WHERE key = \'homeroom_bot_mode\'', [mode.value]));
    const payload = await bot.adminPayload(pool, {});
    const byIssue = Object.fromEntries(payload.queue.items.map((i) => [i.issue_number, i.waiting]));
    assert.deepEqual(byIssue[4602], { reason: 'session_busy', until: until.toISOString() });
    assert.equal(byIssue[4603], null, 'a wait that is over is none');
    const shaped = await require('../src/services/bench/connector-data').botOverview(pool, {}, {});
    const item = shaped.queue.items.find((i) => i.issueNumber === 4602);
    assert.deepEqual(item.waiting, { reason: 'session_busy', until: until.toISOString() });
  });
});
