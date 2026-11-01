'use strict';

// One page per thread (1 Nov 2026): a change built for a request has no
// page of its own. Against the REAL schema in a throwaway database, this
// pins what the server says about where a change lives and what the
// request's page reads:
//
//   1. A change whose thread a request leads lives on that request's page
//      (threads.requestHome, GET /api/apps/:slug/threads/change/:id); a
//      change with no request keeps its own; a live chat nobody may see is
//      nobody else's to place.
//   2. The request that leads the thread counts its changes' replies.
//   3. A change for several requests lives on the first one's page, and the
//      others' pages say where (`elsewhere`).
//
// The request's merged stream itself is pinned in app-chat-postgres.test.js.
//
// Run with: TEST_DATABASE_URL=postgres://… node --test tests/thread-one-page-postgres.test.js

const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const express = require('express');

const DSN = process.env.TEST_DATABASE_URL || 'postgres://postgres:postgres@127.0.0.1:5432/postgres';

test('a change built for a request lives on the request\'s page', { timeout: 180000 }, async (t) => {
  let Pool;
  try { ({ Pool } = require('pg')); } catch { return t.skip('pg is not installed'); }
  const admin = new Pool({ connectionString: DSN, connectionTimeoutMillis: 2000 });
  try { await admin.query('SELECT 1'); } catch (err) {
    await admin.end();
    if (process.env.TEST_DATABASE_URL) throw err;
    t.skip('PostgreSQL unavailable; set TEST_DATABASE_URL to require this check'); return;
  }
  const name = `thread_one_page_${crypto.randomBytes(6).toString('hex')}`;
  await admin.query(`CREATE DATABASE ${name}`);
  const url = new URL(DSN); url.pathname = `/${name}`;
  const pool = new Pool({ connectionString: String(url), max: 4 });
  let server;
  t.after(async () => {
    if (server) await new Promise((resolve) => server.close(resolve));
    await pool.end();
    await admin.query(`DROP DATABASE ${name}`);
    await admin.end();
  });
  const schema = fs.readFileSync(require.resolve('../src/db/schema.sql'), 'utf8');
  await pool.query(schema);
  await pool.query(schema);
  require('../src/db/pool').getPool = () => pool;
  const threads = require('../src/services/threads');
  const { threadsRoutes } = require('../src/routes/threads');

  const users = {};
  const user = async (username) => {
    const { rows: [row] } = await pool.query(
      `INSERT INTO users (username, password, has_platform_access) VALUES ($1, 'x', TRUE) RETURNING id, username`, [username]);
    users[row.id] = { id: row.id, username: row.username };
    return users[row.id];
  };
  const [ana, dewi, maya] = [await user('op_ana'), await user('op_dewi'), await user('op_maya')];
  const { rows: [app] } = await pool.query(
    `INSERT INTO apps (name, slug, status, view_visibility, collab_visibility) VALUES ('Club', 'op-club', 'running', 'public', 'public') RETURNING id, slug`);
  await pool.query(
    `INSERT INTO requests (app_id, number, title, created_by) VALUES ($1, 10, 'Pin a message', $2), ($1, 11, 'Pin in DMs', $2)`,
    [app.id, ana.id]);
  const change = async (by, { pr = null, linked = [], status = 'promoted', shared = false, title = 'A change' } = {}) => (await pool.query(
    `INSERT INTO chat_sessions (app_id, user_id, status, linked_issues, pr_number, pr_title, branch_name, shared_at)
     VALUES ($1, $2, $3, $4::int[], $5, $6, $7, CASE WHEN $8::boolean THEN NOW() END) RETURNING id, thread_id`,
    [app.id, by.id, status, linked, pr, title, `feature/${pr || crypto.randomBytes(3).toString('hex')}`, shared])).rows[0];
  const pin = await change(dewi, { pr: 12, linked: [10, 11], title: 'Pin it' });
  const alone = await change(dewi, { pr: 20, title: 'Faster search' });
  const draft = await change(maya, { linked: [10], status: 'active', title: 'Draft' });
  const reply = (who, sessionId, content) => pool.query(
    `INSERT INTO chat_messages (app_id, user_id, content, thread_type, thread_ref) VALUES ($1, $2, $3, 'session', $4)`,
    [app.id, who.id, content, sessionId]);
  await reply(maya, pin.id, 'Works for me.');
  await reply(ana, pin.id, 'Thanks!');
  await reply(maya, draft.id, 'Still thinking.');
  await pool.query(
    `INSERT INTO chat_messages (app_id, user_id, content, thread_type, thread_ref) VALUES ($1, $2, 'Please', 'issue', 10)`,
    [app.id, ana.id]);

  const httpApp = express();
  httpApp.use((req, _res, next) => { req.user = users[Number(req.get('x-test-user'))]; next(); });
  httpApp.use(threadsRoutes({}));
  server = await new Promise((resolve) => { const s = httpApp.listen(0, '127.0.0.1', () => resolve(s)); });
  const base = `http://127.0.0.1:${server.address().port}`;
  const read = async (who, path) => {
    const res = await fetch(`${base}${path}`, { headers: who ? { 'x-test-user': String(who.id) } : {} });
    return { status: res.status, body: await res.json().catch(() => null) };
  };

  await t.test('a change built for a request lives on its page; one with no request keeps its own', async () => {
    assert.deepEqual(await threads.requestHome(pool, { appId: app.id, sessionId: pin.id, viewerId: ana.id }), {
      number: 10, threadId: Number(pin.thread_id),
    });
    assert.equal(await threads.requestHome(pool, { appId: app.id, sessionId: alone.id, viewerId: ana.id }), null);
    assert.equal(await threads.requestHome(pool, { appId: app.id, sessionId: draft.id, viewerId: ana.id }), null,
      'a live chat nobody may see is not placed for them');
    assert.equal((await threads.requestHome(pool, { appId: app.id, sessionId: draft.id, viewerId: maya.id })).number, 10,
      'its owner reads it on the request\'s page');
    assert.equal(await threads.requestHome(pool, { appId: app.id + 1, sessionId: pin.id, viewerId: ana.id }), null, 'only in its own app');

    assert.deepEqual((await read(ana, `/api/apps/op-club/threads/change/${pin.id}`)).body, { request: 10 });
    assert.deepEqual((await read(null, `/api/apps/op-club/threads/change/${pin.id}`)).body, { request: 10 }, 'signed out, on a public project');
    assert.deepEqual((await read(ana, `/api/apps/op-club/threads/change/${alone.id}`)).body, { request: null });
    assert.deepEqual((await read(ana, '/api/apps/op-club/threads/change/999999')).body, { request: null });
    assert.deepEqual((await read(ana, '/api/apps/op-club/threads/change/0')).body, { request: null });
    assert.equal((await read(ana, `/api/apps/nope/threads/change/${pin.id}`)).status, 404);
  });

  await t.test('the request that leads the thread counts its changes\' replies', async () => {
    const thread = await threads.threadForNumber(pool, { appId: app.id, number: 10 });
    const asAna = await threads.threadPage(pool, { thread, viewerId: ana.id });
    const request = asAna.items.find((i) => i.type === 'request' && i.number === 10);
    assert.equal(request.replies, 3, 'its own reply and the two on its change; the draft is not Ana\'s to read');
    const asMaya = await threads.threadPage(pool, { thread, viewerId: maya.id });
    assert.equal(asMaya.items.find((i) => i.type === 'request').replies, 4, 'the draft\'s owner counts its reply');
  });

  await t.test('a change for two requests is on the first one\'s page; the other says where', async () => {
    const other = await threads.threadForNumber(pool, { appId: app.id, number: 11 });
    const page = await threads.threadPage(pool, { thread: other, viewerId: ana.id });
    assert.ok(!page.items.some((i) => i.type === 'change'), 'it is not in #11\'s thread');
    assert.deepEqual(page.elsewhere, [{ id: Number(pin.id), number: 12, title: 'Pin it', on: 10, request: 11 }]);
    const first = await threads.threadPage(pool, { thread: await threads.threadForNumber(pool, { appId: app.id, number: 10 }), viewerId: ana.id });
    assert.deepEqual(first.elsewhere, [], 'the first request\'s page has it in its own thread');
  });
});
