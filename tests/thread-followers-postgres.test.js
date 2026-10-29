'use strict';

// Threads, stage 2 of #6019, against the FULL PostgreSQL schema in a
// throwaway database, through the real code: posts go through the socket's
// handler (services/ws.js handleMessage), Notify me and Mute through the
// route (routes/threads.js).
//
// What this pins:
//   1. A thread's followers are its requesters, builders and voters and its
//      earlier posters, across every anchor in it: a reply on a change in a
//      request's thread reaches the request's filer, and a reply on the
//      request reaches the change's builder and voters.
//   2. Change and decision threads notify now; each row names what leads
//      its thread ('issue_thread_reply' for a request, 'change_thread_reply'
//      for a change or a decision, `detail` the lead's number).
//   3. Notify me follows a thread you had no part in; Mute stops it ringing
//      you until you choose again or post there; null goes back to the rule.
//   4. The route answers only for a thread the viewer may see.
// #4535's rule for a request's own people stays pinned in
// app-chat-postgres.test.js, which runs through the same fan-out.
//
// Run with: TEST_DATABASE_URL=postgres://… node --test tests/thread-followers-postgres.test.js

const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const express = require('express');

const DSN = process.env.TEST_DATABASE_URL
  || process.env.DATABASE_URL
  || 'postgres://postgres:postgres@127.0.0.1:5432/postgres';

test('thread followers against the full schema', { timeout: 120000 }, async (t) => {
  let Pool;
  try { ({ Pool } = require('pg')); } catch { return t.skip('pg is not installed'); }
  const admin = new Pool({ connectionString: DSN, connectionTimeoutMillis: 3000 });
  try { await admin.query('SELECT 1'); } catch (err) {
    await admin.end();
    if (process.env.TEST_DATABASE_URL) throw err;
    return t.skip(`PostgreSQL unavailable: ${err.message}`);
  }
  const name = `thread_followers_${crypto.randomBytes(6).toString('hex')}`;
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
  const schema = fs.readFileSync(require.resolve('../src/db/schema.sql'), 'utf8');
  await pool.query(schema);
  await pool.query(schema);

  require('../src/db/pool').getPool = () => pool;
  const wsBus = require('../src/services/ws-bus');
  wsBus.publish = () => {};
  wsBus.publishBatched = () => {};
  const ws = require('../src/services/ws');
  const { threadsRoutes } = require('../src/routes/threads');

  const users = {};
  async function user(username) {
    const { rows } = await pool.query(
      `INSERT INTO users (username, password) VALUES ($1, 'x') RETURNING id, username`, [username]
    );
    users[rows[0].id] = { id: rows[0].id, username };
    return users[rows[0].id];
  }
  async function makeApp(slug, owner, { view = 'public', collab = 'public' } = {}) {
    const { rows } = await pool.query(
      `INSERT INTO apps (name, slug, status, created_by, view_visibility, collab_visibility)
       VALUES ($1, $1, 'running', $2, $3, $4) RETURNING id, slug`,
      [slug, owner.id, view, collab]
    );
    return rows[0];
  }
  const client = (who, app) => ({ user: { id: who.id, username: who.username }, appId: app.id, appSlug: app.slug });
  async function post(who, app, content, thread) {
    await pool.query(
      `INSERT INTO community_members (community_id, user_id, source)
         SELECT community_id, $2, 'joined' FROM apps WHERE id = $1
       ON CONFLICT DO NOTHING`,
      [app.id, who.id]
    );
    const result = await ws.handleMessage(pool, client(who, app), { type: 'chat', content, thread });
    assert.equal(result.ok, true, `${who.username} posted`);
    return result.message.id;
  }
  // Who got a row for one message, with its kind and detail.
  async function told(messageId) {
    const { rows } = await pool.query(
      `SELECT u.username, n.kind, n.detail FROM notifications n JOIN users u ON u.id = n.user_id
        WHERE n.chat_message_id = $1 AND n.kind IN ('issue_thread_reply', 'change_thread_reply')
        ORDER BY u.username`,
      [messageId]
    );
    return rows.map((r) => `${r.username}:${r.kind}:${r.detail ?? ''}`);
  }

  const httpApp = express();
  httpApp.use(express.json());
  httpApp.use((req, _res, next) => { req.user = users[Number(req.get('x-test-user'))]; next(); });
  httpApp.use(threadsRoutes({}));
  server = await new Promise((resolve) => {
    const listening = httpApp.listen(0, '127.0.0.1', () => resolve(listening));
  });
  const base = `http://127.0.0.1:${server.address().port}`;
  async function follow(who, threadId, notify) {
    const res = await fetch(`${base}/api/threads/${threadId}/follow`, {
      method: 'PUT',
      headers: { 'content-type': 'application/json', ...(who ? { 'x-test-user': String(who.id) } : {}) },
      body: JSON.stringify({ notify }),
    });
    return { status: res.status, body: await res.json().catch(() => null) };
  }

  async function read(who, path) {
    const res = await fetch(`${base}${path}`, { headers: who ? { 'x-test-user': String(who.id) } : {} });
    return { status: res.status, body: await res.json().catch(() => null) };
  }

  const alice = await user('tf_alice'); // files request #7
  const bob = await user('tf_bob'); // builds the change for it
  const carol = await user('tf_carol'); // votes on that change
  const dave = await user('tf_dave'); // posts in the discussion
  const erin = await user('tf_erin'); // chooses Notify me
  const frank = await user('tf_frank'); // posts, then mutes
  const app = await makeApp('tf-app', alice);

  const { rows: [request] } = await pool.query(
    `INSERT INTO requests (app_id, number, title, created_by) VALUES ($1, 7, 'Dark mode', $2)
     RETURNING id, thread_id`,
    [app.id, alice.id]
  );
  const { rows: [change] } = await pool.query(
    `INSERT INTO chat_sessions (app_id, user_id, status, linked_issues, pr_number)
     VALUES ($1, $2, 'promoted', '{7}', 8) RETURNING id, thread_id`,
    [app.id, bob.id]
  );
  await pool.query(`INSERT INTO pr_votes (session_id, user_id, vote) VALUES ($1, $2, 'yes')`, [change.id, carol.id]);
  const thread = Number(request.thread_id);
  assert.ok(thread > 0);
  assert.equal(Number(change.thread_id), thread, 'the change is in its request\'s thread');

  await t.test('a reply on the change reaches the request\'s filer, its builder and its voter', async () => {
    const id = await post(dave, app, 'Does it follow the system setting?', { type: 'session', ref: change.id });
    assert.deepEqual(await told(id), [
      'tf_alice:issue_thread_reply:7', 'tf_bob:issue_thread_reply:7', 'tf_carol:issue_thread_reply:7',
    ]);
  });

  await t.test('a reply on the request reaches the change\'s people and its earlier posters', async () => {
    const id = await post(frank, app, 'It should.', { type: 'issue', ref: 7 });
    assert.deepEqual(await told(id), [
      'tf_alice:issue_thread_reply:7', 'tf_bob:issue_thread_reply:7', 'tf_carol:issue_thread_reply:7',
      'tf_dave:issue_thread_reply:7',
    ], 'dave posted on the change, which is in the same thread');
  });

  await t.test('Notify me follows a thread you had no part in; null goes back to the rule', async () => {
    const res = await follow(erin, thread, true);
    assert.equal(res.status, 200);
    assert.deepEqual(res.body, { threadId: thread, state: 'following', chosen: true });
    const id = await post(dave, app, 'One more thing.', { type: 'issue', ref: 7 });
    assert.ok((await told(id)).includes('tf_erin:issue_thread_reply:7'));
    assert.deepEqual((await follow(erin, thread, null)).body, { threadId: thread, state: 'none', chosen: false });
    const later = await post(dave, app, 'And another.', { type: 'issue', ref: 7 });
    assert.ok(!(await told(later)).includes('tf_erin:issue_thread_reply:7'));
  });

  await t.test('Mute stops a thread ringing you until you post there again', async () => {
    assert.deepEqual((await follow(frank, thread, false)).body, { threadId: thread, state: 'muted', chosen: true });
    const quiet = await post(dave, app, 'Pushed a fix.', { type: 'session', ref: change.id });
    assert.ok(!(await told(quiet)).some((r) => r.startsWith('tf_frank:')), 'a muted follower is passed by');
    await post(frank, app, 'Looks right now.', { type: 'session', ref: change.id });
    const { rows } = await pool.query('SELECT 1 FROM thread_followers WHERE thread_id = $1 AND user_id = $2', [thread, frank.id]);
    assert.equal(rows.length, 0, 'posting follows it again');
    const heard = await post(dave, app, 'Thanks.', { type: 'issue', ref: 7 });
    assert.ok((await told(heard)).includes('tf_frank:issue_thread_reply:7'));
  });

  await t.test('a change with no request leads its own thread, and its rows say so', async () => {
    const { rows: [solo] } = await pool.query(
      `INSERT INTO chat_sessions (app_id, user_id, status, pr_number) VALUES ($1, $2, 'promoted', 20)
       RETURNING id, thread_id`,
      [app.id, bob.id]
    );
    assert.ok(Number(solo.thread_id) > 0 && Number(solo.thread_id) !== thread);
    await pool.query(`INSERT INTO pr_votes (session_id, user_id, vote) VALUES ($1, $2, 'no')`, [solo.id, carol.id]);
    const id = await post(dave, app, 'Why this way?', { type: 'session', ref: solo.id });
    assert.deepEqual(await told(id), ['tf_bob:change_thread_reply:20', 'tf_carol:change_thread_reply:20']);
  });

  await t.test('a decision filed as a governance row notifies its voters, with no number', async () => {
    const { rows: [rename] } = await pool.query(
      `INSERT INTO issues (app_id, title, kind, created_by, payload)
       VALUES ($1, 'Rename to Night Owl', 'rename', $2, '{"name":"Night Owl"}') RETURNING id, thread_id`,
      [app.id, alice.id]
    );
    assert.ok(Number(rename.thread_id) > 0);
    await pool.query(`INSERT INTO issue_votes (issue_id, user_id, vote) VALUES ($1, $2, 'yes')`, [rename.id, carol.id]);
    const id = await post(dave, app, 'I like it.', { type: 'governance', ref: rename.id });
    assert.deepEqual(await told(id), ['tf_alice:change_thread_reply:', 'tf_carol:change_thread_reply:'],
      'the proposer (the governance row\'s creator) and the voter');
  });

  await t.test('the route answers only for a thread the viewer may see, with a choice it understands', async () => {
    assert.equal((await follow(null, thread, true)).status, 401);
    assert.equal((await follow(erin, thread, 'yes')).status, 422);
    assert.equal((await follow(erin, 999999, true)).status, 404);
    assert.equal((await follow(erin, 'abc', true)).status, 404);
    const hidden = await makeApp('tf-hidden', alice, { view: 'private', collab: 'private' });
    const { rows: [secret] } = await pool.query(
      `INSERT INTO requests (app_id, number, title, created_by) VALUES ($1, 1, 'Secret', $2) RETURNING thread_id`,
      [hidden.id, alice.id]
    );
    assert.equal((await follow(erin, secret.thread_id, true)).status, 404, 'a project you cannot see has no threads for you');
    const { rows } = await pool.query('SELECT 1 FROM thread_followers WHERE user_id = $1', [erin.id]);
    assert.equal(rows.length, 0, 'nothing was stored for it');
  });

  // ── Stage 3: the thread page's read ────────────────────────────────

  await t.test('a thread by any number in it: the request, its change and what was said on each', async () => {
    const page = await read(erin, `/api/apps/${app.slug}/threads/7`);
    assert.equal(page.status, 200);
    assert.deepEqual(page.body.thread, { id: thread, number: 7, kind: 'work', lead: 'request', title: null, state: 'open' });
    const items = page.body.items.map((i) => `${i.type}:${i.number}:${i.replies}`);
    assert.deepEqual(items, ['request:7:4', 'change:8:3'], 'oldest first, each with its people\'s replies');
    const change = page.body.items.find((i) => i.type === 'change');
    assert.equal(change.state, 'review');
    assert.deepEqual(change.folded.map((r) => `${r.username}:${r.text}`),
      ['tf_dave:Does it follow the system setting?', 'tf_dave:Pushed a fix.', 'tf_frank:Looks right now.'],
      'the newest replies fold under the change, in the order they were said');
    assert.deepEqual(page.body.follow, { state: 'none', chosen: false });
    const byChange = await read(erin, `/api/apps/${app.slug}/threads/8`);
    assert.equal(byChange.body.thread.id, thread, 'the change\'s own number is the same thread');
    assert.equal((await read(null, `/api/apps/${app.slug}/threads/7`)).body.follow, null, 'signed out: readable, no button');
  });

  await t.test('a change of its own leads its thread; a decision is read by its id', async () => {
    const solo = await read(bob, `/api/apps/${app.slug}/threads/20`);
    assert.equal(solo.body.thread.lead, 'change');
    assert.deepEqual(solo.body.follow, { state: 'following', chosen: false }, 'its builder follows it');
    const { rows: [rename] } = await pool.query(`SELECT thread_id FROM issues WHERE kind = 'rename' AND app_id = $1`, [app.id]);
    const decision = await read(carol, `/api/threads/${rename.thread_id}`);
    assert.equal(decision.status, 200);
    assert.equal(decision.body.thread.lead, 'decision');
    assert.deepEqual(decision.body.items.map((i) => `${i.type}:${i.replies}`), ['decision:1']);
    assert.equal(decision.body.items[0].folded[0].text, 'I like it.');
  });

  await t.test('a change nobody else can see yet is not listed for them, but is for its builder', async () => {
    const { rows: [draft] } = await pool.query(
      `INSERT INTO chat_sessions (app_id, user_id, status, linked_issues) VALUES ($1, $2, 'active', '{7}') RETURNING id`,
      [app.id, bob.id]
    );
    const types = async (who) => (await read(who, `/api/apps/${app.slug}/threads/7`)).body.items
      .filter((i) => i.type === 'change').map((i) => i.id);
    assert.ok(!(await types(erin)).includes(draft.id), 'a private draft stays private');
    assert.ok((await types(bob)).includes(draft.id), 'its builder sees it');
    await pool.query('UPDATE chat_sessions SET shared_at = NOW() WHERE id = $1', [draft.id]);
    assert.ok((await types(erin)).includes(draft.id), 'once shared, everyone does');
  });

  await t.test('a blocked person\'s replies are not folded for the one who blocked them', async () => {
    await pool.query('INSERT INTO user_blocks (blocker_id, blocked_user_id) VALUES ($1, $2)', [erin.id, dave.id]);
    const page = await read(erin, `/api/apps/${app.slug}/threads/7`);
    const change = page.body.items.find((i) => i.type === 'change' && i.number === 8);
    assert.ok(change.folded.every((r) => r.username !== 'tf_dave'));
    await pool.query('DELETE FROM user_blocks WHERE blocker_id = $1', [erin.id]);
  });

  await t.test('the read answers only for a project the viewer may see, and a number it holds', async () => {
    // A number with no thread is an answer, not a 404: every request and
    // change page asks on open, and a 404 is a console error there.
    const none = await read(erin, `/api/apps/${app.slug}/threads/999`);
    assert.equal(none.status, 200);
    assert.deepEqual(none.body, { thread: null });
    assert.equal((await read(erin, `/api/apps/${app.slug}/threads/abc`)).status, 404);
    assert.equal((await read(erin, '/api/apps/tf-hidden/threads/1')).status, 404);
    assert.equal((await read(erin, '/api/threads/999999')).status, 404);
  });
});
