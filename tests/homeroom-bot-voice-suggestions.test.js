'use strict';

// 3 Nov 2026 (#6213): Homeroom bot's answers in a request's or a change's
// discussion end with suggested replies the people it answered tap to send
// as their own. Pinned here: only those places get the tool's field, the
// prompt asks for it there only, and say() stores the prompts for the
// people it answered, never beside an offer's Yes/No.

const test = require('node:test');
const assert = require('node:assert/strict');

const voice = require('../src/services/homeroom-bot-voice');

test('only a request\'s or a change\'s discussion offers suggestions', () => {
  for (const place of [{ type: 'issue', ref: 1 }, { type: 'session', ref: 2 }]) {
    const reply = voice.toolsFor(place).find((t) => t.function.name === 'reply');
    assert.ok(reply.function.parameters.properties.suggestions, `${place.type} offers them`);
    assert.equal(reply.function.parameters.properties.suggestions.type, 'array');
    assert.equal(reply.function.parameters.properties.suggestions.maxItems, 3);
  }
  for (const place of [{ type: 'chat', ref: null }, { type: 'category', ref: 1 }, { type: 'message', ref: 2 }]) {
    const reply = voice.toolsFor(place).find((t) => t.function.name === 'reply');
    assert.equal(reply.function.parameters.properties.suggestions, undefined, `${place.type} keeps its behaviour`);
  }
});

test('the prompt asks for suggestions in a request or a change, and nowhere else', () => {
  const tools = voice.toolsFor({ type: 'issue', ref: 1 });
  const issue = voice.systemPrompt({ app: { slug: 'x', name: 'X' }, place: { type: 'issue', ref: 1 }, tools });
  assert.match(issue, /End the reply with one to three short things/);
  assert.match(issue, /Leave them out when the conversation has plainly\s+ended/);
  const chatTools = voice.toolsFor({ type: 'chat', ref: null });
  const chat = voice.systemPrompt({ app: { slug: 'x', name: 'X' }, place: { type: 'chat', ref: null }, tools: chatTools });
  assert.doesNotMatch(chat, /End the reply with one to three short things/);
});

// ── say() ────────────────────────────────────────────────────────────────

function sayPool() {
  return {
    queries: [],
    async query(sql) {
      const s = String(sql);
      this.queries.push(s);
      if (/INSERT INTO homeroom_bot_voice_offers/.test(s)) return { rows: [{ id: 5 }] };
      return { rows: [] };
    },
  };
}

async function sayWith(extra) {
  const sent = [];
  const pool = sayPool();
  const deps = {
    ws: {
      async sendBotMessage(_pool, _appId, args) { sent.push(args); return { id: 900, createdAt: new Date() }; },
      broadcast() {},
    },
    notifications: { async createMentionNotifications() { return []; } },
  };
  const out = await voice.say(pool, {
    app: { id: 1, slug: 'x' },
    place: { type: 'issue', ref: 7 },
    bot: { id: 2, username: 'homeroom_bot' },
    text: 'Sure.',
    answer: [{ message: { id: 50, content: 'Can it?' }, username: 'evan', userId: 9 }],
    deps,
    ...extra,
  });
  return { sent, out, pool };
}

test('say() stores the suggestions as prompts for the people it answered', async () => {
  const { sent, pool } = await sayWith({ suggestions: ['Go ahead', 'Just the triage part', 'Not now'] });
  assert.equal(sent.length, 1);
  const bot = sent[0].metadata.homeroomBot;
  assert.deepEqual(bot.suggest, { status: 'open', forUserIds: [9] });
  assert.deepEqual(bot.actions.map((a) => a.label), ['Go ahead', 'Just the triage part', 'Not now']);
  assert.ok(bot.actions.every((a) => a.type === 'prompt' && a.style === 'secondary'));
  // The older sets in that thread are retired in the same send.
  assert.ok(pool.queries.some((q) => /jsonb_set/.test(q) && /homeroomBot,suggest,status/.test(q)));
});

test('say() stores none with an empty list, or beside an offer\'s Yes/No', async () => {
  const empty = await sayWith({ suggestions: [] });
  assert.equal(empty.sent[0].metadata.homeroomBot.suggest, undefined);
  const offered = await sayWith({ suggestions: ['Go ahead'], offer: { kind: 'file_request', forUserId: 9, args: {} } });
  // The offer keeps its own buttons; the two never share `actions`.
  assert.ok(offered.sent[0].metadata.homeroomBot.offer);
  assert.equal(offered.sent[0].metadata.homeroomBot.suggest, undefined);
  assert.deepEqual(offered.sent[0].metadata.homeroomBot.actions.map((a) => a.label), ['File it', 'Not now']);
});

test('say() clips a suggestion too long for a button, rather than cutting it', async () => {
  const { sent } = await sayWith({ suggestions: ['x'.repeat(61), 'Not now'] });
  assert.deepEqual(sent[0].metadata.homeroomBot.actions.map((a) => a.label), ['Not now']);
});
