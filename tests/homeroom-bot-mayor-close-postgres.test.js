'use strict';

// #4525: a person asks the Homeroom bot in chat to close one of their
// requests, and the bot offers to open a vote on closing it. Against the
// full PostgreSQL schema, with GitHub a stub that records what it is asked
// to do. What is checked: the offer (the chat model's offer_close_request,
// with Propose to close and Keep it open under it) and what the tap does:
// the same close_issue proposal the request page opens, proposed by whoever
// tapped, with its governance and request thread lines; nothing at all for
// Keep it open; and each way it is refused, at the offer and at the tap.
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
  async createIssue(owner, repo, { title }) {
    return { number: 900, title };
  },
  async createIssueComment() { return { id: 1 }; },
  async closeIssue() { return {}; },
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

test('#4525: an offer to open a vote on closing a request, decided by its tap', { timeout: 180000 }, async (t) => {
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
  const sam = await user('sam');
  const ears = await project('ear-trainer', ada, { members: [sam] });
  await setting('homeroom_bot_mode', 'shadow');
  const settings = await homeroomBot.readSettings(pool);
  const opened = await conversations.ensureAdmittedDirect(pool, bot.id, ada.id);
  const workflow = { governsKind: () => false, async fileProposal() {} };

  // A request on Ear Trainer, open on GitHub.
  async function request(n, { title = `Tone ${n}`, state = 'open', pullRequest = false } = {}) {
    const raw = { number: n, state, title, body: 'The tones are thin.', user: { login: 'ada' } };
    if (pullRequest) raw.pull_request = {};
    gh.issues.set(`ear-trainer#${n}`, raw);
    await pool.query(
      `INSERT INTO issues (app_id, github_issue_number, title, description, kind, payload, created_by)
       VALUES ($1, $2, $3, $4, 'general', '{}', $5)`,
      [ears.id, n, title, 'The tones are thin.', ada.id],
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
  const closeVotes = () => pool.query(
    `SELECT payload, created_by, status FROM issues WHERE app_id = $1 AND kind = 'close_issue' ORDER BY id`, [ears.id],
  );
  const tap = (action, choice, who = ada) => mayor.decideOfferTap(pool, CONFIG, {
    user: who, actionId: action.id, choice, deps: { bot, workflow, domain: 'app.test' },
  });
  const lastAck = () => pool.query(
    'SELECT content FROM conversation_messages WHERE conversation_id = $1 ORDER BY id DESC LIMIT 1', [opened.conversationId],
  );

  await t.test('the chat model offers it; Propose to close opens the request page\'s close vote', async () => {
    await request(6, { title: 'Richer synth tones' });
    const offered = await turn('that tone request is done already, propose to close it', [
      [['offer_close_request', { project: 'ear-trainer', number: 6, reason: 'It was done already in #4417.' }]],
      [['reply', { text: 'Want me to open a vote on closing it?' }]],
    ]);
    const meta = (await read(offered)).metadata.homeroomBot;
    assert.deepEqual(meta.actions.map((a) => a.label), ['Propose to close', 'Keep it open']);
    assert.equal(meta.question, 'Propose closing request #6 on Ear trainer?');
    assert.match((await read(offered)).content,
      /^Want me to open a vote on closing it\?\n\n\*\*Ear trainer\*\* · request #6: Richer synth tones\n\nWhy: It was done already in #4417\.$/);
    const action = await actionOf(offered.messageId);
    assert.deepEqual([action.kind, action.source_issue_number, action.app_id, action.title],
      ['close_request', 6, ears.id, 'Richer synth tones']);
    assert.equal(meta.actionId, Number(action.id));
    assert.equal((await closeVotes()).rows.length, 0, 'nothing is proposed before the tap');

    assert.deepEqual(await tap(action, 'yes'), { ok: true, choice: 'yes', label: 'Propose to close' });
    const { rows: [vote] } = await closeVotes();
    assert.equal(vote.status, 'open');
    assert.equal(vote.created_by, ada.id, 'the tapper is its proposer');
    assert.equal(vote.payload.issueNumber, 6);
    assert.equal(vote.payload.reason, 'It was done already in #4417.');
    assert.equal(vote.payload.issueTitle, 'Richer synth tones');
    assert.ok(systemMessages.some((m) => m.thread?.type === 'governance' && m.thread.ref
      && /proposed closing issue #6/.test(m.content)), 'a line on the project\'s vote list');
    assert.ok(systemMessages.some((m) => m.thread?.type === 'issue' && m.thread.ref === 6
      && /proposed closing issue #6/.test(m.content)), 'a line on the request\'s discussion');
    const decided = await pool.query('SELECT status FROM homeroom_bot_dm_actions WHERE id = $1', [action.id]);
    assert.equal(decided.rows[0].status, 'done');
    const ack = await lastAck();
    assert.match(ack.rows[0].content, /^Done\. I opened a vote on closing request #6 on Ear trainer\. It closes if its group votes for it\.$/);
    assert.equal((await tap(action, 'yes')).status, 409, 'decided once');
    assert.equal((await closeVotes()).rows.length, 1, 'no second vote');
  });

  await t.test('typed words decide it as the tap does', async () => {
    await request(7, { title: 'Header spacing' });
    const offered = await turn('close #7 please', [
      [['offer_close_request', { project: 'ear-trainer', number: 7, reason: 'Done.' }]],
      [['reply', { text: 'Tap below.' }]],
    ]);
    assert.equal((await closeVotes()).rows.length, 1, 'from the first test\'s tap');
    const { message } = await conversations.sendMessage(pool, ada, opened.conversationId, { content: 'propose to close' });
    const sent = await mayor.decideTyped(pool, CONFIG, {
      bot, user: ada, settings, conversationId: opened.conversationId, message, deps: { bot, workflow, domain: 'app.test' },
    });
    assert.ok(sent, 'the typed words decided the offer');
    const { rows: votes } = await closeVotes();
    assert.equal(votes.length, 2);
    assert.equal(votes[1].payload.issueNumber, 7);
  });

  await t.test('Keep it open proposes nothing', async () => {
    await request(8, { title: 'Loudness slider' });
    const offered = await turn('close #8 too', [
      [['offer_close_request', { project: 'ear-trainer', number: 8, reason: 'Done.' }]],
      [['reply', { text: 'Tap below.' }]],
    ]);
    const before = (await closeVotes()).rows.length;
    assert.deepEqual(await tap(await actionOf(offered.messageId), 'no'), { ok: true, choice: 'no', label: 'Keep it open' });
    assert.equal((await closeVotes()).rows.length, before);
    assert.equal((await actionOf(offered.messageId)).status, 'declined');
  });

  await t.test('a vote already open, a request already closed, a pull request and a missing request are refused', async () => {
    // A vote is already open for #6: the gate refuses it at offer time.
    const refused = await turn('close #6 as well', [
      [['offer_close_request', { project: 'ear-trainer', number: 6, reason: 'Done.' }]],
      [['reply', { text: 'A vote on closing it is already open, so I can\'t offer one.' }]],
    ]);
    assert.equal((await read(refused)).metadata.homeroomBot.kind, 'chat', 'no offer under it');
    // A closed request and a pull request are refused at offer time too.
    await request(9, { state: 'closed' });
    assert.equal((await mayor.closeGate(pool, { app: ears, issueNumber: 9, user: ada })).code, 'closed');
    await request(10, { pullRequest: true });
    assert.equal((await mayor.closeGate(pool, { app: ears, issueNumber: 10, user: ada })).code, 'not_found');
    assert.equal((await mayor.closeGate(pool, { app: ears, issueNumber: 999, user: ada })).code, 'not_found');
    // Between the offer and the tap: someone else proposes closing it.
    await request(11, { title: 'Late race' });
    const offered = await turn('close #11', [
      [['offer_close_request', { project: 'ear-trainer', number: 11, reason: 'Done.' }]],
      [['reply', { text: 'Tap below.' }]],
    ]);
    await pool.query(
      `INSERT INTO issues (app_id, github_issue_number, title, description, kind, payload, created_by)
       VALUES ($1, NULL, 'Close issue #11: "Late race"', 'Done.', 'close_issue', $2, $3)`,
      [ears.id, JSON.stringify({ issueNumber: 11, issueTitle: 'Late race', reason: 'Sam got there first.' }), sam.id],
    );
    assert.deepEqual(await tap(await actionOf(offered.messageId), 'yes'), { ok: true, choice: 'yes', label: 'Propose to close' });
    const ack = await lastAck();
    assert.equal(ack.rows[0].content, 'A vote on closing it is already open.');
    assert.equal((await closeVotes()).rows.filter((v) => v.payload.issueNumber === 11).length, 1, 'nothing is duplicated');
    const action = await actionOf(offered.messageId);
    assert.equal(action.status, 'failed');
  });

  await t.test('a person who left the project is told to join first', async () => {
    await request(12, { title: 'MIDI import' });
    const offered = await turn('close #12', [
      [['offer_close_request', { project: 'ear-trainer', number: 12, reason: 'Done.' }]],
      [['reply', { text: 'Tap below.' }]],
    ]);
    await pool.query('DELETE FROM community_members WHERE user_id = $1', [ada.id]);
    assert.deepEqual(await tap(await actionOf(offered.messageId), 'yes'), { ok: true, choice: 'yes', label: 'Propose to close' });
    const ack = await lastAck();
    assert.equal(ack.rows[0].content,
      'I couldn\'t propose closing it: you need to be a member of that project first. You can join it from its page.');
    assert.equal((await closeVotes()).rows.filter((v) => v.payload.issueNumber === 12).length, 0);
    await pool.query('INSERT INTO community_members (community_id, user_id) VALUES ($1, $2)', [ears.community_id, ada.id]);
  });
});
