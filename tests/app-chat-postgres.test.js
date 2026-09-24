'use strict';

// #2387 (app channels) and #2967 (the Messages list's sections) against the
// FULL PostgreSQL schema, in a throwaway database, through the real code:
// the canonical chat handler (services/ws.js handleMessage), the REST routes
// (routes/chat.js, routes/messages-overview.js) and services/app-chat.js.
//
// Pinned here:
//   * reply threads — a 'message' thread hangs off a general-stream root of
//     the same app, never nests, never appears in the general stream, and
//     the root carries a summary; the room hears `thread_summary`, with a
//     variant for a viewer who blocked a replier;
//   * 'thread_reply' notifications — root author + earlier repliers, minus
//     the sender, a mention wins, the per-app "Replies to you" switch gates;
//   * soft delete — author only, idempotent, one transaction that clears the
//     text and removes attachments, reactions, bookmarks and notifications;
//     edit / react / save refused afterwards; a placeholder on read;
//   * the read cursor — forward-only read, back-only unread, the unread
//     definition, the lazy cursor at zero, posting as reading;
//   * paging — before / after / around with has_more_* and focus;
//   * the Messages list — "yours" = Home.isYours, "more" = activity, never
//     an app the viewer cannot open, yours first.
//
// Run with: node --test tests/app-chat-postgres.test.js

const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const express = require('express');

const DSN = process.env.TEST_DATABASE_URL
  || process.env.DATABASE_URL
  || 'postgres://postgres:postgres@127.0.0.1:5432/postgres';

test('app channels against the full schema', { timeout: 120000 }, async (t) => {
  let Pool;
  try { ({ Pool } = require('pg')); } catch { return t.skip('pg is not installed'); }
  const admin = new Pool({ connectionString: DSN, connectionTimeoutMillis: 3000 });
  try { await admin.query('SELECT 1'); } catch (err) {
    await admin.end();
    if (process.env.TEST_DATABASE_URL) throw err;
    return t.skip(`PostgreSQL unavailable: ${err.message}`);
  }
  const name = `app_chat_${crypto.randomBytes(6).toString('hex')}`;
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
  await pool.query(schema); // boot-idempotent, the new table and columns included

  // The routes resolve their pool at construction, so it is swapped first.
  // The cross-instance bus is the one place every room frame passes through
  // (publish is a no-op until start(), so nothing else is sent anywhere):
  // recording it is how the test hears what the room would.
  require('../src/db/pool').getPool = () => pool;
  const frames = [];
  const wsBus = require('../src/services/ws-bus');
  wsBus.publish = (kind, routing, data) => frames.push({ kind, routing, data });
  const ws = require('../src/services/ws');
  const appChat = require('../src/services/app-chat');
  const { chatRoutes } = require('../src/routes/chat');
  const { messagesOverviewRoutes } = require('../src/routes/messages-overview');

  const users = {};
  async function user(username, { isAdmin = false } = {}) {
    const { rows } = await pool.query(
      `INSERT INTO users (username, password, is_admin) VALUES ($1, 'x', $2)
       RETURNING id, username`,
      [username, isAdmin]
    );
    users[rows[0].id] = { id: rows[0].id, username, isAdmin };
    return users[rows[0].id];
  }
  async function makeApp(slug, { owner, view = 'public', collab = 'public', selfHosted = false, name: appName } = {}) {
    const { rows } = await pool.query(
      `INSERT INTO apps (name, slug, status, created_by, view_visibility, collab_visibility, self_hosted)
       VALUES ($1, $2, 'running', $3, $4, $5, $6) RETURNING id, slug`,
      [appName || slug, slug, owner ? owner.id : null, view, collab, selfHosted]
    );
    return rows[0];
  }
  async function member(app, who) {
    await pool.query(
      `INSERT INTO app_collaborators (app_id, user_id, status, accepted_at)
       VALUES ($1, $2, 'member', NOW()) ON CONFLICT DO NOTHING`,
      [app.id, who.id]
    );
  }
  const client = (who, app) => ({ user: { id: who.id, username: who.username }, appId: app.id, appSlug: app.slug });
  async function post(who, app, content, extra = {}) {
    const result = await ws.handleMessage(pool, client(who, app), { type: 'chat', content, ...extra });
    return result;
  }
  async function system(app, content) {
    const { rows } = await pool.query(
      `INSERT INTO chat_messages (app_id, content, msg_type) VALUES ($1, $2, 'system') RETURNING id`,
      [app.id, content]
    );
    return rows[0].id;
  }
  const notificationsFor = async (who, kind) => (await pool.query(
    'SELECT * FROM notifications WHERE user_id = $1 AND kind = $2 ORDER BY id', [who.id, kind]
  )).rows;
  const roomFrames = (type) => frames.filter((f) => f.kind === 'room' && f.data?.type === type);

  const httpApp = express();
  httpApp.use(express.json());
  httpApp.use((req, _res, next) => {
    req.user = users[Number(req.get('x-test-user'))];
    next();
  });
  httpApp.use(chatRoutes({}));
  httpApp.use(messagesOverviewRoutes({}));
  server = await new Promise((resolve) => {
    const listening = httpApp.listen(0, '127.0.0.1', () => resolve(listening));
  });
  const base = `http://127.0.0.1:${server.address().port}`;
  async function call(method, path, who, body) {
    const res = await fetch(`${base}${path}`, {
      method,
      headers: { 'x-test-user': String(who.id), ...(body ? { 'content-type': 'application/json' } : {}) },
      body: body ? JSON.stringify(body) : undefined,
    });
    return { status: res.status, body: await res.json().catch(() => null) };
  }

  const alice = await user('ta_alice');
  const bob = await user('ta_bob');
  const carol = await user('ta_carol');
  const dave = await user('ta_dave');
  const chan = await makeApp('ta-chan', { owner: alice, name: 'Chan' });
  const other = await makeApp('ta-other', { owner: alice, name: 'Other' });
  await member(chan, alice);
  await member(chan, bob);

  // ── Reply threads ────────────────────────────────────────────────────

  let rootId;
  let bobReply;
  let carolReply;
  await t.test('a reply thread hangs off a general-stream root and stays out of the general stream', async () => {
    rootId = (await post(alice, chan, 'Root: which colour for the header?')).message.id;
    frames.length = 0;
    const first = await post(bob, chan, 'Blue, I think.', { thread: { type: 'message', ref: rootId } });
    assert.equal(first.ok, true);
    bobReply = first.message.id;
    assert.deepEqual(first.message.thread, { type: 'message', ref: rootId });

    const chat = roomFrames('chat');
    assert.equal(chat.length, 1);
    assert.deepEqual(chat[0].data.thread, { type: 'message', ref: rootId }, 'the live frame names its thread');
    const summary = roomFrames('thread_summary');
    assert.equal(summary.length, 1, 'the room hears the thread grew');
    assert.equal(summary[0].data.root_id, rootId);
    assert.equal(summary[0].data.thread.reply_count, 1);
    assert.deepEqual(summary[0].data.thread.participants, [{ id: bob.id, username: 'ta_bob' }]);

    // No nesting: a reply is not a root. Nor is a system line, a message of
    // another app, or a message that does not exist.
    const sys = await system(chan, 'ta_bob promoted PR #1');
    const otherRoot = (await post(alice, other, 'elsewhere')).message.id;
    for (const ref of [bobReply, sys, otherRoot, 2147483000]) {
      const bad = await post(carol, chan, 'nested?', { thread: { type: 'message', ref } });
      assert.deepEqual(bad, { ok: false, code: 'invalid_thread' }, `ref ${ref}`);
    }

    // The REST write path shares the validation.
    const viaRest = await call('POST', '/api/apps/ta-chan/messages', carol,
      { content: 'Green. @ta_alice what do you think?', thread_type: 'message', thread_ref: rootId });
    assert.equal(viaRest.status, 201);
    assert.equal(viaRest.body.message.thread_type, 'message');
    assert.equal(viaRest.body.message.thread_ref, rootId);
    carolReply = viaRest.body.message.id;
    const nested = await call('POST', '/api/apps/ta-chan/messages', carol,
      { content: 'x', thread_type: 'message', thread_ref: bobReply });
    assert.equal(nested.status, 400);

    // The general stream: the root with its summary, never a reply.
    const general = await call('GET', '/api/apps/ta-chan/messages', alice);
    assert.equal(general.status, 200);
    const ids = general.body.messages.map((m) => m.id);
    assert.ok(ids.includes(rootId));
    assert.ok(!ids.includes(bobReply) && !ids.includes(carolReply), 'replies never reach the general stream');
    const root = general.body.messages.find((m) => m.id === rootId);
    assert.equal(root.thread.reply_count, 2);
    assert.deepEqual(root.thread.participants.map((p) => p.username), ['ta_carol', 'ta_bob'],
      'most recent replier first');
    assert.equal(root.deleted, false);
    for (const m of general.body.messages.filter((row) => row.id !== rootId)) {
      assert.equal(m.thread, null, `row ${m.id} has no thread`);
    }

    // The thread itself, with its root.
    const thread = await call('GET', `/api/apps/ta-chan/messages?thread_type=message&thread_ref=${rootId}`, alice);
    assert.equal(thread.status, 200);
    assert.deepEqual(thread.body.messages.map((m) => m.id), [bobReply, carolReply]);
    assert.equal(thread.body.root.id, rootId);
    assert.equal(thread.body.root.thread.reply_count, 2);
    const missing = await call('GET', `/api/apps/ta-chan/messages?thread_type=message&thread_ref=${bobReply}`, alice);
    assert.equal(missing.status, 404, 'a reply is not a thread');
  });

  await t.test('a thread reply notifies the root author and earlier repliers; a mention wins', async () => {
    // bob's reply → alice (root author).
    const aliceThread = await notificationsFor(alice, 'thread_reply');
    assert.deepEqual(aliceThread.map((n) => n.chat_message_id), [bobReply],
      'carol @mentioned alice, so alice has a mention for that reply instead');
    assert.deepEqual((await notificationsFor(alice, 'mention')).map((n) => n.chat_message_id), [carolReply]);
    // carol's reply → bob (an earlier replier), never carol herself.
    assert.deepEqual((await notificationsFor(bob, 'thread_reply')).map((n) => n.chat_message_id), [carolReply]);
    assert.equal((await notificationsFor(carol, 'thread_reply')).length, 0);

    // The row routes to the thread.
    const notifications = require('../src/services/notifications');
    const [row] = await notifications.listForUser(pool, bob.id, { kinds: ['thread_reply'] });
    const serialized = notifications.serialize(row);
    assert.equal(serialized.threadType, 'message');
    assert.equal(serialized.threadRef, rootId);
    assert.equal(serialized.href, `#messages/app/ta-chan/thread/${rootId}`);

    // Push: the kind is in the closed registry, so the outbox trigger runs.
    const { rows: policy } = await pool.query(
      `SELECT category, default_enabled FROM mobile_push_kind_categories WHERE kind = 'thread_reply'`
    );
    assert.deepEqual(policy, [{ category: 'direct_interactions', default_enabled: true }]);

    // "Replies to you", switched off for this app, silences the kind.
    await pool.query(
      `INSERT INTO notification_preferences (user_id, app_id, category, enabled)
       VALUES ($1, $2, 'thread_replies', FALSE)`,
      [bob.id, chan.id]
    );
    await post(dave, chan, 'Purple!', { thread: { type: 'message', ref: rootId } });
    assert.equal((await notificationsFor(bob, 'thread_reply')).length, 1, 'bob muted replies here');
    assert.equal((await notificationsFor(alice, 'thread_reply')).length, 2, 'alice did not');
    assert.equal((await notificationsFor(carol, 'thread_reply')).length, 1, 'carol replied earlier');

    // Posting in the app clears the chat-actionable kinds, this one included.
    await post(carol, chan, 'Back in the main chat.');
    assert.equal((await notificationsFor(carol, 'thread_reply')).filter((n) => !n.read_at).length, 0);
  });

  await t.test('a viewer who blocked a replier gets their own thread summary', async () => {
    await pool.query('INSERT INTO user_blocks (blocker_id, blocked_user_id) VALUES ($1, $2)', [alice.id, dave.id]);
    frames.length = 0;
    await post(bob, chan, 'Blue still.', { thread: { type: 'message', ref: rootId } });
    const [summary] = roomFrames('thread_summary');
    assert.ok(summary.data.thread.participants.some((p) => p.id === dave.id), 'everybody else sees dave');
    const mine = summary.routing.threadByViewer[alice.id];
    assert.ok(mine, 'alice gets a variant');
    assert.ok(!mine.participants.some((p) => p.id === dave.id), 'without the person she blocked');
    assert.equal(mine.reply_count, summary.data.thread.reply_count - 1);
    await pool.query('DELETE FROM user_blocks WHERE blocker_id = $1', [alice.id]);
  });

  // ── Soft delete ──────────────────────────────────────────────────────

  await t.test('deleting your own message clears it and everything hanging off it, in one go', async () => {
    const target = (await post(bob, chan, 'Oops, wrong channel @ta_alice')).message.id;
    await pool.query(`INSERT INTO message_reactions (message_id, user_id, emoji) VALUES ($1, $2, '👍')`, [target, alice.id]);
    await pool.query('INSERT INTO message_bookmarks (user_id, message_id) VALUES ($1, $2)', [alice.id, target]);
    await pool.query(
      `INSERT INTO chat_message_attachments (id, app_id, user_id, kind, filename, content_type, size_bytes, data, message_id)
       VALUES ($1, $2, $3, 'text', 'a.txt', 'text/plain', 1, 'x', $4)`,
      ['f'.repeat(32), chan.id, bob.id, target]
    );
    await pool.query(
      `UPDATE chat_messages SET metadata = '{"attachments":[{"id":"ffff"}],"quote":{"refMsgId":1,"snippet":"s"}}' WHERE id = $1`,
      [target]
    );
    assert.equal((await notificationsFor(alice, 'mention')).filter((n) => n.chat_message_id === target).length, 1);

    const denied = await call('DELETE', `/api/apps/ta-chan/messages/${target}`, alice);
    assert.equal(denied.status, 403, 'author only');
    assert.deepEqual(denied.body, { error: 'not_author' });
    const sys = await system(chan, 'a system line');
    assert.equal((await call('DELETE', `/api/apps/ta-chan/messages/${sys}`, alice)).status, 403,
      'a system line is nobody\'s to take back');
    assert.equal((await call('DELETE', `/api/apps/ta-other/messages/${target}`, bob)).status, 404,
      'the message must be in the named app');

    frames.length = 0;
    const done = await call('DELETE', `/api/apps/ta-chan/messages/${target}`, bob);
    assert.equal(done.status, 200);
    assert.deepEqual(done.body, { ok: true, id: target, thread_type: null, thread_ref: null, deleted: true });
    const [frame] = roomFrames('chat_delete');
    assert.deepEqual(frame.data, { type: 'chat_delete', id: target, thread_type: null, thread_ref: null });
    assert.ok(frames.some((f) => f.kind === 'user' && f.routing.userId === alice.id
      && f.data.type === 'notifications_changed'), 'alice\'s bell re-syncs');

    const { rows: [row] } = await pool.query('SELECT * FROM chat_messages WHERE id = $1', [target]);
    assert.ok(row.deleted_at);
    assert.equal(row.content, '', 'the text is gone from the row, not merely hidden');
    assert.deepEqual(row.metadata, {});
    const count = async (sql) => Number((await pool.query(sql, [target])).rows[0].n);
    assert.equal(await count('SELECT COUNT(*) AS n FROM message_reactions WHERE message_id = $1'), 0);
    assert.equal(await count('SELECT COUNT(*) AS n FROM message_bookmarks WHERE message_id = $1'), 0);
    assert.equal(await count('SELECT COUNT(*) AS n FROM chat_message_attachments WHERE message_id = $1'), 0);
    assert.equal(await count('SELECT COUNT(*) AS n FROM notifications WHERE chat_message_id = $1'), 0);

    // Idempotent, and quiet the second time.
    frames.length = 0;
    const again = await call('DELETE', `/api/apps/ta-chan/messages/${target}`, bob);
    assert.equal(again.status, 200);
    assert.equal(roomFrames('chat_delete').length, 0);

    // Edit, react and save are refused on what is left.
    const edit = await ws.handleMessage(pool, client(bob, chan), { type: 'edit', messageId: target, content: 'resurrect' });
    assert.deepEqual(edit, { ok: false, code: 'message_deleted' });
    await ws.handleMessage(pool, client(alice, chan), { type: 'react', messageId: target, emoji: '🎉' });
    assert.equal(await count('SELECT COUNT(*) AS n FROM message_reactions WHERE message_id = $1'), 0);
    const save = await call('PUT', `/api/apps/ta-chan/messages/${target}/bookmark`, alice);
    assert.equal(save.status, 409);
    assert.deepEqual(save.body, { error: 'message_deleted' });
    assert.equal((await call('DELETE', `/api/apps/ta-chan/messages/${target}/bookmark`, alice)).status, 200,
      'unsaving stays harmless');

    // Read back as a placeholder.
    const general = await call('GET', `/api/apps/ta-chan/messages?around=${target}`, alice);
    const placeholder = general.body.messages.find((m) => m.id === target);
    assert.equal(placeholder.deleted, true);
    assert.equal(placeholder.content, '');
    assert.deepEqual(placeholder.metadata, {});
    assert.deepEqual(placeholder.reactions, []);
    assert.equal(placeholder.bookmarked, false);
    assert.equal(placeholder.username, 'ta_bob', 'the sender is kept');
    assert.equal(placeholder.edited_at, null);

    // A quote of it keeps who said it and loses what; a new quote of it is
    // dropped rather than sent.
    const { rows: [quoting] } = await pool.query(
      `INSERT INTO chat_messages (app_id, user_id, content, metadata)
       VALUES ($1, $2, 'replying', $3) RETURNING id`,
      [chan.id, carol.id, JSON.stringify({ quote: { source: 'message', refMsgId: target, author: 'ta_bob', snippet: 'Oops' } })]
    );
    const withQuote = (await call('GET', `/api/apps/ta-chan/messages?around=${quoting.id}`, alice))
      .body.messages.find((m) => m.id === quoting.id);
    assert.deepEqual(withQuote.metadata.quote,
      { source: 'message', refMsgId: target, author: 'ta_bob', snippet: '', deleted: true });
    const fresh = await post(carol, chan, 'quoting a ghost', { quote: { source: 'message', refMsgId: target } });
    assert.equal(fresh.message.metadata, undefined, 'sent as a plain message');
  });

  await t.test('deleting a thread reply over the socket updates the thread for the room', async () => {
    const reply = (await post(carol, chan, 'Never mind.', { thread: { type: 'message', ref: rootId } })).message.id;
    const before = (await appChat.threadSummaries(pool, chan.id, [rootId])).get(rootId).reply_count;
    frames.length = 0;
    const result = await ws.handleMessage(pool, client(carol, chan), { type: 'delete', id: reply });
    assert.equal(result.ok, true);
    const [frame] = roomFrames('chat_delete');
    assert.deepEqual(frame.data, { type: 'chat_delete', id: reply, thread_type: 'message', thread_ref: rootId });
    const [summary] = roomFrames('thread_summary');
    assert.equal(summary.data.thread.reply_count, before - 1, 'a deleted reply is not counted');
    // The deleted reply is still a placeholder inside the thread.
    const thread = await call('GET', `/api/apps/ta-chan/messages?thread_type=message&thread_ref=${rootId}`, alice);
    assert.equal(thread.body.messages.find((m) => m.id === reply).deleted, true);

    // A deleted ROOT keeps its thread.
    await ws.handleMessage(pool, client(alice, chan), { type: 'delete', id: rootId });
    const again = await call('GET', `/api/apps/ta-chan/messages?thread_type=message&thread_ref=${rootId}`, bob);
    assert.equal(again.status, 200);
    assert.equal(again.body.root.deleted, true);
    assert.ok(again.body.root.thread.reply_count > 0);
  });

  // ── Paging ───────────────────────────────────────────────────────────

  await t.test('before / after / around page the stream and say whether there is more', async () => {
    const pager = await makeApp('ta-pager', { owner: alice, name: 'Pager' });
    await member(pager, alice);
    const ids = [];
    for (let i = 1; i <= 9; i += 1) ids.push((await post(alice, pager, `m${i}`)).message.id);
    const threadRoot = ids[4];
    const reply = (await post(bob, pager, 'in the thread', { thread: { type: 'message', ref: threadRoot } })).message.id;
    const { rows: [issueRow] } = await pool.query(
      `INSERT INTO chat_messages (app_id, user_id, content, thread_type, thread_ref)
       VALUES ($1, $2, 'on an issue', 'issue', 42) RETURNING id`, [pager.id, alice.id]
    );
    const get = async (qs) => (await call('GET', `/api/apps/ta-pager/messages?${qs}`, alice)).body;
    const idsOf = (page) => page.messages.map((m) => m.id);

    const latest = await get('limit=3');
    assert.deepEqual(idsOf(latest), ids.slice(6));
    assert.equal(latest.has_more_before, true);
    assert.equal(latest.has_more_after, false);

    const older = await get(`limit=3&before=${ids[6]}`);
    assert.deepEqual(idsOf(older), ids.slice(3, 6));
    assert.equal(older.has_more_before, true);
    assert.equal(older.has_more_after, true);

    const oldest = await get(`limit=5&before=${ids[3]}`);
    assert.deepEqual(idsOf(oldest), ids.slice(0, 3));
    assert.equal(oldest.has_more_before, false);

    const catchUp = await get(`limit=3&after=${ids[2]}`);
    assert.deepEqual(idsOf(catchUp), ids.slice(3, 6), 'ascending, ids above the cursor');
    assert.equal(catchUp.has_more_before, true);
    assert.equal(catchUp.has_more_after, true);
    const caughtUp = await get(`limit=5&after=${ids[6]}`);
    assert.deepEqual(idsOf(caughtUp), ids.slice(7));
    assert.equal(caughtUp.has_more_after, false);

    const window = await get(`limit=5&around=${ids[4]}`);
    assert.deepEqual(idsOf(window), ids.slice(2, 7), 'two before, the target, two after');
    assert.deepEqual(window.focus, { message_id: ids[4], thread_ref: null });
    assert.equal(window.has_more_before, true);
    assert.equal(window.has_more_after, true);
    const edge = await get(`limit=5&around=${ids[0]}`);
    assert.equal(edge.messages[0].id, ids[0]);
    assert.equal(edge.has_more_before, false);

    // A permalink to a reply opens the general stream around its root.
    const toReply = await get(`limit=3&around=${reply}`);
    assert.ok(idsOf(toReply).includes(threadRoot));
    assert.ok(!idsOf(toReply).includes(reply));
    assert.deepEqual(toReply.focus, { message_id: reply, thread_ref: threadRoot });
    // ...and inside the thread, around itself.
    const inThread = await get(`thread_type=message&thread_ref=${threadRoot}&around=${reply}`);
    assert.deepEqual(inThread.focus, { message_id: reply, thread_ref: threadRoot });
    assert.equal(inThread.root.id, threadRoot);

    // A topic-thread message is not in the general stream.
    assert.equal((await call('GET', `/api/apps/ta-pager/messages?around=${issueRow.id}`, alice)).status, 404);
    assert.equal((await call('GET', `/api/apps/ta-pager/messages?around=${ids[0]}&thread_type=issue&thread_ref=42`, alice)).status, 404);
    // A blocked author's message is not visible to around.
    await pool.query('INSERT INTO user_blocks (blocker_id, blocked_user_id) VALUES ($1, $2)', [carol.id, alice.id]);
    assert.equal((await call('GET', `/api/apps/ta-pager/messages?around=${ids[1]}`, carol)).status, 404);
    await pool.query('DELETE FROM user_blocks WHERE blocker_id = $1', [carol.id]);

    for (const qs of [`before=${ids[1]}&after=${ids[0]}`, 'before=abc', 'around=0', 'after=1e3']) {
      assert.equal((await call('GET', `/api/apps/ta-pager/messages?${qs}`, alice)).status, 400, qs);
    }
  });

  // ── The read cursor ──────────────────────────────────────────────────

  await t.test('the read cursor: lazily zero, forward-only read, back-only unread', async () => {
    const reads = await makeApp('ta-reads', { owner: alice, name: 'Reads' });
    await member(reads, alice);
    await member(reads, bob);
    const early = (await post(bob, reads, 'before the cursor existed')).message.id;
    const list = async (who) => (await call('GET', '/api/messages/app-discussions', who)).body.discussions;
    const row = async (who) => (await list(who)).find((d) => d.slug === 'ta-reads');

    assert.equal((await row(alice)).unreadCount, 0, 'a first look starts at zero');
    const { rows: [cursor] } = await pool.query(
      'SELECT last_read_message_id FROM app_chat_reads WHERE app_id = $1 AND user_id = $2', [reads.id, alice.id]
    );
    assert.equal(cursor.last_read_message_id, early, 'seeded at the newest general-stream message');

    const m1 = (await post(bob, reads, 'one')).message.id;
    const m2 = (await post(bob, reads, 'two')).message.id;
    const m3 = (await post(bob, reads, 'three')).message.id;
    await system(reads, 'a system line is not unread');
    await post(bob, reads, 'a thread reply is not in the general stream', { thread: { type: 'message', ref: m1 } });
    const gone = (await post(bob, reads, 'deleted')).message.id;
    await ws.handleMessage(pool, client(bob, reads), { type: 'delete', id: gone });
    assert.equal((await row(alice)).unreadCount, 3);
    assert.equal(await appChat.unreadCount(pool, reads.id, alice.id), 3, 'the service and the list agree');

    const read = await call('POST', '/api/apps/ta-reads/messages/read', alice, { message_id: m2 });
    assert.equal(read.status, 200);
    assert.deepEqual(read.body, { unread_count: 1 });
    const back = await call('POST', '/api/apps/ta-reads/messages/read', alice, { message_id: m1 });
    assert.deepEqual(back.body, { unread_count: 1 }, 'read never moves back');

    const unread = await call('POST', '/api/apps/ta-reads/messages/unread', alice, { message_id: m1 });
    assert.deepEqual(unread.body, { unread_count: 3 }, 'm1 and everything after it');
    const forward = await call('POST', '/api/apps/ta-reads/messages/unread', alice, { message_id: m3 });
    assert.deepEqual(forward.body, { unread_count: 3 }, 'unread never moves forward');

    // Blocked authors are not unread for the blocker.
    await pool.query('INSERT INTO user_blocks (blocker_id, blocked_user_id) VALUES ($1, $2)', [alice.id, bob.id]);
    assert.equal(await appChat.unreadCount(pool, reads.id, alice.id), 0);
    await pool.query('DELETE FROM user_blocks WHERE blocker_id = $1', [alice.id]);

    // Only this app's general stream can move it.
    const replyId = (await pool.query(
      `SELECT id FROM chat_messages WHERE app_id = $1 AND thread_type = 'message' LIMIT 1`, [reads.id]
    )).rows[0].id;
    assert.equal((await call('POST', '/api/apps/ta-reads/messages/read', alice, { message_id: replyId })).status, 404);
    assert.equal((await call('POST', '/api/apps/ta-other/messages/read', alice, { message_id: m3 })).status, 404);
    assert.equal((await call('POST', '/api/apps/ta-reads/messages/read', alice, { message_id: 'x' })).status, 400);
    assert.equal((await call('POST', '/api/apps/ta-reads/messages/read', alice, {})).status, 400);

    // Posting in the general stream is reading it.
    await post(alice, reads, 'caught up');
    assert.equal((await row(alice)).unreadCount, 0);
  });

  // ── The Messages list: yours and more (#2967) ───────────────────────

  await t.test('yours is Home.isYours, more is activity, and nothing the viewer cannot open', async () => {
    const vic = await user('ta_vic');
    const owner = await user('ta_owner');
    const mk = (slug, opts = {}) => makeApp(slug, { owner, name: slug, ...opts });
    const memberApp = await mk('ta-s-member');
    const hiddenApp = await mk('ta-s-hidden');
    const favApp = await mk('ta-s-fav');
    const votedApp = await mk('ta-s-voted');
    const decidedApp = await mk('ta-s-decided');
    const proposedApp = await mk('ta-s-proposed');
    const filedApp = await mk('ta-s-filed');
    const postedApp = await mk('ta-s-posted');
    const reactedApp = await mk('ta-s-reacted');
    const untouched = await mk('ta-s-untouched');
    const privatePosted = await mk('ta-s-private-posted', { view: 'private', collab: 'private' });
    const privateFav = await mk('ta-s-private-fav', { view: 'private', collab: 'private' });
    const privateMember = await mk('ta-s-private-member', { view: 'private', collab: 'private' });
    const selfHosted = await mk('ta-s-self', { selfHosted: true });
    const headless = await mk('ta-s-headless');

    await member(memberApp, vic);
    await member(hiddenApp, vic);
    await member(privateMember, vic);
    await member(selfHosted, vic);
    await pool.query(
      `INSERT INTO app_favorites (app_id, user_id, hidden) VALUES ($1, $3, TRUE), ($2, $3, FALSE), ($4, $3, FALSE)`,
      [hiddenApp.id, favApp.id, vic.id, privateFav.id]
    );
    const session = async (app, who, extra = '') => (await pool.query(
      `INSERT INTO chat_sessions (app_id, user_id, status${extra ? ', is_headless, promoted_at' : ''})
       VALUES ($1, $2, 'promoted'${extra ? ', TRUE, NOW()' : ''}) RETURNING id`, [app.id, who.id]
    )).rows[0].id;
    await pool.query(`INSERT INTO pr_votes (session_id, user_id, vote) VALUES ($1, $2, 'yes')`,
      [await session(votedApp, owner), vic.id]);
    const { rows: [issue] } = await pool.query(
      `INSERT INTO issues (app_id, title, created_by, kind) VALUES ($1, 'rename', $2, 'rename') RETURNING id`,
      [decidedApp.id, owner.id]
    );
    await pool.query(`INSERT INTO issue_votes (issue_id, user_id, vote) VALUES ($1, $2, 'yes')`, [issue.id, vic.id]);
    await session(proposedApp, vic);
    await session(headless, vic, 'headless');
    await pool.query(`INSERT INTO issues (app_id, title, created_by) VALUES ($1, 'please add dark mode', $2)`,
      [filedApp.id, vic.id]);
    await post(vic, postedApp, 'hello from outside');
    // Written straight to the table: vic posted while the app was public, and
    // it has gone private since (the write gate would refuse a post now).
    await pool.query(
      `INSERT INTO chat_messages (app_id, user_id, content) VALUES ($1, $2, 'I was here before it went private')`,
      [privatePosted.id, vic.id]
    );
    const theirs = (await post(owner, reactedApp, 'react to me')).message.id;
    await pool.query(`INSERT INTO message_reactions (message_id, user_id, emoji) VALUES ($1, $2, '👍')`, [theirs, vic.id]);
    // A later message in the member app, so the order inside yours is by
    // latest activity.
    await post(owner, memberApp, 'newest in a member app');

    const { status, body } = await call('GET', '/api/messages/app-discussions', vic);
    assert.equal(status, 200);
    const bySlug = Object.fromEntries(body.discussions.map((d) => [d.slug, d]));
    const sectionOf = (app) => bySlug[app.slug]?.section;
    assert.equal(sectionOf(memberApp), 'yours');
    assert.equal(sectionOf(favApp), 'yours', 'a favorited non-member app is yours');
    assert.equal(sectionOf(privateMember), 'yours', 'membership opens a private app');
    assert.equal(sectionOf(hiddenApp), 'more', 'a member app hidden from Your apps is more');
    for (const app of [votedApp, decidedApp, proposedApp, filedApp, postedApp, reactedApp]) {
      assert.equal(sectionOf(app), 'more', app.slug);
    }
    for (const app of [untouched, privatePosted, privateFav, selfHosted, headless]) {
      assert.equal(bySlug[app.slug], undefined, `${app.slug} is not listed`);
    }
    const sections = body.discussions.map((d) => d.section);
    assert.deepEqual(sections, [...sections].sort((a, b) => (a === b ? 0 : a === 'yours' ? -1 : 1)),
      'yours first, then more');
    assert.equal(body.discussions[0].slug, memberApp.slug, 'latest activity leads yours');
    const handles = body.discussions.map((d) => d.channel);
    assert.equal(new Set(handles).size, handles.length, 'handles are unique across both sections');
    for (const d of body.discussions) assert.equal(typeof d.unreadCount, 'number');

    // The platform admin sees the self-hosted app they are a member of.
    const root = await user('ta_root', { isAdmin: true });
    await member(selfHosted, root);
    const adminList = (await call('GET', '/api/messages/app-discussions', root)).body.discussions;
    assert.ok(adminList.some((d) => d.slug === selfHosted.slug));
  });

  await t.test('a deleted message cannot be reported', async () => {
    const { contentReportRoutes } = require('../src/routes/content-reports');
    const live = (await post(bob, chan, 'still here')).message.id;
    const { rows: [gone] } = await pool.query(
      `SELECT id FROM chat_messages WHERE app_id = $1 AND deleted_at IS NOT NULL AND user_id = $2 LIMIT 1`,
      [chan.id, bob.id]
    );
    const reportApp = express();
    reportApp.use(express.json());
    reportApp.use((req, _res, next) => { req.user = users[carol.id]; next(); });
    reportApp.use(contentReportRoutes({}));
    const reportServer = await new Promise((resolve) => {
      const listening = reportApp.listen(0, '127.0.0.1', () => resolve(listening));
    });
    const report = (id) => fetch(
      `http://127.0.0.1:${reportServer.address().port}/api/apps/ta-chan/messages/${id}/report`,
      { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ reason: 'spam' }) }
    );
    try {
      assert.equal((await report(live)).status, 202, 'a live message can be');
      assert.equal((await report(gone.id)).status, 404);
    } finally {
      await new Promise((resolve) => reportServer.close(resolve));
    }
  });
});
