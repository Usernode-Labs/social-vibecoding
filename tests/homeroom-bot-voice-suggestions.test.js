'use strict';

// 3 Nov 2026 (#6213): Homeroom bot's answers in a request's or a change's
// discussion end with suggested replies the people it answered tap to send
// as their own. 6 Nov 2026 (#6391): every such reply ends in buttons: a set
// for the people it answered (the model's, else one built from the reply and
// the thread's state) and a second set for the other members. Pinned here:
// the tool's two fields, the prompt, the one re-ask, the fallback sets, what
// say() stores, and the Go ahead a waiting note carries.

const test = require('node:test');
const assert = require('node:assert/strict');

const voice = require('../src/services/homeroom-bot-voice');

test('only a request\'s or a change\'s discussion offers suggestions', () => {
  for (const place of [{ type: 'issue', ref: 1 }, { type: 'session', ref: 2 }]) {
    const reply = voice.toolsFor(place).find((t) => t.function.name === 'reply');
    assert.ok(reply.function.parameters.properties.suggestions, `${place.type} offers them`);
    assert.equal(reply.function.parameters.properties.suggestions.type, 'array');
    assert.equal(reply.function.parameters.properties.suggestions.maxItems, 3);
    // #6391: and a second set for the members it did not answer.
    assert.equal(reply.function.parameters.properties.suggestionsForOthers.type, 'array');
    assert.equal(reply.function.parameters.properties.suggestionsForOthers.maxItems, 3);
    assert.doesNotMatch(reply.function.parameters.properties.suggestions.description, /Leave this out/);
  }
  for (const place of [{ type: 'chat', ref: null }, { type: 'category', ref: 1 }, { type: 'message', ref: 2 }]) {
    const reply = voice.toolsFor(place).find((t) => t.function.name === 'reply');
    assert.equal(reply.function.parameters.properties.suggestions, undefined, `${place.type} keeps its behaviour`);
    assert.equal(reply.function.parameters.properties.suggestionsForOthers, undefined);
  }
});

test('the prompt asks for both sets in a request or a change, and nowhere else', () => {
  const tools = voice.toolsFor({ type: 'issue', ref: 1 });
  const issue = voice.systemPrompt({ app: { slug: 'x', name: 'X' }, place: { type: 'issue', ref: 1 }, tools });
  assert.match(issue, /Always put one to three short things the people you answered might say next/);
  assert.match(issue, /They are shown as buttons/);
  assert.match(issue, /Never write them in the text/);
  assert.match(issue, /When your reply asks a question,\s+they are its answers/);
  assert.match(issue, /suggestionsForOthers field/);
  // #6614: the queued-work rule sits beside the question and closing-pair rules.
  assert.match(issue, /When your reply says work is queued, running or about to start and asks nothing/);
  assert.match(issue, /Their yes is answered with one short line and no buttons/);
  const described = tools.find((t) => t.function.name === 'reply').function.parameters.properties.suggestions.description;
  assert.match(described, /When your reply says work is queued, running or about to start and asks nothing/);
  assert.doesNotMatch(issue, /plainly ended/, 'the conversation ending no longer drops the buttons');
  assert.doesNotMatch(issue, /End the reply with one to three short things/, 'no longer invites a list in the text');
  const chatTools = voice.toolsFor({ type: 'chat', ref: null });
  const chat = voice.systemPrompt({ app: { slug: 'x', name: 'X' }, place: { type: 'chat', ref: null }, tools: chatTools });
  assert.doesNotMatch(chat, /suggestions field/);
});

test('a reply that writes its suggestions as a list has them moved into the tool\'s field', async () => {
  const ctx = { app: { id: 1, slug: 'x' }, place: { type: 'issue', ref: 7 }, deps: {} };
  const raw = 'Once it is built, the change runs its checks.\n\nSuggestions:\n'
    + '- So once the checks pass I can vote on it?\n- Where do I see the checks?\n';
  await voice.runTool({}, ctx, 'reply', {
    text: raw, suggestionsForOthers: ["I'd like this too", 'What\'s left to do?'],
  });
  assert.equal(ctx.reply.text, 'Once it is built, the change runs its checks.');
  assert.deepEqual(ctx.reply.suggestions, ['So once the checks pass I can vote on it?', 'Where do I see the checks?']);
  assert.deepEqual(ctx.reply.suggestionsForOthers, ["I'd like this too", 'What\'s left to do?']);
});

// ── #6391: one more ask, then a set Homeroom builds ───────────────────────

test('a reply missing either set is refused once, then kept', async () => {
  const ctx = { app: { id: 1, slug: 'x' }, place: { type: 'issue', ref: 7 }, deps: {} };
  const out = await voice.runTool({}, ctx, 'reply', { text: 'I am on it.', suggestions: ['Thanks'] });
  assert.match(out.error, /no buttons for people to tap/);
  assert.equal(ctx.reply, undefined, 'not stored: it is asked once more');
  assert.deepEqual(ctx.pendingReply, { text: 'I am on it.', suggestions: ['Thanks'] });
  assert.equal(ctx.suggestAsked, true);
  // The second answer is kept as it is, whatever it gives.
  const again = await voice.runTool({}, ctx, 'reply', { text: 'I am on it.' });
  assert.deepEqual(again, { ok: true });
  assert.equal(ctx.reply.text, 'I am on it.');
  assert.equal(ctx.pendingReply, null);
});

test('a reply whose sets are both usable is kept at once', async () => {
  const ctx = { app: { id: 1, slug: 'x' }, place: { type: 'session', ref: 3 }, deps: {} };
  const out = await voice.runTool({}, ctx, 'reply', {
    text: 'Built.', suggestions: ['Thanks'], suggestionsForOthers: ["I'd like this too"],
  });
  assert.deepEqual(out, { ok: true });
  assert.equal(ctx.suggestAsked, undefined);
  assert.deepEqual(ctx.reply.suggestions, ['Thanks']);
  assert.deepEqual(ctx.reply.suggestionsForOthers, ["I'd like this too"]);
});

test('a chat message, or a reply beside an offer, is never asked again', async () => {
  const chat = { app: { id: 1, slug: 'x' }, place: { type: 'chat', ref: null }, deps: {} };
  await voice.runTool({}, chat, 'reply', { text: 'Hello.' });
  assert.equal(chat.reply.text, 'Hello.');
  const offered = { app: { id: 1, slug: 'x' }, place: { type: 'issue', ref: 7 }, offer: { kind: 'file_request' }, deps: {} };
  await voice.runTool({}, offered, 'reply', { text: 'Want me to file it?' });
  assert.equal(offered.reply.text, 'Want me to file it?');
});

test('the fallback set fits the reply and the thread\'s state', () => {
  const tell = voice.fallbackSuggestions({
    text: 'Thanks evan. You can follow it here: #6389. Want me to tell you here when it is ready to vote?',
  });
  assert.deepEqual(tell.answered, ['Yes, tell me here', 'No thanks']);
  assert.deepEqual(tell.others, ["I'd like this too", 'Can I try it?', "What's left to do?"]);

  assert.deepEqual(voice.fallbackSuggestions({ text: 'Should I keep going?' }).answered, ['Yes', 'No']);
  assert.deepEqual(voice.fallbackSuggestions({ text: 'It is queued.' }).answered, ['Thanks', 'What happens next?']);
  const ended = voice.fallbackSuggestions({ text: 'It is live now.', ended: true });
  assert.deepEqual(ended.answered, ['Thanks', "Something's still wrong"]);
  assert.deepEqual(ended.others, ["Something's still wrong", 'Can I try it?']);
});

// ── #6614: work under way puts a plain yes first ─────────────────────────

test('withAffirmationFirst puts Sounds good before new asks, keeps a yes, drops a duplicate', () => {
  const asks = voice.withAffirmationFirst([
    'Also fix the Codex config note', 'Leave the test alone, just rebase', 'Show me the failing test output',
  ]);
  assert.deepEqual(asks.labels, ['Sounds good', 'Also fix the Codex config note', 'Leave the test alone, just rebase']);
  assert.equal(asks.affirm, 'Sounds good');

  const kept = voice.withAffirmationFirst(['Thanks, go ahead', 'Tell me when it\'s ready']);
  assert.deepEqual(kept.labels, ['Thanks, go ahead', "Tell me when it's ready"]);
  assert.equal(kept.affirm, 'Thanks, go ahead');

  const duplicate = voice.withAffirmationFirst(['Sounds good', 'sounds good', 'Tell me when it\'s ready']);
  assert.deepEqual(duplicate.labels, ['Sounds good', "Tell me when it's ready"]);

  const clipped = voice.withAffirmationFirst(['One', 'Two', 'Three', 'Four']);
  assert.equal(clipped.labels.length, 3);
  assert.equal(clipped.labels[0], 'Sounds good');
});

test('isAffirmation knows a short yes from a new ask', () => {
  for (const yes of ['Sounds good', 'Thanks!', 'ok', 'Yes, go ahead', 'Carry on']) {
    assert.equal(voice.isAffirmation(yes), true, yes);
  }
  for (const ask of ['Also fix the Codex config note', 'Show me the failing test output', 'Can I try it?']) {
    assert.equal(voice.isAffirmation(ask), false, ask);
  }
});

test('fallbackSuggestions after queued work gives the yes first; a question keeps its answers', () => {
  const queued = voice.fallbackSuggestions({ text: 'I\'ve queued a fix on PR #6586.', queued: true });
  assert.deepEqual(queued.answered, ['Sounds good', "Tell me when it's ready"]);
  const question = voice.fallbackSuggestions({ text: 'Want me to tell you here when it is ready?', queued: true });
  assert.deepEqual(question.answered, ['Yes, tell me here', 'No thanks']);
  assert.deepEqual(voice.fallbackSuggestions({ text: 'It is queued.' }).answered, ['Thanks', 'What happens next?']);
});

// ── say() ────────────────────────────────────────────────────────────────

function sayPool(extra = () => ({ rows: [] })) {
  return {
    queries: [],
    async query(sql, params) {
      const s = String(sql);
      this.queries.push(s);
      if (/INSERT INTO bot_cards/.test(s)) return { rows: [{ id: 5 }] };
      return extra(s, params) || { rows: [] };
    },
  };
}

async function sayWith(extra, pool = sayPool()) {
  const sent = [];
  const deps = {
    ws: {
      // Step 3: a card is written with its message (ws.sendBotMessage), its
      // offer and buttons put into the metadata there, as a card of id 77.
      async sendBotMessage(_pool, _appId, args) {
        const metadata = args.card
          ? require('../src/services/bot-cards').withThreadCard(args.metadata, { id: 77, ...args.card, user_id: args.card.forUserId })
          : args.metadata;
        sent.push({ ...args, metadata });
        return { id: 900, createdAt: new Date(), ...(args.card ? { cardId: 77 } : {}) };
      },
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
  // #6391: the other members get a set beside it.
  assert.deepEqual(bot.othersActions.map((a) => a.label),
    ["I'd like this too", 'Can I try it?', "What's left to do?"]);
  assert.ok(bot.othersActions.every((a) => a.type === 'prompt' && a.style === 'secondary'));
  assert.deepEqual(bot.othersActions.map((a) => a.id), ['others-1', 'others-2', 'others-3']);
  // The older sets in that thread are retired in the same send.
  assert.ok(pool.queries.some((q) => /jsonb_set/.test(q) && /homeroomBot,suggest,status/.test(q)));
});

test('say() builds the sets the model left out, from the reply', async () => {
  const { sent } = await sayWith({ text: 'Want me to tell you here when it is ready to vote?' });
  const bot = sent[0].metadata.homeroomBot;
  assert.deepEqual(bot.actions.map((a) => a.label), ['Yes, tell me here', 'No thanks']);
  assert.deepEqual(bot.othersActions.map((a) => a.label),
    ["I'd like this too", 'Can I try it?', "What's left to do?"]);
});

test('say() keeps the model\'s usable set and builds only the missing one', async () => {
  const { sent } = await sayWith({ suggestions: ['Where do I see the checks?'] });
  const bot = sent[0].metadata.homeroomBot;
  assert.deepEqual(bot.actions.map((a) => a.label), ['Where do I see the checks?']);
  assert.equal(bot.othersActions.length, 3);
});

test('say() stores none beside an offer\'s Yes/No, or when told not to', async () => {
  const offered = await sayWith({ suggestions: ['Go ahead'], offer: { kind: 'file_request', forUserId: 9, args: {} } });
  assert.ok(offered.sent[0].metadata.homeroomBot.offer);
  assert.equal(offered.sent[0].metadata.homeroomBot.suggest, undefined);
  assert.equal(offered.sent[0].metadata.homeroomBot.othersActions, undefined);
  assert.deepEqual(offered.sent[0].metadata.homeroomBot.actions.map((a) => a.label), ['File it', 'Not now']);
  // #6391: the "I couldn't answer just now" line carries no buttons.
  const sorry = await sayWith({ suggest: false });
  assert.equal(sorry.sent[0].metadata.homeroomBot.suggest, undefined);
  assert.equal(sorry.sent[0].metadata.homeroomBot.othersActions, undefined);
});

test('say() clips a suggestion too long for a button, rather than cutting it', async () => {
  const { sent } = await sayWith({ suggestions: ['x'.repeat(61), 'Not now'] });
  assert.deepEqual(sent[0].metadata.homeroomBot.actions.map((a) => a.label), ['Not now']);
});

test('say() writes only the second set when nobody in particular was answered', async () => {
  const { sent } = await sayWith({ answer: [], text: 'It is done.' });
  const bot = sent[0].metadata.homeroomBot;
  assert.deepEqual(bot.suggest, { status: 'open', forUserIds: [] });
  assert.deepEqual(bot.actions, []);
  assert.equal(bot.othersActions.length, 3);
});

test('say() reads a closed request as ended and closes both sets', async () => {
  const pool = sayPool((s) => {
    if (/FROM chat_sessions/.test(s)) return { rows: [] };
    return null;
  });
  const { sent } = await sayWith({
    text: 'It is live.', ended: true,
  }, pool);
  const bot = sent[0].metadata.homeroomBot;
  assert.deepEqual(bot.actions.map((a) => a.label), ['Thanks', "Something's still wrong"]);
  assert.deepEqual(bot.othersActions.map((a) => a.label), ["Something's still wrong", 'Can I try it?']);
});

test('say() carries Go ahead for the people a waiting note asked', async () => {
  const pool = sayPool((s) => {
    if (/AS ids/.test(s)) return { rows: [{ ids: [11, 12] }] };
    return null;
  });
  const { sent } = await sayWith({ suggestions: ['Thanks'], text: 'I am on it.' }, pool);
  const bot = sent[0].metadata.homeroomBot;
  assert.deepEqual(bot.actions.map((a) => a.label), ['Go ahead', 'Thanks']);
  assert.equal(bot.actions[0].id, 'go_ahead');
  assert.equal(bot.actions[0].style, 'primary');
  assert.deepEqual(bot.suggest.forUserIds, [9, 11, 12], 'the people it answered and the people the note asked');
});

test('say() stops carrying Go ahead once it was said, or a change started', async () => {
  const saidPool = sayPool((s) => (/AS ids/.test(s) ? { rows: [{ ids: [11] }] } : null));
  const said = await sayWith({
    suggestions: ['Thanks'], text: 'On it.',
    answer: [{ message: { id: 51, content: '  Go Ahead ' }, username: 'evan', userId: 9 }],
  }, saidPool);
  assert.deepEqual(said.sent[0].metadata.homeroomBot.actions.map((a) => a.label), ['Thanks']);

  const startedPool = sayPool((s) => {
    if (/AS ids/.test(s)) return { rows: [{ ids: [11] }] };
    if (/FROM chat_sessions/.test(s)) return { rows: [{ '?column?': 1 }] };
    return null;
  });
  const started = await sayWith({ suggestions: ['Thanks'], text: 'On it.' }, startedPool);
  assert.deepEqual(started.sent[0].metadata.homeroomBot.actions.map((a) => a.label), ['Thanks']);
});

// ── #6614: queued work, and the yes that ends the exchange ───────────────

test('say() puts a plain yes first when the turn queued work, and stores its wording', async () => {
  const { sent } = await sayWith({
    text: 'I\'ve queued a fix on PR #6586. Here is what I\'ll do.',
    queued: true,
    suggestions: ['Also fix the Codex config note', 'Leave the test alone, just rebase', 'Show me the failing test output'],
  });
  const bot = sent[0].metadata.homeroomBot;
  assert.deepEqual(bot.actions.map((a) => a.label),
    ['Sounds good', 'Also fix the Codex config note', 'Leave the test alone, just rebase']);
  assert.deepEqual(bot.affirm, { label: 'Sounds good' });
});

test('say() keeps a reply that asks a question as it is, and stores no affirmation', async () => {
  const { sent } = await sayWith({
    text: 'Want me to tell you here when it is ready?',
    queued: true,
    suggestions: ['Yes, tell me here', 'No thanks'],
  });
  const bot = sent[0].metadata.homeroomBot;
  assert.deepEqual(bot.actions.map((a) => a.label), ['Yes, tell me here', 'No thanks']);
  assert.equal(bot.affirm, undefined);
});

test('say() falls back to the queued set when the model gave none', async () => {
  const { sent } = await sayWith({ text: 'I\'ve queued a fix.', queued: true });
  const bot = sent[0].metadata.homeroomBot;
  assert.deepEqual(bot.actions.map((a) => a.label), ['Sounds good', "Tell me when it's ready"]);
  assert.deepEqual(bot.affirm, { label: 'Sounds good' });
});

test('affirmedAck matches the bot\'s stored yes from a person it answered, and nothing else', async () => {
  const yes = { metadata: { homeroomBot: { affirm: { label: 'Sounds good' }, suggest: { forUserIds: [9] } } } };
  const pool = { async query() { return { rows: [yes] }; } };
  const args = { app: { id: 1 }, place: { type: 'issue', ref: 7 }, bot: { id: 2 }, speaker: { id: 9 } };
  assert.equal(await voice.affirmedAck(pool, { ...args, row: { id: 60, content: ' sounds good ' } }), true);
  assert.equal(await voice.affirmedAck(pool, { ...args, row: { id: 60, content: 'Also fix the Codex config note' } }), false);
  // A member the bot did not answer goes to the model as today.
  assert.equal(await voice.affirmedAck(pool, { ...args, row: { id: 60, content: 'Sounds good' }, speaker: { id: 10 } }), false);
  // A newer bot message (the result) is the one read, so the old yes no longer matches.
  const newer = { async query() { return { rows: [{ metadata: { homeroomBot: { kind: 'voice' } } }] }; } };
  assert.equal(await voice.affirmedAck(newer, { ...args, row: { id: 61, content: 'Sounds good' } }), false);
});
