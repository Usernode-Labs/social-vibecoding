'use strict';

// Saved drafts in the chat with Homeroom bot, against the full PostgreSQL
// schema: the routes a browser calls (routes/conversations.js, the
// bot-drafts routes), the table they write (src/db/migrations/
// conversation-drafts.sql) and the event the person's other devices hear.
//
//   - the person's own chat with the bot only: somebody else's, a chat
//     between people, and anything that is not a conversation are not found,
//     for the list, a save and a delete alike;
//   - one list for the chat and one for each of its threads;
//   - text only, trimmed, at most a message's 8000 characters;
//   - 20 drafts a list: the 21st is refused (409 `draft_cap`), nothing is
//     evicted, a draft already stored never trips the cap, and two devices
//     saving at once cannot both squeeze under it;
//   - a save and a delete are idempotent, and every write answers the list;
//   - the person's own sockets are told, and only when something changed;
//   - the rows leave with the conversation and with the person;
//   - same-origin, rate-limited as the agent chats' drafts are, and on no
//     connector's or CLI's list.
//
// The message box's side is tests/messages-bot-drafts.test.js.
//
// Run with: TEST_DATABASE_URL=postgres://… node --test tests/messages-bot-drafts-postgres.test.js

const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const { Pool } = require('pg');

const DSN = process.env.TEST_DATABASE_URL || process.env.DATABASE_URL
  || 'postgres://postgres:postgres@127.0.0.1:5432/postgres';

// What the routes send to sockets: [userId, payload, options].
const pushed = [];
const wsId = require.resolve('../src/services/ws');
require.cache[wsId] = {
  id: wsId, filename: wsId, loaded: true,
  exports: {
    pushConversationEvent(memberIds) { return memberIds.length; },
    pushToUser(userId, payload, options) { pushed.push([userId, payload, options]); return 1; },
    pushNotificationToUser() { return 1; },
  },
};
const pushId = require.resolve('../src/services/mobile-push');
require.cache[pushId] = { id: pushId, filename: pushId, loaded: true, exports: { scheduleBadgeSync() { return false; } } };

const express = require('express');
const conversations = require('../src/services/conversations');
const notifications = require('../src/services/notifications');
const { AUTHORIZE_SQL } = require('../src/services/ws-delivery');
const { conversationRoutes } = require('../src/routes/conversations');

test('saved drafts in the chat with Homeroom bot, against the full PostgreSQL schema', { timeout: 180000 }, async (t) => {
  const admin = new Pool({ connectionString: DSN, connectionTimeoutMillis: 2000 });
  try { await admin.query('SELECT 1'); } catch (err) {
    await admin.end();
    if (process.env.TEST_DATABASE_URL) throw err;
    t.skip('PostgreSQL unavailable; set TEST_DATABASE_URL to require this check');
    return;
  }
  const name = `hrbot_drafts_${crypto.randomBytes(6).toString('hex')}`;
  await admin.query(`CREATE DATABASE ${name}`);
  const url = new URL(DSN); url.pathname = `/${name}`;
  const pool = new Pool({ connectionString: String(url), max: 12 });
  pool.on('error', () => {});
  t.after(async () => {
    await pool.end();
    await admin.query(`DROP DATABASE ${name} WITH (FORCE)`);
    await admin.end();
  });
  // The migrations themselves, in the manifest's order: the new table is
  // made by its own file, as a deployed database gets it.
  await require('../src/db/schema-migrations').applySchemaWithLockRetry(pool);

  let seq = 0;
  async function user(prefix, { synthetic = false } = {}) {
    const { rows } = await pool.query(
      `INSERT INTO users (username, password, has_platform_access, is_synthetic)
       VALUES ($1, 'x', TRUE, $2) RETURNING id, username`,
      [synthetic ? prefix : `${prefix}_${++seq}`, synthetic],
    );
    return rows[0];
  }
  const bot = await user('homeroom_bot', { synthetic: true });
  const ada = await user('ada');
  const sam = await user('sam');
  const adasChat = Number((await conversations.ensureAdmittedDirect(pool, bot.id, ada.id)).conversationId);
  const samsChat = Number((await conversations.ensureAdmittedDirect(pool, bot.id, sam.id)).conversationId);
  const friends = Number((await conversations.ensureAdmittedDirect(pool, ada.id, sam.id)).conversationId);
  const message = async (conversationId, senderId, content, threadRootId = null) => Number((await pool.query(
    `INSERT INTO conversation_messages (conversation_id, sender_id, content, thread_root_id)
     VALUES ($1, $2, $3, $4) RETURNING id`, [conversationId, senderId, content, threadRootId])).rows[0].id);
  // A thread of Ada's chat with the bot, a reply inside it, and a message of
  // another conversation.
  const root = await message(adasChat, bot.id, 'A place to plan the garden app.');
  const reply = await message(adasChat, ada.id, 'Start with the beds.', root);
  const elsewhere = await message(friends, sam.id, 'lunch?');

  // The routes, as the signed-in person's browser reaches them.
  const app = express();
  app.use(express.json());
  let actor = ada;
  app.use((req, _res, next) => { req.user = actor; next(); });
  app.use(conversationRoutes({}, { pool }));
  const server = await new Promise((resolve) => { const s = app.listen(0, '127.0.0.1', () => resolve(s)); });
  t.after(() => server.close());
  const call = async (as, method, path, body, headers = {}) => {
    actor = as;
    const res = await fetch(`http://127.0.0.1:${server.address().port}/api/conversations/${path}`, {
      method, headers: { ...(body ? { 'content-type': 'application/json' } : {}), ...headers }, body: body ? JSON.stringify(body) : undefined,
    });
    return { status: res.status, body: await res.json().catch(() => null) };
  };
  const list = (as, where, rootId) => call(as, 'GET', `${where}/bot-drafts${rootId ? `?threadRootId=${rootId}` : ''}`);
  const save = (as, where, body, headers) => call(as, 'POST', `${where}/bot-drafts`, body, headers);
  const remove = (as, where, draftId, rootId, headers) => call(as, 'DELETE', `${where}/bot-drafts/${draftId}${rootId ? `?threadRootId=${rootId}` : ''}`, null, headers);
  const stored = async (where = adasChat) => (await pool.query(
    `SELECT user_id, thread_root_id, draft_id, content FROM conversation_drafts
      WHERE conversation_id = $1 ORDER BY thread_root_id, saved_at, draft_id`, [where])).rows;
  const seed = async (who, where, rootId, from, to) => {
    for (let n = from; n <= to; n += 1) {
      await pool.query(
        `INSERT INTO conversation_drafts (user_id, conversation_id, thread_root_id, draft_id, content, saved_at)
         VALUES ($1, $2, $3, $4, $5, NOW() - ($6 || ' seconds')::interval)`,
        [who.id, where, rootId || 0, `seed${n}`, `seeded ${n}`, String(1000 - n)]);
    }
  };

  await t.test('the table is private, keyed to the person, the conversation, the place and the draft, and its text is a message\'s length', async () => {
    const { rows: [table] } = await pool.query(`SELECT obj_description('conversation_drafts'::regclass) AS comment`);
    assert.equal(table.comment, 'staging:private');
    const { rows: key } = await pool.query(
      `SELECT a.attname FROM pg_index i JOIN pg_attribute a ON a.attrelid = i.indrelid AND a.attnum = ANY(i.indkey)
        WHERE i.indrelid = 'conversation_drafts'::regclass AND i.indisprimary ORDER BY array_position(i.indkey::int[], a.attnum::int)`);
    assert.deepEqual(key.map((row) => row.attname), ['user_id', 'conversation_id', 'thread_root_id', 'draft_id']);
    const { rows: fks } = await pool.query(
      `SELECT confrelid::regclass::text AS target, confdeltype FROM pg_constraint
        WHERE conrelid = 'conversation_drafts'::regclass AND contype = 'f' ORDER BY 1`);
    assert.deepEqual(fks, [{ target: 'conversations', confdeltype: 'c' }, { target: 'users', confdeltype: 'c' }],
      'it leaves with the conversation and with the person');
    const insert = (content) => pool.query(
      `INSERT INTO conversation_drafts (user_id, conversation_id, draft_id, content) VALUES ($1, $2, 'length', $3)`, [sam.id, samsChat, content]);
    await assert.rejects(insert(''), /check constraint/);
    await assert.rejects(insert('x'.repeat(8001)), /check constraint/);
    await insert('x'.repeat(8000));
    await pool.query(`DELETE FROM conversation_drafts WHERE draft_id = 'length'`);
    // The migration is recorded in the manifest, and is this change's own file.
    const manifest = JSON.parse(fs.readFileSync(require.resolve('../src/db/migrations/manifest.json'), 'utf8'));
    assert.ok(manifest.migrations.some((m) => m.id === 'conversation-drafts'));
    assert.match(fs.readFileSync(require.resolve('../src/db/migrations/conversation-drafts.sql'), 'utf8'),
      /COMMENT ON TABLE conversation_drafts IS 'staging:private';/);
  });

  await t.test('the person\'s own chat with the bot only: anything else is not found, for a read, a save and a delete', async () => {
    assert.deepEqual(await list(ada, adasChat), { status: 200, body: { drafts: [], max: 20 } });
    // Somebody else's chat with the bot, a chat between people, something
    // that is not a conversation, and a thread that is not an id.
    for (const [who, where] of [[sam, adasChat], [ada, samsChat], [ada, friends], [sam, friends], [ada, 'homeroom'], [ada, 99999999], [ada, '0']]) {
      assert.equal((await list(who, where)).status, 404, `list ${who.username} ${where}`);
      assert.equal((await save(who, where, { id: 'nope', text: 'not here' })).status, 404, `save ${who.username} ${where}`);
      assert.equal((await remove(who, where, 'nope')).status, 404, `delete ${who.username} ${where}`);
    }
    assert.equal((await list(ada, adasChat, 'all')).status, 404);
    assert.equal((await save(ada, adasChat, { id: 'nope', text: 'x', threadRootId: 'all' })).status, 404);
    assert.equal((await remove(ada, adasChat, 'nope', 'all')).status, 404);
    // Nobody signed in.
    assert.equal((await list({}, adasChat)).status, 404);
    assert.equal((await save({}, adasChat, { id: 'nope', text: 'x' })).status, 404);
    assert.deepEqual(await stored(adasChat), []);
    assert.deepEqual(await stored(friends), []);
    assert.equal(pushed.length, 0, 'and nobody is told of a save that never was');
    // The bot's account is found on the server: a chat with another
    // synthetic account is not the chat with Homeroom bot.
    const helper = await user('helper_bot', { synthetic: true });
    const helpersChat = Number((await conversations.ensureAdmittedDirect(pool, helper.id, ada.id)).conversationId);
    assert.equal((await list(ada, helpersChat)).status, 404);
    assert.equal((await save(ada, helpersChat, { id: 'nope', text: 'x' })).status, 404);
  });

  await t.test('a save keeps the trimmed text, answers the list oldest first, is idempotent, and tells the person\'s own sockets', async () => {
    pushed.length = 0;
    const first = await save(ada, adasChat, { id: 'd1', text: '  and make the header green  ' });
    assert.equal(first.status, 200);
    assert.equal(first.body.ok, true);
    assert.equal(first.body.id, 'd1');
    assert.equal(first.body.max, 20);
    assert.deepEqual(first.body.drafts.map((d) => [d.id, d.text]), [['d1', 'and make the header green']]);
    assert.ok(Date.parse(first.body.drafts[0].savedAt) > 0, 'each draft says when it was saved');
    // Her own sockets, and nobody else's: the event names the conversation
    // and carries no words.
    assert.deepEqual(pushed, [[ada.id, { type: 'conversation_drafts_changed', conversationId: adasChat }, { actorUserId: ada.id }]]);

    // Saved again (a retry, or a second tab replaying): one row, the first text.
    const again = await save(ada, adasChat, { id: 'd1', text: 'something else' });
    assert.equal(again.status, 200);
    assert.deepEqual(again.body.drafts.map((d) => [d.id, d.text]), [['d1', 'and make the header green']]);
    // No id given: the server makes one.
    const made = await save(ada, adasChat, { text: 'then the footer' });
    assert.match(made.body.id, /^d[0-9a-z]+$/);
    assert.deepEqual(made.body.drafts.map((d) => d.text), ['and make the header green', 'then the footer'], 'oldest first');
    // A client's own time orders the list (a device that was offline), but
    // never into the future.
    const early = await save(ada, adasChat, { id: 'd0', text: 'typed first', savedAt: new Date(Date.now() - 3600 * 1000).toISOString() });
    assert.deepEqual(early.body.drafts.map((d) => d.text), ['typed first', 'and make the header green', 'then the footer']);
    const late = await save(ada, adasChat, { id: 'd9', text: 'typed last', savedAt: '2999-01-01T00:00:00Z' });
    assert.ok(Date.parse(late.body.drafts.find((d) => d.id === 'd9').savedAt) <= Date.now() + 1000);
    assert.deepEqual((await list(ada, adasChat)).body.drafts.map((d) => d.id).slice(0, 2), ['d0', 'd1']);
    // Sam sees none of it in his own chat with the bot.
    assert.deepEqual((await list(sam, samsChat)).body.drafts, []);
  });

  await t.test('text only, at most a message\'s 8000 characters, with an id that is only ever a token', async () => {
    assert.equal((await save(ada, adasChat, { id: 'e1', text: '   ' })).status, 400);
    assert.equal((await save(ada, adasChat, { id: 'e1' })).status, 400);
    assert.equal((await save(ada, adasChat, { id: 'e1', text: 12 })).status, 400);
    assert.equal((await save(ada, adasChat, { id: 'e1', text: 'x'.repeat(8001) })).status, 400);
    assert.equal((await save(ada, adasChat, { id: 'bad id!', text: 'x' })).status, 400);
    assert.equal((await save(ada, adasChat, { id: 'x'.repeat(33), text: 'x' })).status, 400);
    assert.equal((await remove(ada, adasChat, 'bad id!')).status, 400);
    const longest = await save(ada, adasChat, { id: 'e2', text: 'y'.repeat(8000) });
    assert.equal(longest.status, 200);
    assert.equal(longest.body.drafts.find((d) => d.id === 'e2').text.length, 8000);
    // A file, a quoted message or an attached item is not part of a draft:
    // whatever else a save carries is not kept.
    await save(ada, adasChat, { id: 'e3', text: 'words', attachmentIds: ['a'], replyToId: root, object: { type: 'issue' } });
    const { rows: [kept] } = await pool.query(`SELECT to_jsonb(d) AS row FROM conversation_drafts d WHERE draft_id = 'e3'`);
    assert.deepEqual(Object.keys(kept.row).sort(), ['content', 'conversation_id', 'created_at', 'draft_id', 'saved_at', 'thread_root_id', 'user_id']);
    assert.equal((await remove(ada, adasChat, 'e2')).status, 200);
    assert.equal((await remove(ada, adasChat, 'e3')).status, 200);
  });

  await t.test('a thread has its own list, and only a main-stream message of this chat is a thread', async () => {
    pushed.length = 0;
    const main = (await list(ada, adasChat)).body.drafts.map((d) => d.id);
    const inThread = await save(ada, adasChat, { id: 't1', text: 'raised beds, six of them', threadRootId: root });
    assert.equal(inThread.status, 200);
    assert.deepEqual(inThread.body.drafts.map((d) => [d.id, d.text]), [['t1', 'raised beds, six of them']], 'the thread\'s list alone');
    assert.deepEqual(pushed.at(-1), [ada.id, { type: 'conversation_drafts_changed', conversationId: adasChat, threadRootId: root }, { actorUserId: ada.id }]);
    assert.deepEqual((await list(ada, adasChat, root)).body.drafts.map((d) => d.id), ['t1']);
    assert.deepEqual((await list(ada, adasChat)).body.drafts.map((d) => d.id), main, 'the chat\'s own list is as it was');
    // The same id in the chat's list is another draft.
    assert.equal((await save(ada, adasChat, { id: 't1', text: 'in the chat itself' })).status, 200);
    assert.deepEqual((await list(ada, adasChat, root)).body.drafts.map((d) => d.text), ['raised beds, six of them']);
    // A reply, a message of another conversation and a message that never
    // was are not threads of this chat.
    for (const notRoot of [reply, elsewhere, 99999999]) {
      assert.equal((await save(ada, adasChat, { id: 't2', text: 'x', threadRootId: notRoot })).status, 404, String(notRoot));
    }
    assert.equal((await stored()).filter((row) => row.draft_id === 't2').length, 0);
    // Deleting names the place: the thread's draft goes, the chat's stays.
    const gone = await remove(ada, adasChat, 't1', root);
    assert.deepEqual(gone, { status: 200, body: { ok: true, drafts: [], max: 20 } });
    assert.ok((await list(ada, adasChat)).body.drafts.some((d) => d.id === 't1'));
    assert.equal((await remove(ada, adasChat, 't1')).status, 200);
  });

  await t.test('a delete is the writer\'s alone, answers the list, and deleting twice tells nobody', async () => {
    pushed.length = 0;
    // Sam cannot reach Ada's draft through any chat of his.
    assert.equal((await remove(sam, adasChat, 'd1')).status, 404);
    assert.equal((await remove(sam, samsChat, 'd1')).status, 200, 'his own list has no such draft: nothing to delete');
    assert.ok((await list(ada, adasChat)).body.drafts.some((d) => d.id === 'd1'), 'hers is still there');
    assert.equal(pushed.length, 0);
    const gone = await remove(ada, adasChat, 'd1');
    assert.equal(gone.status, 200);
    assert.ok(!gone.body.drafts.some((d) => d.id === 'd1'));
    assert.deepEqual(pushed, [[ada.id, { type: 'conversation_drafts_changed', conversationId: adasChat }, { actorUserId: ada.id }]]);
    assert.equal((await remove(ada, adasChat, 'd1')).status, 200, 'deleting twice is fine');
    assert.equal(pushed.length, 1, 'and tells nobody, since nothing changed');
  });

  await t.test('twenty drafts a list: the next is refused and nothing is evicted, in the chat and in each thread apart', async () => {
    // A person of this test's own: every write counts toward the minute's
    // budget of sixty, whatever it answers.
    const cal = await user('cal');
    const calsChat = Number((await conversations.ensureAdmittedDirect(pool, bot.id, cal.id)).conversationId);
    const calsRoot = await message(calsChat, bot.id, 'A thread of Cal\'s.');
    await seed(cal, calsChat, null, 1, 19);
    assert.equal((await save(cal, calsChat, { id: 'c20', text: 'the twentieth' })).status, 200);
    pushed.length = 0;
    const full = await save(cal, calsChat, { id: 'c21', text: 'one too many' });
    assert.equal(full.status, 409);
    assert.equal(full.body.code, 'draft_cap');
    assert.equal(full.body.error, 'That\'s 20 saved drafts. Send or delete one first');
    assert.equal(pushed.length, 0);
    const held = (await list(cal, calsChat)).body.drafts;
    assert.equal(held.length, 20);
    assert.deepEqual(held.map((d) => d.id), [...Array.from({ length: 19 }, (_, n) => `seed${n + 1}`), 'c20'], 'every one of them still there, oldest first');
    assert.equal((await save(cal, calsChat, { id: 'seed3', text: 'seeded 3' })).status, 200, 'a draft already stored never trips the cap');
    // The thread's list is its own twenty.
    assert.equal((await save(cal, calsChat, { id: 'c21', text: 'fits in the thread', threadRootId: calsRoot })).status, 200);
    // One sent or deleted makes room for one.
    assert.equal((await remove(cal, calsChat, 'seed1')).status, 200);
    assert.equal((await save(cal, calsChat, { id: 'c21', text: 'now it fits' })).status, 200);
    assert.equal((await save(cal, calsChat, { id: 'c22', text: 'and this does not' })).status, 409);

    // Two devices saving at once cannot both squeeze under the cap.
    await pool.query('DELETE FROM conversation_drafts WHERE conversation_id = $1', [calsChat]);
    await seed(cal, calsChat, null, 1, 18);
    const race = await Promise.all(Array.from({ length: 6 }, (_, n) => save(cal, calsChat, { id: `race${n}`, text: `at once ${n}` })));
    assert.deepEqual(race.map((r) => r.status).sort(), [200, 200, 409, 409, 409, 409]);
    assert.equal((await stored(calsChat)).length, 20);
  });

  await t.test('the event reaches the person\'s own socket while they are in the chat, and nobody else\'s', async () => {
    // What the socket layer asks before it sends an event that names a
    // conversation (services/ws.js deliverToUser → services/ws-delivery.js):
    // the recipient is a member, and so is whoever acted. The drafts' event
    // names the person themselves as its actor.
    const token = (who) => `drafts-test-${who.id}`;
    for (const who of [ada, sam]) {
      await pool.query(`INSERT INTO sessions (token, user_id, expires_at) VALUES ($1, $2, NOW() + INTERVAL '1 day')`, [token(who), who.id]);
    }
    const allowed = async (who, { actor = ada.id, where = adasChat } = {}) => {
      const { rows } = await pool.query(AUTHORIZE_SQL, [JSON.stringify([{
        n: 0, user_id: who.id, token: token(who), staging: false, claim_username: null, admin: false, app_required: false,
        app_id: null, app_slug: null, session_id: null, watching: false, fanout: false, shared_only: false,
        conversation_id: where, conversation_required: true, actor_id: actor, actor_message_id: null,
        notification_required: false, notification_id: null,
      }]), notifications.MERGED_HIDDEN_KINDS]);
      return rows[0].authenticated && rows[0].allowed;
    };
    assert.equal(await allowed(ada), true, 'her own socket');
    assert.equal(await allowed(sam), false, 'never somebody who is not in the chat');
    assert.equal(await allowed(ada, { actor: null }), false, 'an event with no actor is dropped: the route names one');
    const src = fs.readFileSync(require.resolve('../src/services/conversation-drafts.js'), 'utf8');
    assert.match(src, /pushToUser\(userId, \{\n\s+type: DRAFTS_CHANGED, conversationId, \.\.\.\(threadRootId \? \{ threadRootId \} : \{\}\),\n\s+\}, \{ actorUserId: userId \}\);/);
  });

  await t.test('a browser\'s own request only, rate-limited as the agent chats\' drafts are, and on no connector\'s list', async () => {
    for (const site of ['cross-site', 'same-site']) {
      const headers = { 'sec-fetch-site': site };
      assert.equal((await call(ada, 'GET', `${adasChat}/bot-drafts`, null, headers)).status, 403, site);
      assert.equal((await save(ada, adasChat, { id: 'x1', text: 'from another page' }, headers)).status, 403, site);
      assert.equal((await remove(ada, adasChat, 'x1', null, headers)).status, 403, site);
    }
    assert.equal((await save(ada, adasChat, { id: 'x1', text: 'from the Homeroom page' }, { 'sec-fetch-site': 'same-origin' })).status, 200);
    assert.equal((await remove(ada, adasChat, 'x1', null, { 'sec-fetch-site': 'same-origin' })).status, 200);

    const routes = fs.readFileSync(require.resolve('../src/routes/conversations.js'), 'utf8');
    assert.match(routes, /router\.get\('\/api\/conversations\/:id\/bot-drafts', sameOriginBrowserOnly, async/);
    assert.match(routes, /router\.post\('\/api\/conversations\/:id\/bot-drafts', draftWriteLimiter, sameOriginBrowserOnly, async/);
    assert.match(routes, /router\.delete\('\/api\/conversations\/:id\/bot-drafts\/:draftId', draftWriteLimiter, sameOriginBrowserOnly, async/);
    // The agent chats' own limits, so the lists cannot drift apart; the
    // length is a message's.
    assert.match(routes, /const draftLimits = \(\) => require\('\.\/chat-drafts'\);/);
    assert.match(routes, /const \{ MAX_DRAFTS, DRAFT_ID_RE, CAP_MESSAGE, clampSavedAt \} = draftLimits\(\);/);
    assert.equal(require('../src/services/conversation-drafts').MAX_DRAFT_CHARS, conversations.MAX_MESSAGE_LENGTH);
    assert.equal(conversations.MAX_MESSAGE_LENGTH, 8000);
    // The bot's account is resolved on the server, as Stop's is.
    assert.match(routes, /const bot = await botDm\.botAccount\(pool\);\n\s+if \(!bot \|\| !\(await botDm\.isBotDirect\(pool, id, bot\.id, req\.user\.id\)\)\) return null;\n\s+return \{ id, threadRootId \};/);
    const policy = fs.readFileSync(require.resolve('../src/services/cli-api-policy.js'), 'utf8');
    assert.doesNotMatch(policy, /bot-drafts/);

    // The write limiter: sixty writes a minute for one person, then 429.
    const busy = await user('busy');
    const busysChat = Number((await conversations.ensureAdmittedDirect(pool, bot.id, busy.id)).conversationId);
    let last = null;
    for (let n = 0; n < 60; n += 1) last = await save(busy, busysChat, { id: 'same', text: 'again and again' });
    assert.equal(last.status, 200);
    assert.equal((await save(busy, busysChat, { id: 'same', text: 'again and again' })).status, 429);
    assert.equal((await remove(busy, busysChat, 'same')).status, 429, 'saves and deletes share the budget');
    assert.equal((await list(busy, busysChat)).status, 200, 'reading is not a write');
  });

  await t.test('the drafts leave with the conversation and with the person', async () => {
    const eve = await user('eve');
    const evesChat = Number((await conversations.ensureAdmittedDirect(pool, bot.id, eve.id)).conversationId);
    const evesRoot = await message(evesChat, bot.id, 'A thread.');
    assert.equal((await save(eve, evesChat, { id: 'k1', text: 'in the chat' })).status, 200);
    assert.equal((await save(eve, evesChat, { id: 'k2', text: 'in the thread', threadRootId: evesRoot })).status, 200);
    assert.equal((await stored(evesChat)).length, 2);
    await pool.query('DELETE FROM conversations WHERE id = $1', [evesChat]);
    assert.equal((await stored(evesChat)).length, 0);

    const dan = await user('dan');
    const dansChat = Number((await conversations.ensureAdmittedDirect(pool, bot.id, dan.id)).conversationId);
    assert.equal((await save(dan, dansChat, { id: 'k3', text: 'mine' })).status, 200);
    await pool.query('DELETE FROM users WHERE id = $1', [dan.id]);
    assert.equal((await stored(dansChat)).length, 0);
  });
});
