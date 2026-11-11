'use strict';

// Homeroom bot, one model, step 4 (11 Nov 2026): the posting function
// (src/services/bot-post.js) against the full schema. A post is claimed by
// its key before anything is sent and said once; the place's rules refuse
// what is not said there (recorded); a person's chat with the bot records
// its messages through its transport (homeroom-bot-dm.js sendDm); and the
// migration gives the posts said before keys of their own, so a durable
// build sent back across the release says nothing twice.
//
// Run with: TEST_DATABASE_URL=postgres://… node --test tests/bot-post-postgres.test.js

const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const { Pool } = require('pg');

const DSN = process.env.TEST_DATABASE_URL || process.env.DATABASE_URL
  || 'postgres://postgres:postgres@127.0.0.1:5432/postgres';

test('the posting function against the full schema', { timeout: 120000 }, async (t) => {
  const admin = new Pool({ connectionString: DSN, connectionTimeoutMillis: 3000 });
  try { await admin.query('SELECT 1'); } catch (err) {
    await admin.end();
    if (process.env.TEST_DATABASE_URL) throw err;
    t.skip(`PostgreSQL unavailable: ${err.message}`);
    return;
  }
  const name = `bot_post_${crypto.randomBytes(6).toString('hex')}`;
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

  const botPost = require('../src/services/bot-post');
  const ws = require('../src/services/ws');
  const one = async (sql, params) => (await pool.query(sql, params)).rows[0];
  const owner = await one(`INSERT INTO users (username, password) VALUES ('bp_owner', 'x') RETURNING id, username`);
  const bot = await one(`INSERT INTO users (username, password, is_synthetic) VALUES ('homeroom_bot', 'x', TRUE) RETURNING id, username`);
  const app = await one(
    `INSERT INTO apps (name, slug, status, created_by, view_visibility, collab_visibility)
     VALUES ('Posts', 'bp-posts', 'running', $1, 'public', 'public') RETURNING id, slug, name`, [owner.id]);
  const row = (key) => one('SELECT * FROM bot_posts WHERE said_key = $1', [key]);

  await t.test('a post is claimed, said with its record in the message\'s transaction, and said once', async () => {
    const spec = {
      place: { type: 'issue', ref: 9 }, appId: app.id, kind: 'question', words: 'Which colour?', author: bot,
      issueNumber: 9, version: 'run-1',
    };
    const out = await botPost.post(pool, spec, { ws });
    assert.equal(out.outcome, 'said');
    const key = `question:request:${app.id}-9:run-1`;
    const said = await row(key);
    assert.equal(said.outcome, 'said');
    assert.equal(said.chat_message_id, out.messageId, 'its record names its message');
    assert.ok(said.said_at);
    assert.ok(said.words_digest);
    const projected = await one('SELECT kind, thread_message_id FROM homeroom_bot_posts WHERE id = $1', [said.request_post_id]);
    assert.deepEqual(projected, { kind: 'question', thread_message_id: out.messageId }, 'on the request\'s record once said');
    const again = await botPost.post(pool, spec, { ws });
    assert.deepEqual([again.outcome, again.messageId], ['again', out.messageId]);
    assert.equal((await row(key)).asked, 2, 'asked twice, said once');
    const n = await one(`SELECT COUNT(*)::int AS n FROM chat_messages WHERE thread_type = 'issue' AND thread_ref = 9`);
    assert.equal(n.n, 1);
  });

  await t.test('what a request\'s thread does not hear is recorded as refused, and never a message', async () => {
    const out = await botPost.post(pool, {
      place: { type: 'issue', ref: 10 }, appId: app.id, kind: 'looking', words: 'Looking at this now.', author: bot,
      issueNumber: 10, version: 'once',
    }, { ws });
    assert.equal(out.outcome, 'refused');
    const refused = await row(`looking:request:${app.id}-10:once`);
    assert.deepEqual([refused.outcome, refused.why, refused.chat_message_id], ['refused', 'not_in_place', null]);
    const n = await one(`SELECT COUNT(*)::int AS n FROM chat_messages WHERE thread_type = 'issue' AND thread_ref = 10`);
    assert.equal(n.n, 0);
  });

  await t.test('Homeroom\'s own line about what a person did is said once, with no author', async () => {
    const spec = {
      place: { type: 'issue', ref: 11 }, appId: app.id, kind: 'moved', words: 'bp_owner moved this request to Homeroom as #4 and closed it here',
      issueNumber: 11, version: 'to-4', record: false,
    };
    const out = await botPost.post(pool, spec, { ws });
    assert.equal(out.outcome, 'said');
    const msg = await one('SELECT user_id, msg_type FROM chat_messages WHERE id = $1', [out.messageId]);
    assert.deepEqual(msg, { user_id: null, msg_type: 'system' });
    assert.equal((await row(`moved:request:${app.id}-11:to-4`)).chat_message_id, out.messageId, 'named in the line\'s transaction');
    assert.equal((await botPost.post(pool, spec, { ws })).outcome, 'again');
  });

  await t.test('a newer failure note\'s card supersedes the older card of its kind; a question beside another does not', async () => {
    const tryAgain = () => ({ kind: 'try_again', forUserId: owner.id, args: { issueNumber: 12, sessionId: 5 } });
    const first = await botPost.post(pool, {
      place: { type: 'issue', ref: 12 }, appId: app.id, kind: 'followup_person', words: 'Its checks still fail.', author: bot,
      issueNumber: 12, card: tryAgain(),
    }, { ws });
    const second = await botPost.post(pool, {
      place: { type: 'issue', ref: 12 }, appId: app.id, kind: 'followup_person', words: 'Its checks fail in a new way.', author: bot,
      issueNumber: 12, card: tryAgain(),
    }, { ws });
    const status = async (id) => (await one('SELECT status, retired_reason FROM bot_cards WHERE id = $1', [id]));
    assert.deepEqual(await status(first.cardId), { status: 'retired', retired_reason: 'superseded' });
    assert.deepEqual(await status(second.cardId), { status: 'open', retired_reason: null });
    // Two overlaps on one request, each about another request: both stay.
    const overlap = (other) => botPost.post(pool, {
      place: { type: 'issue', ref: 13 }, appId: app.id, kind: 'overlap', words: `This overlaps with #${other}.`, author: bot,
      issueNumber: 13, card: { kind: 'overlap', forUserId: owner.id, args: { issueNumber: 13, other } },
    }, { ws });
    const a = await overlap(30);
    const b = await overlap(31);
    assert.equal((await status(a.cardId)).status, 'open');
    assert.equal((await status(b.cardId)).status, 'open');
  });

  await t.test('a person\'s chat with the bot records its messages through its transport, and refuses request news', async () => {
    await botPost.recordDm(pool, { userId: owner.id, kind: 'reply', key: 'answer-1', messageId: 77, words: 'Hi.' });
    await botPost.recordDm(pool, { userId: owner.id, kind: 'reply', key: 'answer-1', messageId: 77, words: 'Hi.' });
    const dmRow = await row(`reply:dm:${owner.id}:key-answer-1`);
    assert.deepEqual([dmRow.outcome, dmRow.place_type, dmRow.conversation_message_id, dmRow.asked], ['said', 'dm', 77, 2]);
    // Request news is not a message in their chat: sendDm refuses it, recorded.
    const dm = require('../src/services/homeroom-bot-dm');
    const sent = await dm.sendDm(pool, {
      bot, userId: owner.id, content: 'Your request is built.', idempotencyKey: 'request-news-1',
      metadata: { kind: 'proposal', appSlug: app.slug, issueNumber: 9 },
    });
    assert.equal(sent, null);
    const news = await row(`proposal:dm:${owner.id}:key-request-news-1`);
    assert.equal(news.outcome, 'refused');
  });

  await t.test('the migration keys the posts said before, so a run sent back across the release says nothing twice', async () => {
    const run = await one(
      `INSERT INTO homeroom_bot_runs (app_id, issue_number, verdict, mode) VALUES ($1, 20, 'ready', 'live') RETURNING id`, [app.id]);
    const msg = await one(
      `INSERT INTO chat_messages (app_id, user_id, content, msg_type, thread_type, thread_ref) VALUES ($1, $2, 'Built it.', 'message', 'issue', 20) RETURNING id`,
      [app.id, bot.id]);
    await pool.query(
      `INSERT INTO homeroom_bot_posts (app_id, issue_number, run_id, kind, thread_message_id) VALUES ($1, 20, $2, 'proposal', $3)`,
      [app.id, run.id, msg.id]);
    await pool.query(
      `INSERT INTO homeroom_bot_posts (app_id, issue_number, run_id, kind, pending) VALUES ($1, 20, $2, 'spec', TRUE)`,
      [app.id, run.id]);
    await pool.query(`INSERT INTO homeroom_bot_posts (app_id, issue_number, kind) VALUES ($1, 21, 'looking')`, [app.id]);
    // Its statements are idempotent: run again over rows from before.
    await pool.query(fs.readFileSync(path.join(__dirname, '..', 'src/db/migrations/bot-posts.sql'), 'utf8'));
    const said = await row(`proposal:request:${app.id}-20:run-${run.id}`);
    assert.deepEqual([said.outcome, said.chat_message_id], ['said', msg.id]);
    assert.equal((await row(`spec:request:${app.id}-20:run-${run.id}`)).outcome, 'pending', 'one going out is taken up');
    assert.equal((await row(`looking:request:${app.id}-21:once`)).outcome, 'refused', '"looking" was said once per request, ever');
    const live = require('../src/services/homeroom-bot-live');
    const again = await live.post({
      pool, github: { async createIssueComment() { throw new Error('not again'); } }, ws, app,
      repo: { owner: 'a', repo: 'b' }, issueNumber: 20, kind: 'proposal', runId: run.id, text: 'Built it.', sender: bot,
    });
    assert.equal(again.again, true, 'said before the release: not said again');
  });
});
