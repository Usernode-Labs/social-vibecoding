'use strict';

// #6262: where each person's reading of a request, a change or a decision
// thread stands, against the FULL PostgreSQL schema in a throwaway database.
//
// What this pins:
//   1. A thread starts at zero: the first read creates its cursor at the
//      thread's newest message.
//   2. Somebody else's message after it is unread; the viewer's own, a
//      system line, a deleted one and one from somebody they blocked are not.
//   3. The cursor only moves forward, and opening the thread clears it.
//   4. services/ai-work.js lists how much is new on each thread, and the
//      route marks a thread of this app read (404 for another app's).
//
// Run with: TEST_DATABASE_URL=postgres://… node --test tests/thread-reads-postgres.test.js

const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const express = require('express');

const DSN = process.env.TEST_DATABASE_URL
  || process.env.DATABASE_URL
  || 'postgres://postgres:postgres@127.0.0.1:5432/postgres';

test('a thread\'s read cursor, and what the Homeroom bot page counts', { timeout: 120000 }, async (t) => {
  let Pool;
  try { ({ Pool } = require('pg')); } catch { return t.skip('pg is not installed'); }
  const admin = new Pool({ connectionString: DSN, connectionTimeoutMillis: 3000 });
  try { await admin.query('SELECT 1'); } catch (err) {
    await admin.end();
    if (process.env.TEST_DATABASE_URL) throw err;
    return t.skip(`PostgreSQL unavailable: ${err.message}`);
  }
  const name = `thread_reads_${crypto.randomBytes(6).toString('hex')}`;
  await admin.query(`CREATE DATABASE ${name}`);
  const url = new URL(DSN);
  url.pathname = `/${name}`;
  const pool = new Pool({ connectionString: String(url), max: 6 });
  let server;
  t.after(async () => {
    if (server) await new Promise((resolve) => server.close(resolve));
    await pool.end();
    await admin.query(`DROP DATABASE ${name}`);
    await admin.end();
  });
  await require('../src/db/schema-migrations').applySchemaWithLockRetry(pool);
  await require('../src/db/reference-data').seedReferenceData(pool);
  await require('../src/db/schema-migrations').applySchemaWithLockRetry(pool);

  const one = async (sql, params) => (await pool.query(sql, params)).rows[0];
  const user = (username, synthetic = false) => one(
    `INSERT INTO users (username, password, is_synthetic) VALUES ($1, 'x', $2) RETURNING id, username`,
    [username, synthetic]);
  const ada = await user('tr_ada');
  const bob = await user('tr_bob');
  const carol = await user('tr_carol');
  const bot = await user('homeroom_bot', true);
  const app = await one(
    `INSERT INTO apps (name, slug, status, created_by, view_visibility, collab_visibility)
     VALUES ('Threads', 'tr-threads', 'running', $1, 'public', 'public') RETURNING id, slug`, [ada.id]);
  const other = await one(
    `INSERT INTO apps (name, slug, status, created_by, view_visibility, collab_visibility)
     VALUES ('Other', 'tr-other', 'running', $1, 'public', 'public') RETURNING id, slug`, [ada.id]);
  const request = await one(
    `INSERT INTO requests (app_id, number, title, created_by) VALUES ($1, 1, 'Print view', $2) RETURNING id, thread_id`,
    [app.id, ada.id]);
  assert.ok(request.thread_id, 'a request has its thread');
  const threadId = Number(request.thread_id);

  const message = (userId, content, extra = {}) => one(
    `INSERT INTO chat_messages (app_id, user_id, content, thread_type, thread_ref, msg_type, deleted_at)
     VALUES ($1, $2, $3, 'issue', 1, $4, $5) RETURNING id`,
    [app.id, userId, content, extra.msgType || 'message', extra.deletedAt || null]);

  const threadReads = require('../src/services/thread-reads');
  // One message already there: the first read starts at it, so nothing new.
  await message(bob.id, 'before anyone looked');
  assert.equal((await threadReads.unreadFor(pool, ada.id, [threadId])).get(threadId) || 0, 0,
    'a thread starts at zero, not with everything ever written');
  const first = await one(`SELECT last_read_id FROM thread_reads WHERE thread_id = $1 AND user_id = $2`, [threadId, ada.id]);
  assert.ok(first, 'the first read creates the cursor');

  // Somebody else writes: that is new.
  await message(bob.id, 'a reply');
  assert.equal((await threadReads.unreadFor(pool, ada.id, [threadId])).get(threadId), 1);

  // The viewer's own, a system line, a deleted one and a blocked person's
  // never count.
  await message(ada.id, 'my own');
  await message(bob.id, 'a notice', { msgType: 'system' });
  await message(bob.id, 'gone', { deletedAt: new Date() });
  await message(carol.id, 'blocked');
  await pool.query(`INSERT INTO user_blocks (blocker_id, blocked_user_id) VALUES ($1, $2)`, [ada.id, carol.id]);
  assert.equal((await threadReads.unreadFor(pool, ada.id, [threadId])).get(threadId), 1,
    'only another person\'s visible message counts');

  // Opening it clears it, and the cursor only moves forward.
  assert.deepEqual(await threadReads.markRead(pool, { userId: ada.id, threadId }), { unread: 0 });
  const read = await one(`SELECT last_read_id FROM thread_reads WHERE thread_id = $1 AND user_id = $2`, [threadId, ada.id]);
  assert.ok(Number(read.last_read_id) > Number(first.last_read_id));
  await threadReads.markRead(pool, { userId: ada.id, threadId });
  const again = await one(`SELECT last_read_id FROM thread_reads WHERE thread_id = $1 AND user_id = $2`, [threadId, ada.id]);
  assert.equal(Number(again.last_read_id), Number(read.last_read_id), 'never back');
  await message(bob.id, 'one more');
  assert.equal((await threadReads.unreadFor(pool, ada.id, [threadId])).get(threadId), 1, 'and comes back when someone writes');

  // The address a page uses resolves to its thread.
  assert.equal(await threadReads.threadOf(pool, app.id, 'issue', 1), threadId);
  const sessionThread = await one(`INSERT INTO threads (app_id) VALUES ($1) RETURNING id`, [app.id]);
  const session = await one(
    `INSERT INTO chat_sessions (app_id, user_id, status, thread_id) VALUES ($1, $2, 'active', $3) RETURNING id`,
    [app.id, ada.id, sessionThread.id]);
  assert.equal(await threadReads.threadOf(pool, app.id, 'session', session.id), Number(sessionThread.id));
  const decisionThread = await one(`INSERT INTO threads (app_id) VALUES ($1) RETURNING id`, [app.id]);
  const decision = await one(
    `INSERT INTO issues (app_id, title, kind, created_by, thread_id) VALUES ($1, 'Rename it', 'rename', $2, $3) RETURNING id`,
    [app.id, ada.id, decisionThread.id]);
  assert.equal(await threadReads.threadOf(pool, app.id, 'governance', decision.id), Number(decisionThread.id));
  assert.equal(await threadReads.threadOf(pool, other.id, 'issue', 1), null, 'not another project\'s');

  // services/ai-work.js: the request waits for her plan, and says one
  // message is new in it.
  await pool.query('INSERT INTO homeroom_bot_requesters (app_id, issue_number, user_id) VALUES ($1, 1, $2)', [app.id, ada.id]);
  await pool.query(
    `INSERT INTO homeroom_bot_runs (app_id, issue_number, mode, verdict, awaiting_go_at, created_at)
     VALUES ($1, 1, 'live', 'ready', NOW() - INTERVAL '50 minutes', NOW() - INTERVAL '1 hour')`, [app.id]);
  const aiWork = require('../src/services/ai-work');
  const work = await aiWork.workFor(pool, {
    user: { id: ada.id }, deps: { bot, liveSvc: { isStaging: () => false }, settings: { mode: 'live' } },
  });
  const row = work.needs.find((r) => r.threadId === threadId);
  assert.ok(row, 'the plan waits for her');
  assert.equal(row.unread, 1, 'and one message in it is new');
  assert.ok(work.next.concat(work.waiting, work.live).every((r) => typeof r.unread === 'number'),
    'every list carries the count');

  // The route: marks a thread of this app read, hides another app's.
  // The route reads the app through the platform pool; point it at this
  // throwaway database (as ai-work-postgres.test.js does).
  require('../src/db/pool').getPool = () => pool;
  const httpApp = express();
  httpApp.use(express.json());
  httpApp.use((req, _res, next) => { req.user = req.get('x-test-user') ? { id: Number(req.get('x-test-user')) } : null; next(); });
  httpApp.use(require('../src/routes/ai-work').aiWorkRoutes({}));
  server = await new Promise((resolve) => { const s = httpApp.listen(0, '127.0.0.1', () => resolve(s)); });
  const base = `http://127.0.0.1:${server.address().port}`;
  assert.equal((await fetch(`${base}/api/apps/tr-threads/threads/read`, { method: 'POST' })).status, 401);
  const ok = await fetch(`${base}/api/apps/tr-threads/threads/read`, {
    method: 'POST',
    headers: { 'x-test-user': String(ada.id), 'Content-Type': 'application/json' },
    body: JSON.stringify({ thread_type: 'issue', thread_ref: 1 }),
  });
  assert.equal(ok.status, 200);
  assert.deepEqual(await ok.json(), { ok: true, unread: 0 });
  // A page's own number that has no thread (a staging mock request, a row
  // the backfill has not reached) is an answer, not a 4xx a page would log.
  const missing = await fetch(`${base}/api/apps/tr-threads/threads/read`, {
    method: 'POST',
    headers: { 'x-test-user': String(ada.id), 'Content-Type': 'application/json' },
    body: JSON.stringify({ thread_type: 'issue', thread_ref: 404 }),
  });
  assert.equal(missing.status, 200);
  assert.deepEqual(await missing.json(), { ok: true, unread: 0 });
  const otherThread = await one(`INSERT INTO threads (app_id) VALUES ($1) RETURNING id`, [other.id]);
  const hidden = await fetch(`${base}/api/apps/tr-threads/threads/read`, {
    method: 'POST',
    headers: { 'x-test-user': String(ada.id), 'Content-Type': 'application/json' },
    body: JSON.stringify({ thread_id: Number(otherThread.id) }),
  });
  assert.equal(hidden.status, 404, 'a thread of another app is not this app\'s');
});
