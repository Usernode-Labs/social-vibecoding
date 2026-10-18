'use strict';

// #3652: a live build a restart lost always records an outcome.
//
// Run 613 was a live build with a session and neither build_ok nor
// build_error: a redeploy interrupted it, restart recovery archived the
// session and sent the issue back to be triaged, and the refresh its wake
// started read the issue as unchanged and deleted the restart's queue row.
// Recovery now records the interruption and the refresh keeps the row, and a
// sweep records any live build no recovery saw.
//
// Everything the database is asked runs against the full schema, in a
// throwaway database built from src/db/schema.sql as a boot applies it.
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

const REPO = { owner: 'usernode-bot', repo: 'todo' };

function deps(overrides = {}) {
  return {
    github: {
      isEnabled: () => true,
      getBotUsername: async () => 'usernode-bot',
      async fetchPublicIssue(_o, _r, n) { return { issue: { number: n, title: `Issue ${n}`, state: 'open' } }; },
      async fetchPublicIssues() { return { issues: overrides.issues || [] }; },
      async fetchIssueComments() { return { comments: [] }; },
      async createIssueComment() { return { id: 1, created_at: new Date().toISOString() }; },
    },
    limits: { async checkBudget() { return { ok: true }; }, async recordSpend() {} },
    threadContext: { async loadIssueThread() { return { messages: [] }; }, async loadProposalThread() { return { messages: [] }; } },
    managedOpenRouter: { async usesIncludedKey() { return false; } },
    sessions: { buildHeadlessSeed: (n) => `ISSUE #${n}` },
    worker: { async ensureWorkerImage() {}, async ensureWorker() { return 'w'; }, async stopTurn() {} },
    agentTurn: { async resolveCodexRuntimeContext() { return {}; } },
    activeWorkers: new Set(),
    ws: {},
    sessionLifecycle: {},
    notifications: null,
  };
}

test('a live build a restart lost records an outcome, and the sweep leaves it alone', { timeout: 180000 }, async (t) => {
  const admin = new Pool({ connectionString: DSN, connectionTimeoutMillis: 2000 });
  try { await admin.query('SELECT 1'); } catch (err) {
    await admin.end();
    if (process.env.TEST_DATABASE_URL) throw err;
    t.skip('PostgreSQL unavailable; set TEST_DATABASE_URL to require this check');
    return;
  }
  const name = `hbot_live_${crypto.randomBytes(6).toString('hex')}`;
  await admin.query(`CREATE DATABASE ${name}`);
  const url = new URL(DSN); url.pathname = `/${name}`;
  const pool = new Pool({ connectionString: String(url), max: 8 });
  const real = { post: live.post, seen: live.advanceSeen, targets: live.mentionTargets, username: live.botUsernameOf, build: live.buildAndPropose };
  t.after(async () => {
    live.post = real.post; live.advanceSeen = real.seen; live.mentionTargets = real.targets;
    live.botUsernameOf = real.username; live.buildAndPropose = real.build;
    bot._resetForTests();
    await pool.end();
    await admin.query(`DROP DATABASE ${name}`);
    await admin.end();
  });
  const schema = fs.readFileSync(require.resolve('../src/db/schema.sql'), 'utf8');
  await pool.query(schema);
  await pool.query(schema); // boot-idempotent, the new column and index included

  const posts = [];
  live.post = async (args) => { posts.push(args); return { githubCreatedAt: new Date().toISOString() }; };
  live.advanceSeen = async () => ({ advanced: true });
  live.mentionTargets = async () => [];
  live.botUsernameOf = async () => 'usernode-bot';

  const setting = (key, value) => pool.query(
    `INSERT INTO platform_settings (key, value) VALUES ($1, $2)
     ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value`, [key, value],
  );
  const { rows: [botUser] } = await pool.query(
    `INSERT INTO users (username, password, is_synthetic) VALUES ('homeroom_bot', 'x', TRUE) RETURNING id`,
  );
  const app = async (slug) => (await pool.query(
    `INSERT INTO apps (name, slug, status, repo_url) VALUES ($1, $1, 'running', $2) RETURNING id, slug, name, repo_url, self_hosted`,
    [slug, `https://github.com/usernode-bot/${slug}`],
  )).rows[0];
  const todo = await app('todo');
  const session = async () => (await pool.query(
    `INSERT INTO chat_sessions (app_id, user_id, branch_name, status) VALUES ($1, $2, 'dev/b', 'active') RETURNING id`,
    [todo.id, botUser.id],
  )).rows[0].id;
  const liveRun = async (sessionId, issue, { ago = 7000, mode = 'live', threadSeenAt = null } = {}) => (await pool.query(
    `INSERT INTO homeroom_bot_runs (app_id, issue_number, mode, verdict, build_session_id, thread_seen_at, created_at)
     VALUES ($1, $2, $3, 'ready', $4, COALESCE($5::timestamptz, NOW()), NOW() - make_interval(secs => $6::int))
     RETURNING id`,
    [todo.id, issue, mode, sessionId, threadSeenAt, ago],
  )).rows[0].id;
  const runRow = async (id) => (await pool.query(
    'SELECT build_ok, build_error, proposal_session_id, build_session_id FROM homeroom_bot_runs WHERE id = $1', [id],
  )).rows[0];
  const sessionStatus = async (id) => (await pool.query('SELECT status FROM chat_sessions WHERE id = $1', [id])).rows[0].status;

  const settings = { mode: 'live', liveApps: ['todo'], turnSeconds: 1200 };

  await t.test('abandonedLiveAfterSeconds is the longest a build can take, plus the stale-claim margin', () => {
    assert.equal(bot.abandonedLiveAfterSeconds({ turnSeconds: 1200 }), 6000);
    assert.equal(bot.abandonedLiveAfterSeconds(null), 6000);
  });

  await t.test('recovery records the interruption, and the restart row survives the refresh', async () => {
    const sessionId = await session();
    const runId = await liveRun(sessionId, 91, { ago: 5 });
    // The worker was lost: recovery notes the live build.
    assert.equal(await bot.abandonRecoveredTurn({ pool, session: { id: sessionId }, why: 'the worker was lost' }), 'live_pending');
    // Then it is finished once the session is free.
    assert.equal(await bot.completeRecoveredLive({ pool, config: {}, sessionId, deps: deps() }), 'requeued');

    const run = await runRow(runId);
    assert.equal(run.build_ok, false, 'the run says what became of its build');
    assert.equal(run.build_error, 'interrupted: the worker was lost by a restart; the issue was sent back to be triaged again');
    assert.equal(await sessionStatus(sessionId), 'archived');
    const { rows: queue } = await pool.query(
      'SELECT reason, started_at FROM homeroom_bot_queue WHERE app_id = $1 AND issue_number = $2', [todo.id, 91],
    );
    assert.deepEqual(queue, [{ reason: 'restart', started_at: null }], 'back in the queue, without saying "looking" again');

    // The refresh its wake starts reads the issue as unchanged, and leaves
    // the bot's own row and reason in place.
    const refreshed = await bot.refreshApp(pool, todo, {
      github: deps({ issues: [{ number: 91, state: 'open', updatedAt: '2020-01-01T00:00:00Z' }] }).github,
    });
    assert.ok(refreshed);
    const { rows: kept } = await pool.query(
      'SELECT reason, started_at, priority FROM homeroom_bot_queue WHERE app_id = $1 AND issue_number = $2', [todo.id, 91],
    );
    assert.deepEqual(kept, [{ reason: 'restart', started_at: null, priority: 1 }], 'the issue is triaged again');
  });

  await t.test('the sweep says a lost build once, and records it', async () => {
    bot._resetForTests();
    posts.length = 0;
    const sessionId = await session();
    const runId = await liveRun(sessionId, 92);
    const settled = await bot.settleAbandonedLiveBuilds(pool, settings, deps());
    assert.equal(settled, 1);
    const run = await runRow(runId);
    assert.equal(run.build_ok, false);
    assert.equal(run.build_error, bot.ABANDONED_LIVE_ERROR);
    assert.equal(await sessionStatus(sessionId), 'archived');
    assert.equal(posts.length, 1);
    assert.equal(posts[0].kind, 'build_failed');
    assert.match(posts[0].text, /the platform restarted while it was building, and the build was lost/);
    assert.deepEqual(posts[0].dm, { reason: bot.ABANDONED_LIVE_REASON });

    // The claim is guarded, so a second pass records and says nothing more.
    posts.length = 0;
    assert.equal(await bot.settleAbandonedLiveBuilds(pool, settings, deps()), 0);
    assert.equal(posts.length, 0);
  });

  await t.test('a session that became a proposal is recorded as a build that worked, and nothing is said', async () => {
    bot._resetForTests();
    posts.length = 0;
    const sessionId = await session();
    await pool.query("UPDATE chat_sessions SET status = 'promoted' WHERE id = $1", [sessionId]);
    const runId = await liveRun(sessionId, 93);
    await bot.settleAbandonedLiveBuilds(pool, settings, deps());
    const run = await runRow(runId);
    assert.equal(run.build_ok, true);
    assert.equal(run.proposal_session_id, sessionId);
    assert.equal(posts.length, 0);
    assert.equal(await sessionStatus(sessionId), 'promoted', 'left as the proposal it is');
  });

  await t.test('an outcome already said before outcomes were recorded is recorded, and not repeated', async () => {
    bot._resetForTests();
    posts.length = 0;
    const sessionId = await session();
    const runId = await liveRun(sessionId, 94);
    await pool.query(
      `INSERT INTO homeroom_bot_posts (app_id, issue_number, run_id, kind) VALUES ($1, $2, $3, 'build_failed')`,
      [todo.id, 94, runId],
    );
    await bot.settleAbandonedLiveBuilds(pool, settings, deps());
    const run = await runRow(runId);
    assert.equal(run.build_ok, false);
    assert.equal(run.build_error, 'not recorded when it ended; the issue was told: build_failed');
    assert.equal(await sessionStatus(sessionId), 'archived');
    assert.equal(posts.length, 0, 'nothing new said');
  });

  await t.test('nothing is said when a newer run, a closed issue, a non-live app or a recent build speaks', async () => {
    bot._resetForTests();
    posts.length = 0;
    const sessionA = await session();
    const runA = await liveRun(sessionA, 95);
    await pool.query(
      `INSERT INTO homeroom_bot_runs (app_id, issue_number, mode, verdict) VALUES ($1, 95, 'live', 'ready')`, [todo.id],
    );
    const sessionB = await session();
    const runB = await liveRun(sessionB, 96);
    const sessionC = await session();
    const runC = await liveRun(sessionC, 97);
    const sessionD = await session();
    const runD = await liveRun(sessionD, 98, { ago: 60 });

    const gh = deps({ issues: [] }).github;
    gh.fetchPublicIssue = async (_o, _r, n) => ({ issue: { number: n, title: `Issue ${n}`, state: n === 96 ? 'closed' : 'open' } });
    const settled = await bot.settleAbandonedLiveBuilds(pool, { ...settings, liveApps: [] }, deps({ github: gh }));
    assert.equal(settled, 3, 'the runs are still recorded');
    assert.equal(posts.length, 0, 'and nothing is said');
    // Still recorded: a lost build always has an outcome.
    for (const id of [runA, runB, runC]) assert.equal((await runRow(id)).build_ok, false);
    // The recent build is not old enough to be called lost.
    assert.equal((await runRow(runD)).build_ok, null);
  });

  await t.test('a build this process is running, and one recovery is finishing, are left alone', async () => {
    bot._resetForTests();
    posts.length = 0;
    // A live build recovery is following.
    const sessionP = await session();
    const runP = await liveRun(sessionP, 99);
    await bot.abandonRecoveredTurn({ pool, session: { id: sessionP }, why: 'the worker was lost' });
    // And a build running right now: actOnVerdict holds its lane entry
    // while live.buildAndPropose runs.
    const sessionA = await session();
    const runA = await liveRun(sessionA, 100);
    let release;
    const gate = new Promise((r) => { release = r; });
    live.buildAndPropose = async () => { await gate; return { ok: true, sessionId: sessionA, prNumber: 5, costUsd: 0 }; };
    const acting = bot.actOnVerdict({
      pool, config: {}, bot: { id: botUser.id, username: 'homeroom_bot' }, app: todo, repo: REPO,
      issueNumber: 100, issue: { title: 'x' }, parsed: { verdict: 'ready', buildNote: 'x' },
      capSuppressed: null, runId: runA, seed: 'seed', seedReadAt: new Date().toISOString(),
      postedAt: [], turnBudgetMs: 1000, model: 'm', deps: deps(),
    });
    for (let i = 0; i < 100; i += 1) await new Promise((r) => setImmediate(r));

    await bot.settleAbandonedLiveBuilds(pool, settings, deps());
    assert.equal((await runRow(runP)).build_ok, null, 'recovery is still finishing it');
    assert.equal((await runRow(runA)).build_ok, null, 'the build is still running');
    assert.equal(posts.length, 0);

    release();
    await acting;
    assert.equal((await runRow(runA)).build_ok, true, 'its own path records it');
  });
});
