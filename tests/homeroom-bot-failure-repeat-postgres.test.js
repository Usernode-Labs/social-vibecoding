'use strict';

// #6313 (4 Nov 2026): "I couldn't finish building this: something went wrong
// during the build. Reply here and I'll try again." was posted five times in
// 28 minutes on #6306 and four times on #6225, each a new post that marked the
// request as having news and rang its requester again. The same failure line
// the bot's last post in the request's thread already says is not said again:
// that post is updated with how many tries it has been and nobody is told.
//
// Against the full schema, through live.post itself: the rows it writes, the
// message it broadcasts and the two cases that must still post (a first
// failure, and a failure that says something different).
//
// Run with: TEST_DATABASE_URL=postgres://… node --test tests/homeroom-bot-failure-repeat-postgres.test.js

const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const { Pool } = require('pg');

const DSN = process.env.TEST_DATABASE_URL || process.env.DATABASE_URL
  || 'postgres://postgres:postgres@127.0.0.1:5432/postgres';

const PLAN = 'Homeroom bot couldn\'t finish writing the plan for this. It is trying again.';
const TIME = 'Homeroom bot couldn\'t finish building this: the build took longer than it\'s allowed. '
  + 'Reply here (or on the GitHub issue) and it will try again.';

test('a repeated build failure updates its one post instead of saying it again', { timeout: 120000 }, async (t) => {
  const admin = new Pool({ connectionString: DSN, connectionTimeoutMillis: 3000 });
  try { await admin.query('SELECT 1'); } catch (err) {
    await admin.end();
    if (process.env.TEST_DATABASE_URL) throw err;
    return t.skip(`PostgreSQL unavailable: ${err.message}`);
  }
  const name = `hrbot_repeat_${crypto.randomBytes(6).toString('hex')}`;
  await admin.query(`CREATE DATABASE ${name}`);
  const url = new URL(DSN);
  url.pathname = `/${name}`;
  const pool = new Pool({ connectionString: String(url), max: 4 });
  t.after(async () => {
    await pool.end();
    await admin.query(`DROP DATABASE ${name}`);
    await admin.end();
  });
  await require('../src/db/schema-migrations').applySchemaWithLockRetry(pool);
  await require('../src/db/reference-data').seedReferenceData(pool);
  await require('../src/db/schema-migrations').applySchemaWithLockRetry(pool);
  const live = require('../src/services/homeroom-bot-live');

  const one = async (sql, params) => (await pool.query(sql, params)).rows[0];
  const owner = await one(
    `INSERT INTO users (username, password) VALUES ('hr_owner', 'x') RETURNING id, username, is_synthetic`);
  const bot = await one(
    `INSERT INTO users (username, password, is_synthetic) VALUES ('homeroom-bot', 'x', TRUE) RETURNING id, username`);
  const app = await one(
    `INSERT INTO apps (name, slug, status, created_by, view_visibility, collab_visibility)
     VALUES ('Repeat', 'hr-repeat', 'running', $1, 'public', 'public') RETURNING id, slug, name`, [owner.id]);

  const broadcasts = [];
  const ws = {
    broadcast(appId, frame) { broadcasts.push({ appId, frame }); },
    async sendBotMessage(_pool, _appId, { content, thread }) {
      return one(
        `INSERT INTO chat_messages (app_id, user_id, content, msg_type, thread_type, thread_ref)
         VALUES ($1, $2, $3, 'message', $4, $5) RETURNING id`,
        [app.id, bot.id, content, thread.type, thread.ref]);
    },
  };
  let comments = 0;
  const github = {
    isEnabled: () => true,
    async createIssueComment() { comments += 1; return { id: 9000 + comments, created_at: new Date().toISOString() }; },
  };
  const say = (text) => live.post({
    pool, github, ws, app, repo: { owner: 'acme', repo: 'repeat' }, issueNumber: 42,
    kind: 'build_failed', text, sender: bot, senderId: bot.id,
  });
  const posts = async () => (await pool.query(
    'SELECT id, thread_message_id FROM homeroom_bot_posts ORDER BY id')).rows;
  const messages = async () => (await pool.query(
    'SELECT id, content, metadata FROM chat_messages ORDER BY id')).rows;

  // The first failure says itself, once.
  const first = await say(PLAN);
  assert.equal(first.thread, true);
  assert.equal(comments, 1, 'the first failure is said once on GitHub');
  assert.equal((await posts()).length, 1);
  const saidOnce = await messages();
  assert.equal(saidOnce.length, 1);
  assert.equal(saidOnce[0].content, 'I couldn\'t finish writing the plan for this. I\'m trying again.');

  // The same failure again: no second post, no second message, no
  // notification; the one post says how many tries it has been.
  const second = await say(PLAN);
  assert.equal(second.repeated, true);
  assert.equal(second.threadMessageId, saidOnce[0].id, 'the same message, updated');
  assert.equal(comments, 1, 'and no second GitHub comment');
  assert.equal((await posts()).length, 1, 'one post, not two');
  const afterTwo = await messages();
  assert.equal(afterTwo.length, 1, 'and one message in the thread');
  assert.equal(afterTwo[0].content,
    'I couldn\'t finish writing the plan for this. I\'m trying again. (Tried 2 times.)');
  assert.equal(Number(afterTwo[0].metadata.homeroomBot.tries), 2);
  const edit = broadcasts.filter((b) => b.frame.type === 'chat_edit');
  assert.equal(edit.length, 1, 'everybody reading hears the update');
  assert.equal(edit[0].frame.messageId, afterTwo[0].id);

  // And again: still one post, now the third try.
  await say(PLAN);
  assert.equal((await posts()).length, 1);
  const afterThree = await messages();
  assert.equal(afterThree.length, 1);
  assert.equal(afterThree[0].content,
    'I couldn\'t finish writing the plan for this. I\'m trying again. (Tried 3 times.)');

  // A failure that says something different is news, and is posted.
  const third = await say(TIME);
  assert.equal(third.thread, true);
  assert.equal((await posts()).length, 2);
  assert.equal((await messages()).length, 2);
});
