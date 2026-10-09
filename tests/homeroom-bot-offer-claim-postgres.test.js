'use strict';

// #4605: the bot could promise a File it button without making one.
//
// Drea, on Rilo, twice asked the bot to file a request ("Week by week
// tracking in insights"). Each time it wrote the request as ordinary text and
// said a File it button would appear under the message, and no button came:
// offer_request had not been called, so there was nothing to tap and nothing
// was filed. Now a reply that promises the buttons with no offer behind it is
// asked again (the CLAIMS kind `offered`, and checkNote tells the second pass
// to call offer_request), so the File it and Not now buttons really land
// under the reply and the request can be filed.
//
// Run with: TEST_DATABASE_URL=postgres://… node --test tests/homeroom-bot-offer-claim-postgres.test.js

const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const { Pool } = require('pg');

const DSN = process.env.TEST_DATABASE_URL || process.env.DATABASE_URL
  || 'postgres://postgres:postgres@127.0.0.1:5432/postgres';

const wsId = require.resolve('../src/services/ws');
require.cache[wsId] = {
  id: wsId, filename: wsId, loaded: true,
  exports: {
    pushConversationEvent() { return 0; },
    pushToUser() { return 1; },
    pushNotificationToUser() { return 1; },
    pushSessionUpdate() {},
    broadcast() {},
    async handleMessage() { return { ok: true, message: { id: 1 } }; },
    async sendSystemMessage() { return { id: 1 }; },
    pushIssueUpdate() {},
  },
};
const pushId = require.resolve('../src/services/mobile-push');
require.cache[pushId] = {
  id: pushId, filename: pushId, loaded: true,
  exports: { scheduleBadgeSync() { return false; } },
};
const githubId = require.resolve('../src/services/github');
const created = [];
require.cache[githubId] = {
  id: githubId, filename: githubId, loaded: true,
  exports: new Proxy({
    isEnabled: () => true,
    async createIssue(_owner, _repo, { title }) {
      created.push({ title });
      return { number: 40 + created.length, title };
    },
    noteIssueCreated() {},
    safeMention: (s) => s,
  }, { get: (t, k) => (k in t ? t[k] : async () => null) }),
};

const conversations = require('../src/services/conversations');
const mayor = require('../src/services/homeroom-bot-mayor');
const homeroomBot = require('../src/services/homeroom-bot');

const CONFIG = { openrouterApiBase: 'https://openrouter.test/api/v1', openrouterOrigin: 'https://test', openrouterDefaultCodexModel: 'z-ai/glm-5.3-flash' };

/** A scripted model: each call answers with the next step's tool calls. */
function scripted(steps, seen = []) {
  let i = 0;
  return async (request) => {
    seen.push(request);
    const step = steps[Math.min(i, steps.length - 1)];
    i += 1;
    const calls = (typeof step === 'function' ? step(request) : step).map((c, n) => ({
      id: `call_${i}_${n}`, type: 'function', function: { name: c[0], arguments: JSON.stringify(c[1] || {}) },
    }));
    return {
      content: '',
      toolCalls: calls,
      assistantMessage: { role: 'assistant', content: null, tool_calls: calls },
      usage: { inputTokens: 100, outputTokens: 10, costUsd: 0 },
    };
  };
}

test('a promised File it button is asked about once, and the offer really lands', { timeout: 180000 }, async (t) => {
  const admin = new Pool({ connectionString: DSN, connectionTimeoutMillis: 2000 });
  try { await admin.query('SELECT 1'); } catch (err) {
    await admin.end();
    if (process.env.TEST_DATABASE_URL) throw err;
    t.skip('PostgreSQL unavailable; set TEST_DATABASE_URL to require this check');
    return;
  }
  const name = `hrbot_offer_${crypto.randomBytes(6).toString('hex')}`;
  await admin.query(`CREATE DATABASE ${name}`);
  const url = new URL(DSN); url.pathname = `/${name}`;
  const pool = new Pool({ connectionString: String(url), max: 8 });
  t.after(async () => {
    await pool.end();
    await admin.query(`DROP DATABASE ${name}`);
    await admin.end();
  });
  await pool.query(fs.readFileSync(require.resolve('../src/db/schema.sql'), 'utf8'));

  const user = async (username, synthetic = false) => (await pool.query(
    `INSERT INTO users (username, password, has_platform_access, is_synthetic) VALUES ($1, 'x', TRUE, $2)
     RETURNING id, username, is_synthetic AS "isSynthetic", has_platform_access AS "hasPlatformAccess", is_admin AS "isAdmin"`,
    [username, synthetic],
  )).rows[0];
  const setting = (key, value) => pool.query(
    `INSERT INTO platform_settings (key, value) VALUES ($1, $2) ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value`,
    [key, value],
  );
  const bot = await user('homeroom_bot', true);
  const drea = await user('drea');
  const { rows: [inserted] } = await pool.query(
    `INSERT INTO apps (name, slug, status, created_by, repo_url, view_visibility, collab_visibility)
     VALUES ('Rilo', 'rilo', 'running', $1, 'https://github.com/usernode-bot/rilo', 'invited', 'invited')
     RETURNING id`,
    [drea.id],
  );
  const { rows: [app] } = await pool.query('SELECT * FROM apps WHERE id = $1', [inserted.id]);
  await pool.query('INSERT INTO community_members (community_id, user_id) VALUES ($1, $2) ON CONFLICT DO NOTHING', [app.community_id, drea.id]);
  // Filing a request needs the collab gate too, which a member of a private
  // project passes as a collaborator.
  await pool.query('INSERT INTO app_collaborators (app_id, user_id, status) VALUES ($1, $2, \'member\') ON CONFLICT DO NOTHING', [app.id, drea.id]);
  await setting('homeroom_bot_mode', 'shadow');

  const settings = await homeroomBot.readSettings(pool);
  const chat = (await conversations.ensureAdmittedDirect(pool, bot.id, drea.id)).conversationId;
  const send = async (person, content, extra = {}) => (await conversations.sendMessage(
    pool, person, chat, { content, ...extra },
  )).message;

  // Drea asks the bot to file her request. The first pass writes the request
  // as text and promises the button; offer_request is never called.
  const seen = [];
  const message = await send(drea, 'Please file a request: week by week tracking in insights');
  const asked = await mayor.runDmTurn(pool, CONFIG, {
    bot, user: drea, settings, conversationId: chat, message,
    deps: { chat: scripted([
      [['reply', { text: 'I\'ve drafted the request below; a File it button will appear under it.' }]],
      [['offer_request', { project: 'Rilo', title: 'Week by week tracking in insights', details: 'Track minutes spent per project, week by week, in the insights screen, with a chart for the last eight weeks.' }],
        ['reply', { text: 'Here is the request I would file on Rilo. Tap File it under it when it appears.' }]],
    ], seen), apiKey: 'sk-test', openMcp: async () => null, seesImages: false },
  });

  // The model was asked twice: the second request carries the check note,
  // with the clause that tells it to make the real offer.
  assert.equal(seen.length, 2, 'the model was asked again');
  assert.ok(seen[1].messages.some((m) => m.role === 'user'
    && /To put a request they can file under your reply, call offer_request with the project, a title and details/.test(m.content)
    && /Then call reply again\.\]$/.test(m.content)), 'the check note asks for the offer');

  // The offer's row is open, and its message is the one that was sent.
  const { rows: [action] } = await pool.query(
    'SELECT kind, status, message_id FROM homeroom_bot_dm_actions WHERE user_id = $1', [drea.id],
  );
  assert.equal(action.kind, 'file_request');
  assert.equal(action.status, 'open');
  assert.equal(action.message_id, asked.messageId, 'the offer names the message it waits under');

  // The sent message carries the confirm card: File it first and filled,
  // Not now beside it, and the answers an older client reads.
  const { rows: [sent] } = await pool.query(
    'SELECT content, metadata FROM conversation_messages WHERE id = $1', [asked.messageId],
  );
  const meta = sent.metadata.homeroomBot;
  assert.equal(meta.kind, 'confirm');
  assert.deepEqual(meta.answers, ['File it', 'Not now']);
  assert.deepEqual(meta.actions.map((a) => [a.id, a.label, a.style, a.type]), [
    ['yes', 'File it', 'primary', 'server'], ['no', 'Not now', 'secondary', 'server'],
  ]);
  assert.match(sent.content, /\*\*Rilo\*\* · new request: Week by week tracking in insights/);

  // Nothing was filed until File it is tapped; the tap files it.
  assert.equal((await pool.query('SELECT COUNT(*)::int AS n FROM issues WHERE app_id = $1', [app.id])).rows[0].n, 0,
    'nothing was filed by the reply');
  const tapped = await send(drea, 'File it', { reply_to_id: asked.messageId });
  const card = await mayor.decideOffer(pool, CONFIG, { bot, user: drea, settings, message: tapped, deps: {} });
  assert.equal(created.length, 1, 'the tap filed it');
  const { rows: [issue] } = await pool.query('SELECT github_issue_number FROM issues WHERE app_id = $1', [app.id]);
  assert.equal(issue.github_issue_number, 41);
  const { rows: [cardMeta] } = await pool.query('SELECT metadata FROM conversation_messages WHERE id = $1', [card.messageId]);
  assert.equal(cardMeta.metadata.homeroomBot.kind, 'activity');
  assert.equal((await pool.query(
    'SELECT status FROM homeroom_bot_dm_actions WHERE user_id = $1', [drea.id],
  )).rows[0].status, 'done');
});
