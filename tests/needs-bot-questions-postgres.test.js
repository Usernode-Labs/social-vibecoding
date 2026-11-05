'use strict';

// 5 Nov 2026 (docs/plans/bot-one-model.md, step 4): Homeroom bot's questions
// in Needs you come from where each request stands, against the REAL schema
// in a throwaway PostgreSQL database.
//
// What this pins:
//   1. A request whose stored work state waits for its requester's answer
//      (waiting_for_you · question, services/work-state.js) is owed by that
//      requester: one row in the Needs you feed, its key in COUNTS_SQL's
//      `owed`, and one row in GET /api/workshop/bot-questions, each by the
//      bot's question post on the request (homeroom_bot_posts), saying what
//      it asked.
//   2. Nobody else owes it.
//   3. A question still open in their chat with the bot from before
//      (homeroom_bot_dm_messages) is listed instead, never both.
//   4. It leaves all three once the request moves on, and when its post is
//      deleted.
//
// Run with: TEST_DATABASE_URL=postgres://… node --test tests/needs-bot-questions-postgres.test.js

const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');

const DSN = process.env.TEST_DATABASE_URL
  || process.env.DATABASE_URL
  || 'postgres://postgres:postgres@127.0.0.1:5432/postgres';

test('the bot\'s questions in Needs you are the requests that wait on an answer', { timeout: 180000 }, async (t) => {
  let Pool;
  try { ({ Pool } = require('pg')); } catch { return t.skip('pg is not installed'); }
  const admin = new Pool({ connectionString: DSN, connectionTimeoutMillis: 3000 });
  try { await admin.query('SELECT 1'); } catch (err) {
    await admin.end();
    if (process.env.TEST_DATABASE_URL) throw err;
    return t.skip(`PostgreSQL unavailable: ${err.message}`);
  }
  const name = `needs_botq_${crypto.randomBytes(6).toString('hex')}`;
  await admin.query(`CREATE DATABASE ${name}`);
  const url = new URL(DSN);
  url.pathname = `/${name}`;
  const pool = new Pool({ connectionString: String(url), max: 6 });
  t.after(async () => {
    await pool.end();
    await admin.query(`DROP DATABASE ${name}`);
    await admin.end();
  });
  await require('../src/db/schema-migrations').applySchemaWithLockRetry(pool);
  await require('../src/db/reference-data').seedReferenceData(pool);
  await require('../src/db/schema-migrations').applySchemaWithLockRetry(pool);
  require('../src/db/pool').getPool = () => pool;
  const overview = require('../src/routes/workshop-overview');

  const one = async (sql, params) => (await pool.query(sql, params)).rows[0];
  const user = (username, synthetic = false) => one(
    `INSERT INTO users (username, password, has_platform_access, is_synthetic)
     VALUES ($1, 'x', TRUE, $2) RETURNING id, username`,
    [username, synthetic]);
  const bot = await user('homeroom_bot', true);
  const ada = await user('nq_ada');
  const bob = await user('nq_bob');
  const app = await one(
    `INSERT INTO apps (name, slug, view_visibility, collab_visibility)
     VALUES ('Seed swap', 'nq-seed-swap', 'public', 'public') RETURNING id, slug`);
  for (const u of [ada, bob]) {
    await pool.query(`INSERT INTO app_collaborators (app_id, user_id, status) VALUES ($1, $2, 'member')`, [app.id, u.id]);
  }
  await pool.query(`INSERT INTO requests (app_id, number, title, created_by) VALUES ($1, 7, 'Swap by post', $2)`, [app.id, ada.id]);

  // The bot's question, posted on the request's thread, and where the
  // request stands: waiting for ada's answer.
  const asked = await one(
    `INSERT INTO chat_messages (app_id, user_id, content, thread_type, thread_ref)
     VALUES ($1, $2, 'Should a swap close after a week?', 'issue', 7) RETURNING id`,
    [app.id, bot.id]);
  await pool.query(
    `INSERT INTO homeroom_bot_posts (app_id, issue_number, kind, thread_message_id) VALUES ($1, 7, 'question', $2)`,
    [app.id, asked.id]);
  const stand = (stage, why) => pool.query(
    `INSERT INTO work_states (app_id, item_kind, item_ref, issue_number, stage, why, whose_move, requester_id, since)
     VALUES ($1, 'request', 7, 7, $2, $3, $4, $5, NOW())
     ON CONFLICT (app_id, item_kind, item_ref)
       DO UPDATE SET stage = EXCLUDED.stage, why = EXCLUDED.why, whose_move = EXCLUDED.whose_move`,
    [app.id, stage, why, why ? 'requester' : 'bot', ada.id]);
  await stand('waiting_for_you', 'question');

  // What the three readers say, for one viewer.
  const feed = async (viewer) => (await pool.query(
    overview.NEEDS_FEED_SQL, [viewer.id, false, false, overview.NEEDS_FEED_MAX])).rows
    .filter((r) => Number(r.app_id) === Number(app.id) && r.kind === 'question')
    .map((r) => ({ id: Number(r.id), title: r.title, author: r.author, number: Number(r.number) }));
  const owed = async (viewer) => {
    const row = (await pool.query(overview.COUNTS_SQL, [viewer.id, false, false])).rows
      .find((r) => r.slug === app.slug);
    return row ? { needs: Number(row.needs), owed: row.owed } : { needs: 0, owed: [] };
  };
  const listed = async (viewer) => (await pool.query(
    overview.BOT_QUESTIONS_SQL, [viewer.id, overview.BOT_QUESTIONS_MAX])).rows
    .map((r) => ({ id: Number(r.message_id), number: Number(r.issue_number), question: r.question }));

  await t.test('the requester owes it: in the feed, the counts and the list, by the bot\'s post', async () => {
    assert.deepEqual(await feed(ada), [
      { id: asked.id, title: 'Should a swap close after a week?', author: 'homeroom_bot', number: 7 },
    ]);
    assert.deepEqual(await owed(ada), { needs: 1, owed: [`question:${asked.id}`] });
    assert.deepEqual(await listed(ada), [{ id: asked.id, number: 7, question: 'Should a swap close after a week?' }]);
  });

  await t.test('nobody else owes it', async () => {
    assert.deepEqual(await feed(bob), []);
    assert.deepEqual(await owed(bob), { needs: 0, owed: [] });
    assert.deepEqual(await listed(bob), []);
  });

  await t.test('one still open in the chat with the bot is listed instead, never both', async () => {
    const conversation = await one(`INSERT INTO conversations (kind) VALUES ('direct') RETURNING id`);
    const dm = await one(
      `INSERT INTO conversation_messages (conversation_id, sender_id, content, metadata)
       VALUES ($1, $2, 'A question', jsonb_build_object('homeroomBot', jsonb_build_object('question', 'Weekly or monthly?')))
       RETURNING id`,
      [conversation.id, bot.id]);
    await pool.query(
      `INSERT INTO homeroom_bot_dm_messages (message_id, user_id, conversation_id, app_id, issue_number, kind, question_status)
       VALUES ($1, $2, $3, $4, 7, 'question', 'open')`,
      [dm.id, ada.id, conversation.id, app.id]);
    assert.deepEqual(await feed(ada), [{ id: dm.id, title: 'Weekly or monthly?', author: 'homeroom_bot', number: 7 }]);
    assert.deepEqual(await owed(ada), { needs: 1, owed: [`question:${dm.id}`] });
    assert.deepEqual((await listed(ada)).map((q) => q.id), [dm.id]);
    await pool.query(`UPDATE homeroom_bot_dm_messages SET question_status = 'answered' WHERE message_id = $1`, [dm.id]);
    assert.deepEqual((await feed(ada)).map((q) => q.id), [asked.id], 'answered there, the post asks again');
  });

  await t.test('it leaves all three once the request moves on', async () => {
    await stand('building', null);
    assert.deepEqual(await feed(ada), []);
    assert.deepEqual(await owed(ada), { needs: 0, owed: [] });
    assert.deepEqual(await listed(ada), []);
    await stand('waiting_for_you', 'plan');
    assert.deepEqual(await feed(ada), [], 'a plan waits on a yes, not an answer: it is asked on the request');
  });

  await t.test('and when its post is deleted', async () => {
    await stand('waiting_for_you', 'question');
    assert.equal((await feed(ada)).length, 1);
    await pool.query(`UPDATE chat_messages SET deleted_at = NOW() WHERE id = $1`, [asked.id]);
    assert.deepEqual(await feed(ada), []);
    assert.deepEqual(await listed(ada), []);
  });
});
