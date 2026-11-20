'use strict';

// 20 Nov 2026 (live-draft review, C): Homeroom bot offers a live draft's
// Propose, and once it is up for a vote its Update proposal, as a card under
// its reply (offer_propose_draft), and only the person's tap does it
// (decideDraftProposal). Against the full PostgreSQL schema: the turn offers
// the tool only with the thread's draft loaded, the card is a bot_cards row
// of its own kind naming the draft, a tap asks the draft store (a stand-in
// recording what it was asked) as the person, Not yet asks nothing, and a
// plain "yes" typed under the card decides nothing.
//
// Run with: node --test tests/live-draft-propose-offer-postgres.test.js

const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const { Pool } = require('pg');

const DSN = process.env.TEST_DATABASE_URL || process.env.DATABASE_URL
  || 'postgres://postgres:postgres@127.0.0.1:5432/postgres';

const wsId = require.resolve('../src/services/ws');
require.cache[wsId] = {
  id: wsId, filename: wsId, loaded: true,
  exports: {
    pushConversationEvent(memberIds) { return memberIds.length; },
    pushToUser() { return 1; },
    pushNotificationToUser() { return 1; },
    pushSessionUpdate() {},
    async sendSystemMessage() { return { id: 1 }; },
    pushIssueUpdate() {},
  },
};
const pushId = require.resolve('../src/services/mobile-push');
require.cache[pushId] = {
  id: pushId, filename: pushId, loaded: true,
  exports: { scheduleBadgeSync() { return false; } },
};

const conversations = require('../src/services/conversations');
const mayor = require('../src/services/homeroom-bot-mayor');
const homeroomBot = require('../src/services/homeroom-bot');
const liveDrafts = require('../src/services/live-drafts');

const CONFIG = { openrouterApiBase: 'https://openrouter.test/api/v1', openrouterOrigin: 'https://test', openrouterDefaultCodexModel: 'z-ai/glm-5.3-flash' };
const SHA = (c) => c.repeat(40);

/** A model that calls `steps` in order, and keeps the tools each request offered. */
function scripted(steps, offered) {
  let i = 0;
  return async (opts) => {
    offered.push((opts.tools || []).map((tool) => tool.function.name));
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

// The draft capability, standing in for live-draft-bot.js: its code tools
// are not what this checks.
const draftBot = {
  NO_CODE_TEXT: 'Its code cannot be read just now.',
  DONE_TEXT: 'Done.',
  async openSession(_pool, _config, { draft }) {
    return {
      capability: 'draft', draft, projectName: draft.app_name, prompt: 'THIS THREAD\'S LIVE DRAFT (a stand-in).',
      owns: () => false, tools: () => [], beforeReply: async () => null, saved: () => false,
      meta: () => ({ liveDraft: { id: Number(draft.id), app: draft.app_slug } }),
      facts: () => ({ liveDraft: true, draftSaved: false, draftPlatform: false }),
    };
  },
};

test('C: a live draft\'s Propose and Update proposal, offered under the reply and done by the tap', { timeout: 180000 }, async (t) => {
  const admin = new Pool({ connectionString: DSN, connectionTimeoutMillis: 2000 });
  try { await admin.query('SELECT 1'); } catch (err) {
    await admin.end();
    if (process.env.TEST_DATABASE_URL) throw err;
    t.skip('PostgreSQL unavailable; set TEST_DATABASE_URL to require this check');
    return;
  }
  const name = `draft_offer_${crypto.randomBytes(6).toString('hex')}`;
  await admin.query(`CREATE DATABASE ${name}`);
  const url = new URL(DSN); url.pathname = `/${name}`;
  const pool = new Pool({ connectionString: String(url), max: 8 });
  t.after(async () => {
    await pool.end();
    await admin.query(`DROP DATABASE ${name}`);
    await admin.end();
  });
  await require('../src/db/schema-migrations').applySchemaWithLockRetry(pool);
  await require('../src/db/reference-data').seedReferenceData(pool);
  await require('../src/db/schema-migrations').applySchemaWithLockRetry(pool);

  const user = async (username, { synthetic = false } = {}) => (await pool.query(
    `INSERT INTO users (username, password, has_platform_access, is_synthetic)
     VALUES ($1, 'x', TRUE, $2) RETURNING id, username`, [username, synthetic],
  )).rows[0];
  const bot = await user('homeroom_bot', { synthetic: true });
  const evan = await user('evan');
  const { rows: [{ id: appId }] } = await pool.query(
    `INSERT INTO apps (name, slug, status, created_by, repo_url, view_visibility, collab_visibility)
     VALUES ('Gym Tracker', 'gym-tracker', 'running', $1, 'https://github.com/usernode-bot/gym-tracker', 'public', 'public') RETURNING id`,
    [evan.id],
  );
  const { rows: [app] } = await pool.query('SELECT * FROM apps WHERE id = $1', [appId]);
  await pool.query('INSERT INTO community_members (community_id, user_id) VALUES ($1, $2) ON CONFLICT DO NOTHING', [app.community_id, evan.id]);
  await pool.query(
    `INSERT INTO platform_settings (key, value) VALUES ('homeroom_bot_mode', 'shadow')
     ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value`,
  );
  const settings = await homeroomBot.readSettings(pool);
  const opened = await conversations.ensureAdmittedDirect(pool, bot.id, evan.id);

  // The draft: two saved changes, its preview up.
  const { rows: [{ id: draftId }] } = await pool.query(
    `INSERT INTO live_drafts (app_id, user_id, root_message_id, state, base_sha, head_sha, edits, live_state)
     VALUES ($1, $2, 0, 'open', $3, $4, 2, 'live') RETURNING id`,
    [appId, evan.id, SHA('0'), SHA('b')],
  );
  await pool.query(
    `INSERT INTO live_draft_edits (draft_id, commit_sha, summary) VALUES ($1, $2, 'Delete button on each set'), ($1, $3, 'Bigger delete button')`,
    [draftId, SHA('a'), SHA('b')],
  );

  // What the tap asks the draft store, which answers as the real one does.
  const asked = [];
  const store = {
    async propose(_pool, _config, args) {
      asked.push(['propose', args.draftId, args.user.id, args.title]);
      return { status: 200, body: { ok: true, draft: { app: { name: 'Gym Tracker' }, proposal: { sessionId: null, prNumber: null } } } };
    },
    async updateProposal(_pool, _config, args) {
      asked.push(['update', args.draftId, args.user.id]);
      return { status: 200, body: { ok: true, draft: { app: { name: 'Gym Tracker' }, proposal: { sessionId: null, prNumber: 142 } } } };
    },
  };
  const replies = {
    async tapDmAction(a) {
      await mayor.actOnTap(pool, CONFIG, { ...a, key: `action:${a.actionId}`, deps: { bot, liveDrafts: store } });
      return { ok: true };
    },
  };

  // A turn in the draft's thread: their message is the thread's root.
  async function turn(text, steps, { withDraft = true } = {}) {
    const { message } = await conversations.sendMessage(pool, evan, opened.conversationId, { content: text });
    await pool.query('UPDATE live_drafts SET root_message_id = $2 WHERE id = $1', [draftId, message.id]);
    const offered = [];
    const sent = await mayor.runDmTurn(pool, CONFIG, {
      bot, user: evan, settings, conversationId: opened.conversationId, message,
      deps: {
        chat: scripted(steps, offered), apiKey: 'sk-test', sleep: async () => {}, schedule: () => {},
        openMcp: async () => { throw new Error('no grant'); }, domain: 'app.test', draftBot,
        threadRootId: message.id,
        ...(withDraft ? { threadLiveDraft: await liveDrafts.byId(pool, draftId) } : {}),
      },
    });
    return { sent, offered };
  }
  const read = async (sent) => conversations.getMessage(pool, evan, opened.conversationId, sent.messageId);
  const cardOf = async (messageId) => (await pool.query('SELECT * FROM bot_cards WHERE message_id = $1', [messageId])).rows[0];
  const tap = (card, choice) => mayor.decideOfferTap(pool, CONFIG, { user: evan, actionId: card.id, choice, deps: { bot, replies } });

  await t.test('the tool is offered only with the thread\'s draft loaded', async () => {
    const { offered } = await turn('what is new?', [[['reply', { text: 'Nothing yet.' }]]], { withDraft: false });
    assert.ok(offered.length > 0);
    for (const tools of offered) assert.ok(!tools.includes('offer_propose_draft'), 'no draft, no Propose');
    const { offered: withDraft } = await turn('how is it looking?', [[['reply', { text: 'It looks right.' }]]]);
    assert.ok(withDraft.every((tools) => tools.includes('offer_propose_draft')));
  });

  await t.test('Propose: a card under the reply, and only the tap proposes it, as them', async () => {
    const { sent } = await turn('looks good, can we make this a proposal now?', [
      [['offer_propose_draft', { title: 'A clearer delete button' }]],
      [['reply', { text: 'It is ready.' }]],
    ]);
    const message = await read(sent);
    const meta = message.metadata.homeroomBot;
    assert.deepEqual(meta.actions.map((a) => a.label), ['Propose', 'Not yet']);
    assert.equal(meta.question, 'Propose this draft of Gym Tracker?');
    assert.equal(meta.liveDraft.id, Number(draftId), 'the reply still names its draft');
    assert.equal(message.content, 'It is ready.\n\n**Gym Tracker** · a proposal from this draft: A clearer delete button\n\n'
      + '2 changes. The project\'s group votes on it, and this draft stays open here for more.');
    const card = await cardOf(sent.messageId);
    assert.deepEqual([card.kind, card.app_id, card.args], ['propose_draft', Number(appId), { draftId: Number(draftId), title: 'A clearer delete button' }]);
    assert.equal(meta.actionId, Number(card.id));
    assert.equal(asked.length, 0, 'nothing is proposed before the tap');

    // A plain yes typed under it decides nothing: the tap does.
    const { message: yes } = await conversations.sendMessage(pool, evan, opened.conversationId, { content: 'yes' });
    assert.equal(await mayor.decideTyped(pool, CONFIG, {
      bot, user: evan, settings, conversationId: opened.conversationId, message: yes, deps: { bot },
    }), null);
    assert.equal(asked.length, 0);
    assert.equal((await cardOf(sent.messageId)).status, 'open');

    assert.deepEqual(await tap(card, 'yes'), { ok: true, choice: 'yes', label: 'Propose' });
    assert.deepEqual(asked, [['propose', Number(draftId), Number(evan.id), 'A clearer delete button']]);
    assert.equal((await cardOf(sent.messageId)).status, 'done');
    const outcome = (await read(sent)).metadata.homeroomBot.outcome;
    assert.equal(outcome.state, 'done');
    assert.match(outcome.text, /^It is going up for a vote on Gym Tracker\. The draft stays open here/);
    assert.equal((await tap(card, 'yes')).status, 409, 'decided once');
    assert.equal(asked.length, 1);
  });

  await t.test('Update proposal: for a draft up for a vote, and Not yet asks nothing', async () => {
    const { rows: [{ id: proposalId }] } = await pool.query(
      `INSERT INTO chat_sessions (app_id, user_id, status, is_headless, linked_issues, session_title, pr_number)
       VALUES ($1, $2, 'promoted', FALSE, '{}', 'A clearer delete button', 142) RETURNING id`, [appId, evan.id],
    );
    await pool.query(
      `UPDATE live_drafts SET state = 'proposed', proposal_session_id = $2, proposed_head_sha = $3, head_sha = $4, edits = 3
        WHERE id = $1`, [draftId, proposalId, SHA('b'), SHA('c')],
    );
    await pool.query('INSERT INTO live_draft_edits (draft_id, commit_sha, summary) VALUES ($1, $2, \'Red confirm step\')', [draftId, SHA('c')]);
    const { sent } = await turn('put that in the proposal', [
      [['offer_propose_draft', {}]],
      [['reply', { text: 'Tap below when you are ready.' }]],
    ]);
    const message = await read(sent);
    assert.deepEqual(message.metadata.homeroomBot.actions.map((a) => a.label), ['Update proposal', 'Not yet']);
    assert.equal(message.metadata.homeroomBot.question, 'Update PR #142 with the changes since?');
    assert.match(message.content, /\*\*Gym Tracker\*\* · PR #142: 1 change not in it yet\n\nUpdating it clears its votes and runs its checks again\.$/);
    const card = await cardOf(sent.messageId);
    assert.equal(card.kind, 'update_draft_proposal');

    // Not yet: nothing asked, the card says what it left.
    assert.deepEqual(await tap(card, 'no'), { ok: true, choice: 'no', label: 'Not yet' });
    assert.equal(asked.length, 1, 'only the earlier Propose');
    assert.equal((await read(sent)).metadata.homeroomBot.outcome.text, 'Not updated. The proposal stays as it is.');

    const again = await turn('ok now update it', [[['offer_propose_draft', {}]], [['reply', { text: 'Here it is.' }]]]);
    await tap(await cardOf(again.sent.messageId), 'yes');
    assert.deepEqual(asked[1], ['update', Number(draftId), Number(evan.id)]);
    assert.match((await read(again.sent)).metadata.homeroomBot.outcome.text, /^PR #142 has the draft's changes now\. Its votes were cleared/);
  });
});
