'use strict';

// #4530: addressedSinceLastPost against the full PostgreSQL schema. The gate
// on a re-look reads the request's discussion for somebody addressing the
// bot since its last post: a message naming @homeroom_bot, or a reply (a
// quote, metadata.quote.refMsgId) to one of the bot's own thread messages.
// The bound is the later of the newest post's created_at and the run's
// thread_seen_at, people talking among themselves count for nothing, and
// neither the bot's own messages nor any other synthetic account's wake it.
//
// Skips when no PostgreSQL is reachable, like the repository's other
// postgres tests.

const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');

const DSN = process.env.TEST_DATABASE_URL || process.env.DATABASE_URL
  || 'postgres://postgres:postgres@127.0.0.1:5432/postgres';

const live = require('../src/services/homeroom-bot-live');

async function openDatabase(t) {
  let pg;
  try { pg = require('pg'); } catch { t.skip('the pg driver is not installed'); return null; }
  const admin = new pg.Pool({ connectionString: DSN, connectionTimeoutMillis: 3000, max: 1 });
  try {
    await admin.query('SELECT 1');
  } catch (err) {
    await admin.end().catch(() => {});
    if (process.env.TEST_DATABASE_URL) throw err;
    t.skip(`no postgres reachable at ${DSN}: ${err.message}`);
    return null;
  }
  const name = `hrbot_addressed_${crypto.randomBytes(6).toString('hex')}`;
  await admin.query(`CREATE DATABASE ${name}`);
  const url = new URL(DSN);
  url.pathname = `/${name}`;
  const pool = new pg.Pool({ connectionString: String(url), max: 8 });
  pool.on('error', () => {});
  t.after(async () => {
    await pool.end().catch(() => {});
    await admin.query(`DROP DATABASE IF EXISTS ${name}`).catch(() => {});
    await admin.end().catch(() => {});
  });
  await pool.query(fs.readFileSync(path.join(__dirname, '../src/db/schema.sql'), 'utf8'));
  return pool;
}

test('a re-look is answered only by a mention or a reply newer than the bot\'s last post', { timeout: 120000 }, async (t) => {
  const pool = await openDatabase(t);
  if (!pool) return;

  let seq = 0;
  async function user(prefix, { synthetic = false } = {}) {
    const { rows } = await pool.query(
      `INSERT INTO users (username, password, has_platform_access, is_synthetic)
       VALUES ($1, 'x', TRUE, $2) RETURNING id, username`,
      [synthetic ? 'homeroom_bot' : `${prefix}_${++seq}`, synthetic],
    );
    return rows[0];
  }
  const homeroomBot = await user('homeroom_bot', { synthetic: true });
  const evan = await user('evan');
  const drea = await user('drea');
  const { rows: [app] } = await pool.query(
    `INSERT INTO apps (name, slug, status, created_by, repo_url, view_visibility, collab_visibility)
     VALUES ('Todo List', 'todo-list', 'running', $1, 'https://github.com/usernode-bot/todo-list', 'public', 'public')
     RETURNING id, slug`,
    [evan.id],
  );
  const appId = app.id;
  const n = 30;

  // The bot's own message in the request's discussion, and the post that
  // carries it: its thread_message_id is what a reply quotes.
  const { rows: [botMsg] } = await pool.query(
    `INSERT INTO chat_messages (app_id, user_id, content, msg_type, thread_type, thread_ref, created_at)
     VALUES ($1, $2, 'Homeroom bot thinks a person needs to decide this one.', 'message', 'issue', $3, NOW() - INTERVAL '20 minutes')
     RETURNING id`,
    [appId, homeroomBot.id, n],
  );
  await pool.query(
    `INSERT INTO homeroom_bot_posts (app_id, issue_number, kind, thread_message_id, created_at)
     VALUES ($1, $2, 'person', $3, NOW() - INTERVAL '20 minutes')`,
    [appId, n, botMsg.id],
  );

  async function message(who, content, age, { quoted = null, deleted = false } = {}) {
    const { rows } = await pool.query(
      `INSERT INTO chat_messages (app_id, user_id, content, msg_type, thread_type, thread_ref, metadata, deleted_at, created_at)
       VALUES ($1, $2, $3, 'message', 'issue', $4, $5::jsonb, $6, NOW() - make_interval(mins => $7::int))
       RETURNING id`,
      [appId, who.id, content, n, quoted ? JSON.stringify({ quote: { refMsgId: quoted } }) : '{}',
        deleted ? new Date().toISOString() : null, age],
    );
    return rows[0].id;
  }

  const checked = (since = null) => live.addressedSinceLastPost(pool, { appId, issueNumber: n, since });

  // Nobody addressed it: two people discussed among themselves.
  await message(evan, 'might be able to comment on this. not sure about the reason for the change.', 15);
  await message(drea, 'its because more people joined, I think', 12);
  assert.equal(await checked('2026-10-09T17:00:00Z'), false, 'people talking to each other does not address the bot');

  // A mention older than the bot's last post was already answered by that look.
  await message(evan, '@homeroom_bot what about the approval count?', 30);
  assert.equal(await checked('2026-10-09T17:00:00Z'), false, 'a mention before the bound does not count');

  // The bot's own messages, and any synthetic account's, never wake it.
  await message(homeroomBot, '@homeroom_bot @homeroom_bot', 5);
  const { rows: [skeleton] } = await pool.query(
    `INSERT INTO users (username, password, has_platform_access, is_synthetic) VALUES ('webhook_1', 'x', TRUE, TRUE) RETURNING id`,
  );
  await message({ id: skeleton.id }, '@homeroom_bot', 5);
  assert.equal(await checked('2026-10-09T17:00:00Z'), false, 'synthetic accounts do not address the bot');

  // A deleted message counts for nothing either.
  await message(evan, '@homeroom_bot never mind', 5, { deleted: true });

  // A mention newer than the bound, in any letter case, is somebody addressing it.
  await message(drea, 'Hey @Homeroom_Bot, what should we do here?', 10);
  assert.equal(await checked('2026-10-09T17:00:00Z'), true, 'a newer mention opens the note');

  // And so does a reply (a quote) to one of the bot's own messages, without
  // naming it.
  await pool.query(`DELETE FROM chat_messages WHERE id = $1`, [await message(drea, 'Hey @Homeroom_Bot, what should we do here?', 10)]);
  await message(evan, 'good question, same here', 8, { quoted: botMsg.id });
  assert.equal(await checked('2026-10-09T17:00:00Z'), true, 'a reply to one of the bot\'s messages opens the note');

  // A run that has seen past every reply leaves the note unsaid again: the
  // bound is the later of the newest post and the run's seen time.
  assert.equal(await checked(new Date(Date.now() + 60_000).toISOString()), false, 'what the run has already seen does not count');

  // Another request's discussion says nothing about this one.
  assert.equal(await live.addressedSinceLastPost(pool, { appId, issueNumber: 31, since: null }), false,
    'other requests do not address the bot here');

  // @evan naming a person is not naming the bot.
  await message(evan, 'thanks @drea_2 that explains it', 3);
  assert.equal(await checked(new Date(Date.now() + 60_000).toISOString()), false, 'a mention of somebody else is not one of the bot');
});