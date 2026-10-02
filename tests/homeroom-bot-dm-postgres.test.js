'use strict';

// #3624: the Homeroom bot's DM against the full PostgreSQL schema.
//
// What only a real database can show: the bot's DM is a direct
// conversation both people are already in (no invitation), a person who
// blocked the bot gets none, a message's metadata is the platform's alone
// and reaches a reader only on the bot's own messages, a request's question
// lands in its requester's DM with its suggested answers, an answer given
// there is posted on the request and closes the question, the weekly
// allowance is summed per requester, and a project's description is filed
// as its first-version request once it runs.

const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const { Pool } = require('pg');

const DSN = process.env.TEST_DATABASE_URL || process.env.DATABASE_URL
  || 'postgres://postgres:postgres@127.0.0.1:5432/postgres';

// Realtime and push are process-wide singletons: capture what the module
// hands them. handleMessage is the app-thread write a DM answer goes
// through; here it records the post and answers like the real one.
const events = [];
const threadPosts = [];
const issueUpdates = [];
const systemMessages = [];
let threadAllowed = true;
const wsId = require.resolve('../src/services/ws');
require.cache[wsId] = {
  id: wsId, filename: wsId, loaded: true,
  exports: {
    pushConversationEvent(memberIds, payload) { events.push({ memberIds: [...memberIds], payload }); return memberIds.length; },
    pushToUser(userId, payload) { events.push({ userId, payload }); return 1; },
    pushNotificationToUser(userId, payload) { events.push({ userId, payload }); return 1; },
    async handleMessage(_pool, client, msg) {
      if (!threadAllowed) return { ok: false, code: 'not_collaborator' };
      threadPosts.push({ userId: client.user.id, appId: client.appId, msg });
      return { ok: true, message: { id: threadPosts.length } };
    },
    async sendSystemMessage(_pool, appId, content, msgType, metadata, thread) {
      systemMessages.push({ appId, content, thread });
      return { id: systemMessages.length };
    },
    pushIssueUpdate(data) { issueUpdates.push(data); },
  },
};
const pushId = require.resolve('../src/services/mobile-push');
require.cache[pushId] = {
  id: pushId, filename: pushId, loaded: true,
  exports: { scheduleBadgeSync() { return false; } },
};

const conversations = require('../src/services/conversations');
const dm = require('../src/services/homeroom-bot-dm');
const homeroomBot = require('../src/services/homeroom-bot');

test('the Homeroom bot DM against the full PostgreSQL schema', { timeout: 180000 }, async (t) => {
  const admin = new Pool({ connectionString: DSN, connectionTimeoutMillis: 2000 });
  try { await admin.query('SELECT 1'); } catch (err) {
    await admin.end();
    if (process.env.TEST_DATABASE_URL) throw err;
    t.skip('PostgreSQL unavailable; set TEST_DATABASE_URL to require this check');
    return;
  }
  const name = `hrbot_dm_${crypto.randomBytes(6).toString('hex')}`;
  await admin.query(`CREATE DATABASE ${name}`);
  const url = new URL(DSN); url.pathname = `/${name}`;
  const pool = new Pool({ connectionString: String(url), max: 8 });
  t.after(async () => {
    await pool.end();
    await admin.query(`DROP DATABASE ${name}`);
    await admin.end();
  });
  const schema = fs.readFileSync(require.resolve('../src/db/schema.sql'), 'utf8');
  await pool.query(schema);
  await pool.query(schema); // boot-idempotent

  let seq = 0;
  async function user(prefix, { synthetic = false } = {}) {
    const { rows } = await pool.query(
      `INSERT INTO users (username, password, has_platform_access, is_synthetic)
       VALUES ($1, 'x', TRUE, $2) RETURNING id, username`,
      [synthetic ? prefix : `${prefix}_${++seq}`, synthetic],
    );
    return rows[0];
  }
  async function setting(key, value) {
    await pool.query(
      `INSERT INTO platform_settings (key, value) VALUES ($1, $2)
       ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value`,
      [key, value],
    );
  }
  const bot = await user('homeroom_bot', { synthetic: true });
  const ada = await user('ada');
  const sam = await user('sam');
  const { rows: [app] } = await pool.query(
    `INSERT INTO apps (name, slug, status, created_by, repo_url)
     VALUES ('Seed swap', 'seed-swap', 'running', $1, 'https://github.com/usernode-bot/seed-swap') RETURNING *`,
    [ada.id],
  );

  await t.test('schema: the settings are seeded, and the DM index and briefs are private', async () => {
    const { rows } = await pool.query(
      `SELECT key, value FROM platform_settings
        WHERE key IN ('homeroom_bot_dm_users', 'homeroom_bot_user_weekly_cents') ORDER BY key`,
    );
    assert.deepEqual(rows, [
      { key: 'homeroom_bot_dm_users', value: '[]' },
      { key: 'homeroom_bot_user_weekly_cents', value: '5000' },
    ]);
    for (const table of ['homeroom_bot_dm_messages', 'homeroom_bot_first_versions']) {
      const { rows: [c] } = await pool.query(`SELECT obj_description('${table}'::regclass, 'pg_class') AS comment`);
      assert.equal(c.comment, 'staging:private', table);
    }
  });

  await t.test('the bot\'s DM opens with both people in it, once, and never for somebody who blocked it', async () => {
    const opened = await conversations.ensureAdmittedDirect(pool, bot.id, ada.id);
    assert.equal(opened.created, true);
    const again = await conversations.ensureAdmittedDirect(pool, bot.id, ada.id);
    assert.equal(again.conversationId, opened.conversationId, 'one DM per person');
    assert.equal(again.created, false);
    const { rows: members } = await pool.query(
      'SELECT user_id, status FROM conversation_members WHERE conversation_id = $1 ORDER BY user_id',
      [opened.conversationId],
    );
    assert.deepEqual(members.map((m) => m.status), ['member', 'member'], 'nobody is left invited');
    const { rows: invites } = await pool.query(
      `SELECT 1 FROM notifications WHERE conversation_id = $1 AND kind = 'conversation_invite'`, [opened.conversationId],
    );
    assert.equal(invites.length, 0, 'and nobody is asked to accept');

    await pool.query('INSERT INTO user_blocks (blocker_id, blocked_user_id) VALUES ($1, $2)', [sam.id, bot.id]);
    assert.equal(await conversations.ensureAdmittedDirect(pool, bot.id, sam.id), null, 'blocking the bot turns it off');
    await pool.query('DELETE FROM user_blocks WHERE blocker_id = $1', [sam.id]);
  });

  await t.test('a person opening a DM with the bot gets the same conversation, already open', async () => {
    const mine = await conversations.ensureAdmittedDirect(pool, bot.id, ada.id);
    const asked = await conversations.createDirect(pool, ada, bot.id);
    assert.equal(asked.conversationId, mine.conversationId);
    assert.deepEqual(asked.notifications, []);
  });

  await t.test('metadata is the platform\'s: written beside the input, read only on the bot\'s messages', async () => {
    const { conversationId } = await conversations.ensureAdmittedDirect(pool, bot.id, ada.id);
    const fromBot = await conversations.sendMessage(pool, { id: bot.id }, conversationId, { content: 'Which colour?' }, {
      metadata: { homeroomBot: { kind: 'question', answers: ['Green', 'Blue'], status: 'open' } },
    });
    assert.deepEqual(fromBot.message.metadata, { homeroomBot: { kind: 'question', answers: ['Green', 'Blue'], status: 'open' } });
    assert.equal(fromBot.message.sender.bot, true, 'the bot is marked as one');
    // A request body that carries metadata (the route spreads req.body
    // into the input) writes none.
    const fromAda = await conversations.sendMessage(pool, ada, conversationId, {
      content: 'Green', metadata: { homeroomBot: { kind: 'question' } },
    });
    assert.equal(fromAda.message.metadata, undefined);
    assert.equal(fromAda.message.sender.bot, undefined);
    const { rows: [stored] } = await pool.query('SELECT metadata FROM conversation_messages WHERE id = $1', [fromAda.message.id]);
    assert.deepEqual(stored.metadata, {});
  });

  await t.test('nothing reaches a DM for somebody who is not on the list', async () => {
    await setting('homeroom_bot_mode', 'shadow');
    await pool.query(
      `INSERT INTO homeroom_bot_requesters (app_id, issue_number, user_id, issue_title) VALUES ($1, 7, $2, 'Sort by date')`,
      [app.id, ada.id],
    );
    const sent = await dm.relayIssuePost({
      pool, app, issueNumber: 7, kind: 'question', postId: 1, bot,
      dm: { question: 'Newest first?', answers: ['Newest first', 'Oldest first'] },
    });
    assert.equal(sent, null);
  });

  await t.test('a question reaches its requester\'s DM with the answers to tap, and an answer is posted on the request', async () => {
    await setting('homeroom_bot_dm_users', JSON.stringify([ada.username]));
    assert.deepEqual(await dm.dmRecipient(pool, app.id, 7), { userId: ada.id, username: ada.username },
      'she is told in her DM, so the post on the request leaves her untagged');
    const sent = await dm.relayIssuePost({
      pool, app, issueNumber: 7, kind: 'question', postId: 2, bot,
      dm: { question: 'Newest first?', answers: ['Newest first', 'Oldest first'] },
    });
    assert.ok(sent.messageId);
    const message = await conversations.getMessage(pool, ada, sent.conversationId, sent.messageId);
    assert.match(message.content, /Seed swap.*request #7: Sort by date/);
    assert.match(message.content, /Newest first\?/);
    assert.deepEqual(message.metadata.homeroomBot.answers, ['Newest first', 'Oldest first']);
    assert.equal(message.metadata.homeroomBot.status, 'open');
    assert.equal(message.metadata.homeroomBot.mirrors, true, 'the reader is told answers are public');

    // The same post relayed twice (a retry) sends once.
    const retry = await dm.relayIssuePost({
      pool, app, issueNumber: 7, kind: 'question', postId: 2, bot,
      dm: { question: 'Newest first?', answers: ['Newest first'] },
    });
    assert.equal(retry.messageId, sent.messageId);

    // Ada taps "Oldest first": an ordinary message quoting the question.
    const answer = await conversations.sendMessage(pool, ada, sent.conversationId, {
      content: 'Oldest first', reply_to_id: sent.messageId,
    });
    threadPosts.length = 0;
    const ack = await dm.noteUserMessage(pool, {}, { user: ada, conversationId: sent.conversationId, message: answer.message });
    assert.equal(threadPosts.length, 1, 'posted on the request');
    assert.equal(threadPosts[0].userId, ada.id, 'as her own message');
    assert.deepEqual(threadPosts[0].msg.thread, { type: 'issue', ref: 7 });
    assert.match(threadPosts[0].msg.content, /^Oldest first\n\n\(Answered in a chat with Homeroom bot\.\)$/);
    const after = await conversations.getMessage(pool, ada, sent.conversationId, sent.messageId);
    assert.equal(after.metadata.homeroomBot.status, 'answered');
    assert.equal(after.metadata.homeroomBot.answer, 'Oldest first');
    const thanks = await conversations.getMessage(pool, ada, sent.conversationId, ack.messageId);
    assert.match(thanks.content, /public discussion/, 'and the bot says where it went');
  });

  await t.test('newer news on a request closes its open question; a reply with nothing open gets the help', async () => {
    const asked = await dm.relayIssuePost({
      pool, app, issueNumber: 7, kind: 'question', postId: 3, bot, dm: { question: 'Show dates?', answers: ['Yes'] },
    });
    await dm.relayIssuePost({ pool, app, issueNumber: 7, kind: 'spec', postId: 4, bot, dm: { building: true } });
    const closed = await conversations.getMessage(pool, ada, asked.conversationId, asked.messageId);
    assert.equal(closed.metadata.homeroomBot.status, 'closed');
    const hello = await conversations.sendMessage(pool, ada, asked.conversationId, { content: 'hello?' });
    threadPosts.length = 0;
    const help = await dm.noteUserMessage(pool, {}, { user: ada, conversationId: asked.conversationId, message: hello.message });
    assert.equal(threadPosts.length, 0, 'nothing is posted on a request');
    const text = await conversations.getMessage(pool, ada, asked.conversationId, help.messageId);
    assert.equal(text.content, dm.HELP_TEXT);
  });

  await t.test('an answer the request cannot take (not a member) is said, and the question stays open', async () => {
    const asked = await dm.relayIssuePost({
      pool, app, issueNumber: 7, kind: 'question', postId: 5, bot, dm: { question: 'Colour?', answers: ['Green'] },
    });
    const reply = await conversations.sendMessage(pool, ada, asked.conversationId, { content: 'Green' });
    threadAllowed = false;
    try {
      const said = await dm.noteUserMessage(pool, {}, { user: ada, conversationId: asked.conversationId, message: reply.message });
      const text = await conversations.getMessage(pool, ada, asked.conversationId, said.messageId);
      assert.match(text.content, /couldn't post that/);
    } finally {
      threadAllowed = true;
    }
    const still = await conversations.getMessage(pool, ada, asked.conversationId, asked.messageId);
    assert.equal(still.metadata.homeroomBot.status, 'open');
  });

  await t.test('the weekly allowance sums each requester\'s runs this week', async () => {
    await pool.query(
      `INSERT INTO homeroom_bot_runs (app_id, issue_number, mode, verdict, cost_usd, build_cost_usd)
       VALUES ($1, 7, 'live', 'ready', 0.40, 12.10), ($1, 7, 'live', 'question', 0.50, NULL)`,
      [app.id],
    );
    await pool.query(
      `INSERT INTO homeroom_bot_runs (app_id, issue_number, mode, verdict, cost_usd, created_at)
       VALUES ($1, 7, 'live', 'ready', 99, NOW() - INTERVAL '14 days')`,
      [app.id],
    );
    assert.equal(await dm.weeklySpentCents(pool, ada.id), 1300, 'last week\'s run is not counted');
    assert.equal(await dm.overWeeklyAllowance(pool, { userWeeklyCents: 5000 }, ada.id), false);
    assert.equal(await dm.overWeeklyAllowance(pool, { userWeeklyCents: 1200 }, ada.id), true);
    assert.equal(await dm.overWeeklyAllowance(pool, { userWeeklyCents: 0 }, ada.id), false, '0 is no cap');
    assert.equal(await dm.weeklySpentCents(pool, sam.id), 0);
  });

  await t.test('a project\'s description is filed as its first version once it runs, under its creator', async () => {
    const { rows: [project] } = await pool.query(
      `INSERT INTO apps (name, slug, status, created_by) VALUES ('Chore wheel', 'chore-wheel', 'creating', $1) RETURNING *`,
      [ada.id],
    );
    const started = await dm.startFirstVersion(pool, {}, {
      app: project, user: ada, brief: 'Who does the dishes this week, decided fairly for the four of us.',
    });
    assert.ok(started.conversationId, 'and the DM says so');
    const settings = await homeroomBot.readSettings(pool);
    assert.deepEqual(settings.firstVersionApps.sort(), ['chore-wheel'], 'live while its creator is on the list');

    const created = [];
    const github = {
      isEnabled: () => true,
      safeMention: (s) => s,
      async createIssue(owner, repo, body) { created.push({ owner, repo, ...body }); return { number: 1 }; },
      noteIssueCreated() {},
    };
    assert.equal(await dm.fileFirstVersion(pool, {}, project.id, { github }), null, 'not while it is being created');
    await pool.query(
      `UPDATE apps SET status = 'running', repo_url = 'https://github.com/usernode-bot/chore-wheel' WHERE id = $1`,
      [project.id],
    );
    const filed = await dm.fileFirstVersion(pool, {}, project.id, { github });
    assert.deepEqual(filed, { issueNumber: 1 });
    assert.equal(created.length, 1);
    assert.equal(created[0].title, 'First version of Chore wheel');
    assert.match(created[0].body, /^\*\*Source:\*\* Homeroom user \(ada_\d+\)/);
    assert.match(created[0].body, /dishes this week/);
    const requester = await dm.requesterOf(pool, project.id, 1);
    assert.equal(requester.userId, ada.id);
    assert.equal(requester.firstVersion, true);
    const { rows: [issue] } = await pool.query('SELECT created_by FROM issues WHERE app_id = $1', [project.id]);
    assert.equal(issue.created_by, ada.id);
    assert.equal(await dm.fileFirstVersion(pool, {}, project.id, { github }), null, 'filed once');
    assert.equal(await dm.sweepFirstVersions(pool, {}, { github }), 0);

    await setting('homeroom_bot_dm_users', '[]');
    assert.deepEqual((await homeroomBot.readSettings(pool)).firstVersionApps, [], 'off the list, back to shadow');
  });

  await t.test('a staging preview has a bot DM with a question open, at its own address, once', async () => {
    const staging = require('../src/services/staging-messages');
    const env = process.env.USERNODE_ENV;
    process.env.USERNODE_ENV = 'staging';
    try {
      const viewer = await user('viewer');
      const first = await staging.resolveLegacyLink(pool, viewer, staging.BOT_DM_LEGACY_ID);
      const again = await staging.resolveLegacyLink(pool, viewer, staging.BOT_DM_LEGACY_ID);
      assert.equal(first, again);
      assert.notEqual(first, staging.BOT_DM_LEGACY_ID);
      const page = await conversations.listMessages(pool, viewer, first, {});
      const messages = page.messages || page;
      assert.equal(messages.length, 1, 'one question, not one per visit');
      assert.equal(messages[0].metadata.homeroomBot.status, 'open');
      assert.deepEqual(messages[0].metadata.homeroomBot.answers, ['Newest first', 'Oldest first', 'Let me pick each time']);
      assert.match(messages[0].content, /Staging demo/);
      const { rows } = await pool.query('SELECT 1 FROM homeroom_bot_dm_messages WHERE user_id = $1', [viewer.id]);
      assert.equal(rows.length, 0, 'never a question the bot waits on: nothing is posted anywhere');
    } finally {
      if (env === undefined) delete process.env.USERNODE_ENV; else process.env.USERNODE_ENV = env;
    }
  });

  await t.test('somebody not on the list who writes to the bot hears why it does not answer', async () => {
    const { conversationId } = await conversations.ensureAdmittedDirect(pool, bot.id, sam.id);
    const hi = await conversations.sendMessage(pool, sam, conversationId, { content: 'hi' });
    const said = await dm.noteUserMessage(pool, {}, { user: sam, conversationId, message: hi.message });
    const text = await conversations.getMessage(pool, sam, conversationId, said.messageId);
    assert.equal(text.content, dm.NOT_ENABLED_TEXT);
  });
});
