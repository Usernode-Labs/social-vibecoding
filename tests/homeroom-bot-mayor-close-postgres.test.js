'use strict';

// #4525: a request the Homeroom bot offers to propose closing, from its DM,
// against the full PostgreSQL schema. GitHub is a stub that records what it
// is asked to do. What is checked: the offer (its buttons and the action row
// it stages), and what the tap does: the close_issue proposal filed in the
// tapper's name with the offer's reason, the two system lines its project
// sees, the "Done." answer, and every refusal (Keep it open, a request that
// closed in between, a close vote already open, somebody who left).
//
// Run with: node --test tests/homeroom-bot-mayor-close-postgres.test.js

const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const { Pool } = require('pg');

const DSN = process.env.TEST_DATABASE_URL || process.env.DATABASE_URL
  || 'postgres://postgres:postgres@127.0.0.1:5432/postgres';

const systemMessages = [];
const wsId = require.resolve('../src/services/ws');
require.cache[wsId] = {
  id: wsId, filename: wsId, loaded: true,
  exports: {
    pushConversationEvent(memberIds) { return memberIds.length; },
    pushToUser() { return 1; },
    pushNotificationToUser() { return 1; },
    pushSessionUpdate() {},
    async sendSystemMessage(_pool, appId, content, _type, _meta, thread) {
      systemMessages.push({ appId, content, thread });
      return { id: systemMessages.length };
    },
    pushIssueUpdate() {},
  },
};
const pushId = require.resolve('../src/services/mobile-push');
require.cache[pushId] = {
  id: pushId, filename: pushId, loaded: true,
  exports: { scheduleBadgeSync() { return false; } },
};
const githubId = require.resolve('../src/services/github');
const gh = { issues: new Map() };
const githubStub = {
  isEnabled: () => true,
  async getIssue(owner, repo, number) {
    const issue = gh.issues.get(`${repo}#${number}`);
    if (!issue) throw Object.assign(new Error('Not Found'), { status: 404 });
    return issue;
  },
  async fetchPublicIssue(_owner, _repo, number) { return { issue: { number, title: `Issue ${number}`, state: 'open' } }; },
  async fetchIssueComments() { return { comments: [], truncated: false }; },
  noteIssueCreated() {},
  noteIssuesClosed() {},
  invalidateIssuesCache() {},
  safeMention: (s) => s,
};
require.cache[githubId] = {
  id: githubId, filename: githubId, loaded: true,
  exports: new Proxy(githubStub, { get: (t, k) => (k in t ? t[k] : async () => null) }),
};

const conversations = require('../src/services/conversations');
const mayor = require('../src/services/homeroom-bot-mayor');
const homeroomBot = require('../src/services/homeroom-bot');

const CONFIG = { openrouterApiBase: 'https://openrouter.test/api/v1', openrouterOrigin: 'https://test', openrouterDefaultCodexModel: 'z-ai/glm-5.3-flash' };

function scripted(steps) {
  let i = 0;
  return async () => {
    const step = steps[Math.min(i, steps.length - 1)];
    i += 1;
    const calls = step.map((c, n) => ({
      id: `call_${i}_${n}`, type: 'function', function: { name: c[0], arguments: JSON.stringify(c[1] || {}) },
    }));
    return {
      content: '', toolCalls: calls,
      assistantMessage: { role: 'assistant', content: null, tool_calls: calls },
      usage: { inputTokens: 100, outputTokens: 10, costUsd: 0.0001 },
    };
  };
}

test('#4525: the bot offers to propose closing a request, and the tap files the close vote', { timeout: 180000 }, async (t) => {
  const admin = new Pool({ connectionString: DSN, connectionTimeoutMillis: 2000 });
  try { await admin.query('SELECT 1'); } catch (err) {
    await admin.end();
    if (process.env.TEST_DATABASE_URL) throw err;
    t.skip('PostgreSQL unavailable; set TEST_DATABASE_URL to require this check');
    return;
  }
  const name = `hrbot_close_${crypto.randomBytes(6).toString('hex')}`;
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
  async function project(slug, owner, { members = [] } = {}) {
    const { rows: [inserted] } = await pool.query(
      `INSERT INTO apps (name, slug, status, created_by, repo_url, view_visibility, collab_visibility)
       VALUES ($1, $2, 'running', $3, $4, 'public', 'public') RETURNING id`,
      [slug.replace(/-/g, ' ').replace(/^./, (c) => c.toUpperCase()), slug, owner.id,
        `https://github.com/usernode-bot/${slug}`],
    );
    const { rows: [app] } = await pool.query('SELECT * FROM apps WHERE id = $1', [inserted.id]);
    for (const member of [owner, ...members]) {
      await pool.query(
        'INSERT INTO community_members (community_id, user_id) VALUES ($1, $2) ON CONFLICT DO NOTHING',
        [app.community_id, member.id],
      );
    }
    return app;
  }

  const bot = await user('homeroom_bot', { synthetic: true });
  const ada = await user('ada');
  const pat = await user('pat');
  const ears = await project('ear-trainer', ada, { members: [] });
  await setting('homeroom_bot_mode', 'shadow');
  const settings = await homeroomBot.readSettings(pool);
  const opened = await conversations.ensureAdmittedDirect(pool, bot.id, ada.id);
  const workflow = { governsKind: () => false, async fileProposal() {} };
  const deps = { bot, workflow, domain: 'app.test' };

  // A request on Ear Trainer, done as far as Ada is concerned.
  async function request(n, { by = ada, title = `Header ${n}`, body = 'The header frame covers the app.' } = {}) {
    gh.issues.set(`ear-trainer#${n}`, { number: n, state: 'open', title, body, user: { login: 'usernode-bot' } });
    await pool.query(
      `INSERT INTO issues (app_id, github_issue_number, title, description, kind, payload, created_by)
       VALUES ($1, $2, $3, $4, 'general', '{}', $5)`,
      [ears.id, n, title, body, by.id],
    );
  }
  async function turn(text, steps) {
    const { message } = await conversations.sendMessage(pool, ada, opened.conversationId, { content: text });
    return mayor.runDmTurn(pool, CONFIG, {
      bot, user: ada, settings, conversationId: opened.conversationId, message,
      deps: {
        chat: scripted(steps), apiKey: 'sk-test', sleep: async () => {}, schedule: () => {},
        openMcp: async () => { throw new Error('no grant'); }, domain: 'app.test',
      },
    });
  }
  async function read(sent) {
    return conversations.getMessage(pool, ada, opened.conversationId, sent.messageId);
  }
  const actionOf = async (messageId) => (await pool.query(
    'SELECT * FROM homeroom_bot_dm_actions WHERE message_id = $1', [messageId],
  )).rows[0];
  const tap = (action, choice, who = ada) => mayor.decideOfferTap(pool, CONFIG, {
    user: who, actionId: action.id, choice, deps,
  });
  const lastMessage = async () => (await pool.query(
    'SELECT content FROM conversation_messages WHERE conversation_id = $1 ORDER BY id DESC LIMIT 1', [opened.conversationId],
  )).rows[0].content;
  const closeVotes = async (n) => (await pool.query(
    `SELECT id, title, payload, created_by, status FROM issues
      WHERE app_id = $1 AND kind = 'close_issue' AND (payload->>'issueNumber')::int = $2`, [ears.id, n],
  )).rows;

  await t.test('the offer stages nothing; Propose to close files the close vote in their name', async () => {
    await request(6, { title: 'Header covers the app' });
    const offered = await turn('request #6 is done, can you propose closing it?', [
      [['offer_close_request', { project: 'ear-trainer', number: 6, reason: 'It is done already' }]],
      [['reply', { text: 'Tap Propose to close below.' }]],
    ]);
    const sent = await read(offered);
    const meta = sent.metadata.homeroomBot;
    assert.deepEqual(meta.actions.map((a) => a.label), ['Propose to close', 'Keep it open']);
    assert.equal(meta.question, 'Propose closing this request on Ear trainer?');
    assert.match(sent.content, /Tap Propose to close below\./);
    assert.match(sent.content, /I can't close it myself: closing it goes to the project's group as a vote, and it closes only if they approve\.$/);
    const action = await actionOf(offered.messageId);
    assert.deepEqual([action.kind, action.source_issue_number, action.app_id, action.title, action.details],
      ['close_request', 6, ears.id, 'Header covers the app', 'It is done already']);
    assert.equal(meta.actionId, Number(action.id));
    assert.deepEqual(await closeVotes(6), [], 'nothing is proposed before the tap');

    assert.deepEqual(await tap(action, 'yes'), { ok: true, choice: 'yes', label: 'Propose to close' });
    const [vote] = await closeVotes(6);
    assert.equal(vote.status, 'open');
    assert.equal(vote.created_by, ada.id, 'proposed in the tapper\'s name');
    assert.equal(vote.payload.issueNumber, 6);
    assert.equal(vote.payload.reason, 'It is done already');
    assert.equal(vote.title, 'Close issue #6: "Header covers the app"');
    assert.ok(systemMessages.some((m) => m.thread?.type === 'governance' && m.thread.ref === vote.id
      && /ada_\d+ proposed closing issue #6/.test(m.content)), 'the project sees the governance line');
    assert.ok(systemMessages.some((m) => m.thread?.type === 'issue' && m.thread.ref === 6
      && /proposed closing issue #6/.test(m.content)), 'and on the request itself');
    const decided = await pool.query('SELECT status, issue_number FROM homeroom_bot_dm_actions WHERE id = $1', [action.id]);
    assert.deepEqual(decided.rows[0], { status: 'done', issue_number: vote.id }, 'the action row records the close proposal');
    const ack = await lastMessage();
    assert.match(ack, /^\*\*Ear trainer\*\* · request #6: Header covers the app\n\nDone\. Closing it is now up for the group's vote: they'll see it on the request's page, and it closes only if they approve\.$/);
    assert.equal((await tap(action, 'yes')).status, 409, 'decided once');

    // A typed "close it", sent as a reply to the decided offer, is told,
    // not filed again.
    const { message: again } = await conversations.sendMessage(pool, ada, opened.conversationId, {
      content: 'Propose to close', reply_to_id: offered.messageId,
    });
    await mayor.decideOffer(pool, CONFIG, { bot, user: ada, settings, deps, message: again });
    assert.match(await lastMessage(), /^That one is already decided\.$/);
    assert.equal((await closeVotes(6)).length, 1, 'no second proposal');
  });

  await t.test('Keep it open decides nothing and files nothing', async () => {
    await request(7);
    const offered = await turn('propose closing #7 please', [
      [['offer_close_request', { project: 'ear-trainer', number: 7, reason: 'Done' }]],
      [['reply', { text: 'Tap below.' }]],
    ]);
    const offer = await read(offered);
    const action = await actionOf(offered.messageId);
    assert.deepEqual(await tap(action, 'no'), { ok: true, choice: 'no', label: 'Keep it open' });
    assert.deepEqual(await closeVotes(7), []);
    assert.equal((await actionOf(offered.messageId)).status, 'declined');
    assert.equal(await lastMessage(), offer.content, 'a tapped no needs no reply: the buttons show it');

    // The typed words reach the same decision, and are answered.
    await request(8);
    const offered2 = await turn('propose closing #8 too', [
      [['offer_close_request', { project: 'ear-trainer', number: 8, reason: 'Done' }]],
      [['reply', { text: 'Tap below.' }]],
    ]);
    const { message: typed } = await conversations.sendMessage(pool, ada, opened.conversationId, { content: 'keep it open' });
    await mayor.decideTyped(pool, CONFIG, { bot, user: ada, settings, conversationId: opened.conversationId, message: typed, deps });
    assert.deepEqual(await closeVotes(8), []);
    assert.equal((await actionOf(offered2.messageId)).status, 'declined');
    assert.match(await lastMessage(), /^OK, I'll leave it open\.$/);
  });

  await t.test('a close vote already open is refused at offer time', async () => {
    await request(9);
    await pool.query(
      `INSERT INTO issues (app_id, github_issue_number, title, description, kind, payload, created_by)
       VALUES ($1, NULL, 'Close issue #9: "Header 9"', 'Already asked on its page.', 'close_issue', '{"issueNumber":9}', $2)`,
      [ears.id, ada.id],
    );
    const refused = await turn('propose closing #9', [
      [['offer_close_request', { project: 'ear-trainer', number: 9, reason: 'Done' }]],
      [['reply', { text: 'There is already a vote on closing that one.' }]],
    ]);
    assert.equal((await read(refused)).metadata.homeroomBot.kind, 'chat', 'no offer under it');
  });

  await t.test('a request that closed in between is refused at the tap, and the action says so', async () => {
    await request(10);
    const offered = await turn('propose closing #10', [
      [['offer_close_request', { project: 'ear-trainer', number: 10, reason: 'Done' }]],
      [['reply', { text: 'Tap below.' }]],
    ]);
    const action = await actionOf(offered.messageId);
    gh.issues.get('ear-trainer#10').state = 'closed';
    assert.equal((await tap(action, 'yes')).ok, true);
    assert.deepEqual(await closeVotes(10), []);
    const { rows: [failed] } = await pool.query('SELECT status, error FROM homeroom_bot_dm_actions WHERE id = $1', [action.id]);
    assert.equal(failed.status, 'failed');
    assert.equal(failed.error, 'closed');
    assert.match(await lastMessage(), /^I couldn't propose it: That request is already closed\.$/);
  });

  await t.test('somebody who is no longer a member is told to join first, and nothing is filed', async () => {
    await request(11);
    // The offer requires membership, so this one is staged by hand: Pat was
    // a member when it was offered and has left since.
    const { rows: [staged] } = await pool.query(
      `INSERT INTO homeroom_bot_dm_actions (user_id, conversation_id, app_id, kind, title, details, source_issue_number)
       VALUES ($1, $2, $3, 'close_request', 'Header 11', 'Done', 11) RETURNING id`,
      [pat.id, opened.conversationId, ears.id],
    );
    const patsChat = await conversations.ensureAdmittedDirect(pool, bot.id, pat.id);
    assert.equal((await tap(staged, 'yes', pat)).ok, true);
    assert.deepEqual(await closeVotes(11), []);
    const { rows: [failed] } = await pool.query('SELECT status, error FROM homeroom_bot_dm_actions WHERE id = $1', [staged.id]);
    assert.equal(failed.status, 'failed');
    assert.equal(failed.error, 'join_required');
    const line = await pool.query(
      'SELECT content FROM conversation_messages WHERE conversation_id = $1 ORDER BY id DESC LIMIT 1',
      [patsChat.conversationId],
    );
    assert.match(line.rows[0].content, /you need to be a member of that project first\. You can join it from its page\./);
  });

  await t.test('the gates, seen by the tool the model calls', async () => {
    const move = require('../src/services/homeroom-bot-move');
    assert.equal((await move.closeGate(pool, { app: ears, issueNumber: 0 })).code, 'not_found');
    assert.equal((await move.closeGate(pool, { app: ears, issueNumber: 999 })).code, 'not_found', 'a request GitHub has never heard of');
    assert.equal((await move.closeGate(pool, { app: { id: ears.id, slug: 'ear-trainer', repo_url: null }, issueNumber: 6 })).code, 'unreadable');
    await request(12);
    gh.issues.get('ear-trainer#12').state = 'closed';
    assert.equal((await move.closeGate(pool, { app: ears, issueNumber: 12 })).code, 'closed');
    await request(13);
    const gate = await move.closeGate(pool, { app: ears, issueNumber: 13 });
    assert.equal(gate.ok, true);
    assert.equal(gate.issue.title, 'Header 13');
    // A pull request is not a request.
    gh.issues.set('ear-trainer#14', { number: 14, state: 'open', title: 'PR', pull_request: {} });
    assert.equal((await move.closeGate(pool, { app: ears, issueNumber: 14 })).code, 'not_found');

    // A non-member gets no offer at all, with the join wording.
    const refused = await mayor.offerCloseRequest(pool, {
      user: pat, appIds: new Set(), deps: {},
    }, { project: 'ear-trainer', number: 13, reason: 'Done' });
    assert.match(refused.error, /not a member of Ear trainer/);
    assert.match(refused.error, /They can join it from its page\./);
  });
});
