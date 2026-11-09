'use strict';

// #6159 (3 Nov 2026): a private thread with Homeroom bot can be finished:
// on its own when its request goes live or is closed, by Mark done, or by
// asking the bot (close_thread). A done thread leaves the Homeroom bot
// page's lists, and anything the person writes in it brings it back where
// it was. Run against the real schema; skips with no PostgreSQL reachable.

const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');

const DSN = process.env.TEST_DATABASE_URL || process.env.DATABASE_URL || 'postgres://postgres:postgres@localhost:5432/postgres';

const workChangedId = require.resolve('../src/services/bot-work-changed');
const changed = [];
require.cache[workChangedId] = { id: workChangedId, filename: workChangedId, loaded: true, exports: { noteWorkChanged(userId) { changed.push(userId); } } };

const privateThreads = require('../src/services/private-threads');
const aiWork = require('../src/services/ai-work');
const mayor = require('../src/services/homeroom-bot-mayor');

async function openDatabase(t) {
  let pg;
  try { pg = require('pg'); } catch { t.skip('the pg driver is not installed'); return null; }
  const admin = new pg.Pool({ connectionString: DSN, connectionTimeoutMillis: 3000, max: 1 });
  try { await admin.query('SELECT 1'); } catch (err) {
    await admin.end().catch(() => {});
    if (process.env.TEST_DATABASE_URL) throw err;
    t.skip(`no postgres reachable at ${DSN}: ${err.message}`);
    return null;
  }
  const name = `private_thread_done_${crypto.randomBytes(6).toString('hex')}`;
  await admin.query(`CREATE DATABASE ${name}`);
  const url = new URL(DSN);
  url.pathname = `/${name}`;
  const pool = new pg.Pool({ connectionString: String(url), max: 4 });
  pool.on('error', () => {});
  t.after(async () => {
    await pool.end().catch(() => {});
    await admin.query(`DROP DATABASE IF EXISTS ${name}`).catch(() => {});
    await admin.end().catch(() => {});
  });
  require('../src/db/schema-source').ensureSchema();
  await pool.query(fs.readFileSync(path.join(__dirname, '../src/db/schema.sql'), 'utf8'));
  return pool;
}

test('a private thread is done, comes back, and finishes with its request', { timeout: 120000 }, async (t) => {
  const pool = await openDatabase(t);
  if (!pool) return;
  const user = async (name, synthetic = false) => (await pool.query(
    'INSERT INTO users (username, password, is_synthetic) VALUES ($1, \'x\', $2) RETURNING id, username', [name, synthetic],
  )).rows[0];
  const bot = await user('homeroom_bot', true);
  const evan = await user('evan');
  const ada = await user('ada');
  const { rows: [app] } = await pool.query(
    `INSERT INTO apps (slug, name, repo_url) VALUES ('ear-trainer', 'Ear Trainer', 'https://github.com/x/ear') RETURNING id, slug, name`,
  );
  const { rows: [chat] } = await pool.query('INSERT INTO conversations (kind) VALUES (\'direct\') RETURNING id');
  await pool.query('INSERT INTO conversation_members (conversation_id, user_id) VALUES ($1, $2), ($1, $3)', [chat.id, evan.id, bot.id]);
  const say = async (sender, content, root = null) => (await pool.query(
    'INSERT INTO conversation_messages (conversation_id, sender_id, content, thread_root_id) VALUES ($1, $2, $3, $4) RETURNING id',
    [chat.id, sender.id, content, root],
  )).rows[0].id;
  const deps = { bot };

  // A design thread filed as request #14.
  const filedRoot = await say(evan, 'An interval quiz screen');
  await say(bot, 'Here is a first version.', filedRoot);
  await pool.query(
    `INSERT INTO private_threads (user_id, conversation_id, root_message_id, app_id, kind, state, result_ref)
     VALUES ($1, $2, $3, $4, 'draft_request', 'filed', 14)`,
    [evan.id, chat.id, filedRoot, app.id],
  );
  // A thread of their own, with no row yet.
  const ideaRoot = await say(evan, 'Chord drill ideas');
  await say(bot, 'Triads first, then sevenths.', ideaRoot);

  await t.test('Mark done: their own thread, a row made for one that had none; nobody else\'s', async () => {
    assert.deepEqual(await privateThreads.markDone(pool, { user: evan, rootId: ideaRoot, deps }), { ok: true, state: 'done' });
    const { rows: [row] } = await pool.query('SELECT state, done_from, done_at FROM private_threads WHERE root_message_id = $1', [ideaRoot]);
    assert.equal(row.state, 'done');
    assert.equal(row.done_from, 'open');
    assert.ok(row.done_at);
    const again = await privateThreads.markDone(pool, { user: evan, rootId: ideaRoot, deps });
    assert.equal(again.unchanged, true, 'a second Mark done changes nothing');
    assert.equal((await privateThreads.markDone(pool, { user: ada, rootId: ideaRoot, deps })).status, 404, 'somebody else\'s is no such thread');
    assert.ok(changed.includes(evan.id), 'the bot page reads its lists again');
  });

  await t.test('a done thread stays findable for a week (#6271), and writing in it brings it back', async () => {
    const listed = async () => (await pool.query(aiWork.PRIVATE_SQL || '', [evan.id, bot.id, 50, aiWork.LIVE_DAYS]).catch(() => ({ rows: null }))).rows;
    const rows = await listed();
    const done = rows && rows.find((r) => Number(r.root_id) === ideaRoot);
    if (rows) {
      assert.deepEqual([done && done.state, !!(done && done.done_at)], ['done', true],
        'a done thread is still read, with the day it closed, so Live this week can show it');
    }
    const reply = await say(evan, 'One more idea', ideaRoot);
    assert.equal(await privateThreads.reopenOnReply(pool, { userId: evan.id, message: { id: reply, thread_root_id: ideaRoot } }), true);
    assert.equal((await privateThreads.stateOf(pool, { user: evan, rootId: ideaRoot, deps })).state, 'open', 'back where it was');
    assert.equal(await privateThreads.reopenOnReply(pool, { userId: evan.id, message: { id: reply, thread_root_id: ideaRoot } }), false);
  });

  await t.test('its request going live finishes it, once; Reopen puts it back to filed', async () => {
    const roots = await privateThreads.finishForRequest(pool, { appId: app.id, issueNumber: 14 });
    assert.deepEqual(roots.map((r) => r.rootId), [filedRoot]);
    const { rows: [row] } = await pool.query('SELECT state, done_from, done_at FROM private_threads WHERE root_message_id = $1', [filedRoot]);
    assert.equal(row.state, 'done');
    assert.equal(row.done_from, 'filed');
    const again = await privateThreads.finishForRequest(pool, { appId: app.id, issueNumber: 14 });
    assert.deepEqual(again.map((r) => r.rootId), [filedRoot], 'a retry still names it, so its line is said under its key');
    const { rows: [same] } = await pool.query('SELECT done_at FROM private_threads WHERE root_message_id = $1', [filedRoot]);
    assert.equal(String(same.done_at), String(row.done_at), 'and does not finish it twice');
    assert.deepEqual(await privateThreads.reopen(pool, { user: evan, rootId: filedRoot }), { ok: true, state: 'filed' });
    assert.equal((await privateThreads.reopen(pool, { user: ada, rootId: filedRoot })).status, 404);
  });

  await t.test('close_thread: only the private thread this turn is in', async () => {
    const ctx = (threadRootId, extra = {}) => ({ user: evan, bot, deps: { threadRootId, ...extra } });
    assert.match((await mayor.closeThread(pool, ctx(null))).error, /Main Chat cannot be closed/);
    assert.match((await mayor.closeThread(pool, ctx(filedRoot, { threadRequest: { rootId: 1 } }))).error, /request/);
    const inThread = ctx(filedRoot);
    const went = await mayor.closeThread(pool, inThread);
    assert.equal(went.ok, true);
    assert.equal(inThread.closedThread, filedRoot);
    assert.equal((await mayor.closeThread(pool, { user: ada, bot, deps: { threadRootId: ideaRoot } })).error, 'No such thread.');
  });
});

test('the bot never tells them to close a thread on their side', () => {
  for (const said of [
    'I can\'t close threads myself, only reply in them.',
    'Nothing is lost if you close it from your side.',
    'You can close this thread yourself.',
  ]) assert.match(said, mayor.NO_CONTROL_CLAIM, said);
  assert.doesNotMatch('Done. Reply here to pick it up again.', mayor.NO_CONTROL_CLAIM);
  const dm = require('../src/services/homeroom-bot-dm');
  assert.equal(dm.doneLine({ how: 'live', issueNumber: 14 }), '#14 is live. This thread is done; reply here to pick it up again.');
  assert.equal(dm.doneLine({ how: 'closed', issueNumber: 14 }), '#14 was closed without going in. This thread is done; reply here to pick it up again.');
  assert.equal(dm.doneLine({ how: 'merged', issueNumber: 14 }), '#14 went in. This thread is done; reply here to pick it up again.');
});
