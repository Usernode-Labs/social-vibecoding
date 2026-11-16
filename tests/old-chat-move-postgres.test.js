'use strict';

// 15 Nov 2026: agent chats and dev chats are retired. What was said in each
// is copied, once, into its owner's chat with Homeroom bot as one finished
// thread (src/services/old-chat-move.js). Against the real schema, this pins:
//
//   1. WHAT MOVES. A person's messages as theirs and the agent's replies as
//      the bot's, in order and at the times they were said; never a system
//      row or an empty one. A reply longer than a chat message holds is
//      continued in the next message.
//   2. WHICH CONVERSATIONS. An agent chat (with the messages of the changes
//      under it), and a dev chat of a classic change. Never an unattended
//      run, an imported pull request, a CLI hand-off, a request's planning
//      record, a change under an agent chat on its own, or one a synthetic
//      account owns.
//   3. THE THREAD ARRIVES FINISHED AND READ: done as of its last message,
//      nothing unread, no notification, listed in History by the old title,
//      and the Messages list's latest message is not one of the copies.
//   4. TWICE OVER IS THE SAME RESULT, and a message an older instance wrote
//      afterwards is added under the same thread.
//   5. GET /api/ai/where answers an old address with its thread, and never
//      with somebody else's.
//
// Skips with no PostgreSQL reachable; fails when TEST_DATABASE_URL is set
// and it is not.

const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');

const DSN = process.env.TEST_DATABASE_URL || process.env.DATABASE_URL || 'postgres://postgres:postgres@localhost:5432/postgres';

const stub = (file, exports) => {
  const id = require.resolve(file);
  require.cache[id] = { id, filename: id, loaded: true, exports };
};
stub('../src/services/ws', {
  pushConversationEvent(memberIds) { return memberIds.length; },
  pushToUser() { return 1; },
  pushNotificationToUser() { return 1; },
});
stub('../src/services/mobile-push', { scheduleBadgeSync() { return false; } });
stub('../src/services/bot-work-changed', { noteWorkChanged() {} });
stub('../src/workflow/platform.ts', {
  async dmWritten() {},
  async dmMailOwed() {},
  async botRefresh() {},
});

const conversations = require('../src/services/conversations');
const privateThreads = require('../src/services/private-threads');
const aiWork = require('../src/services/ai-work');
const aiHistory = require('../src/services/ai-history');
const oldChats = require('../src/services/old-chat-move');

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
  const name = `old_chat_move_${crypto.randomBytes(6).toString('hex')}`;
  await admin.query(`CREATE DATABASE ${name}`);
  const url = new URL(DSN);
  url.pathname = `/${name}`;
  const pool = new pg.Pool({ connectionString: String(url), max: 6 });
  pool.on('error', () => {});
  t.after(async () => {
    await pool.end().catch(() => {});
    await admin.query(`DROP DATABASE IF EXISTS ${name}`).catch(() => {});
    await admin.end().catch(() => {});
  });
  require('../src/db/schema-source').ensureSchema();
  await pool.query(fs.readFileSync(path.join(__dirname, '../src/db/schema.sql'), 'utf8'));
  await pool.query(`ALTER TABLE users ALTER COLUMN contact_policy SET DEFAULT 'anyone'`).catch(() => {});
  return pool;
}

test('agent chats and dev chats move into finished Homeroom bot threads', { timeout: 170000 }, async (t) => {
  const pool = await openDatabase(t);
  if (!pool) return;
  const person = async (username, synthetic = false) => (await pool.query(
    `INSERT INTO users (username, password, is_synthetic, has_platform_access) VALUES ($1, 'x', $2, TRUE)
     RETURNING id, username`, [username, synthetic],
  )).rows[0];
  const bot = await person('homeroom_bot', true);
  const ada = await person('ada');
  const bo = await person('bo');
  const { rows: [app] } = await pool.query(
    `INSERT INTO apps (name, slug, status, created_by) VALUES ('Plant Pal', 'plant-pal', 'running', $1) RETURNING id, slug, name`,
    [ada.id],
  );
  const agentChat = async (user, title) => (await pool.query(
    `INSERT INTO agent_sessions (user_id, title, focus_app_id) VALUES ($1, $2, $3) RETURNING id`,
    [user.id, title, app.id])).rows[0].id;
  const change = async (user, title, extra = {}) => (await pool.query(
    `INSERT INTO chat_sessions (user_id, app_id, session_title, status, is_headless, source, agent_session_id)
     VALUES ($1, $2, $3, 'active', $4, $5, $6) RETURNING id`,
    [user.id, app.id, title, extra.headless === true, extra.source || null, extra.agent || null])).rows[0].id;
  let minute = 0;
  const say = async ({ agent = null, session = null }, role, content) => {
    minute += 1;
    return (await pool.query(
      `INSERT INTO chat_session_messages (session_id, agent_session_id, role, content, created_at)
       VALUES ($1, $2, $3, $4, TIMESTAMPTZ '2026-09-01 10:00:00+00' + make_interval(mins => $5)) RETURNING id, created_at`,
      [session, agent, role, content, minute])).rows[0];
  };

  // An agent chat: a question, a reply, a system line, a change under it
  // with its own slice of the conversation, an empty row, and a long reply.
  const dark = await agentChat(ada, '  Looks: a dark\n mode  ');
  const asked = await say({ agent: dark }, 'user', 'Can the app have a dark mode?');
  await say({ agent: dark }, 'assistant', 'Yes. I will start a change for it.');
  await say({ agent: dark }, 'system', 'Started change #1');
  const under = await change(ada, 'Dark mode', { agent: dark });
  await say({ agent: dark, session: under }, 'user', 'Make the header navy.');
  await say({ agent: dark, session: under }, 'system', 'Building…');
  await say({ agent: dark, session: under }, 'assistant', '   ');
  const long = `${'a'.repeat(oldChats.MAX_CONTENT)}${'b'.repeat(10)}`;
  const last = await say({ agent: dark, session: under }, 'assistant', long);

  // A dev chat of a classic change, opened by the agent's line.
  const classic = await change(ada, 'Fix the watering reminder');
  await say({ session: classic }, 'assistant', 'What should the reminder say?');
  await say({ session: classic }, 'user', 'Water me.');

  // None of these is a conversation to move.
  const silent = await agentChat(ada, 'Nothing said');
  await say({ agent: silent }, 'system', 'Opened');
  for (const extra of [{ headless: true }, { source: 'imported' }, { source: 'cli_handoff' }, { source: 'request_spec' }]) {
    const id = await change(ada, 'Not a chat', extra);
    await say({ session: id }, 'user', 'Not to be moved.');
  }
  const botBuilt = await change(bot, 'Bot build');
  await say({ session: botBuilt }, 'user', 'Build issue #4');
  // Bo has one agent chat of his own.
  const bos = await agentChat(bo, 'Bo asks');
  await say({ agent: bos }, 'user', 'Hello from Bo.');

  const chatOf = async (user) => (await conversations.ensureAdmittedDirect(pool, bot.id, user.id)).conversationId;
  const adaChat = await chatOf(ada);
  // What was last actually said in Ada's chat with the bot.
  const { rows: [real] } = await pool.query(
    `INSERT INTO conversation_messages (conversation_id, sender_id, content) VALUES ($1, $2, 'Said today.') RETURNING id`,
    [adaChat, ada.id]);
  await pool.query(
    `INSERT INTO private_threads (user_id, conversation_id, root_message_id, kind, state, last_read_message_id)
     VALUES ($1, $2, $3, 'idea', 'open', $3)`, [ada.id, adaChat, real.id]);
  const bells = async () => (await pool.query('SELECT COUNT(*)::int AS n FROM notifications')).rows[0].n;
  const bellsBefore = await bells();

  const done = await oldChats.moveAll(pool, { batch: 2 });
  assert.deepEqual(done, { chats: 3, copied: 8 });

  const thread = async (source, id) => {
    const { rows: [moved] } = await pool.query(
      `SELECT root_message_id, through_id, user_id FROM moved_chats WHERE source = $1 AND source_id = $2`, [source, id]);
    if (!moved) return null;
    const { rows } = await pool.query(
      `SELECT m.id, m.sender_id, m.content, m.created_at, m.thread_root_id, m.metadata
         FROM conversation_messages m WHERE m.id = $1 OR m.thread_root_id = $1 ORDER BY m.id`, [moved.root_message_id]);
    const { rows: [row] } = await pool.query(
      `SELECT kind, state, done_from, done_at, app_id, last_read_message_id FROM private_threads WHERE root_message_id = $1`,
      [moved.root_message_id]);
    return { moved, rows, row };
  };

  // 1. The agent chat: what was said, in order, by whom, when.
  const darkThread = await thread('agent', dark);
  assert.deepEqual(darkThread.rows.map((m) => [Number(m.sender_id), m.content.length > 40 ? m.content.length : m.content]), [
    [ada.id, 'Can the app have a dark mode?'],
    [bot.id, 'Yes. I will start a change for it.'],
    [ada.id, 'Make the header navy.'],
    [bot.id, oldChats.MAX_CONTENT],
    [bot.id, 'bbbbbbbbbb'],
  ]);
  const root = darkThread.rows[0];
  assert.equal(root.thread_root_id, null);
  assert.ok(darkThread.rows.slice(1).every((m) => m.thread_root_id === root.id), 'everything after the first message is under it');
  assert.equal(String(root.created_at), String(asked.created_at), 'a message keeps the time it was said');
  assert.deepEqual(root.metadata, { movedChat: { source: 'agent', id: dark, title: 'Looks: a dark mode' } });
  assert.deepEqual(darkThread.rows[1].metadata, { movedChat: { source: 'agent', id: dark } });
  assert.equal(darkThread.moved.through_id, last.id);
  // 3. Finished, read, about its project.
  assert.deepEqual([darkThread.row.kind, darkThread.row.state, darkThread.row.done_from, darkThread.row.app_id],
    ['idea', 'done', 'open', app.id]);
  assert.equal(String(darkThread.row.done_at), String(last.created_at), 'done as of its last message');
  assert.equal(darkThread.row.last_read_message_id, darkThread.rows[darkThread.rows.length - 1].id);

  // 2. The dev chat, which the agent opened: a note of the bot's.
  const classicThread = await thread('session', classic);
  assert.deepEqual(classicThread.rows.map((m) => [Number(m.sender_id), m.content]), [
    [bot.id, 'What should the reminder say?'], [ada.id, 'Water me.'],
  ]);
  assert.equal(classicThread.row.kind, 'note');
  assert.equal(classicThread.rows[0].metadata.movedChat.title, 'Fix the watering reminder');
  // Nothing else moved: not the silent chat, the runs, the imports, the bot's
  // own build, or the change under the agent chat a second time.
  assert.deepEqual((await pool.query(`SELECT source, source_id FROM moved_chats ORDER BY source, source_id`)).rows, [
    { source: 'agent', source_id: dark }, { source: 'agent', source_id: bos }, { source: 'session', source_id: classic },
  ]);
  assert.equal((await pool.query(`SELECT COUNT(*)::int AS n FROM conversation_messages WHERE metadata ? 'movedChat'`)).rows[0].n, 8);

  // 3. Nothing unread, nothing rang, and the chat's row did not move.
  assert.equal(await privateThreads.unreadInChat(pool, { userId: ada.id, conversationId: adaChat }), 0);
  assert.equal((await privateThreads.unreadFor(pool, ada.id, [root.id])).get(root.id) || 0, 0);
  assert.equal(await bells(), bellsBefore);
  const listed = await conversations.getConversation(pool, { id: ada.id, username: 'ada' }, adaChat);
  assert.equal(listed.latestMessage.id, real.id, 'the list\'s latest message is what was last actually said');
  // The page's lists leave a thread that finished months ago to History,
  // which names it as the conversation was named.
  assert.equal((await aiWork.privateFor(pool, { user: ada })).some((p) => p.rootId === root.id), false);
  const history = await aiHistory.historyFor(pool, { user: ada, kind: 'solo' });
  const past = history.rows.find((r) => r.rootId === root.id);
  assert.equal(past.title, 'Looks: a dark mode');
  assert.equal(past.outcome, 'done');
  assert.equal(history.rows.find((r) => r.rootId === classicThread.rows[0].id).title, 'Fix the watering reminder');

  // 5. An old address finds its thread, and only its owner's.
  assert.equal((await privateThreads.whereFor(pool, { user: ada, agentChat: dark, deps: { bot } })).rootId, root.id);
  assert.equal((await privateThreads.whereFor(pool, { user: ada, devChat: classic, deps: { bot } })).rootId, classicThread.rows[0].id);
  assert.equal((await privateThreads.whereFor(pool, { user: bo, agentChat: dark, deps: { bot } })).rootId, null);
  assert.equal((await privateThreads.whereFor(pool, { user: ada, agentChat: silent, deps: { bot } })).rootId, null);
  assert.equal((await privateThreads.whereFor(pool, { user: ada, devChat: dark, deps: { bot } })).rootId, null, 'an agent chat\'s id is not a dev chat\'s');

  // 4. Twice over: nothing more.
  const before = (await pool.query(`SELECT id, content, thread_root_id FROM conversation_messages ORDER BY id`)).rows;
  assert.deepEqual(await oldChats.moveAll(pool, { batch: 2 }), { chats: 0, copied: 0 });
  assert.deepEqual((await pool.query(`SELECT id, content, thread_root_id FROM conversation_messages ORDER BY id`)).rows, before);
  // A message an older instance writes in the agent chat afterwards is added
  // under the same thread, read, and the thread's end moves with it.
  const late = await say({ agent: dark }, 'assistant', 'Written by an older instance.');
  assert.deepEqual(await oldChats.moveAll(pool), { chats: 1, copied: 1 });
  const again = await thread('agent', dark);
  assert.equal(again.moved.root_message_id, root.id);
  assert.equal(again.rows[again.rows.length - 1].content, 'Written by an older instance.');
  assert.equal(again.rows[again.rows.length - 1].thread_root_id, root.id);
  assert.equal(again.row.last_read_message_id, again.rows[again.rows.length - 1].id);
  assert.equal(String(again.row.done_at), String(late.created_at));
  assert.equal(again.moved.through_id, late.id);

  // Writing in a moved thread reopens it, like any done thread.
  assert.equal((await privateThreads.reopen(pool, { user: ada, rootId: root.id })).state, 'open');
});

test('the move is pure where it can be, and runs at boot', () => {
  assert.deepEqual(oldChats.pieces('  hello  '), ['hello']);
  assert.deepEqual(oldChats.pieces(''), []);
  assert.deepEqual(oldChats.pieces('abcdefg', 3), ['abc', 'def', 'g']);
  assert.equal(oldChats.titleOf('  A\n title  '), 'A title');
  assert.equal(oldChats.titleOf('   '), null);
  assert.equal(oldChats.titleOf('x'.repeat(500)).length, 200);

  const read = (file) => fs.readFileSync(path.join(__dirname, '..', file), 'utf8');
  const migrate = read('src/db/migrate.js');
  assert.match(migrate, /async function moveOldChatsToThreads\(pool\) \{\n\s+try \{\n\s+const done = await require\('\.\.\/services\/old-chat-move'\)\.moveAll\(pool\);/);
  assert.match(migrate, /await moveMainChatToThreads\(pool\);\n\s+await moveOldChatsToThreads\(pool\);/);
  // The table it records in is a tracked migration, and private on staging.
  const sql = read('src/db/migrations/moved-chats.sql');
  assert.match(sql, /CREATE TABLE IF NOT EXISTS moved_chats \(/);
  assert.match(sql, /COMMENT ON TABLE moved_chats IS 'staging:private';/);
  // The route reads both old kinds of address.
  const route = read('src/routes/ai-work.js');
  assert.match(route, /const agentChat = idOf\('agentChat'\);\n\s+const devChat = idOf\('devChat'\);/);
});
