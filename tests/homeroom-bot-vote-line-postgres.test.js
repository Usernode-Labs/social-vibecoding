'use strict';

// #3977: a No vote's line on a change Homeroom bot built reaches the bot.
//
// A No comes with a line (#1688). On one of the bot's own changes, while it
// is up for a vote, that line is what the bot should fix, and it used to
// stop at the vote row: a system row the bot neither wakes on nor reads.
// The vote route (routes/votes.js) now hands it over through
// homeroom-bot-dm.js, posted in the change's discussion as the voter's own
// reply, the way Change something posts a DM, with the bot's follow-up
// queued first. These pin when that happens:
//
//   1. voteLineFor: a No whose words moved something (a new vote, a flip,
//      new words). Never a Yes, a No without a line, or a re-cast with the
//      same words, so one line is handed once;
//   2. voteLineTarget, against the full schema: the bot's own change, up for
//      a vote, answering a request, on a project the bot works on and has
//      not paused, revised fewer than MAX_REVISIONS times. Anything else
//      keeps the line on the vote row, as before;
//   3. handVoteLine: one post, as the voter, in the change's discussion, and
//      one queue row at the front ('vote_no', asked for by the voter, paid
//      for as any reply there is).
//
// The route's side (it asks only for a No with new words, and the vote row
// leaves out a line the bot took) is tests/vote-reasons.test.js.
//
// Run with: TEST_DATABASE_URL=postgres://… node --test tests/homeroom-bot-vote-line-postgres.test.js

const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const { Pool } = require('pg');

const DSN = process.env.TEST_DATABASE_URL || process.env.DATABASE_URL
  || 'postgres://postgres:postgres@127.0.0.1:5432/postgres';

// The discussion post goes through ws.handleMessage, exactly as a reply typed
// there does; here it is recorded rather than broadcast.
const threadPosts = [];
let refuse = null;
const wsId = require.resolve('../src/services/ws');
require.cache[wsId] = {
  id: wsId, filename: wsId, loaded: true,
  exports: {
    pushConversationEvent(memberIds) { return memberIds.length; },
    pushToUser() { return 1; },
    pushNotificationToUser() { return 1; },
    pushSessionUpdate() {},
    broadcast() {},
    async handleMessage(_pool, client, msg) {
      if (refuse) return { ok: false, code: refuse };
      threadPosts.push({ userId: client.user.id, appId: client.appId, msg });
      return { ok: true, message: { id: threadPosts.length } };
    },
    async sendSystemMessage() { return { id: 1 }; },
    pushIssueUpdate() {},
  },
};
const pushId = require.resolve('../src/services/mobile-push');
require.cache[pushId] = {
  id: pushId, filename: pushId, loaded: true,
  exports: { scheduleBadgeSync() { return false; } },
};

const dm = require('../src/services/homeroom-bot-dm');
const followup = require('../src/services/homeroom-bot-followup');

// ── 1. Which votes carry a line for the bot ───────────────────────────

test('voteLineFor: a No whose words moved something; never a Yes, a bare No, or the same words again', () => {
  assert.equal(dm.voteLineFor({ vote: 'no', reason: 'Sort the list by date', unchanged: false }), 'Sort the list by date');
  assert.equal(dm.voteLineFor({ vote: 'no', reason: '  Sort it  ', unchanged: false }), 'Sort it');
  assert.equal(dm.voteLineFor({ vote: 'yes', reason: 'Love it', unchanged: false }), null, 'a Yes asks for nothing');
  assert.equal(dm.voteLineFor({ vote: 'no', reason: null, unchanged: false }), null, 'a No without a line');
  assert.equal(dm.voteLineFor({ vote: 'no', reason: '   ', unchanged: false }), null);
  assert.equal(dm.voteLineFor({ vote: 'no', reason: 'Sort the list by date', unchanged: true }), null,
    'the same No with the same words: handed once already');
});

// ── 2 and 3. Where it goes, and what handing it over does ─────────────

test('voteLineTarget and handVoteLine against the full PostgreSQL schema', { timeout: 180000 }, async (t) => {
  const admin = new Pool({ connectionString: DSN, connectionTimeoutMillis: 2000 });
  try { await admin.query('SELECT 1'); } catch (err) {
    await admin.end();
    if (process.env.TEST_DATABASE_URL) throw err;
    t.skip('PostgreSQL unavailable; set TEST_DATABASE_URL to require this check');
    return;
  }
  const name = `hrbot_vote_line_${crypto.randomBytes(6).toString('hex')}`;
  await admin.query(`CREATE DATABASE ${name}`);
  const url = new URL(DSN); url.pathname = `/${name}`;
  const pool = new Pool({ connectionString: String(url), max: 8 });
  t.after(async () => {
    await pool.end();
    await admin.query(`DROP DATABASE ${name}`);
    await admin.end();
  });
  await pool.query(fs.readFileSync(require.resolve('../src/db/schema.sql'), 'utf8'));

  const user = async (username, synthetic = false) => (await pool.query(
    `INSERT INTO users (username, password, has_platform_access, is_synthetic) VALUES ($1, 'x', TRUE, $2)
     RETURNING id, username`,
    [username, synthetic],
  )).rows[0];
  const setting = (key, value) => pool.query(
    `INSERT INTO platform_settings (key, value) VALUES ($1, $2) ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value`,
    [key, value],
  );
  const bot = await user('homeroom_bot', true);
  const maya = await user('maya');
  const sam = await user('sam');
  const app = async (slug) => (await pool.query(
    `INSERT INTO apps (name, slug, status, created_by, repo_url, view_visibility, collab_visibility)
     VALUES ($1, $2, 'running', $3, $4, 'public', 'public') RETURNING id, slug`,
    [`App ${slug}`, slug, maya.id, `https://github.com/usernode-bot/${slug}`],
  )).rows[0];
  const plantPal = await app('plant-pal');
  const quiet = await app('quiet-app');
  await setting('homeroom_bot_mode', 'shadow');
  await setting('homeroom_bot_dm_users', JSON.stringify(['maya', 'sam']));
  await setting('homeroom_bot_live_apps', JSON.stringify(['plant-pal']));
  const change = async ({ appId = plantPal.id, by = bot.id, status = 'promoted', issues = '{1}', headless = false } = {}) => (await pool.query(
    `INSERT INTO chat_sessions (app_id, user_id, branch_name, status, session_title, promoted_at, linked_issues, is_headless)
     VALUES ($1, $2, $3, $4, 'Sunday reminder', NOW(), $5, $6) RETURNING id`,
    [appId, by, `b-${crypto.randomBytes(3).toString('hex')}`, status, issues, headless],
  )).rows[0].id;
  const queueRows = async (appId = plantPal.id) => (await pool.query(
    'SELECT issue_number, reason, requested_by, payer_user_id, priority FROM homeroom_bot_queue WHERE app_id = $1', [appId],
  )).rows;

  const botChange = await change();

  await t.test('the bot\'s own change, up for a vote, on a project it works on: the line goes to it', async () => {
    const target = await dm.voteLineTarget(pool, { sessionId: botChange });
    assert.deepEqual(target, {
      app: { id: plantPal.id, slug: 'plant-pal', name: 'App plant-pal' }, sessionId: botChange, issueNumber: 1,
    });
  });

  await t.test('anything else keeps the line on the vote row', async () => {
    const none = async (sessionId, why) => assert.equal(await dm.voteLineTarget(pool, { sessionId }), null, why);
    await none(await change({ by: maya.id }), 'a person\'s change: not the bot\'s to revise');
    await none(await change({ status: 'merging' }), 'approved and going live');
    await none(await change({ status: 'merged' }), 'live already');
    await none(await change({ status: 'closed' }), 'closed');
    await none(await change({ issues: '{}' }), 'answers no request, so there is no follow-up to run');
    await none(await change({ headless: true }), 'a headless session');
    await none(await change({ appId: quiet.id }), 'a project the bot does not work on');
    await none(0, 'no change at all');
    // Paused: the bot keeps away from the project for now.
    await setting('homeroom_bot_paused_apps', JSON.stringify(['plant-pal']));
    await none(botChange, 'a paused project');
    await pool.query('DELETE FROM platform_settings WHERE key = $1', ['homeroom_bot_paused_apps']);
    // Off: nobody would pick it up.
    await setting('homeroom_bot_mode', 'off');
    await none(botChange, 'the bot is off');
    await setting('homeroom_bot_mode', 'shadow');
    assert.ok(await dm.voteLineTarget(pool, { sessionId: botChange }), 'and back once those are undone');
  });

  await t.test('a change revised MAX_REVISIONS times already takes no more', async () => {
    const revised = await change();
    const revise = () => pool.query(
      `INSERT INTO homeroom_bot_runs (app_id, issue_number, mode, verdict, proposal_session_id)
       VALUES ($1, 1, 'live', 'revise', $2)`,
      [plantPal.id, revised],
    );
    for (let i = 1; i < followup.MAX_REVISIONS; i += 1) await revise();
    assert.ok(await dm.voteLineTarget(pool, { sessionId: revised }), `${followup.MAX_REVISIONS - 1} revisions: one more may follow`);
    await revise();
    assert.equal(await dm.voteLineTarget(pool, { sessionId: revised }), null, `${followup.MAX_REVISIONS}: none`);
  });

  await t.test('handing it over: one post as the voter in the change\'s discussion, and one revision request first in line', async () => {
    threadPosts.length = 0;
    await pool.query('DELETE FROM homeroom_bot_queue');
    const target = await dm.voteLineTarget(pool, { sessionId: botChange });
    const handed = await dm.handVoteLine(pool, { user: sam, target, line: 'Sort the list by date' });
    assert.deepEqual(handed, { ok: true, queued: true });
    assert.equal(threadPosts.length, 1);
    assert.equal(threadPosts[0].userId, sam.id, 'his words, under his name');
    assert.equal(threadPosts[0].appId, plantPal.id);
    assert.deepEqual(threadPosts[0].msg, {
      type: 'chat', content: 'Sort the list by date', thread: { type: 'session', ref: botChange },
    });
    assert.deepEqual(await queueRows(), [{
      issue_number: 1, reason: 'vote_no', requested_by: sam.id, payer_user_id: null, priority: 0,
    }], 'its follow-up is next, paid for as any reply in the discussion is');
    // Handed again (new words): still one row for the request, at the front.
    await dm.handVoteLine(pool, { user: sam, target, line: 'And newest first' });
    assert.equal(threadPosts.length, 2);
    assert.equal((await queueRows()).length, 1);
  });

  await t.test('a post the discussion refuses is reported, and nothing is queued', async () => {
    threadPosts.length = 0;
    await pool.query('DELETE FROM homeroom_bot_queue');
    refuse = 'not_collaborator';
    try {
      const target = await dm.voteLineTarget(pool, { sessionId: botChange });
      const handed = await dm.handVoteLine(pool, { user: sam, target, line: 'Sort the list by date' });
      assert.equal(handed.ok, false, 'so the route keeps the line on the vote row');
      assert.deepEqual(await queueRows(), []);
    } finally {
      refuse = null;
    }
  });
});
