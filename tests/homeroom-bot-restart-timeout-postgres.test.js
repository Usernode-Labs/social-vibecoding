'use strict';

// A live build that deploys land in keeps the time they cost it, against the
// FULL PostgreSQL schema and through server.js's own restart recovery.
//
// Page Turners #3 (5 Oct 2026): its build turn started about 12:31; four
// platform PRs merged between 12:33 and 12:41, each deployed, and each new
// server adopted the build's worker and followed its journal. The bot's
// clock is the turn's start plus its budget (recoveryDeadline), counted
// across every restart, so the last recovery's clock ended the turn at
// 12:51 and the run was recorded as "the build ran past its time limit
// (finished after a restart)".
//
// #3895 answered that by sending such a build round again from the start.
// On 7 Oct 2026 two requests were each built three times that way: the
// worker had run on through every restart, and each try was stopped at the
// same 20-minute clock. Now each restart that reaches the turn is counted on
// its record (turn-lifecycle noteRestart) and gives the clock back
// RESTART_ALLOWANCE_MS, which is what a restart costs a worker that runs on;
// a build whose clock still runs out ran too long on its own.
//
// A restart leaves nothing behind but the turn record, whose start does not
// move, so the recovery these drive is the last restart's. The worker is
// stubbed (the journal runs until the bot's clock stops it); the run rows,
// the queue, the session and the restart count are real.
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

// ── worker stub: the build's agent, still running in its worker ─────────
let journalTail = async () => ({});
let onStop = null;
const stops = [];
const stopTimes = [];
const workerPath = require.resolve('../src/services/worker');
const realWorker = require(workerPath);
require.cache[workerPath].exports = {
  ...realWorker,
  usesKubernetesWorkers: () => false,
  resumeTurnFromJournal: async (sessionId, opts) => journalTail(sessionId, opts),
  stopTurn: async (sessionId) => { stops.push(sessionId); stopTimes.push(Date.now()); onStop?.(); return true; },
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
const turnLifecycle = require('../src/services/turn-lifecycle');
const live = require('../src/services/homeroom-bot-live');
const dm = require('../src/services/homeroom-bot-dm');
const github = require('../src/services/github');
const agentTurn = require('../src/services/agent-turn');
const sessionsRoutes = require('../src/routes/sessions');
const managedKeys = require('../src/services/openrouter-managed-keys');

// The ledger and the agent thread are settled as for any recovered turn;
// what they do is covered elsewhere.
agentTurn.persistRecoveredAgentThread = async () => {};
agentTurn.settleRecoveredAgentAttempt = async () => null;
sessionsRoutes.resumeRecoveredCodexFreshRetry = async () => null;
managedKeys.usesIncludedKey = async () => false;

const BUDGET_MS = bot.DEFAULTS.turnSeconds * 1000;
const ALLOWANCE_MS = bot.RESTART_ALLOWANCE_MS;
const ago = (ms) => new Date(Date.now() - ms).toISOString();
// What a build's clock has left when the last deploy's server takes it. The
// adoption reads the clock only after its own queries (the session, whose
// bot it is, the run's deadline). This was 400 ms, and on 7 Oct 2026 main's
// unit suite took longer than that to get there under the full suite's
// load: the clock read nothing left, the build was recorded as having run
// too long on its own, and the next two subtests failed after it. Each
// recovery waits this out, so it is a few seconds, not a minute.
const CLOCK_LEFT_MS = 5000;
// Still working when the bot's clock stops it.
const untilStopped = () => new Promise((resolve) => { onStop = () => resolve({ exitCode: 143, pushOk: false, ahead: 0 }); });

test('a live build keeps the time restarts cost it; one that still runs out ran too long on its own', { timeout: 180000 }, async (t) => {
  const admin = new Pool({ connectionString: DSN, connectionTimeoutMillis: 2000 });
  try { await admin.query('SELECT 1'); } catch (err) {
    await admin.end();
    if (process.env.TEST_DATABASE_URL) throw err;
    t.skip('PostgreSQL unavailable; set TEST_DATABASE_URL to require this check');
    return;
  }
  const name = `hbot_restart_${crypto.randomBytes(6).toString('hex')}`;
  await admin.query(`CREATE DATABASE ${name}`);
  const url = new URL(DSN); url.pathname = `/${name}`;
  const pool = new Pool({ connectionString: String(url), max: 8 });
  const real = {
    post: live.post, mentionTargets: live.mentionTargets, botUsernameOf: live.botUsernameOf,
    fetchPublicIssue: github.fetchPublicIssue,
  };
  t.after(async () => {
    Object.assign(live, { post: real.post, mentionTargets: real.mentionTargets, botUsernameOf: real.botUsernameOf });
    github.fetchPublicIssue = real.fetchPublicIssue;
    bot._resetForTests();
    await pool.end();
    await admin.query(`DROP DATABASE ${name}`);
    await admin.end();
  });
  const schema = fs.readFileSync(require.resolve('../src/db/schema.sql'), 'utf8');
  await pool.query(schema);

  const posts = [];
  live.post = async (args) => { posts.push(args); return { postId: posts.length }; };
  live.mentionTargets = async () => [];
  live.botUsernameOf = async () => 'usernode-bot';
  github.fetchPublicIssue = async (_o, _r, n) => ({ issue: { number: n, title: `Request ${n}`, state: 'open' } });

  const { rows: [botUser] } = await pool.query(
    `INSERT INTO users (username, password, is_synthetic) VALUES ('homeroom_bot', 'x', TRUE) RETURNING id`,
  );
  const { rows: [mo] } = await pool.query(`INSERT INTO users (username, password) VALUES ('mo', 'x') RETURNING id`);
  const { rows: [app] } = await pool.query(
    `INSERT INTO apps (name, slug, status, repo_url) VALUES ('Page Turners', 'page-turners-30094f', 'running', $1)
     RETURNING id, slug, name, repo_url`,
    ['https://github.com/usernode-bot/page-turners-30094f'],
  );

  // A live build's session, its turn in flight since `startedAt` (the
  // restarts that reached it before this one counted on it), and its run.
  const build = async (issueNumber, startedAt, { restarts = null } = {}) => {
    const turnId = `turn-${crypto.randomBytes(4).toString('hex')}`;
    const activeTurn = {
      turnId, turnUuid: `uuid-${turnId}`, journal: `/journals/${turnId}.log`, phase: 'executing', mode: 'build',
      backend: 'codex_openrouter', model: 'z-ai/glm-5.3-flash', startedAt, attemptNumber: 1,
      ...(restarts == null ? {} : { restarts }),
    };
    const { rows: [s] } = await pool.query(
      `INSERT INTO chat_sessions (app_id, user_id, branch_name, status, is_headless, linked_issues, active_turn)
       VALUES ($1, $2, $3, 'active', FALSE, '{}', $4) RETURNING id`,
      [app.id, botUser.id, `dev/homeroom_bot-${turnId}`, JSON.stringify(activeTurn)],
    );
    const { rows: [r] } = await pool.query(
      `INSERT INTO homeroom_bot_runs (app_id, issue_number, mode, verdict, build_note, build_session_id)
       VALUES ($1, $2, 'live', 'ready', 'build it', $3) RETURNING id`,
      [app.id, issueNumber, s.id],
    );
    return { sessionId: s.id, runId: r.id, turnId };
  };
  // The last restart's server adopting the build's worker.
  const recover = (sessionId) => adoptOrphanWorker(
    { name: `usernode-worker-${sessionId}`, sessionId, state: 'running' },
    { config: {}, pool, staging: {}, ghub: {}, broadcastGlobal: () => {} },
  );
  const runRow = async (id) => (await pool.query('SELECT build_ok, build_error FROM homeroom_bot_runs WHERE id = $1', [id])).rows[0];
  const restartsOf = async (id) => (await pool.query(
    `SELECT (active_turn->>'restarts')::int AS n FROM chat_sessions WHERE id = $1`, [id],
  )).rows[0].n;
  const statusOf = async (id) => (await pool.query('SELECT status FROM chat_sessions WHERE id = $1', [id])).rows[0].status;
  const queueRows = async () => (await pool.query(
    'SELECT issue_number, reason FROM homeroom_bot_queue WHERE app_id = $1 ORDER BY issue_number', [app.id],
  )).rows;
  const context = { appName: 'Page Turners', issueNumber: 3, issueTitle: 'Display location and host information for meetings' };

  await t.test('issue #9, 7 Oct: the fourth restart gives the build back the time all four cost it', async () => {
    // Three restarts had reached it before this one: without their time it
    // would be minutes past its clock and stopped at once. With it, the clock
    // has CLOCK_LEFT_MS plus a margin left (both outcomes read the same, so
    // the wait is what tells them apart).
    const LEFT_MS = CLOCK_LEFT_MS + 3000;
    let followedAt = 0; let restartsSeen = null;
    journalTail = async (sessionId) => {
      followedAt = Date.now();
      restartsSeen = await restartsOf(sessionId);
      return untilStopped();
    };
    stops.length = 0; stopTimes.length = 0; posts.length = 0;
    const { sessionId, runId } = await build(9, ago(BUDGET_MS + 4 * ALLOWANCE_MS - LEFT_MS), { restarts: 3 });
    const t0 = Date.now();
    await recover(sessionId);
    assert.equal(restartsSeen, 4, 'this restart counted on the turn before its clock was read');
    assert.deepEqual(stops, [sessionId], 'the bot\'s clock still ends the turn');
    assert.ok(stopTimes[0] - followedAt >= 2000, `followed until its clock ran out, not stopped at once (${stopTimes[0] - followedAt} ms)`);
    assert.ok(Date.now() - t0 < 60_000, 'at the turn\'s own deadline: the restarts did not re-arm a fresh budget');
    assert.deepEqual(await runRow(runId), { build_ok: false, build_error: 'the build ran past its time limit (finished after a restart)' },
      'its own time ran out: said so, not sent round again from the start');
    assert.deepEqual(await queueRows(), [], 'nothing back on the queue');
    assert.equal(await statusOf(sessionId), 'archived');
    assert.equal(posts.length, 1);
    assert.equal(posts[0].kind, 'build_failed');
    assert.equal(dm.dmText('build_failed', posts[0].dm, { ...context, issueNumber: 9 }).split('\n\n')[1],
      'I couldn\'t finish building this: it took longer than I\'m allowed. Reply here and I\'ll try again.');
  });

  await t.test('a restart is counted on its own turn only, and the count survives the turn\'s phase changes', async () => {
    const { sessionId, turnId } = await build(10, ago(0));
    assert.equal(await turnLifecycle.noteRestart(pool, { sessionId, turnId }), 1);
    assert.equal(await turnLifecycle.noteRestart(pool, { sessionId, turnId }), 2);
    await turnLifecycle.markTailPending(pool, { sessionId, turnId });
    assert.equal(await restartsOf(sessionId), 2, 'a phase change merges into the record: the count stays');
    assert.equal(await turnLifecycle.noteRestart(pool, { sessionId, turnId }), 3);
    assert.equal(await turnLifecycle.noteRestart(pool, { sessionId, turnId: 'turn-another' }), null,
      'a restart that finds another turn there counts nothing on it');
    assert.equal(await restartsOf(sessionId), 3);
    assert.equal(await turnLifecycle.noteRestart(pool, { sessionId, turnId: null }), null);
    await pool.query('UPDATE chat_sessions SET active_turn = NULL WHERE id = $1', [sessionId]);
    assert.equal(await turnLifecycle.noteRestart(pool, { sessionId, turnId }), null, 'no turn, nothing counted');
  });

  await t.test('a build whose time was up before any restart reached it ran too long on its own', async () => {
    journalTail = untilStopped;
    stops.length = 0; posts.length = 0;
    const { sessionId, runId } = await build(4, ago(BUDGET_MS + 5 * 60 * 1000));
    await recover(sessionId);
    assert.deepEqual(stops, [sessionId], 'stopped at once');
    assert.deepEqual(await runRow(runId), { build_ok: false, build_error: 'the build ran past its time limit (finished after a restart)' });
    assert.deepEqual(await queueRows(), [], 'not sent round again');
    assert.equal(posts.length, 1);
    assert.equal(posts[0].kind, 'build_failed');
    assert.equal(dm.dmText('build_failed', posts[0].dm, { ...context, issueNumber: 4 }).split('\n\n')[1],
      'I couldn\'t finish building this: it took longer than I\'m allowed. Reply here and I\'ll try again.',
      'said plainly, with what to do about it');
  });

  await t.test('a first version keeps its doubled clock across a restart, and its restarts\' time', async () => {
    const { sessionId } = await build(5, ago(0));
    await pool.query(
      'INSERT INTO homeroom_bot_requesters (app_id, issue_number, user_id, first_version) VALUES ($1, 5, $2, TRUE)',
      [app.id, mo.id],
    );
    const start = Date.parse('2026-10-05T09:00:00Z');
    const session = { id: sessionId, repo_url: app.repo_url };
    const deadline = await bot.recoveryDeadline(pool, {}, session, { mode: 'build', startedAt: new Date(start).toISOString() });
    assert.equal(deadline - start, BUDGET_MS * bot.FIRST_VERSION_BUILD_TIME_FACTOR);
    const afterTwo = await bot.recoveryDeadline(pool, {}, session, { mode: 'build', startedAt: new Date(start).toISOString(), restarts: 2 });
    assert.equal(afterTwo - start, BUDGET_MS * bot.FIRST_VERSION_BUILD_TIME_FACTOR + 2 * ALLOWANCE_MS,
      'and the time its restarts cost it on top');
  });
});
