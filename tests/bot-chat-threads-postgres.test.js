'use strict';

// 14 Nov 2026: Main Chat is removed. Every conversation with Homeroom bot is
// a thread. Against the real schema, this pins:
//
//   1. THE INVARIANT. In a person's chat with the bot, every message that is
//      not a reply is the first message of a thread the Homeroom bot page
//      lists (a private_threads row). Each kind of writer is driven: the
//      "+", a hello, a first version from its opening line to live and a
//      failure, a reply to what a person wrote, a message named under a
//      request's card from before, and one with no thread named at all.
//   2. A person's message with no thread named becomes a thread, exactly as
//      New thread opens one; one that quotes a message joins its thread; a
//      retry opens no second thread; and a message no thread could be
//      opened for is its own thread's first.
//   3. The weekly account notices and the invite nudge are bell rows, once
//      each, and no chat message.
//   4. The one-time move: Main Chat under "Earlier chat", in order, twice
//      over with the same result, hidden news and thread roots left alone,
//      nothing newly unread and no notification touched.
//   5. The chat's unread count is the sum over its threads by their own
//      cursors, equal to the page's per-thread marks, and opening a thread
//      clears its share.
//   6. GET /api/ai/where: the thread a message is in, a project's
//      first-version thread, Earlier chat, and never anybody else's.
//
// Skips with no PostgreSQL reachable; fails when TEST_DATABASE_URL is set
// and it is not.

const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');

const DSN = process.env.TEST_DATABASE_URL || process.env.DATABASE_URL || 'postgres://postgres:postgres@localhost:5432/postgres';

// Realtime, push and the workflow runtime are process-wide: nothing here
// needs them to run, only not to be reached.
const stub = (file, exports) => {
  const id = require.resolve(file);
  require.cache[id] = { id, filename: id, loaded: true, exports };
};
const pushed = [];
stub('../src/services/ws', {
  pushConversationEvent(memberIds, payload) { pushed.push({ memberIds: [...memberIds], payload }); return memberIds.length; },
  pushToUser() { return 1; },
  pushNotificationToUser(userId, payload) { pushed.push({ userId, payload }); return 1; },
});
stub('../src/services/mobile-push', { scheduleBadgeSync() { return false; } });
stub('../src/services/bot-work-changed', { noteWorkChanged() {} });
const heard = [];
stub('../src/workflow/platform.ts', {
  async dmWritten(_db, args) { heard.push(args); },
  async dmMailOwed() {},
  async botRefresh() {},
});

const conversations = require('../src/services/conversations');
const dm = require('../src/services/homeroom-bot-dm');
const privateThreads = require('../src/services/private-threads');
const aiWork = require('../src/services/ai-work');
const earlierChat = require('../src/services/earlier-chat');
const notices = require('../src/services/homeroom-bot-notices');
const inviteNudge = require('../src/services/invite-nudge');

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
  const name = `bot_chat_threads_${crypto.randomBytes(6).toString('hex')}`;
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

test('every conversation with Homeroom bot is a thread', { timeout: 170000 }, async (t) => {
  const pool = await openDatabase(t);
  if (!pool) return;
  const person = async (username, synthetic = false) => (await pool.query(
    `INSERT INTO users (username, password, is_synthetic, has_platform_access) VALUES ($1, 'x', $2, TRUE)
     RETURNING id, username`, [username, synthetic],
  )).rows[0];
  const bot = await person('homeroom_bot', true);
  const ada = await person('ada');
  const bo = await person('bo');
  const cy = await person('cy');
  const { rows: [app] } = await pool.query(
    `INSERT INTO apps (name, slug, status, created_by) VALUES ('Plant Pal', 'plant-pal', 'running', $1) RETURNING id, slug, name`,
    [ada.id],
  );
  const chatOf = async (user) => (await conversations.ensureAdmittedDirect(pool, bot.id, user.id)).conversationId;
  const adaChat = await chatOf(ada);
  const bodyOf = async (id) => (await pool.query(
    `SELECT id, thread_root_id, sender_id, content, metadata FROM conversation_messages WHERE id = $1`, [id])).rows[0];
  // The invariant, read as a list: first messages of this chat with no row.
  const unlisted = async (user, conversationId) => (await pool.query(
    `SELECT m.id, m.content FROM conversation_messages m
      WHERE m.conversation_id = $1 AND m.thread_root_id IS NULL
        AND NOT EXISTS (SELECT 1 FROM private_threads p WHERE p.root_message_id = m.id AND p.user_id = $2)
      ORDER BY m.id`, [conversationId, user.id])).rows;
  const threadOf = async (rootId) => (await pool.query(
    'SELECT kind, state, app_id, last_read_message_id FROM private_threads WHERE root_message_id = $1', [rootId])).rows[0];
  const unreadOf = async (user, conversationId) => (await conversations.getConversation(pool, user, conversationId)).unreadCount;
  // A person's message, as the route sends one: given a thread first when it
  // names none, then heard in its own transaction.
  const post = async (user, conversationId, input) => {
    const body = { ...input };
    if (body.thread_root_id == null) {
      const rootId = await privateThreads.threadForPost(pool, {
        user, conversationId, replyToId: body.reply_to_id, idempotencyKey: body.idempotency_key,
      });
      if (rootId) body.thread_root_id = rootId;
    }
    return conversations.sendMessage(pool, user, conversationId, body, {
      afterInsert: (db, sent) => dm.heardInDm(db, {
        user, conversationId, messageId: sent.messageId, membership: sent.membership, memberIds: sent.memberIds,
      }),
    });
  };

  await t.test('1. everything the bot says is in a thread the page lists', async () => {
    // A hello is the first message of a thread of its own, and its prompts
    // are answered inside it.
    const hello = await dm.sendDm(pool, {
      bot, userId: ada.id, content: dm.TOUR_HELLO, idempotencyKey: `hrbot-tour-${ada.id}`, thread: { kind: 'hello' },
      metadata: { kind: 'hello_tour', hello: dm.TOUR_HELLO, actions: dm.promptActions(dm.TOUR_PROMPTS), status: 'open' },
      hello: { kind: 'tour' },
    });
    assert.equal(hello.hello, true);
    assert.equal(hello.threadRootId, null, 'a thread\'s own first message');
    assert.equal(hello.rootId, hello.messageId);
    assert.deepEqual(await threadOf(hello.messageId), { kind: 'hello', state: 'open', app_id: null, last_read_message_id: null });
    const tapped = await post(ada, adaChat, { content: dm.TOUR_PROMPTS[0], reply_to_id: hello.messageId });
    assert.equal(tapped.message.threadRootId, hello.messageId, 'a prompt tapped under the hello answers in its thread');
    const answered = await dm.sendDm(pool, {
      bot, userId: ada.id, content: 'Anything about your projects.', replyToId: tapped.message.id, moment: 'reply',
      idempotencyKey: `hrbot-mayor-${tapped.message.id}`,
    });
    assert.equal(answered.threadRootId, hello.messageId);

    // The "+": its line and its row, written together, and read (they opened it).
    const plus = await privateThreads.startThread(pool, { user: ada, ungated: true });
    assert.equal(plus.ok, true);
    assert.deepEqual(await threadOf(plus.rootId), { kind: 'ask', state: 'open', app_id: null, last_read_message_id: plus.rootId });

    // A first version: its opening line opens the thread, and every later
    // post about it lands there, whichever way its sender named its place.
    const started = await dm.sendDm(pool, {
      bot, userId: ada.id, idempotencyKey: `hrbot-create-${app.id}`,
      content: dm.firstVersionStartedText({ name: app.name }),
      metadata: { kind: 'first_version_started', appSlug: app.slug, appName: app.name },
    });
    assert.equal(started.threadRootId, null);
    assert.deepEqual(await threadOf(started.messageId), {
      kind: 'first_version', state: 'open', app_id: app.id, last_read_message_id: null,
    });
    const about = { appSlug: app.slug, appName: app.name, issueNumber: 1, firstVersion: true };
    const plan = await dm.sendDm(pool, {
      bot, userId: ada.id, content: 'The plan for Plant Pal', idempotencyKey: 'hrbot-plan-0001',
      metadata: { kind: 'plan', ...about },
    });
    const card = await dm.sendDm(pool, {
      bot, userId: ada.id, content: 'Building it.', idempotencyKey: 'hrbot-activity-1', threadRootId: false,
      metadata: { kind: 'activity', ...about },
    });
    await pool.query(
      `INSERT INTO homeroom_bot_dm_messages (message_id, user_id, conversation_id, app_id, issue_number, kind)
       VALUES ($1, $2, $3, $4, 1, 'activity')`, [card.messageId, ada.id, adaChat, app.id]);
    // Named under the request's card, as a sender from before names it.
    const ready = await dm.sendDm(pool, {
      bot, userId: ada.id, content: 'Your first version is ready to try.', idempotencyKey: 'hrbot-ready-0001',
      threadRootId: card.messageId, metadata: { kind: 'proposal', ...about },
    });
    const live = await dm.sendDm(pool, {
      bot, userId: ada.id, content: 'It\'s live.', idempotencyKey: 'hrbot-merged-1',
      metadata: { kind: 'merged', ...about, live: true },
    });
    const failed = await dm.sendDm(pool, {
      bot, userId: ada.id, content: 'I couldn\'t start building it.', idempotencyKey: `hrbot-filefail-${app.id}`,
      metadata: { kind: 'first_version_failed', appSlug: app.slug, appName: app.name, firstVersion: true },
    });
    const flaky = await dm.sendDm(pool, {
      bot, userId: ada.id, content: 'Its checks are failing on something that isn\'t the change.', moment: null,
      idempotencyKey: 'hrbot-checks-green-1', threadRootId: false,
      metadata: { kind: 'step', step: 'checks_green', ...about },
    });
    for (const sent of [plan, card, ready, live, failed, flaky]) {
      assert.equal(sent.threadRootId, started.messageId, 'one thread for the whole first version');
    }
    // What rings names the thread, for the bell's row and the mail's button.
    const { rows: [rang] } = await pool.query(
      `SELECT detail FROM notifications WHERE conversation_message_id = $1`, [live.messageId]);
    assert.match(rang.detail, new RegExp(`"r":${started.messageId}\\b`));
    assert.equal((await bodyOf(live.messageId)).metadata.homeroomBot.alsoInChat, undefined, 'no moment is shown in a main chat too');

    // A reply to what a person wrote goes under it, in its thread.
    const wrote = await post(ada, adaChat, { content: 'How long will the plants one take?' });
    const reply = await dm.sendDm(pool, {
      bot, userId: ada.id, content: 'About eight minutes.', replyToId: wrote.message.id, moment: 'reply',
      idempotencyKey: `hrbot-mayor-${wrote.message.id}`,
    });
    assert.equal(reply.threadRootId, wrote.message.threadRootId);
    assert.equal((await bodyOf(reply.messageId)).thread_root_id, wrote.message.threadRootId);

    // A request's news is still not a message at all.
    assert.equal(await dm.sendDm(pool, {
      bot, userId: ada.id, content: 'Built.', metadata: { kind: 'step', appSlug: app.slug, issueNumber: 7 },
    }), null);

    // Nothing named at all: a thread of its own, never a message outside one.
    const loose = await dm.sendDm(pool, { bot, userId: ada.id, content: 'A note with no thread named.', idempotencyKey: 'loose-note-0001' });
    assert.equal(loose.threadRootId, null);
    assert.equal((await threadOf(loose.messageId)).kind, 'note');
    // Said again under the same key, it is the same message and one thread.
    const again = await dm.sendDm(pool, { bot, userId: ada.id, content: 'A note with no thread named.', idempotencyKey: 'loose-note-0001' });
    assert.equal(again.duplicate, true);
    assert.equal(again.messageId, loose.messageId);

    assert.deepEqual(await unlisted(ada, adaChat), [], 'no first message without its thread');
    // And the page lists every one of them.
    const listed = new Set((await aiWork.privateFor(pool, { user: ada })).map((p) => p.rootId));
    const { rows: roots } = await pool.query(
      'SELECT id FROM conversation_messages WHERE conversation_id = $1 AND thread_root_id IS NULL', [adaChat]);
    for (const root of roots) assert.ok(listed.has(root.id), `thread ${root.id} is on the page`);
    const titled = (await aiWork.privateFor(pool, { user: ada })).find((p) => p.rootId === started.messageId);
    assert.equal(titled.title, 'Plant Pal, first version');
    assert.equal(titled.kind, 'first_version');
  });

  await t.test('2. a message posted outside a thread becomes one', async () => {
    const boChat = await chatOf(bo);
    const before = (await pool.query('SELECT COUNT(*)::int AS n FROM private_threads WHERE user_id = $1', [bo.id])).rows[0].n;
    const sent = await post(bo, boChat, { content: 'Add a dark mode please', idempotency_key: 'bo-post-000001' });
    const root = await bodyOf(sent.message.threadRootId);
    assert.equal(root.sender_id, bot.id, 'the bot\'s opener, as New thread writes it');
    assert.equal(root.metadata.homeroomBot.kind, 'opened_thread');
    assert.ok(root.id < sent.message.id, 'the opener sorts before their words');
    assert.deepEqual(await threadOf(root.id), { kind: 'ask', state: 'open', app_id: null, last_read_message_id: root.id });
    assert.deepEqual(heard.at(-1), { userId: bo.id, conversationId: boChat, messageId: sent.message.id });
    // The bot reads it as that thread, so no turn is ever "in Main".
    const where = await dm.threadDeps(pool, { userId: bo.id, conversationId: boChat, message: { id: sent.message.id } });
    assert.equal(where.threadRootId, root.id);
    assert.equal(where.threadDraft.kind, 'ask');
    assert.equal(require('../src/services/bot-profiles').kindInChat(where), 'private');
    // The same message again (a retry) opens no second thread.
    const retry = await post(bo, boChat, { content: 'Add a dark mode please', idempotency_key: 'bo-post-000001' });
    assert.equal(retry.duplicate, true);
    assert.equal((await pool.query('SELECT COUNT(*)::int AS n FROM private_threads WHERE user_id = $1', [bo.id])).rows[0].n, before + 1);
    // Quoting a message of a thread joins that thread.
    const quoted = await post(bo, boChat, { content: 'And a light one', reply_to_id: sent.message.id });
    assert.equal(quoted.message.threadRootId, root.id);
    assert.equal(quoted.message.reply.id, sent.message.id, 'and keeps its quote, which says what it answers');
    // A chat that is not the bot's is left alone.
    const direct = await conversations.ensureAdmittedDirect(pool, ada.id, bo.id);
    assert.equal(await privateThreads.threadForPost(pool, { user: bo, conversationId: direct.conversationId }), null);
    // No thread could be opened (the bot is unavailable): the message is its
    // own thread's first, listed, and answered under.
    const own = await conversations.sendMessage(pool, bo, boChat, { content: 'Posted with no thread at all' }, {
      afterInsert: (db, s) => dm.heardInDm(db, {
        user: bo, conversationId: boChat, messageId: s.messageId, membership: s.membership, memberIds: s.memberIds,
      }),
    });
    assert.equal(own.message.threadRootId, null);
    assert.deepEqual(await threadOf(own.message.id), { kind: 'idea', state: 'open', app_id: null, last_read_message_id: own.message.id });
    const deps = await dm.threadDeps(pool, { userId: bo.id, conversationId: boChat, message: { id: own.message.id } });
    assert.equal(deps.threadRootId, own.message.id);
    const under = await dm.sendDm(pool, { bot, userId: bo.id, content: 'Here.', replyToId: own.message.id, moment: 'reply' });
    assert.equal(under.threadRootId, own.message.id);
    assert.deepEqual(await unlisted(bo, boChat), []);
  });

  await t.test('3. the weekly notices and the invite nudge are bell rows, once each', async () => {
    const chat = await chatOf(cy);
    const messages = async () => (await pool.query(
      'SELECT COUNT(*)::int AS n FROM conversation_messages WHERE conversation_id = $1', [chat])).rows[0].n;
    const before = await messages();
    const bell = async () => (await pool.query(
      `SELECT kind, detail, app_id, conversation_id, conversation_message_id, source_user_id, read_at
         FROM notifications WHERE user_id = $1 ORDER BY id`, [cy.id])).rows;
    const low = await dm.noteAllowanceLow(pool, { bot, userId: cy.id });
    assert.ok(low.notificationId);
    assert.deepEqual(await dm.noteAllowanceLow(pool, { bot, userId: cy.id }), { duplicate: true }, 'once a week');
    const held = await notices.ring(pool, {
      bot, userId: cy.id, kind: 'allowance', appId: app.id,
      fields: { kind: 'allowance', appSlug: app.slug, appName: app.name, count: 2 },
    });
    assert.ok(held.notificationId);
    const paused = await notices.ring(pool, { bot, userId: cy.id, kind: 'paused', fields: { kind: 'paused' } });
    assert.ok(paused.notificationId);
    assert.deepEqual(await notices.ring(pool, { bot, userId: cy.id, kind: 'paused', fields: { kind: 'paused' } }), { duplicate: true });
    // Next week it is said again.
    const next = await notices.ring(pool, {
      bot, userId: cy.id, kind: 'paused', fields: { kind: 'paused' }, now: new Date(Date.now() + 8 * 86400000),
    });
    assert.ok(next.notificationId);
    const rows = await bell();
    assert.equal(rows.length, 4);
    for (const row of rows) {
      assert.equal(row.kind, 'build_stopped', 'the "Your builds" kind its message rang as');
      assert.equal(row.conversation_id, null);
      assert.equal(row.conversation_message_id, null, 'no chat message stands behind it');
      assert.equal(row.source_user_id, bot.id);
      assert.equal(row.read_at, null);
    }
    const copy = require('../src/services/homeroom-bot-notify-copy');
    assert.deepEqual(rows.map((row) => copy.parseBotDetail(row.detail).said), ['low', 'allowance', 'paused', 'paused']);
    assert.equal(copy.botMomentCopy(rows[0].detail).body, 'You\'re close to this week\'s building time.');
    assert.equal(copy.botMomentCopy(rows[0].detail).bellLabel, 'Building time');
    assert.equal(copy.botMomentCopy(rows[1].detail).title, '2 requests on hold');
    assert.equal(rows[1].app_id, app.id);
    assert.equal(copy.botMomentCopy(rows[2].detail).body, 'On hold until Monday: I\'ve used my budget for this week.');
    // The bell lists them, though no chat is their home.
    const listed = await require('../src/services/notifications').listForUser(pool, cy.id, {});
    assert.equal((listed.items || listed).filter((n) => n.kind === 'build_stopped').length, 4);
    // Said in the chat already this week, before the bell: not said again.
    const dan = await person('dan');
    const danChat = await chatOf(dan);
    const key = `hrbot-paused-${dan.id}-${notices.weekKey()}`;
    await pool.query(
      `INSERT INTO conversation_messages (conversation_id, sender_id, content, idempotency_key) VALUES ($1, $2, 'On hold.', $3)`,
      [danChat, bot.id, key]);
    assert.deepEqual(await notices.ring(pool, { bot, userId: dan.id, kind: 'paused', legacyKey: key }), { duplicate: true });

    // The bring-a-friend nudge: one bell row, named on its own row, no card.
    const { rows: [nudge] } = await pool.query(
      `INSERT INTO invite_nudges (user_id, app_id, act) VALUES ($1, $2, 'vote') RETURNING id`, [cy.id, app.id]);
    const claimed = { nudgeId: nudge.id, userId: cy.id, appId: app.id, act: 'vote', slug: app.slug, name: app.name };
    const first = await inviteNudge.send(pool, claimed, { bot });
    assert.equal(first.said, 'sent');
    const second = await inviteNudge.send(pool, claimed, { bot });
    assert.deepEqual(second, { said: 'sent', notificationId: first.notificationId }, 'a retry rings nothing twice');
    const { rows: nudges } = await pool.query(
      `SELECT kind, detail, app_id, conversation_message_id FROM notifications WHERE user_id = $1 AND kind = 'invite_nudge'`, [cy.id]);
    assert.deepEqual(nudges, [{ kind: 'invite_nudge', detail: 'vote', app_id: app.id, conversation_message_id: null }]);
    const { rows: [kept] } = await pool.query(
      'SELECT card_id, message_id, notification_id, sent_at IS NOT NULL AS sent FROM invite_nudges WHERE id = $1', [nudge.id]);
    assert.deepEqual(kept, { card_id: null, message_id: null, notification_id: first.notificationId, sent: true });
    assert.equal((await pool.query(`SELECT COUNT(*)::int AS n FROM mobile_push_kind_categories WHERE kind = 'invite_nudge'`)).rows[0].n, 0,
      'it wakes no phone, as the message rang nothing');
    assert.equal(await messages(), before, 'none of them is a chat message');
  });

  await t.test('4. Main Chat moves under Earlier chat, once, in order', async () => {
    const eve = await person('eve');
    const chat = await chatOf(eve);
    const say = async (sender, content, extra = {}) => (await pool.query(
      `INSERT INTO conversation_messages (conversation_id, sender_id, content, metadata, thread_root_id, reply_to_id, deleted_at)
       VALUES ($1, $2, $3, $4::jsonb, $5, $6, $7) RETURNING id`,
      [chat, sender, content, JSON.stringify(extra.meta ? { homeroomBot: extra.meta } : {}), extra.root || null,
        extra.quote || null, extra.deleted ? new Date() : null],
    )).rows[0].id;
    // Main Chat as it was, oldest first.
    const gone = await say(eve.id, '', { deleted: true });
    const hello = await say(bot.id, 'Hi, I\'m Homeroom bot.', { meta: { kind: 'hello_tour' } });
    const news = await say(bot.id, 'Request #4: I have a question.', { meta: { kind: 'question', issueNumber: 4, appSlug: app.slug } });
    const newsReply = await say(eve.id, 'Newest first', { root: news });
    const asked = await say(eve.id, 'Could you add a dark mode?');
    const offer = await say(bot.id, 'Here is the request I\'d file.', { meta: { kind: 'confirm' }, quote: asked });
    const opener = await say(bot.id, 'New thread.', { meta: { kind: 'opened_thread', changeKind: 'any' } });
    await pool.query(
      `INSERT INTO private_threads (user_id, conversation_id, root_message_id, kind, state, last_read_message_id)
       VALUES ($1, $2, $3, 'ask', 'open', $3)`, [eve.id, chat, opener]);
    const inPlus = await say(eve.id, 'In my own thread', { root: opener });
    const ownRoot = await say(eve.id, 'A thread I started on my own message');
    const ownReply = await say(bot.id, 'Answered under it', { root: ownRoot });
    const firstCard = await say(bot.id, 'Building Plant Pal.', { meta: { kind: 'activity', firstVersion: true, appSlug: app.slug, issueNumber: 1 } });
    const firstReply = await say(eve.id, 'Thanks', { root: firstCard });
    const middle = await say(bot.id, 'Anything else?', { meta: { kind: 'chat' } });
    await pool.query('UPDATE conversation_members SET last_read_message_id = $3 WHERE conversation_id = $1 AND user_id = $2',
      [chat, eve.id, middle]);
    const unseen = await say(bot.id, 'One more thing you have not read.', { meta: { kind: 'chat' } });
    const last = await say(eve.id, 'ok');
    await pool.query(
      `INSERT INTO notifications (user_id, conversation_id, conversation_message_id, source_user_id, kind)
       VALUES ($1, $2, $3, $4, 'conversation_message')`, [eve.id, chat, unseen, bot.id]);
    const bells = async () => (await pool.query(
      'SELECT id, read_at, conversation_message_id FROM notifications WHERE user_id = $1 ORDER BY id', [eve.id])).rows;
    const bellsBefore = await bells();
    const snapshot = async () => (await pool.query(
      `SELECT id, thread_root_id, content, created_at, deleted_at IS NOT NULL AS deleted FROM conversation_messages
        WHERE conversation_id = $1 ORDER BY id`, [chat])).rows;
    const was = await snapshot();
    // A person with nothing to move gets no thread.
    const fay = await person('fay');
    const fayChat = await chatOf(fay);
    const fayThread = await privateThreads.startThread(pool, { user: fay, ungated: true });

    const done = await earlierChat.moveAll(pool, { batch: 2 });
    assert.ok(done.people >= 1 && done.moved >= 5);
    const rootId = await privateThreads.earlierRootFor(pool, eve.id);
    assert.equal(rootId, hello, 'the earliest message still there to read leads the thread');
    assert.equal((await threadOf(rootId)).kind, 'earlier');
    const now = await snapshot();
    const at = (id) => now.find((m) => m.id === id);
    // In their original order, every one under the first, nothing rewritten.
    assert.deepEqual(now.filter((m) => m.thread_root_id === rootId).map((m) => m.id), [asked, offer, middle, unseen, last]);
    for (const m of now) {
      const old = was.find((w) => w.id === m.id);
      assert.equal(m.content, old.content);
      assert.equal(String(m.created_at), String(old.created_at));
    }
    // Hidden news, its replies, and every message that started a thread stay.
    assert.equal(at(news).thread_root_id, null);
    assert.equal(at(newsReply).thread_root_id, news);
    assert.equal(await threadOf(news), undefined, 'a request\'s card is no thread of the page\'s');
    assert.equal(at(opener).thread_root_id, null);
    assert.equal(at(inPlus).thread_root_id, opener);
    assert.equal(at(ownRoot).thread_root_id, null);
    assert.equal(at(ownReply).thread_root_id, ownRoot);
    assert.equal((await threadOf(ownRoot)).kind, 'idea', 'their own message people replied under is listed as it was');
    assert.equal(at(firstCard).thread_root_id, null);
    assert.equal(at(firstReply).thread_root_id, firstCard);
    assert.deepEqual([(await threadOf(firstCard)).kind, (await threadOf(firstCard)).app_id], ['first_version', app.id]);
    // A deleted placeholder from before the thread's start stays put.
    assert.equal(at(gone).thread_root_id, null);
    // Nothing newly unread, and nothing rang or was read for them.
    assert.equal((await threadOf(rootId)).last_read_message_id, middle, 'the cursor is where Main Chat\'s was');
    assert.equal((await privateThreads.unreadFor(pool, eve.id, [rootId])).get(rootId), 1, 'exactly what was unread in Main');
    assert.deepEqual(await bells(), bellsBefore);
    // The page lists it, by its name; it can be marked done and comes back.
    const row = (await aiWork.privateFor(pool, { user: eve })).find((p) => p.rootId === rootId);
    assert.equal(row.title, 'Earlier chat');
    assert.equal(row.kind, 'earlier');
    assert.equal((await privateThreads.stateOf(pool, { user: eve, rootId, bot })).title, 'Earlier chat');
    assert.equal((await privateThreads.markDone(pool, { user: eve, rootId, bot })).state, 'done');
    assert.equal((await privateThreads.reopen(pool, { user: eve, rootId })).state, 'open');
    // Run again: the same result, and nothing more.
    const twice = await earlierChat.moveAll(pool, { batch: 2 });
    assert.deepEqual([twice.moved, twice.listed], [0, 0]);
    assert.deepEqual(await snapshot(), now);
    assert.equal((await pool.query(`SELECT COUNT(*)::int AS n FROM private_threads WHERE user_id = $1 AND kind = 'earlier'`, [eve.id])).rows[0].n, 1);
    // A message an older instance writes outside a thread later is swept
    // under the same thread.
    const late = await say(bot.id, 'Written by an older instance.', { meta: { kind: 'chat' } });
    await earlierChat.moveAll(pool);
    assert.equal((await bodyOf(late)).thread_root_id, rootId);
    // Fay had nothing to move: no Earlier chat for her.
    assert.equal(await privateThreads.earlierRootFor(pool, fay.id), null);
    assert.deepEqual(await unlisted(fay, fayChat), []);
    assert.ok(fayThread.ok);
    // What is left unthreaded for Eve is only what Main never drew, and the placeholder.
    assert.deepEqual((await unlisted(eve, chat)).map((m) => m.id), [gone, news]);
  });

  await t.test('5. the chat\'s unread is its threads\', and opening one clears its share', async () => {
    const gil = await person('gil');
    const chat = await chatOf(gil);
    assert.equal(await unreadOf(gil, chat), 0);
    const a = await privateThreads.startThread(pool, { user: gil, ungated: true });
    assert.equal(await unreadOf(gil, chat), 0, 'the opener of a thread they started is nothing new');
    const mine = await conversations.sendMessage(pool, gil, chat, { content: 'First question', thread_root_id: a.rootId });
    const r1 = await dm.sendDm(pool, { bot, userId: gil.id, content: 'One', replyToId: mine.message.id, moment: 'reply' });
    const r2 = await dm.sendDm(pool, { bot, userId: gil.id, content: 'Two', threadRootId: a.rootId, moment: null });
    const hello = await dm.sendDm(pool, { bot, userId: gil.id, content: 'Hi!', thread: { kind: 'hello' } });
    assert.equal(await unreadOf(gil, chat), 3, 'two replies and the hello');
    const perThread = async () => {
      const rows = await aiWork.privateFor(pool, { user: gil });
      return Object.fromEntries(rows.map((p) => [p.rootId, p.unread]));
    };
    assert.deepEqual(await perThread(), { [a.rootId]: 2, [hello.messageId]: 1 });
    const sum = async () => Object.values(await perThread()).reduce((x, y) => x + y, 0);
    assert.equal(await sum(), await unreadOf(gil, chat), 'the page\'s marks add up to the badge');
    // Reading the thread up to its first reply clears that one only.
    const read1 = await conversations.markRead(pool, gil, chat, r1.messageId);
    assert.equal(read1.threadRootId, a.rootId);
    assert.deepEqual(await perThread(), { [a.rootId]: 1, [hello.messageId]: 1 });
    // And never moves back.
    await conversations.markRead(pool, gil, chat, mine.message.id);
    assert.equal((await perThread())[a.rootId], 1);
    await conversations.markRead(pool, gil, chat, r2.messageId);
    assert.equal(await unreadOf(gil, chat), 1);
    // A thread with no reply is read by its first message.
    const readHello = await conversations.markRead(pool, gil, chat, hello.messageId);
    assert.equal(readHello.threadRootId, hello.messageId);
    assert.equal(await unreadOf(gil, chat), 0);
    assert.equal(await sum(), 0);
    // Its alert goes with it.
    const r3 = await dm.sendDm(pool, { bot, userId: gil.id, content: 'Three', threadRootId: a.rootId, moment: 'reply' });
    const unreadBells = async () => (await pool.query(
      'SELECT COUNT(*)::int AS n FROM notifications WHERE user_id = $1 AND read_at IS NULL', [gil.id])).rows[0].n;
    assert.equal(await unreadBells(), 1, 'the reply that rang and is not read yet');
    await conversations.markRead(pool, gil, chat, r3.messageId);
    assert.equal(await unreadBells(), 0);
    // Marked unread from a message, it counts from there again.
    const back = await conversations.markUnread(pool, gil, chat, r2.messageId);
    assert.equal(back.unreadCount, 2);
    assert.equal(await unreadOf(gil, chat), 2);
    // A done thread has nothing unread, and their own messages never count.
    await privateThreads.markDone(pool, { user: gil, rootId: a.rootId, bot });
    assert.equal(await unreadOf(gil, chat), 0);
    assert.equal(await sum(), 0);
    // A quiet line counts as nothing.
    await privateThreads.reopen(pool, { user: gil, rootId: a.rootId });
    await conversations.markRead(pool, gil, chat, r3.messageId);
    await conversations.sendMessage(pool, { id: bot.id }, chat, { content: 'A quiet step.', thread_root_id: a.rootId }, {
      notify: false, metadata: { homeroomBot: { kind: 'step', quiet: true } },
    });
    assert.equal(await unreadOf(gil, chat), 0);
    // Another conversation's count is its own, as before.
    const direct = await conversations.ensureAdmittedDirect(pool, ada.id, gil.id);
    await conversations.sendMessage(pool, ada, direct.conversationId, { content: 'hey' });
    assert.equal(await unreadOf(gil, direct.conversationId), 1);
  });

  await t.test('6. where a message, a first version and Earlier chat are', async () => {
    const eve = (await pool.query(`SELECT id, username FROM users WHERE username = 'eve'`)).rows[0];
    const earlier = await privateThreads.earlierRootFor(pool, eve.id);
    const { rows: [reply] } = await pool.query(
      'SELECT id FROM conversation_messages WHERE thread_root_id = $1 ORDER BY id LIMIT 1', [earlier]);
    assert.deepEqual(await privateThreads.whereFor(pool, { user: eve, message: reply.id }), { rootId: earlier, earlierRootId: earlier });
    assert.deepEqual(await privateThreads.whereFor(pool, { user: eve, message: earlier }), { rootId: earlier, earlierRootId: earlier },
      'a first message is its own thread');
    assert.deepEqual(await privateThreads.whereFor(pool, { user: eve }), { rootId: null, earlierRootId: earlier });
    // Ada's first-version thread, by its project.
    const first = await privateThreads.whereFor(pool, { user: ada, project: app.slug, firstVersion: true });
    assert.equal((await threadOf(first.rootId)).kind, 'first_version');
    assert.equal(first.earlierRootId, null, 'Ada had no Main Chat to move');
    assert.deepEqual(await privateThreads.whereFor(pool, { user: ada, project: 'no-such-project', firstVersion: true }),
      { rootId: null, earlierRootId: null });
    assert.deepEqual(await privateThreads.whereFor(pool, { user: ada, project: app.slug }), { rootId: null, earlierRootId: null },
      'a project alone names nothing');
    // Somebody else's message, another chat's, and none at all: null.
    assert.deepEqual(await privateThreads.whereFor(pool, { user: ada, message: reply.id }), { rootId: null, earlierRootId: null });
    assert.deepEqual(await privateThreads.whereFor(pool, { user: eve, message: first.rootId }), { rootId: null, earlierRootId: earlier });
    const direct = await conversations.ensureAdmittedDirect(pool, ada.id, eve.id);
    const other = await conversations.sendMessage(pool, ada, direct.conversationId, { content: 'not the bot\'s chat' });
    assert.equal((await privateThreads.whereFor(pool, { user: eve, message: other.message.id })).rootId, null);
    assert.equal((await privateThreads.whereFor(pool, { user: eve, message: 2147483000 })).rootId, null);
    assert.deepEqual(await privateThreads.whereFor(pool, { user: null, message: reply.id }), { rootId: null, earlierRootId: null });
  });
});

// H: the staging demo's chat, which a preview reaches from the Homeroom bot
// page's list now that Main Chat is gone: a few private threads, one hello
// thread, one first-version thread and Earlier chat.
test('the staging demo\'s chat with Homeroom bot is threads', { timeout: 120000 }, async (t) => {
  const pool = await openDatabase(t);
  if (!pool) return;
  const env = process.env.USERNODE_ENV;
  process.env.USERNODE_ENV = 'staging';
  t.after(() => { if (env === undefined) delete process.env.USERNODE_ENV; else process.env.USERNODE_ENV = env; });
  const staging = require('../src/services/staging-messages');
  const { rows: [viewer] } = await pool.query(
    `INSERT INTO users (username, password, has_platform_access) VALUES ('threads-viewer', 'x', TRUE) RETURNING id, username`);
  const chat = await staging.ensureBotDmFixture(pool, viewer);
  const shape = async () => (await pool.query(
    `SELECT id, thread_root_id, idempotency_key FROM conversation_messages WHERE conversation_id = $1 ORDER BY id`, [chat])).rows;
  const first = await shape();
  // Opened again (every read of the demo does), nothing is sent or moved.
  await staging.ensureBotDmFixture(pool, viewer);
  assert.deepEqual(await shape(), first);

  const rows = await aiWork.privateFor(pool, { user: viewer });
  const byKind = (kind) => rows.filter((p) => p.kind === kind);
  assert.equal(byKind('ask').length, 4, 'a few private threads');
  assert.ok(byKind('ask').every((p) => /^Staging demo: /.test(p.title)));
  const [hello] = byKind('hello');
  const [firstVersion] = byKind('first_version');
  const [earlier] = byKind('earlier');
  assert.ok(hello && firstVersion && earlier, 'a hello, a first version and Earlier chat');
  assert.equal(byKind('hello').length + byKind('first_version').length + byKind('earlier').length, 3, 'one of each');

  const thread = async (rootId) => (await pool.query(
    `SELECT m.id, m.sender_id, m.content, m.metadata->'homeroomBot'->>'kind' AS kind FROM conversation_messages m
      WHERE m.id = $1 OR m.thread_root_id = $1 ORDER BY (m.id = $1) DESC, m.id`, [rootId])).rows;
  // The hello: the bot's, with its prompts, alone and unread.
  const helloLines = await thread(hello.rootId);
  assert.deepEqual(helloLines.map((m) => m.kind), ['hello_tour']);
  assert.equal(hello.unread, 1);
  // The first version: one thread from its opening line to live.
  assert.equal(firstVersion.title, 'Staging demo plants, first version');
  const firstLines = await thread(firstVersion.rootId);
  assert.deepEqual(firstLines.map((m) => m.kind), ['first_version_started', 'activity', 'plan', 'merged']);
  assert.match(firstLines[0].content, /I'm setting up Staging demo plants now\./);
  assert.ok(firstLines.every((m, i) => i === 0 || m.id > firstLines[0].id), 'its first message sorts first');
  assert.equal(firstVersion.unread, 1, 'its "live", the newest');
  assert.deepEqual(await privateThreads.whereFor(pool, { user: viewer, project: 'staging-demo-plants', firstVersion: true }),
    { rootId: firstVersion.rootId, earlierRootId: earlier.rootId });
  // Earlier chat: a handful of obviously fake old messages, the viewer's ask
  // for a dark mode leading them.
  assert.equal(earlier.title, 'Earlier chat');
  const earlierLines = await thread(earlier.rootId);
  assert.equal(earlierLines[0].sender_id, viewer.id);
  assert.equal(earlierLines[0].content, 'Staging demo: could you add a dark mode to the list?');
  assert.ok(earlierLines.length >= 5, 'a handful');
  assert.ok(earlierLines.filter((m) => /Staging demo|Game Corner|ViaTales/.test(m.content)).length >= 5, 'obviously fake');
  assert.ok(earlierLines.every((m, i) => i === 0 || m.id > earlierLines[i - 1].id), 'in the order they were said');
  assert.equal(earlier.unread, 0, 'the demo opens calm');
  // The badge is the page's marks added up.
  const unread = (await conversations.getConversation(pool, viewer, chat)).unreadCount;
  assert.equal(unread, 2);
  assert.equal(rows.reduce((n, p) => n + p.unread, 0), unread);
  // Nothing Main drew is left outside a thread: only requests' news, which
  // was never Main's to draw and is no thread's either.
  const { rows: loose } = await pool.query(earlierChat.CANDIDATES_SQL, [chat]);
  assert.deepEqual(loose, []);
  // Every key the fixture had is still there, once.
  const keys = first.map((m) => m.idempotency_key).filter(Boolean);
  assert.equal(new Set(keys).size, keys.length);
  for (const key of ['staging-hrbot-question', 'staging-hrbot-ask', 'staging-hrbot-offer', 'staging-hrbot-plan', 'staging-hrbot-first-live']) {
    assert.ok(keys.includes(key), key);
  }
});

test('GET /api/ai/where is the signed-in person\'s own read, never cached', () => {
  const routes = fs.readFileSync(path.join(__dirname, '../src/routes/ai-work.js'), 'utf8');
  const start = routes.indexOf("router.get('/api/ai/where'");
  assert.ok(start > 0);
  const route = routes.slice(start, routes.indexOf('\n  });', start));
  assert.match(routes.slice(start, start + 120), /router\.get\('\/api\/ai\/where', appChatReadLimiter, sameOriginBrowserOnly, async/);
  assert.match(route, /res\.set\('Cache-Control', 'private, no-store'\);/);
  assert.match(route, /if \(!req\.user\?\.id\) return res\.status\(401\)/);
  // The chat is the signed-in person's, resolved on the server: the request
  // names a message or a project, never a conversation or a user.
  assert.match(route, /whereFor\(pool, \{\s*user: req\.user, message, project, firstVersion: req\.query\.firstVersion === '1',\s*\}\)/);
  assert.doesNotMatch(route, /req\.query\.(conversation|user)/);
  assert.match(route, /if \(raw != null && message == null\) return res\.status\(400\)/);
});

// ── What needs no database ───────────────────────────────────────────────

const read = (file) => fs.readFileSync(path.join(__dirname, '..', file), 'utf8');

test('a message posted with no thread named is given one before it is sent, and keeps its quote', () => {
  const route = read('src/routes/conversations.js');
  const start = route.indexOf("router.post('/api/conversations/:id/messages'");
  const body = route.slice(start, route.indexOf('router.patch(', start));
  assert.match(body, /if \(hasBody && input\.thread_root_id == null && input\.threadRootId == null\) \{\n\s+const rootId = await privateThreads\(\)\.threadForPost\(pool, \{\n\s+user: req\.user, conversationId: id, replyToId: input\.reply_to_id, idempotencyKey: input\.idempotency_key,\n\s+\}\);/);
  assert.match(body, /if \(rootId\) input\.thread_root_id = rootId;/);
  assert.doesNotMatch(body, /delete input\.reply_to_id/, 'what it answers is read from its quote');
  assert.ok(body.indexOf('threadForPost') < body.indexOf('conversations.sendMessage('), 'before the send');
  // And one no thread could be opened for is its own thread's first, in the
  // message's own transaction.
  assert.match(read('src/services/homeroom-bot-dm.js'),
    /await require\('\.\/private-threads'\)\.ownThreadFor\(db, \{ userId: user\.id, conversationId, messageId \}\);\n\s+await require\('\.\.\/workflow\/platform\.ts'\)\.dmWritten\(db, \{/);
  // New thread itself is unchanged: the same route, the same answer.
  assert.match(route, /router\.post\('\/api\/conversations\/homeroom-bot\/new-thread', conversationActionLimiter, sameOriginBrowserOnly, async \(req, res\) => \{/);
});

test('the bot\'s turn is always in a thread: Main\'s profile, its tool and its words are gone', () => {
  const profiles = require('../src/services/bot-profiles');
  const mayor = require('../src/services/homeroom-bot-mayor');
  assert.ok(!profiles.KINDS.includes('main'));
  assert.equal(profiles.kindInChat({}), 'private');
  // Nothing the chat's turn is told speaks of Main Chat any more.
  const prompts = [
    mayor.systemPrompt({ username: 'ada' }),
    mayor.systemPrompt({ username: 'ada', thread: { rootId: 5, draft: null } }),
    mayor.systemPrompt({ username: 'ada', thread: { rootId: 5, draft: { kind: 'ask', changeKind: 'any' } } }),
    mayor.systemPrompt({ username: 'ada', thread: { rootId: 5, draft: { kind: 'first_version', appSlug: 'plant-pal', appName: 'Plant Pal', issueNumber: 1 } } }),
    mayor.systemPrompt({ username: 'ada', thread: { rootId: 5, draft: { kind: 'earlier' } } }),
  ];
  for (const prompt of prompts) {
    const own = prompt.slice(0, prompt.indexOf('PLATFORM RULES'));
    assert.doesNotMatch(own, /Main Chat|the main chat|in Main\b/, 'no Main Chat');
    assert.doesNotMatch(own, /—/);
  }
  for (const tool of mayor.TOOLS) assert.doesNotMatch(tool.function.description, /Main Chat|main chat/, tool.function.name);
  // A first version's thread is told what it is, and its request once filed.
  assert.match(prompts[3], /- It is the thread of the first version of Plant Pal \(project "plant-pal"\)/);
  assert.match(prompts[3], /request_detail with project "plant-pal" and number 1\./);
  assert.match(prompts[3], /Do not call draw_screen in this thread\./);
  // Earlier chat: what was said before, still theirs to write in.
  assert.match(prompts[4], /- It is their Earlier chat thread: what you and they said before every conversation here became a thread of\n  its own\./);
  // A thread started with New thread can do what Main could.
  assert.match(prompts[2], /offer it as a request with offer_request/);
  assert.match(prompts[2], /call draw_screen: it is drawn here, in this thread/);
  assert.match(prompts[2], /offer_new_project so New project shows under your reply/);
  assert.match(prompts[2], /unless they ask about everything, or nothing has been asked for in this thread yet\./,
    '"where do things stand?" as a new thread\'s first words is about everything, as it was in Main');
  assert.match(prompts[2], /For "where do things stand\?", "what needs me\?" or "status\?", call my_work/);
});

test('a first version\'s thread holds no design, and a draft leaves a thread that is not its own as it is', async () => {
  const mayor = require('../src/services/homeroom-bot-mayor');
  const refused = await mayor.runTool(null, { user: { id: 9 }, settings: {}, deps: { threadRootId: 5, threadKind: 'first_version' } },
    'draw_screen', { what: 'A home screen', title: 'Home' });
  assert.equal(refused.ok, false);
  assert.match(refused.error, /^No screen is drawn in a first version's thread\. Tell them to start a new thread/);
  const ctx = { user: { id: 9 }, settings: {}, deps: { threadRootId: 5, threadKind: 'ask' } };
  assert.equal((await mayor.runTool(null, ctx, 'draw_screen', { what: 'A home screen', title: 'Home' })).ok, true);
  assert.deepEqual(ctx.drawScreen, { app: null, title: 'Home', brief: 'A home screen' });
  assert.match(read('src/services/homeroom-bot-mayor.js'),
    /AND p\.root_message_id = m\.thread_root_id AND p\.user_id = \$2 AND p\.state = 'open'\n(?:\s+--[^\n]*\n)+\s+AND p\.kind NOT IN \('hello', 'first_version', 'earlier', 'note'\)`/);
});

test('the move runs at boot, after the channel sweep, and a promise made in Main is kept in Earlier chat', () => {
  const migrate = read('src/db/migrate.js');
  assert.match(migrate, /await clearAutomatedChannelLines\(pool\);\n(?:\s+\/\/[^\n]*\n)+\s+await moveMainChatToThreads\(pool\);/);
  assert.match(migrate, /async function moveMainChatToThreads\(pool\) \{\n\s+try \{\n\s+const done = await require\('\.\.\/services\/earlier-chat'\)\.moveAll\(pool\);/);
  assert.match(migrate, /\} catch \(err\) \{\n\s+log\.warn\('db', 'Moving Main Chat under Earlier chat threads skipped'/, 'never aborts a boot');
  // One person at a time, under the lock a send in that chat takes.
  const move = read('src/services/earlier-chat.js');
  assert.match(move, /return conversations\.transaction\(pool, async \(db\) => \{\n\s+await conversations\.lockPair\(db, Number\(userId\), Number\(botId\)\);\n\s+return moveInTransaction\(db, \{ conversationId, userId \}\);/);
  assert.match(read('src/services/thread-followups.js'),
    /const promisedIn = row\.thread_root_id == null\n\s+\? await require\('\.\/private-threads'\)\.earlierRootFor\(pool, Number\(row\.user_id\)\)\.catch\(\(\) => null\)\n\s+: Number\(row\.thread_root_id\);/);
  // The schema it needs is a tracked migration.
  const sql = read('src/db/migrations/bot-chat-threads-only.sql');
  assert.match(sql, /CHECK \(kind IN \('draft_request', 'draft_reply', 'idea', 'ask', 'design',\n\s+'hello', 'first_version', 'earlier', 'note'\)\);/);
  assert.match(sql, /CREATE UNIQUE INDEX IF NOT EXISTS private_threads_earlier_idx\n\s+ON private_threads \(user_id\) WHERE kind = 'earlier';/);
  assert.match(sql, /ALTER TABLE private_threads ADD COLUMN IF NOT EXISTS last_read_message_id INTEGER;/);
  assert.match(sql, /COMMENT ON TABLE homeroom_bot_notices IS 'staging:private';/);
});
