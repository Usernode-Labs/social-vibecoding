'use strict';

// Threads, stage 5 of #6019: private threads, against the FULL PostgreSQL
// schema in a throwaway database, through the real code
// (services/private-threads.js over homeroom-bot-mayor.js fileRequest,
// ws.handleMessage and homeroom-bot-dm.js sendDm). GitHub is the one fake.
//
// What this pins:
//   1. A thread the person started in their chat with the bot is theirs:
//      somebody else's, a reply inside a thread, or a message in another
//      chat is no thread to file or post.
//   2. File it files its words as a request on the project they pick, under
//      their name, with its thread, says so in the thread, and is done once.
//   3. Post it posts its words in an existing request's discussion as their
//      own message, in that request's thread, and is done once.
//   4. A project they have not joined answers join_required, and nothing is
//      filed or posted.
//   5. A new thread from the bot's "+" (#6071 follow-up) is the bot's line in
//      Main with what its welcome block picked, and the bot's turn in it is
//      told the project and the kind of change.
//
// Run with: TEST_DATABASE_URL=postgres://… node --test tests/private-threads-postgres.test.js

const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');

const DSN = process.env.TEST_DATABASE_URL
  || process.env.DATABASE_URL
  || 'postgres://postgres:postgres@127.0.0.1:5432/postgres';

test('private threads against the full schema', { timeout: 120000 }, async (t) => {
  let Pool;
  try { ({ Pool } = require('pg')); } catch { return t.skip('pg is not installed'); }
  const admin = new Pool({ connectionString: DSN, connectionTimeoutMillis: 3000 });
  try { await admin.query('SELECT 1'); } catch (err) {
    await admin.end();
    if (process.env.TEST_DATABASE_URL) throw err;
    return t.skip(`PostgreSQL unavailable: ${err.message}`);
  }
  const name = `private_threads_${crypto.randomBytes(6).toString('hex')}`;
  await admin.query(`CREATE DATABASE ${name}`);
  const url = new URL(DSN);
  url.pathname = `/${name}`;
  const pool = new Pool({ connectionString: String(url), max: 6 });
  t.after(async () => {
    await pool.end();
    await admin.query(`DROP DATABASE ${name}`);
    await admin.end();
  });
  const schema = fs.readFileSync(require.resolve('../src/db/schema.sql'), 'utf8');
  await pool.query(schema);

  require('../src/db/pool').getPool = () => pool;
  require('../src/services/app-numbers').setPool?.(pool);
  const wsBus = require('../src/services/ws-bus');
  wsBus.publish = () => {};
  wsBus.publishBatched = () => {};
  const conversations = require('../src/services/conversations');
  const privateThreads = require('../src/services/private-threads');

  async function user(username, { synthetic = false } = {}) {
    const { rows: [row] } = await pool.query(
      `INSERT INTO users (username, password, is_synthetic, has_platform_access) VALUES ($1, 'x', $2, TRUE)
       RETURNING id, username`,
      [username, synthetic]
    );
    return { id: row.id, username: row.username, isAdmin: false };
  }
  const bot = await user('homeroom_bot', { synthetic: true });
  const ada = await user('pt_ada');
  const sam = await user('pt_sam');
  const { rows: [inserted] } = await pool.query(
    `INSERT INTO apps (name, slug, status, created_by, repo_url, view_visibility, collab_visibility)
     VALUES ('Seed swap', 'pt-seed-swap', 'running', $1, 'https://github.com/usernode-bot/pt-seed-swap', 'public', 'public')
     RETURNING id`,
    [ada.id]
  );
  // The community is made by a trigger after the insert.
  const { rows: [app] } = await pool.query('SELECT id, slug, community_id FROM apps WHERE id = $1', [inserted.id]);
  await pool.query('INSERT INTO community_members (community_id, user_id) VALUES ($1, $2)', [app.community_id, ada.id]);

  let nextIssue = 40;
  const deps = {
    github: {
      isEnabled: () => true,
      safeMention: (s) => s,
      async createIssue() { nextIssue += 1; return { number: nextIssue }; },
    },
  };
  const opened = await conversations.ensureAdmittedDirect(pool, bot.id, ada.id);
  const say = async (who, content, extra = {}) => (await conversations.sendMessage(pool, who, opened.conversationId, { content, ...extra })).message;
  const replies = async (rootId) => (await pool.query(
    'SELECT sender_id, content FROM conversation_messages WHERE thread_root_id = $1 ORDER BY id', [rootId],
  )).rows;

  await t.test('only a thread she started in her chat with the bot is hers to file or post', async () => {
    const theirs = await say(ada, 'An idea: swap seeds by post');
    const botSaid = (await pool.query(
      `INSERT INTO conversation_messages (conversation_id, sender_id, content) VALUES ($1, $2, 'hi') RETURNING id`,
      [opened.conversationId, bot.id],
    )).rows[0].id;
    const inside = await say(ada, 'more about it', { thread_root_id: theirs.id });
    for (const [rootId, who, why] of [[botSaid, ada, 'the bot\'s own message'], [theirs.id, sam, 'somebody else\'s'], [inside.id, ada, 'a reply inside a thread']]) {
      const out = await privateThreads.fileIt(pool, {}, { user: who, rootId, project: app.slug, deps });
      assert.equal(out.status, 404, why);
    }
    assert.deepEqual(await privateThreads.stateOf(pool, { user: ada, rootId: theirs.id }), { state: 'open' });
  });

  await t.test('File it files her words as a request on the project she picks, says so in the thread, once', async () => {
    const root = await say(ada, 'Swap seeds by post\nPeople mail each other seeds they have spare.');
    const out = await privateThreads.fileIt(pool, {}, { user: ada, rootId: root.id, project: app.slug, deps });
    assert.equal(out.ok, true, out.error);
    assert.deepEqual({ state: out.state, number: out.number, href: out.href }, { state: 'filed', number: 41, href: '#app/pt-seed-swap/dev/issues/41' });
    const { rows: [issue] } = await pool.query(
      'SELECT title, created_by, thread_id FROM issues WHERE app_id = $1 AND github_issue_number = 41', [app.id],
    );
    assert.equal(issue.title, 'Swap seeds by post', 'its first line is the title');
    assert.equal(issue.created_by, ada.id, 'under her name');
    assert.ok(Number(issue.thread_id) > 0, 'and it has its thread');
    const { rows: [row] } = await pool.query('SELECT kind, state, result_ref, target_thread_id FROM private_threads WHERE root_message_id = $1', [root.id]);
    assert.deepEqual({ ...row, target_thread_id: Number(row.target_thread_id) },
      { kind: 'draft_request', state: 'filed', result_ref: 41, target_thread_id: Number(issue.thread_id) });
    const said = await replies(root.id);
    assert.deepEqual(said.map((r) => [r.sender_id, r.content]), [[bot.id, 'Filed it as request #41 on Seed swap, under your name.']]);
    const again = await privateThreads.fileIt(pool, {}, { user: ada, rootId: root.id, project: app.slug, deps });
    assert.equal(again.status, 409);
    assert.equal(again.state, 'filed');
    assert.equal(nextIssue, 41, 'nothing filed twice');
  });

  await t.test('Post it posts her words in an existing request\'s discussion, as hers, once', async () => {
    const root = await say(ada, 'For #41: a limit of five packets each');
    const out = await privateThreads.postIt(pool, { user: ada, rootId: root.id, project: app.slug, number: 41, deps: {} });
    assert.equal(out.ok, true, out.error);
    assert.deepEqual({ state: out.state, number: out.number }, { state: 'posted', number: 41 });
    const { rows: posts } = await pool.query(
      `SELECT user_id, content, thread_type, thread_ref, thread_id FROM chat_messages
        WHERE app_id = $1 AND thread_type = 'issue' AND thread_ref = 41 AND user_id = $2`,
      [app.id, ada.id],
    );
    assert.equal(posts.length, 1);
    assert.match(posts[0].content, /^For #41: a limit of five packets each\n\n\(Posted from a private draft in a chat with Homeroom bot\.\)$/);
    const { rows: [thread] } = await pool.query('SELECT thread_id FROM issues WHERE app_id = $1 AND github_issue_number = 41', [app.id]);
    assert.equal(Number(posts[0].thread_id), Number(thread.thread_id), 'in the request\'s thread');
    assert.equal((await privateThreads.postIt(pool, { user: ada, rootId: root.id, project: app.slug, number: 41, deps: {} })).status, 409);
    assert.equal((await privateThreads.postIt(pool, { user: ada, rootId: (await say(ada, 'x y')).id, project: app.slug, number: 999, deps: {} })).status, 404,
      'a number with no thread');
  });

  await t.test('a project she has not joined answers join_required, and nothing is filed or posted', async () => {
    const samChat = await conversations.ensureAdmittedDirect(pool, bot.id, sam.id);
    const root = (await conversations.sendMessage(pool, sam, samChat.conversationId, { content: 'Sam wants seeds too' })).message;
    const filed = await privateThreads.fileIt(pool, {}, { user: sam, rootId: root.id, project: app.slug, deps });
    assert.deepEqual({ status: filed.status, code: filed.code, app: filed.app }, { status: 403, code: 'join_required', app: { slug: app.slug, name: 'Seed swap' } });
    const posted = await privateThreads.postIt(pool, { user: sam, rootId: root.id, project: app.slug, number: 41, deps: {} });
    assert.equal(posted.code, 'join_required');
    assert.equal(nextIssue, 41);
    assert.deepEqual(await privateThreads.stateOf(pool, { user: sam, rootId: root.id }), { state: 'open' });
  });

  await t.test('a new thread from the bot\'s "+" hangs off its line in Main, and the bot reads what it is for', async () => {
    const dm = require('../src/services/homeroom-bot-dm');
    const aiWork = require('../src/services/ai-work');
    const made = await privateThreads.startThread(pool, { user: ada, project: app.slug, kind: 'fix' });
    assert.equal(made.ok, true, made.error);
    assert.equal(made.conversationId, Number(opened.conversationId), 'in her chat with the bot');
    const { rows: [root] } = await pool.query(
      'SELECT sender_id, thread_root_id, content, metadata FROM conversation_messages WHERE id = $1', [made.rootId],
    );
    assert.equal(root.sender_id, bot.id);
    assert.equal(root.thread_root_id, null, 'a line of Main');
    assert.equal(root.content, 'New thread, to fix something broken on Seed swap.');
    assert.deepEqual(
      { kind: root.metadata.homeroomBot.kind, changeKind: root.metadata.homeroomBot.changeKind, appSlug: root.metadata.homeroomBot.appSlug },
      { kind: 'opened_thread', changeKind: 'fix', appSlug: 'pt-seed-swap' },
    );
    const first = await say(ada, 'The swap button does nothing on my phone', { thread_root_id: made.rootId });
    const where = await dm.messageThread(pool, { userId: ada.id, conversationId: opened.conversationId, message: first });
    assert.deepEqual(where, {
      rootId: made.rootId,
      draft: { kind: 'ask', state: 'open', appSlug: 'pt-seed-swap', appName: 'Seed swap', changeKind: 'fix' },
    });
    // The Homeroom bot tab lists it by her first words in it, not the bot's line.
    const { rows } = await pool.query(aiWork.PRIVATE_SQL, [ada.id, bot.id, aiWork.PRIVATE_MAX]);
    const listed = rows.find((r) => Number(r.root_id) === made.rootId);
    assert.equal(listed.kind, 'ask');
    assert.equal(listed.first_own, 'The swap button does nothing on my phone');

    // Any project, any kind; a project she cannot see is no project; nobody synthetic starts one.
    const any = await privateThreads.startThread(pool, { user: sam, project: null, kind: 'whatever' });
    assert.equal(any.ok, true, any.error);
    const { rows: [line] } = await pool.query('SELECT content, metadata FROM conversation_messages WHERE id = $1', [any.rootId]);
    assert.equal(line.content, 'New thread.');
    assert.equal(line.metadata.homeroomBot.changeKind, 'any');
    assert.equal((await dm.messageThread(pool, { userId: sam.id, conversationId: any.conversationId, message: { threadRootId: any.rootId } })).draft.appSlug, null);
    assert.equal((await privateThreads.startThread(pool, { user: ada, project: 'no-such-project', kind: 'add' })).status, 404);
    assert.equal((await privateThreads.startThread(pool, { user: { ...bot, isSynthetic: true }, project: null })).status, 403);
    assert.equal(privateThreads.startLine({ kind: 'design', appName: null }), 'New thread, to change how a screen looks.');
    assert.equal(privateThreads.startLine({ kind: 'any', appName: 'Seed swap' }), 'New thread, about Seed swap.');
  });
});
