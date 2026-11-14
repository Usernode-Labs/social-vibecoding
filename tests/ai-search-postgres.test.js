'use strict';

// The Homeroom bot tab's search in what was said (services/ai-search.js)
// against the FULL PostgreSQL schema in a throwaway database, and its route
// (GET /api/ai/search, routes/ai-work.js).
//
// What this pins:
//   1. Only the caller's own chat with Homeroom bot is searched: another
//      person's chat with the bot, the caller's chats with other people and
//      their group chats never appear, whatever the request names.
//   2. Both sides of the chat are searched, in the chat itself and in its
//      threads; a match says which thread it is in, by the name the tab's
//      list gives that thread, or that it is in the chat itself.
//   3. Left out: a deleted or hidden message, a system line, the line that
//      opens a thread, a request's news in the chat itself, and a reply
//      under a deleted first message.
//   4. The query is data: %, _ and \ are matched as written, in either case.
//   5. The newest twenty, and whether there were more.
//   6. The route: signed in only, a browser's own read, never cached; a
//      query under two characters is answered with no rows.
//   7. The staging demo's fixture chat has words a search finds.
//
// Run with: TEST_DATABASE_URL=postgres://… node --test tests/ai-search-postgres.test.js

const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const express = require('express');

const DSN = process.env.TEST_DATABASE_URL
  || process.env.DATABASE_URL
  || 'postgres://postgres:postgres@127.0.0.1:5432/postgres';

test('the Homeroom bot tab\'s search in messages against the full schema', { timeout: 120000 }, async (t) => {
  let Pool;
  try { ({ Pool } = require('pg')); } catch { return t.skip('pg is not installed'); }
  const admin = new Pool({ connectionString: DSN, connectionTimeoutMillis: 3000 });
  try { await admin.query('SELECT 1'); } catch (err) {
    await admin.end();
    if (process.env.TEST_DATABASE_URL) throw err;
    return t.skip(`PostgreSQL unavailable: ${err.message}`);
  }
  const name = `ai_search_${crypto.randomBytes(6).toString('hex')}`;
  await admin.query(`CREATE DATABASE ${name}`);
  const url = new URL(DSN);
  url.pathname = `/${name}`;
  const pool = new Pool({ connectionString: String(url), max: 6 });
  let server;
  const envBefore = process.env.USERNODE_ENV;
  t.after(async () => {
    if (envBefore === undefined) delete process.env.USERNODE_ENV; else process.env.USERNODE_ENV = envBefore;
    if (server) await new Promise((resolve) => server.close(resolve));
    await pool.end();
    await admin.query(`DROP DATABASE ${name}`);
    await admin.end();
  });
  await require('../src/db/schema-migrations').applySchemaWithLockRetry(pool);
  await require('../src/db/reference-data').seedReferenceData(pool);
  await require('../src/db/schema-migrations').applySchemaWithLockRetry(pool);
  require('../src/db/pool').getPool = () => pool;
  const conversations = require('../src/services/conversations');
  const aiSearch = require('../src/services/ai-search');

  const one = async (sql, params) => (await pool.query(sql, params)).rows[0];
  const user = (username, synthetic = false) => one(
    `INSERT INTO users (username, password, is_synthetic) VALUES ($1, 'x', $2) RETURNING id, username`, [username, synthetic]);
  const ada = await user('as_ada');
  const bob = await user('as_bob');
  const carol = await user('as_carol');
  // The bot's own account, as the platform names it (homeroom-bot-dm.js botAccount).
  await pool.query(
    `INSERT INTO users (username, password, is_synthetic) VALUES ('homeroom_bot', 'x', TRUE) ON CONFLICT DO NOTHING`);
  const bot = await require('../src/services/homeroom-bot-dm').botAccount(pool);
  assert.ok(bot?.id, 'the bot has an account');

  const adaChat = (await conversations.ensureAdmittedDirect(pool, bot.id, ada.id)).conversationId;
  const bobChat = (await conversations.ensureAdmittedDirect(pool, bot.id, bob.id)).conversationId;
  const say = (conversationId, sender, content, { root = null, meta = null, deleted = false, hidden = false, type = 'message' } = {}) => one(
    `INSERT INTO conversation_messages
       (conversation_id, sender_id, content, thread_root_id, metadata, deleted_at, moderation_hidden_at, msg_type)
     VALUES ($1, $2, $3, $4, $5::jsonb, CASE WHEN $6 THEN NOW() END, CASE WHEN $7 THEN NOW() END, $8)
     RETURNING id`,
    [conversationId, sender ? sender.id : null, content, root, JSON.stringify(meta ? { homeroomBot: meta } : {}), deleted, hidden, type]);

  // Ada's chat with the bot. In the chat itself:
  const asked = await say(adaChat, ada, 'I want to improve my app.');
  const answered = await say(adaChat, bot, 'Happy to help you **improve** it. Which part first?', { meta: { kind: 'chat', moment: 'reply' } });
  // A thread from the bot's "+": its opening line, then what the two said in it.
  const opener = await say(adaChat, bot, 'New thread, to improve something.', { meta: { kind: 'opened_thread', changeKind: 'any' } });
  await pool.query(
    `INSERT INTO private_threads (user_id, conversation_id, root_message_id, kind, state) VALUES ($1, $2, $3, 'ask', 'open')`,
    [ada.id, adaChat, opener.id]);
  const inPlus = await say(adaChat, ada, 'Make the calendar view easier to read', { root: opener.id });
  const botInPlus = await say(adaChat, bot, 'I can improve the calendar view. One question first.', { root: opener.id });
  // A thread that grew from something Ada said in the chat.
  const grew = await say(adaChat, ada, '**Sort** the list by date\n\nNewest first, please.');
  const underGrew = await say(adaChat, bot, 'We could improve the sort as well.', { root: grew.id });
  // A thread opened from a request's page: its opening line is its door, too.
  await say(adaChat, bot, 'New thread about #18 Dark mode. Only you can see it. We can improve it here.', { meta: { kind: 'opened_about' } });
  // A request's news in the chat itself (no longer drawn there), and a reply in its thread.
  const news = await say(adaChat, bot, '**Garden** · request #12: Tidy the beds\n\nBuilding. I will improve the layout.', { meta: { kind: 'step', issueNumber: 12 } });
  const underNews = await say(adaChat, ada, 'Please improve the paths too', { root: news.id });
  // What nobody should find.
  await say(adaChat, ada, 'improve this deleted line', { deleted: true });
  await say(adaChat, ada, 'improve this hidden line', { hidden: true });
  await say(adaChat, null, 'as_ada joined to improve things', { type: 'system' });
  const gone = await say(adaChat, ada, 'a first message that was deleted', { deleted: true });
  await say(adaChat, bot, 'improve, under a deleted first message', { root: gone.id });

  // Other people's words: Bob's chat with the bot, Ada's chat with Bob, a group Ada is in.
  await say(bobChat, bob, 'Bob wants to improve his own app');
  await say(bobChat, bot, 'Bob, I will improve it.');
  const adaBob = (await conversations.ensureAdmittedDirect(pool, bob.id, ada.id)).conversationId;
  await say(adaBob, bob, 'Ada, shall we improve our plan?');
  await say(adaBob, ada, 'Yes, let us improve it together');
  const group = await one(`INSERT INTO conversations (kind, title, created_by) VALUES ('group', 'Planners', $1) RETURNING id`, [ada.id]);
  await pool.query(
    `INSERT INTO conversation_members (conversation_id, user_id, role, status) VALUES ($1, $2, 'owner', 'member'), ($1, $3, 'member', 'member'), ($1, $4, 'member', 'member')`,
    [group.id, ada.id, bob.id, bot.id]);
  await say(group.id, ada, 'A group where we improve things');
  await say(group.id, bot, 'The group can improve this.');

  const search = (who, q) => aiSearch.searchFor(pool, { user: { id: who.id }, q: aiSearch.cleanQuery(q) });
  const ids = (out) => out.rows.map((r) => r.messageId);

  // 1 and 2: Ada's own chat, both sides, the chat and its threads, newest first.
  const mine = await search(ada, 'improve');
  assert.deepEqual(ids(mine), [underNews.id, underGrew.id, botInPlus.id, answered.id, asked.id]);
  assert.equal(mine.more, false);
  const by = Object.fromEntries(mine.rows.map((r) => [r.messageId, r]));
  // The report itself: her own message, with the word marked. 14 Nov 2026:
  // Main Chat is gone, so a message that is not a reply is its own thread's
  // first message: the match names that thread, never "the chat".
  assert.deepEqual(by[asked.id], {
    messageId: asked.id, rootId: asked.id, threadTitle: 'I want to improve my app.', mine: true,
    snippet: 'I want to improve my app.', ranges: [[10, 17]], at: by[asked.id].at,
  });
  assert.match(by[asked.id].at, /^\d{4}-\d\d-\d\dT/);
  // The bot's answer in the chat: its words without their markdown.
  assert.equal(by[answered.id].mine, false);
  assert.equal(by[answered.id].rootId, answered.id);
  assert.equal(by[answered.id].snippet, 'Happy to help you improve it. Which part first?');
  assert.deepEqual(by[answered.id].ranges, [[18, 25]]);
  // In a "+" thread: named as the tab's list names it, by her first words in it.
  assert.equal(by[botInPlus.id].rootId, opener.id);
  assert.equal(by[botInPlus.id].threadTitle, 'Make the calendar view easier to read');
  assert.equal(by[botInPlus.id].mine, false);
  const listed = (await require('../src/services/ai-work').workFor(pool, { user: { id: ada.id }, deps: { bot } })).private;
  assert.equal(listed.find((p) => p.rootId === opener.id).title, by[botInPlus.id].threadTitle, 'the same name as its row in the list');
  // In a thread that grew from the chat: named by its first message's words.
  assert.equal(by[underGrew.id].rootId, grew.id);
  assert.equal(by[underGrew.id].threadTitle, 'Sort the list by date');
  // A reply in a request's old thread is found; the news line over it is not.
  assert.equal(by[underNews.id].rootId, news.id);
  assert.equal(by[underNews.id].threadTitle, 'Garden · request #12: Tidy the beds');
  assert.ok(!ids(mine).includes(news.id), 'a request\'s news in the chat itself is not drawn there, so it is not found');
  // A match in a thread from her own words: the thread, and her message in it.
  const calendar = await search(ada, 'calendar view');
  assert.deepEqual(ids(calendar), [botInPlus.id, inPlus.id]);
  assert.ok(calendar.rows.every((r) => r.rootId === opener.id));
  // 3: the opening lines, deleted, hidden and system lines never appear.
  assert.deepEqual(ids(await search(ada, 'New thread')), [], 'the line that opens a thread is its door, not something said');
  assert.deepEqual(ids(await search(ada, 'deleted')), []);
  assert.deepEqual(ids(await search(ada, 'hidden line')), []);
  assert.deepEqual(ids(await search(ada, 'joined')), []);
  // Her first message of a thread is found as that thread's first.
  assert.deepEqual((await search(ada, 'newest first')).rows.map((r) => [r.messageId, r.rootId, r.threadTitle]),
    [[grew.id, grew.id, 'Sort the list by date']]);
  // Earlier chat is named by what it is, whichever of its messages matches.
  const old = await say(adaChat, ada, 'Something I said in the main chat long ago');
  const oldReply = await say(adaChat, bot, 'Long ago indeed.', { root: old.id });
  await pool.query(
    `INSERT INTO private_threads (user_id, conversation_id, root_message_id, kind, state) VALUES ($1, $2, $3, 'earlier', 'open')`,
    [ada.id, adaChat, old.id]);
  assert.deepEqual((await search(ada, 'long ago')).rows.map((r) => [r.messageId, r.rootId, r.threadTitle]),
    [[oldReply.id, old.id, 'Earlier chat'], [old.id, old.id, 'Earlier chat']]);

  // 1: nobody else's words, and nothing of hers outside this chat.
  for (const r of mine.rows) assert.doesNotMatch(r.snippet, /Bob|our plan|together|group/i);
  assert.deepEqual(ids(await search(ada, 'Bob')), []);
  assert.deepEqual(ids(await search(ada, 'together')), [], 'her chat with Bob is not the bot\'s');
  assert.deepEqual(ids(await search(ada, 'group')), [], 'nor a group she and the bot are both in');
  const bobs = await search(bob, 'improve');
  assert.deepEqual(bobs.rows.map((r) => r.snippet), ['Bob, I will improve it.', 'Bob wants to improve his own app']);
  assert.deepEqual(await search(carol, 'improve'), { q: 'improve', rows: [], more: false }, 'somebody with no chat with the bot finds nothing');
  // Once she has left the chat, it is no longer hers to read.
  await pool.query(`UPDATE conversation_members SET status = 'left', left_at = NOW() WHERE conversation_id = $1 AND user_id = $2`, [bobChat, bob.id]);
  assert.deepEqual(ids(await search(bob, 'improve')), []);
  await pool.query(`UPDATE conversation_members SET status = 'member', left_at = NULL WHERE conversation_id = $1 AND user_id = $2`, [bobChat, bob.id]);

  // 4: the query is data.
  const percent = await say(adaChat, ada, 'It is 100% done_now, see a\\b');
  await say(adaChat, ada, 'It is 100 percent doneXnow, see a-b');
  assert.deepEqual(ids(await search(ada, '100%')), [percent.id], '% is a percent sign');
  assert.deepEqual(ids(await search(ada, 'done_now')), [percent.id], '_ is an underscore');
  assert.deepEqual(ids(await search(ada, 'a\\b')), [percent.id], 'a backslash is a backslash');
  assert.deepEqual(ids(await search(ada, '%%')), [], 'two wildcards match nothing, not everything');
  assert.deepEqual(ids(await search(ada, 'IMPROVE MY APP')), [asked.id], 'in either case');
  assert.deepEqual((await search(ada, 'i')).rows, [], 'one character is not searched for');

  // 5: the newest twenty, and that there were more.
  const bulk = [];
  for (let i = 0; i < aiSearch.MAX_HITS + 3; i++) bulk.push((await say(adaChat, ada, `needle number ${i}`)).id);
  const many = await search(ada, 'needle');
  assert.equal(many.rows.length, aiSearch.MAX_HITS);
  assert.equal(many.more, true);
  assert.deepEqual(ids(many), bulk.slice(-aiSearch.MAX_HITS).reverse());

  // 6: the route.
  const httpApp = express();
  httpApp.use((req, _res, next) => { req.user = req.get('x-test-user') ? { id: Number(req.get('x-test-user')) } : null; next(); });
  httpApp.use(require('../src/routes/ai-work').aiWorkRoutes({}));
  server = await new Promise((resolve) => { const s = httpApp.listen(0, '127.0.0.1', () => resolve(s)); });
  const base = `http://127.0.0.1:${server.address().port}`;
  assert.equal((await fetch(`${base}/api/ai/search?q=improve`)).status, 401);
  const headers = { 'x-test-user': String(ada.id) };
  const res = await fetch(`${base}/api/ai/search?q=${encodeURIComponent('  Improve   my ')}`, { headers });
  assert.equal(res.status, 200);
  assert.equal(res.headers.get('cache-control'), 'private, no-store');
  const body = await res.json();
  assert.equal(body.q, 'Improve my');
  assert.deepEqual(body.rows.map((r) => r.messageId), [asked.id]);
  assert.deepEqual(body.rows[0].ranges, [[10, 20]]);
  assert.equal(body.more, false);
  // Whatever the request names, it is the caller's own chat that is read.
  const forged = await (await fetch(
    `${base}/api/ai/search?q=improve&conversation=${bobChat}&conversationId=${bobChat}&conversation_id=${bobChat}&user=${bob.id}&userId=${bob.id}`, { headers })).json();
  assert.deepEqual(forged.rows.map((r) => r.messageId), ids(mine));
  const asBob = await (await fetch(`${base}/api/ai/search?q=improve`, { headers: { 'x-test-user': String(bob.id) } })).json();
  assert.deepEqual(asBob.rows.map((r) => r.snippet), ['Bob, I will improve it.', 'Bob wants to improve his own app']);
  // Too short, or not a query at all: no rows, and no error.
  assert.deepEqual(await (await fetch(`${base}/api/ai/search?q=i`, { headers })).json(), { q: 'i', rows: [], more: false });
  assert.deepEqual(await (await fetch(`${base}/api/ai/search`, { headers })).json(), { q: '', rows: [], more: false });
  assert.deepEqual(await (await fetch(`${base}/api/ai/search?q=improve&q=app`, { headers })).json(), { q: '', rows: [], more: false });
  // Another site's page cannot make the read with the person's session.
  assert.equal((await fetch(`${base}/api/ai/search?q=improve`, { headers: { ...headers, 'sec-fetch-site': 'cross-site' } })).status, 403);
  assert.equal((await fetch(`${base}/api/ai/search?q=improve`, { headers: { ...headers, 'sec-fetch-site': 'same-origin' } })).status, 200);

  // 7: the staging demo's fixture chat (?demo=1 makes it before it searches)
  // has words to find.
  process.env.USERNODE_ENV = 'staging';
  const demoChat = await require('../src/services/staging-messages').ensureBotDmFixture(pool, { id: carol.id, username: carol.username });
  assert.ok(Number(demoChat) > 0, 'the fixture chat was made');
  const demo = await search(carol, 'dark mode');
  assert.ok(demo.rows.length >= 1, 'a search for "dark mode" finds the demo\'s own ask');
  const ask = demo.rows.find((r) => r.mine);
  assert.ok(ask, 'the viewer\'s own message among them');
  assert.equal(ask.snippet, '…could you add a dark mode to the list?');
  assert.deepEqual(ask.ranges.map(([a, b]) => ask.snippet.slice(a, b)), ['dark mode']);
  // 14 Nov 2026: what the demo used to say in Main Chat is in its Earlier
  // chat thread, which the viewer's ask leads.
  assert.equal(ask.rootId, ask.messageId, 'the first message of its thread');
  assert.equal(ask.threadTitle, 'Earlier chat');
  assert.equal(await require('../src/services/private-threads').earlierRootFor(pool, carol.id), ask.messageId);
  // A word from its start finds it whole, and it says what it is.
  const whole = (await search(carol, 'staging demo: could')).rows.find((r) => r.mine);
  assert.equal(whole.snippet, 'Staging demo: could you add a dark mode to the list?');
});
