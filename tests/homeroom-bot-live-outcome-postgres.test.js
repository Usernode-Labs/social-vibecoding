'use strict';

// #3636: a live build that was lost always records an outcome.
//
// Two ways a live build used to end with no outcome at all: a restart sent
// the issue back to be triaged again while its run stayed "building" (so it
// could be said lost a second time), and a build whose process died without
// a restart's journal to follow left the run with build_ok NULL forever —
// the issue sat on "looking into it" for good. Run against the full
// PostgreSQL schema: the run rows, the queue row, the archived session.

const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const { Pool } = require('pg');

const DSN = process.env.TEST_DATABASE_URL || process.env.DATABASE_URL
  || 'postgres://postgres:postgres@127.0.0.1:5432/postgres';

// Realtime and push are process-wide singletons.
const events = [];
const wsId = require.resolve('../src/services/ws');
require.cache[wsId] = {
  id: wsId, filename: wsId, loaded: true,
  exports: {
    pushConversationEvent() { return 0; },
    pushToUser() { return 0; },
    pushNotificationToUser() { return 0; },
    async handleMessage() { return { ok: true, message: { id: 1 } }; },
    async sendSystemMessage() { return { id: 1 }; },
    pushIssueUpdate() {},
  },
};
const pushId = require.resolve('../src/services/mobile-push');
require.cache[pushId] = {
  id: pushId, filename: pushId, loaded: true,
  exports: { scheduleBadgeSync() { return false; } },
};

const bot = require('../src/services/homeroom-bot');
const live = require('../src/services/homeroom-bot-live');

test('a live build lost, against the full PostgreSQL schema', { timeout: 180000 }, async (t) => {
  const admin = new Pool({ connectionString: DSN, connectionTimeoutMillis: 2000 });
  try { await admin.query('SELECT 1'); } catch (err) {
    await admin.end();
    if (process.env.TEST_DATABASE_URL) throw err;
    t.skip('PostgreSQL unavailable; set TEST_DATABASE_URL to require this check');
    return;
  }
  const name = `hrbot_lost_${crypto.randomBytes(6).toString('hex')}`;
  await admin.query(`CREATE DATABASE ${name}`);
  const url = new URL(DSN); url.pathname = `/${name}`;
  const pool = new Pool({ connectionString: String(url), max: 8 });
  t.after(async () => {
    await pool.end();
    await admin.query(`DROP DATABASE ${name}`);
    await admin.end();
  });
  const schema = fs.readFileSync(require.resolve('../src/db/schema.sql'), 'utf8');
  await pool.query(schema);
  await pool.query(schema); // boot-idempotent

  const { rows: [botUser] } = await pool.query(
    `INSERT INTO users (username, password, has_platform_access, is_synthetic)
     VALUES ('homeroom_bot', 'x', TRUE, TRUE) RETURNING *`,
  );
  const { rows: [app] } = await pool.query(
    `INSERT INTO apps (name, slug, status, created_by, repo_url)
     VALUES ('Todo', 'todo', 'running', $1, 'https://github.com/usernode-bot/todo') RETURNING *`,
    [botUser.id],
  );

  const deps = {
    github: {
      isEnabled: () => true,
      getBotUsername: async () => 'usernode-bot',
      async fetchPublicIssue() { return { issue: { number: 7, title: 'Sort by date', state: 'open' } }; },
      async fetchIssueComments() { return { comments: [] }; },
    },
    ws: {},
    notifications: null,
  };

  const cleanSlate = async () => {
    await pool.query('DELETE FROM homeroom_bot_posts');
    await pool.query('DELETE FROM homeroom_bot_runs');
    await pool.query('DELETE FROM chat_sessions');
    await pool.query('DELETE FROM homeroom_bot_queue');
  };

  async function liveRun({ age = '3 days', sessionStatus = 'active' } = {}) {
    const { rows: [session] } = await pool.query(
      `INSERT INTO chat_sessions (app_id, user_id, status) VALUES ($1, $2, $3) RETURNING *`,
      [app.id, botUser.id, sessionStatus],
    );
    const { rows: [run] } = await pool.query(
      `INSERT INTO homeroom_bot_runs (app_id, issue_number, mode, verdict, build_session_id, created_at)
       VALUES ($1, 7, 'live', 'ready', $2, NOW() - $3::interval) RETURNING *`,
      [app.id, session.id, age],
    );
    return { session, run };
  }

  await t.test('a restart that sent the issue back records the build as interrupted, once', async () => {
    bot._resetForTests();
    await cleanSlate();
    const { session, run } = await liveRun();
    assert.equal(await bot.noteRecoveredLive(pool, session, { lost: true, why: 'killed', mode: 'build' }), true);
    assert.equal(await bot.completeRecoveredLive({ pool, sessionId: session.id, deps }), 'requeued');
    const { rows: [recorded] } = await pool.query('SELECT * FROM homeroom_bot_runs WHERE id = $1', [run.id]);
    assert.equal(recorded.build_ok, false);
    assert.equal(recorded.build_session_id, session.id);
    assert.match(recorded.build_error, /^interrupted: killed by a restart; the issue was sent back to be triaged again$/);
    const { rows: [queued] } = await pool.query(
      'SELECT reason, priority FROM homeroom_bot_queue WHERE app_id = $1 AND issue_number = 7', [app.id],
    );
    assert.equal(queued.reason, 'restart');
    assert.equal(queued.priority, 1);
    const { rows: [put] } = await pool.query('SELECT status FROM chat_sessions WHERE id = $1', [session.id]);
    assert.equal(put.status, 'archived');
    // And the sweep must not say it lost a second time: the row now has its
    // outcome, which is exactly what the sweep reads.
    assert.equal(await bot.settleAbandonedLiveBuilds(pool, { turnSeconds: 1200 }, deps), 0);
  });

  await t.test('the sweep settles a build whose process died without a journal: archived, recorded, said once', async () => {
    bot._resetForTests();
    await cleanSlate();
    const posts = [];
    const realPost = live.post;
    const realBotUsername = live.botUsernameOf;
    live.post = async (args) => { posts.push(args); return { githubCreatedAt: new Date().toISOString() }; };
    live.botUsernameOf = async () => 'usernode-bot';
    try {
      const { session, run } = await liveRun();
      assert.equal(await bot.settleAbandonedLiveBuilds(pool, { turnSeconds: 1200 }, deps), 1);
      const { rows: [recorded] } = await pool.query('SELECT * FROM homeroom_bot_runs WHERE id = $1', [run.id]);
      assert.equal(recorded.build_ok, false);
      assert.match(recorded.build_error, /interrupted: the build was lost before it could be proposed/);
      const { rows: [put] } = await pool.query('SELECT status FROM chat_sessions WHERE id = $1', [session.id]);
      assert.equal(put.status, 'archived');
      assert.equal(posts.length, 1);
      assert.equal(posts[0].kind, 'build_failed');
      assert.match(posts[0].text, /Homeroom bot tried to build this but couldn't finish: interrupted: the build was lost/);
      assert.deepEqual(posts[0].dm, { reason: 'interrupted: the build was lost before it could be proposed' });

      // Settling twice would say it twice; the recorded outcome stops both.
      assert.equal(await bot.settleAbandonedLiveBuilds(pool, { turnSeconds: 1200 }, deps), 0);
      assert.equal(posts.length, 1);
    } finally {
      live.post = realPost;
      live.botUsernameOf = realBotUsername;
    }
  });

  await t.test('a build this process is still running, or a young run, is left alone', async () => {
    bot._resetForTests();
    // A run fresh enough that the clock has not run out.
    const fresh = await liveRun({ age: '2 minutes' });
    assert.equal(await bot.settleAbandonedLiveBuilds(pool, { turnSeconds: 1200 }, deps), 0);
    const { rows: [still] } = await pool.query('SELECT build_ok FROM homeroom_bot_runs WHERE id = $1', [fresh.run.id]);
    assert.equal(still.build_ok, null);
    // An old one, but in flight in this process: the sweep skips it.
    const old = await liveRun();
    bot.liveBuildsInFlight.set(old.run.id, { appId: app.id, issueNumber: 7, startedAt: new Date().toISOString() });
    assert.equal(await bot.settleAbandonedLiveBuilds(pool, { turnSeconds: 1200 }, deps), 0);
    const { rows: [inflight] } = await pool.query('SELECT build_ok FROM homeroom_bot_runs WHERE id = $1', [old.run.id]);
    assert.equal(inflight.build_ok, null);
    bot._resetForTests();
  });

  await t.test('a build whose session reached a proposal is recorded as built, not said lost', async () => {
    bot._resetForTests();
    await cleanSlate();
    const { session, run } = await liveRun({ sessionStatus: 'promoted' });
    assert.equal(await bot.settleAbandonedLiveBuilds(pool, { turnSeconds: 1200 }, deps), 1);
    const { rows: [recorded] } = await pool.query('SELECT * FROM homeroom_bot_runs WHERE id = $1', [run.id]);
    assert.equal(recorded.build_ok, true);
    assert.equal(recorded.proposal_session_id, session.id);
    assert.equal(recorded.build_error, null);
    const { rows: [put] } = await pool.query('SELECT status FROM chat_sessions WHERE id = $1', [session.id]);
    assert.equal(put.status, 'promoted', 'the group\'s proposal is left alone');
  });

  await t.test('the sweep\'s clock is the platform\'s build clock, plus the claim margin', () => {
    // 3 * (1200 + 600) + 600 = 6000s = 100 minutes at the defaults.
    assert.equal(bot.abandonedLiveAfterSeconds({ turnSeconds: 1200 }), 6000);
    assert.equal(bot.abandonedLiveAfterSeconds({}), 3 * (bot.DEFAULTS.turnSeconds + 600) + 600);
  });
});
